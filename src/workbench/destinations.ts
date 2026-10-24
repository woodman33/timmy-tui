/**
 * R11 round 7 (H177; the operator's order of 2026-10-24, "translate the hierarchy into character cells", and the lead's D3):
 * the Workbench's destinations, grouped as the Chat screen's rail groups them (R11 H167, step 3a, the plan's section 2):
 * Chat; WORK Files · Workflows · Runs & receipts · Canvas; CREATE Vision · Motion & 3D; CONNECT Models & accounts · Tools &
 * integrations · Control Room. The rail (src/workbench/chat-shell.ts) and the tabbed pages' header (destinationsRow, drawn by
 * src/workbench/home-journey.ts headerRows and src/workbench/screen.ts) read this one list, so the groups and the names are the
 * same on every screen. The names are the plan's and stay as they are; no destination is added or renamed here.
 *
 * The keys 1 to 9 and 0 are the shared workspace frame's (src/contracts/workspace.ts TABS) and do not change: each destination
 * says the key of the page it opens. Fleet & Clef (8) has no destination of its own since D3 folds it into Control Room: while
 * its page shows, Control Room's cell is the one marked, and the page head names Fleet & Clef. Files and Runs & receipts are two
 * destinations of one page (0): 0 opens the one shown last, 0 again the other.
 *
 * destinationsRow: the header's row in the fullest form that fits the width: the plan's names with their keys and the group
 * labels; the rail's wide names with keys; the rail's short names with keys; the short names alone; the short names with a rule
 * between the groups; the keys alone (one cell a page), grouped by rules, with the shown destination's name in a slot at the
 * row's end. In every form the shown destination is marked "> " and amber (as the rail marks it: one amber active tab), ⚠
 * marks a page where the frame says something waits on you (with its count on the status row), ◌ an unfinished page (the
 * frame's word for it; said in words where the row has room); the brackets stay the buttons'. Every cell keeps its place
 * whichever destination is shown and whatever waits: a form is chosen by the width alone, and a mark's cell is kept on every
 * destination that can carry one.
 */
import { tabOf, TABS, type TabId, type WorkspaceFrame } from '../contracts/workspace.js';
import type { Glyphs } from './frame.js';
import type { WorkspaceId } from './nav.js';
import { cut, fit, lineCells, type Line, type Role, type Seg } from './text.js';

