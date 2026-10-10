/**
 * Round R4 (H55): the active project as cards for Timmy Canvas (GET /api/project, src/studio/project-link.ts). The owner's
 * direction (02:26): Studio/tldraw, the terminal and the browser on the same projects, operations and editable artifacts.
 *
 * Each card is built from the SAME readers the board uses, nothing of its own:
 *   workflow   each workflow document (findWorkflowDocs, workflowForBoard, connectWorkflow): its blocks and newest run
 *   params     the tray recipe's parameter file (paramsCard) and each OpenSCAD model's <model>.params.json
 *              (readScadParams), when the file is there or a workflow names it
 *   flow       each /iterate flow record with its verdict and its check against the runs chain (readBoardFlows), and the
 *              flows that run (their state files)
 *   vox        each VoxVision record with its highlights and its check (readBoardVox)
 *   run        the Control Room's running and recent runs (gatherRoom), but its flows, which have their own cards
 *   unreadable a flow or VoxVision record file the readers left out because it cannot be read as one, named with why
 *
 * A card is its title, its state in words, the record and the receipt behind it (project-relative; a receipt only when
 * the reader's own check names it), the typed command that acts on it, and the board section that shows it. Nothing here
 * writes, runs or seals. The server reads only the folders the REPL named (the project, its jobs folder and its receipts
 * store); every text goes out with the project's folder as "." and the home folder as "~", and any other absolute path
 * as <path>.
 */
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scrubPaths } from '../code-agents/index.js';
import { FLOW_ID, FLOW_SCHEMA } from '../flows/iterate.js';
import { JobManager, type JobRecord } from '../jobs/index.js';
import { paramsFileFor, readScadParams } from '../native/scad-params.js';
import { listProjectFiles, projectId, readProjectFile, sameFolder, type ProjectFile, type ReadResult } from '../project/index.js';
import { PARAMETER_NAMES } from '../recipes/index.js';
import { paramsCard } from '../repl/board-cards.js';
import { readBoardFlows, type BoardFlow, type BoardFlows } from '../repl/board-flows.js';
import { workflowForBoard } from '../repl/board-nodes.js';
import { readBoardVox } from '../repl/board-vox.js';
import { connectWorkflow, mentions, TRAY_PARAMS } from '../repl/board-workflows.js';
import { gatherRoom, type RoomRun } from '../room/index.js';
import type { Receipt } from '../utils/receipts.js';
import { findWorkflowDocs } from '../workflows/upmd.js';

export type ProjectCardKind = 'workflow' | 'params' | 'flow' | 'vox' | 'run' | 'unreadable';

/** One card, as the canvas panel lists it and a placed card holds it. */
export interface ProjectCard {
  /** stable across reads while its record is there: `flow:f1a2b3c4`, `workflow:BUILD.md`, `run:agent:<id>` */
  id: string;
  kind: ProjectCardKind;
  title: string;
  /** its state, in words */
  state: string;
  /** the record behind it, relative to the project (null: none, such as a recipe's defaults) */
  record: string | null;
  /** the receipt behind it (short id), only when the reader's check names one */
  receipt: string | null;
  /** the typed command that acts on it, in the REPL */
  command: string;
  /** the board section that shows it (an anchor of /board and /board live) */
  section: 'room' | 'workflows' | 'parameters' | 'flows' | 'voxvision';
  /** VoxVision: the highlight images its check shows, relative to the project */
  highlights?: string[];
}

export interface ProjectCards {
  cards: ProjectCard[];
  /** what was left out or could not be read, in words */
  notes: string[];
}

/** What the REPL named for its project: the server reads these folders and nothing else. */
export interface CardSource {
  root: string;
  name: string;
  /** where the REPL keeps its job records (<TIMMY_HOME>/jobs); null: none named */
  jobs: string | null;
  /** the receipts store the REPL seals to (its runs.jsonl is read); null: none named */
  receipts: string | null;
}

export const CARDS_MAX = 120;
const RECORD_MAX = 1024 * 1024;
const VOX_RECORD = /^results\/vox\/(v[0-9a-f]{8})\.json$/;
const FLOW_RECORD = /^results\/flows\/(f[0-9a-f]{8})\.json$/;

// ── text ──────────────────────────────────────────────────────────────────────

