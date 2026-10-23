/**
 * R10 CHAT CHECKPOINT (H167; the operator's order of 2026-10-22, 16:01 PT, and the handoff's IMPLEMENTATION_SPEC.md): the
 * Workbench's Chat screen as one shell, in cells:
 *
 *   LEFT     a permanent rail: TIMMY, the project selector and New project, then the menu, Chat first (each item opens the
 *            existing workspace as it is today), and at its foot where the work stays (local; cloud sync off)
 *   HEADER   three rows: the project / Chat, whether the conversation is saved locally, the next turn's route in words, and
 *            the keys of Models and Keys
 *   CENTER   the project's saved conversation (src/workbench/views.ts chatView, drawn in the shell's form), the next turn's
 *            line and the composer
 *   RIGHT    Models: the provider choice, search, Sort (Recently added) and the filters, the rows and the selected model's
 *            detail; it applies to the next turn
 *   BOTTOM   This conversation: its controls (each backed by a capability, or saying what it needs) and a status line
 *
 * It replaces the horizontal tabs on this screen only; every other workspace is drawn as before. The data are read by small
 * functions here (railCatalog, ollamaRows, queryRows) in the shape the slice's shared contract names (H169's CatalogRow and
 * CatalogQuery in src/models/catalog.ts), so the lead can switch them to H169's at the merge. Pure: the controller reads, this
 * draws.
 */
import type { TabId } from '../contracts/workspace.js';
import type { Glyphs } from './frame.js';
import { chatTurnNow } from './hub.js';
import { inWords, routeLine } from './home-journey.js';
import type { Data, Item, Ui, View } from './model.js';
import type { WorkspaceId } from './nav.js';
import { clock, cut, lineCells, trimTo, wrapSegs, wrapText, type Line, type Role, type Seg } from './text.js';

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

// ── the left rail ──────────────────────────────────────────────────────────────

/** The menu, Chat first; each opens the existing workspace as it is today (Files: the project's files; Connections: Home's
 *  list of them). Home is the project selector's, and its key (1). */
export const RAIL: ReadonlyArray<{ id: string; label: string; page: TabId; ws?: WorkspaceId }> = [
  { id: 'chat', label: 'Chat', page: 'chat' },
  { id: 'studio', label: 'Studio', page: 'studio' },
  { id: 'workflows', label: 'Workflows', page: 'workflows' },
  { id: 'voxvision', label: 'VoxVision', page: 'voxvision' },
  { id: 'motion', label: 'Motion', page: 'create' },
  { id: 'control', label: 'Control Room', page: 'control' },
  { id: 'files', label: 'Files', page: 'logs', ws: 'files' },
  { id: 'logs', label: 'Logs & receipts', page: 'logs' },
  { id: 'connections', label: 'Connections', page: 'home' },
];

/** The rail's items, in order: the project selector, New project, then the menu. */
export const RAIL_ITEMS: readonly string[] = ['project', 'new', ...RAIL.map((r) => r.id)];

/** The words at the rail's foot: as true for this build (logs and receipts in the project; nothing is synced anywhere). */
export const RAIL_FOOT = 'Local workspace · logs stay on this computer · cloud sync off';

/**
 * The left rail, `width` cells wide (its right edge is the caller's): the selected item (the screen shown, Chat) amber; the
 * rail's cursor marked where it has the keyboard; the foot at the rail's last rows.
 */
