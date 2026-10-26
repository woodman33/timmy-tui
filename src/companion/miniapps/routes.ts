/**
 * R13 (the 2026-10-26 integration order): the mini-apps' routes on Timmy's companion.
 *
 *   GET  /api/apps               every mini-app: what it is, whether it can be hosted here (or the step it waits on), the
 *                                register's record of its source, and whether this principal's project has it running
 *   POST /api/apps/:id/open      start (or reuse) the app for the request's principal and project; answers a one-time
 *                                launch address for the page's frame (valid for a minute, used once)
 *   POST /api/apps/:id/stop      stop this principal's project's copy (the app's own SIGTERM path ends its native jobs)
 *
 * Each route takes the launch token and, when the request carries one, the user's session (the same guards as /api/app/*):
 * the principal and project come from those checks, never from the request body.
 */
import express from 'express';
import { join } from 'node:path';
import { JobManager } from '../../jobs/index.js';
import { appendReceipt } from '../../utils/receipts.js';
import { projectId } from '../../project/index.js';
import { appDataDir, hostProblem, installedRevision, MiniAppHost, principalKey } from './host.js';
import { MINI_APPS, miniAppOf } from './registry.js';

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

  app.get('/api/apps', ...guards, (req, res) => {
    const p = project(req);
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      project: p ? p.name : null,
      apps: MINI_APPS.map((a) => {
        const problem = a.availability === 'hostable' ? hostProblem(a, deps.env) : null;
        const running = p && a.availability === 'hostable' ? Boolean(host.get(keyOf(a.id, req, p.root))) : false;
        return {
          id: a.id, title: a.title, kind: a.kind, lead: a.lead, availability: a.availability,
          hostable: a.availability === 'hostable' && problem === null, problem, running, observed: a.observed,
          installed: a.availability === 'hostable' ? installedRevision(a, deps.env) : null,
        };
      }),
    });
  });

  app.post('/api/apps/:id/open', ...guards, async (req, res) => {
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
      const hosted = await host.ensure({
        spec, key: keyOf(spec.id, req, p.root), dir: deps.env[spec.host!.sourceEnv]!,
        dataDir: appDataDir(home, spec.id, projectId(p.root)), base: deps.env,
        ancestors: [`http://127.0.0.1:${port}`, `http://localhost:${port}`], jobs: jobsOf(home), project: p.name,
        revision: installedRevision(spec, deps.env),
        // each of the app's ended jobs: one receipt in this project's runs chain (where its chat turns are sealed)
        seal: (r) => appendReceipt('runs', { ...r, project_id: projectId(p.root) }, p.root).id,
      });
      // (this principal's grants to the same app in their other projects end: an old tab cannot act in the project left)
      const revoked = host.revokeOthers(hosted.key);
      res.set('Cache-Control', 'no-store').json({ ok: true, id: spec.id, project: p.name, url: hosted.launch(), startedAt: hosted.startedAt, job: hosted.jobId, revokedElsewhere: revoked });
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

  return host;
}
