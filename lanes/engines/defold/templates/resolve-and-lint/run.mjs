#!/usr/bin/env node
// Defold · resolve-and-lint (engine-shelf/v0). The lane runs one phase per step:
//   node run.mjs <drop.defold.zip> <out> <stem> unpack   → out/project/ + <stem>.project.json
//   node run.mjs <drop.defold.zip> <out> <stem> resolve  → bob resolve → <stem>.resolve.json
//   node run.mjs <drop.defold.zip> <out> <stem> lint     → bob --verbose build (host platform, no bundle) → <stem>.lint.json
// With no phase it runs all three. A non-zero bob exit writes the report and exits 1,
// so the lane marks the step failed but the diagnostics stay in out/.
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBobOutput, compiledResources, hostPlatform, readGameProject, repoRoot, runBob, sha, toolchain, unzipProject, walk, writeJson } from './bob.mjs';

const [drop, out, stem, phaseArg] = process.argv.slice(2);
if (!drop || !out || !stem) { console.error('usage: run.mjs <drop.defold.zip> <out> <stem> [unpack|resolve|lint]'); process.exit(2); }
const phase = phaseArg ?? 'all';
const root = repoRoot(dirname(fileURLToPath(import.meta.url)));
const project = join(out, 'project');
mkdirSync(out, { recursive: true });

function unpack() {
  const t0 = Date.now();
  const u = unzipProject(drop, project);
  const gp = readGameProject(project);
  const byExt = {};
  for (const f of u.files) { const ext = f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.')) : '(none)'; byExt[ext] = (byExt[ext] ?? 0) + 1; }
  const report = { workflow: 'resolve-and-lint', phase: 'unpack', input: drop, input_sha256: sha(drop), input_bytes: statSync(drop).size, title: gp.title, project_dir: project, unwrapped_top_folder: u.unwrapped, source_files: u.files.length, source_bytes: u.bytes, source_by_extension: byExt, declared_dependencies: gp.dependencies, native_extensions: gp.native_extensions, game_project: gp.cfg, ms: Date.now() - t0 };
  writeJson(join(out, `${stem}.project.json`), report);
  console.log(JSON.stringify({ phase: 'unpack', title: gp.title, source_files: u.files.length, dependencies: gp.dependencies.length, native_extensions: gp.native_extensions.length }));
}

function resolve() {
  const tc = toolchain(root);
  const gp = readGameProject(project);
  const r = runBob(tc, project, ['resolve'], { timeout_ms: 300000 });
  const libDir = join(project, '.internal', 'lib');
  const resolved = walk(libDir).map((p) => ({ path: p.slice(libDir.length + 1), bytes: statSync(p).size, sha256: sha(p) }));
  const diag = classifyBobOutput(`${r.stdout}\n${r.stderr}`);
  const report = { workflow: 'resolve-and-lint', phase: 'resolve', ok: r.status === 0, bob_exit: r.status, declared_dependencies: gp.dependencies, dependency_count: gp.dependencies.length, resolved_libraries: resolved, resolved_count: resolved.length, resolve_warnings: diag.warnings.length, resolve_errors: diag.errors.length, error_lines: diag.errors.slice(0, 40), bob_argv: r.argv, bob_ms: r.ms, engine_sha: tc.engine_sha, bob_version: tc.bob_version, bob_sha256: tc.bob_sha256, java: tc.java, java_bin: tc.java_bin, java_source: tc.java_source };
  writeJson(join(out, `${stem}.resolve.json`), report);
  console.log(JSON.stringify({ phase: 'resolve', ok: report.ok, dependencies: gp.dependencies.length, resolved: resolved.length, ms: r.ms }));
  if (r.status !== 0) process.exit(1);
}

function lint() {
  const t0 = Date.now();
  const tc = toolchain(root);
  const gp = readGameProject(project);
  const platform = hostPlatform();
  const r = runBob(tc, project, ['--verbose', '--platform', platform, 'build'], { timeout_ms: 300000 });
  const diag = classifyBobOutput(`${r.stdout}\n${r.stderr}`);
  const resources = r.status === 0 || true ? compiledResources(project) : [];
  const byExt = {};
  for (const f of resources) { const ext = f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.')) : '(none)'; byExt[ext] = (byExt[ext] ?? 0) + 1; }
  const libDir = join(project, '.internal', 'lib');
  const resolved = walk(libDir).map((p) => p.slice(libDir.length + 1));
  const report = {
    workflow: 'resolve-and-lint', phase: 'lint', ok: r.status === 0, bob_exit: r.status, timed_out: r.timed_out, title: gp.title, platform, verbose: true, bundle: false,
    declared_dependencies: gp.dependencies, dependency_count: gp.dependencies.length, resolved_libraries: resolved, native_extensions: gp.native_extensions,
    warnings: diag.warnings.length, errors: diag.errors.length, warning_lines: diag.warnings.slice(0, 100), error_lines: diag.errors.slice(0, 100), jvm_noise_lines: diag.jvm_noise_lines, bob_output_lines: diag.total_lines,
    resources: resources.length, resource_bytes: resources.reduce((a, f) => a + f.bytes, 0), resources_by_extension: byExt, resource_list: resources,
    engine_sha: tc.engine_sha, bob_version: tc.bob_version, bob_sha256: tc.bob_sha256, java: tc.java, java_bin: tc.java_bin, java_source: tc.java_source, bob_argv: r.argv, bob_ms: r.ms, ms: Date.now() - t0
  };
  writeJson(join(out, `${stem}.lint.json`), report);
  console.log(JSON.stringify({ phase: 'lint', ok: report.ok, bob_exit: r.status, warnings: report.warnings, errors: report.errors, resources: resources.length, ms: report.ms }));
  if (r.status !== 0) process.exit(1);
}

const phases = { unpack, resolve, lint };
if (phase === 'all') { unpack(); resolve(); lint(); }
else if (phases[phase]) phases[phase]();
else { console.error(`unknown phase ${phase}`); process.exit(2); }