export function railView(c: ShellCtx, focused: boolean): View {
  const { g, data, width } = c;
  const lines: Line[] = [];
  const items: View['items'] = [];
  const cur = Math.max(0, Math.min(RAIL_ITEMS.length - 1, c.ui.cursor.rail ?? RAIL_ITEMS.indexOf('chat')));
  const mark = (i: number): Seg => S(focused && i === cur ? `${g.cursor} ` : '  ', 'focus');
  const sel = (i: number): Omit<Seg, 'text' | 'role'> => (focused && i === cur ? { selected: true } : {});
  lines.push([S(' TIMMY', 'strong', { bold: true })], blank);
  lines.push([S(' PROJECT', 'secondary', { bold: true })]);
  items.push({ line: lines.length, item: { kind: 'action', key: 'rail:project', action: 'project' } });
  lines.push([mark(0), S(cut(data.project.name, Math.max(3, width - 5), g.ellipsis), 'strong', sel(0)), S(g.unicode ? ' ▾' : ' v', 'secondary', sel(0))]);
  items.push({ line: lines.length, item: { kind: 'action', key: 'rail:new', action: 'new' } });
  lines.push([mark(1), S('+ New project', 'text', sel(1))]);
  lines.push(blank, [S(' WORKSPACE', 'secondary', { bold: true })]);
  RAIL.forEach((r, k) => {
    const i = k + 2;
    const shown = c.ui.page === r.page && (!r.ws || c.ui.workspace === r.ws) && (r.id !== 'logs' || c.ui.workspace !== 'files');
    items.push({ line: lines.length, item: { kind: 'action', key: `rail:${r.id}`, action: r.id } });
    lines.push([mark(i), S(cut(r.label, Math.max(3, width - 2), g.ellipsis), shown ? 'accent' : 'text', { ...(shown ? { bold: true } : {}), ...sel(i) })]);
  });
  // the foot at the rail's last rows, wrapped to its width
  const foot = RAIL_FOOT.split(' · ').flatMap((part, k) => wrapText(k ? part.charAt(0).toUpperCase() + part.slice(1) : part, Math.max(6, width - 1)).map((t): Line => [S(` ${t}`, k ? 'secondary' : 'text')]));
  const gap = c.height - lines.length - foot.length;
  if (gap > 0) lines.push(...Array.from({ length: gap }, (): Line => []));
  lines.push(...foot);
  return { lines, items };
}

/** The rail's rows, `width` cells each with its right edge (a light rule), exactly `height` rows. */
export function railScreen(v: View, width: number, height: number, g: Glyphs, focused: boolean): Line[] {
  const edge = S(g.unicode ? (focused ? '┃' : '│') : (focused ? '#' : '|'), focused ? 'focus' : 'border');
  return Array.from({ length: height }, (_, y) => {
    const l = trimTo(v.lines[y] ?? [], width - 1, g.ellipsis);
    const used = lineCells(l);
    return [...l, S(' '.repeat(Math.max(0, width - 1 - used))), edge];
  });
}

// ── the header ─────────────────────────────────────────────────────────────────

/** The header's one row of words: project / Chat · saved locally (when it is) · the next turn's route · Models [M] · Keys [?].
 *  Ids, hashes, ports, paths and protocol details are the inspector's ([i]). */
export function headerLine(c: ShellCtx, width: number): Line {
  const { data, g } = c;
  const rt = routeLine(data);
  const sep = ` ${g.sep} `;
  const left: Line = [S(data.project.name, 'strong'), S(' / ', 'secondary'), S('Chat', 'accent', { bold: true })];
  const route: Line = rt.model
    ? [S(`${sep}next turn `, 'secondary'), ...(rt.fake ? [S('FAKE ', 'attention')] : []), S(rt.model, 'text'), S(`${sep}${rt.where.replace(/ \(Ollama\)$/, '')}${sep}${rt.price}`, 'secondary')]
    : [S(`${sep}next turn: `, 'secondary'), S(rt.why ?? 'no model chosen', 'attention')];
  const right: Line = [S('Models ', 'text'), S('[M]', 'action'), S(sep, 'secondary'), S('Keys ', 'text'), S('[?]', 'action')];
  const room = width - lineCells(left) - lineCells(right) - 2;
  const mid = lineCells(route) <= room ? route : trimTo(route, Math.max(0, room), g.ellipsis);
  const fill = Math.max(1, width - lineCells(left) - lineCells(mid) - lineCells(right));
  return [...left, ...mid, S(' '.repeat(fill)), ...right];
}

// ── the conversation's next-turn line ──────────────────────────────────────────

