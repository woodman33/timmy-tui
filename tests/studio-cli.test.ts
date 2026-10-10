import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
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
afterAll(() => { own.remove(); expect(realHome.check(), 'changed under the real home\'s timmy folders while these tests ran').toEqual([]); });

// F-4, slice 3: `timmy studio` serves Timmy Canvas; the REPL's agent has the canvas tools; /web studio opens it.
function studio(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'studio', ...args], { env: { ...process.env, ...own.env, ...env, NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const line = async (re: RegExp): Promise<RegExpMatchArray> => {
    for (let i = 0; i < 300; i++) { const m = out.match(re); if (m) return m; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`no match for ${re}: ${out}`);
  };
  return { child, exited, line, out: () => out };
}

describe('timmy studio', () => {
  it('serves Timmy Canvas on 127.0.0.1, says where and whether a license is set (never the key), and stops on SIGTERM with 143', async () => {
    const s = studio(['--port', '0'], { TLDRAW_LICENSE_KEY: 'tldraw-secret/AAAA.BBBB' });
    const [, url] = await s.line(/Timmy Canvas: (http:\/\/127\.0\.0\.1:\d+\/)/);
    expect(s.out()).toContain('License: TLDRAW_LICENSE_KEY is set (tldraw checks it in the page)');
    expect(s.out()).not.toContain('tldraw-secret');
    expect((await (await fetch(`${url}studio-config.json`)).json()).licenseKey).toBe('tldraw-secret/AAAA.BBBB');
    // R4 (H59): its project token is in its own Timmy home while it runs, and removed when it stops.
    const token = join(own.TIMMY_HOME, 'canvas', `project-token-${new URL(url).port}`);
    expect(existsSync(token)).toBe(true);
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
  it('explains a port already in use (69) instead of a stack trace', async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as AddressInfo).port;
    const s = studio(['--port', String(port)]);
    expect(await s.exited).toBe(69);
    expect(s.out()).toContain(`Port ${port} is in use: is Timmy Canvas already running? Use --port to pick another.`);
    busy.close();
  }, 20_000);
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
