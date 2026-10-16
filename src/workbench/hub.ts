/**
 * R5 (H131): the parts of the terminal Workbench drawn from the one workspace frame (src/contracts/workspace.ts, made by
 * src/ops/workspace-frame.ts buildWorkspaceFrame, the frame the browser companion and Studio draw too), laid out as the
 * operator's references lay them out (codex-ui-references 01, 02, 11, 12, 13 and 14):
 *
 *   row 1        TIMMY, the project, the ten tabs as boxed labels; the active one amber (a heavy box), a waiting count in
 *                its box's top edge (⚠ and the number); full labels where they fit, else their first words, else the keys
 *                with the active tab's name at the end; every cell keeps its place whichever tab is active
 *   row 2        the tab's workflow actions as numbered boxes: the one primary next step amber (filled, ▶), one not available
 *                now quiet, its `why` said when it is selected; Enter runs it through a path the Workbench has, else shows
 *                the command to copy (src/workbench/controller.ts runAction)
 *   Home         the connection cards, as observed (● live green only for an observed answer; ○ configured; ✕ unreachable
 *                or refused, amber; · not set up with its step; ? unknown), and a preview: what the companion and Studio
 *                show, in words (the board, the files, the last run), with Companion · Show (c) to see it rendered
 *   Chat         the pipeline row (intent → predict → sandbox → receipt) of the newest run, from its records, and the event
 *                log, newest at the top
 *   the log      Activity & log's newest lines, from the frame's log
 *
 * The tabs, the actions' labels and commands, and the connections' words are the frame's, never made here; the short labels
 * are the frame's labels' first words. Pure: the same frame and state always draw the same rows.
 */
import type { ChatSurface } from '../contracts/chat-session.js';
import type { RunDetail } from '../contracts/run-detail.js';
import { TABS, tabOf, type ConnectionState, type TabId, type WorkspaceAction, type WorkspaceConnection, type WorkspaceFrame, type WorkspaceLogEntry } from '../contracts/workspace.js';
import { turnOf, turnStopWords } from '../ops/workspace-frame.js';
import { sameFolder } from '../project/index.js';
import { KIND_WORD, TIMMY_LOGS } from './state.js';
import { boxOf, type Glyphs } from './frame.js';
import type { Data, PipelineStage, TurnRow, View } from './model.js';
import type { WorkspaceId } from './nav.js';
import { turnEndWords as stopTableEndWords } from '../contracts/stop-words.js';
import { clock, count, cut, lineCells, pickRanked, took, wrapSegs, wrapText, type Line, type Role, type Seg } from './text.js';
import type { ViewCtx } from './views.js';

