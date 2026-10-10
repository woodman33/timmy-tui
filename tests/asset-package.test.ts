// Round R3 (packaging): the npm package carries the project starters (templates/web-starter, c4d-starter) and
// the Look and Cinema 4D workers (workers/look, workers/c4d), and an installed Timmy finds them from wherever
// its code runs: the TypeScript build (dist/src/<area>/, where the bin dist/timmy.js forwards) or the bundled
// CLI (dist/<chunk>.js, scripts/build-cli.mjs). The lists are npm's own (npm pack, the build skipped, offline,
// with a throwaway npm cache), compared with what git tracks. Nothing here installs, publishes or uses the network.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync, transformSync, type Metafile } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
/**
 * What the package must carry, file for file, as git tracks it. Round R4 (H40): this round's starters and workers too,
 * as scripts/packed-install-check.mjs's probe now asks for them in an installed package. R4 (H41): workers/readback
 * holds the STEP, .blend and video readback workers.
 */
const SHIPPED = [
  'templates/web-starter', 'templates/c4d-starter', 'workers/look', 'workers/c4d',
  'templates/ae-starter', 'templates/scad-starter', 'templates/freecad-starter', 'workers/scad', 'workers/freecad', 'workers/readback',
];
/**
 * TODO(lead): templates/blender-starter and workers/blender (another helper, round R3) ship the same way: each
 * tracked regular file listed by name in package.json "files" (a folder entry would also carry __pycache__).
 * While they have no tracked files the check below holds trivially; once they do, it fails until "files" lists them.
 */
const COMING = ['templates/blender-starter', 'workers/blender'];
const PYCACHE = /(^|\/)__pycache__(\/|$)|\.py[co]$/;

const temporary: string[] = [];
const temp = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temporary.push(d); return d; };
afterAll(() => { for (const d of temporary.splice(0)) rmSync(d, { recursive: true, force: true }); });
const write = (path: string, body: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };

