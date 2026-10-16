/**
 * R4 (H110): what each zone of the Workbench shows, as rows (src/workbench/text.ts), from the records the Workbench read
 * (src/workbench/state.ts) and where the person is. Pure: the same data and state always draw the same rows, so the tests
 * read them without a terminal.
 *
 * Words: a state is always said in words beside any mark; a job's state is Timmy's judgement (src/room/judge.ts) and its
 * outcome src/ops/outcome.ts's (no change is said as such); a cost is a reported number or unknown; an action that cannot
 * run says what it needs; a label says what an action does and to what.
 */
import { isTimmyRecord } from '../agent/core.js';
import type { CapabilityRow } from '../capabilities/index.js';
import { sameFolder } from '../project/index.js';
import { tildePath } from '../utils/home-scrub.js';
import type { RunDetail } from '../contracts/run-detail.js';
import { tabOf, type WorkspaceAction } from '../contracts/workspace.js';
import { turnStopWords } from '../ops/workspace-frame.js';
import { controlItemName, controlRoomView, liveTurnDetail } from './control-tab.js';
import { fleetDetail, fleetItemName, fleetItemOperation, fleetView } from './fleet-tab.js';
import type { Glyphs } from './frame.js';
import { actionsRow, actionWords, chatTurnNow, connectionMark, homeView, hintLine, newestLog, pageOf, receiptShort, routeOf, tookWords, turnEndWords, turnStopHere, type ActionHit, type TurnNow } from './hub.js';
import { logsDetail, logsItemName, logsView } from './logs-tab.js';
import type { Data, Item, Lazy, Overlay, TurnRow, Ui, View } from './model.js';
import { FAMILY_ROWS, GROUP_LABEL, NAV, NOT_IN_TIMMY, navItem, type WorkspaceId } from './nav.js';
import { limitRows } from './tab-columns.js';
import { PRESETS, SETTING_LABELS } from './settings.js';
import { catalogWords, keyFromWords, modelFacts } from './setup-paths.js';
import { KIND_ORDER, KIND_TITLE, KIND_WORD, type FileRow, type JobRow } from './state.js';
import { mcpCallInspector, toolsItemName, toolsItemOperation, toolsView as toolsTabView, type ToolsSearch } from './tools-tab.js';
import { voxDetail, voxItemName, voxItemOperation, voxView } from './voxvision-tab.js';
import { selectedBlock, stateMark, workflowsTabView } from './workflows-tab.js';
import { clock, count, cut, fit, lineCells, spread, took, wrapSegs, wrapText, type Line, type Role, type Seg } from './text.js';

export interface ViewCtx {
  ui: Ui;
  data: Data;
  g: Glyphs;
  /** the inner width of the zone being drawn */
  width: number;
  /** the inner height of the zone being drawn */
  height: number;
  now: number;
  /** slice B: whether this Workbench can run a block itself (the REPL's /run path) and send a chat message */
  can: { run: boolean; runWhy?: string; chat: boolean; chatWhy?: string; detail: boolean; detailWhy?: string };
  /** R5 (H134): the terminal's width, where the caller knows it: tabs 0 and 8 draw their columns side by side from 120 */
  columns?: number;
}

const S = (text: string, role: Role = 'text', o: Omit<Seg, 'text' | 'role'> = {}): Seg => ({ text, role, ...o });
const heading = (text: string): Line => [S(text.toUpperCase(), 'secondary', { bold: true })];
const blank: Line = [];
const key = (k: string): Seg => S(`[${k}]`, 'action');

/** A row a person can select: the cursor's marker and the selection's ground when it is the selected one. */
function row(line: Line, selected: boolean, g: Glyphs): Line {
  const mark = selected ? `${g.cursor} ` : '  ';
  const out: Line = [S(mark, 'action', selected ? { selected: true } : {}), ...line.map((s) => (selected ? { ...s, selected: true } : s))];
  return out;
}

/** R5 (H131): a box's step to take, its words wrapped under themselves (never cut), the selection's mark on its first row. */
function stepRows(words: Line, selected: boolean, g: Glyphs, width: number): Line[] {
  return wrapSegs(words, Math.max(8, width - 2)).map((r, i) => (i === 0 ? row(r, selected, g) : [S('  '), ...r.map((x) => (selected ? { ...x, selected: true } : x))]));
}

/** label: value, the label quiet and padded. */
const field = (label: string, value: string, role: Role = 'text', pad = 12): Line => [S(`${label.padEnd(pad)} `, 'secondary'), S(value, role)];

/** label: value, the value wrapped under itself when it is longer than the row (the Inspector's fields are never cut). */
function fieldRows(label: string, value: string, width: number, role: Role = 'text', pad = 12): Line[] {
  const room = Math.max(8, width - pad - 1);
  const [first = '', ...rest] = wrapText(value, room);
  return [[S(`${label.padEnd(pad)} `, 'secondary'), S(first, role)], ...rest.map((r) => [S(' '.repeat(pad + 1)), S(r, role)])];
}

/** Wrapped text as rows of one role, indented. */
function para(text: string, width: number, role: Role = 'secondary', indent = ''): Line[] {
  return wrapText(text, Math.max(8, width - indent.length)).map((t) => [S(`${indent}${t}`, role)]);
}

