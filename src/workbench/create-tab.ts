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
 * in fewer words (its kind, triangles, box and volume; then its kind and triangles).
 *
 * A terminal draws no 3D: the view you can turn is the companion's tab 6. Files only: the reading is made once for each reading
 * of the Workbench (data.readAt), and each file is measured again only when it changes.
 */
import { num } from '../native/stl-readback.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { listMeshes, type MeshList, type MeshRow, type RecordingRow } from '../vox/meshes.js';
import type { Glyphs } from './frame.js';
import type { Data } from './model.js';
import { heading, limitRows, onBar, para, S } from './tab-columns.js';
import { wrapSegs, type Line, type Seg } from './text.js';

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
 *  (2: its kind and triangles). The list takes the fullest form whose every item fits the window it may have. */
type Form = 0 | 1 | 2;

/** A mesh's words in a form: its head (its path, then its facts) and the rows under it. */
function meshWords(m: MeshRow, form: Form, sep: string): { head: Line; under: string[] } {
  const r = m.readback;
  const kind = KIND_WORDS[m.kind] ?? m.kind;
  if (!r) {
    const facts = form === 0 ? [kind, m.why ?? 'not measured'].join(sep) : `${kind}${sep}${m.pending ? 'being measured' : 'not measured'}`;
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

/** A recording's words in a form. */
function recordingWords(r: RecordingRow, form: Form, sep: string): { head: Line; under: string[] } {
  const f = r.facts;
  if (!f) return { head: [S(r.path, 'strong'), S(`  ${form === 0 ? `not read: ${r.why ?? 'unknown'}` : 'not read'}`, 'secondary')], under: [] };
  const facts = form === 0 ? [`written by ${f.writer}`, `${f.messages.chunks} data chunks`, `entities, frames and time range: unknown to Timmy (${f.unknown.entities})`]
    : form === 1 ? [`written by ${f.writer}`, `${f.messages.chunks} data chunks`, 'entities, frames and time range: unknown to Timmy (it does not decode the data chunks)']
      : [`written by ${f.writer}`, 'entities, frames, time range: unknown'];
  return { head: [S(r.path, 'strong'), S(`  ${facts.join(sep)}`, 'text')], under: [] };
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
  const form: Form = ([0, 1, 2] as const).find((f) => own.every((it) => itemRows(wordsOf(it, f), w, false, c.g).length <= room)) ?? 2;
  const place = (it: CreateItem, k: number): void => {
    const rows = itemRows(wordsOf(it, form), w, c.cursor === k, c.g);
    items.push({ line: lines.length, item: it, ...(rows.length > 1 ? { rows: rows.length } : {}) });
    lines.push(...rows);
  };
  const meshes = own.filter((x) => x.kind === 'mesh');
  const recordings = own.filter((x) => x.kind === 'recording');

  lines.push([heading(`Meshes in this project (${list.meshes.length + list.more})`)]);
  if (!meshes.length) lines.push(...para('No mesh in this project yet: an .stl, .obj or .ply file in it is listed here (/add <file> copies one in), and a STEP once /vox view <record> has made its tessellation (that needs OCP).', w, 'secondary', '  '));
  meshes.forEach((it) => place(it, own.indexOf(it)));
  if (list.more) lines.push(...para(`and ${list.more} more, not listed here`, w, 'secondary', '  '));
  if (list.meshes.some((m) => m.readback)) lines.push(...para(`Measured by ${list.reader}. ${list.doctrine}`, w, 'secondary', '  '));

  lines.push([], [heading(`Recordings Timmy can read (${list.recordings.length + list.recordingsMore})`)]);
  if (!recordings.length) lines.push(...para('No Rerun recording (.rrd) in this project.', w, 'secondary', '  '));
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
