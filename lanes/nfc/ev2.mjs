// NTAG 424 DNA secure messaging (EV2), the pure half.
//
// Everything here is arithmetic on bytes: session keys, command MACs, the
// encrypted payloads for ChangeKey and ChangeFileSettings, and the APDUs that
// carry them. No reader, no I/O — so it can be exercised on a laptop with no
// hardware attached (`node lanes/nfc/selftest.mjs`), which is the only way any
// of it gets checked before a chip is in the field.
//
// Source: NXP AN12196, "NTAG 424 DNA and NTAG 424 DNA TagTamper features and
// hints". Section numbers below refer to that note.
//
// HONEST LIMIT: the SUN verification path (sun.ts) is pinned to AN12196's
// published vectors and is proven. This module is not: NXP does not publish a
// worked AuthenticateEV2First vector, so the session-key construction here is
// implemented from the specification and cross-read against public
// implementations, and has never been run against a chip. The first real tag
// is the first real test. `lanes/nfc/program.mjs` therefore verifies every tag
// by reading it back and running its URL through the edge verifier, and
// refuses to seal a receipt if that read-back fails.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------- bytes

export const hex = {
  to: (b) => Buffer.from(b).toString('hex'),
  from: (s) => {
    const clean = String(s).replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2) throw new Error(`odd-length hex: ${s}`);
    return new Uint8Array(Buffer.from(clean, 'hex'));
  },
};

export const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export const xor = (a, b) => {
  if (a.length !== b.length) throw new Error(`xor length mismatch ${a.length} vs ${b.length}`);
  return a.map((v, i) => v ^ b[i]);
};

const ZERO16 = new Uint8Array(16);

// ---------------------------------------------------------------- AES + CMAC

export function aesCbcEncrypt(key, iv, data) {
  const c = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
}

export function aesCbcDecrypt(key, iv, data) {
  const d = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  d.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(data)), d.final()]));
}

function shiftLeft(b) {
  const out = new Uint8Array(b.length);
  let carry = 0;
  for (let i = b.length - 1; i >= 0; i--) {
    out[i] = ((b[i] << 1) & 0xff) | carry;
    carry = (b[i] & 0x80) ? 1 : 0;
  }
  return out;
}

function cmacSubkeys(key) {
  const L = aesCbcEncrypt(key, ZERO16, ZERO16);
  let K1 = shiftLeft(L);
  if (L[0] & 0x80) K1[15] ^= 0x87;
  let K2 = shiftLeft(K1);
  if (K1[0] & 0x80) K2[15] ^= 0x87;
  return { K1, K2 };
}

/** AES-CMAC (RFC 4493). */
export function cmac(key, msg) {
  const { K1, K2 } = cmacSubkeys(key);
  const n = Math.ceil(msg.length / 16);
  const blocks = Math.max(n, 1);
  const complete = msg.length > 0 && msg.length % 16 === 0;
  let last = msg.slice((blocks - 1) * 16);
  if (complete) {
    last = xor(last, K1);
  } else {
    const padded = new Uint8Array(16);
    padded.set(last);
    padded[last.length] = 0x80;
    last = xor(padded, K2);
  }
  let x = ZERO16;
  for (let i = 0; i < blocks - 1; i++) {
    x = aesCbcEncrypt(key, ZERO16, xor(x, msg.slice(i * 16, i * 16 + 16)));
  }
  return aesCbcEncrypt(key, ZERO16, xor(x, last));
}

/** The 8-byte MAC that rides on a command: odd-indexed bytes of the CMAC (§6.1). */
export function truncateMac(full16) {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = full16[2 * i + 1];
  return out;
}

// ---------------------------------------------------------------- CRC32 (§ChangeKey)

/** JAM CRC (CRC32 with the result left un-inverted), as ChangeKey requires. */
export function crc32Jam(data) {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = crc >>> 0;
  return new Uint8Array([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff]);
}

// ---------------------------------------------------------------- session (§6.1)

/**
 * SV1/SV2 from the two randoms, per AN12196:
 *   prefix || RndA[0..1] || (RndA[2..7] XOR RndB[0..5]) || RndB[6..15] || RndA[8..15]
 * SV1 (ENC) uses A5 5A …, SV2 (MAC) uses 5A A5 ….
 */
export function sessionVector(prefix, rndA, rndB) {
  if (rndA.length !== 16 || rndB.length !== 16) throw new Error('RndA and RndB must be 16 bytes');
  return cat(
    prefix,
    rndA.slice(0, 2),
    xor(rndA.slice(2, 8), rndB.slice(0, 6)),
    rndB.slice(6, 16),
    rndA.slice(8, 16),
  );
}

