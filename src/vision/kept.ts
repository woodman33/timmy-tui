/**
 * What an observation keeps privately beside its record (round R4, H20; the review of 07f37ec, findings 1 and 2).
 *
 * A record keeps a model's text (an answer, a raw output) whole up to ANSWER_MAX_BYTES (64 KiB); past that it keeps
 * the text's first 64 KiB for display, the complete text is kept in a file of its own, and the record names that
 * file with its sha256 and size (`<field>_full`). The record carries the complete text's sha256 in every case
 * (`<field>_sha256`). When the observation file itself cannot be written, its whole record (the measurements, a
 * model's answer and raw output, its cites and its cost) is kept instead: a paid answer is never lost with its file.
 *
 * Where: inside the project first, under .timmy/kept/ (model-output/<job>-answer.txt, model-output/<job>-raw.txt,
 * observations/<job>.json); else in Timmy's own kept folder (the Workspace's jobs folder, kept/), named in a record
 * or a receipt as `{ store: 'timmy', path }` relative to that folder, so no absolute path is written. How: a temporary
 * file created exclusively with mode 0600, written and flushed, then linked into place under its final name, so an
 * existing file is never replaced (a taken name gets -2, -3 …); folders are made 0700. Nothing here throws: a place
 * that cannot hold the file says why, in plain words, and a text kept nowhere is recorded as `{ error }`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { humanBytes, resolveInside } from '../project/index.js';
import { placeNew } from '../utils/place-new.js';
import { OBSERVATIONS_DIR } from './look.js';
import { ANSWER_MAX_BYTES } from './route.js';

/** Where an observation keeps what its record cannot hold, inside the project. */
export const KEPT_DIR = '.timmy/kept';
/** The most of a kept file the observation check reads. */
export const KEPT_READ_LIMIT = 32 * 1024 * 1024;

/** A file that keeps something whole: inside the project (a project-relative path), or in Timmy's own kept folder. */
export interface KeptRef { path: string; sha256: string; bytes: number; store?: 'timmy' }
/** Nothing could keep it: why, in plain words. */
export interface KeptFailure { error: string }
/** The project, and Timmy's own kept folder (absolute) when the caller has one. */
export interface KeepPlaces { root: string; timmy?: string }
export type Kept = { ok: true; ref: KeptRef; abs: string } | { ok: false; error: string };

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const code = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'error';
/** A text's first ANSWER_MAX_BYTES, cut on a character boundary, as qualify-route's keptText and describeImage cut it. */
function cut(text: string): { text: string; truncated?: true; bytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= ANSWER_MAX_BYTES) return { text, bytes };
  const buf = Buffer.from(text, 'utf8');
  let end = ANSWER_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // buf[end] is the first byte left out: never inside a character
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, bytes };
}
/**
 * Writes `body` into `dir` as `name` (or name-2 … when it is taken): atomically, mode 0600, never over a file. A disk
 * without hard links takes it by rename once nothing is there (src/utils/place-new.ts, shared with recovery; R4-7).
 */
function placePrivate(dir: string, name: string, body: Buffer): { ok: true; abs: string; name: string } | { ok: false; error: string } {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
    const c = code(e);
    return { ok: false, error: c === 'EEXIST' || c === 'ENOTDIR' ? 'a file is in the way of its folder' : `its folder cannot be made (${c})` };
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const tmp = join(dir, `.${stem}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    // O_CREAT|O_EXCL: nothing already there (a link included) is written through.
    fd = openSync(tmp, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(tmp); } catch { /* never made */ }
    return { ok: false, error: `it could not be written (${code(e)})` };
  }
  try {
    for (let n = 1; n < 100; n++) {
      const final = n === 1 ? name : `${stem}-${n}${ext}`;
      const abs = join(dir, final);
      try {
        // link(2) fails on a name that is taken, so nothing is ever replaced; without hard links, lstat then rename.
        placeNew(tmp, abs);
        return { ok: true, abs, name: final };
      } catch (e) {
        if (code(e) === 'EEXIST') continue;
        return { ok: false, error: `it could not be put in place (${code(e)})` };
      }
    }
    return { ok: false, error: 'no free name for it' };
  } catch (e) {
    return { ok: false, error: `it could not be put in place (${code(e)})` };
  } finally {
    // After a link the temporary name is a second name for the kept file (removing it leaves the file); after a
    // rename it is gone already; otherwise it is the unplaced copy.
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

/**
 * Keeps `body` as `<sub>/<name>`: in the project's .timmy/kept/ (through resolveInside, so no link leads it out of
 * the project), else in Timmy's own kept folder. Says where, with its sha256 and size; or why it is kept nowhere.
 */
export function keepPrivate(places: KeepPlaces, sub: 'model-output' | 'observations', name: string, body: string): Kept {
  const bytes = Buffer.from(body, 'utf8');
  const sum = sha256(bytes);
  const errors: string[] = [];
  const rel = `${KEPT_DIR}/${sub}`;
  const at = resolveInside(places.root, rel);
  if ('error' in at) errors.push(`in the project: ${at.error}`);
  else {
    const w = placePrivate(at.path, name, bytes);
    if (w.ok) return { ok: true, ref: { path: `${rel}/${w.name}`, sha256: sum, bytes: bytes.length }, abs: w.abs };
    errors.push(`in the project (${rel}/): ${w.error}`);
  }
  if (places.timmy) {
    const w = placePrivate(join(places.timmy, sub), name, bytes);
    if (w.ok) return { ok: true, ref: { store: 'timmy', path: `${sub}/${w.name}`, sha256: sum, bytes: bytes.length }, abs: w.abs };
    errors.push(`in Timmy's own folder: ${w.error}`);
  } else errors.push("in Timmy's own folder: none is known here");
  return { ok: false, error: errors.join('; ') };
}