const ago = (iso: string | number | undefined, now: number): string => {
  const t = typeof iso === 'number' ? iso : iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return 'at an unknown time';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

const humanBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

// ── the navigation ─────────────────────────────────────────────────────────────

export function navView(c: ViewCtx): View & { prompt: number } {
  const { ui, data, g, height } = c;
  const lines: Line[] = [];
  const items: View['items'] = [];
  lines.push(heading('Current project'));
  lines.push([S(data.project.name, 'strong'), S(data.project.chosen ? '' : '  (this folder)', 'secondary')]);
  if (data.pinnedAway) lines.push([S('pinned; active elsewhere: ', 'secondary'), S(data.pinnedAway, 'attention')]);
  lines.push([key('p'), S(' Switch  ', 'text'), key('n'), S(' New', 'text')]);
  // R4 (H112; the r26 dry run): "[/] Find a workspace" reads as a key only where / finds a workspace now; in All tools, away
  // from the navigation, / searches the tools, and two rows say how to reach the finder instead (the second takes the blank
  // row's place, so nothing below moves). R5 (H131): its row is `prompt`, which a short drawer keeps in view while it searches
  const prompt = lines.length;
  const how = ui.input.field === 'search' ? undefined : finderKeys(ui);
  if (ui.input.field === 'search') lines.push([S('/ ', 'action'), S(ui.input.text, 'text'), S(' ', 'text', { inverse: true })], blank);
  else if (how) lines.push([S('Find a workspace:', 'secondary')], [S(`  ${how}`, 'secondary')]);
  else lines.push([key('/'), S(' Find a workspace', 'secondary')], blank);
  const q = ui.input.field === 'search' ? ui.input.text.trim().toLowerCase() : '';
  const shown = NAV.filter((n) => !q || n.label.toLowerCase().includes(q) || n.title.toLowerCase().includes(q));
  const waiting = data.decisions.total;
  const groups: Array<'create' | 'operate' | 'library'> = ['create', 'operate', 'library'];
  const roomy = height >= 28;
  for (const [gi, gr] of groups.entries()) {
    const inGroup = shown.filter((n) => n.group === gr);
    if (!inGroup.length) continue;
    if (gi && roomy) lines.push(blank);
    lines.push(heading(GROUP_LABEL[gr]));
    for (const n of inGroup) {
      const active = n.id === ui.workspace;
      // Control Room's count: what waits on you first, then what runs; the longest words that fit whole (never cut)
      const running = data.activity.running;
      const counts: Line[] = n.id !== 'control' ? [] : waiting
        ? [[S(`  ${g.warn} ${waiting} waiting`, 'attention'), ...(running ? [S(` ${g.sep} ${running} running`, 'secondary')] : [])],
          [S(`  ${g.warn} ${waiting} waiting`, 'attention')], [S(` ${g.warn} ${waiting} waiting`, 'attention')], [S(` ${g.warn} ${waiting}`, 'attention')]]
        : running ? [[S(`  ${running} running`, 'secondary')], [S(` ${running} running`, 'secondary')], [S(` ${running} run${running === 1 ? '' : 's'}`, 'secondary')]] : [];
      // R5 (H131): the key of the tab that shows it, at the row's end
      const tabKey = tabOf(pageOf(n.id)).key;
      const room = c.width - 2 - lineCells([S(n.label)]) - 2;
      const extra: Line = counts.find((x) => lineCells(x) <= room) ?? counts[counts.length - 1] ?? [];
      const used = 2 + lineCells([S(n.label), ...extra]);
      const keyCell: Line = used + 2 <= c.width ? [S(' '.repeat(Math.max(1, c.width - used - 1))), S(tabKey, 'secondary')] : [];
      items.push({ line: lines.length, item: { kind: 'action', key: `nav:${n.id}`, action: n.id } });
      lines.push(row([S(n.label, active ? 'strong' : 'text'), ...extra, ...keyCell], active, g));
    }
  }
  if (q && !shown.length) lines.push(...para(`No workspace matches "${ui.input.text}". Enter searches All tools for it.`, c.width));
  // Connections at the foot
  const foot = NAV.find((n) => n.group === 'foot')!;
  const footKey = tabOf(pageOf(foot.id)).key;
  const footPad = Math.max(1, c.width - 2 - lineCells([S(foot.label)]) - 1);
  const footLines = [blank, row([S(foot.label, ui.workspace === foot.id ? 'strong' : 'text'), S(' '.repeat(footPad)), S(footKey, 'secondary')], ui.workspace === foot.id, g)];
  while (lines.length < height - footLines.length) lines.push(blank);
  items.push({ line: lines.length + 1, item: { kind: 'action', key: `nav:${foot.id}`, action: foot.id } });
  lines.push(...footLines);
  return { lines, items, prompt };
}

// ── row 2: the workflow actions, the run state and Stop ────────────────────────

/**
 * R5 (H131): the active tab's workflow actions, from the workspace frame (src/ops/workspace-frame.ts actionsOf), never made
 * here. None while the frame is being read, or while it names another project than the one shown (Follow active project off
 * and another surface chose another: its actions are that project's); `why` says which.
 */
export function pageActions(c: Pick<ViewCtx, 'ui' | 'data'>): { acts: WorkspaceAction[]; why?: string } {
  const f = c.data.frame;
  if (!f) return { acts: [], why: c.data.frameError ? `the workspace frame could not be read: ${c.data.frameError}` : 'reading the workspace frame…' };
  if (f.project.id !== c.data.project.id) return { acts: [], why: `the shared frame names ${f.project.name}, the project chosen elsewhere; this Workbench shows ${c.data.project.name} (Follow active project is off), so its actions are not offered here` };
  const acts = f.actions[c.ui.page] ?? [];
  return { acts: c.ui.page === 'chat' ? chatActionsNow(acts, c.data) : c.ui.page === 'workflows' || c.ui.page === 'control' ? jobActionsNow(acts, c) : acts };
}

/**
 * R5 (H131; the QA of e7f853e, defect 15): tab 3's and tab 7's actions as of now. The run action names the block selected in
 * Workflows' list (the frame names the document's first block: "Run APPROVAL.md › tidy" stayed with LONG.md › wait selected),
 * and while a job of this project runs, Stop current (x) is the one next step, as a chat turn's Stop is; what waits on you stays
 * first (a job may be waiting on it). The frame's labels and commands otherwise.
 */
function jobActionsNow(acts: WorkspaceAction[], c: Pick<ViewCtx, 'ui' | 'data'>): WorkspaceAction[] {
  let out = acts;
  if (c.ui.page === 'workflows') {
    const sel = selectedBlock(c);
    const command = sel ? `/run ${sel.doc.rel} ${sel.block.name}` : '';
    if (sel && !/\s/.test(sel.doc.rel) && !/\s/.test(sel.block.name)) out = out.map((a) => (routeOf(a).kind === 'run' && a.command !== command ? { ...a, label: `Run ${sel.doc.rel} › ${sel.block.name}`, command } : a));
  }
  if (stopWords(c.data).target && !c.data.decisions.total) {
    const stop = out.findIndex((a) => a.command === '/stop' && a.enabled);
    if (stop >= 0) out = out.map((a, i) => ({ ...a, primary: i === stop }));
  }
  return out;
}

/**
 * R5 (H131; the QA round's defect 1): the Chat tab's actions as of now. The frame is read at most once a second, so while
 * this Workbench's own turn is being answered and the frame read does not name it yet, its Send waits and its Stop is the next
 * step at once (and the other way round when its turn has ended since); the labels and commands stay the frame's.
 */
function chatActionsNow(acts: WorkspaceAction[], d: Data): WorkspaceAction[] {
  const turn = chatTurnNow(d);
  const framed = !!(d.frame && d.frame.project.id === d.project.id && d.frame.activity.chatTurn);
  if (!!turn === framed) return acts;
  return acts.map((a) => {
    const r = routeOf(a);
    if (turn && r.kind === 'composer') return { ...a, primary: false, enabled: false, why: `one turn at a time: a turn is being answered in ${turn.where}` };
    if (turn && r.kind === 'abort') {
      const { why: _why, ...rest } = a;
      return { ...rest, primary: true, enabled: true };
    }
    if (!turn && r.kind === 'abort') return { ...a, primary: false, enabled: false, why: 'only while a turn runs' };
    // (R5 H134, at the merge of the frame's chat fix: Stop is the one next step while the turn runs; the frame, not knowing of
    // the turn yet, may still make the chat's fix primary)
    if (turn && a.primary) return { ...a, primary: false };
    return a;
  });
}

/** R5 (H131): the action row 2 has selected: its cursor, kept on the bar; the primary next step until the person moves it. */
export function selectedAction(c: Pick<ViewCtx, 'ui' | 'data'>): { acts: WorkspaceAction[]; at: number } {
  const { acts } = pageActions(c);
  if (!acts.length) return { acts, at: -1 };
  const chosen = c.ui.cursor.top;
  const primary = acts.findIndex((a) => a.primary);
  const at = chosen === undefined ? Math.max(0, primary) : Math.max(0, Math.min(acts.length - 1, chosen));
  return { acts, at };
}

/**
 * R4 (H112): the keys that reach the workspace finder when / alone does not (All tools, away from the navigation, where /
 * searches the tools); undefined where / finds a workspace now. No key changes here: the words say the way that exists.
 * R5 (H131): / searches the tools only while their list has the keyboard (src/workbench/controller.ts search); from the
 * actions bar, Context or Activity it finds a workspace, as on every other tab.
 */
export function finderKeys(ui: Pick<Ui, 'workspace' | 'focus' | 'input' | 'navShown'>): string | undefined {
  if (ui.workspace !== 'tools' || ui.focus !== 'center') return undefined;
  // Esc leaves the tools search with the keyboard on the navigation where it is shown (src/workbench/controller.ts)
  if (ui.input.field === 'tools') return ui.navShown === false ? 'Esc, then g, then /' : 'Esc, then /';
  return 'g, then /';
}

export function runWords(d: Data): string {
  // R5 (H131; the QA round's defect 1): a chat turn being answered runs too, and is named
  const turn = chatTurnNow(d);
  const r = d.activity.running + (turn ? 1 : 0);
  const w = d.decisions.total;
  if (!r && !w) return 'run: idle';
  const away = d.activity.away;
  const here = r - (away?.running ?? 0);
  const running = away ? [here ? `${here} running` : '', `${away.running} running in ${away.where.join(', ')}`].filter(Boolean).join(', ') : `${r} running`;
  const which = turn ? ` (${r > 1 ? '1 is ' : ''}the chat turn${turn.mine ? '' : ` in ${turn.where}`})` : '';
  return `run: ${[r ? `${running}${which}` : '', w ? `${w} waiting on you` : ''].filter(Boolean).join(', ')}`;
}

/** Stop current's target, named before anything is pressed: in the Control Room, the selected job while it runs; else this
 *  Workbench's newest live job (R4, H112: in any project, with its project when it is not the one shown), else the project's
 *  newest live job. x stops exactly this one (src/workbench/controller.ts stop). */
export function stopWords(d: Data, selected?: Item | null, workspace?: WorkspaceId): { text: string; target: JobRow | null; turn?: TurnNow } {
  const live = d.jobs.filter((j) => j.live);
  const picked = workspace === 'control' && selected?.kind === 'job' && selected.job.live ? selected.job : null;
  const t = picked ?? live.find((j) => j.owner === 'workbench') ?? (d.away ?? []).find((j) => j.live && j.owner === 'workbench') ?? live[0] ?? null;
  const where = t && !sameFolder(t.root, d.project.root) ? ` (in ${t.project})` : '';
  if (t) return { text: `Stop current: ${t.id} ${t.label}${where}`, target: t };
  // R5 (H131; the QA round's defect 1): no job runs, a chat turn is being answered: this Workbench's own is stopped by x (and
  // Esc in the composer). R5 (H131; the QA of e7f853e, item 16): another surface's is asked to stop by x, by its id, as its own
  // key there would (src/agent/chat-turn.ts requestTurnStop); a turn the frame names without an id only where it was sent
  const turn = chatTurnNow(d);
  if (turn) return { text: turn.mine ? 'Stop current: the chat turn being answered here' : `Stop current: the chat turn in ${turn.where} (${turnStopHere(turn)})`, target: null, turn };
  return { text: 'Stop current: idle', target: null };
}

const fitTo = (line: Line, w: number, g: Glyphs): Line => {
  const out: Line = [];
  let used = 0;
  for (const s of line) {
    const sw = lineCells([s]);
    if (used + sw <= w) { out.push(s); used += sw; continue; }
    const t = cut(s.text, w - used, g.ellipsis);
    if (t) out.push({ ...s, text: t });
    break;
  }
  return out;
};

/**
 * R4 lead (2026-10-12): the chat's route as the Workbench shows it everywhere (the top line, Chat, Settings): the open chat
 * session's own (src/contracts/chat-session.ts route()), else the one route read here (src/workbench/state.ts readRoute,
 * chatRouteNow as the session reads it): one set of words, never two.
 */
export function routeShown(data: Data): { words: string; ready: boolean; refusal?: readonly string[] } {
  const r = data.chatRoute ?? data.route;
  // R5 (H131; the QA round's defect 22): a route that is not ready is said without the REPL's own remedy (/setup, /model):
  // the Workbench says one, the workspace frame's fix (its Chat action), where it says what to do
  const words = r.ready ? r.words : r.words.replace(/ · \/(setup chat|setup|model)$/, '');
  return { words, ready: r.ready, ...(r.refusal?.length ? { refusal: r.refusal } : {}) };
}

/** The run state and Stop current, kept whole first wherever they are drawn (R4: they show at every size). */
export function stopRight(c: ViewCtx, width: number): Line {
  const { ui, data } = c;
  const stop = stopWords(data, selectedItem(c), ui.workspace);
  const state: Line = [S(runWords(data), data.decisions.total ? 'attention' : 'secondary')];
  const stopLine: Line = stop.target || stop.turn?.mine || stop.turn?.id ? [key('x'), S(` ${stop.text}`, 'strong')] : [S(stop.text, stop.turn ? 'text' : 'secondary')];
  // the state and Stop are kept whole first; when even they do not fit, Stop alone, cut at its end
  const fullRight: Line = [...state, S('  '), ...stopLine];
  return lineCells(fullRight) <= width ? fullRight : lineCells(stopLine) <= width ? stopLine : fitTo(stopLine, width, c.g);
}

/**
 * R5 (H131): row 2, Workflow actions: the tab's actions as numbered boxes (src/workbench/hub.ts actionsRow), then (with
 * `detail`) a row with the selected action's words while the bar has the keyboard (else this computer and the chat route), and
 * the run state and Stop current at its end, kept whole first.
 */
export function topLines(c: ViewCtx, detail = true): { lines: Line[]; hits: ActionHit[]; foot?: Line } {
  const { ui, data, width } = c;
  const { acts, why } = pageActions(c);
  const { at } = selectedAction(c);
  const focused = ui.focus === 'top';
  const row = acts.length ? actionsRow(acts, at, focused, width, c.g) : { line: [S(why ?? 'No action on this tab.', why?.startsWith('the workspace frame could not') ? 'failure' : 'secondary')] as Line, hits: [] };
  if (!detail) return { lines: [row.line], hits: row.hits };
  const route = routeShown(data);
  // R5 (H131; the QA round's defect 15): the selected action's words have the row to themselves (the run state and Stop
  // current are drawn in the panel's bottom edge, src/workbench/screen.ts), and leave out their least needed words first
  const left: Line = focused && acts.length
    ? actionWords(acts[at], c.g, width)
    : [S('this computer', 'secondary'), S(` ${c.g.sep} `, 'secondary'), S(route.words, route.ready ? 'text' : 'secondary')];
  return { lines: [row.line, fit(left, width, c.g.ellipsis)], hits: row.hits, foot: stopRight(c, Math.max(8, width - 2)) };
}

// ── the center ─────────────────────────────────────────────────────────────────

export function centerView(c: ViewCtx): View {
  const o = c.ui.overlay;
  if (o) return overlayView(c, o);
  switch (c.ui.workspace) {
    case 'files': return filesView(c);
    // R5 (H136): tab 3's three columns, references 03 and 12 (src/workbench/workflows-tab.ts)
    case 'workflows': return workflowsTabView(c);
    // R5 (H137): tab 7's body, the roster, the panes and what waits (src/workbench/control-tab.ts)
    case 'control': return controlRoomView(c, c.data.control);
    case 'overview': return overviewView(c);
    case 'studio': return studioView(c);
    case 'chat': return chatView(c);
    case 'create3d': case 'motion': case 'rea': return familyView(c, c.ui.workspace);
    case 'templates': return templatesView(c);
    // R5 (H134): tab 5 and tab 9, references 04, 05, 15, 16 and 08, 17 (src/workbench/voxvision-tab.ts, tools-tab.ts)
    case 'voxvision': return voxView(c, c.data.caps, c.data.voxTab);
    case 'tools': return toolsTabView(c, c.data.caps, c.data.toolsTab, toolsSearch(c.ui), c.data.caps.state === 'ready' ? c.data.caps.at : undefined);
    // R5 (H131): Home's left column, the connection cards from the workspace frame (src/workbench/hub.ts)
    case 'connections': return homeView(c);
    // R5 (H134): tab 0 and tab 8 (src/workbench/logs-tab.ts, src/workbench/fleet-tab.ts)
    case 'logs': return logsView(c, c.data.logs);
    case 'fleet': return fleetView(c, c.data.fleet, c.data.frame, c.data.frameError);
    default: return { lines: [], items: [] };
  }
}

/** The selected list's cursor, kept inside the list. */
export const cursorOf = (ui: Ui, list: string, n: number): number => Math.max(0, Math.min(n - 1, ui.cursor[list] ?? 0));

/** The item the center's cursor is on, for the Inspector and the actions. */
export function selectedItem(c: ViewCtx): Item | null {
  if (c.ui.overlay) return null;
  // Follow selected artifact: the run started here, until the cursor moves
  const followed = c.ui.follow ? c.data.jobs.find((j) => j.id === c.ui.follow) : undefined;
  if (followed) return { kind: 'job', key: `job:${followed.id}`, job: followed };
  const v = centerView(c);
  if (!v.items.length) return null;
  return v.items[cursorOf(c.ui, `center:${c.ui.workspace}`, v.items.length)].item;
}

function blankGuides(c: ViewCtx, what: string): Line[] {
  return [
    [S(what, 'strong')],
    blank,
    ...para('This project is blank: nothing here was made yet, and nothing is shown that is not in it. Ways to begin:', c.width),
    blank,
    [S('  '), key('n'), S(' New project from a public starter (Templates lists them; none holds private work)')],
    [S('  '), S('/add <file>', 'action'), S(' in the REPL copies a reference into refs/', 'secondary')],
    [S('  '), S('a workflow', 'strong'), S(': a Markdown file with named blocks, ```bash [name:build]', 'secondary')],
  ];
}

function filesView(c: ViewCtx): View {
  const { data, g } = c;
  const lines: Line[] = [];
  const items: View['items'] = [];
  if (!data.files.total) return { lines: blankGuides(c, 'No files yet.'), items };
  const cur = cursorOf(c.ui, 'center:files', data.files.total);
  let i = 0;
  lines.push([S(`${count(data.files.total, 'file')} in ${data.project.shown}`, 'secondary'), S(data.files.truncated ? ' (the first 2,000 are listed)' : '', 'secondary')]);
  for (const gr of data.files.groups) {
    lines.push(blank);
    lines.push(heading(`${gr.title} (${gr.files.length})`));
    for (const f of gr.files) {
      const sel = i === cur;
      items.push({ line: lines.length, item: { kind: 'file', key: `file:${f.rel}`, file: f } });
      const meta = `${KIND_WORD[f.kind]} ${g.sep} ${humanBytes(f.bytes)} ${g.sep} ${ago(f.mtimeMs, c.now)}`;
      const nameRoom = Math.max(12, c.width - meta.length - 6);
      lines.push(row([S(cut(f.rel, nameRoom, g.ellipsis).padEnd(Math.min(nameRoom, 48)), 'text'), S(`  ${meta}`, 'secondary')], sel, g));
      i += 1;
    }
  }
  return { lines, items };
}

/** R4 (H117): the surface a chat turn was sent from, in the Control Room's words ("from the Workbench"). */
const TURN_SURFACE: Readonly<Record<TurnRow['surface'], string>> = { repl: 'the REPL', monitor: 'the monitor', workbench: 'the Workbench', companion: 'a companion page' };

function lazyLines<T>(l: Lazy<T>, what: string, c: ViewCtx): Line[] | null {
  if (l.state === 'ready') return null;
  if (l.state === 'failed') return para(`${what} could not be read: ${l.why}. [r] reads it again.`, c.width, 'failure');
  return [[S(`Reading ${what}${l.state === 'loading' ? ` (${took(c.now - l.since)})` : ''}…`, 'secondary')]];
}

function overviewView(c: ViewCtx): View {
  const wait = lazyLines(c.data.overview, 'the project overview', c);
  if (wait) return { lines: wait, items: [] };
  const lines = (c.data.overview as Extract<Lazy<Line[]>, { state: 'ready' }>).value;
  return { lines: [[S(`as the REPL's /overview reads it ${c.g.sep} read ${ago(c.data.overview.state === 'ready' ? c.data.overview.at : undefined, c.now)}`, 'secondary')], blank, ...lines], items: [] };
}

function studioView(c: ViewCtx): View {
  const { g } = c;
  const lines: Line[] = [[S('Studio · Show', 'action'), S(' (', 'secondary'), key('s'), S(') opens the rich canvas on this project; here is its outline.', 'secondary')], blank];
  const items: View['items'] = [];
  const wait = lazyLines(c.data.studio, 'Studio\'s cards', c);
  if (wait) return { lines: [...lines, ...wait], items };
  const v = (c.data.studio as Extract<typeof c.data.studio, { state: 'ready' }>).value;
  if (!v.cards.length) {
    lines.push([S('No Studio cards yet.', 'strong')]);
    lines.push(...para('A card appears for each workflow document, parameter file, flow, VoxVision record and run of the project. Studio\'s board templates start blank, with guides (Templates lists them).', c.width));
    return { lines, items };
  }
  const order = ['workflow', 'params', 'flow', 'vox', 'run', 'unreadable'] as const;
  const titles: Record<string, string> = { workflow: 'Workflows', params: 'Parameters', flow: 'Flows', vox: 'VoxVision', run: 'Runs', unreadable: 'Unreadable records' };
  const total = v.cards.length + v.operations.length;
  const cur = cursorOf(c.ui, 'center:studio', total);
  let i = 0;
  for (const k of order) {
    const cards = v.cards.filter((x) => x.kind === k);
    if (!cards.length) continue;
    lines.push(heading(`${titles[k]} (${cards.length})`));
    for (const card of cards) {
      items.push({ line: lines.length, item: { kind: 'card', key: `card:${card.id}`, card } });
      lines.push(row([S(card.title, 'strong'), S(`  ${card.state}`, 'text'), S(card.operation ? ` ${g.sep} ${card.operation}` : '', 'secondary')], i === cur, g));
      i += 1;
    }
    lines.push(blank);
  }
  if (v.operations.length) {
    lines.push(heading(`Operations (${v.operations.length})`));
    for (const op of v.operations) {
      items.push({ line: lines.length, item: { kind: 'operation', key: `op:${op.id}`, op } });
      lines.push(row([S(op.id, 'strong'), S(`  ${op.state}`, 'text'), S(`  ${op.request ?? '(no record of its request)'}`, 'secondary')], i === cur, g));
      i += 1;
    }
  }
  for (const n of v.notes) lines.push(...para(n, c.width));
  return { lines, items };
}

function chatView(c: ViewCtx): View {
  const { data, g, ui } = c;
  const lines: Line[] = [];
  const items: View['items'] = [];
  // the chat session's own route once one is open (src/contracts/chat-session.ts); else the one route, read here as the
  // session reads it (R4 lead: routeShown, the same words as the top line and Settings)
  const route = routeShown(data);
  lines.push(field('Route', route.words, route.ready ? 'text' : 'secondary', 8));
  // R5 (H131; the QA round's defect 22): one remedy for a chat that is not set up, the workspace frame's fix (src/ops/
  // workspace-frame.ts chatFix: the primary Chat action, which Enter carries out); with no frame read yet, the setup (timmy
  // init; `timmy setup` makes a governed workspace's folders and asks nothing). The session's refusal is said for its cause.
  const framed = data.frame && data.frame.project.id === data.project.id ? data.frame : null;
  const fix = route.ready ? undefined : framed?.actions.chat?.find((a) => a.primary && a.enabled && !['composer', 'abort'].includes(routeOf(a).kind));
  const notReady = fix ? `not ready: ${fix.label.charAt(0).toLowerCase()}${fix.label.slice(1)} (workflow action ${fix.n}, row 2)` : 'not ready: timmy init (in a shell) sets up a route';
  lines.push(...fieldRows('Ready', route.ready ? 'a message can be sent on this route' : notReady, c.width, route.ready ? 'text' : 'attention', 8));
  if (!route.ready && route.refusal?.length) {
    const causes = route.refusal.map((r) => r.trim()).filter((r) => /^Cause:/.test(r));
    for (const r of causes.length ? causes : route.refusal.slice(0, 1)) lines.push(...para(r, c.width, 'secondary', '  '));
  }
  lines.push(blank);
  const t = data.chat;
  const turn = data.turn;
  // R5 (H131; the QA round's defect 21): the newest exchange is said once: while it is being answered, below the conversation
  // (a message of it already kept there is not said twice); once answered and kept there, there, with its receipt under it
  const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
  let msgs = t.messages;
  const n = msgs.length;
  // being answered: its message may be kept already (the last one); answered: the conversation ends with it and its answer;
  // stopped: with it and Timmy's own record of the stop (src/agent/core.ts cancelRecord, isTimmyRecord)
  const kept = !!turn && (turn.state === 'sending'
    ? n >= 1 && msgs[n - 1].role === 'user' && same(msgs[n - 1].text, turn.text)
    : n >= 2 && msgs[n - 2].role === 'user' && same(msgs[n - 2].text, turn.text) && msgs[n - 1].role === 'assistant'
      && (same(msgs[n - 1].text, turn.answer) || (turn.state === 'cancelled' && isTimmyRecord(msgs[n - 1].text))));
  if (turn?.state === 'sending' && kept) msgs = msgs.slice(0, n - 1);
  lines.push(heading(t.session ? `This project's last conversation (${count(t.total, 'message')})` : 'This project\'s conversation'));
  if (t.error) lines.push(...para(`It could not be read: ${t.error}`, c.width, 'failure'));
  else if (!msgs.length && !(turn?.state === 'sending')) lines.push([S('  No conversation is kept in this project yet (.sessions).', 'secondary')]);
  const cur = cursorOf(c.ui, 'center:chat', msgs.length);
  // R5 (H131; the QA round's defect 8): each message whole, wrapped under its speaker (a long answer is read here to its end)
  const bodyW = Math.max(8, c.width - 2 - 6);
  const under = (b: string, sel: boolean, role: Role = 'text'): Line => [S('  ', 'text', sel ? { selected: true } : {}), S(' '.repeat(6), 'text', sel ? { selected: true } : {}), S(b, role, sel ? { selected: true } : {})];
  // R5 (H131; the QA of e7f853e, defect 8): the stopped turn of this Workbench, said once: the stop in Timmy's own words
  const stoppedHere = turn && turn.state === 'cancelled' ? stoppedNote(turn, data, g) : null;
  let noted = false;
  msgs.forEach((m, i) => {
    const sel = i === cur;
    const item: Item = { kind: 'message', key: `msg:${i}`, role: m.role, text: m.text };
    // R5 (H131; the QA of e7f853e, defect 8): Timmy's own record of a turn that ended without its answer (src/agent/core.ts
    // isTimmyRecord) is not the model's words: never under the speaker's label. The partial answer it quotes is shown once,
    // marked partial (this Workbench's own turn's as it streamed, whole), then the stop in Timmy's own words, once
    if (m.role === 'assistant' && isTimmyRecord(m.text)) {
      const rec = timmyRecord(m.text);
      const ownLast = !!stoppedHere && kept && i === msgs.length - 1;
      const partial = ownLast && turn?.answer.trim() ? turn.answer : rec.partial;
      const at = lines.length;
      if (partial) {
        messageRows(partial, Math.max(8, bodyW - 10)).forEach((b, k) => lines.push(k === 0
          ? row([S('Timmy'.padEnd(6), 'ai'), S('(partial) ', 'secondary'), S(b, 'text')], sel, g)
          : under(`${' '.repeat(10)}${b}`, sel)));
      }
      const note = ownLast && stoppedHere ? stoppedHere : recordNote(rec, m.at, g);
      if (ownLast) noted = true;
      wrapSegs(note, Math.max(8, c.width - 2), '  ').forEach((r, k) => lines.push(k === 0 && !partial ? row(r, sel, g) : [S('  ', 'text', sel ? { selected: true } : {}), ...r.map((x) => (sel ? { ...x, selected: true } : x))]));
      items.push({ line: at, item, rows: lines.length - at });
      return;
    }
    const who = m.role === 'user' ? 'You' : 'Timmy';
    const body = messageRows(m.text, bodyW);
    items.push({ line: lines.length, item, rows: body.length });
    body.forEach((b, k) => lines.push(k === 0 ? row([S(who.padEnd(6), m.role === 'user' ? 'strong' : 'ai'), S(b, 'text')], sel, g) : under(b, sel)));
  });
  // the composer's turn, as it went (the session's own words)
  if (turn) {
    const receipt = turn.receipt ? receiptShort(turn.receipt) : '';
    const status = turn.state === 'sending'
      ? [`being answered${turn.operation ? ` as operation ${turn.operation}` : ''}`, 'Esc in the composer, or x, stops it']
      : [turn.state, turn.sent === false ? 'nothing was sent to any model' : turn.sent ? 'sent to a model' : '', turn.costWords ?? '', turn.model ?? '', receipt ? `receipt ${receipt}` : '', turn.operation ? `operation ${turn.operation}` : ''];
    const statusRole: Role = turn.state === 'failed' ? 'failure' : 'secondary';
    // a stopped turn: its stop is said once, in Timmy's own words (the session's "Cancelled…" line says the same stop)
    const said = stoppedHere ? turn.lines.filter((l, k) => !(k === 0 && /^Cancelled\b/.test(l))) : turn.lines;
    if (turn.state !== 'sending' && kept) {
      // kept in the conversation above: its receipt and what came of it, under it (a stopped one's said there, once)
      for (const l of said) lines.push(...para(l, c.width, 'secondary', '  '));
      if (stoppedHere && !noted) lines.push(...wrapSegs([S('  '), ...stoppedHere], c.width, '  '));
      else if (!stoppedHere) lines.push(...para(status.filter(Boolean).join(` ${g.sep} `), c.width, statusRole, '  '));
    } else {
      lines.push(blank);
      lines.push(heading(turn.state === 'sending' ? 'Being answered now' : 'Your last message here'));
      lines.push(...para(`You: ${turn.text}`, c.width, 'strong'));
      if (turn.answer) lines.push(...para(`Timmy${stoppedHere ? ' (partial)' : ''}: ${turn.answer}`, c.width, 'text'));
      for (const x of turn.tools.slice(-4)) lines.push([S(`  ${x.phase === 'start' ? `${g.run} running` : `${g.ok} done`} ${x.name}`, 'secondary'), S(x.outcome ? ` ${x.outcome}` : '', 'secondary')]);
      for (const l of said) lines.push(...para(l, c.width, turn.state === 'failed' ? 'failure' : 'secondary', '  '));
      if (stoppedHere) lines.push(...wrapSegs([S('  '), ...stoppedHere], c.width, '  '));
      else lines.push(...para(status.filter(Boolean).join(` ${g.sep} `), c.width, statusRole, '  '));
    }
  }
  lines.push(blank);
  lines.push(heading('Composer'));
  if (ui.input.field === 'composer') {
    lines.push([S('› ', 'action'), S(ui.input.text, 'text'), S(' ', 'text', { inverse: true })]);
    // R5 (H131; the QA round's defect 1): what Esc does now, one thing at a time
    lines.push([S(turn?.state === 'sending' ? '  Esc stops the turn being answered · Enter sends once it is answered' : '  Enter sends · Esc leaves the composer', 'secondary')]);
  }
  // R5 (H131): the conversation is the body's left column now: the hint is short enough for it
  else lines.push([key('Enter'), S(c.can.chat ? ' Type a message (sent through the chat session, on the route above)' : ' Type a message', 'text')]);
  if (!c.can.chat) lines.push(...para(c.can.chatWhy ?? 'Sending is not available here.', c.width, 'secondary', '  '));
  // R5 (H131; the QA of e7f853e, defect 2 and reference 02's difference 3): what a terminal cannot draw here, as the other
  // tabs say it, and what c and s show for it in truth
  lines.push(blank, ...limitRows('No Timmy surface draws a chat\'s previews or images yet.', { c: 'this project\'s turns, each as its receipt', s: 'the canvas, where Timmy draws when asked' }, c.width, g));
  return { lines, items };
}

/** R5 (H131; the QA of e7f853e, defect 8): what Timmy's own record of a turn that ended without its answer says
 *  (src/agent/core.ts cancelRecord, UNANSWERED): stopped, or left unanswered; the partial answer it quotes; whether what its
 *  tools did stands. */
function timmyRecord(text: string): { stopped: boolean; partial?: string; stands: boolean } {
  const stopped = text.startsWith('[Cancelled by the user before I');
  let partial: string | undefined;
  const quoted = /What I had written so far: ("(?:[^"\\]|\\.)*")\./.exec(text);
  if (quoted) { try { const p = JSON.parse(quoted[1]) as unknown; if (typeof p === 'string' && p.trim()) partial = p; } catch { /* not quoted as cancelRecord writes it */ } }
  return { stopped, ...(partial ? { partial } : {}), stands: /\bNothing was rolled back\./.test(text) };
}

