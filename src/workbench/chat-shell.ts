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
import type { WorkspaceId } from './nav.js';
import { clock, cut, fit, lineCells, trimTo, wrapText, type Line, type Role, type Seg } from './text.js';

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

/** The menu, Chat first; each opens the existing workspace as it is today (Files: the project's files; Connections: Home's
 *  list of them; Logs & records: the turn records, the receipts and the logs). Home is the project selector's, and its key. */
export const RAIL: ReadonlyArray<{ id: string; label: string; short: string; page: TabId; ws?: WorkspaceId }> = [
  { id: 'chat', label: 'Chat', short: 'Chat', page: 'chat' },
  { id: 'studio', label: 'Studio', short: 'Studio', page: 'studio' },
  { id: 'workflows', label: 'Workflows', short: 'Workflows', page: 'workflows' },
  { id: 'voxvision', label: 'VoxVision', short: 'VoxVision', page: 'voxvision' },
  { id: 'motion', label: 'Motion', short: 'Motion', page: 'create' },
  { id: 'control', label: 'Control Room', short: 'Control', page: 'control' },
  { id: 'files', label: 'Files', short: 'Files', page: 'logs', ws: 'files' },
  { id: 'logs', label: 'Logs & records', short: 'Logs', page: 'logs' },
  { id: 'connections', label: 'Connections', short: 'Connections', page: 'home' },
];

/** The rail's items, in order: the project selector, New project, the menu, then Help. */
export const RAIL_ITEMS: readonly string[] = ['project', 'new', ...RAIL.map((r) => r.id), 'help'];

/** The rail's rows from row 3 to the screen's last (`railW` cells each; its separator is the caller's). */
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
  put(1, null, [S('  '), S('PROJECT', focused ? 'accent' : 'secondary', { bold: focused })]);
  const name = cut(data.project.name, grid.railW - (wide ? 6 : 3), g.ellipsis);
  put(2, 'project', [S('  '), S(name, 'strong', on('project')), S(wide ? ' v' : '', 'secondary', on('project'))]);
  put(4, 'new', [S('  '), S(wide ? '+ New project' : '+ New', 'text', on('new'))]);
  RAIL.forEach((r, k) => {
    const shown = ui.page === r.page && (r.id === 'files' ? ui.workspace === 'files' : r.id === 'logs' ? ui.workspace !== 'files' : true);
    const label = cut(wide ? r.label : r.short, grid.railW - 3, g.ellipsis);
    const o = { ...(shown ? { bold: true } : {}), ...on(r.id) };
    put(7 + k, r.id, [S(shown ? ' > ' : '   ', shown ? 'accent' : 'text', o), S(label, shown ? 'accent' : 'text', o)]);
  });
  put(rows - 3, 'help', [S('  '), S('? Help', 'secondary', on('help'))]);
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
  const next: Line = first
    ? [S('FIRST RUN / choose how chat runs', 'secondary')]
    : rt.model
      ? [S(`NEXT / ${nextProvider(data)} / `, 'secondary'), ...(rt.fake ? [S('FAKE ', 'attention')] : []), S(rt.model, 'text')]
      : [S('NEXT / ', 'secondary'), S('Connect a model to chat', 'attention')];
  const row1: Line = [S(' '.repeat(at)), ...trimTo(next, Math.max(4, grid.W - at - margin), g.ellipsis)];
  return [fit(row0, grid.W, g.ellipsis), fit(row1, grid.W, g.ellipsis), [S((g.unicode ? '─' : '-').repeat(grid.W), 'border')]];
}

// ── Models ─────────────────────────────────────────────────────────────────────

/** H169's contract (src/models/catalog.ts), drawn here until it lands: one model as a provider lists it. */
export type ModelSource = 'openrouter' | 'ollama-local' | 'ollama-cloud';
export interface CatalogRow {
  source: ModelSource;
  id: string;
  name: string;
  maker: string;
  description?: string;
  /** epoch seconds: when OpenRouter ADDED it to its catalog (not the model's release) */
  created?: number;
  contextLength?: number;
  price: { inPerM?: number; outPerM?: number; free: boolean | 'unknown' };
  /** undefined: unknown */
  caps: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  inputModalities?: string[];
  installed?: boolean;
  running?: boolean;
  sizeBytes?: number;
  /** a few words the provider gave (Ollama's list: its size and quantization) */
  facts?: string;
}
export interface CatalogQuery { source: ModelSource; search?: string; sort: 'recent' | 'name' | 'price' | 'context'; maker?: string; capability?: 'tools' | 'vision' | 'reasoning'; cost?: 'free' | 'paid'; minContext?: number }

