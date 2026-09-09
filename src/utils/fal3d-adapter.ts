// Narrow image-to-3D queue adapter. Planning is offline; submission consumes
// an operator token. No prompt-only fallback, automatic resubmission, or SDK.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { consumeApproval, planHashOf } from './approvals.js';
import { appendReceipt } from './receipts.js';
import { resolveFalCredential } from './fal-credentials.js';

const PRICE_DATE = '2026-09-06';
const QUEUE = 'https://queue.fal.run';
const ENDPOINTS = {
  p1: 'tripo3d/p1/image-to-3d',
  'h3.1': 'tripo3d/h3.1/image-to-3d',
  trellis2: 'fal-ai/trellis-2',
} as const;
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const p1Options = z.object({
  face_limit: z.number().int().min(48).max(20000).default(5000),
  texture: z.boolean().default(true),
  model_seed: z.number().int().min(0).max(2147483647).default(42),
}).strict();
const h31Options = z.object({
  face_limit: z.number().int().min(500).max(500000).default(50000),
  texture: z.boolean().default(true), pbr: z.boolean().default(true),
  geometry_quality: z.enum(['standard', 'detailed']).default('detailed'),
  texture_quality: z.enum(['standard', 'detailed']).default('detailed'),
  model_seed: z.number().int().min(0).max(2147483647).default(42),
  texture_seed: z.number().int().min(0).max(2147483647).default(42),
  // This first adapter collects GLB. Quad can return FBX and needs a separate importer.
  quad: z.literal(false).default(false),
}).strict().refine(o => o.texture || !o.pbr, 'pbr requires texture');
const trellisOptions = z.object({
  seed: z.number().int().min(0).max(2147483647).default(42),
  resolution: z.union([z.literal(512), z.literal(1024), z.literal(1536)]).default(1024),
  texture_size: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
  decimation_target: z.number().int().min(1000).max(1000000).default(50000),
  remesh: z.boolean().default(true),
}).strict();
const jobSchema = z.discriminatedUnion('model', [
  z.object({ id: name, model: z.literal('p1'), image: z.string().min(1), options: p1Options.default({}) }).strict(),
  z.object({ id: name, model: z.literal('h3.1'), image: z.string().min(1), options: h31Options.default({}) }).strict(),
  z.object({ id: name, model: z.literal('trellis2'), image: z.string().min(1), options: trellisOptions.default({}) }).strict(),
]);
const batchSchema = z.object({
  schema: z.literal('timmy-fal3d/v1'), project: name,
  max_spend_usd: z.number().positive().max(100),
  jobs: z.array(jobSchema).min(1).max(20),
}).strict();
export type Fal3dSpec = z.input<typeof batchSchema>;
type Job = z.output<typeof jobSchema>;
type PlannedJob = Job & { endpoint: string; image_sha256: string; image_bytes: number; image_mime: string; estimated_cost_usd: number };
export interface Fal3dPlan {
  schema: 'timmy-fal3d-plan/v1'; project: string; max_spend_usd: number;
  price_date: string; estimated_cost_usd: number; jobs: PlannedJob[]; plan_hash: string;
}
interface JobState {
  id: string; endpoint: string;
  state: 'not_submitted' | 'submitting' | 'queued' | 'complete' | 'failed' | 'uncertain';
  request_id?: string; status_url?: string; response_url?: string;
  error_class?: string; artifact?: string; sha256?: string;
  provider_status?: string;
}
export interface Fal3dState { schema: 'timmy-fal3d-state/v1'; plan: Fal3dPlan; jobs: JobState[]; }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cents = (n: number) => Math.round(n * 100) / 100;