/** The line above the composer: "Next turn <model> · <provider> · <where>" with Change model ([M]); FAKE when it is. */
export function nextTurnLine(c: ShellCtx, width: number): Line {
  const { data, g } = c;
  const rt = routeLine(data);
  const sep = ` ${g.sep} `;
  const provider = data.route.kind === 'local' || /Ollama/.test(rt.where) ? 'Ollama' : data.route.kind === 'openrouter' ? 'OpenRouter' : 'no provider';
  const where = /this computer/.test(rt.where) ? 'this computer' : /cloud/i.test(rt.where) ? 'cloud' : rt.where;
  const change: Line = [S(' Change model ', 'text'), S('[M]', 'action')];
  const words: Line = rt.model
    ? [S('Next turn ', 'secondary'), ...(rt.fake ? [S('FAKE ', 'attention')] : []), S(rt.model, 'strong'), S(`${sep}${provider}${sep}${where}`, 'secondary')]
    : [S('Next turn: ', 'secondary'), S('Connect a model to chat', 'attention')];
  const body = lineCells(words) + lineCells(change) <= width ? words : trimTo(words, Math.max(0, width - lineCells(change)), g.ellipsis);
  return [...body, S(' '.repeat(Math.max(0, width - lineCells(body) - lineCells(change)))), ...change];
}

// ── the models rail ────────────────────────────────────────────────────────────

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

