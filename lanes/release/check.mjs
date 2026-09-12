#!/usr/bin/env node
// timmy release check — the blank-slate release gate (ORDER blank-slate-v1k9).
//
//   timmy release check [--ref <branch>] [--image node:24-bookworm] [--local] [--seal] [--json out.json] [--keep]
//
// Bundles the COMMITTED state of <ref> (never the working tree, never .timmy/), clones it fresh in a
// clean container (docker; --local = a temp dir with a blank HOME), installs, and asserts:
//   zero personal matches in the tree (pii.* and identity.* at any severity) · zero on the first screen
//   of both entry points (timmy.ts and src/cli.ts, no TTY) · the wizard is shown and writes nothing ·
//   no receipts, store-pin, private overlay or ledger in the clone · the §12 negative control: planted
//   personal strings (and the operator's own first identity literal, when .timmy/private/identity-terms.json
//   exists) MUST fail the scan and the tree is unchanged afterwards.
// Exit 0 only when every assertion holds. --seal records a release.check receipt through the canonical CLI.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

const sub = args.find((a) => !a.startsWith('--')) ?? 'check';
if (sub !== 'check') { console.error('usage: timmy release check [--ref <branch>] [--image <img>] [--local] [--seal] [--json out] [--keep]'); process.exit(2); }

const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT }).stdout.trim();
const ref = flag('--ref', branch === 'HEAD' ? '' : branch);
if (!ref) { console.error('[release] detached HEAD: pass --ref <branch>'); process.exit(2); }
const sha = sh('git', ['rev-parse', ref], { cwd: ROOT }).stdout.trim();
const image = flag('--image', 'node:24-bookworm');
const local = has('--local') || sh('docker', ['info']).status !== 0;
const work = mkdtempSync(join(tmpdir(), 'timmy-release.'));
const bundle = join(work, 'repo.bundle');
const b = sh('git', ['bundle', 'create', bundle, ref], { cwd: ROOT });
if (b.status !== 0) { console.error(`[release] git bundle failed: ${b.stderr}`); process.exit(2); }

// the operator's own first identity literal, if recorded privately, is planted too (never printed)
let plant = '';
try { const t = JSON.parse(readFileSync(join(ROOT, '.timmy', 'private', 'identity-terms.json'), 'utf8')); plant = t.terms?.[0]?.term ?? ''; } catch { /* none */ }

const script = [
  'set -e', 'mkdir -p "$HOME"',
  `git clone -q -b '${ref.replace(/'/g, '')}' /src/repo.bundle /work`,
  'cd /work', 'npm ci --no-audit --no-fund --loglevel=error',
  'node lanes/release/inside.mjs'
].join(' && ');
let r;
const t0 = Date.now();
if (!local) {
  r = sh('docker', ['run', '--rm', '-v', `${work}:/src:ro`, '-e', 'HOME=/tmp/blank', '-e', 'TIMMY_HOME=/tmp/blank/timmy', '-e', 'TIMMY_PRIVATE_DIR=/tmp/blank/private', '-e', `TIMMY_PLANT=${plant}`, image, 'bash', '-lc', script], { maxBuffer: 256 * 1024 * 1024 });
} else {
  const home = join(work, 'home'); const clone = join(work, 'work');
  const env = { ...process.env, HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_PRIVATE_DIR: join(home, 'private'), TIMMY_PLANT: plant };
  const steps = [['git', ['clone', '-q', '-b', ref, bundle, clone]], ['npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error']], ['node', ['lanes/release/inside.mjs']]];
  for (const [c, a] of steps) { r = sh(c, a, { cwd: existsSync(clone) ? clone : work, env, maxBuffer: 256 * 1024 * 1024 }); if (r.status !== 0 && c !== 'node') { console.error(`[release] ${c} ${a.join(' ')} failed:\n${r.stderr}`); break; } }
}
const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RELEASE_CHECK_JSON '));
const inside = line ? JSON.parse(line.slice('RELEASE_CHECK_JSON '.length)) : null;
const out = { ok: Boolean(inside?.ok), ref, sha: sha.slice(0, 12), mode: local ? 'local' : `docker ${image}`, seconds: Math.round((Date.now() - t0) / 1000), planted_operator_term: Boolean(plant), inside, stderr_tail: inside ? undefined : (r.stderr ?? '').split('\n').slice(-15).join('\n') };
if (!has('--keep')) rmSync(work, { recursive: true, force: true });
if (flag('--json')) writeFileSync(flag('--json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
if (has('--seal') && inside) {
  const m = ['--meta', `ref=${ref}`, '--meta', `sha=${sha.slice(0, 12)}`, '--meta', `mode=${out.mode}`, '--meta', `ok=${out.ok}`, '--meta', `tree_personal=${inside.tree_personal}`, '--meta', `first_screen_personal=${inside.first_screen_personal}`, '--meta', `wizard_shown=${JSON.stringify(inside.wizard_shown)}`, '--meta', `negative_control=${inside.negative_control.ok}:${inside.negative_control.findings}/${inside.negative_control.planted}`, '--meta', `patterns_sha256=${inside.patterns_sha256}`, '--meta', `files=${inside.files}`];
  const s = sh('npx', ['tsx', 'src/cli.ts', 'seal', 'release.check', ...m], { cwd: ROOT });
  process.stdout.write(s.stdout); if (s.status !== 0) process.stderr.write(s.stderr);
}
process.exit(out.ok ? 0 : 1);
