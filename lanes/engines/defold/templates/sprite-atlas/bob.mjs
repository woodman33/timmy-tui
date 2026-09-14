// Defold engine-shelf template helper (engine-shelf/v0, shelf-w6d3 step 4).
// Identical copies live in every defold template dir so each template's
// template_sha256 covers the helper it runs with. Edit all three together.
//
// What it knows: where the repo root is (walks up to lanes/engines/engines.json),
// which java bob needs (Defold ships its own JDK; the system Java is too old),
// where the pinned bob.jar is (engines.json binaries.bob, downloaded on demand),
// how to unzip a dropped *.defold.zip into out/project, and how to run bob and
// hand back its exit + output. Nothing here runs in a shell.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

export const ENGINE_SHA = '574678c7d44be490d874fbed2d0ae6211feec4d9';
export const BOB_URL = `https://d.defold.com/archive/${ENGINE_SHA}/bob/bob.jar`;
const DEFOLD_PACKAGES = '/Applications/Defold.app/Contents/Resources/packages';

export const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
export const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
export const hostPlatform = () => (process.platform === 'darwin' ? (process.arch === 'arm64' ? 'arm64-macos' : 'x86_64-macos') : process.platform === 'win32' ? 'x86_64-win32' : process.arch === 'arm64' ? 'arm64-linux' : 'x86_64-linux');

/** Repo root: the nearest ancestor of `from` that holds lanes/engines/engines.json. */
export function repoRoot(from) {
  let d = resolve(from);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'lanes', 'engines', 'engines.json'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`no lanes/engines/engines.json above ${from}`);
}

export function defoldEntry(root) {
  const reg = JSON.parse(readFileSync(join(root, 'lanes', 'engines', 'engines.json'), 'utf8'));
  const e = reg.engines.find((x) => x.id === 'defold');
  if (!e) throw new Error('engines.json has no defold entry');
  return e;
}

/**
 * bob needs the JDK Defold ships (25 for this engine sha). Order: engines.json
 * binaries.java if that path exists → $DEFOLD_JAVA / $JAVA_BIN → a scan of
 * Defold.app's packages/jdk-* (bin/java or Contents/Home/bin/java) → java on PATH.
 * The source is reported so a wrong registry path shows up in the receipt.
 */