/** What the controller read for the rail: OpenRouter's catalog (files only: the one this computer fetched, else the snapshot
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

/** A context length in words ("262K ctx", "1M ctx"); unknown when the list does not say. */
export const ctxWords = (n?: number): string => (n === undefined ? 'context unknown' : n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M ctx` : n >= 1e3 ? `${Math.round(n / 1e3)}K ctx` : `${n} ctx`);

/** A price in words: free (both 0), "$0.15/$0.60 per M" (input/output), or unknown. */
export function priceWords(p: CatalogRow['price'], local = false): string {
  if (local) return 'no charge · local';
  if (p.free === true) return 'free';
  if (p.inPerM === undefined || p.outPerM === undefined) return 'price unknown';
  return `${usd(p.inPerM)}/${usd(p.outPerM)} /M`;
}

/** A price per million tokens in dollars, as short as it reads ("$0.15", "$1.5", "$15"). */
const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/** The provider the rail shows: the person's choice, else the next turn's route's. */
export function railProvider(c: Pick<ShellCtx, 'ui' | 'data'>): 'openrouter' | 'ollama' | 'cloudflare' {
  return c.ui.modelsProvider ?? (c.data.route.kind === 'local' ? 'ollama' : 'openrouter');
}

/** The rows the rail lists now (the provider's, as its query asks), and the next turn's model among them. */
export function modelRows(c: Pick<ShellCtx, 'ui' | 'data'>): { rows: CatalogRow[]; total: number; source: ModelSource | null } {
  const p = railProvider(c);
  const m = c.data.models;
  if (p === 'cloudflare') return { rows: [], total: 0, source: null };
  const source: ModelSource = p === 'ollama' ? (c.ui.modelsOllama === 'cloud' ? 'ollama-cloud' : 'ollama-local') : 'openrouter';
  const all = source === 'openrouter' ? m?.openrouter?.rows ?? [] : source === 'ollama-local' ? m?.ollama?.rows ?? [] : [];
  const q = queryRows(all, { source, sort: source === 'openrouter' ? (c.ui.modelsSort ?? 'recent') : 'name', ...(c.ui.modelsSearch ? { search: c.ui.modelsSearch } : {}) });
  return { rows: q.rows, total: q.total, source };
}

/**
 * The Models rail: a title with the count and "applies to the next turn"; the provider choice (OpenRouter | Ollama (Local /
 * Cloud) | Cloudflare (optional)); search; Sort (Recently added: the catalog's added date) and the filters; the rows (name,
 * then context and price, the next turn's model marked); the selected row's detail (its description, exact id, context,
 * capabilities known or unknown, prices, where the data came from and when). Unknown stays unknown.
 */
export function modelsRailView(c: ShellCtx, focused: boolean): View & { title: string; note: string } {
  const { g, data, width } = c;
  const sep = ` ${g.sep} `;
  const lines: Line[] = [];
  const items: View['items'] = [];
  const p = railProvider(c);
  const rt = routeLine(data);
  const tab = (label: string, on: boolean): Seg[] => [S(on ? `[${label}]` : ` ${label} `, on ? 'accent' : 'text', on ? { bold: true } : {})];
  lines.push([...tab('OpenRouter', p === 'openrouter'), ...tab('Ollama', p === 'ollama')], [...tab('Cloudflare', p === 'cloudflare'), S(p === 'cloudflare' ? '' : ' optional', 'secondary')]);
  if (p === 'ollama') lines.push([S(' ', 'text'), S(c.ui.modelsOllama === 'cloud' ? 'Local' : '[Local]', c.ui.modelsOllama === 'cloud' ? 'text' : 'accent'), S(sep, 'secondary'), S(c.ui.modelsOllama === 'cloud' ? '[Cloud]' : 'Cloud', c.ui.modelsOllama === 'cloud' ? 'accent' : 'text')]);
  if (p === 'cloudflare') {
    lines.push(blank, ...wrapSegs([S('Optional. ', 'strong'), S('A Cloudflare AI Gateway can carry a provider\'s requests; Timmy sends nothing to Cloudflare to check it (a request there can create a gateway and bill).', 'secondary')], width, ''));
    lines.push(blank, [S('Status ', 'secondary'), S('not set up', 'text')]);
    lines.push(...wrapSegs([S('Chat goes to the provider directly; logs stay on this computer.', 'secondary')], width, ''));
    return { lines, items, title: 'Models', note: 'next turn' };
  }
  const search = c.ui.modelsSearch;
  lines.push([S('/ ', 'action'), S(search ? search : 'search model or maker', search ? 'text' : 'secondary')]);
  const { rows, total, source } = modelRows(c);
  if (source === 'openrouter') {
    lines.push([S('Sort ', 'secondary'), S(c.ui.modelsSort && c.ui.modelsSort !== 'recent' ? ({ name: 'Name', price: 'Price', context: 'Context' } as const)[c.ui.modelsSort] : 'Recently added', 'text')]);
    lines.push([S('Maker any · Capability any', 'secondary')], [S('Cost any · Context any', 'secondary')]);
  }
  const m = data.models;
  // where the rows came from, and when
  const from = source === 'openrouter'
    ? (m?.openrouter ? (m.openrouter.from === 'none' ? 'no catalog on this computer' : `${m.openrouter.from === 'fetched' ? 'catalog fetched' : 'snapshot shipped'} ${m.openrouter.at ?? ''}`.trim()) : 'reading the catalog…')
    : source === 'ollama-local'
      ? (m?.ollama ? (m.ollama.state === 'reading' ? 'asking the local Ollama…' : m.ollama.state === 'failed' ? 'the local Ollama did not answer' : `installed${sep}read ${m.ollama.at ?? ''}`.trim()) : 'not read yet')
      : 'Ollama Cloud: not set up';
  lines.push([S(cut(source === 'ollama-local' ? `INSTALLED${m?.ollama?.state === 'listed' ? `${sep}read ${readAt(m.ollama.at)}` : ''}` : source === 'ollama-cloud' ? 'OLLAMA CLOUD' : `${m?.openrouter?.from === 'fetched' ? 'FETCHED' : 'SNAPSHOT'} ${m?.openrouter?.at ?? ''}`.trim(), width, g.ellipsis), 'secondary', { bold: true })]);
  if (source !== 'openrouter' && !(m?.ollama?.state === 'listed')) lines.push([S(cut(from, width, g.ellipsis), 'secondary')]);
  if (source === 'ollama-local' && m?.ollama?.state === 'failed' && m.ollama.why) lines.push(...wrapSegs([S(m.ollama.why, 'failure')], width, ''));
  if (source === 'ollama-cloud') lines.push(...wrapSegs([S('An Ollama Cloud key is set up with its provider (not yet here); the cloud models run off this computer.', 'secondary')], width, ''));
  if (!rows.length && source !== 'ollama-cloud' && (source === 'openrouter' ? m?.openrouter : m?.ollama?.state === 'listed')) lines.push([S(search ? 'No model matches.' : 'None listed.', 'secondary')]);
  const list = 'right:models';
  const cur = rows.length ? Math.max(0, Math.min(rows.length - 1, c.ui.cursor[list] ?? Math.max(0, rows.findIndex((r) => r.id === rt.model)))) : -1;
  // the rows, as many as leave the detail its room (the caller scrolls the list to the selected row)
  rows.forEach((r, i) => {
    const sel = focused && i === cur;
    const next = r.id === rt.model;
    const local = r.source === 'ollama-local';
    const name = `${/\bfake\b/i.test(r.id) ? 'FAKE ' : ''}${r.name}`;
    const head: Line = [S(i === cur ? `${g.cursor} ` : '  ', focused ? 'focus' : 'secondary', sel ? { selected: true } : {}), S(cut(name, Math.max(4, width - 4), g.ellipsis), next ? 'accent' : 'strong', sel ? { selected: true } : {}), S(next ? ` ${g.ok}` : '', 'accent', sel ? { selected: true } : {})];
    const sub: Line = [S('  ', 'text', sel ? { selected: true } : {}), S(cut(local ? (r.facts || 'installed') : `${ctxWords(r.contextLength)}${sep}${priceWords(r.price)}`, Math.max(4, width - 2), g.ellipsis), 'secondary', sel ? { selected: true } : {})];
    items.push({ line: lines.length, item: { kind: 'action', key: `model:${r.source}:${r.id}`, action: r.id }, rows: 2 });
    lines.push(head, sub);
  });
  const picked = cur >= 0 ? rows[cur] : undefined;
  const detail: Line[] = [];
  if (picked) {
    detail.push(blank, [S('SELECTED', 'secondary', { bold: true }), S(picked.id === rt.model ? `${sep}the next turn's` : '', 'secondary')]);
    if (picked.description) detail.push(...wrapText(picked.description.replace(/\s+/g, ' '), width).slice(0, 3).map((t): Line => [S(t, 'text')]));
    // the exact id, whole (over more rows where it is longer than the rail)
    const idW = Math.max(4, width - 3);
    for (let k = 0; k < picked.id.length; k += idW) detail.push([S(k ? '   ' : 'id ', 'secondary'), S(picked.id.slice(k, k + idW), 'text')]);
    detail.push([S(ctxWords(picked.contextLength), 'text')]);
    // the prices whole: input and output per million tokens, as the catalog says them (else unknown); a local one no charge
    if (picked.source === 'ollama-local') detail.push([S('no charge · local', 'text')]);
    else if (picked.price.free === true) detail.push([S('free', 'text'), S(' (input and output)', 'secondary')]);
    else detail.push([S('input ', 'secondary'), S(picked.price.inPerM === undefined ? 'unknown' : `${usd(picked.price.inPerM)} per M tokens`, 'text')], [S('output ', 'secondary'), S(picked.price.outPerM === undefined ? 'unknown' : `${usd(picked.price.outPerM)} per M tokens`, 'text')]);
    const cap = (k: 'tools' | 'vision' | 'reasoning'): Seg[] => [S(`${k} `, 'secondary'), S(picked.caps[k] === undefined ? 'unknown' : picked.caps[k] ? 'yes' : 'no', 'text')];
    detail.push([...cap('tools')], [...cap('vision')], [...cap('reasoning')]);
    if (picked.facts) detail.push(...wrapText(picked.facts, width).slice(0, 2).map((t): Line => [S(t, 'secondary')]));
    if (picked.id !== rt.model) detail.push([S('Enter ', 'action'), S('uses it for the next turn', 'text')]);
  }
  // the detail keeps its rows at the rail's foot: the list scrolls above it (the caller cuts the list to what is left)
  const title = `Models${source ? ` ${g.sep} ${total}` : ''}`;
  return { lines: [...lines, ...detail], items, title, note: 'applies to the next turn', footRows: detail.length };
}

