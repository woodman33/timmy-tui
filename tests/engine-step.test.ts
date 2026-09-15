// Engine steps run as child processes. Codex's 2026-09-14 research found the engine loop calling
// spawnSync inside an async function, so a slow step (a render, a bake) froze Timmy's event loop for
// its whole duration. The step runner must leave the loop free: timers tick, other work proceeds.
import { describe, it, expect } from 'vitest';
import { runStepCommand } from '../lanes/engines/step.mjs';

const node = process.execPath;

describe('engine step runner', { timeout: 30_000 }, () => {
  it('a slow subprocess does not stall the event loop', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const t0 = Date.now();
    const r = await runStepCommand(node, ['-e', 'setTimeout(() => {}, 700)'], { cwd: process.cwd(), timeoutMs: 10_000 });
    clearInterval(timer);
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    // ~35 ticks are due during a 700 ms child; a blocked loop delivers none
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  it('reports stdout, stderr and the exit code like the engine record expects', async () => {
    const r = await runStepCommand(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { cwd: process.cwd() });
    expect(r).toMatchObject({ status: 3, signal: null, stdout: 'out', stderr: 'err', timed_out: false, error: null });
  });

  it('kills a step that exceeds its timeout and marks it timed_out', async () => {
    const r = await runStepCommand(node, ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: process.cwd(), timeoutMs: 300 });
    expect(r.timed_out).toBe(true);
    expect(r.status).toBeNull();
    expect(r.signal).toBe('SIGTERM');
  });

  it('reports a missing binary as an error instead of throwing', async () => {
    const r = await runStepCommand('/nonexistent/timmy-engine-bin', [], { cwd: process.cwd() });
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/ENOENT/);
  });
});
