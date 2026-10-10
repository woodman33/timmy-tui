/**
 * Timmy VoxVision's viewer (round R4, helper H61): `/vox view <record id> [rerun]`, the live board's View in Rerun, and
 * `/vox` alone (its usage, the viewer layers and the status words). It opens a record's inputs and highlights in
 * Rerun's own viewer: a window on the user's computer, started apart from Timmy (detached), which Timmy never stops.
 * The lines say so before it starts.
 *
 *   - The record must be one its vox receipt sealed: verified, or stale (then a changed input is not passed). An
 *     unverified record is refused: nothing vouches for the files it names.
 *   - A file is passed only when its bytes now are the bytes the record names and Rerun's built-in loaders read its
 *     format, by its name and its bytes (src/vox/layers.ts); every other file is said with why. Two meshes or point
 *     clouds are not overlaid unless they share a known frame and unit.
 *   - A missing Rerun is "needs setup" with its install step: nothing starts and nothing is written.
 *   - A launch is recorded on the record (`views`) and sealed as a `vox` receipt event over the record so written, with
 *     the files passed; if it cannot be sealed, the record is put back as it was. Rerun measures nothing: no value of
 *     the record changes.
 *   - Viser and FiftyOne are named with their install steps: VoxVision has no layer for them yet.
 */
import path from 'node:path';
import { currentOperation } from '../ops/context.js';
import { projectId, readProjectFile, resolveInside, writeProjectFile } from '../project/index.js';
import { hashFile } from '../project/intake.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';
import { frameFromRecord } from '../vox/frames.js';
import { headBytes, type VoxKind } from '../vox/kinds.js';
import { LATER_LAYERS, launchDetached, planView, RERUN_NAME, RERUN_READS, rerunReady, type ViewCandidate } from '../vox/layers.js';
import { DOCTRINE_15, VOX_ID, VOX_SCHEMA, voxRecordPath, type VoxView } from '../vox/record.js';
import { VOX_WORDS, WORD_MEANS } from '../vox/words.js';
import { readVoxRecord } from './board-vox.js';

type Line = Segment[];

export interface VoxViewDeps {
  glyphs: GlyphSet;
  /** The REPL's environment, read at each command. */
  env: () => NodeJS.ProcessEnv;
  onPath: (cmd: string) => string | null;
  seal: (input: ReceiptInput) => string | undefined;
  /** Writes the project's folder as "." and the home folder as "~". */
  scrub: (text: string, root: string) => string;
  /** The runs chain now. */
  receipts: () => readonly Receipt[];
  /** The record ids of the actions under way in a project (their records are written when they end). */
  running: (root: string) => string[];
}

export const VOX_VIEW_USAGE = "/vox view <record id> [rerun]   opens a record's inputs and highlights in Rerun's viewer, a window on your computer";