/** A stop's mark, as the Control Room's stopped turn has it (■). */
const stopMark = (g: Glyphs): string => (g.unicode ? '■' : '#');

/** R5 (H131; the QA of e7f853e, defect 8): an earlier record's note, in Timmy's own words, with when it was kept. */
function recordNote(rec: { stopped: boolean; stands: boolean }, at: number | undefined, g: Glyphs): Line {
  const when = at !== undefined ? ` ${g.sep} ${clock(new Date(at).toISOString())}` : '';
  if (!rec.stopped) return [S(`${stopMark(g)} not answered`, 'text'), S(`: it was interrupted before Timmy could (the program ended, or the request failed)${when}`, 'secondary')];
  return [S(`${stopMark(g)} stopped by you`, 'text'), S(`${rec.stands ? ` ${g.sep} what its tools did stands (nothing was rolled back)` : ''}${when}`, 'secondary')];
}

/** R5 (H131; the QA of e7f853e, defect 8): this Workbench's stopped turn, said once in Timmy's own words: who stopped it
 *  (its receipt's stopped_by when another surface asked: src/ops/workspace-frame.ts turnOf), whether anything was sent, its
 *  receipt and when it stopped, in this Workbench's clock. */
function stoppedNote(turn: NonNullable<Data['turn']>, d: Data, g: Glyphs): Line {
  const short = turn.receipt ? receiptShort(turn.receipt) : '';
  const sealed = short ? (d.turns ?? []).find((x) => x.receipt === short) : undefined;
  const how = sealed && sealed.stoppedBy && sealed.stoppedBy !== sealed.surface ? turnEndWords(sealed) : 'stopped by you';
  const rest = [
    turn.sent === false ? 'nothing was sent to any model' : turn.sent ? 'sent to a model: what it did stands, nothing was rolled back' : '',
    turn.sent && turn.costWords ? turn.costWords : '',
    short ? `receipt ${short}` : 'no receipt sealed',
    turn.ended !== undefined ? clock(new Date(turn.ended).toISOString()) : '',
  ].filter(Boolean);
  return [S(`${stopMark(g)} ${how}`, 'text'), S(` ${g.sep} ${rest.join(` ${g.sep} `)}`, 'secondary')];
}

