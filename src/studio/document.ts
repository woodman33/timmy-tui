/**
 * Timmy Canvas, saved by Timmy (fourth order, step 5). The canvas document lives in Timmy's home
 * (`canvas/canvas.json`), so it reopens where it was and the terminal, the page and the browser read
 * the same one. Its source revision is the sha256 of the saved document, as the vision lane uses the
 * term, so a job is tied to exactly what it produced. A save made from an older revision is refused,
 * never merged; an unreadable file is kept aside, never deleted. The jobs ledger (`jobs.json`) lists
 * each canvas job with the revision and source revision it produced, and its receipt once sealed.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Where Timmy keeps the canvas: `<TIMMY_HOME>/canvas`, TIMMY_HOME being ~/timmy unless set. */
export const canvasDir = (env: Record<string, string | undefined>): string => join(env.TIMMY_HOME || join(homedir(), 'timmy'), 'canvas');

/** A folder as the page shows it, resolved: under the home folder as `~/...`, anywhere else in full. */
export function shownPath(path: string, home: string = homedir()): string {
  const at = resolve(path);
  const root = home ? resolve(home) : '';
  return root && (at === root || at.startsWith(`${root}${sep}`)) ? `~${at.slice(root.length)}` : at;
}

/** Larger than any canvas drawn by hand; a document past it is refused with a message. */
export const MAX_CANVAS_BYTES = 25 * 1024 * 1024;
const MAX_JOBS = 200;
const JOB_ID = /^[\w.:-]{1,100}$/;
const RECEIPT_ID = /^[0-9a-f]{8,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface CanvasState {
  revision: number;
  sourceRevision: string | null;
  savedAt: string | null;
  snapshot: unknown;
  /** Said once, when the saved file could not be read and was kept aside. */
  notice?: string;
}

export type SaveResult =
  | { ok: true; revision: number; sourceRevision: string; savedAt: string }
  | { ok: false; conflict: true; revision: number; error: string }
  | { ok: false; error: string; tooLarge?: true };

export interface CanvasJob {
  id: string;
  /** Whether the job's last call succeeded (round R1: a failed call keeps nothing, so the last call is the job's state). */
  ok: boolean;
  calls: number;
  /** How many of its calls failed (each undone on the canvas). Absent in ledgers from before round R1. */
  failed?: number;
  revision: number;
  sourceRevision: string;
  at: string;
  receipt?: string;
  /** R6 (H139): the project the job ran for (its id), as the canvas server stamped the call; absent in ledgers from before R6. */
  project?: string;
}

/**
 * R5 (H133): one line of the drafts record (`drafts.jsonl`, beside the canvas): a draft Timmy proposed (or that was refused before
 * or after it ran), and each decision a person made on one (accepted or discarded), with the canvas revision and source revision
 * that hold it. Appended, never rewritten.
 */
export interface DraftRecord {
  at: string;
  draft: string;
  event: 'proposed' | 'refused' | 'accepted' | 'discarded';
  job: string | null;
  /** How many shapes it had (proposed: drawn; accepted or discarded: kept or removed). */
  shapes: number;
  /** The canvas revision it was made from. */
  from: number | null;
  /** The canvas revision (and its sha256) that holds the event: the save after it. */
  revision: number | null;
  sourceRevision: string | null;
  /** refused: why, in words; stale or changes. */
  why?: string;
  reason?: 'stale' | 'changes';
  /** accepted or discarded: who decided (a person, through this canvas page's session; or the REPL's token), and whether this record holds its proposal. */
  by?: 'page' | 'token';
  proposed?: boolean;
  /** R6 (H139): the project whose board the draft is on (its id); absent in records from before R6. */
  project?: string;
}

export const DRAFT_ID = /^draft-[0-9a-f]{8,32}$/;
const MAX_DRAFT_LINES = 2000;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const isRevision = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** Written whole: a temporary file renamed over the old one, so a crash never leaves half a canvas. */
function writeWhole(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export class CanvasDocuments {
  private readonly file: string;
  private readonly jobsFile: string;
  private readonly draftsFile: string;
  private readonly maxBytes: number;

  constructor(private readonly dir: string, options: { maxBytes?: number } = {}) {
    this.file = join(dir, 'canvas.json');
    this.jobsFile = join(dir, 'jobs.json');
    this.draftsFile = join(dir, 'drafts.jsonl');
    this.maxBytes = options.maxBytes ?? MAX_CANVAS_BYTES;
  }

  /** R5 (H133): the drafts record, oldest first (the last 2000 lines); a line that cannot be read is skipped. */
  drafts(): DraftRecord[] {
    let text = '';
    try { text = readFileSync(this.draftsFile, 'utf8'); } catch { return []; }
    const out: DraftRecord[] = [];
    for (const line of text.split('\n').slice(-MAX_DRAFT_LINES - 1)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as DraftRecord;
        if (r && typeof r === 'object' && typeof r.draft === 'string' && DRAFT_ID.test(r.draft)) out.push(r);
      } catch {
        // a torn line is skipped, never repaired
      }
    }
    return out;
  }

  /** R5 (H133): appends one line to the drafts record (readable by its owner only). */
  recordDraft(entry: Omit<DraftRecord, 'at'> & { at?: string }): DraftRecord {
    if (!DRAFT_ID.test(entry.draft)) throw new Error(`Not a draft id: ${JSON.stringify(entry.draft).slice(0, 40)}`);
    const line = { ...entry, at: entry.at ?? new Date().toISOString() } as DraftRecord;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.draftsFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return line;
  }

  /**
   * R5 (H133): keeps a page's version of the canvas as a copy beside the canvas file (`copies/canvas-r<revision>-<time>.json`),
   * when a newer version is on disk and the page may not save over it. The canvas file is never touched. Returns where it went.
   */
  keepCopy(input: { snapshot?: unknown; revision?: unknown; baseRevision?: unknown }): { ok: true; kept: string; revision: number; sourceRevision: string } | { ok: false; error: string; tooLarge?: true } {
    const { snapshot, revision, baseRevision } = input;
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot) || !isRevision(revision) || !isRevision(baseRevision)) {
      return { ok: false, error: 'Send {"snapshot": {...}, "revision": N, "baseRevision": N}: the page\'s canvas, as a save sends it.' };
    }
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > this.maxBytes) return { ok: false, error: `This canvas is too large to keep (over ${this.maxBytes} bytes).`, tooLarge: true };
    const savedAt = new Date().toISOString();
    const sourceRevision = sha256(text);
    const name = `canvas-r${revision}-${savedAt.replace(/[:.]/g, '-')}.json`;
    const copies = join(this.dir, 'copies');
    mkdirSync(copies, { recursive: true });
    writeWhole(join(copies, name), `${JSON.stringify({ format: 'timmy-canvas-copy', version: 1, revision, baseRevision, savedAt, sourceRevision, snapshot })}\n`);
    return { ok: true, kept: `copies/${name}`, revision, sourceRevision };
  }

  /** The saved canvas, or a blank one. The source revision is always computed from the snapshot read. */
  load(): CanvasState {
    const blank: CanvasState = { revision: 0, sourceRevision: null, savedAt: null, snapshot: null };
    if (!existsSync(this.file)) return blank;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      if (saved.format !== 'timmy-canvas' || !isRevision(saved.revision) || typeof saved.snapshot !== 'object' || saved.snapshot === null) throw new Error('not a Timmy canvas');
      return { revision: saved.revision, sourceRevision: sha256(JSON.stringify(saved.snapshot)), savedAt: typeof saved.savedAt === 'string' ? saved.savedAt : null, snapshot: saved.snapshot };
    } catch {
      const kept = `canvas.json.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(this.file, join(this.dir, kept));
      return { ...blank, notice: `The saved canvas could not be read, so it was kept as ${kept} beside it and this one starts blank.` };
    }
  }

  /**
   * The saved canvas's revision, source revision and save time, read without opening it for use:
   * nothing is moved, even a file that cannot be read (only the canvas page keeps such a file aside).
   */
  peek(): { revision: number | null; sourceRevision: string | null; savedAt: string | null; unreadable?: true } {
    if (!existsSync(this.file)) return { revision: 0, sourceRevision: null, savedAt: null };
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      if (saved.format !== 'timmy-canvas' || !isRevision(saved.revision) || typeof saved.snapshot !== 'object' || saved.snapshot === null) throw new Error('not a Timmy canvas');
      return { revision: saved.revision, sourceRevision: sha256(JSON.stringify(saved.snapshot)), savedAt: typeof saved.savedAt === 'string' ? saved.savedAt : null };
    } catch {
      return { revision: null, sourceRevision: null, savedAt: null, unreadable: true };
    }
  }

  /**
   * R4 (H83): the saved snapshot as it is on disk, read without opening it for use (nothing is moved): null when there is none,
   * or it cannot be read. A save from a page session keeps another project's cards as they are here.
   */
  storedSnapshot(): unknown | null {
    if (!existsSync(this.file)) return null;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      return saved.format === 'timmy-canvas' && typeof saved.snapshot === 'object' && saved.snapshot !== null ? saved.snapshot : null;
    } catch {
      return null;
    }
  }

  /** The revision on disk, without opening the document for use. */
  private savedRevision(): number {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { revision?: unknown };
      return isRevision(saved.revision) ? saved.revision : 0;
    } catch {
      return 0;
    }
  }

  /** Save the page's document at `revision`, if the canvas on disk is still at `baseRevision`. */
  save(input: { snapshot?: unknown; revision?: unknown; baseRevision?: unknown }): SaveResult {
    const { snapshot, revision, baseRevision } = input;
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot) || !isRevision(revision) || !isRevision(baseRevision) || revision < baseRevision) {
      return { ok: false, error: 'Send {"snapshot": {...}, "revision": N, "baseRevision": N}, with revision at least baseRevision.' };
    }
    const current = existsSync(this.file) ? this.savedRevision() : 0;
    if (current !== baseRevision) {
      return { ok: false, conflict: true, revision: current, error: `Another window saved this canvas at revision ${current} after this one opened it. Reload to continue; changes made here since then are not saved.` };
    }
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > this.maxBytes) return { ok: false, error: `This canvas is too large to save (over ${this.maxBytes} bytes).`, tooLarge: true };
    const savedAt = new Date().toISOString();
    const sourceRevision = sha256(text);
    mkdirSync(this.dir, { recursive: true });
    writeWhole(this.file, `${JSON.stringify({ format: 'timmy-canvas', version: 1, revision, savedAt, sourceRevision, snapshot })}\n`);
    return { ok: true, revision, sourceRevision, savedAt };
  }

  /** The canvas jobs, newest first. */
  jobs(): CanvasJob[] {
    try {
      const list = JSON.parse(readFileSync(this.jobsFile, 'utf8')) as unknown;
      return Array.isArray(list) ? (list as CanvasJob[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * A call of job `id` ended, leaving the canvas at `revision` (`sourceRevision`). A failed call marks the job failed. R6 (H139):
   * with the project it ran for (its id), kept on the job.
   */
  recordJob(id: string, call: { ok: boolean; revision: number; sourceRevision: string; project?: string }): CanvasJob {
    if (!JOB_ID.test(id)) throw new Error(`Not a job ID: ${JSON.stringify(id).slice(0, 40)}`);
    if (!SHA256.test(call.sourceRevision) || !isRevision(call.revision)) throw new Error('A job call needs its revision and its source revision (a sha256).');
    if (call.project !== undefined && !/^[0-9a-f]{16}$/.test(call.project)) throw new Error('A job\'s project is its id (16 hex).');
    const list = this.jobs();
    const before = list.find((j) => j.id === id);
    // A ledger from before round R1 has no count: its job failed at least once if it says failed.
    const failedBefore = before ? (before.failed ?? (before.ok ? 0 : 1)) : 0;
    const job: CanvasJob = {
      ...before,
      id,
      ok: call.ok,
      calls: (before?.calls ?? 0) + 1,
      failed: failedBefore + (call.ok ? 0 : 1),
      revision: call.revision,
      sourceRevision: call.sourceRevision,
      ...(call.project ? { project: call.project } : {}),
      at: new Date().toISOString(),
    };
    mkdirSync(this.dir, { recursive: true });
    writeWhole(this.jobsFile, `${JSON.stringify([job, ...list.filter((j) => j.id !== id)].slice(0, MAX_JOBS), null, 1)}\n`);
    return job;
  }

  /** The receipt sealed for job `id` (its short or full hash); false when there is no such job. */
  linkReceipt(id: string, receipt: string): boolean {
    if (!RECEIPT_ID.test(receipt)) throw new Error(`Not a receipt ID: ${JSON.stringify(receipt).slice(0, 40)}`);
    const list = this.jobs();
    const job = list.find((j) => j.id === id);
    if (!job) return false;
    job.receipt = receipt;
    writeWhole(this.jobsFile, `${JSON.stringify(list, null, 1)}\n`);
    return true;
  }
}
