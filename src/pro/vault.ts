// The Pro files on this machine, readable only by their owner (0600 in a 0700
// directory) and replaced atomically on every write:
//   <TIMMY_HOME>/pro/license.json    the license (FileLicenseVault)
//   <TIMMY_HOME>/pro/checkout.json   the checkout `upgrade` has open (FileCheckoutStore)
//
// read() never guesses: no file means none, and a file it cannot read or
// understand is a LicenseStorageError, never "none" (that would invite a second
// purchase). Reading changes nothing; writing tightens permissions.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LicenseStorageError, PERSISTED_PROBLEMS, type CheckoutStore, type LicenseVault, type OpenCheckout, type StoredLicense, type StoredProblem } from './ports.js';
import { CHECKOUT_SESSION_ID } from './protocol.js';

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

export class FileLicenseVault implements LicenseVault {
  private readonly file: PrivateJsonFile;

  constructor(readonly location: string) {
    this.file = new PrivateJsonFile(location, 'license file');
  }

  read(): StoredLicense | null {
    const content = this.file.read();
    if (!content.found) return null;
    const license = toStoredLicense(content.value);
    if (!license) throw this.file.unreadable('is not a license this version of Timmy understands');
    return license;
  }

  write(license: StoredLicense): void {
    this.file.write(license);
  }

  clear(): boolean {
    return this.file.clear();
  }
}

export class FileCheckoutStore implements CheckoutStore {
  private readonly file: PrivateJsonFile;

  constructor(readonly location: string) {
    this.file = new PrivateJsonFile(location, 'checkout record');
  }

  read(): OpenCheckout | null {
    const content = this.file.read();
    if (!content.found) return null;
    const checkout = toOpenCheckout(content.value);
    if (!checkout) throw this.file.unreadable('is not a checkout record this version of Timmy understands');
    return checkout;
  }

  write(checkout: OpenCheckout): void {
    this.file.write(checkout);
  }

  clear(): boolean {
    return this.file.clear();
  }
}

/** One owner-only JSON file. Every failure is a LicenseStorageError naming the file and the operation. */
class PrivateJsonFile {
  constructor(readonly location: string, private readonly subject: LicenseStorageError['subject']) {}

  read(): { found: false } | { found: true; value: unknown } {
    let text: string;
    try {
      text = readFileSync(this.location, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { found: false };
      throw new LicenseStorageError(`cannot read ${this.location}: ${messageOf(error)}`, 'read', this.subject);
    }
    try {
      return { found: true, value: JSON.parse(text) };
    } catch {
      throw this.unreadable('is not valid JSON');
    }
  }

  write(value: unknown): void {
    const temp = `${this.location}.${process.pid}.tmp`;
    try {
      const dir = dirname(this.location);
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
      chmodSync(dir, PRIVATE_DIR);
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE });
      chmodSync(temp, PRIVATE_FILE);
      renameSync(temp, this.location);
    } catch (error) {
      throw new LicenseStorageError(`cannot write ${this.location}: ${messageOf(error)}`, 'write', this.subject);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  clear(): boolean {
    try {
      unlinkSync(this.location);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw new LicenseStorageError(`cannot remove ${this.location}: ${messageOf(error)}`, 'clear', this.subject);
    }
  }

  /** The file exists but its contents cannot be used. */
  unreadable(why: string): LicenseStorageError {
    return new LicenseStorageError(`${this.location} ${why}`, 'read', this.subject);
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

function toStoredProblem(value: unknown): StoredProblem | null {
  if (typeof value !== 'object' || value === null) return null;
  const problem = value as Record<string, unknown>;
  if (!(PERSISTED_PROBLEMS as readonly unknown[]).includes(problem.reason) || typeof problem.at !== 'number') return null;
  const stored: StoredProblem = { reason: problem.reason as StoredProblem['reason'], at: problem.at };
  if (typeof problem.subscriptionStatus === 'string') stored.subscriptionStatus = problem.subscriptionStatus;
  return stored;
}

/**
 * A v1 checkout record, or null. Its session id goes to the service and its link to a browser opener,
 * so a record that names anything but a Stripe Checkout session behind an https link is damaged.
 */
function toOpenCheckout(value: unknown): OpenCheckout | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.sessionId !== 'string' || typeof record.url !== 'string' || typeof record.openedAt !== 'number') return null;
  if (!CHECKOUT_SESSION_ID.test(record.sessionId) || !isHttpsLink(record.url)) return null;
  return { v: 1, sessionId: record.sessionId, url: record.url, openedAt: record.openedAt };
}

function isHttpsLink(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
