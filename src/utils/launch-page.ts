/**
 * Private launch pages (round R4, review M4). An address that carries a secret, such as the live board's token in
 * its fragment, never goes on a command line: tmux, zellij, sh and carbonyl's arguments are readable by anyone on
 * the machine (ps), a shell keeps what is typed into it in its history, and a multiplexer may save a pane's command
 * to restore it. Timmy instead writes a small page into a new folder only this user can open (folder 0700, page
 * 0600, under the system's temporary folder) whose one script sends the browser on to the address, and gives the
 * page's file:// address to the program: the REPL's web views (src/repl/web.ts) and the cockpit's browser lane
 * (Agent.addBrowserPane). The page is removed once the live board has answered a request carrying its token (the
 * page has done its work), when the board stops, when the tmux popup it opened in closes or the pane could not be
 * made, a minute after it was written at the latest, and when this process exits. Timmy does not log it.
 *
 * Only http and https addresses are opened this way. The browser goes there with location.replace, so the page
 * leaves no entry in its history; a file:// page sends no Referer.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LaunchPage {
  /** The page's own address (file://…/open.html): this, never the secret address, is what a program is given. */
  readonly href: string;
  /** The page's folder (0700) and the page (0600). */
  readonly dir: string;
  readonly path: string;
  /** The address the page sends the browser to. */
  readonly target: string;
  /** Removes the page and its folder; again, nothing. */
  remove(): void;
  readonly removed: boolean;
}

/** The longest a launch page is kept when nothing removes it sooner. */
export const LAUNCH_PAGE_TTL_MS = 60_000;
export const LAUNCH_PAGE_NAME = 'open.html';

/** The pages this process has written and not yet removed. */
const live = new Set<LaunchPage>();
let exitHook = false;

/** A string as a JavaScript literal that cannot end the script element it sits in. */
const jsString = (s: string): string => JSON.stringify(s)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * The page: its script sends the browser to `target` and its policy lets that one script run and nothing else load.
 * It shows no address, so nothing on screen carries the secret either.
 */
export function launchPageHtml(target: string): string {
  const script = `location.replace(${jsString(target)});`;
  const hash = createHash('sha256').update(script).digest('base64');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'">`,
    '<title>Opening · Timmy</title>',
    '</head>',
    '<body>',
    '<p>Opening the page Timmy started. If nothing opens, the command that started it prints its address.</p>',
    `<script>${script}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Writes a launch page for `target` (an http or https address) and returns it. `parent` is where its folder is made
 * (the system's temporary folder by default); `ttlMs` how long it is kept when nothing removes it sooner.
 */
export function writeLaunchPage(target: string, opts: { parent?: string; ttlMs?: number } = {}): LaunchPage {
  let scheme = '';
  try { scheme = new URL(target).protocol; } catch { /* not an address */ }
  if (scheme !== 'http:' && scheme !== 'https:') throw new TypeError('a launch page opens only an http or https address');
  const dir = mkdtempSync(join(opts.parent ?? tmpdir(), 'timmy-open-'));
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    live.delete(page);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  };
  const path = join(dir, LAUNCH_PAGE_NAME);
  const page: LaunchPage = { href: pathToFileURL(path).href, dir, path, target, remove, get removed() { return removed; } };
  try {
    chmodSync(dir, 0o700);
    writeFileSync(path, launchPageHtml(target), { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
  } catch (err) {
    remove();
    throw err;
  }
  live.add(page);
  setTimeout(remove, opts.ttlMs ?? LAUNCH_PAGE_TTL_MS).unref();
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => { for (const p of [...live]) p.remove(); });
  }
  return page;
}

/** Removes every launch page this process wrote for `target` (the live board does, once it has let the page in). */
export function dropLaunchPages(target: string): number {
  let n = 0;
  for (const p of [...live]) if (p.target === target) { p.remove(); n++; }
  return n;
}

/** Parameter names that hold a credential in an address's query or fragment (the live board's own is t). */
const SECRET_EXACT = new Set(['t', 'code', 'sid', 'jwt', 'pwd', 'pass', 'auth', 'key', 'sig']);
const SECRET_PART = /token|secret|passw|api[-_]?key|access[-_]?key|private[-_]?key|authori[sz]ation|signature|session|credential/;

/**
 * Whether an http or https address may carry a secret: a user name or password, or a query or fragment parameter
 * named like a credential (t, token, key, secret, password, auth, code, sig, session, ...). Such an address is
 * opened through a launch page and shown in logs without its query and fragment.
 */
export function carriesSecret(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return true;
  const named = (q: string): boolean => [...new URLSearchParams(q).keys()].some((k) => {
    const name = k.toLowerCase();
    return SECRET_EXACT.has(name) || SECRET_PART.test(name);
  });
  return named(u.search) || named(u.hash.slice(1));
}

/** An address as a log or a pane's name may show it: when it may carry a secret, without user, password, query or fragment. */
export function shownAddress(url: string): string {
  if (!carriesSecret(url)) return url;
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}${u.hash ? '#…' : ''}`;
}
