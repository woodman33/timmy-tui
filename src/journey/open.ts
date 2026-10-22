/**
 * R10 (H164): where each kind of the project's work opens, ONE function for the terminal Workbench, the browser companion and
 * Studio (journey step 3: "Open a project artifact in the appropriate companion or Studio preview"; step 4: a run's progress,
 * result and receipt without leaving the project):
 *
 *   kind          opens                                               the address names it as (what the page reads)
 *   mesh          the companion's tab 6, its view, the mesh chosen    ?tab=create&mesh=<its path as hex of its UTF-8 bytes>
 *   recording     the companion's tab 6, the recording chosen          ?tab=create&recording=<its path as hex>   (R9 review F5)
 *   observation   the companion's tab 5, the VoxVision record open     ?tab=voxvision&vox=v<8 hex>
 *   run           the companion's run detail (Workflows)               ?tab=workflows&run=o<8 hex>
 *   turn          the companion's Chat & Intent, at its receipt         ?tab=chat&receipt=<8 hex>
 *   receipt       the companion's Logs & Receipts, the receipt chosen   ?tab=logs&receipt=<8 hex>
 *   reference,    the companion's preview                               ?tab=home&file=<its path as hex>; a result a run
 *   result                                                              wrote opens in that run's detail instead
 *   draft, card   Studio, on the project's board                       (Studio has no address that selects one: said so)
 *
 * The address is a query of names and plain values only, as the Workbench's Companion · Show passes it on
 * (src/workbench/servers.ts PAGE_QUERY: a path is written as hex, since an address holds plain values). openUrl puts it on a
 * base address and NEVER carries a token: the companion's token rides in an address's fragment (#t=…), which openUrl drops,
 * with any query of the base; the Workbench opens the page with its token through a private launch page (servers.ts), and a
 * page already holding its token keeps it in memory. So an address openUrl makes may go into a log, a capture or a file.
 *
 * R9 review F6 (a mesh= the page does not show was replaced silently): askedOf reads what an address asks for, as the page
 * reads it (the query, or beside the token after #, the same hex), and shownFor says what is shown for it and, when that is
 * not what was asked, a notice in words. Pure: no file, no server (the companion's GET /api/journey/open answers it for a page).
 */
import type { TabId } from '../contracts/workspace.js';

export type OpenKind = 'turn' | 'run' | 'mesh' | 'recording' | 'observation' | 'reference' | 'result' | 'receipt' | 'draft' | 'card';
/** What an address chooses on its tab. */
export type SelectName = 'mesh' | 'recording' | 'vox' | 'run' | 'receipt' | 'file' | 'draft' | 'card';

/** Anything openTarget can place: a kind and its id (a path in the project, an operation, a receipt's 8 hex, a draft's id). */
export interface Openable {
  kind: OpenKind;
  id: string;
  /** the operation that made it (a result a run wrote opens in that run's detail) */
  operation?: string | null;
}

export interface OpenTarget {
  surface: 'companion' | 'studio';
  /** the companion's tab (the ten tabs' ids), or null for Studio */
  tab: TabId | null;
  /** what the address chooses on that tab, or null (the tab alone) */
  select: { name: SelectName; value: string } | null;
  /** the query the companion's address carries ('' for Studio): names and plain values only, never a token */
  query: string;
  /** the address's path and query on the page's own server: '/?tab=create&mesh=…', '/' */
  path: string;
  /** what kind of preview it takes: an image, text, tab 6's view (a mesh), a recording's reading, or none */
  preview: 'image' | 'text' | 'mesh' | 'recording' | 'none';
  /** where it opens, in words (no id, no path: those are the inspector's) */
  words: string;
}

export const OPERATION_ID = /^o[0-9a-f]{8}$/;
export const VOX_ID = /^v[0-9a-f]{8}$/;
export const RECEIPT_ID = /^[0-9a-f]{8}$/;
export const DRAFT_ID = /^draft-[0-9a-f]{8,32}$/;
/** The longest path an address carries (the page reads at most 1024 bytes of hex). */
export const PATH_BYTES_MAX = 1024;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'xml', 'html', 'py', 'ts', 'js', 'mjs', 'sh', 'scad', 'usda']);

/** A path's UTF-8 bytes as lowercase hex (what the page reads back). */
export const hexOfPath = (path: string): string => Buffer.from(path, 'utf8').toString('hex');

/** The path a hex value names, or null when it is not even lowercase hex of valid UTF-8 within the length the page reads. */
export function pathOfHex(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){1,1024}$/.test(hex)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex')); } catch { return null; }
}

/** A path inside the project as an address may name it: relative, no "..", no NUL, no control character, not too long. */
export function projectPath(path: string): boolean {
  return path.length > 0 && Buffer.byteLength(path, 'utf8') <= PATH_BYTES_MAX && !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)
    && !path.split(/[\\/]/).includes('..') && !/[\x00-\x1f\x7f]/.test(path);
}

