/**
 * R13 (the 2026-10-26 integration order): the mini-apps' routes on Timmy's companion.
 *
 *   GET  /api/apps               every mini-app: what it is, whether it can be hosted here (or the step it waits on), the
 *                                register's record of its source, and whether this principal's project has it running
 *   POST /api/apps/:id/open      start (or reuse) the app for the request's principal and project; answers a one-time
 *                                launch address for the page's frame (valid for a minute, used once)
 *   POST /api/apps/:id/stop      stop this principal's project's copy (the app's own SIGTERM path ends its native jobs)
 *   GET  /api/apps/provenance    ?path=<project file>: the receipt that names this file with these bytes (an app job's output
 *                                delivered into the project, the checklist's A6), or none
 *   GET  /api/apps/outputs       the apps' results delivered into this project, newest first, each file with where it was sent
 *   POST /api/apps/card-lab/handoff  { path }: the checklist's A11 — an image of the project (an Animate preview, say) as a
 *                                new Card Lab run (Card Lab's own POST /api/runs, started for this principal and project when
 *                                it is not running), the bytes it holds checked against the file's, and ONE handoff receipt
 *                                naming the source file, its receipt and the target run
 *
 * Each route takes the launch token and, when the request carries one, the user's session (the same guards as /api/app/*):
 * the principal and project come from those checks, never from the request body.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { JobManager } from '../../jobs/index.js';
import { appendReceipt, readChain } from '../../utils/receipts.js';
import { projectId } from '../../project/index.js';
import { appDataDir, hostProblem, installedRevision, installedSource, MiniAppHost, principalKey } from './host.js';
import { MINI_APPS, miniAppOf } from './registry.js';
import { deliverInto } from './receipts.js';
import { OPERATIONS } from '../workflow-ops.js';

type Env = Record<string, string | undefined>;

export interface MiniAppDeps {
  withToken: express.RequestHandler;
  withUser?: express.RequestHandler;
  /** the request's principal's project (name, root) and that principal's env (its TIMMY_HOME), null when none is open */
  projectOf: (req: express.Request) => { name: string; root: string; env: Env } | null;
  /** the companion's environment (where the apps' folders and native engines are named) */
  env: Env;
  host?: MiniAppHost;
}

const HOST = /^(?:127\.0\.0\.1|localhost):\d{1,5}$/;
export const APPS_NO_PROJECT = 'No project is open for this page, so a mini-app has nowhere to keep its work: open one in Timmy (`timmy app` in its folder).';

