/**
 * R11 round 4 (H173, contract C1): the companion's identity routes, mounted by src/companion/server.ts.
 *
 *   route                                      requires                 why
 *   GET /api/identity                          the launch token         identityConfig's public part (pageIdentity): configured,
 *                                                                       the publishable key, the frontend API, the exact env
 *                                                                       names needed, the words; never a PEM, never a secret
 *   GET /vendor/clerk/<file>.js|.mjs           nothing more             Clerk's JS from node_modules/@clerk/clerk-js/dist/ (the
 *                                                                       whole folder, by plain file name), served by the companion
 *                                                                       so the page's script-src stays 'self' (no CDN); the page
 *                                                                       loads CLERK_SCRIPT; absent: 404 with words
 *   GET /account, /account/callback            nothing more             the page (as GET /): the account screen, and where Clerk's
 *                                                                       OAuth (Google, GitHub) lands back; no token in the address
 *   GET /api/identity/me                       the token + the user     who the session is, as verified here: { user: { id,
 *                                                                       sessionId, username?, email? } }; the operator:
 *                                                                       { user: { id: 'operator', operator: true }, words }
 *   GET /api/projects                          the token + the user     the user's projects: { projects: [{ id, name, root }],
 *                                                                       default: <id> } (scope.ts userProjects; the default made);
 *                                                                       the operator's: the companion's own (the follower's)
 *   POST /api/projects { name }                the token + the user     makes one under the user's home: { id, name, root }
 *   GET /api/files, /api/files/file            the token + the user     the project's files, read-only (src/companion/workspace.ts
 *                                                                       mountFiles; R11 round 7): the Files page and Chat's attachments
 *
 * "The user" is the verified session's — or, on a companion with NO identity provider configured, the OPERATOR principal
 * (middleware.ts: the launch token's holder; session.ts operatorUser), for whom every route answers as the companion always
 * did (its own home, keys and projects). Nothing here signs anyone in: the page does that with Clerk's JS against the
 * instance; this server only verifies what the page then sends (withUser).
 */
import type { Application, RequestHandler, Response } from 'express';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { projectId } from '../../project/index.js';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failRequest } from '../../utils/server-failure.js';
import type { ActiveProject } from '../../project/index.js';
import { identityConfig, pageIdentity, type Env, type IdentityConfig } from './config.js';
import { userOf, withUser, type WithUserOptions } from './middleware.js';
import { createUserProject, userEnv, userProjectFor, userProjects, type UserProject } from './scope.js';
import { isOperator, OPERATOR_WORDS } from './session.js';
import { mountFiles } from '../workspace.js';

/**
 * The build the page loads, as @clerk/clerk-js 6.40.1 ships it (checked against the installed dist/, 2026-10-23):
 *   clerk.no-rhc.mjs  — ES module, "no remote hosted code": self-contained (no lazily loaded chunk, and no loader for the
 *                       captcha script at challenges.cloudflare.com that clerk.browser.js injects when the instance's bot
 *                       protection is on), so the page's script-src 'self' holds by construction. Exports the Clerk class;
 *                       account.js imports it (import() from a classic script, same origin) and runs `new Clerk(key).load()`.
 *   clerk.no-rhc.js   — the same as CommonJS (ends in `exports`): NOT loadable by a <script src>, so not this.
 *   clerk.browser.js  — UMD for a <script data-clerk-publishable-key>; its chunks (vendors_…, cookieSuffix_…) resolve from the
 *                       script's own folder (document.currentScript), so they would come from here too, but it carries the
 *                       captcha loader. Served too (the whole dist/ is), not loaded by the page.
 * The version here is not Clerk's "headless" build of v4/v5 (clerk.headless.browser.js), which v6 does not ship.
 */
export const CLERK_SCRIPT = 'clerk.no-rhc.mjs';
export const CLERK_VENDOR_PATH = '/vendor/clerk/';
export const CLERK_ABSENT = 'Clerk\'s script is not installed in this build (node_modules/@clerk/clerk-js is missing), so the account screen cannot load the identity provider\'s code. Install the package in a checkout, or reinstall Timmy.';
export const IDENTITY_NO_PROJECT = 'That project is not one of this account\'s (its id names none of your projects, or the path is outside them), so nothing was read.';

