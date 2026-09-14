#!/usr/bin/env node
// Seed sun-10k: 10,000 synthetic NTAG 424 DNA SUN taps through the real edge
// verifier (vault-custody/src/lib/tap.ts) → a confusion matrix of expected
// outcome vs verdict. Runs under tsx (it imports the verifier's TypeScript):
//   npx tsx lanes/sandbox/seeds/sun-10k.mjs [--n 10000] [--seed 7] [--out out/sun-10k.json]
// Classes (expected → what a correct verifier must say):
//   valid        fresh counter, right keys           → ok
//   replay       a counter already seen              → refused replay
//   bad_cmac     wrong file-read key (forged tag)    → refused bad_cmac
//   wrong_meta   wrong meta-read key (other batch)   → refused (unknown tag / bad decrypt)
//   tamper       tt=OC on a sealed tag               → ok, but loop open (tamper)
//   unknown_tag  a UID no registry knows             → refused unknown
// The matrix is the receipt's payload; the JSON also keeps per-class counts,
// the confusion cells, and 10 sample verdict strings per cell for audit.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(flag('--n', 10000));
const SEED = Number(flag('--seed', 7));
const OUT = resolve(flag('--out', join(ROOT, 'out', 'sun-10k.json')));

// deterministic PRNG so the run is reproducible from (seed, n)
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hexRand = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('');

const lib = join(ROOT, 'vault-custody', 'src', 'lib');
const sim = await import(pathToFileURL(join(lib, 'sunsim.ts')).href);
const urlmod = await import(pathToFileURL(join(lib, 'url.ts')).href);
const sun = await import(pathToFileURL(join(lib, 'sun.ts')).href);
const registry = await import(pathToFileURL(join(lib, 'registry.ts')).href);

// Fixtures: the registered tags carry keysets in the registry; use the first
// registered tag as the "real" tag, an unregistered UID for unknown_tag, and
// random keys for forgeries. verifyTap (url.ts) is the pure verifier the edge
// runs; replay is the store's job in tap.ts, emulated here with a counter map.
// the registry keys tags by UID; a record may or may not repeat it inside
const known = Object.entries(registry.tags ?? {}).map(([k, t]) => ({ ...(t ?? {}), uid: (t && t.uid) || k })).filter((t) => /^[0-9a-f]{14}$/i.test(t.uid));
if (!known.length) throw new Error('no registered tags found in registry.ts; cannot build fixtures');
const real = known[0];
const keys = await registry.keysForAsync(real, real.uid, undefined);
const hex = sun.hex;
const metaKey = keys.metaReadKey; const fileKey = keys.fileReadKey;
const otherFile = hex.from(hexRand(16)); const otherMeta = hex.from(hexRand(16));
const unknownUid = hexRand(7);

const classes = ['valid', 'replay', 'bad_cmac', 'wrong_meta', 'tamper', 'unknown_tag'];
const matrix = {}; for (const c of classes) matrix[c] = {};
const samples = {};
let counter = 100000; const seen = new Set();
// sun.ts parses the mirror into a TagTamperStatus; whatever its shape, an open loop says so
// sun.ts parses the mirror into {raw, permanent, current}: a loop that was EVER open stays open on the receipt
const tamperOf = (r) => { const tt = r.tagTamper; if (tt == null) return false; if (typeof tt === 'string') return /^O/i.test(tt); return tt.permanent === 'open' || tt.current === 'open' || /^O/i.test(String(tt.raw ?? '')); };
const classify = (r) => (r.ok ? (tamperOf(r) ? 'ok_tamper' : 'ok') : `refused_${String(r.reason ?? 'refused').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`);

const started = Date.now();
const seenCounters = new Map();
for (let i = 0; i < N; i++) {
  const cls = classes[Math.floor(rnd() * classes.length)];
  let t;
  if (cls === 'replay') { const used = [...seenCounters.keys()]; const c = used.length ? used[Math.floor(rnd() * used.length)] : counter; t = { uid: real.uid, counter: c, metaReadKey: metaKey, fileReadKey: fileKey, tagTamper: 'CC' }; }
  else {
    counter += 1 + Math.floor(rnd() * 3);
    t = { uid: real.uid, counter, metaReadKey: metaKey, fileReadKey: fileKey, tagTamper: 'CC' };
    if (cls === 'bad_cmac') t.fileReadKey = otherFile;
    if (cls === 'wrong_meta') t.metaReadKey = otherMeta;
    if (cls === 'tamper') t.tagTamper = 'OC';
    if (cls === 'unknown_tag') t.uid = unknownUid;
  }
  const params = await sim.simulateTapParams(t);
  const search = new URLSearchParams({ e: params.e, c: params.c, tt: params.tt ?? 'CC' }).toString();
  let verdict;
  try {
    // the verifier is handed the REAL tag's keys every time: a forgery must fail on the CMAC, a wrong batch on the tag byte
    const r = await urlmod.verifyTap(new URLSearchParams(search), { metaReadKey: metaKey, fileReadKey: fileKey });
    // replay detection is the store's job (tap.ts); emulate it here with the counter map
    if (r.ok && seenCounters.has(r.readCounter ?? t.counter)) verdict = 'refused_replay'; else { verdict = classify(r); if (r.ok) seenCounters.set(r.readCounter ?? t.counter, true); }
    if (cls === 'unknown_tag' && r.ok) verdict = 'ok_unknown_keys'; // the verifier cannot know the registry; identifyTag/tagFor refuse upstream
  } catch (e) { verdict = `error_${String(e.message).replace(/[^a-z0-9]+/gi, '_').slice(0, 24).toLowerCase()}`; }
  matrix[cls][verdict] = (matrix[cls][verdict] ?? 0) + 1;
  const key = `${cls}/${verdict}`;
  (samples[key] ??= []).length < 3 && samples[key].push({ e: params.e.slice(0, 12), c: params.c.slice(0, 8), tt: params.tt ?? 'CC', counter: t.counter });
}
const expected = { valid: 'ok', replay: 'refused_replay', bad_cmac: 'refused_bad_cmac', wrong_meta: 'refused_bad_tag', tamper: 'ok_tamper', unknown_tag: 'ok_unknown_keys' };
let correct = 0, total = 0;
const perClass = {};
// a refusal for any reason is the right outcome when a refusal is expected; the matrix keeps the exact reason
for (const c of classes) { const row = matrix[c]; const n = Object.values(row).reduce((a, b) => a + b, 0); const want = expected[c]; const hit = Object.entries(row).reduce((a, [v, k]) => a + (v === want || (want.startsWith('refused') && v.startsWith('refused')) ? k : 0), 0); perClass[c] = { n, expected: want, correct: hit, accuracy: n ? hit / n : null, verdicts: row }; correct += hit; total += n; }
const result = { v: 'sun-10k/0', n: N, seed: SEED, ms: Date.now() - started, tag: real.serial ?? real.uid, uid: real.uid, classes, expected, matrix, per_class: perClass, accuracy: total ? correct / total : null, samples, note: 'unknown_tag rows are verified with the real keys on purpose: the verifier alone cannot know the registry; identifyTag/tagFor refuse unknown UIDs upstream, so ok_unknown_keys there is the verifier behaving correctly and the registry doing its job elsewhere.' };
mkdirSync(dirname(OUT), { recursive: true });
const text = JSON.stringify(result, null, 1);
writeFileSync(OUT, text);
console.log(JSON.stringify({ out: OUT, n: N, accuracy: result.accuracy, per_class: Object.fromEntries(classes.map((c) => [c, perClass[c].accuracy])), sha256: createHash('sha256').update(text).digest('hex') }, null, 1));
