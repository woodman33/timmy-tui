/**
 * Public board templates for Timmy Canvas (fourth order, step 5: public templates start blank). The
 * seeds shipped in the public tree (`templates/boards`, listed by its INDEX.json) are read as their
 * id, title, domain and capability names, and nothing else (other fields are never read); a seed whose
 * fields are not each in their own shape is skipped. The canvas opens one as a blank board: its title
 * and an empty slot per capability.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BoardTemplate {
  id: string;
  title: string;
  domain: string;
  caps: string[];
}

const ID = /^[A-Z]{1,3}\d{1,4}$/;
const CAP = /^[a-z]+(\.[a-z]+)+$/;
const TEXT = /^[\w &+.,/:'()-]{1,60}$/;

/** templates/boards, from the source (src/studio) or the build (dist/src/studio). */
export function templatesDir(): string {
  const candidates = ['../../templates/boards', '../../../templates/boards'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  return candidates.find(existsSync) ?? candidates[0];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** One seed as a template, or null when it is not one: four fields, each in its own shape. */
function asTemplate(seed: unknown, expectedId: string): BoardTemplate | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const { id, title, domain, caps } = seed as Record<string, unknown>;
  if (id !== expectedId || typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof title !== 'string' || !TEXT.test(title) || typeof domain !== 'string' || !TEXT.test(domain)) return null;
  if (!Array.isArray(caps) || caps.length === 0 || caps.length > 12 || !caps.every((c) => typeof c === 'string' && CAP.test(c))) return null;
  return { id, title, domain, caps: [...caps] };
}

/** The public board templates, in their index's order. */
export function publicTemplates(dir = templatesDir()): BoardTemplate[] {
  const index = readJson(join(dir, 'INDEX.json')) as { boards?: unknown } | null;
  const ids = Array.isArray(index?.boards) ? index.boards.filter((b): b is string => typeof b === 'string' && ID.test(b)) : [];
  return ids.map((id) => asTemplate(readJson(join(dir, `${id}.json`)), id)).filter((t): t is BoardTemplate => t !== null);
}

/**
 * R5 (H133): a guided blank board (the operator's order of 2026-10-15: "Templates shipped publicly start blank and guided,
 * without private creative assets"): its title, what it is for, and one empty frame per part, each with a line that says what
 * goes in it. Text only: a seed is read as these fields and nothing else (an image, an asset, a sample or a path is never read),
 * and a text that names an address or a home folder is refused with the whole seed.
 */
export interface GuidedTemplate {
  id: string;
  title: string;
  domain: string;
  intro: string;
  /** Frames joined left to right by arrows, in order. */
  flow: boolean;
  /** How many frames to a row (1-6). */
  columns: number;
  frames: Array<{ name: string; guide: string }>;
}

const GUIDED_ID = /^G\d{1,3}$/;
/** Words, numbers, spaces and plain punctuation, the arrow and the middle dot; no markup, braces, backslash or @. */
const PLAIN = /^[\p{L}\p{N} .,;:'"()?!/&+·→–—-]+$/u;
const NOT_PLAIN = /:\/\/|www\.|\/Users\/|\/home\/|\/root\/|~\//i;
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && PLAIN.test(v) && !NOT_PLAIN.test(v);

function asGuided(seed: unknown, expectedId: string): GuidedTemplate | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const { id, kind, title, domain, intro, flow, columns, frames } = seed as Record<string, unknown>;
  if (id !== expectedId || typeof id !== 'string' || !GUIDED_ID.test(id) || kind !== 'guided') return null;
  if (!plain(title, 80) || !plain(domain, 40) || !plain(intro, 400)) return null;
  if (flow !== undefined && typeof flow !== 'boolean') return null;
  if (columns !== undefined && !(Number.isInteger(columns) && (columns as number) >= 1 && (columns as number) <= 6)) return null;
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 12) return null;
  const parts: GuidedTemplate['frames'] = [];
  for (const f of frames) {
    if (typeof f !== 'object' || f === null) return null;
    const { name, guide } = f as Record<string, unknown>;
    if (!plain(name, 40) || !plain(guide, 280)) return null;
    parts.push({ name, guide });
  }
  return { id, title, domain, intro, flow: flow === true, columns: (columns as number | undefined) ?? Math.min(3, parts.length), frames: parts };
}

