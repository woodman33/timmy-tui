/**
 * Round R4 (H30): what R4 keeps, shown on the board. An observation whose file could not be written keeps its whole
 * record privately (src/vision/kept.ts: the project's .timmy/kept/observations/<job>.json, else Timmy's own kept
 * folder), and its failure receipt (kind observe, status failed) seals it: `observation.kept` names the kept file
 * with its sha256 and size, or says why the record is kept nowhere. Each becomes a result card with a status of
 * its own, never that of a verified measurement:
 *
 * - "kept": the kept file is there with exactly the sha256 and size its receipt sealed, and that receipt hashes to
 *   its own body. Its values are still not shown as measurements: no observation file was written, so the board's
 *   observation check never ran on them; the card says what the record holds and links it.
 * - "kept · unverified": the kept file is gone, cannot be read, is not where Timmy keeps files, holds other bytes
 *   than its receipt sealed, its receipt was edited after it was sealed, or no receipt names it (a file in the
 *   project's .timmy/kept/observations/ whose receipt could not be sealed, or is not in this store); with why.
 * - "not kept": the receipt says the record could not be kept anywhere, and why.
 *
 * A cost is shown as the receipt sealed it: the reported amount; unknown when a request went out and no cost came
 * back (cost_measured: false); nothing when no request went out. A file in Timmy's own kept folder is named
 * relative to that folder, never by an absolute path.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KeptFileReader } from '../evidence/observation-check.js';
import { resolveInside } from '../project/index.js';
import { hashOf, type Receipt } from '../utils/receipts.js';
import { KEPT_DIR, safeKeptPath } from '../vision/kept.js';
import type { ResultCard } from './board-cards.js';

/** Where kept observation records are, inside the project (and, relative to it, in Timmy's own kept folder). */
export const KEPT_OBSERVATIONS = `${KEPT_DIR}/observations`;
const TIMMY_OBSERVATIONS = 'observations';

/** The kept file a receipt names: in the project (a project path), or in Timmy's own kept folder. */
export interface KeptPlace { path: string; store?: 'timmy'; sha256?: string; bytes?: number }

/** Whether a kept record is the one its receipt sealed. */
export interface KeptRecordCheck {
  status: 'matches' | 'unverified';
  /** Why not, in plain words; empty when it matches. */
  reasons: string[];
  /** The kept file's bytes, when they are the ones its receipt sealed. */
  bytes?: Buffer;
}