/** A file's sha256 now: null when it is gone, undefined when it cannot be read or is not inside the project. */
function shaNow(root: string, rel: string): { now: string | null | undefined; abs?: string } {
  const at = resolveInside(root, rel);
  if ('error' in at) return { now: undefined };
  try { return { now: hashFile(at.path), abs: at.path }; } catch (e) { return { now: (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined, abs: at.path }; }
}

/** `/vox` and `/vox view …`: the lines to print. */
export async function voxCommand(d: VoxViewDeps, args: string, at: { root: string; project: string }): Promise<Line[]> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const sep = ` ${d.glyphs.sep} `;
  const say = (text: string, role: Segment['role'] = 'secondary'): Line => [{ text: `  ${text}`, role }];
  if (!words.length || words[0] === 'help' || words[0] === 'layers') return layerLines(d, at, sep);
  const [verb, id, viewer = 'rerun', ...rest] = words;
  if (verb !== 'view' || !id || rest.length) return [say(`Usage: ${VOX_VIEW_USAGE}`)];
  const later = LATER_LAYERS.find((l) => l.tool === viewer.toLowerCase());
  if (later) return [[{ text: '  needs setup ', role: 'estimate' }, { text: `${later.name}: VoxVision has no ${later.name} layer yet` }, { text: `${sep}${later.setup}${sep}it would add ${later.adds}`, role: 'secondary' }], say(`Nothing was started. /vox view ${id} opens it in Rerun.`)];
  if (viewer.toLowerCase() !== 'rerun') return [say(`VoxVision opens a record in Rerun's viewer: /vox view ${id} [rerun]. Viser and FiftyOne need setup (/vox).`)];
  if (!VOX_ID.test(id)) return [say(`${id} is not a VoxVision record id: v and 8 hex digits, as the board and the record's file name show (results/vox/<id>.json).`)];
  if (d.running(at.root).includes(id)) return [say(`${id} is still running: its record is written when it ends; /vox view ${id} then.`, 'estimate')];
  const rel = voxRecordPath(id);
  const read = readProjectFile(at.root, rel, 1024 * 1024);
  if (!read.ok) return [say(`No record ${id} in this project (${rel}): /board lists the records.`, 'failure')];
  if (read.binary || read.text === undefined || read.truncated || !read.sha256) return [say(`${rel} is not a VoxVision record Timmy can read.`, 'failure')];
  let chain: readonly Receipt[];
  try { chain = d.receipts(); } catch { chain = []; }
  const pid = projectId(at.root);
  const card = readVoxRecord({ root: at.root, file: rel, text: read.text, fileSha256: read.sha256, chain, projectId: pid });
  if (!card) return [say(`${rel} is not a VoxVision record (timmy.vox/1) Timmy can read.`, 'failure')];
  if (card.check.status === 'unverified') {
    return [say(`${id} is not verified (${d.scrub(card.check.reasons[0] ?? 'no receipt sealed it', at.root)}): /vox view opens only a record its vox receipt sealed. /${card.action} its files again for a new record.`, 'estimate')];
  }
  const ready = rerunReady({ env: d.env(), onPath: d.onPath, root: at.root });
  if (!ready.ready) {
    return [[{ text: '  needs setup ', role: 'estimate' }, { text: `${RERUN_NAME}: ${ready.why}` }, { text: `${sep}${ready.setup}`, role: 'secondary' }], say('Nothing was started and nothing was written.')];
  }

  // What Rerun is given: the inputs and highlights whose bytes now are the record's, of a format its loaders read.
  const abs = new Map<string, string>();
  const candidates: ViewCandidate[] = [];
  for (const i of card.inputs) {
    const s = shaNow(at.root, i.path);
    if (s.abs) abs.set(i.path, s.abs);
    candidates.push({
      path: i.path, ...(i.sha256 ? { sha256: i.sha256 } : {}), now: s.now, head: s.abs && s.now ? headBytes(s.abs, 512) : Buffer.alloc(0),
      ...(i.role === 'a' || i.role === 'b' ? { role: i.role } : {}), ...(i.kind ? { kind: i.kind as VoxKind } : {}),
      frame: frameFromRecord(i, card.metrics.filter((m) => !m.malformed)),
    });
  }
  for (const h of card.highlights) {
    const s = shaNow(at.root, h.path);
    if (s.abs) abs.set(h.path, s.abs);
    candidates.push({
      path: h.path, ...(h.sha256 ? { sha256: h.sha256 } : {}), now: s.now, head: s.abs && s.now ? headBytes(s.abs, 512) : Buffer.alloc(0),
      ...(h.of === 'a' || h.of === 'b' || h.of === 'both' ? { role: h.of } : {}), highlight: { shown: h.shown, ...(h.why ? { why: h.why } : {}) },
    });
  }
  const plan = planView(candidates);
  const refusedLines = plan.refused.map((r): Line => [{ text: '  not passed ', role: 'secondary' }, { text: r.path }, { text: `: ${d.scrub(r.why, at.root)}`, role: 'secondary' }]);
  if (!plan.pass.length) return [say(`Nothing of ${id} can be opened in Rerun's viewer (it reads ${RERUN_READS}):`, 'estimate'), ...refusedLines, say('Nothing was started and nothing was written.')];

  // Said before it starts: a window on the user's computer, apart from Timmy.
  const before: Line[] = [
    [{ text: '  Rerun      ', role: 'secondary' }, { text: "opens a window on your computer: Rerun's own viewer, started apart from Timmy (detached), which Timmy does not stop; close its window when done. It shows the files as they are and measures nothing." }],
    [{ text: '  passed     ', role: 'secondary' }, { text: plan.pass.map((p) => `${p.path} (${p.loader}, ${p.format})`).join(sep) }],
    ...refusedLines,
    // DOCTRINE §15 with every CAD or mesh result: a mesh or a point cloud shown is a file's geometry.
    ...(plan.pass.some((p) => p.loader === 'mesh' || p.loader === 'point cloud') ? [[{ text: '  notice     ', role: 'secondary' as const }, { text: DOCTRINE_15 }]] : []),
  ];
  // The viewer is the user's program, not part of this request: it gets the REPL's environment without the operation.
  const env = { ...d.env() };
  delete env.TIMMY_OPERATION;
  const started = await launchDetached({ command: ready.command, args: plan.pass.map((p) => abs.get(p.path) ?? path.join(at.root, p.path)), cwd: at.root, env });
  if (!started.ok) return [...before, [{ text: '  failed     ', role: 'failure' }, { text: `Rerun's viewer did not start: ${d.scrub(started.error, at.root)}` }], say('Nothing was written.')];

  // The launch on the record, then the vox receipt event over the record so written (put back if it cannot be sealed).
  const op = currentOperation();
  const view: VoxView = {
    viewer: 'rerun', at: new Date().toISOString(), program: ready.via,
    passed: plan.pass.map((p) => ({ path: p.path, sha256: p.sha256, loader: `${p.loader} (${p.format})`, ...(p.role ? { role: p.role } : {}) })),
    not_passed: plan.refused.map((r) => ({ path: r.path, why: d.scrub(r.why, at.root) })), detached: true,
    ...(started.pid ? { pid: started.pid } : {}), ...(op ? { operation: op } : {}),
  };
  const notRecorded = (why: string): Line[] => [...before, [{ text: '  started    ', role: 'secondary' }, { text: `${started.pid ? `pid ${started.pid}` : 'its pid not known'}${sep}${ready.via}` }], say(`The view was not recorded: ${why}.`, 'estimate')];
  const again = readProjectFile(at.root, rel, 1024 * 1024);
  if (!again.ok || again.sha256 !== read.sha256 || again.text === undefined) return notRecorded(`${rel} changed while the viewer started`);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(again.text) as Record<string, unknown>; } catch { return notRecorded(`${rel} is not JSON`); }
  raw.views = [...(Array.isArray(raw.views) ? raw.views : []), view];
  const w = writeProjectFile(at.root, rel, `${JSON.stringify(raw, null, 2)}\n`);
  if (!w.ok) return notRecorded(`${rel} could not be written (${d.scrub(w.error, at.root)})`);
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'vox', subject: `vox · view · ${id} · rerun · started`, policy: 'human-gated', status: 'ok', project: at.project, project_id: pid,
      files: plan.pass.map((p) => ({ path: p.path, sha256: p.sha256, kind: p.loader })),
      outputs: [{ path: w.rel, sha256: w.sha256, bytes: w.bytes }],
      sources: [{
        vox: id, schema: VOX_SCHEMA, event: 'view', viewer: 'rerun', program: ready.via, detached: true, ...(started.pid ? { pid: started.pid } : {}),
        passed: plan.pass.map((p) => p.path), not_passed: plan.refused.map((r) => r.path), at: view.at,
      }],
    });
  } catch { receipt = undefined; }
  if (!receipt) {
    // Unsealed, the record would no longer be the bytes its receipt sealed: it is put back as it was.
    writeProjectFile(at.root, rel, again.text);
    return notRecorded('its receipt could not be sealed, so the record was put back as it was');
  }
  return [
    ...before,
    [{ text: '  started    ', role: 'secondary' }, { text: `${started.pid ? `pid ${started.pid}` : 'its pid not known'}${sep}${ready.via}` }, { text: `${sep}recorded on ${w.rel}${sep}receipt ${receipt}`, role: 'secondary' }],
  ];
}