export function findJava(root) {
  const entry = defoldEntry(root);
  const fromRegistry = entry.binaries?.java;
  if (fromRegistry && existsSync(fromRegistry)) return { java: fromRegistry, source: 'engines.json' };
  for (const k of ['DEFOLD_JAVA', 'JAVA_BIN']) if (process.env[k] && existsSync(process.env[k])) return { java: process.env[k], source: `$${k}` };
  if (existsSync(DEFOLD_PACKAGES)) {
    for (const d of readdirSync(DEFOLD_PACKAGES).filter((n) => n.startsWith('jdk-')).sort().reverse()) {
      for (const rel of ['bin/java', 'Contents/Home/bin/java']) {
        const p = join(DEFOLD_PACKAGES, d, rel);
        if (existsSync(p)) return { java: p, source: `defold-app-scan (engines.json names ${fromRegistry ?? 'nothing'}, which is absent)` };
      }
    }
  }
  const which = spawnSync('/usr/bin/which', ['java'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return { java: which.stdout.trim(), source: 'PATH (may be too old for bob)' };
  throw new Error('no java found for bob (install Defold.app or set DEFOLD_JAVA)');
}

/** The pinned bob.jar from engines.json (relative to the repo root); fetched from d.defold.com when the cache is empty. */
export function findBob(root) {
  const entry = defoldEntry(root);
  const rel = entry.binaries?.bob ?? `lanes/defold/.cache/bob-${ENGINE_SHA.slice(0, 8)}.jar`;
  const bob = rel.startsWith('/') ? rel : join(root, rel);
  let source = 'engines.json';
  if (!existsSync(bob)) {
    mkdirSync(dirname(bob), { recursive: true });
    const r = spawnSync('curl', ['-sSL', '--fail', '-o', bob, BOB_URL], { encoding: 'utf8' });
    if (r.status !== 0) { rmSync(bob, { force: true }); throw new Error(`bob.jar missing at ${bob} and download failed: ${(r.stderr ?? '').trim()}`); }
    source = `downloaded ${BOB_URL}`;
  }
  return { bob, source, sha256: sha(bob), bytes: statSync(bob).size };
}

export function javaVersion(java) {
  const r = spawnSync(java, ['-version'], { encoding: 'utf8' });
  return `${r.stderr ?? ''}${r.stdout ?? ''}`.split('\n')[0].trim();
}

export function bobVersion(java, bob) {
  const r = spawnSync(java, ['-jar', bob, '--version'], { encoding: 'utf8' });
  return `${r.stdout ?? ''}`.split('\n').find((l) => l.includes('version')) ?? '';
}

/** Everything a report wants to say about the toolchain it ran with. */
export function toolchain(root) {
  const j = findJava(root);
  const b = findBob(root);
  return { engine_sha: ENGINE_SHA, java_bin: j.java, java_source: j.source, java: javaVersion(j.java), bob_jar: b.bob, bob_source: b.source, bob_sha256: b.sha256, bob_bytes: b.bytes, bob_version: bobVersion(j.java, b.bob), host_platform: hostPlatform() };
}

/** Run bob with `args` against `projectRoot`; echoes bob's output so the lane's step log carries it. */
export function runBob(tc, projectRoot, args, { timeout_ms = 600000, echo = true } = {}) {
  const argv = ['-jar', tc.bob_jar, '--root', projectRoot, ...args];
  const t0 = Date.now();
  const r = spawnSync(tc.java_bin, argv, { cwd: projectRoot, encoding: 'utf8', timeout: timeout_ms, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}`; const err = `${r.stderr ?? ''}`;
  if (echo) { process.stdout.write(`$ java ${argv.join(' ')}\n`); process.stdout.write(out); if (err) process.stderr.write(err); }
  return { status: r.status, signal: r.signal ?? null, timed_out: r.error?.code === 'ETIMEDOUT', ms: Date.now() - t0, stdout: out, stderr: err, argv: ['java', ...argv] };
}

/** Lines that are bob's own diagnostics, split from the JVM's protobuf gencode chatter. */
export function classifyBobOutput(text) {
  const lines = text.split('\n');
  const noise = (l) => /protobuf|makeExtensionsImmutable|warnPre22Gencode|GHSA-h4h5-3hr4-j3g2/.test(l) || /^Sep|^[A-Z][a-z]{2} \d\d, \d{4} .* com\.google\.protobuf/.test(l);
  const errors = []; const warnings = [];
  for (const l of lines) {
    if (noise(l)) continue;
    if (/^ERROR\b/.test(l) || /\bSEVERE\b/.test(l) || /^The build failed/.test(l) || /Exception in thread|^\s+at com\.dynamo/.test(l)) errors.push(l.trimEnd());
    else if (/^WARNING\b/.test(l) || /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d WARNING/.test(l) || /^WARN\b/.test(l)) warnings.push(l.trimEnd());
  }
  return { errors, warnings, jvm_noise_lines: lines.filter(noise).length, total_lines: lines.length };
}

/** Unzip a dropped *.defold.zip so that `dest`/game.project exists (a zip wrapping one top-level folder is unwrapped). Returns the source files it found. */
export function unzipProject(zip, dest) {
  const tmp = `${dest}.unzip`;
  rmSync(dest, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const r = spawnSync('/usr/bin/unzip', ['-o', '-q', zip, '-d', tmp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`unzip ${zip}: ${(r.stderr ?? r.stdout ?? '').trim()}`);
  const hits = walk(tmp).filter((p) => p.endsWith('/game.project') && !p.includes('/__MACOSX/')).sort((a, b) => a.length - b.length);
  if (!hits.length) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`no game.project inside ${zip}`); }
  renameSync(dirname(hits[0]), dest);
  rmSync(tmp, { recursive: true, force: true });
  const files = walk(dest).filter((p) => !p.includes('/build/') && !p.includes('/.internal/') && !p.endsWith('/.DS_Store'));
  return { files: files.map((p) => ({ path: p.slice(dest.length + 1), bytes: statSync(p).size })), bytes: files.reduce((a, p) => a + statSync(p).size, 0), unwrapped: dirname(hits[0]) !== tmp };
}

/** game.project is INI-ish: [section] then key = value. Returns {section: {key: value}} plus the declared library dependencies. */
export function readGameProject(projectRoot) {
  const text = readFileSync(join(projectRoot, 'game.project'), 'utf8');
  const cfg = {}; let sec = '';
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    const m = l.match(/^\[(.+)\]$/);
    if (m) { sec = m[1]; cfg[sec] ??= {}; continue; }
    const i = l.indexOf('=');
    if (i > 0) (cfg[sec] ??= {})[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  const deps = Object.entries(cfg.project ?? {}).filter(([k]) => /^dependencies(#\d+)?$/.test(k)).map(([, v]) => v).filter(Boolean);
  return { cfg, title: cfg.project?.title ?? 'Unnamed', dependencies: deps, native_extensions: walk(projectRoot).filter((p) => p.endsWith('/ext.manifest') && !p.includes('/build/') && !p.includes('/.internal/')).map((p) => p.slice(projectRoot.length + 1)) };
}

/** Compiled resources under <root>/build/default, minus bob's bookkeeping files. */
export function compiledResources(projectRoot, buildDir = join(projectRoot, 'build', 'default')) {
  return walk(buildDir).filter((p) => !/\/(_BobBuildState_|digest_cache)$/.test(p)).map((p) => ({ path: p.slice(buildDir.length + 1), bytes: statSync(p).size })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Width/height of a PNG from its IHDR (no decoder needed). */
export function pngSize(p) {
  const b = readFileSync(p);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function writeJson(p, obj) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 1)); }

/** Bundle-zip suffix for a bob platform: wasm-web → html5, arm64-macos → macos, x86_64-linux → linux, x86_64-win32 → win32. */
export const platformSuffix = (platform) => (platform.endsWith('-web') ? 'html5' : platform.split('-').pop());
