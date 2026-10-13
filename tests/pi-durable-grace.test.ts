/**
 * Pi Durable S1 (R4 H118), fix S8 of H119's review: the worker's lease grace (and idle time) is counted from when its
 * socket listens, not from when its process began. REAL: a Pi worker process run directly (no supervisor, so no Timmy
 * ever attaches), its own log lines with their times, its exit code. FAKE: the fixture project; no model is used.
 *
 * Before the fix both clocks started when the worker was constructed, before the pinned packages loaded and the
 * Harness opened, so the first look (250 ms after listening) found the start-up time already spent: a worker whose
 * supervisor had not attached yet could shut itself down at once ("the Pi worker exited 0 before it answered"). The
 * worker's start-up here (loading pi-durable, pi-ai and chord, opening the Harness) takes well over the 150 ms that
 * makes the old clock fire at the first look.
 */
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { workerCommand } from '../src/pi-durable/supervisor.js';
import { anyAlive, cleanup, INSTALLED, project, SKIP_WHY, track, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 120_000 });
afterAll(() => { cleanup(); });

const GRACE = 400;

describe.skipIf(!INSTALLED)(`the worker's clocks (fix S8)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it(`with no Timmy ever attached, the worker waits its whole ${GRACE} ms lease grace after its socket listens, then pauses on exit (S8)`, async () => {
    const root = project('grace-from-listen');
    const { command, args } = workerCommand();
    const child = spawn(command, [...args, '--project', root, '--lease-grace-ms', String(GRACE)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    track(child.pid);
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    const code = await new Promise<number | null>((r) => { child.once('exit', (c) => r(c)); });
    expect(code).toBe(0);
    const ready = /^(\S+) pi-worker pid \d+: ready on its socket/m.exec(out);
    const down = new RegExp(`^(\\S+) pi-worker pid \\d+: shutting down \\(no Timmy process has been attached for ${GRACE} ms\\): pause on exit`, 'm').exec(out);
    expect(ready, out).not.toBeNull();
    expect(down, out).not.toBeNull();
    const gap = Date.parse(down![1]) - Date.parse(ready![1]);
    expect(gap, `ready ${ready![1]}, shutting down ${down![1]}`).toBeGreaterThanOrEqual(GRACE - 50);
  });

  it('leaves no worker running', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
