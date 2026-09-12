// Batch masters and per-tag derivation for the programming lane.
//
// The derivation itself lives in vault-custody/src/lib/divkey.ts — the same
// module the edge verifier calls — and is imported from there, not copied. Any
// drift between "what was written to the chip" and "what the edge derives"
// would make every tag in the batch read as a forgery, so there is exactly one
// implementation.
//
// Masters come from the environment or the gitignored worktree .env:
//   CUSTODY_MASTER_META_<BATCH>   16-byte hex
//   CUSTODY_MASTER_FILE_<BATCH>   16-byte hex
// where <BATCH> is the batch label with [^A-Z0-9] folded to '_' and upper-cased
// (batch 'paradise-001' → CUSTODY_MASTER_META_PARADISE_001). A CUSTODY_KEYS
// JSON with a `diversified` keyset for the batch works too; it is what the
// Pages Function reads, so using it here means one source of truth.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = join(new URL('.', import.meta.url).pathname, '..', '..');

// The lane runs under tsx (`timmy nfc …` spawns `npx tsx lanes/nfc/program.mjs`),
// so the verifier's TypeScript module imports directly. Load it, never copy it.
async function divkey() {
  try {
    return await import(pathToFileURL(join(REPO, 'vault-custody', 'src', 'lib', 'divkey.ts')).href);
  } catch (e) {
    throw new Error(`could not load vault-custody/src/lib/divkey.ts — run this lane with tsx (npx tsx lanes/nfc/program.mjs …): ${e.message}`);
  }
}

export function envName(batch, role) {
  return `CUSTODY_MASTER_${role.toUpperCase()}_${batch.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/** Read one variable from the environment, else from the worktree .env. */
export function readEnv(name) {
  if (process.env[name]) return process.env[name];
  const p = join(REPO, '.env');
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/**
 * Resolve the masters for a batch. Order: explicit env pair, then a diversified
 * keyset named after the batch in CUSTODY_KEYS. Returns null when nothing is
 * configured; the caller decides what that means (bench: zeros; production:
 * refuse).
 */
export function loadBatchMaster(batch) {
  const meta = readEnv(envName(batch, 'meta'));
  const file = readEnv(envName(batch, 'file'));
  if (meta && file) return { masterMetaReadKey: meta, masterFileReadKey: file, batch, source: 'env' };
  const keysJson = readEnv('CUSTODY_KEYS');
  if (keysJson) {
    try {
      const table = JSON.parse(keysJson);
      const k = table[batch];
      if (k && k.kind === 'diversified') return { masterMetaReadKey: k.masterMetaReadKey, masterFileReadKey: k.masterFileReadKey, batch: k.batch ?? batch, source: 'CUSTODY_KEYS' };
    } catch { /* fall through */ }
  }
  return null;
}

/** The keys one tag carries, plus fingerprints safe to put in a receipt. */
export async function tagKeys(master, uidHex) {
  const d = await divkey();
  const keys = await d.deriveTagKeys(master, uidHex);
  return {
    keys,
    derivation: d.KEY_DERIVATION_ID,
    metaFingerprint: await d.keyFingerprint(keys.metaReadKey),
    fileFingerprint: await d.keyFingerprint(keys.fileReadKey),
    isFactoryZero: d.isFactoryZero,
  };
}

export async function derivationId() {
  return (await divkey()).KEY_DERIVATION_ID;
}

/** The keyset entry the edge needs for this batch, ready to paste into CUSTODY_KEYS. */
export function keysetEntry(master) {
  return { [master.batch]: { kind: 'diversified', masterMetaReadKey: master.masterMetaReadKey, masterFileReadKey: master.masterFileReadKey, batch: master.batch } };
}
