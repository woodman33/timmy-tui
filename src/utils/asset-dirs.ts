/**
 * Files Timmy ships beside its code (round R3, packaging): the project starters in templates/ and the native and
 * vision workers in workers/. One lookup, from a module's own place, for the three layouts a module runs in:
 *
 *   a checkout             <root>/src/<area>/<module>.ts        (tsx, vitest)
 *   the TypeScript build   <root>/dist/src/<area>/<module>.js   (tsc; the bin dist/timmy.js forwards to dist/src/cli.js)
 *   the bundled CLI        <root>/dist/<chunk>.js               (scripts/build-cli.mjs: esbuild with splitting)
 *
 * The package root is the nearest folder, at or above the module's own, that holds a package.json named timmy-tui:
 * the checkout, or the installed package, where package.json "files" puts the starters and workers. Nothing above
 * that root (the project that installed Timmy, say) is looked at. An asset is accepted only as a regular file or a
 * directory inside the root, reached through directories: never a link, never a path that climbs out.
 *
 * From any module, pass that module's own import.meta.url:
 *   packagedPath('templates', import.meta.url, { kind: 'dir' })
 *   packagedPath('workers/c4d/timmy_c4d.py', import.meta.url, { kind: 'file' })
 */
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'timmy-tui';

export type AssetKind = 'file' | 'dir';

/** How the lookup sees the filesystem; tests pass a simulated one. */
export interface AssetProbe {
  /** What is at an absolute path, without following a final link: a regular file, a directory, or neither. */
  kind(path: string): AssetKind | undefined;
  /** A file's text, or undefined when it cannot be read. */
  read(path: string): string | undefined;
}

/** The real filesystem. */
export const fsProbe: AssetProbe = {
  kind(path) {
    try {
      const st = lstatSync(path);
      return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : undefined;
    } catch { return undefined; }
  },
  read(path) {
    try { return readFileSync(path, 'utf8'); } catch { return undefined; }
  },
};

function isTimmyRoot(dir: string, probe: AssetProbe): boolean {
  const manifest = join(dir, 'package.json');
  if (probe.kind(manifest) !== 'file') return false;
  const text = probe.read(manifest);
  if (text === undefined) return false;
  try { return (JSON.parse(text) as { name?: unknown } | null)?.name === PACKAGE_NAME; } catch { return false; }
}

/**
 * The package root for a module given by its URL (import.meta.url): the nearest folder at or above the module's
 * own holding a package.json named timmy-tui. Undefined when there is none, or the URL is not a file URL.
 */
export function packageRoot(moduleUrl: string | URL, probe: AssetProbe = fsProbe): string | undefined {
  let dir: string | undefined;
  try { dir = dirname(fileURLToPath(moduleUrl)); } catch { return undefined; }
  while (dir !== undefined) {
    if (isTimmyRoot(dir, probe)) return dir;
    const up = dirname(dir);
    dir = up === dir ? undefined : up;
  }
  return undefined;
}

/** A package-relative path's names: forward slashes and plain names only, so it cannot leave the package. */
function names(rel: string): string[] {
  const parts = rel.split('/');
  if (parts.some((p) => p === '.' || p === '..' || !/^[A-Za-z0-9._-]+$/.test(p))) {
    throw new TypeError(`not a package-relative path: ${JSON.stringify(rel)}`);
  }
  return parts;
}

/**
 * Where a shipped file or folder is: `rel` (package-relative, forward slashes) under packageRoot(moduleUrl), when it
 * is there as a regular file or a directory (`kind` asks for one of them), reached through directories and not a
 * link. Undefined otherwise. A `rel` that is absolute, empty, or holds '.', '..', a backslash or a drive is a
 * programming error (TypeError).
 */
export function packagedPath(rel: string, moduleUrl: string | URL, opts: { kind?: AssetKind; probe?: AssetProbe } = {}): string | undefined {
  const parts = names(rel);
  const probe = opts.probe ?? fsProbe;
  const root = packageRoot(moduleUrl, probe);
  if (root === undefined) return undefined;
  for (let i = 1; i < parts.length; i++) {
    if (probe.kind(join(root, ...parts.slice(0, i))) !== 'dir') return undefined;
  }
  const path = join(root, ...parts);
  const kind = probe.kind(path);
  return kind !== undefined && (opts.kind === undefined || kind === opts.kind) ? path : undefined;
}
