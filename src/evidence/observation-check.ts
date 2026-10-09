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
 *
 * R3 (H14): a record with a `qualified` section (/observe --qualify, the observed-handle + cite protocol of
 * AGENTS.md §4) must also be consistent, or the record is `unverified` with the reason:
 *
 *   5. the section is bound to the record's image (source_revision = source.sha256); an admitted answer says
 *      semantic_correctness_verified: false, names its run, cites each handle once, each citing a deterministic
 *      measurement of this record with exactly its recorded value, and its citations, run, image and answer are
 *      those of the model's raw output it was admitted from; and the receipt that sealed the file sealed the
 *      same qualified outcome (status, run, cited handles, sha256 of the raw output).
 *
 * Consistency says the citations point at this record's measured values; it never makes the answer a measurement.
 */
import { createHash } from 'node:crypto';
import type { RefusalReason } from './admission.js';
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
  let sealedBy: Receipt | undefined;
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
        else { receipt = shortId(same); sealedBy = same; }
      }
    }
  }

  // 5. R3 (H14): a qualified answer consistent with its handles, its image and its receipt.
  const sealedQualified = obj(obj((sealedBy as unknown as Record<string, unknown> | undefined)?.observation)?.qualified);
  if (r && r.qualified !== undefined) unverified.push(...qualifiedReasons(r.qualified, measurements ?? [], sourceSha, sealedBy ? sealedQualified ?? null : undefined));
  else if (sealedQualified) unverified.push('its receipt sealed a qualified model answer that the file no longer records');

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

// ── R3 (H14): the qualified answer of /observe --qualify ─────────────────────────────────────────────

/** The protocol a qualified section was made under, as the record names it. */
export const QUALIFIED_PROTOCOL = 'observed-handle + cite (AGENTS.md §4)';
/** The outcomes a qualified section records. */
export const QUALIFIED_STATUSES = ['admitted', 'refused', 'rejected', 'cancelled', 'failed', 'not asked'] as const;

const REFUSALS: Record<RefusalReason, string> = {
  invalid_output: 'the answer was not exactly the JSON envelope asked for (valid JSON, those fields and no others)',
  stale_context: 'the image changed between Look and the answer',
  wrong_run: "the answer names another run's id",
  wrong_revision: 'the answer names another revision of the image',
  run_closed: 'the run had already decided',
  execution_failed: 'the exchange did not complete',
  no_observations: 'Look recorded no deterministic value to cite, so no model was asked',
  unknown_handle: 'the answer cites a handle not observed in this run (an invented one, or one from another run)',
  duplicate_handle: 'the answer cites a handle twice',
  uncited_handle: 'the answer lists a handle it never cited through the cite tool',
  irrelevant_handle: 'the answer cites a handle that is not evidence for it',
};
/** A refusal reason in plain words. */
export const describeRefusal = (reason: string): string => (REFUSALS as Record<string, string>)[reason] ?? `refused: ${reason}`;

const sha256Text = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const handleIds = (cites: unknown): string[] => (Array.isArray(cites) ? cites.map((c) => text(obj(c)?.handle_id) ?? '') : []);
const shortHandle = (id: string): string => (id.length > 14 ? `${id.slice(0, 11)}…` : id);

/** What an observe receipt seals of a qualified section (Receipt.observation.qualified). */
export interface QualifiedSeal { status: string; model?: string; run_id?: string; source_revision?: string; cites: string[]; refusal?: string; raw_output_sha256?: string; cost_usd?: number | null }

/** What an observe receipt seals of a qualified section: enough to tell an edited one from what was written. */
export function qualifiedSeal(q: Record<string, unknown>): QualifiedSeal {
  return {
    status: String(q.status),
    ...(typeof q.model === 'string' ? { model: q.model } : {}),
    ...(typeof q.run_id === 'string' ? { run_id: q.run_id } : {}),
    ...(typeof q.source_revision === 'string' ? { source_revision: q.source_revision } : {}),
    cites: handleIds(q.cites),
    ...(typeof q.refusal === 'string' ? { refusal: q.refusal } : {}),
    ...(typeof q.raw_output === 'string' ? { raw_output_sha256: sha256Text(q.raw_output) } : {}),
    ...('cost_usd' in q ? { cost_usd: typeof q.cost_usd === 'number' ? q.cost_usd : null } : {}),
  };
}

