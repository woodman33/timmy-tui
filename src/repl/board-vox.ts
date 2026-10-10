/**
 * Timmy VoxVision on the board (round R4, helper H49): the VoxVision section of the snapshot (/board) and of the live
 * board (/board live). It shows, for the project:
 *
 *   Tools    each supported tool: built in, found (not run until an action uses it) or needs setup, with its exact step
 *   Files    the project's files of a kind a tool reads, each with the commands (snapshot) or the Inspect, Measure,
 *            Detect and Compare buttons (live; Compare takes the second file from a list of files of the same kind)
 *   Records  one card per record (results/vox/<id>.json), newest first: the highlight images, the metrics with their
 *            tier, method and who measured them, the inputs, the failures and "needs setup" rows, the action's command
 *
 * A record is editable, so a card is checked before anything on it is drawn as measured (as observation cards are): it
 * is verified when a `vox` receipt on the runs chain sealed exactly the record's bytes for this project and its inputs
 * are the bytes it names; stale when an input changed since; unverified otherwise. A highlight is drawn only when its
 * bytes are the ones the record and the receipt name. On the live board the images come through the token-protected
 * /file route (voxFileFor), loaded by the page's script as blob: URLs; the snapshot links them relatively.
 *
 * Round R4 (H61): each value and highlight shows its status word first (the record's, or derived for an older record;
 * "stale" or "unknown" when the card's check says so) with what it rests on; its tier, method and who measured it are
 * the card's advanced view. Each input names its frame; a compare says whether its two were drawn together; the CAD
 * checks and the views (/vox view) are listed. On the live board only, each verified or stale card has View in Rerun
 * (the typed `/vox view <id> rerun`) while Rerun's viewer is found, else its setup step.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { humanBytes, readProjectFile, resolveInside, type ProjectFile } from '../project/index.js';
import { hashFile } from '../project/intake.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { Receipt } from '../utils/receipts.js';
import { headBytes, KIND_WORDS, voxKindOf, type VoxKind } from '../vox/kinds.js';
import { DOCTRINE_15, num, TIER, VOX_ACTIONS, VOX_DIR, VOX_ID, type VoxAction } from '../vox/record.js';
import { metricText, toolStatuses, type ToolEnv, type ToolStatus } from '../vox/tools.js';
// R4 (H61): each value's and highlight's status word (the record's, or derived for an older record; stale and unverified
// said over it), each input's frame, the CAD checks, whether a compare's two were drawn together, and the views.
import { highlightWord, MEASURED_NOTE, metricWord, NATIVE_NOTE, shownWord, VOX_WORDS, WORD_MEANS, type VoxWord, type WordSaid } from '../vox/words.js';
import { frameFromRecord, together, type VoxFrame } from '../vox/frames.js';
import { checkWords, receiptShort, type VoxSourceCheck } from '../vox/sources.js';
import { RERUN_SETUP } from '../vox/layers.js';
import { esc, stamp, type Kit } from './board-kit.js';
import { voxArg } from '../vox/args.js';

/** How many record cards and offered files the board shows; the rest are counted. */
export const VOX_MAX = { cards: 12, files: 40 } as const;
const RECORD = /^results\/vox\/(v[0-9a-f]{8})\.json$/;
const HIGHLIGHT = /^results\/vox\/(v[0-9a-f]{8})\/(?:frames(?:-[ab])?\/)?[A-Za-z0-9._-]+\.(png|svg)$/;
const OFFERED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mov', '.webm', '.stl', '.step', '.stp', '.blend', '.ply']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const shortSha = (h?: string): string => (h ? h.slice(0, 12) : 'none');

/** R4 (H61): the word a value or highlight is shown with: `recorded`, the record's own when the check says stale or unverified; `derived`, an older record's (no word in it). */
export type ShownWord = WordSaid & { recorded?: VoxWord; derived?: boolean };
export interface VoxCardMetric { name: string; title: string; value: unknown; unit?: string; method?: string; tier?: string; label?: string; measured_by?: string; of?: string; note?: string; malformed?: boolean; status_word?: string; status_note?: string; said?: ShownWord }
export interface VoxCardHighlight { path: string; sha256?: string; type?: string; drawn_from: string[]; drawn_by?: string; method?: string; of?: string; shown: boolean; why?: string; status_word?: string; status_note?: string; said?: ShownWord }
export interface VoxCheck { status: 'verified' | 'stale' | 'unverified'; receipt?: string; reasons: string[] }
/** R4 (H61): a view of the record's files (/vox view), with the vox receipt that sealed it. */
export interface VoxCardView { at: string; viewer: string; program?: string; passed: string[]; notPassed: Array<{ path: string; why: string }>; pid?: number; receipt?: string }
export interface VoxCard {
  file: string; id: string; action: string; command?: string; madeAt?: string; status: string;
  inputs: Array<{ path: string; sha256?: string; bytes?: number; kind?: string; kind_by?: string; role?: string; note?: string; frame?: VoxFrame }>;
  tools: Array<{ tool: string; name?: string; version?: string; engine?: string; ran?: string; job?: string; state?: string; status?: string; raw?: string }>;
  metrics: VoxCardMetric[];
  claims: VoxCardMetric[];
  highlights: VoxCardHighlight[];
  failures: Array<{ tool: string; code: string; message: string; setup?: string; of?: string }>;
  notes: string[];
  doctrine: boolean;
  check: VoxCheck;
  /** R4 (H61): each CAD check in a line (whether it found the values within tolerance) */
  checks?: Array<{ words: string; agrees: boolean }>;
  /** R4 (H61): a compare: whether its two inputs share a known frame and unit (drawn together), or why not */
  together?: { drawn: boolean; words: string };
  views?: VoxCardView[];
}
export interface BoardVox {
  cards: VoxCard[];
  more: number;
  tools: ToolStatus[];
  /** the project's files a supported tool reads (live: offered with buttons) */
  files: Array<{ rel: string; kind: Exclude<VoxKind, 'other'> }>;
  filesMore: number;
}

/** The vox receipt that sealed a record's path for this project (the newest), if any. */
function sealOf(chain: readonly Receipt[], rel: string, pid?: string): Receipt | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const r = chain[i];
    if (r.kind === 'vox' && (!pid || r.project_id === pid) && r.outputs?.[0]?.path === rel) return r;
  }
  return undefined;
}
/** The receipt's short id as /receipts prints it: the store writes `sha256_<hex>` (r18 showed "sha256_2" from a `sha256:`-only strip). */
const shortId = (r: Receipt): string => (r.hash ?? '').replace(/^sha256[:_]/, '').slice(0, 8);

/**
 * The live board rebuilds its state every 2 s: a file's sha256 is kept with its size, mtime and ctime, and computed again
 * only when one of them changes (any write changes ctime, which no program can set back).
 */