/** What the controller read for Models: OpenRouter's catalog (files only: the one this computer fetched, else the snapshot
 *  shipped with Timmy) and what the local Ollama lists (one request to it, no model run). */
export interface RailModels {
  openrouter?: { from: 'fetched' | 'shipped' | 'none'; at: string | null; rows: CatalogRow[] };
  ollama?: { state: 'reading' | 'listed' | 'failed'; where: string; rows: CatalogRow[]; at?: string; why?: string; cloud?: number };
}

interface RawModel {
  id: string; name?: string; created?: number; description?: string; context_length?: number;
  architecture?: { input_modalities?: string[]; modality?: string };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

/** OpenRouter's catalog (its public /api/v1/models answer, as Timmy keeps it) as rows: per-million prices from its per-token
 *  ones; free only where both are 0; a capability only where the catalog says it (else unknown). */
export function railCatalog(models: readonly RawModel[]): CatalogRow[] {
  const perM = (p?: string): number | undefined => { const n = p === undefined ? Number.NaN : Number(p); return Number.isFinite(n) ? n * 1e6 : undefined; };
  return models.filter((m) => typeof m?.id === 'string').map((m) => {
    const inPerM = perM(m.pricing?.prompt);
    const outPerM = perM(m.pricing?.completion);
    const params = m.supported_parameters;
    const mods = m.architecture?.input_modalities;
    return {
      source: 'openrouter' as const, id: m.id, name: m.name ?? m.id, maker: m.id.split('/')[0] ?? 'unknown',
      ...(m.description ? { description: m.description } : {}), ...(typeof m.created === 'number' ? { created: m.created } : {}),
      ...(typeof m.context_length === 'number' ? { contextLength: m.context_length } : {}),
      price: { ...(inPerM !== undefined ? { inPerM } : {}), ...(outPerM !== undefined ? { outPerM } : {}), free: inPerM === undefined || outPerM === undefined ? 'unknown' as const : inPerM === 0 && outPerM === 0 },
      caps: { ...(params ? { tools: params.includes('tools'), reasoning: params.includes('reasoning') || params.includes('include_reasoning') } : {}), ...(mods ? { vision: mods.includes('image') } : {}) },
      ...(mods ? { inputModalities: mods } : {}),
    };
  });
}

/** What the local Ollama lists, as rows: installed (it lists them) and local; its price no charge; what it does not say,
 *  unknown. */
export function ollamaRows(models: ReadonlyArray<{ name: string; facts: string }>): CatalogRow[] {
  return models.map((m) => ({ source: 'ollama-local' as const, id: m.name, name: m.name, maker: m.name.split(/[:/]/)[0] ?? 'unknown', price: { inPerM: 0, outPerM: 0, free: true }, caps: {}, installed: true, facts: m.facts }));
}

/** H169's queryCatalog, drawn here until it lands: the rows that match, sorted; a sort never resets the filters. */
export function queryRows(rows: readonly CatalogRow[], q: CatalogQuery): { rows: CatalogRow[]; total: number; makers: string[] } {
  const s = q.search?.trim().toLowerCase();
  const of = rows.filter((r) => r.source === q.source);
  const makers = [...new Set(of.map((r) => r.maker))].sort();
  const hit = of.filter((r) => (!s || r.name.toLowerCase().includes(s) || r.id.toLowerCase().includes(s) || r.maker.toLowerCase().includes(s))
    && (!q.maker || r.maker === q.maker)
    && (!q.capability || r.caps[q.capability] === true)
    && (!q.cost || (q.cost === 'free' ? r.price.free === true : r.price.free === false))
    && (!q.minContext || (r.contextLength ?? 0) >= q.minContext));
  const by = {
    recent: (a: CatalogRow, b: CatalogRow) => (b.created ?? -1) - (a.created ?? -1) || a.name.localeCompare(b.name),
    name: (a: CatalogRow, b: CatalogRow) => a.name.localeCompare(b.name),
    price: (a: CatalogRow, b: CatalogRow) => (a.price.inPerM ?? Infinity) - (b.price.inPerM ?? Infinity) || a.name.localeCompare(b.name),
    context: (a: CatalogRow, b: CatalogRow) => (b.contextLength ?? -1) - (a.contextLength ?? -1) || a.name.localeCompare(b.name),
  }[q.sort];
  return { rows: [...hit].sort(by), total: of.length, makers };
}

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
export function railCost(c: Pick<ShellCtx, 'ui' | 'data'>): 'free' | 'all' {
  return c.ui.modelsCost ?? (/\bfree-only\b/.test(c.data.route.words) ? 'free' : 'all');
}

/** The rows Models lists now (the provider's, as its query asks: the sort, the search and the Cost filter its rows say). */
export function modelRows(c: Pick<ShellCtx, 'ui' | 'data'>): { rows: CatalogRow[]; total: number; source: ModelSource | null } {
  const p = railProvider(c);
  const m = c.data.models;
  if (p === 'cloudflare') return { rows: [], total: 0, source: null };
  const source: ModelSource = p;
  const all = source === 'openrouter' ? m?.openrouter?.rows ?? [] : source === 'ollama-local' ? m?.ollama?.rows ?? [] : [];
  const q = queryRows(all, { source, sort: source === 'openrouter' ? (c.ui.modelsSort ?? 'recent') : 'name', ...(c.ui.modelsSearch ? { search: c.ui.modelsSearch } : {}), ...(source === 'openrouter' && railCost(c) === 'free' ? { cost: 'free' as const } : {}) });
  return { rows: q.rows, total: q.total, source };
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
  const head: Line = [S('MODELS', focused ? 'accent' : 'strong', { bold: true })];
  const button = drawer ? '[ Close ]' : ui.modelsDetails ? '[ List ]' : '[ Details ]';
  put(1, [...head, S(' '.repeat(Math.max(1, w - lineCells(head) - button.length))), S(button, drawer ? 'accent' : 'secondary')]);
  const rule: Line = [S((g.unicode ? '─' : '-').repeat(w), 'border')];
  const mark = (on: boolean): Seg => S(on ? '> ' : '  ', 'accent');
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
  if (p === 'cloudflare') {
    put(at, [S('Optional.', 'strong')]);
    wrapText('A Cloudflare AI Gateway can carry a provider\'s requests. Timmy sends nothing to Cloudflare to check it: a request there can create a gateway and bill.', w).forEach((t, k) => put(at + 1 + k, [S(t, 'secondary')]));
    put(at + 7, label('Status', 'not set up'));
    wrapText('Chat goes to its provider directly; logs stay on this computer.', w).forEach((t, k) => put(at + 8 + k, [S(t, 'secondary')]));
    return { lines, items: [], listFrom: n, listRows: 0, perItem: per };
  }
  if (p === 'ollama-cloud') {
    put(at, [S('OLLAMA CLOUD', 'secondary', { bold: true })]);
    wrapText('Not set up here yet. Its models run on Ollama\'s computers, not this one; a key from Ollama sets it up.', w).forEach((t, k) => put(at + 2 + k, [S(t, 'secondary')]));
    return { lines, items: [], listFrom: n, listRows: 0, perItem: per };
  }
  const sortV = ui.modelsSort ?? 'recent';
  const costV = railCost(c) === 'free' ? 'Free only' : 'All';
  if (source === 'openrouter' && drawer) {
    // the drawer's pairs, two a row ("Sort: recent   Maker: All")
    const half = Math.max(18, Math.floor(w / 2) - 6);
    const pair = (a: [string, string], b?: [string, string]): Line => [S(`${a[0]}: `, 'secondary'), S(a[1], 'text'), ...(b ? [S(' '.repeat(Math.max(2, half - a[0].length - 2 - a[1].length))), S(`${b[0]}: `, 'secondary'), S(b[1], 'text')] : [])];
    put(at, ui.modelsSearch ? [S('Search ', 'secondary'), S(ui.modelsSearch, 'text')] : [S('Search name or model id', 'secondary')]);
    put(at + 2, pair(['Sort', sortV], ['Maker', 'All']));
    put(at + 3, pair(['Capability', 'All'], ['Cost', costV]));
    put(at + 4, pair(['Context', 'All']));
    put(at + 5, rule);
    at += 7;
  } else if (source === 'openrouter') {
    put(at, ui.modelsSearch ? [S('Search ', 'secondary'), S(ui.modelsSearch, 'text')] : [S('Search name or model id', 'secondary')]);
    put(at + 2, label('Sort', sortV));
    put(at + 3, label('Maker', 'All'));
    put(at + 4, label('Capability', 'All'));
    put(at + 5, label('Cost', costV));
    put(at + 6, label('Context', 'All'));
    put(at + 7, rule);
    at += 9;
  } else {
    const o = m?.ollama;
    put(at + 1, [S(o?.state === 'listed' ? `INSTALLED / read ${clock(o.at ?? new Date(c.now).toISOString()).slice(0, 5)}` : o?.state === 'reading' ? 'ASKING THE LOCAL OLLAMA' : o?.state === 'failed' ? 'THE LOCAL OLLAMA DID NOT ANSWER' : 'NOT READ YET', 'secondary', { bold: true })]);
    if (o?.state === 'failed' && o.why) wrapText(inWords(o.why), w).slice(0, 3).forEach((t, k) => put(at + 2 + k, [S(t, 'failure')]));
    at += o?.state === 'failed' ? 6 : 3;
  }
  // the list, between `at` and the selected block (two rows a model; one in the drawer), scrolled so the cursor's rows show
  const listFrom = at;
  const listRows = Math.max(0, drawer ? n - at : footAt - 1 - at);
  const cur = rows.length ? Math.max(0, Math.min(rows.length - 1, ui.cursor['right:models'] ?? Math.max(0, rows.findIndex((r) => r.id === rt.model)))) : -1;
  const list: Line[] = [];
  const items: View['items'] = [];
  rows.forEach((r, i) => {
    const on = focused && i === cur ? { selected: true } : {};
    const name = `${/\bfake\b/i.test(r.id) ? 'FAKE ' : ''}${r.name}`;
    items.push({ line: list.length, item: { kind: 'action', key: `model:${r.source}:${r.id}`, action: r.id }, rows: per });
    const nameRow: Line = [S(i === cur ? '> ' : '  ', 'accent', on), S(name, i === cur ? 'accent' : 'strong', { ...(i === cur ? { bold: true } : {}), ...on })];
    // a local model's facts without "local weights" (INSTALLED and the note below say where it runs; SELECTED keeps them whole)
    const facts = (r.facts || 'installed').replace(/^local weights · /, '');
    // context / price; where it does not fit beside the indent, the price's own spaces go, then the word "context"
    const price = priceWords(r.price);
    const room = drawer ? w - lineCells(nameRow) - 3 : w - 2;
    const sub = r.source === 'ollama-local' ? facts : [`${ctxWords(r.contextLength)} / ${price}`, `${ctxWords(r.contextLength)} / ${price.replace(/ \/ /g, '/')}`, `${ctxWords(r.contextLength).replace(/ context$/, '')} / ${price.replace(/ \/ /g, '/')}`].find((t) => t.length <= room) ?? `${ctxWords(r.contextLength)} / ${price}`;
    if (drawer) list.push([...nameRow, S(` / ${sub}`, 'secondary', on)]);
    else list.push(nameRow, [S('  ', 'text', on), S(sub, 'secondary', on)]);
  });
  if (!rows.length) list.push([S(source === 'openrouter' ? (m?.openrouter ? (ui.modelsSearch ? 'No model matches.' : 'No catalog on this computer.') : 'Reading the catalog...') : m?.ollama?.state === 'listed' ? 'Ollama lists no model.' : '', 'secondary')]);
  if (source === 'ollama-local' && m?.ollama?.state === 'listed') list.push(blank, blank, ...wrapText('Runs on this computer. A local model does not require a cloud account.', w).map((t): Line => [S(t, 'secondary')]));
  const top = cur >= 0 ? Math.max(0, Math.min(Math.max(0, list.length - listRows), cur * per - Math.max(0, listRows - per))) : 0;
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
  list.slice(top, top + listRows).forEach((l, k) => put(listFrom + k, l));
  if (drawer) return { lines, items: items.map((x) => ({ ...x, line: x.line - top })), listFrom, listRows, perItem: per };
  put(footAt, rule);
  if (picked) {
    // SELECTED / <model> on one row when it fits; else SELECTED, the name on the next and one row of its description
    const shownName = `${/\bfake\b/i.test(picked.id) ? 'FAKE ' : ''}${picked.name}`;
    const oneRow = 'SELECTED / '.length + [...shownName].length <= w;
    put(footAt + 1, oneRow ? [S('SELECTED / ', 'strong', { bold: true }), S(shownName, 'strong', { bold: true })] : [S('SELECTED', 'strong', { bold: true })]);
    if (!oneRow) put(footAt + 2, [S(shownName, 'strong', { bold: true })]);
    const about = picked.description ?? (picked.source === 'ollama-local' ? picked.facts ?? 'Installed; Ollama gives no description.' : 'No description in the catalog.');
    const aboutRows = wrapText(about.replace(/\s+/g, ' '), w);
    const room = oneRow ? 2 : 1;
    aboutRows.slice(0, room).forEach((t, k) => put(footAt + (oneRow ? 2 : 3) + k, [S(k === room - 1 && aboutRows.length > room ? cut(`${t} ${aboutRows[room]}`, w, g.ellipsis) : t, 'secondary')]));
    // whether the next turn uses it, or what keeps it from that (words, never colour alone)
    const isNext = picked.id === rt.model;
    const note = isNext ? 'The next turn uses it.'
      : picked.source === 'openrouter' && data.route.kind !== 'openrouter' ? 'Route is not OpenRouter yet.'
        : freeOnly && picked.price.free !== true ? 'Priced: not under free-only.'
          : focused ? 'Enter: next turn uses it.' : '';
    if (note) put(footAt + 4, [S(note, isNext ? 'text' : 'secondary')]);
    put(footAt + 5, [S(picked.source === 'ollama-local' ? (w >= 33 ? 'no charge / runs on this computer' : 'no charge / this computer') : picked.price.free === true ? '$0 in / $0 out / 1M tokens' : picked.price.inPerM === undefined || picked.price.outPerM === undefined ? 'price unknown' : `${usd(picked.price.inPerM)} in / ${usd(picked.price.outPerM)} out / 1M`, 'text')]);
    put(footAt + 6, [S(picked.source === 'ollama-local' ? `Listed by Ollama: ${clock(m?.ollama?.at ?? new Date(c.now).toISOString()).slice(0, 5)}` : `${m?.openrouter?.from === 'fetched' ? 'Catalog fetched' : 'Catalog snapshot'}: ${shortDate(m?.openrouter?.at)}`, 'secondary')]);
  } else put(footAt + 1, [S('SELECTED / ', 'strong', { bold: true }), S('none', 'secondary')]);
  return { lines, items: items.map((x) => ({ ...x, line: x.line - top })), listFrom, listRows, perItem: per };
}

// ── the bottom: this conversation's actions and the status row ─────────────────

/** A control of this conversation: its words, whether a capability backs it now, and what it needs when not. */
export interface ShellControl { id: string; label: string; count?: number; on: boolean; needs?: string }

/** This conversation's actions, in the target's order and words, each backed by a real capability (or saying what it
 *  needs): Attach, Tools, Plan / Run, Permissions (what waits on you), Budget, Stop (while a turn runs), Logs, Cloudflare. Below
 *  WIDE_COLUMNS: Tools, Budget, Logs and More. */
export function shellControls(c: Pick<ShellCtx, 'data'>, compact = false): ShellControl[] {
  const d = c.data;
  const turnRuns = d.turn?.state === 'sending' || !!chatTurnNow(d)?.mine;
  const all: ShellControl[] = [
    { id: 'attach', label: 'Attach', on: false, needs: 'the companion: the terminal attaches no files yet' },
    { id: 'tools', label: 'Tools', on: true },
    { id: 'plan', label: 'Plan / Run', on: true },
    { id: 'permissions', label: 'Permissions', on: true, ...(d.decisions.total ? { count: d.decisions.total } : {}) },
    { id: 'budget', label: 'Budget', on: true },
    { id: 'stop', label: 'Stop', on: turnRuns, needs: 'a turn being answered here' },
    { id: 'logs', label: 'Logs', on: true },
    { id: 'cloudflare', label: 'Cloudflare', on: true },
  ];
  return compact ? [...all.filter((k) => ['tools', 'budget', 'logs'].includes(k.id)), { id: 'more', label: 'More', on: true }] : all;
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
  const state = runningN ? `${runningN} running${turn ? ` (the chat turn${turn.mine ? '' : ` in ${turn.where}`})` : ''}` : 'idle';
  const rt = routeLine(data);
  // (with no model nothing is sent, so nothing is spent: said so, not "unknown")
  const spend = !rt.model ? 'none (no model)' : /^no charge/.test(rt.price) ? 'no charge' : rt.price;
  const fresh = ui.flash && c.now - ui.flash.at < 6000 && (!ui.flash.whileTurn || turn?.id === ui.flash.whileTurn) ? ui.flash : null;
  const picked = ctls[cur];
  const left: Line = fresh ? [S(inWords(fresh.text), fresh.role)] : focused && picked && !picked.on && picked.needs ? [S(`${picked.label}: needs ${picked.needs}`, 'secondary')] : [S(`Logs: this computer / ${state}`, 'secondary')];
  // at its right: cloud sync off, the spend and the terminal's size (the target's), the spend left out where it does not fit
  const margin = grid.W >= WIDE_COLUMNS ? 8 : 3;
  const size = `${grid.W} x ${grid.H}`;
  const wordsR = [`cloud sync off / spend ${spend} / ${size}`, `cloud sync off / ${size}`].find((t) => lineCells(left) + 2 + t.length <= w - 1 - margin) ?? size;
  const right: Line = [S(wordsR, 'secondary')];
  // (the size stays at the row's right end whatever stands at its left: a notice too long is cut to leave it room)
  const room = Math.max(4, w - 1 - lineCells(right) - margin - 2);
  const shown = lineCells(left) <= room ? left : trimTo(left, room, g.ellipsis);
  const status: Line = [S(' '), ...shown, S(' '.repeat(Math.max(2, w - 1 - lineCells(shown) - lineCells(right) - margin))), ...right];
  return { lines: [[S(' '), S((g.unicode ? '─' : '-').repeat(Math.max(0, w - 1)), 'border')], acts, status], items };
}

// ── the composer and its action row ────────────────────────────────────────────

/** MESSAGE's rows: the label; the composer (boxed in amber only while it has the keyboard, else the draft kept or what Enter
 *  does); the action row ([ Send ] and its keys; [ Stop ] while this Workbench's own turn is being answered). */
function composerRows(c: ShellCtx, w: number): Line[] {
  const { g, ui, data } = c;
  const typing = ui.input.field === 'composer';
  const turn = chatTurnNow(data);
  const answering = !!turn?.mine || data.turn?.state === 'sending';
  const rt = routeLine(data);
  const label: Line = [S('MESSAGE', typing ? 'accent' : 'secondary', typing ? { bold: true } : {})];
  let box: Line[];
  if (typing) {
    const b = g.unicode ? { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' } : { tl: '#', tr: '#', bl: '#', br: '#', h: '=', v: '#' };
    const room = Math.max(1, w - 5);
    const text = ui.input.text;
    const shown = [...text].length > room ? `${g.ellipsis}${[...text].slice(-(room - 1)).join('')}` : text;
    box = [
      [S(`${b.tl}${b.h.repeat(Math.max(0, w - 2))}${b.tr}`, 'focus')],
      [S(`${b.v} `, 'focus'), S(shown, 'text'), S(' ', 'text', { inverse: true }), S(' '.repeat(Math.max(0, w - 4 - [...shown].length - 1))), S(` ${b.v}`, 'focus')],
      [S(`${b.bl}${b.h.repeat(Math.max(0, w - 2))}${b.br}`, 'focus')],
    ];
  } else {
    const draft = ui.draft?.trim();
    box = [draft ? [S('draft: ', 'secondary'), S(cut(draft.replace(/\s+/g, ' '), w - 7, g.ellipsis), 'text')] : [S(rt.model ? 'Enter writes a message' : 'Connect a model to chat (a draft is kept)', 'secondary')], blank, blank];
  }
  const ready = rt.ready && !!rt.model;
  const send: Line = answering
    ? [S('[ Stop ]', 'accent', { bold: true }), S('        Esc stops the turn being answered', 'secondary')]
    : typing
      ? [S('[ Send ]', ready && ui.input.text.trim() ? 'accent' : 'secondary', ready && ui.input.text.trim() ? { bold: true } : {}), S(ready ? '        Enter sends / Esc leaves, the draft kept' : '        no model: Models chooses one', 'secondary')]
      : [S('[ Send ]', 'secondary'), S('        Enter writes / Tab moves on', 'secondary')];
  return [label, ...box, send];
}

// ── the first run, and Chat with no model ──────────────────────────────────────

/** The first run: the Chat screen asks how chat runs while the next turn has no model and the question is not answered in this
 *  Workbench (a choice, or Continue without a model; Review setup choices asks it again). */
export function isFirstRun(c: Pick<ShellCtx, 'ui' | 'data'>): boolean {
  return !routeLine(c.data).model && c.ui.firstRunDone !== true;
}

/** Chat with no model and nothing in its conversation yet (after the first run's question): what it needs, said once. */
export function noModelNow(c: Pick<ShellCtx, 'ui' | 'data'>): boolean {
  return !isFirstRun(c) && !routeLine(c.data).model && !c.data.chat.messages.length && !c.data.turn;
}

/** The first run's choices, in the target's words where they are true (OpenRouter's sign-in in a browser is not in this build:
 *  its key is typed in a shell, hidden), each opening its own setup; Cloudflare only as the advanced one. */
export const FIRST_CHOICES: ReadonlyArray<{ id: string; label: string; about: string; advanced?: boolean }> = [
  { id: 'openrouter', label: 'OpenRouter / cloud', about: 'Use an API key from OpenRouter (typed in a shell, hidden).' },
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
    ...para('OpenRouter: an account and an API key (https://openrouter.ai/settings/keys); timmy init --chat openrouter asks for it in a shell, hidden.'),
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
  const ids = ['models', 'review'];
  const cur = Math.max(0, Math.min(ids.length - 1, c.ui.cursor['center:first'] ?? 0));
  const lines: Line[] = [
    [S('A model is optional until you need an answer.', 'strong', { bold: true })],
    ...wrapText('Project files, logs and records work without one; what you write is kept as a draft until a model is chosen.', w).map((t): Line => [S(t, 'secondary')]),
    blank,
  ];
  const items: View['items'] = [];
  [['models', 'Choose a model'], ['review', 'Review setup choices']].forEach(([id, label]) => {
    const on = focused && ids[cur] === id;
    items.push({ line: lines.length, item: { kind: 'action', key: `first:${id}`, action: id }, rows: 1 });
    lines.push([S(on ? '> ' : '  ', 'accent', on ? { selected: true } : {}), S(`[ ${label} ]`, on ? 'accent' : 'strong', on ? { bold: true, selected: true } : {})]);
  });
  return { lines, items };
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
export function chatScreen(c: ShellCtx, a: { convo: Line[]; convoItems: View['items']; convoScroll: number; convoTotal: number; first?: boolean; list?: string; focus: Region }): { screen: Line[]; regions: Partial<Record<Region, ShellRegion>>; grid: ChatGrid } {
  const { g, ui, data } = c;
  const grid = chatGrid(c.width, c.height);
  const { W, H, railW, cw, contentH } = grid;
  const sep = S(g.unicode ? '│' : '|', 'border');
  const head = headerRows(c, grid, a.first === true);
  const rail = railLines(c, grid, a.focus === 'nav');
  const drawer = grid.sepR === null && ui.modelsOpen === true;
  const ruleAt = ruleRow(contentH);
  const center: Line[] = Array.from({ length: contentH }, (): Line => []);
  const title: Line = [S(a.first ? 'WELCOME TO TIMMY' : `CHAT / ${data.project.name}`, a.focus === 'center' && ui.input.field !== 'composer' ? 'accent' : 'strong', { bold: true })];
  const modelsKey: Line = grid.sepR === null && !drawer ? [S('[ Models ]', 'secondary')] : [];
  center[1] = [...title, S(' '.repeat(Math.max(1, cw - lineCells(title) - lineCells(modelsKey) - 3))), ...modelsKey];
  // the first run's question takes the composer's rows too (the target's first run); else the rule, MESSAGE and the composer
  const convoRows = a.first ? contentH - CONVO_AT : Math.max(1, ruleAt - CONVO_AT);
  a.convo.slice(0, convoRows).forEach((l, k) => { center[CONVO_AT + k] = l; });
  if (!a.first) {
    center[ruleAt] = [S((g.unicode ? '─' : '-').repeat(cw), 'border')];
    composerRows(c, cw).forEach((l, k) => { if (ruleAt + 1 + k < contentH) center[ruleAt + 1 + k] = l; });
  }
  // Models: beside the center, or its drawer over the center's rows down to the composer (the action row stays in sight)
  const mN = drawer ? ruleAt + 5 : contentH;
  const models = grid.sepR !== null || drawer ? modelsLines(c, mN, grid.mw, a.focus === 'right', drawer) : null;
  if (drawer && models) models.lines.forEach((l, k) => { center[k] = l; });
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
  return { screen, regions, grid };
}
