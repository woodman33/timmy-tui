/**
 * R7 (H153): tab 6 (3D & Motion) in the Workbench: the project's meshes and the Rerun recordings Timmy can read, in words, from
 * the reading the companion's tab 6 draws (src/vox/meshes.ts listMeshes):
 *
 *   MESHES IN THIS PROJECT        each mesh (an STL, OBJ or PLY file, or a STEP's tessellation a VoxVision record names) with
 *                                 its kind and what Timmy's own reader of that kind measured from the whole file: triangles,
 *                                 box, topology and volume; an OBJ's or PLY's faces and what its reader ignored; a file's own
 *                                 words (declared, not checked); how much of it the companion's view draws; then who measured
 *                                 and DOCTRINE §15's sentence (R8 H154: OBJ and PLY beside STL)
 *   RECORDINGS TIMMY CAN READ     each .rrd with its header's facts, and its entities, frames and time range said unknown, with
 *                                 why; Rerun's viewer as this computer has it (found is not run)
 *
 * R9 (H160; R8's open item G′): each mesh and each recording is an item the cursor rests on, listed before the tab's tools
 * (familyView in src/workbench/views.ts places them), so the page opens on the first mesh, in view and whole at every size the
 * Workbench draws (60×16 and up). An item's words wrap under it, never cut; where the window is short the list says each item
 * in fewer words (its kind, triangles, box and volume; then its kind and triangles), and Context says all of it. Each one's
 * actions, as the other tabs' items have theirs: Enter shows it whole in Context's Inspector (createDetail: what its reader
 * measured, or a recording's reading); c (Companion · Show) opens the companion's tab 6 with the selected mesh chosen
 * (createCompanionHint); Context's Tools names both (createActions); Files, related only, shows its path (createItemFiles); the
 * body says the keys under each list's heading.
 *
 * A terminal draws no 3D: the view you can turn is the companion's tab 6. Files only: the reading is made once for each reading
 * of the Workbench (data.readAt), and each file is measured again only when it changes.
 */
import { num } from '../native/stl-readback.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { listMeshes, type MeshList, type MeshRow, type RecordingRow } from '../vox/meshes.js';
import type { Glyphs } from './frame.js';
import type { Data } from './model.js';
import { fieldRows, heading, limitRows, onBar, para, S } from './tab-columns.js';
import { wrapSegs, type Line, type Role, type Seg } from './text.js';

/** What the tab says first: where the view you can turn is, and what no Timmy surface draws yet. */
export const CREATE_SENTENCE = "The companion's tab 6 draws this project's meshes in a view you can turn: Timmy's own drawing of each file's triangles, not a render by Blender or any native tool. No Timmy surface draws a motion timeline yet; each app below draws its own, once set up.";

/** Each kind of mesh in its word. */
const KIND_WORDS: Record<MeshRow['kind'], string> = { stl: 'STL', obj: 'OBJ', ply: 'PLY', tessellation: 'tessellation (STL)' };

