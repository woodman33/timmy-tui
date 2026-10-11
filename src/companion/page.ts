/**
 * R4 (H92): what the browser companion's page is served with, so that it loads nothing from the internet.
 *
 * Found on the Mac (r23c, CHECKPOINTS row 173): the page (`timmy watch`, src/companion/client/index.html) loaded code from
 * public CDNs: React, Streamdown and its plugins through esm.sh (about 1,130 requests), the Tailwind Play CDN, GSAP from
 * cdnjs, Google Fonts and Streamdown's style sheet from unpkg. That code ran with the page's rights, so it could read the
 * page's token and use the companion's routes (POST /chat spends the operator's OpenRouter key).
 *
 * Now every file the page uses is this server's own:
 *   - the page and its scripts and style sheet (src/companion/client, COMPANION_RUNTIME_FILES in server.ts);
 *   - Timmy's look, /timmy-theme.css (src/theme/tokens.ts themeCss), and Monaspace Argon's files at /fonts/<name> for a
 *     computer that does not have the font installed (from @fontsource/monaspace-argon, served unmodified by exact name,
 *     as Timmy Canvas serves them);
 *   - the markdown parser the model chat draws with, `marked`, a dependency of Timmy's: its ES module file from the
 *     installed package, served unmodified at /vendor/marked.esm.js.
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
 */
import type { NextFunction, Request, Response } from 'express';
import type express from 'express';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
export function pagePolicy(host: string | undefined): string {
  const socket = typeof host === 'string' && HOST.test(host) ? ` ws://${host}` : '';
  return [
    "default-src 'none'",
    "script-src 'self'",
    PAGE_STYLE_SRC,
    "font-src 'self'",
    PAGE_IMG_SRC,
    `connect-src 'self'${socket}`,
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
 * on the companion's dark frame). Status 404, as before; no script, no path of this computer. R4 (H95): in the companion's
 * own look (its text colour on the frame's ground, Inter), as the page around it.
 */
export function sendSlateAbsent(res: Response, words: string): void {
  if (res.headersSent) { res.destroy(); return; }
  safetyHeaders(res, SLATE_ABSENT_POLICY, 'SAMEORIGIN');
  res.status(404).set('Cache-Control', 'no-store').type('text/html; charset=utf-8').send([
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Slate 3D</title>',
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

/** A file of an installed package by its path inside the package; null when the package is not installed. */
function packageFile(pkg: string, rel: string): string | null {
  try {
    const file = join(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)), rel);
    return existsSync(file) ? file : null;
  } catch { return null; }
}

/** The only font files served, by exact name (Timmy's theme names them: src/theme/tokens.ts FONT_FILES). */
const SERVED_FONTS: ReadonlySet<string> = new Set(FONT_FILES.map((f) => f.file));

/** What the page is told when marked is missing from the installation. */
export const MARKED_ABSENT = 'The markdown parser (marked) is missing from this installation, so the model chat shows answers as plain text. Reinstall Timmy.';
export const FONT_ABSENT = 'No such font here: the page uses this computer\'s own monospace font instead.';

/**
 * Timmy's look, Monaspace Argon's files and marked, for the companion page. Each answers words when it cannot (never a path
 * of this computer, never a stack). None carries any content of the operator's, so none needs the token.
 */
export function mountPageAssets(app: express.Application): void {
  app.get('/timmy-theme.css', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('text/css').send(themeCss());
  });
  app.get('/fonts/:file', (req, res) => {
    const file = String(req.params.file);
    const path = SERVED_FONTS.has(file) ? packageFile('@fontsource/monaspace-argon', join('files', file)) : null;
    if (!path) { failRequest(res, 404, FONT_ABSENT, 'text'); return; }
    res.set('Cache-Control', 'public, max-age=86400').type('font/woff2').sendFile(path, (err?: Error) => {
      if (err) failRequest(res, 500, FONT_ABSENT, 'text');
    });
  });
  app.get('/vendor/marked.esm.js', (_req, res) => {
    const path = packageFile('marked', join('lib', 'marked.esm.js'));
    if (!path) { failRequest(res, 404, MARKED_ABSENT, 'text'); return; }
    res.set('Cache-Control', 'no-cache').type('text/javascript; charset=utf-8').sendFile(path, (err?: Error) => {
      if (err) failRequest(res, 500, MARKED_ABSENT, 'text');
    });
  });
}
