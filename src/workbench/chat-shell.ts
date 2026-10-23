/**
 * R10 CHAT CHECKPOINT (H167; the operator's order of 2026-10-22, 16:01 PT, the handoff's IMPLEMENTATION_SPEC.md and the
 * operator's terminal target of 16:52 PT, measured in cells): the Workbench's Chat screen as one screen, with no boxed panes,
 * vertical separators and horizontal rules only:
 *
 *   122 x 37   the left rail columns 0-17, a separator at 18, the center 19-89, a separator at 90, Models 91-121; the header
 *              rows 0-2 (TIMMY, the project / Chat and LOCAL RECORDS; NEXT / provider / model; a rule), the conversation and
 *              Models rows 3-33, the bottom rows 34-36 (a rule, this conversation's actions, the status row)
 *   80 x 24    the left rail columns 0-13, a separator at 14, the center 15-79; Models a drawer over the center only; the header
 *              rows 0-2, the conversation and the composer rows 3-20, the bottom rows 21-23
 *
 * Uppercase section labels (PROJECT, CHAT / <project>, YOU, TIMMY, MESSAGE, MODELS, SELECTED / <model>); ">" marks the selected
 * menu item, provider and model (amber); the composer is boxed only while it has the keyboard; the section that has the
 * keyboard has its label amber. The words are Timmy's own: a FAKE model is named FAKE, what no record says is unknown. The
 * conversation is src/workbench/views.ts chatView's (the shell's form); the data are read by small functions here
 * (railCatalog, ollamaRows, queryRows) in the shape the slice's shared contract names (H169's CatalogRow and CatalogQuery in
 * src/models/catalog.ts), so the lead can switch them to H169's at the merge. Pure: the controller reads, this draws. It
 * replaces the horizontal tabs on this screen only.
 */
import type { TabId } from '../contracts/workspace.js';
import type { Glyphs } from './frame.js';
import { chatTurnNow } from './hub.js';
import { inWords, routeLine } from './home-journey.js';
import type { Data, Region, Ui, View } from './model.js';
import { noModelChosen } from './state.js';
import type { WorkspaceId } from './nav.js';
import { clock, cut, fit, lineCells, spread, trimTo, wrapText, type Line, type Role, type Seg } from './text.js';
import { openRouterRow, queryCatalog, type CatalogQuery, type CatalogRow, type MakerOption, type ModelSource, type OpenRouterCatalogModel } from '../models/catalog.js';
import { localModelGlyph } from '../setup/local-model-check.js';
import type { ProviderState } from '../setup/providers-state.js';

