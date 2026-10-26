/**
 * R13 (the 2026-10-26 integration order): each hosted app's ended jobs, read from what the app itself keeps, for Timmy's
 * canonical receipts (./receipts.ts).
 *
 * The owners' apps keep their jobs in different shapes. Each reader here takes one app's own record as it is and returns
 * the jobs that record says have ended, with:
 *   - the app's own word for the state (never upgraded), and Timmy's outcome from that word (ok, failed or cancelled; an
 *     unknown word is failed, never ok);
 *   - the files the job made, as paths the app serves over its own HTTP API (Timmy hashes the bytes it serves);
 *   - the app's record of the job exactly as read (its hash is sealed, the record is not copied).
 *
 * Where the app's API lists its jobs (Model Studio's /api/state) the reader uses it. Where it does not (Card Lab lists run
 * summaries only, Film Room lists one workspace at a time, Animate lists none), the reader reads the app's own job files in
 * the data folder Timmy gave that app for this principal and project, and nothing outside it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AppOutcome = 'ok' | 'failed' | 'cancelled';

/** One of an app's own jobs that has ended, as the app reports it. */
export interface FinishedAppJob {
  id: string;
  kind: string;
  /** the app's own word for the job's end */
  status: string;
  /** Timmy's word from the app's: ok only where the app's word is its success */
  outcome: AppOutcome;
  label: string;
  error?: string;
  /** name: where the file is recorded (apps/<app>/<name>); path: the GET path on the app's server that serves its bytes */
  files: Array<{ name: string; path: string }>;
  /** the app's record of the job, exactly as it reported it (its hash is sealed; the record is not) */
  raw: unknown;
}

/** What a reader may use: the app's own HTTP state (GET on its loopback port, parsed JSON or null) and its data folder. */
export interface AppJobSource {
  json: (path: string) => Promise<unknown>;
  dataDir: string;
}

const SAFE = /^[\w.-]+$/;
const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
const errorOf = (v: unknown) => (str(v) ? { error: v.slice(0, 300) } : {});

/** Every `<dir>/<entry>/<file>` (or `<dir>/<entry>` when file is null) that parses as JSON, for entries matching `name`. */
function readJsonFiles(dir: string, name: RegExp, file: string | null): unknown[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: unknown[] = [];
  for (const e of entries.filter((x) => name.test(x)).sort()) {
    try { out.push(JSON.parse(readFileSync(file ? join(dir, e, file) : join(dir, e), 'utf8'))); } catch { /* an unreadable record stays the app's to report */ }
  }
  return out;
}

// ── Model Studio (codex/model-studio docs/CONTRACT.md): GET /api/state → jobs[] ─────────────────────────────────────────
const STUDIO: Record<string, AppOutcome> = { succeeded: 'ok', failed: 'failed', interrupted: 'failed', cancelled: 'cancelled' };
export function modelStudioJobs(state: unknown): FinishedAppJob[] {
  const jobs = (state as { jobs?: unknown[] } | null)?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.flatMap((j) => {
    const o = j as { id?: unknown; kind?: unknown; status?: unknown; engine?: unknown; error?: unknown; result?: { asset?: { id?: unknown; previewFilename?: unknown; nativeFilename?: unknown } } };
    if (!str(o.id) || !str(o.status) || !(o.status in STUDIO)) return [];
    const a = o.result?.asset;
    const files = a && str(a.id) && SAFE.test(a.id)
      ? [a.previewFilename, a.nativeFilename].filter((f): f is string => str(f) && SAFE.test(f))
        .map((f) => ({ name: `${a.id as string}/${f}`, path: `/api/assets/${encodeURIComponent(a.id as string)}/${encodeURIComponent(f)}` }))
      : [];
    const kind = str(o.kind) ? o.kind : 'job';
    return [{ id: o.id, kind, status: o.status, outcome: STUDIO[o.status]!, label: `${kind}${str(o.engine) ? ` ${o.engine}` : ''}`, ...errorOf(o.error), files, raw: j }];
  });
}

// ── Card Lab (backend/server.mjs launch): <data>/card_<uuid>/run.json; one job per launch ───────────────────────────────
// A run is launched stage by stage: a `job_started` event opens a launch, and the first of `job_finished` (ready),
// `held` (an error) or `cancel` after it ends it. Its files are the run's served artifacts; because the app overwrites them
// on each launch, only the run's latest ended launch carries them (an earlier launch's bytes are no longer served).
const CARD_END: Record<string, AppOutcome> = { job_finished: 'ok', held: 'failed', cancel: 'cancelled' };
const CARD_FILES = ['card.analyze.json', 'card.receipt.json', 'card.summarize.md'] as const;
export function cardLabJobs(runs: unknown[]): FinishedAppJob[] {
  const out: FinishedAppJob[] = [];
  for (const r of runs) {
    const run = r as { id?: unknown; revision?: unknown; error?: unknown; events?: Array<{ id?: unknown; type?: unknown; at?: unknown; message?: unknown }> };
    if (!str(run.id) || !/^card_[a-f0-9-]{36}$/.test(run.id) || !Array.isArray(run.events)) continue;
    const ended: FinishedAppJob[] = [];
    let open: { id: string; at: unknown; name: string } | null = null;
    for (const e of run.events) {
      if (e.type === 'job_started' && str(e.id)) { open = { id: e.id, at: e.at, name: str(e.message) ? e.message.replace(/ started$/, '') : 'stage' }; continue; }
      const outcome = typeof e.type === 'string' ? CARD_END[e.type] : undefined;
      if (!open || !outcome) continue;
      ended.push({
        id: `${run.id}/${open.id}`, kind: open.name, status: e.type as string, outcome, label: `card ${open.name}`,
        ...(outcome === 'failed' ? errorOf(e.message) : {}), files: [],
        raw: { run: run.id, revision: run.revision ?? null, started: open, ended: e },
      });
      open = null;
    }
    const last = ended.at(-1);
    if (last?.outcome === 'ok') last.files = CARD_FILES.map((f) => ({ name: `${run.id}/${f}`, path: `/api/runs/${encodeURIComponent(run.id as string)}/artifacts/${f}` }));
    out.push(...ended);
  }
  return out;
}