function imageBytes(image: string, workspace: string): { bytes: Buffer; path: string; mime: string } {
  if (isAbsolute(image)) throw new Error('image must be a workspace-relative file path');
  const root = realpathSync(workspace);
  const path = realpathSync(resolve(root, image));
  if (path === root || !path.startsWith(root + sep)) throw new Error('image must remain inside the workspace');
  const bytes = readFileSync(path);
  if (bytes.length < 12 || bytes.length > 20 * 1024 * 1024) throw new Error('image must be between 12 bytes and 20 MiB');
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : '';
  if (!mime) throw new Error('reference must contain PNG, JPEG or WebP image bytes');
  return { bytes, path: relative(root, path).split(sep).join('/'), mime };
}

export function buildFal3dPlan(spec: unknown, workspace = process.cwd()): Fal3dPlan {
  const parsed = batchSchema.parse(spec);
  if (new Set(parsed.jobs.map(j => j.id)).size !== parsed.jobs.length) throw new Error('job IDs must be unique');
  const jobs: PlannedJob[] = parsed.jobs.map(job => {
    const image = imageBytes(job.image, workspace);
    const price = job.model === 'p1' ? (job.options.texture ? 0.50 : 0.40)
      : job.model === 'h3.1' ? (!job.options.texture ? 0.20 : job.options.texture_quality === 'detailed' ? 0.40 : 0.30)
          + (job.options.geometry_quality === 'detailed' ? 0.20 : 0)
      : ({ 512: 0.25, 1024: 0.30, 1536: 0.35 })[job.options.resolution];
    return { ...job, image: image.path, endpoint: ENDPOINTS[job.model], image_sha256: sha(image.bytes),
      image_bytes: image.bytes.length, image_mime: image.mime, estimated_cost_usd: cents(price) };
  });
  const estimated_cost_usd = cents(jobs.reduce((total, job) => total + job.estimated_cost_usd, 0));
  if (estimated_cost_usd > parsed.max_spend_usd) throw new Error('estimated cost exceeds max_spend_usd');
  const body = { schema: 'timmy-fal3d-plan/v1' as const, project: parsed.project, max_spend_usd: parsed.max_spend_usd,
    price_date: PRICE_DATE, estimated_cost_usd, jobs };
  return { ...body, plan_hash: planHashOf(body) };
}

function verifyPlan(plan: Fal3dPlan, workspace: string): void {
  const rebuilt = buildFal3dPlan({ schema: 'timmy-fal3d/v1', project: plan.project, max_spend_usd: plan.max_spend_usd,
    jobs: plan.jobs.map(({ id, model, image, options }) => ({ id, model, image, options })) }, workspace);
  if (planHashOf(rebuilt) !== planHashOf(plan)) throw new Error('plan or reference bytes changed; create and approve a new plan');
}

export function fal3dPayload(job: PlannedJob, workspace = process.cwd()): Record<string, unknown> {
  const image = imageBytes(job.image, workspace);
  if (sha(image.bytes) !== job.image_sha256) throw new Error('reference image changed');
  return { ...job.options, image_url: `data:${image.mime};base64,${image.bytes.toString('base64')}` };
}

