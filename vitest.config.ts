import { defineConfig } from 'vitest/config';

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
    maxWorkers: 4,
    minWorkers: 1,
    // per-file temp receipt store (TIMMY_STORE) so parallel files never contend
    setupFiles: ['tests/isolation-setup.ts'],
    globalSetup: ['tests/globalsetup.ts'],
  },
});
