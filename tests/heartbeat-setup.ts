// Opt-in event-loop heartbeat for test workers (R4 H31). Off unless TIMMY_TEST_HEARTBEAT names a file;
// vitest.config.ts only loads this setup file then.
//
//   TIMMY_TEST_HEARTBEAT=/tmp/heartbeat.jsonl npx vitest run tests/some.test.ts
//
// Each worker ticks a real 250 ms interval. When a tick arrives more than 1 s late, the worker's event
// loop was blocked (a synchronous child process, a busy wait, heavy synchronous work). One JSON line is
// appended per stall: the file, every test that was running during it, and the stall in ms. Vitest
// does not yield to the event loop between tests, so back-to-back synchronous tests add up to one stall.
// A stall of 60 s or more is what makes the worker report "[vitest-worker]: Timeout calling
// "onTaskUpdate"": the reply to its last RPC sits unread behind the blocked loop until its 60 s timer
// fires first. A synchronous call that never returns also stops vitest's own testTimeout from firing.
import { appendFileSync } from 'node:fs';
import { beforeEach, expect } from 'vitest';

const out = process.env.TIMMY_TEST_HEARTBEAT;
if (out) {
  // Captured before any test can install fake timers or a fake clock.
  const realSetInterval = globalThis.setInterval;
  const hrtime = process.hrtime.bigint;
  const now = () => Number(hrtime()) / 1e6;
  const TICK_MS = 250;
  const STALL_MS = 1000;
  const name = (): string | undefined => { try { return expect.getState().currentTestName; } catch { return undefined; } };
  let last = now();
  let running = name();                 // the test running at the last tick
  let started: string[] = [];           // tests started since the last tick
  beforeEach(() => { const n = name(); if (n) started.push(n); });
  const timer = realSetInterval(() => {
    const at = now();
    const stall = at - last - TICK_MS;
    last = at;
    const during = [...new Set([running, ...started].filter((n): n is string => Boolean(n)))];
    started = [];
    running = name();
    if (stall < STALL_MS) return;
    let file: string | undefined;
    try { file = expect.getState().testPath; } catch { /* outside a test run */ }
    const line = {
      file: file ? file.replace(`${process.cwd()}/`, '') : undefined,
      tests: during.length ? during : ['(no test running: collect or a hook)'],
      stallMs: Math.round(stall),
      pid: process.pid,
      endedAt: new Date().toISOString(),
    };
    try { appendFileSync(out, `${JSON.stringify(line)}\n`); } catch { /* best effort */ }
  }, TICK_MS);
  timer.unref();
}