const hashes = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; sha256: string }>();
/** A file's sha256 now: null when it is not there, undefined when it cannot be read. */
function shaNow(root: string, rel: string): string | null | undefined {
  const at = resolveInside(root, rel);
  if ('error' in at) return undefined;
  try {
    const st = statSync(at.path);
    if (!st.isFile()) return undefined;
    const known = hashes.get(at.path);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs && known.ctimeMs === st.ctimeMs) return known.sha256;
    const now = hashFile(at.path);
    if (hashes.size > 2000) hashes.clear();
    hashes.set(at.path, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sha256: now });
    return now;
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
}

/** A record read for a card (every string as the record gives it; the caller scrubs), with its check. */
export function readVoxRecord(o: { root: string; file: string; text: string; fileSha256?: string; chain: readonly Receipt[]; projectId?: string }): VoxCard | null {
  let r: Record<string, unknown> | undefined;
  try { r = obj(JSON.parse(o.text)); } catch { return null; }
  const id = RECORD.exec(o.file)?.[1];
  if (!r || r.schema !== 'timmy.vox/1' || !id) return null;
  const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.map((x) => obj(x) ?? { malformed: x }) : []);
  const metric = (m: Record<string, unknown>): VoxCardMetric => {
    const name = str(m.name);
    if (!name || m.malformed !== undefined) return { name: name ?? '(an entry with no name)', title: name ?? '(an entry with no name)', value: m.malformed ?? m, malformed: true };
    return {
      name, title: str(m.title) ?? name, value: m.value,
      ...Object.fromEntries((['unit', 'method', 'tier', 'label', 'measured_by', 'of', 'note', 'status_word', 'status_note'] as const).flatMap((k) => (str(m[k]) ? [[k, str(m[k])]] : []))),
    } as VoxCardMetric;
  };
  const inputs: VoxCard['inputs'] = list(r.inputs).map((i) => {
    // R4 (H61): the input's frame as recorded (its words and unit), when well formed; else told from the record below.
    const f = obj(i.frame);
    const frame = f && str(f.words) && str(f.space) ? { space: str(f.space), unit: str(f.unit) ?? null, unit_by: str(f.unit_by) ?? 'not declared', words: str(f.words), ...(Array.isArray(f.size) && f.size.length === 2 && f.size.every((x) => typeof x === 'number') ? { size: f.size as [number, number] } : {}) } as VoxFrame : undefined;
    return {
      path: str(i.path) ?? '(no path)', ...(typeof i.bytes === 'number' ? { bytes: i.bytes } : {}),
      ...(Object.fromEntries((['sha256', 'kind', 'kind_by', 'role', 'note'] as const).flatMap((k) => (str(i[k]) ? [[k, str(i[k])]] : []))) as Partial<Record<'sha256' | 'kind' | 'kind_by' | 'role' | 'note', string>>),
      ...(frame ? { frame } : {}),
    };
  });
  // The check: the receipt sealed these bytes; the inputs are the bytes named.
  const reasons: string[] = [];
  const seal = sealOf(o.chain, o.file, o.projectId);
  let status: VoxCheck['status'] = 'verified';
  if (!seal) { status = 'unverified'; reasons.push('no vox receipt on the runs chain sealed this record'); }
  else if (!o.fileSha256 || seal.outputs?.[0]?.sha256 !== o.fileSha256) { status = 'unverified'; reasons.push(`the record is not the file its receipt ${shortId(seal)} sealed: it was changed after it was written`); }
  if (status === 'verified') {
    for (const i of inputs) {
      const now = i.sha256 ? shaNow(o.root, i.path) : undefined;
      if (now === i.sha256) continue;
      status = 'stale';
      reasons.push(now === null ? `${i.path} is gone since` : now === undefined ? `${i.path} cannot be read now` : `${i.path} changed since (sha256 ${shortSha(now)} now, ${shortSha(i.sha256)} measured)`);
    }
  }
  const sealed = new Map((seal?.outputs ?? []).map((x) => [x.path, x.sha256]));
  const highlights = list(r.highlights).map((h): VoxCardHighlight => {
    const p = str(h.path) ?? '';
    const base = { path: p, ...(str(h.sha256) ? { sha256: str(h.sha256) } : {}), drawn_from: Array.isArray(h.drawn_from) ? h.drawn_from.filter((x): x is string => typeof x === 'string') : [], ...Object.fromEntries((['type', 'drawn_by', 'method', 'of', 'status_word', 'status_note'] as const).flatMap((k) => (str(h[k]) ? [[k, str(h[k])]] : []))) };
    if (!HIGHLIGHT.test(p) || RECORD.exec(o.file)?.[1] !== HIGHLIGHT.exec(p)?.[1]) return { ...base, shown: false, why: 'not a highlight of this record' };
    if (status === 'unverified') return { ...base, shown: false, why: 'the record is not verified' };
    const now = shaNow(o.root, p);
    if (!now || now !== str(h.sha256) || sealed.get(p) !== now) return { ...base, shown: false, why: now === null ? 'its file is gone' : 'its file is not the bytes the record and its receipt name' };
    return { ...base, shown: true };
  });
  const tools = list(r.tools).map((t) => {
    const job = obj(t.job);
    const raw = obj(t.raw);
    return {
      tool: str(t.tool) ?? '?', ...Object.fromEntries((['name', 'version', 'engine', 'ran', 'status'] as const).flatMap((k) => (str(t[k]) ? [[k, str(t[k])]] : []))),
      ...(str(job?.id) ? { job: str(job?.id), state: str(job?.state) } : {}), ...(str(raw?.path) ? { raw: str(raw?.path) } : {}),
    };
  });
  // R4 (H61): every value's and highlight's word: the record's (or derived for an older one), with the check over it.
  const action = str(r.action) ?? '?';
  const check: VoxCheck = { status, ...(seal ? { receipt: shortId(seal) } : {}), reasons };
  const metrics = list(r.metrics).map(metric);
  for (const i of inputs) i.frame = frameFromRecord(i, metrics.filter((m) => !m.malformed));
  const ctx = { action, kinds: inputs.map((i) => i.kind ?? 'other') };
  const recorded = new Map<VoxCardMetric, WordSaid & { derived: boolean }>();
  const say = (m: VoxCardMetric): VoxCardMetric => {
    if (m.malformed) return { ...m, said: { word: 'unknown', note: 'a malformed entry of the record', derived: true } };
    const w = metricWord(m as Parameters<typeof metricWord>[0], ctx);
    recorded.set(m, w);
    return { ...m, said: { ...shownWord(w, check), derived: w.derived } };
  };
  const saidMetrics = metrics.map(say);
  const values = metrics.filter((m) => recorded.has(m)).map((m) => ({ name: m.name, ...(m.of ? { of: m.of } : {}), said: recorded.get(m)! }));
  const saidHighlights = highlights.map((h) => {
    const w = highlightWord(h as Parameters<typeof highlightWord>[0], values);
    return { ...h, said: { ...shownWord(w, check), derived: w.derived } };
  });
  const checks = list(r.checks).filter((c) => c.malformed === undefined).map((c) => {
    const compared = Array.isArray(c.compared) ? c.compared.map(obj).filter((x): x is Record<string, unknown> => !!x).map((x) => ({ metric: str(x.metric) ?? '?', what: str(x.what) ?? '?', reported: x.reported as number, measured: x.measured as number, difference: typeof x.difference === 'number' ? x.difference : null, within: x.within === true })) : [];
    const sc: VoxSourceCheck = { input: str(c.input) ?? '?', against: str(c.against) ?? 'its source', source: { kind: 'openscad-summary' }, tolerance: str(c.tolerance) ?? 'its tolerance', compared, agrees: c.agrees === true, ...(str(c.why) ? { why: str(c.why) } : {}), ...(c.role === 'a' || c.role === 'b' ? { role: c.role } : {}) };
    return { words: `${sc.role ? `${sc.role}: ` : ''}${checkWords(sc)}`, agrees: sc.agrees && !sc.why };
  });
  const t = obj(r.together);
  const together_ = t && typeof t.drawn === 'boolean' && str(t.words) ? { drawn: t.drawn, words: str(t.words)! }
    : action === 'compare' && inputs.length === 2 && inputs[0].kind && inputs[0].kind === inputs[1].kind && inputs[0].kind !== 'other' && inputs[0].frame && inputs[1].frame
      ? together({ kind: inputs[0].kind as VoxKind, frame: inputs[0].frame }, { kind: inputs[1].kind as VoxKind, frame: inputs[1].frame }) : undefined;
  const views = list(r.views).filter((v) => v.malformed === undefined && str(v.at)).slice(-12).map((v): VoxCardView => {
    const sealedBy = [...o.chain].reverse().find((x) => {
      const s = obj(Array.isArray(x.sources) ? x.sources[0] : undefined);
      return x.kind === 'vox' && (!o.projectId || x.project_id === o.projectId) && s?.event === 'view' && s.vox === id && s.at === v.at;
    });
    return {
      at: str(v.at)!, viewer: str(v.viewer) ?? '?', ...(str(v.program) ? { program: str(v.program) } : {}),
      passed: list(v.passed).flatMap((p) => (str(p.path) ? [str(p.path)!] : [])),
      notPassed: list(v.not_passed).flatMap((p) => (str(p.path) ? [{ path: str(p.path)!, why: str(p.why) ?? '' }] : [])),
      ...(typeof v.pid === 'number' ? { pid: v.pid } : {}), ...(sealedBy ? { receipt: receiptShort(sealedBy) } : {}),
    };
  });
  return {
    file: o.file, id, action, ...(str(r.command) ? { command: str(r.command) } : {}), ...(str(r.made_at) ? { madeAt: str(r.made_at) } : {}),
    status: str(r.status) ?? 'unknown', inputs, tools,
    metrics: saidMetrics, claims: list(r.claims).map(metric).map(say), highlights: saidHighlights,
    failures: list(r.failures).map((f) => ({ tool: str(f.tool) ?? '?', code: str(f.code) ?? '?', message: str(f.message) ?? '', ...(str(f.setup) ? { setup: str(f.setup) } : {}), ...(str(f.of) ? { of: str(f.of) } : {}) })),
    notes: Array.isArray(r.notes) ? r.notes.filter((x): x is string => typeof x === 'string').slice(0, 20) : [],
    doctrine: r.doctrine === DOCTRINE_15,
    check,
    ...(checks.length ? { checks } : {}), ...(together_ ? { together: together_ } : {}), ...(views.length ? { views } : {}),
  };
}