const S = (text: string, role: Role = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Seg => ({ text, role, ...o });

/**
 * A destination: `label` is the plan's name (the companion's and the finder's), `wide` fits the Chat rail's 18 columns (16
 * cells), `short` its 14 (12 cells); `page` is the tab it opens and `ws` the workspace of that tab when not its first.
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

/** The destinations in order (the groups flattened). */
export const RAIL: ReadonlyArray<RailItem> = RAIL_GROUPS.flatMap((x) => x.items);

/** The rail's items, in order: the project selector, New project, the destinations, then Help and the finder. */
export const RAIL_ITEMS: readonly string[] = ['project', 'new', ...RAIL.map((r) => r.id), 'help', 'find'];

/** The page a destination's cell stands for when the page shown is not any destination's own: Fleet & Clef under Control Room (D3). */
const FOLDED: Readonly<Partial<Record<TabId, string>>> = { fleet: 'control' };

/**
 * Whether a destination is the one shown: its page is the page shown and, where a page has two destinations (0: Files and
 * Runs & receipts), the one whose workspace shows; a folded page (Fleet & Clef) marks the destination it folds into.
 */
export function destinationShown(r: RailItem, page: TabId, workspace: WorkspaceId): boolean {
  if (FOLDED[page]) return r.id === FOLDED[page];
  if (r.page !== page) return false;
  if (r.id === 'files') return workspace === 'files';
  if (r.id === 'logs') return workspace !== 'files';
  return true;
}

/** The destination a workspace is, or belongs to (its page's first): what the header marks and the body's crumb names. */
export function destinationOf(workspace: WorkspaceId, page?: TabId): RailItem | undefined {
  const pg = page ?? pageOfWs(workspace);
  return RAIL.find((r) => destinationShown(r, pg, workspace));
}

/** The page a workspace is shown on (src/workbench/hub.ts pageOf says the same; kept here so this module imports no view). */
function pageOfWs(ws: WorkspaceId): TabId {
  if (ws === 'connections') return 'home';
  const others = TABS.filter((t) => t.id !== 'home');
  return (others.find((t) => t.workbench[0] === ws) ?? others.find((t) => t.workbench.includes(ws)) ?? TABS[0]).id;
}

/** The workspaces that are a page's own matter (never Files, which every page reaches): an unfinished page's mark is theirs. */
const ownWorkspaces = (page: TabId): readonly WorkspaceId[] => tabOf(page).workbench.filter((w) => w !== 'files' && !TABS.some((o) => o.id !== page && o.workbench.includes(w)));

/** The frame's tabs by id (the contract's until the frame is first read). */
const tabsById = (tabs: WorkspaceFrame['tabs'] | undefined): Map<TabId, WorkspaceFrame['tabs'][number]> => {
  const m = new Map<TabId, WorkspaceFrame['tabs'][number]>();
  for (const t of tabs ?? TABS.map((d) => ({ id: d.id, key: d.key, label: d.label, refs: d.refs, waiting: 0, ...(d.unfinished ? { unfinished: d.unfinished } : {}) }))) m.set(t.id, t);
  return m;
};

/** What a destination's cell may carry beside its name: ⚠ while something waits on you on its page, ◌ on an unfinished page. */
export type CellMark = 'waiting' | 'unfinished' | null;

/** Whether a destination can carry a mark at all (its cell keeps the room for it, so nothing moves when one appears). */
export function canMark(r: RailItem, tabs?: WorkspaceFrame['tabs']): boolean {
  const t = tabsById(tabs).get(r.page);
  if (!t) return false;
  // what waits on you is counted on Home's and the Control Room's tabs (src/ops/workspace-frame.ts); an unfinished page marks
  // the destination whose workspace is the page's own matter (never Files)
  const waits = r.page === 'home' || r.page === 'control';
  const unfinished = !!t.unfinished && ownWorkspaces(r.page).includes(r.ws ?? tabOf(r.page).workbench[0]);
  return waits || unfinished;
}

/** The mark a destination carries now, from the frame's tabs: ⚠ first (what waits on you comes first), then ◌. */
export function markOf(r: RailItem, tabs?: WorkspaceFrame['tabs']): CellMark {
  const t = tabsById(tabs).get(r.page);
  if (!t) return null;
  if (t.waiting > 0) return 'waiting';
  if (t.unfinished && ownWorkspaces(r.page).includes(r.ws ?? tabOf(r.page).workbench[0])) return 'unfinished';
  return null;
}

/** The mark of a page that is unfinished (its word beside it where the row has room). */
export const unfinishedMark = (g: Pick<Glyphs, 'unicode'>): string => (g.unicode ? '◌' : '~');

/** How the destinations are said: the plan's names, the rail's wide or short names, with or without keys, or the keys alone. */
export type DestForm = 'full' | 'wide' | 'short' | 'words' | 'rules' | 'keys';
const FORMS: readonly DestForm[] = ['full', 'wide', 'short', 'words', 'rules', 'keys'];

/** A destination's cell in a form: a key cell and a name, or the key alone. */
function cellText(r: RailItem, form: DestForm): string {
  const key = tabOf(r.page).key;
  switch (form) {
    case 'full': return `${key} ${r.label}`;
    case 'wide': return `${key} ${r.wide}`;
    case 'short': return `${key} ${r.short}`;
    case 'words':
    case 'rules': return r.short;
    default: return key;
  }
}

export interface DestHit { x0: number; x1: number; y0: number; y1: number; page: TabId; dest: string }

export interface DestRowAsk {
  /** the frame's tabs (their waiting counts and unfinished words); the contract's until the frame is first read */
  tabs?: WorkspaceFrame['tabs'];
  page: TabId;
  workspace: WorkspaceId;
  width: number;
  g: Glyphs;
  /** words before the destinations (a short terminal's one-row header: TIMMY and the project); none on the two-row header */
  prefix?: Line;
}

/** The keys form's cells: one a page (Files and Runs & receipts share 0), in the destinations' order. */
function keyCells(): Array<{ r: RailItem; dests: RailItem[] }> {
  const out: Array<{ r: RailItem; dests: RailItem[] }> = [];
  for (const r of RAIL) {
    const had = out.find((c) => c.r.page === r.page);
    if (had) had.dests.push(r); else out.push({ r, dests: [r] });
  }
  return out;
}

/** The slot the keys form keeps for the shown destination's name: as wide as the widest it may hold (the rail's wide names). */
const SLOT_W = Math.max(...RAIL.map((r) => lineCells([S(r.wide)])));

/**
 * The header's destinations as exactly `width` cells, and where each is (for a click). The form is the fullest that fits the
 * width whole (with the ◌ legend where it leaves room, else without it), chosen by the width alone.
 */
export function destinationsRow(a: DestRowAsk): { line: Line; hits: DestHit[]; form: DestForm } {
  const { g, width } = a;
  const prefix: Line = a.prefix?.length ? [...a.prefix, S(' ')] : [];
  const prefixW = lineCells(prefix);
  const legendText = `${unfinishedMark(g)} unfinished`;
  const anyUnfinished = RAIL.some((r) => markOf(r, a.tabs) === 'unfinished');
  const rule = `${g.unicode ? '│' : '|'}`;
  /** the row's elements in a form: cells (with their room for a mark), group labels or rules between groups */
  type El = { kind: 'cell'; text: string; r: RailItem; mark: boolean; dests: RailItem[] } | { kind: 'label'; text: string } | { kind: 'rule' };
  const elements = (form: DestForm): El[] => {
    const out: El[] = [];
    if (form === 'keys') {
      // one cell a page; a rule between the groups
      const cells = keyCells();
      RAIL_GROUPS.forEach((gr, k) => {
        if (k) out.push({ kind: 'rule' });
        for (const c of cells) if (gr.items.includes(c.r)) out.push({ kind: 'cell', text: cellText(c.r, form), r: c.r, mark: c.dests.some((d) => canMark(d, a.tabs)), dests: c.dests });
      });
      return out;
    }
    RAIL_GROUPS.forEach((gr, k) => {
      if (k) out.push(form === 'rules' ? { kind: 'rule' } : { kind: 'label', text: gr.label ?? '' });
      for (const r of gr.items) out.push({ kind: 'cell', text: cellText(r, form), r, mark: canMark(r, a.tabs), dests: [r] });
    });
    return out;
  };
  // each cell: a cell of air, its marker (the cursor on the shown one, as the actions row marks its selected button), its
  // text, and " ◌" or " ⚠" where it can carry a mark; a group label has two cells of air before it; a rule " │ " three
  const cellsOf = (els: El[]): number => els.reduce((n, e) => n + (e.kind === 'cell' ? 2 + lineCells([S(e.text)]) + (e.mark ? 2 : 0) : e.kind === 'label' ? 2 + lineCells([S(e.text)]) : 3), 0);
  const slotOf = (form: DestForm): number => (form === 'keys' ? 1 + SLOT_W : 0);
  // the fullest form that fits, then the legend where that form leaves it room (the groups' names before the mark's word)
  let form: DestForm = 'keys';
  for (const f of FORMS) if (prefixW + cellsOf(elements(f)) + slotOf(f) <= width) { form = f; break; }
  const withLegend = anyUnfinished && prefixW + cellsOf(elements(form)) + slotOf(form) + 2 + lineCells([S(legendText)]) <= width;
  const els = elements(form);
  // the row reaches the right edge, as the references' tab rows do: what the form leaves over is shared out among the gaps
  // before the groups (a line Ink draws is trimmed at its end, so a row that ends in air would be narrower than the screen)
  const used = prefixW + cellsOf(els) + slotOf(form) + (withLegend ? 2 + lineCells([S(legendText)]) : 0);
  const gaps = els.filter((e) => e.kind !== 'cell').length;
  const spare = Math.max(0, width - used);
  let gapAt = 0;
  const extra = (): string => { const n = gaps ? Math.floor(spare / gaps) + (gapAt < spare % gaps ? 1 : 0) : 0; gapAt += 1; return ' '.repeat(n); };
  const line: Line = [...prefix];
  const hits: DestHit[] = [];
  let x = prefixW;
  const shownOf = (dests: RailItem[]): RailItem | undefined => dests.find((d) => destinationShown(d, a.page, a.workspace));
  els.forEach((e) => {
    if (e.kind === 'label') { const air = extra(); line.push(S(`${air}  `), S(e.text, 'secondary', { bold: true })); x += air.length + 2 + lineCells([S(e.text)]); return; }
    if (e.kind === 'rule') { const air = extra(); line.push(S(`${air} `), S(rule, 'border'), S(' ')); x += air.length + 3; return; }
    const shown = shownOf(e.dests);
    const segs: Seg[] = shown
      ? [S(' '), S(g.cursor, 'focus', { bold: true }), S(e.text, 'focus', { bold: true })]
      : [S('  '), S(e.text, 'text')];
    // the mark: what waits on you first, then unfinished; a space keeps the cell where nothing is marked now
    const marks = e.dests.map((d) => markOf(d, a.tabs));
    const m: CellMark = marks.includes('waiting') ? 'waiting' : marks.includes('unfinished') ? 'unfinished' : null;
    if (e.mark) segs.push(S(' '), S(m === 'waiting' ? g.warn : m === 'unfinished' ? unfinishedMark(g) : ' ', m === 'waiting' ? 'attention' : 'secondary'));
    const w = lineCells(segs);
    // (a cell of two destinations (0) opens the one shown, else the page's first: the click says the page; the page's key
    // again shows the other)
    hits.push({ x0: x, x1: x + w - 1, y0: 0, y1: 0, page: e.r.page, dest: (shown ?? e.dests[0]).id });
    line.push(...segs);
    x += w;
  });
  if (form === 'keys') {
    // the shown destination's name in its slot, right after the keys (a folded page's destination: the page head names the page)
    const shown = RAIL.find((r) => destinationShown(r, a.page, a.workspace));
    // (the name at the slot's right end, so the row ends in words, as the keys form always drew it)
    const slot: Line = [S(' '), S(cut(shown?.wide ?? '', SLOT_W, g.ellipsis).padStart(SLOT_W), 'focus', { bold: true })];
    line.push(...slot);
    x += lineCells(slot);
  }
  if (withLegend) {
    // the legend at the row's end (its room counted with the form)
    const pad = width - x - lineCells([S(legendText)]);
    if (pad >= 2) line.push(S(' '.repeat(pad)), S(legendText, 'secondary'));
  }
  return { line: fit(line, width, g.ellipsis), hits, form };
}