export interface IdentityDeps {
  /** The launch token's check (server.ts withToken), first on every content route. */
  withToken: RequestHandler;
  /** A small JSON body parser (express.json({ limit })), after the user is verified, for POST /api/projects. */
  json: RequestHandler;
  /** The environment the configuration is read from (a test's; process.env when absent). */
  env?: Env;
  /** The page, as GET / sends it (server.ts sendPage). */
  sendPage: (res: Response) => void;
  /** Where Clerk's built files are (a test's FAKE folder); found from node_modules when absent. */
  clerkDir?: string;
  /** withUser's options (the LAN addresses, a test's origins, JWKS or clock). */
  user?: WithUserOptions;
  /**
   * The companion's own project rule for the OPERATOR principal (server.ts projectFor: ?project=<id> among the projects it
   * has shown, else the one followed). Preferred over scope.ts's operator rule (which sees the fixed/active project and
   * <TIMMY_HOME>/projects, not what a page pinned) when given.
   */
  operator?: { projectFor: (req: Parameters<RequestHandler>[0]) => ActiveProject | null; current: () => ActiveProject };
}

export interface IdentityMount {
  /** The configuration read at mount (identityConfig(env)). */
  cfg: IdentityConfig;
  /** The middleware the other owners put after withToken on every route that reads or writes user data. */
  withUser: RequestHandler;
  /** The user's env for a request behind withUser (scope.ts userEnv); the operator's is the companion's own. */
  envOf: (req: Parameters<RequestHandler>[0]) => Env;
  /**
   * The project a request behind withUser is about, for EITHER principal: the user's by ?project=<id> or path, else their
   * default (scope.ts userProjectFor); the operator's by the companion's own rule (deps.operator.projectFor, else scope.ts's).
   * null when it is not one of theirs: the route answers with words (IDENTITY_NO_PROJECT) and reads nothing.
   */
  projectFor: (req: Parameters<RequestHandler>[0]) => UserProject | null;
  /** Where Clerk's files are served from, or null when the package is not installed. */
  clerkDir: string | null;
}

