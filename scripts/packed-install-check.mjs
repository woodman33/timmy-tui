#!/usr/bin/env node
// The packed-install check (round R4). Does the package npm would publish install on its own and run? This is NOT a
// publication: nothing is published, tagged, deployed or installed globally. Everything happens in one new temporary
// folder, removed at the end (--keep keeps it): the tarball, npm's cache, the install prefix, HOME and TIMMY_HOME.
//
//   node scripts/packed-install-check.mjs [--keep] [--ignore-scripts]
//
// 1. npm pack, which runs prepack (the build, writing dist/ here as a publish would), into <tmp>/pack: the tarball's
//    name, sha256, size and file count.
// 2. npm install --prefix <tmp>/prefix <tarball>: its dependencies come from the npm registry into that prefix
//    (--ignore-scripts passes on to this install; by default it runs as a person's install would).
// 3. The installed bin, <prefix>/node_modules/.bin/timmy, from <tmp>/work with HOME and TIMMY_HOME in <tmp>/home and
//    an environment of PATH, HOME, TIMMY_HOME, TMPDIR, LANG, TERM=dumb and NO_COLOR only (no model key, no proxy):
//    timmy --version, timmy --help, timmy tools, timmy tools --json. Each is offline.
// 4. A probe that imports the installed package's own modules (dist/src/..., not the checkout) and asks where the
//    starters (templates/), the Look worker (workers/look/look.py), the Cinema 4D and Blender workers (workers/c4d,
//    workers/blender) and Timmy Canvas (companion/studio-canvas) are: each must be inside the installed package.
//    It also copies the web starter into a new project and compares the copy with the packaged file.
//    Round R4 (H40): the same for this round's assets in package.json "files", each found by the module that uses it:
//    the After Effects, OpenSCAD and FreeCAD starters (templates/ae-starter, scad-starter, freecad-starter: each copied
//    into a new project, its files compared with what "files" lists for it), the OpenSCAD runner
//    (workers/scad/timmy_scad_run.mjs, src/native/openscad.ts), the FreeCAD worker (workers/freecad/timmy_freecad.py,
//    src/native/freecad.ts) and the STEP and .blend readback workers (workers/readback/step_readback.py and
//    blend_readback.py, src/flows/iterate.ts and src/flows/iterate-blender.ts). R4 (H46): and the video readback worker
//    /iterate ae runs (workers/readback/video_readback.py, src/flows/iterate-ae.ts).
//
// It prints a short report: each step with its exit code and first output line. Exit 0 when every check passed,
// 1 when any failed or did not run, 2 on a usage error.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--keep' && a !== '--ignore-scripts');
if (unknown.length || args.includes('--help')) {
  process.stderr.write('Usage: node scripts/packed-install-check.mjs [--keep] [--ignore-scripts]\n');
  process.exit(args.includes('--help') ? 0 : 2);
}
const repo = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-packed-')));
const dir = (name) => { const d = join(base, name); mkdirSync(d, { recursive: true }); return d; };
const [packDir, prefix, home, work, scratch] = ['pack', 'prefix', 'home', 'work', 'tmp'].map(dir);
const short = (p) => (p.startsWith(base) ? `<tmp>/${relative(base, p)}` : p);
const firstLine = (s) => (String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, 110);