const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');
/** A path of two parts or more that starts at /, at the start or after a space, a quote or a bracket. */
const ABSOLUTE = /(^|[\s"'(=[,;])(\/[^\s"'<>()[\],;/]+(?:\/[^\s"'<>()[\],;/]*)+)/g;
const WINDOWS = /(^|[\s"'(=[,;])([A-Za-z]:\\[^\s"'<>]*)/g;

/** One line of text for a card: the project's folder as ".", the home folder as "~", any other absolute path as <path>, cut at `max`. */
export function cardText(text: unknown, root: string, max = 300): string {
  const s = scrubPaths(String(text ?? ''), root).replace(CONTROL, ' ').replace(ABSOLUTE, '$1<path>').replace(WINDOWS, '$1<path>').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** A command argument as /run, /scad and /open read it: one word, or null when it has a space. */
const word = (s: string): string | null => (s && !/\s/.test(s) ? s : null);

// ── what the REPL named ───────────────────────────────────────────────────────

/** The runs chain in the named store (runs.jsonl, one receipt per line), as readChain reads it; [] when there is none. */
export function readRunsChain(store: string | null): Receipt[] {
  if (!store) return [];
  let text: string;
  try {
    const file = join(store, 'runs.jsonl');
    if (!statSync(file).isFile()) return [];
    text = readFileSync(file, 'utf8');
  } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const r = JSON.parse(line) as Receipt;
      return r && typeof r.hash === 'string' ? [r] : [];
    } catch { return []; }
  });
}

/** The project's job records in the named jobs folder (read only: nothing is created or changed), newest first. */
export function readProjectJobs(dir: string | null, root: string): JobRecord[] {
  if (!dir) return [];
  try {
    return new JobManager({ dir }).list().filter((j) => sameFolder(j.root, root));
  } catch { return []; }
}

/** The newest receipt of this project that names `rel` among its files or outputs (its short id). */
function receiptNaming(chain: readonly Receipt[], rel: string, pid: string): string | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const r = chain[i];
    if (r.project_id !== pid) continue;
    if ([...(r.files ?? []), ...(r.outputs ?? [])].some((f) => f && f.path === rel)) return typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : null;
  }
  return null;
}

// ── the cards ─────────────────────────────────────────────────────────────────

/** Each workflow document, with its newest run (connectWorkflow, as the board connects it). */
function workflowCards(c: Ctx): ProjectCard[] {
  return c.docs.slice(0, 20).map((doc): ProjectCard => {
    const r = c.doc(doc.rel);
    const view = workflowForBoard(doc.rel, r.ok && r.text !== undefined && !r.truncated ? { text: r.text, ...(r.sha256 ? { sha256: r.sha256 } : {}) } : undefined);
    let w = view;
    try {
      w = connectWorkflow(view, { root: c.root, jobs: c.jobs, chain: c.chain, files: c.rels, scrub: c.scrub, tray: () => paramsCard(c.root) });
    } catch { w = view; }
    const names = w.blocks.map((b) => b.name);
    const run = w.connected?.runs.find((x) => x.job === w.connected?.latest) ?? w.connected?.runs[0];
    const title = (r.ok && r.text ? /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(r.text)?.[1] : undefined) ?? doc.rel;
    const blocks = `${names.length} block${names.length === 1 ? '' : 's'}: ${names.join(', ')}`;
    const state = !r.ok ? `not readable: ${r.error}`
      : run ? `newest run (${run.target}) ${run.word}${run.met === false ? ', its prediction not met' : ''} · ${blocks}`
        : `not run yet · ${blocks}`;
    const last = names[names.length - 1];
    const runCmd = word(doc.rel) && last && word(last) ? `/run ${doc.rel} ${last}` : `/workflows ${doc.rel}`;
    return {
      id: `workflow:${doc.rel}`, kind: 'workflow', title: c.text(title, 160), state: c.text(state), record: doc.rel,
      receipt: run?.receipt ?? null, command: c.text(runCmd, 400), section: 'workflows',
    };
  });
}