/**
 * R5 (H133): the guided blank boards, in their index's order (INDEX.json `guided`). R11 round 7 (H176): and, after them, the
 * guided blank public starters (starterTemplates below), each marked kind 'starter', so GET /api/canvas/templates serves both in
 * `guided` and the canvas page draws each its own way (canvas.js openGuided, openStarter).
 */
export function guidedTemplates(dir = templatesDir()): Array<GuidedTemplate | StarterTemplate> {
  const index = readJson(join(dir, 'INDEX.json')) as { guided?: unknown } | null;
  const ids = Array.isArray(index?.guided) ? index.guided.filter((b): b is string => typeof b === 'string' && GUIDED_ID.test(b)) : [];
  const guided = ids.map((id) => asGuided(readJson(join(dir, `${id}.json`)), id)).filter((t): t is GuidedTemplate => t !== null);
  return [...guided, ...starterTemplates()];
}

// ── R11 round 7 (H176): the guided blank public starters (TEMPLATE SCHEMA v1) ─────────────────────────────────────────────
//
// The structure of three recovered Houdini boards (the handoff's lanes and manifest, the cookbook's categories, the atlas's
// typed-port pipeline), every card blank, with a guidance card per step ("01 Define the geometry / 02 Set the parameters /
// 03 Cook in Houdini"), as src/studio/templates/H*.json (shipped inside the package: tsc copies an imported .json into dist).
// Each is read as the fields below and nothing else, under the guided boards' PLAIN rule for every word a person reads, and is
// refused whole when anything of it is not as the schema says (a starter is listed sound or not at all): the page then draws
// it as tldraw records (companion/studio-canvas/src/starters.js), every shape's id fresh per opening, every arrow bound.
// The originals (P67, T22, T24) stay retained examples outside the repo; their content is not here.
import starterH1 from './templates/H1.json' with { type: 'json' };
import starterH2 from './templates/H2.json' with { type: 'json' };
import starterH3 from './templates/H3.json' with { type: 'json' };

export const STARTER_WORKBENCH = 'timmy-starter-v1';
export type StarterSlot = 'result' | 'params' | 'workflow';
export type StarterShapeType = 'geo' | 'text' | 'frame' | 'arrow';
/** A flat value of a shape's data: a primitive; a nested value is a JSON string (the recovered schema's rule). */
export type StarterDatum = string | number | boolean;

export interface StarterStep { n: '01' | '02' | '03'; verb: string; guide: string; slot: StarterSlot }
export interface StarterShape {
  key: string;
  type: StarterShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string[];
  color?: string;
  fill?: string;
  dash?: string;
  size?: string;
  font?: string;
  geo?: string;
  align?: string;
  verticalAlign?: string;
  parent?: string;
  role: string;
  lane: string;
  data: Record<string, StarterDatum>;
  slot?: StarterSlot;
}
export interface StarterBinding { key: string; from: string; to: string; fromPort?: string; toPort?: string; dataType?: string }
export interface StarterTemplate {
  id: string;
  kind: 'starter';
  from: { template: string; key: string; generated: string };
  title: string;
  domain: string;
  intro: string;
  workbench: typeof STARTER_WORKBENCH;
  page: string;
  lanes: string[];
  steps: StarterStep[];
  shapes: StarterShape[];
  bindings: StarterBinding[];
}

const STARTER_ID = /^H\d{1,3}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLORS = new Set(['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white']);
const FILLS = new Set(['none', 'semi', 'solid', 'pattern', 'fill']);
const DASHES = new Set(['draw', 'solid', 'dashed', 'dotted']);
const SIZES = new Set(['s', 'm', 'l', 'xl']);
const FONTS = new Set(['draw', 'sans', 'serif', 'mono']);
const GEOS = new Set(['rectangle', 'ellipse']);
const ALIGNS = new Set(['start', 'middle', 'end']);
const VALIGNS = new Set(['start', 'middle', 'end']);
const SLOTS = new Set<string>(['result', 'params', 'workflow']);
const TYPES = new Set<string>(['geo', 'text', 'frame', 'arrow']);
const STEP_NS = ['01', '02', '03'] as const;
const MAX_SHAPES = 80;
const MAX_BINDINGS = 40;
/** A data value: a primitive; a string short, with no control character and no address or home folder in it. */
const datum = (v: unknown): v is StarterDatum => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) && !NOT_PLAIN.test(v));
const coord = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 20000;
const extent = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 4000;
const styleIn = (v: unknown, set: Set<string>): boolean => v === undefined || (typeof v === 'string' && set.has(v));

