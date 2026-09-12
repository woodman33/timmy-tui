// ACR122U over PC/SC, via nfc-pcsc. The impure half of the chip layer: it
// moves APDUs and keeps the secure-messaging state (session keys, transaction
// id, command counter) for one authenticated session.
//
// nfc-pcsc is a native module (it wraps the platform PC/SC library), so it is
// installed beside this lane rather than in the repo root:
//   npm --prefix lanes/nfc install
// and imported lazily, so the rest of the lane (self-test, dry run, template
// preview) works on a machine with no reader and no build toolchain.
//
// NEVER RUN AGAINST A CHIP: see ev2.mjs. Every step below reports what it did,
// and program.mjs refuses to seal a receipt unless the tag reads back through
// the edge verifier afterwards.
import {
  CMD, SELECT_NDEF_APP, SW_MORE, SW_OK, apdu, statusOf, hex, cat, randA, rotateLeft, rotateRight,
  aesCbcEncrypt, aesCbcDecrypt, sessionKeys, commandIv, responseIv, padIso, unpadIso, commandMac, responseMac,
  changeKeyData, sdmFileSettings,
} from './ev2.mjs';

const ZERO16 = new Uint8Array(16);

export class ReaderError extends Error {}

/** Load nfc-pcsc only when a reader is actually wanted. */
export async function loadPcsc() {
  try {
    const m = await import('nfc-pcsc');
    return m.NFC ?? m.default?.NFC ?? m.default;
  } catch (e) {
    throw new ReaderError(`nfc-pcsc is not installed beside this lane. Run: npm --prefix lanes/nfc install  (${e.message})`);
  }
}

/**
 * Wait for one reader and one card. Resolves with a handle that transmits
 * APDUs to that card. The ACR122U exposes the ISO 14443-4 card through PC/SC
 * once it is on the field; nfc-pcsc raises `card` with the ATR.
 */
export function waitForCard({ timeoutMs = 60_000, log = () => {} } = {}) {
  return new Promise(async (resolve, reject) => {
    const NFC = await loadPcsc().catch(reject);
    if (!NFC) return;
    const nfc = new NFC();
    const timer = setTimeout(() => { nfc.close?.(); reject(new ReaderError(`no card within ${timeoutMs / 1000}s`)); }, timeoutMs);
    nfc.on('reader', (reader) => {
      log(`reader: ${reader.reader.name}`);
      // We drive the card ourselves; stop the library from auto-reading NDEF.
      reader.autoProcessing = false;
      reader.on('card', (card) => {
        clearTimeout(timer);
        log(`card on field: atr ${Buffer.from(card.atr).toString('hex')}`);
        resolve({
          readerName: reader.reader.name,
          atr: new Uint8Array(card.atr),
          transmit: async (bytes) => {
            const res = await reader.transmit(Buffer.from(bytes), 258);
            return new Uint8Array(res);
          },
          close: () => { try { reader.close(); } catch { /* already closed */ } try { nfc.close?.(); } catch { /* ignore */ } },
        });
      });
      reader.on('error', (err) => { clearTimeout(timer); reject(new ReaderError(`reader: ${err.message}`)); });
    });
    nfc.on('error', (err) => { clearTimeout(timer); reject(new ReaderError(`pcsc: ${err.message}`)); });
  });
}

/** The anti-collision UID the reader already has, no authentication needed (PC/SC GET DATA). */
export async function readUid(card) {
  const res = await card.transmit(new Uint8Array([0xff, 0xca, 0x00, 0x00, 0x00]));
  const { sw1, sw2, data } = statusOf(res);
  if (sw1 !== 0x90 || sw2 !== 0x00) throw new ReaderError(`GET DATA (UID) failed: ${sw1.toString(16)}${sw2.toString(16)}`);
  if (data.length !== 7) throw new ReaderError(`expected a 7-byte UID, got ${data.length}`);
  return hex.to(data);
}

/** GetVersion, three frames. Identifies NTAG 424 DNA and whether it is the TagTamper part. */
export async function getVersion(card) {
  let res = await card.transmit(apdu(CMD.GET_VERSION));
  let st = statusOf(res);
  const frames = [st.data];
  while (st.sw1 === 0x91 && st.sw2 === SW_MORE) {
    res = await card.transmit(apdu(CMD.ADDITIONAL_FRAME));
    st = statusOf(res);
    frames.push(st.data);
  }
  if (st.sw1 !== 0x91 || st.sw2 !== SW_OK) throw new ReaderError(`GetVersion: ${st.sw1.toString(16)}${st.sw2.toString(16)}`);
  const hw = frames[0];
  // AN12196 §GetVersion: HW type 0x04 = NTAG, subtype 0x02 = 424 DNA, 0x08 = 424 DNA TagTamper.
  const type = hw[1];
  const subtype = hw[2];
  const isNtag424 = type === 0x04 && (subtype === 0x02 || subtype === 0x08);
  return { raw: frames.map((f) => hex.to(f)), isNtag424, tagTamper: subtype === 0x08, hwMajor: hw[3], hwMinor: hw[4], storage: hw[5] };
}

