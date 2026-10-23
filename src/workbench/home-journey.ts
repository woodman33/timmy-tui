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
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { tildePath } from '../utils/home-scrub.js';
import { connectionsPath } from '../ops/workspace-frame.js';
import { createItems } from './create-tab.js';
import { boxOf, type Glyphs } from './frame.js';
import { chatTurnNow, connectionMark, frameTabs, unfinishedMark } from './hub.js';
export { plainWords } from './hub.js';
import type { Data, Item, Ui, View } from './model.js';
import type { WorkspaceId } from './nav.js';
import type { JourneyRoute, WorkItem as JourneyWorkItem } from '../journey/index.js';
import type { BuildInfo } from '../build-info.js';
import { clock, count, cut, fit, lineCells, took, trimTo, wrapSegs, type Line, type Role, type Seg } from './text.js';

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
  /** R10 (H163; H168's N1): its price's long form where the face says it shorter ("no price declared (local)" beside "no
   *  charge · local"): the inspector's */
  priceWhole?: string;
}

/** R10 (H163; H168's N1, pass 2a): a local route's price, said one way wherever the face says it (the header, Chat's route row,
 *  the composer's foot, a turn's line and its notice); its long forms ("no price declared (local)", "no charge (local
 *  endpoint)") are the details' ([i]). A paid or unknown price keeps its own words. */
export const LOCAL_PRICE = 'no charge · local';

/** A turn's cost as the face says it: the session's "no charge (local endpoint)" is LOCAL_PRICE; any other its own words. */
export const costOnFace = (words: string | undefined): string => (words ?? '').replace(/^no charge \(local endpoint\)/, LOCAL_PRICE);

