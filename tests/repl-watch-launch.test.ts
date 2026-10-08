import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { exitStatus, monitorLaunch, runMonitor } from '../src/repl/watch-launch.js';

// `timmy watch` must start the full-screen monitor from a source checkout AND from the installed
// npm package. The package ships the compiled dist/cli.js, not cli.tsx (npm pack, 2026-10-07), so
// running `npx tsx <dist>/cli.tsx` there finds no file.
describe('where timmy watch finds the monitor', () => {
  // C-15: through this checkout's own tsx, with no npx between: npx could pick another tsx (or fetch
  // one), and its npm, shell and tsx processes kept a SIGTERM from reaching the monitor.
  it('runs cli.tsx with node and this checkout\'s tsx loader in a source checkout', () => {
    const exists = (p: string) => p === '/repo/cli.tsx' || p === '/repo/node_modules/tsx/dist/loader.mjs';
    expect(monitorLaunch('file:///repo/src/cli.ts', exists, '/usr/bin/node'))
      .toEqual({ command: '/usr/bin/node', args: ['--import', 'file:///repo/node_modules/tsx/dist/loader.mjs', '/repo/cli.tsx'] });
  });
  it('falls back to npx tsx when the checkout has no tsx installed', () => {
    const exists = (p: string) => p === '/repo/cli.tsx';
    expect(monitorLaunch('file:///repo/src/cli.ts', exists, '/usr/bin/node')).toEqual({ command: 'npx', args: ['tsx', '/repo/cli.tsx'] });
  });
  it('runs the compiled dist/cli.js with node from the installed package', () => {
    const exists = (p: string) => p === '/pkg/dist/cli.js';
    expect(monitorLaunch('file:///pkg/dist/src/cli.js', exists, '/usr/bin/node')).toEqual({ command: '/usr/bin/node', args: ['/pkg/dist/cli.js'] });
  });
  // Fourth order, step 2 (row 52): `timmy watch --no-companion` started the companion anyway; the
  // arguments given to `timmy watch` now reach the monitor, however it is started.
  it('passes the arguments given to timmy watch on to the monitor', () => {
    const tsx = (p: string) => p === '/repo/cli.tsx' || p === '/repo/node_modules/tsx/dist/loader.mjs';
    expect(monitorLaunch('file:///repo/src/cli.ts', tsx, '/usr/bin/node', ['--no-companion']).args.slice(-2)).toEqual(['/repo/cli.tsx', '--no-companion']);
    expect(monitorLaunch('file:///repo/src/cli.ts', (p) => p === '/repo/cli.tsx', '/usr/bin/node', ['--no-companion']))
      .toEqual({ command: 'npx', args: ['tsx', '/repo/cli.tsx', '--no-companion'] });
    expect(monitorLaunch('file:///pkg/dist/src/cli.js', (p) => p === '/pkg/dist/cli.js', '/usr/bin/node', ['--no-companion']).args)
      .toEqual(['/pkg/dist/cli.js', '--no-companion']);
  });
});

describe('how timmy watch reports the monitor ending', () => {
  it('passes the exit code through, and reports a signal as 128 plus its number, never 0', () => {
    expect(exitStatus({ status: 0, signal: null })).toBe(0);
    expect(exitStatus({ status: 3, signal: null })).toBe(3);
    expect(exitStatus({ status: null, signal: 'SIGTERM' })).toBe(143);
    expect(exitStatus({ status: null, signal: 'SIGKILL' })).toBe(137);
    expect(exitStatus({ status: null, signal: null })).toBe(1);
  });
});

// C-15: `timmy watch` waits for the monitor without blocking, so a SIGTERM or SIGHUP sent to it is
// passed on to the monitor, which restores the terminal and exits 143 (before: the wrapper died and
// left the monitor drawing). A monitor that cannot start is still 69, with the cause.
describe('timmy watch runs the monitor', () => {
  const node = process.execPath;
  it('passes SIGTERM on to the monitor and exits as it does', async () => {
    const signals = new EventEmitter();
    const child = runMonitor({ command: node, args: ['-e', "process.on('SIGTERM',()=>process.exit(143));setInterval(()=>{},1000)"] }, () => {}, signals);
    await new Promise((r) => setTimeout(r, 400));
    signals.emit('SIGTERM');
    await expect(child).resolves.toBe(143);
  });
  it('passes the monitor\'s own exit code through', async () => {
    await expect(runMonitor({ command: node, args: ['-e', 'process.exit(3)'] }, () => {}, new EventEmitter())).resolves.toBe(3);
  });
  it('says a monitor that cannot start, and exits 69', async () => {
    const said: string[] = [];
    await expect(runMonitor({ command: '/nonexistent/timmy-monitor', args: [] }, (s) => said.push(s), new EventEmitter())).resolves.toBe(69);
    expect(said.join('')).toContain('could not start the monitor');
  });
});
