import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConnections } from '../src/ops/workspace-frame.js';
import { NAMED_PAGES, resolveWebTarget } from '../src/repl/web.js';
import { replTools } from '../src/repl/main.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { STUDIO_PORT } from '../src/studio/config.js';
import { guardRealHome, ownHome } from './fixtures/home-guard.js';

// R4 (H59; found by H55): `timmy studio` runs with its own temporary HOME and TIMMY_HOME, so its project token file
// (<TIMMY_HOME>/canvas/project-token-<port>) is written and removed there, never under the test machine's own home; and
// nothing here may change the real home's timmy folders (tests/fixtures/home-guard.ts reads them before and after).
const realHome = guardRealHome();
const own = ownHome('studio-cli-home-');
const repo = fileURLToPath(new URL('..', import.meta.url));
afterAll(() => { own.remove(); expect(realHome.check(), 'changed under the real home\'s timmy folders while these tests ran').toEqual([]); });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ended = (c: ChildProcess): boolean => c.exitCode !== null || c.signalCode !== null;

/**
 * R5 (H137; H133's finding: a `timmy studio` a test started, still serving after the test timed out under load): what each run
 * started, so every way out of a test stops it: the run's own wait when its line never comes, and afterEach after a failure or
 * vitest's own timeout. Only these children are stopped, by their handles (SIGTERM, then SIGKILL after 5 s): never a process
 * found by its port, which may be another's.
 */
const started: ChildProcess[] = [];
async function stopRun(c: ChildProcess): Promise<void> {
  if (ended(c)) return;
  const closed = new Promise<void>((resolve) => c.once('close', () => resolve()));
  c.kill('SIGTERM');
  if (await Promise.race([closed.then(() => true), sleep(5000).then(() => false)])) return;
  c.kill('SIGKILL');
  await closed;
}
afterEach(async () => { for (const c of started.splice(0)) await stopRun(c); });

/** Whether this machine lets a server listen on 127.0.0.1:`port` now (it is free), the server closed again at once. */
const portFree = (port: number): Promise<boolean> => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
/** Whether something on 127.0.0.1:`port` takes a connection now. */
const answers = (port: number): Promise<boolean> => new Promise((resolve) => {
  const c = connect(port, '127.0.0.1');
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('error', () => resolve(false));
});
/** A port no server listens on now (the system picks it). */
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});

// F-4, slice 3: `timmy studio` serves Timmy Canvas; the REPL's agent has the canvas tools; /web studio opens it.
function studio(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'studio', ...args], { env: { ...process.env, ...own.env, ...env, NO_COLOR: '1' } });
  started.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  /** The first match of `re` in what it printed, within `ms`; else the run is stopped (R5 H137) and the wait fails. */
  const line = async (re: RegExp, ms = 15_000): Promise<RegExpMatchArray> => {
    for (const end = Date.now() + ms; Date.now() < end;) { const m = out.match(re); if (m) return m; await sleep(50); }
    await stopRun(child);
    throw new Error(`no match for ${re} within ${ms} ms (the studio this run started is stopped): ${out}`);
  };
  return { child, exited, line, out: () => out };
}