// ── the bottom: this conversation's controls and the status line ───────────────

/** A control of this conversation: its words, whether a capability backs it now, and what it needs when not. */
export interface ShellControl { id: string; label: string; count?: number; on: boolean; needs?: string }

/** This conversation's controls, each backed by a real capability (or saying what it needs): Tools, Attachments, Plan & Run,
 *  Budget, Approvals, Stop (while a turn runs), Cloudflare (optional), Logs (local). */
export function shellControls(c: Pick<ShellCtx, 'data'>): ShellControl[] {
  const d = c.data;
  const turnRuns = d.turn?.state === 'sending';
  return [
    { id: 'tools', label: 'Tools', on: true, ...(d.turn?.tools.length ? { count: d.turn.tools.length } : {}) },
    { id: 'attach', label: 'Attachments', on: false, needs: 'the companion attaches files; not the terminal yet' },
    { id: 'plan', label: 'Plan & Run', on: true },
    { id: 'budget', label: 'Budget', on: true },
    { id: 'approvals', label: 'Approvals', on: true, count: d.decisions.total },
    { id: 'stop', label: 'Stop', on: turnRuns, needs: 'a turn being answered' },
    { id: 'cloudflare', label: 'Cloudflare', on: true },
    { id: 'logs', label: 'Logs', on: true },
  ];
}

