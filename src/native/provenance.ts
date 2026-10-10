/**
 * Round R4 (helper H18; an independent review of 07f37ec, findings 5 and 6): what a native run ran, and which
 * of its outputs it made.
 *
 * Finding 5: the app ran the script at its own path, which can change after it is submitted, and the verdict
 * checked what the script read only when the result said. Now a c4dpy or Blender run keeps the script as
 * submitted in the run's own folder (.timmy/native/<run>/source/<name>.py, read-only), checks that copy's
 * sha256 against the submission when it is made and again when the run is judged, and the app runs the copy:
 * what ran is the bytes hashed at submission. The script's own read digest (script_sha256_read, the sha256 of
 * TIMMY_SCRIPT, the file it runs) must agree when it is given; a run with no copy (recorded before R4) needs it.
 *
 * Finding 6: bytes matching a digest do not say which run made them. Before a run, each output path it may be
 * judged on is inventoried (there or not, size, times, sha256): its expected outputs and, for the scripted
 * apps, every file under out/ (TIMMY_OUT, the folder the job tells the script to write in). After the run each
 * output is classified against that inventory: created (not there before), changed (there with other bytes)
 * or reused (there with the same bytes, untouched or rewritten identically). Only created and changed are the
 * run's work; the rest are said so, never counted as made by it.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, type Dirent, type Stats,
} from 'node:fs';
import path from 'node:path';
import { privatePath, resolveInside } from '../project/index.js';
import type { PreState } from './index.js';

/** an output's time may trail the submission by this much (coarse file times) */
export const MTIME_SLACK_MS = 2000;
/** the folder the scripted apps are told to write in (TIMMY_OUT), relative to the project */
export const OUT_FOLDER = 'out';
/** where a run keeps the script it runs, inside its own folder */
const SOURCE_DIR = 'source';
/** the inventory lists at most this many entries under its folders; past it, it is incomplete */
const INVENTORY_ENTRIES = 5000;
/** and hashes at most this many bytes of them (an expected output is always hashed) */
const INVENTORY_HASH_BYTES = 1024 ** 3;
/** and goes at most this deep */
const INVENTORY_DEPTH = 16;

/**
 * A regular file's sha256, read in chunks; undefined when it is not a regular file or cannot be read. It is
 * opened without waiting, so a FIFO found where a file was expected is never blocked on.
 */
export function sha256File(file: string): string | undefined {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, n));
    return hash.digest('hex');
  } catch { return undefined; } finally { closeSync(fd); }
}

const relInside = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

// ── finding 5: the script that runs is the script submitted ─────────────────

/** A script as submitted: its bytes, read once, and their sha256. */
export interface SubmittedScript { path: string; rel: string; bytes: Buffer; sha256: string }

