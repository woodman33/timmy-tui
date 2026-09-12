// The derivation is the one piece of the NFC lane that cannot be checked with
// a tag in hand later: if the programmer and the verifier disagree, every tag
// in the batch reads as a forgery and the only symptom is "bad_cmac". So it is
// pinned to NXP's own published example, and the split between the batch key
// and the per-tag key is asserted here rather than left to a comment.
import { describe, it, expect } from 'vitest';
import { hex, aesCmac } from '../src/lib/sun.js';
import {
  diversifyAes128, metaDivInput, fileDivInput, deriveTagKeys, deriveBatchMetaKey,
  deriveTagFileKey, isFactoryZero, keyFingerprint, KEY_DERIVATION_ID, MAX_DIV_INPUT, DivKeyError,
} from '../src/lib/divkey.js';

describe('AN10922 AES-128 diversification', () => {
  // NXP AN10922 "Symmetric key diversifications" Rev 2.2, the AES-128 worked
  // example: master key, diversification input, expected diversified key.
  const MASTER = '00112233445566778899AABBCCDDEEFF';
  const DIV_INPUT = '04782E21801D803042F54E585020416275';
  const EXPECTED = 'A8DD63A3B89D54B37CA802473FDA9175';

  it('reproduces the application note vector', async () => {
    const k = await diversifyAes128(hex.from(MASTER), hex.from(DIV_INPUT));
    expect(hex.to(k).toUpperCase()).toBe(EXPECTED);
  });

  it('is CMAC over 0x01 || M, nothing more', async () => {
    const m = hex.from(DIV_INPUT);
    const direct = await aesCmac(hex.from(MASTER), new Uint8Array([0x01, ...m]));
    expect(hex.to(await diversifyAes128(hex.from(MASTER), m))).toBe(hex.to(direct));
  });

  it('refuses a master that is not 16 bytes', async () => {
    await expect(diversifyAes128(new Uint8Array(8), new Uint8Array([1]))).rejects.toThrow(DivKeyError);
  });

  it('refuses an empty or oversized diversification input', async () => {
    const master = hex.from(MASTER);
    await expect(diversifyAes128(master, new Uint8Array(0))).rejects.toThrow(DivKeyError);
    await expect(diversifyAes128(master, new Uint8Array(MAX_DIV_INPUT + 1))).rejects.toThrow(DivKeyError);
  });
});

describe('diversification inputs', () => {
  const uid = hex.from('04de5f1eacc040');

  it('derives the meta input without a UID, because the UID is not known yet', () => {
    const m = metaDivInput('paradise-001');
    expect(new TextDecoder().decode(m)).toBe('vc\u0000paradise-001\u0000m');
  });

  it('binds the file input to the UID, the batch and the role', () => {
    const f = fileDivInput(uid, 'paradise-001');
    expect(hex.to(f).startsWith('04de5f1eacc040')).toBe(true);
    expect(hex.to(f)).not.toBe(hex.to(metaDivInput('paradise-001')));
    expect(f.length).toBe(7 + 1 + 12 + 1 + 1);
  });

  it('rejects a UID that is not 7 bytes', () => {
    expect(() => fileDivInput(new Uint8Array(4), 'b')).toThrow(DivKeyError);
  });

  it('rejects a batch label that would overflow or carry separators', () => {
    expect(() => fileDivInput(uid, 'x'.repeat(21))).toThrow(DivKeyError);
    expect(() => fileDivInput(uid, 'has space')).toThrow(DivKeyError);
    expect(() => fileDivInput(uid, '')).toThrow(DivKeyError);
    expect(() => metaDivInput('has space')).toThrow(DivKeyError);
  });
});

describe('per-tag keys', () => {
  const master = {
    masterMetaReadKey: '000102030405060708090a0b0c0d0e0f',
    masterFileReadKey: 'f0e0d0c0b0a090807060504030201000',
    batch: 'paradise-001',
  };

  it('gives every tag its own file-read key', async () => {
    const a = await deriveTagKeys(master, '04de5f1eacc040');
    const b = await deriveTagKeys(master, '04958caa5c5e80');
    expect(hex.to(a.fileReadKey)).not.toBe(hex.to(b.fileReadKey));
    expect(hex.to(a.fileReadKey)).not.toBe(hex.to(a.metaReadKey));
  });

  it('shares one meta-read key across the batch, so the UID can be decrypted', async () => {
    const a = await deriveTagKeys(master, '04de5f1eacc040');
    const b = await deriveTagKeys(master, '04958caa5c5e80');
    expect(hex.to(a.metaReadKey)).toBe(hex.to(b.metaReadKey));
    expect(hex.to(a.metaReadKey)).toBe(hex.to(await deriveBatchMetaKey(master)));
  });

  it('is deterministic and case-insensitive on the UID: the verifier re-derives what was written', async () => {
    const once = await deriveTagFileKey(master, '04de5f1eacc040');
    const twice = await deriveTagFileKey(master, '04DE5F1EACC040');
    expect(hex.to(once)).toBe(hex.to(twice));
  });

  it('changes with the batch, so a compromise stops at one production run', async () => {
    const a = await deriveTagKeys(master, '04de5f1eacc040');
    const b = await deriveTagKeys({ ...master, batch: 'paradise-002' }, '04de5f1eacc040');
    expect(hex.to(a.metaReadKey)).not.toBe(hex.to(b.metaReadKey));
    expect(hex.to(a.fileReadKey)).not.toBe(hex.to(b.fileReadKey));
  });

  it('never derives the factory key from a real master', async () => {
    const k = await deriveTagKeys(master, '04de5f1eacc040');
    expect(isFactoryZero(hex.to(k.metaReadKey))).toBe(false);
    expect(isFactoryZero(hex.to(k.fileReadKey))).toBe(false);
  });
});

describe('key safety', () => {
  it('recognises the factory key', () => {
    expect(isFactoryZero('00000000000000000000000000000000')).toBe(true);
    expect(isFactoryZero('  00000000000000000000000000000000 ')).toBe(true);
    expect(isFactoryZero('000102030405060708090a0b0c0d0e0f')).toBe(false);
  });

  it('fingerprints a key without carrying it', async () => {
    const k = hex.from('000102030405060708090a0b0c0d0e0f');
    const fp = await keyFingerprint(k);
    expect(fp).toHaveLength(16);
    expect(hex.to(k)).not.toContain(fp);
    expect(await keyFingerprint(k)).toBe(fp);
  });

  it('names the scheme so a later change is visible in old receipts', () => {
    expect(KEY_DERIVATION_ID).toBe('an10922-aes128/meta:batch+file:uid/v1');
  });
});
