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
 * A terminal draws no 3D: the view you can turn is the companion's tab 6, which c (Companion · Show) opens on this tab. One line
 * of src/workbench/views.ts (familyView) puts these lines at the top of the tab's body. Files only: the reading is made once
 * for each reading of the Workbench (data.readAt), and each file is measured again only when it changes.
 */
import { num } from '../native/stl-readback.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { listMeshes, type MeshList, type MeshRow } from '../vox/meshes.js';
import type { Glyphs } from './frame.js';
import type { Data } from './model.js';
import { heading, limitRows, para, S } from './tab-columns.js';
import { wrapSegs, type Line } from './text.js';

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

/** Tab 6's meshes and recordings as rows of at most `width` cells, under the sentence that says where the view you can turn is. */
export function createTabLines(c: { data: Pick<Data, 'project' | 'readAt'>; width: number; g: Glyphs }): Line[] {
  const w = Math.max(8, c.width);
  const sep = ` ${c.g.sep} `;
  const out: Line[] = [...limitRows(CREATE_SENTENCE, { c: 'tab 6, the meshes in a view you can turn', s: 'the canvas (2D shapes and cards)' }, w, c.g), []];
  const list = readingOf(c.data.project.root, c.data.readAt);
  if ('error' in list) return [...out, ...para(`The project's meshes could not be read: ${list.error}`, w, 'failure', '  '), []];

  out.push([heading(`Meshes in this project (${list.meshes.length + list.more})`)]);
  if (!list.meshes.length) out.push(...para('No mesh in this project yet: an .stl, .obj or .ply file in it is listed here (/add <file> copies one in), and a STEP once /vox view <record> has made its tessellation (that needs OCP).', w, 'secondary', '  '));
  for (const m of list.meshes) {
    const r = m.readback;
    const facts = [KIND_WORDS[m.kind] ?? m.kind, ...(r
      ? [`${r.triangles} triangle${r.triangles === 1 ? '' : 's'}`, r.bbox ? `box ${r.bbox.size.map(num).join(' × ')}` : 'no box', m.topology, `volume ${m.volume}`,
        ...(m.view && m.view.shown < m.view.total ? [`the companion's view shows ${m.view.shown} of ${m.view.total}`] : [])]
      : [m.why ?? 'not measured'])].join(sep);
    out.push(...wrapSegs([S(`  ${m.path}`, 'strong'), S(`  ${facts}`, r ? 'text' : 'secondary')], w, '    '));
    if (r && (m.faces || m.ignored)) out.push(...para([m.faces, m.ignored].filter(Boolean).join(sep), w, 'secondary', '    '));
    if (m.kind === 'tessellation') out.push(...para(m.origin.words, w, 'secondary', '    '));
    if (m.declared) out.push(...para(`the file says (${m.declared.what}; not checked): ${m.declared.words}`, w, 'secondary', '    '));
  }
  if (list.more) out.push(...para(`and ${list.more} more, not listed here`, w, 'secondary', '  '));
  if (list.meshes.some((m) => m.readback)) out.push(...para(`Measured by ${list.reader}. ${list.doctrine}`, w, 'secondary', '  '));

  out.push([], [heading(`Recordings Timmy can read (${list.recordings.length + list.recordingsMore})`)]);
  if (!list.recordings.length) out.push(...para('No Rerun recording (.rrd) in this project.', w, 'secondary', '  '));
  for (const r of list.recordings) {
    const f = r.facts;
    const facts = f
      ? [`written by ${f.writer}`, `${f.messages.chunks} data chunks`, `entities, frames and time range: unknown to Timmy (${f.unknown.entities})`].join(sep)
      : `not read: ${r.why ?? 'unknown'}`;
    out.push(...wrapSegs([S(`  ${r.path}`, 'strong'), S(`  ${facts}`, f ? 'text' : 'secondary')], w, '    '));
  }
  if (list.recordingsMore) out.push(...para(`and ${list.recordingsMore} more, not listed here`, w, 'secondary', '  '));
  out.push(...para(`${list.viewer.name}: ${list.viewer.state}${list.viewer.setup ? ` (${list.viewer.setup})` : ''}`, w, 'secondary', '  '));
  return out;
}
