/**
 * R12 (the operator's order of 2026-10-25, 03:04 PT: "spend the night coding the timmy tui into rive and tldraw"): `timmy app` —
 * Timmy's main UI, the Timmy app (a tldraw board of cards with the Rive faces; src/companion/timmy-app.ts), opened from the
 * terminal. It starts the browser companion on this computer (127.0.0.1, the port `timmy watch` asks for: --port, else
 * TIMMY_COMPANION_PORT, else 3001, then the next three, then any free port) and opens /app with the companion's token in the
 * page's address fragment, through the private launch page (src/utils/launch-page.ts), so the token never goes on a command
 * line. The terminal stays the launcher: o opens the app again (its token is kept in the page's memory only, so a reloaded
 * page asks for it again), q or Ctrl-C stops the companion.
 *
 *   timmy app [--port <n>] [--no-open]
 *
 * Exit: 0 after q / Ctrl-C / SIGTERM; 2 for a bad argument; 69 when the app is not built or the companion does not start.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanionServer } from '../companion/server.js';
import { APP_NOT_BUILT, appRoot } from '../companion/timmy-app.js';
import { askedCompanionPort, companionPortNote } from '../setup/companion-port.js';
import { openBrowser } from '../utils/logserver.js';
import { companionPorts } from '../workbench/servers.js';

export const APP_USAGE = [
  'timmy app — Timmy’s main UI: a board of cards (tldraw) with live faces (Rive), in your browser.',
  '',
  '  timmy app [--port <n>] [--no-open]',
  '',
  'It starts the companion on this computer (127.0.0.1) and opens the app with its token.',
  'In this terminal: o opens the app again, q stops it.',
].join('\n');

/** The app's address from the companion's: the same origin and token, the page /app. */
export function appUrlOf(companionUrl: string): string {
  const u = new URL(companionUrl);
  u.pathname = '/app';
  return u.toString();
}

export interface AppLaunchDeps {
  start?: (port: number) => Promise<CompanionServer>;
  open?: (url: string) => Promise<unknown>;
  out?: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** keys from the terminal (process.stdin when it is a TTY) */
  keys?: NodeJS.ReadStream | null;
  /** resolves when the launcher should stop (a test's); SIGINT/SIGTERM/q otherwise */
  until?: Promise<void>;
}

export async function runApp(argv: readonly string[], deps: AppLaunchDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  if (argv.includes('--help') || argv.includes('-h')) { out(APP_USAGE); return 0; }
  const known = new Set(['--port', '--no-open']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { i += 1; continue; }
    if (!known.has(a)) { out(`timmy app: unknown argument ${a}\n\n${APP_USAGE}`); return 2; }
  }
  if (!existsSync(join(appRoot(), 'dist', 'app.js'))) { out(`timmy app: ${APP_NOT_BUILT}`); return 69; }
  const env = deps.env ?? process.env;
  let asked: number;
  const at = argv.indexOf('--port');
  if (at >= 0 && !/^\d{1,5}$/.test(argv[at + 1] ?? '')) { out(`timmy app: --port needs a port (1 to 65535).\n\n${APP_USAGE}`); return 2; }
  try { asked = askedCompanionPort(at >= 0 ? ['--companion-port', argv[at + 1]] : [], env); } catch (e) { out(`timmy app: ${e instanceof Error ? e.message : String(e)}`); return 2; }
  const start = deps.start ?? (async (port: number) => (await import('../companion/server.js')).startCompanionServer(port));
  let server: CompanionServer | null = null;
  let last: unknown = null;
  for (const port of companionPorts(asked)) {
    try { server = await start(port); break; } catch (e) {
      last = e;
      if ((e as NodeJS.ErrnoException | null)?.code !== 'EADDRINUSE') break;
    }
  }
  if (!server) { out(`timmy app: the companion did not start (${last instanceof Error ? last.message : String(last)}).`); return 69; }
  const appUrl = appUrlOf(server.url);
  const bare = `${server.address.replace(/\/+$/, '')}/app`;
  const note = companionPortNote(asked, server.port);
  const open = deps.open ?? openBrowser;
  out(`Timmy app: ${bare}${note ? `  (${note})` : ''}`);
  if (!argv.includes('--no-open')) {
    const r = await open(appUrl);
    out(r === 'failed' ? 'Your browser did not open here: press o to try again, or open the companion from `timmy watch`.' : 'Opened in your browser.');
  }
  out('o  open the app again    q  stop');
  const keys = deps.keys === undefined ? (process.stdin.isTTY ? process.stdin : null) : deps.keys;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => { if (done) return; done = true; if (keys && keys.isTTY) { try { keys.setRawMode(false); } catch { /* the terminal is gone */ } } keys?.pause(); resolve(); };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    if (deps.until) deps.until.then(finish, finish);
    if (keys) {
      if (keys.isTTY) { try { keys.setRawMode(true); } catch { /* not a terminal after all */ } }
      keys.setEncoding('utf8');
      keys.on('data', (k: string) => {
        if (k === 'q' || k === '\u0003' || k === '\u0004') finish();
        else if (k === 'o') { void open(appUrl).then((r) => out(r === 'failed' ? 'The browser did not open.' : 'Opened again.')); }
      });
      keys.resume();
    }
  });
  await server.shutdown();
  out('Timmy app stopped.');
  return 0;
}
