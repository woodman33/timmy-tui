// Media Fabric local blueprint spike (v0.7.4 · VISION-REGISTER V-04 first
// rung): deterministic comfy-cli execution adapter for local headless 5s
// golden runs. Real local ComfyUI or nothing — fail closed on missing CLI,
// missing server, or unverifiable determinism. Checkpoints are DISCOVERED at
// runtime (comfy skill law: never hardcode model names).
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import { appendReceipt } from './receipts.js';
import { publish as appendEvent } from '../bus/index.js';

export const GOLDEN_SEED = 1337;

export interface ComfyGoldenOpts {
  workflow: string;          // API-format workflow json path
  out?: string;              // expected output file for sha assertion
  wall_ms?: number;
  seed?: number;
  dir?: string;
}

export interface ComfyGoldenResult {
  ok: boolean;
  state?: 'not_configured' | 'blocked';
  error_class?: string;
  note?: string;
  output_sha256?: string;
  checkpoint?: string | null;
  receipt?: string;
}

const sha = (p: string): string => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');

// Background shells may lack ~/.local/bin on PATH — resolve like the
// openhands adapter's UV_PY pattern.
function comfyBin(): string {
  // `--json env` is the cheap always-valid envelope (`--json version` is a
  // usage error in comfy-cli 1.16)
  const probe = spawnSync('comfy', ['--json', 'env'], { encoding: 'utf8', timeout: 15000 });
  if (probe.status === 0) return 'comfy';
  const fallback = join(homedir(), '.local', 'bin', 'comfy');
  return existsSync(fallback) ? fallback : 'comfy';
}

export function comfyPreflight(): { ok: boolean; state?: 'not_configured'; note?: string } {
  const v = spawnSync(comfyBin(), ['--json', 'env'], { encoding: 'utf8', timeout: 15000 });
  if (v.status !== 0) return { ok: false, state: 'not_configured', note: 'comfy CLI missing (see comfy skill)' };
  return { ok: true };
}

// Pure + deterministic: pin every seed widget; inject the discovered
// checkpoint into loaders that still carry the DISCOVER sentinel.
export function prepareGoldenWorkflow(wf: Record<string, unknown>, opts: { seed?: number; checkpoint?: string | null }): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(wf)) as Record<string, any>;
  for (const node of Object.values(out)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    if ('seed' in node.inputs) node.inputs.seed = opts.seed ?? GOLDEN_SEED;
    if ('ckpt_name' in node.inputs && node.inputs.ckpt_name === 'DISCOVER' && opts.checkpoint) node.inputs.ckpt_name = opts.checkpoint;
  }
  return out;
}

export function discoverCheckpoint(): string | null {
  const r = spawnSync(comfyBin(), ['--json', 'models', 'list-folder', 'checkpoints'], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  try {
    const env = JSON.parse(r.stdout);
    const rows = env?.data?.rows ?? env?.data?.files ?? [];
    return rows[0]?.name ?? null;
  } catch { return null; }
}

export async function runComfyGolden(o: ComfyGoldenOpts): Promise<ComfyGoldenResult> {
  const dir = o.dir ?? process.cwd();
  const pre = comfyPreflight();
  if (!pre.ok) {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'comfy golden not_configured', policy: 'human-gated', status: 'failed', error_class: 'not_configured', discrepancies: ['comfy CLI missing'], spans: [], artifacts: [] }, dir);
    return { ok: false, state: 'not_configured', error_class: 'not_configured', note: pre.note, receipt: rec.hash };
  }
  if (!existsSync(o.workflow)) {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'comfy golden blocked (workflow missing)', policy: 'human-gated', status: 'failed', error_class: 'missing_source', discrepancies: [o.workflow], spans: [], artifacts: [] }, dir);
    return { ok: false, state: 'blocked', error_class: 'missing_source', note: `workflow missing: ${o.workflow}`, receipt: rec.hash };
  }
  let wf: Record<string, unknown>;
  try { wf = JSON.parse(readFileSync(o.workflow, 'utf8')); } catch {
    const rec = appendReceipt('runs', { kind: 'run', subject: 'comfy golden blocked (bad workflow json)', policy: 'human-gated', status: 'failed', error_class: 'workflow_invalid_json', spans: [], artifacts: [] }, dir);
    return { ok: false, state: 'blocked', error_class: 'workflow_invalid_json', receipt: rec.hash };
  }
  const checkpoint = discoverCheckpoint();
  const prepared = prepareGoldenWorkflow(wf, { seed: o.seed, checkpoint });
  const wfPath = join(dir, '.timmy', 'comfy-golden-5s.prepared.json');
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(wfPath, JSON.stringify(prepared, null, 2));

  const r = spawnSync(comfyBin(), ['--json', 'run', '--workflow', wfPath, '--where', 'local', '--wait'], { encoding: 'utf8', timeout: o.wall_ms ?? 180000 });
  let env: any = {};
  try { env = JSON.parse(r.stdout ?? ''); } catch { /* non-json */ }
  const code = env?.error?.code as string | undefined;
  if (r.status !== 0 || env?.ok !== true) {
    const errClass = code === 'server_not_running' ? 'not_configured' : (code ?? 'exec');
    const rec = appendReceipt('runs', { kind: 'run', subject: `comfy golden ${errClass}`, policy: 'human-gated', status: 'failed', error_class: errClass, spans: [], artifacts: [] }, dir);
    appendEvent('comfy.golden_failed', { code: errClass }, dir);
    return { ok: false, state: errClass === 'not_configured' ? 'not_configured' : 'blocked', error_class: errClass, note: env?.error?.message ?? (r.stderr ?? '').slice(-300), checkpoint, receipt: rec.hash };
  }
  const outSha = o.out && existsSync(o.out) ? sha(o.out) : undefined;
  const rec = appendReceipt('runs', {
    kind: 'verify', subject: 'comfy golden 5s · deterministic seed pinned', policy: 'human-gated', status: 'ok',
    ...(outSha ? { output_sha256: outSha } : {}),
    spans: [{ name: `comfy headless golden run · seed ${o.seed ?? GOLDEN_SEED} · ckpt ${checkpoint ?? 'none'}`, kind: 'execute_tool' }],
    artifacts: []
  }, dir);
  appendEvent('comfy.golden_ok', { seed: o.seed ?? GOLDEN_SEED, checkpoint }, dir);
  return { ok: true, output_sha256: outSha, checkpoint, receipt: rec.hash };
}
