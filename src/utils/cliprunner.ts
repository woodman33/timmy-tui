import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import { appendReceipt } from './receipts.js';
import { publish as appendEvent } from '../bus/index.js';
import { captureEnvLock, relHome, type EnvLock } from './envlock.js';
import { applyEdl, makeFragment, type Edl } from './edl.js';
import type { ClipJob } from './clip.js';

// T1 clip runner: the EDL cut-list IS the edit (specs/edl-v1.md). The .md
// runbook is for humans; replay reads ONLY manifest.edl. Every run seals an
// env-locked, ed25519-signed receipt — success AND failure alike.

export interface RunResult {
  ok: boolean;
  verified?: boolean;
  runDir?: string;
  receiptHash?: string;
  output?: string;
  outputSha?: string;
  note?: string;
}

// repo-vs-spec flags (T1 work order: repo wins, flag in the run receipt)
const DISCREPANCIES = [
  'spec §1.2 permits media display; repo CLIP tab shows manifests only — QC via mpv (repo wins)',
  'spec §1.4 has_sig field was absent from T0 receipts (treated unsigned); T1 adds signature'
];

const sha = (p: string): string => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');

// v0.5 replay integrity: before rendering, the ACTIVE environment (os, arch,
// executable build hashes) and every sealed source hash must match the sealed
// record. Mismatches reject with a signed failure receipt — no silent replays
// on drifted machines.
const resolveRel = (p: string, dir: string): string =>
  p.startsWith('~') ? join(homedir(), p.slice(1)) : isAbsolute(p) ? p : join(dir, p);

export const envMismatches = (sealed: EnvLock, dir: string): string[] => {
  const now = captureEnvLock(['ffmpeg', 'ffprobe'], dir);
  const m: string[] = [];
  if (now.os.platform !== sealed.os.platform) m.push(`os ${sealed.os.platform}→${now.os.platform}`);
  if (now.os.build !== sealed.os.build) m.push(`os build ${sealed.os.build}→${now.os.build}`);
  if (now.arch !== sealed.arch) m.push(`arch ${sealed.arch}→${now.arch}`);
  for (const [name, t] of Object.entries(sealed.tools ?? {})) {
    const cur = now.tools?.[name];
    if (!cur) m.push(`tool missing: ${name}`);
    else if (cur.sha256 !== t.sha256) m.push(`tool build-hash drift: ${name}`);
  }
  return m;
};

export function defaultEdl(job: ClipJob): Edl {
  return {
    edl_version: 1,
    output: job.output,
    clips: [{ src: makeFragment(job.sources[0].artifact, 2, 8) }],
    concat: false
  };
}

const runbook = (job: ClipJob, edl: Edl, outSha: string): string => [
  `# TIMMY Clip runbook — ${job.id}`,
  '',
  `instruction (human): ${job.instruction}`,
  '',
  'machine cut-list (the edit; replay reads this alone):',
  '```json',
  JSON.stringify(edl, null, 2),
  '```',
  '',
  `output sha256:${outSha}`
].join('\n') + '\n';

export function runClipJob(job: ClipJob, dir: string = process.cwd()): RunResult {
  if (!job.sources[0]) {
    const rec = appendReceipt('runs', {
      kind: 'run', subject: `clip ${job.id} · ${job.project}`, policy: 'human-gated',
      status: 'failed', error_class: 'schema', exit_code: 2,
      partial_artifacts: [], discrepancies: DISCREPANCIES
    }, dir);
    return { ok: false, receiptHash: rec.hash, note: 'no sources linked — SLATE [c] links gens with receipt hashes' };
  }
  const src = job.sources[0].artifact;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(dir, '.timmy', 'runs', `run_${ts}`);
  mkdirSync(runDir, { recursive: true });
  const env_lock = captureEnvLock(['ffmpeg', 'ffprobe'], dir);
  const edl: Edl = (job as ClipJob & { edl?: Edl }).edl ?? defaultEdl(job);

  let result: { output: string; sha256: string };
  try {
    result = applyEdl(edl);
  } catch (e) {
    const err = e as Error & { code?: string };
    const error_class = err.code === 'missing_source' ? 'missing_source' : err.code === 'exec' ? 'exec' : 'schema';
    writeFileSync(join(runDir, 'replay.md'), `# replay (FAILED)\n\nedl: ${JSON.stringify(edl)}\nerror: ${err.message}\n`);
    const rec = appendReceipt('runs', {
      kind: 'run', subject: `clip ${job.id} · ${job.project}`, policy: 'human-gated',
      spans: [{ name: 'edl apply', kind: 'execute_tool' }],
      edl, env_lock, status: 'failed', error_class, exit_code: 1,
      partial_artifacts: [relHome(join(runDir, 'replay.md'))],
      discrepancies: DISCREPANCIES
    }, dir);
    writeFileSync(join(runDir, 'receipt.json'), JSON.stringify(rec, null, 2));
    appendEvent('run.failed', { lane: 'clip', job: job.id, error_class }, dir);
    return { ok: false, runDir, receiptHash: rec.hash, note: `${error_class}: ${err.message}` };
  }

  const manifest = {
    job: job.id,
    task: job.instruction,
    lang: 'edl',
    lane: 'clip',
    edl,
    env_lock,
    sources: [{ artifact: relHome(src), sha256: sha(src), receipt: job.sources[0].receiptHash ?? null }],
    model: null,
    output_sha256: result.sha256,
    created_at: new Date().toISOString(),
    discrepancies: DISCREPANCIES
  };
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(runDir, 'replay.md'), runbook(job, edl, result.sha256));

  const rec = appendReceipt('runs', {
    kind: 'run', subject: `clip ${job.id} · ${job.project}`, policy: 'human-gated',
    spans: [{ name: 'edl stream-copy cut', kind: 'execute_tool' }],
    edl, env_lock, output_sha256: result.sha256, status: 'ok', cost_usd: 0,
    artifacts: [relHome(result.output)], discrepancies: DISCREPANCIES
  }, dir);
  writeFileSync(join(runDir, 'receipt.json'), JSON.stringify(rec, null, 2));
  appendEvent('run.completed', { lane: 'clip', job: job.id, out: result.sha256.slice(0, 16) }, dir);
  return { ok: true, runDir, receiptHash: rec.hash, output: result.output, outputSha: result.sha256 };
}

