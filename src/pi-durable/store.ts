/**
 * Pi Durable, slice S1 (R4 H118): the store, <project>/.timmy/private/pi/store.sqlite, opened only by the Pi worker
 * (plan b.1.3).
 *
 * pi-durable has no cross-process lock (its README: "one process owns a storage at a time"), and H115's spike C showed
 * what a second opener does to a live store: it turned the owner's running task back to pending, and one that also
 * resumed re-ran the call while the owner re-executed it every 8 s. So the worker opens its own connection and sets
 * `PRAGMA locking_mode = EXCLUSIVE` before WAL (the WAL index then lives in this process's memory), then takes the lock
 * at once with a write transaction. A second opener fails with "database is locked" (SQLITE_BUSY), and the operating
 * system releases the lock when the holder dies, however it dies (spike I). The connection is handed to pi-durable's
 * SQLite storage through the adapter; nothing else in Timmy opens this file.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** How long an opener waits for a competing lock before it reports the store owned (a dying holder's lock is released at once). */
export const LOCK_WAIT_MS = Number(process.env.TIMMY_PI_LOCK_WAIT_MS ?? 2000);

export class StoreLocked extends Error {
  constructor(readonly path: string, readonly cause: unknown) { super('database is locked'); this.name = 'StoreLocked'; }
}

const busy = (e: unknown): boolean => {
  const err = e as { errcode?: number; code?: string; message?: string };
  return err?.errcode === 5 || err?.errcode === 6 || /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(err?.message ?? ''));
};

/**
 * Opens the store with an exclusive lock held for this connection's whole life, or throws StoreLocked. `node:sqlite` is
 * imported here, at the call, so the worker can quiet its experimental-feature warning (Node 22) before it loads.
 */
export async function openExclusive(path: string, waitMs = LOCK_WAIT_MS): Promise<DatabaseSync> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync: Sync } = await import('node:sqlite');
  let raw: DatabaseSync | undefined;
  try {
    raw = new Sync(path, { timeout: waitMs });
    raw.exec('PRAGMA locking_mode = EXCLUSIVE'); // before WAL: the WAL index is kept in this process's memory
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA wal_autocheckpoint = 1000');
    raw.exec('BEGIN EXCLUSIVE'); // take the lock now; in EXCLUSIVE locking mode it is never given back while open
    raw.exec('COMMIT');
    chmodSync(path, 0o600);
    return raw;
  } catch (e) {
    try { raw?.close(); } catch { /* it was never fully open */ }
    if (busy(e)) throw new StoreLocked(path, e);
    throw e;
  }
}