/** The VoxVision section's data for a board: the records (checked), the tools' states and the files a tool reads. */
export function readBoardVox(o: { root: string; files: readonly ProjectFile[]; chain: readonly Receipt[]; projectId?: string; scrub: (t: string) => string; tools: ToolEnv }): BoardVox {
  const cards: Array<VoxCard & { at: number }> = [];
  for (const f of o.files.filter((x) => RECORD.test(x.rel))) {
    const r = readProjectFile(o.root, f.rel, 1024 * 1024);
    if (!r.ok || !r.text || r.truncated) continue;
    const card = readVoxRecord({ root: o.root, file: f.rel, text: r.text, ...(r.sha256 ? { fileSha256: r.sha256 } : {}), chain: o.chain, ...(o.projectId ? { projectId: o.projectId } : {}) });
    if (!card) continue;
    const at = card.madeAt ? Date.parse(card.madeAt) : Number.NaN;
    cards.push({ ...scrubCard(card, o.scrub), at: Number.isNaN(at) ? f.mtimeMs : at });
  }
  cards.sort((a, b) => b.at - a.at);
  const files: BoardVox['files'] = [];
  let filesMore = 0;
  for (const f of o.files) {
    // Timmy's own working folders are not offered: r19 (ledger row 158) saw a recipe's internal workspace STLs listed
    // (.timmy/recipe-jobs/<job>/workspace/...), while the copies a run delivers sit in the project (out/, results/).
    if (f.rel.startsWith('.timmy/') || f.rel.startsWith(`${VOX_DIR}/`) || !OFFERED_EXT.has(extname(f.rel).toLowerCase())) continue;
    // Past the cap a file is counted by its name only: its bytes are not read on every poll.
    if (files.length >= VOX_MAX.files) { filesMore++; continue; }
    const k = voxKindOf(f.rel, headBytes(join(o.root, f.rel)));
    if (k.kind !== 'other') files.push({ rel: f.rel, kind: k.kind });
  }
  let tools: ToolStatus[];
  try { tools = toolStatuses(o.tools).map((t) => ({ ...t, detail: o.scrub(t.detail) })); } catch { tools = []; }
  return { cards: cards.slice(0, VOX_MAX.cards).map(({ at: _at, ...c }) => c), more: Math.max(0, cards.length - VOX_MAX.cards), tools, files, filesMore };
}