/** The tray recipe's parameter file and each OpenSCAD model's, when the file is there or a workflow names it. */
function paramsCards(c: Ctx): ProjectCard[] {
  const out: ProjectCard[] = [];
  // A workflow names a parameter file by its path in its text (the board's own plain match, `mentions`).
  const named = (rel: string): boolean => c.docs.some((d) => {
    const r = c.doc(d.rel);
    return r.ok && typeof r.text === 'string' && mentions(r.text, rel);
  });
  // The tray recipe's: its file read and checked by the recipe's own rules (the board's parameter card).
  const tray = c.rels.includes(TRAY_PARAMS) || named(TRAY_PARAMS) ? paramsCard(c.root) : undefined;
  if (tray) {
    const values = PARAMETER_NAMES.map((n) => `${n} ${tray.values[n]}`).join(', ');
    const state = tray.file.state === 'ok' ? `saved: ${values} (mm)`
      : tray.file.state === 'none' ? `no file yet: the recipe's defaults, ${values} (mm)`
        : `not usable: ${tray.file.error}; /recipe ${tray.recipe} refuses to start until it is fixed`;
    out.push({
      id: `params:${tray.path}`, kind: 'params', title: c.text(`Tray recipe parameters (${tray.path})`, 160), state: c.text(state),
      record: tray.file.state === 'none' ? null : tray.path, receipt: tray.file.state === 'none' ? null : receiptNaming(c.chain, tray.path, c.pid),
      command: `/recipe ${tray.recipe}`, section: 'parameters',
    });
  }
  // OpenSCAD: every model in the project with its parameter file beside it, or named by a workflow.
  const models = c.rels.filter((f) => /\.scad$/i.test(f));
  for (const model of models.slice(0, 12)) {
    const file = paramsFileFor(model);
    if (!c.rels.includes(file) && !named(file)) continue;
    const read = readScadParams(c.root, model);
    const state = !read.ok ? `not usable: ${read.error}`
      : !read.exists ? 'no parameter file yet: the model\'s own values'
        : `saved: ${Object.entries(read.parameters).slice(0, 8).map(([k, v]) => `${k} ${String(v)}`).join(', ') || 'no parameters'}${Object.keys(read.parameters).length > 8 ? ', …' : ''}`;
    out.push({
      id: `params:${file}`, kind: 'params', title: c.text(`OpenSCAD parameters of ${model} (${file})`, 160), state: c.text(state),
      record: read.ok && !read.exists ? null : file, receipt: read.ok && !read.exists ? null : receiptNaming(c.chain, file, c.pid),
      command: c.text(word(model) ? `/scad ${model}` : `/open ${file}`, 400), section: 'workflows',
    });
  }
  return out;
}

const KIND_OF_FLOW = (r: Record<string, unknown>): string => (typeof r.target === 'string' ? r.target : 'tray');

/** Each flow: its outcome and verdict as its record says, and whether a flow receipt sealed exactly those bytes. */
function flowCard(f: BoardFlow, c: Ctx): ProjectCard {
  const r = f.record as unknown as Record<string, unknown>;
  const id = String(r.id);
  const instruction = typeof r.instruction === 'string' ? r.instruction : '';
  const title = `/iterate ${KIND_OF_FLOW(r)} · ${id}${instruction ? `: ${instruction}` : ''}`;
  if (f.live) {
    const step = typeof r.step === 'string' ? `its ${r.step} step` : 'a step its state file does not name';
    return {
      id: `flow:${id}`, kind: 'flow', title: c.text(title, 160), state: c.text(`running: ${step}, as its state file says (written ${f.live.written})`),
      record: f.file, receipt: null, command: `/stop ${id}`, section: 'flows',
    };
  }
  const readback = r.readback && typeof r.readback === 'object' ? r.readback as Record<string, unknown> : undefined;
  const verdict = typeof readback?.verdict === 'string' ? `, readback ${readback.verdict}` : '';
  const check = f.check.status === 'verified' ? `verified: receipt ${f.check.receipt} sealed these bytes` : `not verified: ${f.check.reasons.join('; ') || 'no reason was given'}`;
  const outcome = String(r.outcome ?? 'unknown');
  return {
    id: `flow:${id}`, kind: 'flow', title: c.text(title, 160), state: c.text(`${outcome}${verdict}${f.check.status === 'verified' ? '' : ' (as the file says)'} · ${check}`),
    record: f.file, receipt: f.check.status === 'verified' ? f.check.receipt ?? null : null,
    command: FLOW_ID.test(id) ? `/room ${id}` : '/iterate', section: 'flows',
  };
}

