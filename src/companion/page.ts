/**
 * R4 (H92): what the browser companion's page is served with, so that it loads nothing from the internet.
 *
 * Found on the Mac (r23c, CHECKPOINTS row 173): the page (`timmy watch`, src/companion/client/index.html) loaded code from
 * public CDNs: React, Streamdown and its plugins through esm.sh (about 1,130 requests), the Tailwind Play CDN, GSAP from
 * cdnjs, Google Fonts and Streamdown's style sheet from unpkg. That code ran with the page's rights, so it could read the
 * page's token and use the companion's routes (POST /chat spends the operator's OpenRouter key).
 *
 * Now every file the page uses is this server's own: the page and its script and style sheet (src/companion/client,
 * COMPANION_RUNTIME_FILES in server.ts) and its built web code (/web/, below).
 * Every answer carries the page's Content-Security-Policy (pagePolicy): scripts and style sheets only from this server, no
 * inline script, event handler or style attribute, requests only to this server and its own WebSocket, no plugins, no
 * <base>, no form posts, and no page may frame it; with nosniff, no referrer and no DNS prefetching (a model's links would
 * otherwise have the browser look up their names). Slate 3D, which the page frames, may be framed by this origin only.
 *
 * R4 (H95): the page has its own design again (companion.css, as at b69ab12) and its STREAMDOWN CHAT tab is Streamdown
 * again, both from this computer: the companion's built web code at /web/ (src/companion/web-assets.ts; built by
 * scripts/companion-web-build.mjs): the chat island and its chunks (React, Streamdown, Shiki, Mermaid), Streamdown's
 * style sheet and its Tailwind classes, and the page's three fonts (Outfit, Inter, Fira Code). The policy stays as strict
 * as the page works under (PAGE_STYLE_SRC, PAGE_IMG_SRC say what each relaxation is for).
 *
 * R4 (H97): the files of H92's page that H95's replaced and no page asked for any more (its chat and markdown scripts,
 * src/companion/client/chat.js and markdown.js, and the routes /timmy-theme.css, /fonts/<name> and /vendor/marked.esm.js)
 * are no longer shipped or served. Timmy Canvas keeps its own /timmy-theme.css and /fonts/<name> (src/studio/server.ts).
 *
 * R5 (H132, the operator's palette, DESIGN.md §10 B10): the page is drawn in Timmy's shared look again, so /timmy-theme.css
 * (src/theme/tokens.ts themeCss: the --timmy-* variables and Monaspace Argon's faces) and the four Monaspace Argon files
 * those faces name (by exact name, from the @fontsource/monaspace-argon package, OFL-1.1, unmodified) are served here, as
 * Timmy Canvas serves its own. The files are at /web/fonts/<name>, beside the page's other font files (the page's files are
 * its own and /web/'s; a page without its token asks for nothing else), answered before the built web code's own files.
 * The page's sheet (companion.css) uses only those variables. Outfit, Inter and Fira Code (b69ab12's look) are no longer
 * named by the page. /chat.js, /markdown.js, /vendor/marked.esm.js and /fonts/<name> stay gone.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import type express from 'express';
import { FONT_FILES, themeCss } from '../theme/tokens.js';
import { failRequest } from '../utils/server-failure.js';
import { sendWebFile } from './web-assets.js';

/**
 * A Host header as the local rule lets it through (src/utils/local-request.ts), as a policy can name it: a name or an IPv4
 * address, and a port. ([::1] cannot be written in a policy's source list; there 'self' alone covers the page's socket.)
 */
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * R4 (H95): the page's style sheets are its own; inline styles are allowed for Mermaid alone. Measured in a real Chromium
 * (tests/companion-page-browser.test.ts): drawing one flowchart, Mermaid writes a <style> element into the diagram's SVG and
 * sets style attributes on its parts (with d3 and DOMPurify), and Streamdown inserts that SVG as markup; under
 * style-src 'self' every one of them was refused and the diagram lost its look. Shiki's colours and Streamdown's own
 * styles are set through the DOM (React's style objects), which a policy does not govern, and needed nothing. Scripts stay
 * 'self' only (no 'unsafe-inline', no 'unsafe-eval'); a style can fetch nothing here, since fonts, images and requests are
 * held to this server ('self').
 */
export const PAGE_STYLE_SRC = "style-src 'self' 'unsafe-inline'";

/**
 * R4 (H95): images from this server and data: images. Measured in a real Chromium: Streamdown's "Download diagram → PNG"
 * paints the drawn diagram's own SVG onto a canvas by loading it as a data:image/svg+xml image, which img-src 'self'
 * refused (no download). A data: image is made in the page from bytes it already holds: it fetches nothing from anywhere,
 * and an image runs no script. Images from any other site stay refused.
 */
export const PAGE_IMG_SRC = "img-src 'self' data:";

/**
 * The companion page's policy. `host`: the request's Host, which the local rule has already checked; the page's own
 * WebSocket (ws://<host>) is named beside 'self' (some browsers do not count ws: as 'self').
 */
/**
 * R11 round 4 (H171, step 4): what the identity provider adds to connect-src, only when configured: the Clerk instance's
 * frontend API (H173's identityConfig / connectSrcFor: " https://<host>", exactly one https origin, nothing else). Set once by
 * the server (setPagePolicyConnect); '' leaves the policy as it was. script-src stays 'self'.
 */
let policyConnect = '';
const CONNECT_ORIGIN = /^ https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;
export function setPagePolicyConnect(extra: string): void {
  policyConnect = typeof extra === 'string' && CONNECT_ORIGIN.test(extra) ? extra : '';
}

export function pagePolicy(host: string | undefined): string {
  const socket = typeof host === 'string' && HOST.test(host) ? ` ws://${host}` : '';
  return [
    "default-src 'none'",
    "script-src 'self'",
    PAGE_STYLE_SRC,
    "font-src 'self'",
    PAGE_IMG_SRC,
    `connect-src 'self'${socket}${policyConnect}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Slate 3D's built page (only in a source checkout that built it; companion/slate3d, not changed here): only its own
 * scripts, no plugins, no <base>, framed by this origin only (the companion's Slate 3D tab). Its style sheets, fonts and
 * requests are as its page asks: this policy does not narrow them.
 */
export const SLATE_POLICY = "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";

/** The words page where Slate 3D's bundle is not built: this server's style sheets only, framed by this origin only. */
export const SLATE_ABSENT_POLICY = "default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/** The headers every answer carries beside its policy. */
function safetyHeaders(res: Response, policy: string, framing: 'DENY' | 'SAMEORIGIN'): void {
  res.setHeader('Content-Security-Policy', policy);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', framing);
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

/** Middleware: every answer of the companion with the page's policy; Slate 3D's paths with Slate 3D's. */
export function companionHeaders(req: Request, res: Response, next: NextFunction): void {
  if (/^\/slate3d(?:\/|$)/.test(req.path)) safetyHeaders(res, SLATE_POLICY, 'SAMEORIGIN');
  else {
    safetyHeaders(res, pagePolicy(req.headers.host), 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }
  next();
}

const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Where Slate 3D's bundle is not built: its words as a page of Timmy's look (r23c, row 173: they were plain text, drawn black
 * on the companion's dark frame). No script, no path of this computer. R4 (H95): in the companion's own look (its text
 * colour on the frame's ground, Inter), as the page around it. R4 (H104, r25's D11): status 200: the words are the page
 * (the npm package never ships Slate 3D's bundle, so this is what an installed companion's SLATE 3D tab shows), and a 404
 * made the browser log "Failed to load resource … 404" in the companion page's console each time the tab was opened.
 * R5 (H132): in Timmy's shared look (the theme's text on the canvas, in Monaspace Argon).
 */
export function sendSlateAbsent(res: Response, words: string): void {
  if (res.headersSent) { res.destroy(); return; }
  safetyHeaders(res, SLATE_ABSENT_POLICY, 'SAMEORIGIN');
  res.status(200).set('Cache-Control', 'no-store').type('text/html; charset=utf-8').send([
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Slate 3D</title>',
    // R5 (H132): Timmy's shared look first (the page's sheet uses its variables only)
    `<link rel="stylesheet" href="${THEME_PATH}">`,
    '<link rel="stylesheet" href="/companion.css"></head>',
    `<body class="slate-absent"><p>${escHtml(words)}</p></body></html>`,
    '',
  ].join('\n'));
}

/** The page's own files at /web/ (the built chat, its styles, its fonts), from `webDir` when a test gives one. */
export function mountWebAssets(app: express.Application, webDir?: string): void {
  app.get(/^\/web\//, (req, res, next) => {
    sendWebFile(req.path, res, webDir).then((handled) => { if (!handled) next(); }, () => failRequest(res, 500, FONT_ABSENT, 'text'));
  });
}

export const FONT_ABSENT = 'No such font here: the page uses this computer\'s own monospace font instead.';

/**
 * R11 round 4 (H171, step 3): the Rive runtime for the T mark, served from its package (@rive-app/canvas, a runtime
 * dependency; no CDN: the page's CSP is 'self'): /vendor/rive/rive.js and /vendor/rive/rive.wasm by exact name. Not
 * installed → 404 in words; the page keeps its text mark.
 */
export const RIVE_PATH = '/vendor/rive/';
const RIVE_FILES: Readonly<Record<string, string>> = { 'rive.js': 'text/javascript; charset=utf-8', 'rive.wasm': 'application/wasm' };
export function riveDir(): string | null {
  try { return dirname(createRequire(import.meta.url).resolve('@rive-app/canvas/package.json')); } catch { return null; }
}
export const RIVE_ABSENT = 'The Rive runtime is not installed here (@rive-app/canvas): the page draws its text mark instead.';
export function mountRive(app: express.Application): void {
  app.get(`${RIVE_PATH}:file`, (req, res, next) => {
    const file = String(req.params.file);
    const type = RIVE_FILES[file];
    const dir = type ? riveDir() : null;
    if (!type || !dir || !existsSync(join(dir, file))) { if (type) failRequest(res, 404, RIVE_ABSENT, 'text'); else next(); return; }
    res.set('Cache-Control', 'public, max-age=86400').type(type).sendFile(join(dir, file), (err?: Error) => { if (err) failRequest(res, 404, RIVE_ABSENT, 'text'); });
  });
}

/**
 * R11 round 4 (H171, step 3): the T mark's files (src/companion/assets/mark/: the preview's proposed T mark — its Rive source
 * scene.rml and rive.yaml, and timmy-mark.riv when the binary is there; a proposed mark, not a final mascot), at /assets/<name>
 * by exact name. A file not there → 404 in words; the page keeps its text mark.
 */
export const MARK_FILES: Readonly<Record<string, string>> = { 'timmy-mark.riv': 'application/octet-stream', 'scene.rml': 'text/plain; charset=utf-8', 'rive.yaml': 'text/plain; charset=utf-8' };
export const MARK_ABSENT = 'The T mark’s file is not in this installation: the page draws its text mark instead.';
export function markDir(assetsDir?: string): string {
  return assetsDir ?? join(dirname(fileURLToPath(import.meta.url)), 'assets', 'mark');
}
export function mountMark(app: express.Application, assetsDir?: string): void {
  const dir = markDir(assetsDir);
  app.get('/assets/:file', (req, res, next) => {
    const file = String(req.params.file);
    const type = MARK_FILES[file];
    if (!type) { next(); return; }
    if (!existsSync(join(dir, file))) { failRequest(res, 404, MARK_ABSENT, 'text'); return; }
    res.set('Cache-Control', 'public, max-age=3600').type(type).sendFile(join(dir, file), (err?: Error) => { if (err) failRequest(res, 404, MARK_ABSENT, 'text'); });
  });
}

/** R5 (H132): the path of the theme's style sheet (the variables and the font faces), as the page links it. */
export const THEME_PATH = '/timmy-theme.css';
/** R5 (H132): where the theme's font faces find their files (themeCss's fontPath), beside the page's other web files. */
export const THEME_FONT_PATH = '/web/fonts/';

/** R5 (H132): Monaspace Argon's files, from its package (a runtime dependency); null when it is not installed. */
export function themeFontDir(): string | null {
  try {
    return join(dirname(createRequire(import.meta.url).resolve('@fontsource/monaspace-argon/package.json')), 'files');
  } catch {
    return null;
  }
}

/** The only font files the page's theme names, by exact name (src/theme/tokens.ts FONT_FILES). */
const THEME_FONTS: ReadonlySet<string> = new Set(FONT_FILES.map((f) => f.file));

/**
 * R5 (H132): Timmy's shared look for the page: the theme's sheet (no project content, so no token) and Monaspace Argon's
 * files by exact name. Mounted before the built web code (mountWebAssets): any other name under /web/fonts/, or a Monaspace
 * file the package does not have here, goes on to it, which answers its own files or a 404 in words (no path of this
 * computer); the page then falls back to this computer's own monospace font (the theme's stack).
 */
export function mountTheme(app: express.Application): void {
  const css = themeCss(THEME_FONT_PATH);
  app.get(THEME_PATH, (_req, res) => {
    res.set('Cache-Control', 'no-store').type('text/css; charset=utf-8').send(css);
  });
  app.get(`${THEME_FONT_PATH}:file`, (req, res, next) => {
    const file = String(req.params.file);
    const dir = THEME_FONTS.has(file) ? themeFontDir() : null;
    if (!dir || !existsSync(join(dir, file))) { next(); return; }
    res.set('Cache-Control', 'public, max-age=86400').type('font/woff2').sendFile(join(dir, file), (err?: Error) => {
      if (err) failRequest(res, 404, FONT_ABSENT, 'text');
    });
  });
}
