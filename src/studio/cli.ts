/**
 * `timmy studio` (plan F-4): serves Timmy Canvas on 127.0.0.1 until Ctrl+C. It says whether a
 * tldraw license is set, never what it is. Exit: 130 on Ctrl+C, 143 on SIGTERM, 69 when it cannot
 * listen, 2 on bad usage.
 */
import type { AddressInfo } from 'node:net';
import { STUDIO_PORT, studioConfig } from './config.js';
import { startStudioServer } from './server.js';

export function studioHelp(): string {
  return [
    'Usage: timmy studio [--port N]',
    '',
    `Serves Timmy Canvas, the tldraw canvas Timmy's agent draws on, at http://127.0.0.1:${STUDIO_PORT}/.`,
    'Open it with /web studio in the REPL, or in your browser. Ctrl+C stops it.',
    'The tldraw license comes from TLDRAW_LICENSE_KEY when it is set (never printed).',
  ].join('\n');
}

export async function runStudio(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${studioHelp()}\n`);
    return 0;
  }
  const at = argv.indexOf('--port');
  const port = at < 0 ? STUDIO_PORT : Number(argv[at + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('timmy studio: --port needs a number from 0 to 65535.\n');
    return 2;
  }
  let server: Awaited<ReturnType<typeof startStudioServer>>;
  try {
    server = await startStudioServer(port, { env });
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
    'Open it with /web studio in the REPL, or in your browser. Ctrl+C stops it.',
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