export function routeLine(data: Pick<Data, 'route' | 'chatRoute' | 'journeyRoute'>): RouteLine {
  // the one source (H164's routeNow), unless the open chat session reports another route than it read (a test's FIXTURE
  // session): the session's is the turn's then
  const j = data.journeyRoute;
  if (j && (!data.chatRoute || data.chatRoute.words === j.words)) return fromRouteNow(j);
  const r = data.chatRoute ?? data.route;
  const words = r.words.replace(/^chat:\s*/, '');
  // a FAKE model or a test's FIXTURE route says so in its words: it is named FAKE on screen
  const fake = /\b(?:fake|fixture)\b/i.test(r.words);
  const base = { fake, ready: r.ready, words: r.words };
  if (r.kind === 'local') {
    if (/no model chosen/.test(words)) return { ...base, model: null, where: 'Ollama on this computer', price: LOCAL_PRICE, priceWhole: 'no charge (local endpoint)', why: 'no local model chosen yet' };
    if (/address is not usable/.test(words)) return { ...base, model: null, where: 'Ollama', price: 'unknown', why: 'the Ollama address is not usable' };
    const m = /^(?:local\s+)?(\S+)\s+·\s+(.*)$/.exec(words);
    // words in no shape the route's own make (a test's FIXTURE route): the words are the model, said as they are
    const model = m ? m[1] : words.trim() || null;
    const rest = m ? m[2] : '';
    const cloud = /cloud-backed/.test(rest);
    const away = /not this computer/.test(rest);
    const where = cloud ? 'Ollama, cloud-backed (leaves this computer)' : away ? 'Ollama on another computer' : m ? 'this computer (Ollama)' : 'the local route';
    const price = cloud ? 'cost unknown' : away ? 'price unknown' : m ? LOCAL_PRICE : 'price unknown';
    return { ...base, model, where, price, ...(price === LOCAL_PRICE ? { priceWhole: 'no charge (local endpoint)' } : {}), ...(r.ready ? {} : { why: 'the local route is not ready' }) };
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

/** H164's route (src/journey routeNow) in the header's words: the model, where it runs, its price as declared (else what is
 *  known of it), FAKE when it is, and why it is not ready. */
export function fromRouteNow(j: JourneyRoute): RouteLine {
  const where = j.provider === 'none' || !j.where ? (j.provider === 'ollama' ? 'Ollama' : 'no route')
    : j.provider === 'ollama' ? (j.where === 'this computer' ? 'this computer (Ollama)' : j.where === 'cloud' ? 'Ollama, cloud-backed (leaves this computer)' : 'Ollama on another computer')
      : j.provider === 'openrouter' ? 'OpenRouter (cloud)' : j.where;
  // a price is said as declared; a local model's is not declared (its receipt says "no charge" once Ollama reports local
  // weights), and another's unknown
  // (R10 H163; H168's N1: a local one on this computer is said as every local price is, LOCAL_PRICE; its long form is [i]'s)
  const local = j.price.state !== 'declared' && j.provider === 'ollama' && j.where === 'this computer';
  const price = j.price.state === 'declared' ? (j.price.free ? 'free (declared)' : j.price.words)
    : local ? LOCAL_PRICE : j.provider === 'fake' ? 'no price (FAKE)' : 'price unknown';
  return {
    model: j.model, where, price, fake: j.fake, ready: j.ready, words: j.words, ...(local ? { priceWhole: 'no price declared (local)' } : {}),
    ...(j.ready ? {} : { why: j.why ?? 'not set up' }),
  };
}

/** The route as one line of segments: "qwen3:8b · this computer (Ollama) · no charge", FAKE first when it is. */
export function routeSegs(rt: RouteLine, g: Glyphs, o: { label?: boolean; short?: boolean } = {}): Seg[] {
  const sep = S(` ${g.sep} `, 'secondary');
  const lead: Seg[] = o.label === false ? [] : [S(o.short ? 'next: ' : 'next turn: ', 'secondary')];
  // R10 (H168's F8): the short form a narrow row takes before anything is cut ("next: FAKE fake-qwen3:8b · here · no price")
  const where = o.short ? shortWhere(rt.where) : rt.where;
  const price = o.short ? shortPrice(rt.price) : rt.price;
  if (!rt.model) return [...lead, S(rt.why ?? 'not set up', 'attention'), ...(rt.where !== 'no route' && where ? [sep, S(where, 'secondary')] : [])];
  return [
    ...lead, ...(rt.fake ? [S('FAKE ', 'attention', { bold: true })] : []), S(rt.model, 'strong'), ...(where ? [sep, S(where, 'text')] : []), sep, S(price, 'secondary'),
    ...(rt.ready ? [] : [sep, S(`not ready: ${rt.why ?? 'not set up'}`, 'attention')]),
  ];
}

/** Where a route runs, in a word (the short form). */
function shortWhere(where: string): string {
  if (/^this computer/.test(where)) return 'here';
  if (/cloud/.test(where)) return 'cloud';
  if (/another computer/.test(where)) return 'elsewhere';
  if (/local route/.test(where)) return 'local';
  return where === 'no route' ? '' : where;
}

/** A route's price, in a word or two (the short form): never a price no record declares. */
function shortPrice(price: string): string {
  if (/^free/.test(price)) return 'free';
  if (/^no price/.test(price)) return 'no price';
  return price;
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
  // R10 (H168's F8): the fullest words that fit whole, the route's short form and then the short state before anything is cut
  const rt = routeLine(data);
  const shortRight: Line = [S(rw.running ? `${g.run} ${rw.running} running` : 'idle', rw.running ? 'text' : 'secondary'), ...(rw.waiting ? [sep, S(`${g.warn} ${rw.waiting} waiting`, 'attention', { bold: true })] : [])];
  const says: Array<[Seg[], Line]> = [[routeSegs(rt, g), rw.line], [routeSegs(rt, g, { short: true }), rw.line], [routeSegs(rt, g, { short: true }), shortRight]];
  const chosen = says.find(([r, w]) => lineCells(brand) + 3 + lineCells(r) + 1 + lineCells(w) <= width) ?? says[says.length - 1];
  const right = chosen[1];
  const room = Math.max(0, width - lineCells(brand) - lineCells(right) - 4);
  const route = fit(chosen[0], room, g.ellipsis);
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
  // the legend first (R7 H150, the operator's order of 2026-10-16: a mark and a word), then the fullest labels that fit beside
  // it; without it only where not even the keys leave it room
  choose: for (const want of legend ? [true, false] : [false]) {
    for (const f of forms) {
      const used = tabs.reduce((n, t) => n + cellOf(t, f.label), 0) + (f.slot ? Math.min(slotW, 16) + 2 : 0) + (want ? lineCells([S(legend)]) + 2 : 0);
      // (a gap of 0 too: every cell ends in its mark's cell, a space where nothing is marked, as the boxed row's labels did)
      for (const gp of [2, 1, 0]) if (used + gp * (tabs.length - 1) <= width) { form = f; gap = gp; withLegend = want; break choose; }
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

/** Where a work item opens in this Workbench, and in the companion (H164's openTarget: its address's query). */
export interface OpenTarget {
  /** the tab Enter opens */
  page: TabId;
  /** the workspace of that tab, when not its first */
  ws?: WorkspaceId;
  /** the list there and the item to select in it (by its key) */
  select?: { list: string; key: string };
  /** what Enter does, in words */
  words: string;
  /** the companion's address parameters for it (c): tab=…&run=… (H164's openTarget query); '' when it opens in Studio */
  companion: string;
  /** what the companion (or Studio) draws of it, in words */
  companionWords: string;
  /** Enter shows it in the companion (an image or a mesh: a terminal cannot draw it), not in a tab here */
  show?: boolean;
  /** it opens in Studio (s), not the companion */
  studio?: boolean;
}

/** One item of Home's list: an item of the project's recent work (H164's src/journey recentWork), or what waits on you (the
 *  one waiting count's items, src/ops/waiting.ts), as Home draws it. */
export interface WorkItem {
  kind: 'run' | 'turn' | 'observation' | 'result' | 'reference' | 'mesh' | 'recording' | 'receipt' | 'draft' | 'card' | 'waiting';
  /** stable: what it is (an operation, a receipt, a record, a file, a draft, a waiting item) */
  id: string;
  title: string;
  /** its record's word: completed, failed, answered, saved, draft, waits on you */
  state: string;
  tone: 'ok' | 'failed' | 'running' | 'waiting' | 'stopped' | 'quiet';
  /** when (ms since the epoch); NaN: not recorded */
  at: number;
  /** a few facts, in words (no id, hash, path or command) */
  facts: string[];
  /** its receipt: sealed (a record names it) and whether it verifies here now (H164 verifies each one listed) */
  receipt?: { sealed: boolean; verified?: boolean; why?: string };
  /** a FAKE stand-in or FAKE content: said FAKE on the row */
  fake?: boolean;
  /** the operation it belongs to (the inspector names it) */
  operation?: string;
  /** what the inspector says of it: its ids, hashes and paths */
  detail: Array<[string, string]>;
  opens: OpenTarget;
  /** a run's results, as its receipts name them (project paths) */
  results?: string[];
}

const KIND_WORD: Readonly<Record<WorkItem['kind'], string>> = {
  run: 'run', turn: 'chat', observation: 'VoxVision', result: 'result', reference: 'reference', mesh: 'mesh', recording: 'recording',
  receipt: 'receipt', draft: 'draft', card: 'card', waiting: 'needs you',
};

/** A file's name without its folders (an artifact's name; its path is the inspector's). */
const base = (rel: string): string => rel.split('/').pop() ?? rel;

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** R10 (H167; H168's F7): what a file of the project is, by its kind of content, in a word (an image, a mesh's format, a
 *  recording, a document, a text), as Home's row says it beside the kind its record gives ("reference · image"). */
export function fileWhat(rel: string): string {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(rel)?.[1] ?? '').toLowerCase();
  if (IMAGE.test(rel)) return 'image';
  if (['stl', 'obj', 'ply', 'glb', 'gltf', 'usd', 'usda', 'usdz'].includes(ext)) return ext.toUpperCase();
  if (ext === 'step' || ext === 'stp') return 'STEP';
  if (ext === 'rrd') return 'recording';
  if (ext === 'md' || ext === 'markdown') return 'document';
  if (['txt', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'xml', 'html', 'py', 'ts', 'js', 'mjs', 'sh', 'scad'].includes(ext)) return 'text';
  return 'file';
}

const TONE: Readonly<Record<string, WorkItem['tone']>> = {
  answered: 'ok', completed: 'ok', saved: 'ok', sealed: 'ok', 'no change': 'ok',
  failed: 'failed', refused: 'failed', differs: 'failed', untrusted: 'failed', interrupted: 'failed',
  running: 'running', 'waiting on you': 'waiting', draft: 'waiting', 'needs setup': 'waiting',
  // R10 (H163; H168's N5): a stopped turn has the stop's own mark, as the conversation draws it (■), never a bare "·"
  stopped: 'stopped',
};

const WHERE_WORDS: Readonly<Record<string, string>> = { 'this computer': 'this computer', 'another computer': 'another computer', cloud: 'the cloud' };

/** H164's recent work item as Home's: its words, its receipt as verified here, where Enter opens it in this Workbench and
 *  where c opens it (the companion's address H164's openTarget gives). */
export function fromJourney(it: JourneyWorkItem, data: Pick<Data, 'jobs' | 'workflows'>): WorkItem {
  const kind = it.kind as WorkItem['kind'];
  const facts: string[] = [];
  if (it.kind === 'turn' && it.route) facts.push(...[it.route.answeredBy ?? it.route.requested ?? '', WHERE_WORDS[it.route.where] ?? ''].filter(Boolean));
  if (it.kind === 'run' && it.results?.length) facts.push(`${count(it.results.length, 'file')} written`);
  // (R10 H167; H168's F7: what the file is, by its content's kind, beside the kind its record gives: "reference · image")
  // (R10 H163; H168's N5: the kind said once: a recording is "recording", never "recording · recording")
  if (it.kind === 'mesh' || it.kind === 'recording' || it.kind === 'reference' || it.kind === 'result') { const what = fileWhat(it.id); if (what !== KIND_WORD[kind]) facts.push(what); }
  const companion = it.open.surface === 'companion' ? it.open.query : '';
  const studio = it.open.surface === 'studio';
  const opens = targetOf(it, data, companion, studio);
  const detail: Array<[string, string]> = [
    ['Kind', it.kind], ['Id', it.id], ['Operation', it.operation ?? 'none'],
    ['Receipt', it.receipt ? `${it.receipt.id} ${it.receipt.verified ? '(verified here now)' : `(does not verify: ${it.receipt.why ?? 'unknown'})`}` : 'none sealed'],
    ['When', it.when ? `${clock(it.when)} · ${new Date(it.when).toDateString()}` : 'not recorded'],
    ...(it.results?.length ? [['Results', it.results.join(', ')] as [string, string]] : []),
    ...(it.route ? [['Route', `${it.route.provider} · asked ${it.route.requested ?? 'no model'} · answered by ${it.route.answeredBy ?? 'not recorded'} · ${it.route.where}${it.route.fallback ? ' · the last-resort fallback' : ''}`] as [string, string]] : []),
    ['Opens', studio ? 'Studio, on the project\'s board' : `the companion at ${it.open.path}`],
  ];
  return {
    // a file by its name; an observation's or a run's words with each path said by its file's name (the paths are the details')
    kind, id: it.id, title: it.kind === 'mesh' || it.kind === 'recording' || it.kind === 'reference' || it.kind === 'result' ? base(it.title) : it.kind === 'observation' || it.kind === 'run' ? it.title.replace(/(?:[\w.-]+\/)+([\w.-]+)/g, '$1') : it.title,
    state: it.state, tone: TONE[it.state] ?? 'quiet', at: it.when ? Date.parse(it.when) : Number.NaN, facts,
    ...(it.receipt ? { receipt: { sealed: true, verified: it.receipt.verified, ...(it.receipt.why ? { why: it.receipt.why } : {}) } } : {}),
    ...(it.fake ? { fake: true } : {}), ...(it.operation ? { operation: it.operation } : {}),
    ...(it.results?.length ? { results: it.results } : {}),
    detail, opens,
  };
}

/** Where Enter opens an item in this Workbench (the companion's place is H164's): a run on 3 Workflows with its block selected,
 *  an observation on 5, a chat turn on 2, a mesh or a recording on 6, a receipt on 0, a draft or a card on 4 (Studio's own
 *  board); an image, which a terminal cannot draw, in the companion; a result a run wrote, where that run opens. */
function targetOf(it: JourneyWorkItem, data: Pick<Data, 'jobs' | 'workflows'>, companion: string, studio: boolean): OpenTarget {
  const words = it.open.words;
  const runOf = (op: string | null | undefined): OpenTarget => {
    const job = op ? data.jobs.find((j) => j.operation === op) : undefined;
    const m = job ? /^(.+?) › (.+)$/.exec(job.label) : null;
    const doc = m ? data.workflows.docs.find((d) => d.rel === m[1]) : undefined;
    const b = doc && m ? doc.blocks.find((x) => x.name === m[2]) : undefined;
    return { page: 'workflows', ...(doc && b ? { select: { list: 'center:workflows', key: `block:${doc.rel}:${b.key}` } } : {}), words: 'opens its progress, result and receipt in 3 Workflows', companion, companionWords: 'its source, changes, outputs and receipts, drawn' };
  };
  switch (it.kind) {
    case 'run': return runOf(it.id);
    case 'observation': return { page: 'voxvision', select: { list: 'center:voxvision', key: `vox:${it.id}` }, words: 'opens it in 5 VoxVision', companion, companionWords: 'the image with what was measured over it, drawn' };
    case 'turn': return { page: 'chat', words: 'opens the conversation in 2 Chat', companion, companionWords: 'this project\'s turns, at this one' };
    case 'mesh': return { page: 'create', select: { list: 'center:create3d', key: `mesh:${it.id}` }, words: 'opens it in 6 3D & Motion', companion, companionWords: 'the mesh in a view you can turn' };
    case 'recording': return { page: 'create', select: { list: 'center:create3d', key: `rrd:${it.id}` }, words: 'opens it in 6 3D & Motion', companion, companionWords: 'the recording\'s entities and time ranges' };
    case 'receipt': return { page: 'logs', words: 'opens 0 Logs & Receipts', companion, companionWords: 'the receipt, verified on its page' };
    case 'draft': case 'card': return { page: 'studio', words: 'opens 4 Studio, where Accept or Discard is', companion: '', companionWords: 'the board in Studio (s)', studio: true };
    default: {
      // a reference or a result: where the run that wrote it opens, else an image in the companion, else Files
      if (it.open.select?.name === 'run') return { ...runOf(it.open.select.value), companionWords: 'the run that wrote it, drawn' };
      if (it.open.preview === 'image') return { page: 'logs', ws: 'files', select: { list: 'center:files', key: `file:${it.id}` }, words: `shows it in the companion: ${words}`, companion, companionWords: 'the image, drawn', show: true };
      return { page: 'logs', ws: 'files', select: { list: 'center:files', key: `file:${it.id}` }, words: 'opens it in Files (0 Logs & Receipts)', companion, companionWords: words };
    }
  }
}

/** What waits on you (the one waiting count's items, src/ops/waiting.ts) as Home's first items; a Studio draft is H164's own
 *  item, so it is not listed twice. */
function waitingItem(d: Data['decisions']['items'][number], at: number): WorkItem {
  return {
    kind: 'waiting', id: d.key, title: d.title, state: 'waits on you', tone: 'waiting', at, facts: [d.needed],
    ...(d.operation ? { operation: d.operation } : {}),
    detail: [['Kind', d.kind], ['Why', d.why], ...(d.record ? [['Record', d.record] as [string, string]] : []), ...(d.commands.length ? [['Commands', d.commands.join(' ; ')] as [string, string]] : [])],
    opens: { page: 'control', words: 'opens 7 Control Room, where you answer it', companion: 'tab=control', companionWords: 'what waits, read-only' },
  };
}

/**
 * Home's recent work: what waits on you first (the next step), then the project's recent work as H164's recentWork read it
 * (src/journey/recent.ts: turns, runs, observations, files, drafts and receipts, newest first, each receipt verified here),
 * at most `limit`. Read once per reading of the records (src/workbench/controller.ts readAll), never per frame.
 */
export function recentWork(data: Data, limit = 30, now = Date.now()): WorkItem[] {
  const waiting = data.decisions.items.filter((d) => !d.key.startsWith('draft:')).map((d) => waitingItem(d, now));
  const recent = (data.recent?.items ?? []).map((it) => fromJourney(it, data));
  // R10 (H168's F7): two files of one name (refs/preview.png, out/preview.png) say their folder, so the rows differ
  const names = new Map<string, number>();
  for (const w of recent) if (FILE_KINDS.has(w.kind)) names.set(w.title, (names.get(w.title) ?? 0) + 1);
  const told = recent.map((w) => (FILE_KINDS.has(w.kind) && (names.get(w.title) ?? 0) > 1 && w.id.includes('/') ? { ...w, title: `${w.title} (in ${w.id.split('/').slice(0, -1).join('/')})` } : w));
  return [...waiting, ...told].slice(0, limit);
}

/** The kinds of work that are a file of the project. */
const FILE_KINDS: ReadonlySet<WorkItem['kind']> = new Set(['result', 'reference', 'mesh', 'recording']);

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
    case 'stopped': return { glyph: g.unicode ? '■' : '#', role: 'text' };
    default: return { glyph: w.kind === 'result' ? (g.unicode ? '◇' : '*') : g.dot, role: 'secondary' };
  }
}

/** One row of recent work: the selection's marker, its glyph, its title, its kind and state, and when. */
function workRow(w: WorkItem, selected: boolean, focused: boolean, width: number, c: JourneyCtx): Line {
  const g = c.g;
  const m = workMark(w, g);
  const when = ago(w.at, c.now);
  // (R10 H167; H168's F7: a file says what it is, "reference · image"; anything else its record's word, "run · completed")
  const kind = FILE_KINDS.has(w.kind) ? (w.facts[0] ? `${KIND_WORD[w.kind]} ${g.sep} ${w.facts[0]}` : KIND_WORD[w.kind]) : `${KIND_WORD[w.kind]} ${g.sep} ${w.state}`;
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
  const conns = homeConnections(c);
  const lines: Line[] = [];
  const all = homeItems(c);
  const cur = all.length ? Math.max(0, Math.min(all.length - 1, c.ui.cursor['center:connections'] ?? 0)) : -1;
  const focused = c.ui.focus === 'center';
  // (R10 H167, with H163's first frame: before the project's files are first read there is no recent work to say yet)
  if (!work.length && !c.data.recent && c.data.files.reading) lines.push([S('  Reading the project\'s recent work…', 'secondary')]);
  else if (!work.length) {
    lines.push([S('  Nothing here yet', 'strong')]);
    lines.push(...wrapSegs([S('  No workflow run, chat turn or result is recorded in this project yet. '), S('Enter', 'action'), S(' on the next step above types your first message; '), S('3', 'action'), S(' Workflows runs a block; '), S('n', 'action'), S(' starts a project from a starter.')], Math.max(10, c.width), '  '));
  }
  work.forEach((w, i) => {
    items.push({ line: lines.length, item: workItem(w) });
    lines.push(workRow(w, i === cur, focused, c.width, c));
  });
  // the connections, a row each (its mark and word; its words, its step and its address are the selected item's and the
  // details'): Enter on one does its step, as the cards did (R5 H131)
  // R10 (H167; H168's F13 at pass 2a: "the connections' state column still starts at three columns … (no summary)"): under
  // the heading, how many are in each state (what live means beside it where the row has room, else in ? and the details);
  // every row's state starts in one column (the longest name's, at most 28 cells)
  lines.push(blank, [S('CONNECTIONS', 'secondary', { bold: true }), S(`  ${c.g.sep} as last observed`, 'secondary')]);
  if (!c.data.frame) lines.push([S(c.data.frameError ? `  not read: ${c.data.frameError}` : '  reading…', c.data.frameError ? 'failure' : 'secondary')]);
  else if (conns.length) {
    const sum: Line = [S(`  ${connectionCounts(conns).join(` ${c.g.sep} `)}`, 'secondary')];
    const legend: Line = [...sum, S(`  ${c.g.sep} live: an answer seen in the last 30 minutes`, 'secondary')];
    lines.push(...(lineCells(legend) <= c.width ? [legend] : wrapSegs(sum, Math.max(10, c.width), '  ')));
  }
  const nameW = Math.min(28, Math.max(13, ...conns.map((conn) => connName(conn).length + 2)));
  conns.forEach((conn, k) => {
    const i = work.length + k;
    items.push({ line: lines.length, item: { kind: 'conn', key: `conn:${conn.id}`, conn } });
    const row = connectionRow(conn, c, i === cur, focused, nameW);
    lines.push(i === cur ? row.map((x) => ({ ...x, selected: true })) : row);
  });
  return { lines, items };
}

/** How many items of recent work Home lists (the newest). */
const HOME_WORK = 12;

/** Home's list: recent work, then the connections, in the order drawn. */
export function homeItems(c: Pick<JourneyCtx, 'data' | 'now'>): Item[] {
  return [...recentWork(c.data, HOME_WORK, c.now).map(workItem), ...homeConnections(c).map((conn): Item => ({ kind: 'conn', key: `conn:${conn.id}`, conn }))];
}

/** How long an answer counts as live (the frame's own bound, src/ops/workspace-frame.ts LIVE_FOR_MS). */
const LIVE_MS = 30 * 60_000;

/**
 * R10 (H168's F6): the connections as Home says them: the frame's, with the chat's own answers counted as what they are, an
 * observation of the route's connection: a turn answered through Ollama (its sealed receipt names the route it took) within
 * the live bound makes Ollama live, through OpenRouter OpenRouter, said so ("answered a chat turn 06:02"). Nothing else is
 * changed: a connection no record observed stays as the frame says it.
 *
 * R10 (H163; the lead, with H164's 7df15a9b): the answers are the frame's own sealed turns (every surface's, the newest first,
 * each with the route its receipt names), not recent work's rows: recent work says the conversation as ONE row, its newest
 * turn, which is the turn being answered while one is, and which went through one provider only.
 */
export function homeConnections(c: Pick<JourneyCtx, 'data' | 'now'>): WorkspaceConnection[] {
  const turns = (c.data.frame?.chat?.turns ?? []).filter((t) => t.state === 'answered' && Number.isFinite(Date.parse(t.at)));
  return (c.data.frame?.connections ?? []).map((conn) => {
    if (conn.state === 'live' || (conn.id !== 'ollama' && conn.id !== 'openrouter')) return conn;
    // (a receipt that names an Ollama endpoint, on this computer or off it, went through Ollama; one that names none, OpenRouter)
    const t = turns.find((x) => (x.route === 'openrouter' ? 'openrouter' : 'ollama') === conn.id);
    const at = t ? Date.parse(t.at) : Number.NaN;
    if (!t || !Number.isFinite(at) || c.now - at > LIVE_MS || (conn.observedAt && Date.parse(conn.observedAt) > at)) return conn;
    return { ...conn, state: 'live' as const, words: `answered a chat turn ${clock(t.at)} (its receipt is sealed); live: an answer seen in the last 30 minutes`, observedAt: t.at };
  });
}

/** R10 (H168's F6): what a connection's row says beside its mark, from what observed it last (never "not checked yet" for
 *  one a check or a turn did observe). */
function rowWord(conn: WorkspaceConnection, s: Ui['companion'] | null): string {
  if (s?.serving) return 'served here';
  if (s?.other) return 'served by another Timmy';
  const at = conn.observedAt ? clock(conn.observedAt).slice(0, 5) : null;
  if (!at) return conn.state === 'configured' ? 'not checked yet' : '';
  if (/^not running/.test(conn.words)) return `not running · checked ${at}`;
  if (/^answered a chat turn/.test(conn.words)) return `answered a chat turn ${at}`;
  if (/^answered/.test(conn.words) && conn.state !== 'live') return `answered ${at} · not live now`;
  return `checked ${at}`;
}

/**
 * R10 (H168's F2): the item Home's list selects until the person moves in it: its newest work; with none, the connection the
 * ready route uses (Ollama for the local route, OpenRouter for the cloud one), else the first connection that is not "not set
 * up": never a connection that is not set up while a route is ready.
 */
export function homeDefault(c: Pick<JourneyCtx, 'data' | 'now'>): number {
  const all = homeItems(c);
  if (!all.length || all[0].kind === 'work') return 0;
  const j = c.data.journeyRoute;
  if (!j?.ready) return 0;
  const id = j.provider === 'openrouter' ? 'openrouter' : j.provider === 'ollama' ? 'ollama' : null;
  const own = id ? all.findIndex((it) => it.kind === 'conn' && it.conn.id === id) : -1;
  if (own >= 0) return own;
  const set = all.findIndex((it) => it.kind === 'conn' && it.conn.state !== 'not set up');
  return set >= 0 ? set : 0;
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

/**
 * R10 (H167; H168's F3, an acceptance line): words for Home and Chat: an address, a port, a path, a raw command, an error code
 * or a setting's name said by what it is ("Ollama on this computer did not answer: start it, then check again"). The details
 * ([i]: the Inspector's About · diagnostics, and Activity expanded on another tab) keep them whole.
 */
export function inWords(words: string): string {
  return words
    // an address on this computer, then any other
    .replace(/\b(?:at|on) (?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?(?=[\s,;.)]|$)/g, 'on this computer')
    .replace(/\(?(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[^\s,;)]*)?\)?/g, 'this computer')
    .replace(/\bhttps?:\/\/[^\s,;)]+/g, 'its address')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, 'its address')
    // an error's code: "(the connection failed (ECONNREFUSED))" is "(the connection was refused)"
    .replace(/the connection failed \(ECONNREFUSED\)/g, 'the connection was refused')
    .replace(/\s*\(E[A-Z]{3,}\)/g, '')
    // a command in brackets after its words, or as the step itself
    .replace(/\s*\((?:[^()]*: )?(?:timmy|ollama|npm|npx|brew|curl|open|xdg-open)\b[^()]*\)/g, '')
    .replace(/\b(?:start it|run) \((?:ollama serve|open -a Ollama)[^)]*\)/gi, 'start the Ollama app')
    .replace(/`[^`]+`/g, 'the command ([i])')
    .replace(/\bthen timmy workspace check\b/g, 'then check again')
    .replace(/\btimmy workspace check\b/g, 'a check')
    .replace(/\btimmy (?:init|setup|act)(?: --?[\w-]+(?:[ =](?!asks\b|reads\b|and\b|or\b)[\w./:<>-]+)?)*/g, 'the setup (in a shell)')
    .replace(/\/(?:setup|model|run|op|jobs|open)\b(?: (?![A-Z])[\w./-]+)*/g, 'a REPL command ([i])')
    .replace(/\bollama (?:serve|pull|run)\b(?: [\w.:<>-]+)?/g, 'Ollama')
    // a setting's name and a path
    .replace(/\bset [A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, 'set it in the environment ([i])')
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, 'a setting ([i])')
    .replace(/\s*\(\.sessions\)/g, '')
    .replace(/(?:~|<Timmy home>)?\/?(?:[\w.@-]+\/)+[\w.@-]+\.(?:json|jsonl|md|log|txt|ts|js|png|stl|obj|ply|rrd)\b/g, 'its file')
    .replace(/(?:~|<Timmy home>)\/[\w.@/-]+/g, 'its folder')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** A turn's end as the chat session gives it (src/contracts/chat-session.ts ChatTurnResult), the parts its words are made of. */
export interface TurnEnd { status: string; lines?: readonly string[]; sent: boolean | null; receipt?: string; costWords?: string }

/** The lines of a turn's failure the session gives (src/agent/chat-session.ts errorLines: what, "Cause: …", "Try: …"; the
 *  agent's "Reason:" and "Next:" before it), told apart from its notices and from "Nothing was sent to any model." */
const LABELLED = /^(?:Cause|Reason|Try|Next):/i;
const NOTHING_SENT = /^Nothing was sent to any model\.?$/i;

/**
 * R10 (H163; H168's F3, pass 2a): a turn that failed, as the face says it: what happened, that nothing was sent and it cost
 * nothing (when nothing was), then the next step, in words: "Ollama on this computer did not answer: nothing was sent, no cost.
 * Start the Ollama app, then send again." From the session's lines; those lines whole, with the address, the cause's code and
 * the commands, are the details' ([i] on Chat), and the turn's record and receipt keep them as the session gave them. `notices`:
 * the session's notices before them, in words.
 */
export function failedTurnWords(t: Pick<TurnEnd, 'lines' | 'sent'>): { what: string; next: string | null; notices: string[]; fix: FailedFix } {
  const lines = (t.lines ?? []).map((l) => l.trim()).filter(Boolean);
  const cause = lines.findIndex((l) => /^(?:Cause|Reason):/i.test(l));
  // what happened: the line its cause follows, else the last line that is neither labelled nor "Nothing was sent…"
  const unlabelled = lines.map((l, i) => ({ l, i })).filter((x) => !LABELLED.test(x.l) && !NOTHING_SENT.test(x.l));
  const at = cause > 0 && !LABELLED.test(lines[cause - 1]) ? cause - 1 : unlabelled.length ? unlabelled[unlabelled.length - 1].i : -1;
  const head = at >= 0 ? lines[at] : 'The turn failed, and no reason came back.';
  const notices = lines.slice(0, Math.max(0, at)).filter((l) => !LABELLED.test(l) && !NOTHING_SENT.test(l)).map(inWords);
  let what = inWords(head).replace(/,?\s*so (?:nothing was sent|this message was not sent)\.?$/i, '').replace(/[.:;,\s]+$/, '');
  if (t.sent === false) what = /\b(?:was not sent|nothing was sent)\b/i.test(what) ? `${what}: no cost.` : `${what}: nothing was sent, no cost.`;
  else what = `${what}.`;
  const step = lines.find((l) => /^(?:Try|Next):/i.test(l));
  const s = step ? step.replace(/^(?:Try|Next):\s*/i, '') : '';
  return { what, next: step ? stepInWords(s) : null, notices, fix: step ? fixOf(s) : /\b(?:did not answer|was not sent|stopped answering)\b/i.test(head) ? 'check' : null };
}

/** R10 (H163; H168's N5): what a failure's next step asks of the person, as an action of the Workbench's: check the
 *  connections (the route did not answer), choose the model, set the Ollama address, set the chat up; null: send again. */
export type FailedFix = 'check' | 'model' | 'address' | 'setup' | null;

function fixOf(step: string): FailedFix {
  if (/^start (?:it|Ollama)\b/i.test(step)) return 'check';
  if (/^\/model\b|^choose (?:another|a) model\b/i.test(step)) return 'model';
  if (/\/setup chat\b|\btimmy init --ollama\b/.test(step)) return 'address';
  if (/^timmy init\b|\/setup key\b/.test(step)) return 'setup';
  return null;
}

/** A failure's next step, in words (the commands it names are the details'). */
function stepInWords(step: string): string {
  const s = step.replace(/;?\s*no other model is tried\.?\s*$/i, '').replace(/[.;\s]+$/, '').trim();
  if (/^start (?:it|Ollama)\b/i.test(s)) return 'Start the Ollama app, then send again.';
  if (/^send (?:it )?again\b/i.test(s)) return /\bif it repeats, see Ollama's own log\b/i.test(s) ? 'Send again; if it repeats, Ollama\'s own log says why.' : 'Send again.';
  if (/^\/model lists what it has\b/.test(s)) return /\bollama pull\b/.test(s) ? 'Choose a model it has, or have Ollama pull it first.' : 'Choose a model it has.';
  if (/^\/model to choose one with local weights\b/.test(s)) return 'Choose a model with local weights.';
  if (/^\/model to choose a chat model\b/.test(s)) return 'Choose a chat model Ollama lists.';
  if (/^choose another model\b/i.test(s)) return 'Choose another model.';
  if (/\/setup chat\b|\btimmy init --ollama\b/.test(s)) return 'Set the Ollama address the chat uses again: the setup asks for it.';
  if (/^timmy init\b/.test(s)) return 'Run the setup (in a shell): it asks for a model key, or sets a local model.';
  const w = inWords(s);
  return w ? `${w.charAt(0).toUpperCase()}${w.slice(1)}.` : 'Send again.';
}

/**
 * R10 (H163; H168's F3): the notice a turn's end gives (Activity's newest line): an answer with its receipt and its cost; a
 * failure as the face says it (failedTurnWords); a refusal as the session words it. A stopped turn's is the controller's.
 */
export function turnEndNotice(r: TurnEnd, g: Pick<Glyphs, 'sep'>): string {
  if (r.status === 'answered') return `Answered${r.receipt ? ': its receipt is sealed' : ''} ${g.sep} ${costOnFace(r.costWords) || 'cost unknown'}`;
  if (r.status === 'failed') {
    const f = failedTurnWords(r);
    return `Failed: ${f.what}${f.next ? ` ${f.next}` : ''}`;
  }
  return `${r.status === 'refused' ? 'Refused' : 'Failed'}: ${(r.lines ?? [])[0] ?? r.status}${r.sent ? '' : ' Nothing was sent to any model.'}`;
}

// ── the selected item, drawn as a terminal can (R10 H167; H168's F10) ───────────

const IMAGE_SIZES = new Map<string, { key: string; size: { w: number; h: number } | null }>();

/** An image's pixel size from its own header (PNG, GIF, JPEG), read once for each reading of the records; null: not read. */
export function imageSize(file: string, key: string): { w: number; h: number } | null {
  const kept = IMAGE_SIZES.get(file);
  if (kept?.key === key) return kept.size;
  let size: { w: number; h: number } | null = null;
  try {
    const fd = openSync(file, 'r');
    const b = Buffer.alloc(65536);
    let n = 0;
    try { n = readSync(fd, b, 0, b.length, 0); } finally { closeSync(fd); }
    const buf = b.subarray(0, n);
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) size = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    else if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') size = { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    else if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      // a JPEG: its markers walked to the frame's (SOF), which holds the height, then the width
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { size = { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }; break; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { size = null; }
  IMAGE_SIZES.set(file, { key, size });
  if (IMAGE_SIZES.size > 64) IMAGE_SIZES.delete(IMAGE_SIZES.keys().next().value!);
  return size;
}

const MESH_WORD: Readonly<Record<string, string>> = { stl: 'STL', obj: 'OBJ', ply: 'PLY', tessellation: 'tessellation (STL)' };
const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));

/**
 * R10 (H168's F10): the selected item as a terminal draws it: an image's pixel size and what VoxVision measured on it; a
 * mesh's format, triangles and box (tab 6's own reader, src/workbench/create-tab.ts); a run's steps, the files it wrote and
 * how it ended; a turn's question and the first lines of its answer (this project's conversation). What no record says is not
 * said. Rows of words, with no address, path or id.
 */
export function representation(w: WorkItem, c: JourneyCtx, room = 0): Line[] {
  const { data, g, width } = c;
  const sep = ` ${g.sep} `;
  const out: Line[] = [];
  const row = (k: string, v: string, role: Role = 'text'): void => { out.push(...wrapSegs([S(`${k.padEnd(9)} `, 'secondary'), S(v, role)], width, ' '.repeat(10))); };
  if ((w.kind === 'reference' || w.kind === 'result') && IMAGE.test(w.id)) {
    const size = imageSize(join(data.project.root, w.id), `${data.readAt}`);
    row('Image', size ? `${size.w} × ${size.h} px` : 'its size could not be read');
    const name = base(w.id);
    const seen = (data.vox ?? []).filter((v) => v.what.includes(name)).slice(0, 2);
    for (const v of seen) row('Measured', `VoxVision ${v.what.split(' ')[0]}${sep}${v.state}${sep}${clock(v.at).slice(0, 5)}`);
    if (!seen.length) row('Measured', 'nothing yet: 5 VoxVision measures an image');
  } else if (w.kind === 'mesh') {
    const m = createItems(data).find((x) => x.kind === 'mesh' && x.mesh.path === w.id);
    const r = m?.kind === 'mesh' ? m.mesh.readback : undefined;
    if (m?.kind === 'mesh' && r) {
      row('Mesh', `${MESH_WORD[m.mesh.kind] ?? m.mesh.kind}${sep}${r.triangles} triangle${r.triangles === 1 ? '' : 's'}`);
      row('Box', r.bbox ? r.bbox.size.map(num).join(' × ') : 'none (no triangles)');
    } else row('Mesh', m?.kind === 'mesh' ? (m.mesh.pending ? 'being measured' : 'not measured: 6 3D & Motion says why') : 'not read yet');
  } else if (w.kind === 'run') {
    const job = data.jobs.find((j) => j.operation === w.id);
    // (R10 H167; H168's F10 at pass 2a: the column's empty rows): what the column has room for is given to the run's steps, a
    // row each by its name and how it ended, then to the files it wrote, all named
    let left = Math.max(0, room);
    if (job) {
      const steps = job.steps ?? [];
      const done = steps.filter((st) => st.state === 'completed').length;
      row('Progress', `${job.word}${steps.length ? `${sep}${done} of ${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}${job.elapsed ? `${sep}${job.elapsed}` : ''}`);
      for (const st of steps.slice(0, left)) {
        const word = st.outcome === 'no change' ? 'no change' : st.state;
        out.push(trimTo([S(' '.repeat(10)), S(st.name, 'text'), S(sep, 'secondary'), S(word, st.state === 'failed' ? 'failure' : 'secondary')], width, g.ellipsis));
        left -= 1;
      }
    }
    const files = (w.results ?? []).map(base);
    if (files.length) {
      const rowsOf = (v: string): number => wrapSegs([S(`${'Wrote'.padEnd(9)} `, 'secondary'), S(v, 'text')], width, ' '.repeat(10)).length;
      const short = `${files.slice(0, 3).join(', ')}${files.length > 3 ? `, ${files.length - 3} more` : ''}`;
      const whole = files.join(', ');
      row('Wrote', files.length > 3 && left > 0 && rowsOf(whole) - rowsOf(short) <= left ? whole : short);
    }
  } else if (w.kind === 'turn') {
    const msgs = data.chat?.messages ?? [];
    const norm = (t: string): string => t.replace(/\s+/g, ' ').trim();
    // R10 CHAT (H167; H168's R1 at pass 2c): the conversation row's title carries the turn count since 7df15a9b ("… · 13 turns in
    // this conversation", src/journey/recent.ts) and is cut to make it room: the turn's own words are the title without that
    // tail and its cut's ellipsis, and its message the newest of the conversation that begins with them, said whole after You
    const words = norm(w.title.replace(/ · (?:at least )?\d+ turns in this conversation$/, '')).replace(/…$/, '').trim();
    let at = -1;
    for (let k = msgs.length - 1; k >= 0 && at < 0; k--) if (words && msgs[k].role === 'user' && norm(msgs[k].text).startsWith(words)) at = k;
    const answer = at >= 0 ? msgs.slice(at + 1).find((m) => m.role === 'assistant') : undefined;
    out.push(...wrapSegs([S('You    ', 'secondary'), S(at >= 0 ? norm(msgs[at].text) : words, 'strong')], width, ' '.repeat(7)).slice(0, 2));
    // (R10 H167; H168's F10 at pass 2a: the column's empty rows): its answer's first lines, as many as the column has room for
    if (answer) out.push(...wrapSegs([S('Timmy  ', 'ai'), S(answer.text.replace(/\s+/g, ' ').trim(), 'text')], width, ' '.repeat(7)).slice(0, 3 + Math.max(0, room)));
    else out.push([S('       its answer is not in the conversation kept here', 'secondary')]);
  } else if (w.kind === 'observation') {
    const v = (data.vox ?? []).find((x) => x.id === w.id);
    if (v) row('Measured', `${v.what}${sep}${v.state}`);
  }
  return out;
}