const S = (text: string, role: Role = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Seg => ({ text, role, ...o });
const heading = (text: string): Line => [S(text.toUpperCase(), 'secondary', { bold: true })];
const key = (k: string): Seg => S(`[${k}]`, 'action');
const blank: Line = [];

const ago = (iso: string | number | undefined | null, now: number): string => {
  const t = typeof iso === 'number' ? iso : iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return 'at an unknown time';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

// ── the tabs and the Workbench's workspaces ────────────────────────────────────

/** Home and Chat draw their own right column; every other tab shows a Workbench workspace with Context beside it. */
export const isHub = (page: TabId): boolean => page === 'home' || page === 'chat';

/** The workspace a tab opens: its first (TABS), except Home, which the Workbench draws as its connections hub. */
export const workspaceOfPage = (page: TabId): WorkspaceId => (page === 'home' ? 'connections' : tabOf(page).workbench[0]);

/** The workspaces a tab gathers, in its order: the same key again moves to the next (Home: its hub alone). */
export const workspacesOf = (page: TabId): readonly WorkspaceId[] => (page === 'home' ? ['connections'] : tabOf(page).workbench);

/** The tab a workspace belongs to: the tab that opens it, else the first that gathers it (God's Eye View: Fleet & Clef). */
export function pageOf(ws: WorkspaceId): TabId {
  if (ws === 'connections') return 'home';
  const others = TABS.filter((t) => t.id !== 'home');
  return (others.find((t) => t.workbench[0] === ws) ?? others.find((t) => t.workbench.includes(ws)) ?? TABS[0]).id;
}

/** The frame's tabs, or the contract's (no waiting count) until the frame is first read. */
export const frameTabs = (f: WorkspaceFrame | undefined): WorkspaceFrame['tabs'] => f?.tabs ?? TABS.map((t) => ({ id: t.id, key: t.key, label: t.label, refs: t.refs, waiting: 0 }));

/** A tab's short label: the first word of the frame's label ("Chat & Intent": Chat). */
export const shortLabel = (label: string): string => label.split(/\s+/)[0] ?? label;

// ── row 1: TIMMY, the project, the tabs ────────────────────────────────────────

export interface PageHit { x0: number; x1: number; y0: number; y1: number; page: TabId }

/**
 * How the tabs' labels are said: their full labels, their first words, or their keys (with the active tab's name in a slot of
 * its own at the row's end). R5 (H131; the QA round's defect 4): the form is chosen by the width and the project's name alone,
 * never by which tab is active or which carries a badge, so the tabs keep their place and their width whichever is active.
 */
export type TabForm = 'full' | 'short' | 'keys';
const FORMS: readonly TabForm[] = ['full', 'short', 'keys'];

function labelIn(t: WorkspaceFrame['tabs'][number], form: TabForm): string {
  switch (form) {
    case 'full': return `${t.key} ${t.label}`;
    case 'short': return `${t.key} ${shortLabel(t.label)}`;
    default: return t.key;
  }
}

/**
 * Row 1 as `rows` rows (3: boxed labels; 1: a short terminal), exactly `width` cells each, and where each tab is (for a
 * click). The project's name is cut before a form is given up, but never below its first few letters.
 *
 * R5 (H131; defect 4, "a stable tab header"): every tab's cell has the same width in a form whichever tab is active; what
 * waits on you is drawn without moving anything: on a boxed tab, in its box's top edge (⚠ and the count); on a one-row bar,
 * in a cell every tab keeps for it (⚠ alone). The keys form says the active tab's name in a slot of its own at the end,
 * as wide as the longest name it may hold.
 */
export function tabBar(tabs: WorkspaceFrame['tabs'], active: TabId, project: string, width: number, rows: 1 | 3, g: Glyphs): { lines: Line[]; hits: PageHit[]; form: TabForm } {
  const brand = 'TIMMY';
  const sep = ` ${g.sep} `;
  // a one-row bar keeps one cell in every tab for ⚠, and its brackets mark the active tab
  const cellW = (t: WorkspaceFrame['tabs'][number], form: TabForm): number => lineCells([S(labelIn(t, form))]) + 2 + (rows === 1 ? 1 : 0);
  // the keys form's slot for the active tab's name: as wide as the longest (a name that does not fit is cut)
  const slotW = Math.max(...tabs.map((t) => lineCells([S(t.label)])));
  const fits = (form: TabForm, name: string): { gap: number; slot: number } | null => {
    const prefix = lineCells([S(`${brand}${name ? `${sep}${name}` : ''} `)]);
    const cells = tabs.reduce((n, t) => n + cellW(t, form), 0);
    const slot = form === 'keys' ? Math.min(slotW, Math.max(0, width - prefix - cells - tabs.length - 1)) : 0;
    const extra = form === 'keys' ? (slot ? slot + 1 : 0) : 0;
    if (prefix + cells + (tabs.length - 1) + extra <= width) return { gap: 1, slot };
    if (prefix + cells + extra <= width) return { gap: 0, slot };
    return null;
  };
  // the fullest form that fits with the whole name, then with the name cut (to 12, then 6 letters), then without it
  const names = [project, cut(project, 12, g.ellipsis), cut(project, 6, g.ellipsis), ''];
  let form: TabForm = 'keys';
  let name = '';
  let gap = 0;
  let slot = 0;
  outer: for (const n of names) {
    for (const f of FORMS) {
      const ok = fits(f, n);
      if (ok) { form = f; name = n; gap = ok.gap; slot = ok.slot; break outer; }
    }
  }
  // the tabs reach the row's end, as the references' do: what is left is shared out evenly inside the cells, around their
  // labels, and the rest goes between TIMMY's name and the first tab (the same whichever tab is active)
  const slotRoom = slot ? slot + 1 : 0;
  const used = lineCells([S(`${brand}${name ? `${sep}${name}` : ''} `)]) + tabs.reduce((n, t) => n + cellW(t, form), 0) + gap * (tabs.length - 1) + slotRoom;
  const spare = Math.max(0, width - used);
  const per = 2 * Math.floor(spare / (2 * tabs.length));
  const lead = spare - per * tabs.length;
  const prefixSegs: Seg[] = [S(brand, 'strong'), ...(name ? [S(sep, 'secondary'), S(name, 'strong')] : []), S(' '.repeat(1 + lead))];
  const prefixW = lineCells(prefixSegs);
  const half = ' '.repeat(per / 2);
  const hits: PageHit[] = [];
  const activeName = tabs.find((t) => t.id === active)?.label ?? '';
  const slotSegs: Seg[] = slot ? [S(' '), S(cut(activeName, slot, g.ellipsis).padStart(slot), 'focus')] : [];
  if (rows === 1) {
    const line: Line = [...prefixSegs];
    let x = prefixW;
    tabs.forEach((t, i) => {
      const on = t.id === active;
      const label = labelIn(t, form);
      const mark = t.waiting > 0 ? g.warn : ' ';
      const segs: Seg[] = [S(`${on ? '[' : ' '}${half}${label}${half}${on ? ']' : ' '}`, on ? 'focus' : 'text'), S(mark, 'attention')];
      const w = lineCells(segs);
      hits.push({ x0: x, x1: x + w - 1, y0: 0, y1: 0, page: t.id });
      line.push(...segs);
      x += w;
      if (i < tabs.length - 1 && gap) { line.push(S(' ')); x += 1; }
    });
    line.push(...slotSegs);
    return { lines: [line], hits, form };
  }
  const top: Line = [S(' '.repeat(prefixW))];
  const mid: Line = [...prefixSegs];
  const bot: Line = [S(' '.repeat(prefixW))];
  let x = prefixW;
  tabs.forEach((t, i) => {
    const on = t.id === active;
    const b = boxOf(g, on);
    const edge: Role = on ? 'focus' : 'border';
    const label = labelIn(t, form);
    const inner = lineCells([S(label)]) + per;
    // what waits on you there, in the top edge (one edge cell first where the box has room for it, then ⚠ and the count; ⚠
    // alone where the count does not fit: a cut number would say another count)
    const before = inner >= 2 ? 1 : 0;
    const room = Math.max(0, inner - before);
    const counted = `${g.warn}${t.waiting}`;
    const badge = t.waiting <= 0 ? '' : lineCells([S(counted)]) <= room ? counted : lineCells([S(g.warn)]) <= room ? g.warn : '';
    const badgeW = lineCells([S(badge)]);
    top.push(...(badge
      ? [S(`${b.tl}${b.h.repeat(before)}`, edge), S(badge, 'attention'), S(`${b.h.repeat(Math.max(0, inner - before - badgeW))}${b.tr}`, edge)]
      : [S(`${b.tl}${b.h.repeat(inner)}${b.tr}`, edge)]));
    mid.push(S(b.v, edge), S(`${half}${label}${half}`, on ? 'focus' : 'text'), S(b.v, edge));
    bot.push(S(`${b.bl}${b.h.repeat(inner)}${b.br}`, edge));
    hits.push({ x0: x, x1: x + inner + 1, y0: 0, y1: 2, page: t.id });
    x += inner + 2;
    if (i < tabs.length - 1 && gap) { for (const l of [top, mid, bot]) l.push(S(' ')); x += 1; }
  });
  if (slot) { mid.push(...slotSegs); top.push(S(' '.repeat(slot + 1))); bot.push(S(' '.repeat(slot + 1))); }
  return { lines: [top, mid, bot], hits, form };
}

// ── row 2: the workflow actions ────────────────────────────────────────────────

export interface ActionHit { x0: number; x1: number; i: number }

/** What Enter does with an action: a path the Workbench has, or the command shown to copy. */
export type ActionRoute =
  | { kind: 'page'; page: TabId; words: string }
  | { kind: 'key'; key: string; words: string }
  | { kind: 'workspace'; ws: WorkspaceId; words: string }
  | { kind: 'run'; doc: string; block: string; words: string }
  | { kind: 'composer'; words: string }
  | { kind: 'abort'; words: string }
  // R5 (H131; the finish line, item 3): the chat's fixes the Workbench carries out (src/workbench/setup-paths.ts)
  | { kind: 'free-models'; words: string }
  | { kind: 'model'; words: string }
  | { kind: 'check'; words: string }
  | { kind: 'setup'; which: 'init' | 'chat'; words: string }
  | { kind: 'show'; where: 'the REPL (timmy)' | 'a shell'; words: string };

/** The frame's commands this Workbench runs through a path of its own (its keys and workspaces); every other is shown. */
const BY_KEY: Readonly<Record<string, { key: string; words: string }>> = {
  '/stop': { key: 'x', words: 'Enter stops what Stop current names (as x does)' },
  '/studio': { key: 's', words: 'Enter is Studio · Show (as s is)' },
  'timmy watch': { key: 'c', words: 'Enter is Companion · Show (as c is)' },
  '/project new <name>': { key: 'n', words: 'Enter asks the new project\'s name (as n does)' },
  '/project <name>': { key: 'p', words: 'Enter opens the project picker (as p does)' },
  '/project list': { key: 'p', words: 'Enter opens the project picker (as p does)' },
};
const BY_WORKSPACE: Readonly<Record<string, { ws: WorkspaceId; words: string }>> = {
  '/room': { ws: 'control', words: 'Enter opens the Control Room, where what waits on you is' },
  '/jobs': { ws: 'control', words: 'Enter opens the Control Room' },
  '/tools': { ws: 'tools', words: 'Enter opens All tools' },
  '/files': { ws: 'files', words: 'Enter opens Files' },
  '/workflows': { ws: 'workflows', words: 'Enter opens Workflows' },
  '/vox': { ws: 'voxvision', words: 'Enter opens VoxVision\'s records' },
  '/project new <name> --from <starter>': { ws: 'templates', words: 'Enter opens Templates: Enter on a starter makes the project' },
};

export function routeOf(a: Pick<WorkspaceAction, 'command'>): ActionRoute {
  const cmd = a.command.trim();
  const tab = /^[0-9]$/.test(cmd) ? TABS.find((t) => t.key === cmd) : undefined;
  if (tab) return { kind: 'page', page: tab.id, words: `Enter opens ${tab.key} ${tab.label}` };
  const k = BY_KEY[cmd];
  if (k) return { kind: 'key', key: k.key, words: k.words };
  const w = BY_WORKSPACE[cmd];
  if (w) return { kind: 'workspace', ws: w.ws, words: w.words };
  if (cmd === 'type in Chat, then Enter') return { kind: 'composer', words: 'Enter opens the composer' };
  // (while a turn runs the frame says where it stops, by the surface that sent it: src/ops/workspace-frame.ts turnStopCommand,
  // "Esc in the composer that sent it (the Workbench)", "Ctrl+C in the REPL that sent it", "Stop on the companion page …")
  // R5 (H131; the QA of e7f853e, item 16): and one sent elsewhere is asked to stop, by its id (src/agent/chat-turn.ts
  // requestTurnStop), as its own key would stop it there
  if (/^(?:Esc in the composer|Ctrl\+C in the REPL|Stop on the companion page)\b/.test(cmd)) return { kind: 'abort', words: 'Enter stops the turn being answered here (as Esc in the composer does), or asks one sent from elsewhere to stop, as its own key would' };
  // R5 (H131; the finish line, item 3): the frame's fixes for a chat that cannot answer, done here where the Workbench can do
  // them honestly; the setup, which asks for a key, is a shell's (its command and what it asks are shown)
  if (cmd === '/model free') return { kind: 'free-models', words: 'Enter lists the free models in this computer\'s catalog; Enter on one makes it the chat\'s model (free-only stays on)' };
  if (cmd === '/model') return { kind: 'model', words: 'Enter lists what Ollama has now, to choose the local model (on OpenRouter: shows /model for the REPL)' };
  if (cmd === 'timmy workspace check') return { kind: 'check', words: 'Enter checks the connections from here: free requests only, no model called' };
  // every `timmy init …` (and a stray `timmy setup`, which asks nothing: it makes a governed workspace's folders) is the setup
  if (cmd === 'timmy setup' || cmd === '/setup' || /^timmy init(?:\s|$)/.test(cmd)) {
    return { kind: 'setup', which: 'init', words: /--chat local\b/.test(cmd)
      ? 'Enter shows what timmy init asks, and chooses the local model here: what Ollama lists now (no key, no charge)'
      : 'Enter shows the setup to run in a shell (timmy init) and what it asks; a key is typed there, hidden' };
  }
  if (cmd === '/setup chat') return { kind: 'setup', which: 'chat', words: 'Enter shows how to set the chat\'s Ollama address (the REPL\'s /setup chat, or timmy init in a shell)' };
  const run = /^\/run (\S+) (\S+)$/.exec(cmd);
  if (run && !cmd.includes('<')) return { kind: 'run', doc: run[1], block: run[2], words: 'Enter opens its Run confirm (it asks before anything runs)' };
  const where = cmd.startsWith('/') ? 'the REPL (timmy)' as const : 'a shell' as const;
  return { kind: 'show', where, words: `Enter shows the command to copy (it runs in ${where}; nothing is run from here)` };
}

/**
 * Row 2's buttons: each action as a numbered box ([n label]); the primary next step filled amber with ▶; one not available now
 * quiet; the selected one marked ▸ while the bar has the keyboard. Labels are cut evenly when they do not all fit (the whole
 * label is on the row below, when the bar has the keyboard).
 */
/** `room` cells shared out among labels that need `need` cells each: the shortest first, each its whole label or an even
 *  share of what is left, at least `min` cells. */
function shares(need: readonly number[], room: number, min = 4): number[] {
  const out = need.map(() => 0);
  let left = Math.max(0, room);
  const order = need.map((n, i) => ({ n, i })).sort((a, b) => a.n - b.n);
  order.forEach((o, k) => {
    const fair = Math.floor(left / (order.length - k));
    const give = Math.max(Math.min(o.n, fair), Math.min(o.n, min));
    out[o.i] = give;
    left -= give;
  });
  return out;
}

/** Texts sharing `room` cells (shares), each cut at a word where it must be; what a cut at a word leaves unused is given to
 *  the texts that were cut, in the order `first` names (the most needed first), so the row is used to its end. */
function fillShares(words: readonly string[], room: number, g: Glyphs, first: readonly number[] = words.map((_, i) => i)): string[] {
  const rooms = shares(words.map((w) => lineCells([S(w)])), room);
  const texts = words.map((w, i) => cut(w, Math.max(1, rooms[i]), g.ellipsis));
  for (const i of first) {
    const left = room - texts.reduce((n, t) => n + lineCells([S(t)]), 0);
    if (left <= 0) break;
    if (texts[i] === words[i]) continue;
    // (what it drew, and what is left: what it was given and did not draw is in `left` already)
    texts[i] = cut(words[i], lineCells([S(texts[i])]) + left, g.ellipsis);
  }
  return texts;
}

export function actionsRow(acts: readonly WorkspaceAction[], sel: number, focused: boolean, width: number, g: Glyphs): { line: Line; hits: ActionHit[] } {
  if (!acts.length) return { line: [S('Nothing to do on this tab yet.', 'secondary')], hits: [] };
  const glyph = (a: WorkspaceAction): string => (a.primary ? `${g.next} ` : '');
  const text = (a: WorkspaceAction, room?: number): string => {
    const label = room === undefined ? a.label : cut(a.label, Math.max(4, room), g.ellipsis);
    return `${glyph(a)}${a.n} ${label}`;
  };
  // each box: its marker cell, [ , its text, ]
  const overhead = acts.reduce((n, a) => n + 1 + 2 + lineCells([S(`${glyph(a)}${a.n} `)]), 0) + (acts.length - 1);
  const need = acts.map((a) => lineCells([S(a.label)]));
  const full = need.reduce((n, w) => n + w, 0);
  // R5 (H131; the QA round's defect 15): where the labels do not all fit, the primary next step keeps its whole label first,
  // and the others share what is left, a short one keeping its whole label and leaving the rest to the longer ones
  let rooms: Array<number | undefined> = acts.map(() => undefined);
  if (overhead + full > width) {
    const keep = acts.findIndex((a) => a.primary && a.enabled);
    const others = acts.map((_, i) => i).filter((i) => i !== keep);
    const kept = keep >= 0 && width - overhead - need[keep] >= others.length * 4 ? keep : -1;
    const share = kept >= 0 ? others : acts.map((_, i) => i);
    const given = shares(share.map((i) => need[i]), width - overhead - (kept >= 0 ? need[kept] : 0));
    rooms = acts.map((_, i) => (i === kept ? undefined : given[share.indexOf(i)]));
  }
  const line: Line = [];
  const hits: ActionHit[] = [];
  let x = 0;
  acts.forEach((a, i) => {
    const on = focused && i === sel;
    const marker = S(on ? g.cursor : ' ', 'action');
    const t = text(a, rooms[i]);
    const segs: Seg[] = a.primary && a.enabled
      ? [S('[', 'action', { inverse: true, bold: true }), S(t, 'action', { inverse: true, bold: true }), S(']', 'action', { inverse: true, bold: true })]
      : a.enabled
        ? [S('[', 'border'), S(t, 'text'), S(']', 'border')]
        : [S('[', 'secondary'), S(t, 'secondary'), S(']', 'secondary')];
    const box = on && !(a.primary && a.enabled) ? segs.map((s) => ({ ...s, selected: true })) : segs;
    const w = lineCells(box);
    line.push(marker, ...box);
    hits.push({ x0: x + 1, x1: x + w, i });
    x += 1 + w;
    if (i < acts.length - 1) { line.push(S(' ')); x += 1; }
  });
  return { line, hits };
}

/** The selected action's words for the row below the buttons: what it is, and what Enter does or why it is not now. */
export function actionWords(a: WorkspaceAction | undefined, g: Glyphs, width = Number.POSITIVE_INFINITY): Line {
  if (!a) return [S('No action is selected.', 'secondary')];
  const route = routeOf(a);
  const head: Seg[] = [S(`${a.n} ${a.label}`, a.enabled ? 'strong' : 'secondary'), S(` ${g.sep} `, 'secondary')];
  if (!a.enabled) return [...head, S(`not now: ${a.why ?? 'not available'}`, 'secondary')];
  // the command first (the same on every surface), then what Enter does with it here, then what it touches. R5 (H131; the QA
  // round's defect 15): where the row is short, what it touches goes first, then Enter's words are said shorter, whole
  const sep = S(` ${g.sep} `, 'secondary');
  const short = route.kind === 'show' ? `Enter shows it to copy (it runs in ${route.where}, not from here)` : route.kind === 'run' ? 'Enter opens its Run confirm' : route.words;
  const forms: Line[] = [
    [...head, S(a.command, 'action'), S(` ${g.sep} ${a.effect} ${g.sep} `, 'secondary'), S(route.words, 'text')],
    [...head, S(a.command, 'action'), sep, S(route.words, 'text')],
    [...head, S(a.command, 'action'), sep, S(short, 'text')],
    [...head, S(a.command, 'action')],
  ];
  return forms.find((f) => lineCells(f) <= width) ?? forms[forms.length - 1];
}

// ── the connections ────────────────────────────────────────────────────────────

/** A connection's mark and word (its color never alone): ● live green only for an observed answer. */
export function connectionMark(state: ConnectionState, g: Glyphs): { text: string; role: Role } {
  switch (state) {
    case 'live': return { text: `${g.bullet} live`, role: 'live' };
    case 'configured': return { text: `${g.ring} configured`, role: 'text' };
    case 'not set up': return { text: `${g.dot} not set up`, role: 'secondary' };
    case 'unreachable': return { text: `${g.fail} unreachable`, role: 'failure' };
    case 'refused': return { text: `${g.fail} refused`, role: 'failure' };
    default: return { text: '? unknown', role: 'secondary' };
  }
}

/** How many rows a connection card takes at least (its edges, its words, its step); R5 (H131): its words and its step wrap,
 *  up to WORDS_ROWS and STEP_ROWS rows, rather than being cut where there is room (the QA round's defect 15). */
export const CARD_ROWS = 4;
const WORDS_ROWS = 2;
const STEP_ROWS = 3;

/** Rows of a card's inside: `segs` wrapped to `room`, at most `max` rows, the last one cut where more was left. */
function cardRows(segs: Seg[], room: number, max: number, g: Glyphs): Line[] {
  const rows = wrapSegs(segs, room, '  ');
  if (rows.length <= max) return rows;
  return [...rows.slice(0, max - 1), [...rows[max - 1], S(' '), ...rows.slice(max).flat().map((x) => ({ ...x, text: x.text.replace(/^\s+/, '') }))]].map((r, i, all) => (i === all.length - 1 ? fitRow(r, room, g) : r));
}

/** A row cut to `room` cells at its end (an ellipsis where it was cut). */
function fitRow(line: Line, room: number, g: Glyphs): Line {
  const out: Line = [];
  let used = 0;
  for (const x of line) {
    const w = lineCells([x]);
    if (used + w <= room) { out.push(x); used += w; continue; }
    const t = cut(x.text, room - used, g.ellipsis);
    if (t) out.push({ ...x, text: t });
    break;
  }
  return out;
}

/** What this Workbench itself knows of the companion's and Studio's servers (it starts them): said beside the frame's words,
 *  never instead of them, and never as an observation that makes the card live. */
function serverWords(c: ViewCtx, id: WorkspaceConnection['id']): string | null {
  if (id !== 'companion' && id !== 'studio') return null;
  const s = id === 'companion' ? c.ui.companion : c.ui.studio;
  const show = id === 'companion' ? '[c] Companion · Show' : '[s] Studio · Show';
  if (s.starting) return `starting it here… ${show}`;
  if (s.serving) return `this Workbench serves it at ${s.address} ${c.g.sep} ${show}`;
  if (s.other) return `another Timmy serves it at ${s.address} ${c.g.sep} ${show}`;
  return `not served by this Workbench ${c.g.sep} ${show} starts it`;
}

/**
 * R5 (H131; the QA of e7f853e, defect 24): the run detail's time, labelled: the operation's, from its record, and the job's or
 * the turn's own when the item is one (from its own record), with the time between them said for what it holds: the
 * prediction, any wait on you and the receipts, none of which is recorded apart (so no part of it is said to be the wait).
 */
export function tookWords(time: RunDetail['time'], own?: { kind: 'job' | 'turn'; ms: number | null | undefined; running?: boolean }): string {
  const op = time.elapsedMs;
  const opWords = op === null ? 'the operation\'s time is not recorded' : time.endedAt ? `operation took ${took(op)}` : `operation running for ${took(op)}`;
  if (!own || own.ms === null || own.ms === undefined || !Number.isFinite(own.ms)) return opWords;
  const mine = own.kind === 'job' ? (own.running ? `job running for ${took(own.ms)}` : `job ran ${took(own.ms)}`) : `turn took ${took(own.ms)}`;
  const gap = op !== null && time.endedAt && !own.running ? op - own.ms : null;
  return `${mine} · ${opWords}${gap !== null && gap >= 100 ? `, ${took(gap)} of it around the ${own.kind} (its prediction, any wait on you, its receipts: not recorded apart)` : ''}`;
}

/** The frame's words for free-only being on, in the OpenRouter connection's detail (src/ops/workspace-frame.ts). */
const FREE_ONLY_WORDS = /; free-only on \(a model not known to be free is refused\)/;

/** R5 (H131; the QA of e7f853e, defect 20): free-only as the frame's OpenRouter detail says it: on when it says so; off when it
 *  names the key and not free-only (the frame says free-only only while it is on); null when it says neither (no key). */
export function freeOnlyOf(conn: Pick<WorkspaceConnection, 'id' | 'detail'>): 'on' | 'off' | null {
  if (conn.id !== 'openrouter' || !conn.detail) return null;
  if (/\bfree-only on\b/.test(conn.detail)) return 'on';
  return /^key from /.test(conn.detail) ? 'off' : null;
}

/** One connection as a card of CARD_ROWS rows or more, `width` cells wide: its name and its mark on the top edge, its words, then its
 *  detail and the step that sets it up. The selected card's box is heavy, and amber while the list has the keyboard. */
export function connectionCard(conn: WorkspaceConnection, selected: boolean, focused: boolean, width: number, c: ViewCtx): Line[] {
  const g = c.g;
  const b = boxOf(g, selected);
  const edge: Role = selected && focused ? 'focus' : 'border';
  const inner = Math.max(4, width - 2);
  const mark = connectionMark(conn.state, g);
  const markT = ` ${mark.text} `;
  const titleRoom = Math.max(3, inner - 1 - lineCells([S(markT)]) - 2);
  const title = ` ${cut(conn.label, titleRoom - 2, g.ellipsis)} `;
  const fill = Math.max(0, inner - 1 - lineCells([S(title)]) - lineCells([S(markT)]) - 1);
  const top: Line = [S(`${b.tl}${b.h}`, edge), S(title, selected && focused ? 'focus' : 'strong'), S(b.h.repeat(fill), edge), S(markT, mark.role), S(`${b.h}${b.tr}`, edge)];
  const body = (segs: Seg[]): Line => {
    const room = inner - 2;
    const out: Seg[] = [];
    let used = 0;
    for (const s of segs) {
      if (used >= room) break;
      const w = lineCells([s]);
      if (used + w <= room) { out.push(s); used += w; continue; }
      const t = cut(s.text, room - used, g.ellipsis);
      if (t) { out.push({ ...s, text: t }); used += lineCells([S(t)]); }
      break;
    }
    return [S(b.v, edge), S(' '), ...out, S(' '.repeat(Math.max(0, room - used))), S(' '), S(b.v, edge)];
  };
  const step = conn.setup && conn.state !== 'live' ? conn.setup : null;
  const extra = serverWords(c, conn.id);
  // R5 (H131; the QA of e7f853e, defect 20): the OpenRouter card says free-only first, on or off, as the frame's detail has it
  // (src/ops/workspace-frame.ts: "key from …; free-only on (…)" when it is on; with a key and no such words, it is off)
  const free = freeOnlyOf(conn);
  const said = free === 'on' && conn.detail ? conn.detail.replace(FREE_ONLY_WORDS, '') : conn.detail;
  // its step first (what to do), then free-only, its detail and what this Workbench serves
  const detail: Seg[] = [
    ...(step ? [S(`${g.arrow} `, 'secondary'), S(step, 'action')] : []),
    ...(free ? [S(`${step ? `  ${g.sep} ` : ''}free-only ${free}`, 'strong'), S(free === 'on' ? ': a model not known to be free is refused' : ': a paid model can be asked', 'secondary')] : []),
    ...(said ? [S(`${step || free ? `  ${g.sep} ` : ''}${said}`, 'secondary')] : []),
    ...(extra ? [S(`${said || step || free ? `  ${g.sep} ` : ''}${extra}`, 'secondary')] : []),
  ];
  const wordsRole: Role = conn.state === 'unreachable' || conn.state === 'refused' ? 'failure' : 'text';
  const room = inner - 2;
  const words = cardRows([S(conn.words, wordsRole)], room, WORDS_ROWS, g);
  const steps = cardRows(detail.length ? detail : [S(conn.observedAt ? `observed ${clock(conn.observedAt)}` : 'never observed answering here', 'secondary')], room, STEP_ROWS, g);
  return [top, ...words.map(body), ...steps.map(body), [S(`${b.bl}${b.h.repeat(inner)}${b.br}`, edge)]];
}

/** Home's left column: the connection cards from the frame, as observed. */
export function homeView(c: ViewCtx): View {
  const lines: Line[] = [];
  const items: View['items'] = [];
  const f = c.data.frame;
  lines.push(heading('Connections, as last observed'));
  lines.push(...wrapText('live: an answer seen in the last 30 minutes; a setting alone is configured', Math.max(8, c.width)).map((t) => [S(t, 'secondary')]));
  if (!f) {
    lines.push(blank, [S(c.data.frameError ? `The workspace frame could not be read: ${c.data.frameError}. [r] reads it again.` : 'Reading the workspace frame (src/ops/workspace-frame.ts)…', c.data.frameError ? 'failure' : 'secondary')]);
    return { lines, items };
  }
  const cur = Math.max(0, Math.min(f.connections.length - 1, c.ui.cursor['center:connections'] ?? 0));
  const focused = c.ui.focus === 'center';
  f.connections.forEach((conn, i) => {
    const card = connectionCard(conn, i === cur, focused, c.width, c);
    items.push({ line: lines.length, item: { kind: 'conn', key: `conn:${conn.id}`, conn }, rows: card.length });
    lines.push(...card);
  });
  lines.push(...wrapText('timmy workspace check asks each one once with free requests and records what answered (a shell command; nothing is asked from here). Enter on a card: its step.', Math.max(8, c.width)).map((t) => [S(t, 'secondary')]));
  return { lines, items };
}

// ── Home's preview ─────────────────────────────────────────────────────────────

const markOfJob = (mark: string, g: Glyphs): { glyph: string; role: Role } => (
  mark === 'ok' ? { glyph: g.ok, role: 'text' } : mark === 'failed' ? { glyph: g.fail, role: 'failure' } : mark === 'running' ? { glyph: g.run, role: 'text' } : mark === 'unchanged' ? { glyph: '=', role: 'text' } : mark === 'stopped' ? { glyph: g.unicode ? '■' : '#', role: 'text' } : { glyph: '?', role: 'secondary' });

/**
 * Home's right column: what the companion and Studio show, as a terminal can say it (the board's cards, the files, the last
 * run), and the way to see them rendered. Nothing is drawn as a picture: no canvas and no 3D in the terminal.
 */
export function previewView(c: ViewCtx): View {
  const { data, g } = c;
  const f = data.frame;
  const lines: Line[] = [];
  const para = (t: string, role: Role = 'secondary', indent = ''): Line[] => wrapText(t, Math.max(8, c.width - indent.length)).map((x) => [S(`${indent}${x}`, role)]);
  const surface = (id: 'companion' | 'studio', name: string, k: string, show: string, what: string): void => {
    const conn = f?.connections.find((x) => x.id === id);
    // R5 (H131; the QA of e7f853e, defect 19): the observation's age, as every connection card says it; never ● live without one
    const observed = conn?.observedAt ?? null;
    const mark = conn && (conn.state !== 'live' || observed) ? connectionMark(conn.state, g) : { text: '? unknown', role: 'secondary' as Role };
    const when = conn ? (observed ? `checked ${ago(observed, c.now)}` : 'never checked') : '';
    const at = f ? (f.surfaces[id].openAtStart ? 'opens at start' : 'opens when asked') : '';
    lines.push(...wrapSegs([S(name.padEnd(10), 'secondary', { bold: true }), S(mark.text, mark.role), S([when, at].filter(Boolean).map((x) => `  ${g.sep} ${x}`).join(''), 'secondary')], Math.max(8, c.width), '  '));
    const s = id === 'companion' ? c.ui.companion : c.ui.studio;
    // R5 (H131; the QA of e7f853e, defect 2): what the key shows, in truth (the companion: these records in words; Studio: the canvas)
    lines.push(...wrapSegs([S('  '), key(k), S(` ${show}`, 'text'), S(s.serving ? `  ${g.sep} served here at ${s.address}` : s.other ? `  ${g.sep} served by another Timmy` : `  ${what}`, 'secondary')], Math.max(8, c.width), '    '));
  };
  surface('companion', 'COMPANION', 'c', 'Companion · Show', 'these records in a browser page, in words');
  surface('studio', 'STUDIO', 's', 'Studio · Show', 'the canvas');
  lines.push(blank);
  // the board: Studio's cards for this project, read from its records (src/studio/project-cards.ts)
  const st = data.studio;
  lines.push(heading('Board (Studio\'s cards, from this project\'s records)'));
  if (st.state === 'ready') {
    const v = st.value;
    if (!v.cards.length) lines.push(...para('No card yet: a card appears for each workflow document, parameter file, flow, VoxVision record and run.', 'secondary', '  '));
    else {
      const kinds = ['workflow', 'params', 'flow', 'vox', 'run', 'unreadable'];
      const names: Record<string, string> = { workflow: 'workflow', params: 'parameter', flow: 'flow', vox: 'VoxVision', run: 'run', unreadable: 'unreadable' };
      lines.push([S(`  ${kinds.map((k) => [k, v.cards.filter((x) => x.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => count(n, names[k])).join(` ${g.sep} `)}${v.operations.length ? ` ${g.sep} ${count(v.operations.length, 'operation')}` : ''}`, 'text')]);
      for (const card of v.cards.slice(0, 6)) lines.push([S(`  ${g.dot} `, 'secondary'), S(card.title, 'text'), S(`  ${card.state}`, 'secondary'), S(card.operation ? ` ${g.sep} ${card.operation}` : '', 'secondary')]);
      if (v.cards.length > 6) lines.push([S(`  and ${v.cards.length - 6} more: Studio · Show (s), or 4 Studio`, 'secondary')]);
    }
  } else if (st.state === 'failed') lines.push(...para(`Studio's cards could not be read: ${st.why}`, 'failure', '  '));
  else lines.push([S('  Reading Studio\'s cards…', 'secondary')]);
  lines.push(blank);
  // the files: the project's own; R5 (H131; the QA round's defect 24): Timmy's own logs (logs/*.log, which Timmy writes in the
  // folder it runs in) are counted apart, and said so
  const own = (gr: (typeof data.files.groups)[number]): number => gr.files.filter((f) => !TIMMY_LOGS.has(f.rel)).length;
  const logs = data.files.timmyLogs ?? 0;
  const projectFiles = data.files.total - logs;
  lines.push(heading(`Files (${projectFiles})`));
  if (!projectFiles) lines.push([S('  No files yet: this project is blank.', 'secondary')]);
  else {
    const kinds = data.files.groups.map((gr) => [gr.kind, own(gr)] as const).filter(([, n]) => n).map(([k, n]) => count(n, k === 'other' ? 'other file' : KIND_WORD[k]));
    lines.push(...wrapSegs([S(kinds.join(` ${g.sep} `), 'text')], Math.max(8, c.width - 2), '  ').map((r) => [S('  '), ...r]));
    lines.push(...wrapSegs([S(`in ${data.project.shown} ${g.sep} 0 Logs & Receipts lists them`, 'secondary')], Math.max(8, c.width - 2), '  ').map((r) => [S('  '), ...r]));
  }
  if (logs) lines.push(...wrapSegs([S(`not counted: ${count(logs, 'log')} Timmy writes itself (logs/*.log)`, 'secondary')], Math.max(8, c.width - 2), '  ').map((r) => [S('  '), ...r]));
  lines.push(blank);
  // the last run
  lines.push(heading('Last run'));
  const last = data.jobs[0];
  if (!last) lines.push([S('  Nothing has run in this project yet.', 'secondary')]);
  else {
    const m = markOfJob(last.mark, g);
    lines.push([S(`  ${m.glyph} `, m.role), S(last.id, 'strong'), S(`  ${last.word}`, m.role), S(`  ${last.label}`, 'text')]);
    lines.push([S(`    ${last.live ? `running for ${last.elapsed}` : `${ago(last.endedAt ?? last.startedAt, c.now)}, took ${last.elapsed}`} ${g.sep} ${last.operation ? `operation ${last.operation}` : 'no operation'}`, 'secondary')]);
  }
  if (f?.unknown.length) {
    lines.push(blank, heading('Not known'));
    for (const u of f.unknown) lines.push(...para(`${u.field}: ${u.why}`, 'secondary', '  '));
  }
  lines.push(blank);
  // R5 (H131; the QA of e7f853e, defect 2): the companion says these in words too; only Studio draws (its canvas)
  lines.push(...para('A terminal says these in words, and so does the companion (c), in a browser page; Studio (s) draws the canvas. No Timmy surface draws images or 3D yet.'));
  return { lines, items: [] };
}

// ── the chat turn being answered now ───────────────────────────────────────────

/** A receipt's short id, as the Control Room says it (its hash's first 8 hex), or the id as it was given when it is not a hash. */
export const receiptShort = (h: string): string => (/^sha256[:_][0-9a-f]{8}/.test(h) ? h.slice(7, 15) : h);

/** What a chat surface is called in words (src/agent/chat-turn.ts says them so too); a Workbench turn here is "another"
 *  Workbench's, since this one's own is known without the frame. */
const SURFACE_AWAY: Readonly<Record<string, string>> = { repl: 'the REPL', monitor: 'the monitor', workbench: 'another Workbench', companion: 'the companion' };

/** R5 (H131; the QA round's defect 1): the chat turn being answered now in this project. */
export interface TurnNow {
  /** this Workbench's own (its composer sent it; Esc in the composer, or x, stops it) */
  mine: boolean;
  /** where it is being answered, in words ("this Workbench", "the REPL") */
  where: string;
  /** when it began (ISO) */
  since: string;
  /** the surface that sent it (its stop is that surface's key: src/ops/workspace-frame.ts turnStopWords) */
  surface: ChatSurface;
  /** R5 (H131; the operator's 22:32 order, items 1 and 2): its identity (the frame's activity.chatTurn.id, its hold's id): a
   *  stop is asked of it by this id (src/agent/chat-turn.ts requestTurnStop); absent when the frame did not name one */
  id?: string;
}

/**
 * R5 (H131; the QA round's defect 1): the chat turn being answered now, one fact for row 2's run state and Stop current,
 * Activity, the Chat tab's event log and its actions: this Workbench's own while it sends (known at once), else the workspace
 * frame's (any surface's, read at most once a second). R5 (H131; the operator's 22:32 order, item 1): a frame's turn has
 * ended when its identity says so, never by surface and time: it is this Workbench's own turn, now ended, or a sealed
 * receipt (the Workbench's reading or the frame's) names it as its turn_id; a next turn taken at once is still running.
 */
export function chatTurnNow(d: Pick<Data, 'turn' | 'frame' | 'project' | 'turns'>): TurnNow | null {
  const own = d.turn;
  if (own?.state === 'sending') return { mine: true, where: 'this Workbench', since: new Date(own.at).toISOString(), surface: 'workbench', ...(own.id ? { id: own.id } : {}) };
  const f = d.frame;
  const t = f && f.project.id === d.project.id ? f.activity.chatTurn : null;
  if (!f || !t) return null;
  const id = t.id;
  if (id && (id === own?.id || (d.turns ?? []).some((x) => x.turn === id) || (f.chat?.turns ?? []).some((x) => x.turn === id))) return null;
  return { mine: false, where: SURFACE_AWAY[t.surface] ?? t.surface, since: t.since, surface: t.surface as ChatSurface, ...(id ? { id } : {}) };
}

/** R5 (H131; the QA of e7f853e, item 16): how a turn being answered stops, in the frame's words (turnStopWords) and with what
 *  x or Enter does here: this Workbench's own stops here; another surface's is asked to stop by its id, as its own key would. */
export function turnStopHere(t: TurnNow): string {
  if (t.mine) return 'Esc in the composer or x stops it';
  return t.id ? `x asks it to stop, as ${turnStopWords(t.surface)} does` : `${turnStopWords(t.surface)} stops it, there`;
}

/** R5 (H131; the QA of e7f853e, item 17): how a sealed turn ended, in the frame's words (src/ops/workspace-frame.ts turnOf):
 *  "stopped (asked from the companion)" when a surface other than the one that sent it asked it to stop. R6 (H140): from the
 *  one table (src/contracts/stop-words.ts), here the Workbench: "stopped by you" where the Workbench asked. */
export function turnEndWords(t: Pick<TurnRow, 'state' | 'surface' | 'stoppedBy'>): string {
  return stopTableEndWords(t, 'workbench'); // R6 (H140): the one table's words, who asked always said ("by you" where the Workbench asked)
}

// ── Chat: the pipeline row and the event log ───────────────────────────────────

const STAGES: ReadonlyArray<{ id: 'intent' | 'predict' | 'sandbox' | 'receipt'; name: string }> = [
  { id: 'intent', name: 'intent' }, { id: 'predict', name: 'predict' }, { id: 'sandbox', name: 'sandbox' }, { id: 'receipt', name: 'receipt' },
];

/** A stage's role: .intent and .predict amber when recorded; a verified receipt green; a failure amber with ✕; else quiet. */
function stageRole(id: string, s: PipelineStage): Role {
  if (s.state === 'failed') return 'failure';
  if (s.state === 'not run yet' || s.state === 'none' || s.state === 'unknown') return 'secondary';
  if (id === 'receipt') return s.verified ? 'live' : 'text';
  if (id === 'intent' || id === 'predict') return 'action';
  return 'text';
}

/** The Chat tab's pipeline row: intent → predict → sandbox → receipt of the newest run, from its records; two rows. */
export function pipelineLines(c: ViewCtx, width: number): Line[] {
  const g = c.g;
  const p = c.data.pipeline;
  const arrow = ` ${g.arrow} `;
  const stages = STAGES.map((st) => {
    const s: PipelineStage = p ? p[st.id] : { state: 'not run yet', words: 'not run yet' };
    const mark = s.state === 'failed' ? `${g.fail} ` : st.id === 'receipt' && s.verified ? `${g.ok} ` : '';
    return { st, s, mark, role: stageRole(st.id, s) };
  });
  const fixed = stages.reduce((n, x) => n + 2 + lineCells([S(`${x.mark}${x.st.name} ${g.sep} `)]), 0) + lineCells([S(arrow)]) * (stages.length - 1);
  // R5 (H131; the QA round's defect 15): the stages share the row: a short one keeps its words whole and leaves the rest to
  // the longer ones (an even share cut "sealed before it ran…" with 20 columns free)
  // (what is left goes first to the receipt, then the intent, what ran it, and the prediction). R5 (H131; the QA of e7f853e,
  // defect 11): the receipt's words are kept whole first ("sealed fb72a565 · verified here" was cut to "verified…"), and the
  // other three share the rest (the request is the one cut first: the line under says the run it is)
  const words = stages.map((x) => x.s.words);
  const room = width - fixed;
  const receiptRoom = Math.max(1, Math.min(lineCells([S(words[3])]), room - 3 * 12));
  const three = fillShares(words.slice(0, 3), room - receiptRoom, g, [2, 1, 0]);
  const texts = [...three, cut(words[3], receiptRoom, g.ellipsis)];
  const row: Line = [];
  stages.forEach((x, i) => {
    if (i) row.push(S(arrow, 'secondary'));
    const edge: Role = x.role === 'action' || x.role === 'live' || x.role === 'failure' ? x.role : 'border';
    row.push(S('[', edge), S(`${x.mark}${x.st.name}`, x.role, { bold: x.role !== 'secondary' }), S(` ${g.sep} `, 'secondary'), S(texts[i], x.role === 'secondary' ? 'secondary' : 'text'), S(']', edge));
  });
  const from = p?.kind === 'chat'
    ? (p.live ? 'being answered now: its request as sent from here; its receipt is sealed once it is answered' : 'from its records: its request, a prediction if one was sealed, the turn, its receipt (verified here)')
    : 'from its records: the operation\'s request, its predict receipt, its job, its receipt (verified here)';
  const source: Line = p?.operation
    ? [S(p.kind === 'chat' ? 'newest operation ' : 'newest run ', 'secondary'), S(p.label ?? '', 'strong'), S(` ${g.sep} operation ${p.operation} ${g.sep} ${from}`, 'secondary')]
    : [S('Nothing has run in this project yet: each stage says not run yet. A run from 3 Workflows, or a message sent here, fills it as its records are written.', 'secondary')];
  return [row, source];
}

/** A log entry's role and mark: its tone, said in its words too (a failure amber with ✕; live green only when the frame says). */
function toneOf(e: WorkspaceLogEntry, g: Glyphs): { role: Role; mark: string } {
  switch (e.tone) {
    case 'failure': return { role: 'failure', mark: `${g.fail} ` };
    case 'attention': return { role: 'attention', mark: `${g.warn} ` };
    case 'live': return { role: 'live', mark: `${g.ok} ` };
    default: return { role: 'text', mark: '' };
  }
}

/** One log entry on one row: its time, its tag, its words (cut at the row's end). */
export function logLine(e: WorkspaceLogEntry, width: number, g: Glyphs): Line {
  const t = toneOf(e, g);
  const head: Seg[] = [S(`${clock(e.at)} `, 'secondary'), S(`[${e.tag}] `, 'secondary')];
  const room = Math.max(4, width - lineCells(head));
  return [...head, S(cut(`${t.mark}${e.words}`, room, g.ellipsis), t.role)];
}

const SURFACE_NAME: Readonly<Record<string, string>> = { repl: 'the REPL', monitor: 'the monitor', workbench: 'the Workbench', companion: 'the companion' };

/** R5 (H131; the QA round's defect 8): a sealed chat turn as a log entry: how it ended, where, the model and its receipt (its
 *  receipt keeps hashes only, and so do these words: never a word of the message or the answer). R5 (H131; the QA of
 *  e7f853e, item 17): the words are the frame's own for the turn (src/ops/workspace-frame.ts turnOf), so a stop another surface
 *  asked for reads the same everywhere: "turn stopped (asked from the companion) in the REPL · …". */
export function turnEntry(t: TurnRow): WorkspaceLogEntry {
  return {
    at: t.at, tag: 'chat', tone: t.state === 'failed' ? 'failure' : 'neutral', words: turnOf(t).words,
    ...(t.operation ? { operation: t.operation } : {}), source: `receipt ${t.receipt}`,
  };
}

/** R5 (H131): the log's entries that are events (a line a job printed is tab 0's), the newest first, with the project's sealed
 *  chat turns among them. */
export function eventsNow(data: ViewCtx['data']): WorkspaceLogEntry[] {
  const log = (data.frame?.log ?? []).filter((e) => e.tag !== 'job.output');
  const turns = (data.turns ?? []).map(turnEntry);
  return [...log, ...turns].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** The Chat tab's right column: what runs now (the jobs, and a chat turn being answered), then the events, the chat turns
 *  among them, the newest at the top. */
export function eventLogView(c: ViewCtx): View {
  const { data, g, width } = c;
  const lines: Line[] = [];
  const live = [...data.jobs, ...(data.away ?? [])].filter((j) => j.live);
  const turn = chatTurnNow(data);
  lines.push(heading(`Running now (${live.length + (turn ? 1 : 0)})`));
  if (!live.length && !turn) lines.push([S('  Nothing runs.', 'secondary')]);
  if (turn) {
    // R5 (H131; the QA of e7f853e, the lead's batch): when it began in this Workbench's own clock (the frame's words carry
    // none), how long it has run, and how it stops from here
    const since = Date.parse(turn.since);
    lines.push(...wrapSegs([S(`  ${g.run} running `, 'text'), S('chat turn', 'strong'), S(`  being answered in ${turn.where}`, 'text'),
      S(Number.isFinite(since) ? ` ${g.sep} since ${clock(turn.since)} ${g.sep} ${took(c.now - since)}` : '', 'secondary'), S(` ${g.sep} ${turnStopHere(turn)}`, 'secondary')], width, '    '));
  }
  for (const j of live) {
    const where = sameFolder(j.root, data.project.root) ? '' : ` ${g.sep} in ${j.project}`;
    lines.push([S(`  ${g.run} running `, 'text'), S(j.id, 'strong'), S(`  ${j.label}`, 'text'), S(` ${g.sep} ${j.elapsed}${where}`, 'secondary')]);
  }
  lines.push(blank, heading('Event log, newest at the top'));
  const log = eventsNow(data);
  if (!data.frame && !log.length) lines.push([S('  Reading the workspace frame…', 'secondary')]);
  else if (!log.length) lines.push([S('  No event yet: no job has run and no chat turn is sealed in this project.', 'secondary')]);
  for (const e of log) {
    const t = toneOf(e, g);
    const head = `${clock(e.at)} [${e.tag}] `;
    const [first = '', ...more] = wrapText(`${t.mark}${e.words}`, Math.max(10, width - head.length), g.ellipsis);
    lines.push([S(clock(e.at), 'secondary'), S(` [${e.tag}] `, 'secondary'), S(first, t.role)]);
    for (const m of more) lines.push([S(' '.repeat(head.length)), S(m, t.role)]);
  }
  return { lines, items: [] };
}

// ── Activity & log's newest lines, and the key-hint line ───────────────────────

/** The collapsed log: the frame's newest `n` entries, the newest first, each on one row. */
export function newestLog(c: Pick<ViewCtx, 'data' | 'g'>, n: number, width: number): Line[] {
  const f = c.data.frame;
  if (!f) return [[S(c.data.frameError ? `The log could not be read: ${c.data.frameError}` : 'Reading the log…', c.data.frameError ? 'failure' : 'secondary')]];
  // R5 (H131; the QA round's defect 9): events in words; what a job printed is tab 0's (0 Logs & Receipts)
  const events = eventsNow(c.data);
  if (!events.length) return [[S('No event yet: no job has run in this project. [a] expands Activity (this Workbench\'s own notices too).', 'secondary')]];
  return events.slice(0, n).map((e) => logLine(e, width, c.g));
}

/** The key-hint line: the keys that matter most first, each whole or left out. */
export function hintLine(width: number, o: { tabs?: boolean } = {}): Line {
  const h = (k: string, w: string, rank: number): { line: Line; rank: number } => ({ line: [key(k), S(` ${w}`, 'secondary')], rank });
  // R5 (H131; the QA round's defect 16): [?] keys is the last hint drawn and the last left out; on a narrow row the less
  // needed hints go first
  return pickRanked([
    ...(o.tabs === false ? [] : [h('1–0', 'tabs', 1)]),
    h('Enter', 'acts', 2), h('Tab', 'zones', 4), h('x', 'Stop', 3), h('c', 'Companion · Show', 5), h('s', 'Studio · Show', 6), h('a', 'log', 7),
    h('/', 'find', 8), h(',', 'settings', 10), h('i', 'Context', 9), h('?', 'keys', 0),
  ], width, S('  '));
}