/** R5 (H131; the QA round's defect 8): the conversation's view follows its newest rows (an answer's end, its receipt and the
 *  composer) until the person selects a message; while the composer is open it is always in view. */
export const chatFollows = (ui: Pick<Ui, 'chosen' | 'input'>): boolean => !ui.chosen?.['center:chat'] || ui.input.field === 'composer';

/** R5 (H131): a message's words as rows of at most `width` cells, its paragraphs kept (one blank row between them). */
function messageRows(text: string, width: number): string[] {
  const rows = wrapText(text.trim() || '(empty)', width);
  return rows.filter((r, i) => r !== '' || (i > 0 && rows[i - 1] !== ''));
}

function capLine(r: CapabilityRow, g: Glyphs): Line {
  const role: Role = r.rung === 'needs setup' ? 'secondary' : 'text';
  return [S(r.name, 'strong'), S(`  ${r.rung}`, role), S(r.setup ? ` ${g.sep} ${r.setup}` : r.detail ? ` ${g.sep} ${r.detail}` : '', 'secondary')];
}

function familyView(c: ViewCtx, ws: WorkspaceId): View {
  const { data, g } = c;
  const lines: Line[] = [];
  const items: View['items'] = [];
  // R5 (H131; the QA of e7f853e, defect 23): tab 6's two views (6, then 6 again) list the tab's every app, their own first:
  // After Effects is the tab's action 3, so it is in the 3D view's list too
  const tab6 = ws === 'create3d' || ws === 'motion';
  const families: WorkspaceId[] = tab6 ? (ws === 'motion' ? ['motion', 'create3d'] : ['create3d', 'motion']) : [ws];
  let rows: CapabilityRow[] = [];
  const wait = lazyLines(data.caps, 'Timmy\'s tools', c);
  if (!wait && data.caps.state === 'ready') {
    const caps = data.caps.value;
    rows = families.flatMap((f) => { const m = FAMILY_ROWS[f]; return m ? caps.filter((r) => m(r.id, r.kind)) : []; });
  }
  const records = ws === 'voxvision' ? data.vox : tab6 ? families.flatMap((f) => data.native[f] ?? []) : data.native[ws] ?? [];
  const total = rows.length + records.length;
  const cur = cursorOf(c.ui, `center:${ws}`, total);
  let i = 0;
  // R5 (H131; the QA round's defect 3): tab 6 says, first, what a terminal cannot draw; the QA of e7f853e, defect 2: and what
  // c and s show for it in truth (no Timmy surface draws 3D or a timeline yet; each app draws its own)
  if (tab6) lines.push(...limitRows('No Timmy surface draws 3D, images or a motion timeline yet: each app below draws its own, once it is set up.', { c: 'this tab\'s actions, in words', s: 'the canvas (2D shapes and cards)' }, c.width, g), blank);
  lines.push(heading(`Tools (${wait ? 'checking' : rows.length})`));
  if (wait) lines.push(...wait);
  else if (!rows.length) {
    lines.push(...para(ws === 'rea'
      ? 'No REA capability is registered in this revision: REA\'s core (src/rea) is being built separately, so nothing here runs REA yet.'
      : 'No registered tool belongs here in this revision.', c.width));
  }
  // R5 (H131; the QA of e7f853e, defect 11): a tool's row wraps under itself: its step is never cut off
  for (const r of rows) {
    const body = wrapSegs(capLine(r, g), Math.max(8, c.width - 2), '    ');
    items.push({ line: lines.length, item: { kind: 'cap', key: `cap:${r.id}`, row: r }, rows: body.length });
    body.forEach((b, k) => lines.push(k === 0 ? row(b, i === cur, g) : [S('  '), ...b.map((x) => (i === cur ? { ...x, selected: true } : x))]));
    i += 1;
  }
  const missing = NOT_IN_TIMMY[tab6 ? 'create3d' : ws] ?? [];
  if (missing.length) {
    lines.push(blank, heading(`Not in Timmy yet (${missing.length})`));
    for (const m of missing) lines.push(...wrapSegs([S(`  ${m.name}`, 'strong'), S(`  ${m.why}`, 'secondary')], Math.max(8, c.width), '    '));
  }
  lines.push(blank);
  lines.push(heading(`This project's records (${records.length})`));
  if (!records.length) {
    lines.push(...para(ws === 'voxvision' ? 'No VoxVision record yet: /inspect <file> in the REPL makes one.' : ws === 'rea' ? 'No REA record in this project.'
      : 'No run of these apps in this project yet: /blender, /scad or /ae in the REPL (the actions above) starts one, once its app is set up (each row above says what it needs).', c.width, 'secondary', '  '));
  }
  for (const rec of records) {
    items.push({ line: lines.length, item: { kind: 'record', key: `rec:${rec.record}`, rec } });
    lines.push(row([S(rec.id, 'strong'), S(`  ${rec.what}`, 'text'), S(`  ${rec.state}`, rec.state.startsWith('failed') ? 'failure' : 'secondary'), S(rec.at ? ` ${g.sep} ${ago(rec.at, c.now)}` : '', 'secondary')], i === cur, g));
    i += 1;
  }
  if (ws === 'voxvision' || ws === 'create3d' || ws === 'motion') {
    lines.push(blank);
    lines.push(...para('A preview here is never a measurement: measured values are shown with their method and source in the REPL (/inspect, /measure) and on the board.', c.width));
  }
  return { lines, items };
}

function templatesView(c: ViewCtx): View {
  const { data, g } = c;
  const lines: Line[] = [];
  const items: View['items'] = [];
  const total = data.starters.length + data.boards.length;
  const cur = cursorOf(c.ui, 'center:templates', total);
  let i = 0;
  lines.push(heading(`Project starters (${data.starters.length})`));
  lines.push([S('  Enter makes a new project from one (it asks a name); its files are yours to edit.', 'secondary')]);
  if (!data.starters.length) lines.push([S('  This Timmy has no starters (templates/ is not in it).', 'secondary')]);
  for (const s of data.starters) {
    items.push({ line: lines.length, item: { kind: 'starter', key: `starter:${s.name}`, name: s.name, about: s.about } });
    lines.push(row([S(s.name, 'strong'), S(`  ${s.about}`, 'secondary')], i === cur, g));
    i += 1;
  }
  lines.push(blank);
  lines.push(heading(`Studio board templates (${data.boards.length})`));
  lines.push([S('  Blank boards with guides; Studio · Show opens Studio, where they are chosen.', 'secondary')]);
  for (const b of data.boards) {
    items.push({ line: lines.length, item: { kind: 'board', key: `board:${b.id}`, board: b } });
    lines.push(row([S(b.title, 'strong'), S(`  ${b.domain}`, 'secondary')], i === cur, g));
    i += 1;
  }
  return { lines, items };
}

/** R5 (H134): All tools' search as tab 9 draws it (src/workbench/tools-tab.ts): the words searched are the ones typed, or the
 *  ones kept after Enter (R4, H112); / searches the tools only from their list (R5, H131). */
function toolsSearch(ui: Ui): ToolsSearch {
  const typing = ui.input.field === 'tools';
  const finder = finderKeys(ui);
  return { typing, text: ui.input.text, query: typing ? ui.input.text : ui.toolsQuery ?? '', focused: ui.focus === 'center', ...(finder ? { finder } : {}) };
}

// ── the overlays (drawn in the center) ─────────────────────────────────────────

/** The keys sheet's key column: the longest key and a cell of air. */
const KEY_COLUMN = 17;

export const HELP: ReadonlyArray<[string, string]> = [
  ['1 … 9  0', 'the ten tabs: 1 Home, 2 Chat & Intent, 3 Workflows, 4 Studio, 5 VoxVision, 6 3D & Motion, 7 Control Room, 8 Fleet & Clef, 9 Tools & MCP, 0 Logs & Receipts (not while a field has the keyboard); a tab\'s key again shows its next workspace. Row 1 says their full labels where they fit, else their first words, else their keys with the open tab\'s name at the end; a tab never moves, and ⚠ with a count over a tab is what waits on you there'],
  ['Tab / Shift+Tab', 'the next or previous zone: the body\'s columns, Activity & log, the workflow actions (the one with the keyboard has a heavy amber border and ◆)'],
  ['↑ ↓ or k j', 'move within the zone; PgUp PgDn a page'],
  ['← →', 'the workflow actions (row 2); Context\'s tabs (Tools, Inspector, Files)'],
  ['Home End', 'the first or last of Context\'s tabs; elsewhere the first or last row'],
  ['Enter', 'do what the selection offers (its words say what and to what): a workflow action (row 2) runs through the Workbench\'s own path or shows its command to copy; a workflow block: run it, after a confirm'],
  ['y  a  n', 'a NEEDS YOU box: allow once, for this session (when offered), or deny; Esc and Enter deny too (the default)'],
  ['Esc', 'close a drawer, a box or a search'],
  ['p  n', 'switch project (search, recent, open a folder)  ·  a new blank project'],
  ['/', 'find a workspace or a tab (the navigation, as a drawer), or search All tools there'],
  ['c  s', 'Companion · Show  ·  Studio · Show (each starts once, on 127.0.0.1); closing a view never stops a job'],
  ['C  S', 'stop serving the Companion  ·  Studio (only what this Workbench started)'],
  [',', 'Quick settings (saved in Timmy\'s settings folder): open the Companion or Studio at start, and more'],
  ['x', 'Stop current: the job it names'],
  ['i  g', 'Context (Tools, Inspector, Files) as a drawer  ·  the navigation (CREATE, OPERATE, LIBRARY) as a drawer'],
  ['z', 'focus mode: the body\'s list alone, with the tabs, the actions and the log; z or Esc leaves it'],
  ['a  A', 'Activity & log: expand or collapse  ·  all operations or the selected one'],
  ['f', 'Files tab: related files only, or all of them'],
  ['r', 'read the records again (the workspace frame and the tools too)'],
  ['m', 'mouse capture on or off (off: the terminal selects text as usual)'],
  ['?', 'these keys'],
  ['Ctrl+C', 'quit (work another session started keeps running; it says what)'],
  ['Mouse', 'a click picks a tab, selects an action, a card or a row, or presses a [key]; a click never runs or allows anything (Enter, the key, runs; y allows); the wheel scrolls the list under the pointer'],
  ['Marks', '● live (green: an answer seen in the last 30 min)  ○ configured (a setting, not seen answering)  ✕ unreachable, refused or failed (amber)  · not set up  ? unknown  ▶ running  … waiting its turn  ⚠ waits on you; each mark has its word beside it, and green is only ever live, passed or verified'],
  ['Activity', 'collapsed: the log\'s newest lines, the newest first; expanded: oldest first, the newest at the bottom; it follows the newest while the newest is selected (End); select an older row and it stays put as rows arrive'],
];

