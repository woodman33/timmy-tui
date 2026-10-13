/**
 * Round R4 (helper H97): records every use of the file system, in this process, of a path under one of the given folders.
 * tests/isolation-setup.ts watches the account's own Timmy home with it, so a test that reads (or writes) the real one is
 * named, with the call and the path, and its file fails.
 *
 * Every function of node:fs and node:fs/promises (classes aside) is wrapped while the watch runs: its first two arguments
 * (a path, or two for a rename, a copy or a link) are checked, as strings, file: URLs and Buffers, made absolute against the
 * current folder; then the original runs as before, with the same `this` and arguments, and its own properties (such as
 * util.promisify.custom, or realpath's .native) are kept. The ES module bindings of node:fs are synchronised too
 * (module.syncBuiltinESMExports), so an `import { readFileSync } from 'node:fs'` sees the wrapper. What it cannot see: a
 * child process's use of the file system, and a file opened before the watch began.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PathWatch {
  /** each use seen: "<function> <absolute path> (from <the first caller outside node and this file>)", in the order seen */
  readonly seen: string[];
  /** the folders it watches, absolute */
  readonly roots: readonly string[];
  /** puts the original functions back */
  stop(): void;
}

type Fn = (...args: unknown[]) => unknown;

/**
 * Starts watching `roots` (folders; a path equal to one, or under one, is recorded). `exempt`: files (a part of their path)
 * whose own uses are not counted, wherever they appear on the call's stack: a guard that lists a watched folder on purpose.
 */
export function watchPaths(roots: readonly string[], o: { exempt?: readonly string[] } = {}): PathWatch {
  const exempt = o.exempt ?? [];
  const watched = [...new Set(roots.map((r) => path.resolve(r)))];
  const seen: string[] = [];
  const under = (arg: unknown): string | null => {
    let p: string | null = null;
    if (typeof arg === 'string') p = arg;
    else if (arg instanceof URL) p = arg.protocol === 'file:' ? fileURLToPath(arg) : null;
    else if (Buffer.isBuffer(arg)) p = arg.toString('utf8');
    if (p === null || p === '' || p.includes('\0')) return null;
    const abs = path.resolve(p);
    return watched.some((r) => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`)) ? abs : null;
  };
  const undo: Array<() => void> = [];
  /** The frames of the call's stack that are neither node's own nor this file's, the nearest first. */
  const callers = (): string[] => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    const stack = new Error().stack ?? '';
    Error.stackTraceLimit = limit;
    return stack.split('\n').slice(1).map((l) => l.trim()).filter((l) => !l.includes('path-watch') && !/\(node:|at node:|\(internal\/|\(<anonymous>\)|^at <anonymous>$/.test(l));
  };
  const record = (name: string, hit: string): void => {
    const frames = callers();
    if (exempt.length && frames.some((f) => exempt.some((e) => f.includes(e)))) return;
    seen.push(`${name} ${hit} (from ${frames[0] ? frames[0].replace(/^at\s+/, '') : 'an unknown caller'})`);
  };
  const wrap = (name: string, orig: Fn): Fn => {
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      for (const a of args.slice(0, 2)) { const hit = under(a); if (hit) record(name, hit); }
      return orig.apply(this, args);
    };
    for (const key of Reflect.ownKeys(orig)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue;
      const d = Object.getOwnPropertyDescriptor(orig, key)!;
      try {
        // realpath.native and realpathSync.native: watched too
        if (key === 'native' && typeof d.value === 'function') Object.defineProperty(wrapped, key, { ...d, value: wrap(`${name}.native`, d.value as Fn) });
        else Object.defineProperty(wrapped, key, d);
      } catch { /* a property a function cannot be given: the original keeps it */ }
    }
    return wrapped;
  };
  const patch = (target: Record<string, unknown>, prefix: string): void => {
    for (const name of Object.keys(target)) {
      const d = Object.getOwnPropertyDescriptor(target, name);
      // values only (fs.promises is a getter), functions only, no classes (Stats, ReadStream, Dir …)
      if (!d || !('value' in d) || typeof d.value !== 'function' || /^[A-Z]/.test(name) || !d.writable) continue;
      const orig = d.value as Fn;
      target[name] = wrap(`${prefix}${name}`, orig);
      undo.push(() => { target[name] = orig; });
    }
  };
  patch(fs as unknown as Record<string, unknown>, '');
  patch(fs.promises as unknown as Record<string, unknown>, 'promises.');
  syncBuiltinESMExports();
  let stopped = false;
  return {
    seen,
    roots: watched,
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const u of undo.splice(0)) u();
      syncBuiltinESMExports();
    },
  };
}
