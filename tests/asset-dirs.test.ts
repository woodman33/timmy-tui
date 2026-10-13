// Round R3 (packaging): one lookup for the files Timmy ships beside its code (the starters in templates/, the
// workers in workers/), from a module's own place in each layout it runs in: a checkout (src/<area>/), the
// TypeScript build (dist/src/<area>/) and the bundled CLI (dist/<chunk>.js), in a checkout or an installed
// package. The resolver is pure: these cases simulate each layout through an injected probe.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, packageRoot, packagedPath, type AssetProbe } from '../src/utils/asset-dirs.js';

type Entry = 'file' | 'dir' | 'link';
const PACKAGE = JSON.stringify({ name: 'timmy-tui', version: '0.0.0' });

/** A simulated filesystem: what is at each absolute path, and the text of the package.json files in it. */
function simulated(entries: Record<string, Entry>, texts: Record<string, string> = {}): AssetProbe & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    kind: (path) => { const k = entries[path]; return k === 'file' || k === 'dir' ? k : undefined; },
    read: (path) => { reads.push(path); return entries[path] === 'file' ? texts[path] : undefined; },
  };
}

/** Timmy's package at `root`: its package.json, the starters and the workers, plus anything extra. */
function timmyAt(root: string, extra: Record<string, Entry> = {}, texts: Record<string, string> = {}) {
  return simulated({
    [join(root, 'package.json')]: 'file',
    [join(root, 'templates')]: 'dir',
    [join(root, 'templates/web-starter')]: 'dir',
    [join(root, 'templates/c4d-starter')]: 'dir',
    [join(root, 'workers')]: 'dir',
    [join(root, 'workers/look')]: 'dir',
    [join(root, 'workers/look/look.py')]: 'file',
    [join(root, 'workers/c4d')]: 'dir',
    [join(root, 'workers/c4d/timmy_c4d.py')]: 'file',
    ...extra,
  }, { [join(root, 'package.json')]: PACKAGE, ...texts });
}
const url = (path: string): URL => pathToFileURL(path);

describe('the package root', () => {
  it('is named timmy-tui', () => expect(PACKAGE_NAME).toBe('timmy-tui'));

  it('is found from a checkout (src/<area>/<module>.ts)', () => {
    const fs = timmyAt('/repo');
    expect(packageRoot(url('/repo/src/project/starters.ts'), fs)).toBe('/repo');
    expect(packagedPath('templates', url('/repo/src/project/starters.ts'), { kind: 'dir', probe: fs })).toBe('/repo/templates');
    expect(packagedPath('workers/look/look.py', url('/repo/src/vision/look.ts'), { kind: 'file', probe: fs })).toBe('/repo/workers/look/look.py');
  });

  it('is found from the TypeScript build in a checkout (dist/src/<area>/<module>.js)', () => {
    const fs = timmyAt('/repo');
    expect(packageRoot(url('/repo/dist/src/vision/look.js'), fs)).toBe('/repo');
    expect(packagedPath('workers/c4d/timmy_c4d.py', url('/repo/dist/src/native/index.js'), { kind: 'file', probe: fs })).toBe('/repo/workers/c4d/timmy_c4d.py');
  });

  it('is found from the TypeScript build of an installed package, not the project that installed it', () => {
    const pkg = '/work/app/node_modules/timmy-tui';
    const fs = timmyAt(pkg, { '/work/app/package.json': 'file' }, { '/work/app/package.json': JSON.stringify({ name: 'my-app' }) });
    expect(packageRoot(url(`${pkg}/dist/src/project/starters.js`), fs)).toBe(pkg);
    expect(packagedPath('templates', url(`${pkg}/dist/src/project/starters.js`), { kind: 'dir', probe: fs })).toBe(`${pkg}/templates`);
    // The walk stops at Timmy's own package.json: the installing project's is never read.
    expect(fs.reads).not.toContain('/work/app/package.json');
  });

  it('is found from the bundled CLI (dist/<chunk>.js), ignoring what lies where the old guesses looked', () => {
    const pkg = '/work/app/node_modules/timmy-tui';
    // '../..' and '../../..' from dist/ land outside the package: decoys there must never be used.
    const fs = timmyAt(pkg, {
      '/work/app/templates': 'dir', '/work/app/templates/web-starter': 'dir',
      '/work/app/node_modules/workers/look/look.py': 'file', '/work/workers/look/look.py': 'file',
    });
    for (const chunk of ['dist/fast-entry.js', 'dist/chunk-7QX2KD3A.js']) {
      expect(packageRoot(url(`${pkg}/${chunk}`), fs)).toBe(pkg);
      expect(packagedPath('templates', url(`${pkg}/${chunk}`), { kind: 'dir', probe: fs })).toBe(`${pkg}/templates`);
      expect(packagedPath('workers/look/look.py', url(`${pkg}/${chunk}`), { kind: 'file', probe: fs })).toBe(`${pkg}/workers/look/look.py`);
    }
  });

  it('is found from a module at the package root itself (timmy.ts)', () => {
    expect(packageRoot(url('/repo/timmy.ts'), timmyAt('/repo'))).toBe('/repo');
  });

  it('skips a package.json that is not Timmy\'s, cannot be read as JSON, or is a link', () => {
    const fs = timmyAt('/repo', { '/repo/dist/package.json': 'file', '/repo/dist/src/package.json': 'file', '/repo/dist/src/project/package.json': 'link' }, {
      '/repo/dist/package.json': '{"type":"module"}', '/repo/dist/src/package.json': '{ not json', '/repo/dist/src/project/package.json': PACKAGE,
    });
    expect(packageRoot(url('/repo/dist/src/project/starters.js'), fs)).toBe('/repo');
  });

  it('takes the nearest Timmy when one is installed inside another', () => {
    const inner = '/repo/node_modules/timmy-tui';
    const fs = timmyAt('/repo', { [join(inner, 'package.json')]: 'file', [join(inner, 'templates')]: 'dir' }, { [join(inner, 'package.json')]: PACKAGE });
    expect(packageRoot(url(`${inner}/dist/src/project/starters.js`), fs)).toBe(inner);
  });

  it('is undefined when no folder above holds Timmy\'s package.json, or the URL is not a file', () => {
    const fs = simulated({ '/elsewhere/package.json': 'file', '/elsewhere/templates': 'dir' }, { '/elsewhere/package.json': '{"name":"other"}' });
    expect(packageRoot(url('/elsewhere/dist/src/project/starters.js'), fs)).toBeUndefined();
    expect(packagedPath('templates', url('/elsewhere/dist/src/project/starters.js'), { probe: fs })).toBeUndefined();
    expect(packageRoot('data:text/javascript,export%20{}', fs)).toBeUndefined();
    expect(packageRoot('https://example.invalid/dist/timmy.js', fs)).toBeUndefined();
  });
});