function overlayView(c: ViewCtx, o: NonNullable<Overlay>): View {
  const { g, ui, data } = c;
  const lines: Line[] = [];
  const items: View['items'] = [];
  switch (o.kind) {
    case 'help':
      // R5 (H131; the QA round's defect 5): every entry whole, its words wrapped under themselves (the body is a column of
      // about half the width on Home and Chat)
      lines.push(...wrapSegs([S('Keys', 'strong'), S('  Esc closes. The mouse clicks what it is on: a workspace, a tab, a row or any [key].', 'secondary')], c.width), blank);
      for (const [k, w] of HELP) {
        const words = wrapText(w, Math.max(8, c.width - KEY_COLUMN));
        words.forEach((r, i) => lines.push(i === 0 ? [S(k.padEnd(KEY_COLUMN), 'action'), S(r, 'text')] : [S(' '.repeat(KEY_COLUMN)), S(r, 'text')]));
      }
      return { lines, items };
    case 'picker': {
      lines.push([S('Switch project', 'strong'), S('  type to search; Enter chooses; a path (with /) opens that folder; Esc keeps this one', 'secondary')]);
      lines.push([S('› ', 'action'), S(ui.input.text, 'text'), S(' ', 'text', { inverse: true })]);
      lines.push(blank);
      const q = ui.input.text.trim().toLowerCase();
      const isPath = /[\\/]/.test(ui.input.text) || ui.input.text.startsWith('~') || ui.input.text.startsWith('.');
      const shown = isPath ? [] : data.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
      const cur = cursorOf(ui, 'overlay', shown.length + 2);
      if (isPath) {
        items.push({ line: lines.length, item: { kind: 'action', key: 'open-path', action: 'open-path' } });
        lines.push(row([S('Open existing: ', 'text'), S(ui.input.text, 'strong')], cur === 0, g));
      } else {
        lines.push(heading(`Projects in Timmy's home (${shown.length}), the most recently changed first`));
        if (!shown.length) lines.push([S(q ? '  No project matches.' : '  None yet.', 'secondary')]);
        shown.forEach((p, i) => {
          items.push({ line: lines.length, item: { kind: 'project', key: `project:${p.root}`, choice: p } });
          lines.push(row([S(p.name, p.active ? 'strong' : 'text'), S(p.active ? '  (open now)' : '', 'secondary'), S(`  ${p.shown}`, 'secondary'), S(p.changedMs ? ` ${g.sep} changed ${ago(p.changedMs, c.now)}` : '', 'secondary')], i === cur, g));
        });
        lines.push(blank);
        items.push({ line: lines.length, item: { kind: 'action', key: 'new-project', action: 'new-project' } });
        lines.push(row([key('n'), S(' New project (blank)', 'text'), S(q ? ` named ${ui.input.text.trim()}` : '', 'secondary')], cur === shown.length, g));
        items.push({ line: lines.length, item: { kind: 'action', key: 'open-path-hint', action: 'open-path-hint' } });
        lines.push(row([S('Open existing: type a folder\'s path, such as ~/work/app', 'secondary')], cur === shown.length + 1, g));
      }
      lines.push(blank);
      lines.push(...para('Choosing writes the shared active-project record (<Timmy home>/state/active-project.json): the REPL, the monitor and Studio follow it. A job keeps the project it started in.', c.width));
      return { lines, items };
    }
    case 'new':
      lines.push([S(o.from ? `New project from ${o.from}` : 'New project (blank)', 'strong'), S('  type its name; Enter makes it; Esc cancels', 'secondary')]);
      lines.push([S('Name › ', 'action'), S(ui.input.text, 'text'), S(' ', 'text', { inverse: true })]);
      lines.push(blank);
      lines.push(...para(o.from
        ? `A new folder in Timmy's home with ${o.from}'s files, yours to edit; then it becomes the active project.`
        : 'An empty folder in Timmy\'s home, then the active project. Nothing is copied into it: no example, chat, agent or job.', c.width));
      lines.push(...para('Letters, digits, dots, dashes and underscores; it never replaces a project that exists.', c.width));
      return { lines, items };
    case 'settings': {
      lines.push([S('Quick settings', 'strong'), S('  Space or Enter changes the selected one; Esc closes', 'secondary')]);
      lines.push([S(ui.saved ?? (ui.settings.state === 'saved' ? 'As its file has them (nothing changed here yet)' : ui.settings.state === 'none yet' ? 'Not saved yet: the defaults' : `Not read (${ui.settings.error ?? 'unreadable'}): the defaults`), ui.saved?.startsWith('Not saved') ? 'failure' : 'secondary')]);
      lines.push(blank);
      const s = ui.settings.settings;
      const n = SETTING_LABELS.length + PRESETS.length;
      const cur = cursorOf(ui, 'overlay', n);
      // R5 (H131; the QA round's defects 5 and 25): each row whole, wrapped under its label (a selected one keeps its ground on
      // every row); the settings file's path from ~ where it can be, broken at its separators
      const wrapped = (line: Line, sel: boolean, indent: string): Line[] => wrapSegs(line, Math.max(8, c.width - 2), indent).map((r, k) => (k === 0 ? row(r, sel, g) : [S('  ', 'text', sel ? { selected: true } : {}), ...r.map((x) => (sel ? { ...x, selected: true } : x))]));
      SETTING_LABELS.forEach((x, i) => {
        const rows = wrapped([S(s[x.key] ? g.check : g.uncheck, 'action'), S(` ${x.label}`, 'strong'), S(`  ${x.about}`, 'secondary')], i === cur, ' '.repeat(lineCells([S(`${g.check} `)])));
        items.push({ line: lines.length, item: { kind: 'action', key: `setting:${x.key}`, action: x.key }, rows: rows.length });
        lines.push(...rows);
      });
      lines.push(blank);
      lines.push(heading('Presets (the startup choices)'));
      PRESETS.forEach((p, j) => {
        const rows = wrapped([S(p.label, 'strong'), S(`  ${p.about}`, 'secondary')], SETTING_LABELS.length + j === cur, '  ');
        items.push({ line: lines.length, item: { kind: 'action', key: `preset:${p.id}`, action: p.id }, rows: rows.length });
        lines.push(...rows);
      });
      lines.push(blank);
      lines.push(...wrapSegs([S('Kept in ', 'secondary'), S(`${tildePath(ui.settings.path)}.`, 'secondary'), S(' Show acts now; the startup choices apply when timmy workbench starts at a terminal, never for --json, --help or a script.', 'secondary')], c.width));
      return { lines, items };
    }
    case 'confirm-run':
      lines.push([S('Run ', 'strong'), S(`${o.doc} › ${o.block}`, 'strong'), S('?', 'strong')]);
      lines.push(blank);
      // R5 (H131; the QA round's defect 15): each field whole, wrapped under itself
      lines.push(...fieldRows('Runs', o.order.join(` ${g.arrow} `), c.width));
      lines.push(...fieldRows('How', 'the REPL\'s own /run: its prediction sealed first, upmd runs each block after the blocks it needs', c.width));
      lines.push(...fieldRows('Where', `${data.project.name} (${data.project.shown}), on this computer`, c.width));
      if (o.risky.length) lines.push(...fieldRows('Needs you', `${o.risky.map((r) => r.name).join(', ')}: a destructive command; its NEEDS YOU box asks first`, c.width, 'attention'));
      {
        // R4 (H112): a run of it that goes on now: Enter starts nothing (one press, one operation, one job)
        const going = runOfBlock(c, o.doc, o.block);
        if (going) {
          lines.push(...para(`Not now: ${going.words}.`, c.width, 'attention'));
          lines.push(blank);
          lines.push([key('Esc'), S(' Close', 'text')]);
          return { lines, items };
        }
      }
      lines.push(blank);
      lines.push([key('Enter'), S(' Run it   ', 'text'), key('Esc'), S(' Do not run', 'text'), S('   (a click never starts a run: Enter, the key, does)', 'secondary')]);
      return { lines, items };
    case 'needs-you': {
      const req = o.req;
      // the keys first: on a short terminal the box's rows scroll, and its answer must never be below them
      lines.push([S(`${g.warn} NEEDS YOU`, 'attention', { bold: true }), S(`  ${req.tool}`, 'strong')]);
      lines.push([key('y'), S(' allow once   ', 'text'), ...(req.session === false ? [] : [key('a'), S(' allow for this session   ', 'text')]), key('n'), S(' / Esc / Enter deny (the default)', 'text')]);
      lines.push(blank);
      if (req.summary) lines.push(...para(req.summary, c.width, 'text'));
      lines.push(...para(req.reason, c.width, 'secondary'));
      if (req.detail) { lines.push(blank); for (const l of req.detail.split('\n').slice(0, 12)) lines.push(...para(l, c.width, 'text', '  ')); }
      lines.push(blank);
      lines.push(...para('Nothing runs until you answer, with a key: a click never allows (a click on [n] denies). The Control Room lists it as waiting on you.', c.width, 'secondary'));
      return { lines, items };
    }
    case 'quit': {
      lines.push([S('Quit the Workbench?', 'strong')]);
      lines.push(blank);
      // R4 (H112): the jobs as they are now: one that ended while the box waited is said so, not named as one to stop
      const liveNow = (id: string): boolean => [...c.data.jobs, ...(c.data.away ?? [])].some((j) => j.id === id && j.live);
      const own = o.own.filter((j) => liveNow(j.id));
      const ended = o.own.filter((j) => !liveNow(j.id));
      if (own.length) {
        lines.push(...para(`${count(own.length, 'job')} this Workbench started will stop with it (its runner ends when the Workbench does):`, c.width, 'attention'));
        for (const j of own) lines.push([S(`  ${j.id} ${j.label}`, 'strong')]);
      }
      if (ended.length) {
        lines.push(...para(`${count(ended.length, 'job')} it started ended while this box waited (nothing of ${ended.length === 1 ? 'it' : 'them'} to stop):`, c.width, 'secondary'));
        for (const j of ended) lines.push([S(`  ${j.id} ${j.label}`, 'text')]);
      }
      if (o.others.length) {
        lines.push(...para(`${count(o.others.length, 'job')} another session started will keep running:`, c.width));
        for (const j of o.others) lines.push([S(`  ${j.id} ${j.label}`, 'text'), S(` ${g.sep} ${j.ownerWords}`, 'secondary')]);
      }
      lines.push(blank);
      lines.push([key('Ctrl+C'), S(own.length ? ` Quit and stop ${own.length === 1 ? 'it' : 'them'}   ` : ' Quit   ', 'text'), key('Esc'), S(' Stay', 'text')]);
      return { lines, items };
    }
    // R5 (H131; the finish line, item 3): the chat's fixes, done here (src/workbench/setup-paths.ts)
    case 'free-models': {
      lines.push(...wrapSegs([S('Choose a free model', 'strong'), S('  free-only stays on · Esc closes, nothing changed', 'secondary')], c.width), blank);
      if (o.state === 'reading') { lines.push([S('Reading this computer\'s OpenRouter catalog…', 'secondary')]); return { lines, items }; }
      if (o.state === 'failed') { lines.push(...para(`The catalog could not be read: ${o.why}. Nothing was changed.`, c.width, 'failure')); return { lines, items }; }
      const cat = o.catalog;
      lines.push(...para(catalogWords(cat), c.width));
      if (cat.from === 'none') return { lines, items };
      lines.push(...para('Free by the catalog\'s prices, not by a check of your account.', c.width));
      lines.push(blank);
      if (!cat.models.length) { lines.push(...para('That catalog lists no free model.', c.width, 'attention')); return { lines, items }; }
      lines.push(heading(`Free models (${cat.models.length})`));
      const cur = cursorOf(ui, 'overlay', cat.models.length);
      const idW = Math.min(Math.max(12, Math.floor(c.width / 2)), Math.max(...cat.models.map((m) => m.id.length)) + 2);
      cat.models.forEach((m, i) => {
        items.push({ line: lines.length, item: { kind: 'action', key: `free:${m.id}`, action: m.id } });
        lines.push(row([S(cut(m.id, idW - 2, g.ellipsis).padEnd(idW), 'strong'), S(modelFacts(m), 'secondary')], i === cur, g));
      });
      lines.push(blank);
      lines.push(...wrapSegs([key('Enter'), S(' makes the selected one the chat\'s model (saved in Timmy\'s settings)   ', 'text'), key('Esc'), S(' closes', 'text')], c.width));
      return { lines, items };
    }
    case 'local-models': {
      lines.push(...wrapSegs([S('Choose the local model', 'strong'), S('  no key, no charge · Esc closes, nothing changed', 'secondary')], c.width), blank);
      if (o.state === 'asking') { lines.push(...para('Asking the Ollama the setup names for its models… (no charge; nothing is downloaded)', c.width)); return { lines, items }; }
      const l = o.list;
      if (o.state === 'failed') {
        const why = l.why ? `${l.why.charAt(0).toUpperCase()}${l.why.slice(1)}` : `${l.where} did not answer`;
        lines.push(...para(l.answered
          ? `${l.where} answered, and lists no model that runs on it (${count(l.listed, 'model')} listed${l.cloud ? `, ${l.cloud} of them cloud-backed, which send the chat off this computer` : ''}). ollama pull <model>, in a shell, adds one: Timmy downloads nothing. Nothing was changed.`
          : `${why}. Start it (the Ollama app, or ollama serve), then check again. Nothing was changed.`, c.width, 'attention'));
        lines.push(blank);
        const step = stepRows([key('Enter'), S(' Check the connections again (timmy workspace check: free requests only)', 'text')], true, g, c.width);
        items.push({ line: lines.length, item: { kind: 'action', key: 'local:check', action: 'check' }, rows: step.length });
        lines.push(...step);
        return { lines, items };
      }
      lines.push(...para(`What ${l.where} lists now (asked just now, no charge): the names timmy init --chat local --model takes.`, c.width));
      if (l.cloud) lines.push(...para(`${count(l.cloud, 'cloud-backed model')} it lists ${l.cloud === 1 ? 'is' : 'are'} not offered here: Ollama sends that chat off this computer.`, c.width, 'secondary'));
      lines.push(blank, heading(`Local models (${l.models.length})`));
      const cur = cursorOf(ui, 'overlay', l.models.length);
      const nameW = Math.min(Math.max(12, Math.floor(c.width / 2)), Math.max(...l.models.map((m) => m.name.length)) + 2);
      l.models.forEach((m, i) => {
        items.push({ line: lines.length, item: { kind: 'action', key: `local:${m.name}`, action: m.name } });
        lines.push(row([S(cut(m.name, nameW - 2, g.ellipsis).padEnd(nameW), 'strong'), S(m.facts, 'secondary')], i === cur, g));
      });
      lines.push(blank);
      lines.push(...wrapSegs([key('Enter'), S(' makes the selected one the local chat\'s model (the setup\'s answer, as timmy init --chat local --model writes it)   ', 'text'), key('Esc'), S(' closes', 'text')], c.width));
      return { lines, items };
    }
    case 'setup': {
      if (o.which === 'chat') {
        lines.push([S('Set the chat\'s Ollama address', 'strong')], blank);
        lines.push(...para('In the REPL (timmy): /setup chat asks the chat question again: the Ollama address, then a model it lists, or OpenRouter.', c.width, 'text'));
        lines.push([S('  '), S('/setup chat', 'action')], blank);
        lines.push(...para('Or in a shell: timmy init --ollama <host> sets the address (this computer\'s Ollama is http://127.0.0.1:11434).', c.width, 'text'));
        lines.push([S('  '), S('timmy init --ollama <host>', 'action')]);
      } else {
        const local = /--chat local\b/.test(o.command);
        const openrouter = /--chat openrouter\b/.test(o.command);
        lines.push([S(local ? 'Set the chat to a local model' : 'Set up chat, in a shell', 'strong')], blank);
        lines.push([S('  '), S(/^timmy init\b/.test(o.command) ? o.command : 'timmy init', 'action')], blank);
        if (o.command === 'timmy setup') lines.push(...para('(timmy setup makes a governed workspace\'s folders and asks nothing; the setup that asks is timmy init.)', c.width), blank);
        lines.push(...para(setupAskWords(o, openrouter, local), c.width, 'text'));
        // a key in use that the setup's own does not replace
        if (openrouter && (o.keyFrom === 'environment' || o.keyFrom === 'timmy-tui.config.json')) {
          lines.push(blank, ...para(`The key in use comes from ${keyFromWords(o.keyFrom)}, which wins over the one the setup keeps: to use another key, change it there.`, c.width, 'attention'));
        }
      }
      lines.push(blank);
      lines.push(...para('A key is typed only in a terminal, hidden as you type (timmy init in a shell, or /setup key in the REPL): never into a tab, a page or this Workbench. Nothing was run from here.', c.width, 'attention'));
      if (o.local) {
        lines.push(blank);
        const step = stepRows([key('Enter'), S(/--chat local\b/.test(o.command) ? ' Choose the local model here: what Ollama lists now (no key, no charge)' : ' Use a local model instead: choose one Ollama lists (no key, no charge)', 'text')], true, g, c.width);
        items.push({ line: lines.length, item: { kind: 'action', key: 'setup:local', action: 'local' }, rows: step.length });
        lines.push(...step);
      }
      lines.push(blank, [S('m gives the mouse back to the terminal, to select a command and copy it.', 'secondary')]);
      return { lines, items };
    }
    case 'message': {
      // R5 (H131): a line wider than the body is wrapped, never cut (Home's and Chat's body is ~48% of the width: "Nothing was
      // run from here" was cut off a shown command's words). QA of e7f853e: a line of several voices too, each word in its
      // own voice, the rows after the first indented under it ("The chat is set to the local model …" was cut)
      const fitted = o.lines.flatMap((l): Line[] => {
        if (lineCells(l) <= c.width) return [l];
        const voiced = l.filter((s) => s.text.trim());
        const role = voiced[0]?.role ?? 'text';
        if (voiced.some((s) => (s.role ?? 'text') !== role)) return wrapSegs(l, c.width, '  ');
        return para(l.map((s) => s.text).join('').trim(), c.width, role);
      });
      lines.push([S(o.title, 'strong')], blank, ...fitted, blank, [key('Esc'), S(' Close', 'text')]);
      return { lines, items };
    }
    default:
      return { lines, items };
  }
}

