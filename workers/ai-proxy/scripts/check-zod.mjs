// Preflight for `npm test` (wired as `pretest`). ORDER codemode-f7q1.
//
// Code Mode publishes tool types via Zod v4's top-level `z.toJSONSchema`
// (src/tools.ts, src/index.ts). This worker correctly pins `zod: ^4.5.4`, the
// lockfile pins 4.5.4, and the deployed bundle runs v4 — Code Mode has never
// been broken in production.
//
// The failure mode this guard addresses is purely local: the repo ROOT
// legitimately declares `zod: ^3.24.0`. If this worker's OWN node_modules is not
// installed (e.g. a fresh worktree where only the root was installed), Node
// resolves `zod` UPWARD to the root's v3, whose default export predates the
// top-level `toJSONSchema`, and vitest fails four Code Mode tests with a cryptic
// `z.toJSONSchema is not a function` that reads like a code bug.
//
// So: if the v4 API is present, proceed. If it is absent BECAUSE the worker's own
// deps were never installed, self-heal with `npm ci` (exactly the fix) and
// re-check, so `npm test` is green from a bare checkout. Only when it still can't
// get there do we fail — with one legible, actionable line. No runtime/source
// change; not part of the deploy bundle.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const WORKER_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // workers/ai-proxy
const LOCAL_ZOD = join(WORKER_ROOT, 'node_modules', 'zod');

function probe() {
  // Resolve in a fresh child so we never trust this process's require cache
  // across an install. Prints "<path>\t<version>\t<0|1 hasV4>" or "MISSING".
  const src =
    "try{const r=require.resolve('zod');const v=require('zod/package.json').version;" +
    "const {z}=require('zod');process.stdout.write(r+'\\t'+v+'\\t'+(typeof z?.toJSONSchema==='function'?'1':'0'));}" +
    "catch(e){process.stdout.write('MISSING');}";
  const r = spawnSync(process.execPath, ['-e', src], { cwd: WORKER_ROOT, encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (out === 'MISSING' || !out) return { resolved: null, version: null, hasV4: false };
  const [resolved, version, hasV4] = out.split('\t');
  return { resolved, version, hasV4: hasV4 === '1' };
}

let s = probe();
if (s.hasV4) {
  console.log(`[check-zod] ok — zod v${s.version} exposes z.toJSONSchema (${s.resolved})`);
  process.exit(0);
}

// v4 API missing. If the worker's OWN zod isn't installed, this is the hoisting
// case — self-heal with the exact documented fix, then re-check.
if (!existsSync(LOCAL_ZOD)) {
  console.log(
    `[check-zod] zod resolved without the v4 API (${s.resolved ?? 'unresolved'}${s.version ? ` v${s.version}` : ''}); ` +
      "workers/ai-proxy has no local zod — running `npm ci` to install its pinned v4…",
  );
  const ci = spawnSync('npm', ['ci'], { cwd: WORKER_ROOT, stdio: 'inherit' });
  if (ci.status === 0) {
    s = probe();
    if (s.hasV4) {
      console.log(`[check-zod] ok after npm ci — zod v${s.version} exposes z.toJSONSchema (${s.resolved})`);
      process.exit(0);
    }
  }
}

console.error(
  `[check-zod] zod resolved to ${s.resolved ?? 'unresolved'} (v${s.version ?? '?'}) — no top-level z.toJSONSchema (the Zod v4 API).\n` +
    '[check-zod] Code Mode needs Zod v4. This worker pins zod ^4.5.4, but without its OWN\n' +
    "[check-zod] node_modules, Node hoists to the repo root's zod ^3.24.0 (v3).\n" +
    '[check-zod] Fix: run `npm ci` in workers/ai-proxy.',
);
process.exit(1);
