/**
 * Timmy VoxVision's viewer (round R4, helper H61): `/vox view <record id> [rerun]`, the live board's View in Rerun, and
 * `/vox` alone (its usage, the viewer layers and the status words). It opens a record's inputs and highlights in
 * Rerun's own viewer: a window on the user's computer, started apart from Timmy (detached), which Timmy never stops.
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
 *
 * Round R4 (helper H70), from what r20 found on the Mac:
 *   - The order: what is said before Rerun starts ("Rerun opens a window on your computer …", where it listens, what
 *     is passed) is printed then, through the REPL's notify, before anything starts; the answer says what started. On
 *     the live board the page gets those lines first too (src/repl/workspace.ts boardCommandNow).
 *   - Loopback: Rerun is told to listen on this computer only (`--bind 127.0.0.1`, src/vox/layers.ts RERUN_BIND); a
 *     found rerun whose --help does not list that option is not started.
 *   - A STEP: Rerun has no STEP loader, so a STEP input whose bytes are the record's is given as its tessellation by
 *     OCP (src/vox/tessellate.ts), kept in the record's folder with its sha256 and tolerance, said as a tessellation of
 *     the STEP and never the STEP itself, recorded on the view (`derived`) and sealed with it. Without that Python:
 *     needs setup, with its step.
 *   - The view's receipt names the record's highlights as they are too, so the board, which checks a record's
 *     highlights against its newest receipt, still draws them after a view.
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
import { LATER_LAYERS, launchDetached, planView, RERUN_BIND, RERUN_NAME, RERUN_READS, RERUN_SETUP, rerunBindArgs, rerunReady, rerunTakesBind, type ViewCandidate, type ViewPlan } from '../vox/layers.js';
import { DOCTRINE_15, num, VOX_ID, VOX_SCHEMA, voxRecordPath, type VoxDerived, type VoxView } from '../vox/record.js';
import { stepBoxOf, TESSELLATION, tessellateForView, tessellationReady, reusableTessellation, type StepInput, type TessDeps, type TessOutcome } from '../vox/tessellate.js';
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
  /** R4 (H70): prints a line at once (the REPL's notify): what is said before Rerun starts reaches the screen before it starts. */
  notify: (line: Line) => void;
  /** R4 (H70): a STEP's tessellation runs as this REPL's job (src/vox/tessellate.ts). */
  startJob: TessDeps['startJob'];
  jobs: TessDeps['jobs'];
}

export const VOX_VIEW_USAGE = "/vox view <record id> [rerun]   opens a record's inputs and highlights in Rerun's viewer, a window on your computer";