export async function checkFal3dCredentials(env: NodeJS.ProcessEnv = process.env, live = false) {
  const credential = resolveFalCredential(env);
  const base = { configured: Boolean(credential), credential_source: credential?.source ?? null, generation_submitted: false };
  if (!credential || !live) return { ...base, auth_status: credential ? 'not_checked' : 'not_configured' };
  try {
    const url = new URL('https://api.fal.ai/v1/models/pricing');
    for (const endpoint of Object.values(ENDPOINTS)) url.searchParams.append('endpoint_id', endpoint);
    const r = await fetch(url, { headers: { Authorization: `Key ${credential.key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    // Do not expose response text, account details, request headers, or credentials.
    return { ...base, http_status: r.status, auth_status: r.ok ? 'valid_for_pricing_read'
      : r.status === 401 ? 'invalid' : r.status === 403 ? 'forbidden' : 'inconclusive' };
  } catch { return { ...base, auth_status: 'inconclusive', error_class: 'network' }; }
}

const statePath = (planHash: string, workspace: string) => {
  if (!/^[a-f0-9]{32}$/.test(planHash)) throw new Error('invalid plan hash');
  return join(workspace, '.timmy', 'fal3d', planHash, 'state.json');
};
function saveState(state: Fal3dState, workspace: string, exclusive = false): void {
  const path = statePath(state.plan.plan_hash, workspace);
  mkdirSync(dirname(path), { recursive: true });
  if (exclusive) writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  else {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, path);
  }
}
function record(plan: Fal3dPlan, job: JobState | undefined, effect: string, status: 'ok' | 'failed' | 'denied', workspace: string) {
  return appendReceipt('runs', {
    kind: 'generation', subject: `fal3d ${plan.project} ${job?.id ?? 'batch'} ${effect}`, policy: 'human-gated', status,
    plan_hash: plan.plan_hash, max_spend: plan.max_spend_usd, via: 'fal',
    ...(job ? { model_requested: job.endpoint, model_resolved: job.endpoint } : {}),
    ...(job?.artifact ? { artifacts: [job.artifact], output_sha256: job.sha256 } : {}),
    ...(job?.error_class ? { error_class: job.error_class } : {}),
    executors: [{ request_id: job?.request_id ?? null, estimated_batch_cost_usd: plan.estimated_cost_usd,
      actual_cost_usd: null, price_date: plan.price_date }],
  }, workspace);
}

function queueUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('missing fal queue URL');
  const url = new URL(value);
  if (url.origin !== QUEUE || url.username || url.password || !url.pathname.includes('/requests/')) throw new Error('untrusted queue URL');
  return url.href;
}

export async function submitFal3dPlan(plan: Fal3dPlan, approval: string, env: NodeJS.ProcessEnv = process.env, workspace = process.cwd()): Promise<Fal3dState> {
  if (resolve(workspace) !== resolve(process.cwd())) throw new Error('submit from the canonical workspace so operator approval storage matches');
  verifyPlan(plan, workspace);
  const credential = resolveFalCredential(env);
  if (!credential) throw new Error('fal is not configured: set FAL_KEY or FALAI_API_KEY');
  if (existsSync(statePath(plan.plan_hash, workspace))) throw new Error('this plan already has submission state; use status or collect, never resubmit');
  // Freeze the exact approved bytes before consuming approval or making a request.
  const payloads = plan.jobs.map(job => fal3dPayload(job, workspace));
  const gate = consumeApproval(approval, plan.plan_hash);
  if (!gate.ok) {
    record(plan, undefined, 'approval denied', 'denied', workspace);
    throw new Error(gate.note ?? 'operator approval required');
  }
  const state: Fal3dState = { schema: 'timmy-fal3d-state/v1', plan,
    jobs: plan.jobs.map(job => ({ id: job.id, endpoint: job.endpoint, state: 'not_submitted' })) };
  saveState(state, workspace, true);
  for (const [i, job] of state.jobs.entries()) {
    job.state = 'submitting'; saveState(state, workspace);
    record(plan, job, 'submission started', 'ok', workspace);
    try {
      const r = await fetch(`${QUEUE}/${job.endpoint}`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Key ${credential.key}`, 'Content-Type': 'application/json', 'X-Fal-No-Retry': '1' },
        body: JSON.stringify(payloads[i]), signal: AbortSignal.timeout(60000) });
      if (!r.ok) { job.state = 'failed'; job.error_class = `http_${r.status}`; }
      else {
        const body = await r.json() as Record<string, unknown>;
        if (typeof body.request_id !== 'string' || !/^[\w-]+$/.test(body.request_id)) throw new Error('invalid queue handle');
        job.request_id = body.request_id;
        job.status_url = queueUrl(body.status_url); job.response_url = queueUrl(body.response_url); job.state = 'queued';
      }
    } catch { job.state = 'uncertain'; job.error_class = 'submission_outcome_unknown'; }
    saveState(state, workspace);
    record(plan, job, job.state, job.state === 'queued' ? 'ok' : 'failed', workspace);
    if (job.state !== 'queued') break; // A timeout can still be billed; never retry it or continue spending.
  }
  return state;
}