describe('timmy studio', () => {
  it('serves Timmy Canvas on 127.0.0.1, says where and whether a license is set (never the key), and stops on SIGTERM with 143', async () => {
    const s = studio(['--port', '0'], { TLDRAW_LICENSE_KEY: 'tldraw-secret/AAAA.BBBB' });
    const [, url] = await s.line(/Timmy Canvas: (http:\/\/127\.0\.0\.1:\d+\/)/);
    expect(s.out()).toContain('License: TLDRAW_LICENSE_KEY is set (tldraw checks it in the page)');
    expect(s.out()).not.toContain('tldraw-secret');
    // R4 (H59): its project token is in its own Timmy home while it runs, and removed when it stops.
    const token = join(own.TIMMY_HOME, 'canvas', `project-token-${new URL(url).port}`);
    expect(existsSync(token)).toBe(true);
    // R4 (H83): the page's license key only with a credential (here the REPL's token, as a REPL of this home reads it)
    expect((await (await fetch(`${url}studio-config.json`)).json()).licenseKey).toBeNull();
    const kept = JSON.parse(readFileSync(token, 'utf8')) as { token: string };
    expect((await (await fetch(`${url}studio-config.json`, { headers: { Authorization: `Bearer ${kept.token}` } })).json()).licenseKey).toBe('tldraw-secret/AAAA.BBBB');
    // R4 (H83): it names /canvas open as the way to open the page (a page opened by its address alone loads no canvas)
    expect(s.out()).toContain("Open it from Timmy's REPL with /canvas open (or /web studio): that page gets a one-time grant from Timmy.");
    expect(s.out()).toContain('A page opened by this address alone (typed, a bookmark, a reload) loads no canvas and says so. Ctrl+C stops it.');
    s.child.kill('SIGTERM');
    expect(await s.exited).toBe(143);
    expect(existsSync(token)).toBe(false);
  }, 20_000);
  it('without a key says it runs in development mode, which needs none on this machine', async () => {
    const s = studio(['--port', '0'], { TLDRAW_LICENSE_KEY: '' });
    await s.line(/Timmy Canvas: /);
    expect(s.out()).toContain('License: none set; tldraw runs in development mode, which needs none on this machine.');
    s.child.kill('SIGTERM');
    await s.exited;
  }, 20_000);
  it('explains a port already in use (69) instead of a stack trace, and leaves the server that holds it alone', async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as AddressInfo).port;
    const s = studio(['--port', String(port)]);
    expect(await s.exited).toBe(69);
    expect(s.out()).toContain(`Port ${port} is in use: is Timmy Canvas already running? Use --port to pick another.`);
    // R5 (H137): another process's server was never this run's: it still listens and takes a connection
    expect(busy.listening).toBe(true);
    expect(await answers(port)).toBe(true);
    await new Promise<void>((r) => busy.close(() => r()));
  }, 20_000);
  it('a run whose wait times out stops the Studio it started: the port is free after the timeout, and its token file is gone (R5 H137, H133\'s finding)', async () => {
    const port = await freePort();
    const s = studio(['--port', String(port)]);
    await s.line(new RegExp(`Timmy Canvas: http://127\\.0\\.0\\.1:${port}/`));
    // serving: it takes connections, and its project token is kept for the REPLs of its Timmy home
    expect(await answers(port)).toBe(true);
    const token = join(own.TIMMY_HOME, 'canvas', `project-token-${port}`);
    expect(existsSync(token)).toBe(true);
    // a line it never prints: the wait times out after 1 s, and the run is stopped on the way out (SIGTERM: its own stop)
    await expect(s.line(/a line timmy studio never prints/, 1000)).rejects.toThrow(/within 1000 ms \(the studio this run started is stopped\)/);
    expect(ended(s.child)).toBe(true);
    expect(await s.exited).toBe(143);
    expect(await answers(port)).toBe(false);
    expect(await portFree(port)).toBe(true);
    expect(existsSync(token)).toBe(false);
  }, 30_000);
  it('R5 (H137; the QA round, defect 19\'s analog): as the Studio the frame names (its port), it notes in the frame\'s record that it started listening, and on SIGTERM that it stopped, before it exits; a run that cannot listen there (another holds the port) notes nothing', async () => {
    const port = await freePort();
    const env = { ...own.env, TIMMY_STUDIO_PORT: String(port) };
    const address = `http://127.0.0.1:${port}`;
    const s = studio(['--port', String(port)], env);
    await s.line(new RegExp(`Timmy Canvas: http://127\\.0\\.0\\.1:${port}/`));
    expect(readConnections(env).checks.studio).toMatchObject({ answer: 'listening', detail: 'it started listening', asked: address });
    // a second run on the same port cannot listen (69), and records nothing of the Studio that holds it
    const second = studio(['--port', String(port)], env);
    expect(await second.exited).toBe(69);
    expect(readConnections(env).checks.studio).toMatchObject({ answer: 'listening', detail: 'it started listening', asked: address });
    s.child.kill('SIGTERM');
    expect(await s.exited).toBe(143);
    expect(readConnections(env).checks.studio).toMatchObject({ answer: 'not running', detail: 'it stopped', asked: address });
  }, 40_000);
  it('R5 (H137): a process that ends without closing the Studio it serves (a REPL that quits) notes the stop as it exits', async () => {
    const port = await freePort();
    const env = { ...own.env, TIMMY_STUDIO_PORT: String(port) };
    const server = pathToFileURL(join(repo, 'src', 'studio', 'server.ts')).href;
    const code = `const { startStudioServer } = await import(${JSON.stringify(server)}); await startStudioServer(${port}); process.exit(0);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...process.env, ...env, NO_COLOR: '1' } });
    started.push(child);
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    expect(await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c))), out).toBe(0);
    expect(readConnections(env).checks.studio).toMatchObject({ answer: 'not running', detail: 'it stopped', asked: `http://127.0.0.1:${port}` });
  }, 30_000);
});

describe('the canvas in the REPL', () => {
  it('gives the agent the three canvas tools, each with a known NEEDS YOU rule', () => {
    const names = replTools().map((t) => (t as { function: { name: string } }).function.name);
    expect(names).toEqual(expect.arrayContaining(['canvas_exec', 'canvas_read', 'canvas_api']));
    for (const n of ['canvas_exec', 'canvas_read', 'canvas_api']) expect(approvalNeeded(n, { code: 'x' })?.reason ?? 'read-only').not.toBe('unknown tool');
  });
  it('/web studio opens Timmy Canvas', () => {
    expect(NAMED_PAGES.studio).toBe(`http://127.0.0.1:${STUDIO_PORT}/`);
    expect(resolveWebTarget('studio')).toBe(`http://127.0.0.1:${STUDIO_PORT}/`);
  });
});
