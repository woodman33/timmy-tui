import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveLicenseKey, generateLicenseKeyPair, importSigningKey, importVerifyKey, licenseKeyHash,
  normalizeLicenseKey, proClaims, signLicenseToken, verifyLicenseToken,
} from '../src/pro/license.js';
import { PRO_FEATURES } from '../src/pro/plan.js';

const NOW = 1_800_000_000;
let signing: CryptoKey;
let verifying: CryptoKey;
let otherVerifying: CryptoKey;

beforeAll(async () => {
  const pair = await generateLicenseKeyPair();
  signing = await importSigningKey(pair.privatePkcs8);
  verifying = await importVerifyKey(pair.publicRaw);
  otherVerifying = await importVerifyKey((await generateLicenseKeyPair()).publicRaw);
});

describe('license keys', () => {
  it('derives a stable, readable key per subscription and version', async () => {
    const a = await deriveLicenseKey('secret', 'sub_123', 1);
    expect(a).toMatch(/^tpro_[0-9A-HJKMNP-TV-Z]{8}(-[0-9A-HJKMNP-TV-Z]{8}){3}$/);
    expect(await deriveLicenseKey('secret', 'sub_123', 1)).toBe(a);
    expect(await deriveLicenseKey('secret', 'sub_123', 2)).not.toBe(a);
    expect(await deriveLicenseKey('other-secret', 'sub_123', 1)).not.toBe(a);
  });

  it('normalizes pasted keys: case, dashes, spaces and look-alike letters', async () => {
    const key = await deriveLicenseKey('secret', 'sub_123', 1);
    const sloppy = `  ${key.toLowerCase().replace(/-/g, ' ')}  `;
    expect(normalizeLicenseKey(sloppy)).toBe(key);
    expect(normalizeLicenseKey('tpro_short')).toBeNull();
    expect(normalizeLicenseKey('sk_test_' + 'A'.repeat(32))).toBeNull();
    expect(normalizeLicenseKey(undefined)).toBeNull();
  });

  it('stores only a hash that changes when the key rotates', async () => {
    const v1 = await licenseKeyHash(await deriveLicenseKey('secret', 'sub_123', 1));
    const v2 = await licenseKeyHash(await deriveLicenseKey('secret', 'sub_123', 2));
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect(v2).not.toBe(v1);
  });
});

describe('license tokens', () => {
  const claims = () => proClaims({ subscriptionRef: 'abcd1234abcd1234', status: 'active', issuedAt: NOW, expiresAt: NOW + 3600 });

  it('round-trips signed claims with every Pro feature', async () => {
    const token = await signLicenseToken(claims(), signing);
    const check = await verifyLicenseToken(token, verifying, NOW);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.claims.features).toEqual([...PRO_FEATURES]);
  });

  it('rejects edited claims, foreign keys, expiry and garbage', async () => {
    const token = await signLicenseToken(claims(), signing);
    const [prefix, payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims(), exp: NOW + 10 ** 9 })).toString('base64url');
    expect(await verifyLicenseToken(`${prefix}.${forged}.${sig}`, verifying, NOW)).toEqual({ ok: false, reason: 'signature does not verify' });
    expect(await verifyLicenseToken(token, otherVerifying, NOW)).toEqual({ ok: false, reason: 'signature does not verify' });
    expect(await verifyLicenseToken(token, verifying, NOW + 3600)).toEqual({ ok: false, reason: 'token expired' });
    expect(await verifyLicenseToken('nope', verifying, NOW)).toEqual({ ok: false, reason: 'not a Timmy Pro token' });
    expect(await verifyLicenseToken(`${prefix}.${payload}.!!`, verifying, NOW)).toEqual({ ok: false, reason: 'malformed token' });
  });

  it('rejects a correctly signed token whose subscription is not active', async () => {
    const canceled = await signLicenseToken({ ...claims(), status: 'canceled' }, signing);
    expect(await verifyLicenseToken(canceled, verifying, NOW)).toEqual({ ok: false, reason: 'subscription not active' });
  });
});