/** `/vox`: the viewer command, the layers' states and the status words. */
function layerLines(d: VoxViewDeps, at: { root: string }, sep: string): Line[] {
  const ready = rerunReady({ env: d.env(), onPath: d.onPath, root: at.root });
  return [
    [{ text: '  VoxVision viewers', role: 'strong' }, { text: '  advanced and opt-in: a viewer shows a record\'s files; it measures nothing', role: 'secondary' }],
    [{ text: `  ${VOX_VIEW_USAGE}` }],
    ready.ready
      ? [{ text: `  ${RERUN_NAME}  ` }, { text: 'found', role: 'strong' }, { text: `${sep}${ready.via}; found is not run: /vox view <record id> starts it${sep}reads ${RERUN_READS}`, role: 'secondary' }]
      : [{ text: `  ${RERUN_NAME}  ` }, { text: 'needs setup', role: 'estimate' }, { text: `${sep}${ready.why}${sep}${ready.setup}`, role: 'secondary' }],
    ...LATER_LAYERS.map((l): Line => [{ text: `  ${l.name}  ` }, { text: 'needs setup', role: 'estimate' }, { text: `${sep}${l.setup}${sep}no ${l.name} layer yet; it would add ${l.adds}`, role: 'secondary' }]),
    [{ text: '  Words      ', role: 'secondary' }, { text: VOX_WORDS.map((w) => `${w}: ${WORD_MEANS[w]}`).join(sep), role: 'secondary' }],
  ];
}
