/**
 * Whether an observation file is what Timmy sealed (the independent review of 40022d9; AGENTS.md §4).
 *
 * An observation (results/observations/*.json, written by /observe) is an editable file in the project: a
 * person, an agent or another tool can change it. Its values may be called verified only when all of this
 * holds, checked here as a pure function of what the caller read:
 *
 *   1. the record is a Look observation: `observation: 1`, and `look.worker` names timmy-look and a version;
 *   2. every value in `look.measurements` is marked exactly "deterministic computation" (src/vision/look.ts);
 *   3. a sealed receipt of kind `observe` (status ok, this project's, its hash matching its own body) lists
 *      this file among its outputs with exactly the sha256 of the file's bytes now, and names the same
 *      source image the record names;
 *   4. the source image in the project still has the record's sha256.
 *
 * Failing 1–3 makes the record `unverified`; failing only 4 makes it `stale` (the image changed since, or is
 * gone). Every failed condition is kept as a plain-words reason. A receipt's hash binds its bytes, not
 * their truth: `verified` says the file is the one Timmy's Look run sealed about the image as it is now,
 * not that a measurement is physically right. A model's interpretation inside a verified file stays a claim.
 */
import type { Receipt } from '../utils/receipts.js';
import { hashOf } from '../utils/receipts.js';
import { DETERMINISTIC } from '../vision/look.js';

export type ObservationStatus = 'verified' | 'unverified' | 'stale';

export interface ObservationCheck {
  status: ObservationStatus;
  /** Why it is not verified, in plain words; empty when it is. */
  reasons: string[];
  /** The short id (as /results shows it) of the receipt that sealed this file, when one did. */
  receipt?: string;
}

export interface ObservationCheckInput {
  /** The observation file's JSON, as parsed from its bytes. */
  record: unknown;
  /** The observation file's path, relative to the project ('/'-separated). */
  file: string;
  /** The sha256 of the observation file's bytes now; undefined when they could not be hashed. */
  fileSha256: string | undefined;
  /**
   * The sha256 of the project file at the record's source path, now: a string when it was hashed, null
   * when there is no such file in the project any more, undefined when it could not be read or hashed.
   */
  currentSourceSha256: string | null | undefined;
  /** The receipts to look in (the runs chain). */
  receipts: readonly Receipt[];
  /** The project's identity (projectId); when given, the receipt must be this project's. */
  projectId?: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const short = (sha: string): string => sha.slice(0, 12);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A path inside the project as '/'-separated parts, or null: absolute, a URL, home-relative, or climbing out. */
function insideProject(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/** The receipt's recorded hash is the hash of its own body (verifyChain's body check, without the chain). */
function hashesToItself(r: Receipt): boolean {
  if (typeof r.hash !== 'string') return false;
  try {
    const { hash, ...rest } = r;
    return hashOf({ ...rest, hash: '' } as Record<string, unknown>) === hash;
  } catch { return false; }
}

const shortId = (r: Receipt): string => String(r.hash).slice(7, 15);

/** Checks an observation file's provenance: see the module comment for exactly what `verified` means. */
export function checkObservation(input: ObservationCheckInput): ObservationCheck {
  const unverified: string[] = [];
  const stale: string[] = [];
  const r = obj(input.record);
  const look = obj(r?.look);
  const worker = obj(look?.worker);

  // 1. A Look observation.
  if (!r || r.observation !== 1 || !look) unverified.push('the file is not an observation record that /observe writes');
  else if (worker?.name !== 'timmy-look' || !text(worker?.version)) unverified.push("the record does not name Look's worker and its version");

  // 2. Every value deterministic.
  const measurements = Array.isArray(look?.measurements) ? look.measurements : undefined;
  if (look && !measurements) unverified.push('the record has no list of measurements');
  const other = (measurements ?? []).filter((m) => obj(m)?.tier !== DETERMINISTIC || !text(obj(m)?.name)).length;
  if (other) unverified.push(`${other} of its ${measurements!.length} values ${other === 1 ? 'is' : 'are'} not marked "${DETERMINISTIC}"`);

  // The image it measured, as the record names it.
  const src = obj(r?.source);
  const sourcePath = insideProject(src?.path);
  const sourceSha = typeof src?.sha256 === 'string' && SHA256.test(src.sha256) ? src.sha256 : undefined;
  if (!sourcePath) unverified.push('the record names no image inside the project');
  else if (!sourceSha) unverified.push(`the record gives no sha256 for ${sourcePath}`);

  // 3. A sealed observe receipt for exactly these bytes.
  let receipt: string | undefined;
  const file = insideProject(input.file);
  const naming = (input.receipts ?? []).filter((x) => x && x.kind === 'observe' && x.status === 'ok'
    && (input.projectId === undefined || x.project_id === input.projectId)
    && Array.isArray(x.outputs) && x.outputs.some((o) => o && o.path === file));
  if (!file) unverified.push('the file is not inside the project');
  else if (!naming.length) unverified.push('no observe receipt names this file (it was not written by /observe here, or its receipt is not in this store)');
  else if (!input.fileSha256) unverified.push('the file could not be hashed, so it cannot be matched to its receipt');
  else {
    const exact = naming.filter((x) => x.outputs!.some((o) => o && o.path === file && o.sha256 === input.fileSha256));
    if (!exact.length) {
      const was = naming.flatMap((x) => x.outputs!.filter((o) => o && o.path === file && typeof o.sha256 === 'string').map((o) => short(o.sha256!)));
      unverified.push(`the file changed after it was sealed: its receipt sealed sha256 ${[...new Set(was)].join(', ') || '(none recorded)'}, the file is now ${short(input.fileSha256)}`);
    } else {
      const intact = exact.filter(hashesToItself);
      if (!intact.length) unverified.push(`the receipt that names this file (${exact.map(shortId).join(', ')}) does not match its contents: it was edited after it was sealed`);
      else {
        const same = intact.find((x) => sourcePath && sourceSha && Array.isArray(x.files) && x.files.some((f) => f && f.path === sourcePath && f.sha256 === sourceSha));
        if (!same) unverified.push(`the receipt that sealed this file (${intact.map(shortId).join(', ')}) names a different source image than the record`);
        else receipt = shortId(same);
      }
    }
  }

  // 4. The image unchanged since.
  if (sourcePath && sourceSha) {
    if (input.currentSourceSha256 === null) stale.push(`${sourcePath} is no longer in the project: the observation describes an image that is gone`);
    else if (input.currentSourceSha256 === undefined) unverified.push(`${sourcePath} could not be read now, so whether it changed since it was observed is not known`);
    else if (input.currentSourceSha256 !== sourceSha) stale.push(`${sourcePath} changed since it was observed: it was sha256 ${short(sourceSha)}, it is now ${short(input.currentSourceSha256)}`);
  }

  const reasons = [...unverified, ...stale];
  const status: ObservationStatus = unverified.length ? 'unverified' : stale.length ? 'stale' : 'verified';
  return { status, reasons, ...(receipt ? { receipt } : {}) };
}