/** A connection's words with its address said by what it is (the details say it whole). */
const noAddress = (words: string): string => inWords(words);

const COMPANION_TAB: Readonly<Record<string, string>> = {
  home: 'Home', chat: 'Chat & Intent', workflows: 'Workflows', studio: 'Studio', voxvision: 'VoxVision', create: '3D & Motion',
  control: 'Control Room', fleet: 'Fleet & Clef', tools: 'Tools & MCP', logs: 'Logs & Receipts',
};

/**
 * R10 (H167; H168's F3 and F5): what a hand-off to the companion opens, in words, from the page's query (H164's openTarget
 * query: tab=create&mesh=…) and the item's name when one was given ("for demo-tray.stl"): "demo-tray.stl in 3D & Motion", or
 * "its Chat & Intent tab".
 */
export function companionWhat(query: string, why = ''): string {
  const p = new URLSearchParams(query);
  const tab = COMPANION_TAB[p.get('tab') ?? 'home'] ?? 'Home';
  const item = /^for (.+)$/.exec(why.trim())?.[1];
  if (item) return `${item} in ${tab}`;
  // a mesh, a recording or a file is named in the address by its path's hex (H164's hexOfPath): said by its file's name
  for (const k of ['mesh', 'recording', 'file']) {
    const hex = p.get(k);
    if (!hex || !/^(?:[0-9a-f]{2})+$/.test(hex)) continue;
    const path = Buffer.from(hex, 'hex').toString('utf8');
    if (/^[\x20-\x7e]+$/.test(path)) return `${path.split('/').pop()} in ${tab}`;
  }
  const chosen = ['run', 'mesh', 'recording', 'file', 'vox', 'receipt'].find((k) => p.has(k));
  const what: Readonly<Record<string, string>> = { run: 'the run', mesh: 'the mesh', recording: 'the recording', file: 'the file', vox: 'the observation', receipt: 'the receipt' };
  return chosen ? `${what[chosen]} chosen in ${tab}` : `its ${tab} tab`;
}