// ── Film Room (server/runtime.mjs, server/API.md): <data>/jobs/<uuid>.json ──────────────────────────────────────────────
// States queued/running/complete/failed/cancelled/interrupted. A render's files are its accepted outputs
// (/api/jobs/:id/files/:name, scoped by its workspace); an ingest's is its managed asset (/api/assets/:id/media).
const FILM: Record<string, AppOutcome> = { complete: 'ok', failed: 'failed', interrupted: 'failed', cancelled: 'cancelled' };
export function filmRoomJobs(jobs: unknown[]): FinishedAppJob[] {
  return jobs.flatMap((j) => {
    const o = j as { id?: unknown; type?: unknown; state?: unknown; error?: unknown; workspaceId?: unknown; result?: Record<string, unknown> };
    if (!str(o.id) || !/^[a-f0-9-]{36}$/.test(o.id) || !str(o.state) || !(o.state in FILM)) return [];
    const files: FinishedAppJob['files'] = [];
    if (o.state === 'complete' && o.result) {
      const scope = str(o.workspaceId) ? `?workspaceId=${encodeURIComponent(o.workspaceId)}` : '';
      const prefix = `/api/jobs/${o.id}/files/`;
      const urls = new Set<string>();
      const visit = (v: unknown) => {
        if (typeof v === 'string' && v.startsWith(prefix) && SAFE.test(v.slice(prefix.length).split('?')[0]!)) urls.add(v.split('?')[0]!);
        else if (v && typeof v === 'object') for (const x of Object.values(v)) visit(x);
      };
      visit(o.result);
      for (const u of [...urls].sort()) files.push({ name: `${o.id}/${u.slice(prefix.length)}`, path: u + scope });
      const asset = (o.result as { asset?: { id?: unknown; name?: unknown } }).asset;
      if (asset && str(asset.id) && /^[a-f0-9-]{36}$/.test(asset.id)) files.push({ name: `assets/${asset.id}/${str(asset.name) && SAFE.test(asset.name) ? asset.name : 'media'}`, path: `/api/assets/${asset.id}/media` });
    }
    const kind = str(o.type) ? o.type : 'job';
    return [{ id: o.id, kind, status: o.state, outcome: FILM[o.state]!, label: kind, ...errorOf(o.error), files, raw: j }];
  });
}

// ── Timmy Animate (server.mjs): <data>/<uuid>/job.json; artifacts it lists at /api/artifacts/:id/:name ────────────────
const ANIMATE: Record<string, AppOutcome> = { succeeded: 'ok', failed: 'failed', interrupted: 'failed', cancelled: 'cancelled' };
export function animateJobs(jobs: unknown[]): FinishedAppJob[] {
  return jobs.flatMap((j) => {
    const o = j as { id?: unknown; status?: unknown; error?: unknown; artifacts?: Array<{ name?: unknown }> };
    if (!str(o.id) || !/^[a-f0-9-]{36}$/.test(o.id) || !str(o.status) || !(o.status in ANIMATE)) return [];
    const files = (Array.isArray(o.artifacts) ? o.artifacts : []).map((a) => a?.name).filter((n): n is string => str(n) && SAFE.test(n))
      .map((n) => ({ name: `${o.id as string}/${n}`, path: `/api/artifacts/${o.id as string}/${n}` }));
    return [{ id: o.id, kind: 'export', status: o.status, outcome: ANIMATE[o.status]!, label: 'export blender', ...errorOf(o.error), files, raw: j }];
  });
}

/** The readers, as the registry binds them to each app. */
export const APP_JOBS = {
  'model-studio': async (s: AppJobSource) => modelStudioJobs(await s.json('/api/state')),
  'card-lab': async (s: AppJobSource) => cardLabJobs(readJsonFiles(s.dataDir, /^card_[a-f0-9-]{36}$/, 'run.json')),
  'film-room': async (s: AppJobSource) => filmRoomJobs(readJsonFiles(join(s.dataDir, 'jobs'), /^[a-f0-9-]{36}\.json$/, null)),
  'animate': async (s: AppJobSource) => animateJobs(readJsonFiles(s.dataDir, /^[a-f0-9-]{36}$/, 'job.json')),
} as const;
