/**
 * Round R4 (H120): decision records, in the project's own folder.
 *
 *   .timmy/decisions/<d + 8 hex>.json   one decision, written once (exclusive create, 0600, flushed) and never edited
 *   .timmy/decisions/index.jsonl        {requestKey, id, at} per decision, appended and flushed after its record
 *   .timmy/decisions/claims/<key>.json  while a request is being decided: {pid, at, id}; removed once it is recorded
 *
 * The same request key returns the recorded decision: no second provider call and no second record, whether the request
 * came twice (duplicate delivery), was retried by its transport, or arrived from another process at the same time (it waits
 * for the claim's holder). A claim left by a process that died is taken over; if that process had already written its
 * record, the record is indexed and returned, never decided again. An index entry whose record cannot be read is refused
 * in words, never decided over.
 *
 * The operator's rule it keeps: a record is kept, never rewritten; nothing here calls a provider, and a record never holds a
 * secret (the service writes only what src/decision/service.ts built from redacted words).
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DECISION_SCHEMA, type DecisionRecord } from './types.js';

export const DECISIONS_DIR = join('.timmy', 'decisions');
export const DECISION_ID = /^d[0-9a-f]{8}$/;
/** A claim older than this is taken over even when its process id is alive (that id may have been reused). */
export const CLAIM_STALE_MS = 10 * 60_000;

export const decisionsDir = (root: string): string => join(root, DECISIONS_DIR);
export const recordRel = (id: string): string => join(DECISIONS_DIR, `${id}.json`);
const indexPath = (root: string): string => join(decisionsDir(root), 'index.jsonl');
const claimPath = (root: string, key: string): string => join(decisionsDir(root), 'claims', `${createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`);

/** Why a decision could not be recorded or read back; the caller refuses (the CLI exits 1). Its words never hold a secret. */
export class DecisionRefused extends Error {
  constructor(readonly refusal: 'not recorded' | 'unreadable record' | 'in progress elsewhere', readonly why: string) {
    super(`${refusal}: ${why}`);
  }
}

const newId = (): string => `d${randomBytes(4).toString('hex')}`;

export type RecordRead = { ok: true; record: DecisionRecord } | { ok: false; why: string };

/** One recorded decision by its id. */
export function readDecision(root: string, id: string): RecordRead {
  if (!DECISION_ID.test(id)) return { ok: false, why: `${JSON.stringify(id)} is not a decision id (d and 8 hex digits)` };
  let text: string;
  try { text = readFileSync(join(decisionsDir(root), `${id}.json`), 'utf8'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, why: code === 'ENOENT' ? `no decision ${id} in this project` : `decision ${id} cannot be read (${code ?? 'error'})` };
  }
  try {
    const r = JSON.parse(text) as DecisionRecord;
    if (!r || r.schema !== DECISION_SCHEMA || r.id !== id) return { ok: false, why: `${recordRel(id)} is not a decision record` };
    return { ok: true, record: r };
  } catch {
    return { ok: false, why: `${recordRel(id)} is not JSON` };
  }
}

/** The recorded decisions, oldest first; with operationId, only that operation's. Files that are not records are skipped. */
export function listDecisions(root: string, o: { operationId?: string } = {}): DecisionRecord[] {
  let names: string[];
  try { names = readdirSync(decisionsDir(root)).filter((n) => /^d[0-9a-f]{8}\.json$/.test(n)); } catch { return []; }
  const out: DecisionRecord[] = [];
  for (const n of names) {
    const r = readDecision(root, n.slice(0, -5));
    if (r.ok && (o.operationId === undefined || r.record.operationId === o.operationId)) out.push(r.record);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function indexEntries(root: string): Array<{ requestKey: string; id: string }> {
  let text: string;
  try { text = readFileSync(indexPath(root), 'utf8'); } catch { return []; }
  const out: Array<{ requestKey: string; id: string }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { requestKey?: unknown; id?: unknown };
      if (typeof e.requestKey === 'string' && typeof e.id === 'string' && DECISION_ID.test(e.id)) out.push({ requestKey: e.requestKey, id: e.id });
    } catch { /* a torn last line from a crash is skipped, never guessed */ }
  }
  return out;
}

/**
 * The decision recorded for this request key, if any. An entry whose record is gone is passed over; one whose record
 * cannot be read, or belongs to another request, is refused (never decided over).
 */
