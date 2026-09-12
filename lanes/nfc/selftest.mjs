#!/usr/bin/env node
// What can be checked about the chip layer with no chip.
//
// The SUN verification path has NXP's published vectors and is pinned in
// vault-custody/test/sun.test.ts. The EV2 command layer has no published
// vector, so this asserts the parts that are checkable on their own terms:
// CMAC against RFC 4493, the CRC the ChangeKey payload carries, the shape and
// reversibility of the session construction, and the NDEF framing plus the
// offset shift that turns URL offsets into file offsets. Run it before every
// programming session.
//
//   node lanes/nfc/selftest.mjs
import assert from 'node:assert/strict';
import {
  hex, cat, xor, cmac, truncateMac, crc32Jam, sessionVector, sessionKeys, rotateLeft, rotateRight,
  padIso, unpadIso, changeKeyData, sdmFileSettings, apdu, ndefUrlFile, fileOffsets, commandMac,
  aesCbcEncrypt, aesCbcDecrypt, commandIv,
} from './ev2.mjs';

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('EV2 self-test (no reader required)\n');

// -------------------------------------------------- CMAC, against RFC 4493
check('AES-CMAC matches RFC 4493 for the empty message', () => {
  const key = hex.from('2b7e151628aed2a6abf7158809cf4f3c');
  assert.equal(hex.to(cmac(key, new Uint8Array(0))), 'bb1d6929e95937287fa37d129b756746');
});

check('AES-CMAC matches RFC 4493 for a 16-byte message', () => {
  const key = hex.from('2b7e151628aed2a6abf7158809cf4f3c');
  const msg = hex.from('6bc1bee22e409f96e93d7e117393172a');
  assert.equal(hex.to(cmac(key, msg)), '070a16b46b4d4144f79bdd9dd04a287c');
});

check('AES-CMAC matches RFC 4493 for a 40-byte message', () => {
  const key = hex.from('2b7e151628aed2a6abf7158809cf4f3c');
  const msg = hex.from('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411');
  assert.equal(hex.to(cmac(key, msg)), 'dfa66747de9ae63030ca32611497c827');
});

check('the truncated MAC keeps the odd-indexed bytes', () => {
  const full = hex.from('000102030405060708090a0b0c0d0e0f');
  assert.equal(hex.to(truncateMac(full)), '01030507090b0d0f');
});

// -------------------------------------------------- CRC32/JAM
check('JAM CRC of the empty string is zero', () => {
  assert.equal(hex.to(crc32Jam(new Uint8Array(0))), 'ffffffff');
});

check('JAM CRC is the un-inverted CRC32 of "123456789"', () => {
  // CRC32("123456789") = CBF43926; JAM leaves the register un-inverted, so the
  // result is the bitwise complement 340BC6D9, sent little-endian.
  const c = crc32Jam(new TextEncoder().encode('123456789'));
  assert.equal(hex.to(c), 'd9c60b34');
});

// -------------------------------------------------- session construction
check('the session vector is 32 bytes and mixes both randoms', () => {
  const rndA = hex.from('00112233445566778899aabbccddeeff');
  const rndB = hex.from('ffeeddccbbaa99887766554433221100');
  const sv = sessionVector(new Uint8Array([0xa5, 0x5a, 0x00, 0x01, 0x00, 0x80]), rndA, rndB);
  assert.equal(sv.length, 32);
  assert.equal(hex.to(sv.slice(0, 6)), 'a55a00010080');
  assert.equal(hex.to(sv.slice(6, 8)), hex.to(rndA.slice(0, 2)));
  assert.equal(hex.to(sv.slice(8, 14)), hex.to(xor(rndA.slice(2, 8), rndB.slice(0, 6))));
  assert.equal(hex.to(sv.slice(14, 24)), hex.to(rndB.slice(6, 16)));
  assert.equal(hex.to(sv.slice(24, 32)), hex.to(rndA.slice(8, 16)));
});

check('the two session keys differ and are stable', () => {
  const key = hex.from('00000000000000000000000000000000');
  const rndA = hex.from('00112233445566778899aabbccddeeff');
  const rndB = hex.from('ffeeddccbbaa99887766554433221100');
  const a = sessionKeys(key, rndA, rndB);
  const b = sessionKeys(key, rndA, rndB);
  assert.notEqual(hex.to(a.enc), hex.to(a.mac));
  assert.equal(hex.to(a.enc), hex.to(b.enc));
  assert.equal(hex.to(a.mac), hex.to(b.mac));
});

check('a different RndB gives different session keys', () => {
  const key = hex.from('00000000000000000000000000000000');
  const rndA = hex.from('00112233445566778899aabbccddeeff');
  const one = sessionKeys(key, rndA, hex.from('ffeeddccbbaa99887766554433221100'));
  const two = sessionKeys(key, rndA, hex.from('ffeeddccbbaa99887766554433221101'));
  assert.notEqual(hex.to(one.enc), hex.to(two.enc));
});

check('rotate left and right are inverses', () => {
  const b = hex.from('00112233445566778899aabbccddeeff');
  assert.equal(hex.to(rotateRight(rotateLeft(b))), hex.to(b));
  assert.equal(hex.to(rotateLeft(b).slice(15)), '00');
});

// -------------------------------------------------- padding and IVs
check('ISO padding always adds a byte and round-trips', () => {
  for (const len of [0, 1, 15, 16, 17, 31, 32]) {
    const data = new Uint8Array(len).fill(0xab);
    const p = padIso(data);
    assert.equal(p.length % 16, 0);
    assert.ok(p.length > len);
    assert.equal(hex.to(unpadIso(p)), hex.to(data));
  }
});

