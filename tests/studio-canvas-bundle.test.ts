import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TLDRAW_VERSION } from '../src/studio/config.js';

// Fourth order, step 5: Timmy Canvas on tldraw bundled on this machine, pinned, with tldraw's own
// fonts, icons, translations and embed icons beside the code, so the page loads nothing from
// another host. tldraw's license asks for a verbatim copy in any distribution; the package's own
// LICENSE.md only points to it. The text (from the v5.5.2 tag) names an email address, which the
// privacy gate keeps out of the repo until the operator rules, so the build knows it by its hash
// and a package build refuses to go without it.
const root = fileURLToPath(new URL('..', import.meta.url));
const page = join(root, 'companion', 'studio-canvas');
const build = join(root, 'scripts', 'canvas', 'build.mjs');
const TLDRAW_LICENSE_SHA256 = '9578fcddc20e404b6a29f44b6fea81d8b331698c0e7e9be34132d6f4394fa533';
// The licenses the bundle may carry: permissive ones, and tldraw's own (its packages say
// "SEE LICENSE IN LICENSE.md"). Anything else stops the build's check until someone reads it.
const ALLOWED_LICENSES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'SEE LICENSE IN LICENSE.md']);

describe('Timmy Canvas loads nothing from another host', () => {
  it('the page names no remote address and loads the bundle beside it', () => {
    const html = readFileSync(join(page, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toContain('esm.sh');
    expect(html).toMatch(/<script type="module" src="dist\/canvas\.js"/);
    expect(html).toContain('<link rel="stylesheet" href="dist/canvas.css"');
  });
  it("the page's code imports packages, never an address", () => {
    const code = readFileSync(join(page, 'src', 'canvas.js'), 'utf8');
    const imports = [...code.matchAll(/^import (?:[^'\n]+ from )?'([^']+)';$/gm)].map((m) => m[1]);
    // R4 (H55): and the page's own Project panel, a file beside it that imports nothing.
    // R4 (H75): and the drawn cards, a file beside it that imports nothing either (canvas.js hands it React and tldraw).
    expect(imports).toEqual(['react', 'react-dom/client', 'tldraw', '@tldraw/assets/selfHosted', 'tldraw/tldraw.css', './project.js', './cards.js']);
    for (const file of ['project.js', 'cards.js']) {
      const own = readFileSync(join(page, 'src', file), 'utf8');
      expect([...own.matchAll(/^import\b/gm)], file).toEqual([]);
      expect(own, file).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    }
  });
  it('pins tldraw and its assets at the version Timmy names, as build-time dependencies only', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    expect(pkg.devDependencies.tldraw).toBe(TLDRAW_VERSION);
    expect(pkg.devDependencies['@tldraw/assets']).toBe(TLDRAW_VERSION);
    expect(pkg.dependencies.tldraw).toBeUndefined();
    expect(pkg.scripts['build:canvas']).toBe('node scripts/canvas/build.mjs');
    expect(pkg.scripts.build).toContain('node scripts/canvas/build.mjs');
    // A package carries tldraw, so it must carry tldraw's license: prepack refuses a build without it.
    expect(pkg.scripts.prepack).toBe('npm run build && node scripts/canvas/build.mjs --check');
  });
});

type Built = {
  versions: Record<string, string>;
  packages: Array<{ name: string; version: string; license: string; licenseFile: string | null }>;
  distributable: boolean;
  missing: string[];
};
type BuildCanvas = (root: string, out: string, options?: { licenses?: string }) => Promise<Built>;

describe('the canvas build', () => {
  let out = '';
  let licenses = '';
  let built: Built;
  let buildCanvas: BuildCanvas;
  const previousKey = process.env.TLDRAW_LICENSE_KEY;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'timmy-canvas-'));
    licenses = mkdtempSync(join(tmpdir(), 'timmy-canvas-licenses-'));
    // A key in the build's environment must never end up in the bundle: the server hands it over at run time.
    process.env.TLDRAW_LICENSE_KEY = 'tldraw-NOT-A-REAL-KEY/eyJ0IjoxfQ.c2ln';
    ({ buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: BuildCanvas });
    built = await buildCanvas(root, out, { licenses });
  }, 120_000);
  afterAll(() => {
    if (previousKey === undefined) delete process.env.TLDRAW_LICENSE_KEY;
    else process.env.TLDRAW_LICENSE_KEY = previousKey;
    rmSync(out, { recursive: true, force: true });
    rmSync(licenses, { recursive: true, force: true });
  });

  it('bundles the pinned tldraw with React and react-dom at one version', () => {
    expect(built.versions.tldraw).toBe(TLDRAW_VERSION);
    expect(built.versions.assets).toBe(TLDRAW_VERSION);
    expect(built.versions.react).toBe(built.versions.reactDom);
    for (const f of ['canvas.js', 'canvas.css', 'versions.json']) expect(existsSync(join(out, f)), f).toBe(true);
    expect(readFileSync(join(out, 'canvas.js'), 'utf8')).toContain(`"${TLDRAW_VERSION}"`);
  });
  it("puts every font, icon, translation and embed icon tldraw's self-hosted map names beside the code", () => {
    const map = readFileSync(join(root, 'node_modules', '@tldraw', 'assets', 'selfHosted.js'), 'utf8');
    const named = [...new Set([...map.matchAll(/formatAssetUrl\(\s*'\.\/([^']+)'/g)].map((m) => m[1]))];
    expect(named.length).toBeGreaterThan(40);
    expect(named.filter((p) => !existsSync(join(out, 'assets', p)))).toEqual([]);
  });
  it('writes a notice for every package it bundles, under licenses the bundle may carry', () => {
    const notices = readFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    const names = built.packages.map((p) => p.name);
    for (const must of ['tldraw', '@tldraw/editor', 'react', 'react-dom']) expect(names).toContain(must);
    for (const p of built.packages) expect(notices).toContain(`## ${p.name} ${p.version}`);
    expect(built.packages.filter((p) => !ALLOWED_LICENSES.has(p.license)).map((p) => `${p.name}: ${p.license}`)).toEqual([]);
  });
  it('without the verbatim tldraw license, or a license text for each package, the build is not distributable and says what is missing', () => {
    expect(built.distributable).toBe(false);
    expect(existsSync(join(out, 'LICENSE-tldraw.md'))).toBe(false);
    // The one bundled package that ships no license file of its own (it says MIT in package.json).
    expect(built.packages.filter((p) => p.licenseFile === null).map((p) => p.name)).toEqual(['react-remove-scroll-bar']);
    expect(built.missing).toEqual([
      'LICENSE-tldraw.md: the tldraw license, verbatim from the v5.5.2 tag (it asks for a copy in any distribution)',
      'licenses/react-remove-scroll-bar.LICENSE: react-remove-scroll-bar 2.3.8 ships no license file; its repository\'s, verbatim',
    ]);
    expect(JSON.parse(readFileSync(join(out, 'versions.json'), 'utf8'))).toMatchObject({ distributable: false, missing: built.missing });
  });
  it('a tldraw license file that is not the verbatim v5.5.2 text does not count', async () => {
    const other = mkdtempSync(join(tmpdir(), 'timmy-canvas-other-'));
    const otherOut = mkdtempSync(join(tmpdir(), 'timmy-canvas-out-'));
    try {
      writeFileSync(join(other, 'LICENSE-tldraw.md'), '# tldraw license (edited)');
      const result = await buildCanvas(root, otherOut, { licenses: other });
      expect(result.missing[0]).toBe(`LICENSE-tldraw.md: not the verbatim v5.5.2 text (sha256 must be ${TLDRAW_LICENSE_SHA256})`);
      expect(existsSync(join(otherOut, 'LICENSE-tldraw.md'))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(otherOut, { recursive: true, force: true });
    }
  }, 120_000);
  it('the package check (prepack) refuses a build that is not distributable, naming what is missing', () => {
    const run = (dir: string) => {
      try {
        return { code: 0, out: execFileSync('node', [build, '--check', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (error) {
        const e = error as { status: number; stderr: string };
        return { code: e.status, out: e.stderr };
      }
    };
    const refused = run(out);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('LICENSE-tldraw.md: the tldraw license, verbatim');
    const ready = mkdtempSync(join(tmpdir(), 'timmy-canvas-ready-'));
    try {
      writeFileSync(join(ready, 'versions.json'), JSON.stringify({ distributable: true, missing: [] }));
      expect(run(ready).code).toBe(0);
    } finally {
      rmSync(ready, { recursive: true, force: true });
    }
  });
  it('never builds the license key in', () => {
    expect(readFileSync(join(out, 'canvas.js'), 'utf8')).not.toContain('NOT-A-REAL-KEY');
  });
});

describe('the npm package', () => {
  it('ships the canvas page with its build beside it (npm keeps a nested dist/ that .gitignore names)', () => {
    // npm's own inclusion rules, checked on a scratch package with this repo's files list and .gitignore,
    // so the check needs no build in the repo itself.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('companion/studio-canvas');
    const scratch = mkdtempSync(join(tmpdir(), 'timmy-pack-'));
    try {
      writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'scratch', version: '0.0.0', files: pkg.files }));
      cpSync(join(root, '.gitignore'), join(scratch, '.gitignore'));
      for (const f of ['index.html', 'src/canvas.js', 'dist/canvas.js', 'dist/canvas.css', 'dist/LICENSE-tldraw.md', 'dist/assets/fonts/x.woff2']) {
        mkdirSync(join(scratch, 'companion', 'studio-canvas', f, '..'), { recursive: true });
        writeFileSync(join(scratch, 'companion', 'studio-canvas', f), 'x');
      }
      const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: scratch, encoding: 'utf8' })) as Array<{ files: Array<{ path: string }> }>;
      expect(pack.files.map((f) => f.path).filter((p) => p.startsWith('companion/')).sort()).toEqual([
        'companion/studio-canvas/dist/LICENSE-tldraw.md',
        'companion/studio-canvas/dist/assets/fonts/x.woff2',
        'companion/studio-canvas/dist/canvas.css',
        'companion/studio-canvas/dist/canvas.js',
        'companion/studio-canvas/index.html',
        'companion/studio-canvas/src/canvas.js',
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
