#!/usr/bin/env node
// Commit a box: seal what is inside BEFORE the sticker goes on.
//
//   timmy custody commit --serial VC0100 --contents contents.txt [--product "…"] [--by "…"] [--where "…"] [--photos 3]
//
// The contents file is one line per item, in the order they were packed. Its
// bytes are hashed; the hash goes into the receipt and, later, onto the box's
// record as `contentsHash`. The file itself is kept beside the receipt id so
// the manifest can be produced on demand — the hash proves it was not changed
// after the seal.
//
// Order matters: custody.commit is sealed with the box OPEN, then the sticker
// is applied and the first tap seals custody.seal. A commit that comes after
// the sticker proves nothing about what was inside.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const args = process.argv.slice(2);
const sub = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

if (sub !== 'commit') {
  console.error('usage: timmy custody commit --serial VC0100 --contents contents.txt [--product "…"] [--by "…"] [--where "…"] [--photos N]');
  process.exit(2);
}

const SERIAL = opt('--serial');
const CONTENTS = opt('--contents');
if (!SERIAL || !/^[A-Z]{2}\d{4,}$/.test(SERIAL)) { console.error('--serial must look like VC0100'); process.exit(2); }
if (!CONTENTS || !existsSync(resolve(CONTENTS))) { console.error('--contents must name a file that exists'); process.exit(2); }

const bytes = readFileSync(resolve(CONTENTS));
const lines = bytes.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
if (!lines.length) { console.error('the contents file is empty; list what is in the box, one line per item'); process.exit(2); }
const contentsHash = createHash('sha256').update(bytes).digest('hex');

// Keep the manifest beside the receipts, named by its hash so it cannot drift.
const DIR = join(ROOT, 'vault-custody', 'manifests');
mkdirSync(DIR, { recursive: true });
const kept = join(DIR, `${SERIAL}.${contentsHash.slice(0, 12)}.txt`);
copyFileSync(resolve(CONTENTS), kept);

const meta = {
  serial: SERIAL,
  contents_sha256: contentsHash,
  items: String(lines.length),
  manifest: relative(ROOT, kept),
  product: opt('--product', ''),
  by: opt('--by', ''),
  where: opt('--where', ''),
  photos: opt('--photos', '0'),
  state: 'open',
  note: 'sealed with the box open, before the sticker',
};
const a = ['custody.commit'];
for (const [k, v] of Object.entries(meta)) if (v !== '') a.push('--meta', `${k}=${String(v).slice(0, 400)}`);
const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'seal', ...a], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write((r.stdout + r.stderr).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ''));
if (r.status !== 0) process.exit(r.status ?? 1);

console.log(`\n${SERIAL}: ${lines.length} item(s), contents ${contentsHash.slice(0, 16)}… · manifest kept at ${relative(ROOT, kept)}`);
console.log('Now apply the sticker across the lid seam and tap it once: that first tap is custody.seal.');