check('the command IV changes with the counter', () => {
  const ses = hex.from('000102030405060708090a0b0c0d0e0f');
  const ti = hex.from('7a21085e');
  assert.notEqual(hex.to(commandIv(ses, ti, 0)), hex.to(commandIv(ses, ti, 1)));
});

check('CBC encrypt and decrypt round-trip without padding', () => {
  const key = hex.from('000102030405060708090a0b0c0d0e0f');
  const iv = new Uint8Array(16);
  const data = padIso(new TextEncoder().encode('custody'));
  assert.equal(hex.to(aesCbcDecrypt(key, iv, aesCbcEncrypt(key, iv, data))), hex.to(data));
});

check('the command MAC covers the counter and the transaction id', () => {
  const ses = hex.from('000102030405060708090a0b0c0d0e0f');
  const a = commandMac(ses, 0x5f, 0, hex.from('7a21085e'), new Uint8Array([0x02]), new Uint8Array(0));
  const b = commandMac(ses, 0x5f, 1, hex.from('7a21085e'), new Uint8Array([0x02]), new Uint8Array(0));
  const c = commandMac(ses, 0x5f, 0, hex.from('7a21085f'), new Uint8Array([0x02]), new Uint8Array(0));
  assert.equal(a.length, 8);
  assert.notEqual(hex.to(a), hex.to(b));
  assert.notEqual(hex.to(a), hex.to(c));
});

// -------------------------------------------------- ChangeKey
check('changing the master key sends the key and its version', () => {
  const nk = hex.from('000102030405060708090a0b0c0d0e0f');
  const d = changeKeyData(0, nk, undefined, 0x01);
  assert.equal(d.length, 17);
  assert.equal(hex.to(d.slice(0, 16)), hex.to(nk));
  assert.equal(d[16], 0x01);
});

check('changing another key sends new XOR old, a version, and a CRC of the new key', () => {
  const nk = hex.from('000102030405060708090a0b0c0d0e0f');
  const ok = hex.from('ffffffffffffffffffffffffffffffff');
  const d = changeKeyData(1, nk, ok, 0x01);
  assert.equal(d.length, 21);
  assert.equal(hex.to(d.slice(0, 16)), hex.to(xor(nk, ok)));
  assert.equal(d[16], 0x01);
  assert.equal(hex.to(d.slice(17)), hex.to(crc32Jam(nk)));
});

check('changing a non-master key without the old key is refused', () => {
  assert.throws(() => changeKeyData(1, hex.from('000102030405060708090a0b0c0d0e0f')), /old key/);
});

// -------------------------------------------------- SDM settings
check('the SDM settings carry every enabled offset, tamper included', () => {
  const offsets = { piccDataOffset: 40, macOffset: 90, macInputOffset: 90, tagTamperOffset: 110 };
  const withTt = sdmFileSettings({ offsets, tagTamper: true });
  const without = sdmFileSettings({ offsets, tagTamper: false });
  // file option + rights(2) + sdm options + sdm access(2) = 6, then 3 bytes per offset
  assert.equal(withTt.length, 6 + 3 * 4);
  assert.equal(without.length, 6 + 3 * 3);
  assert.equal(withTt[0] & 0x40, 0x40, 'SDM enabled bit');
  assert.equal(withTt[3] & 0x20, 0x20, 'tamper mirror bit set');
  assert.equal(without[3] & 0x20, 0x00, 'tamper mirror bit clear on a plain part');
});

check('offsets are little-endian 24-bit', () => {
  const s = sdmFileSettings({ offsets: { piccDataOffset: 0x0102, macOffset: 1, macInputOffset: 1 }, tagTamper: false });
  assert.equal(hex.to(s.slice(6, 9)), '020100');
});

// -------------------------------------------------- NDEF + offset shift
check('the NDEF file wraps the URL and reports where its text starts', () => {
  const url = 'https://example.com/t?e=' + '0'.repeat(32);
  const { file, urlTextOffset, recordBytes } = ndefUrlFile(url);
  assert.equal(file[0] << 8 | file[1], recordBytes);
  assert.equal(file[2], 0xd1, 'NDEF record header');
  assert.equal(file[5], 0x55, 'URI record type U');
  assert.equal(file[6], 0x04, 'https:// abbreviation');
  const text = new TextDecoder().decode(file.slice(urlTextOffset));
  assert.equal(text, url.slice('https://'.length));
});

check('URL offsets shift into file offsets by a constant', () => {
  const url = 'https://example.com/t?e=' + '0'.repeat(32) + '&c=' + '0'.repeat(16);
  const { file, urlTextOffset } = ndefUrlFile(url);
  const urlOffsets = { piccDataOffset: url.indexOf('?e=') + 3, macOffset: url.indexOf('&c=') + 3, macInputOffset: url.indexOf('&c=') + 3 };
  const fo = fileOffsets(urlOffsets, urlTextOffset);
  // The mirror must land on the placeholder run inside the file bytes.
  const at = (o, len) => new TextDecoder().decode(file.slice(o, o + len));
  assert.equal(at(fo.piccDataOffset, 32), '0'.repeat(32));
  assert.equal(at(fo.macOffset, 16), '0'.repeat(16));
});

check('a URL that is not https is refused, because the abbreviation would lie', () => {
  assert.throws(() => ndefUrlFile('http://example.com/t'), /https/);
});

// -------------------------------------------------- APDU
check('an APDU wraps the command with Lc and Le', () => {
  const a = apdu(0x5f, new Uint8Array([1, 2, 3]));
  assert.equal(hex.to(a), '905f0000030102030' + '0');
});

console.log(`\n${n} checks passed. The SUN path is pinned separately in vault-custody/test.`);
console.log('Not covered here: anything that needs a chip. The programming lane proves those by reading the tag back through the edge verifier.');