/**
 * Why a qualified section is not what /observe --qualify wrote for this record; empty when it is consistent.
 * `sealed`: the qualified part of the receipt that sealed this file (null: that receipt sealed none;
 * undefined: no receipt was matched, which the other checks already report).
 */
function qualifiedReasons(v: unknown, measurements: readonly unknown[], sourceSha: string | undefined, sealed: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  const q = obj(v);
  if (!q) return ['the qualified model answer is not a record'];
  const status = text(q.status);
  if (!status || !(QUALIFIED_STATUSES as readonly string[]).includes(status)) out.push(`the qualified model answer has no known status (${status ?? 'none'})`);
  if (q.source_revision !== sourceSha) out.push(`the qualified model answer is bound to image sha256 ${typeof q.source_revision === 'string' ? short(q.source_revision) : '(none)'}, not the record's ${sourceSha ? short(sourceSha) : '(none)'}`);
  const raw = typeof q.raw_output === 'string' ? q.raw_output : undefined;
  if (status === 'admitted') {
    if (q.semantic_correctness_verified !== false) out.push('the qualified model answer says its correctness was verified: an admission never establishes that');
    if (!text(q.run_id)) out.push('the qualified model answer names no run');
    const cites = Array.isArray(q.cites) ? q.cites : [];
    if (!cites.length) out.push('the admitted model answer cites nothing');
    const deterministic = new Map<string, Record<string, unknown>>();
    for (const m of measurements) { const o = obj(m); if (o && o.tier === DETERMINISTIC && text(o.name)) deterministic.set(o.name as string, o); }
    const ids: string[] = [];
    for (const c of cites) {
      const co = obj(c);
      const id = text(co?.handle_id);
      const name = text(co?.measurement);
      if (!co || !id || !name) { out.push('a citation of the qualified model answer has no handle id or measurement'); continue; }
      if (ids.includes(id)) out.push(`handle ${shortHandle(id)} is cited twice`);
      ids.push(id);
      const m = deterministic.get(name);
      if (!m) out.push(`handle ${shortHandle(id)} cites ${name}, which is not a deterministic measurement in this record`);
      else if (JSON.stringify(m.value ?? null) !== JSON.stringify(co.value ?? null)) out.push(`handle ${shortHandle(id)} cites ${name} with a value this record's measurement does not have`);
    }
    // The citations are the ones the model's raw output was admitted with: the same run, image, handles and answer.
    let env: Record<string, unknown> | undefined;
    try { env = raw !== undefined && q.raw_output_truncated !== true ? obj(JSON.parse(raw)) : undefined; } catch { env = undefined; }
    const listed = obj(env?.evidence)?.answer;
    if (!env || env.run_id !== q.run_id || env.source_revision !== q.source_revision || !Array.isArray(listed)
      || listed.length !== cites.length || listed.some((h, i) => h !== text(obj(cites[i])?.handle_id))) {
      out.push("the qualified model answer's citations, run or image are not those of the raw output it was admitted from");
    } else if (q.answer_truncated !== true && obj(env.payload)?.answer !== q.answer) {
      out.push("the qualified model answer's text is not the answer in its raw output");
    }
  }
  if (sealed === null) out.push('the receipt that sealed this file sealed no qualified model answer, but the file records one');
  else if (sealed) {
    const sealedIds = Array.isArray(sealed.cites) ? sealed.cites.map(String) : [];
    const ids = handleIds(q.cites);
    if (sealed.status !== q.status || sealed.run_id !== q.run_id || sealed.source_revision !== q.source_revision
      || sealedIds.join('\n') !== ids.join('\n') || (raw !== undefined ? sealed.raw_output_sha256 !== sha256Text(raw) : sealed.raw_output_sha256 !== undefined)) {
      out.push(`the qualified model answer is not the one its receipt sealed (sealed: ${String(sealed.status)}${sealedIds.length ? `, citing ${sealedIds.map(shortHandle).join(', ')}` : ''})`);
    }
  }
  return out;
}
