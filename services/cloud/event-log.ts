/**
 * Timmy Cloud's backend: the append-only event log.
 *
 * One JSON object per line in `<data>/events.jsonl` (mode 0600, its folder 0700). Every append writes the whole line and
 * then fsyncs before it returns, so an event the backend has acted on is on disk. Nothing in the file is ever rewritten
 * or removed.
 *
 * A crash can cut the last line short. On open, a last line with no end of line is reported as unreadable and kept as it
 * is; a mark and a newline are written after it, so the next event starts on its own line and the cut line can never be
 * read as an event later (a cut line can be a whole event short of only its newline: it was not applied when it was
 * found, so it is never applied). Any other line that does not parse as an event is reported the same way and skipped:
 * the state is rebuilt from the events that can be read, and the overview names the lines that could not.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudEvent } from './types.js';
import { isCloudEvent } from './reducer.js';
import { crashNow, type Failpoints } from './failpoints.js';

export interface UnreadableLine { line: number; bytes: number; why: string }

export interface LogContents {
  events: CloudEvent[];
  unreadable: UnreadableLine[];
}

export const EVENTS_FILE = 'events.jsonl';
export const LOCK_FILE = 'backend.lock';

/** Refused at start: another backend holds the data folder, or the folder cannot be used. Words only, no path. */
export class DataFolderError extends Error {}
/** Written after a cut line when the log is next opened: not whitespace, so the line can never parse as JSON. */
export const CUT_MARK = ' #cut-short-by-a-crash';

/** Reads a log's text: the events, and the lines that are not events (with why). */
export function parseLog(text: string): LogContents {
  const events: CloudEvent[] = [];
  const unreadable: UnreadableLine[] = [];
  if (!text) return { events, unreadable };
  const parts = text.split('\n');
  const tail = parts.pop() ?? '';
  parts.forEach((line, i) => {
    if (line === '') return;
    if (line.endsWith(CUT_MARK)) {
      unreadable.push({ line: i + 1, bytes: Buffer.byteLength(line), why: 'a write cut short by a crash (marked when the log was next opened): kept as it was and never applied' });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      unreadable.push({ line: i + 1, bytes: Buffer.byteLength(line), why: 'not JSON: kept as it was and not applied' });
      return;
    }
    if (!isCloudEvent(parsed)) {
      unreadable.push({ line: i + 1, bytes: Buffer.byteLength(line), why: 'JSON, but not an event this backend knows: kept as it was and not applied' });
      return;
    }
    events.push(parsed);
  });
  if (tail !== '') {
    unreadable.push({ line: parts.length + 1, bytes: Buffer.byteLength(tail), why: 'a last line with no end of line: a write cut short by a crash, kept as it was and not applied' });
  }
  return { events, unreadable };
}

export class EventLog {
  readonly path: string;
  private fd: number | null;
  /** A write failed part-way (a full disk): nothing more is written, so the next event cannot land on the cut line. */
  private broken = false;

  private constructor(path: string, fd: number, private readonly lockPath: string, private readonly failpoints: Failpoints | null) {
    this.path = path;
    this.fd = fd;
  }

  /** Opens (or creates) the log in `dir` and reads what is in it. One backend at a time: the folder is locked. */
  static open(dir: string, failpoints: Failpoints | null = null): { log: EventLog; contents: LogContents } {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { throw folderError(e); }
    const lockPath = join(dir, LOCK_FILE);
    takeLock(lockPath);
    try {
      return EventLog.openLocked(dir, lockPath, failpoints);
    } catch (e) {
      releaseLock(lockPath);
      throw e instanceof DataFolderError ? e : folderError(e);
    }
  }

  private static openLocked(dir: string, lockPath: string, failpoints: Failpoints | null): { log: EventLog; contents: LogContents } {
    const path = join(dir, EVENTS_FILE);
    const existed = existsSync(path);
    const text = existed ? readFileSync(path, 'utf8') : '';
    const contents = parseLog(text);
    const fd = openSync(path, 'a', 0o600);
    if (!existed) fsyncDir(dir);
    // A cut last line stays as it is, marked so it never parses later; the next event starts on a line of its own.
    if (text !== '' && !text.endsWith('\n')) { writeAll(fd, `${CUT_MARK}\n`); fsyncSync(fd); }
    return { log: new EventLog(path, fd, lockPath, failpoints), contents };
  }

  /** Writes one event as one line and makes it durable before returning. */
  append(event: CloudEvent): void {
    if (this.fd === null) throw new DataFolderError('The event log is closed.');
    if (this.broken) throw new DataFolderError('The event log could not be written earlier: nothing more is written until the backend is restarted (which marks the cut line).');
    const line = `${JSON.stringify(event)}\n`;
    this.failpoints?.crashIfReached('log:before-write');
    if (this.failpoints?.reached('log:mid-write')) {
      writeAll(this.fd, line.slice(0, Math.max(1, Math.floor(line.length / 2))));
      fsyncSync(this.fd);
      crashNow();
    }
    try {
      writeAll(this.fd, line);
      fsyncSync(this.fd);
    } catch (e) {
      this.broken = true;
      throw new DataFolderError(`The event log could not be written (${why(e)}).`);
    }
    this.failpoints?.crashIfReached('log:after-write');
  }

  close(): void {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; releaseLock(this.lockPath); }
  }
}

/** The lock names the process that holds it; a lock left by a process that is gone (a crash) is taken over. */
function takeLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw folderError(e);
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
        throw new DataFolderError('Another backend is running on this data folder (its lock names a live process): one backend at a time writes the event log. Nothing was started.');
      }
      try { unlinkSync(lockPath); } catch { /* taken by another start: the next attempt says so */ }
    }
  }
  throw new DataFolderError('The data folder\'s lock could not be taken. Nothing was started.');
}

function releaseLock(lockPath: string): void {
  try { if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) unlinkSync(lockPath); } catch { /* already gone */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'permission denied'
    : code === 'ENOTDIR' || code === 'EEXIST' ? 'a file is in the way of the folder'
      : code === 'ENOSPC' ? 'the disk is full'
        : code === 'EROFS' ? 'the disk is read-only' : (code ?? 'an error');
}

function folderError(e: unknown): DataFolderError {
  return new DataFolderError(`The data folder could not be used (${why(e)}). Nothing was started.`);
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** Makes a new file's name durable in its folder (where the platform allows a folder to be synced). */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); } catch { /* not every platform syncs a folder */ } finally { if (fd !== null) closeSync(fd); }
}
