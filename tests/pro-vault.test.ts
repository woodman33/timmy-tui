import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredLicense } from '../src/pro/ports.js';
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

describe('FileLicenseVault', () => {
  it('writes a 0600 file inside a 0700 directory and reads it back', () => {
    const vault = new FileLicenseVault(path);
    vault.write(LICENSE);
    expect(mode(join(root, 'pro'))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(vault.read()).toEqual(LICENSE);
    expect(vault.location).toBe(path);
  });

  it('keeps a license whose token was dropped', () => {
    const vault = new FileLicenseVault(path);
    vault.write({ ...LICENSE, token: null });
    expect(vault.read()).toEqual({ ...LICENSE, token: null });
  });

  it('keeps a refusal the service gave, and rejects a malformed one', () => {
    const vault = new FileLicenseVault(path);
    const refused: StoredLicense = { ...LICENSE, token: null, refusal: { reason: 'key_revoked', at: 1_800_000_100 } };
    vault.write(refused);
    expect(vault.read()).toEqual(refused);
    writeFileSync(path, JSON.stringify({ ...refused, refusal: { reason: 'bored', at: 1 } }));
    expect(vault.read()).toBeNull();
  });

  it('reads a missing, corrupt or wrong-shaped file as null', () => {
    const vault = new FileLicenseVault(path);
    expect(vault.read()).toBeNull();
    mkdirSync(join(root, 'pro'), { recursive: true });
    for (const content of ['not json', '[]', JSON.stringify({ ...LICENSE, v: 2 }), JSON.stringify({ ...LICENSE, key: 7 }), JSON.stringify({ v: 1, key: LICENSE.key, savedAt: 1 })]) {
      writeFileSync(path, content);
      expect(vault.read(), content).toBeNull();
    }
  });

  it('tightens a loosely permissioned file on read', () => {
    const vault = new FileLicenseVault(path);
    vault.write(LICENSE);
    chmodSync(path, 0o644);
    expect(vault.read()).toEqual(LICENSE);
    expect(mode(path)).toBe(0o600);
  });

  it('replaces the file without leaving temporary files behind', () => {
    const vault = new FileLicenseVault(path);
    vault.write(LICENSE);
    vault.write({ ...LICENSE, token: 'tpro1.next.signature' });
    expect(readdirSync(join(root, 'pro'))).toEqual(['license.json']);
    expect(vault.read()?.token).toBe('tpro1.next.signature');
  });

  it('clear removes the file and reports whether one existed', () => {
    const vault = new FileLicenseVault(path);
    vault.write(LICENSE);
    expect(vault.clear()).toBe(true);
    expect(vault.read()).toBeNull();
    expect(vault.clear()).toBe(false);
  });
});