/** Every free text of a card with the project's folder as "." and the home folder as "~". */
function scrubCard(c: VoxCard, scrub: (t: string) => string): VoxCard {
  const deep = (v: unknown): unknown => (typeof v === 'string' ? scrub(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  return { ...(deep(c) as VoxCard), check: { ...c.check, reasons: c.check.reasons.map(scrub) } };
}

// ── the live board's actions and files ─────────────────────────────────────────

type VoxChecked = { ok: true; command: { name: VoxAction | 'vox'; args: string; line: string } } | { ok: false; status: number; error: string };
const textOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);

/**
 * A live-board VoxVision action, checked against the files the board offers: {"action":"vox","verb":…,"file":…} with
 * "other" for compare, and "color" (r,g,b) and "at" (seconds, comma-separated) for detect. Exact shapes only; the files
 * must be offered by the board now, of a kind the verb reads. The typed command it stands for, or why not.
 * R4 (H61): {"action":"vox","verb":"view","id":…}, View in Rerun on a record the board shows now (verified or stale):
 * the typed `/vox view <id> rerun`.
 */
export function checkVoxAction(body: Record<string, unknown>, files: ReadonlyArray<{ rel: string; kind: string }>, records: readonly string[] = []): VoxChecked {
  const bad = (status: number, error: string): VoxChecked => ({ ok: false, status, error });
  const keys = Object.keys(body).sort().join(',');
  const verb = body.verb;
  if (verb === 'view') {
    if (keys !== 'action,id,verb' || !textOk(body.id)) return bad(400, 'A view action is {"action":"vox","verb":"view","id":"<record id>"}.');
    if (!VOX_ID.test(body.id) || !records.includes(body.id)) return bad(404, `${String(body.id)} is not a VoxVision record this board offers to view.`);
    return { ok: true, command: { name: 'vox', args: `view ${body.id} rerun`, line: `/vox view ${body.id} rerun` } };
  }
  if (typeof verb !== 'string' || !(VOX_ACTIONS as readonly string[]).includes(verb)) return bad(400, 'A VoxVision action names a verb: inspect, measure, detect, compare or view.');
  const shapes: Record<string, string[]> = {
    inspect: ['action,file,verb'], measure: ['action,file,verb'], compare: ['action,file,other,verb'],
    detect: ['action,file,verb', 'action,color,file,verb', 'action,at,color,file,verb'],
  };
  if (!shapes[verb].includes(keys) || !textOk(body.file)) return bad(400, `A ${verb} action is {"action":"vox","verb":"${verb}","file":"<file>"${verb === 'compare' ? ',"other":"<file>"' : verb === 'detect' ? ' and optionally "color":"r,g,b" and "at":"t,…"' : ''}}.`);
  const file = files.find((f) => f.rel === body.file);
  if (!file) return bad(404, `${String(body.file)} is not a file VoxVision offers on this board.`);
  const arg = voxArg(file.rel);
  if (!arg) return bad(422, `${file.rel} cannot be written as one argument.`);
  if (verb === 'inspect' || verb === 'measure') return { ok: true, command: { name: verb, args: arg, line: `/${verb} ${arg}` } };
  if (verb === 'detect') {
    if (file.kind !== 'image' && file.kind !== 'video') return bad(409, `/detect reads images and videos; ${file.rel} is ${KIND_WORDS[file.kind as VoxKind] ?? file.kind}.`);
    const color = body.color;
    const at = body.at;
    if (color !== undefined && (typeof color !== 'string' || !/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/.test(color) || color.split(',').some((x) => Number(x) > 255))) return bad(422, 'A colour is r,g,b: three whole numbers from 0 to 255.');
    if (at !== undefined && (typeof at !== 'string' || !/^\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?){0,11}$/.test(at))) return bad(422, 'Times are up to 12 numbers of seconds, comma-separated.');
    if (file.kind === 'video' && color === undefined) return bad(422, 'In a video /detect finds a colour region: give its colour (r,g,b).');
    if (file.kind === 'image' && at !== undefined) return bad(422, 'An image has one frame: no times.');
    const args = `${arg}${color ? ` color ${color}` : ''}${at ? ` --at ${at}` : ''}`;
    return { ok: true, command: { name: 'detect', args, line: `/detect ${args}` } };
  }
  if (!textOk(body.other)) return bad(400, 'A compare action names its second file in "other".');
  const other = files.find((f) => f.rel === body.other);
  if (!other) return bad(404, `${String(body.other)} is not a file VoxVision offers on this board.`);
  if (other.rel === file.rel) return bad(409, '/compare needs two different files.');
  if (other.kind !== file.kind) return bad(409, `/compare needs two files of the same kind: ${file.rel} is ${file.kind}, ${other.rel} is ${other.kind}.`);
  if (file.kind === 'blend') return bad(409, 'Two .blend files are not compared here.');
  const argB = voxArg(other.rel);
  if (!argB) return bad(422, `${other.rel} cannot be written as one argument.`);
  return { ok: true, command: { name: 'compare', args: `${arg} ${argB}`, line: `/compare ${arg} ${argB}` } };
}

/**
 * A highlight file for the live board's /file route: only a PNG or SVG of a verified record, whose bytes now are the
 * ones the record and its receipt name. Its type and bytes, or null (the route answers 404).
 */
export function voxFileFor(o: { root: string; path: string; chain: readonly Receipt[]; projectId?: string }): { type: string; body: Buffer } | null {
  const m = HIGHLIGHT.exec(o.path);
  if (!m) return null;
  const recordRel = `${VOX_DIR}/${m[1]}.json`;
  const r = readProjectFile(o.root, recordRel, 1024 * 1024);
  if (!r.ok || !r.text || r.truncated) return null;
  const card = readVoxRecord({ root: o.root, file: recordRel, text: r.text, ...(r.sha256 ? { fileSha256: r.sha256 } : {}), chain: o.chain, ...(o.projectId ? { projectId: o.projectId } : {}) });
  const h = card?.highlights.find((x) => x.path === o.path && x.shown);
  if (!card || card.check.status === 'unverified' || !h) return null;
  const at = resolveInside(o.root, o.path);
  if ('error' in at) return null;
  let body: Buffer;
  try { body = readFileSync(at.path); } catch { return null; }
  if (sha(body) !== h.sha256) return null;
  return { type: m[2] === 'svg' ? 'image/svg+xml' : 'image/png', body };
}

// ── HTML ────────────────────────────────────────────────────────────────────────