/** node_modules/@clerk/clerk-js/dist, at or above this module's folder (a checkout's or the installed package's), else null. */
export function findClerkDist(from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '@clerk', 'clerk-js', 'dist');
    try { if (statSync(candidate).isDirectory() && existsSync(join(candidate, CLERK_SCRIPT))) return candidate; } catch { /* not here */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** A plain file name of Clerk's dist/: no path, no link, no other folder; .js (the chunks, the UMD) or .mjs (the module). */
export const VENDOR_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.m?js$/;

export function mountIdentity(app: Application, deps: IdentityDeps): IdentityMount {
  const env = deps.env ?? process.env;
  const cfg = identityConfig(env);
  const guard = withUser(cfg, deps.user ?? {});
  const clerkDir = deps.clerkDir === undefined ? findClerkDist() : (existsSync(join(deps.clerkDir, CLERK_SCRIPT)) ? deps.clerkDir : null);

  app.get('/api/identity', deps.withToken, (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, ...pageIdentity(cfg), clerkScript: clerkDir ? `${CLERK_VENDOR_PATH}${CLERK_SCRIPT}` : null, ...(clerkDir ? {} : { clerkWords: CLERK_ABSENT }) });
  });

  // Clerk's dist/ (the module the page imports, and every .js/.mjs beside it), by plain file name only: no path, no link,
  // no other folder, nothing but JavaScript (types/, maps and package files are not served)
  app.get(`${CLERK_VENDOR_PATH}:file`, (req, res) => {
    const file = String(req.params.file ?? '');
    if (!clerkDir) { failRequest(res, 404, CLERK_ABSENT, 'text'); return; }
    if (!VENDOR_FILE.test(file)) { failRequest(res, 404, 'No such file of Clerk\'s here.', 'text'); return; }
    const p = join(clerkDir, file);
    // a regular file that really is in dist/ (a link leading out of the folder is not Clerk's file)
    try {
      if (!statSync(p).isFile()) throw new Error('not a file');
      const real = realpathSync(p); const dir = realpathSync(clerkDir);
      if (!real.startsWith(dir + sep)) throw new Error('out of the folder');
    } catch { failRequest(res, 404, 'No such file of Clerk\'s here.', 'text'); return; }
    // text/javascript: the one MIME type a module script (import()) is accepted with, and fine for a classic script
    res.set('Cache-Control', 'public, max-age=3600').set('X-Content-Type-Options', 'nosniff').type('text/javascript; charset=utf-8').sendFile(p, (err?: Error) => {
      if (err && !res.headersSent) failRequest(res, 500, 'Clerk\'s script could not be read.', 'text');
    });
  });

  // who this session is, as THIS SERVER verified it (the page shows the account from this, never from what it decoded itself);
  // the operator principal says so in words
  app.get('/api/identity/me', deps.withToken, guard, (req, res) => {
    const user = userOf(req);
    res.set('Cache-Control', 'no-store');
    if (isOperator(user)) { res.json({ ok: true, user: { id: user.id, operator: true }, words: OPERATOR_WORDS }); return; }
    res.json({ ok: true, user: { id: user.id, sessionId: user.sessionId, ...(user.username ? { username: user.username } : {}), ...(user.email ? { email: user.email } : {}) } });
  });

  // the account screen by its own address, and where Clerk's OAuth lands back (the page reads the callback; no token in the address)
  app.get(['/account', '/account/', '/account/callback', '/account/callback/'], (_req, res) => { deps.sendPage(res); });

  const envOf = (req: Parameters<RequestHandler>[0]): Env => userEnv(userOf(req), env);
  const asView = (p: ActiveProject): UserProject => ({ id: projectId(p.root), name: p.name, root: p.root, chosen: true });
  const projectFor = (req: Parameters<RequestHandler>[0]): UserProject | null => {
    const user = userOf(req);
    if (isOperator(user) && deps.operator) { const p = deps.operator.projectFor(req); return p ? asView(p) : null; }
    return userProjectFor(user, envOf(req), req.query.project);
  };

  app.get('/api/projects', deps.withToken, guard, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const user = userOf(req);
      const env = envOf(req);
      const own = userProjects(user, env);
      const projects = own.roots.map((root) => userProjectFor(user, env, root)).filter((p): p is NonNullable<typeof p> => Boolean(p));
      // the default: the user's (scope.ts); the operator's as the companion names it (deps.operator: the followed project,
      // which the operator's roots then include even when it is one the companion was pointed at by a page)
      const def = isOperator(user) && deps.operator ? deps.operator.current() : null;
      const defView = def ? asView(def) : userProjectFor(user, env);
      if (defView && !projects.some((p) => p.id === defView.id)) projects.unshift(defView);
      res.json({ ok: true, projects: projects.map(({ id, name, root }) => ({ id, name, root })), default: defView?.id ?? null, ...(isOperator(user) ? { operator: true, words: OPERATOR_WORDS } : {}) });
    } catch { failRequest(res, 500, 'This account\'s projects could not be read; nothing was written.'); }
  });

  app.post('/api/projects', deps.withToken, guard, deps.json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    let body: unknown = req.body;
    if (!body || typeof body !== 'object') body = {};
    try {
      const made = createUserProject(userOf(req), envOf(req), (body as { name?: unknown }).name);
      if ('error' in made) { res.status(400).json({ ok: false, error: `Not made: ${made.error}.` }); return; }
      res.status(201).json({ ok: true, id: made.id, name: made.name, root: made.root });
    } catch { failRequest(res, 500, 'The project could not be made; nothing was written.'); }
  });

  // R11 round 7 (H173): the project's files, read-only, for the Files page and Chat's attachments (src/companion/workspace.ts
  // mountFiles): behind the launch token and the user, on identity.projectFor's project — mounted here so the one project
  // rule serves both principals (the user's own project; the operator's by the companion's own rule)
  mountFiles(app, { withToken: deps.withToken, withUser: guard, projectFor, envOf });

  return { cfg, withUser: guard, envOf, projectFor, clerkDir };
}