let npmCache = '';
const env = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: 'false', npm_config_cache: npmCache || (npmCache = temp('timmy-npm-cache-')) };
  delete e.NODE_OPTIONS; delete e.NODE_PATH;
  return e;
};
const npm = (cwd: string, args: string[]): string => execFileSync('npm', args, { cwd, encoding: 'utf8', timeout: 120_000, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
const packList = (cwd: string): string[] => {
  const [pack] = JSON.parse(npm(cwd, ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'])) as Array<{ files: Array<{ path: string }> }>;
  return pack.files.map((f) => f.path).sort();
};
const tracked = (prefix: string): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', prefix], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const under = (paths: string[], prefix: string): string[] => paths.filter((p) => p.startsWith(`${prefix}/`));

describe('the npm package', () => {
  it('carries every tracked file of the starters and workers, and no Python cache', () => {
    const listed = packList(root);
    for (const prefix of SHIPPED) {
      expect(tracked(prefix).length, prefix).toBeGreaterThan(0);
      expect(under(listed, prefix), prefix).toEqual(tracked(prefix));
    }
    for (const prefix of COMING) expect(under(listed, prefix), `${prefix}: list its tracked files in package.json "files"`).toEqual(tracked(prefix));
    expect(listed.filter((p) => PYCACHE.test(p))).toEqual([]);
  });

  it('leaves out a stray cache, a .env or a note that sits beside the shipped files', () => {
    const src = temp('timmy-asset-src-');
    cpSync(join(root, 'package.json'), join(src, 'package.json'));
    const files = SHIPPED.flatMap(tracked);
    for (const f of files) cpSync(join(root, f), join(src, f));
    write(join(src, 'workers/c4d/__pycache__/timmy_c4d.cpython-311.pyc'), 'synthetic cache');
    write(join(src, 'workers/look/__pycache__/look.cpython-312.pyc'), 'synthetic cache');
    write(join(src, 'templates/c4d-starter/__pycache__/scene.cpython-311.pyc'), 'synthetic cache');
    write(join(src, 'templates/web-starter/.env'), 'SYNTHETIC_KEY=not-a-real-value');
    write(join(src, 'workers/look/notes.txt'), 'synthetic local note');
    expect(packList(src)).toEqual(['package.json', ...files].sort());
  });
});

type Probe = {
  starters: string | null; list: string[]; look: string; lookExists: boolean; c4d: string | null; root: string | null; copied: { files: string[] } | { error: string } | null;
  /** R4 (H40): the OpenSCAD runner and the FreeCAD worker (from src/native/), and the readback workers (from src/flows/; R4 H46: the video one too) */
  scad: string | null; freecad: string | null; step: string | null; blend: string | null; video: string | null;
};

describe('an installed Timmy finds its starters and workers', () => {
  let base = '', pkg = '';
  let bundled: Metafile;
  const layouts: Record<string, { probe: string; native: string; flows: string }> = {};
  const TSC = 'the TypeScript build (dist/src/<area>/)', BUNDLE = 'the bundled CLI (dist/<chunk>.js)';

  beforeAll(() => {
    // A real tarball (npm pack, the build skipped), unpacked as npm installs it: <tmp>/package.
    base = temp('timmy-asset-install-');
    const [{ filename }] = JSON.parse(npm(root, ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', base])) as Array<{ filename: string }>;
    execFileSync('tar', ['-xzf', join(base, filename), '-C', base]);
    pkg = join(base, 'package');
    // Decoys where the old guesses ('../..' and '../../..' from the module's folder) land for the bundled CLI.
    write(join(base, 'templates/web-starter/index.html'), 'decoy');
    write(join(base, 'workers/look/look.py'), 'decoy');
    write(join(base, 'workers/c4d/timmy_c4d.py'), 'decoy');
    // R4 (H40): decoys for this round's workers too
    for (const w of ['workers/scad/timmy_scad_run.mjs', 'workers/freecad/timmy_freecad.py', 'workers/readback/step_readback.py', 'workers/readback/blend_readback.py', 'workers/readback/video_readback.py']) write(join(base, w), 'decoy');

    const probeBody = (load: (m: string) => string): string => `
      const { startersDir, listStarters, copyStarter } = await import(${load('src/project/starters.ts')});
      const { LOOK_SCRIPT } = await import(${load('src/vision/look.ts')});
      const { packagedPath, packageRoot } = await import(${load('src/utils/asset-dirs.ts')});
      const { pathToFileURL } = await import('node:url');
      const { existsSync } = await import('node:fs');
      // How src/native/index.ts would find workers/c4d from its own place in this layout.
      const native = pathToFileURL(process.env.PROBE_NATIVE_MODULE).href;
      // R4 (H40): how src/flows/iterate.ts and iterate-blender.ts would find the readback workers from theirs
      // (src/native/openscad.ts and freecad.ts sit beside src/native/index.ts, so native stands for them).
      const flows = pathToFileURL(process.env.PROBE_FLOWS_MODULE).href;
      const dest = process.env.PROBE_DEST;
      const copied = dest ? copyStarter('web-starter', dest) : null;
      const found = (rel, from) => packagedPath(rel, from, { kind: 'file' }) ?? null;
      console.log(JSON.stringify({ starters: startersDir() ?? null, list: listStarters().map((s) => s.name).sort(), look: LOOK_SCRIPT, lookExists: existsSync(LOOK_SCRIPT),
        c4d: found('workers/c4d/timmy_c4d.py', native), root: packageRoot(native) ?? null, copied,
        scad: found('workers/scad/timmy_scad_run.mjs', native), freecad: found('workers/freecad/timmy_freecad.py', native),
        step: found('workers/readback/step_readback.py', flows), blend: found('workers/readback/blend_readback.py', flows),
        video: found('workers/readback/video_readback.py', flows) }));`;

    // The TypeScript build's layout: each module compiled on its own to dist/<its path>.js, as tsc emits it.
    const graph = buildSync({ entryPoints: ['src/project/starters.ts', 'src/vision/look.ts', 'src/utils/asset-dirs.ts'], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent', outdir: join(base, 'unused'), absWorkingDir: root });
    for (const input of Object.keys(graph.metafile!.inputs)) {
      const code = transformSync(readFileSync(join(root, input), 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022' }).code;
      write(join(pkg, 'dist', input.replace(/\.ts$/, '.js')), code);
    }
    const tscProbe = join(base, 'probe-tsc.mjs');
    writeFileSync(tscProbe, probeBody((m) => JSON.stringify(pathToFileURL(join(pkg, 'dist', m.replace(/\.ts$/, '.js'))).href)));
    layouts[TSC] = { probe: tscProbe, native: join(pkg, 'dist/src/native/index.js'), flows: join(pkg, 'dist/src/flows/iterate.js') };

    // The bundled CLI's layout: scripts/build-cli.mjs's options, so the modules run from chunks in dist/.
    const entry = join(base, 'bundle-probe.ts');
    writeFileSync(entry, probeBody((m) => JSON.stringify(join(root, m))));
    bundled = buildSync({ entryPoints: [entry], bundle: true, splitting: true, platform: 'node', format: 'esm', outdir: join(pkg, 'dist'), entryNames: 'bundle-probe', metafile: true, logLevel: 'silent', absWorkingDir: root,
      banner: { js: "import { createRequire as __timmyCR } from 'node:module'; const require = __timmyCR(import.meta.url);" } }).metafile!;
    layouts[BUNDLE] = { probe: join(pkg, 'dist/bundle-probe.js'), native: join(pkg, 'dist/chunk-NATIVE.js'), flows: join(pkg, 'dist/chunk-FLOWS.js') };
  }, 180_000);

  const run = (layout: string, dest?: string): Probe => {
    const { probe, native, flows } = layouts[layout];
    return JSON.parse(execFileSync(process.execPath, [probe], { cwd: base, encoding: 'utf8', timeout: 30_000, env: { ...env(), PROBE_NATIVE_MODULE: native, PROBE_FLOWS_MODULE: flows, PROBE_DEST: dest ?? '' } })) as Probe;
  };
  const sortedCopy = (c: Probe['copied']): Probe['copied'] => (c && 'files' in c ? { files: [...c.files].sort() } : c);

  it('the bundle runs the lookups from chunks directly under dist/', () => {
    const chunks = Object.entries(bundled.outputs).filter(([, o]) => Object.keys(o.inputs).some((i) => i === 'src/project/starters.ts' || i === 'src/vision/look.ts'));
    expect(chunks.length).toBeGreaterThan(0);
    for (const [out] of chunks) expect(dirname(join(root, out))).toBe(join(pkg, 'dist'));
  });

  for (const layout of [TSC, BUNDLE]) {
    it(`from ${layout}, in the package and nowhere else`, () => {
      const dest = join(temp('timmy-asset-project-'), 'site');
      const r = run(layout, dest);
      expect(r.root).toBe(pkg);
      expect(r.starters).toBe(join(pkg, 'templates'));
      expect(r.list).toEqual(['ae-starter', 'blender-starter', 'c4d-starter', 'freecad-starter', 'scad-starter', 'web-starter']);
      expect(r.look).toBe(join(pkg, 'workers/look/look.py'));
      expect(r.lookExists).toBe(true);
      expect(r.c4d).toBe(join(pkg, 'workers/c4d/timmy_c4d.py'));
      // R4 (H40): this round's workers, in the package
      expect([r.scad, r.freecad, r.step, r.blend, r.video]).toEqual(['workers/scad/timmy_scad_run.mjs', 'workers/freecad/timmy_freecad.py', 'workers/readback/step_readback.py', 'workers/readback/blend_readback.py', 'workers/readback/video_readback.py'].map((w) => join(pkg, w)));
      expect(sortedCopy(r.copied)).toEqual({ files: tracked('templates/web-starter').map((f) => f.slice('templates/web-starter/'.length)).sort() });
      expect(readFileSync(join(dest, 'index.html'))).toEqual(readFileSync(join(root, 'templates/web-starter/index.html')));
    });
  }

  it('says what is missing from the package instead of using a file outside it', () => {
    rmSync(join(pkg, 'workers/look/look.py'));
    rmSync(join(pkg, 'workers/c4d/timmy_c4d.py'));
    rmSync(join(pkg, 'templates/web-starter'), { recursive: true });
    // R4 (H40): one native worker and one readback worker gone; the decoys outside the package are never used
    rmSync(join(pkg, 'workers/scad/timmy_scad_run.mjs'));
    rmSync(join(pkg, 'workers/readback/blend_readback.py'));
    rmSync(join(pkg, 'workers/readback/video_readback.py'));
    for (const layout of [TSC, BUNDLE]) {
      const dest = join(temp('timmy-asset-project-'), 'site');
      const r = run(layout, dest);
      expect(r.list, layout).toEqual(['ae-starter', 'blender-starter', 'c4d-starter', 'freecad-starter', 'scad-starter']);
      expect(r.look, layout).toBe(join(pkg, 'workers/look/look.py'));
      expect(r.lookExists, layout).toBe(false);
      expect(r.c4d, layout).toBeNull();
      expect([r.scad, r.blend, r.video], layout).toEqual([null, null, null]);
      expect([r.freecad, r.step], layout).toEqual([join(pkg, 'workers/freecad/timmy_freecad.py'), join(pkg, 'workers/readback/step_readback.py')]);
      expect(r.copied, layout).toEqual({ error: 'the web-starter starter is not in this Timmy (templates/web-starter)' });
      expect(existsSync(dest) ? readdirSync(dest) : [], layout).toEqual([]);
    }
  });
});

describe('scripts/packed-install-check.mjs (R4 H46)', () => {
  it('its probe asks the installed package for every readback worker package.json "files" ships, each found by the module that runs it', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files?: string[] };
    const workers = (manifest.files ?? []).filter((f) => /^workers\/readback\/[^/]+\.py$/.test(f));
    expect(workers).toEqual(expect.arrayContaining(['workers/readback/step_readback.py', 'workers/readback/blend_readback.py', 'workers/readback/video_readback.py']));
    const script = readFileSync(join(root, 'scripts', 'packed-install-check.mjs'), 'utf8');
    // Each is a check of its own: the path the installed module found must be that file, inside the package, and present.
    for (const w of workers) expect(script, w).toMatch(new RegExp(`check\\('assets', '[^']+', p\\.\\w+ === join\\(pkg, '${w.replace(/[.]/g, '\\.')}'\\) && p\\.\\w+Exists`));
    // The video worker is found by src/flows/iterate-ae.ts, the module /iterate ae runs it from.
    expect(script).toContain("const { VIDEO_READBACK_SCRIPT } = await load('dist/src/flows/iterate-ae.js');");
  });
});