/** One kept observation record, as its receipt and the file say. */
export interface KeptObservation {
  /** The short id (as /results shows it) of the receipt that sealed the kept copy; absent when no receipt names it. */
  receipt?: string;
  at?: string;
  /** The image it observed, inside the project. */
  source?: string;
  job?: string;
  /** Why the observation file could not be written, as the receipt sealed it. */
  error?: string;
  /** The kept file, or why the record is kept nowhere. */
  kept: KeptPlace | { error: string };
  /** Absent when the record is kept nowhere: there is no file to check. */
  check?: KeptRecordCheck;
  /** What was spent, as the receipt sealed it: absent when no request went out; null when one did and no cost came back. */
  cost?: number | null;
  model?: string;
  /** What became of the model's part, as the receipt sealed it, in words. */
  claim?: string;
  /** With a matching file: what the record holds. */
  holds?: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const short = (sha: string): string => sha.slice(0, 12);
const shortId = (r: Receipt): string => String(r.hash).slice(7, 15);

/** A path inside the project as '/'-separated parts, or null: absolute, a URL, home-relative, or climbing out. */
function insideProject(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/** The receipt's recorded hash is the hash of its own body (as src/evidence/observation-check.ts checks it). */
function hashesToItself(r: Receipt): boolean {
  if (typeof r.hash !== 'string') return false;
  try {
    const { hash, ...rest } = r;
    return hashOf({ ...rest, hash: '' } as Record<string, unknown>) === hash;
  } catch { return false; }
}

/** A receipt's `observation.kept` read strictly: a kept file, why it is kept nowhere, or nothing. */
export function keptOf(r: Receipt): KeptPlace | { error: string } | undefined {
  const k = obj(obj(r.observation)?.kept);
  if (!k) return undefined;
  const path = str(k.path);
  if (path === undefined) return { error: str(k.error) ?? 'no reason was recorded' };
  return {
    path, ...(k.store === 'timmy' ? { store: 'timmy' as const } : {}),
    ...(str(k.sha256) ? { sha256: str(k.sha256) } : {}), ...(typeof k.bytes === 'number' ? { bytes: k.bytes } : {}),
  };
}

/** Where a kept file is, for a person: its project path, or its place in Timmy's own kept folder (never absolute). */
export const keptWhere = (k: KeptPlace): string => (k.store === 'timmy' ? `Timmy's own kept folder (${k.path})` : k.path);

/** Whether the place is one where Timmy keeps an observation record. */
function keptPlace(k: KeptPlace): boolean {
  return k.store === 'timmy'
    ? safeKeptPath(k.path) && k.path.startsWith(`${TIMMY_OBSERVATIONS}/`)
    : insideProject(k.path) === k.path && k.path.startsWith(`${KEPT_OBSERVATIONS}/`);
}

/**
 * Whether the kept file `k` names is exactly what `receipt` sealed: the receipt hashes to its own body, the file is
 * where Timmy keeps records, and its bytes have the sha256 and size the receipt names. `read` reads a kept file
 * (src/vision/kept.ts keptReader): its bytes, null when it is not there, undefined when it cannot be read.
 */
export function checkKeptRecord(k: KeptPlace, receipt: Receipt | undefined, read: KeptFileReader): KeptRecordCheck {
  const where = keptWhere(k);
  if (!receipt) return { status: 'unverified', reasons: ['no observe receipt names this kept record (its receipt could not be sealed, or it is not in this store)'] };
  const reasons: string[] = [];
  if (!hashesToItself(receipt)) reasons.push(`the receipt that names it (${shortId(receipt)}) does not match its contents: it was edited after it was sealed`);
  if (!keptPlace(k)) return { status: 'unverified', reasons: [...reasons, `the receipt names ${where} for the kept record, which is not a place Timmy keeps one`] };
  const sealed = k.sha256 !== undefined && SHA256.test(k.sha256) ? k.sha256 : undefined;
  if (!sealed) reasons.push('its receipt names no sha256 for the kept record');
  const bytes = read({ path: k.path, ...(k.store ? { store: k.store } : {}) });
  if (bytes === null) return { status: 'unverified', reasons: [...reasons, `the kept record is no longer at ${where}`] };
  if (bytes === undefined) return { status: 'unverified', reasons: [...reasons, `the kept record at ${where} could not be read`] };
  const got = createHash('sha256').update(bytes).digest('hex');
  if (sealed && got !== sealed) reasons.push(`the kept record at ${where} is not the one its receipt sealed: it is sha256 ${short(got)}, the receipt sealed ${short(sealed)}`);
  else if (typeof k.bytes === 'number' && k.bytes !== bytes.length) reasons.push(`the kept record at ${where} is ${bytes.length} bytes, not the ${k.bytes} its receipt sealed`);
  return reasons.length ? { status: 'unverified', reasons } : { status: 'matches', reasons: [], bytes };
}

/** What a matching kept record holds, in words: Look's values, the model's answer, its raw output. */
function holdsOf(bytes: Buffer): string | undefined {
  let r: Record<string, unknown> | undefined;
  try { r = obj(JSON.parse(bytes.toString('utf8'))); } catch { return undefined; }
  if (!r) return undefined;
  const n = Array.isArray(obj(r.look)?.measurements) ? (obj(r.look)!.measurements as unknown[]).length : undefined;
  const model = obj(r.qualified) ?? obj(r.interpretation);
  const parts = [
    ...(n !== undefined ? [`Look's ${n} value${n === 1 ? '' : 's'} (as recorded)`] : []),
    ...(typeof model?.answer === 'string' && model.answer ? ["the model's answer (a claim)"] : []),
    ...(typeof model?.raw_output === 'string' && model.raw_output ? ["the model's raw output"] : []),
    ...(obj(r.whole_texts) ? ['a model text kept nowhere else'] : []),
  ];
  return parts.length ? `it holds ${parts.join(', ')}` : undefined;
}

/** What became of a model's part, as an observe receipt sealed it. */
function claimOf(r: Receipt): string | undefined {
  const q = r.observation?.qualified;
  if (q) return q.status === 'admitted' ? 'a cited model answer (a claim)' : `no admitted model answer (${q.status})`;
  const i = r.observation?.interpretation;
  if (i) return i.status === 'answered' ? "a model's answer (a claim)" : `no model answer (${i.status})`;
  return undefined;
}

/**
 * The project's kept observation records, newest first: each one an observe receipt of this project names (checked
 * against it), then any file in the project's .timmy/kept/observations/ that no receipt names (unverified).
 */
export function keptObservations(o: { root: string; chain: readonly Receipt[]; projectId: string; read: KeptFileReader; max?: number }): KeptObservation[] {
  const out: Array<KeptObservation & { t: number }> = [];
  const named = new Set<string>();
  for (const r of [...o.chain].reverse()) {
    if (!r || r.kind !== 'observe' || r.project_id !== o.projectId) continue;
    const kept = keptOf(r);
    if (!kept) continue;
    if ('path' in kept && !kept.store) named.add(kept.path);
    const source = insideProject(r.files?.[0]?.path);
    const t = Date.parse(r.ts);
    const check = 'path' in kept ? checkKeptRecord(kept, r, o.read) : undefined;
    const holds = check?.bytes ? holdsOf(check.bytes) : undefined;
    out.push({
      receipt: shortId(r), at: r.ts, t: Number.isNaN(t) ? 0 : t, kept,
      ...(source ? { source } : {}), ...(r.job?.id ? { job: r.job.id } : {}), ...(str(r.observation?.error) ? { error: str(r.observation?.error) } : {}),
      ...(check ? { check: { status: check.status, reasons: check.reasons } } : {}),
      ...(r.cost_measured === false ? { cost: null } : typeof r.cost_usd === 'number' ? { cost: r.cost_usd } : {}),
      ...(str(r.model_resolved ?? r.model_requested) ? { model: r.model_resolved ?? r.model_requested } : {}),
      ...(claimOf(r) ? { claim: claimOf(r) } : {}), ...(holds ? { holds } : {}),
    });
  }
  // Files in the project's own kept folder that no receipt names: regular files only (a link is never followed).
  const dir = resolveInside(o.root, KEPT_OBSERVATIONS);
  if (!('error' in dir)) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir.path, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      const rel = `${KEPT_OBSERVATIONS}/${e.name}`;
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('.') || named.has(rel)) continue;
      let t = 0;
      try { t = fs.statSync(path.join(dir.path, e.name)).mtimeMs; } catch { /* unreadable: last */ }
      out.push({ at: new Date(t).toISOString(), t, kept: { path: rel }, check: checkKeptRecord({ path: rel }, undefined, o.read) });
    }
  }
  out.sort((a, b) => b.t - a.t);
  return out.slice(0, o.max ?? 6).map(({ t: _t, ...k }) => k);
}

