// TIMMY Command Post v0.1 — typed dispatch contract + controller.
// Equip riders; don't ride: this PREPARES, ARMS and LAUNCHES work into
// existing harness lanes (LANE_RUNNERS + tmux vocabulary). It is not a second
// scheduler; the later tldraw Mission Map compiles into these same calls.
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { planHashOf, consumeApproval } from './approvals.js';
import { appendReceipt } from './receipts.js';
import { captureEnvLock, type EnvLock } from './envlock.js';
import { harnessFields } from '../harness/policy.js';
import { publish as appendEvent } from '../bus/index.js';
import { LANE_RUNNERS } from '../agent/lanes.js';
import { selectFromCone, type ContextCone, type ConeSelection } from './context-cone.js';
import { openHandsPreflight, runOpenHandsTask } from './openhands-adapter.js';
import { dockerReady } from './doctor.js';

export type Lifecycle =
  | 'draft' | 'ready' | 'armed' | 'running' | 'needs_approval'
  | 'judging' | 'passed' | 'failed' | 'promoted' | 'archived';

export interface DispatchPlan {
  schema_version: 'dispatch/0.1';
  objective: string;
  deliverables: string[];
  acceptance_tests: string[];
  harnesses: string[];
  model_policy: { requested: string; allow_paid: boolean; max_spend_usd: number };
  copies: number;
  cadence: { mode: 'parallel' | 'sequential'; depends_on: string[] };
  context_manifest: { path: string; sha256: string }[];
  /** V-01 rung 2: provenance of a cone-derived manifest; isolation seeds only these paths */
  context_cone?: {
    budget_tokens: number;
    selected_tokens: number;
    entries: { id: string; tier: 'L0' | 'L1' | 'L2'; tokens: number; path?: string }[];
  };
  repo_ref: string;
  workspace: { kind: 'docker' | 'host-ephemeral'; image?: string; path?: string };
  permissions: { filesystem: 'ro' | 'rw-ephemeral'; network: boolean; tools: string[]; secrets: string[] };
  limits: { tokens?: number; cost_usd: number; steps?: number; wall_ms: number };
  retry_limit: number;
  approval: { required: boolean; mode: 'manual' | 'delegated-envelope' };
  expected_artifacts: string[];
  telemetry: { redact: boolean; events: boolean };
}

export interface StoredPlan {
  id: string;
  plan: DispatchPlan;
  plan_hash: string;
  lifecycle: Lifecycle;
  approved_hash?: string;
  session?: string;
  dispatched_at?: string;
  blocked?: { state: 'not_configured' | 'blocked'; note: string };
}

const sha = (p: string): string => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
const storeDir = (dir?: string) => join(dir ?? process.cwd(), '.timmy', 'dispatch');
const planPath = (id: string, dir?: string) => join(storeDir(dir), `${id}.json`);
const readStored = (id: string, dir?: string): StoredPlan | null => {
  try { return JSON.parse(readFileSync(planPath(id, dir), 'utf8')) as StoredPlan; } catch { return null; }
};
const writeStored = (s: StoredPlan, dir?: string) => {
  mkdirSync(storeDir(dir), { recursive: true });
  writeFileSync(planPath(s.id, dir), JSON.stringify(s, null, 2));
};
const ev = (kind: string, s: StoredPlan, extra: Record<string, unknown> = {}, dir?: string) =>
  appendEvent(kind, { plan_id: s.id, plan_hash: s.plan_hash, harness: s.plan.harnesses.join(','), status: s.lifecycle, ...extra }, dir);