/**
 * R10 (H167; H168's F3): a server's hand-off words (src/workbench/servers.ts: "The Companion opened in your browser
 * (http://127.0.0.1:4472/?tab=…), through a private page…") said in words, with what opened; the address, the port it took
 * and the private page are the details' ([i], where the server's own words are kept whole).
 */
export function handoffWords(which: 'companion' | 'studio', words: string, what: string): string {
  const name = which === 'companion' ? 'the companion' : 'Studio';
  if (/opened in your browser/.test(words)) {
    if (which === 'studio') {
      const shows = /It shows ([^.]+)\./.exec(words)?.[1];
      const elsewhere = /Another Timmy serves it\./.test(words) ? ' Another Timmy serves it.' : '';
      return `Opened Studio${shows ? `: it shows ${shows}` : ''}.${elsewhere}`;
    }
    return `Opened in the companion: ${what}.${/port asked for, was taken/.test(words) ? ' It took another port than the one asked for ([i] says which).' : ''}`;
  }
  if (/so open it yourself|could not be written/.test(words)) return `${which === 'companion' ? 'The companion' : 'Studio'} serves ${what || 'its page'} on this computer, but no browser was opened from here: the details ([i]) say its address, to open it yourself.`;
  return inWords(words.replace(/\bThe Companion\b/, 'The companion'));
}

