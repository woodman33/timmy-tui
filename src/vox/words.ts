/**
 * Timmy VoxVision (round R4, helper H61): the one status word each value and each highlight carries, the words of the
 * owner's brief, and what each rests on (its note).
 *
 *   CAD checked       a value of generated CAD that Timmy compared with its source's own report or prediction and
 *                     found within tolerance (src/vox/sources.ts); the note says what it was checked against
 *   measured          a deterministic computation on these exact bytes
 *   estimated         a value that rests on an assumption, named in the note: a unit the files do not declare, one
 *                     sampled frame, a scale, what a header declares, a kind told by a name
 *   model prediction  a model's output (Roboflow): a claim, never a measurement
 *   stale             an input changed since the record: said when a record is read, never written into one
 *   unknown           no value, with why; also every value of a record that is not verified (nothing vouches for it)
 *
 * A record made from now on carries its words (status_word and status_note on each value and highlight). For a record
 * made before, the word is derived here from what the record holds (each value's tier, its value, its method and
 * unit, its inputs' kinds), never from new evidence: an older record is never "CAD checked", since it holds no check.
 * The existing tier, method and who measured it stay on every value as its advanced detail.
 */
import type { VoxKind } from './kinds.js';
import { LABEL, TIER, type VoxClaim, type VoxHighlight, type VoxMetric, type VoxRecord } from './record.js';
import type { VoxSourceCheck } from './sources.js';

export type VoxWord = 'CAD checked' | 'measured' | 'estimated' | 'model prediction' | 'stale' | 'unknown';
export const VOX_WORDS: readonly VoxWord[] = ['CAD checked', 'measured', 'estimated', 'model prediction', 'stale', 'unknown'];

/** What each word means, said once (the board's legend and /vox). */
export const WORD_MEANS: Readonly<Record<VoxWord, string>> = {
  'CAD checked': "a value of generated CAD that Timmy compared with its source's own report or prediction and found within tolerance",
  measured: 'a deterministic computation on these exact bytes',
  estimated: 'a value that rests on an assumption, named beside it',
  'model prediction': "a model's output: a claim, not a measurement",
  stale: 'an input changed since the record: not known to hold for it now',
  unknown: 'no value, or nothing that vouches for it; why is said',
};

/** A word and what it rests on. */
export interface WordSaid { word: VoxWord; note: string }

/** The assumptions an estimated value rests on, worded the same everywhere. */
export const ASSUMES = {
  stlUnits: "units not declared: an STL carries no unit, so the two files' numbers are compared in their own units, never as millimetres",
  plyUnits: "units not declared: a PLY carries no unit, and the geo lane reads both clouds' coordinates as metres",
  plyNormalized: "scaled: both clouds were scaled by the truth's longest bounding-box side, so values are in unit-cube units (--normalize)",
  plyFitted: 'fitted: the prediction was fitted to the truth (--fit), so this is a shape score, not a metric one',
  stepMm: 'millimetres assumed: OCP did not report the unit in effect',
  declared: 'as the file declares it: read from its header, not counted or decoded',
  byName: 'its kind by its name: its bytes carry no magic number',
} as const;
/** One sampled frame of a video: the time, and the scale its pixels were counted at. */
export const sampledFrame = (time?: string, scale?: number): string =>
  `one sampled frame${time ? ` (the frame shown at ${time} s)` : ''}, as ffmpeg decoded it${scale && scale !== 1 ? `, scaled by 1/${scale} before its pixels were counted` : ''}`;
export const MEASURED_NOTE = 'computed from these exact bytes';
export const NATIVE_NOTE = 'a second pass of the same application over these exact bytes';

const isWord = (v: unknown): v is VoxWord => typeof v === 'string' && (VOX_WORDS as readonly string[]).includes(v);

/** What a record says about the action, for deriving a word. */
export interface WordContext { action: string; kinds: ReadonlyArray<VoxKind | string> }

type MetricLike = Pick<VoxMetric, 'name' | 'value'> & Partial<Pick<VoxMetric, 'unit' | 'method' | 'tier' | 'label' | 'of' | 'note' | 'title' | 'status_word' | 'status_note'>>;