const ext = (path: string): string => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
/** The preview a file takes, by its kind. */
export const previewOf = (path: string): OpenTarget['preview'] => (IMAGE_EXT.has(ext(path)) ? 'image' : TEXT_EXT.has(ext(path)) ? 'text' : 'none');

const TAB_WORDS: Readonly<Partial<Record<TabId, string>>> = {
  home: 'Home', chat: 'Chat & Intent', workflows: 'Workflows', voxvision: 'VoxVision', create: '3D & Motion', logs: 'Logs & Receipts',
};

function companion(tab: TabId, select: OpenTarget['select'], preview: OpenTarget['preview'], words: string): OpenTarget {
  const query = `tab=${tab}${select ? `&${select.name}=${select.name === 'mesh' || select.name === 'recording' || select.name === 'file' ? hexOfPath(select.value) : select.value}` : ''}`;
  return { surface: 'companion', tab, select, query, path: `/?${query}`, preview, words };
}

/** The tab alone, saying why nothing is chosen on it (an id that is not one of its kind is never put in an address). */
const tabAlone = (tab: TabId, why: string): OpenTarget => companion(tab, null, 'none', `the companion's ${TAB_WORDS[tab] ?? tab} tab (${why})`);

/** Where `item` opens. */
export function openTarget(item: Openable): OpenTarget {
  const id = String(item.id ?? '');
  switch (item.kind) {
    case 'mesh':
      return projectPath(id) ? companion('create', { name: 'mesh', value: id }, 'mesh', 'the companion\'s 3D view, this mesh chosen') : tabAlone('create', `${id} is not a path in the project, so no mesh is chosen`);
    case 'recording':
      return projectPath(id) ? companion('create', { name: 'recording', value: id }, 'recording', 'the companion\'s 3D & Motion tab, this recording chosen') : tabAlone('create', `${id} is not a path in the project, so no recording is chosen`);
    case 'observation':
      return VOX_ID.test(id) ? companion('voxvision', { name: 'vox', value: id }, 'image', 'the companion\'s VoxVision tab, this record open') : tabAlone('voxvision', `${id} is not a VoxVision record's id, so none is open`);
    case 'run':
      return OPERATION_ID.test(id) ? companion('workflows', { name: 'run', value: id }, 'none', 'the companion\'s run detail: progress, result and receipt') : tabAlone('workflows', `${id} is not an operation id, so no run is chosen`);
    case 'turn':
      return RECEIPT_ID.test(id) ? companion('chat', { name: 'receipt', value: id }, 'none', 'the companion\'s Chat & Intent tab, at this turn') : tabAlone('chat', `${id} is not a receipt's id, so no turn is chosen`);
    case 'receipt':
      return RECEIPT_ID.test(id) ? companion('logs', { name: 'receipt', value: id }, 'none', 'the companion\'s Logs & Receipts tab, this receipt chosen') : tabAlone('logs', `${id} is not a receipt's id, so none is chosen`);
    case 'reference':
    case 'result': {
      // a result a run wrote: that run's detail, beside its progress and its receipt
      if (item.kind === 'result' && item.operation && OPERATION_ID.test(item.operation)) return companion('workflows', { name: 'run', value: item.operation }, previewOf(id), 'the companion\'s run detail, beside the run that wrote it');
      return projectPath(id) ? companion('home', { name: 'file', value: id }, previewOf(id), 'the companion\'s preview') : tabAlone('home', `${id} is not a path in the project, so nothing is previewed`);
    }
    case 'draft':
      return { surface: 'studio', tab: null, select: DRAFT_ID.test(id) ? { name: 'draft', value: id } : null, query: '', path: '/', preview: 'none', words: 'Studio, on the project\'s board, where the draft waits for Accept or Discard (Studio has no address that selects it)' };
    case 'card':
    default:
      return { surface: 'studio', tab: null, select: id ? { name: 'card', value: id } : null, query: '', path: '/', preview: 'none', words: 'Studio, on the project\'s board (Studio has no address that selects a card)' };
  }
}

/**
 * The address `target` opens at on the server at `base` (the companion's or Studio's address WITHOUT its token, as each server
 * gives it: CompanionServer.address). Only the base's origin is kept: its fragment (where a token rides) and its query are
 * dropped, so the address never carries a token. A base that is not an http(s) address is refused (thrown).
 */