/** The name a connection goes by on Home's rows. */
const connName = (conn: WorkspaceConnection): string => (conn.id === 'openrouter' ? 'OpenRouter' : conn.id === 'ollama' ? 'Ollama' : conn.id === 'companion' ? 'Companion' : conn.id === 'studio' ? 'Studio' : conn.id === 'cloudflare' ? 'Cloudflare' : conn.label.replace(/\s*\(.*\)$/, ''));

/** Home's right column: the selected item (what it is, how it ended, its receipt, where it opens; a connection's words and its
 *  step), then the project. Ids, hashes, addresses and commands are the details' ([i]). */
export function homeSideView(c: JourneyCtx, step?: (conn: WorkspaceConnection) => string | null, room = 0): View {
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
    // R10 (H168's F10): the item itself, as a terminal can draw it (references 01 and 13 give this half to its preview)
    const shown = representation(w, c, room);
    if (shown.length) lines.push(blank, ...shown);
    if (w.receipt) {
      lines.push(blank);
      lines.push(w.receipt.verified === true
        ? [S('Receipt  ', 'secondary'), S(`${g.ok} sealed and verified`, 'live')]
        : w.receipt.verified === false
          ? [S('Receipt  ', 'secondary'), S(`${g.fail} sealed, does not verify`, 'failure')]
          : [S('Receipt  ', 'secondary'), S('sealed', 'text'), S(' · not verified on this screen', 'secondary')]);
    }
    lines.push(blank);
    // (R10 H167; H168: Enter acts on the zone with the keyboard: with the list's, it opens this; else Tab gives it the list)
    const listHas = c.ui.focus === 'center';
    lines.push(...wrapSegs([...(listHas ? [] : [S('Tab, then ', 'secondary')]), key('Enter'), S(` ${w.opens.words}`, 'text')], width, '        '));
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
    if (does) lines.push(...wrapSegs([key('Enter'), S(` ${inWords(does)}`, 'text')], width, '        '));
    lines.push(...wrapSegs([key('i'), S('     details: its address, its step, what was observed', 'secondary')], width, '        '));
  } else {
    lines.push(heading('Nothing selected'), [S('Recent work is empty: the next step above starts it.', 'secondary')]);
  }
  lines.push(blank, heading('Project'));
  const files = data.files.total - (data.files.timmyLogs ?? 0);
  const docs = data.workflows.docs.length;
  // (its jobs, as the Control Room lists them: a job no operation record names, such as another session's task, is not in the
  // recent work above, which lists the runs the operation records name)
  // R10 (H163): the files and workflow documents are read right after the first frame: until then, said so
  lines.push(...wrapSegs([S(data.files.reading || data.workflows.reading ? `files and workflow documents being read${sep}${count(data.jobs.length, 'job')}` : `${count(files, 'file')}${sep}${count(docs, 'workflow document')}${sep}${count(data.jobs.length, 'job')}`, 'text')], width, '  '));
  // R5 (H131; the QA round's defect 24): Timmy's own logs (logs/*.log, written where it runs) are not the project's files
  if (data.files.timmyLogs) lines.push(...wrapSegs([S(`not counted: ${count(data.files.timmyLogs, 'log')} Timmy writes itself (logs/*.log)`, 'secondary')], width, '  '));
  // R10 (H167; H168's F10 at pass 2a: "empty rows of the Selected column with a turn selected: 7 of 22 at 122×37"): what the
  // column has room for under the project is given to the item itself (a turn's answer, its next lines; a run's steps and the
  // files it wrote), drawn once more with it
  const free = c.height - lines.length;
  if (!room && free > 0 && it?.kind === 'work' && (it.work.kind === 'turn' || it.work.kind === 'run')) return homeSideView(c, step, free);
  return { lines, items: [] };
}

