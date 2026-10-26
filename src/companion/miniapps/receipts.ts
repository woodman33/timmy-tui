/**
 * R13 (the 2026-10-26 integration order): an owner's app's finished jobs, sealed as Timmy's canonical receipts.
 *
 * The app keeps its own records (Model Studio: a local hash manifest per job, unsigned). Timmy does not relabel those as
 * sealed: while it hosts the app, it reads the app's state, and for each job the app reports ended (its own word, never
 * upgraded) it seals ONE receipt into the project's `runs` chain (src/utils/receipts.ts appendReceipt: hash-chained, signed
 * where the store signs) with:
 *   - the app's job id, kind, label and state, and its error when it failed;
 *   - every file the job made, hashed by Timmy from the bytes the app serves (path, sha256, bytes), not from the app's claim;
 *   - the sha256 of the app's own record of the job exactly as it reported it (the record itself is not copied);
 *   - who started it: not observed by Timmy (the app's own UI or its local assistant).
 * Each job is sealed once: the sealed ids are kept beside the app's data folder (<data dir>.timmy-sealed.json), so a restart
 * never seals again.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname } from 'node:path';
import type { FinishedAppJob, MiniAppSpec } from './registry.js';

/** What the watcher hands the seal (the routes bind it to appendReceipt in the project's store). */
export interface AppJobReceipt {
  kind: 'miniapp';
  subject: string;
  policy: string;
  /** Timmy's word from the app's: succeeded → ok; failed or interrupted → failed; cancelled → cancelled */
  status: 'ok' | 'failed' | 'cancelled';
  job: { id: string; kind: string; label: string; state: string; error?: string };
  outputs: Array<{ path: string; sha256: string; bytes: number }>;
  miniapp: { app: string; title: string; revision: string | null; record_sha256: string; started_by: string; principal: string };
  project?: string;
}

const STATUS: Record<string, AppJobReceipt['status']> = { succeeded: 'ok', failed: 'failed', interrupted: 'failed', cancelled: 'cancelled' };

const MAX_FILE = 200 * 1024 * 1024;

function fetchBytes(port: number, path: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` }, timeout: 15_000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks: Buffer[] = []; let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > MAX_FILE) { req.destroy(); resolve(null); return; } chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** A canonical JSON (sorted keys) of what the app reported, for its hash. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export interface WatchOptions {
  spec: MiniAppSpec;
  workerPort: number;
  /** the app's data folder: the sealed ids are kept beside it */
  dataDir: string;
  revision: string | null;
  project?: string;
  seal: (r: AppJobReceipt) => string | undefined;
  /** the principal's one-way key (src/companion/miniapps/host.ts principalKey), sealed with each job */
  principal: string;
  /**
   * The app job ids this app, principal and project already have a receipt for, read from the chain itself: a job is never
   * sealed twice even when the sealed-ids file is gone or the app replays its history after a restart.
   */
  known?: () => string[];
  everyMs?: number;
}

/** Reads the app's state now: seals each newly ended job; resolves to the receipts it sealed. */
export async function sealFinished(o: WatchOptions, sealed: Set<string>): Promise<string[]> {
  const r = o.spec.host?.receipts;
  if (!r) return [];
  const body = await fetchBytes(o.workerPort, r.statePath);
  if (!body) return [];
  let state: unknown;
  try { state = JSON.parse(body.toString('utf8')); } catch { return []; }
  const out: string[] = [];
  for (const j of r.finished(state) as FinishedAppJob[]) {
    if (sealed.has(j.id)) continue;
    const outputs: AppJobReceipt['outputs'] = [];
    for (const f of j.files) {
      const bytes = await fetchBytes(o.workerPort, `/api/assets/${encodeURIComponent(f.assetId)}/${encodeURIComponent(f.filename)}`);
      if (bytes) outputs.push({ path: `apps/${o.spec.id}/${f.assetId}/${f.filename}`, sha256: sha(bytes), bytes: bytes.length });
    }
    const id = o.seal({
      kind: 'miniapp',
      subject: `miniapp · ${o.spec.id} · ${j.label} · ${j.status}`,
      policy: 'app-initiated',
      status: STATUS[j.status] ?? 'failed',
      job: { id: j.id, kind: j.kind, label: j.label, state: j.status, ...(j.error ? { error: j.error } : {}) },
      outputs,
      miniapp: { app: o.spec.id, title: o.spec.title, revision: o.revision, record_sha256: sha(canon(j.raw)), started_by: 'not observed by Timmy (the app’s own controls or its local assistant)', principal: o.principal },
      ...(o.project ? { project: o.project } : {}),
    });
    sealed.add(j.id);
    if (id) out.push(id);
  }
  return out;
}

/** Watches a hosted app's state while it runs; stop() ends it after one last read. */
export function watchAppJobs(o: WatchOptions): { stop: () => Promise<void>; tick: () => Promise<string[]> } {
  // (beside the app's data folder, never inside it: <data dir>.timmy-sealed.json)
  const file = `${o.dataDir}.timmy-sealed.json`;
  let sealed: Set<string>;
  try { sealed = new Set((JSON.parse(readFileSync(file, 'utf8')) as { jobs?: string[] }).jobs ?? []); } catch { sealed = new Set(); }
  // (the chain is the record: what it already holds for this app, principal and project counts as sealed)
  try { for (const id of o.known?.() ?? []) sealed.add(id); } catch { /* the chain unreadable: the file's ids stand */ }
  const keep = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify({ jobs: [...sealed] }), { mode: 0o600 }); renameSync(`${file}.tmp`, file); };
  let busy: Promise<string[]> = Promise.resolve([]);
  const tick = () => {
    busy = busy.catch(() => []).then(async () => { const before = sealed.size; const r = await sealFinished(o, sealed); if (sealed.size !== before) keep(); return r; });
    return busy;
  };
  const timer = setInterval(() => { void tick(); }, o.everyMs ?? 2000);
  timer.unref();
  return { tick, stop: async () => { clearInterval(timer); await tick().catch(() => []); } };
}