/** R5 (H131; the finish line, item 3): what a `timmy init …` asks now, for its own flags (src/workbench/setup-paths.ts setupPlan). */
function setupAskWords(o: Extract<NonNullable<Overlay>, { kind: 'setup' }>, openrouter: boolean, local: boolean): string {
  if (o.blank) return `Timmy is not set up on this computer yet, so it asks each question in turn${o.asks?.length ? `: ${o.asks.join('; ')}` : ''}.`;
  if (o.asks === null) return 'It asks the setup\'s questions that have no answer yet.';
  if (o.asks.length) return `It asks what has no answer yet: ${o.asks.join('; ')}.`;
  if (openrouter && o.keyFrom) {
    return `It asks no question now: every one has an answer, and a key is set (in ${keyFromWords(o.keyFrom)}). It does not replace that key: timmy init --openrouter - does (it reads the key hidden at a terminal), or /setup key in the REPL (it asks for it hidden).`;
  }
  if (local) return 'It asks no question now (every one has an answer): it writes the chat as the local model you name, once that Ollama lists it (it checks the name first, and downloads nothing).';
  return 'Every setup question has an answer, so it asks nothing now. To choose the chat again: timmy init --chat openrouter (it asks for a key, hidden, when none is kept), or timmy init --chat local --model <name> (a model Ollama lists).';
}

// ── the right dock: Tools, Inspector, Files ────────────────────────────────────

export interface Action { key: string; label: string; enabled: boolean; why?: string }

/**
 * R4 (H112): a run of a workflow document's block that is under way: being started here (its confirm answered, its NEEDS YOU
 * box or its start still to come), or a job of it that runs in this project, whoever started it. A second press starts
 * nothing while one goes on (one press, one operation, one job); its words say which run and what stops it.
 */
export function runOfBlock(c: Pick<ViewCtx, 'ui' | 'data'>, doc: string, block: string): { words: string; job?: JobRow } | undefined {
  const label = `${doc} › ${block}`;
  if ((c.ui.starting ?? []).includes(label)) return { words: `${label} is being started here already (one press runs it once)` };
  const job = c.data.jobs.find((j) => j.live && j.label === label);
  if (!job) return undefined;
  const who = job.owner === 'workbench' ? 'this Workbench' : job.owner === 'live-session' ? 'another Timmy session' : job.recovery ? `a session that ended (${job.recovery.state})` : 'a session';
  return { job, words: `it is running now as ${job.id}, started by ${who}${job.operation ? `, operation ${job.operation}` : ''}: Run starts nothing until it ends (x stops it${job.owner === 'live-session' ? ' only in the session that started it' : ''})` };
}

/** The named actions of the workspace and its selection: what each does and to what; one that cannot run says what it needs. */
export function actionsOf(c: ViewCtx, item: Item | null): Action[] {
  const ws = c.ui.workspace;
  const out: Action[] = [];
  const stop = stopWords(c.data, item, ws);
  if (ws === 'workflows' && item?.kind === 'block') {
    // R4 (H112): a run of this block that goes on (in any session) or is being started here: Run starts nothing until it ends
    const going = runOfBlock(c, item.doc.rel, item.block.name);
    const runnable = c.data.workflows.upmd && !item.doc.repeated.includes(item.block.name) && !item.block.missing.length && !item.block.cycle && !going;
    const why = going ? going.words
      : !c.data.workflows.upmd ? 'upmd is not installed: brew install rezigned/tap/upmd'
        : item.doc.repeated.includes(item.block.name) ? 'the document names it more than once' : item.block.missing.length ? `it needs ${item.block.missing.join(', ')}, which the document does not have` : c.can.runWhy;
    out.push({ key: 'Enter', label: `Run ${item.doc.rel} › ${item.block.name}${item.block.order.length > 1 ? ` (${item.block.order.join(` ${c.g.arrow} `)})` : ''}`, enabled: runnable && c.can.run, ...(why && !(runnable && c.can.run) ? { why } : {}) });
  }
  if (ws === 'control' && item?.kind === 'job') out.push({ key: 'x', label: item.job.live ? `Stop ${item.job.id} ${item.job.label}` : `Stop ${item.job.id}`, enabled: item.job.live, ...(item.job.live ? {} : { why: `it already ${item.job.word}` }) });
  if (ws === 'templates' && item?.kind === 'starter') out.push({ key: 'Enter', label: `New project from ${item.name}`, enabled: true });
  // R5 (H131): a connection card of Home: the companion's and Studio's Show; any other, the step that sets it up, shown to copy
  if (ws === 'connections' && item?.kind === 'conn') {
    const k = item.conn;
    if (k.id === 'companion') out.push({ key: 'Enter', label: 'Companion · Show: the browser companion on 127.0.0.1', enabled: true });
    else if (k.id === 'studio') out.push({ key: 'Enter', label: 'Studio · Show: the rich canvas on this project', enabled: true });
    else {
      // R5 (H131; the finish line, item 3): the check runs from here; the setup's step shows what it asks; any other, to copy
      const step = k.setup ? routeOf({ command: k.setup }).kind : null;
      const label = !k.setup ? `${k.label}: its step` : step === 'check' ? `Check the connections from here: ${k.setup} (free requests only)` : step === 'setup' ? `Its step: ${k.setup} (Enter shows what it asks; it runs in a shell)` : `Its step, shown to copy: ${k.setup}`;
      out.push({ key: 'Enter', label, enabled: !!k.setup, ...(k.setup ? {} : { why: 'no step sets it up or checks it' }) });
    }
  }
  if (ws === 'chat') out.push({ key: 'Enter', label: 'Type a message to Timmy', enabled: c.can.chat, ...(c.can.chat ? {} : { why: c.can.chatWhy ?? 'sending is not available here' }) });
  if (ws === 'studio' || ws === 'connections') out.push({ key: 's', label: 'Studio · Show: the rich canvas on this project', enabled: true });
  if (ws === 'connections') {
    out.push({ key: 'c', label: 'Companion · Show: the browser companion on 127.0.0.1', enabled: true });
    out.push({ key: 'C', label: 'Stop serving the Companion', enabled: c.ui.companion.serving, ...(c.ui.companion.serving ? {} : { why: 'this Workbench serves none' }) });
    out.push({ key: 'S', label: 'Stop serving Studio', enabled: c.ui.studio.serving, ...(c.ui.studio.serving ? {} : { why: c.ui.studio.other ? 'another Timmy serves it' : 'this Workbench serves none' }) });
  }
  if (ws === 'tools' || ws === 'voxvision' || ws === 'create3d' || ws === 'motion' || ws === 'rea') out.push({ key: 'r', label: 'Check the tools again (local checks only)', enabled: true });
  else out.push({ key: 'r', label: `Read ${c.data.project.name}'s records again`, enabled: true });
  if (stop.target) out.push({ key: 'x', label: `Stop current: ${stop.target.id} ${stop.target.label}`, enabled: true });
  else if (stop.turn?.mine) out.push({ key: 'x', label: 'Stop current: the chat turn being answered here', enabled: true });
  else if (stop.turn?.id) out.push({ key: 'x', label: `Stop current: ask the chat turn in ${stop.turn.where} to stop`, enabled: true });
  else if (stop.turn) out.push({ key: 'x', label: 'Stop current', enabled: false, why: `the chat turn is being answered in ${stop.turn.where}, and stops there (${turnStopWords(stop.turn.surface)})` });
  else out.push({ key: 'x', label: 'Stop current', enabled: false, why: 'nothing runs in this project' });
  return out.filter((a, i, all) => all.findIndex((b) => b.key === a.key && b.label === a.label) === i);
}

function itemName(item: Item | null): string {
  if (!item) return 'nothing selected';
  switch (item.kind) {
    case 'file': return item.file.rel;
    case 'doc': return item.doc.rel;
    case 'block': return `${item.doc.rel} › ${item.block.name}`;
    case 'job': return `${item.job.id} ${item.job.label}`;
    case 'turn': return `chat turn ${item.turn.receipt}`;
    case 'decision': return item.decision.title;
    case 'card': return item.card.title;
    case 'operation': return item.op.id;
    case 'cap': return item.row.name;
    case 'record': return item.rec.id;
    case 'starter': return item.name;
    case 'board': return item.board.title;
    case 'server': return item.which === 'companion' ? 'the Companion' : 'Studio';
    case 'message': return `a ${item.role} message`;
    case 'event': return item.event.words;
    case 'project': return item.choice.name;
    case 'conn': return item.conn.label;
    case 'log-receipt': case 'log-op': case 'log-event': return logsItemName(item);
    case 'fleet-plan': case 'clef-decision': return fleetItemName(item);
    case 'vox-record': return voxItemName(item);
    case 'mcp-call': return toolsItemName(item);
    case 'live-turn': return controlItemName(item);
    default: return 'an action';
  }
}

