// The license file on this machine: <TIMMY_HOME>/pro/license.json, readable only
// by its owner (0600 in a 0700 directory), replaced atomically on every write.
//
// read() never guesses: no file means no license, and a file it cannot read or
// understand is a LicenseStorageError, never "no license" (that would invite a
// second purchase). Reading changes nothing; writing tightens permissions.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LicenseStorageError, PERSISTED_PROBLEMS, type LicenseVault, type PendingCheckout, type StoredLicense, type StoredProblem } from './ports.js';

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

export class FileLicenseVault implements LicenseVault {
  constructor(readonly location: string) {}

  private get checkoutLocation(): string {
    return `${this.location}.checkout.json`;
  }

  read(): StoredLicense | null {
    let text: string;
    try {
      text = readFileSync(this.location, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw new LicenseStorageError(`cannot read ${this.location}: ${messageOf(error)}`, 'read');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LicenseStorageError(`${this.location} is not valid JSON`, 'read');
    }
    const license = toStoredLicense(parsed);
    if (!license) throw new LicenseStorageError(`${this.location} is not a license this version of Timmy understands`, 'read');
    return license;
  }

  write(license: StoredLicense): void {
    const temp = `${this.location}.${process.pid}.tmp`;
    try {
      const dir = dirname(this.location);
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
      chmodSync(dir, PRIVATE_DIR);
      writeFileSync(temp, `${JSON.stringify(license, null, 2)}\n`, { mode: PRIVATE_FILE });
      chmodSync(temp, PRIVATE_FILE);
      renameSync(temp, this.location);
    } catch (error) {
      throw new LicenseStorageError(`cannot write ${this.location}: ${messageOf(error)}`, 'write');
    } finally {
      rmSync(temp, { force: true });
    }
  }

  readPendingCheckout(): PendingCheckout | null {
    let text: string;
    try {
      text = readFileSync(this.checkoutLocation, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw new LicenseStorageError(`cannot read ${this.checkoutLocation}: ${messageOf(error)}`, 'read');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LicenseStorageError(`${this.checkoutLocation} is not valid JSON`, 'read');
    }
    const checkout = toPendingCheckout(parsed);
    if (!checkout) throw new LicenseStorageError(`${this.checkoutLocation} is not a checkout this version of Timmy understands`, 'read');
    return checkout;
  }

  writePendingCheckout(checkout: PendingCheckout): void {
    try {
      const dir = dirname(this.checkoutLocation);
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
      chmodSync(dir, PRIVATE_DIR);
      writeFileSync(this.checkoutLocation, `${JSON.stringify(checkout, null, 2)}\n`, { flag: 'wx', mode: PRIVATE_FILE });
      chmodSync(this.checkoutLocation, PRIVATE_FILE);
    } catch (error) {
      throw new LicenseStorageError(`cannot write ${this.checkoutLocation}: ${messageOf(error)}`, 'write');
    }
  }

  clearPendingCheckout(): boolean {
    try {
      unlinkSync(this.checkoutLocation);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw new LicenseStorageError(`cannot remove ${this.checkoutLocation}: ${messageOf(error)}`, 'clear');
    }
  }

  clear(): boolean {
    let removed = false;
    try {
      unlinkSync(this.location);
      removed = true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new LicenseStorageError(`cannot remove ${this.location}: ${messageOf(error)}`, 'clear');
    }
    return this.clearPendingCheckout() || removed;
  }
}

/** A v1 license, or null. An unrecognized `problem` or `nextRefreshAt` is dropped rather than losing the key. */
function toStoredLicense(value: unknown): StoredLicense | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.key !== 'string' || typeof record.savedAt !== 'number') return null;
  if (typeof record.token !== 'string' && record.token !== null) return null;
  const license: StoredLicense = { v: 1, key: record.key, token: record.token, savedAt: record.savedAt };
  const problem = toStoredProblem(record.problem);
  if (problem) license.problem = problem;
  if (typeof record.nextRefreshAt === 'number') license.nextRefreshAt = record.nextRefreshAt;
  return license;
}

function toPendingCheckout(value: unknown): PendingCheckout | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.url !== 'string' || typeof record.sessionId !== 'string' || typeof record.startedAt !== 'number') return null;
  return { v: 1, url: record.url, sessionId: record.sessionId, startedAt: record.startedAt };
}

function toStoredProblem(value: unknown): StoredProblem | null {
  if (typeof value !== 'object' || value === null) return null;
  const problem = value as Record<string, unknown>;
  if (!(PERSISTED_PROBLEMS as readonly unknown[]).includes(problem.reason) || typeof problem.at !== 'number') return null;
  const stored: StoredProblem = { reason: problem.reason as StoredProblem['reason'], at: problem.at };
  if (typeof problem.subscriptionStatus === 'string') stored.subscriptionStatus = problem.subscriptionStatus;
  return stored;
}

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
