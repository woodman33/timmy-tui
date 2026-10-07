/**
 * Timmy Canvas, saved by Timmy (fourth order, step 5). The canvas document lives in Timmy's home
 * (`canvas/canvas.json`), so it reopens where it was and the terminal, the page and the browser read
 * the same one. Its source revision is the sha256 of the saved document, as the vision lane uses the
 * term, so a job is tied to exactly what it produced. A save made from an older revision is refused,
 * never merged; an unreadable file is kept aside, never deleted. The jobs ledger (`jobs.json`) lists
 * each canvas job with the revision and source revision it produced, and its receipt once sealed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where Timmy keeps the canvas: `<TIMMY_HOME>/canvas`, TIMMY_HOME being ~/timmy unless set. */
export const canvasDir = (env: Record<string, string | undefined>): string => join(env.TIMMY_HOME || join(homedir(), 'timmy'), 'canvas');

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
  ok: boolean;
  calls: number;
  revision: number;
  sourceRevision: string;
  at: string;
  receipt?: string;
}

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
  private readonly maxBytes: number;

  constructor(private readonly dir: string, options: { maxBytes?: number } = {}) {
    this.file = join(dir, 'canvas.json');
    this.jobsFile = join(dir, 'jobs.json');
    this.maxBytes = options.maxBytes ?? MAX_CANVAS_BYTES;
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

  /** A call of job `id` ended, leaving the canvas at `revision` (`sourceRevision`). A failed call marks the job failed. */
  recordJob(id: string, call: { ok: boolean; revision: number; sourceRevision: string }): CanvasJob {
    if (!JOB_ID.test(id)) throw new Error(`Not a job ID: ${JSON.stringify(id).slice(0, 40)}`);
    if (!SHA256.test(call.sourceRevision) || !isRevision(call.revision)) throw new Error('A job call needs its revision and its source revision (a sha256).');
    const list = this.jobs();
    const before = list.find((j) => j.id === id);
    const job: CanvasJob = {
      ...before,
      id,
      ok: (before?.ok ?? true) && call.ok,
      calls: (before?.calls ?? 0) + 1,
      revision: call.revision,
      sourceRevision: call.sourceRevision,
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