/**
 * One seed as a starter, or the reasons it is not one (the first few): every field checked, every word a person reads PLAIN,
 * the bindings sound (each joins two cards; a typed one names an out port and an in port of its data type; no cycle). The
 * rules match companion/studio-canvas/src/starters.js checkBindings, which the page runs again before it draws.
 */
export function asStarter(seed: unknown, expectedId: string): { ok: true; starter: StarterTemplate } | { ok: false; why: string[] } {
  const why: string[] = [];
  const bad = (w: string): void => { if (why.length < 8) why.push(w); };
  if (typeof seed !== 'object' || seed === null) return { ok: false, why: ['not an object'] };
  const s = seed as Record<string, unknown>;
  if (s.id !== expectedId || typeof s.id !== 'string' || !STARTER_ID.test(s.id)) bad(`id is not ${expectedId}`);
  if (s.kind !== 'starter') bad('kind is not starter');
  const from = typeof s.from === 'object' && s.from !== null ? s.from as Record<string, unknown> : null;
  if (!from || !plain(from.template, 8) || !TOKEN.test(String(from.key)) || typeof from.generated !== 'string' || !DATE.test(from.generated)) bad('from is not { template, key, generated }');
  if (!plain(s.title, 80)) bad('title is not plain text (at most 80 characters)');
  if (!plain(s.domain, 40)) bad('domain is not plain text');
  if (!plain(s.intro, 400)) bad('intro is not plain text (at most 400 characters)');
  if (s.workbench !== STARTER_WORKBENCH) bad(`workbench is not ${STARTER_WORKBENCH}`);
  if (!TOKEN.test(String(s.page))) bad('page is not a token');
  const lanes = Array.isArray(s.lanes) && s.lanes.length > 0 && s.lanes.length <= 16 && s.lanes.every((l) => typeof l === 'string' && TOKEN.test(l)) ? s.lanes as string[] : null;
  if (!lanes) bad('lanes is not a short list of tokens');
  if (lanes && !lanes.includes('steps')) bad('lanes does not name steps');
  const steps = Array.isArray(s.steps) ? s.steps : [];
  if (steps.length !== 3) bad('steps are not three');
  steps.forEach((st, i) => {
    const o = typeof st === 'object' && st !== null ? st as Record<string, unknown> : {};
    if (o.n !== STEP_NS[i]) bad(`step ${i + 1} is not numbered ${STEP_NS[i]}`);
    if (!plain(o.verb, 40)) bad(`step ${STEP_NS[i]}'s verb is not plain text`);
    if (!plain(o.guide, 320)) bad(`step ${STEP_NS[i]}'s guide is not plain text (at most 320 characters)`);
    if (typeof o.slot !== 'string' || !SLOTS.has(o.slot)) bad(`step ${STEP_NS[i]}'s slot is not result, params or workflow`);
  });
  const shapes = Array.isArray(s.shapes) ? s.shapes : null;
  if (!shapes || shapes.length === 0 || shapes.length > MAX_SHAPES) bad(`shapes is not a list of 1 to ${MAX_SHAPES}`);
  const keys = new Set<string>();
  const frames = new Set<string>();
  for (const [i, raw] of (shapes ?? []).entries()) {
    const o = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const at = typeof o.key === 'string' ? o.key : `#${i + 1}`;
    if (typeof o.key !== 'string' || !KEY.test(o.key)) bad(`shape ${at}: no key`);
    else if (keys.has(o.key)) bad(`shape ${at}: its key is used twice`);
    else keys.add(o.key);
    if (typeof o.type !== 'string' || !TYPES.has(o.type)) bad(`shape ${at}: type is not geo, text, frame or arrow`);
    if (o.type === 'arrow') bad(`shape ${at}: an arrow is drawn from a binding, never listed as a shape`);
    if (!coord(o.x) || !coord(o.y)) bad(`shape ${at}: x and y are not whole numbers`);
    if (!extent(o.w) || !extent(o.h)) bad(`shape ${at}: w and h are not whole numbers from 1 to 4000`);
    const text = Array.isArray(o.text) ? o.text : null;
    if (!text || text.length > 24 || !text.every((l) => typeof l === 'string' && (l === '' || plain(l, 300)))) bad(`shape ${at}: text is not up to 24 plain lines`);
    if (!styleIn(o.color, COLORS) || !styleIn(o.fill, FILLS) || !styleIn(o.dash, DASHES) || !styleIn(o.size, SIZES) || !styleIn(o.font, FONTS) || !styleIn(o.geo, GEOS) || !styleIn(o.align, ALIGNS) || !styleIn(o.verticalAlign, VALIGNS)) bad(`shape ${at}: a style is not one tldraw draws`);
    if (o.parent !== undefined && (typeof o.parent !== 'string' || !frames.has(o.parent))) bad(`shape ${at}: parent is not a frame listed before it`);
    if (typeof o.role !== 'string' || !TOKEN.test(o.role)) bad(`shape ${at}: role is not a token`);
    if (typeof o.lane !== 'string' || !lanes || !lanes.includes(o.lane)) bad(`shape ${at}: lane is not one of the starter's lanes`);
    const data = typeof o.data === 'object' && o.data !== null && !Array.isArray(o.data) ? o.data as Record<string, unknown> : null;
    if (!data || Object.keys(data).length > 24 || !Object.entries(data).every(([k, v]) => KEY.test(k.toLowerCase()) && datum(v))) bad(`shape ${at}: data is not flat primitives under short keys`);
    if (o.slot !== undefined && (typeof o.slot !== 'string' || !SLOTS.has(o.slot) || o.type !== 'frame')) bad(`shape ${at}: a slot goes on a frame, named result, params or workflow`);
    if (o.type === 'frame' && typeof o.key === 'string') frames.add(o.key);
  }
  const bindings = Array.isArray(s.bindings) ? s.bindings : null;
  if (!bindings || bindings.length > MAX_BINDINGS) bad(`bindings is not a list of at most ${MAX_BINDINGS}`);
  for (const [i, raw] of (bindings ?? []).entries()) {
    const o = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const at = typeof o.key === 'string' ? o.key : `#${i + 1}`;
    if (typeof o.key !== 'string' || !KEY.test(o.key)) bad(`binding ${at}: no key`);
    if (typeof o.from !== 'string' || typeof o.to !== 'string') bad(`binding ${at}: from and to are not keys`);
    for (const f of ['fromPort', 'toPort', 'dataType']) if (o[f] !== undefined && (typeof o[f] !== 'string' || !TOKEN.test(o[f] as string))) bad(`binding ${at}: ${f} is not a token`);
  }
  if (why.length) return { ok: false, why };
  const starter = seed as StarterTemplate;
  const sound = checkStarterBindings(starter);
  if (sound.length) return { ok: false, why: sound.slice(0, 8) };
  return { ok: true, starter };
}