// CUE validates structure (owner amendment: CUE only at v0.1, no Nickel).
export function validatePlanCue(plan: unknown, dir?: string): { ok: boolean; note?: string; error_class?: string } {
  const cueBin = spawnSync('cue', ['version'], { encoding: 'utf8' });
  if (cueBin.status !== 0) return { ok: false, error_class: 'not_configured', note: 'cue binary missing (brew install cue)' };
  // schema lives in the repo, independent of the data dir
  const schema = fileURLToPath(new URL('../../schemas/dispatch.cue', import.meta.url));
  const tmp = join(mkdtempSync(join(tmpdir(), 'timmy-cue-')), 'plan.json');
  writeFileSync(tmp, JSON.stringify(plan));
  const r = spawnSync('cue', ['vet', '-d', '#Plan', schema, tmp], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error_class: 'schema', note: (r.stderr || r.stdout || 'cue vet failed').slice(0, 400) };
  return { ok: true };
}

export function listLanes(): { id: string; label: string; available: boolean; install?: string; model?: string }[] {
  return Object.entries(LANE_RUNNERS).map(([id, r]) => ({
    id, label: r.label, available: spawnSync('command', ['-v', r.cmd], { encoding: 'utf8', shell: true }).status === 0,
    install: r.install, model: r.model
  }));
}

// V-01 rung 2 (v0.7.6): the cone selects token-budgeted L0/L1/L2 slices; this
// turns the selection into the sha-pinned context_manifest a capsule seeds.
// Fails closed on budget_exceeded, path escapes, and missing entries.
export function coneToContextManifest(cone: ContextCone, opts?: { budgetOverride?: number; repoRoot?: string }): { ok: boolean; manifest?: { path: string; sha256: string }[]; selection?: ConeSelection; error_class?: string; note?: string } {
  const root = resolve(opts?.repoRoot ?? process.cwd());
  const sel = selectFromCone(cone, opts?.budgetOverride);
  if (!sel.ok) return { ok: false, selection: sel, error_class: sel.error_class, note: sel.note };
  const manifest: { path: string; sha256: string }[] = [];
  for (const e of sel.entries) {
    if (!e.path) continue;
    const src = resolve(root, e.path);
    if (!src.startsWith(root + '/')) return { ok: false, selection: sel, error_class: 'blocked', note: `cone path escapes repo: ${e.path}` };
    if (!existsSync(src)) return { ok: false, selection: sel, error_class: 'missing_source', note: `cone entry missing: ${e.path}` };
    manifest.push({ path: e.path, sha256: sha(src) });
  }
  return { ok: true, manifest, selection: sel };
}