/** The bottom area's rows: the controls (the selected one marked where it has the keyboard), the status line and the keys. */
export function shellBottomView(c: ShellCtx, focused: boolean): View {
  const { g, data, width } = c;
  const sep = ` ${g.sep} `;
  const items: View['items'] = [];
  const ctls = shellControls(c);
  const cur = Math.max(0, Math.min(ctls.length - 1, c.ui.cursor.shellBottom ?? 0));
  const row: Line = [];
  let x = 0;
  ctls.forEach((k, i) => {
    const sel = focused && i === cur;
    const words = `${k.label}${k.count !== undefined ? ` ${k.count}` : ''}${k.id === 'logs' ? ' local' : k.id === 'cloudflare' ? ' optional' : ''}`;
    const seg = S(sel ? `[${words}]` : ` ${words} `, sel ? 'focus' : k.on ? 'text' : 'secondary', sel ? { bold: true } : {});
    const w = lineCells([seg]);
    if (x + w > width) return;
    items.push({ line: 0, item: { kind: 'action', key: `ctl:${k.id}`, action: k.id }, x: { from: x, to: x + w - 1 } });
    row.push(seg);
    x += w;
  });
  const rt = routeLine(data);
  const inference = data.route.kind === 'local' ? `Ollama${sep}${/this computer/.test(rt.where) ? 'this computer' : rt.where}` : data.route.kind === 'openrouter' ? 'OpenRouter · cloud' : 'no model';
  const spend = /^no charge/.test(rt.price) ? 'no charge' : rt.price;
  // what runs now, first, where something does (this Workbench's jobs, and a chat turn being answered here or elsewhere)
  const turn = chatTurnNow(data);
  const runningN = data.activity.running + (turn ? 1 : 0);
  const run: Line = runningN ? [S(`${g.run} ${runningN} running${turn ? ` (the chat turn${turn.mine ? '' : ` in ${turn.where}`})` : ''}`, 'text'), S('  |  ', 'border')] : [];
  const status: Line = [...run, S('inference ', 'secondary'), S(inference, 'text'), S('  |  ', 'border'), S('logs ', 'secondary'), S('this computer', 'text'), S('  |  ', 'border'), S('cloud sync off', 'text'), S('  |  ', 'border'), S('spend ', 'secondary'), S(spend, 'text')];
  const picked = ctls[cur];
  // a fresh notice (what the Workbench just did or refused) takes the keys' row for its few seconds, in words
  const fresh = c.ui.flash && c.now - c.ui.flash.at < 6000 && (!c.ui.flash.whileTurn || turn?.id === c.ui.flash.whileTurn) ? c.ui.flash : null;
  const said = fresh ? wrapSegs([S(inWords(fresh.text), fresh.role)], width) : null;
  if (said && said.length > 1) return { lines: [row, said[0], trimTo(said.slice(1).flatMap((r, i) => (i ? [S(' '), ...r] : r)), width, g.ellipsis)], items };
  const hint: Line = said ? said[0] : focused && picked && !picked.on && picked.needs
    ? [S(`${picked.label}: needs ${picked.needs}`, 'secondary')]
    : [S('Tab', 'action'), S(' next pane  ', 'secondary'), S('Enter', 'action'), S(' acts  ', 'secondary'), S('M', 'action'), S(' models  ', 'secondary'), S('Esc', 'action'), S(' back  ', 'secondary'), S('?', 'action'), S(' keys  ', 'secondary'), S('Ctrl+C', 'action'), S(' quit', 'secondary')];
  return { lines: [row, trimTo(status, width, g.ellipsis), trimTo(hint, width, g.ellipsis)], items };
}

/** When the next-turn line's model was read (the header and the rail's freshness): a clock time. */
export const readAt = (iso?: string): string => (iso ? clock(iso).slice(0, 5) : '');
