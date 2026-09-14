#!/usr/bin/env node
// Defold · sprite-atlas (engine-shelf/v0). The lane runs one phase per step:
//   node run.mjs <drop.defold.zip> <out> <stem> unpack  → out/project/ + <stem>.project.json
//   node run.mjs <drop.defold.zip> <out> <stem> atlas   → bob build focused on every *.atlas
//                                                       → <stem>.<path>.texturec / .texturesetc copied into out/ + <stem>.atlas.json
// With no phase it runs both. Exit codes: 0 ok · 1 bob failed · 3 no atlas in the project.
//
// Focus: bob's --build-input takes a resource path to build instead of
// game.project; an atlas task also needs /builtins/graphics/default.texture_profiles,
// so both are passed. If the focused build fails the phase retries a full build
// and the report says `focused: false`.
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBobOutput, compiledResources, hostPlatform, pngSize, readGameProject, repoRoot, runBob, sha, toolchain, unzipProject, walk, writeJson } from './bob.mjs';

const [drop, out, stem, phaseArg] = process.argv.slice(2);
if (!drop || !out || !stem) { console.error('usage: run.mjs <drop.defold.zip> <out> <stem> [unpack|atlas]'); process.exit(2); }
const phase = phaseArg ?? 'all';
const root = repoRoot(dirname(fileURLToPath(import.meta.url)));
const project = join(out, 'project');
mkdirSync(out, { recursive: true });

const atlasFiles = () => walk(project).filter((p) => (p.endsWith('.atlas') || p.endsWith('.tilesource')) && !p.includes('/build/') && !p.includes('/.internal/')).sort();

/** The images an .atlas / .tilesource names (`image: "/main/tile.png"`), resolved against the project root. */
function atlasImages(atlasPath) {
  const text = readFileSync(atlasPath, 'utf8');
  const seen = new Set(); const images = [];
  for (const m of text.matchAll(/^\s*image:\s*"([^"]+)"/gm)) {
    const rel = m[1].replace(/^\//, '');
    if (seen.has(rel)) continue; seen.add(rel);
    const abs = join(project, rel);
    const exists = statSync(abs, { throwIfNoEntry: false });
    images.push(exists ? { path: '/' + rel, bytes: exists.size, sha256: sha(abs), ...(pngSize(abs) ?? {}) } : { path: '/' + rel, missing: true });
  }
  return images;
}

function unpack() {
  const t0 = Date.now();
  const u = unzipProject(drop, project);
  const gp = readGameProject(project);
  const atlases = atlasFiles().map((p) => p.slice(project.length));
  const report = { workflow: 'sprite-atlas', phase: 'unpack', input: drop, input_sha256: sha(drop), input_bytes: statSync(drop).size, title: gp.title, project_dir: project, unwrapped_top_folder: u.unwrapped, source_files: u.files.length, source_bytes: u.bytes, atlases, atlas_count: atlases.length, native_extensions: gp.native_extensions, ms: Date.now() - t0 };
  writeJson(join(out, `${stem}.project.json`), report);
  console.log(JSON.stringify({ phase: 'unpack', title: gp.title, source_files: u.files.length, atlases }));
}

function atlas() {
  const t0 = Date.now();
  const tc = toolchain(root);
  const gp = readGameProject(project);
  const files = atlasFiles();
  const atlases = files.map((p) => ({ path: p.slice(project.length), images: atlasImages(p), text_sha256: sha(p) }));
  if (!atlases.length) {
    writeJson(join(out, `${stem}.atlas.json`), { workflow: 'sprite-atlas', phase: 'atlas', ok: false, error: 'no .atlas or .tilesource in the project', atlas_count: 0, compiled_count: 0 });
    console.error('sprite-atlas: the project has no .atlas or .tilesource'); process.exit(3);
  }
  const platform = hostPlatform();
  const focusedArgs = ['--platform', platform, '--build-input', '/builtins/graphics/default.texture_profiles'];
  for (const a of atlases) focusedArgs.push('--build-input', a.path);
  let r = runBob(tc, project, [...focusedArgs, 'build'], { timeout_ms: 300000 });
  let focused = true; let fallback = 'none';
  if (r.status !== 0) {
    const reason = classifyBobOutput(`${r.stdout}\n${r.stderr}`).errors[0] ?? `bob exited ${r.status}`;
    focused = false; fallback = { from: 'focused --build-input build', to: 'full build', reason };
    console.error(`sprite-atlas: focused build failed (${reason}); retrying a full build`);
    r = runBob(tc, project, ['--platform', platform, 'build'], { timeout_ms: 300000 });
  }
  const diag = classifyBobOutput(`${r.stdout}\n${r.stderr}`);
  const buildDir = join(project, 'build', 'default');
  const compiled = compiledResources(project).filter((f) => /\.(texturec|texturesetc)$/.test(f.path)).map((f) => {
    const outName = `${stem}.${f.path.replace(/\//g, '_')}`;
    copyFileSync(join(buildDir, f.path), join(out, outName));
    return { build_path: 'build/default/' + f.path, out_file: outName, bytes: f.bytes, sha256: sha(join(out, outName)) };
  });
  for (const a of atlases) { const base = a.path.replace(/\.(atlas|tilesource)$/, '').replace(/^\//, ''); a.compiled = compiled.filter((c) => c.build_path.startsWith('build/default/' + base + '.')); }
  const sourceImages = atlases.flatMap((a) => a.images);
  const report = {
    workflow: 'sprite-atlas', phase: 'atlas', ok: r.status === 0 && compiled.length > 0, bob_exit: r.status, title: gp.title, platform, focused, fallback, texture_profile: 'builtins/graphics/default.texture_profiles (bob default; --texture-compression not passed)',
    atlases, atlas_count: atlases.length, atlas_paths: atlases.map((a) => a.path).join(','), source_images: sourceImages.length, source_image_bytes: sourceImages.reduce((a, i) => a + (i.bytes ?? 0), 0), png_sha256: sourceImages.map((i) => i.sha256 ?? 'missing').join(','),
    compiled, compiled_count: compiled.length, compiled_bytes: compiled.reduce((a, c) => a + c.bytes, 0),
    warnings: diag.warnings.length, errors: diag.errors.length, error_lines: diag.errors.slice(0, 40),
    engine_sha: tc.engine_sha, bob_version: tc.bob_version, bob_sha256: tc.bob_sha256, java: tc.java, java_bin: tc.java_bin, java_source: tc.java_source, bob_argv: r.argv, bob_ms: r.ms, ms: Date.now() - t0
  };
  writeJson(join(out, `${stem}.atlas.json`), report);
  console.log(JSON.stringify({ phase: 'atlas', ok: report.ok, focused, atlases: atlases.length, source_images: sourceImages.length, compiled: compiled.map((c) => c.out_file), compiled_bytes: report.compiled_bytes, ms: report.ms }));
  if (!report.ok) process.exit(1);
}

const phases = { unpack, atlas };
if (phase === 'all') { unpack(); atlas(); }
else if (phases[phase]) phases[phase]();
else { console.error(`unknown phase ${phase}`); process.exit(2); }
