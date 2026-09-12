#!/usr/bin/env node
// Program NTAG 424 DNA (TagTamper) stickers for Vault Custody.
//
//   timmy nfc program --batch paradise-001 --count 10 [--role seal|reveal] [--part tt|plain]
//                     [--base https://v.vlt.to] [--serial-start VC0100] [--bench] [--dry-run] [--no-seal]
//   timmy nfc template --base <url> [--part tt|plain]      print the URL template + offsets
//   timmy nfc selftest                                     the chip layer's no-hardware checks
//
// Per tag, in this order — and the order is the safety:
//   1. read the UID, check the part (424 DNA, TagTamper or plain)
//   2. derive this tag's keys from the batch master (vault-custody/src/lib/divkey.ts)
//   3. authenticate with the FACTORY key 0 (zeros) — a tag that refuses was already programmed
//   4. write the NDEF URL template
//   5. enable SDM with the offsets computed from the template
//   6. change key 1 (meta read), key 2 (file read), then key 0 (master) LAST
//   7. read the tag back: the chip fills the mirrors, the URL runs through the
//      edge verifier with the derived keys. No pass, no receipt.
//   8. seal tag.program, append the batch registry line
//
// Refusals that stop the run before touching a chip:
//   - production batch (no --bench) with a master that is all zeros or missing
//   - a batch label that will not fit the derivation input
//   - --part tt on a chip whose GetVersion says it has no tamper loop, or the reverse
//
// Never printed, never sealed: any key. Receipts carry fingerprints only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ndefUrlFile, fileOffsets } from './ev2.mjs';
import { loadBatchMaster, tagKeys, derivationId, keysetEntry } from './keys.mjs';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const args = process.argv.slice(2);
const sub = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
const log = (m) => console.log(m);
const sha = (s) => createHash('sha256').update(s).digest('hex');

const usage = () => {
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(2);
};

// ---------------------------------------------------------------- verifier-side modules (TypeScript, via tsx)
async function lib(name) {
  return import(pathToFileURL(join(ROOT, 'vault-custody', 'src', 'lib', `${name}.ts`)).href);
}

// ---------------------------------------------------------------- template
async function template({ base, part }) {
  const { buildUrlTemplate, templateFingerprintInput } = await lib('sdmurl');
  const t = buildUrlTemplate({ base, tagTamper: part === 'tt' });
  const ndef = ndefUrlFile(t.template);
  const fo = fileOffsets(t.offsets, ndef.urlTextOffset);
  return { ...t, ndef, fileOffsets: fo, template_sha256: sha(templateFingerprintInput(t)) };
}

if (sub === 'template') {
  const t = await template({ base: opt('--base', 'https://preview.vault-custody.pages.dev'), part: opt('--part', 'tt') });
  log(t.template);
  log(`url offsets   picc ${t.offsets.piccDataOffset}  mac ${t.offsets.macOffset}  macInput ${t.offsets.macInputOffset}${t.offsets.tagTamperOffset != null ? `  tt ${t.offsets.tagTamperOffset}` : ''}`);
  log(`file offsets  picc ${t.fileOffsets.piccDataOffset}  mac ${t.fileOffsets.macOffset}  macInput ${t.fileOffsets.macInputOffset}${t.fileOffsets.tagTamperOffset != null ? `  tt ${t.fileOffsets.tagTamperOffset}` : ''}`);
  log(`ndef file     ${t.ndef.file.length} bytes · template sha256 ${t.template_sha256.slice(0, 16)}`);
  process.exit(0);
}