// npm, with its cache in the temporary folder and nothing inherited that changes how node loads modules.
const npmEnv = { ...process.env, npm_config_cache: join(base, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
delete npmEnv.NODE_OPTIONS; delete npmEnv.NODE_PATH;
// The installed Timmy's environment: a home of its own, no keys, no proxy, plain output.
const runEnv = { PATH: process.env.PATH ?? '', HOME: home, TIMMY_HOME: join(home, '.timmy'), TMPDIR: scratch, LANG: process.env.LANG ?? 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1' };

const report = [];
const checks = [];
const row = (step, what, code, line) => report.push(`${step.padEnd(8)} ${what.padEnd(24)} ${String(code).padEnd(7)} ${line}`);
const check = (step, what, ok, line) => { checks.push({ step, what, ok }); row(step, what, ok ? 'ok' : 'FAILED', line); return ok; };
const run = (cmd, argv, opts) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });

const npmVersion = firstLine(run('npm', ['--version'], { env: npmEnv }).stdout);
report.push('packed-install check: not a publication (nothing published, tagged or installed globally)');
report.push(`package  ${manifest.name}@${manifest.version} · node ${process.version} · npm ${npmVersion} · engines.node ${manifest.engines?.node ?? 'any'}`);

// 1. npm pack (prepack builds first).
let tarball = null;
const started = Date.now();
const pack = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: repo, env: npmEnv, timeout: 30 * 60_000 });
let packed = null;
try {
  // Script output can come before the JSON: it is the last top-level array.
  const at = pack.stdout.lastIndexOf('\n[');
  packed = JSON.parse(pack.stdout.slice(at < 0 ? 0 : at + 1))[0];
} catch { /* reported below */ }
if (pack.status === 0 && packed?.filename && existsSync(join(packDir, packed.filename))) {
  tarball = join(packDir, packed.filename);
  const bytes = readFileSync(tarball);
  const sha = createHash('sha256').update(bytes).digest('hex');
  check('pack', 'npm pack', true, `exit ${pack.status} in ${Math.round((Date.now() - started) / 1000)} s`);
  report.push(`tarball  ${packed.filename} · sha256 ${sha} · ${statSync(tarball).size} bytes · ${packed.entryCount ?? packed.files?.length} files`);
} else {
  check('pack', 'npm pack', false, `exit ${pack.status ?? pack.error?.message} · ${firstLine(pack.stderr.split('\n').filter((l) => /err/i.test(l)).join('\n') || pack.stderr)}`);
}