const SV1_PREFIX = new Uint8Array([0xa5, 0x5a, 0x00, 0x01, 0x00, 0x80]);
const SV2_PREFIX = new Uint8Array([0x5a, 0xa5, 0x00, 0x01, 0x00, 0x80]);

export function sessionKeys(authKey, rndA, rndB) {
  return {
    enc: cmac(authKey, sessionVector(SV1_PREFIX, rndA, rndB)),
    mac: cmac(authKey, sessionVector(SV2_PREFIX, rndA, rndB)),
  };
}

/** Rotate left by one byte: RndB' in the second authentication leg. */
export function rotateLeft(b) {
  return cat(b.slice(1), b.slice(0, 1));
}

/** Rotate right by one byte: recovering RndA from RndA' the tag returns. */
export function rotateRight(b) {
  return cat(b.slice(b.length - 1), b.slice(0, b.length - 1));
}

// ---------------------------------------------------------------- secure messaging (§6.2)

/** The IV for command data: E(KSesAuthENC, 0xA5 0x5A || TI || CmdCtr || 0…). */
export function commandIv(sesEnc, ti, cmdCtr) {
  return aesCbcEncrypt(sesEnc, ZERO16, cat(new Uint8Array([0xa5, 0x5a]), ti, ctr16(cmdCtr), new Uint8Array(8)));
}

/** The IV for response data: E(KSesAuthENC, 0x5A 0xA5 || TI || CmdCtr || 0…). */
export function responseIv(sesEnc, ti, cmdCtr) {
  return aesCbcEncrypt(sesEnc, ZERO16, cat(new Uint8Array([0x5a, 0xa5]), ti, ctr16(cmdCtr), new Uint8Array(8)));
}

function ctr16(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

/** Pad to the AES block with 0x80 00 … (§6.2, always padded, even at a boundary). */
export function padIso(data) {
  const out = new Uint8Array(Math.ceil((data.length + 1) / 16) * 16);
  out.set(data);
  out[data.length] = 0x80;
  return out;
}

export function unpadIso(data) {
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] === 0x80) return data.slice(0, i);
    if (data[i] !== 0x00) break;
  }
  return data;
}

/** MAC over Cmd || CmdCtr || TI || CmdHeader || CmdData, truncated. */
export function commandMac(sesMac, cmd, cmdCtr, ti, header, data) {
  return truncateMac(cmac(sesMac, cat(new Uint8Array([cmd]), ctr16(cmdCtr), ti, header ?? new Uint8Array(0), data ?? new Uint8Array(0))));
}

/** MAC the tag returns: RC || CmdCtr || TI || ResponseData. */
export function responseMac(sesMac, rc, cmdCtr, ti, data) {
  return truncateMac(cmac(sesMac, cat(new Uint8Array([rc]), ctr16(cmdCtr), ti, data ?? new Uint8Array(0))));
}

// ---------------------------------------------------------------- ChangeKey (§4.5)

/**
 * The ChangeKey payload.
 *
 * Key 0 is the master: the new key is sent alone. Any other key number is
 * changed while authenticated with key 0, so the tag cannot verify it holds the
 * old key — the payload carries (new XOR old) plus a CRC over the new key, and
 * a version byte.
 */
export function changeKeyData(keyNo, newKey, oldKey, keyVersion = 0x00) {
  if (newKey.length !== 16) throw new Error('new key must be 16 bytes');
  if (keyNo === 0) return cat(newKey, new Uint8Array([keyVersion]));
  if (!oldKey || oldKey.length !== 16) throw new Error('changing a non-master key needs the old key');
  return cat(xor(newKey, oldKey), new Uint8Array([keyVersion]), crc32Jam(newKey));
}

// ---------------------------------------------------------------- ChangeFileSettings / SDM (§4.3, §8.3)

export const FILE_NDEF = 0x02;

/** Access rights nibble pair, e.g. rights(0x0E, 0x0E, 0x00, 0x00). 0x0E = free, 0x0F = never. */
export function accessRights(read, write, readWrite, change) {
  return new Uint8Array([((readWrite & 0x0f) << 4) | (change & 0x0f), ((read & 0x0f) << 4) | (write & 0x0f)]);
}

const u24le = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);

/**
 * The plaintext of a ChangeFileSettings that turns SDM on for the NDEF file.
 *
 * Layout (§8.3.1): FileOption | AccessRights(2) | SDMOptions | SDMAccessRights(2)
 * then, in a fixed order, only the offsets the options actually enabled.
 *
 * We enable: UID mirror + read counter mirror, both inside the encrypted PICC
 * data, plus the SDMMAC. TagTamper status is mirrored when the part has a loop.
 */