/** Each VoxVision record: its action and inputs, its check, and the highlights the check shows. */
function voxCards(c: Ctx): ProjectCard[] {
  const vox = readBoardVox({ root: c.root, files: c.files, chain: c.chain, projectId: c.pid, scrub: c.scrub, tools: { env: {}, onPath: () => null, root: c.root } });
  if (vox.more) c.notes.push(`${vox.more} older VoxVision records are not listed (the board shows the newest ${vox.cards.length}).`);
  // The vox receipt that sealed a record (the reader's own rule: the newest of this project naming it first), by the short id
  // the REPL prints (hash characters 8 to 15, as receipts are named everywhere else).
  const sealedBy = (file: string): string | null => {
    for (let i = c.chain.length - 1; i >= 0; i--) {
      const r = c.chain[i];
      if (r.kind === 'vox' && r.project_id === c.pid && r.outputs?.[0]?.path === file) return typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : null;
    }
    return null;
  };
  return vox.cards.map((v): ProjectCard => {
    const shown = v.highlights.filter((h) => h.shown).map((h) => h.path);
    const inputs = v.inputs.map((i) => i.path).join(' and ');
    const receipt = v.check.status !== 'unverified' ? sealedBy(v.file) : null;
    const check = v.check.status === 'verified' ? `verified: receipt ${receipt ?? '?'} sealed it` : `${v.check.status}: ${v.check.reasons.join('; ') || 'no reason was given'}`;
    const failures = v.failures.length ? ` · ${v.failures.length} failure${v.failures.length === 1 ? '' : 's'}` : '';
    return {
      id: `vox:${v.id}`, kind: 'vox', title: c.text(`${v.action} ${inputs || '(no input named)'}`, 160),
      state: c.text(`${v.status} · ${check} · ${shown.length} highlight${shown.length === 1 ? '' : 's'} shown${failures}`),
      record: v.file, receipt,
      command: c.text(v.command ?? `/inspect ${v.inputs[0]?.path ?? v.file}`, 400), section: 'voxvision', highlights: shown,
    };
  });
}