export async function selectNdefApp(card) {
  const st = statusOf(await card.transmit(SELECT_NDEF_APP));
  if (!(st.sw1 === 0x90 && st.sw2 === 0x00)) throw new ReaderError(`select NDEF application: ${st.sw1.toString(16)}${st.sw2.toString(16)}`);
}

/**
 * AuthenticateEV2First with key `keyNo`. Returns a session: keys, TI, and a
 * command counter, plus helpers that wrap a command in full secure messaging
 * (encrypted data + MAC) and verify the response MAC.
 */
export async function authenticateEv2First(card, keyNo, key, { log = () => {} } = {}) {
  // Leg 1: ask for RndB.
  let st = statusOf(await card.transmit(apdu(CMD.AUTH_EV2_FIRST, new Uint8Array([keyNo, 0x00]))));
  if (!(st.sw1 === 0x91 && st.sw2 === SW_MORE)) throw new ReaderError(`AuthenticateEV2First leg 1 with key ${keyNo}: ${st.sw1.toString(16)}${st.sw2.toString(16)} (wrong key?)`);
  const rndB = aesCbcDecrypt(key, ZERO16, st.data);
  const rndA = randA();
  // Leg 2: E(K, RndA || RndB').
  const leg2 = aesCbcEncrypt(key, ZERO16, cat(rndA, rotateLeft(rndB)));
  st = statusOf(await card.transmit(apdu(CMD.ADDITIONAL_FRAME, leg2)));
  if (!(st.sw1 === 0x91 && st.sw2 === SW_OK)) throw new ReaderError(`AuthenticateEV2First leg 2: ${st.sw1.toString(16)}${st.sw2.toString(16)}`);
  const plain = aesCbcDecrypt(key, ZERO16, st.data); // TI(4) || RndA'(16) || PDcap2(6) || PCDcap2(6)
  const ti = plain.slice(0, 4);
  const rndAback = rotateRight(plain.slice(4, 20));
  if (hex.to(rndAback) !== hex.to(rndA)) throw new ReaderError('AuthenticateEV2First: the tag did not echo RndA — wrong key or a card that is not what it says');
  const ses = sessionKeys(key, rndA, rndB);
  log(`authenticated with key ${keyNo}; TI ${hex.to(ti)}`);

  const s = { keyNo, ti, cmdCtr: 0, ses };

  /** Full mode: E(data) under the command IV, then MAC over cmd||ctr||TI||header||E(data). */
  s.full = async (cmd, header, data) => {
    const enc = data && data.length ? aesCbcEncrypt(ses.enc, commandIv(ses.enc, ti, s.cmdCtr), padIso(data)) : new Uint8Array(0);
    const mac = commandMac(ses.mac, cmd, s.cmdCtr, ti, header, enc);
    const res = statusOf(await card.transmit(apdu(cmd, cat(header ?? new Uint8Array(0), enc, mac))));
    s.cmdCtr = (s.cmdCtr + 1) & 0xffff;
    if (!(res.sw1 === 0x91 && res.sw2 === SW_OK)) throw new ReaderError(`cmd ${cmd.toString(16)}: ${res.sw1.toString(16)}${res.sw2.toString(16)}`);
    // Response: [E(data)] || MAC(8). Verify the MAC before trusting anything.
    const body = res.data.slice(0, res.data.length - 8);
    const gotMac = res.data.slice(res.data.length - 8);
    const want = responseMac(ses.mac, SW_OK, s.cmdCtr, ti, body);
    if (hex.to(want) !== hex.to(gotMac)) throw new ReaderError(`cmd ${cmd.toString(16)}: response MAC mismatch`);
    return body.length ? unpadIso(aesCbcDecrypt(ses.enc, responseIv(ses.enc, ti, s.cmdCtr), body)) : new Uint8Array(0);
  };

  /** MAC mode: plain data, MAC over cmd||ctr||TI||header||data. */
  s.maced = async (cmd, header, data) => {
    const mac = commandMac(ses.mac, cmd, s.cmdCtr, ti, header, data);
    const res = statusOf(await card.transmit(apdu(cmd, cat(header ?? new Uint8Array(0), data ?? new Uint8Array(0), mac))));
    s.cmdCtr = (s.cmdCtr + 1) & 0xffff;
    if (!(res.sw1 === 0x91 && res.sw2 === SW_OK)) throw new ReaderError(`cmd ${cmd.toString(16)}: ${res.sw1.toString(16)}${res.sw2.toString(16)}`);
    const body = res.data.slice(0, res.data.length - 8);
    const gotMac = res.data.slice(res.data.length - 8);
    const want = responseMac(ses.mac, SW_OK, s.cmdCtr, ti, body);
    if (hex.to(want) !== hex.to(gotMac)) throw new ReaderError(`cmd ${cmd.toString(16)}: response MAC mismatch`);
    return body;
  };

  return s;
}