/** The runs chain the companion's panels read: TIMMY_STORE, else the project's own store. */
function chainOf(root: string): readonly Receipt[] {
  try { return process.env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

let kept: { key: string; list: MeshList | { error: string } } | null = null;
/** The project's meshes and recordings, read once for each reading of the Workbench. */
function readingOf(root: string, at: number): MeshList | { error: string } {
  const key = `${root}\0${at}`;
  if (kept?.key === key) return kept.list;
  let list: MeshList | { error: string };
  // within a time budget (the Workbench draws its frame synchronously): a large mesh is measured by a later reading
  try { list = listMeshes({ root, env: process.env, chain: () => chainOf(root) }, { budgetMs: 150 }); } catch (e) { list = { error: e instanceof Error ? e.message : String(e) }; }
  kept = { key, list };
  return list;
}

// ── the items ──────────────────────────────────────────────────────────────────

/** R9 (H160): tab 6's own items, before its tools: a mesh (with who measured it and DOCTRINE §15's sentence, as the list says
 *  them) and a recording (with Rerun's viewer as this computer has it). */
export type CreateItem =
  | { kind: 'mesh'; key: string; mesh: MeshRow; list: Pick<MeshList, 'reader' | 'doctrine' | 'view'> }
  | { kind: 'recording'; key: string; rec: RecordingRow; viewer: MeshList['viewer'] };

/** The name an item goes by in Context ("For refs/demo-tray.stl, in …"). */
export const createItemName = (item: CreateItem): string => (item.kind === 'mesh' ? item.mesh.path : item.rec.path);

/** The project files an item names, for Context's Files (related only): the mesh or recording itself, and for a tessellation
 *  the VoxVision record that names it and the STEP it was made from. */
export function createItemFiles(item: CreateItem): string[] {
  if (item.kind === 'recording') return [item.rec.path];
  const t = item.mesh.tessellation;
  return [item.mesh.path, ...(t ? [`results/vox/${t.record}.json`, t.from.replace(/^\.\//, '')] : [])];
}

/**
 * What Companion · Show (c) passes to the companion's address so that its tab 6 opens with this mesh chosen
 * (src/companion/client/panel-create.js reads mesh=): the mesh's path as the hex of its UTF-8 bytes, since an address the
 * Workbench passes holds plain values only (src/workbench/servers.ts PAGE_QUERY). Any other selection: tab 6 alone.
 */
export function createCompanionHint(item: { kind: string } | null | undefined): string {
  const path = item && item.kind === 'mesh' ? (item as Extract<CreateItem, { kind: 'mesh' }>).mesh.path : '';
  return `tab=create${path ? `&mesh=${Buffer.from(path, 'utf8').toString('hex')}` : ''}`;
}

/** The tab's items as the cursor counts them (the meshes, then the recordings): none when the reading failed. */
export function createItems(data: Pick<Data, 'project' | 'readAt'>): CreateItem[] {
  const list = readingOf(data.project.root, data.readAt);
  if ('error' in list) return [];
  const facts = { reader: list.reader, doctrine: list.doctrine, view: list.view };
  return [
    ...list.meshes.map((mesh): CreateItem => ({ kind: 'mesh', key: `mesh:${mesh.path}`, mesh, list: facts })),
    ...list.recordings.map((rec): CreateItem => ({ kind: 'recording', key: `rrd:${rec.path}`, rec, viewer: list.viewer })),
  ];
}

/** How many words an item's rows say: all of them (0), a short form (1: a mesh's kind, triangles, box and volume), the least
 *  (2: its kind and triangles). Each list takes the fullest form whose every item fits the rows it may have. */
type Form = 0 | 1 | 2;

/** A mesh's words in a form: its head (its path, then its facts) and the rows under it. */
function meshWords(m: MeshRow, form: Form, sep: string): { head: Line; under: string[] } {
  const r = m.readback;
  const kind = KIND_WORDS[m.kind] ?? m.kind;
  if (!r) {
    const facts = form === 0 ? [kind, m.why ?? 'not measured'].join(sep) : `${kind}${sep}${m.pending ? 'being measured' : 'not measured'}: Context says why`;
    return { head: [S(m.path, 'strong'), S(`  ${facts}`, 'secondary')], under: form === 0 ? [...(m.kind === 'tessellation' ? [m.origin.words] : []), ...(m.declared ? [`the file says (${m.declared.what}; not checked): ${m.declared.words}`] : [])] : [] };
  }
  const tri = `${r.triangles} triangle${r.triangles === 1 ? '' : 's'}`;
  const box = r.bbox ? `box ${r.bbox.size.map(num).join(' × ')}` : 'no box';
  const facts = form === 2 ? [kind, tri]
    : form === 1 ? [kind, tri, box, `volume ${m.volume}`]
      : [kind, tri, box, m.topology, `volume ${m.volume}`, ...(m.view && m.view.shown < m.view.total ? [`the companion's view shows ${m.view.shown} of ${m.view.total}`] : [])];
  const under = form === 0 ? [
    ...(m.faces || m.ignored ? [[m.faces, m.ignored].filter(Boolean).join(sep)] : []),
    ...(m.kind === 'tessellation' ? [m.origin.words] : []),
    ...(m.declared ? [`the file says (${m.declared.what}; not checked): ${m.declared.words}`] : []),
  ] : [];
  return { head: [S(m.path, 'strong'), S(`  ${facts.join(sep)}`, 'text')], under };
}

/**
 * R9 (H160): a recording's reading through the installed Rerun CLI, as H159 posted its shape for RecordingRow.cli
 * (src/vox/rrd-cli.ts RrdReading: { state, words, cli, verify, entities, timelines, calls }, each fact { state: 'read', … } or
 * { state: 'unknown', reason, why }), read structurally: a row without it, or with one of another shape, has none, and the
 * header reader's words (unknown, with why) stand.
 */
interface CliFact { state: string; why?: string }
interface CliReading {
  state: string; words: string;
  verify: CliFact & { words?: string };
  entities: CliFact & { count?: number; paths?: string[]; static?: CliFact & { paths?: string[] } };
  timelines: CliFact & { list?: Array<{ name: string; kind?: CliFact & { kind?: string }; range?: CliFact & { words?: string } }> };
}
const isFact = (v: unknown): v is CliFact => !!v && typeof v === 'object' && typeof (v as CliFact).state === 'string';
function cliOf(r: RecordingRow): CliReading | null {
  const c = (r as { cli?: unknown }).cli as Partial<CliReading> | null | undefined;
  if (!c || typeof c !== 'object' || typeof c.state !== 'string' || typeof c.words !== 'string' || !isFact(c.verify) || !isFact(c.entities) || !isFact(c.timelines)) return null;
  return c as CliReading;
}
const unknownWhy = (x: CliFact): string => `unknown: ${x.why ?? 'not said'}`;
/** A timeline as the reading names it: its name, its kind, and its range or why not. */
const timelineWords = (x: NonNullable<CliReading['timelines']['list']>[number]): string =>
  `${x.name}${x.kind?.state === 'read' && x.kind.kind ? ` (${x.kind.kind})` : ''}: ${x.range?.state === 'read' ? x.range.words ?? '' : `its range unknown: ${x.range?.why ?? 'not said'}`}`;

/** A recording's words in a form. */
function recordingWords(r: RecordingRow, form: Form, sep: string): { head: Line; under: string[] } {
  const f = r.facts;
  if (!f) return { head: [S(r.path, 'strong'), S(`  ${form === 0 ? `not read: ${r.why ?? 'unknown'}` : 'not read: Context says why'}`, 'secondary')], under: [] };
  // read through the Rerun CLI: its entities and timelines (each, or that it is unknown: Context says why)
  const cli = cliOf(r);
  if (cli) {
    const e = cli.entities.state === 'read' ? `${cli.entities.count ?? (cli.entities.paths ?? []).length} entities` : 'entities unknown: Context says why';
    const t = cli.timelines.state === 'read' ? (form === 0 ? `timelines ${(cli.timelines.list ?? []).map(timelineWords).join('; ') || 'none'}` : `${(cli.timelines.list ?? []).length} timelines`) : 'timelines unknown: Context says why';
    const facts = form === 2 ? [`written by ${f.writer}`, e] : [`written by ${f.writer}`, `${f.messages.chunks} data chunks`, e, t];
    return { head: [S(r.path, 'strong'), S(`  ${facts.join(sep)}`, 'text')], under: [] };
  }
  const facts = form === 0 ? [`written by ${f.writer}`, `${f.messages.chunks} data chunks`, `entities, frames and time range: unknown to Timmy (${f.unknown.entities})`]
    : form === 1 ? [`written by ${f.writer}`, `${f.messages.chunks} data chunks`, 'entities, frames and time range: unknown to Timmy (it does not decode the data chunks)']
      : [`written by ${f.writer}`, 'entities, frames, time range: unknown'];
  return { head: [S(r.path, 'strong'), S(`  ${facts.join(sep)}`, 'text')], under: [] };
}

/** An item's words in a form (0 all, 1 short, 2 the least), as the page says them: its path, its facts, the rows under it. */
export function createItemWords(it: CreateItem, form: 0 | 1 | 2, g: Glyphs): string {
  const sep = ` ${g.sep} `;
  const w = it.kind === 'mesh' ? meshWords(it.mesh, form, sep) : recordingWords(it.rec, form, sep);
  return [w.head.map((x) => x.text).join(''), ...w.under].join(' ');
}

/** An item's rows `w` cells wide: the cursor's mark (or its room) first, its words wrapped under it, never cut. */
function itemRows(words: { head: Line; under: string[] }, w: number, selected: boolean, g: Glyphs): Line[] {
  const iw = Math.max(8, w - 2);
  const body: Line[] = [...wrapSegs(words.head, iw, '  '), ...words.under.flatMap((t) => para(t, iw, 'secondary', '  '))];
  return body.map((b, k): Line => {
    const mark: Seg = k === 0 && selected ? S(`${g.cursor} `, 'accent') : S('  ');
    const rowed: Line = [mark, ...b];
    // the selection's ground on every row of it, its quiet words in the text colour there (onBar: the contrast floor)
    return selected ? onBar(rowed) : rowed;
  });
}

export interface CreateCtx {
  data: Pick<Data, 'project' | 'readAt'>;
  /** the body's inner width */
  width: number;
  /** the body's inner height: an item never takes more rows than the window can show it whole in (absent: no limit) */
  height?: number;
  g: Glyphs;
  /** the cursor's place in the tab's list (its own items first, src/workbench/views.ts familyView); absent: none selected */
  cursor?: number;
}

export interface CreateTabView { lines: Line[]; items: Array<{ line: number; item: CreateItem; rows?: number }> }

/**
 * Tab 6's meshes and recordings as rows of at most `width` cells, under the sentence that says where the view you can turn is:
 * each one an item (its line, and its rows where it takes more than one), the cursor's on the selection's ground.
 */
export function createTabView(c: CreateCtx): CreateTabView {
  const w = Math.max(8, c.width);
  const sep = ` ${c.g.sep} `;
  const lines: Line[] = [...limitRows(CREATE_SENTENCE, { c: 'tab 6, the meshes in a view you can turn', s: 'the canvas (2D shapes and cards)' }, w, c.g), []];
  const items: CreateTabView['items'] = [];
  const list = readingOf(c.data.project.root, c.data.readAt);
  if ('error' in list) return { lines: [...lines, ...para(`The project's meshes could not be read: ${list.error}`, w, 'failure', '  '), []], items };
  const own = createItems(c.data);
  // the fullest form in which every item fits the rows it may have: about half the window (DESIGN.md §3.4's density budget: a
  // list, not one item's wall of words), and never more than the window less a row for its heading or the box's title
  const room = c.height === undefined ? Infinity : Math.max(1, Math.min(c.height - 2, Math.max(2, Math.floor((c.height - 2) / 2))));
  const wordsOf = (it: CreateItem, f: Form) => (it.kind === 'mesh' ? meshWords(it.mesh, f, sep) : recordingWords(it.rec, f, sep));
  // one form for each list (the meshes', the recordings'), so a list reads alike and one list's words never cut the other's
  const formOf = (list: CreateItem[]): Form => ([0, 1, 2] as const).find((f) => list.every((it) => itemRows(wordsOf(it, f), w, false, c.g).length <= room)) ?? 2;
  const forms = { mesh: formOf(own.filter((x) => x.kind === 'mesh')), recording: formOf(own.filter((x) => x.kind === 'recording')) };
  const place = (it: CreateItem, k: number): void => {
    const rows = itemRows(wordsOf(it, forms[it.kind]), w, c.cursor === k, c.g);
    items.push({ line: lines.length, item: it, ...(rows.length > 1 ? { rows: rows.length } : {}) });
    lines.push(...rows);
  };
  const meshes = own.filter((x) => x.kind === 'mesh');
  const recordings = own.filter((x) => x.kind === 'recording');
  // what the keys do to the selected one, under each list's heading, as tab 7 says it of its panes (Context's Tools too)
  const key = (k: string): Seg => S(`[${k}]`, 'action');
  const keys = (l: Line): Line[] => wrapSegs([S('  '), ...l], w, '  ');

  lines.push([heading(`Meshes in this project (${list.meshes.length + list.more})`)]);
  if (!meshes.length) lines.push(...para('No mesh in this project yet: an .stl, .obj or .ply file in it is listed here (/add <file> copies one in), and a STEP once /vox view <record> has made its tessellation (that needs OCP).', w, 'secondary', '  '));
  else lines.push(...keys([key('Enter'), S(' its measurements in Context', 'secondary'), S(sep, 'secondary'), key('c'), S(' it chosen in the companion\'s view you can turn', 'secondary')]));
  meshes.forEach((it) => place(it, own.indexOf(it)));
  if (list.more) lines.push(...para(`and ${list.more} more, not listed here`, w, 'secondary', '  '));
  if (list.meshes.some((m) => m.readback)) lines.push(...para(`Measured by ${list.reader}. ${list.doctrine}`, w, 'secondary', '  '));

  lines.push([], [heading(`Recordings Timmy can read (${list.recordings.length + list.recordingsMore})`)]);
  if (!recordings.length) lines.push(...para('No Rerun recording (.rrd) in this project.', w, 'secondary', '  '));
  else lines.push(...keys([key('Enter'), S(' its reading in Context: its header\'s facts, and what stays unknown, with why', 'secondary')]));
  recordings.forEach((it) => place(it, own.indexOf(it)));
  if (list.recordingsMore) lines.push(...para(`and ${list.recordingsMore} more, not listed here`, w, 'secondary', '  '));
  lines.push(...para(`${list.viewer.name}: ${list.viewer.state}${list.viewer.setup ? ` (${list.viewer.setup})` : ''}`, w, 'secondary', '  '));
  return { lines, items };
}

/** Tab 6's meshes and recordings as rows of at most `width` cells (none selected), under the sentence that says where the view
 *  you can turn is. */
export function createTabLines(c: { data: Pick<Data, 'project' | 'readAt'>; width: number; g: Glyphs }): Line[] {
  return createTabView(c).lines;
}

// ── Context ────────────────────────────────────────────────────────────────────

const bytesWords = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/**
 * R9 (H160): an item in Context's Inspector, whole. A mesh: what its reader measured from the whole file (triangles, corners,
 * box, area, volume, topology, an OBJ's or PLY's faces and what its reader ignored, its units), the file, where it came from,
 * its own words (declared, not checked), what the companion's view draws, who measured and DOCTRINE §15's sentence. A
 * recording: its header's facts, its messages and stores, its entities, frames and time range unknown, with why, and Rerun's
 * viewer as this computer has it (found is not run: nothing here starts it).
 */
export function createDetail(item: CreateItem, w: number, g: Glyphs): Line[] {
  const out: Line[] = [];
  const f = (label: string, value: string, role: Role = 'text'): void => { out.push(...fieldRows(label, value, w, role, 10)); };
  const key = (k: string): Seg => S(`[${k}]`, 'action');
  if (item.kind === 'mesh') {
    const m = item.mesh;
    const r = m.readback;
    out.push([heading('Mesh'), S(` ${g.sep} ${KIND_WORDS[m.kind] ?? m.kind}`, 'secondary')], ...para(m.path, w, 'strong'));
    if (!r) {
      f(m.pending ? 'Measuring' : 'Not measured', m.why ?? 'unknown', 'secondary');
      f('Reader', m.reader.words, 'secondary');
    } else {
      f('Measured', `by ${m.reader.words}`, 'secondary');
      f('Triangles', String(r.triangles));
      f('Corners', `${r.corners} (joined only where bit-identical)`);
      f('Box', r.bbox ? `${r.bbox.size.map(num).join(' × ')}, from ${r.bbox.min.map(num).join(', ')} to ${r.bbox.max.map(num).join(', ')}` : 'none (no triangles)');
      f('Area', num(r.area));
      f('Volume', m.volume ?? 'unknown');
      f('Topology', m.topology ?? 'unknown');
      if (m.faces) f('Faces', m.faces);
      if (m.ignored) f('Ignored', m.ignored.replace(/^ignored:\s*/, ''), 'secondary');
      f('Units', r.units, 'secondary');
      f('File', `${m.format ?? KIND_WORDS[m.kind]} ${g.sep} ${bytesWords(r.bytes)} ${g.sep} sha256 ${r.sha256.slice(0, 12)}`, 'secondary');
    }
    f('Origin', `${m.origin.provenance}: ${m.origin.words}`, 'secondary');
    if (m.declared) f('Says', `the file's own words (${m.declared.what}; not checked): ${m.declared.words}`, 'secondary');
    if (m.tessellation) f('Made from', `${m.tessellation.from} by ${m.tessellation.made_by}, within ${m.tessellation.tolerance}; ${m.tessellation.sealed === true ? 'a vox receipt sealed these bytes' : m.tessellation.sealed === false ? 'no vox receipt of this project seals these bytes' : 'no receipt was checked here'}`, 'secondary');
    if (m.view) f('View', `the companion's view you can turn: ${m.view.words}`, 'secondary');
    out.push([], ...para(item.list.view, w, 'secondary'), ...para(item.list.doctrine, w, 'secondary'));
    out.push([], ...wrapSegs([key('c'), S(' Companion · Show: the companion\'s tab 6 with this mesh chosen, in a view you can turn', 'secondary')], w, '    '));
    return out;
  }
  const r = item.rec;
  const x = r.facts;
  out.push([heading('Recording'), S(` ${g.sep} Rerun (.rrd)`, 'secondary')], ...para(r.path, w, 'strong'));
  if (!x) f('Not read', r.why ?? 'unknown', 'secondary');
  else {
    f('Header', `written by ${x.writer} ${g.sep} compression ${x.compression} ${g.sep} ${x.serializer} ${g.sep} ${bytesWords(x.bytes)} (read from the file)`);
    f('Messages', `${x.messages.storeInfo} store info ${g.sep} ${x.messages.chunks} data chunks ${g.sep} ${x.messages.blueprint} blueprint${x.messages.other ? ` ${g.sep} ${x.messages.other} other` : ''}${x.ended ? ` ${g.sep} ends with its end marker` : ` ${g.sep} no end marker`}${x.footer ? ' and a footer' : ''}`);
    const stores = x.stores.map((s) => [s.kind, s.application ? `application ${s.application}` : '', s.recording ? `recording ${s.recording}` : ''].filter(Boolean).join(` ${g.sep} `)).join('; ');
    if (stores) f('Stores', stores);
    if (x.stopped) f('Stopped', x.stopped, 'secondary');
  }
  // R9 (H160): read through the installed Rerun CLI where the row carries that reading (H159's RecordingRow.cli): each fact as
  // read, else its why; else the header reader's: unknown to Timmy, with why
  const cli = cliOf(r);
  if (cli) {
    f('Rerun CLI', cli.words, cli.state === 'read' ? 'text' : 'secondary');
    const v = cli.verify;
    f('Verify', v.state === 'passed' ? v.words ?? 'passed' : v.state === 'failed' ? `failed: ${v.why ?? 'not said'}` : unknownWhy(v), v.state === 'failed' ? 'failure' : v.state === 'passed' ? 'text' : 'secondary');
    const e = cli.entities;
    f('Entities', e.state === 'read' ? `${e.count ?? (e.paths ?? []).length}: ${(e.paths ?? []).join(', ')}` : unknownWhy(e), e.state === 'read' ? 'text' : 'secondary');
    if (e.state === 'read' && isFact(e.static)) f('Static', e.static.state === 'read' ? (e.static.paths ?? []).join(', ') || 'none' : unknownWhy(e.static), 'secondary');
    const t = cli.timelines;
    f('Timelines', t.state === 'read' ? (t.list ?? []).map(timelineWords).join('; ') || 'none' : unknownWhy(t), t.state === 'read' ? 'text' : 'secondary');
  } else if (x) {
    f('Entities', `unknown to Timmy: ${x.unknown.entities}`, 'secondary');
    f('Frames', `unknown to Timmy: ${x.unknown.frames}`, 'secondary');
    f('Time range', `unknown to Timmy: ${x.unknown.timeRange}`, 'secondary');
  }
  const v = item.viewer;
  f('Viewer', `${v.name}: ${v.state}`, 'secondary');
  out.push(...para(v.words, w, 'secondary', '  '));
  if (v.setup) out.push(...wrapSegs([S('  Set up: ', 'secondary'), S(v.setup, 'action')], w, '    '));
  return out;
}

/** R9 (H160): what an item offers, in Context's Tools (src/workbench/views.ts actionsOf; "For <its path>" above them names it):
 *  Enter shows it whole in the Inspector; c the companion's tab 6, a mesh chosen there. Short enough for Context's drawer (36
 *  cells), whose rows are cut, not wrapped. */
export function createActions(item: CreateItem): Array<{ key: string; label: string; enabled: boolean }> {
  if (item.kind === 'mesh') return [{ key: 'Enter', label: 'Its measurements, in full', enabled: true }, { key: 'c', label: 'Companion · Show, mesh chosen', enabled: true }];
  return [{ key: 'Enter', label: 'Its reading, in full', enabled: true }, { key: 'c', label: 'Companion · Show: tab 6', enabled: true }];
}
