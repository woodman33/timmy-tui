/**
 * R6 (H145): what is on a project's board, read from its saved document, for the browser companion's tab 4 (reference 06): the
 * artifact cards (src/studio/artifacts.ts; companion/studio-canvas/src/artifacts.js), the reference images
 * (src/studio/references.ts), Timmy's drawn cards and the project cards placed from Studio's panel, and the words people and Timmy
 * wrote on it, each with what it links to. Read only, from the board as last saved (src/studio/document.ts storedSnapshot: nothing
 * is moved, nothing opened for use), and only for the project asked for: a card of another project kept on the board (a paste, or
 * the canvas a Timmy home had before each project had its own) is named as such, and nothing of it is read.
 *
 * Imports nothing but node's path helpers, so any surface can read a board the same way.
 */
import { basename } from 'node:path';

export const BOARD_ITEMS_SCHEMA = 'timmy.studio-board/1';
/** How many items the list carries (the board's first, in reading order: page by page, top to bottom, left to right). */
export const BOARD_ITEMS_MAX = 120;
const PROJECT_ID = /^[0-9a-f]{16}$/;
const OPERATION_ID = /^o[0-9a-f]{8}$/;
const VOX_ID = /^v[0-9a-f]{8}$/;
const RECEIPT_KEY = /^[0-9a-f]{8,64}$/;
const REF_SRC = /^\/api\/canvas\/ref\/([0-9a-f]{16})\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
/** Timmy's drawn cards (companion/studio-canvas/src/cards.js CARD_SHAPES) and the artifact card (artifacts.js ARTIFACT_SHAPE). */
const DRAWN = new Set(['timmy-workflow', 'timmy-params', 'timmy-result']);
const ARTIFACT = 'timmy-artifact';

export type BoardItemKind = 'artifact' | 'reference' | 'card' | 'words' | 'image' | 'other-project';

/** One thing on the board, as tab 4 lists it. */
export interface BoardItem {
  /** the tldraw shape it is (its id), and the name of the board's page it is on */
  shape: string;
  page: string;
  kind: BoardItemKind;
  /** an artifact's kind (vox, run, receipt), a card's (workflow, params, result; a placed card's: vox, run, flow …), the words' shape */
  sub?: string;
  /** its title in words (an artifact's, a card's, a reference's file name; the start of a text) */
  title: string;
  /** what it says, or what it is, in short */
  excerpt: string;
  /** a draft of Timmy's still waiting for Accept or Discard (its id): it is on the board as proposed */
  draft: string | null;
  /** made by a test double, as its record says (an artifact's FAKE mark) */
  fake?: true;
  /** what it links to: a VoxVision record, an operation (its run), a receipt */
  target?: { vox?: string; run?: string; receipt?: string };
  /** a reference image: its board copy (served for this board only) and where it came from */
  ref?: { file: string; path: string; sha256: string; bytes: number; from: string };
}

export interface BoardItems {
  schema: typeof BOARD_ITEMS_SCHEMA;
  items: BoardItem[];
  /** how many of each kind the board holds (all of them, not only those listed) */
  counts: Record<string, number>;
  /** the drafts waiting for Accept or Discard (each once) */
  drafts: string[];
  more: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const one = (v: unknown, max = 160): string => {
  const c = Array.from(str(v).replace(/\s+/g, ' ').trim());
  return c.length > max ? `${c.slice(0, max - 1).join('')}…` : c.join('');
};
/** A card's state as it was read when it was placed (the board keeps those words; nothing here reads the record again). */
const asPlaced = (state: unknown): string => { const w = one(state, 228); return w ? `as placed: ${w}` : ''; };
const pad = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n) + 1e8).padStart(10, '0') : '');

/** The words of a tldraw rich text (its text nodes, in order; a paragraph ends with a space). */
export function richWords(rich: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown, depth: number): void => {
    const o = obj(n);
    if (!o || depth > 12) return;
    if (typeof o.text === 'string') out.push(o.text);
    if (Array.isArray(o.content)) { for (const c of o.content) walk(c, depth + 1); if (o.type === 'paragraph') out.push(' '); }
  };
  walk(rich, 0);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** What a card's or an artifact's id links to. */
function targetOf(kind: string, card: string, operation: unknown, receipt: unknown): BoardItem['target'] | undefined {
  const id = card.slice(card.indexOf(':') + 1);
  const t: NonNullable<BoardItem['target']> = {};
  if (kind === 'vox' && VOX_ID.test(id)) t.vox = id;
  if (kind === 'run' && OPERATION_ID.test(id)) t.run = id;
  if (kind === 'receipt' && RECEIPT_KEY.test(id)) t.receipt = id;
  if (!t.run && typeof operation === 'string' && OPERATION_ID.test(operation)) t.run = operation;
  if (!t.receipt && typeof receipt === 'string' && RECEIPT_KEY.test(receipt)) t.receipt = receipt;
  return Object.keys(t).length ? t : undefined;
}