/** Why a value is missing, from its own note where it says. */
function unknownWhy(m: MetricLike): string {
  const n = typeof m.note === 'string' ? m.note.replace(/^not measured:\s*/i, '') : '';
  return n || 'no value was recorded';
}

/** The word of a value from what its record holds (a record made before H61, or a value no action worded). */
export function deriveMetricWord(m: MetricLike, ctx: WordContext): WordSaid {
  if (m.tier === TIER.model) return { word: 'model prediction', note: m.label ?? "a model's output, not a measurement" };
  if (m.value === null || m.value === undefined) return { word: 'unknown', note: unknownWhy(m) };
  if (m.tier === TIER.declared) return { word: 'estimated', note: ASSUMES.declared };
  if (m.name === 'file_kind' && /file name/.test(m.method ?? '')) return { word: 'estimated', note: ASSUMES.byName };
  if (m.label === LABEL.geo) {
    const text = `${m.unit ?? ''} ${m.method ?? ''} ${m.title ?? ''}`;
    return { word: 'estimated', note: /^not metric/.test(m.note ?? '') ? ASSUMES.plyFitted : /unit-cube/.test(text) ? ASSUMES.plyNormalized : ASSUMES.plyUnits };
  }
  if (m.name.split(':')[0] === 'color_at') {
    const time = /^color_at:([0-9.]+)/.exec(m.name)?.[1];
    const scale = Number(/scaled by 1\/([0-9.]+)/.exec(m.method ?? '')?.[1]);
    return { word: 'estimated', note: sampledFrame(time, Number.isFinite(scale) ? scale : undefined) };
  }
  if (typeof m.unit === 'string' && m.unit.includes('the unit in effect was not reported')) return { word: 'estimated', note: ASSUMES.stepMm };
  if (ctx.action === 'compare' && m.of === 'delta' && ctx.kinds.length === 2 && ctx.kinds.every((k) => k === 'stl')) return { word: 'estimated', note: ASSUMES.stlUnits };
  return { word: 'measured', note: m.tier === TIER.native ? NATIVE_NOTE : MEASURED_NOTE };
}

/** A value's word: the one its record carries, else derived. `derived` says which. */
export function metricWord(m: MetricLike, ctx: WordContext): WordSaid & { derived: boolean } {
  if (isWord(m.status_word) && m.status_word !== 'stale') return { word: m.status_word, note: typeof m.status_note === 'string' ? m.status_note : WORD_MEANS[m.status_word], derived: false };
  return { ...deriveMetricWord(m, ctx), derived: true };
}

/** From the strongest to the weakest: a highlight takes the weakest word of the values it was drawn from. */
const STRENGTH: readonly VoxWord[] = ['CAD checked', 'measured', 'estimated', 'model prediction', 'stale', 'unknown'];

/** A highlight's word: the one its record carries, else the weakest of the values it was drawn from (by name, and by input). */
export function highlightWord(h: Pick<VoxHighlight, 'drawn_from'> & Partial<Pick<VoxHighlight, 'of' | 'status_word' | 'status_note'>>, values: ReadonlyArray<{ name: string; of?: string; said: WordSaid }>): WordSaid & { derived: boolean } {
  if (isWord(h.status_word) && h.status_word !== 'stale') return { word: h.status_word, note: typeof h.status_note === 'string' ? h.status_note : WORD_MEANS[h.status_word], derived: false };
  const from = values.filter((v) => h.drawn_from.some((d) => v.name === d || v.name.startsWith(`${d}:`)) && v.of !== 'delta' && (!h.of || h.of === 'both' || !v.of || v.of === h.of));
  if (!from.length) return { word: 'unknown', note: 'the values it was drawn from are not in the record', derived: true };
  const weakest = from.reduce((w, v) => (STRENGTH.indexOf(v.said.word) > STRENGTH.indexOf(w.said.word) ? v : w));
  const note = weakest.said.word === 'measured' ? 'drawn from measured values only'
    : weakest.said.word === 'CAD checked' ? `drawn from CAD-checked values (${weakest.said.note})` : `drawn from ${weakest.said.word} values: ${weakest.said.note}`;
  return { word: weakest.said.word, note, derived: true };
}