export function openUrl(target: OpenTarget, base: string): string {
  let u: URL;
  try { u = new URL(base); } catch { throw new Error(`openUrl: ${JSON.stringify(String(base).slice(0, 80))} is not an http address`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`openUrl: ${u.protocol} is not an http address`);
  return `${u.protocol}//${u.host}${target.path}`;
}

// ── what an address asks for (R9 review F6) ─────────────────────────────────────

export interface AskedAddress {
  tab: TabId | null;
  /** what the address asks to be chosen, read as the page reads it */
  select: { name: SelectName; value: string } | null;
  /** an address parameter that names nothing usable, in words (not hex, not an id of its kind, a path outside the project) */
  problems: string[];
}

const TAB = /^[a-z]{2,16}$/;
const SELECTORS: readonly SelectName[] = ['mesh', 'recording', 'file', 'vox', 'run', 'receipt'];
const KIND_NAME: Readonly<Record<SelectName, string>> = { mesh: 'a mesh', recording: 'a recording', file: 'a file', vox: 'a VoxVision record', run: 'a run', receipt: 'a receipt', draft: 'a draft', card: 'a card' };

/**
 * What an address asks for: its tab and the one thing it chooses (mesh=, recording=, file=, vox=, run=, receipt=), read from
 * its query and from beside the token after # (as the page reads them). The token (t=) is never read or repeated.
 */
export function askedOf(address: string): AskedAddress {
  const params = new Map<string, string>();
  for (const part of String(address ?? '').split(/[?#&]/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq);
    if (name === 't' || params.has(name)) continue;
    params.set(name, part.slice(eq + 1));
  }
  const tabRaw = params.get('tab');
  const tab = tabRaw && TAB.test(tabRaw) ? tabRaw as TabId : null;
  const problems: string[] = [];
  let select: AskedAddress['select'] = null;
  for (const name of SELECTORS) {
    const raw = params.get(name);
    if (raw === undefined || select) continue;
    const shown = raw.length > 64 ? `${raw.slice(0, 63)}…` : raw;
    if (name === 'mesh' || name === 'recording' || name === 'file') {
      const path = pathOfHex(raw);
      if (path === null) { problems.push(`The address asks for ${KIND_NAME[name]} as "${shown}", which is not a path written as hex, so it names nothing`); continue; }
      if (!projectPath(path)) { problems.push(`The address names a path outside this project (${path.length > 120 ? `${path.slice(0, 119)}…` : path}), so nothing of it is shown`); continue; }
      select = { name, value: path };
    } else {
      const ok = name === 'vox' ? VOX_ID.test(raw) : name === 'run' ? OPERATION_ID.test(raw) : RECEIPT_ID.test(raw);
      if (!ok) { problems.push(`The address asks for ${KIND_NAME[name]} as "${shown}", which is not ${name === 'vox' ? 'a record\'s id' : name === 'run' ? 'an operation id' : 'a receipt\'s id'}, so it names nothing`); continue; }
      select = { name, value: raw };
    }
  }
  return { tab, select, problems };
}

/** What a page has to show on its tab (tab 6: its meshes and recordings, in its list's order; tab 5: its records; the
 *  preview: the asked file when it is a file of the project). */
export interface PageHas { meshes?: readonly string[]; recordings?: readonly string[]; records?: readonly string[]; files?: readonly string[] }

/**
 * What a page shows for what its address asked (`asked`), given what it has: the asked one when it has it; otherwise its first
 * (tab 6's first mesh, tab 5's first record), with a notice that says what was asked, why it is not shown and what is shown
 * instead. An address that asks for nothing in particular gets the first, with no notice (as the page always did).
 */
export function shownFor(asked: AskedAddress, has: PageHas): { shown: { name: SelectName; value: string } | null; notice: string | null } {
  const sel = asked.select;
  const onVox = sel?.name === 'vox' || asked.tab === 'voxvision';
  const first: { name: SelectName; value: string } | null = onVox
    ? (has.records?.length ? { name: 'vox', value: has.records[0] } : null)
    : (has.meshes?.length ? { name: 'mesh', value: has.meshes[0] } : null);
  const instead = first ? `${first.value} is shown instead` : onVox ? 'this project has no record to show' : 'this project has no mesh to show';
  if (asked.problems.length && !sel) return { shown: first, notice: `${asked.problems[0]}: ${instead}.` };
  if (!sel) return { shown: first, notice: null };
  // the preview shows the file asked for, or nothing (it has no "first" to show instead)
  if (sel.name === 'file' && has.files) return has.files.includes(sel.value) ? { shown: sel, notice: null } : { shown: null, notice: `${sel.value} is not a file of this project, so nothing is previewed.` };
  const list = sel.name === 'mesh' ? has.meshes : sel.name === 'recording' ? has.recordings : sel.name === 'vox' ? has.records : undefined;
  if (!list) return { shown: sel, notice: null };
  if (list.includes(sel.value)) return { shown: sel, notice: null };
  const of = sel.name === 'mesh' ? 'meshes' : sel.name === 'recording' ? 'recordings' : 'VoxVision records';
  return { shown: first, notice: `${sel.value} is not one of this project's ${of}, so it is not shown: ${instead}.` };
}