const S = (text: string, role: Role = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Seg => ({ text, role, ...o });
const blank: Line = [];

/** What a view of the shell is given (the subset of src/workbench/views.ts ViewCtx it reads). */
export interface ShellCtx {
  ui: Ui;
  data: Data;
  g: Glyphs;
  width: number;
  height: number;
  now: number;
}

// ── the grid ───────────────────────────────────────────────────────────────────

/** Where everything sits at a terminal's size (the operator's terminal target's cell budget, generalised). */
export interface ChatGrid {
  W: number;
  H: number;
  /** the rail's columns (0 to railW-1); its separator is column railW */
  railW: number;
  /** the center's first column and its width up to the next separator (or the edge) */
  centerX: number;
  centerW: number;
  /** where the center's content starts and how wide it is (an inset of one cell, a margin before the separator or the edge) */
  cx: number;
  cw: number;
  /** Models beside the center: its separator's column; null: Models is a drawer over the center */
  sepR: number | null;
  /** Models' first column, its content's start and width */
  modelsX: number;
  mx: number;
  mw: number;
  /** the content rows: from row 3, this many; the bottom's three rows after them */
  contentH: number;
}

/** From here Models sits beside the conversation (the target's 122 columns); below, the compact rail and a Models drawer. */
export const WIDE_COLUMNS = 110;
const MODELS_W = 31;

export function chatGrid(W: number, H: number): ChatGrid {
  const wide = W >= WIDE_COLUMNS;
  const railW = wide ? 18 : 14;
  const sepR = wide ? W - MODELS_W - 1 : null;
  const centerX = railW + 1;
  const centerW = (sepR ?? W) - centerX;
  const cw = centerW - 1 - (sepR !== null ? 1 : 2);
  const modelsX = sepR !== null ? sepR + 1 : centerX;
  return { W, H, railW, centerX, centerW, cx: centerX + 1, cw, sepR, modelsX, mx: modelsX + 1, mw: sepR !== null ? MODELS_W - 3 : cw, contentH: Math.max(4, H - 6) };
}

/** Where the rule above MESSAGE is, among the content rows (the conversation is the rows between CHAT / project and it). */
const ruleRow = (contentH: number): number => contentH - 1 - (contentH >= 25 ? 1 : 0) - 5;

/** The conversation's rows and width at this size (the caller scrolls the conversation to them). */
export function convoRowsAt(W: number, H: number): { rows: number; width: number } {
  const grid = chatGrid(W, H);
  return { rows: Math.max(1, ruleRow(grid.contentH) - CONVO_AT), width: grid.cw };
}

/** The conversation's first row among the content rows (the target's row 7 at both sizes: CHAT / project, two rows, then it). */
const CONVO_AT = 4;

// ── the left rail ──────────────────────────────────────────────────────────────

/**
 * R11 (H167; step 3a, the plan's section 2): the rail in four groups with uppercase labels: PROJECT (the switcher, + New),
 * CHAT, WORK (Files · Workflows · Runs & receipts · Canvas), CREATE (Vision · Motion & 3D) and CONNECT (Models & accounts ·
 * Tools & integrations · Control Room); a footer "? Help · / find". Each opens the existing workspace as it is today, renamed
 * (`label` is the plan's name, the companion's and the finder's; `wide` fits the 18-column rail's 16 cells, `short` the
 * 14-column rail's 12): Files the project's files; Runs & receipts the turn records, the receipts and the logs (today's Logs
 * & records); Canvas Studio's outline (Studio · Show opens it in the browser); Vision VoxVision; Motion & 3D the 3D and
 * motion apps; Models & accounts Home's connections (the keys and the servers; Models itself is M); Tools & integrations the
 * Tools & MCP page; Control Room the jobs, turns and decisions.
 */
export interface RailItem { id: string; label: string; wide: string; short: string; page: TabId; ws?: WorkspaceId }
export const RAIL_GROUPS: ReadonlyArray<{ label: string | null; items: readonly RailItem[] }> = [
  { label: null, items: [{ id: 'chat', label: 'Chat', wide: 'Chat', short: 'Chat', page: 'chat' }] },
  { label: 'WORK', items: [
    { id: 'files', label: 'Files', wide: 'Files', short: 'Files', page: 'logs', ws: 'files' },
    { id: 'workflows', label: 'Workflows', wide: 'Workflows', short: 'Workflows', page: 'workflows' },
    { id: 'logs', label: 'Runs & receipts', wide: 'Runs & receipts', short: 'Runs', page: 'logs' },
    { id: 'studio', label: 'Canvas', wide: 'Canvas', short: 'Canvas', page: 'studio' },
  ] },
  { label: 'CREATE', items: [
    { id: 'voxvision', label: 'Vision', wide: 'Vision', short: 'Vision', page: 'voxvision' },
    { id: 'motion', label: 'Motion & 3D', wide: 'Motion & 3D', short: 'Motion & 3D', page: 'create' },
  ] },
  { label: 'CONNECT', items: [
    { id: 'connections', label: 'Models & accounts', wide: 'Models & keys', short: 'Models', page: 'home' },
    { id: 'tools', label: 'Tools & integrations', wide: 'Tools & MCP', short: 'Tools', page: 'tools' },
    { id: 'control', label: 'Control Room', wide: 'Control Room', short: 'Control', page: 'control' },
  ] },
];

/** The rail's menu items in order (the groups flattened). */
export const RAIL: ReadonlyArray<RailItem> = RAIL_GROUPS.flatMap((x) => x.items);

/** The rail's items, in order: the project selector, New project, the menu, then Help and the finder. */
export const RAIL_ITEMS: readonly string[] = ['project', 'new', ...RAIL.map((r) => r.id), 'help', 'find'];

/**
 * The rail's rows from row 3 to the screen's last (`railW` cells each; its separator is the caller's): the groups with a
 * blank row between them where the rows allow (the target's 122x37), packed where they do not (80x24: 21 rows), the footer
 * on the third row from the end. The item shown is marked "> " and amber, the cursor's row on the selection's ground.
 */
function railLines(c: ShellCtx, grid: ChatGrid, focused: boolean): { lines: Line[]; items: View['items'] } {
  const { g, data, ui } = c;
  const wide = grid.railW >= 18;
  const rows = grid.H - 3;
  const lines: Line[] = Array.from({ length: rows }, (): Line => []);
  const items: View['items'] = [];
  const cur = Math.max(0, Math.min(RAIL_ITEMS.length - 1, ui.cursor.rail ?? RAIL_ITEMS.indexOf('chat')));
  const on = (id: string): Omit<Seg, 'text' | 'role'> => (focused && RAIL_ITEMS[cur] === id ? { selected: true } : {});
  const put = (row: number, id: string | null, line: Line): void => {
    if (row < 0 || row >= rows) return;
    lines[row] = line;
    if (id) items.push({ line: row, item: { kind: 'action', key: `rail:${id}`, action: id } });
  };
  const label = (row: number, text: string): void => put(row, null, [S('  '), S(text, focused ? 'accent' : 'secondary', { bold: focused })]);
  // the footer, and whether the groups get their blank rows: PROJECT's three rows, a blank, then the groups (a label row
  // and its items, a blank between groups) must end above the footer's blank row
  const footAt = rows - 3;
  const groupRows = RAIL_GROUPS.reduce((n, x) => n + (x.label ? 1 : 0) + x.items.length, 0);
  const roomy = 6 + groupRows + (RAIL_GROUPS.length - 1) + 1 <= footAt;
  label(1, 'PROJECT');
  const name = cut(data.project.name, grid.railW - (wide ? 6 : 3), g.ellipsis);
  put(2, 'project', [S('  '), S(name, 'strong', on('project')), S(wide ? ' v' : '', 'secondary', on('project'))]);
  put(roomy ? 4 : 3, 'new', [S('  '), S(wide ? '+ New project' : '+ New', 'text', on('new'))]);
  let row = roomy ? 6 : 5;
  RAIL_GROUPS.forEach((gr, k) => {
    if (k && roomy) row += 1;
    if (gr.label) { label(row, gr.label); row += 1; }
    for (const r of gr.items) {
      const shown = ui.page === r.page && (r.id === 'files' ? ui.workspace === 'files' : r.id === 'logs' ? ui.workspace !== 'files' : true);
      const text = cut(wide ? r.wide : r.short, grid.railW - 2, g.ellipsis);
      const o = { ...(shown ? { bold: true } : {}), ...on(r.id) };
      put(row, r.id, [S(shown ? '> ' : '  ', shown ? 'accent' : 'text', o), S(text, shown ? 'accent' : 'text', o)]);
      row += 1;
    }
  });
  // (R11 step 3a: the footer, Help and the finder, each a target of its own)
  const help: Seg = S('? Help', 'secondary', on('help'));
  const find: Seg = S(wide ? '/ find' : '/', 'secondary', on('find'));
  put(footAt, 'help', [S('  '), help, S('  '), find]);
  items.push({ line: footAt, item: { kind: 'action', key: 'rail:find', action: 'find' }, x: { from: 2 + lineCells([help]) + 2, to: 2 + lineCells([help]) + 2 + lineCells([find]) - 1 } });
  items[items.length - 2].x = { from: 2, to: 2 + lineCells([help]) - 1 };
  return { lines, items };
}

// ── the header ─────────────────────────────────────────────────────────────────

/** The provider of the next turn, in the target's words ("OpenRouter", "Ollama local", "Ollama cloud"). */
function nextProvider(d: Data): string {
  const rt = routeLine(d);
  if (d.route.kind === 'openrouter') return 'OpenRouter';
  if (d.route.kind === 'local') return /cloud/i.test(rt.where) ? 'Ollama cloud' : /another computer/.test(rt.where) ? 'Ollama, another computer' : 'Ollama local';
  return 'no provider';
}

/** The header's three rows: TIMMY, the project / Chat and LOCAL RECORDS; NEXT / provider / model (FAKE named), or what is
 *  missing; a rule the whole width. */
function headerRows(c: ShellCtx, grid: ChatGrid, first: boolean): Line[] {
  const { data, g } = c;
  const rt = routeLine(data);
  const at = grid.railW + 2;
  const margin = grid.W >= WIDE_COLUMNS ? 6 : 3;
  const title: Line = [S(`${data.project.name} / Chat`, 'strong', { bold: true })];
  const right: Line = [S('LOCAL RECORDS', 'secondary')];
  const fill = Math.max(1, grid.W - at - lineCells(title) - lineCells(right) - margin);
  const row0: Line = [S('  '), S('TIMMY', 'strong', { bold: true }), S(' '.repeat(Math.max(1, at - 7))), ...title, S(' '.repeat(fill)), ...right];
  // (R11 H167, step 1c: below WIDE_COLUMNS the next turn's model is the chip's, at the composer's right: row 1 is blank there)
  const next: Line = first
    ? [S('FIRST RUN / choose how chat runs', 'secondary')]
    : grid.W < WIDE_COLUMNS ? []
    : rt.model
      ? [S(`NEXT / ${nextProvider(data)} / `, 'secondary'), ...(rt.fake ? [S('FAKE ', 'attention')] : []), S(rt.model, 'text')]
      // (R10 CHAT H167; H168's pass 3b, R17: a key and no model chosen: none is the next turn's)
      : noModelChosen(data.route) ? [S('NEXT / OpenRouter / ', 'secondary'), S('no model chosen: Models (M)', 'attention')]
        : [S('NEXT / ', 'secondary'), S('Connect a model to chat', 'attention')];
  const row1: Line = [S(' '.repeat(at)), ...trimTo(next, Math.max(4, grid.W - at - margin), g.ellipsis)];
  return [fit(row0, grid.W, g.ellipsis), fit(row1, grid.W, g.ellipsis), [S((g.unicode ? '─' : '-').repeat(grid.W), 'border')]];
}

// ── Models ─────────────────────────────────────────────────────────────────────

/** Models' rows and query are H169's catalog's (src/models/catalog.ts, the shared contract): one model as a provider lists
 *  it, and its query (sort, search and filters; a sort never resets the filters). */
export type { CatalogQuery, CatalogRow, ModelSource };

/** What the controller read for Models: OpenRouter's catalog (the copy this computer fetched, else the snapshot shipped with
 *  Timmy: H169's loadCatalog with no refresh, so no request) and what the local Ollama lists (one request to it, no model
 *  run); and the providers' states (H170's providerStates: files and observations only, nothing asked). */
export interface RailModels {
  openrouter?: { from: 'fetched' | 'shipped' | 'none'; at: string | null; rows: CatalogRow[] };
  ollama?: { state: 'reading' | 'listed' | 'failed'; where: string; rows: CatalogRow[]; at?: string; why?: string; cloud?: number };
  providers?: ProviderState[];
}

/** OpenRouter's catalog (its public /api/v1/models answer, as Timmy keeps it) as rows: H169's openRouterRow. */
export function railCatalog(models: readonly OpenRouterCatalogModel[]): CatalogRow[] {
  return models.map(openRouterRow);
}

/** What the local Ollama lists (the setup's own request, src/workbench/setup-paths.ts ollama: a name and its facts in words),
 *  as rows: installed (it lists them) and local; no charge; what it does not say, unknown. */
export function ollamaRows(models: ReadonlyArray<{ name: string; facts: string; chat?: boolean | null }>): CatalogRow[] {
  return models.map((m) => ({ source: 'ollama-local' as const, id: m.name, name: m.name, maker: m.name.split(/[:/]/)[0] ?? 'unknown', price: { inPerM: 0, outPerM: 0, free: true }, caps: {}, installed: true, facts: m.facts, ...(m.chat !== undefined ? { chat: m.chat } : {}) } as CatalogRow & { facts: string; chat?: boolean | null }));
}

/** Whether a row can answer a chat: false where the probe's /api/show check did not establish it (a local row's `chat`). */
export const chatModel = (r: CatalogRow): boolean => (r as CatalogRow & { chat?: boolean | null }).chat !== false;

/** A local row's facts as the setup's list words them (absent on a catalog row). */
const factsOf = (r: CatalogRow): string | undefined => (r as CatalogRow & { facts?: string }).facts;

/** The host of an Ollama address, as the words say it ("127.0.0.1:11434"). */
const hostOf = (origin: string | undefined): string => (origin ?? 'Ollama').replace(/^https?:\/\//, '').replace(/\/+$/, '');

/**
 * R11 (H167; step 1a): what the row of the local model last chosen says beside its name, from its readiness check (H170's
 * checkLocalModel, asked on Enter): checking while Ollama is asked; the reason when it was not chosen (nothing saved); nothing
 * once it is ready (the row's facts stand, and the chip says ready). Words with every state (B10), ✕ with a refusal: `long`
 * with the cause or the address, `short` where a row has no room for it (H170's whole words stand under the row then).
 */
export function checkRowWords(ck: NonNullable<Ui['modelCheck']>): { long: string; short: string; role: Role } | null {
  switch (ck.state) {
    case 'checking': return { long: 'checking with Ollama…', short: 'checking…', role: 'attention' };
    case 'not-a-chat-model': return { long: `✕ not a chat model: ${ck.why === 'cloud-tag' || ck.why === 'remote' ? 'cloud-backed' : ck.why === 'invalid-name' ? 'not a name Ollama lists' : 'no completion capability'}`, short: '✕ not a chat model', role: 'failure' };
    case 'not-installed': return { long: `✕ not installed: ollama pull ${ck.model}`, short: '✕ not installed', role: 'failure' };
    case 'unreachable': return { long: `✕ Ollama did not answer at ${hostOf(ck.origin)}`, short: '✕ no answer from Ollama', role: 'failure' };
    default: return null;
  }
}

/** H169's queryCatalog: the rows that match, sorted; the source's makers (for the Maker control). */
export function queryRows(rows: readonly CatalogRow[], q: CatalogQuery): { rows: CatalogRow[]; total: number; makers: MakerOption[] } {
  const r = queryCatalog(rows, q);
  return { rows: r.rows, total: r.total, makers: r.makers };
}

/** R10 CHAT (H167; H168's pass 3a, R3): the controls above Models' OpenRouter list, in their order (ui.modelsControl), and the
 *  values ← → and Enter go through. */
export const MODEL_CONTROLS = ['search', 'sort', 'maker', 'capability', 'cost', 'context'] as const;
export const SORT_VALUES: ReadonlyArray<NonNullable<Ui['modelsSort']>> = ['recent', 'name', 'price', 'context'];
export const CAP_VALUES: ReadonlyArray<NonNullable<Ui['modelsCap']> | ''> = ['', 'tools', 'vision', 'reasoning'];
export const COST_VALUES: ReadonlyArray<'all' | 'free' | 'paid'> = ['all', 'free', 'paid'];
export const CONTEXT_VALUES: readonly number[] = [0, 32_000, 128_000, 256_000, 1_000_000];
const contextShort = (n: number): string => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

/** A context length in words ("262k context", "1M context"); unknown when the list does not say. */
export const ctxWords = (n?: number): string => (n === undefined ? 'context unknown' : n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M context` : n >= 1e3 ? `${Math.round(n / 1e3)}k context` : `${n} context`);

/** A price per million tokens in dollars ("$0", "$0.15", "$15"). */
const usd = (n: number): string => `$${n === 0 ? '0' : n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/** A price in a few words: Free (both 0), "$0.15 / $0.60" (input / output per million tokens), or unknown. */
export function priceWords(p: CatalogRow['price'], local = false): string {
  if (local) return 'no charge (local)';
  if (p.free === true) return 'Free';
  if (p.inPerM === undefined || p.outPerM === undefined) return 'price unknown';
  return `${usd(p.inPerM)} / ${usd(p.outPerM)}`;
}

/** The four providers, in the target's order and words. */
export const PROVIDERS: ReadonlyArray<{ id: NonNullable<Ui['modelsProvider']>; label: string; short: string }> = [
  { id: 'openrouter', label: 'OpenRouter', short: 'OpenRouter' },
  { id: 'ollama-local', label: 'Ollama local', short: 'Local' },
  { id: 'ollama-cloud', label: 'Ollama cloud', short: 'Cloud' },
  { id: 'cloudflare', label: 'Cloudflare (optional)', short: 'Cloudflare' },
];

/** The provider Models shows: the person's choice, else the next turn's route's. */
export function railProvider(c: Pick<ShellCtx, 'ui' | 'data'>): NonNullable<Ui['modelsProvider']> {
  return c.ui.modelsProvider ?? (c.data.route.kind === 'local' ? (/cloud/i.test(routeLine(c.data).where) ? 'ollama-cloud' : 'ollama-local') : 'openrouter');
}

/** Models' Cost filter now: the person's choice, else free where the next turn's route is free-only, else all. */
export function railCost(c: Pick<ShellCtx, 'ui' | 'data'>): 'free' | 'all' | 'paid' {
  // (R10 CHAT H167; H168's pass 3c, R17b: and while no OpenRouter model is chosen, the free ones to start with, every launch)
  return c.ui.modelsCost ?? (/\bfree-only\b/.test(c.data.route.words) || noModelChosen(c.data.route) ? 'free' : 'all');
}

const makerWords = (makers: readonly MakerOption[], id: string): string => {
  const m = makers.find((x) => x.id === id);
  return m && makers.filter((x) => x.label === m.label).length === 1 ? m.label : id;
};

/** R10 CHAT (H167; H168's pass 3a, R3): each control's value in words: Cost says whether it is the default or the route's. */
export function controlWords(c: Pick<ShellCtx, 'ui' | 'data'>, makers: readonly MakerOption[]): Record<(typeof MODEL_CONTROLS)[number], string> {
  const { ui } = c;
  const cost = railCost(c);
  const set = ui.modelsCost !== undefined;
  return {
    search: ui.modelsSearch ?? '',
    sort: ui.modelsSort ?? 'recent',
    // (a maker's label, or its id where another maker has the same label: two makers never read the same)
    maker: ui.modelsMaker ? makerWords(makers, ui.modelsMaker) : 'All',
    capability: ui.modelsCap ?? 'All',
    // (R10 CHAT H167; H168's pass 3b, R17: after a key is saved Models starts on the free ones: "Free (start)")
    cost: cost === 'free' ? (ui.modelsCostStart ? 'Free (start)' : set ? 'Free only' : /\bfree-only\b/.test(c.data.route.words) ? 'Free (route)' : 'Free (start)') : cost === 'paid' ? 'Paid' : set ? 'All' : 'All (default)',
    context: ui.modelsContext ? `${contextShort(ui.modelsContext)} or more` : 'All',
  };
}

/** R10 CHAT (H167): the row of Models' list the cursor is on, as drawn: the person's, else the next turn's model's, else the first
 *  (Enter and the arrows use this one: the one the person sees). -1: none listed. */
export function railCursor(c: Pick<ShellCtx, 'ui' | 'data'>): number {
  const { rows } = modelRows(c);
  if (!rows.length) return -1;
  const model = routeLine(c.data).model;
  return Math.max(0, Math.min(rows.length - 1, c.ui.cursor['right:models'] ?? Math.max(0, rows.findIndex((r) => r.id === model))));
}

/** The rows Models lists now (the provider's, as its query asks: the sort, the search and the Cost filter its rows say). */
export function modelRows(c: Pick<ShellCtx, 'ui' | 'data'>): { rows: CatalogRow[]; total: number; source: ModelSource | null; makers: MakerOption[] } {
  const p = railProvider(c);
  const m = c.data.models;
  if (p === 'cloudflare') return { rows: [], total: 0, source: null, makers: [] };
  const source: ModelSource = p;
  const all = source === 'openrouter' ? m?.openrouter?.rows ?? [] : source === 'ollama-local' ? m?.ollama?.rows ?? [] : [];
  // (R10 CHAT H167; H168's pass 3a, R3: OpenRouter's controls are H169's query: the sort, the search and the four filters)
  const or = source === 'openrouter';
  const cost = or ? railCost(c) : 'all';
  const q = queryRows(all, {
    // (H168's pass 3c, R23: Search is OpenRouter's, as its row is: the local list is never filtered by a search it does not show)
    source, sort: or ? (c.ui.modelsSort ?? 'recent') : 'name', ...(or && c.ui.modelsSearch ? { search: c.ui.modelsSearch } : {}),
    ...(or && c.ui.modelsMaker ? { maker: c.ui.modelsMaker } : {}), ...(or && c.ui.modelsCap ? { capability: c.ui.modelsCap } : {}),
    ...(or && c.ui.modelsContext ? { minContext: c.ui.modelsContext } : {}), ...(cost !== 'all' ? { cost } : {}),
  });
  return { rows: q.rows, total: q.total, source, makers: q.makers };
}

/** The catalog's date, as the target says it ("Sep 7"). */
const shortDate = (ymd: string | null | undefined): string => {
  if (!ymd) return 'unknown';
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ymd;
};

/** A string cut into pieces of `w` (an id whole over several rows). */
const chunks = (s: string, w: number): string[] => { const out: string[] = []; for (let k = 0; k < s.length; k += Math.max(1, w)) out.push(s.slice(k, k + Math.max(1, w))); return out.length ? out : ['']; };

/**
 * Models' rows (`n` of them, `w` cells each): MODELS and [ Details ] (or [ Close ] as a drawer); the four providers ("> " the
 * one shown, amber); for OpenRouter, Search and the five label/value rows (Sort recent, Maker, Capability, Cost, Context) and a
 * rule; for Ollama local, what it lists (installed) and when it was read; the list (name, then "context / price"; the next
 * turn's model says so); a rule and SELECTED / <model> with its description, its prices and the data's date. With Details
 * open (i), the selected model's every known field in place of the list; Ollama cloud and Cloudflare say what they are and
 * that they are not set up here. As the drawer (below WIDE_COLUMNS; the target's 06-models-drawer-80x24): a rule under its
 * title, the providers on one row, the label/value pairs two a row, the list one row a model and no SELECTED block (Details,
 * i, shows the selected model's every field).
 */
function modelsLines(c: ShellCtx, n: number, w: number, focused: boolean, drawer: boolean): { lines: Line[]; items: View['items']; listFrom: number; listRows: number; perItem: number } {
  const { g, data, ui } = c;
  const rt = routeLine(data);
  const lines: Line[] = Array.from({ length: n }, (): Line => []);
  const put = (row: number, line: Line): void => { if (row >= 0 && row < n) lines[row] = trimTo(line, w, g.ellipsis); };
  const p = railProvider(c);
  // (R10 CHAT H167; H168's pass 3a, R7: its key on screen, [M], a target the mouse presses too)
  const head: Line = [S('MODELS', focused ? 'accent' : 'strong', { bold: true }), ...(drawer ? [] : [S(' [M]', 'secondary')])];
  const button = drawer ? '[ Close ]' : ui.modelsDetails ? '[ List ]' : '[ Details ]';
  put(1, [...head, S(' '.repeat(Math.max(1, w - lineCells(head) - button.length))), S(button, drawer ? 'accent' : 'secondary')]);
  // the shown provider's state (H170's providerStates: files and observations only, nothing asked), its word on the row under
  // the title: green only for a passed check, with its time
  const ps = data.models?.providers?.find((x) => x.id === p);
  // (the local Ollama's own answer to Models' listing is the newest observation of it: an answer now is live, green, whatever
  // the program's install says; no answer is said so)
  const heard = p === 'ollama-local' ? data.models?.ollama : undefined;
  // (R10 CHAT H167; H168's pass 3b, R21: who answered, said: "Ollama answered 21:59" is the local Ollama answering Models' list,
  // not a turn's time; a key's check is the key's)
  const checkedWho = p === 'ollama-local' ? 'Ollama ' : p === 'cloudflare' ? '' : 'key ';
  // (R11 H167, step 3; H168's pass 4a R27: while Ollama is being asked, the row says so, not the install's state from the files)
  const word: Seg | null = heard?.state === 'listed' ? S(`Ollama answered ${clock(heard.at ?? new Date(c.now).toISOString()).slice(0, 5)}`, 'live')
    : heard?.state === 'failed' ? S(`Ollama did not answer${heard.at ? ` ${clock(heard.at).slice(0, 5)}` : ''}`, 'failure')
    : heard?.state === 'reading' ? S('asking Ollama…', 'attention')
      : ps ? S(ps.state === 'checked' && ps.at ? `${checkedWho}checked ${clock(ps.at).slice(0, 5)}` : ps.state, ps.state === 'checked' ? 'live' : ps.state === 'refused' || ps.state === 'unreachable' ? 'failure' : 'secondary') : null;
  if (word && !drawer) put(2, [word]);
  const rule: Line = [S((g.unicode ? '─' : '-').repeat(w), 'border')];
  const mark = (on: boolean): Seg => S(on ? '> ' : '  ', 'accent');
  // R11 (H167; step 2; H168's pass 4a R30): on the first run, before a choice, the four providers and their states only: no
  // catalog rows and no cursor on a priced model; the center's question chooses, and that choice reads its list here
  if (isFirstRun(c) && ui.modelsProvider === undefined) {
    // (no [ Details ]: there is no list; the drawer keeps its [ Close ])
    put(1, drawer ? [...head, S(' '.repeat(Math.max(1, w - lineCells(head) - button.length))), S(button, 'accent')] : head);
    const stateOf = (id: string): Seg => {
      const st = data.models?.providers?.find((x) => x.id === id);
      if (id === 'ollama-local') {
        const h = data.models?.ollama;
        if (h?.state === 'listed') return S(`Ollama answered ${clock(h.at ?? new Date(c.now).toISOString()).slice(0, 5)}`, 'live');
        if (h?.state === 'failed') return S(`Ollama did not answer${h.at ? ` ${clock(h.at).slice(0, 5)}` : ''}`, 'failure');
        if (h?.state === 'reading') return S('asking Ollama…', 'attention');
      }
      if (!st) return S(id === 'ollama-local' ? 'not read yet' : 'not set up', 'secondary');
      return S(st.state === 'checked' && st.at ? `${id === 'ollama-local' ? 'Ollama' : 'key'} checked ${clock(st.at).slice(0, 5)}` : st.state, st.state === 'checked' ? 'live' : st.state === 'refused' || st.state === 'unreachable' ? 'failure' : 'secondary');
    };
    let row = drawer ? 3 : 3;
    if (drawer) put(2, rule);
    PROVIDERS.forEach((x) => {
      if (drawer) { put(row, [S('  '), S(x.label, 'text'), S('  '), stateOf(x.id)]); row += 1; }
      else { put(row, [S('  '), S(x.label, 'text')]); put(row + 1, [S('    '), stateOf(x.id)]); row += 2; }
    });
    wrapText('Choose how chat runs: the question in the center (Enter on a choice) reads that provider\'s models here.', w).forEach((t, k) => put(row + 1 + k, [S(t, 'secondary')]));
    return { lines, items: [], listFrom: n, listRows: 0, perItem: drawer ? 1 : 2 };
  }
  if (drawer) {
    put(2, rule);
    const provs: Line = [];
    PROVIDERS.forEach((x, k) => { if (k) provs.push(S('   ')); provs.push(mark(x.id === p), S(x.short, x.id === p ? 'accent' : 'text', x.id === p ? { bold: true } : {})); });
    put(3, provs);
  } else PROVIDERS.forEach((x, k) => put(3 + k, [mark(x.id === p), S(x.label, x.id === p ? 'accent' : 'text', x.id === p ? { bold: true } : {})]));
  const { rows, source } = modelRows(c);
  const m = data.models;
  const label = (k: string, v: string): Line => [S(k.padEnd(11), 'secondary'), S(v, 'text')];
  const freeOnly = /\bfree-only\b/.test(data.route.words);
  const footAt = drawer ? n : n - 7;
  const per = drawer ? 1 : 2;
  let at = drawer ? 4 : 8;
  if (p === 'cloudflare' || p === 'ollama-cloud') {
    // H170's words for it (what is set up, what a check would send, the next step), each wrapped; else the words this build has
    const words = ps ? [ps.words, ...(ps.lines ?? []), ...(ps.next ? [`Next: ${ps.next}`] : [])]
      : p === 'cloudflare' ? ['Optional. A Cloudflare AI Gateway can carry a provider\'s requests. Timmy sends nothing to Cloudflare to check it: a request there can create a gateway and bill.', 'Status: not set up']
        : ['Not set up here yet. Its models run on Ollama\'s computers, not this one; a key from Ollama sets it up.'];
    put(at, [S(p === 'cloudflare' ? 'CLOUDFLARE (optional)' : 'OLLAMA CLOUD', 'secondary', { bold: true })]);
    let row = at + 2;
    for (const para of words) {
      for (const t of wrapText(para, w)) { if (row >= n - 1) break; put(row, [S(t, 'secondary')]); row += 1; }
      row += 1;
    }
    return { lines, items: [], listFrom: n, listRows: 0, perItem: per };
  }
  // (R10 CHAT H167; H168's pass 3a, R3: the controls: the one the keyboard is on says so, its value between < >, in amber;
  // Search shows what is typed into it)
  const vals = controlWords(c, modelRows(c).makers);
  const onCtl = (k: (typeof MODEL_CONTROLS)[number]): boolean => focused && ui.modelsControl === MODEL_CONTROLS.indexOf(k);
  const typingSearch = ui.input.field === 'msearch';
  const searchRow: Line = typingSearch ? [S('Search ', 'accent', { bold: true }), S(ui.input.text, 'accent', { raw: true }), S(' ', 'text', { inverse: true })]
    : onCtl('search') ? [S('> ', 'accent'), S('Search ', 'accent', { bold: true }), S(vals.search || 'name or model id', vals.search ? 'accent' : 'secondary', { raw: true })]
      : vals.search ? [S('Search ', 'secondary'), S(vals.search, 'text', { raw: true })] : [S('Search name or model id', 'secondary')];
  const shown = (k: (typeof MODEL_CONTROLS)[number]): string => (onCtl(k) ? `< ${vals[k]} >` : vals[k]);
  const ctlSeg = (k: (typeof MODEL_CONTROLS)[number]): Seg => S(shown(k), onCtl(k) ? 'accent' : 'text', onCtl(k) ? { bold: true } : {});
  const ctlLabel = (name: string, k: (typeof MODEL_CONTROLS)[number]): Line => [S(name.padEnd(11), onCtl(k) ? 'accent' : 'secondary', onCtl(k) ? { bold: true } : {}), ctlSeg(k)];
  if (source === 'openrouter' && drawer) {
    // the drawer's pairs, two a row ("Sort: recent   Maker: All")
    const half = Math.max(18, Math.floor(w / 2) - 6);
    const pair = (a: [string, (typeof MODEL_CONTROLS)[number]], b?: [string, (typeof MODEL_CONTROLS)[number]]): Line => [S(`${a[0]}: `, onCtl(a[1]) ? 'accent' : 'secondary'), ctlSeg(a[1]), ...(b ? [S(' '.repeat(Math.max(2, half - a[0].length - 2 - shown(a[1]).length))), S(`${b[0]}: `, onCtl(b[1]) ? 'accent' : 'secondary'), ctlSeg(b[1])] : [])];
    put(at, searchRow);
    put(at + 2, pair(['Sort', 'sort'], ['Maker', 'maker']));
    put(at + 3, pair(['Capability', 'capability'], ['Cost', 'cost']));
    put(at + 4, pair(['Context', 'context']));
    put(at + 5, rule);
    at += 7;
  } else if (source === 'openrouter') {
    put(at, searchRow);
    put(at + 2, ctlLabel('Sort', 'sort'));
    put(at + 3, ctlLabel('Maker', 'maker'));
    put(at + 4, ctlLabel('Capability', 'capability'));
    put(at + 5, ctlLabel('Cost', 'cost'));
    put(at + 6, ctlLabel('Context', 'context'));
    put(at + 7, rule);
    at += 9;
  } else {
    const o = m?.ollama;
    put(at + 1, [S(o?.state === 'listed' ? `INSTALLED / read ${clock(o.at ?? new Date(c.now).toISOString()).slice(0, 5)}` : o?.state === 'reading' ? 'ASKING THE LOCAL OLLAMA' : o?.state === 'failed' ? `NO ANSWER${o.at ? ` / asked ${clock(o.at).slice(0, 5)}` : ''}` : 'NOT READ YET', 'secondary', { bold: true })]);
    // (R11 H167, step 2; H168's pass 4a R33: the next step under the failure's words: start Ollama, then r asks again)
    if (o?.state === 'failed') {
      const why = o.why ? wrapText(inWords(o.why), w).slice(0, 3) : [];
      why.forEach((t, k) => put(at + 2 + k, [S(t, 'failure')]));
      const next = wrapText(NO_ANSWER_NEXT, w).slice(0, 2);
      next.forEach((t, k) => put(at + 2 + why.length + k, [S(t, 'text')]));
      at += 3 + why.length + next.length;
    } else at += 3;
  }
  // the list, between `at` and the selected block (two rows a model; one in the drawer), scrolled so the cursor's rows show
  // (R11 H167, step 3; H168's pass 4a R34: the drawer keeps its last row for what the keys do: Enter chooses, r asks again)
  const listFrom = at;
  const listRows = Math.max(0, drawer ? n - 1 - at : footAt - 1 - at);
  const cur = railCursor(c);
  const list: Line[] = [];
  const items: View['items'] = [];
  rows.forEach((r, i) => {
    const on = focused && i === cur ? { selected: true } : {};
    const name = `${/\bfake\b/i.test(r.id) ? 'FAKE ' : ''}${r.name}`;
    items.push({ line: list.length, item: { kind: 'action', key: `model:${r.source}:${r.id}`, action: r.id }, rows: per });
    // (a name as the provider gives it: cut where the row ends, never dropped for a word that does not fit)
    const nameRow: Line = [S(i === cur ? '> ' : '  ', 'accent', on), S(name, i === cur ? 'accent' : chatModel(r) ? 'strong' : 'secondary', { ...(i === cur ? { bold: true } : {}), ...on, raw: true })];
    // a local model's facts without "local weights" (INSTALLED and the note below say where it runs; SELECTED keeps them whole);
    // one the probe's check does not establish as a chat model says so in their place
    const facts = chatModel(r) ? (factsOf(r) || 'installed').replace(/^local weights · /, '') : 'not a chat model';
    // context / price; where it does not fit beside the indent, the price's own spaces go, then the word "context"
    const price = priceWords(r.price);
    const room = drawer ? w - lineCells(nameRow) - 3 : w - 2;
    const forms = [`${ctxWords(r.contextLength)} / ${price}`, `${ctxWords(r.contextLength)} / ${price.replace(/ \/ /g, '/')}`, `${ctxWords(r.contextLength).replace(/ context$/, '')} / ${price.replace(/ \/ /g, '/')}`];
    // (R11 H167, step 1a: the row of the local model last chosen says its check: checking, or why it was not chosen)
    const ck = r.source === 'ollama-local' && ui.modelCheck?.model === r.id ? checkRowWords(ui.modelCheck) : null;
    const subRole: Role = ck ? ck.role : 'secondary';
    const sub = ck ? ([...ck.long].length <= room ? ck.long : ck.short) : r.source === 'ollama-local' ? facts : forms.find((t) => t.length <= room) ?? (drawer ? forms[forms.length - 1] : forms[0]);
    if (drawer) {
      // (one row: where the facts do not fit beside the whole name, the name is cut so that they do; never one without the other)
      const nameRoom = Math.max(8, w - 2 - 3 - [...sub].length);
      // (R10 CHAT H167; H168's pass 3b, R5b: cut where the room ends, by its words where that keeps most of it, else by its
      // characters: "FAKE…" alone, a long id after a short word dropped, is never the name)
      const byWords = cut(name, nameRoom, g.ellipsis);
      const shown = [...name].length <= nameRoom ? name : [...byWords].length >= nameRoom - 6 ? byWords : `${[...name].slice(0, nameRoom - 1).join('')}${g.ellipsis}`;
      list.push([nameRow[0], { ...nameRow[1], text: shown }, S(` / ${sub}`, subRole, on)]);
    } else list.push(nameRow, [S('  ', 'text', on), S(sub, subRole, on)]);
  });
  if (!rows.length) list.push([S(source === 'openrouter' ? (m?.openrouter ? (ui.modelsSearch ? 'No model matches.' : 'No catalog on this computer.') : 'Reading the catalog...') : m?.ollama?.state === 'listed' ? 'Ollama lists no model.' : '', 'secondary')]);
  // (under the local list, where it runs: drawn whole below the models shown, or not at all. R11 step 3; H168's pass 4a R34:
  // in the drawer, the refused check's whole words (H170's) first, in up to two rows: the MODEL block that holds them stands
  // only beside the conversation)
  const refused = drawer && source === 'ollama-local' && ui.modelCheck && ui.modelCheck.state !== 'ready' && ui.modelCheck.state !== 'checking' && rows.some((r) => r.id === ui.modelCheck?.model) ? ui.modelCheck : null;
  const reason: Line[] = refused ? wrapText(refused.words.replace(/\s+/g, ' '), w).slice(0, 2).map((t, k, all): Line => [S(k === all.length - 1 && wrapText(refused.words, w).length > 2 ? cut(`${t} ${wrapText(refused.words, w)[2]}`, w, g.ellipsis) : t, 'failure')]) : [];
  const tail: Line[] = [...reason, ...(source === 'ollama-local' && m?.ollama?.state === 'listed' ? wrapText('Runs on this computer. A local model does not require a cloud account.', w).map((t): Line => [S(t, 'secondary')]) : [])];
  // the list scrolled by whole models (a model's name never left above its facts, nor its facts without their name), the
  // cursor's in view
  const fits = Math.max(1, Math.floor(listRows / per));
  const top = cur >= 0 ? per * Math.max(0, Math.min(Math.max(0, Math.ceil((list.length - listRows) / per)), cur - fits + 1)) : 0;
  const shownRows = list.slice(top, top + (rows.length ? fits * per : listRows));
  const gap = shownRows.length + 2 + tail.length <= listRows ? 2 : shownRows.length + 1 + tail.length <= listRows ? 1 : -1;
  if (tail.length && gap > 0) shownRows.push(...Array.from({ length: gap }, () => blank), ...tail);
  // (the reason alone, where the sentence under it has no room)
  else if (reason.length && shownRows.length + 1 + reason.length <= listRows) shownRows.push(blank, ...reason);
  const picked = cur >= 0 ? rows[cur] : undefined;
  if (ui.modelsDetails && picked) {
    // Details: every field the record has, unknown said so, in place of the list and the selected block
    const caps = (k: 'tools' | 'vision' | 'reasoning'): string => (picked.caps[k] === undefined ? 'unknown' : picked.caps[k] ? 'yes' : 'no');
    const local = picked.source === 'ollama-local';
    const d: Line[] = [
      [S('DETAILS', 'strong', { bold: true })],
      ...chunks(picked.id, w - 3).map((t, k): Line => [S(k ? '   ' : 'id ', 'secondary'), S(t, 'text')]),
      label('Context', ctxWords(picked.contextLength).replace(/ context$/, '')),
      label('Input', local ? 'no charge' : picked.price.inPerM === undefined ? 'unknown' : `${usd(picked.price.inPerM)} / 1M tokens`),
      label('Output', local ? 'no charge' : picked.price.outPerM === undefined ? 'unknown' : `${usd(picked.price.outPerM)} / 1M tokens`),
      label('Tools', caps('tools')), label('Vision', caps('vision')), label('Reasoning', caps('reasoning')),
      label('Source', local ? 'the local Ollama' : m?.openrouter?.from === 'fetched' ? 'catalog fetched' : 'snapshot shipped'),
      ...(picked.description ? wrapText(picked.description.replace(/\s+/g, ' '), w).map((t): Line => [S(t, 'secondary')]) : []),
    ];
    d.slice(0, Math.max(0, n - listFrom)).forEach((l, k) => put(listFrom + k, l));
    return { lines, items: [], listFrom: n, listRows: 0, perItem: per };
  }
  shownRows.forEach((l, k) => put(listFrom + k, l));
  if (drawer) {
    // R34: the drawer's last row says what the keys do here (words, where the MODEL block's are not drawn)
    const keys = source === 'ollama-local' ? `Enter chooses ${g.sep} r asks Ollama again ${g.sep} Esc closes` : `Enter chooses ${g.sep} Esc closes`;
    put(n - 1, [S(keys, 'secondary')]);
    return { lines, items: items.map((x) => ({ ...x, line: x.line - top })), listFrom, listRows, perItem: per };
  }
  put(footAt, rule);
  // (R10 CHAT H167; H168's pass 3b, R17: with a key and no OpenRouter model chosen, MODEL / none while Models does not have the
  // keyboard: the cursor's row is not a choice)
  const noneChosen = noModelChosen(data.route) && !focused && source === 'openrouter';
  if (picked && !noneChosen) {
    // SELECTED / <model> only for the next turn's model (the lead's Mac check of 50237ef: with no route chosen the cursor's
    // model is not "selected"); any other the cursor is on is MODEL / <model>. One row when it fits, else the name below
    // (and a model the probe's check does not establish as a chat model is never SELECTED, even one the route names)
    const isNext = picked.id === rt.model;
    const head = isNext && chatModel(picked) ? 'SELECTED' : 'MODEL';
    const shownName = `${/\bfake\b/i.test(picked.id) ? 'FAKE ' : ''}${picked.name}`;
    const oneRow = `${head} / `.length + [...shownName].length <= w;
    put(footAt + 1, oneRow ? [S(`${head} / `, 'strong', { bold: true }), S(shownName, 'strong', { bold: true, raw: true })] : [S(head, 'strong', { bold: true })]);
    if (!oneRow) put(footAt + 2, [S(shownName, 'strong', { bold: true, raw: true })]);
    // (R11 H167, step 1a: the local model last chosen says its check here in full: H170's words, with the next step)
    const pk = picked.source === 'ollama-local' && ui.modelCheck?.model === picked.id && ui.modelCheck.state !== 'ready' ? ui.modelCheck : null;
    const about = pk ? pk.words : picked.description ?? (picked.source === 'ollama-local' ? factsOf(picked) ?? 'Installed; Ollama gives no description.' : 'No description in the catalog.');
    const aboutRows = wrapText(about.replace(/\s+/g, ' '), w);
    // (R11 H167, step 1a: a check that refused the model takes the rows the prices and the listing's time take otherwise:
    // H170's words whole where they fit, the last row cut)
    const room = pk ? (oneRow ? 5 : 4) : oneRow ? 2 : 1;
    const aboutRole: Role = pk ? (pk.state === 'checking' ? 'attention' : 'failure') : 'secondary';
    aboutRows.slice(0, room).forEach((t, k) => put(footAt + (oneRow ? 2 : 3) + k, [S(k === room - 1 && aboutRows.length > room ? cut(`${t} ${aboutRows[room]}`, w, g.ellipsis) : t, aboutRole)]));
    if (pk) return { lines, items: items.map((x) => ({ ...x, line: x.line - top })), listFrom, listRows, perItem: per };
    // whether the next turn uses it, or what keeps it from that (words, never colour alone)
    // (R10 CHAT H167; H168's pass 3b, R17: a priced model the next turn uses says so, with its price, before the first send;
    // with no OpenRouter model chosen, the cursor's is the one Enter would choose)
    const priced = picked.source === 'openrouter' && picked.price.free !== true && picked.price.inPerM !== undefined && picked.price.outPerM !== undefined;
    const note = !chatModel(picked) ? 'Not a chat model (checked).'
      : isNext ? (priced ? 'The next turn uses it, paid:' : 'The next turn uses it.')
      : noModelChosen(data.route) && picked.source === 'openrouter' ? 'None chosen: Enter picks it.'
      : picked.source === 'openrouter' && data.route.kind !== 'openrouter' ? 'Route is not OpenRouter yet.'
        : freeOnly && picked.price.free !== true ? 'Priced: not under free-only.'
          : focused ? 'Enter: next turn uses it.' : '';
    if (note) put(footAt + 4, [S(note, isNext ? 'text' : 'secondary')]);
    put(footAt + 5, [S(picked.source === 'ollama-local' ? (w >= 33 ? 'no charge / runs on this computer' : 'no charge / this computer') : picked.price.free === true ? '$0 in / $0 out / 1M tokens' : picked.price.inPerM === undefined || picked.price.outPerM === undefined ? 'price unknown' : `${usd(picked.price.inPerM)} in / ${usd(picked.price.outPerM)} out per 1M`, 'text')]);
    put(footAt + 6, [S(picked.source === 'ollama-local' ? `Listed by Ollama: ${clock(m?.ollama?.at ?? new Date(c.now).toISOString()).slice(0, 5)}` : `${m?.openrouter?.from === 'fetched' ? 'Catalog fetched' : 'Catalog snapshot'}: ${shortDate(m?.openrouter?.at)}`, 'secondary')]);
  } else if (rt.model) {
    // (R10 CHAT H167: no row for the next turn's model here, before its list is read or on another provider's: the route's
    // model is still the next turn's, said so; never "none")
    put(footAt + 1, [S('SELECTED', 'strong', { bold: true })]);
    put(footAt + 2, [S(`${rt.fake ? 'FAKE ' : ''}${rt.model}`, 'strong', { bold: true, raw: true })]);
    put(footAt + 3, [S(source === 'ollama-local' && m?.ollama?.state === 'failed' ? 'Not listed: no answer.' : source === 'ollama-local' && m?.ollama?.state !== 'listed' ? 'Not listed here yet.' : 'Not in this list: the route names it.', 'secondary')]);
  } else {
    put(footAt + 1, [S('MODEL / ', 'strong', { bold: true }), S('none', 'secondary')]);
    if (noneChosen) wrapText('No model is chosen for the next turn: M, then Enter on one.', w).slice(0, 3).forEach((t, k) => put(footAt + 2 + k, [S(t, 'attention')]));
  }
  return { lines, items: items.map((x) => ({ ...x, line: x.line - top })), listFrom, listRows, perItem: per };
}

// ── the bottom: this conversation's actions and the status row ─────────────────

/** A control of this conversation: its words, whether a capability backs it now, and what it needs when not. */
export interface ShellControl { id: string; label: string; count?: number; on: boolean; needs?: string }

/**
 * R11 (H167; step 3b, the plan's section 2): one compact row of this conversation's actions, each backed by a real capability
 * (or saying what it needs): Attach, Tools, Budget, Logs. Plan / Run, Permissions (what waits on you) and Cloudflare are
 * under Tools (its drawer's MORE CONTROLS); Stop lives in the composer ([ Stop ] during the turn, Esc there). Below
 * WIDE_COLUMNS: Tools, Budget and More (Attach and Logs under it).
 */
export function shellControls(c: Pick<ShellCtx, 'data'>, compact = false): ShellControl[] {
  const d = c.data;
  const all: ShellControl[] = [
    { id: 'attach', label: 'Attach', on: false, needs: 'the companion: the terminal attaches no files yet' },
    { id: 'tools', label: 'Tools', on: true, ...(d.decisions.total ? { count: d.decisions.total } : {}) },
    { id: 'budget', label: 'Budget', on: true },
    { id: 'logs', label: 'Logs', on: true },
  ];
  return compact ? [...all.filter((k) => ['tools', 'budget'].includes(k.id)), { id: 'more', label: 'More', on: true }] : all;
}

/** The controls under Tools' MORE CONTROLS: Plan / Run (Workflows), Permissions (the Control Room, with what waits on you),
 *  Cloudflare (Models on it). */
export function toolsControls(c: Pick<ShellCtx, 'data'>): ShellControl[] {
  const d = c.data;
  return [
    { id: 'plan', label: 'Plan / Run', on: true },
    { id: 'permissions', label: 'Permissions', on: true, ...(d.decisions.total ? { count: d.decisions.total } : {}) },
    { id: 'cloudflare', label: 'Cloudflare', on: true },
  ];
}

/**
 * R11 (H167; step 3e, H168's pass 3c R17c): the next turn's spend in a few words for the status row: no charge on a local
 * route; a priced OpenRouter model's prices in and out per million tokens ("$0.20 in / $0.80 out per 1M", from the route's
 * words); free; unknown said so; none with no model (nothing is sent, so nothing is spent).
 */
export function spendWords(rt: { model: string | null; price: string }): string {
  if (!rt.model) return 'none (no model)';
  if (/^no charge/.test(rt.price)) return 'no charge';
  const m = /\$([\d.]+) per million tokens in, \$([\d.]+) out/.exec(rt.price);
  if (m) return `$${m[1]} in / $${m[2]} out per 1M`;
  if (/^free\b/.test(rt.price)) return 'free';
  if (/not read here/.test(rt.price)) return 'as OpenRouter lists it';
  if (/^cost unknown|^unknown/.test(rt.price)) return 'unknown';
  return rt.price;
}

/** The bottom's three rows (from the separator's next column to the edge): a rule; the actions ("[Tools]", the selected one
 *  amber where the bottom has the keyboard); the status row: Logs: this computer / what runs, and at its right cloud sync off
 *  and the spend; a fresh notice in its place for its few seconds. */
function bottomRows(c: ShellCtx, grid: ChatGrid, focused: boolean): { lines: Line[]; items: View['items'] } {
  const { g, data, ui } = c;
  const w = grid.W - grid.railW - 1;
  const items: View['items'] = [];
  const ctls = shellControls(c, grid.W < WIDE_COLUMNS);
  const cur = Math.max(0, Math.min(ctls.length - 1, ui.cursor.shellBottom ?? 0));
  const acts: Line = [S(' ')];
  let x = 1;
  ctls.forEach((k, i) => {
    const sel = focused && i === cur;
    const words = `[${k.label}${k.count ? ` ${k.count}` : ''}]`;
    if (i) { acts.push(S('  ')); x += 2; }
    items.push({ line: 1, item: { kind: 'action', key: `ctl:${k.id}`, action: k.id }, x: { from: x, to: x + words.length - 1 } });
    acts.push(S(words, sel ? 'accent' : k.on ? 'text' : 'secondary', sel ? { bold: true, selected: true } : {}));
    x += words.length;
  });
  const turn = chatTurnNow(data);
  const runningN = data.activity.running + (turn ? 1 : 0);
  // (R11 step 3b, the plan's section 3: the status words in sentences, not slashes; R17c: a paid route's spend, short)
  const states = runningN ? [` ${g.sep} ${runningN} running${turn ? ` (the chat turn${turn.mine ? '' : ` in ${turn.where}`})` : ''}`, ` ${g.sep} ${runningN} running${turn && !turn.mine ? ` (in ${turn.where})` : ''}`, ` ${g.sep} ${runningN} running`] : [''];
  // (the state's fullest form that leaves the size its place at the row's end: at 80x24 "(the chat turn)" gives way)
  const state = states.find((t) => lineCells([S(`Logs stay on this computer${t}`)]) <= statusRoom(grid.W, grid.H)) ?? states[states.length - 1];
  const rt = routeLine(data);
  const spend = spendWords(rt);
  // (R11 H167, step 3; H168's pass 4a R39: a notice from before the turn being answered began gives way to "1 running (the chat
  // turn)"; one said during it stays its six seconds)
  const before = !!turn && !!ui.flash && !(ui.flash.whileTurn && ui.flash.whileTurn === turn.id) && ui.flash.at < Date.parse(turn.since);
  const fresh = ui.flash && !before && c.now - ui.flash.at < 6000 && (!ui.flash.whileTurn || turn?.id === ui.flash.whileTurn) ? ui.flash : null;
  const picked = ctls[cur];
  const left: Line = fresh ? [S(inWords(fresh.text), fresh.role)] : focused && picked && !picked.on && picked.needs ? [S(`${picked.label}: needs ${picked.needs}`, 'secondary')] : [S(`Logs stay on this computer${state}`, 'secondary')];
  // at its right: cloud sync off, the spend and the terminal's size (the target's), the spend left out where it does not fit
  const margin = grid.W >= WIDE_COLUMNS ? 8 : 3;
  const size = `${grid.W} x ${grid.H}`;
  const wordsR = [`cloud sync off ${g.sep} spend ${spend} ${g.sep} ${size}`, `cloud sync off ${g.sep} ${size}`].find((t) => lineCells(left) + 2 + t.length <= w - 1 - margin) ?? size;
  const right: Line = [S(wordsR, 'secondary')];
  // (the size stays at the row's right end whatever stands at its left: a notice too long is cut to leave it room)
  const room = Math.max(4, w - 1 - lineCells(right) - margin - 2);
  const shown = lineCells(left) <= room ? left : trimTo(left, room, g.ellipsis);
  const status: Line = [S(' '), ...shown, S(' '.repeat(Math.max(2, w - 1 - lineCells(shown) - lineCells(right) - margin))), ...right];
  return { lines: [[S(' '), S((g.unicode ? '─' : '-').repeat(Math.max(0, w - 1)), 'border')], acts, status], items };
}

/** R11 (H167; step 2, H172's finding 2): the most cells a notice has on the status row at this size (the size at its right end
 *  always; the spend and cloud sync give way to a long notice): the controller says a longer notice in more than one flash. */
export function statusRoom(W: number, H: number): number {
  const grid = chatGrid(W, H);
  const w = grid.W - grid.railW - 1;
  const margin = grid.W >= WIDE_COLUMNS ? 8 : 3;
  return Math.max(4, w - 1 - `${grid.W} x ${grid.H}`.length - margin - 2);
}

// ── the bottom's drawers: Logs, Budget and (below WIDE_COLUMNS) More ─────────────

/** Where a turn came from, in words ("here": this Workbench). */
const fromWords = (surface: string): string => (surface === 'workbench' ? 'here' : surface === 'repl' ? 'in the REPL' : `in the ${surface}`);

/** The controls More lists: the ones the compact row leaves out, in the row's order. */
export function moreControls(c: Pick<ShellCtx, 'data'>): ShellControl[] {
  return shellControls(c, false).filter((k) => !['tools', 'budget'].includes(k.id));
}

/**
 * The drawer a control of the bottom opened (`n` rows over the conversation's, `w` cells): its title and [ Close ], a rule,
 * then for Logs where the logs and records are kept and the project's recent turns (when, how each ended, the model, where it
 * was sent from; no receipt id: Logs & records has them) and Open Logs & records; for Budget the next turn's route and price,
 * free-only, and Open settings; for More the controls the compact row leaves out, as their buttons act (or what each needs).
 * The cursor's item is marked "> " and amber; Enter acts on it, Esc closes the drawer.
 */
export function shellDrawerLines(c: ShellCtx, n: number, w: number): { lines: Line[]; items: View['items'] } {
  const { g, ui, data } = c;
  const lines: Line[] = Array.from({ length: n }, (): Line => []);
  const items: View['items'] = [];
  const put = (row: number, line: Line): void => { if (row >= 0 && row < n) lines[row] = trimTo(line, w, g.ellipsis); };
  const which = ui.shellDrawer;
  const title = which === 'logs' ? 'LOGS / this computer' : which === 'budget' ? 'BUDGET / the next turn' : which === 'tools' ? 'TOOLS' : 'THIS CONVERSATION';
  put(1, [S(title, 'accent', { bold: true }), S(' '.repeat(Math.max(1, w - title.length - 9))), S('[ Close ]', 'accent')]);
  put(2, [S((g.unicode ? '─' : '-').repeat(w), 'border')]);
  const cur = ui.cursor.shellDrawer ?? 0;
  const choice = (row: number, k: number, id: string, label: string, after?: string): void => {
    const on = k === cur;
    const sel = on ? { selected: true } : {};
    items.push({ line: row, item: { kind: 'action', key: `drawer:${id}`, action: id } });
    put(row, [S(on ? '> ' : '  ', 'accent', sel), S(`[ ${label} ]`, on ? 'accent' : 'strong', on ? { bold: true, ...sel } : {}), ...(after ? [S(`  ${after}`, 'secondary')] : [])]);
  };
  if (which === 'logs') {
    wrapText('Logs and records stay on this computer; cloud sync is off. Each turn\'s receipt is sealed here.', w).slice(0, 2).forEach((t, k) => put(4 + k, [S(t, 'secondary')]));
    put(7, [S('RECENT TURNS', 'secondary', { bold: true })]);
    const turns = (data.turns ?? []).slice(0, Math.max(1, n - 12));
    if (!turns.length) put(8, [S('No turn is recorded in this project yet.', 'secondary')]);
    turns.forEach((t, k) => put(8 + k, [S(clock(t.at).slice(0, 5), 'secondary'), S('  '), S(t.state, t.state === 'failed' ? 'failure' : 'text'), S('  '), S(`${t.model && /\bfake\b/i.test(t.model) ? 'FAKE ' : ''}${t.model ?? 'model not recorded'}`, 'text'), S(`  ${fromWords(t.surface)}`, 'secondary')]));
    choice(n - 2, 0, 'open-logs', 'Open Logs & records', 'every receipt, run and log');
  } else if (which === 'budget') {
    const rt = routeLine(data);
    // (the policy as read with the route; its words where it was not read)
    const freeOnly = data.route.policy?.freeOnly ?? /\bfree-only\b/.test(data.route.words);
    const localOnly = data.route.policy?.localOnly ?? /\blocal-only\b/.test(data.route.words);
    put(4, [S('Next turn  ', 'secondary'), S(rt.model ? `${rt.fake ? 'FAKE ' : ''}${rt.model} / ${rt.price}` : 'no model: nothing is sent, nothing spent', 'text')]);
    put(5, [S('Free-only  ', 'secondary'), S(freeOnly ? 'on: a model the catalog does not price at 0 is not used' : 'off', 'text')]);
    put(6, [S('Local-only ', 'secondary'), S(localOnly ? 'on: no cloud route, fallback or tool model call' : 'off', 'text')]);
    // (R10 CHAT H167; the lead's 20:06 note: where each really switches: the REPL, or the environment; not this Workbench)
    wrapText('Each turn\'s cost is sealed on its receipt (Logs & records). Free-only and local-only switch in the REPL (timmy): /model free-only on|off and /model local-only on|off; TIMMY_CHAT_FREE_ONLY=1 or TIMMY_CHAT_LOCAL_ONLY=1 sets one for what runs with it. Settings here does not switch them.', w).slice(0, Math.max(1, n - 11)).forEach((t, k) => put(8 + k, [S(t, 'secondary')]));
    choice(n - 2, 0, 'settings', 'Open settings');
  } else if (which === 'tools') {
    // (R11 step 3b: Tools & integrations, the page; then the controls the compact row no longer carries, as their buttons act)
    choice(4, 0, 'open-tools', 'Open Tools & integrations', 'every tool and MCP server, its rung and its step');
    put(6, [S('MORE CONTROLS', 'secondary', { bold: true })]);
    toolsControls(c).forEach((k, i) => choice(7 + i, 1 + i, `ctl:${k.id}`, `${k.label}${k.count ? ` ${k.count}` : ''}`, k.id === 'plan' ? 'Workflows: the blocks, Enter runs one after it asks' : k.id === 'permissions' ? 'the Control Room: what waits on you' : 'Models on Cloudflare (optional)'));
    wrapText('Stop lives in the composer: [ Stop ] during the turn, or Esc there.', w).slice(0, 2).forEach((t, k) => put(11 + k, [S(t, 'secondary')]));
  } else {
    moreControls(c).forEach((k, i) => choice(4 + i, i, `ctl:${k.id}`, k.label, k.on ? undefined : `needs ${k.needs ?? 'what it names'}`));
  }
  return { lines, items };
}

// ── the composer, its action row and the model chip ─────────────────────────────

/** The composer's placeholder while nothing is typed. */
export const COMPOSER_PLACEHOLDER = 'Message TIMMY…';
/** The chord hint beside [ Send ] while the composer has the keyboard (the playbook §17.2: Enter submits, Ctrl+J inserts a
 *  newline; R11 step 2, the lead's Mac run: the way to Models from the composer, Tab to the chip and Enter there). */
export const SEND_HINT = 'Enter sends · Ctrl+J newline · Tab then Enter: Models';
/** Under NO ANSWER on Models' local list, and in Enter's notice there (R11 step 2; H168's pass 4a R33): the next step. */
export const NO_ANSWER_NEXT = 'Start Ollama (ollama serve), then r asks again.';
/** Beside [ Send ] while the composer lacks the keyboard (R11 step 2; H168's pass 4a R29): how it is opened. */
export const OPEN_HINT = 'Enter or a letter opens the composer';

/** A text as the composer's rows: each newline a row, a long row cut into pieces of `room` cells. */
function textRows(text: string, room: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const cs = [...para];
    if (!cs.length) { out.push(''); continue; }
    for (let i = 0; i < cs.length; i += Math.max(1, room)) out.push(cs.slice(i, i + Math.max(1, room)).join(''));
  }
  return out.length ? out : [''];
}

/**
 * R11 (H167; step 1c): the model chip at the composer's right: the next turn's model, where it runs and its readiness, in
 * words with a dot (DESIGN.md B10: never colour alone): ● amber while Ollama is asked, ● green only after Ollama (or the
 * key's check) answered, with that answer's time; ○ grey when nothing answered yet; ✕ with the word on a failure. The
 * readiness of a local model is Ollama's own answer: the choice's check (ui.modelCheck), else the /api/show answer Models'
 * listing got for that exact name; a cloud model's is the key check's (H170's providerStates). "○ no model · choose one"
 * with none. The name is cut to the room, never the state.
 */
export interface ModelChip { glyph: '●' | '○' | '✕'; tone: Role; words: string; state: 'checking' | 'ready' | 'failed' | 'unknown' | 'none' }

export function modelChip(c: Pick<ShellCtx, 'ui' | 'data'>, room = 200): ModelChip {
  const { ui, data } = c;
  const rt = routeLine(data);
  const at = (iso: string | number | undefined): string => clock(typeof iso === 'number' ? new Date(iso).toISOString() : iso).slice(0, 5);
  // (the name cut to the room: by its words where that keeps most of it, else by its characters: "FAKE…" alone is never the
  // name, as R5b found in the drawer)
  const fitName = (name: string, tail: string): string => {
    const nameRoom = Math.max(6, room - 2 - [...tail].length);
    if ([...name].length <= nameRoom) return `${name}${tail}`;
    const byWords = cut(name, nameRoom, '…');
    return `${[...byWords].length >= nameRoom - 6 ? byWords : `${[...name].slice(0, nameRoom - 1).join('')}…`}${tail}`;
  };
  // (a choice being checked is the chip's while Ollama is asked, whatever the route's model is until it answers)
  const asking = ui.modelCheck;
  if (asking?.state === 'checking') return { glyph: '●', tone: 'attention', words: fitName(`${/\bfake\b/i.test(asking.model) ? 'FAKE ' : ''}${asking.model}`, ' · this computer · checking…'), state: 'checking' };
  if (!rt.model) return { glyph: '○', tone: 'secondary', words: data.route.unchosen ? 'no model chosen · choose one (M)' : 'no model · choose one (M)', state: 'none' };
  const name = `${rt.fake ? 'FAKE ' : ''}${rt.model}`;
  if (data.route.kind === 'local') {
    const where = /cloud/i.test(rt.where) ? 'Ollama cloud' : /another computer/.test(rt.where) ? 'another computer' : 'this computer';
    const ck = ui.modelCheck?.model === rt.model ? ui.modelCheck : null;
    const o = data.models?.ollama;
    const row = o?.rows.find((r) => r.id === rt.model) as (CatalogRow & { chat?: boolean | null }) | undefined;
    const said = (state: 'checking' | 'ready' | 'failed' | 'unknown', word: string): ModelChip => {
      const gl = localModelGlyph(state === 'checking' ? 'checking' : state === 'ready' ? 'ready' : state === 'unknown' ? 'unknown' : 'unreachable');
      return { glyph: state === 'failed' ? '✕' : gl.glyph, tone: state === 'failed' ? 'failure' : gl.tone, words: fitName(name, ` · ${where} · ${word}`), state };
    };
    if (ck?.state === 'ready') return said('ready', `ready ${at(ck.at)}`);
    if (ck) return said('failed', localModelGlyph(ck.state).word);
    if (o?.state === 'listed' && row?.chat === true) return said('ready', `ready ${at(o.at)}`);
    if (o?.state === 'listed' && row?.chat === false) return said('failed', 'not a chat model');
    if (o?.state === 'listed' && !row) return said('failed', 'not listed by Ollama');
    if (o?.state === 'failed') return said('failed', 'unreachable');
    if (o?.state === 'reading') return said('checking', 'checking…');
    return said('unknown', 'not checked');
  }
  if (data.route.kind === 'openrouter') {
    const row = data.models?.openrouter?.rows.find((r) => r.id === rt.model);
    const price = row ? (row.price.free === true ? 'free' : row.price.inPerM === undefined || row.price.outPerM === undefined ? 'price unknown' : `${usd(row.price.inPerM)} in / ${usd(row.price.outPerM)} out per 1M`) : /^free/.test(rt.price) ? 'free' : 'price not read';
    const ps = data.models?.providers?.find((x) => x.id === 'openrouter');
    const checked = ps?.state === 'checked' && ps.at;
    const failed = ps?.state === 'refused' || ps?.state === 'unreachable';
    const word = checked ? `key checked ${at(ps.at)}` : failed ? `key ${ps.state}` : 'key saved, not checked';
    return { glyph: checked ? '●' : failed ? '✕' : '○', tone: checked ? 'live' : failed ? 'failure' : 'secondary', words: fitName(name, ` · OpenRouter · ${price} · ${word}`), state: checked ? 'ready' : failed ? 'failed' : 'unknown' };
  }
  return { glyph: '○', tone: 'secondary', words: fitName(name, ` · ${rt.where} · not checked`), state: 'unknown' };
}

/** The chip as a row's segments (amber words while it has the keyboard; its dot keeps its tone). */
function chipLine(c: ShellCtx, room: number, focused: boolean): Line {
  const chip = modelChip(c, room);
  return [S(chip.glyph, chip.tone, chip.state === 'ready' ? { bold: true } : {}), S(' '), S(chip.words, focused ? 'accent' : 'text', focused ? { bold: true, selected: true } : { raw: true })];
}

/**
 * R11 (H167; step 1b): the composer nobody can miss (the playbook's `block` input, §17.2): tinted rows (Seg.block; the tint
 * from the terminal's own background, none without colour) with "› " (amber while the composer has the keyboard) and an
 * inverse cursor cell; two rows at the target's 122x37, one at 80x24, always drawn, never dim; "Message TIMMY…" while
 * nothing is typed; the draft kept shows in it when the composer is left. Below: [ Send ] amber while a model is on the
 * route and no turn runs (dim with the reason otherwise: an unsafe Send is disabled, never sent on an unchosen model), the
 * chord hint "Enter sends · Ctrl+J newline", [ Stop ] during this Workbench's own turn; the model chip (modelChip) at the
 * right of that row where it fits (122x37), on its own row below it (80x24). `chip`: where the chip is drawn (row of these
 * lines, cells from the row's start), for the click.
 */
function composerRows(c: ShellCtx, w: number, wide: boolean): { lines: Line[]; chip: { row: number; x0: number; x1: number } } {
  const { g, ui, data } = c;
  const typing = ui.input.field === 'composer';
  const turn = chatTurnNow(data);
  const answering = !!turn?.mine || data.turn?.state === 'sending';
  const rt = routeLine(data);
  const B = (text: string, role: Role = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Seg => S(text, role, { ...o, block: true });
  const pad = (line: Line): Line => { const used = lineCells(line); return used < w ? [...line, B(' '.repeat(w - used))] : line; };
  const inputRows = wide ? 2 : 1;
  const text = typing ? ui.input.text : ui.draft ?? '';
  const room = Math.max(4, w - 2);
  const rows = textRows(text, room);
  // (the cursor on the next row once a row is full)
  if (typing && text && [...rows[rows.length - 1]].length >= room) rows.push('');
  const shown = rows.slice(-inputRows);
  const more = rows.length > inputRows;
  const lines: Line[] = [];
  for (let k = 0; k < inputRows; k++) {
    const r = shown[k];
    const first = k === 0;
    const last = k === shown.length - 1;
    const prompt: Seg = first ? B('› ', typing ? 'accent' : 'text', typing ? { bold: true } : {}) : B('  ');
    if (r === undefined) { lines.push(pad([prompt])); continue; }
    const segs: Line = [prompt];
    if (!text) segs.push(...(typing ? [B(' ', 'text', { inverse: true })] : []), B(COMPOSER_PLACEHOLDER, 'secondary'));
    else {
      const body = first && more ? `${g.ellipsis}${[...r].slice(1).join('')}` : r;
      segs.push(B(body, 'text', { raw: true }));
      if (typing && last) segs.push(B(' ', 'text', { inverse: true }));
    }
    lines.push(pad(segs));
  }
  const on = rt.ready && !!rt.model && !data.route.unchosen;
  const send: Line = answering
    ? [S('[ Stop ]', 'accent', { bold: true }), S('  Esc stops the turn being answered', 'secondary')]
    : [S('[ Send ]', on ? 'accent' : 'secondary', on ? { bold: true } : {}), S(on ? `  ${typing ? SEND_HINT : OPEN_HINT}` : rt.model ? '  not sent: the route is not ready' : data.route.unchosen ? '  no model chosen: M chooses one' : '  no model: M chooses one', 'secondary')];
  const chipFocus = ui.chip === true && ui.focus === 'center' && !typing;
  // (the chip whole: at the Send row's right where both fit (a terminal wider than the target's: at 122x37 the center's 69
  // cells hold the hint or the chip, not both), else on the row under it, flush left)
  const chip = chipLine(c, w, chipFocus);
  const cells = lineCells(chip);
  if (wide && cells + 1 + lineCells(send) <= w) {
    lines.push(spread(send, chip, w, g.ellipsis), blank);
    return { lines, chip: { row: inputRows, x0: w - cells, x1: w - 1 } };
  }
  lines.push(send, trimTo(chip, w, g.ellipsis));
  return { lines, chip: { row: inputRows + 1, x0: 0, x1: Math.min(w, cells) - 1 } };
}

// ── the first run, and Chat with no model ──────────────────────────────────────

/** The first run: the Chat screen asks how chat runs while the next turn has no model and the question is not answered in this
 *  Workbench (a choice, or Continue without a model; Review setup choices asks it again). */
export function isFirstRun(c: Pick<ShellCtx, 'ui' | 'data'>): boolean {
  // (R10 CHAT H167, the lead's ask for the Mac: a relaunch after an answered turn shows that conversation, model or not)
  // (R10 CHAT H167; H168's pass 3b, R17: with a key and no model chosen, the next step is a model, not how chat runs)
  return !routeLine(c.data).model && !noModelChosen(c.data.route) && c.ui.firstRunDone !== true && !c.data.chat.messages.length && !c.data.turn;
}

/** Chat with no model and nothing in its conversation yet (after the first run's question): what it needs, said once. */
export function noModelNow(c: Pick<ShellCtx, 'ui' | 'data'>): boolean {
  return !isFirstRun(c) && !routeLine(c.data).model && !c.data.chat.messages.length && !c.data.turn;
}

/** The first run's choices, in the target's words where they are true (R10 CHAT H167: OpenRouter's is connected here, by its
 *  sign-in in a browser or a key pasted into a hidden field: the controller's Connect OpenRouter box), each opening its own
 *  setup; Cloudflare only as the advanced one. */
export const FIRST_CHOICES: ReadonlyArray<{ id: string; label: string; about: string; advanced?: boolean }> = [
  { id: 'openrouter', label: 'OpenRouter / cloud', about: 'Sign in with OpenRouter in your browser, or paste a key.' },
  { id: 'ollama-local', label: 'Ollama / this computer', about: 'Use installed models; no cloud account needed.' },
  { id: 'ollama-cloud', label: 'Ollama / cloud', about: 'Remote models; no local weights required.' },
  { id: 'explore', label: 'Continue without a model', about: 'Explore files, setup and local records.' },
  { id: 'cloudflare', label: 'Advanced: Cloudflare (optional)', about: 'A gateway in front of a provider; Timmy sends it nothing to check.', advanced: true },
];

/** The Timmy guide (deterministic: no model writes it): what each choice needs, the official pages, and what is set up here,
 *  each in words. */
function guideLines(c: ShellCtx, w: number): Line[] {
  const rt = routeLine(c.data);
  const para = (t: string): Line[] => wrapText(t, w).map((x): Line => [S(x, 'text')]);
  const item = (on: boolean, words: string): Line => [S(on ? '[x] ' : '[ ] ', 'secondary'), S(words, on ? 'text' : 'secondary')];
  return [
    [S('TIMMY GUIDE', 'strong', { bold: true })],
    ...para('OpenRouter: an account. Sign in here (OpenRouter\'s own page, in your browser), or paste a key made at https://openrouter.ai/keys; it is kept in providers.json in the Timmy home (0600).'),
    ...para('Ollama on this computer: the app (https://ollama.com/download) and a model it lists; Models shows them here.'),
    ...para('Ollama cloud: an Ollama account (https://ollama.com); Timmy does not set it up yet.'),
    item(true, 'Logs and records on this computer'),
    item(!!rt.model, rt.model ? `A model for the next turn: ${rt.fake ? 'FAKE ' : ''}${rt.model}` : 'A model for the next turn'),
  ];
}

/**
 * The first run's rows for the center from its first conversation row (`rows` of them, `w` cells): the question, the choices
 * ("> " and amber where the cursor is while the center has the keyboard), each with what it is, the advanced one, the guide's
 * Show / Hide (its text after it while shown) and the note on logs and cloud sync; where they do not fit, the blank rows
 * between the choices go first (the target's 80x24), then the advanced choice's words, the note, the choices' words.
 */
export function firstRunLines(c: ShellCtx, w: number, rows: number, focused: boolean): { lines: Line[]; items: View['items'] } {
  const ids = [...FIRST_CHOICES.map((x) => x.id), 'guide'];
  const cur = Math.max(0, Math.min(ids.length - 1, c.ui.cursor['center:first'] ?? 0));
  const build = (o: { gaps: boolean; advAbout: boolean; note: boolean; abouts: boolean }): { lines: Line[]; items: View['items'] } => {
    const lines: Line[] = [[S('How would you like to run chat?', 'strong', { bold: true })], [S('Choose one. You can add the others later.', 'secondary')], blank];
    const items: View['items'] = [];
    const choice = (id: string, label: string, about: string | null): void => {
      const on = focused && ids[cur] === id;
      const sel = on ? { selected: true } : {};
      items.push({ line: lines.length, item: { kind: 'action', key: `first:${id}`, action: id }, rows: about ? 2 : 1 });
      lines.push([S(on ? '> ' : '  ', 'accent', sel), S(`[ ${label} ]`, on ? 'accent' : 'strong', on ? { bold: true, ...sel } : {})]);
      if (about) lines.push([S('  ', 'text', sel), S(about, 'secondary', sel)]);
    };
    FIRST_CHOICES.forEach((x, k) => {
      if (k && o.gaps) lines.push(blank);
      choice(x.id, x.label, x.advanced ? (o.advAbout ? x.about : null) : o.abouts ? x.about : null);
    });
    if (o.gaps) lines.push(blank);
    choice('guide', c.ui.guide ? 'Hide the Timmy guide' : 'Show the Timmy guide', null);
    if (c.ui.guide) lines.push(blank, ...guideLines(c, w));
    if (o.note) lines.push(blank, ...wrapText('Local logs are included; cloud sync is optional and off.', w).map((t): Line => [S(t, 'secondary')]));
    return { lines, items };
  };
  const tries = [
    { gaps: true, advAbout: true, note: true, abouts: true },
    { gaps: false, advAbout: true, note: true, abouts: true },
    { gaps: false, advAbout: false, note: true, abouts: true },
    { gaps: false, advAbout: false, note: false, abouts: true },
    { gaps: false, advAbout: false, note: false, abouts: false },
  ];
  for (const t of tries) { const b = build(t); if (b.lines.length <= rows) return b; }
  const b = build(tries[tries.length - 1]);
  return { lines: b.lines.slice(0, rows), items: b.items.filter((x) => x.line < rows) };
}

/** Chat with no model and an empty conversation: a model is needed only for an answer; Choose a model (Models has the
 *  keyboard) and Review setup choices (the first run's question again). The composer keeps a draft below. */
export function noModelLines(c: ShellCtx, w: number, focused: boolean): { lines: Line[]; items: View['items'] } {
  const ids = ['models', 'review', 'draft'];
  const cur = Math.max(0, Math.min(ids.length - 1, c.ui.cursor['center:first'] ?? 0));
  const lines: Line[] = [
    [S('A model is optional until you need an answer.', 'strong', { bold: true })],
    ...wrapText('Project files, logs and records work without one; what you write is kept as a draft until a model is chosen.', w).map((t): Line => [S(t, 'secondary')]),
    blank,
    // (R10 CHAT H167; H168's pass 3b, R17: a key saved chooses no model; Models starts on OpenRouter's free ones)
    ...(noModelChosen(c.data.route) ? [...wrapText('OpenRouter\'s key is saved, and no model is chosen for the next turn: Choose a model opens Models on OpenRouter, Cost Free only to start with.', w).map((t): Line => [S(t, 'text')]), blank] : []),
  ];
  const items: View['items'] = [];
  [['models', 'Choose a model'], ['review', 'Review setup choices'], ['draft', 'Write a draft']].forEach(([id, label]) => {
    const on = focused && ids[cur] === id;
    items.push({ line: lines.length, item: { kind: 'action', key: `first:${id}`, action: id }, rows: 1 });
    lines.push([S(on ? '> ' : '  ', 'accent', on ? { selected: true } : {}), S(`[ ${label} ]`, on ? 'accent' : 'strong', on ? { bold: true, selected: true } : {})]);
  });
  return { lines, items };
}

// ── the welcome: an empty conversation with a model on the route ───────────────

/**
 * R11 (H167; step 2a, the plan's section 2 "Empty conversation"): the welcome, in the conversation's rows while a model is on
 * the route and nothing has been said in this project yet (after the first run's choice, or a relaunch on a set-up home): what
 * TIMMY is, how to start, where the logs live, and four starter actions that work today, drawn as the first run's choices. The
 * composer stays below: the cursor starts on no choice, so a plain Enter opens it; ↓ reaches the choices, Esc clears the choice.
 * Not the first run's question (no model yet) and not Chat with no model's rows: those keep their own words.
 */
export function isWelcome(c: Pick<ShellCtx, 'ui' | 'data'>): boolean {
  return !!routeLine(c.data).model && !c.data.chat.messages.length && !c.data.turn && !c.data.chat.error && !isFirstRun(c) && !noModelNow(c);
}

/** The welcome's three lines (the handoff's 10:20 PT words, which the companion mirrors): what, how to start, where the logs are. */
export const WELCOME_WORDS: readonly [string, string, string] = [
  'TIMMY runs tools and workflows on your machine and keeps a receipt for every step.',
  'Write below and press Enter: the model on the chip answers.',
  'Logs and receipts stay on this computer, in this project\'s .timmy folder: Logs & records lists them.',
];

/** The four starter actions, each one the Workbench does today (the controller's firstChoice: nothing is sent, run, signed
 *  up or downloaded by any of them; a question is typed as a draft, a workflow runs only after its own Run asks). */
export const START_CHOICES: ReadonlyArray<{ id: 'ask' | 'inspect' | 'run' | 'canvas'; label: string; about: string }> = [
  { id: 'ask', label: 'Ask about this project', about: 'A question typed as a draft: what the project does and what ran here last.' },
  { id: 'inspect', label: 'Inspect an image', about: 'VoxVision: what Timmy measured on this project\'s images; /inspect in the REPL inspects a new one.' },
  { id: 'run', label: 'Run a workflow', about: 'Workflows: this project\'s WORKFLOW.md blocks; Enter runs one after it asks.' },
  { id: 'canvas', label: 'Open the canvas', about: 'Studio in your browser (s): this project\'s runs and drafts as cards.' },
];

/** The draft Ask about this project types into the composer (nothing is sent until Enter there). */
export const ASK_DRAFT = 'What does this project do, and what ran here last?';

/**
 * The welcome's rows for the conversation's `rows` (`w` cells): the three lines, a blank row, START WITH, the four choices
 * (amber with "> " on the cursor's while the center has the keyboard; none while the cursor is on no choice), each with its
 * line under it in grey, whole. Where they do not fit, the blank rows between the choices go first (the target's 122x37),
 * then the choices' lines are one row each, cut after a word, then left out, then the blank row before the label, then the
 * choices go two to a row (the target's 80x24: the three lines wrapped, START WITH and two rows of two choices, eight rows;
 * each choice is its own cell for a click), and the label last.
 */
export function welcomeLines(c: ShellCtx, w: number, rows: number, focused: boolean): { lines: Line[]; items: View['items'] } {
  const cur = c.ui.cursor['center:first'];
  const at = cur === undefined ? -1 : Math.max(0, Math.min(START_CHOICES.length - 1, cur));
  const build = (o: { gaps: boolean; abouts: 'wrap' | 'one' | 'none'; label: boolean; gap: boolean; pairs: boolean }): { lines: Line[]; items: View['items'] } => {
    const lines: Line[] = [
      ...wrapText(WELCOME_WORDS[0], w).map((t): Line => [S(t, 'strong', { bold: true })]),
      ...wrapText(WELCOME_WORDS[1], w).map((t): Line => [S(t, 'text')]),
      ...wrapText(WELCOME_WORDS[2], w).map((t): Line => [S(t, 'secondary')]),
    ];
    if (o.label) lines.push(...(o.gap ? [blank] : []), [S('START WITH', 'secondary')]);
    const items: View['items'] = [];
    const cell = (k: number): Seg[] => {
      const on = focused && at === k;
      const sel = on ? { selected: true } : {};
      return [S(on ? '> ' : '  ', 'accent', sel), S(`[ ${START_CHOICES[k].label} ]`, on ? 'accent' : 'strong', on ? { bold: true, ...sel } : {})];
    };
    if (o.pairs) {
      // (the center's content starts one cell after its region's edge: an item's cells are counted from that edge)
      for (let k = 0; k < START_CHOICES.length; k += 2) {
        const a = cell(k);
        const b = cell(k + 1);
        const aw = lineCells(a);
        items.push({ line: lines.length, item: { kind: 'action', key: `first:${START_CHOICES[k].id}`, action: START_CHOICES[k].id }, rows: 1, x: { from: 1, to: aw } });
        items.push({ line: lines.length, item: { kind: 'action', key: `first:${START_CHOICES[k + 1].id}`, action: START_CHOICES[k + 1].id }, rows: 1, x: { from: aw + 2, to: aw + 1 + lineCells(b) } });
        lines.push(trimTo([...a, S(' '), ...b], w, '…'));
      }
      return { lines, items };
    }
    START_CHOICES.forEach((x, k) => {
      if (k && o.gaps) lines.push(blank);
      const sel = focused && at === k ? { selected: true } : {};
      const from = lines.length;
      lines.push(cell(k));
      // (its line whole, wrapped, where the rows allow; else one row cut after a word; else none)
      const about = o.abouts === 'wrap' ? wrapText(x.about, Math.max(8, w - 2)) : o.abouts === 'one' ? [cut(x.about, Math.max(8, w - 2), '…')] : [];
      for (const t of about) lines.push([S('  ', 'text', sel), S(t, 'secondary', sel)]);
      items.push({ line: from, item: { kind: 'action', key: `first:${x.id}`, action: x.id }, rows: lines.length - from });
    });
    return { lines, items };
  };
  const tries: Array<Parameters<typeof build>[0]> = [
    { gaps: true, abouts: 'wrap', label: true, gap: true, pairs: false },
    { gaps: false, abouts: 'wrap', label: true, gap: true, pairs: false },
    { gaps: false, abouts: 'one', label: true, gap: true, pairs: false },
    { gaps: false, abouts: 'none', label: true, gap: true, pairs: false },
    { gaps: false, abouts: 'none', label: true, gap: false, pairs: false },
    { gaps: false, abouts: 'none', label: true, gap: false, pairs: true },
    { gaps: false, abouts: 'none', label: false, gap: false, pairs: true },
  ];
  for (const t of tries) { const b = build(t); if (b.lines.length <= rows) return b; }
  const b = build(tries[tries.length - 1]);
  return { lines: b.lines.slice(0, rows), items: b.items.filter((x) => x.line < rows) };
}

/** The first run's rows and width at this size: the conversation's and the composer's rows together (the question takes the
 *  composer's place, as the target's first run). */
export function firstRowsAt(W: number, H: number): { rows: number; width: number } {
  const grid = chatGrid(W, H);
  return { rows: Math.max(1, grid.contentH - CONVO_AT), width: grid.cw };
}

// ── the screen ─────────────────────────────────────────────────────────────────

export interface ShellRegion { rect: { x: number; y: number; w: number; h: number }; list: string; items: View['items']; scroll: number; fixed: number; height: number; total: number }

/**
 * The Chat screen at `c.width` x `c.height`, every row exactly that wide. `convo` is the conversation as chatView draws it in
 * the shell's form, already scrolled to the rows convoRowsAt gives, or the first run's question (`first`: WELCOME TO TIMMY,
 * the header's FIRST RUN, the rows firstRowsAt gives and no composer) or Chat with no model's rows; `list`: their cursor's.
 */
export function chatScreen(c: ShellCtx, a: { convo: Line[]; convoItems: View['items']; convoScroll: number; convoTotal: number; first?: boolean; full?: boolean; list?: string; focus: Region }): { screen: Line[]; regions: Partial<Record<Region, ShellRegion>>; grid: ChatGrid; chip?: { x0: number; x1: number; y: number } } {
  const { g, ui, data } = c;
  const grid = chatGrid(c.width, c.height);
  const { W, H, railW, cw, contentH } = grid;
  const sep = S(g.unicode ? '│' : '|', 'border');
  const head = headerRows(c, grid, a.first === true);
  const rail = railLines(c, grid, a.focus === 'nav');
  // (R11 H167, step 1a: never over a box: a box has every key, so a drawer drawn over it hid what the keys did)
  const drawer = grid.sepR === null && ui.modelsOpen === true && !ui.overlay;
  const ruleAt = ruleRow(contentH);
  const center: Line[] = Array.from({ length: contentH }, (): Line => []);
  // the first run's question takes the composer's rows too (the target's first run), and so does a box that has every key
  // until it closes (`full`: Connect OpenRouter); else the rule, MESSAGE and the composer
  const whole = a.first === true || a.full === true;
  const convoRows = whole ? contentH - CONVO_AT : Math.max(1, ruleAt - CONVO_AT);
  const title: Line = [S(a.first ? 'WELCOME TO TIMMY' : `CHAT / ${data.project.name}`, a.focus === 'center' && ui.input.field !== 'composer' ? 'accent' : 'strong', { bold: true })];
  // (R10 CHAT H167; H168's pass 3a, R7: the button says its key, [M], and the mouse presses it)
  const modelsKey: Line = grid.sepR === null && !drawer ? [S('[M] Models', 'secondary')] : [];
  // (R10 CHAT H167; H168's pass 3a, R10: a box longer than its rows, the Keys among them, says which rows show at the title
  // row's right, as the tabbed layout's title does; the Keys' first line says so)
  const note = ui.overlay && a.convoTotal > convoRows ? `${ui.overlay.kind === 'help' ? 'Keys ' : ''}${a.convoScroll + 1}–${Math.min(a.convoTotal, a.convoScroll + convoRows)} of ${a.convoTotal}` : '';
  const titleRight: Line = note ? [S(note, 'secondary')] : modelsKey;
  center[1] = [...title, S(' '.repeat(Math.max(1, cw - lineCells(title) - lineCells(titleRight) - 3))), ...titleRight];
  a.convo.slice(0, convoRows).forEach((l, k) => { center[CONVO_AT + k] = l; });
  let chip: { x0: number; x1: number; y: number } | undefined;
  if (!whole) {
    center[ruleAt] = [S((g.unicode ? '─' : '-').repeat(cw), 'border')];
    const comp = composerRows(c, cw, grid.sepR !== null);
    comp.lines.forEach((l, k) => { if (ruleAt + 1 + k < contentH) center[ruleAt + 1 + k] = l; });
    if (ruleAt + 1 + comp.chip.row < contentH) chip = { x0: grid.cx + comp.chip.x0, x1: grid.cx + comp.chip.x1, y: 3 + ruleAt + 1 + comp.chip.row };
  }
  // Models: beside the center, or its drawer over the center's rows down to the composer's text row (R11 H167, step 1b/1c:
  // the Send row and the model chip stay in sight under it, so a choice's "checking…" and its answer are seen at 80x24 too)
  const mN = drawer ? (whole ? ruleAt + 5 : ruleAt + 2) : contentH;
  const models = grid.sepR !== null || drawer ? modelsLines(c, mN, grid.mw, a.focus === 'right', drawer) : null;
  if (drawer && models) models.lines.forEach((l, k) => { center[k] = l; });
  // the bottom's drawer (Logs, Budget, More): over the conversation's rows, the composer and its draft in sight below it;
  // below WIDE_COLUMNS down to the composer's action row, as the Models drawer
  if (ui.shellDrawer && !drawer && !a.first) shellDrawerLines(c, grid.sepR === null ? ruleAt + 2 : ruleAt, cw).lines.forEach((l, k) => { center[k] = l; });
  const bottom = bottomRows(c, grid, a.focus === 'bottom');
  const screen: Line[] = [...head];
  for (let y = 3; y < H; y++) {
    const left = fit(rail.lines[y - 3] ?? [], railW, g.ellipsis);
    if (y >= H - 3) { screen.push(fit([...left, sep, ...bottom.lines[y - (H - 3)]], W, g.ellipsis)); continue; }
    const r = y - 3;
    const mid = fit([S(' '), ...trimTo(center[r] ?? [], cw, g.ellipsis)], grid.centerW, g.ellipsis);
    const right = grid.sepR !== null && models ? [sep, ...fit([S(' '), ...(models.lines[r] ?? [])], W - grid.sepR - 1, g.ellipsis)] : [];
    screen.push(fit([...left, sep, ...mid, ...right], W, g.ellipsis));
  }
  const regions: Partial<Record<Region, ShellRegion>> = {
    nav: { rect: { x: 0, y: 3, w: railW, h: H - 3 }, list: 'rail', items: rail.items, scroll: 0, fixed: 0, height: H - 3, total: H - 3 },
    center: { rect: { x: grid.centerX, y: 3, w: grid.centerW, h: contentH }, list: ui.overlay ? 'overlay' : a.list ?? 'center:chat', items: a.convoItems, scroll: a.convoScroll, fixed: CONVO_AT, height: convoRows, total: a.convoTotal },
    bottom: { rect: { x: railW + 1, y: H - 3, w: W - railW - 1, h: 3 }, list: 'shellBottom', items: bottom.items, scroll: 0, fixed: 0, height: 3, total: 3 },
  };
  if (models) regions.right = { rect: grid.sepR !== null ? { x: grid.modelsX, y: 3, w: W - grid.modelsX, h: contentH } : { x: grid.centerX, y: 3, w: grid.centerW, h: mN }, list: 'right:models', items: models.items, scroll: 0, fixed: models.listFrom, height: models.listRows, total: models.items.length * models.perItem };
  // (a drawer stops above the Send row: the chip under it is drawn, and a click on it opens Models)
  return { screen, regions, grid, ...(chip ? { chip } : {}) };
}