export function findRecorded(root: string, requestKey: string): { record: DecisionRecord; file: string } | undefined {
  for (const e of indexEntries(root)) {
    if (e.requestKey !== requestKey) continue;
    const r = readDecision(root, e.id);
    if (r.ok) {
      if (r.record.requestKey !== requestKey) throw new DecisionRefused('unreadable record', `the index names ${recordRel(e.id)} for this request, but that record is another request's`);
      return { record: r.record, file: recordRel(e.id) };
    }
    if (!/^no decision/.test(r.why)) throw new DecisionRefused('unreadable record', r.why);
  }
  return undefined;
}

function appendIndex(root: string, requestKey: string, id: string, at: string): void {
  const fd = openSync(indexPath(root), 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ requestKey, id, at })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const words = (e: unknown): string => ((e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e)));

function ensureDir(dir: string): void {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
    throw new DecisionRefused('not recorded', `the decisions folder ${DECISIONS_DIR} cannot be written (${words(e)})`);
  }
}

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

export type Claim =
  | { kind: 'mine'; id: string; release: () => void }
  | { kind: 'held'; pid: number }
  | { kind: 'recorded'; record: DecisionRecord; file: string };

/**
 * Claims a request before it is decided, so no other process asks the same thing at the same time. The claim names the
 * record id it will be written under; a dead holder's claim is taken over, and its record indexed if it was written.
 */
export function claim(root: string, requestKey: string): Claim {
  ensureDir(join(decisionsDir(root), 'claims'));
  const file = claimPath(root, requestKey);
  for (let attempt = 0; attempt < 3; attempt++) {
    let id = newId();
    while (statSafe(join(decisionsDir(root), `${id}.json`))) id = newId();
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      let released = false;
      return { kind: 'mine', id, release: () => { if (released) return; released = true; try { unlinkSync(file); } catch { /* gone */ } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new DecisionRefused('not recorded', `a claim cannot be written in ${DECISIONS_DIR} (${words(e)})`);
    }
    let held: { pid?: number; at?: string; id?: string } = {};
    try { held = JSON.parse(readFileSync(file, 'utf8')) as typeof held; } catch { /* torn or empty: taken over below */ }
    const age = held.at ? Date.now() - Date.parse(held.at) : Number.POSITIVE_INFINITY;
    if (typeof held.pid === 'number' && alive(held.pid) && age < CLAIM_STALE_MS) return { kind: 'held', pid: held.pid };
    // the holder is gone: if it wrote its record, index it and return it; otherwise take the claim over
    if (held.id && DECISION_ID.test(held.id)) {
      const r = readDecision(root, held.id);
      if (r.ok && r.record.requestKey === requestKey) {
        if (!indexEntries(root).some((x) => x.id === held.id)) appendIndex(root, requestKey, held.id, r.record.createdAt);
        try { unlinkSync(file); } catch { /* gone */ }
        return { kind: 'recorded', record: r.record, file: recordRel(held.id) };
      }
    }
    try { unlinkSync(file); } catch { /* another process took it over first */ }
  }
  throw new DecisionRefused('in progress elsewhere', 'the claim on this request keeps changing hands; ask again');
}

function statSafe(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

/** Writes a record under the id its claim named: exclusive create, 0600, flushed; then the index line, flushed. */
export function writeDecision(root: string, record: DecisionRecord): string {
  ensureDir(decisionsDir(root));
  const file = join(decisionsDir(root), `${record.id}.json`);
  let fd: number;
  try { fd = openSync(file, 'wx', 0o600); } catch (e) {
    throw new DecisionRefused('not recorded', `${recordRel(record.id)} cannot be created (${words(e)})`);
  }
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } catch (e) {
    throw new DecisionRefused('not recorded', `${recordRel(record.id)} cannot be written (${words(e)})`);
  } finally {
    closeSync(fd);
  }
  try { appendIndex(root, record.requestKey, record.id, record.createdAt); } catch (e) {
    throw new DecisionRefused('not recorded', `the decision index cannot be written (${words(e)}); ${recordRel(record.id)} was kept`);
  }
  return recordRel(record.id);
}

/** Waits for another process's decision of this request to be recorded (its claim held), up to `ms`. */
export async function waitForRecorded(root: string, requestKey: string, ms: number): Promise<{ record: DecisionRecord; file: string } | undefined> {
  const until = Date.now() + ms;
  for (;;) {
    const found = findRecorded(root, requestKey);
    if (found) return found;
    const c = claimStateOf(root, requestKey);
    if (c === 'none' || Date.now() > until) return findRecorded(root, requestKey);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function claimStateOf(root: string, requestKey: string): 'held' | 'none' {
  try { readFileSync(claimPath(root, requestKey)); return 'held'; } catch { return 'none'; }
}