/** The board's items for project `projectId`, from its saved snapshot (null or unreadable: none). */
export function boardItems(snapshot: unknown, projectId: string, max = BOARD_ITEMS_MAX): BoardItems {
  const out: BoardItems = { schema: BOARD_ITEMS_SCHEMA, items: [], counts: {}, drafts: [], more: 0 };
  const store = obj(obj(snapshot)?.store);
  if (!store || !PROJECT_ID.test(projectId)) return out;
  const records = Object.values(store).map(obj).filter((r): r is Obj => !!r);
  const pages = new Map(records.filter((r) => r.typeName === 'page').map((r) => [str(r.id), { name: one(r.name, 80) || 'a page', index: str(r.index) }]));
  const assets = new Map(records.filter((r) => r.typeName === 'asset').map((r) => [str(r.id), r]));
  const shapes = records.filter((r) => r.typeName === 'shape');
  const byId = new Map(shapes.map((s) => [str(s.id), s]));
  /** the page a shape is on (through its parents: a group, a frame) */
  const pageOf = (s: Obj): string => {
    let at: Obj | undefined = s;
    for (let i = 0; i < 20 && at; i++) {
      const parent = str(at.parentId);
      if (pages.has(parent)) return parent;
      at = byId.get(parent);
    }
    return '';
  };
  /** where a shape is on its page: its x and y, and its groups' and frames' (a child's are its parent's own; rotation aside) */
  const placeOf = (s: Obj): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    let at: Obj | undefined = s;
    for (let i = 0; i < 20 && at; i++) {
      x += typeof at.x === 'number' && Number.isFinite(at.x) ? at.x : 0;
      y += typeof at.y === 'number' && Number.isFinite(at.y) ? at.y : 0;
      at = byId.get(str(at.parentId));
    }
    return { x, y };
  };
  const drafts = new Set<string>();
  const all: Array<BoardItem & { order: string }> = [];
  for (const s of shapes) {
    const type = str(s.type);
    const p = obj(s.props) ?? {};
    const meta = obj(s.meta) ?? {};
    const page = pages.get(pageOf(s));
    const d = obj(meta.timmyDraft);
    const draft = d && typeof d.id === 'string' && /^draft-[0-9a-f]{8,32}$/.test(d.id) ? d.id : null;
    if (draft) drafts.add(draft);
    const at = placeOf(s);
    const base = { shape: str(s.id), page: page?.name ?? 'a page', draft, order: `${page?.index ?? '~'}|${pad(at.y)}|${pad(at.x)}|${str(s.id)}` };
    const placed = obj(meta.timmyProjectCard);
    // Timmy's cards (drawn, artifacts, placed from the panel): another project's is named, and nothing of it is read
    const owner = type === ARTIFACT || DRAWN.has(type) ? { id: str(p.projectId), name: one(p.project, 80) } : placed ? { id: str(placed.projectId), name: one(placed.project, 80) } : null;
    if (owner && owner.id !== projectId) {
      const name = owner.name || 'another project';
      all.push({ ...base, kind: 'other-project', title: `a card of ${name}`, excerpt: `kept apart: shown on ${name}'s own board only, so nothing of it is read here` });
      continue;
    }
    if (type === ARTIFACT) {
      const card = str(p.card);
      const kind = str(p.kind);
      const data = obj(p.data) ?? {};
      const target = targetOf(kind, card, undefined, undefined);
      all.push({ ...base, kind: 'artifact', sub: kind, title: one(p.title) || card, excerpt: asPlaced(data.state), ...(data.fake === true ? { fake: true as const } : {}), ...(target ? { target } : {}) });
      continue;
    }
    if (DRAWN.has(type)) {
      const card = str(p.card);
      const target = targetOf(card.slice(0, Math.max(0, card.indexOf(':'))), card, meta.timmyOperation, undefined);
      all.push({ ...base, kind: 'card', sub: type.slice('timmy-'.length), title: one(p.title) || card, excerpt: one(p.command, 240), ...(target ? { target } : {}) });
      continue;
    }
    if (placed) {
      const card = str(placed.card);
      const target = targetOf(str(placed.kind), card, placed.operation, placed.receipt);
      all.push({ ...base, kind: 'card', sub: one(placed.kind, 40), title: one(placed.title) || card, excerpt: asPlaced(placed.state), ...(target ? { target } : {}) });
      continue;
    }
    if (type === 'image') {
      const asset = assets.get(str(p.assetId));
      const ref = obj(obj(asset?.meta)?.timmyRef);
      const src = REF_SRC.exec(str(obj(asset?.props)?.src));
      if (ref && src) {
        if (str(ref.project) !== projectId || src[1] !== projectId) {
          const name = one(ref.projectName, 80) || 'another project';
          all.push({ ...base, kind: 'other-project', title: `a reference image of ${name}`, excerpt: `kept apart: shown on ${name}'s own board only, so nothing of it is read here` });
          continue;
        }
        const path = one(ref.path, 300);
        all.push({
          ...base, kind: 'reference', title: basename(path) || one(obj(asset?.props)?.name), excerpt: one(ref.from, 300) || `from ${path}`,
          ref: { file: `${src[2]}.${src[3]}`, path, sha256: src[2], bytes: typeof ref.bytes === 'number' ? ref.bytes : 0, from: one(ref.from, 300) },
        });
        continue;
      }
      all.push({ ...base, kind: 'image', title: one(obj(asset?.props)?.name) || 'an image', excerpt: 'an image put on the board by hand, kept inside the board itself: Studio shows it' });
      continue;
    }
    // words: a note, a text, a shape with text, a frame's name; a reference's caption is its image's, so it is not listed apart
    if (meta.timmyRefCaption || type === 'group' || type === 'arrow') continue;
    const words = type === 'frame' ? one(p.name) : richWords(p.richText);
    if (!words) continue;
    all.push({ ...base, kind: 'words', sub: type, title: one(words, 80), excerpt: one(words, 240) });
  }
  all.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  for (const it of all) out.counts[it.kind] = (out.counts[it.kind] ?? 0) + 1;
  out.items = all.slice(0, max).map(({ order: _o, ...it }) => it);
  out.drafts = [...drafts].sort();
  out.more = Math.max(0, all.length - max);
  return out;
}
