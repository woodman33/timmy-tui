/**
 * R13 (the 2026-10-26 integration order): an owner's app's finished jobs, sealed as Timmy's canonical receipts.
 *
 * The apps keep their own records (Model Studio and Animate: local hash manifests, Card Lab: an unsigned local hash chain,
 * Film Room: local sha256 files). Timmy does not relabel those as sealed: while it hosts the app, it reads the app's own
 * record of its jobs (./app-jobs.ts), and for each job that record says ended (the app's word, never upgraded) it seals ONE
 * receipt into the project's `runs` chain (src/utils/receipts.ts appendReceipt: hash-chained, signed where the store signs)
 * with:
 *   - the app's job id, kind, label and state, and its error when it failed;
 *   - every file the job made, hashed by Timmy from the bytes the app serves (path, sha256, bytes), not from the app's claim;
 *     a file the app did not serve (or larger than 200 MiB) is listed as not hashed, never left out silently;
 *   - the sha256 of the app's own record of the job exactly as it reported it (the record itself is not copied);
 *   - who started it: not observed by Timmy (the app's own UI or its local assistant).
 * Each job is sealed once: the sealed ids are kept beside the app's data folder (<data dir>.timmy-sealed.json), so a restart
 * never seals again.
 *
 * The integrated candidate's checklist, A6: with `deliver` (the routes give it the project's folder), each hashed file is also
 * written into the project, at from-apps/<app>/<job>/<its name>, from the same bytes, and the receipt names that path, so the
 * person finds the result in Timmy's Files beside its receipt. A file already there is never written over: one with other
 * bytes is kept, and the receipt keeps the app's own name for that output (apps/<app>/<name>).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import type { MiniAppSpec } from './registry.js';

/** What the watcher hands the seal (the routes bind it to appendReceipt in the project's store). */
export interface AppJobReceipt {
  kind: 'miniapp';
  subject: string;
  policy: string;
  /** Timmy's word from the app's: succeeded → ok; failed or interrupted → failed; cancelled → cancelled */
  status: 'ok' | 'failed' | 'cancelled';
  job: { id: string; kind: string; label: string; state: string; error?: string };
  outputs: Array<{ path: string; sha256: string; bytes: number }>;
  /** files the job made that the app did not serve to Timmy (or over the size limit): named, not hashed */
  outputs_unhashed?: string[];
  miniapp: { app: string; title: string; revision: string | null; record_sha256: string; started_by: string; principal: string };
  project?: string;
}

const MAX_FILE = 200 * 1024 * 1024;

function fetchBytes(port: number, path: string, secret?: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    // (the worker's guard answers only Timmy: src/companion/miniapps/host.ts WORKER_HEADER)
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...(secret ? { 'x-timmy-worker': secret } : {}) }, timeout: 15_000 }, (res) => {
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
  /** the worker's secret (its guard refuses a request without it) */
  workerSecret?: string;
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
  /** writes one output into the project (deliverInto): true when the file there holds exactly these bytes */
  deliver?: (rel: string, bytes: Buffer) => boolean;
}

/** The project-relative path an app job's output is delivered at: from-apps/<app>/<job>/<its name>, made safe. */
export function deliveredPath(app: string, job: string, name: string): string | null {
  const parts = String(name).split(/[\\/]/).filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..')) return null;
  if (parts.length > 1 && parts[0] === job) parts.shift(); // (Animate names its files under the job's own folder)
  const clean = (x: string): string => x.replace(/[^A-Za-z0-9._ +()-]/g, '_').slice(0, 120);
  return ['from-apps', clean(app), clean(job), ...parts.map(clean)].join('/');
}

/** Writes an app job's output into the project (never over a file that is there with other bytes). */
export function deliverInto(root: string): (rel: string, bytes: Buffer) => boolean {
  const base = resolve(root, 'from-apps');
  return (rel, bytes) => {
    try {
      const abs = resolve(root, rel);
      if (!abs.startsWith(`${base}${sep}`)) return false;
      if (existsSync(abs)) return sha(readFileSync(abs)) === sha(bytes);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(`${abs}.timmy-part`, bytes, { flag: 'wx' });
      renameSync(`${abs}.timmy-part`, abs);
      return true;
    } catch { return false; }
  };
}

/** Reads the app's state now: seals each newly ended job; resolves to the receipts it sealed. */
export async function sealFinished(o: WatchOptions, sealed: Set<string>): Promise<string[]> {
  const r = o.spec.host?.receipts;
  if (!r) return [];
  const json = async (path: string) => { const b = await fetchBytes(o.workerPort, path, o.workerSecret); if (!b) return null; try { return JSON.parse(b.toString('utf8')) as unknown; } catch { return null; } };
  let finished;
  try { finished = await r.finished({ json, dataDir: o.dataDir }); } catch { return []; }
  const out: string[] = [];
  for (const j of finished) {
    if (sealed.has(j.id)) continue;
    const outputs: AppJobReceipt['outputs'] = [];
    const unhashed: string[] = [];
    for (const f of j.files) {
      const bytes = await fetchBytes(o.workerPort, f.path, o.workerSecret);
      if (bytes) {
        const rel = o.deliver ? deliveredPath(o.spec.id, j.id, f.name) : null;
        const here = rel !== null && o.deliver!(rel, bytes);
        outputs.push({ path: here ? rel! : `apps/${o.spec.id}/${f.name}`, sha256: sha(bytes), bytes: bytes.length });
      }
      else unhashed.push(`apps/${o.spec.id}/${f.name}`);
    }
    const id = o.seal({
      kind: 'miniapp',
      subject: `miniapp · ${o.spec.id} · ${j.label} · ${j.status}`,
      policy: 'app-initiated',
      // (the reader's outcome from the app's own word: anything but the app's success is failed or cancelled)
      status: j.outcome === 'ok' || j.outcome === 'cancelled' ? j.outcome : 'failed',
      job: { id: j.id, kind: j.kind, label: j.label, state: j.status, ...(j.error ? { error: j.error } : {}) },
      outputs,
      ...(unhashed.length ? { outputs_unhashed: unhashed } : {}),
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