/** A connection as one row: the selection's marker, its name, its state's mark and word (green only for an observed answer)
 *  and when it was observed; no address. */
function connectionRow(conn: WorkspaceConnection, c: Pick<JourneyCtx, 'g' | 'ui'>, selected = false, focused = false, nameW = 13): Line {
  const m = connectionMark(conn.state, c.g);
  const s = conn.id === 'companion' ? c.ui.companion : conn.id === 'studio' ? c.ui.studio : null;
  const extra = rowWord(conn, s);
  // (R10 H167: a name longer than the column is shortened with an ellipsis, whole in the selected item's words and the details)
  const name = connName(conn);
  const shown = name.length + 2 > nameW ? `${name.slice(0, Math.max(1, nameW - 3))}${c.g.ellipsis}` : name;
  return [S(selected ? `${c.g.cursor} ` : '  ', selected && focused ? 'accent' : 'secondary'), S(`${shown.padEnd(nameW)}`, selected ? 'strong' : 'text'), S(m.text, m.role), S(extra ? `  ${c.g.sep} ${extra}` : '', 'secondary')];
}

/** R10 (H167; H168's F13): how many connections are in each state ("1 live", "7 not set up"), in the marks' order (none of a
 *  state: not said). */
export function connectionCounts(conns: WorkspaceConnection[]): string[] {
  const order: ReadonlyArray<WorkspaceConnection['state']> = ['live', 'configured', 'unreachable', 'refused', 'not set up', 'unknown'];
  const state = (x: WorkspaceConnection): WorkspaceConnection['state'] => (order.includes(x.state) ? x.state : 'unknown');
  return order.map((st) => [st, conns.filter((x) => state(x) === st).length] as const).filter(([, n]) => n > 0).map(([st, n]) => `${n} ${st}`);
}