/** A file's sha256 now: null when it is gone, undefined when it cannot be read or is not inside the project. */
function shaNow(root: string, rel: string): { now: string | null | undefined; abs?: string } {
  const at = resolveInside(root, rel);
  if ('error' in at) return { now: undefined };
  try { return { now: hashFile(at.path), abs: at.path }; } catch (e) { return { now: (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined, abs: at.path }; }
}

const STEP_LOADER = "Rerun's viewer has no STEP loader (a STEP is CAD, not a mesh)";

/** `/vox` and `/vox view …`: the lines to print (what is said before Rerun starts is printed through `notify` then). */
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
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(read.text) as Record<string, unknown>; } catch { return [say(`${rel} is not JSON.`, 'failure')]; }

  // What Rerun is given: the inputs and highlights whose bytes now are the record's, of a format its loaders read.
  const abs = new Map<string, string>();
  const candidates: ViewCandidate[] = [];
  // R4 (H70): the STEP inputs whose bytes now are the record's: Rerun is given each as its tessellation.
  const steps: Array<{ input: StepInput; candidate: ViewCandidate }> = [];
  for (const i of card.inputs) {
    const s = shaNow(at.root, i.path);
    if (s.abs) abs.set(i.path, s.abs);
    const role = i.role === 'a' || i.role === 'b' ? i.role : undefined;
    const c: ViewCandidate = {
      path: i.path, ...(i.sha256 ? { sha256: i.sha256 } : {}), now: s.now, head: s.abs && s.now ? headBytes(s.abs, 512) : Buffer.alloc(0),
      ...(role ? { role } : {}), ...(i.kind ? { kind: i.kind as VoxKind } : {}),
      frame: frameFromRecord(i, card.metrics.filter((m) => !m.malformed)),
    };
    candidates.push(c);
    if (i.kind === 'step' && i.sha256 && s.abs && s.now === i.sha256) steps.push({ input: { path: i.path, sha256: i.sha256, abs: s.abs, ...(role ? { role } : {}), box: stepBoxOf(card.metrics, role) }, candidate: c });
  }
  for (const h of card.highlights) {
    const s = shaNow(at.root, h.path);
    if (s.abs) abs.set(h.path, s.abs);
    candidates.push({
      path: h.path, ...(h.sha256 ? { sha256: h.sha256 } : {}), now: s.now, head: s.abs && s.now ? headBytes(s.abs, 512) : Buffer.alloc(0),
      ...(h.of === 'a' || h.of === 'b' || h.of === 'both' ? { role: h.of } : {}), highlight: { shown: h.shown, ...(h.why ? { why: h.why } : {}) },
    });
  }
  const first = planView(candidates);
  // A STEP is shown as its tessellation: one an earlier view made of these bytes, else OCP's, made now (needs its Python).
  const tess = tessellationReady({ env: d.env(), onPath: d.onPath, root: at.root });
  const meshable = steps.filter((s) => tess.ready || reusableTessellation(raw.views, s.input, at.root, id));
  const setupLines = (list: typeof steps): Line[] => (tess.ready ? [] : list.map((s): Line => [
    { text: '  needs setup ', role: 'estimate' }, { text: `its tessellation for the viewer (OCP), of ${s.input.path}: ${d.scrub(tess.why, at.root)}` }, { text: `${sep}${tess.setup}`, role: 'secondary' },
  ]));
  const notPassed = (plan: ViewPlan, said: (p: string) => string | undefined = () => undefined): Line[] => plan.refused.map((r): Line => [{ text: '  not passed ', role: 'secondary' }, { text: r.path }, { text: `: ${d.scrub(said(r.path) ?? r.why, at.root)}`, role: 'secondary' }]);
  const stepSaid = (why: (s: (typeof steps)[number]) => string) => (p: string): string | undefined => { const s = steps.find((x) => x.input.path === p); return s ? why(s) : undefined; };
  if (!first.pass.length && !meshable.length) {
    return [
      say(`Nothing of ${id} can be opened in Rerun's viewer (it reads ${RERUN_READS}):`, 'estimate'),
      ...notPassed(first, stepSaid(() => `${STEP_LOADER}, and its tessellation for the viewer needs setup`)), ...setupLines(steps),
      say('Nothing was started and nothing was written.'),
    ];
  }

  // R4 (H70): told to listen on this computer only; a rerun whose --help does not list the option is not started.
  // The viewer is the user's program, not part of this request: it gets the REPL's environment without the operation.
  const env = { ...d.env() };
  delete env.TIMMY_OPERATION;
  const bind = await rerunTakesBind({ command: ready.command, env, cwd: at.root });
  if (!bind.ok) {
    return [
      [{ text: '  not started ', role: 'estimate' }, { text: `${RERUN_NAME}, ${ready.via}: ${d.scrub(bind.why, at.root)}` }, { text: `${sep}Timmy starts it only told to listen on this computer (${rerunBindArgs().join(' ')}, as in ${RERUN_BIND.known})${sep}update Rerun: ${RERUN_SETUP}`, role: 'secondary' }],
      say('Nothing was started and nothing was written.'),
    ];
  }

  // Said first, on the screen before anything starts (r20 (5)): a window on the user's computer, apart from Timmy.
  const print = (l: Line): void => d.notify(l);
  print([{ text: '  Rerun      ', role: 'secondary' }, { text: "opens a window on your computer: Rerun's own viewer, started apart from Timmy (detached), which Timmy does not stop; close its window when done. It shows the files as they are and measures nothing." }]);
  print([{ text: '  address    ', role: 'secondary' }, { text: `told to listen on this computer only (${rerunBindArgs().join(' ')})` }, { text: `${sep}a Rerun viewer already listening on its port is given the files instead and keeps its own address`, role: 'secondary' }]);

  // R4 (H70): each STEP that can be, as a mesh: its tessellation, checked by Timmy before it is passed.
  const made: Array<{ step: (typeof steps)[number]; out: TessOutcome }> = [];
  for (const s of meshable) {
    const out = await tessellateForView({ env: d.env, onPath: d.onPath, startJob: d.startJob, jobs: d.jobs, scrub: d.scrub }, {
      root: at.root, project: at.project, id, input: s.input, views: raw.views,
      started: (job) => print([{ text: '  tessellate ', role: 'secondary' }, { text: `${s.input.path}: OCP meshes it for the viewer, within ${num(TESSELLATION.linear_deflection_mm)} mm (linear deflection) and ${num(TESSELLATION.angular_deflection_rad)} rad (angular)` }, { text: `${sep}job ${job.id}`, role: 'secondary' }]),
    });
    made.push({ step: s, out });
  }
  const derived: Array<{ derived: VoxDerived; head: Buffer; step: (typeof steps)[number] }> = made.flatMap((m) => (m.out.ok ? [{ derived: m.out.derived, head: m.out.head, step: m.step }] : []));
  // The derived meshes in their STEP's place: the overlay rule weighs them as that STEP (its frame and unit).
  const final: ViewCandidate[] = candidates.flatMap((c) => {
    const x = derived.find((m) => m.step.candidate === c);
    if (!x) return [c];
    const at_ = resolveInside(at.root, x.derived.path);
    if (!('error' in at_)) abs.set(x.derived.path, at_.path);
    return [c, { path: x.derived.path, sha256: x.derived.sha256, now: x.derived.sha256, head: x.head, ...(c.role ? { role: c.role } : {}), ...(c.kind ? { kind: c.kind } : {}), ...(c.frame ? { frame: c.frame } : {}) }];
  });
  const plan = planView(final);
  const passed = new Set(plan.pass.map((p) => p.path));
  const stepWhy = stepSaid((s) => {
    const m = made.find((x) => x.step === s);
    if (!m) return `${STEP_LOADER}, and its tessellation for the viewer needs setup`;
    if (!m.out.ok) return `${STEP_LOADER}, and its tessellation is not passed: ${m.out.why}`;
    return passed.has(m.out.derived.path) ? `${STEP_LOADER}: its tessellation ${m.out.derived.path} is passed instead` : `${STEP_LOADER}, and its tessellation ${m.out.derived.path} is not passed (said below)`;
  });
  const tessLines: Line[] = made.flatMap((m): Line[] => (m.out.ok ? [[{ text: '  mesh       ', role: 'secondary' }, { text: d.scrub(m.out.derived.words, at.root) }]]
    : m.out.setup ? [[{ text: '  needs setup ', role: 'estimate' }, { text: `its tessellation for the viewer (OCP), of ${m.step.input.path}: ${d.scrub(m.out.why, at.root)}` }, { text: `${sep}${m.out.setup}`, role: 'secondary' }]]
      : [[{ text: '  failed     ', role: 'failure' }, { text: `the tessellation of ${m.step.input.path}: ${d.scrub(m.out.why, at.root)}` }]]));
  const after: Line[] = [...tessLines, ...notPassed(plan, stepWhy), ...setupLines(steps.filter((s) => !meshable.includes(s)))];
  if (!plan.pass.length) {
    const ran = made.some((m) => !m.out.ok && m.out.job) || derived.some((x) => x.derived.made === 'now');
    return [say(`Nothing of ${id} can be opened in Rerun's viewer (it reads ${RERUN_READS}):`, 'estimate'), ...after, say(ran ? 'Nothing was started and the record was not changed; what its tessellation printed is kept beside it.' : 'Nothing was started and nothing was written.')];
  }
  print([{ text: '  passed     ', role: 'secondary' }, { text: plan.pass.map((p) => `${p.path} (${p.loader}, ${p.format})`).join(sep) }]);
  for (const l of after) print(l);
  // DOCTRINE §15 with every CAD or mesh result: a mesh or a point cloud shown is a file's geometry.
  if (plan.pass.some((p) => p.loader === 'mesh' || p.loader === 'point cloud')) print([{ text: '  notice     ', role: 'secondary' }, { text: DOCTRINE_15 }]);

  const started = await launchDetached({ command: ready.command, args: [...rerunBindArgs(), ...plan.pass.map((p) => abs.get(p.path) ?? path.join(at.root, p.path))], cwd: at.root, env });
  const fresh = derived.filter((x) => x.derived.made === 'now').map((x) => x.derived.path);
  if (!started.ok) return [[{ text: '  failed     ', role: 'failure' }, { text: `Rerun's viewer did not start: ${d.scrub(started.error, at.root)}` }], say(`The record was not changed.${fresh.length ? ` Its tessellation stays, unrecorded: ${fresh.join(', ')}.` : ''}`)];

  // The launch on the record, then the vox receipt event over the record so written (put back if it cannot be sealed).
  const op = currentOperation();
  const view: VoxView = {
    viewer: 'rerun', at: new Date().toISOString(), program: ready.via,
    passed: plan.pass.map((p) => ({ path: p.path, sha256: p.sha256, loader: `${p.loader} (${p.format})`, ...(p.role ? { role: p.role } : {}) })),
    not_passed: plan.refused.map((r) => ({ path: r.path, why: d.scrub(stepWhy(r.path) ?? r.why, at.root) })), detached: true,
    ...(started.pid ? { pid: started.pid } : {}), ...(op ? { operation: op } : {}),
    bind: RERUN_BIND.address, ...(derived.length ? { derived: derived.map((x) => ({ ...x.derived, words: d.scrub(x.derived.words, at.root) })) } : {}),
  };
  const startedLine = (tail: Segment[] = []): Line => [{ text: '  started    ', role: 'secondary' }, { text: `${started.pid ? `pid ${started.pid}` : 'its pid not known'}${sep}${ready.via}` }, ...tail];
  const notRecorded = (why: string): Line[] => [startedLine(), say(`The view was not recorded: ${why}.${fresh.length ? ` Its tessellation stays, unrecorded: ${fresh.join(', ')}.` : ''}`, 'estimate')];
  const again = readProjectFile(at.root, rel, 1024 * 1024);
  if (!again.ok || again.sha256 !== read.sha256 || again.text === undefined) return notRecorded(`${rel} changed while the viewer started`);
  let record: Record<string, unknown>;
  try { record = JSON.parse(again.text) as Record<string, unknown>; } catch { return notRecorded(`${rel} is not JSON`); }
  record.views = [...(Array.isArray(record.views) ? record.views : []), view];
  const w = writeProjectFile(at.root, rel, `${JSON.stringify(record, null, 2)}\n`);
  if (!w.ok) return notRecorded(`${rel} could not be written (${d.scrub(w.error, at.root)})`);
  // R4 (H70): the record's highlights as they are now (the bytes it names), so the board still draws them after a view.
  const highlights = (Array.isArray(raw.highlights) ? raw.highlights : []).flatMap((h) => {
    const x = h && typeof h === 'object' ? h as { path?: unknown; sha256?: unknown; bytes?: unknown } : {};
    return typeof x.path === 'string' && typeof x.sha256 === 'string' && typeof x.bytes === 'number' && shaNow(at.root, x.path).now === x.sha256 ? [{ path: x.path, sha256: x.sha256, bytes: x.bytes }] : [];
  });
  const tessJob = derived.find((x) => x.derived.job)?.derived;
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'vox', subject: `vox · view · ${id} · rerun · started`, policy: 'human-gated', status: 'ok', project: at.project, project_id: pid,
      files: plan.pass.map((p) => ({ path: p.path, sha256: p.sha256, kind: p.loader })),
      outputs: [
        { path: w.rel, sha256: w.sha256, bytes: w.bytes }, ...highlights,
        ...derived.flatMap((x) => [{ path: x.derived.path, sha256: x.derived.sha256, bytes: x.derived.bytes }, ...(x.derived.raw ? [x.derived.raw] : [])]),
      ],
      ...(tessJob?.job ? { job: { id: tessJob.job, kind: 'task', label: `vox view ${id} · tessellate ${tessJob.from.path} (OCP)`, state: 'completed', exit_code: 0 } } : {}),
      sources: [{
        vox: id, schema: VOX_SCHEMA, event: 'view', viewer: 'rerun', program: ready.via, detached: true, bind: RERUN_BIND.address, ...(started.pid ? { pid: started.pid } : {}),
        passed: plan.pass.map((p) => p.path), not_passed: plan.refused.map((r) => r.path), at: view.at,
        ...(derived.length ? { derived: derived.map((x) => ({ path: x.derived.path, sha256: x.derived.sha256, kind: x.derived.kind, from: x.derived.from, tolerance: x.derived.tolerance, made: x.derived.made, ...(x.derived.job ? { job: x.derived.job } : {}) })) } : {}),
      }],
    });
  } catch { receipt = undefined; }
  if (!receipt) {
    // Unsealed, the record would no longer be the bytes its receipt sealed: it is put back as it was.
    writeProjectFile(at.root, rel, again.text);
    return notRecorded('its receipt could not be sealed, so the record was put back as it was');
  }
  return [startedLine([{ text: `${sep}recorded on ${w.rel}${sep}receipt ${receipt}`, role: 'secondary' }])];
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
