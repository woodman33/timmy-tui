// Tag simulator: produce the URL an NTAG 424 DNA would emit, given its keys,
// its UID and its counter.
//
// This exists so the parts of the NFC lane that cannot be tested without a chip
// can be tested without a chip. The programmer computes an NDEF URL template
// with SDM mirror offsets; a real tag fills those offsets in at read time. Here
// we fill them in ourselves and push the result through the same `sun.ts` the
// edge runs. An off-by-one in an offset — the classic way to brick a batch —
// fails this round trip instead of failing silently on 500 stickers.
//
// It is deliberately in src/lib, not in the lane: the simulator has to move in
// lockstep with the verifier, and a copy in a lane would drift.
import {
  aesEncryptBlock, computeSdmMac, concat, counterLE, hex, sessionMacKey,
} from './sun.js';
import { CMAC_PARAM, type TapParams } from './url.js';

/** PICCData tag byte 0xC7: UID mirrored (0x80) + counter mirrored (0x40) + UID length 7. */
export const PICC_TAG_UID_CTR = 0xc7;

export interface SimTag {
  /** 7-byte UID, hex. */
  uid: string;
  /** SDM read counter this tap reports. */
  counter: number;
  metaReadKey: Uint8Array;
  fileReadKey: Uint8Array;
  /** TagTamper mirror, e.g. 'CC' (closed) or 'OC'. Omit for a plain 424. */
  tagTamper?: string;
  /** Padding bytes the chip puts after the counter. Fixed input keeps tests deterministic. */
  pad?: Uint8Array;
}

/** The 16 bytes of encrypted PICCData a tag mirrors into the `e` parameter. */
export async function simulatePiccData(t: SimTag): Promise<Uint8Array> {
  const uid = hex.from(t.uid);
  if (uid.length !== 7) throw new Error(`UID must be 7 bytes, got ${uid.length}`);
  const pad = t.pad ?? new Uint8Array([0, 0, 0, 0, 0]);
  if (pad.length !== 5) throw new Error('pad must be 5 bytes');
  const plain = concat(new Uint8Array([PICC_TAG_UID_CTR]), uid, counterLE(t.counter), pad);
  // One block, zero IV: CBC and ECB agree, and aesEncryptBlock is the primitive
  // sun.ts already derives from WebCrypto's AES-CBC.
  return aesEncryptBlock(t.metaReadKey, plain);
}

/** The 8-byte truncated SDMMAC a tag mirrors into the `c` parameter. */
export async function simulateSdmMac(t: SimTag): Promise<Uint8Array> {
  const uid = hex.from(t.uid);
  const ctrLE = counterLE(t.counter);
  const kMac = await sessionMacKey(t.fileReadKey, uid, ctrLE);
  // No SDMENCFileData mirrored, so the MAC input is empty — the same branch
  // verifyEncryptedSun takes. computeSdmMac already truncates to 8 bytes.
  return computeSdmMac(kMac, new Uint8Array(0));
}

/** The tap parameters a real read of this tag would carry. */
export async function simulateTapParams(t: SimTag): Promise<TapParams> {
  const e = hex.to(await simulatePiccData(t)).toUpperCase();
  const c = hex.to(await simulateSdmMac(t)).toUpperCase();
  return { mode: 'encrypted', e, c, tt: t.tagTamper };
}

/** The full URL a phone would open after tapping this tag. */
export async function simulateTapUrl(base: string, t: SimTag): Promise<string> {
  const p = await simulateTapParams(t);
  const u = new URL('/t', base);
  u.searchParams.set('e', (p as { e: string }).e);
  u.searchParams.set(CMAC_PARAM, p.c);
  if (t.tagTamper) u.searchParams.set('tt', t.tagTamper.toUpperCase());
  return u.toString();
}

/**
 * Fill an NDEF URL template's SDM mirrors the way a chip does: overwrite the
 * placeholder runs at the recorded offsets with the values for this read.
 *
 * This is the check that matters. The programmer hands over a template and a
 * set of byte offsets; if any offset is off by one, the URL a tag produces is
 * subtly wrong and every tap fails with `bad_cmac`. Running the filled template
 * through the verifier proves the offsets before a single sticker is printed.
 */
export async function fillTemplate(template: string, offsets: SdmOffsets, t: SimTag): Promise<string> {
  const bytes = new TextEncoder().encode(template);
  const put = (at: number, textUpper: string) => {
    const v = new TextEncoder().encode(textUpper);
    if (at < 0 || at + v.length > bytes.length) throw new Error(`mirror at ${at}+${v.length} falls outside the ${bytes.length}-byte template`);
    bytes.set(v, at);
  };
  put(offsets.piccDataOffset, hex.to(await simulatePiccData(t)).toUpperCase());
  put(offsets.macOffset, hex.to(await simulateSdmMac(t)).toUpperCase());
  if (offsets.tagTamperOffset != null) {
    if (!t.tagTamper) throw new Error('template mirrors TagTamper but the simulated tag has none');
    put(offsets.tagTamperOffset, t.tagTamper.toUpperCase());
  }
  return new TextDecoder().decode(bytes);
}

/** Byte offsets into the NDEF URL where the chip writes each mirror. */
export interface SdmOffsets {
  piccDataOffset: number;
  macOffset: number;
  /** Absent on a plain NTAG 424 DNA: no tamper loop, no status to mirror. */
  tagTamperOffset?: number;
  /** Where the MAC input starts. Equal to macOffset when no file data is mirrored. */
  macInputOffset: number;
}