/** A path a record may name in Timmy's own kept folder: relative, inside it, no climbing out. */
export function safeKeptPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || isAbsolute(p)) return false;
  const parts = p.split('/');
  return parts.every((x) => x && x !== '.' && x !== '..');
}

/**
 * What the observation check reads of a file a record names as keeping a whole text: its bytes; null when there is
 * no such file; undefined when it cannot be read, is larger than `limit`, or is not a place Timmy keeps files.
 */
export function keptReader(places: KeepPlaces, limit = KEPT_READ_LIMIT): (ref: { path: string; store?: 'timmy' }) => Buffer | null | undefined {
  return (ref) => {
    let abs: string;
    if (ref?.store === 'timmy') {
      if (!places.timmy || !safeKeptPath(ref.path)) return undefined;
      abs = join(places.timmy, ref.path);
    } else {
      if (typeof ref?.path !== 'string' || !ref.path.startsWith(`${KEPT_DIR}/`)) return undefined;
      const at = resolveInside(places.root, ref.path);
      if ('error' in at) return undefined;
      abs = at.path;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > limit) return undefined;
      return readFileSync(abs);
    } catch (e) {
      return code(e) === 'ENOENT' || code(e) === 'ENOTDIR' ? null : undefined;
    }
  };
}

/**
 * A model's text as a record keeps it, under `field`: whole up to 64 KiB (with `<field>_sha256`); past that its first
 * 64 KiB cut on a character (`<field>_truncated`, `<field>_bytes`), the complete text's sha256, and `<field>_full`:
 * where `keep` kept the complete text ({ path, sha256, bytes }), or why it could not ({ error }).
 */
export function recordedText(field: string, complete: string, keep: (whole: string) => KeptRef | KeptFailure): Record<string, unknown> {
  const sum = sha256(complete);
  const part = cut(complete);
  if (!part.truncated) return { [field]: complete, [`${field}_sha256`]: sum };
  let full: KeptRef | KeptFailure;
  try { full = keep(complete); } catch (e) { full = { error: `it could not be kept (${e instanceof Error ? e.message : 'error'})` }; }
  return { [field]: part.text, [`${field}_truncated`]: true, [`${field}_bytes`]: part.bytes, [`${field}_sha256`]: sum, [`${field}_full`]: full };
}

/** One observation's keeper: what it keeps of its model's texts, and of its record when the record's file cannot be written. */
export interface ObservationKeeper {
  /** Keeps a model's complete text as <job>-answer.txt or <job>-raw.txt; one kept nowhere is remembered for record(). */
  whole(what: 'answer' | 'raw_output', complete: string): KeptRef | KeptFailure;
  /** The record's fields for a model text (recordedText), its complete text kept by whole(). */
  fields(field: 'answer' | 'raw_output', complete: string): Record<string, unknown>;
  /** Keeps the whole record of an observation whose file could not be written, with why, and any complete text kept nowhere else. */
  record(record: Record<string, unknown>, reason: string): Kept;
}

export function observationKeeper(places: KeepPlaces, jobId: string): ObservationKeeper {
  const nowhere: Record<string, string> = {};
  const whole = (what: 'answer' | 'raw_output', complete: string): KeptRef | KeptFailure => {
    const k = keepPrivate(places, 'model-output', `${jobId}-${what === 'raw_output' ? 'raw' : 'answer'}.txt`, complete);
    if (k.ok) return k.ref;
    nowhere[what] = complete;
    return { error: k.error };
  };
  return {
    whole,
    fields: (field, complete) => recordedText(field, complete, (c) => whole(field, c)),
    record: (record, reason) => keepPrivate(places, 'observations', `${jobId}.json`, `${JSON.stringify({
      ...record, not_written: { to: `${OBSERVATIONS_DIR}/`, reason }, ...(Object.keys(nowhere).length ? { whole_texts: nowhere } : {}),
    }, null, 2)}\n`),
  };
}

/** For a notice: where the whole of a cut text is kept, or why it could not be; '' when the record holds it whole. */
export function wholeNote(section: Record<string, unknown> | undefined, field: string, label: string, show: (ref: KeptRef) => string): string {
  if (!section || section[`${field}_truncated`] !== true) return '';
  const n = section[`${field}_bytes`];
  const size = typeof n === 'number' ? ` (${humanBytes(n)})` : '';
  const full = section[`${field}_full`] as Partial<KeptRef & KeptFailure> | undefined;
  return full && typeof full.path === 'string'
    ? `the whole ${label}${size} is kept at ${show(full as KeptRef)}`
    : `the whole ${label}${size} could not be kept${typeof full?.error === 'string' ? `: ${full.error}` : ''}`;
}
