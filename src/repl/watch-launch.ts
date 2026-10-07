/**
 * Where `timmy watch` finds the full-screen monitor. A source checkout has cli.tsx (run through
 * tsx); the installed npm package ships only the compiled dist/cli.js (run with node).
 */
import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function monitorLaunch(
  cliModuleUrl: string,
  exists: (path: string) => boolean = existsSync,
  node: string = process.execPath,
): { command: string; args: string[] } {
  const tsx = fileURLToPath(new URL('../cli.tsx', cliModuleUrl));
  if (exists(tsx)) {
    // This checkout's own tsx, with no npx between (C-15): npx could pick another tsx (or fetch one),
    // and its npm, shell and tsx processes kept a SIGTERM from reaching the monitor.
    const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', cliModuleUrl));
    if (exists(loader)) return { command: node, args: ['--import', pathToFileURL(loader).href, tsx] };
    return { command: 'npx', args: ['tsx', tsx] };
  }
  return { command: node, args: [fileURLToPath(new URL('../cli.js', cliModuleUrl))] };
}

/** The monitor's exit as a status: its own code, or 128 plus the signal number; never 0 for a kill. */
export function exitStatus(r: { status: number | null; signal: NodeJS.Signals | string | null }): number {
  if (r.status !== null) return r.status;
  const n = r.signal ? (constants.signals as Record<string, number>)[r.signal] : undefined;
  return n ? 128 + n : 1;
}

/**
 * Runs the monitor with the terminal handed over and resolves with its exit status. A SIGTERM or SIGHUP
 * sent to `timmy watch` is passed on to the monitor, which restores the terminal and exits 128 plus the
 * signal; Ctrl+C belongs to the monitor (it reads it as a key in raw mode, and a SIGINT from the
 * terminal reaches it directly). A monitor that cannot start is 69 (EX_UNAVAILABLE), with the cause.
 */
export function runMonitor(
  launch: { command: string; args: string[] },
  write: (s: string) => void = (s) => process.stderr.write(s),
  signals: Pick<EventEmitter, 'on' | 'off'> = process,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { stdio: 'inherit' });
    const pass = { SIGTERM: () => child.kill('SIGTERM'), SIGHUP: () => child.kill('SIGHUP'), SIGINT: () => {} };
    for (const [sig, fn] of Object.entries(pass)) signals.on(sig, fn);
    const done = (code: number): void => {
      for (const [sig, fn] of Object.entries(pass)) signals.off(sig, fn);
      resolve(code);
    };
    child.on('error', (err) => {
      const hint = launch.command === 'npx' ? ' It runs through npx: is npx on your PATH?' : '';
      write(`timmy watch: could not start the monitor (${err.message}).${hint}\n`);
      done(69);
    });
    child.on('exit', (status, signal) => done(exitStatus({ status, signal })));
  });
}