export function mountMiniApps(app: express.Application, deps: MiniAppDeps): MiniAppHost {
  const host = deps.host ?? new MiniAppHost();
  const guards = [deps.withToken, deps.withUser].filter((g): g is express.RequestHandler => typeof g === 'function');
  const who = (req: express.Request) => principalKey((req as express.Request & { user?: { id?: unknown; operator?: boolean } }).user);
  const project = (req: express.Request) => { try { return deps.projectOf(req); } catch { return null; } };
  const keyOf = (appId: string, req: express.Request, root: string) => `${appId}:${who(req)}:${projectId(root)}`;
  // one job manager per Timmy home: a worker's job is kept with that principal's other jobs (<home>/jobs)
  const managers = new Map<string, JobManager>();
  const jobsOf = (home: string) => { let m = managers.get(home); if (!m) { m = new JobManager({ dir: join(home, 'jobs') }); managers.set(home, m); } return m; };

  /** Starts (or reuses) an app for the request's principal and project, its receipts sealed into that project. */
  const ensureFor = (spec: NonNullable<ReturnType<typeof miniAppOf>>, req: express.Request, p: { name: string; root: string; env: Env }, port: string) => {
    const home = p.env.TIMMY_HOME!;
    return host.ensure({
      spec, key: keyOf(spec.id, req, p.root), dir: deps.env[spec.host!.sourceEnv]!,
      dataDir: appDataDir(home, spec.id, projectId(p.root)), base: deps.env,
      ancestors: [`http://127.0.0.1:${port}`, `http://localhost:${port}`], jobs: jobsOf(home), project: p.name,
      parentOrigin: typeof req.headers.host === 'string' && HOST.test(req.headers.host) ? `http://${req.headers.host}` : `http://127.0.0.1:${port}`,
      revision: installedRevision(spec, deps.env),
      // each of the app's ended jobs: one receipt in this project's runs chain (where its chat turns are sealed)
      seal: (r) => appendReceipt('runs', { ...r, project_id: projectId(p.root) }, p.root).id,
      principal: who(req),
      // the checklist's A6: what the job made, delivered into the project's Files (from-apps/<app>/<job>/)
      deliver: deliverInto(p.root),
      known: () => readChain('runs', p.root).filter((r) => r.kind === 'miniapp' && r.miniapp?.app === spec.id && r.miniapp?.principal === who(req) && typeof r.job?.id === 'string').map((r) => r.job!.id),
    });
  };

  /** this principal's ok receipts of each app's ended jobs in the project, newest first (hash prefixes) */
  const receiptsOf = (appId: string, req: express.Request, root: string): string[] => {
    try {
      return readChain('runs', root).filter((r) => r.kind === 'miniapp' && r.miniapp?.app === appId && r.miniapp?.principal === who(req) && r.status === 'ok')
        .map((r) => String(r.hash).slice(7, 15)).reverse();
    } catch { return []; }
  };
  /** the operations the host itself starts for an app (each a route of this file) */
  const HOST_OPERATIONS: Record<string, Array<{ id: string; label: string; where: Array<'canvas' | 'control-room' | 'terminal' | 'page'>; how: string }>> = {
    'card-lab': [{ id: 'inspect-image', label: 'Inspect an image of the project', where: ['page'], how: 'POST /api/apps/card-lab/handoff (Files: Send to Image Analysis)' }],
  };
  const listing = (req: express.Request) => {
    const p = project(req);
    return MINI_APPS.map((a) => {
      const problem = a.availability === 'hostable' ? hostProblem(a, deps.env) : null;
      const running = p && a.availability === 'hostable' ? Boolean(host.get(keyOf(a.id, req, p.root))) : false;
      return {
        id: a.id, title: a.title, kind: a.kind, lead: a.lead, availability: a.availability,
        hostable: a.availability === 'hostable' && problem === null, problem, running, observed: a.observed,
        theme: a.host?.theme ?? null,
        installed: a.availability === 'hostable' ? installedSource(a, deps.env) : null,
        receipts: p ? receiptsOf(a.id, req, p.root) : [],
        // the host's own routes for the app, and the Workspace's operations that dispatch to its jobs (src/companion/workflow-ops.ts)
        operations: [...(HOST_OPERATIONS[a.id] ?? []), ...OPERATIONS.filter((o) => o.app === a.id).map((o) => ({ id: o.id, label: o.label, where: ['canvas' as const], how: `a Workspace operation node (${o.adapter})` }))],
      };
    });
  };
  host.listing = (req) => (project(req as express.Request) ? listing(req as express.Request) : null);
  host.appFor = async (r, appId) => {
    const req = r as express.Request;
    const spec = miniAppOf(appId);
    if (!spec) return { error: 'No such mini-app.', status: 404 };
    const problem = hostProblem(spec, deps.env);
    if (problem) return { error: problem, status: 409 };
    const p = project(req);
    if (!p) return { error: APPS_NO_PROJECT, status: 404 };
    if (!p.env.TIMMY_HOME) return { error: 'This principal has no Timmy home to keep the app’s data in.', status: 500 };
    const self = typeof req.headers.host === 'string' && HOST.test(req.headers.host) ? req.headers.host : null;
    if (!self) return { error: 'Mini-apps open only on this computer’s address.', status: 403 };
    try { return await ensureFor(spec, req, p, self.split(':')[1]); } catch (e) { return { error: e instanceof Error ? e.message : String(e), status: 502 }; }
  };
  host.runningFor = (r, appId) => { const req = r as express.Request; const p = project(req); return p ? host.get(keyOf(appId, req, p.root)) ?? null : null; };

  app.get('/api/apps', ...guards, (req, res) => {
    const p = project(req);
    res.set('Cache-Control', 'no-store').json({ ok: true, project: p ? p.name : null, apps: listing(req) });
  });

  app.post('/api/apps/:id/open', ...guards, express.json({ limit: '2kb' }), async (req, res) => {
    const spec = miniAppOf(String(req.params.id));
    if (!spec) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: 'No such mini-app.' }); return; }
    const problem = hostProblem(spec, deps.env);
    if (problem) { res.status(409).set('Cache-Control', 'no-store').json({ ok: false, error: problem, observed: spec.observed }); return; }
    const p = project(req);
    if (!p) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: APPS_NO_PROJECT }); return; }
    const home = p.env.TIMMY_HOME;
    if (!home) { res.status(500).set('Cache-Control', 'no-store').json({ ok: false, error: 'This principal has no Timmy home to keep the app’s data in.' }); return; }
    const self = typeof req.headers.host === 'string' && HOST.test(req.headers.host) ? req.headers.host : null;
    if (!self) { res.status(403).set('Cache-Control', 'no-store').json({ ok: false, error: 'Mini-apps open only on this computer’s address.' }); return; }
    const port = self.split(':')[1];
    try {
      const hosted = await ensureFor(spec, req, p, port);
      // (this principal's grants to the same app in their other projects end: an old tab cannot act in the project left)
      const revoked = host.revokeOthers(hosted.key);
      res.set('Cache-Control', 'no-store').json({ ok: true, id: spec.id, project: p.name, url: hosted.launch((req.body as { to?: unknown } | undefined)?.to as string | undefined), startedAt: hosted.startedAt, job: hosted.jobId, revokedElsewhere: revoked });
    } catch (e) {
      res.status(502).set('Cache-Control', 'no-store').json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // the page renews its browser's grant while it holds a valid session (a grant not renewed ends in GRANT_MS: a signed-out
  // session cannot renew, so its frames are refused within that time)
  app.post('/api/apps/:id/renew', ...guards, (req, res) => {
    const spec = miniAppOf(String(req.params.id));
    const p = project(req);
    const hosted = spec && p ? host.get(keyOf(spec.id, req, p.root)) : undefined;
    if (!hosted) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: 'Not running for this project: open it again.' }); return; }
    res.set('Cache-Control', 'no-store').json({ ok: true, grants: hosted.renew() });
  });

  // end every grant this principal holds in every app (the page calls it before signing out)
  app.post('/api/apps/revoke', ...guards, (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, revoked: host.revokePrincipal(who(req)) });
  });

  app.post('/api/apps/:id/stop', ...guards, async (req, res) => {
    const spec = miniAppOf(String(req.params.id));
    const p = project(req);
    if (!spec || !p) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: spec ? APPS_NO_PROJECT : 'No such mini-app.' }); return; }
    const stopped = await host.stop(keyOf(spec.id, req, p.root));
    res.set('Cache-Control', 'no-store').json({ ok: true, stopped });
  });

  // the checklist's A6: which receipt names this project file, with exactly these bytes
  app.get('/api/apps/provenance', ...guards, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const p = project(req);
    if (!p) { res.status(404).json({ ok: false, error: APPS_NO_PROJECT }); return; }
    const f = projectFile(p.root, String(req.query.path ?? ''));
    if (!f.ok) { res.status(f.status).json({ ok: false, error: f.error }); return; }
    res.json({ ok: true, path: f.rel, sha256: f.sha256, receipt: provenanceOf(p.root, f.rel, f.sha256), sent: handoffsOf(p.root, f.rel, f.sha256) });
  });

  // the 05:03 order's G3: the apps' results in this project, newest first — each job's delivered files by name, with where each
  // was sent since (a handoff receipt naming it). Files shows these first; the from-apps/<app>/<job>/ paths stay underneath.
  app.get('/api/apps/outputs', ...guards, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const p = project(req);
    if (!p) { res.status(404).json({ ok: false, error: APPS_NO_PROJECT }); return; }
    res.json({ ok: true, project: p.name, results: appOutputsOf(p.root, 24) });
  });

  // the checklist's A11: one supported cross-app handoff — a project image as a new Card Lab run
  app.post('/api/apps/card-lab/handoff', ...guards, express.json({ limit: '4kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const spec = miniAppOf('card-lab')!;
    const problem = hostProblem(spec, deps.env);
    if (problem) { res.status(409).json({ ok: false, error: problem }); return; }
    const p = project(req);
    if (!p) { res.status(404).json({ ok: false, error: APPS_NO_PROJECT }); return; }
    if (!p.env.TIMMY_HOME) { res.status(500).json({ ok: false, error: 'This principal has no Timmy home to keep the app’s data in.' }); return; }
    const self = typeof req.headers.host === 'string' && HOST.test(req.headers.host) ? req.headers.host : null;
    if (!self) { res.status(403).json({ ok: false, error: 'Mini-apps open only on this computer’s address.' }); return; }
    const f = projectFile(p.root, String((req.body as { path?: unknown } | undefined)?.path ?? ''));
    if (!f.ok) { res.status(f.status).json({ ok: false, error: f.error }); return; }
    const mime = imageMime(f.bytes);
    if (!mime) { res.status(415).json({ ok: false, error: 'Image Analysis takes a PNG, JPEG or WebP image; this file is none of them (by its bytes).' }); return; }
    if (f.bytes.length > 8 * 1024 * 1024) { res.status(413).json({ ok: false, error: 'Image Analysis takes an image of at most 8 MB.' }); return; }
    const source = provenanceOf(p.root, f.rel, f.sha256);
    try {
      const hosted = await ensureFor(spec, req, p, self.split(':')[1]);
      const name = f.rel.split('/').pop()!.slice(0, 180);
      const r = await hosted.request('POST', '/api/runs', { images: [{ dataUrl: `data:${mime};base64,${f.bytes.toString('base64')}`, name, view: 'front' }] });
      const run = r.json as { id?: unknown; images?: Array<{ sha256?: unknown }> } | null;
      if (r.status !== 201 || !run || typeof run.id !== 'string') { res.status(502).json({ ok: false, error: `Card Lab did not make the run (it answered ${r.status}${run && typeof (run as { error?: unknown }).error === 'string' ? `: ${(run as { error: string }).error}` : ''}). Nothing was sealed.` }); return; }
      const held = run.images?.[0]?.sha256;
      if (held !== f.sha256) { res.status(502).json({ ok: false, error: `Card Lab made run ${run.id}, but the image it holds is not this file's bytes (${String(held).slice(0, 12)} ≠ ${f.sha256.slice(0, 12)}). Nothing was sealed.` }); return; }
      const rc = appendReceipt('runs', {
        kind: 'handoff', subject: `handoff · ${f.rel} → Card Lab ${run.id}`, policy: 'human-gated', status: 'ok',
        project: p.name, project_id: projectId(p.root),
        files: [{ path: f.rel, sha256: f.sha256, bytes: f.bytes.length }],
        handoff: {
          from: { path: f.rel, sha256: f.sha256, receipt: source ? source.id : null, app: source ? source.app : null, job: source ? source.job : null },
          to: { app: 'card-lab', run: run.id, image_sha256: String(held), revision: installedRevision(spec, deps.env) },
          principal: who(req),
        },
      }, p.root);
      res.json({ ok: true, run: run.id, receipt: rc.hash.slice(7, 15), source, sha256: f.sha256 });
    } catch (e) {
      res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  return host;
}

/** A regular file inside the project, read whole (at most 64 MiB), its path relative to the project; never outside it. */
export function projectFile(root: string, given: string): { ok: true; rel: string; bytes: Buffer; sha256: string } | { ok: false; status: number; error: string } {
  const rel = given.replace(/^\/+/, '');
  if (!rel || rel.split(/[\\/]/).includes('..')) return { ok: false, status: 400, error: 'Name a file of the project by its path in it.' };
  let real: string; let base: string;
  try { base = realpathSync(root); real = realpathSync(resolve(root, rel)); } catch { return { ok: false, status: 404, error: 'No such file in the project.' }; }
  if (!real.startsWith(`${base}${sep}`)) return { ok: false, status: 400, error: 'That path leaves the project.' };
  const st = statSync(real);
  if (!st.isFile()) return { ok: false, status: 400, error: 'That is not a file.' };
  if (st.size > 64 * 1024 * 1024) return { ok: false, status: 413, error: 'The file is larger than this route reads.' };
  const bytes = readFileSync(real);
  return { ok: true, rel: relative(base, real).split(sep).join('/'), bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The newest receipt in the project's chain that names this file with exactly these bytes, as an output or a file. */
function provenanceOf(root: string, rel: string, sha256: string): { id: string; kind: string; app: string | null; job: string | null; at: string } | null {
  let chain: ReturnType<typeof readChain> = [];
  try { chain = readChain('runs', root); } catch { return null; }
  for (let i = chain.length - 1; i >= 0; i--) {
    const r = chain[i];
    const named = (r.outputs ?? []).some((o) => o.path === rel && o.sha256 === sha256) || (r.kind !== 'handoff' && (r.files ?? []).some((o) => o.path === rel && o.sha256 === sha256));
    if (named) return { id: r.hash.slice(7, 15), kind: r.kind, app: r.miniapp?.app ?? null, job: r.job?.id ?? null, at: r.ts };
  }
  return null;
}

/** The handoff receipts that sent this file, with exactly these bytes, to another app (oldest first). */
function handoffsOf(root: string, rel: string, sha256: string): Array<{ app: string; run: string; receipt: string; at: string }> {
  let chain: ReturnType<typeof readChain> = [];
  try { chain = readChain('runs', root); } catch { return []; }
  return chain.filter((r) => r.kind === 'handoff' && r.handoff && r.handoff.from.path === rel && r.handoff.from.sha256 === sha256)
    .map((r) => ({ app: r.handoff!.to.app, run: r.handoff!.to.run, receipt: r.hash.slice(7, 15), at: r.ts }));
}

type AppResult = {
  receipt: string; app: string; title: string; job: string | null; label: string | null; status: string; at: string;
  files: Array<{ path: string; name: string; sha256: string | null; bytes: number; image: boolean; sent: Array<{ app: string; run: string; receipt: string; at: string }> }>;
};

/** The project chain's app jobs whose outputs were delivered into the project (from-apps/), newest first, at most `limit`. */
function appOutputsOf(root: string, limit: number): AppResult[] {
  let chain: ReturnType<typeof readChain> = [];
  try { chain = readChain('runs', root); } catch { return []; }
  const sent = new Map<string, Array<{ app: string; run: string; receipt: string; at: string }>>();
  for (const r of chain) {
    const h = r.handoff;
    if (r.kind !== 'handoff' || !h) continue;
    const key = `${h.from.path}@${h.from.sha256}`;
    sent.set(key, [...(sent.get(key) ?? []), { app: h.to.app, run: h.to.run, receipt: r.hash.slice(7, 15), at: r.ts }]);
  }
  const out: AppResult[] = [];
  for (let i = chain.length - 1; i >= 0 && out.length < limit; i--) {
    const r = chain[i];
    if (!r.miniapp) continue;
    const files = (r.outputs ?? []).filter((o) => o.path.startsWith('from-apps/'));
    if (!files.length) continue;
    out.push({
      receipt: r.hash.slice(7, 15), app: r.miniapp.app, title: r.miniapp.title, job: r.job?.id ?? null, label: r.job?.label ?? null, status: r.status ?? 'unknown', at: r.ts,
      files: files.map((o) => ({
        path: o.path, name: o.path.split('/').pop() ?? o.path, sha256: o.sha256 ?? null, bytes: o.bytes,
        image: /\.(png|jpe?g|webp|gif)$/i.test(o.path), sent: o.sha256 ? sent.get(`${o.path}@${o.sha256}`) ?? [] : [],
      })),
    });
  }
  return out;
}

/** An image's type by its bytes (PNG, JPEG, WebP), as Card Lab checks it. */
function imageMime(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length > 3 && b[0] === 255 && b[1] === 216) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