const operationOf = (item: Item | null): string | null => {
  if (!item) return null;
  if (item.kind === 'job') return item.job.operation ?? null;
  if (item.kind === 'turn') return item.turn.operation;
  if (item.kind === 'card') return item.card.operation;
  if (item.kind === 'operation') return item.op.id;
  if (item.kind === 'decision') return item.decision.operation ?? null;
  if (item.kind === 'record') return item.rec.operation ?? null;
  if (item.kind === 'log-receipt' || item.kind === 'log-op' || item.kind === 'log-event') return item.event.operation ?? null;
  if (item.kind === 'fleet-plan' || item.kind === 'clef-decision') return fleetItemOperation(item);
  if (item.kind === 'vox-record') return voxItemOperation(item);
  if (item.kind === 'mcp-call') return toolsItemOperation(item);
  return null;
};

function toolsTab(c: ViewCtx, item: Item | null): View {
  const ws = navItem(c.ui.workspace);
  const lines: Line[] = [heading(`Timmy tools · ${ws.task}`), [S(`For ${itemName(item)}, in ${c.data.project.name}.`, 'secondary')], blank];
  const items: View['items'] = [];
  const acts = actionsOf(c, item);
  const cur = cursorOf(c.ui, 'right:tools', acts.length);
  acts.forEach((a, i) => {
    items.push({ line: lines.length, item: { kind: 'action', key: `act:${a.key}:${a.label}`, action: a.key } });
    lines.push(row([S(`[${a.key}]`, a.enabled ? 'action' : 'secondary'), S(` ${a.label}`, a.enabled ? 'text' : 'secondary')], i === cur, c.g));
    if (!a.enabled && a.why) lines.push(...para(`needs: ${a.why}`, c.width, 'secondary', '      '));
  });
  lines.push(blank);
  lines.push(heading('Selected context'));
  lines.push(field('Project', c.data.project.name, 'text', 10));
  lines.push(field('Selected', itemName(item), 'text', 10));
  lines.push(field('Operation', operationOf(item) ?? 'none', 'text', 10));
  lines.push(field('Runs on', 'this computer', 'text', 10));
  return { lines, items };
}

function detailLines(d: Lazy<RunDetail> | undefined, c: ViewCtx, own?: Parameters<typeof tookWords>[1]): Line[] {
  if (!c.can.detail) return para(`Run detail: ${c.can.detailWhy ?? 'not available here'}`, c.width, 'secondary');
  if (!d || d.state === 'idle') return [[S('Run detail: Enter reads it', 'secondary')]];
  if (d.state === 'loading') return [[S('Run detail: reading…', 'secondary')]];
  if (d.state === 'failed') return para(`Run detail: ${d.why}`, c.width, 'failure');
  const r = d.value;
  // the operation's id as written (a heading's capitals would change it)
  const out: Line[] = [[S('RUN DETAIL', 'secondary', { bold: true }), S(` ${c.g.sep} ${r.operation}`, 'strong')]];
  out.push(...fieldRows('Objective', r.objective?.value ?? 'not recorded', c.width, 'text', 10));
  // R4 lead (the r26 dry run read "completed: succeeded: job … completed" and "Stage none · 1 of 1 steps"): the verdict apart
  // from its record's words (once when they start with it), and the stage in words: the step now, or that it ended
  const verdictWords = r.verdict.words.startsWith(r.verdict.state) ? r.verdict.words : `${r.verdict.state} ${c.g.sep} ${r.verdict.words}`;
  out.push(...fieldRows('Verdict', verdictWords, c.width, r.verdict.state === 'failed' ? 'failure' : 'strong', 10));
  const stepNow = r.stage.current ?? (r.time.endedAt !== null ? 'ended' : 'no step named yet');
  const stepsDone = r.stage.total === null ? `${r.stage.done} done (how many in all is not recorded)` : `${r.stage.done} of ${r.stage.total} step${r.stage.total === 1 ? '' : 's'} done`;
  out.push(...fieldRows('Stage', `${stepNow} ${c.g.sep} ${stepsDone}`, c.width, 'text', 10));
  for (const e of r.exits.slice(0, 4)) out.push(...fieldRows('Exit', `${e.who}: ${e.code ?? 'none'}${e.state ? ` (${e.state})` : ''}`, c.width, 'secondary', 10));
  out.push(...fieldRows('Freshness', `${r.freshness.state}: ${r.freshness.why}`, c.width, 'text', 10));
  out.push(...fieldRows('Accepted', r.acceptance.state, c.width, 'text', 10));
  // R5 (H131; the QA of e7f853e, defect 24): each duration labelled with what it measures (the job's or turn's own, the operation's)
  out.push(...fieldRows('Took', tookWords(r.time, own), c.width, 'text', 10));
  out.push(...fieldRows('Cost', r.cost.measured ? `$${r.cost.usd} (reported)` : `unknown: ${r.cost.why}`, c.width, 'text', 10));
  if (r.prediction) out.push(...fieldRows('Predicted', r.prediction.words, c.width, 'secondary', 10));
  for (const ch of r.checks.slice(0, 4)) out.push(...fieldRows('Check', `${ch.name}: ${ch.actual}${ch.differs ? ' (differs)' : ''}`, c.width, ch.differs ? 'attention' : 'secondary', 10));
  for (const f of r.files.slice(0, 6)) out.push(...fieldRows(f.role, f.path, c.width, 'secondary', 10));
  if (r.receipts.length) out.push(...fieldRows('Receipts', r.receipts.slice(0, 4).map((x) => x.id).join(', '), c.width, 'secondary', 10));
  if (r.next) out.push(...fieldRows('Next', `${r.next.words}${r.next.command ? `: ${r.next.command}` : ''}`, c.width, 'action', 10));
  for (const u of r.unknown.slice(0, 3)) out.push(...fieldRows('Unknown', `${u.field}: ${u.why}`, c.width, 'secondary', 10));
  return out;
}

function inspectorTab(c: ViewCtx, item: Item | null): View {
  const lines: Line[] = [];
  const w = c.width;
  // R5 (H131; the QA round's defect 17): the body's list, wherever it is drawn (there is no center column on every layout)
  if (!item) return { lines: [heading('Inspector'), [S('Nothing is selected: choose a row in the list.', 'secondary')]], items: [] };
  const f = (l: string, v: string, r: Role = 'text'): void => { lines.push(...fieldRows(l, v, w, r, 10)); };
  switch (item.kind) {
    case 'file': {
      const x: FileRow = item.file;
      lines.push(heading('File'));
      f('Path', x.rel); f('Kind', KIND_WORD[x.kind]); f('Size', humanBytes(x.bytes)); f('Changed', ago(x.mtimeMs, c.now));
      lines.push(blank, ...para(`Open it in the REPL: /open ${x.rel}, or /edit ${x.rel} (sealed with hashes before and after).`, w));
      break;
    }
    case 'doc': lines.push(heading('Workflow document')); f('Document', item.doc.rel); if (item.doc.title) f('Title', item.doc.title); f('Blocks', String(item.doc.blocks.length)); if (item.doc.error) f('Not read', item.doc.error, 'failure'); break;
    case 'block': {
      const b = item.block;
      lines.push(heading('Workflow block'));
      f('Document', item.doc.rel); f('Block', `${b.name} (block ${b.key})`); f('Language', b.lang || 'none'); f('Needs', b.needs.join(', ') || 'nothing'); f('Runs', b.order.join(` ${c.g.arrow} `));
      // R5 (H136): its mark as tab 3 draws it (one meaning per mark: ▶ running, … waiting, never ● or ○)
      f('Last state', `${stateMark(b.word, c.g).glyph} ${b.word}${b.detail ? ` ${b.detail}` : ''}`, b.word === 'failed' ? 'failure' : 'text');
      if (b.run) f('Last run', b.run);
      if (b.risky.length) for (const r of b.risky) lines.push(...para(`${c.g.warn} ${r.name} needs you before it runs: ${r.command.split('\n')[0]}`, w, 'attention'));
      else f('Decides', 'it runs on its own (no destructive command)');
      if (b.command) { lines.push(blank, heading('Command')); for (const l of b.command.split('\n').slice(0, 6)) lines.push([S(`  ${l}`, 'text')]); }
      break;
    }
    case 'job': {
      const j = item.job;
      lines.push(heading('Job'));
      f('Job', j.id); f('What', j.label);
      // R4 (H112): where it runs (a run keeps its own project when the view switches)
      if (!sameFolder(j.root, c.data.project.root)) f('Runs in', `${j.project} (not the project shown)`, 'attention');
      f('Judged', `${j.word}${j.why ? `: ${j.why}` : ''}`, j.mark === 'failed' ? 'failure' : 'strong');
      // R4 (H112): a job a session left, in recovery's words
      if (j.recovery) lines.push(...para(j.recovery.words, w, 'attention'));
      f('Outcome', j.outcome.words); f('Record', `${j.state}${j.stale ? ', stale' : ''}${j.exitCode !== undefined ? ` (exit ${j.exitCode ?? 'none'})` : ''}`, 'secondary');
      f('Started', `${clock(j.startedAt)} (${ago(j.startedAt, c.now)})`); f(j.live ? 'Running' : 'Took', j.elapsed);
      if (j.blocks) f('Blocks', j.blocks);
      f('Operation', j.operation ?? 'none recorded'); if (j.receipt) f('Receipt', j.receipt);
      lines.push(...para(j.ownerWords, w, 'secondary'));
      if (j.error) lines.push(...para(j.error, w, 'failure'));
      if (j.note) lines.push(...para(j.note, w, 'secondary'));
      // R5 (H131; the QA round's defect 18): each mark has one meaning, its word beside it: ▶ runs now, ■ stopped, ! interrupted;
      // a step its record says runs, of a job no process of runs (stale), is said as its record says it, not marked as running
      for (const s of j.steps.slice(0, 8)) {
        const claimed = s.state === 'running' && !j.live;
        const mark = s.state === 'completed' ? c.g.ok : s.state === 'failed' ? c.g.fail : s.state === 'running' ? (claimed ? '?' : c.g.run) : s.state === 'stopped' ? (c.g.unicode ? '■' : '#') : '!';
        const word = claimed ? 'running, as its record says (no process of it runs)' : `${s.outcome ?? s.state}${s.code !== undefined ? ` exit ${s.code}` : ''}`;
        lines.push(...wrapSegs([S(`  ${mark} ${s.name}`, s.state === 'failed' ? 'failure' : 'text'), S(`  ${word}`, 'secondary')], w, '    '));
      }
      lines.push(blank, ...(j.operation ? detailLines(c.data.details[j.operation], c, { kind: 'job', ms: j.elapsedMs, running: j.live }) : para('Run detail: this job names no operation.', w)));
      break;
    }
    case 'turn': {
      // R4 (H117): a chat turn as its sealed receipt says it, whichever surface sent it
      const t = item.turn;
      lines.push(heading('Chat turn'));
      f('Receipt', t.receipt, 'strong'); f('From', TURN_SURFACE[t.surface]); f('Ended', turnEndWords(t), t.state === 'failed' ? 'failure' : 'strong');
      f('Model', t.model ?? 'not recorded on its receipt');
      f('Route', t.local === true ? 'local endpoint, no charge: Ollama on this computer'
        : t.local === false ? 'Ollama, which sent it off this computer (another computer, or a cloud-backed model): no cost comes back'
          : 'not recorded on its receipt (it names the model, not the endpoint that answered)');
      f('When', `${clock(t.at)} (${ago(t.at, c.now)})`); f('Took', took(t.ms)); f('Operation', t.operation ?? 'none recorded');
      lines.push(...para('Its receipt keeps the message and the answer as hashes, never their words.', w, 'secondary'));
      lines.push(blank, ...(t.operation ? detailLines(c.data.details[t.operation], c, { kind: 'turn', ms: t.ms }) : para('Run detail: this turn names no operation.', w)));
      break;
    }
    case 'decision': {
      const d = item.decision;
      lines.push(heading('Waiting on you'));
      f('What', d.title, 'strong'); lines.push(...para(`Needed: ${d.needed}`, w, 'attention')); lines.push(...para(`Why: ${d.why}`, w));
      for (const cmd of d.commands) lines.push([S('  '), S(cmd, 'action')]);
      if (d.record) f('Record', d.record); if (d.receipt) f('Receipt', d.receipt); if (d.operation) f('Operation', d.operation);
      lines.push(...para('Nothing is done until you do it.', w));
      break;
    }
    case 'card': { const x = item.card; lines.push(heading(`Studio card · ${x.kind}`)); f('Title', x.title); f('State', x.state); f('Record', x.record ?? 'none'); f('Receipt', x.receipt ?? 'none'); f('Operation', x.operation ?? x.operationFrom); lines.push([S('  '), S(x.command, 'action')]); break; }
    case 'operation': { const o = item.op; lines.push(heading('Operation')); f('Id', o.id); f('Request', o.request ?? 'no record of it here'); f('From', o.via ?? 'unknown'); f('State', o.state); if (o.why) lines.push(...para(o.why, w)); f('Cards', String(o.cards.length)); break; }
    case 'cap': { const r = item.row; lines.push(heading('Tool')); f('Name', r.name); f('Rung', r.rung); lines.push(...para(r.detail, w)); if (r.setup) lines.push(...para(`Set up: ${r.setup}`, w, 'action')); if (r.tools?.length) f('Agent tools', r.tools.join(', ')); if (r.exercised) f('Used', r.exercised); break; }
    case 'record': { const r = item.rec; lines.push(heading('Record')); f('Id', r.id); f('What', r.what); f('State', r.state); f('When', r.at || 'not recorded'); f('Record', r.record); if (r.operation) f('Operation', r.operation); break; }
    case 'starter': lines.push(heading('Project starter')); f('Name', item.name); lines.push(...para(item.about, w)); lines.push(...para('Enter makes a new project from it; it asks a name.', w, 'action')); break;
    case 'board': lines.push(heading('Studio board template')); f('Id', item.board.id); f('Title', item.board.title); f('Domain', item.board.domain); lines.push(...para(`Capabilities: ${item.board.caps.join(', ')}`, w)); break;
    case 'server': { const s = item.which === 'companion' ? c.ui.companion : c.ui.studio; lines.push(heading(item.which === 'companion' ? 'Companion' : 'Studio')); f('Serving', s.serving ? `yes, at ${s.address}` : s.other ? `another Timmy, at ${s.address}` : 'no'); if (s.last) lines.push(...para(s.last, w)); break; }
    // R5 (H131; the QA of e7f853e, defect 8): Timmy's own record of a turn that ended without its answer is not an answer
    case 'message': lines.push(heading(item.role === 'user' ? 'Your message' : isTimmyRecord(item.text) ? 'Timmy\'s own record (no answer)' : 'Timmy\'s answer')); lines.push(...para(item.text, w, 'text')); break;
    case 'event': lines.push(heading('Activity')); f('When', clock(item.event.at)); lines.push(...para(item.event.words, w, 'text')); if (item.event.job) f('Job', item.event.job); if (item.event.operation) f('Operation', item.event.operation); break;
    case 'conn': {
      // R5 (H131): a connection as the workspace frame has it (src/ops/workspace-frame.ts), never as a setting alone
      const k = item.conn;
      const mark = connectionMark(k.state, c.g);
      lines.push(heading('Connection'));
      f('Name', k.label, 'strong'); f('State', mark.text, mark.role); f('Words', k.words);
      f('Observed', k.observedAt ? `${clock(k.observedAt)} (${ago(k.observedAt, c.now)})` : 'never: no answered request of it is recorded here');
      if (k.detail) f('Detail', k.detail);
      f('Step', k.setup ?? 'none');
      lines.push(blank, ...para('Live only when a request it answered was seen in the last 30 minutes (timmy workspace check asks each one once, with free requests); a setting alone is configured.', w));
      break;
    }
    // R5 (H134): tab 0's and tab 8's rows
    case 'log-receipt': case 'log-op': case 'log-event': lines.push(...logsDetail(item, c.data.logs, w, c.g)); break;
    case 'fleet-plan': case 'clef-decision': lines.push(...fleetDetail(item, w, c.g)); break;
    // R5 (H134): tab 5's records and tab 9's calls, in full
    case 'vox-record': lines.push(...voxDetail(item, c.data.voxTab, w, c.g)); break;
    case 'mcp-call': lines.push(...mcpCallInspector(item, c.data.toolsTab, w, c.g)); break;
    // R5 (H137): a chat turn being answered (tab 7's pane), in its hold's words
    case 'live-turn': lines.push(...liveTurnDetail(item.live, w, c.g, c.now, c.data.turn)); break;
    default: lines.push(heading('Inspector'), [S(itemName(item), 'text')]);
  }
  return { lines, items: [] };
}