/** The Control Room's running runs and the recent ones of each owner, but flows (they have their own cards). */
function runCards(c: Ctx, flows: BoardFlows): ProjectCard[] {
  const room = gatherRoom({
    root: c.root, project: c.name, projectId: c.pid, jobs: c.jobs, chain: c.chain, flows,
    // The canvas server knows no REPL's own jobs: a run's Stop is the REPL's typed /stop, which the REPL checks.
    mine: () => false, activeFlows: [], scrub: c.scrub,
  });
  const runs: RoomRun[] = [...room.view.running, ...room.view.groups.flatMap((g) => g.recent)].filter((r) => r.kind !== 'flow');
  const seen = new Set<string>();
  return runs.flatMap((r): ProjectCard[] => {
    const id = `run:${r.kind}:${r.id}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const command = r.running ? (r.hint?.command ?? (r.job ? `/stop ${r.job}` : `/room ${r.id}`)) : `/room ${r.id}`;
    return [{
      id, kind: 'run', title: c.text(`${r.owner} · ${r.id}`, 160), state: c.text(`${r.state}${r.step ? ` · ${r.step}` : ''}${r.recordNote ? ` · ${r.recordNote}` : ''}`),
      record: r.record ?? null, receipt: r.receipt ?? null, command: c.text(command, 400), section: 'room',
    }];
  });
}

/** Why a record file the readers left out cannot be read as one, or null when it can (it was only left off the list). */
function unreadable(root: string, rel: string, schema: string): string | null {
  const abs = join(root, rel);
  let buf: Buffer;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return 'a symbolic link: records are read only in place';
    if (!st.isFile()) return 'not a regular file';
    if (st.size > RECORD_MAX) return `larger than ${RECORD_MAX / 1024 / 1024} MB`;
    buf = readFileSync(abs);
  } catch (e) { return `cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`; }
  let json: unknown;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { return `not JSON (${e instanceof Error ? e.message : String(e)})`; }
  const o = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : undefined;
  if (!o) return 'not a JSON object';
  if (o.schema !== schema) return `its schema is not ${schema}`;
  return null;
}

function unreadableCard(rel: string, why: string, section: ProjectCard['section'], c: Ctx): ProjectCard {
  return {
    id: `unreadable:${rel}`, kind: 'unreadable', title: c.text(`Unreadable record ${rel}`, 160), state: c.text(`unreadable: ${why}`),
    record: rel, receipt: null, command: c.text(word(rel) ? `/open ${rel}` : `/files ${rel.slice(0, rel.lastIndexOf('/'))}`, 400), section,
  };
}

interface Ctx {
  root: string;
  name: string;
  pid: string;
  files: ProjectFile[];
  rels: string[];
  docs: Array<{ rel: string }>;
  /** a workflow document, read once (up to 1 MB) */
  doc: (rel: string) => ReadResult;
  jobs: JobRecord[];
  chain: Receipt[];
  notes: string[];
  scrub: (t: string) => string;
  text: (t: unknown, max?: number) => string;
}

/**
 * The project's cards, read now. `chain` and `jobs` may be given (a test, or a caller that has them); otherwise they are
 * read from the store and the jobs folder the REPL named. Each part is read inside its own guard: a part that throws
 * becomes a note, never a failed answer.
 */
export function projectCards(src: CardSource, given: { chain?: Receipt[]; jobs?: JobRecord[] } = {}): ProjectCards {
  const root = src.root;
  const notes: string[] = [];
  let listed: { files: ProjectFile[]; truncated: boolean };
  try { listed = listProjectFiles(root); } catch { listed = { files: [], truncated: false }; }
  if (listed.truncated) notes.push('Only the first 2,000 files of the project were read.');
  const read = new Map<string, ReadResult>();
  const c: Ctx = {
    root, name: src.name, pid: projectId(root), files: listed.files, rels: listed.files.map((f) => f.rel),
    docs: (() => { try { return findWorkflowDocs(root); } catch { return []; } })(),
    doc: (rel) => {
      if (!read.has(rel)) read.set(rel, readProjectFile(root, rel, 1024 * 1024));
      return read.get(rel)!;
    },
    jobs: given.jobs ?? readProjectJobs(src.jobs, root),
    chain: given.chain ?? readRunsChain(src.receipts),
    notes,
    scrub: (t) => scrubPaths(t, root),
    text: (t, max) => cardText(t, root, max),
  };
  const part = <T>(what: string, read: () => T[]): T[] => {
    try { return read(); } catch (e) { notes.push(`The ${what} could not be read: ${cardText(e instanceof Error ? e.message : String(e), root)}`); return []; }
  };
  const flowRels = c.rels.filter((f) => FLOW_RECORD.test(f));
  let flows: BoardFlows = { list: [], more: 0 };
  try { flows = readBoardFlows(root, flowRels, { receipts: c.chain, projectId: c.pid, scrub: c.scrub }); } catch (e) {
    notes.push(`The flow records could not be read: ${cardText(e instanceof Error ? e.message : String(e), root)}`);
  }
  if (flows.more) notes.push(`${flows.more} older flow records are not listed (the board reads the newest ${flows.list.length}).`);
  const shownFlows = new Set([...flows.list, ...(flows.running ?? [])].map((f) => f.file));
  const shownVox = new Set<string>();
  const cards: ProjectCard[] = [
    ...part('workflow documents', () => workflowCards(c)),
    ...part('parameter files', () => paramsCards(c)),
    ...part('flows', () => [...(flows.running ?? []), ...flows.list].map((f) => flowCard(f, c))),
    ...part('VoxVision records', () => voxCards(c).map((v) => { if (v.record) shownVox.add(v.record); return v; })),
    ...part('Control Room', () => runCards(c, flows)),
  ];
  // The record files the readers left out because they cannot be read as records: named, with why.
  const odd = [
    ...flowRels.filter((f) => !shownFlows.has(f)).flatMap((f) => { const why = unreadable(root, f, FLOW_SCHEMA); return why ? [unreadableCard(f, why, 'flows', c)] : []; }),
    ...c.rels.filter((f) => VOX_RECORD.test(f) && !shownVox.has(f)).flatMap((f) => { const why = unreadable(root, f, 'timmy.vox/1'); return why ? [unreadableCard(f, why, 'voxvision', c)] : []; }),
  ];
  const all = [...odd, ...cards];
  if (all.length > CARDS_MAX) notes.push(`${all.length - CARDS_MAX} more cards are not listed.`);
  return { cards: all.slice(0, CARDS_MAX), notes: notes.map((n) => cardText(n, root)) };
}
