import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LicenseStorageError, type StoredLicense } from '../src/pro/ports.js';
import { FileLicenseVault } from '../src/pro/vault.js';

const LICENSE: StoredLicense = { v: 1, key: 'tpro_ABCDEFGH-JKMNPQRS-TVWXYZ01-23456789', token: 'tpro1.payload.signature', savedAt: 1_800_000_000 };

let root: string;
let path: string;
const mode = (p: string) => statSync(p).mode & 0o777;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'timmy-vault-'));
  path = join(root, 'pro', 'license.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function storageError(read: () => unknown): LicenseStorageError {
  let caught: unknown = null;
  try { read(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LicenseStorageError);
  return caught as LicenseStorageError;
}

describe('FileLicenseVault', () => {
  it('writes a 0600 file inside a 0700 directory and reads it back', () => {
    const vault = new FileLicenseVault(path);
    vault.write(LICENSE);
    expect(mode(join(root, 'pro'))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(vault.read()).toEqual(LICENSE);
    expect(vault.location).toBe(path);
  });

  it('keeps a license whose token was dropped, with the problem that dropped it', () => {
    const vault = new FileLicenseVault(path);
    const stored: StoredLicense = { ...LICENSE, token: null, problem: { reason: 'subscription_inactive', at: 1_800_000_100, subscriptionStatus: 'past_due' } };
    vault.write(stored);
    expect(vault.read()).toEqual(stored);
  });

  it('reads a missing file as no license', () => {
    expect(new FileLicenseVault(path).read()).toBeNull();
  });

  it('refuses to guess at a corrupt, newer-format or wrong-shaped file', () => {
    const vault = new FileLicenseVault(path);
    mkdirSync(join(root, 'pro'), { recursive: true });
    for (const content of ['not json', '[]', JSON.stringify({ ...LICENSE, v: 2 }), JSON.stringify({ ...LICENSE, key: 7 }), JSON.stringify({ v: 1, key: LICENSE.key, savedAt: 1 })]) {
      writeFileSync(path, content);
      const error = storageError(() => vault.read());
      expect(error.operation, content).toBe('read');
    }
  });

  it('keeps the key when only the problem field is unrecognized', () => {
    const vault = new FileLicenseVault(path);
    mkdirSync(join(root, 'pro'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...LICENSE, token: null, problem: { reason: 'bored', at: 1 } }));
    expect(vault.read()).toEqual({ ...LICENSE, token: null });
  });

  it('reads without touching the file; the next write tightens it', () => {
    const vault = new FileLicenseVault(path);
    vault.write(LICENSE);
    chmodSync(path, 0o644);
    expect(vault.read()).toEqual(LICENSE);
    expect(mode(path)).toBe(0o644);
    vault.write(LICENSE);
    expect(mode(path)).toBe(0o600);
  });

  it('replaces the file without leaving temporary files behind', () => {
    const vault = new FileLicenseVault(path);
    vault.write(LICENSE);
    vault.write({ ...LICENSE, token: 'tpro1.next.signature' });
    expect(readdirSync(join(root, 'pro'))).toEqual(['license.json']);
    expect(vault.read()?.token).toBe('tpro1.next.signature');
  });

  it('reports a failed write as a storage error and leaves no temporary file', () => {
    mkdirSync(join(path, 'occupied'), { recursive: true });
    const error = storageError(() => new FileLicenseVault(path).write(LICENSE));
    expect(error.operation).toBe('write');
    expect(readdirSync(join(root, 'pro'))).toEqual(['license.json']);
  });

  it('clear removes the file and reports whether one existed', () => {
    const vault = new FileLicenseVault(path);
    vault.write(LICENSE);
    expect(vault.clear()).toBe(true);
    expect(vault.read()).toBeNull();
    expect(vault.clear()).toBe(false);
  });
});
