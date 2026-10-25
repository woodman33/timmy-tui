/**
 * R10 (H163; the turn-holds latency): React's production build in every timmy process.
 *
 * React, its JSX runtime, the scheduler and react-reconciler (Ink's) each choose their build by NODE_ENV when first loaded.
 * Timmy is tsc output, not a bundle, so with NODE_ENV unset (an installed timmy) or "test" (a test's terminal) they loaded their
 * development builds: a Workbench frame cost 88 to 105 ms of CPU, React's part 51 to 62 ms of it (its development-only checks),
 * against 52 to 55 ms and 14 to 16 ms with the production builds (measured in tests/workbench-turn-holds-pty.test.ts's
 * Workbench, 7 runs at load 6 to 8, 14 to 24 frames each). A frame that costs half as much is drawn sooner, and so is whatever
 * waits behind it on the event loop (another surface's chat turn, a key).
 *
 * loadReactProduction loads them first, with NODE_ENV=production for that moment only: Node's module cache then hands these
 * same modules to Ink and to every app that imports them later. NODE_ENV is put back as it was (unset stays unset), so whatever
 * else reads it (the receipts' NODE_ENV=test isolation, src/utils/receipts.ts; the pulse, src/tui/hooks/usePulse.ts) is
 * unchanged. TIMMY_REACT_DEV=1 keeps the development builds (React's own warnings and whole error messages, for debugging a
 * view). src/react-production.ts calls it as src/cli.ts's first import, before anything can load React.
 */
import { createRequire } from 'node:module';

/** What is loaded, in this order: React, its JSX runtime (tsc's output imports it), the scheduler and react-reconciler. */
export const REACT_MODULES: readonly string[] = ['react', 'react/jsx-runtime', 'scheduler', 'react-reconciler', 'react-reconciler/constants.js'];

/** Which build this process's React is. */
export type ReactBuild = 'production' | 'development';

/**
 * Loads REACT_MODULES with NODE_ENV=production, then puts NODE_ENV back as it was; with TIMMY_REACT_DEV=1, loads nothing (the
 * development builds load where they are first imported). `load` is how a module is loaded (a test's FAKE; else require from
 * here). A module that cannot be loaded is left to load where it is first imported.
 */
export function loadReactProduction(env: NodeJS.ProcessEnv = process.env, load: (id: string) => unknown = createRequire(import.meta.url)): ReactBuild {
  if (env.TIMMY_REACT_DEV === '1') return 'development';
  const had = Object.prototype.hasOwnProperty.call(env, 'NODE_ENV');
  const was = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    for (const id of REACT_MODULES) {
      try { load(id); } catch { /* not installed beside this file: the build chosen where it is first imported */ }
    }
  } finally {
    if (had && was !== undefined) env.NODE_ENV = was;
    else delete env.NODE_ENV;
  }
  return 'production';
}
