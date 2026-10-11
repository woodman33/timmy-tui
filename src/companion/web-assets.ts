/**
 * R4 (H95): the companion's built web code, served at /web/ by the browser companion (`timmy watch`) and the log
 * companion (`timmy logs`), so their chat pages draw with Streamdown, as they did, without loading anything from a CDN.
 *
 * scripts/companion-web-build.mjs builds it into dist/companion-web (package-relative; package.json "files" ships dist):
 *   /web/island/companion-chat.js, /web/island/logs-chat.js, /web/island/chunks/<name>.js   the islands and their chunks
 *   /web/styles/tailwind.css, /web/styles/streamdown.css                                     Streamdown's look
 *   /web/fonts/<family>-latin-wght-normal.woff2                                              Outfit, Inter and Fira Code
 * Only those three folders, only names of letters, digits, '.', '_' and '-', only .js, .css and .woff2 files, only regular
 * files inside the build (never a link): anything else is a 404 in words.
 *
 * Where it is not built: a source checkout (this module run from src/, by tsx or vitest) builds it on the first request
 * (ensureCompanionWeb: one builder at a time, only when missing or stale); an installed package never builds (it ships
 * the build). Where it is missing all the same, each island's entry answers with a small module of this server's own that
 * says so in words where the chat would be (never a path of this computer), and every other file is a 404 in words.
 */
import { createReadStream, lstatSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagedPath } from '../utils/asset-dirs.js';
import { failRequest } from '../utils/server-failure.js';

/** Where the built web code is, package-relative. */
export const WEB_BUILD = 'dist/companion-web';
export const WEB_PREFIX = '/web/';

/** The files /web/ may answer: folder, name and type. */
const KINDS: ReadonlyArray<{ re: RegExp; type: string }> = [
  { re: /^island\/(?:chunks\/)?[A-Za-z0-9_.-]+\.js$/, type: 'text/javascript; charset=utf-8' },
  { re: /^styles\/[A-Za-z0-9_.-]+\.css$/, type: 'text/css; charset=utf-8' },
  { re: /^fonts\/[A-Za-z0-9_.-]+\.woff2$/, type: 'font/woff2' },
];

/** Whether this module runs from source (a checkout, by tsx or vitest), where the build may be made on demand. */
export const FROM_SOURCE = fileURLToPath(import.meta.url).endsWith('.ts');

/** The words where the chat's code is missing. */
export const WEB_ABSENT_INSTALLED = 'The chat\'s code (Streamdown, built when Timmy is packaged) is missing from this installation, so this tab cannot draw answers. Nothing was loaded from anywhere else. Reinstall Timmy.';
export const WEB_ABSENT_SOURCE = 'The chat\'s code is not built in this checkout, and building it here did not work, so this tab cannot draw answers. Nothing was loaded from anywhere else. Run `node scripts/companion-web-build.mjs` (or `npm run build`) to see why.';
export const WEB_NOT_FOUND = 'The companion\'s web code has nothing at this address.';

/** Where each island draws, for the words when its code is missing. */
const ISLANDS: Readonly<Record<string, { mount: string; tag: string; className: string }>> = {
  'island/companion-chat.js': { mount: 'streamdown-root', tag: 'p', className: 'sd-absent' },
  'island/logs-chat.js': { mount: 'left', tag: 'h1', className: 'absent' },
};

const isFile = (path: string): boolean => { try { return lstatSync(path).isFile(); } catch { return false; } };

let building: Promise<boolean> | null = null;

/**
 * The build's folder: `given` (a test's) as it is; else the package's dist/companion-web, built first when this module runs
 * from source and it is missing or stale. `{ dir: null }` when there is none, with why.
 */
export async function webDir(given?: string): Promise<{ dir: string | null; why: 'installed' | 'source' | null }> {
  if (given !== undefined) return isFile(join(given, 'versions.json')) ? { dir: given, why: null } : { dir: null, why: FROM_SOURCE ? 'source' : 'installed' };
  if (FROM_SOURCE) {
    if (!building) {
      const script = new URL('../../scripts/companion-web-build.mjs', import.meta.url).href;
      building = import(script).then((m: { ensureCompanionWeb: () => Promise<unknown> }) => m.ensureCompanionWeb()).then(() => true, () => false);
      // a failed build is tried again on the next request
      void building.then((ok) => { if (!ok) building = null; });
    }
    await building;
  }
  const dir = packagedPath(WEB_BUILD, import.meta.url, { kind: 'dir' }) ?? null;
  return dir && isFile(join(dir, 'versions.json')) ? { dir, why: null } : { dir: null, why: FROM_SOURCE ? 'source' : 'installed' };
}

/** A module of this server's own that writes `words` where an island would draw (its code is missing). */
function absentModule(rel: string, words: string): string {
  const where = ISLANDS[rel];
  return [
    '// The companion\'s web code is missing here; this module says so where the chat would be (R4 H95, src/companion/web-assets.ts).',
    `const el = document.getElementById(${JSON.stringify(where.mount)});`,
    'if (el) {',
    `  const note = document.createElement(${JSON.stringify(where.tag)});`,
    `  note.className = ${JSON.stringify(where.className)};`,
    `  note.textContent = ${JSON.stringify(words)};`,
    '  el.replaceChildren(note);',
    "  el.dataset.island = 'absent';",
    '}',
    '',
  ].join('\n');
}

/**
 * Answers a request for /web/<path> from the build (true when `pathname` is under /web/: answered, found or not; false
 * otherwise, for the caller's other routes). `given`: a test's build folder.
 */
export async function sendWebFile(pathname: string, res: ServerResponse, given?: string): Promise<boolean> {
  if (!pathname.startsWith(WEB_PREFIX)) return false;
  const rel = pathname.slice(WEB_PREFIX.length);
  const kind = KINDS.find((k) => k.re.test(rel));
  if (!kind || rel.split('/').some((p) => p === '.' || p === '..')) { failRequest(res, 404, WEB_NOT_FOUND, 'text'); return true; }
  let found: { dir: string | null; why: 'installed' | 'source' | null };
  try { found = await webDir(given); } catch { found = { dir: null, why: FROM_SOURCE ? 'source' : 'installed' }; }
  const file = found.dir ? join(found.dir, ...rel.split('/')) : null;
  if (file && isFile(file)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', kind.type);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = createReadStream(file);
    stream.on('error', () => failRequest(res, 500, WEB_NOT_FOUND, 'text'));
    stream.pipe(res);
    return true;
  }
  if (!found.dir && ISLANDS[rel]) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(absentModule(rel, found.why === 'source' ? WEB_ABSENT_SOURCE : WEB_ABSENT_INSTALLED));
    return true;
  }
  failRequest(res, 404, WEB_NOT_FOUND, 'text');
  return true;
}
