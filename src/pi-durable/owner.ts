/**
 * Pi Durable, slice S1 (R4 H118): the owner record, <project>/.timmy/pi/worker.json (plan b.1.4). It is how any Timmy
 * process finds the project's Pi worker: its pid and process start (the writerState proof src/ops/process-proof.ts gives
 * recovery: a pid alone is never enough, pids are reused), its socket, and the sha256 of the token a client presents.
 * The token itself is in worker.token beside it. Both are 0600 and written through a temp file and a rename, so a reader
 * sees the old record or the new one, never half of one. Only the worker writes them, and only after it holds the store's
 * lock; it removes them when it exits cleanly.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { THIS_PROCESS, writerState } from '../ops/process-proof.js';
import type { PiPaths } from './paths.js';

export const OWNER_SCHEMA = 'timmy.pi-worker/1';

export interface OwnerRecord {
  readonly schema: typeof OWNER_SCHEMA;
  readonly pid: number;
  /** when the worker process started (writerState proof) */
  readonly started: string;
  readonly project_id: string;
  /** project-relative */
  readonly store: string;
  readonly socket: string;
  readonly token_sha256: string;
  readonly pins: Record<string, string>;
  readonly node: string;
  readonly scheduling: 'paused' | 'running';
  /** S1: what the worker does when Timmy exits. "pause" is the plan's proposed default; the operator has not decided it. */
  readonly setting: { readonly on_exit: 'pause' };
  readonly written: string;
}

export const sha256Hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Writes a file 0600 through a temp file and a rename. */
export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readOwner(paths: PiPaths): OwnerRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(paths.owner, 'utf8')) as OwnerRecord;
    return r && r.schema === OWNER_SCHEMA && typeof r.pid === 'number' ? r : undefined;
  } catch { return undefined; }
}

/** Whether the process the record names is the one that wrote it and still runs ('unknown': treat as alive). */
export const ownerState = (r: OwnerRecord | undefined): 'alive' | 'gone' | 'unknown' => writerState(r);

/** A fresh random token for this worker life: its text goes to worker.token, its sha256 into worker.json. */
export const newToken = (): string => randomBytes(32).toString('hex');

export function readToken(paths: PiPaths): string | undefined {
  try { return readFileSync(paths.token, 'utf8').trim() || undefined; } catch { return undefined; }
}

/** The worker publishes itself: the token first, then the record naming its hash (a reader that sees the record finds its token). */
export function publishOwner(paths: PiPaths, token: string, fields: Omit<OwnerRecord, 'schema' | 'pid' | 'started' | 'token_sha256' | 'written'>): OwnerRecord {
  writePrivate(paths.token, `${token}\n`);
  const record: OwnerRecord = { schema: OWNER_SCHEMA, pid: THIS_PROCESS.pid, started: THIS_PROCESS.started, token_sha256: sha256Hex(token), ...fields, written: new Date().toISOString() };
  writePrivate(paths.owner, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Updates this worker's own record (its scheduling word); never another process's. */
export function updateOwner(paths: PiPaths, change: Partial<Pick<OwnerRecord, 'scheduling'>>): void {
  const r = readOwner(paths);
  if (!r || r.pid !== THIS_PROCESS.pid || r.started !== THIS_PROCESS.started) return;
  writePrivate(paths.owner, `${JSON.stringify({ ...r, ...change, written: new Date().toISOString() }, null, 2)}\n`);
}

/** At a clean exit: removes the record and the token, only when they are this process's own. */
export function withdrawOwner(paths: PiPaths): void {
  const r = readOwner(paths);
  if (!r || r.pid !== THIS_PROCESS.pid || r.started !== THIS_PROCESS.started) return;
  rmSync(paths.owner, { force: true });
  rmSync(paths.token, { force: true });
}