// ── the inspector: details and the build ───────────────────────────────────────

/** The build's identity, as About says it (H163's src/build-info.ts replaces this once merged): the review's revision when the
 *  launcher sets it, else unknown. */
export function buildWords(env: Record<string, string | undefined> = process.env, b?: BuildInfo): Array<[string, string]> {
  // H163's buildInfo: the version, the revision and where it was read, packed or from source
  if (b) {
    return [
      ['Version', b.version],
      ['Revision', b.revision ? `${b.revision.short}${b.dirty ? ' (with uncommitted changes)' : ''}` : 'revision unknown'],
      ['From', `${b.source === 'packed' ? 'a packed build' : 'source'} · ${b.revisionFrom}`],
      ...(b.reviewPackage ? [['Review', `${b.reviewPackage}${b.mismatch ? ` · ${b.mismatch}` : ''}`] as [string, string]] : []),
      ['Node', b.node.version],
      ['Timmy home', tildePath(b.timmyHome)],
      ['Ports', `companion ${b.ports.companion}, Studio ${b.ports.studio}, log ${b.ports.logs}`],
    ];
  }
  // (the build is read with the records, once: until then it is not known here)
  return [
    ['Revision', 'not read yet'],
    ['Node', process.versions.node],
    ['Timmy home', env.TIMMY_HOME ? tildePath(env.TIMMY_HOME, env as NodeJS.ProcessEnv) : 'the default (~/timmy)'],
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
export function diagnosticsLines(c: Pick<JourneyCtx, 'data' | 'g' | 'width'> & { ui?: Pick<Ui, 'companion' | 'studio'> }, env: Record<string, string | undefined> = process.env): Line[] {
  const { data, g, width } = c;
  const out: Line[] = [heading('About · diagnostics')];
  const row = (k: string, v: string, role: Role = 'text'): void => { out.push(...wrapSegs([S(`${k.padEnd(10)} `, 'secondary'), S(v, role)], width, ' '.repeat(11))); };
  for (const [k, v] of buildWords(env, data.build)) row(k, v);
  const rt = routeLine(data);
  row('Route', rt.words);
  // R10 (H163; H168's N1): the price in its long form (the face says a local one "no charge · local"), with what the route
  // declares of it
  const whole = rt.priceWhole ?? rt.price;
  const priceWords = data.journeyRoute?.price.words ?? '';
  const declared = whole.startsWith('no price declared') ? priceWords.replace(/^no price declared:\s*/, '') : priceWords;
  row('Price', declared && declared !== whole ? `${whole} ${g.sep} ${declared}` : whole);
  const j = data.journeyRoute;
  if (j) {
    if (j.fakeWhy) out.push(...wrapSegs([S(`${'FAKE'.padEnd(10)} `, 'secondary'), S(j.fakeWhy, 'text')], width, ' '.repeat(11)));
    if (j.details.host) out.push(...wrapSegs([S(`${'Ollama at'.padEnd(10)} `, 'secondary'), S(j.details.host, 'text')], width, ' '.repeat(11)));
    if (j.step) out.push(...wrapSegs([S(`${'Step'.padEnd(10)} `, 'secondary'), S(j.step.words, 'text')], width, ' '.repeat(11)));
    if (j.cause) out.push(...wrapSegs([S(`${'Cause'.padEnd(10)} `, 'secondary'), S(j.cause, 'text')], width, ' '.repeat(11)));
  }
  for (const n of data.recent?.notes ?? []) out.push(...wrapSegs([S(`${'Recent'.padEnd(10)} `, 'secondary'), S(n, 'secondary')], width, ' '.repeat(11)));
  // R10 (H167; H168's F3): what Home and Chat say in words, whole here: the servers' addresses and their last words, the
  // project's folder, where the connections' checks are recorded, and the newest notices as they were said
  if (c.ui) {
    for (const [k, s] of [['Companion', c.ui.companion], ['Studio', c.ui.studio]] as const) {
      row(k, `${s.serving ? `served by this Workbench at ${s.address}` : s.other && s.address ? `served by another Timmy at ${s.address}` : 'not served by this Workbench'}${s.last ? ` · last: ${s.last}` : ''}`);
    }
  }
  row('Project', `${data.project.name} · ${data.project.shown}`);
  row('Checks', tildePath(connectionsPath(env as NodeJS.ProcessEnv), env as NodeJS.ProcessEnv));
  const said = data.activity.events.filter((e) => !e.output).slice(0, 4);
  if (said.length) {
    out.push(blank, heading('Newest notices, as said'));
    for (const e of said) out.push(...wrapSegs([S(`${clock(e.at)} `, 'secondary'), S(e.words, 'text')], width, ' '.repeat(9)));
  }
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