/** A cost in dollars, never a nonzero amount that reads as zero. */
const usd = (n: number): string => (n > 0 && n < 0.0001 ? `$${n.toPrecision(2)}` : `$${n.toFixed(4)}`);

/** The kept records as result cards (src/repl/board-cards.ts renderResultCards draws them). */
export function keptResults(list: readonly KeptObservation[], scrub: (t: string) => string): ResultCard[] {
  return list.map((k): ResultCard => {
    const error = k.error ? scrub(k.error) : 'the observation file could not be written';
    const place = 'path' in k.kept ? k.kept : undefined;
    const where = place ? scrub(keptWhere(place)) : '';
    const status: ResultCard['status'] = !place
      ? { word: 'not kept', tone: 'failed', detail: `${error}, and its record could not be kept either: ${scrub((k.kept as { error: string }).error)}` }
      : k.check?.status === 'matches'
        ? { word: 'kept', tone: 'attention', detail: `${error}; its whole record is kept ${place.store ? 'in' : 'at'} ${where}, exactly the bytes its receipt sealed (sha256 ${short(place.sha256 ?? '')}). Its values are a record, not verified measurements: no observation file was written and checked` }
        : { word: 'kept · unverified', tone: 'attention', detail: `not verified: ${(k.check?.reasons ?? ['it was not checked']).map(scrub).join('; ')}` };
    const facts: NonNullable<ResultCard['facts']> = [
      ...(k.model ? [{ label: 'model', value: k.model, how: `as its receipt sealed it${k.claim ? `; ${k.claim}` : ''}` }] : []),
      ...(k.cost === undefined ? [] : [{
        label: 'cost', value: k.cost === null ? 'unknown' : usd(k.cost),
        how: k.cost === null ? 'a request went out; no cost was reported (sealed as cost_measured: false)' : 'as the response reported it, sealed on its receipt',
      }]),
    ];
    const files = [
      ...(k.source ? [{ rel: k.source, note: 'the image' }] : []),
      ...(place && !place.store ? [{ rel: place.path, note: k.check?.status === 'matches' ? 'the kept record, as its receipt sealed it' : 'the kept record, not verified' }] : []),
    ];
    return {
      kind: 'kept', title: k.source ?? (place ? place.path : 'an observation'), ...(k.at ? { at: k.at } : {}), status,
      lines: [
        ...(place?.store === 'timmy' ? [`kept outside the project, in ${where}`] : []),
        ...(k.check?.status === 'unverified' ? [error] : []),
        ...(k.holds ? [k.holds] : []),
        ...(k.job ? [`job ${k.job}`] : []),
      ],
      ...(facts.length ? { facts } : {}),
      ...(files.length ? { files } : {}),
      ...(k.receipt ? { receipts: [{ id: k.receipt, what: 'observe, failed: it sealed the kept copy' }] } : {}),
      commands: [...(place && !place.store && k.check?.status === 'matches' ? [`/open ${place.path}`] : []), ...(k.job ? [`/jobs ${k.job}`] : []), '/results'],
    };
  });
}
