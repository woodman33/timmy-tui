// R4 (H87): `timmy studio` without --port listens where the rest of Timmy looks for it (src/studio/config.ts studioBaseUrl:
// TIMMY_STUDIO_URL on this computer, else TIMMY_STUDIO_PORT, else 4337). Before, it took 4337 and ignored TIMMY_STUDIO_PORT,
// so the REPL and the agent's canvas tools looked for Timmy Canvas on one port while it answered on another.
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { studioListenPort } from '../src/studio/cli.js';
import { STUDIO_PORT, studioBaseUrl } from '../src/studio/config.js';
import { guardRealHome, ownHome } from './fixtures/home-guard.js';

const realHome = guardRealHome();
const own = ownHome('studio-port-home-');
afterAll(() => { own.remove(); expect(realHome.check(), 'changed under the real home\'s timmy folders while these tests ran').toEqual([]); });

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('timmy studio\'s port (R4 H87)', () => {
  it('follows the rule every other part of Timmy uses to reach it', () => {
    expect(studioListenPort({})).toBe(STUDIO_PORT);
    expect(studioListenPort({ TIMMY_STUDIO_PORT: '5123' })).toBe(5123);
    expect(studioListenPort({ TIMMY_STUDIO_PORT: 'not a port' })).toBe(STUDIO_PORT);
    expect(studioListenPort({ TIMMY_STUDIO_URL: 'http://127.0.0.1:5200/', TIMMY_STUDIO_PORT: '5123' })).toBe(5200);
    // a studio on another computer is not this one: here the port rule
    expect(studioListenPort({ TIMMY_STUDIO_URL: 'http://studio.example:5300', TIMMY_STUDIO_PORT: '5124' })).toBe(5124);
    for (const env of [{}, { TIMMY_STUDIO_PORT: '5123' }, { TIMMY_STUDIO_URL: 'http://127.0.0.1:5200' }]) {
      expect(String(studioListenPort(env))).toBe(new URL(studioBaseUrl(env)).port || '80');
    }
  });

  it('`timmy studio` with TIMMY_STUDIO_PORT and no --port listens and answers there, and says so', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'studio'], { env: { ...process.env, ...own.env, TIMMY_STUDIO_PORT: String(port), TIMMY_STUDIO_URL: '', NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    try {
      for (let i = 0; i < 300 && !/Timmy Canvas: http/.test(out) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
      expect(out).toContain(`Timmy Canvas: http://127.0.0.1:${port}/`);
      expect((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
    } finally {
      child.kill('SIGTERM');
      expect(await exited).toBe(143);
    }
  }, 30_000);
});
