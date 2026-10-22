// R10 (H163; the turn-holds latency): a probe loaded with --import before a launched timmy (src/cli.ts). At the process's exit it
// writes, to REACT_PROBE_OUT, which files of React, its JSX runtime, the scheduler and react-reconciler (Ink's) the process ran
// (Node's module cache, the modules evaluated only: Node's ESM loader also caches, unevaluated, every file a CommonJS module
// may re-export, the development builds among them, to read their export names), NODE_ENV as it was then (null: not set), and,
// when REACT_PROBE_RECEIPTS names src/utils/receipts.ts, the receipts' store for the process's own folder (rootStoreDir: under
// NODE_ENV=test with TIMMY_STORE set, TIMMY_STORE). It loads nothing of React itself.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const cache = createRequire(import.meta.url).cache;
const out = process.env.REACT_PROBE_OUT;
const receipts = process.env.REACT_PROBE_RECEIPTS ? await import(process.env.REACT_PROBE_RECEIPTS) : null;
process.on('exit', () => {
  if (!out) return;
  const files = Object.entries(cache)
    .filter(([f, m]) => m?.loaded === true && /[\\/]node_modules[\\/](react|scheduler|react-reconciler)[\\/]/.test(f))
    .map(([f]) => f.replace(/^.*[\\/]node_modules[\\/]/, '').split('\\').join('/'))
    .sort();
  const nodeEnv = Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV') ? process.env.NODE_ENV : null;
  writeFileSync(out, JSON.stringify({ files, nodeEnv, store: receipts ? receipts.rootStoreDir() ?? null : null }));
});
