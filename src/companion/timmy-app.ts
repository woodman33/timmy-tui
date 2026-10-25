/**
 * R12 (the operator's order of 2026-10-25, 03:04 PT: "spend the night coding the timmy tui into rive and tldraw dont stop until
 * its done"): the Timmy app — Timmy's main UI as a tldraw board of cards with the Rive faces (companion/timmy-app, bundled on
 * this machine by scripts/canvas/build-app.mjs) — served by the browser companion at /app, beside the companion's own page.
 *
 *   GET /app, /app/                the app's page (companion/timmy-app/index.html), under its own policy (appPolicy)
 *   GET /app/dist/<file>           its bundle (app.js, app.css), tldraw's own fonts, icons and translations, the license texts
 *   GET /api/app/config            { ok, tldrawVersion, licenseKey, built, principal, project: { name, root }, ollama } — the launch token first (the
 *                                  key is the operator's); the project is the one the request's principal works in (the operator's
 *                                  followed project, or a signed-in user's own), its root the one the Chat's turn names
 *
 * The app reads and acts through the companion's existing routes only (the Chat's /api/chat/*, the providers' /api/connections/*,
 * the Rive listing /api/rive/assets), with the same launch token in an Authorization header; it has no route of its own that
 * reads a project, sends a prompt or spends. Nothing here starts a model.
 *
 * The policy is the companion page's, with the two things tldraw needs: inline styles (tldraw positions its shapes and menus
 * with style attributes) and data:/blob: images and fonts (its icons are inlined; a pasted image is a blob). Scripts stay this
 * server's own ('self', plus 'wasm-unsafe-eval' for the Rive runtime's WebAssembly); requests only to this server and its own
 * WebSocket; no frames, plugins, <base> or form posts; no page may frame it.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioConfig } from '../studio/config.js';
import { installSteps, SIZE_NOTE, STARTER_MODELS } from '../setup/ollama-local.js';

type Env = Record<string, string | undefined>;

/** Where the app's page and its bundle are: companion/timmy-app in a source checkout and in the installed package alike. */
export function appRoot(): string {
  const candidates = ['../../companion/timmy-app', '../../../companion/timmy-app'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  return candidates.find(existsSync) ?? candidates[0];
}

/** The words where the bundle is not built (a source checkout before `npm run build:app`). */
export const APP_NOT_BUILT = 'The Timmy app is not built on this computer: run npm run build:app in the checkout (the installed package ships it built).';

const HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

/** The app page's Content-Security-Policy (see the header). */
export function appPolicy(host: string | undefined): string {
  const socket = typeof host === 'string' && HOST.test(host) ? ` ws://${host}` : '';
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self'${socket}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface TimmyAppDeps {
  /** the launch token's check (src/companion/server.ts withToken) */
  withToken: express.RequestHandler;
  /** the environment the tldraw license key is read from (TLDRAW_LICENSE_KEY), this process's when absent */
  env?: Env;
  /** the folder the page and its dist/ are served from (a test's); appRoot() when absent */
  root?: string;
  /** a signed-in user's session when the request carries one (src/companion/server.ts withUserOrOperator) */
  withUser?: express.RequestHandler;
  /** the project the request's principal works in (name and root), null when none is known */
  projectOf?: (req: express.Request) => { name: string; root: string } | null;
}

export function mountTimmyApp(app: express.Application, deps: TimmyAppDeps): { root: string } {
  const root = deps.root ?? appRoot();
  const dist = join(root, 'dist');
  const policy: express.RequestHandler = (req, res, next) => {
    res.setHeader('Content-Security-Policy', appPolicy(req.headers.host));
    next();
  };
  const page = (_req: express.Request, res: express.Response): void => {
    const file = join(root, 'index.html');
    if (!existsSync(file) || !existsSync(join(dist, 'app.js'))) { res.status(200).type('text/plain').set('Cache-Control', 'no-store').send(`${APP_NOT_BUILT}\n`); return; }
    res.set('Cache-Control', 'no-store').type('text/html').sendFile(file);
  };
  app.get(['/app', '/app/', '/app/index.html'], policy, page);
  app.use('/app/dist', policy, express.static(dist, { etag: true, index: false, fallthrough: true }));
  const guards = [deps.withToken, deps.withUser].filter((g): g is express.RequestHandler => typeof g === 'function');
  app.get('/api/app/config', ...guards, (req, res) => {
    const config = studioConfig(deps.env ?? process.env);
    const p = (() => { try { return deps.projectOf ? deps.projectOf(req) : null; } catch { return null; } })();
    // R12 (the finish brief's private-cache scope): who this page reads as, as a short one-way key (never the id itself): the
    // page keys what it keeps in its browser (the Canvas desk) by it, so two principals on one browser never share a desk
    const u = (req as express.Request & { user?: { id?: unknown; operator?: boolean } }).user;
    const principal = !u || u.operator ? 'operator' : `u-${createHash('sha256').update(`timmy-app:${String(u.id ?? '')}`).digest('hex').slice(0, 16)}`;
    res.set('Cache-Control', 'no-store').json({
      ok: true, tldrawVersion: config.tldrawVersion, licenseKey: config.licenseKey, built: existsSync(join(dist, 'app.js')),
      principal,
      project: p ? { name: p.name, root: p.root } : null,
      // the local models' starters (what the Models card offers to download, each only after its size and the person's yes)
      // and how Ollama is installed and started on this computer's system (words and the official page; nothing is run)
      ollama: { starters: STARTER_MODELS.map(({ model, size, use, page, default: d }) => ({ model, size, use, page, default: d })), sizeNote: SIZE_NOTE, install: installSteps(process.platform) },
    });
  });
  return { root };
}
