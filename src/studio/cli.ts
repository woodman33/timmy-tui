/**
 * `timmy studio` (plan F-4): serves Timmy Canvas on 127.0.0.1 until Ctrl+C. It says whether a
 * tldraw license is set, never what it is. Exit: 130 on Ctrl+C, 143 on SIGTERM, 69 when it cannot
 * listen, 2 on bad usage. R4 (H83): it opens no page itself; a page loads the canvas only when Timmy's REPL opens it with a
 * one-time grant (/canvas open, or /web studio), so that is the way it names.
 */
import type { AddressInfo } from 'node:net';
import { studioBaseUrl, studioConfig, studioPort } from './config.js';
import { startStudioServer } from './server.js';

type Env = Record<string, string | undefined>;

/**
 * R4 (H87): the port `timmy studio` listens on without --port: where the rest of Timmy looks for Timmy Canvas
 * (src/studio/config.ts studioBaseUrl): TIMMY_STUDIO_URL's port when it names this computer, else TIMMY_STUDIO_PORT, else
 * 4337. Before, it always took 4337, while the REPL and the agent's canvas tools followed TIMMY_STUDIO_PORT.
 */
export function studioListenPort(env: Env = process.env): number {
  try {
    const url = new URL(studioBaseUrl(env));
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  } catch { /* not an address: the port rule */ }
  return studioPort(env);
}

export function studioHelp(env: Env = process.env): string {
  return [
    'Usage: timmy studio [--port N]',
    '',
    `Serves Timmy Canvas, the tldraw canvas Timmy's agent draws on, at http://127.0.0.1:${studioListenPort(env)}/ (TIMMY_STUDIO_PORT, or the port of TIMMY_STUDIO_URL on this computer; 4337 by default).`,
    'Open it from Timmy\'s REPL with /canvas open (or /web studio): that page gets a one-time grant from Timmy.',
    'A page opened by its address alone (typed, a bookmark, a reload) loads no canvas and says so. Ctrl+C stops it.',
    'The tldraw license comes from TLDRAW_LICENSE_KEY when it is set (never printed).',
  ].join('\n');
}

export async function runStudio(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${studioHelp(env)}\n`);
    return 0;
  }
  const at = argv.indexOf('--port');
  const port = at < 0 ? studioListenPort(env) : Number(argv[at + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('timmy studio: --port needs a number from 0 to 65535.\n');
    return 2;
  }
  let server: Awaited<ReturnType<typeof startStudioServer>>;
  try {
    // R4 (H55): its project token is kept for the REPLs of this Timmy home, so /canvas open can name their project here.
    server = await startStudioServer(port, { env, projectTokenFile: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    process.stderr.write(code === 'EADDRINUSE'
      ? `Port ${port} is in use: is Timmy Canvas already running? Use --port to pick another.\n`
      : `timmy studio: could not start (${(error as Error).message}).\n`);
    return 69;
  }
  const actual = (server.address() as AddressInfo).port;
  const licensed = studioConfig(env).licenseKey !== null;
  process.stdout.write([
    `Timmy Canvas: http://127.0.0.1:${actual}/`,
    licensed
      ? 'License: TLDRAW_LICENSE_KEY is set (tldraw checks it in the page)'
      : 'License: none set; tldraw runs in development mode, which needs none on this machine.',
    'Open it from Timmy\'s REPL with /canvas open (or /web studio): that page gets a one-time grant from Timmy.',
    'A page opened by this address alone (typed, a bookmark, a reload) loads no canvas and says so. Ctrl+C stops it.',
    '',
  ].join('\n'));
  return new Promise<number>((resolve) => {
    const stop = (code: number) => (): void => {
      // A browser holding a keep-alive connection must not keep Timmy running.
      setTimeout(() => resolve(code), 3000).unref();
      server.close(() => resolve(code));
    };
    process.once('SIGINT', stop(130));
    process.once('SIGTERM', stop(143));
  });
}