if (sub === 'selftest') {
  const r = spawnSync('node', [join(ROOT, 'lanes', 'nfc', 'selftest.mjs')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

if (sub !== 'program') usage();

// ---------------------------------------------------------------- program
const BATCH = opt('--batch');
const COUNT = Number(opt('--count', 1));
const ROLE = opt('--role', 'seal');
const PART = opt('--part', 'tt');
const BASE = opt('--base', 'https://preview.vault-custody.pages.dev');
const SERIAL_START = opt('--serial-start', null);
const BENCH = flag('--bench');
const DRY = flag('--dry-run');
const NO_SEAL = flag('--no-seal');
if (!BATCH || !Number.isInteger(COUNT) || COUNT < 1) usage();
if (!['seal', 'reveal'].includes(ROLE)) usage();
if (!['tt', 'plain'].includes(PART)) usage();

// Batch label must survive the derivation input.
const { BATCH_LABEL } = await lib('divkey');
if (!BATCH_LABEL.test(BATCH)) {
  console.error(`batch label ${JSON.stringify(BATCH)} must match ${BATCH_LABEL} (it is mixed into every key)`);
  process.exit(2);
}

// ---------------------------------------------------------------- masters and the zero-key refusal
const ZERO = '00000000000000000000000000000000';
let master = loadBatchMaster(BATCH);
const { isFactoryZero } = await lib('divkey');
if (!master) {
  if (!BENCH) {
    console.error(`no master keys for batch ${BATCH}. Set ${envNamePair(BATCH)} in the environment or the worktree .env, or a diversified keyset "${BATCH}" in CUSTODY_KEYS. Refusing: a production batch never ships on factory keys. (--bench programs with zeros for a bench test only.)`);
    process.exit(3);
  }
  master = { masterMetaReadKey: ZERO, masterFileReadKey: ZERO, batch: BATCH, source: 'bench zeros' };
}
if (!BENCH && (isFactoryZero(master.masterMetaReadKey) || isFactoryZero(master.masterFileReadKey))) {
  console.error(`batch ${BATCH} master keys are the factory zeros. Refusing to program a production batch; use --bench for a bench test.`);
  process.exit(3);
}
if (BENCH && !(isFactoryZero(master.masterMetaReadKey) && isFactoryZero(master.masterFileReadKey))) {
  log('note: --bench with real masters. Keys will be diversified from them as in production; the receipt will say bench.');
}
function envNamePair(b) {
  const n = b.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return `CUSTODY_MASTER_META_${n} and CUSTODY_MASTER_FILE_${n}`;
}

const T = await template({ base: BASE, part: PART });
const DERIVATION = await derivationId();
log(`batch ${BATCH} · ${COUNT} tag(s) · role ${ROLE} · part ${PART === 'tt' ? 'NTAG 424 DNA TagTamper' : 'NTAG 424 DNA (plain)'} · masters from ${master.source}`);
log(`template ${T.template}`);
log(`file offsets picc ${T.fileOffsets.piccDataOffset} mac ${T.fileOffsets.macOffset}${T.fileOffsets.tagTamperOffset != null ? ` tt ${T.fileOffsets.tagTamperOffset}` : ''} · derivation ${DERIVATION}`);

// Serial assignment: sequential from --serial-start, else none (assign later in the registry).
const serialAt = (i) => {
  if (!SERIAL_START) return null;
  const m = /^([A-Z]+)(\d+)$/.exec(SERIAL_START);
  if (!m) return null;
  return `${m[1]}${String(Number(m[2]) + i).padStart(m[2].length, '0')}`;
};

// Batch registry: one JSON line per programmed tag, ready to fold into
// vault-custody/src/data/tags.json (or KV in production).
const BATCH_DIR = join(ROOT, 'lanes', 'nfc', 'batches');
const BATCH_FILE = join(BATCH_DIR, `${BATCH}.jsonl`);
mkdirSync(BATCH_DIR, { recursive: true });

if (DRY) {
  log('\n--dry-run: no reader opened. What one tag would get:');
  const demoUid = '04de5f1eacc040';
  const k = await tagKeys(master, demoUid);
  log(` uid ${demoUid} (example) · meta fp ${k.metaFingerprint} · file fp ${k.fileFingerprint}`);
  log(` keyset entry for the edge (CUSTODY_KEYS):`);
  log(' ' + JSON.stringify(keysetEntry(master)).replace(/"master(Meta|File)ReadKey":"[0-9a-fA-F]+"/g, '"master$1ReadKey":"<redacted>"'));
  process.exit(0);
}

// ---------------------------------------------------------------- the reader loop
const reader = await import('./reader.mjs');
const { verifyTap } = await lib('url');

const seal = (subject, meta) => {
  if (NO_SEAL) return null;
  const a = [subject];
  for (const [k, v] of Object.entries(meta)) a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 400)}`);
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'seal', ...a], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout + r.stderr).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  process.stdout.write(out);
  if (r.status !== 0) throw new Error(`seal failed for ${subject}`);
  const m = /sealed (sha256_[0-9a-f]+)/.exec(out);
  return m ? m[1] : null;
};

let done = 0;
for (let i = 0; i < COUNT; i++) {
  log(`\n[${i + 1}/${COUNT}] place a tag on the reader…`);
  const card = await reader.waitForCard({ log });
  try {
    const ver = await reader.getVersion(card);
    if (!ver.isNtag424) throw new Error(`not an NTAG 424 DNA (GetVersion ${ver.raw[0]})`);
    if (PART === 'tt' && !ver.tagTamper) throw new Error('this chip has no tamper loop; program it with --part plain or use TagTamper stock');
    if (PART === 'plain' && ver.tagTamper) throw new Error('this is a TagTamper chip; program it with --part tt so the loop status is mirrored');
    await reader.selectNdefApp(card);
    const uid = await reader.readUid(card);
    log(` uid ${uid} · ${ver.tagTamper ? 'TagTamper' : 'plain'} · hw ${ver.hwMajor}.${ver.hwMinor}`);

    const k = await tagKeys(master, uid);

    // 3. factory master. A tag that refuses here was programmed before; leave it alone.
    const factory = new Uint8Array(16);
    let session = await reader.authenticateEv2First(card, 0, factory, { log: (m) => log(` ${m}`) });
    const authUid = await reader.getCardUid(session);
    if (authUid !== uid) throw new Error(`authenticated UID ${authUid} differs from anti-collision UID ${uid}`);

    // 4. the URL template
    await reader.writeNdefFile(card, T.ndef.file);
    log(` wrote NDEF (${T.ndef.file.length} bytes)`);

    // 5. SDM on, offsets from the template
    await reader.enableSdm(session, { fileOffsets: T.fileOffsets, tagTamper: PART === 'tt' });
    log(' SDM enabled');

    // 6. keys: 1 and 2 under the factory session, then 0 last (it ends the session)
    await reader.changeKey(session, 1, k.keys.metaReadKey, factory, 0x01);
    await reader.changeKey(session, 2, k.keys.fileReadKey, factory, 0x01);
    // Key 0 (application master) becomes a per-tag key too, so nobody can re-open
    // the tag with the factory master. Same derivation, role 'a' (divkey.ts).
    const { deriveTagAppKey } = await lib('divkey');
    await reader.changeKey(session, 0, await deriveTagAppKey(master, uid), undefined, 0x01);
    log(' keys changed: 1 (meta), 2 (file), 0 (master)');

    // 7. read back through the edge verifier. The chip fills the mirrors on this read.
    const back = await reader.readNdefFile(card, T.ndef.file.length);
    const url = reader.urlFromNdefFile(back);
    const r = await verifyTap(new URL(url).searchParams, k.keys);
    if (!r.ok) throw new Error(`read-back did not verify: ${r.reason} ${r.detail ?? ''} — NOT sealing. The tag holds new keys; keep it aside as batch ${BATCH} uid ${uid}.`);
    log(` read-back verified · counter ${r.readCounter}${r.tagTamper ? ` · loop ${r.tagTamper.current}` : ''}`);

    // 8. receipt + registry
    const serial = serialAt(i);
    const receipt = seal('tag.program', {
      uid, batch: BATCH, role: ROLE, part: PART === 'tt' ? 'NTAG424DNA_TT' : 'NTAG424DNA', bench: String(BENCH),
      key_derivation: DERIVATION, meta_key_fp: k.metaFingerprint, file_key_fp: k.fileFingerprint,
      url_template_sha256: T.template_sha256, base: BASE, ndef_bytes: String(T.ndef.file.length),
      picc_off: String(T.fileOffsets.piccDataOffset), mac_off: String(T.fileOffsets.macOffset),
      tt_off: T.fileOffsets.tagTamperOffset != null ? String(T.fileOffsets.tagTamperOffset) : 'none',
      readback_counter: String(r.readCounter), readback_loop: r.tagTamper?.current ?? 'n/a',
      ...(serial ? { serial } : {}),
      note: PART === 'plain' ? 'bench part: plain NTAG 424 DNA, no tamper loop mirrored; production stickers are TagTamper' : 'TagTamper: loop status mirrored as tt=',
    });
    appendFileSync(BATCH_FILE, JSON.stringify({
      uid, serial, role: ROLE, type: PART === 'tt' ? 'NTAG424DNA_TT' : 'NTAG424DNA', batch: BATCH, keyset: BATCH,
      lastCounter: r.readCounter, programmed_at: new Date().toISOString(), receipt, bench: BENCH,
    }) + '\n');
    done++;
    log(` sealed ${receipt ?? '(--no-seal)'} · registry ${relative(ROOT, BATCH_FILE)}`);
  } finally {
    card.close();
  }
}

log(`\n${done}/${COUNT} programmed. Add the keyset to the edge's CUSTODY_KEYS and the registry lines to tags.json.`);
log(JSON.stringify(keysetEntry(master)).replace(/"master(Meta|File)ReadKey":"[0-9a-fA-F]+"/g, '"master$1ReadKey":"<from the same env, never from this log>"'));
