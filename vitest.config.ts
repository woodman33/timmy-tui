import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// R13 (the 2026-10-26 integration order; the R12 failure diagnosis): never more workers than CPUs. On the lead's 2-CPU
// runner 4 workers drove the load to 9-13 and starved vitest's own main process (onTaskUpdate timeouts) and the browser
// tests' wall-clock budgets. The ceiling stays 4 on bigger machines; TIMMY_TEST_WORKERS sets it exactly. No assertion,
// timeout or threshold changes with it.
const workers = Number(process.env.TIMMY_TEST_WORKERS) > 0 ? Number(process.env.TIMMY_TEST_WORKERS) : Math.max(1, Math.min(4, availableParallelism()));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Worker core and HTTP-route tests live in workers/ai-proxy/test and run
    // through that package's separate Node suite (not a native workerd pool).
    exclude: ['**/node_modules/**'],
    environment: 'node',
    // dispatch/forge/cone tests spawn tmux+binaries; under parallel load they
    // need headroom beyond the 5s default (load-flake hygiene, onebus-m5f2)
    testTimeout: 60000,
    // heavy ink/logserver tests starve under full fork count; cap workers so
    // parallel files still run but the interval-driven TUI meets its cadence
    maxWorkers: workers,
    minWorkers: 1,
    // per-file temp receipt store (TIMMY_STORE) so parallel files never contend.
    // TIMMY_TEST_HEARTBEAT=<file.jsonl> also loads an event-loop heartbeat that logs every stall over
    // 1 s with its file and test (see tests/heartbeat-setup.ts); off by default.
    setupFiles: ['tests/isolation-setup.ts', ...(process.env.TIMMY_TEST_HEARTBEAT ? ['tests/heartbeat-setup.ts'] : [])],
    globalSetup: ['tests/globalsetup.ts'],
    // the default reporter, plus one that names any file still running after 5 min with the processes under vitest
    // (tests/stuck-file-reporter.ts): a worker stuck in a synchronous call cannot reach its test timeout (R4 H31)
    reporters: ['default', './tests/stuck-file-reporter.ts'],
  },
});