export function readFal3dState(planHash: string, workspace = process.cwd()): Fal3dState {
  const state = JSON.parse(readFileSync(statePath(planHash, workspace), 'utf8')) as Fal3dState;
  if (state.schema !== 'timmy-fal3d-state/v1' || state.plan.plan_hash !== planHash) throw new Error('invalid saved fal state');
  const { plan_hash: ignored, ...body } = state.plan;
  if (planHashOf(body) !== planHash || state.jobs.length !== state.plan.jobs.length
    || state.jobs.some((job, i) => job.id !== state.plan.jobs[i].id || job.endpoint !== state.plan.jobs[i].endpoint
      || !name.safeParse(job.id).success || !Object.values(ENDPOINTS).includes(job.endpoint as typeof ENDPOINTS[keyof typeof ENDPOINTS]))) {
    throw new Error('saved plan or job handles were altered');
  }
  return state;
}

function assetUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('missing GLB URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['fal.media', 'tripo3d.ai'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
    throw new Error('asset host needs review; only fal.media and tripo3d.ai CDN hosts are accepted');
  }
  return url.href;
}
function validGlb(bytes: Buffer): boolean {
  return bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'glTF'
    && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length;
}

export async function collectFal3d(planHash: string, env: NodeJS.ProcessEnv = process.env, workspace = process.cwd(), download = true): Promise<Fal3dState> {
  const state = readFal3dState(planHash, workspace);
  const credential = resolveFalCredential(env);
  if (!credential) throw new Error('fal is not configured');
  for (const job of state.jobs) {
    if (job.state !== 'queued') continue;
    const headers = { Authorization: `Key ${credential.key}` };
    const r = await fetch(queueUrl(job.status_url), { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`fal status HTTP ${r.status}; no request was resubmitted`);
    const status = await r.json() as Record<string, unknown>;
    job.provider_status = ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(String(status.status)) ? String(status.status) : 'UNKNOWN';
    saveState(state, workspace);
    if (status.status !== 'COMPLETED') continue;
    if (status.error || status.error_type) {
      job.state = 'failed'; job.error_class = 'provider_generation_failed'; saveState(state, workspace);
      record(state.plan, job, 'failed', 'failed', workspace); continue;
    }
    if (!download) continue;
    const response = await fetch(queueUrl(job.response_url), { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`fal result HTTP ${response.status}; collect may be retried`);
    const result = await response.json() as { model_glb?: { url?: string }; model_mesh?: { url?: string }; model_urls?: { glb?: { url?: string } } };
    const url = assetUrl(result.model_glb?.url ?? result.model_urls?.glb?.url ?? result.model_mesh?.url);
    // Credentials are never attached to model-download requests.
    const file = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!file.ok || !file.body) throw new Error(`asset download HTTP ${file.status}; collect may be retried`);
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = file.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 200 * 1024 * 1024) throw new Error('model exceeds 200 MiB collection limit');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    if (!validGlb(bytes)) throw new Error('download is not a complete GLB v2; no asset imported');
    const artifact = join('.timmy', 'fal3d', planHash, `${job.id}.glb`);
    const assetPath = join(workspace, artifact);
    if (existsSync(assetPath)) {
      if (sha(readFileSync(assetPath)) !== sha(bytes)) throw new Error('existing asset differs; preserve it and review before collecting');
    } else writeFileSync(assetPath, bytes, { flag: 'wx' });
    job.artifact = artifact; job.sha256 = sha(bytes); job.state = 'complete';
    saveState(state, workspace); record(state.plan, job, 'collected', 'ok', workspace);
  }
  return state;
}