export function createPlan(plan: DispatchPlan, dir?: string, cone?: ContextCone): { ok: boolean; id?: string; plan_hash?: string; validation?: unknown; note?: string } {
  if (cone) {
    const cm = coneToContextManifest(cone);
    if (!cm.ok) return { ok: false, validation: { error_class: cm.error_class, note: cm.note }, note: cm.note ?? cm.error_class };
    plan = {
      ...plan,
      context_manifest: cm.manifest!,
      context_cone: {
        budget_tokens: cone.budget_tokens,
        selected_tokens: cm.selection!.tokens,
        entries: cm.selection!.entries.map(e => ({ id: e.id, tier: e.tier, tokens: e.tokens, ...(e.path ? { path: e.path } : {}) }))
      }
    };
  }
  const validation = validatePlanCue(plan, dir);
  if (!validation.ok) return { ok: false, validation, note: validation.note };
  if (!plan.harnesses || plan.harnesses.length < 1) return { ok: false, note: 'no harnesses' };
  for (const h of plan.harnesses) {
    if (!LANE_RUNNERS[h]) return { ok: false, note: `unknown harness '${h}'`, validation: { available: Object.keys(LANE_RUNNERS) } };
  }
  const id = `dp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const stored: StoredPlan = { id, plan, plan_hash: planHashOf(plan), lifecycle: plan.approval.required ? 'needs_approval' : 'ready' };
  writeStored(stored, dir);
  ev('dispatch.created', stored, {}, dir);
  return { ok: true, id, plan_hash: stored.plan_hash, validation };
}

// Approval binds the COMPLETE immutable plan hash; any mutation invalidates.
export function armPlan(id: string, approval: string, dir?: string): { ok: boolean; note?: string; plan_hash?: string } {
  const s = readStored(id, dir);
  if (!s) return { ok: false, note: 'unknown plan' };
  // preflight (friction log #2): containerized plans cannot arm while the
  // docker daemon is down — checked BEFORE consuming the one-shot token so a
  // bad environment never burns operator authority. DRYRUN bypasses (the
  // mechanical path is explicitly not the real sandbox).
  if (s.plan.workspace.kind === 'docker' && process.env.TIMMY_DISPATCH_DRYRUN !== '1' && !dockerReady()) {
    ev('dispatch.arm_denied', s, { note: 'docker not_configured' }, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} arm BLOCKED (preflight)`, policy: 'human-gated', status: 'failed', error_class: 'not_configured', plan_hash: s.plan_hash, discrepancies: ['docker daemon down — timmy doctor preflight'], spans: [], artifacts: [] }, dir);
    return { ok: false, note: 'docker daemon not_configured — containerized plans cannot arm (timmy doctor preflight)', plan_hash: s.plan_hash };
  }
  const gate = consumeApproval(approval, s.plan_hash);
  if (!gate.ok) {
    s.lifecycle = 'needs_approval';
    writeStored(s, dir);
    ev('dispatch.arm_denied', s, { note: gate.note }, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} arm DENIED`, policy: 'human-gated', status: 'denied', error_class: 'approval', plan_hash: s.plan_hash, spans: [], artifacts: [] }, dir);
    return { ok: false, note: gate.note, plan_hash: s.plan_hash };
  }
  s.approved_hash = s.plan_hash;
  s.lifecycle = 'armed';
  writeStored(s, dir);
  ev('dispatch.armed', s, {}, dir);
  return { ok: true, plan_hash: s.plan_hash };
}

// bounded: a saturated tmux server must stall a dispatch, not hang it
const tmux = (args: string[]) => spawnSync('tmux', args, { encoding: 'utf8', timeout: 5000 });

// Real sandbox or nothing: docker disposable, or host-ephemeral temp copy.
// Never the live checkout; never a changed directory as a claimed jail.
function establishIsolation(s: StoredPlan): { ok: boolean; workdir?: string; note?: string; state?: 'not_configured' | 'blocked' } {
  const repoRoot = process.cwd();
  if (s.plan.workspace.kind === 'docker') {
    const info = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 15000 });
    if (info.status !== 0) return { ok: false, state: 'not_configured', note: 'docker daemon unavailable — fail closed' };
    const workdir = mkdtempSync(join(tmpdir(), `timmy-dp-${s.id}-`));
    return { ok: true, workdir };
  }
  const hinted = s.plan.workspace.path;
  if (hinted && (hinted === repoRoot || hinted.startsWith(repoRoot + '/'))) {
    return { ok: false, state: 'blocked', note: 'workspace inside live checkout — refused (isolation law)' };
  }
  const workdir = mkdtempSync(join(tmpdir(), `timmy-dp-${s.id}-`));
  // cone law (v0.7.6): a cone-derived capsule seeds ONLY the budgeted
  // selection — unconstrained blobs riding the manifest are refused
  const allowed = s.plan.context_cone
    ? new Set(s.plan.context_cone.entries.map(e => e.path).filter((p): p is string => Boolean(p)))
    : null;
  // seed the temp copy: hash-verified manifest files read from the governing
  // repo; the pane only ever sees the ephemeral copy (isolation law)
  for (const m of s.plan.context_manifest ?? []) {
    if (allowed && !allowed.has(m.path)) return { ok: false, state: 'blocked', note: `context outside cone selection: ${m.path}` };
    const src = resolve(repoRoot, m.path);
    if (!src.startsWith(resolve(repoRoot) + '/')) return { ok: false, state: 'blocked', note: `context path escapes repo: ${m.path}` };
    if (!existsSync(src)) return { ok: false, state: 'blocked', note: `context missing: ${m.path}` };
    const got = sha(src);
    if (got !== m.sha256) return { ok: false, state: 'blocked', note: `context hash mismatch: ${m.path} (want ${m.sha256.slice(0, 12)}… got ${got.slice(0, 12)}…)` };
    const dst = resolve(workdir, m.path);
    if (!dst.startsWith(resolve(workdir) + '/')) return { ok: false, state: 'blocked', note: `context path escapes workspace: ${m.path}` };
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src));
  }
  return { ok: true, workdir };
}

export function dispatchPlan(id: string, dir?: string): { ok: boolean; note?: string; session?: string; blocked?: { state: string; note: string } } {
  const s = readStored(id, dir);
  if (!s) return { ok: false, note: 'unknown plan' };
  if (s.lifecycle !== 'armed') return { ok: false, note: `plan not armed (lifecycle ${s.lifecycle}) — chat prepares, authority launches` };
  const currentHash = planHashOf(s.plan);
  if (s.approved_hash !== currentHash || currentHash !== s.plan_hash) {
    s.plan_hash = currentHash;
    s.lifecycle = 'needs_approval';
    writeStored(s, dir);
    ev('dispatch.mutation_denied', s, {}, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} DENIED (plan mutated post-approval)`, policy: 'human-gated', status: 'denied', error_class: 'approval', plan_hash: s.plan_hash, spans: [], artifacts: [] }, dir);
    return { ok: false, note: 'plan mutated after approval — approval invalidated' };
  }
  const iso = establishIsolation(s);
  if (!iso.ok) {
    s.blocked = { state: iso.state!, note: iso.note! };
    s.lifecycle = 'failed';
    writeStored(s, dir);
    ev('dispatch.isolation_failed', s, { note: iso.note }, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} isolation FAILED`, policy: 'human-gated', status: 'failed', error_class: iso.state === 'not_configured' ? 'not_configured' : 'env', plan_hash: s.plan_hash, discrepancies: [iso.note!], spans: [], artifacts: [] }, dir);
    return { ok: false, note: iso.note, blocked: s.blocked };
  }
  const runner = LANE_RUNNERS[s.plan.harnesses[0]];
  const session = `timmy-dp-${s.id}`;
  const task = s.plan.objective.replace(/"/g, '\\"');
  const cmd = (runner.task ?? `${runner.cmd} "{task}"`).replace('{task}', task);
  tmux(['kill-session', '-t', session]);
  const ns = tmux(['new-session', '-d', '-s', session, '-c', iso.workdir!]);
  if (ns.status !== 0) {
    s.lifecycle = 'failed';
    writeStored(s, dir);
    return { ok: false, note: 'tmux spawn failed' };
  }
  // TIMMY_DISPATCH_DRYRUN=1: exercise session mechanics without launching a
  // real harness (tests, demos). Isolation + approval gates still apply.
  const launchCmd = process.env.TIMMY_DISPATCH_DRYRUN === '1'
    ? `echo TIMMY_DISPATCH_DRYRUN ${s.id}; sleep 30`
    : `cd ${JSON.stringify(iso.workdir)} && ${cmd}`;
  tmux(['send-keys', '-t', session, launchCmd, 'Enter']);
  s.session = session;
  s.lifecycle = 'running';
  s.dispatched_at = new Date().toISOString();
  writeStored(s, dir);
  ev('dispatch.launched', s, { session, workdir: iso.workdir }, dir);
  appendReceipt('runs', {
    kind: 'run', subject: `dispatch ${id} · ${s.plan.harnesses[0]} · ${s.plan.copies}x`,
    policy: s.plan.approval.mode === 'delegated-envelope' ? 'human-gated' : 'human-gated',
    status: 'ok', plan_hash: s.plan_hash, max_spend: s.plan.limits.cost_usd,
    ...harnessFields(s.plan.harnesses[0], dir),
    env_lock: captureEnvLock(['ffmpeg', 'ffprobe', s.plan.harnesses[0]], dir),
    spans: [{ name: `dispatch ${s.plan.harnesses[0]}`, kind: 'invoke_agent' }], artifacts: []
  }, dir);
  return { ok: true, session };
}

export function getPlan(id: string, dir?: string): StoredPlan | null {
  return readStored(id, dir);
}

export function listPlans(dir?: string): StoredPlan[] {
  const d = join(dir ?? process.cwd(), '.timmy', 'dispatch');
  try {
    return readdirSync(d)
      .filter(f => f.endsWith('.json'))
      .map(f => readStored(f.replace(/\.json$/, ''), dir))
      .filter((s): s is StoredPlan => Boolean(s))
      .sort((a, b) => String(b.dispatched_at ?? '').localeCompare(String(a.dispatched_at ?? '')));
  } catch { return []; }
}

// Live containerized lane (v0.7.6): an armed openhands+docker plan runs
// through the OpenHands docker engine with telemetry on the event bus (SSE
// to the Mission Studio). Authority was consumed at arm time against THIS
// plan hash; the adapter records that hash (preApproved) instead of re-
// minting — unidirectional authority, no second token.
export async function dispatchContainerized(id: string, dir?: string): Promise<{ ok: boolean; note?: string; container?: boolean; blocked?: { state: string; note: string } }> {
  const s = readStored(id, dir);
  if (!s) return { ok: false, note: 'unknown plan' };
  if (s.lifecycle !== 'armed') return { ok: false, note: `plan not armed (lifecycle ${s.lifecycle}) — chat prepares, authority launches` };
  const currentHash = planHashOf(s.plan);
  if (s.approved_hash !== currentHash || currentHash !== s.plan_hash) {
    s.plan_hash = currentHash;
    s.lifecycle = 'needs_approval';
    writeStored(s, dir);
    ev('dispatch.mutation_denied', s, {}, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} DENIED (plan mutated post-approval)`, policy: 'human-gated', status: 'denied', error_class: 'approval', plan_hash: s.plan_hash, spans: [], artifacts: [] }, dir);
    return { ok: false, note: 'plan mutated after approval — approval invalidated' };
  }
  if (process.env.TIMMY_DISPATCH_DRYRUN === '1') {
    s.session = `container-dryrun-${s.id}`;
    s.lifecycle = 'running';
    s.dispatched_at = new Date().toISOString();
    writeStored(s, dir);
    ev('dispatch.container_started', s, { dryrun: true }, dir);
    s.lifecycle = 'judging';
    writeStored(s, dir);
    ev('dispatch.container_done', s, { dryrun: true, ok: true }, dir);
    return { ok: true, container: true };
  }
  const pre = openHandsPreflight();
  if (!pre.ok) {
    s.blocked = { state: 'not_configured', note: pre.note! };
    s.lifecycle = 'failed';
    writeStored(s, dir);
    ev('dispatch.container_failed', s, { note: pre.note }, dir);
    appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} container not_configured`, policy: 'human-gated', status: 'failed', error_class: 'not_configured', plan_hash: s.plan_hash, discrepancies: [pre.note!], spans: [], artifacts: [] }, dir);
    return { ok: false, note: pre.note, blocked: s.blocked };
  }
  s.session = `container-${s.id}`;
  s.lifecycle = 'running';
  s.dispatched_at = new Date().toISOString();
  writeStored(s, dir);
  ev('dispatch.container_started', s, { engine: 'docker' }, dir);
  let lastLog = 0;
  void runOpenHandsTask({
    task: s.plan.objective,
    acceptance: s.plan.acceptance_tests,
    engine: 'docker',
    wall_ms: s.plan.limits.wall_ms,
    max_spend: s.plan.limits.cost_usd,
    llm: s.plan.model_policy.allow_paid ? 'auto' : 'local',
    preApproved: { plan_hash: s.plan_hash },
    onLine: chunk => {
      const now = Date.now();
      if (now - lastLog < 1500) return;
      lastLog = now;
      ev('dispatch.container_log', s, { line: chunk.replace(/\s+/g, ' ').slice(0, 240) }, dir);
    },
    dir,
  }).then(r => {
    const s2 = readStored(id, dir);
    if (!s2) return;
    s2.lifecycle = r.ok ? 'judging' : 'failed';
    if (!r.ok) s2.blocked = { state: r.state ?? 'blocked', note: r.note ?? 'container run failed' };
    writeStored(s2, dir);
    ev(r.ok ? 'dispatch.container_done' : 'dispatch.container_failed', s2, { ok: r.ok, receipt: r.receipt ?? null, note: r.note ?? null }, dir);
  });
  return { ok: true, container: true };
}

export function tailLane(id: string, dir?: string): { ok: boolean; lines?: string[]; note?: string; lifecycle?: Lifecycle } {
  const s = readStored(id, dir);
  if (!s?.session) return { ok: false, note: 'no session for plan' };
  const cap = tmux(['capture-pane', '-p', '-t', s.session]);
  if (cap.status !== 0) {
    s.lifecycle = s.lifecycle === 'running' ? 'failed' : s.lifecycle;
    writeStored(s, dir);
    return { ok: false, note: 'session gone', lifecycle: s.lifecycle };
  }
  return { ok: true, lines: (cap.stdout ?? '').split('\n').slice(-40), lifecycle: s.lifecycle };
}

export function pauseOrCancelLane(id: string, action: 'hold' | 'cancel', dir?: string): { ok: boolean; note?: string } {
  const s = readStored(id, dir);
  if (!s) return { ok: false, note: 'unknown plan' };
  if (action === 'hold') {
    if (s.session) tmux(['send-keys', '-t', s.session, 'C-z']);
    s.lifecycle = 'archived';
    writeStored(s, dir);
    ev('dispatch.held', s, {}, dir);
    return { ok: true };
  }
  if (s.session) tmux(['kill-session', '-t', s.session]);
  s.lifecycle = 'archived';
  writeStored(s, dir);
  ev('dispatch.cancelled', s, {}, dir);
  appendReceipt('runs', { kind: 'run', subject: `dispatch ${id} cancelled`, policy: 'human-gated', status: 'failed', error_class: 'cancelled', plan_hash: s.plan_hash, spans: [], artifacts: [] }, dir);
  return { ok: true };
}

export function collectRun(id: string, dir?: string): { ok: boolean; lines?: string[]; over_wall?: boolean; elapsed_ms?: number; receipt?: string; lifecycle?: Lifecycle } {
  const s = readStored(id, dir);
  if (!s) return { ok: false } as any;
  const tail = s.session ? tmux(['capture-pane', '-p', '-t', s.session]) : null;
  const lines = tail?.status === 0 ? (tail.stdout ?? '').split('\n').slice(-60) : [];
  const elapsed_ms = s.dispatched_at ? Date.now() - new Date(s.dispatched_at).getTime() : 0;
  const over_wall = elapsed_ms > s.plan.limits.wall_ms;
  s.lifecycle = over_wall ? 'failed' : 'judging';
  writeStored(s, dir);
  const rec = appendReceipt('runs', {
    kind: 'run', subject: `dispatch ${id} collect · ${over_wall ? 'WALL EXCEEDED' : 'awaiting judge'}`,
    policy: 'human-gated', status: over_wall ? 'failed' : 'ok',
    ...(over_wall ? { error_class: 'wall_time' as const } : {}),
    plan_hash: s.plan_hash, ms: elapsed_ms,
    ...harnessFields(s.plan.harnesses[0], dir),
    env_lock: captureEnvLock(['ffmpeg', 'ffprobe', s.plan.harnesses[0]], dir),
    spans: [{ name: `collect ${s.plan.harnesses[0]}`, kind: 'execute_tool' }],
    artifacts: []
  }, dir);
  ev('dispatch.collected', s, { over_wall, elapsed_ms }, dir);
  return { ok: true, lines, over_wall, elapsed_ms, receipt: rec.hash, lifecycle: s.lifecycle };
}

export const dispatchHashOf = planHashOf;
export { sha as dispatchSha };