const HEX = /^#[0-9a-f]{6}$/i;
const swatch = (hex: string, live: boolean): string => (HEX.test(hex) ? (live ? `<span class="swatch" data-swatch="${esc(hex)}"></span>` : `<span class="swatch" style="background:${hex}"></span>`) : '');
const plain = (v: unknown, max = 240): string => {
  if (v === null || v === undefined) return 'not measured';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const nums = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** A value as HTML: the shared words (metricText), with a swatch beside each colour. */
function valueHtml(m: VoxCardMetric, live: boolean): string {
  const v = m.value;
  if (m.malformed) return esc(plain(v));
  const o = obj(v);
  if (m.name === 'mean_color' && o && str(o.hex)) return `${swatch(str(o.hex)!, live)}${esc(str(o.hex))}`;
  if (m.name === 'dominant_colors' && Array.isArray(v) && v.length) {
    return v.map((c) => { const x = obj(c); const hex = str(x?.hex) ?? ''; return `<span class="color">${swatch(hex, live)}${esc(hex)}${typeof x?.share === 'number' ? ` ${esc(`${num(x.share * 100)}%`)}` : ''}</span>`; }).join(' ');
  }
  const text = metricText({ name: m.name, value: v });
  const unit = m.unit && v !== null && v !== undefined && (typeof v === 'number' || nums(v)) ? ` <span class="unit">${esc(m.unit)}</span>` : '';
  return `${esc(text)}${unit}`;
}

const BADGE: Record<string, string> = { ok: 'ok', untrusted: 'warn', partial: 'warn', 'needs-setup': 'warn', failed: 'bad', cancelled: 'warn' };

/**
 * R4 (H61): a status word as a small label in the text colour (stale in the attention colour, its meaning), with what it
 * rests on below it: what it was checked against, the assumption, why unknown; what the record said when stale or not verified.
 */
function wordHtml(s: ShownWord | undefined, o: { note?: boolean } = {}): string {
  if (!s) return '';
  const cls = `vox-word w-${s.word.replace(/\s+/g, '-').toLowerCase()}`;
  const plainNote = s.word === 'model prediction' || (s.word === 'measured' && (s.note === MEASURED_NOTE || s.note === NATIVE_NOTE || s.note === 'drawn from measured values only'));
  const note = o.note !== false && s.note && !plainNote ? `<span class="word-note">${esc(s.note)}</span>` : '';
  const recorded = s.recorded && s.recorded !== s.word ? `<span class="word-note">${esc(`recorded as ${s.recorded}`)}</span>` : '';
  return `<span class="${cls}" title="${esc(WORD_MEANS[s.word])}">${esc(s.word)}</span>${note}${recorded}`;
}

function cardHtml(c: VoxCard, k: Kit, base: string, rerun: { found: boolean; setup?: string } = { found: false }): string {
  const verified = c.check.status === 'verified';
  // R4 (H61): a card made by hand (or read before H61's reader) has no words yet: they are derived here, the same way.
  const ctx = { action: c.action, kinds: c.inputs.map((i) => i.kind ?? 'other') };
  const saidOf = (m: VoxCardMetric): ShownWord => m.said ?? (m.malformed ? { word: 'unknown', note: 'a malformed entry of the record' } : shownWord(metricWord(m as Parameters<typeof metricWord>[0], ctx), c.check));
  const src = (rel: string): string => esc(base + rel.split('/').map(encodeURIComponent).join('/'));
  const words = c.inputs.map((i) => `${i.role ? `${i.role}: ` : ''}${i.path}`);
  const head = `<div class="vox-head"><span class="vox-badge vox-badge-${BADGE[c.status] ?? 'warn'}">${esc(c.status === 'needs-setup' ? 'needs setup' : c.status)}</span> <strong class="verb">${esc(c.action)}</strong> ${c.inputs.map((i) => `${i.role ? `<span class="role">${esc(i.role)}</span> ` : ''}${k.fileLink(i.path)}`).join(' ')}</div>`;
  const tools = c.tools.map((t) => `${t.name ?? t.tool}${t.version ? ` ${t.version}` : ''}${t.engine ? ` (${t.engine})` : ''}${t.ran === 'in-process' ? ', in Timmy\'s process' : t.job ? `, job ${t.job}` : ''}`);
  const meta = `<div class="meta">${esc([c.id, `made ${stamp(c.madeAt)}`, ...tools].join(' · '))}</div>`;
  const check = verified
    ? `<div class="status status-verified"><strong>verified</strong> ${esc(`receipt ${c.check.receipt ?? '?'} sealed this record; its input${c.inputs.length === 1 ? ' is' : 's are'} unchanged since`)}</div>`
    : `<div class="status status-${c.check.status}"><strong>${esc(c.check.status)}</strong> ${esc(c.check.status === 'stale' ? 'measured from an earlier version of its input; not known to hold for it now' : 'these values are not verified')}<ul class="reasons">${c.check.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
  const shown = c.highlights.filter((h) => h.shown);
  const figs = shown.map((h) => {
    const img = k.live ? `<img data-vox-src="${esc(h.path)}" alt="${esc(`${h.type ?? 'highlight'} of ${words.join(' and ')}`)}">` : `<a href="${src(h.path)}"><img src="${src(h.path)}" alt="${esc(`${h.type ?? 'highlight'} of ${words.join(' and ')}`)}" loading="lazy"></a>`;
    const cap = [h.type === 'annotated' ? 'annotated copy' : h.type === 'difference-heatmap' ? 'difference heatmap' : h.type === 'bbox-svg' ? 'bounding box' : h.type === 'frame' ? 'frame read' : h.type ?? 'highlight',
      ...(h.of ? [h.of] : []), ...(h.drawn_from.length ? [`drawn from ${h.drawn_from.join(', ')}`] : []), ...(h.drawn_by ? [`by ${h.drawn_by}`] : []), `sha256 ${shortSha(h.sha256)}`];
    return `<figure>${img}<figcaption>${wordHtml(h.said)} ${esc(cap.join(' · '))}</figcaption></figure>`;
  }).join('');
  const hidden = c.highlights.filter((h) => !h.shown).map((h) => `<li>${esc(`${h.path}: not shown (${h.why ?? 'not checked'})`)}</li>`).join('');
  const highlights = `${figs ? `<div class="vox-hl">${figs}</div>` : ''}${hidden ? `<ul class="reasons">${hidden}</ul>` : ''}`;
  /** A row: its name, its method (or "the same method as above"), its value. */
  const row = (m: VoxCardMetric, prev?: VoxCardMetric): string => {
    const of = m.of === 'delta' ? 'Δ' : m.of ?? '';
    const method = m.method ? (prev?.method === m.method ? 'the same method as above' : m.method) : '';
    const note = m.note && prev?.note !== m.note ? m.note : '';
    return `<tr><td class="of">${esc(of)}</td><th scope="row">${esc(m.title)}${method ? `<span class="method">${esc(method)}</span>` : ''}${note ? `<span class="note">${esc(note)}</span>` : ''}</th><td class="val">${valueHtml(m, k.live)}</td></tr>`;
  };
  /** Rows under one line saying their tier and who measured them (the same for every row of the group). */
  const grouped = (list: VoxCardMetric[]): string => {
    const groups = new Map<string, VoxCardMetric[]>();
    for (const m of list) {
      const key = m.malformed ? 'malformed' : `${m.tier ?? ''}\u0000${m.label ?? ''}\u0000${m.measured_by ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups.values()].map((ms) => {
      const m = ms[0];
      const tier = m.malformed ? 'malformed entries' : verified ? (m.tier ?? 'no tier recorded') : `recorded as ${m.tier ?? 'no tier'}`;
      // The label often begins with the tier's words ("deterministic computation (OpenCV) on these bytes"): said once.
      const label = m.label && m.tier && m.label.startsWith(m.tier) ? m.label.slice(m.tier.length).trim() : m.label;
      const who = [label, m.measured_by].filter(Boolean).join(' · ');
      return `<p class="vox-who"><span class="tier ${m.tier === TIER.model ? 'model' : ''}">${esc(tier)}</span>${who ? ` ${esc(who)}` : ''}</p><div class="vox-table"><table class="metrics"><tbody>${ms.map((x, i) => row(x, ms[i - 1])).join('')}</tbody></table></div>`;
    }).join('');
  };
  // R4 (H61): each value with its status word first; how it was measured (its tier, method and who) in the advanced view.
  const wordRow = (m: VoxCardMetric): string => `<tr><td class="of">${esc(m.of === 'delta' ? 'Δ' : m.of ?? '')}</td><th scope="row">${esc(m.title)}</th><td class="val">${valueHtml(m, k.live)}</td><td class="word">${wordHtml(saidOf(m))}</td></tr>`;
  const wordTable = (list: VoxCardMetric[]): string => `<div class="vox-table"><table class="metrics vox-values"><tbody>${list.map(wordRow).join('')}</tbody></table></div>`;
  const how = (list: VoxCardMetric[], key: string): string => `<details class="vox-adv" data-keep="${esc(`${c.id}:${key}`)}"><summary>${esc('advanced: how each value was measured (its tier, method and who measured it)')}</summary>${grouped(list)}</details>`;
  // A long record shows its key values first (a comparison's deltas; else the first six) and every value on demand.
  const long = c.metrics.length > 10;
  const key = !long ? c.metrics : c.action === 'compare' ? c.metrics.filter((m) => m.of === 'delta' || !m.of) : c.metrics.slice(0, 6);
  const heading = verified ? (long ? 'key values' : 'values') : c.check.status === 'stale' ? 'values from an earlier version of the input' : 'not verified: values as the file records them, not measurements';
  const metrics = c.metrics.length
    ? `<section class="${verified ? 'measured' : 'unverified'} vox-metrics"><h4>${esc(heading)}</h4>${wordTable(key.length ? key : c.metrics.slice(0, 6))}`
      + `${long ? `<details class="vox-all" data-keep="${esc(`${c.id}:metrics`)}"><summary>${esc(`all ${c.metrics.length} values`)}</summary>${wordTable(c.metrics)}</details>` : ''}${how(c.metrics, 'how')}</section>`
    : '';
  const claims = c.claims.length
    ? `<section class="claim"><h4>${esc("a model's prediction (a claim, not a measurement)")}</h4>${wordTable(c.claims)}${how(c.claims, 'claims')}</section>`
    : '';
  // R4 (H61): the CAD checks, whether a compare's two were drawn together, the views, and View in Rerun (live board only).
  const checks = c.checks?.length ? `<ul class="vox-checks">${c.checks.map((x) => `<li class="${x.agrees ? 'ok' : 'warn'}">${esc(x.words)}</li>`).join('')}</ul>` : '';
  const pair = c.together ? `<p class="vox-together">${esc(c.together.words)}</p>` : '';
  const views = c.views?.length
    ? `<ul class="vox-views">${c.views.map((v) => `<li>${esc(`viewed in ${v.viewer === 'rerun' ? "Rerun's viewer" : v.viewer} ${stamp(v.at)}${v.receipt ? ` · receipt ${v.receipt}` : ' · no receipt names it'}: ${v.passed.length} file${v.passed.length === 1 ? '' : 's'} passed${v.notPassed.length ? `, ${v.notPassed.length} not (${v.notPassed.map((x) => x.path).join(', ')})` : ''}`)}</li>`).join('')}</ul>`
    : '';
  const viewer = !k.live || c.check.status === 'unverified' ? ''
    : rerun.found
      ? `<div class="vox-view">${k.act('View in Rerun', { act: 'vox', verb: 'view', id: c.id })}<span class="meta">${esc("advanced: opens Rerun's own viewer, a window on your computer that Timmy does not stop; it shows the files and measures nothing")}</span></div>`
      : `<p class="meta vox-view">${esc(`View in Rerun needs setup: ${rerun.setup ?? RERUN_SETUP}`)}</p>`;
  const fails = c.failures.map((f) => (f.code === 'needs-setup'
    ? `<li class="setup"><strong>${esc('needs setup')}</strong> ${esc(`${f.tool}${f.of ? ` (${f.of})` : ''}: ${f.message}`)}${f.setup ? `<code class="step">${esc(f.setup)}</code>` : ''}</li>`
    : `<li class="${f.code === 'untrusted' || f.code === 'not-measured' || f.code === 'cancelled' || f.code === 'unsupported' ? 'warn' : 'bad'}"><strong>${esc(f.code)}</strong> ${esc(`${f.tool}${f.of ? ` (${f.of})` : ''}: ${f.message}`)}</li>`)).join('');
  const failures = fails ? `<ul class="vox-fail">${fails}</ul>` : '';
  const inputs = `<dl class="vox-inputs">${c.inputs.map((i) => `<dt>${esc(i.role ?? 'input')}</dt><dd>${esc([i.path, i.kind ? `${KIND_WORDS[i.kind as VoxKind] ?? i.kind}${i.kind_by ? ` by its ${i.kind_by}` : ''}` : '', i.bytes !== undefined ? humanBytes(i.bytes) : '', `sha256 ${shortSha(i.sha256)}`, i.note ?? ''].filter(Boolean).join(' · '))}${i.frame ? `<span class="vox-frame">${esc(`frame: ${i.frame.words}`)}</span>` : ''}</dd>`).join('')}</dl>`;
  const raws = c.tools.filter((t) => t.raw).map((t) => t.raw!);
  const raw = raws.length ? `<p class="meta">${esc('raw output kept: ')}${raws.map((r) => k.fileLink(r, 'file')).join(', ')}</p>` : '';
  const notes = c.notes.length ? `<details class="vox-notes"><summary>${esc(`notes (${c.notes.length})`)}</summary><ul>${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : '';
  const doctrine = c.doctrine || c.inputs.some((i) => i.kind === 'stl' || i.kind === 'step' || i.kind === 'blend' || i.kind === 'ply') ? `<p class="doctrine">${esc(DOCTRINE_15)}</p>` : '';
  return `<article class="card vox-card" data-vox="${esc(c.id)}">${head}${meta}${check}${highlights}${metrics}${claims}${checks}${pair}${failures}${inputs}${raw}${views}${notes}${doctrine}${viewer}${k.cmds([...(c.command ? [c.command] : []), `/open ${c.file}`])}</article>`;
}

/** The Files panel: each file a tool reads, with its commands (snapshot) or buttons (live). */
function filesHtml(v: BoardVox, k: Kit): string {
  if (!v.files.length) return k.empty('No image, STL, STEP, .blend, video or PLY file in the project yet: /add <file> copies one into refs/.');
  const rows = v.files.map((f) => {
    const arg = voxArg(f.rel) ?? f.rel;
    const same = v.files.filter((x) => x.kind === f.kind && x.rel !== f.rel);
    const detect = f.kind === 'image' || f.kind === 'video';
    const compare = same.length > 0 && f.kind !== 'blend';
    if (!k.live) {
      const cmds = [`/inspect ${arg}`, `/measure ${arg}`, ...(f.kind === 'image' ? [`/detect ${arg}`] : f.kind === 'video' ? [`/detect ${arg} color 255,0,0 --at 0`] : []), ...(compare ? [`/compare ${arg} ${voxArg(same[0].rel) ?? same[0].rel}`] : [])];
      return `<li class="vox-file"><span class="kind">${esc(f.kind)}</span>${k.fileLink(f.rel)}${k.cmds(cmds)}</li>`;
    }
    const inputs = detect ? `<input class="vox-in" type="text" data-vox-color placeholder="${esc(f.kind === 'video' ? 'r,g,b' : 'r,g,b (opt.)')}" aria-label="${esc(`colour to detect in ${f.rel}${f.kind === 'video' ? ' (needed)' : ' (optional)'}`)}" size="14">${f.kind === 'video' ? `<input class="vox-in" type="text" data-vox-at placeholder="t s,…" aria-label="${esc(`times in seconds in ${f.rel}`)}" size="8">` : ''}` : '';
    const select = compare ? `<select class="vox-in" data-vox-other aria-label="${esc(`second file to compare with ${f.rel}`)}">${same.map((x) => `<option value="${esc(x.rel)}">${esc(x.rel)}</option>`).join('')}</select>` : '';
    return `<li class="vox-file" data-vox-file="${esc(f.rel)}"><span class="kind">${esc(f.kind)}</span><span class="name">${esc(f.rel)}</span><div class="vox-acts">`
      + `${k.act('Inspect', { act: 'vox', verb: 'inspect', file: f.rel })}${k.act('Measure', { act: 'vox', verb: 'measure', file: f.rel })}`
      + `${detect ? `${inputs}${k.act('Detect', { act: 'vox', verb: 'detect', file: f.rel })}` : ''}${compare ? `${select}${k.act('Compare', { act: 'vox', verb: 'compare', file: f.rel })}` : ''}</div></li>`;
  }).join('');
  return `<ul class="vox-files">${rows}</ul>${v.filesMore ? `<p class="more">${esc(`and ${v.filesMore} more files with a supported name: type /inspect <file>`)}</p>` : ''}`;
}

function toolsHtml(v: BoardVox): string {
  if (!v.tools.length) return '<p class="empty">The tools could not be listed.</p>';
  return `<ul class="vox-tools">${v.tools.map((t) => `<li class="vox-tool state-${t.state === 'needs setup' ? 'setup' : t.state === 'found' ? 'found' : 'builtin'}"><strong>${esc(t.name)}</strong> <span class="vox-badge vox-badge-${t.state === 'needs setup' ? 'warn' : 'ok'}">${esc(t.state)}</span><span class="meta">${esc(`${t.reads} · ${t.detail}`)}</span>${t.setup ? `<code class="step">${esc(t.setup)}</code>` : ''}</li>`).join('')}</ul>`
    + '<p class="meta">Found is not working: a tool is run only by an action, and its record says whether it ran.</p>';
}

/** The section: its table-of-contents link and its HTML (every string escaped; no style attribute on the live board). */
export function voxSection(v: BoardVox, o: { kit: Kit; base: string }): { toc: string; html: string } {
  const k = o.kit;
  const base = /^(?:\.\.\/)*$/.test(o.base) ? o.base : '';
  const n = v.cards.length + v.more;
  // R4 (H61): View in Rerun is offered on the live board while Rerun's viewer is found (else its setup step is said).
  const rr = v.tools.find((t) => t.tool === 'rerun');
  const rerun = { found: rr?.state === 'found', ...(rr?.setup ? { setup: rr.setup } : {}) };
  return {
    toc: `<a href="#voxvision">VoxVision <b>${n}</b></a>`,
    html: [
      `<h2 id="voxvision">VoxVision <span class="count">${n}</span></h2>`,
      `<p class="sub vox-lead">${esc('Inspect, Measure, Detect and Compare run the spatial tools Timmy supports on project files. Every value and highlight carries one word; how it was measured (its tier, method and who) is in each card\'s advanced view. A measurement of a CAD or mesh file is never a measurement of a physical part.')}</p>`,
      `<p class="meta vox-legend">${VOX_WORDS.map((w) => `<span class="vox-word w-${w.replace(/\s+/g, '-').toLowerCase()}">${esc(w)}</span> ${esc(WORD_MEANS[w])}`).join(' · ')}</p>`,
      `<div class="grid wide vox-panels"><article class="card"><h4>tools</h4>${toolsHtml(v)}</article><article class="card"><h4>files a tool reads</h4>${filesHtml(v, k)}</article></div>`,
      `<h3 id="vox-records">Records <span class="count">${n}</span></h3>`,
      v.cards.length ? `<div class="grid wide vox-cards">${v.cards.map((c) => cardHtml(c, k, base, rerun)).join('')}</div>` : k.empty('No VoxVision records yet: /inspect <file>, /measure, /detect or /compare makes one.'),
      v.more ? `<p class="more">${esc(`and ${v.more} more records in ${VOX_DIR}/`)}</p>` : '',
    ].join('\n'),
  };
}

export const VOX_CSS = `
.vox-lead { margin-top: -4px; }
.vox-panels .card h4, .vox-card h4 { margin-bottom: 4px; }
.vox-badge { display: inline-block; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 999px; padding: 0 7px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; vertical-align: 1px; }
.vox-badge-ok { color: ${HOMEBREW.text}; border-color: ${HOMEBREW.lineStrong}; } /* an outcome in the text colour; green is for actions (B9) */
.vox-badge-warn { color: ${HOMEBREW.attention}; border-color: ${HOMEBREW.attention}; }
.vox-badge-bad { color: ${HOMEBREW.failure}; border-color: ${HOMEBREW.failure}; }
ul.vox-tools, ul.vox-files, ul.vox-fail { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: ${TYPE.size.small}px; }
.vox-tool .meta { display: block; }
.vox-tool.state-setup strong { color: ${HOMEBREW.attention}; }
code.step { display: block; margin-top: 2px; color: ${HOMEBREW.text}; background: ${HOMEBREW.raised}; border: 1px solid ${HOMEBREW.line}; border-radius: 4px; padding: 2px 6px; overflow-wrap: anywhere; font: inherit; font-size: 12px; }
.vox-file { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; border-bottom: 1px solid ${HOMEBREW.line}; padding-bottom: 6px; }
.vox-file .cmds { margin-top: 0; width: 100%; }
.vox-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; width: 100%; }
.vox-in { font: inherit; font-size: 12px; color: ${HOMEBREW.text}; background: ${HOMEBREW.raised}; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 6px; padding: 2px 6px; max-width: 100%; }
.vox-in:focus-visible { outline: 2px solid ${HOMEBREW.accent}; outline-offset: 1px; }
.vox-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.vox-head .verb { text-transform: uppercase; letter-spacing: .06em; color: ${HOMEBREW.accent}; }
.vox-head .role { color: ${HOMEBREW.textSecondary}; font-size: 11px; }
.vox-hl { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); gap: 8px; }
.vox-hl figure { margin: 0; background: ${HOMEBREW.raised}; border: 1px solid ${HOMEBREW.line}; border-radius: 6px; overflow: hidden; }
.vox-hl img { display: block; width: 100%; height: 200px; object-fit: contain; background: ${HOMEBREW.ground}; }
.vox-hl img[data-failed] { height: auto; padding: 8px; color: ${HOMEBREW.attention}; }
.vox-hl figcaption { font-size: 11px; color: ${HOMEBREW.textSecondary}; padding: 4px 6px; overflow-wrap: anywhere; }
.vox-table { overflow-x: auto; }
table.metrics { width: 100%; border-collapse: collapse; font-size: ${TYPE.size.small}px; table-layout: fixed; }
table.metrics th, table.metrics td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid ${HOMEBREW.line}; overflow-wrap: anywhere; }
table.metrics td.of { color: ${HOMEBREW.textSecondary}; width: 1.6em; padding-right: 0; }
table.metrics th { font-weight: ${TYPE.weight.strong}; color: ${HOMEBREW.text}; width: 46%; }
table.metrics th span { display: block; font-weight: ${TYPE.weight.body}; font-size: 11px; color: ${HOMEBREW.textSecondary}; }
table.metrics th span.note { font-style: italic; }
table.metrics td.val { color: ${HOMEBREW.text}; }
table.metrics .unit { color: ${HOMEBREW.textSecondary}; }
.vox-who { margin: 8px 0 2px; font-size: 11px; color: ${HOMEBREW.textSecondary}; overflow-wrap: anywhere; }
.vox-who .tier { font-style: normal; margin: 0 4px 0 0; color: ${HOMEBREW.accent}; text-transform: uppercase; letter-spacing: .04em; }
.vox-who .tier.model { color: ${HOMEBREW.ai}; }
section.unverified .vox-who .tier, section.unverified table.metrics td.val { color: ${HOMEBREW.textSecondary}; }
.vox-fail li { border-left: 3px solid ${HOMEBREW.lineStrong}; padding-left: 8px; }
.vox-fail li.setup { border-left-color: ${HOMEBREW.attention}; }
.vox-fail li.setup strong, .vox-fail li.warn strong { color: ${HOMEBREW.attention}; }
.vox-fail li.bad { border-left-color: ${HOMEBREW.failure}; }
.vox-fail li.bad strong { color: ${HOMEBREW.failure}; }
.vox-fail strong { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; margin-right: 4px; }
dl.vox-inputs dd { color: ${HOMEBREW.textSecondary}; }
.vox-all summary, .vox-notes summary { cursor: pointer; color: ${HOMEBREW.textSecondary}; font-size: 12px; margin-top: 6px; }
.vox-notes { font-size: 12px; color: ${HOMEBREW.textSecondary}; }
.vox-notes ul { margin: 4px 0 0; padding-left: 18px; }
.vox-card .doctrine { margin: 0; font-size: 12px; color: ${HOMEBREW.text}; border-left: 3px solid ${HOMEBREW.attention}; padding-left: 8px; }
/* R4 (H61): the status words, in the text colour (stale in the attention colour, its meaning); what each rests on below it */
.vox-word { display: inline-block; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 4px; padding: 0 5px; font-size: 10.5px; line-height: 1.5; text-transform: uppercase; letter-spacing: .05em; color: ${HOMEBREW.text}; white-space: nowrap; }
.vox-word.w-stale { color: ${HOMEBREW.attention}; border-color: ${HOMEBREW.attention}; }
.word-note { display: block; font-size: 11px; color: ${HOMEBREW.textSecondary}; overflow-wrap: anywhere; }
table.vox-values th { width: 34%; }
table.vox-values td.val { width: 30%; }
table.vox-values td.word { width: 36%; }
.vox-legend { font-size: 11px; }
.vox-legend .vox-word { margin-right: 2px; }
.vox-adv summary { cursor: pointer; color: ${HOMEBREW.textSecondary}; font-size: 12px; margin-top: 6px; }
ul.vox-checks, ul.vox-views { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: ${HOMEBREW.textSecondary}; }
ul.vox-checks li { border-left: 3px solid ${HOMEBREW.lineStrong}; padding-left: 8px; color: ${HOMEBREW.text}; }
ul.vox-checks li.warn { border-left-color: ${HOMEBREW.attention}; }
.vox-together { margin: 0; font-size: 12px; color: ${HOMEBREW.text}; border-left: 3px solid ${HOMEBREW.lineStrong}; padding-left: 8px; }
.vox-frame { display: block; font-size: 11px; color: ${HOMEBREW.textSecondary}; }
.vox-view { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.vox-view .meta { font-size: 11px; }
`;

/**
 * The live page's VoxVision part (src/repl/board-live.ts includes it before its own script, as it does the editor's):
 * the action body of a VoxVision button, and the highlight images, fetched through /file with the token (which stays in
 * the live script's closure: it hands `get` over) and shown as blob: URLs, revoked at each redraw. A row whose inputs
 * hold text is marked data-editing, so the page does not redraw over what is being typed.
 */
export const VOX_LIVE_SCRIPT = `
var TimmyVox = (function () {
  'use strict';
  var get = null;
  var urls = [];
  var row = function (el) { return el && el.closest ? el.closest('[data-vox-file]') : null; };
  var editing = function (r) {
    if (!r) return;
    var any = false;
    var ins = r.querySelectorAll('input.vox-in');
    for (var i = 0; i < ins.length; i++) if (ins[i].value.trim()) any = true;
    if (any || r.hasAttribute('data-picked')) r.setAttribute('data-editing', ''); else r.removeAttribute('data-editing');
  };
  document.addEventListener('input', function (e) { editing(row(e.target)); });
  document.addEventListener('change', function (e) { var r = row(e.target); if (r && e.target.tagName === 'SELECT') r.setAttribute('data-picked', ''); editing(r); });
  return {
    attach: function (o) { get = o.get; },
    body: function (b) {
      // R4 (H61): View in Rerun names a record, not a file.
      if (b.getAttribute('data-verb') === 'view') return { action: 'vox', verb: 'view', id: b.getAttribute('data-id') };
      var r = row(b);
      var body = { action: 'vox', verb: b.getAttribute('data-verb'), file: b.getAttribute('data-file') };
      if (body.verb === 'compare') { var s = r ? r.querySelector('select[data-vox-other]') : null; if (!s || !s.value) return null; body.other = s.value; }
      if (body.verb === 'detect' && r) {
        var c = r.querySelector('input[data-vox-color]');
        var t = r.querySelector('input[data-vox-at]');
        if (c && c.value.trim()) body.color = c.value.replace(/\\s+/g, '');
        if (t && t.value.trim()) body.at = t.value.replace(/\\s+/g, '');
      }
      if (r) { r.removeAttribute('data-editing'); r.removeAttribute('data-picked'); }
      return body;
    },
    paint: function (main) {
      for (var i = 0; i < urls.length; i++) URL.revokeObjectURL(urls[i]);
      urls = [];
      if (!get) return;
      var imgs = main.querySelectorAll('img[data-vox-src]');
      for (var k = 0; k < imgs.length; k++) (function (img) {
        get(img.getAttribute('data-vox-src'))
          .then(function (r) { if (!r.ok) throw r.status; return r.blob(); })
          .then(function (blob) { var u = URL.createObjectURL(blob); urls.push(u); img.src = u; },
            function () { img.setAttribute('data-failed', ''); img.alt = 'not shown: the board could not load this highlight'; });
      })(imgs[k]);
    }
  };
})();
`;
