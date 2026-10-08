#!/usr/bin/env node
// The release artifact check (the operator's 2026-10-07 20:14 order, part 4). The release workflow
// packs one tarball, this script validates that file, and publication uses that same file: what
// ships is what was checked, byte for byte.
//
//   node scripts/release/validate-tarball.mjs <tarball> [--expect-version X.Y.Z-rc.N] [--out manifest.json] [--github]
//
// --github (in a workflow step): a passing artifact's sha256 and integrity become step outputs, and the
// step summary records the artifact, or the failures. A failing artifact produces no outputs.
//
// It checks that the package carries its bins, the CLI, the canvas bundle with every license it
// needs (the build's own distributable verdict, the tldraw license by its pinned hash, and both
// license texts byte-identical to the repository's committed copies), and none of the paths that
// must never ship. It writes a manifest with the tarball's full SHA-256 and npm integrity, the
// source commit, and the qualification evidence the repository holds for it. Exit 0 when every
// check passes, 1 otherwise (each failure named).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
/** The tldraw license at its v5.5.2 tag (scripts/canvas/build.mjs pins the same hash). */
export const TLDRAW_LICENSE_SHA256 = '9578fcddc20e404b6a29f44b6fea81d8b331698c0e7e9be34132d6f4394fa533';
const CANVAS = 'companion/studio-canvas';
/** Files every release must carry, besides the bins its package.json names. */
export const REQUIRED = ['package.json', 'dist/src/cli.js', `${CANVAS}/dist/canvas.js`, `${CANVAS}/dist/canvas.css`,
  `${CANVAS}/dist/versions.json`, `${CANVAS}/dist/THIRD-PARTY-NOTICES.md`, `${CANVAS}/dist/LICENSE-tldraw.md`,
  `${CANVAS}/LICENSE-tldraw.md`, `${CANVAS}/licenses/react-remove-scroll-bar.LICENSE`];
/** License texts that must be the repository's committed bytes. */
export const VERBATIM = [`${CANVAS}/LICENSE-tldraw.md`, `${CANVAS}/licenses/react-remove-scroll-bar.LICENSE`];
/** Paths that must never ship. */
export const FORBIDDEN = [/^tests\//, /^\.timmy\//, /^docs\/ui-cockpit\//, /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)\.env($|\.)/, /(^|\/)\.dev\.vars$/];
/** Where the repository keeps the qualification of a release candidate. */
export const QUALIFICATION = ['docs/ui-cockpit/c17/freeze.json', 'docs/ui-cockpit/c17/results.json'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });

function filesUnder(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  walk(dir);
  return out.map((p) => relative(dir, p).split('\\').join('/')).sort();
}