/** The files related to the selection: itself, its document and the files its command names. */
function relatedTo(item: Item | null, files: FileRow[]): FileRow[] {
  if (!item) return [];
  const names = new Set<string>();
  if (item.kind === 'file') names.add(item.file.rel);
  if (item.kind === 'doc' || item.kind === 'block') names.add(item.doc.rel);
  if (item.kind === 'job') { const doc = item.job.label.split(' › ')[0]; if (doc) names.add(doc); }
  if (item.kind === 'card' && item.card.record) names.add(item.card.record);
  if (item.kind === 'record') names.add(item.rec.record);
  // R5 (H134): a VoxVision record and its inputs; an MCP call's record
  if (item.kind === 'vox-record') { names.add(item.row.card.file); for (const i of item.row.card.inputs) names.add(i.path.replace(/^\.\//, '')); }
  if (item.kind === 'mcp-call') names.add(item.call.read.call);
  const text = item.kind === 'block' ? item.block.command ?? '' : '';
  return files.filter((f) => names.has(f.rel) || (text && text.includes(f.rel)));
}

function filesTab(c: ViewCtx, item: Item | null): View {
  const lines: Line[] = [];
  const items: View['items'] = [];
  const all = c.data.files.groups.flatMap((g) => g.files);
  const related = c.ui.related ? relatedTo(item, all) : all;
  lines.push(c.ui.related
    ? [S(`Related to ${itemName(item)} `, 'text'), key('f'), S(' all files', 'secondary')]
    : [S(`All ${count(all.length, 'project file')} `, 'text'), key('f'), S(' related only', 'secondary')]);
  if (!all.length) { lines.push(blank, [S('No files yet.', 'strong')], ...para('This project is blank; files appear here as work makes them.', c.width)); return { lines, items }; }
  if (c.ui.related && !related.length) lines.push([S('  none: the selection names no project file', 'secondary')]);
  const cur = cursorOf(c.ui, 'right:files', related.length);
  let i = 0;
  for (const kind of KIND_ORDER) {
    const inKind = related.filter((f) => f.kind === kind);
    if (!inKind.length) continue;
    lines.push(heading(`${KIND_TITLE[kind]} (${inKind.length})`));
    for (const fl of inKind) { items.push({ line: lines.length, item: { kind: 'file', key: `rfile:${fl.rel}`, file: fl } }); lines.push(row([S(fl.rel, 'text')], i === cur, c.g)); i += 1; }
  }
  return { lines, items };
}

export function rightView(c: ViewCtx): View {
  const item = selectedItem(c);
  const v = c.ui.tab === 'tools' ? toolsTab(c, item) : c.ui.tab === 'inspector' ? inspectorTab(c, item) : filesTab(c, item);
  const tabRow = (compact: boolean): Line => (['tools', 'inspector', 'files'] as const).flatMap((t, i): Seg[] => {
    const on = c.ui.tab === t;
    const label = t === 'tools' ? 'Tools' : t === 'inspector' ? 'Inspector' : 'Files';
    const mark = compact ? (on ? c.g.cursor : '') : (on ? `${c.g.cursor} ` : '  ');
    return [...(i ? [S(c.g.unicode ? ' │ ' : ' | ', 'border')] : []), ...(mark ? [S(mark, 'action')] : []), S(label, on ? 'strong' : 'secondary', on ? { underline: true } : {})];
  });
  // a narrow drawer keeps all three tabs whole: the marker loses its column
  const tabs = lineCells(tabRow(false)) <= c.width ? tabRow(false) : tabRow(true);
  // the tabs' row first; the tab's own rows below it
  return { lines: [tabs, blank, ...v.lines], items: v.items.map((x) => ({ ...x, line: x.line + 2 })) };
}

// ── the bottom: task controls and Activity ─────────────────────────────────────

/**
 * R5 (H131): Activity & log. Its first row: what runs and waits (with Stop current too where row 2 has no room for it); then,
 * collapsed, the frame's newest log lines, the newest first (`logLines` of them); expanded ([a]), every event of this Workbench's
 * Activity (the jobs' records, the lines they printed, its own notices), oldest first and the newest at the bottom, as R4 drew
 * them. `foot` is the key-hint line, drawn last (a fresh notice takes its place for a few seconds). `fixed`: the rows at the top
 * that do not scroll.
 */
export function bottomView(c: ViewCtx, o: { logLines?: number; stop?: boolean } = {}): View & { fixed: number; foot: Line; footAbove?: Line } {
  const { ui, data, g, width } = c;
  const fresh = ui.flash && c.now - ui.flash.at < 6000 ? ui.flash : null;
  // R5 (H131; the QA round's defect 15): a notice wider than the row takes the row above the hints too (for its few seconds),
  // so its words are read to their end ("…so Timmy asks once" was cut); a longer one is cut at the second row's end
  const said = fresh ? wrapSegs([S(fresh.text, fresh.role)], width) : null;
  const foot: Line = !said ? hintLine(width) : said.length === 1 ? said[0] : fit(said.slice(1).flatMap((r, i) => (i ? [S(' '), ...r] : r)), width, g.ellipsis);
  const footAbove = said && said.length > 1 ? said[0] : undefined;
  const a = data.activity;
  // R5 (H131; the QA round's defect 9): the newest event in words; a line a job printed (its raw output) is tab 0's
  const newest = a.events.find((e) => !e.output) ?? null;
  const last = newest ? `${clock(newest.at)} ${newest.words}` : 'nothing yet';
  // R5 (H131; the QA round's defect 1): a chat turn being answered runs too
  const turn = chatTurnNow(data);
  const runningN = a.running + (turn ? 1 : 0);
  const motion = !ui.settings.settings.reducedMotion && runningN ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][Math.floor(c.now / 250) % 10] : '';
  // R4 (H112): this Workbench's runs in another project count as running, with where they run
  const turnWords = turn ? `, the chat turn${turn.mine ? '' : ` in ${turn.where}`}` : '';
  const running = a.away ? `${runningN} running (${a.away.running} in ${a.away.where.join(', ')}${turnWords})` : `${runningN} running${turn ? ` (${turnWords.slice(2)})` : ''}`;
  // the newest of this Workbench's own Activity (a notice of what it did, a job's line) stays on the first row, as R4 drew it;
  // the rows under it, collapsed, are the shared log's
  const strip: Line = [
    S(ui.activityOpen ? `${g.expanded} ` : `${g.cursor} `, 'action'), S('Activity  ', 'strong'),
    S(`${motion && g.unicode ? `${motion} ` : ''}${running}`, 'text'), S(` ${g.sep} `, 'secondary'),
    S(`${a.waiting} waiting on you`, a.waiting ? 'attention' : 'text'),
    S(` ${g.sep} last: `, 'secondary'), S(last, newest?.failed ? 'failure' : 'text'),
  ];
  const toggle: Line = [key('a'), S(ui.activityOpen ? ' collapse' : ' expand', 'secondary')];
  // on a short terminal row 2 has no row for the run state and Stop: they are here, kept whole first
  const right: Line = o.stop ? [...stopRight(c, Math.max(10, width - 30)), S('  '), ...toggle] : toggle;
  const lines: Line[] = [spread(strip, right, width, g.ellipsis)];
  const items: View['items'] = [];
  if (!ui.activityOpen) {
    const n = Math.max(0, o.logLines ?? 3);
    lines.push(...newestLog(c, n, width).slice(0, n));
    return { lines, items, fixed: lines.length, foot, ...(footAbove ? { footAbove } : {}) };
  }
  {
    const sel = selectedItem(c);
    const op = operationOf(sel);
    // R4 (H112): oldest first, the newest at the bottom (a log's order): rows that arrive are added below, so a row the person
    // selected higher up, and the rows around it, stay where they are; the view follows the newest only while it is selected
    const events = [...(ui.activityAll || !op ? a.events : a.events.filter((e) => e.operation === op))].reverse();
    const follow = ui.activityFollow !== false;
    lines.push([
      S(ui.activityAll || !op ? 'All operations' : `Operation ${op}`, 'strong'), S('  ', 'secondary'), key('A'), S(ui.activityAll || !op ? (op ? ` only ${op}` : '') : ' all operations', 'secondary'),
      S(`  ${g.sep} `, 'secondary'), S(follow ? 'following the newest' : 'held where you are (End follows the newest)', follow ? 'secondary' : 'attention'),
    ]);
    const cur = cursorOf(ui, 'bottom', events.length);
    if (!events.length) lines.push([S('  No events yet.', 'secondary')]);
    events.forEach((e, i) => {
      items.push({ line: lines.length, item: { kind: 'event', key: `ev:${e.key}`, event: e } });
      // an event's words are whole here: a long one wraps under its time (the strip above shows only its start)
      const at = `${clock(e.at)} `;
      const role: Role = e.failed ? 'failure' : e.attention ? 'attention' : 'text';
      const [first = '', ...more] = wrapText(e.words, Math.max(10, width - 2 - at.length), g.ellipsis);
      lines.push(row([S(at, 'secondary'), S(first, role)], i === cur && ui.focus === 'bottom', g));
      for (const rest of more) lines.push([S(' '.repeat(2 + at.length)), S(rest, role)]);
    });
  }
  return { lines, items, fixed: 2, foot, ...(footAbove ? { footAbove } : {}) };
}