describe('a packaged path', () => {
  const fs = timmyAt('/repo', {
    '/repo/workers/linked.py': 'link', '/repo/templates/linked-starter': 'link',
    // A folder that is a link, with a regular file behind it: the file is not reached through the link.
    '/repo/workers/linked-dir': 'link', '/repo/workers/linked-dir/helper.py': 'file',
  });
  const from = url('/repo/src/project/starters.ts');

  it('is a regular file or a folder in the package, never a link and never missing', () => {
    expect(packagedPath('workers/look/look.py', from, { probe: fs })).toBe('/repo/workers/look/look.py');
    expect(packagedPath('templates/web-starter', from, { probe: fs })).toBe('/repo/templates/web-starter');
    expect(packagedPath('workers/linked.py', from, { probe: fs })).toBeUndefined();
    expect(packagedPath('templates/linked-starter', from, { probe: fs })).toBeUndefined();
    expect(packagedPath('workers/linked-dir/helper.py', from, { probe: fs })).toBeUndefined();
    expect(packagedPath('workers/blender/timmy_blender.py', from, { probe: fs })).toBeUndefined();
  });

  it('is the kind asked for', () => {
    expect(packagedPath('templates', from, { kind: 'file', probe: fs })).toBeUndefined();
    expect(packagedPath('workers/look/look.py', from, { kind: 'dir', probe: fs })).toBeUndefined();
    expect(packagedPath('workers/look/look.py', from, { kind: 'file', probe: fs })).toBe('/repo/workers/look/look.py');
  });

  it('stays inside the package: an absolute, empty or climbing path is a programming error', () => {
    for (const rel of ['/etc/hosts', '', '.', '../templates', 'templates/../../x', 'workers/./look/look.py', 'templates\\web-starter', 'C:/x']) {
      expect(() => packagedPath(rel, from, { probe: fs }), rel).toThrow(TypeError);
    }
  });
});

describe('on this checkout', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

  it('finds the repository root and its starters and workers through the real filesystem', () => {
    expect(packageRoot(import.meta.url)).toBe(root);
    expect(packagedPath('templates/web-starter', import.meta.url, { kind: 'dir' })).toBe(join(root, 'templates/web-starter'));
    expect(packagedPath('templates/c4d-starter', import.meta.url, { kind: 'dir' })).toBe(join(root, 'templates/c4d-starter'));
    expect(packagedPath('workers/look/look.py', import.meta.url, { kind: 'file' })).toBe(join(root, 'workers/look/look.py'));
    expect(packagedPath('workers/c4d/timmy_c4d.py', import.meta.url, { kind: 'file' })).toBe(join(root, 'workers/c4d/timmy_c4d.py'));
  });
});