/** Validate one tarball. Returns { ok, failures, manifest }. */
export function validateTarball(tarball, { expectVersion } = {}) {
  const failures = [];
  const bytes = readFileSync(tarball);
  const at = mkdtempSync(join(tmpdir(), 'timmy-release-'));
  const x = spawnSync('tar', ['-xzf', resolve(tarball), '-C', at], { encoding: 'utf8' });
  if (x.status !== 0) failures.push(`the tarball does not unpack: ${x.stderr.trim()}`);
  const root = join(at, 'package');
  const files = existsSync(root) ? filesUnder(root) : [];
  if (!files.length) failures.push('the tarball has no package/ directory');
  const has = (p) => files.includes(p);
  const read = (p) => readFileSync(join(root, p));
  let pkg = {};
  if (has('package.json')) { try { pkg = JSON.parse(read('package.json').toString('utf8')); } catch { failures.push('package.json is not JSON'); } }
  for (const p of REQUIRED) if (!has(p)) failures.push(`missing: ${p}`);
  for (const target of new Set(Object.values(pkg.bin ?? {}))) {
    const p = String(target).replace(/^\.\//, '');
    if (!has(p)) failures.push(`missing bin target: ${p}`);
  }
  if (pkg.name !== 'timmy-tui') failures.push(`package name is ${JSON.stringify(pkg.name)}, not "timmy-tui"`);
  if (expectVersion && pkg.version !== expectVersion) failures.push(`package version is ${JSON.stringify(pkg.version)}, expected ${expectVersion}`);
  if (has(`${CANVAS}/dist/versions.json`)) {
    try {
      const v = JSON.parse(read(`${CANVAS}/dist/versions.json`).toString('utf8'));
      if (v.distributable !== true || (v.missing ?? []).length) failures.push(`the canvas build is not distributable: ${JSON.stringify(v.missing ?? [])}`);
    } catch { failures.push('the canvas versions.json is not JSON'); }
  }
  if (has(`${CANVAS}/dist/LICENSE-tldraw.md`) && sha256(read(`${CANVAS}/dist/LICENSE-tldraw.md`)) !== TLDRAW_LICENSE_SHA256)
    failures.push(`${CANVAS}/dist/LICENSE-tldraw.md is not the tldraw license (sha256 must be ${TLDRAW_LICENSE_SHA256})`);
  for (const p of VERBATIM) {
    if (!has(p)) continue;
    const committed = join(REPO, p);
    if (!existsSync(committed)) failures.push(`${p}: the repository has no committed copy to compare`);
    else if (!read(p).equals(readFileSync(committed))) failures.push(`${p} is not byte-identical to the repository's committed text`);
  }
  for (const p of files) if (FORBIDDEN.some((rx) => rx.test(p))) failures.push(`must not ship: ${p}`);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const dirty = git(['status', '--porcelain']).stdout.trim().length > 0;
  const qualification = QUALIFICATION.filter((p) => existsSync(join(REPO, p))).map((p) => {
    const b = readFileSync(join(REPO, p));
    let frozenHead; try { frozenHead = JSON.parse(b.toString('utf8')).head; } catch {}
    return { path: p, sha256: sha256(b), ...(frozenHead ? { head: frozenHead } : {}) };
  });
  const manifest = {
    schema: 1, kind: 'release-artifact', name: pkg.name, version: pkg.version, file: basename(tarball), bytes: bytes.length,
    sha256: sha256(bytes), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), entries: files.length,
    source: { commit: head, dirty }, qualification, checked_at: new Date().toISOString(), ok: failures.length === 0,
  };
  return { ok: failures.length === 0, failures, manifest };
}

/** The step summary for one checked artifact (GitHub-flavoured Markdown). */
export function summaryMarkdown(manifest, failures) {
  const code = (v) => '`' + String(v) + '`';
  const q = manifest.qualification.map((x) => `${code(x.path)} sha256 ${code(x.sha256)}${x.head ? ` (frozen head ${code(x.head)})` : ''}`).join('<br>');
  return ['### Release artifact' + (failures.length ? ': REFUSED' : ''), '', '| | |', '|---|---|',
    `| file | ${code(manifest.file)} (${manifest.bytes} bytes, ${manifest.entries} files) |`,
    `| sha256 | ${code(manifest.sha256)} |`, `| integrity | ${code(manifest.integrity)} |`,
    `| source | ${code(manifest.source.commit)}${manifest.source.dirty ? ' (dirty)' : ''} |`,
    `| qualification | ${q || 'none in this checkout'} |`, '',
    ...(failures.length ? ['Failures:', '', ...failures.map((f) => `- ${f}`), ''] : [])].join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const tarball = args.find((a, i) => !a.startsWith('--') && !['--expect-version', '--out'].includes(args[i - 1]));
  if (!tarball || !existsSync(tarball) || !statSync(tarball).isFile()) {
    console.error('usage: validate-tarball.mjs <tarball> [--expect-version X.Y.Z-rc.N] [--out manifest.json] [--github]');
    process.exit(2);
  }
  const r = validateTarball(tarball, { expectVersion: flag('--expect-version') });
  const out = flag('--out');
  if (out) writeFileSync(out, JSON.stringify({ ...r.manifest, failures: r.failures }, null, 2) + '\n');
  if (args.includes('--github')) {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(r.manifest, r.failures));
    if (r.ok && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${r.manifest.sha256}\nintegrity=${r.manifest.integrity}\n`);
  }
  console.log(JSON.stringify({ ...r.manifest, failures: r.failures }));
  if (!r.ok) { for (const f of r.failures) console.error(`release check: ${f}`); process.exit(1); }
}
