/**
 * R10 (H167): the journey's first screens in the terminal Workbench, after the operator's UI review of 2026-10-22 ("walls of
 * text, diagnostics up front, no obvious next action"), from his reference layouts 01 and 13 (Home) and 02 and 11 (Chat):
 *
 *   the header     TIMMY · the project · the route the next chat turn takes (its model, where it runs, its price; FAKE when
 *                  the model says it is) · what runs and what waits on you; then the ten tabs on one row, the active one amber
 *   Home           recent work (the project's newest runs, chat turns, observations, results and what waits on you, a glyph and
 *                  a few words each, the newest first) beside the selected item: what it is, how it ended, its receipt, and
 *                  where Enter and c open it; the connections as one word each
 *   the inspector  everything technical (ids, receipts' hashes, addresses, ports, paths, commands, the build) is said in
 *                  Context's Inspector ([i]), never on these screens
 *
 * The data comes from what the Workbench already reads (src/workbench/state.ts, the workspace frame) through the small functions
 * below (routeLine, recentWork, openOf): H164's src/journey (routeNow, recentWork, openTarget) replaces them once it is merged.
 * Words follow what Timmy observed: a state is its record's word, a receipt is "verified" only where this Workbench verified it,
 * and a value no record holds is unknown. Pure: the same data and state always draw the same rows.
 */
import { tabOf, type TabId, type WorkspaceConnection } from '../contracts/workspace.js';
import { sameFolder } from '../project/index.js';
import { boxOf, type Glyphs } from './frame.js';
import { chatTurnNow, connectionMark, frameTabs, unfinishedMark } from './hub.js';
export { plainWords } from './hub.js';
import type { Data, Item, TurnRow, Ui, View } from './model.js';
import type { WorkspaceId } from './nav.js';
import type { FileRow, JobRow, RecordRow } from './state.js';
import { clock, count, cut, fit, lineCells, took, wrapSegs, type Line, type Role, type Seg } from './text.js';