/** What a passing check says on each value it covers. */
export function checkedNote(c: Pick<VoxSourceCheck, 'against' | 'tolerance'>): string {
  return `checked against ${c.against}: within ${c.tolerance}`;
}

/** The checks (of this input) that compared this metric: all within → CAD checked; any outside → said on the value. */
function checkOf(m: VoxMetric, checks: readonly VoxSourceCheck[]): { agrees: true; check: VoxSourceCheck } | { agrees: false; check: VoxSourceCheck; by: number | null } | undefined {
  if (m.of === 'delta') return undefined;
  for (const c of checks) {
    if (c.why || (c.role ?? undefined) !== (m.of ?? undefined)) continue;
    const rows = c.compared.filter((x) => x.metric === m.name);
    if (!rows.length) continue;
    if (rows.every((x) => x.within)) return { agrees: true, check: c };
    const by = rows.filter((x) => !x.within).map((x) => (typeof x.difference === 'number' ? Math.abs(x.difference) : null)).reduce<number | null>((a, d) => (d === null ? a : a === null ? d : Math.max(a, d)), null);
    return { agrees: false, check: c, by };
  }
  return undefined;
}

/**
 * Words every value, claim and highlight of a new record (called once, as the record is settled): a value an agreeing
 * check covers is CAD checked; one a check found outside its tolerance stays measured and says by how much; every
 * other value gets the word its record supports (deriveMetricWord); a value an action already worded keeps its word.
 */
export function settleWords(rec: VoxRecord): void {
  const ctx: WordContext = { action: rec.action, kinds: rec.inputs.map((i) => i.kind) };
  const checks = rec.checks ?? [];
  for (const m of rec.metrics) {
    if (isWord(m.status_word)) { m.status_note ??= WORD_MEANS[m.status_word]; continue; }
    const c = checkOf(m, checks);
    const said: WordSaid = c?.agrees ? { word: 'CAD checked', note: checkedNote(c.check) } : deriveMetricWord(m, ctx);
    if (c && !c.agrees && said.word === 'measured') said.note = `${said.note}; not CAD checked: it differs from ${c.check.against}${c.by !== null ? ` by up to ${Number(c.by.toPrecision(3))}` : ''}, beyond ${c.check.tolerance}`;
    m.status_word = said.word;
    m.status_note = said.note;
  }
  for (const c of rec.claims ?? []) wordClaim(c);
  const values = rec.metrics.map((m) => ({ name: m.name, ...(m.of ? { of: m.of } : {}), said: { word: m.status_word!, note: m.status_note! } }));
  for (const h of rec.highlights) {
    if (isWord(h.status_word)) continue;
    const s = highlightWord(h, values);
    h.status_word = s.word;
    h.status_note = s.note;
  }
}

function wordClaim(c: VoxClaim): void {
  c.status_word = 'model prediction';
  c.status_note = `${c.claimed_by}: a model's output, not a measurement`;
}

/** The record's check now (src/repl/board-vox.ts readVoxRecord) over a recorded word: stale and unverified say so. */
export function shownWord(said: WordSaid, check: { status: 'verified' | 'stale' | 'unverified'; reasons: readonly string[] }): WordSaid & { recorded?: VoxWord } {
  if (check.status === 'stale') return { word: 'stale', note: check.reasons[0] ?? 'an input changed since the record', recorded: said.word };
  if (check.status === 'unverified') return { word: 'unknown', note: `not verified: ${check.reasons[0] ?? 'no vox receipt sealed this record'}`, recorded: said.word };
  return said;
}

/** "measured", "estimated: units not declared …": a word with its note, as one line says it. */
export function wordText(s: WordSaid, o: { note?: boolean } = {}): string {
  if (o.note === false || s.word === 'measured' || s.word === 'model prediction') return s.word;
  return `${s.word}: ${s.note}`;
}
