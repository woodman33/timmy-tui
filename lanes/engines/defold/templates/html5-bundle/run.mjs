#!/usr/bin/env node
// Defold · html5-bundle (engine-shelf/v0). The lane runs one phase per step:
//   node run.mjs <drop.defold.zip> <out> <stem> unpack    → out/project/ + <stem>.project.json
//   node run.mjs <drop.defold.zip> <out> <stem> resolve   → bob resolve → <stem>.resolve.json
//   node run.mjs <drop.defold.zip> <out> <stem> bundle    → bob build bundle --platform wasm-web --archive
//                                                          → <stem>.bundle/ + <stem>.html5.zip + <stem>.bundle.json
// With no phase it runs all three. Exit codes: 0 ok · 1 bob failed · 2 usage.
//
// Platform: Defold 1.13 names HTML5 `wasm-web` (js-web/asm.js is gone). bob.jar
// carries the prebuilt wasm-web engine, so a project with no native extensions
// bundles locally — no build server, no download. If the wasm-web bundle fails
// the phase retries on the host platform (arm64-macos here) and SAYS SO in the
// report (`fallback`) — the receipt then carries platform=<host>, not wasm-web.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBobOutput, hostPlatform, platformSuffix, readGameProject, repoRoot, runBob, sha, toolchain, unzipProject, walk, writeJson } from './bob.mjs';

const [drop, out, stem, phaseArg] = process.argv.slice(2);
if (!drop || !out || !stem) { console.error('usage: run.mjs <drop.defold.zip> <out> <stem> [unpack|resolve|bundle]'); process.exit(2); }
const phase = phaseArg ?? 'all';
const root = repoRoot(dirname(fileURLToPath(import.meta.url)));
const project = join(out, 'project');
const REQUESTED = { platform: 'wasm-web', architectures: 'wasm-web', variant: 'release' };
mkdirSync(out, { recursive: true });

function unpack() {
  const t0 = Date.now();
  const u = unzipProject(drop, project);
  const gp = readGameProject(project);
  const report = { workflow: 'html5-bundle', phase: 'unpack', input: drop, input_sha256: sha(drop), input_bytes: statSync(drop).size, title: gp.title, project_dir: project, unwrapped_top_folder: u.unwrapped, source_files: u.files.length, source_bytes: u.bytes, declared_dependencies: gp.dependencies, native_extensions: gp.native_extensions, ms: Date.now() - t0 };
  writeJson(join(out, `${stem}.project.json`), report);
  console.log(JSON.stringify({ phase: 'unpack', title: gp.title, source_files: u.files.length, native_extensions: gp.native_extensions.length }));
}

function resolve() {
  const tc = toolchain(root);
  const gp = readGameProject(project);
  const r = runBob(tc, project, ['resolve'], { timeout_ms: 300000 });
  const libDir = join(project, '.internal', 'lib');
  const resolved = walk(libDir).map((p) => ({ path: p.slice(libDir.length + 1), bytes: statSync(p).size, sha256: sha(p) }));
  const diag = classifyBobOutput(`${r.stdout}\n${r.stderr}`);
  const report = { workflow: 'html5-bundle', phase: 'resolve', ok: r.status === 0, bob_exit: r.status, declared_dependencies: gp.dependencies, dependency_count: gp.dependencies.length, resolved_libraries: resolved, resolved_count: resolved.length, warnings: diag.warnings.length, errors: diag.errors.length, error_lines: diag.errors.slice(0, 40), bob_argv: r.argv, bob_ms: r.ms, engine_sha: tc.engine_sha, bob_version: tc.bob_version, bob_sha256: tc.bob_sha256, java: tc.java, java_bin: tc.java_bin, java_source: tc.java_source };
  writeJson(join(out, `${stem}.resolve.json`), report);
  console.log(JSON.stringify({ phase: 'resolve', ok: report.ok, dependencies: gp.dependencies.length, resolved: resolved.length, ms: r.ms }));
  if (r.status !== 0) process.exit(1);
}

function bundleOnce(tc, platform, architectures, bundleTmp) {
  rmSync(bundleTmp, { recursive: true, force: true });
  const args = ['--platform', platform, '--archive', '--variant', REQUESTED.variant, '--bundle-output', bundleTmp];
  if (architectures) args.push('--architectures', architectures);
  return runBob(tc, project, [...args, 'build', 'bundle'], { timeout_ms: 300000 });
}

