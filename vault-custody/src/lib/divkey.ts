// AN10922 AES-128 key diversification — one derivation, two callers.
//
// The programmer (lanes/nfc) writes per-tag keys into the chip; the edge
// verifier re-derives the same keys from the batch master and the UID it just
// read. If those two ever disagree, every tag in the batch verifies as a
// forgery and the only symptom is `bad_cmac`. So they must be the same code,
// not two implementations of the same paragraph. This module is that code:
// `lanes/nfc` imports it, and `registry.keysFor` calls it for any keyset
// declared `diversified`.
//
// AN10922 §2.2.1 (Rev 2.2): for AES-128, D = 0x01 || M padded per CMAC, and
// K_div = CMAC(K_master, D). Standard AES-CMAC already applies exactly that
// padding and subkey rule, so the derivation is one CMAC over 0x01 || M.
// Pinned to the application note's published example in test/divkey.test.ts.
//
// WHY THE TWO KEYS DIVERSIFY DIFFERENTLY. With SDM encrypted PICC mirroring,
// the UID arrives encrypted: a reader must decrypt it with K_SDMMetaRead
// BEFORE it can know which tag it is holding. A meta-read key diversified per
// UID would therefore be underivable at the moment it is needed. So:
//
//   K_SDMMetaRead  diversified per BATCH   — decrypts UID + counter
//   K_SDMFileRead  diversified per TAG     — authenticates the CMAC
//
// This gives away nothing. The meta key only conceals the UID and the counter,
// neither of which is a secret (the plain SDM variant mirrors both in the
// clear). Tag authenticity rests entirely on the file-read key, and that one is
// unique per tag: lifting a key off one chip forges that chip and no other.
import { aesCmac, concat, hex, type SunKeys } from './sun.js';

/** Names the scheme in every tag.program receipt. Change the scheme, change the id. */
export const KEY_DERIVATION_ID = 'an10922-aes128/meta:batch+file:uid/v1';

/** AN10922 diversification constant for AES-128. */
const AES128_DIV_CONSTANT = 0x01;

/** M may be 1..31 bytes: 0x01 || M has to fit two AES blocks with room to pad. */
export const MAX_DIV_INPUT = 31;

/** Batch labels are mixed into key material, so keep them boring and bounded. */
export const BATCH_LABEL = /^[A-Za-z0-9._-]{1,20}$/;

export class DivKeyError extends Error {}

/**
 * AN10922 AES-128 diversification.
 * @param master 16-byte master key
 * @param divInput 1..31 bytes of diversification input (M)
 * @returns the 16-byte diversified key
 */
export async function diversifyAes128(master: Uint8Array, divInput: Uint8Array): Promise<Uint8Array> {
  if (master.length !== 16) throw new DivKeyError(`master key must be 16 bytes, got ${master.length}`);
  if (divInput.length < 1 || divInput.length > MAX_DIV_INPUT) {
    throw new DivKeyError(`diversification input must be 1..${MAX_DIV_INPUT} bytes, got ${divInput.length}`);
  }
  return aesCmac(master, concat(new Uint8Array([AES128_DIV_CONSTANT]), divInput));
}

const enc = new TextEncoder();

function checkBatch(batch: string): void {
  if (!BATCH_LABEL.test(batch)) {
    throw new DivKeyError(`batch label must be 1-20 chars of [A-Za-z0-9._-], got ${JSON.stringify(batch)}`);
  }
}

/**
 * Meta-read diversification input: the batch, and the role byte 'm'.
 * Derivable before the UID is known, which is the whole point.
 *
 *   M = "vc" || 0x00 || batch || 0x00 || "m"
 */
export function metaDivInput(batch: string): Uint8Array {
  checkBatch(batch);
  const m = concat(enc.encode('vc'), new Uint8Array([0]), enc.encode(batch), new Uint8Array([0]), enc.encode('m'));
  if (m.length > MAX_DIV_INPUT) throw new DivKeyError(`diversification input too long: ${m.length} bytes`);
  return m;
}

/**
 * File-read diversification input: the tag's own UID, the batch, and the role
 * byte 'f'. Unique per chip.
 *
 *   M = UID(7) || 0x00 || batch || 0x00 || "f"
 *
 * With a 7-byte UID and two separators, the batch label must fit in 21 bytes;
 * BATCH_LABEL caps it at 20.
 */
export function fileDivInput(uid: Uint8Array, batch: string): Uint8Array {
  return tagDivInput(uid, batch, 'f');
}

/**
 * Per-tag diversification input for any per-tag role: 'f' is the SDM
 * file-read key, 'a' is the application master (key 0), which the programmer
 * also makes per tag so the factory master can never reopen a shipped sticker.
 */
export function tagDivInput(uid: Uint8Array, batch: string, role: 'f' | 'a'): Uint8Array {
  if (uid.length !== 7) throw new DivKeyError(`UID must be 7 bytes, got ${uid.length}`);
  checkBatch(batch);
  const m = concat(uid, new Uint8Array([0]), enc.encode(batch), new Uint8Array([0]), enc.encode(role));
  if (m.length > MAX_DIV_INPUT) throw new DivKeyError(`diversification input too long: ${m.length} bytes`);
  return m;
}

/** The per-tag application master (key 0) the programmer leaves on the chip. Never needed at the edge. */
export async function deriveTagAppKey(master: BatchMaster, uidHex: string): Promise<Uint8Array> {
  return diversifyAes128(hex.from(master.masterFileReadKey), tagDivInput(hex.from(uidHex), master.batch, 'a'));
}

export interface BatchMaster {
  /** 16-byte master behind every batch meta-read key, hex. */
  masterMetaReadKey: string;
  /** 16-byte master behind every per-tag file-read key, hex. */
  masterFileReadKey: string;
  /** Batch label, mixed into both derivations. */
  batch: string;
}

/** The batch meta-read key: what a reader needs before it knows the UID. */
export async function deriveBatchMetaKey(master: BatchMaster): Promise<Uint8Array> {
  return diversifyAes128(hex.from(master.masterMetaReadKey), metaDivInput(master.batch));
}

/** The per-tag file-read key: what makes one chip unforgeable as another. */
export async function deriveTagFileKey(master: BatchMaster, uidHex: string): Promise<Uint8Array> {
  return diversifyAes128(hex.from(master.masterFileReadKey), fileDivInput(hex.from(uidHex), master.batch));
}

/** Both keys a single tag carries, as the verifier and the programmer see them. */
export async function deriveTagKeys(master: BatchMaster, uidHex: string): Promise<SunKeys> {
  return {
    metaReadKey: await deriveBatchMetaKey(master),
    fileReadKey: await deriveTagFileKey(master, uidHex),
  };
}

/** All-zero is the factory key. Never leave a production batch holding it. */
export function isFactoryZero(keyHex: string): boolean {
  return /^0{32}$/i.test(String(keyHex).trim());
}

/**
 * A short, non-reversible label for a key, safe to write into a receipt or a
 * log: eight bytes of CMAC over a fixed string under that key. It identifies
 * the key without carrying it, so two runs can be compared without either
 * receipt containing key material.
 */
export async function keyFingerprint(key: Uint8Array): Promise<string> {
  const mac = await aesCmac(key, enc.encode('custody-key-fingerprint-v1'));
  return hex.to(mac.slice(0, 8));
}