export function findRunForJob(jobId: string, dir: string = process.cwd()): { runDir: string; manifest: Record<string, any> } | null {
  const runs = join(dir, '.timmy', 'runs');
  if (!existsSync(runs)) return null;
  const dirs = readdirSync(runs).filter(d => d.startsWith('run_')).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const mp = join(runs, dirs[i], 'manifest.json');
    if (!existsSync(mp)) continue;
    try {
      const m = JSON.parse(readFileSync(mp, 'utf8')) as Record<string, any>;
      if (m.job === jobId) return { runDir: join(runs, dirs[i]), manifest: m };
    } catch { /* skip */ }
  }
  return null;
}

// Exit-criterion verifier: replay from the cut-list ALONE, compare hashes.
export function replayFromEdl(jobId: string, dir: string = process.cwd()): RunResult {
  const found = findRunForJob(jobId, dir);
  if (!found) return { ok: false, note: `no sealed run for ${jobId}` };
  const { manifest, runDir } = found;
  const edl = manifest.edl as Edl;

  // Pre-render enforcement: sealed environment + sealed source hashes.
  const envProblems = manifest.env_lock
    ? envMismatches(manifest.env_lock as EnvLock, dir)
    : ['no sealed env_lock (T0-grade run; not replayable at v0.5)'];
  const srcProblems: string[] = [];
  for (const s of (manifest.sources ?? []) as { artifact: string; sha256: string }[]) {
    const p = resolveRel(s.artifact, dir);
    if (!existsSync(p)) srcProblems.push(`missing source: ${s.artifact}`);
    else if (sha(p) !== s.sha256) srcProblems.push(`source hash drift: ${s.artifact}`);
  }
  if (envProblems.length > 0 || srcProblems.length > 0) {
    const rec = appendReceipt('runs', {
      kind: 'verify', subject: `replay ${jobId} · rejected (env/source mismatch)`, policy: 'auto',
      status: 'failed', error_class: envProblems.length ? 'env' : 'source_drift',
      edl, env_lock: captureEnvLock(['ffmpeg', 'ffprobe'], dir),
      discrepancies: [...envProblems, ...srcProblems]
    }, dir);
    appendEvent('run.failed', { lane: 'clip', job: jobId, error_class: envProblems.length ? 'env' : 'source_drift' }, dir);
    return { ok: false, runDir, receiptHash: rec.hash, note: [...envProblems, ...srcProblems].join('; ') };
  }

  const replayOut = join(dirname(edl.output), `.replay_${jobId}.mp4`);
  let result: { output: string; sha256: string };
  try {
    result = applyEdl({ ...edl, output: replayOut });
  } catch (e) {
    const rec = appendReceipt('runs', {
      kind: 'verify', subject: `replay ${jobId}`, policy: 'auto',
      status: 'failed', error_class: 'exec', edl,
      env_lock: captureEnvLock(['ffmpeg', 'ffprobe'], dir)
    }, dir);
    return { ok: false, runDir, receiptHash: rec.hash, note: (e as Error).message };
  }
  const match = result.sha256 === manifest.output_sha256;
  // The signed verify record binds EDL + manifest + sources + output hash.
  const rec = appendReceipt('runs', {
    kind: 'verify', subject: `replay ${jobId} · ${match ? 'match' : 'drift'}`, policy: 'auto',
    status: match ? 'ok' : 'failed', ...(match ? {} : { error_class: 'replay_drift' as const }),
    edl, output_sha256: result.sha256,
    manifest_sha256: sha(join(runDir, 'manifest.json')),
    sources: manifest.sources,
    env_lock: captureEnvLock(['ffmpeg', 'ffprobe'], dir)
  }, dir);
  appendEvent(match ? 'run.completed' : 'run.failed', { lane: 'clip', job: jobId, verify: match }, dir);
  return { ok: match, verified: match, runDir, receiptHash: rec.hash, output: result.output, outputSha: result.sha256, note: match ? 'replay matches sealed output' : 'replay drift' };
}