function bundle() {
  const t0 = Date.now();
  const tc = toolchain(root);
  const gp = readGameProject(project);
  const bundleTmp = join(out, '.bundle-tmp');
  const attempts = [];
  let platform = REQUESTED.platform; let architectures = REQUESTED.architectures; let r = null; let fallback = 'none';
  if (process.env.SHELF_DEFOLD_FORCE_FALLBACK) {
    attempts.push({ platform, architectures, skipped: 'SHELF_DEFOLD_FORCE_FALLBACK set' });
  } else {
    r = bundleOnce(tc, platform, architectures, bundleTmp);
    attempts.push({ platform, architectures, exit: r.status, ms: r.ms, errors: classifyBobOutput(`${r.stdout}\n${r.stderr}`).errors.slice(0, 12) });
  }
  if (!r || r.status !== 0) {
    const reason = r ? (attempts[0].errors[0] ?? `bob exited ${r.status}${r.timed_out ? ' (timed out)' : ''}`) : attempts[0].skipped;
    platform = process.env.SHELF_DEFOLD_FALLBACK_PLATFORM ?? hostPlatform(); architectures = null;
    fallback = { from: REQUESTED.platform, to: platform, reason };
    console.error(`html5-bundle: wasm-web bundle did not succeed (${reason}); falling back to --platform ${platform}`);
    r = bundleOnce(tc, platform, architectures, bundleTmp);
    attempts.push({ platform, architectures, exit: r.status, ms: r.ms, errors: classifyBobOutput(`${r.stdout}\n${r.stderr}`).errors.slice(0, 12) });
  }
  const diag = classifyBobOutput(`${r.stdout}\n${r.stderr}`);
  const suffix = platformSuffix(platform);
  const bundleDir = join(out, `${stem}.bundle`);
  const zipName = `${stem}.${suffix}.zip`;
  let produced = null; let buildInput = null;
  if (r.status === 0 && existsSync(bundleTmp)) {
    produced = readdirSync(bundleTmp).map((n) => join(bundleTmp, n)).find((p) => statSync(p).isDirectory()) ?? null;
    const bi = join(bundleTmp, 'build_input_data.json');
    if (existsSync(bi)) { try { buildInput = JSON.parse(readFileSyncText(bi)); } catch { buildInput = null; } }
    if (produced) { rmSync(bundleDir, { recursive: true, force: true }); renameSync(produced, bundleDir); }
    rmSync(bundleTmp, { recursive: true, force: true });
  }
  const files = produced ? walk(bundleDir).map((p) => ({ path: p.slice(bundleDir.length + 1), bytes: statSync(p).size, sha256: sha(p) })) : [];
  let zip = null;
  if (produced) {
    rmSync(join(out, zipName), { force: true });
    const z = spawnSync('/usr/bin/zip', ['-r', '-X', '-q', zipName, `${stem}.bundle`], { cwd: out, encoding: 'utf8' });
    if (z.status !== 0) console.error(`zip failed: ${z.stderr}`); else zip = { file: zipName, bytes: statSync(join(out, zipName)).size, sha256: sha(join(out, zipName)) };
  }
  const report = {
    workflow: 'html5-bundle', phase: 'bundle', ok: r.status === 0 && !!produced && !!zip, bob_exit: r.status, title: gp.title,
    requested_platform: REQUESTED.platform, platform, architectures: architectures ?? '(bob default for platform)', variant: REQUESTED.variant, fallback, attempts,
    build_server: gp.native_extensions.length ? 'https://build.defold.com (bob default; the project declares native extensions, so bob needs the network)' : 'not needed: no native extensions, engine comes prebuilt inside bob.jar',
    native_extensions: gp.native_extensions, declared_dependencies: gp.dependencies,
    bundle_dir: produced ? `${stem}.bundle` : null, bundle_source_name: produced ? produced.slice(bundleTmp.length + 1) : null, bundle_files: files.length, bundle_bytes: files.reduce((a, f) => a + f.bytes, 0), bundle_zip: zip,
    engine_files: files.filter((f) => /\.wasm$|_wasm\.js$|dmloader\.js$|_pthread|\/MacOS\/|\.exe$/.test(f.path)), file_list: files,
    warnings: diag.warnings.length, errors: diag.errors.length, error_lines: diag.errors.slice(0, 40),
    engine_sha: tc.engine_sha, bob_version: tc.bob_version, bob_sha256: tc.bob_sha256, bob_build_input: buildInput, java: tc.java, java_bin: tc.java_bin, java_source: tc.java_source, bob_argv: r.argv, bob_ms: r.ms, ms: Date.now() - t0
  };
  writeJson(join(out, `${stem}.bundle.json`), report);
  console.log(JSON.stringify({ phase: 'bundle', ok: report.ok, platform, fallback, bundle_files: files.length, bundle_bytes: report.bundle_bytes, zip: zip?.file ?? null, ms: report.ms }));
  if (!report.ok) process.exit(1);
}

function readFileSyncText(p) { return process.getBuiltinModule('node:fs').readFileSync(p, 'utf8'); }

const phases = { unpack, resolve, bundle };
if (phase === 'all') { unpack(); resolve(); bundle(); }
else if (phases[phase]) phases[phase]();
else { console.error(`unknown phase ${phase}`); process.exit(2); }
