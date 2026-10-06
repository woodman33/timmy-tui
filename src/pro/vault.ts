// The license file on this machine: <TIMMY_HOME>/pro/license.json, readable only
// by its owner (0600 in a 0700 directory), replaced atomically on every write.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StoredLicense {
  v: 1;
  /** The license key, as issued (`tpro_XXXXXXXX-…`). */
  key: string;
  /** The latest signed license token, or null when none is held. */
  token: string | null;
  /** Unix seconds of the last write. */
  savedAt: number;
}

export interface LicenseVault {
  readonly location: string;
  read(): StoredLicense | null;
  write(license: StoredLicense): void;
  /** Removes the stored license; true when there was one. */
  clear(): boolean;
}

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

export class FileLicenseVault implements LicenseVault {
  constructor(readonly location: string) {}

  read(): StoredLicense | null {
    let text: string;
    try {
      text = readFileSync(this.location, 'utf8');
    } catch {
      return null;
    }
    if ((statSync(this.location).mode & 0o077) !== 0) chmodSync(this.location, PRIVATE_FILE);
    try {
      const parsed: unknown = JSON.parse(text);
      return isStoredLicense(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  write(license: StoredLicense): void {
    const dir = dirname(this.location);
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
    chmodSync(dir, PRIVATE_DIR);
    const temp = `${this.location}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(license, null, 2)}\n`, { mode: PRIVATE_FILE });
      chmodSync(temp, PRIVATE_FILE);
      renameSync(temp, this.location);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  clear(): boolean {
    if (!existsSync(this.location)) return false;
    unlinkSync(this.location);
    return true;
  }
}

function isStoredLicense(value: unknown): value is StoredLicense {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1
    && typeof record.key === 'string'
    && (typeof record.token === 'string' || record.token === null)
    && typeof record.savedAt === 'number';
}