/** A node's ports (data.ports, a JSON string of [{ id, direction, dataType }]), or []. */
function portsOf(shape: StarterShape): Array<{ id: string; direction: 'in' | 'out'; dataType: string }> {
  const raw = shape.data.ports;
  if (typeof raw !== 'string') return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is { id: string; direction: 'in' | 'out'; dataType: string } => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string' && ((p as { direction?: unknown }).direction === 'in' || (p as { direction?: unknown }).direction === 'out') && typeof (p as { dataType?: unknown }).dataType === 'string');
}

/**
 * The problems of a starter's bindings, in words (none: sound): each joins two different cards of the starter (never an arrow);
 * a typed one (fromPort, toPort, dataType together) names an out port of its start and an in port of its end, both of its data
 * type; the whole is acyclic (Kahn). The same rules as starters.js checkBindings.
 */
export function checkStarterBindings(t: StarterTemplate): string[] {
  const problems: string[] = [];
  const byKey = new Map(t.shapes.map((x) => [x.key, x]));
  const seen = new Set<string>();
  for (const b of t.bindings) {
    if (seen.has(b.key)) problems.push(`binding ${b.key} is named twice`);
    seen.add(b.key);
    const from = byKey.get(b.from);
    const to = byKey.get(b.to);
    if (!from) problems.push(`binding ${b.key} starts at ${JSON.stringify(b.from)}, which is not a card of this starter`);
    if (!to) problems.push(`binding ${b.key} ends at ${JSON.stringify(b.to)}, which is not a card of this starter`);
    if (from && to && from === to) problems.push(`binding ${b.key} joins ${b.from} to itself`);
    const typed = b.fromPort !== undefined || b.toPort !== undefined || b.dataType !== undefined;
    if (!typed) continue;
    if (typeof b.fromPort !== 'string' || typeof b.toPort !== 'string' || typeof b.dataType !== 'string') { problems.push(`binding ${b.key} is typed in part only (fromPort, toPort and dataType go together)`); continue; }
    const out = from ? portsOf(from).find((p) => p.id === b.fromPort && p.direction === 'out') : undefined;
    const inn = to ? portsOf(to).find((p) => p.id === b.toPort && p.direction === 'in') : undefined;
    if (from && !out) problems.push(`binding ${b.key}: ${b.from} has no out port ${b.fromPort}`);
    if (to && !inn) problems.push(`binding ${b.key}: ${b.to} has no in port ${b.toPort}`);
    if (out && out.dataType !== b.dataType) problems.push(`binding ${b.key} carries ${b.dataType}, but ${b.from}.${b.fromPort} gives ${out.dataType}`);
    if (inn && inn.dataType !== b.dataType) problems.push(`binding ${b.key} carries ${b.dataType}, but ${b.to}.${b.toPort} takes ${inn.dataType}`);
  }
  const nodes = t.shapes.map((x) => x.key).filter((k) => t.bindings.some((b) => b.from === k || b.to === k));
  const edges = t.bindings.filter((b) => byKey.has(b.from) && byKey.has(b.to) && b.from !== b.to);
  const indegree = new Map(nodes.map((k) => [k, 0]));
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const done = new Set<string>();
  let ready = nodes.filter((k) => indegree.get(k) === 0);
  while (ready.length) {
    const k = ready.shift()!;
    done.add(k);
    for (const e of edges.filter((x) => x.from === k)) {
      indegree.set(e.to, (indegree.get(e.to) ?? 1) - 1);
      if (indegree.get(e.to) === 0) ready = nodes.filter((n) => ready.includes(n) || n === e.to);
    }
  }
  if (done.size < nodes.length) problems.push(`the bindings form a cycle (${nodes.filter((k) => !done.has(k)).join(', ')})`);
  return problems;
}

/** What is shipped: each starter's seed, by the id it must carry. */
export const STARTER_SEEDS: ReadonlyArray<readonly [string, unknown]> = [['H1', starterH1], ['H2', starterH2], ['H3', starterH3]];

/**
 * R11 round 7 (H176): the guided blank public starters, sound ones only, in their shipped order (H1 the handoff, H2 the cookbook,
 * H3 the pipeline atlas). A seed that does not validate is left out whole, and `starterProblems` says why.
 */
export function starterTemplates(seeds: ReadonlyArray<readonly [string, unknown]> = STARTER_SEEDS): StarterTemplate[] {
  return seeds.map(([id, seed]) => asStarter(seed, id)).filter((r): r is { ok: true; starter: StarterTemplate } => r.ok).map((r) => r.starter);
}

/** Why each shipped starter that is not listed was refused (id → reasons); empty when every one is sound. */
export function starterProblems(seeds: ReadonlyArray<readonly [string, unknown]> = STARTER_SEEDS): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, seed] of seeds) { const r = asStarter(seed, id); if (!r.ok) out[id] = r.why; }
  return out;
}
