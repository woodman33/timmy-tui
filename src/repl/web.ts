/**
 * Web views (plan C-13): a page opens in carbonyl, a Chromium that draws inside the terminal, as a
 * floating zellij pane or a tmux popup, so the REPL stays where it is. Pages must be on this
 * machine (127.0.0.1, localhost, ::1, *.localhost, file:) unless the operator allows one. With no
 * carbonyl or no multiplexer to draw it in, Timmy gives the link instead.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUDIO_PORT } from '../studio/config.js';

export type WebRoute = 'zellij' | 'tmux' | 'link' | 'refused';

export interface WebPlan {
  route: WebRoute;
  command?: string;
  args: string[];
  url: string;
  /** One line for the operator. */
  note: string;
}

export interface WebInputs {
  url: string;
  has: (bin: string) => boolean;
  env: Record<string, string | undefined>;
  allowRemote: boolean;
}

/**
 * Pages Timmy serves itself, by name. The Mission Map is the tldraw board on the vision server;
 * studio is Timmy Canvas (`timmy studio`), the canvas the agent draws on.
 */
export const NAMED_PAGES: Record<string, string> = { map: 'http://127.0.0.1:4336/', studio: `http://127.0.0.1:${STUDIO_PORT}/` };

/** A receipt's page on Timmy's own server (C-13), by the short hash its line shows. */
export const receiptUrl = (id: string): string => `http://127.0.0.1:${STUDIO_PORT}/receipts/${id}`;
/** Eight hex digits, the short hash a receipt line shows. */
export const RECEIPT_ID = /^[0-9a-f]{8}$/i;

export function resolveWebTarget(target: string): string {
  const t = target.trim();
  if (NAMED_PAGES[t]) return NAMED_PAGES[t];
  if (RECEIPT_ID.test(t)) return receiptUrl(t.toLowerCase());
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

export function planWeb(i: WebInputs): WebPlan {
  const { local, host, scheme } = hostOf(i.url);
  if (!scheme) return { route: 'refused', args: [], url: i.url, note: 'Refused: only http, https and file pages open here.' };
  if (!local && !i.allowRemote) {
    return { route: 'refused', args: [], url: i.url, note: `Refused: ${host} is not on this machine. Use /web --allow-remote <url> to open it anyway.` };
  }
  if (i.has('carbonyl') && i.env.ZELLIJ !== undefined) {
    return {
      route: 'zellij',
      command: 'zellij',
      // As big as the tmux popup, centred.
      args: ['run', '--floating', '--close-on-exit', '--name', 'Web', '--width', '90%', '--height', '85%', '--x', '5%', '--y', '8%', '--', 'carbonyl', i.url],
      url: i.url,
      note: 'Opened in a floating zellij pane. Ctrl+C there closes it.',
    };
  }
  if (i.has('carbonyl') && i.env.TMUX) {
    return {
      route: 'tmux',
      command: 'tmux',
      // Separate arguments: tmux runs carbonyl with no shell in between, whatever the page's address holds.
      args: ['display-popup', '-E', '-w', '90%', '-h', '85%', '-T', ' Web ', 'carbonyl', tmuxArg(i.url)],
      url: i.url,
      note: 'Opened in a tmux popup. Ctrl+C there closes it.',
    };
  }
  return { route: 'link', args: [], url: i.url, note: `Open ${i.url} in your browser.` };
}