/** Reads a script (a path inside the project, resolved) once: a regular file, never a FIFO waited on. */
export function readSubmittedScript(at: { path: string; rel: string }): SubmittedScript {
  let fd: number;
  try { fd = openSync(at.path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { throw new Error(`no script at ${at.rel}`); }
  let bytes: Buffer;
  try {
    let isFile = false;
    try { isFile = fstatSync(fd).isFile(); } catch { /* unreadable: no script */ }
    if (!isFile) throw new Error(`no script at ${at.rel}`);
    try { bytes = readFileSync(fd); } catch { throw new Error(`${at.rel} cannot be read`); }
  } finally { closeSync(fd); }
  return { ...at, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Keeps the script as submitted in the run's folder (<record>/source/<name>), read-only, and checks that the
 * copy reads back with the submitted sha256. The app runs this copy, so what runs is the bytes hashed at
 * submission whatever happens to the original. Throws (and nothing starts) when the copy cannot be made or
 * does not read back the same.
 */
export function keepScript(root: string, record: string, script: SubmittedScript): { path: string; rel: string; sha256: string } {
  const at = path.join(record, SOURCE_DIR, path.basename(script.path));
  try {
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, script.bytes, { flag: 'wx', mode: 0o444 });
    chmodSync(at, 0o444);
  } catch (e) {
    throw new Error(`the copy of ${script.rel} for this run could not be made (${(e as NodeJS.ErrnoException).code ?? 'an error'}); nothing started`);
  }
  const kept = sha256File(at);
  if (kept !== script.sha256) throw new Error(`the copy of ${script.rel} made for this run does not read back with the submitted sha256; nothing started`);
  return { path: at, rel: relInside(root, at), sha256: kept };
}

/**
 * What the script is told about itself: TIMMY_SCRIPT is the copy it runs (what its read digest is of),
 * TIMMY_SCRIPT_ORIGINAL and TIMMY_SCRIPT_DIR the file and folder it was submitted from, for the files and
 * modules beside it (its __file__ is the copy's).
 */
export function scriptEnv(script: SubmittedScript, copy: { path: string }): Record<string, string> {
  return { TIMMY_SCRIPT: copy.path, TIMMY_SCRIPT_SHA256: script.sha256, TIMMY_SCRIPT_ORIGINAL: script.path, TIMMY_SCRIPT_DIR: path.dirname(script.path) };
}

/** How "what ran is what was submitted" was established for a scripted run, or why it was not. */
export interface SourceCheck {
  /** the copy kept at submission that the app ran, relative to the project; absent for a run recorded before copies were kept */
  copy?: string;
  /** that copy when the run is judged: still the submitted bytes, other bytes, or not there */
  copy_state?: 'intact' | 'changed' | 'gone';
  /** the script's own script_sha256_read against the submission */
  read: 'matches' | 'differs' | 'not reported';
  /** the checks that establish it; empty when none does, or when one contradicts it */
  established_by: Array<'retained copy' | 'read digest'>;
  /** the script at its own path is not the submitted bytes now (edited or gone since); a copy that ran makes this beside the point */
  original_changed?: true;
}

/** The run's source checks, from the submission, the copy it recorded and the script's read digest. */
export function checkSource(root: string, input: { path: string; sha256: string }, copy: { path: string; sha256: string } | undefined, readDigest: unknown): SourceCheck {
  const read: SourceCheck['read'] = typeof readDigest !== 'string' ? 'not reported' : readDigest.toLowerCase() === input.sha256 ? 'matches' : 'differs';
  let copyState: SourceCheck['copy_state'];
  if (copy) {
    const at = resolveInside(root, copy.path);
    let there = false;
    if (!('error' in at)) { try { lstatSync(at.path); there = true; } catch { /* gone */ } }
    const now = there && !('error' in at) ? sha256File(at.path) : undefined;
    copyState = !there ? 'gone' : now !== undefined && now === copy.sha256 && copy.sha256 === input.sha256 ? 'intact' : 'changed';
  }
  const contradicted = read === 'differs' || (copyState !== undefined && copyState !== 'intact');
  const established_by: SourceCheck['established_by'] = contradicted ? [] : [
    ...(copyState === 'intact' ? ['retained copy' as const] : []), ...(read === 'matches' ? ['read digest' as const] : []),
  ];
  const original = resolveInside(root, input.path);
  const originalNow = 'error' in original ? undefined : sha256File(original.path);
  return {
    ...(copy ? { copy: copy.path, copy_state: copyState } : {}), read, established_by,
    ...(originalNow !== input.sha256 ? { original_changed: true as const } : {}),
  };
}

/** The words for an established source: which check established it, and an original that has changed since. */
export function sourceWords(s: SourceCheck, input: { path: string }): string {
  const how = s.established_by.includes('retained copy')
    ? `the copy kept at submission ran: its sha256 was checked when it was made and again after the run${s.read === 'matches' ? ', and the script read the same bytes' : '; the script reported no sha256 of what it read'}`
    : 'the script read bytes with the submitted sha256; no copy was kept for this run';
  return `${input.path} as submitted (${how})${s.original_changed ? `; ${input.path} itself has changed since it was submitted, which did not change what ran` : ''}`;
}

// ── finding 6: an output is the run's only if the run made it ───────────────

/** What was inventoried before a run besides its expected outputs (job.json `inventory`). */
export interface NativeInventory {
  /** the folders walked, relative to the project: out/ (TIMMY_OUT) */
  folders: string[];
  /** every entry under them was listed: a path under them that the inventory does not name was not there */
  complete: boolean;
  /** entries listed under the folders (files, and links or folders not walked into) */
  files: number;
  /** files listed without a sha256: past the hashing budget, private by name, or unreadable then */
  unhashed: number;
}

/**
 * Adds to `pre` every entry under `folders` as it is now: a regular file by its size, times and sha256 (none
 * for a private name or past the hashing budget), anything else (a link, a FIFO, a folder too deep or not
 * readable) as not-a-file, never opened and never walked into. Returns what the walk covered.
 */
export function inventoryFolders(root: string, pre: Record<string, PreState>, folders: string[]): NativeInventory {
  let entries = 0;
  let unhashed = 0;
  let budget = INVENTORY_HASH_BYTES;
  let complete = true;
  const note = (rel: string, state: PreState): boolean => {
    if (entries >= INVENTORY_ENTRIES) { complete = false; return false; }
    entries++;
    pre[rel] = state;
    return true;
  };
  const walk = (abs: string, rel: string, depth: number): void => {
    let list: Dirent[];
    try { list = readdirSync(abs, { withFileTypes: true }); } catch { note(rel, { state: 'not-a-file' }); return; }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      if (!complete) return;
      const childRel = `${rel}/${e.name}`;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (depth + 1 >= INVENTORY_DEPTH) { if (!note(childRel, { state: 'not-a-file' })) return; continue; }
        walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (pre[childRel]) continue; // an expected output, recorded already
      let s: Stats;
      try { s = lstatSync(childAbs); } catch { continue; } // gone since it was listed: not there before the run
      if (!s.isFile()) { if (!note(childRel, { state: 'not-a-file' })) return; continue; }
      let sha256 = '';
      if (!privatePath(childRel) && s.size <= budget) {
        sha256 = sha256File(childAbs) ?? '';
        if (sha256) budget -= s.size;
      }
      if (!sha256) unhashed++;
      if (!note(childRel, { state: 'present', size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, sha256 })) return;
    }
  };
  for (const folder of folders) {
    let top: Stats | undefined;
    try { top = lstatSync(path.join(root, folder)); } catch { /* not there: nothing under it before the run */ }
    if (!top) continue;
    if (!top.isDirectory()) { note(folder, { state: 'not-a-file' }); continue; } // a link or a file: nothing under it is walked
    walk(path.join(root, folder), folder, 0);
  }
  return { folders: [...folders], complete, files: entries, unhashed };
}

/**
 * A path's state before the run: its own inventory entry; else 'absent' when it lies under a folder the
 * inventory walked completely and below no entry the walk did not go into; else undefined (not inventoried).
 */
export function stateBefore(rel: string, pre: Record<string, PreState> | undefined, inventory: NativeInventory | undefined): PreState | undefined {
  const own = pre?.[rel];
  if (own) return own;
  if (!inventory?.complete || !Array.isArray(inventory.folders)) return undefined;
  const folder = inventory.folders.find((f) => typeof f === 'string' && f && rel.startsWith(`${f}/`));
  if (!folder || pre?.[folder]) return undefined;
  for (let i = rel.indexOf('/', folder.length + 1); i > 0; i = rel.indexOf('/', i + 1)) {
    if (pre?.[rel.slice(0, i)]) return undefined;
  }
  return { state: 'absent' };
}

/**
 * What a run did to an output path, from its state before the run and the file now:
 *   created     not there before the run, a file now
 *   changed     there before with other bytes
 *   reused      there before with the same bytes (untouched, or rewritten identically); or, not inventoried,
 *               last changed before the run was submitted. Never the run's work.
 *   unverified  there before and touched since with the same size, its bytes before the run not recorded
 *               (past the inventory's hashing budget): a change cannot be shown
 *   unrecorded  not inventoried, and changed during the run: whether it was there before, with these bytes, is not known
 *   gone        there before, not now
 *   absent      not there before or now
 */
export type OutputChange = 'created' | 'changed' | 'reused' | 'unverified' | 'unrecorded' | 'gone' | 'absent';

/** A file's record before the run: an inventoried file, or one frame of a sequence. */
interface Recorded { size: number; mtimeMs: number; ctimeMs?: number; sha256?: string }

/**
 * A regular file there now against its record before the run (`before`), or with none: undefined when the
 * inventory said the path was absent, null when it was not inventoried (its times alone speak). `now` gives
 * its sha256 now, asked only when the bytes must be compared.
 */
export function changeOf(s: Stats, before: Recorded | undefined | null, sinceMs: number, now: () => string | undefined): OutputChange {
  if (before === null) {
    const old = s.mtimeMs < sinceMs - MTIME_SLACK_MS && s.ctimeMs < sinceMs - MTIME_SLACK_MS;
    return old ? 'reused' : 'unrecorded';
  }
  if (before === undefined) return 'created';
  if (s.size !== before.size) return 'changed';
  if (before.sha256) {
    const sha = now();
    return sha === undefined ? 'unverified' : sha === before.sha256 ? 'reused' : 'changed';
  }
  // No sha256 recorded before the run (past the inventory's budget, or a record from before R4): only a file
  // not touched since (the same modification and, when recorded, status-change times) is known to hold the
  // same bytes; anything else cannot be told from a rewrite with its own bytes.
  const untouched = s.mtimeMs === before.mtimeMs && (before.ctimeMs === undefined || s.ctimeMs === before.ctimeMs);
  return untouched ? 'reused' : 'unverified';
}

/** One output path classified: its change, whether it is a file now, its sha256 and times now. */
export interface Classified {
  change: OutputChange;
  present: boolean;
  sha256?: string;
  size?: number;
  mtimeMs?: number;
  /** false when the path was not inventoried before the run (its change told from its times alone) */
  inventoried: boolean;
}

/** A single output path (followed through links, as the app writes it) against its state before the run. */
export function classifyOutput(abs: string, before: PreState | undefined, sinceMs: number): Classified {
  let s: Stats | undefined;
  let link = false;
  try { link = lstatSync(abs).isSymbolicLink(); s = statSync(abs); } catch { /* not there, or a link to nothing */ }
  // What the inventory says the path was: a file's record; not there (undefined); or not known (null): not
  // inventoried, a sequence's name, or a link the inventory never opened.
  const record: Recorded | undefined | null = before === undefined || before.state === 'sequence' ? null
    : before.state === 'present' ? before : before.state === 'not-a-file' && link ? null : undefined;
  const inventoried = record !== null;
  if (!s?.isFile()) return { change: before?.state === 'present' ? 'gone' : 'absent', present: false, inventoried };
  const sha256 = sha256File(abs);
  return { change: changeOf(s, record, sinceMs, () => sha256), present: true, ...(sha256 ? { sha256 } : {}), size: s.size, mtimeMs: s.mtimeMs, inventoried };
}

/** Made by this run, for an output found by its path alone (not named by a result): created or changed, not empty, with a time from the run. */
export function madeByRun(c: Classified, sinceMs: number): boolean {
  return (c.change === 'created' || c.change === 'changed') && (c.size ?? 0) > 0 && (c.mtimeMs ?? 0) >= sinceMs - MTIME_SLACK_MS;
}

/** Why an output found by its path alone is not this run's, in a few words. */
export function notWrittenWords(c: Classified): string {
  switch (c.change) {
    case 'absent': case 'gone': return 'not there';
    case 'reused': return c.inventoried ? 'there before this run with the same bytes: reused, not written by this run' : 'last changed before this run was submitted: not written by this run';
    case 'unverified': return 'there before this run and rewritten with the same size; its bytes before the run were not recorded, so a change cannot be shown';
    case 'unrecorded': return 'not inventoried before the run, so whether this run wrote it is not known';
    default: return 'there, but not written by this run';
  }
}

/** Why a path has no state of its own before the run, in a few words (for a verdict). */
export function whyNotInventoried(rel: string, inventory: NativeInventory | undefined): string {
  if (!inventory || !Array.isArray(inventory.folders)) return 'no inventory beyond the expected outputs was taken before this run';
  const folder = inventory.folders.find((f) => typeof f === 'string' && f && rel.startsWith(`${f}/`));
  if (!folder) return `it is outside ${inventory.folders.map((f) => `${f}/`).join(', ') || 'the inventoried folders'} and the expected outputs`;
  if (!inventory.complete) return `the inventory of ${folder}/ taken before the run was incomplete (more than ${INVENTORY_ENTRIES} entries)`;
  return `it lies below an entry of ${folder}/ the inventory did not go into: a link, or a folder too deep or unreadable`;
}

/**
 * Why a file a result names is not shown to be this run's: the clause after "names <file>, which".
 * `unlisted` says why the path was not inventoried, when it was not.
 */
export function notMadeWords(c: { change?: OutputChange; inventoried?: boolean }, unlisted = 'it was not inventoried'): string {
  switch (c.change) {
    case 'reused': return c.inventoried === false
      ? `was last changed before this run was submitted (Timmy did not inventory it: ${unlisted}): not made by this run`
      : 'was there before this run with the same bytes (reused): not made by this run';
    case 'unverified': return 'was there before this run and was rewritten with the same size, and its bytes before the run were not recorded: whether this run changed it cannot be shown';
    case 'unrecorded': return `Timmy did not inventory before the run (${unlisted}) and which changed during it: whether it was there before with these bytes is not known; write outputs under out/ (TIMMY_OUT) or name them as expected outputs`;
    default: return 'is not shown to be made by this run';
  }
}