/** Cmd.GetCardUID inside a session: the real UID, authenticated, not the anti-collision one. */
export async function getCardUid(session) {
  const uid = await session.full(CMD.GET_CARD_UID, new Uint8Array(0), new Uint8Array(0));
  return hex.to(uid.slice(0, 7));
}

/** Cmd.WriteData to the NDEF file in plain communication (factory: write is free). */
export async function writeNdefFile(card, fileBytes) {
  // Header: FileNo | Offset(3, LE) | Length(3, LE). Chunk under the frame limit.
  const CHUNK = 200;
  for (let off = 0; off < fileBytes.length; off += CHUNK) {
    const part = fileBytes.slice(off, off + CHUNK);
    const header = new Uint8Array([0x02, off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, part.length & 0xff, (part.length >> 8) & 0xff, (part.length >> 16) & 0xff]);
    const st = statusOf(await card.transmit(apdu(CMD.WRITE_DATA, cat(header, part))));
    if (!(st.sw1 === 0x91 && st.sw2 === SW_OK)) throw new ReaderError(`WriteData at ${off}: ${st.sw1.toString(16)}${st.sw2.toString(16)}`);
  }
}

/** Cmd.ReadData of the NDEF file in plain communication; the tag mirrors SDM values into it. */
export async function readNdefFile(card, length) {
  const header = new Uint8Array([0x02, 0, 0, 0, length & 0xff, (length >> 8) & 0xff, (length >> 16) & 0xff]);
  let st = statusOf(await card.transmit(apdu(CMD.READ_DATA, header)));
  const parts = [st.data];
  while (st.sw1 === 0x91 && st.sw2 === SW_MORE) {
    st = statusOf(await card.transmit(apdu(CMD.ADDITIONAL_FRAME)));
    parts.push(st.data);
  }
  if (!(st.sw1 === 0x91 && st.sw2 === SW_OK)) throw new ReaderError(`ReadData: ${st.sw1.toString(16)}${st.sw2.toString(16)}`);
  return cat(...parts);
}

/** Cmd.ChangeFileSettings for the NDEF file, full mode, turning SDM on with the given offsets. */
export async function enableSdm(session, { fileOffsets, tagTamper }) {
  const settings = sdmFileSettings({ offsets: fileOffsets, tagTamper });
  await session.full(CMD.CHANGE_FILE_SETTINGS, new Uint8Array([0x02]), settings);
  return settings;
}

/** Cmd.ChangeKey, full mode. Key 0 must be changed LAST: it ends the session. */
export async function changeKey(session, keyNo, newKey, oldKey, version = 0x01) {
  await session.full(CMD.CHANGE_KEY, new Uint8Array([keyNo]), changeKeyData(keyNo, newKey, oldKey, version));
}

/** Pull the URL back out of an NDEF file read from the chip. */
export function urlFromNdefFile(fileBytes) {
  const len = (fileBytes[0] << 8) | fileBytes[1];
  const record = fileBytes.slice(2, 2 + len);
  if (record[3] !== 0x55) throw new ReaderError('NDEF record is not a URI record');
  const payloadLen = record[2];
  const payload = record.slice(4, 4 + payloadLen);
  const PREFIX = { 0x00: '', 0x01: 'http://www.', 0x02: 'https://www.', 0x03: 'http://', 0x04: 'https://' };
  const prefix = PREFIX[payload[0]];
  if (prefix == null) throw new ReaderError(`unknown URI abbreviation 0x${payload[0].toString(16)}`);
  return prefix + new TextDecoder().decode(payload.slice(1));
}
