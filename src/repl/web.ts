/**
 * Web views (plan C-13): a page opens in carbonyl, a Chromium that draws inside the terminal, as a
 * floating zellij pane or a tmux popup, so the REPL stays where it is. Pages must be on this
 * machine (127.0.0.1, localhost, ::1, *.localhost, file:) unless the operator allows one. With no
 * carbonyl or no multiplexer to draw it in, Timmy gives the link instead.
 *
 * Round R4 (review M4): an address that carries a secret (the live board's token, or a parameter named like a
 * credential) is never an argument of tmux, zellij, sh or carbonyl, which anyone on the machine can read with ps.
 * The pane opens a private launch page instead (src/utils/launch-page.ts) that sends carbonyl on to the address;
 * the link given to the operator to open by hand still holds the whole address.
 */
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUDIO_PORT, studioBaseUrl } from '../studio/config.js';
import { carriesSecret, writeLaunchPage, type LaunchPage } from '../utils/launch-page.js';

export type WebRoute = 'zellij' | 'tmux' | 'link' | 'refused';

export interface WebPlan {
  route: WebRoute;
  command?: string;
  args: string[];
  url: string;
  /** One line for the operator. */
  note: string;
  /** The private launch page the pane opens instead of an address that carries a secret (review M4). */
  page?: LaunchPage;
  /** A link given only because the launch page could not be written: why. */
  why?: string;
}

export interface WebInputs {
  url: string;
  has: (bin: string) => boolean;
  /** Where a program really is (links followed), or null: carbonyl runs from there (fourth order, step 3). */
  locate?: (bin: string) => string | null;
  env: Record<string, string | undefined>;
  allowRemote: boolean;
  /** The address carries a secret (the live board's token): no command line may hold it. */
  secret?: boolean;
  /** Writes the launch page such an address opens through: launch-page.ts's writeLaunchPage unless a test gives one. */
  launch?: (url: string) => LaunchPage;
}

/**
 * Pages Timmy serves itself, by name. The Mission Map is the tldraw board on the vision server;
 * studio is Timmy Canvas (`timmy studio`), the canvas the agent draws on.
 */
export const NAMED_PAGES: Record<string, string> = { map: 'http://127.0.0.1:4336/', studio: `http://127.0.0.1:${STUDIO_PORT}/` };

/** A receipt's page on Timmy's own server (C-13), by the short hash its line shows, at Timmy Canvas's address. */
export const receiptUrl = (id: string, env: Record<string, string | undefined> = process.env): string => `${studioBaseUrl(env)}/receipts/${id}`;
/** Eight hex digits, the short hash a receipt line shows. */
export const RECEIPT_ID = /^[0-9a-f]{8}$/i;

export function resolveWebTarget(target: string, env: Record<string, string | undefined> = process.env): string {
  const t = target.trim();
  // Timmy Canvas is wherever the one address says (round R1); the named default stays 4337.
  if (t === 'studio') return `${studioBaseUrl(env)}/`;
  if (NAMED_PAGES[t]) return NAMED_PAGES[t];
  if (RECEIPT_ID.test(t)) return receiptUrl(t.toLowerCase(), env);
  // A path on this machine becomes a file URL.
  if (t.startsWith('/')) return pathToFileURL(t).href;
  if (t.startsWith('./') || t.startsWith('../')) return pathToFileURL(resolve(t)).href;
  if (t.startsWith('~/')) return pathToFileURL(join(homedir(), t.slice(2))).href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && (t.includes('://') || t.startsWith('file:'))) return t;
  return `http://${t}`;
}

const LOOPBACK = new Set(['localhost', '[::1]', '::1']);
const WEB_SCHEMES = new Set(['http:', 'https:', 'file:']);

export function hostOf(url: string): { local: boolean; host: string; scheme: boolean } {
  try {
    const u = new URL(url);
    if (!WEB_SCHEMES.has(u.protocol)) return { local: false, host: u.hostname, scheme: false };
    // A file URL with a host names another machine's share (file://server/share): not local.
    if (u.protocol === 'file:') return u.hostname === '' || u.hostname === 'localhost' ? { local: true, host: 'this machine', scheme: true } : { local: false, host: u.hostname, scheme: true };
    const h = u.hostname;
    return { local: LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h) || h.endsWith('.localhost'), host: h, scheme: true };
  } catch {
    return { local: false, host: url, scheme: true };
  }
}

/** tmux reads an argument ending in `;` as the end of a command; `\\;` keeps it literal. */
const tmuxArg = (a: string): string => (a.endsWith(';') ? `${a.slice(0, -1)}\\;` : a);