// 2. npm install of that tarball into a fresh prefix.
let pkg = null;
if (tarball) {
  const t = Date.now();
  const install = run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', ...(args.includes('--ignore-scripts') ? ['--ignore-scripts'] : []), tarball], { cwd: work, env: npmEnv, timeout: 30 * 60_000 });
  const ok = install.status === 0 && existsSync(join(prefix, 'node_modules', manifest.name, 'package.json'));
  check('install', `npm install --prefix`, ok, `exit ${install.status ?? install.error?.message} in ${Math.round((Date.now() - t) / 1000)} s · ${firstLine(install.stdout.split('\n').find((l) => /added|up to date/.test(l)) ?? install.stderr)}`);
  // npm installs a package whose engines field this node does not meet, with a warning block per package: one line each.
  const engine = (install.stderr ?? '').split('\n').filter((l) => /EBADENGINE/.test(l)).join('\n');
  const wants = [...engine.matchAll(/package: '([^']+)',\s*npm warn EBADENGINE\s+required: \{ ([^}]*) \}/g)].map((m) => `${m[1]} wants ${m[2].replace(/'/g, '')}`);
  if (engine) report.push(`install  warning EBADENGINE      ${wants.join('; ') || firstLine(engine)} (this is node ${process.version}; npm installs anyway)`);
  if (ok) pkg = realpathSync(join(prefix, 'node_modules', manifest.name));
} else {
  check('install', 'npm install --prefix', false, 'not run: no tarball');
}

// 3. The installed bin.
const bin = join(prefix, 'node_modules', '.bin', 'timmy');
const timmy = (argv) => run(bin, argv, { cwd: work, env: runEnv, timeout: 120_000 });
let toolsJson = null;
for (const argv of [['--version'], ['--help'], ['tools'], ['tools', '--json']]) {
  const what = `timmy ${argv.join(' ')}`;
  if (!pkg || !existsSync(bin)) { check('run', what, false, 'not run: no installed bin'); continue; }
  const r = timmy(argv);
  const out = r.stdout?.trim() ? r.stdout : r.stderr;
  let ok = r.status === 0;
  if (argv[0] === '--version') ok &&= firstLine(r.stdout) === `${manifest.name} v${manifest.version}`;
  if (argv[1] === '--json') { try { toolsJson = JSON.parse(r.stdout); ok &&= Array.isArray(toolsJson.rows) && toolsJson.rows.length > 0; } catch { ok = false; } }
  check('run', what, ok, `exit ${r.status ?? r.error?.message} · ${argv[1] === '--json' && toolsJson ? `${toolsJson.rows.length} rows, checked at ${toolsJson.checkedAt}` : firstLine(out)}`);
}
if (toolsJson) {
  const canvas = toolsJson.rows.find((x) => x.id === 'canvas');
  if (canvas) report.push(`run      tools: canvas row        ${canvas.rung} · ${canvas.detail}`);
}

// 4. The installed package's own lookups.
if (pkg) {
  const probe = join(scratch, 'probe.mjs');
  writeFileSync(probe, `
    import { existsSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.env.PROBE_PKG;
    const load = (rel) => import(pathToFileURL(join(root, rel)).href);
    const { packageRoot } = await load('dist/src/utils/asset-dirs.js');
    const { startersDir, listStarters, copyStarter } = await load('dist/src/project/starters.js');
    const { LOOK_SCRIPT } = await load('dist/src/vision/look.js');
    const { c4dHelperDir, blenderHelperDir } = await load('dist/src/native/index.js');
    const { studioRoot } = await load('dist/src/studio/server.js');
    // R4: the OpenSCAD runner, the FreeCAD worker and the three readback workers, each found by the module that runs it.
    const { scadRunnerPath } = await load('dist/src/native/openscad.js');
    const { freecadHelperDir } = await load('dist/src/native/freecad.js');
    const { READBACK_SCRIPT } = await load('dist/src/flows/iterate.js');
    const { BLEND_READBACK_SCRIPT } = await load('dist/src/flows/iterate-blender.js');
    const { VIDEO_READBACK_SCRIPT } = await load('dist/src/flows/iterate-ae.js');
    // R4 batch 6: the OpenHands worker /agent openhands mounts into its container (H52).
    const { openHandsWorker } = await load('dist/src/code-agents/openhands-run.js');
    // R4 batch 7 (H58): the pty wrapper /run runs upmd through.
    const { PTY_RUN_SCRIPT } = await load('dist/src/workflows/upmd-live.js');
    const dest = join(process.env.PROBE_WORK, 'site');
    const copied = copyStarter('web-starter', dest);
    // R4: each starter of this round copied into a new project of its own; the files the copy holds.
    const r4 = {};
    for (const name of ['ae-starter', 'scad-starter', 'freecad-starter', 'tray-workflow']) {
      const c = copyStarter(name, join(process.env.PROBE_WORK, name));
      r4[name] = 'files' in c ? c.files.sort() : c.error;
    }
    console.log(JSON.stringify({
      root: packageRoot(pathToFileURL(join(root, 'dist/src/native/index.js')).href) ?? null,
      starters: startersDir() ?? null, list: listStarters().map((s) => s.name).sort(),
      look: LOOK_SCRIPT, lookExists: existsSync(LOOK_SCRIPT), c4d: c4dHelperDir() ?? null, blender: blenderHelperDir() ?? null,
      canvas: existsSync(join(studioRoot(), 'dist', 'canvas.js')) ? studioRoot() : null,
      copied: 'files' in copied ? copied.files.length : copied.error,
      same: existsSync(join(dest, 'index.html')) && readFileSync(join(dest, 'index.html')).equals(readFileSync(join(root, 'templates/web-starter/index.html'))),
      r4, scad: scadRunnerPath() ?? null, freecad: freecadHelperDir() ?? null,
      step: READBACK_SCRIPT, stepExists: existsSync(READBACK_SCRIPT), blend: BLEND_READBACK_SCRIPT, blendExists: existsSync(BLEND_READBACK_SCRIPT),
      video: VIDEO_READBACK_SCRIPT, videoExists: existsSync(VIDEO_READBACK_SCRIPT),
      openhands: openHandsWorker() ?? null,
      pty: PTY_RUN_SCRIPT, ptyExists: existsSync(PTY_RUN_SCRIPT),
    }));`);
  const r = run(process.execPath, [probe], { cwd: work, env: { ...runEnv, PROBE_PKG: pkg, PROBE_WORK: work }, timeout: 120_000 });
  let p = null;
  try { p = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { /* reported below */ }
  if (!p) {
    check('assets', 'probe', false, `exit ${r.status ?? r.error?.message} · ${firstLine(r.stderr)}`);
  } else {
    const inside = (path) => typeof path === 'string' && (path === pkg || path.startsWith(`${pkg}/`));
    check('assets', 'package root', p.root === pkg, short(p.root ?? 'none found'));
    const starters = ['ae-starter', 'blender-starter', 'c4d-starter', 'freecad-starter', 'scad-starter', 'tray-workflow', 'web-starter'];
    check('assets', 'starters (templates/)', p.starters === join(pkg, 'templates') && starters.every((n) => p.list.includes(n)), `${short(p.starters ?? 'none found')}: ${p.list.join(', ') || 'none'}`);
    check('assets', 'Look worker', p.look === join(pkg, 'workers/look/look.py') && p.lookExists, short(p.look));
    check('assets', 'Cinema 4D worker', p.c4d === join(pkg, 'workers/c4d'), short(p.c4d ?? 'none found'));
    check('assets', 'Blender worker', p.blender === join(pkg, 'workers/blender'), short(p.blender ?? 'none found'));
    check('assets', 'Timmy Canvas (built)', inside(p.canvas), short(p.canvas ?? 'none found'));
    check('assets', 'web-starter copied', typeof p.copied === 'number' && p.copied > 0 && p.same, typeof p.copied === 'number' ? `${p.copied} files into a new project; index.html is the packaged one` : String(p.copied));
    // R4 (H40): this round's starters, each copied as /project new --from copies it: the files "files" lists for it.
    for (const name of ['ae-starter', 'scad-starter', 'freecad-starter', 'tray-workflow']) {
      const want = (manifest.files ?? []).filter((f) => f.startsWith(`templates/${name}/`)).map((f) => f.slice(`templates/${name}/`.length)).sort();
      const got = p.r4?.[name];
      check('assets', `${name} copied`, Array.isArray(got) && want.length > 0 && got.join('\n') === want.join('\n'), Array.isArray(got) ? `${got.length} files into a new project (${got.join(', ')}); "files" lists ${want.length}` : String(got ?? 'not copied'));
    }
    // R4 (H40): this round's workers, each found by the module that runs it.
    check('assets', 'OpenSCAD runner', p.scad === join(pkg, 'workers/scad/timmy_scad_run.mjs'), short(p.scad ?? 'none found'));
    check('assets', 'FreeCAD worker', p.freecad === join(pkg, 'workers/freecad'), short(p.freecad ?? 'none found'));
    check('assets', 'STEP readback worker', p.step === join(pkg, 'workers/readback/step_readback.py') && p.stepExists, `${short(p.step)}${p.stepExists ? '' : ' (not there)'}`);
    check('assets', '.blend readback worker', p.blend === join(pkg, 'workers/readback/blend_readback.py') && p.blendExists, `${short(p.blend)}${p.blendExists ? '' : ' (not there)'}`);
    // R4 (H46): the video readback worker /iterate ae runs (in package.json "files", needed by its readback step).
    check('assets', 'video readback worker', p.video === join(pkg, 'workers/readback/video_readback.py') && p.videoExists, `${short(p.video)}${p.videoExists ? '' : ' (not there)'}`);
    // R4 batch 6 (H52): the OpenHands worker, found by the module that mounts it.
    check('assets', 'OpenHands worker', p.openhands === join(pkg, 'workers/openhands/timmy_openhands.py'), short(p.openhands ?? 'none found'));
    // R4 batch 7 (H58): the pty wrapper for live workflow states, found by the module that runs it.
    check('assets', 'upmd pty wrapper', p.pty === join(pkg, 'workers/upmd/pty_run.py') && p.ptyExists, `${short(p.pty)}${p.ptyExists ? '' : ' (not there)'}`);
  }
} else {
  check('assets', 'probe', false, 'not run: nothing installed');
}

const failed = checks.filter((c) => !c.ok);
report.push(`result   ${failed.length ? `FAILED: ${failed.length} of ${checks.length} checks (${failed.map((c) => c.what).join('; ')})` : `PASS: all ${checks.length} checks`}`);
if (args.includes('--keep')) report.push(`kept     ${base}`);
else { rmSync(base, { recursive: true, force: true }); report.push('cleanup  the temporary folder (tarball, cache, prefix, home) is removed'); }
process.stdout.write(`${report.join('\n')}\n`);
process.exit(failed.length ? 1 : 0);