const S = (text: string, role: Role = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Seg => ({ text, role, ...o });
const blank: Line = [];
const key = (k: string): Seg => S(`[${k}]`, 'action');
const heading = (text: string): Line => [S(text.toUpperCase(), 'secondary', { bold: true })];

/** What the journey's views need of the Workbench's context (src/workbench/views.ts ViewCtx). */
export interface JourneyCtx { ui: Ui; data: Data; g: Glyphs; width: number; height: number; now: number; can: { chat: boolean; chatWhy?: string } }

// ── the route the next chat turn takes ─────────────────────────────────────────

/** The route the next chat turn takes, in the header's words: its model, where it runs and its price (H164's routeNow replaces
 *  this once merged; until then it is read from the one route every surface reads, src/workbench/state.ts readRoute, or the open
 *  chat session's own). */
export interface RouteLine {
  /** the model, as the route names it; null: none is chosen */
  model: string | null;
  /** where it runs, in words */
  where: string;
  /** its price as declared, or unknown */
  price: string;
  /** the model (or its provider) says it is FAKE: no model behind it */
  fake: boolean;
  /** a message would be sent on it now */
  ready: boolean;
  /** why not, in a few words, when it is not ready */
  why?: string;
  /** the route's own words, whole (the inspector shows them) */
  words: string;
}

export function routeLine(data: Pick<Data, 'route' | 'chatRoute'>): RouteLine {
  const r = data.chatRoute ?? data.route;
  const words = r.words.replace(/^chat:\s*/, '');
  // a FAKE model or a test's FIXTURE route says so in its words: it is named FAKE on screen
  const fake = /\b(?:fake|fixture)\b/i.test(r.words);
  const base = { fake, ready: r.ready, words: r.words };
  if (r.kind === 'local') {
    if (/no model chosen/.test(words)) return { ...base, model: null, where: 'Ollama on this computer', price: 'no charge', why: 'no local model chosen yet' };
    if (/address is not usable/.test(words)) return { ...base, model: null, where: 'Ollama', price: 'unknown', why: 'the Ollama address is not usable' };
    const m = /^(?:local\s+)?(\S+)\s+·\s+(.*)$/.exec(words);
    // words in no shape the route's own make (a test's FIXTURE route): the words are the model, said as they are
    const model = m ? m[1] : words.trim() || null;
    const rest = m ? m[2] : '';
    const cloud = /cloud-backed/.test(rest);
    const away = /not this computer/.test(rest);
    const where = cloud ? 'Ollama, cloud-backed (leaves this computer)' : away ? 'Ollama on another computer' : m ? 'this computer (Ollama)' : 'the local route';
    const price = cloud ? 'cost unknown' : away ? 'price unknown' : m ? 'no charge' : 'price unknown';
    return { ...base, model, where, price, ...(r.ready ? {} : { why: 'the local route is not ready' }) };
  }
  if (r.kind === 'openrouter') {
    const m = /^(\S+)\s+·\s+OpenRouter/.exec(words);
    const model = m ? m[1] : null;
    const free = /free-only/.test(words);
    const price = model && /:free$/.test(model) ? 'free (as OpenRouter lists it)' : free ? 'free models only' : 'price as OpenRouter lists it (not read here)';
    return { ...base, model, where: 'OpenRouter (cloud)', price, ...(r.ready ? {} : { why: free ? 'free-only refuses this model' : 'not ready' }) };
  }
  return { ...base, model: null, where: 'no route', price: 'unknown', why: /no model key/.test(words) ? 'no model key and no local model' : 'not set up' };
}

/** The route as one line of segments: "qwen3:8b · this computer (Ollama) · no charge", FAKE first when it is. */
export function routeSegs(rt: RouteLine, g: Glyphs, o: { label?: boolean } = {}): Seg[] {
  const sep = S(` ${g.sep} `, 'secondary');
  const lead: Seg[] = o.label === false ? [] : [S('next turn: ', 'secondary')];
  if (!rt.model) return [...lead, S(rt.why ?? 'not set up', 'attention'), ...(rt.where !== 'no route' ? [sep, S(rt.where, 'secondary')] : [])];
  return [
    ...lead, ...(rt.fake ? [S('FAKE ', 'attention', { bold: true })] : []), S(rt.model, 'strong'), sep, S(rt.where, 'text'), sep, S(rt.price, 'secondary'),
    ...(rt.ready ? [] : [sep, S(`not ready: ${rt.why ?? 'not set up'}`, 'attention')]),
  ];
}

// ── what runs and what waits on you ────────────────────────────────────────────

/** What runs now (the jobs and a chat turn being answered) and what waits on you, as the header and Home say it. */
export function runsAndWaits(data: Data, g: Glyphs): { running: number; waiting: number; line: Line } {
  const turn = chatTurnNow(data);
  const running = data.activity.running + (turn ? 1 : 0);
  const waiting = data.decisions.total;
  const sep = S(` ${g.sep} `, 'secondary');
  const run: Seg = running ? S(`${g.run} ${running} running${turn ? (running > 1 ? ' (1 a chat turn)' : ' (a chat turn)') : ''}`, 'text') : S('nothing runs', 'secondary');
  const wait: Seg[] = waiting ? [S(`${g.warn} ${waiting} waiting on you`, 'attention', { bold: true })] : [S('nothing waits on you', 'secondary')];
  return { running, waiting, line: [run, sep, ...wait] };
}

// ── the header ─────────────────────────────────────────────────────────────────

export interface HeaderHit { x0: number; x1: number; y0: number; y1: number; page: TabId }

/**
 * The header as two rows of exactly `width` cells: TIMMY, the project, the route of the next turn, and what runs and waits (the
 * status row); then the ten tabs on one row, the active one amber in brackets, ⚠ and a count where something waits, ◌ on an
 * unfinished tab. Labels are the frame's: whole where they fit, else their first words, else their keys. Every tab keeps its
 * place whichever is active (the brackets are drawn as spaces on the others).
 */
export function headerRows(data: Data, page: TabId, width: number, g: Glyphs): { lines: Line[]; hits: HeaderHit[] } {
  const tabs = frameTabs(data.frame);
  const sep = S(` ${g.sep} `, 'secondary');
  // the status row: what is kept whole first is what runs and waits; the route is cut at a word where the row is short
  const rw = runsAndWaits(data, g);
  const brand: Line = [S('TIMMY', 'strong', { bold: true }), sep, S(data.project.name, 'strong')];
  const right = rw.line;
  const room = Math.max(0, width - lineCells(brand) - lineCells(right) - 4);
  const route = fit(routeSegs(routeLine(data), g), room, g.ellipsis);
  const status: Line = [...brand, S('   '), ...route, S(' '), ...right];
  const pad = Math.max(0, width - lineCells(status));
  const statusRow = fit([...brand, S('   '), ...route, S(' '.repeat(pad + 1)), ...right], width, g.ellipsis);
  // the tabs: full labels, else short ones, else keys (the active tab's name then in a slot of its own at the row's end); each
  // cell is [label] on the active tab and  label  on the others, so no tab moves when another is active; "◌ unfinished" says
  // the mark in words, kept before a fuller form of the labels
  const forms: Array<{ label: (t: (typeof tabs)[number]) => string; slot: boolean }> = [
    { label: (t) => `${t.key} ${t.label}`, slot: false },
    { label: (t) => `${t.key} ${t.label.split(/\s+/)[0]}`, slot: false },
    { label: (t) => t.key, slot: true },
  ];
  // every cell keeps one cell for its mark (⚠ something waits there, ◌ unfinished), so nothing moves when something starts to
  // wait (the QA round's defect 4); the count is the status row's
  const mark = (t: (typeof tabs)[number]): string => (t.waiting > 0 ? g.warn : t.unfinished ? unfinishedMark(g) : ' ');
  const cellOf = (t: (typeof tabs)[number], f: (t: (typeof tabs)[number]) => string): number => lineCells([S(`[${f(t)}]`)]) + 1;
  const legend = tabs.some((t) => t.unfinished) ? `${unfinishedMark(g)} unfinished` : '';
  const slotW = Math.max(...tabs.map((t) => lineCells([S(t.label)])));
  let form = forms[forms.length - 1];
  let gap = 1;
  let withLegend = false;
  // the fullest labels that fit come first; the legend is said where it fits beside them
  choose: for (const f of forms) {
    for (const want of legend ? [true, false] : [false]) {
      const used = tabs.reduce((n, t) => n + cellOf(t, f.label), 0) + (f.slot ? Math.min(slotW, 16) + 2 : 0) + (want ? lineCells([S(legend)]) + 2 : 0);
      for (const gp of [2, 1]) if (used + gp * (tabs.length - 1) <= width) { form = f; gap = gp; withLegend = want; break choose; }
    }
  }
  const row: Line = [];
  const hits: HeaderHit[] = [];
  let x = 0;
  tabs.forEach((t, i) => {
    const on = t.id === page;
    const label = form.label(t);
    const m = mark(t);
    const segs: Seg[] = on
      ? [S('[', 'focus', { bold: true }), S(label, 'focus', { bold: true }), S(']', 'focus', { bold: true })]
      : [S(' '), S(label, 'text'), S(' ')];
    segs.push(S(m, t.waiting > 0 ? 'attention' : 'secondary'));
    const w = lineCells(segs);
    hits.push({ x0: x, x1: x + w - 1, y0: 1, y1: 1, page: t.id });
    row.push(...segs);
    x += w;
    if (i < tabs.length - 1) { row.push(S(' '.repeat(gap))); x += gap; }
  });
  const tail: Line = [
    ...(withLegend ? [S(legend, 'secondary')] : []),
    ...(form.slot ? [S(withLegend ? '  ' : ''), S(cut(tabs.find((t) => t.id === page)?.label ?? '', Math.min(slotW, 16), g.ellipsis), 'focus', { bold: true })] : []),
  ];
  const tabsRow = tail.length && x + 2 + lineCells(tail) <= width ? fit([...row, S(' '.repeat(width - x - lineCells(tail))), ...tail], width, g.ellipsis) : fit(row, width, g.ellipsis);
  return { lines: [statusRow, tabsRow], hits };
}

// ── recent work ────────────────────────────────────────────────────────────────

/** Where a work item opens: a tab of this Workbench (the list it selects there), and the companion's page for it. */
export interface OpenTarget {
  /** the tab Enter opens */
  page: TabId;
  /** the workspace of that tab, when not its first */
  ws?: WorkspaceId;
  /** the list there and the item to select in it (by its key) */
  select?: { list: string; key: string };
  /** what Enter does, in words */
  words: string;
  /** the companion's address parameters for it (c): tab=…&run=… */
  companion: string;
  /** what the companion draws of it, in words */
  companionWords: string;
  /** Enter shows it in the companion (an image or a mesh: a terminal cannot draw it), not in a tab here */
  show?: boolean;
}

/** One item of recent work (H164's recentWork replaces the reading once merged: kind, id, title, time, state, where it opens). */
export interface WorkItem {
  kind: 'run' | 'turn' | 'observation' | 'result' | 'waiting';
  /** stable: what it is (a job, a receipt, a record, a file, a waiting item) */
  id: string;
  title: string;
  /** its record's word: completed, failed, answered, ok, waits on you */
  state: string;
  tone: 'ok' | 'failed' | 'running' | 'waiting' | 'quiet';
  /** when (ms since the epoch); NaN: not recorded */
  at: number;
  /** a few facts, in words (no id, hash, path or command) */
  facts: string[];
  /** its receipt: sealed (a record names it) and whether this Workbench verified it now */
  receipt?: { sealed: boolean; verified?: boolean };
  /** the operation it belongs to (the inspector names it) */
  operation?: string;
  /** what the inspector says of it: its ids, hashes and paths */
  detail: Array<[string, string]>;
  opens: OpenTarget;
}

const KIND_WORD: Readonly<Record<WorkItem['kind'], string>> = { run: 'run', turn: 'chat', observation: 'VoxVision', result: 'result', waiting: 'needs you' };

const SURFACE_WORDS: Readonly<Record<string, string>> = { repl: 'the REPL', monitor: 'the monitor', workbench: 'the Workbench', companion: 'the companion' };

/** A file's name without its folders (an artifact's name; its path is the inspector's). */
const base = (rel: string): string => rel.split('/').pop() ?? rel;

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const MESH = /\.(stl|obj|ply)$/i;

const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

function runItem(j: JobRow, data: Data): WorkItem {
  const tone: WorkItem['tone'] = j.live ? 'running' : j.mark === 'failed' ? 'failed' : j.mark === 'ok' ? 'ok' : 'quiet';
  const block = /^(.+?) › (.+)$/.exec(j.label);
  const doc = block ? data.workflows.docs.find((d) => d.rel === block[1]) : undefined;
  const b = doc && block ? doc.blocks.find((x) => x.name === block[2]) : undefined;
  const steps = j.steps?.length ? `${j.steps.filter((s) => s.state === 'completed').length} of ${j.steps.length} step${j.steps.length === 1 ? '' : 's'}` : '';
  const verified = data.pipeline?.kind === 'job' && data.pipeline.operation && data.pipeline.operation === j.operation ? data.pipeline.receipt.verified : undefined;
  const away = !sameFolder(j.root, data.project.root);
  return {
    kind: 'run', id: j.id, title: doc?.title && block ? `${doc.title} › ${block[2]}` : j.label, state: j.live ? 'running' : j.word, tone,
    at: Date.parse(j.endedAt ?? j.startedAt),
    facts: [steps, j.live ? `running for ${j.elapsed}` : `took ${j.elapsed}`, away ? `in ${j.project}` : ''].filter(Boolean),
    ...(j.receipt ? { receipt: { sealed: true, ...(verified !== undefined ? { verified } : {}) } } : {}),
    ...(j.operation ? { operation: j.operation } : {}),
    detail: [['Job', j.id], ['What', j.label], ['Operation', j.operation ?? 'none'], ['Receipt', j.receipt ?? 'none sealed'], ['Started', j.startedAt], ['Outcome', j.outcome.words], ...(j.why ? [['Why', j.why] as [string, string]] : [])],
    opens: {
      page: 'workflows', ...(doc && b ? { select: { list: 'center:workflows', key: `block:${doc.rel}:${b.key}` } } : {}),
      words: 'opens its progress, result and receipt in 3 Workflows',
      companion: `tab=workflows${j.operation ? `&run=${j.operation}` : ''}`, companionWords: 'its source, changes, outputs and receipts, drawn',
    },
  };
}

function turnItem(t: TurnRow, data: Data): WorkItem {
  const tone: WorkItem['tone'] = t.state === 'failed' ? 'failed' : t.state === 'answered' ? 'ok' : 'quiet';
  const where = SURFACE_WORDS[t.surface] ?? t.surface;
  // verified only where this Workbench verified it: the newest operation's receipt, which the Chat tab's pipeline row checks
  const verified = data.pipeline?.kind === 'chat' && !data.pipeline.live && data.pipeline.operation && data.pipeline.operation === t.operation ? data.pipeline.receipt.verified : undefined;
  return {
    kind: 'turn', id: t.receipt, title: `Chat turn in ${where}`, state: t.state, tone, at: Date.parse(t.at),
    facts: [t.model ?? 'model not recorded', t.local === true ? 'this computer' : t.local === false ? 'another computer' : '', t.ms !== undefined ? took(t.ms) : ''].filter(Boolean),
    receipt: { sealed: true, ...(verified !== undefined ? { verified } : {}) },
    ...(t.operation ? { operation: t.operation } : {}),
    detail: [['Receipt', t.receipt], ['Turn', t.turn ?? 'not recorded'], ['Operation', t.operation ?? 'none'], ['Surface', t.surface], ['Model', t.model ?? 'not recorded'], ['Sealed', t.at]],
    opens: { page: 'chat', words: 'opens the conversation in 2 Chat', companion: 'tab=chat', companionWords: 'this project\'s turns, each as its receipt' },
  };
}

function observationItem(r: RecordRow): WorkItem {
  const ok = /^(ok|done|succeeded)$/i.test(r.state);
  return {
    kind: 'observation', id: r.id, title: r.what.replace(/(\S+\/)+(\S+)/g, '$2'), state: r.state, tone: ok ? 'ok' : /fail|error/i.test(r.state) ? 'failed' : 'quiet',
    at: Date.parse(r.at), facts: ['measured over the image'],
    ...(r.operation ? { operation: r.operation } : {}),
    detail: [['Record', r.id], ['File', r.record], ['What', r.what], ['Operation', r.operation ?? 'none'], ['Made', r.at]],
    opens: {
      page: 'voxvision', select: { list: 'center:voxvision', key: `vox:${r.id}` }, words: 'opens it in 5 VoxVision',
      companion: `tab=voxvision&vox=${r.id}`, companionWords: 'the image with what was measured over it, drawn',
    },
  };
}

function resultItem(f: FileRow): WorkItem {
  const image = IMAGE.test(f.rel);
  const mesh = MESH.test(f.rel);
  const what = image ? 'image' : mesh ? 'mesh' : DOCUMENT.test(f.rel) ? 'document' : f.kind === 'reference' ? 'reference' : 'result';
  // a terminal draws no image and no mesh: those open where they are drawn (the companion); a text result opens in Files
  const opens: OpenTarget = mesh
    ? { page: 'create', select: { list: 'center:create3d', key: `mesh:${f.rel}` }, words: 'shows it in the companion: the mesh in a view you can turn', companion: `tab=create&mesh=${hex(f.rel)}`, companionWords: 'the mesh in a view you can turn', show: true }
    : image
      ? { page: 'logs', ws: 'files', select: { list: 'center:files', key: `file:${f.rel}` }, words: 'shows it in the companion: the image, drawn', companion: 'tab=home', companionWords: 'the newest images, drawn', show: true }
      : { page: 'logs', ws: 'files', select: { list: 'center:files', key: `file:${f.rel}` }, words: 'opens it in Files (0 Logs & Receipts)', companion: 'tab=logs', companionWords: 'this project\'s records' };
  return {
    kind: 'result', id: f.rel, title: base(f.rel), state: what, tone: 'quiet', at: f.mtimeMs, facts: [what, humanBytes(f.bytes)],
    detail: [['Path', f.rel], ['Kind', f.kind], ['Size', `${f.bytes} bytes`], ['Changed', new Date(f.mtimeMs).toISOString()]],
    opens,
  };
}

const humanBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

function waitingItem(d: Data['decisions']['items'][number], at: number): WorkItem {
  const draft = d.key.startsWith('draft:');
  return {
    kind: 'waiting', id: d.key, title: d.title, state: 'waits on you', tone: 'waiting', at, facts: [d.needed],
    ...(d.operation ? { operation: d.operation } : {}),
    detail: [['Kind', d.kind], ['Why', d.why], ...(d.record ? [['Record', d.record] as [string, string]] : []), ...(d.commands.length ? [['Commands', d.commands.join(' ; ')] as [string, string]] : [])],
    opens: draft
      ? { page: 'studio', words: 'opens 4 Studio, where Accept or Discard is', companion: 'tab=studio', companionWords: 'the board and its draft' }
      : { page: 'control', words: 'opens 7 Control Room, where you answer it', companion: 'tab=control', companionWords: 'what waits, read-only' },
  };
}

/**
 * The project's recent work, the newest first: what waits on you first (it is the next step), then its runs, chat turns,
 * VoxVision observations and the results and references it holds, at most `limit`. Timmy's own logs and a run's own records
 * are not work (they are the inspector's and tab 0's).
 */
export function recentWork(data: Data, limit = 30, now = Date.now()): WorkItem[] {
  const waiting = data.decisions.items.map((d) => waitingItem(d, now));
  const vox = data.vox.map(observationItem);
  // a run that made an observation is said by the observation (its record, its image and what was measured over it)
  const observed = new Set(data.vox.map((r) => r.operation).filter(Boolean));
  const runs = data.jobs.filter((j) => !(j.operation && observed.has(j.operation))).map((j) => runItem(j, data));
  const turns = (data.turns ?? []).map((t) => turnItem(t, data));
  // the artifacts: images, meshes and documents a run wrote or the project holds (an observation's own files are its record's;
  // data files, recordings and Timmy's records are tab 0's), the newest few
  const files = data.files.groups.filter((gr) => gr.kind === 'results' || gr.kind === 'reference').flatMap((gr) => gr.files)
    .filter((f) => !/(^|\/)vox\//.test(f.rel) && (IMAGE.test(f.rel) || MESH.test(f.rel) || (gr(f) === 'results' && DOCUMENT.test(f.rel))))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  // one mesh in several formats (demo-tray.stl, .obj, .ply) is one item, opened on its first format, STL first
  const meshes = new Map<string, FileRow[]>();
  for (const f of files.filter((x) => MESH.test(x.rel))) {
    const stem = f.rel.replace(MESH, '');
    meshes.set(stem, [...(meshes.get(stem) ?? []), f]);
  }
  const order = ['.stl', '.obj', '.ply'];
  const artifacts = files.filter((f) => !MESH.test(f.rel) || meshes.get(f.rel.replace(MESH, ''))?.[0] === f).slice(0, ARTIFACTS).map((f) => {
    const same = MESH.test(f.rel) ? [...(meshes.get(f.rel.replace(MESH, '')) ?? [f])].sort((a, b) => order.indexOf(ext(a.rel)) - order.indexOf(ext(b.rel))) : [f];
    const item = resultItem(same[0]);
    return same.length > 1 ? { ...item, title: `${base(same[0].rel)} ${same.slice(1).map((x) => `${CHOICE} ${ext(x.rel).slice(1)}`).join(' ')}`, facts: [`a mesh in ${same.length} formats`, ...item.facts.slice(1)] } : item;
  });
  const at = (w: WorkItem): number => (Number.isFinite(w.at) ? w.at : 0);
  // the newest first; at the same moment, what ran before what it wrote
  const rest = [...runs, ...turns, ...vox, ...artifacts].sort((a, b) => at(b) - at(a) || RANK[a.kind] - RANK[b.kind]);
  return [...waiting, ...rest].slice(0, limit);
}

const ext = (rel: string): string => (/\.[^./]+$/.exec(rel)?.[0] ?? '').toLowerCase();
const CHOICE = '·';

/** How many artifacts recent work lists (the newest). */
const ARTIFACTS = 6;
const DOCUMENT = /\.(md|html?|pdf|txt|csv)$/i;
const gr = (f: FileRow): FileRow['kind'] => f.kind;
const RANK: Readonly<Record<WorkItem['kind'], number>> = { waiting: 0, run: 1, turn: 2, observation: 3, result: 4 };

/** A work item as the Workbench's selectable item. */
export const workItem = (w: WorkItem): Item => ({ kind: 'work', key: `work:${w.kind}:${w.id}`, work: w });

// ── Home ───────────────────────────────────────────────────────────────────────

const ago = (t: number, now: number): string => {
  if (!Number.isFinite(t)) return 'time unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

/** A work item's glyph and its role (its state's word is always beside it). */
export function workMark(w: Pick<WorkItem, 'tone' | 'kind'>, g: Glyphs): { glyph: string; role: Role } {
  switch (w.tone) {
    case 'ok': return { glyph: g.ok, role: 'text' };
    case 'failed': return { glyph: g.fail, role: 'failure' };
    case 'running': return { glyph: g.run, role: 'text' };
    case 'waiting': return { glyph: g.warn, role: 'attention' };
    default: return { glyph: w.kind === 'result' ? (g.unicode ? '◇' : '*') : g.dot, role: 'secondary' };
  }
}

/** One row of recent work: the selection's marker, its glyph, its title, its kind and state, and when. */
function workRow(w: WorkItem, selected: boolean, focused: boolean, width: number, c: JourneyCtx): Line {
  const g = c.g;
  const m = workMark(w, g);
  const when = ago(w.at, c.now);
  const kind = `${KIND_WORD[w.kind]} ${g.sep} ${w.state}`;
  const right: Seg[] = [S(kind.padEnd(Math.min(24, kind.length)), 'secondary'), S('  '), S(when.padStart(11), 'secondary')];
  const lead: Seg[] = [S(selected ? `${g.cursor} ` : '  ', selected && focused ? 'accent' : 'secondary'), S(`${m.glyph} `, m.role)];
  const room = Math.max(6, width - lineCells(lead) - lineCells(right) - 2);
  const title = cut(w.title, room, g.ellipsis);
  const line: Line = [...lead, S(title, selected ? 'strong' : 'text'), S(' '.repeat(Math.max(2, width - lineCells(lead) - lineCells([S(title)]) - lineCells(right))))];
  if (lineCells([...line, ...right]) > width) return fit([...lead, S(cut(w.title, Math.max(4, width - lineCells(lead) - 12), g.ellipsis), 'text'), S('  '), S(when, 'secondary')], width, g.ellipsis).map((s) => (selected ? { ...s, selected: true } : s));
  return [...line, ...right].map((s) => (selected ? { ...s, selected: true } : s));
}

/** Home's left column: the project's recent work, the newest first; Enter opens the selected item where it belongs. */
export function homeWorkView(c: JourneyCtx): View {
  const items: View['items'] = [];
  const work = recentWork(c.data, HOME_WORK, c.now);
  const conns = c.data.frame?.connections ?? [];
  const lines: Line[] = [];
  const all = homeItems(c);
  const cur = all.length ? Math.max(0, Math.min(all.length - 1, c.ui.cursor['center:connections'] ?? 0)) : -1;
  const focused = c.ui.focus === 'center';
  if (!work.length) {
    lines.push([S('  Nothing here yet', 'strong')]);
    lines.push(...wrapSegs([S('  This project has no run, chat turn or result. '), S('Enter', 'action'), S(' on the next step above types your first message; '), S('3', 'action'), S(' Workflows runs a block; '), S('n', 'action'), S(' starts a project from a starter.')], Math.max(10, c.width), '  '));
  }
  work.forEach((w, i) => {
    items.push({ line: lines.length, item: workItem(w) });
    lines.push(workRow(w, i === cur, focused, c.width, c));
  });
  // the connections, a row each (its mark and word; its words, its step and its address are the selected item's and the
  // details'): Enter on one does its step, as the cards did (R5 H131)
  lines.push(blank, [S('CONNECTIONS', 'secondary', { bold: true }), S(`  ${c.g.sep} as last observed; live: an answer seen in the last 30 minutes`, 'secondary')]);
  if (!c.data.frame) lines.push([S(c.data.frameError ? `  not read: ${c.data.frameError}` : '  reading…', c.data.frameError ? 'failure' : 'secondary')]);
  conns.forEach((conn, k) => {
    const i = work.length + k;
    items.push({ line: lines.length, item: { kind: 'conn', key: `conn:${conn.id}`, conn } });
    const row = connectionRow(conn, c, i === cur, focused);
    lines.push(i === cur ? row.map((x) => ({ ...x, selected: true })) : row);
  });
  return { lines, items };
}

/** How many items of recent work Home lists (the newest). */
const HOME_WORK = 12;

/** Home's list: recent work, then the connections, in the order drawn. */
export function homeItems(c: Pick<JourneyCtx, 'data' | 'now'>): Item[] {
  return [...recentWork(c.data, HOME_WORK, c.now).map(workItem), ...(c.data.frame?.connections ?? []).map((conn): Item => ({ kind: 'conn', key: `conn:${conn.id}`, conn }))];
}

/** Home's selected item (an item of recent work or a connection), or the first. */
export function selectedHome(c: Pick<JourneyCtx, 'ui' | 'data' | 'now'>): Item | null {
  const all = homeItems(c);
  if (!all.length) return null;
  return all[Math.max(0, Math.min(all.length - 1, c.ui.cursor['center:connections'] ?? 0))];
}

/** The selected work item, or null where the selection is a connection. */
export function selectedWork(c: Pick<JourneyCtx, 'ui' | 'data' | 'now'>): WorkItem | null {
  const it = selectedHome(c);
  return it?.kind === 'work' ? it.work : null;
}

/** A connection's words with its address said by what it is (the details say it whole). */
const noAddress = (words: string): string => words.replace(/\bhttps?:\/\/[^\s,;)]+/g, 'its address').replace(/\b\d{1,3}(?:\.\d{1,3}){3}:\d+\b/g, 'its address').replace(/~?\/[\w./-]+\/[\w.-]+/g, 'its file');

/** The name a connection goes by on Home's rows. */
const connName = (conn: WorkspaceConnection): string => (conn.id === 'openrouter' ? 'OpenRouter' : conn.id === 'ollama' ? 'Ollama' : conn.id === 'companion' ? 'Companion' : conn.id === 'studio' ? 'Studio' : conn.id === 'cloudflare' ? 'Cloudflare' : conn.label.replace(/\s*\(.*\)$/, ''));

/** Home's right column: the selected item (what it is, how it ended, its receipt, where it opens; a connection's words and its
 *  step), then the project. Ids, hashes, addresses and commands are the details' ([i]). */
export function homeSideView(c: JourneyCtx, step?: (conn: WorkspaceConnection) => string | null): View {
  const { data, g, width } = c;
  const lines: Line[] = [];
  const it = selectedHome(c);
  const sep = ` ${g.sep} `;
  if (it?.kind === 'work') {
    const w = it.work;
    const m = workMark(w, g);
    lines.push([S(KIND_WORD[w.kind].toUpperCase(), 'secondary', { bold: true }), S(sep, 'secondary'), S(`${m.glyph} ${w.state}`, m.role === 'secondary' ? 'text' : m.role, { bold: true })]);
    lines.push(...wrapSegs([S(w.title, 'strong')], width, '  '));
    lines.push(...wrapSegs([S(`${ago(w.at, c.now)}${w.facts.length ? `${sep}${w.facts.join(sep)}` : ''}`, 'secondary')], width, '  '));
    if (w.receipt) {
      lines.push(blank);
      lines.push(w.receipt.verified === true
        ? [S('Receipt  ', 'secondary'), S(`${g.ok} sealed and verified`, 'live')]
        : w.receipt.verified === false
          ? [S('Receipt  ', 'secondary'), S(`${g.fail} sealed, does not verify`, 'failure')]
          : [S('Receipt  ', 'secondary'), S('sealed', 'text'), S(' · not verified on this screen', 'secondary')]);
    }
    lines.push(blank);
    lines.push(...wrapSegs([key('Enter'), S(` ${w.opens.words}`, 'text')], width, '        '));
    if (!w.opens.show) lines.push(...wrapSegs([key('c'), S(`     the companion: ${w.opens.companionWords}`, 'text')], width, '        '));
    lines.push(...wrapSegs([key('i'), S(`     details: ${w.receipt ? 'ids, its receipt, files' : 'its file, size, time'}`, 'secondary')], width, '        '));
  } else if (it?.kind === 'conn') {
    const conn = it.conn;
    const m = connectionMark(conn.state, g);
    lines.push([S('CONNECTION', 'secondary', { bold: true }), S(sep, 'secondary'), S(m.text, m.role, { bold: true })]);
    lines.push(...wrapSegs([S(conn.label, 'strong')], width, '  '));
    lines.push(...wrapSegs([S(noAddress(conn.words), conn.state === 'unreachable' || conn.state === 'refused' ? 'failure' : 'text')], width, '  '));
    if (conn.observedAt) lines.push([S(`observed ${clock(conn.observedAt)}`, 'secondary')]);
    lines.push(blank);
    const does = step?.(conn) ?? null;
    if (does) lines.push(...wrapSegs([key('Enter'), S(` ${does}`, 'text')], width, '        '));
    lines.push(...wrapSegs([key('i'), S('     details: its address, its step, what was observed', 'secondary')], width, '        '));
  } else {
    lines.push(heading('Nothing selected'), [S('Recent work is empty: the next step above starts it.', 'secondary')]);
  }
  lines.push(blank, heading('Project'));
  const files = data.files.total - (data.files.timmyLogs ?? 0);
  const docs = data.workflows.docs.length;
  lines.push(...wrapSegs([S(`${count(files, 'file')}${sep}${count(docs, 'workflow document')}${sep}${count(data.jobs.length, 'run')}`, 'text')], width, '  '));
  // R5 (H131; the QA round's defect 24): Timmy's own logs (logs/*.log, written where it runs) are not the project's files
  if (data.files.timmyLogs) lines.push(...wrapSegs([S(`not counted: ${count(data.files.timmyLogs, 'log')} Timmy writes itself (logs/*.log)`, 'secondary')], width, '  '));
  return { lines, items: [] };
}

/** A connection as one row: the selection's marker, its name, its state's mark and word (green only for an observed answer)
 *  and when it was observed; no address. */
function connectionRow(conn: WorkspaceConnection, c: Pick<JourneyCtx, 'g' | 'ui'>, selected = false, focused = false): Line {
  const m = connectionMark(conn.state, c.g);
  const s = conn.id === 'companion' ? c.ui.companion : conn.id === 'studio' ? c.ui.studio : null;
  const extra = s?.serving ? 'served here' : s?.other ? 'served by another Timmy' : conn.state === 'configured' ? 'not checked yet' : conn.observedAt ? `checked ${clock(conn.observedAt).slice(0, 5)}` : '';
  return [S(selected ? `${c.g.cursor} ` : '  ', selected && focused ? 'accent' : 'secondary'), S(`${connName(conn).padEnd(Math.max(13, connName(conn).length + 2))}`, selected ? 'strong' : 'text'), S(m.text, m.role), S(extra ? `  ${c.g.sep} ${extra}` : '', 'secondary')];
}

// ── the inspector: details and the build ───────────────────────────────────────

/** The build's identity, as About says it (H163's src/build-info.ts replaces this once merged): the review's revision when the
 *  launcher sets it, else unknown. */
export function buildWords(env: Record<string, string | undefined> = process.env): Array<[string, string]> {
  const rev = env.TIMMY_REVIEW?.trim();
  return [
    ['Revision', rev ? rev : 'revision unknown'],
    ['Node', process.versions.node],
    ['Timmy home', env.TIMMY_HOME ? env.TIMMY_HOME.replace(/^\/(?:home|Users)\/[^/]+/, '~') : 'the default (~/timmy)'],
    ['Ports', [env.TIMMY_COMPANION_PORT ? `companion ${env.TIMMY_COMPANION_PORT}` : '', env.TIMMY_STUDIO_PORT ? `Studio ${env.TIMMY_STUDIO_PORT}` : '', env.TIMMY_LOGS_PORT ? `log ${env.TIMMY_LOGS_PORT}` : ''].filter(Boolean).join(', ') || 'the defaults'],
  ];
}

/** The rows the inspector shows for a work item (its ids, hashes and paths), then where it opens, in full. */
export function workDetail(w: WorkItem, width: number, g: Glyphs): Line[] {
  const out: Line[] = [heading(`${KIND_WORD[w.kind]} ${g.sep} details`)];
  for (const [k, v] of w.detail) out.push(...wrapSegs([S(`${k.padEnd(10)} `, 'secondary'), S(v, 'text')], width, ' '.repeat(11)));
  out.push(...wrapSegs([S(`${'Opens'.padEnd(10)} `, 'secondary'), S(`Enter ${w.opens.words}; c the companion (${w.opens.companion})`, 'text')], width, ' '.repeat(11)));
  return out;
}

/** About · Diagnostics: the build, the route in its own words, and each connection whole (its address and its step). */
export function diagnosticsLines(c: Pick<JourneyCtx, 'data' | 'g' | 'width'>, env: Record<string, string | undefined> = process.env): Line[] {
  const { data, g, width } = c;
  const out: Line[] = [heading('About · diagnostics')];
  for (const [k, v] of buildWords(env)) out.push(...wrapSegs([S(`${k.padEnd(10)} `, 'secondary'), S(v, 'text')], width, ' '.repeat(11)));
  out.push(...wrapSegs([S(`${'Route'.padEnd(10)} `, 'secondary'), S(routeLine(data).words, 'text')], width, ' '.repeat(11)));
  out.push(blank, heading('Connections, as observed'));
  for (const conn of data.frame?.connections ?? []) {
    const m = connectionMark(conn.state, g);
    out.push([S(conn.label, 'strong'), S(`  ${m.text}`, m.role)]);
    out.push(...wrapSegs([S(`  ${conn.words}`, 'text')], width, '    '));
    if (conn.detail) out.push(...wrapSegs([S(`  ${conn.detail}`, 'secondary')], width, '    '));
    if (conn.setup && conn.state !== 'live') out.push(...wrapSegs([S(`  ${g.arrow} `, 'secondary'), S(conn.setup, 'action')], width, '    '));
  }
  if (!data.frame) out.push([S('  the workspace frame is not read yet', 'secondary')]);
  return out;
}

/** The box drawn around a row of words (the composer's), `width` cells wide, light or heavy (focused). */
export function boxed(inner: Line[], width: number, g: Glyphs, o: { heavy?: boolean; title?: string; foot?: Line } = {}): Line[] {
  const b = boxOf(g, o.heavy === true);
  const edge: Role = o.heavy ? 'focus' : 'border';
  const room = Math.max(1, width - 4);
  const title = o.title ? ` ${o.title} ` : '';
  const top: Line = [S(`${b.tl}${b.h}`, edge), S(title, o.heavy ? 'focus' : 'secondary'), S(`${b.h.repeat(Math.max(0, width - 3 - lineCells([S(title)])))}${b.tr}`, edge)];
  const rows = inner.map((l): Line => [S(`${b.v} `, edge), ...fit(l, room, g.ellipsis), S(` ${b.v}`, edge)]);
  const foot = o.foot ? fit([S(' '), ...o.foot, S(' ')], Math.max(0, width - 3), g.ellipsis) : null;
  const bottom: Line = foot ? [S(b.bl, edge), ...foot.slice(0, foot.length), S(`${b.h.repeat(Math.max(0, width - 2 - lineCells(foot)))}${b.br}`, edge)] : [S(`${b.bl}${b.h.repeat(Math.max(0, width - 2))}${b.br}`, edge)];
  return [top, ...rows, bottom];
}

/** The tab a page key names, for the words of where something opens. */
export const tabWords = (page: TabId): string => `${tabOf(page).key} ${tabOf(page).label}`;