export function sdmFileSettings({ offsets, tagTamper, sdmMetaReadKeyNo = 1, sdmFileReadKeyNo = 2, readKeyNo = 0x0e, writeKeyNo = 0x00 }) {
  const FILE_OPTION_SDM_ENABLED = 0x40; // bit 6; comm mode plain in the low bits
  const fileOption = FILE_OPTION_SDM_ENABLED | 0x00;

  // SDMOptions (§8.3.1 Table): UID mirror, ReadCtr mirror, ASCII encoding.
  let sdmOptions = 0x80 /* UID */ | 0x40 /* ReadCtr */ | 0x01 /* ASCII */;
  if (tagTamper) sdmOptions |= 0x20; // TagTamper status mirrored

  // SDMAccessRights: meta read key, file read key, and the counter-retrieve
  // right. 0xF = never, 0xE = free (plain).
  const sdmAccess = new Uint8Array([
    (0x0f << 4) | (sdmMetaReadKeyNo & 0x0f),   // RFU | CtrRet=F(never) is high nibble per note; meta read low
    ((sdmFileReadKeyNo & 0x0f) << 4) | 0x0f,   // file read | RFU
  ]);

  const parts = [
    new Uint8Array([fileOption]),
    accessRights(readKeyNo, writeKeyNo, 0x00, 0x00),
    new Uint8Array([sdmOptions]),
    sdmAccess,
  ];
  // Order matters and follows the enabled bits, high to low.
  parts.push(u24le(offsets.piccDataOffset));       // UID + counter, encrypted, one mirror
  if (tagTamper) parts.push(u24le(offsets.tagTamperOffset));
  parts.push(u24le(offsets.macInputOffset));
  parts.push(u24le(offsets.macOffset));
  return cat(...parts);
}

// ---------------------------------------------------------------- APDUs

const LE = new Uint8Array([0x00]);

/** Wrap a native command as an ISO 7816 APDU: 90 <cmd> 00 00 Lc <data> 00. */
export function apdu(cmd, data = new Uint8Array(0)) {
  return cat(new Uint8Array([0x90, cmd, 0x00, 0x00, data.length]), data, LE);
}

export const CMD = {
  AUTH_EV2_FIRST: 0x71,
  ADDITIONAL_FRAME: 0xaf,
  CHANGE_KEY: 0xc4,
  CHANGE_FILE_SETTINGS: 0x5f,
  GET_FILE_SETTINGS: 0xf5,
  WRITE_DATA: 0x8d,
  READ_DATA: 0xad,
  GET_CARD_UID: 0x51,
  GET_VERSION: 0x60,
};

/** Select the NDEF application (D2760000850101). */
export const SELECT_NDEF_APP = new Uint8Array([0x00, 0xa4, 0x04, 0x00, 0x07, 0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00]);

/** Status word at the end of a response: 91 00 is success, 91 AF wants another frame. */
export function statusOf(res) {
  if (res.length < 2) throw new Error('response too short for a status word');
  return { sw1: res[res.length - 2], sw2: res[res.length - 1], data: res.slice(0, res.length - 2) };
}

export const SW_OK = 0x00;
export const SW_MORE = 0xaf;

// ---------------------------------------------------------------- NDEF

/**
 * Wrap a URL as an NDEF message in an NDEF file: 2-byte length, then the
 * record. Returns the bytes and the offset at which the URL text begins, so
 * the SDM mirror offsets (which are relative to the FILE, not the URL) can be
 * shifted by it.
 */
export function ndefUrlFile(url) {
  // URI record, abbreviation 0x04 = "https://", so that prefix is not stored.
  const HTTPS = 'https://';
  if (!url.startsWith(HTTPS)) throw new Error('URL must start with https:// so the NDEF abbreviation applies');
  const rest = new TextEncoder().encode(url.slice(HTTPS.length));
  const payload = cat(new Uint8Array([0x04]), rest);
  const record = cat(new Uint8Array([0xd1, 0x01, payload.length, 0x55]), payload);
  const file = cat(new Uint8Array([(record.length >> 8) & 0xff, record.length & 0xff]), record);
  // 2 length bytes + 4 record header bytes + 1 abbreviation byte, then the URL text.
  const urlTextOffset = 2 + 4 + 1;
  return { file, urlTextOffset, recordBytes: record.length };
}

/** Shift URL-relative mirror offsets into file-relative ones. */
export function fileOffsets(offsets, urlTextOffset, httpsPrefixLen = 'https://'.length) {
  const shift = urlTextOffset - httpsPrefixLen;
  const out = {};
  for (const [k, v] of Object.entries(offsets)) out[k] = typeof v === 'number' ? v + shift : v;
  return out;
}

export const randA = () => new Uint8Array(randomBytes(16));