/**
 * Fourth order, step 3, found on the Mac: run through a link to it (~/.local/bin/carbonyl), carbonyl cannot
 * find icudtl.dat beside itself and exits at once, so the pane vanished while the REPL said it had opened.
 * The pane runs carbonyl ("$0", from where it really is) on the page ("$1": an argument, never shell text);
 * when it stops with an error, the pane says so and waits for Enter.
 */
export const WEB_VIEW_SCRIPT = '"$0" "$1" || { s=$?; echo; echo "  The web view stopped (exit $s). Press Enter to close."; read -r _; }';
const webView = (i: WebInputs, url: string): string[] => ['sh', '-c', WEB_VIEW_SCRIPT, i.locate?.('carbonyl') ?? 'carbonyl', url];

export function planWeb(i: WebInputs): WebPlan {
  const { local, host, scheme } = hostOf(i.url);
  if (!scheme) return { route: 'refused', args: [], url: i.url, note: 'Refused: only http, https and file pages open here.' };
  if (!local && !i.allowRemote) {
    return { route: 'refused', args: [], url: i.url, note: `Refused: ${host} is not on this machine. Use /web --allow-remote <url> to open it anyway.` };
  }
  const route = !i.has('carbonyl') ? 'link' : i.env.ZELLIJ !== undefined ? 'zellij' : i.env.TMUX ? 'tmux' : 'link';
  const link = (why?: string): WebPlan => ({ route: 'link', args: [], url: i.url, note: `Open ${i.url} in your browser.`, ...(why ? { why } : {}) });
  if (route === 'link') return link();
  // Review M4: carbonyl gets the private launch page's address, never one that carries a secret.
  let page: LaunchPage | undefined;
  if (i.secret || carriesSecret(i.url)) {
    try {
      page = (i.launch ?? writeLaunchPage)(i.url);
    } catch (err) {
      return link(`the private page that keeps its secret off command lines could not be written (${err instanceof Error ? err.message : 'error'})`);
    }
  }
  const target = page?.href ?? i.url;
  if (route === 'zellij') {
    return {
      route: 'zellij',
      command: 'zellij',
      // As big as the tmux popup, centred.
      args: ['run', '--floating', '--close-on-exit', '--name', 'Web', '--width', '90%', '--height', '85%', '--x', '5%', '--y', '8%', '--', ...webView(i, target)],
      url: i.url,
      note: 'Opened in a floating zellij pane. Ctrl+C there closes it.',
      ...(page ? { page } : {}),
    };
  }
  return {
    route: 'tmux',
    command: 'tmux',
    // Separate arguments: tmux runs the pane's sh with no shell of its own in between, and the page's
    // address reaches carbonyl as an argument, whatever it holds.
    args: ['display-popup', '-E', '-w', '90%', '-h', '85%', '-T', ' Web ', ...webView(i, tmuxArg(target))],
    url: i.url,
    note: 'Opened in a tmux popup. Ctrl+C there closes it.',
    ...(page ? { page } : {}),
  };
}

/**
 * Opens a page as planWeb plans it (the REPL's /web, /board live and the other pages it opens) and says how, in
 * one line. The tmux popup runs beside the REPL, not waited for (display-popup waits until the page closes); the
 * zellij pane is made at once (zellij run returns when it is). `show` writes the link the operator is given.
 * A launch page goes when the popup ends or the pane cannot be made (else as launch-page.ts says).
 */
export function openWebView(i: WebInputs, o: { show?: (url: string) => string } = {}): string {
  const plan = planWeb(i);
  if (plan.route === 'link') return `Open ${(o.show ?? ((u: string) => u))(plan.url)} in your browser.${plan.why ? ` Not opened in a pane: ${plan.why}.` : ''}`;
  if (plan.route === 'refused' || !plan.command) return plan.note;
  if (plan.route === 'tmux') {
    const child = spawn(plan.command, plan.args, { stdio: 'ignore', detached: true, env: i.env });
    child.on('error', () => plan.page?.remove());
    child.on('exit', () => plan.page?.remove());
    child.unref();
    return plan.note;
  }
  const r = spawnSync(plan.command, plan.args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', env: i.env });
  const why = r.error?.message ?? (r.status !== 0 ? (r.stderr?.split('\n').find((l) => l.trim()) ?? `exit ${r.status}`) : '');
  if (why) plan.page?.remove();
  return why ? `Could not open the web view (${why}). Open ${plan.url} in your browser.` : plan.note;
}
