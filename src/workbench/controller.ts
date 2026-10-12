/**
 * R4 (H110): the terminal Workbench's state and what each key, click and timer does. The app (src/workbench/app.tsx) draws
 * what frame() returns and hands every key and mouse report here.
 *
 * Reading: the active project, its jobs and Activity every second; its files, workflows, decisions and records every few
 * seconds and on [r]; the overview, Studio's cards and the tools check when their workspace is first opened. Acting: through
 * the REPL's own code on this Workbench's Workspace (src/repl/workspace.ts): /project to switch or make a project (which
 * writes the shared active-project record), /run for a workflow block (one operation, its NEEDS YOU box drawn here), /stop
 * for its own jobs, recovery's stop for a job an ended session left (src/workbench/stop.ts), and the Companion and Studio
 * controls (src/workbench/servers.ts). The run detail and the chat session come from their producers when this Timmy has
 * them (src/workbench/producers.ts); until then the Inspector and the composer say so.
 */
import { statSync } from 'node:fs';
import type { Key } from 'ink';
import type { CapabilityRow } from '../capabilities/index.js';
import type { ChatSession, OpenChatSession } from '../contracts/chat-session.js';
import type { JobRecord } from '../jobs/index.js';
import { readActiveProject, sameFolder } from '../project/index.js';
import { listStarters } from '../project/starters.js';
import { currentOperation } from '../ops/context.js';
import type { ApprovalRequest, Decision } from '../repl/approvals.js';
import type { Workspace } from '../repl/workspace.js';
import { projectCards } from '../studio/project-cards.js';
import { publicTemplates } from '../studio/templates.js';
import type { Segment } from '../term/theme.js';
import { keyAt, type MouseReport } from '../tui/mouse.js';
import { receiptsPath, type Receipt } from '../utils/receipts.js';
import { innerWidth, type Glyphs } from './frame.js';
import { modeOf } from './layout.js';
import type { Data, Item, Lazy, Overlay, Region, Ui } from './model.js';
import { REGIONS } from './model.js';
import { NAV_ORDER, type WorkspaceId } from './nav.js';
import { checkDetail, realProducers, type Loaded, type Producers, type RunDetailOf } from './producers.js';
import type { CompanionControl, StudioControl } from './servers.js';
import { frameOf, type Frame } from './screen.js';
import { DEFAULT_SETTINGS, PRESETS, readSettings, RIGHT_TABS, saveSettings, SETTING_LABELS, type SaveResult, type SettingsRead, type WorkbenchSettings } from './settings.js';
import {
  activityOf, chainOf, projectChoices, projectView, readChatTail, readDecisions, readFiles, readJobs, readNativeRows, readRoute, readVoxRecords, readWorkflows,
  type ActivityEvent,
} from './state.js';
import { stopCurrent, type StopDeps } from './stop.js';
import { clock, type Line, type Role } from './text.js';
import { actionsOf, centerView, cursorOf, selectedItem, stopWords, topButtons, type ViewCtx } from './views.js';

/** What this Workbench uses of the REPL's Workspace. */
export type WorkspaceLike = Pick<Workspace, 'project' | 'root' | 'jobs' | 'project_' | 'stop' | 'overview' | 'close' | 'run' | 'ops'>;

/** Keys this soon after a NEEDS YOU box appears are not answers (the REPL's type-ahead guard, src/repl/approvals.ts). */
export const GUARD_MS = 300;

export interface ControllerDeps {
  env: NodeJS.ProcessEnv;
  jobsDir: string;
  onPath: (cmd: string) => string | null;
  glyphs: Glyphs;
  workspace: WorkspaceLike;
  companion: CompanionControl;
  studio: StudioControl;
  /** the /tools ladder's rows (local checks only: no model key is passed, so OpenRouter is never asked) */
  capabilities: () => Promise<CapabilityRow[]>;
  settings?: { read: () => SettingsRead; save: (s: WorkbenchSettings) => SaveResult };
  /** asks the terminal for mouse reports, or gives them back */
  setMouse?: (on: boolean) => void;
  /** an interactive `timmy workbench`: the startup choices apply */
  interactive?: boolean;
  /** the app ends with this exit code (after the terminal is restored) */
  onExit?: (code: number, after: string[]) => void;
  stopLeft?: StopDeps['stopLeft'];
  /** the run detail's and the chat session's producers (absent: the real modules, when this Timmy has them) */
  producers?: Producers;
  /** the NEEDS YOU box's type-ahead guard (ms) */
  guardMs?: number;
  now?: () => number;
  /** how often the jobs and Activity are read (ms) */
  tickMs?: number;
  /** how often the files, workflows and decisions are read (ms) */
  slowMs?: number;
}

const plain = (l: Segment[] | Line): string => l.map((s) => s.text).join('');

export class Controller {
  ui: Ui;
  data: Data;
  private readonly listeners = new Set<() => void>();
  private timers: NodeJS.Timeout[] = [];
  private last: Frame | null = null;
  private size = { columns: 80, rows: 24 };
  private readonly mine = new Set<string>();
  private readonly notices: ActivityEvent[] = [];
  private chainCache: { key: string; chain: Receipt[] } | null = null;
  private records: JobRecord[] = [];
  private disposed = false;
  private signature = '';
  /** the producers, once asked: null while they load */
  private detailOf: Loaded<RunDetailOf> | null = null;
  private chatOf: Loaded<OpenChatSession> | null = null;
  /** the chat session for the project shown (opened when Chat is first opened) */
  private chat: { root: string; state: 'opening' } | { root: string; state: 'open'; session: ChatSession } | { root: string; state: 'failed'; why: string } | null = null;
  /** the runs being started here (one press runs once) */
  private readonly starting = new Set<string>();
  private turnAbort: AbortController | null = null;

  constructor(private readonly d: ControllerDeps) {
    const settings = (d.settings?.read ?? (() => readSettings(d.env)))();
    const project = projectView(d.workspace.project, d.env);
    const remembered = settings.settings.rememberLayout ? settings.settings.layouts[project.id] : undefined;
    this.ui = {
      workspace: remembered?.workspace ?? 'workflows', focus: 'nav', tab: remembered?.tab ?? 'inspector',
      navOpen: false, rightOpen: false, activityOpen: remembered?.activity ?? false, activityAll: false, overlay: null,
      input: { field: null, text: '' }, cursor: {}, scroll: {}, flash: null, mouse: false, related: false, settings, saved: null,
      companion: d.companion.state(), studio: d.studio.state(), mine: [],
    };
    this.data = this.emptyData(project);
    this.readAll();
  }

  private now(): number { return this.d.now?.() ?? Date.now(); }

  private emptyData(project: ReturnType<typeof projectView>): Data {
    return {
      project, projects: [], files: { total: 0, truncated: false, groups: [] }, workflows: { upmd: false, docs: [] }, jobs: [],
      decisions: { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [] }, route: readRoute(this.d.env),
      activity: { running: 0, waiting: 0, last: null, events: [] }, chat: { session: null, total: 0, messages: [] }, vox: [], native: {},
      starters: [], boards: [], studio: { state: 'idle' }, overview: { state: 'idle' }, caps: { state: 'idle' }, details: {}, readAt: 0,
    };
  }

  // ── subscribers ───────────────────────────────────────────────────────────────

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { if (!this.disposed) for (const fn of this.listeners) fn(); }

  /** What the person sees now: say it in Activity and on the controls row. A notice that names a job (or is given an
   *  operation) belongs to that job's operation, so Activity's filter for that operation keeps it. */
  say(text: string, role: Role = 'text', meta: { operation?: string; job?: string } = {}): void {
    const at = new Date(this.now()).toISOString();
    this.ui.flash = { text, role, at: this.now() };
    const named = meta.job ?? /\b(j[0-9a-f]{6,})\b/.exec(text)?.[1];
    const job = named ? this.records.find((j) => j.id === named) : undefined;
    const operation = meta.operation ?? job?.operation;
    this.notices.unshift({ at, words: text, ...(job ? { job: job.id } : {}), ...(operation ? { operation } : {}), ...(role === 'failure' ? { failed: true } : {}), ...(role === 'attention' ? { attention: true } : {}) });
    this.notices.splice(40);
    this.data.activity = activityOf(this.data.jobs, this.data.decisions.total, this.notices);
    this.emit();
  }

  // ── reading the records ───────────────────────────────────────────────────────

  private chain(): Receipt[] {
    let key = '';
    try { const p = this.d.env.TIMMY_STORE ? receiptsPath('runs') : receiptsPath('runs', this.data.project.root); const st = statSync(p); key = `${p}:${st.size}:${st.mtimeMs}`; } catch { key = 'none'; }
    if (this.chainCache?.key === key) return this.chainCache.chain;
    const chain = chainOf(this.data.project.root, this.d.env);
    this.chainCache = { key, chain };
    return chain;
  }

  /** The jobs and Activity (every tick). */
  readJobs(): void {
    try { this.records = this.d.workspace.jobs.list(); } catch { this.records = []; }
    const root = this.data.project.root;
    this.data.jobs = readJobs(this.records, root, { mine: this.mine, chain: this.chain() });
    this.data.activity = activityOf(this.data.jobs, this.data.decisions.total, this.notices);
  }

  /** Everything but the on-demand parts (every few seconds, and on [r]). */
  readAll(): void {
    const root = this.data.project.root;
    this.readJobs();
    const files = readFiles(root);
    this.data.files = files;
    const chain = this.chain();
    const own = this.records.filter((j) => sameFolder(j.root, root));
    this.data.workflows = readWorkflows(root, { jobs: own, chain, files: files.groups.flatMap((g) => g.files.map((f) => f.rel)), env: this.d.env, onPath: this.d.onPath });
    this.data.decisions = readDecisions(root, this.records, chain, this.data.caps.state === 'ready' ? { checkedAt: new Date(this.data.caps.at).toISOString(), rows: this.data.caps.value } : undefined, this.d.env);
    this.data.activity = activityOf(this.data.jobs, this.data.decisions.total, this.notices);
    this.data.route = readRoute(this.d.env, root);
    this.data.chat = readChatTail(root);
    this.data.vox = readVoxRecords(root);
    this.data.native = { create3d: readNativeRows(root, 'create3d'), motion: readNativeRows(root, 'motion') };
    this.data.projects = projectChoices(this.data.project, this.d.env);
    if (!this.data.starters.length) { try { this.data.starters = listStarters(); } catch { this.data.starters = []; } }
    if (!this.data.boards.length) { try { this.data.boards = publicTemplates(); } catch { this.data.boards = []; } }
    this.data.readAt = this.now();
  }

  private async lazy<T>(key: 'overview' | 'studio' | 'caps', load: () => Promise<T>, force = false): Promise<void> {
    const cur = this.data[key] as Lazy<T>;
    if (!force && (cur.state === 'loading' || cur.state === 'ready')) return;
    (this.data[key] as Lazy<T>) = { state: 'loading', since: this.now() };
    this.emit();
    try {
      const value = await load();
      (this.data[key] as Lazy<T>) = { state: 'ready', value, at: this.now() };
    } catch (e) {
      (this.data[key] as Lazy<T>) = { state: 'failed', why: e instanceof Error ? e.message : String(e), at: this.now() };
    }
    this.emit();
  }

  /** What a workspace reads when it is first opened (and again on [r]). */
  private loadFor(ws: WorkspaceId, force = false): void {
    if (ws === 'overview') {
      void this.lazy('overview', async () => {
        const lines = await this.d.workspace.overview('');
        return lines.map((l) => l.map((s) => ({ text: s.text.replace(/^ {2}/, ''), role: roleOf(s.role) })));
      }, force);
    }
    if (ws === 'studio') {
      void this.lazy('studio', async () => {
        const p = this.data.project;
        const r = projectCards({ root: p.root, name: p.name, jobs: this.d.jobsDir, receipts: null }, { chain: this.chain(), jobs: this.records.filter((j) => sameFolder(j.root, p.root)) });
        return { cards: r.cards, notes: r.notes, operations: r.operations ?? [] };
      }, force);
    }
    if (['voxvision', 'create3d', 'motion', 'rea', 'tools'].includes(ws)) void this.lazy('caps', () => this.d.capabilities(), force);
  }

  // ── timers ────────────────────────────────────────────────────────────────────

  start(): void {
    void this.loadProducers();
    const tick = this.d.tickMs ?? 1000;
    const slow = this.d.slowMs ?? 5000;
    this.timers.push(setInterval(() => this.onTick(), tick));
    this.timers.push(setInterval(() => { this.readAll(); this.emit(); }, slow));
    this.loadFor(this.ui.workspace);
    if (this.d.interactive) {
      const s = this.ui.settings.settings;
      if (s.openCompanionAtStart) void this.showCompanion('at startup (Quick settings)');
      if (s.openStudioAtStart) void this.showStudio('at startup (Quick settings)');
    }
  }

  private onTick(): void {
    this.followProject();
    this.readJobs();
    // Activity's words change with the time, and a spinner turns while something runs
    const sig = JSON.stringify([this.data.jobs.map((j) => [j.id, j.state, j.steps.length, j.word]), this.data.activity.last?.words, this.ui.flash?.at]);
    if (sig !== this.signature || this.data.activity.running || (this.ui.flash && this.now() - this.ui.flash.at < 7000)) { this.signature = sig; this.emit(); }
  }

  /** Follow active project: a project chosen in another surface moves this Workbench (else it says it is pinned). */
  private followProject(): void {
    let rec;
    try { rec = readActiveProject(this.data.project.root); } catch { return; }
    if (!rec.chosen || sameFolder(rec.root, this.data.project.root)) { this.data.pinnedAway = undefined; return; }
    if (this.ui.settings.settings.followActiveProject) this.switchProject(rec.root, `followed the active project (chosen elsewhere): ${rec.name}`);
    else this.data.pinnedAway = rec.name;
  }

  dispose(): void {
    if (this.rememberTimer) { clearTimeout(this.rememberTimer); this.rememberTimer = null; this.rememberNow(); }
    // a box nobody can answer any more is denied (deny is the default); a message being sent is stopped
    if (this.ui.overlay?.kind === 'needs-you') this.ui.overlay.answer('deny');
    this.turnAbort?.abort();
    this.disposed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.d.studio.close();
  }

  // ── the frame ─────────────────────────────────────────────────────────────────

  can(): ViewCtx['can'] {
    const chat = this.chat?.root === this.data.project.root ? this.chat : null;
    const chatWhy = !this.chatOf ? 'the chat session is being looked for'
      : !this.chatOf.ok ? `sending from the Workbench needs the shared chat session: ${this.chatOf.why}. Type in the REPL (timmy) or the monitor (timmy watch) instead. Nothing is sent from here.`
        : !chat ? 'its chat session opens when Chat is opened'
          : chat.state === 'opening' ? 'its chat session is opening'
            : chat.state === 'failed' ? `its chat session did not open: ${chat.why}. Nothing is sent from here.` : undefined;
    const detailWhy = !this.detailOf ? 'the run detail\'s producer is being looked for'
      : !this.detailOf.ok ? `${this.detailOf.why}; the job's own fields are above` : undefined;
    return {
      run: true,
      chat: !chatWhy, ...(chatWhy ? { chatWhy } : {}),
      detail: !detailWhy, ...(detailWhy ? { detailWhy } : {}),
    };
  }

  // ── the producers (src/workbench/producers.ts) ────────────────────────────────

  private async loadProducers(): Promise<void> {
    const p = this.d.producers ?? realProducers;
    const [detail, chat] = await Promise.all([p.runDetail(), p.openChat()]);
    this.detailOf = detail;
    this.chatOf = chat;
    if (this.ui.workspace === 'chat') void this.openChat();
    this.emit();
  }

  /** The chat session for the project shown: opened once per project, through the producer (one path for every surface). */
  private async openChat(): Promise<void> {
    if (!this.chatOf?.ok) return;
    const p = this.data.project;
    if (this.chat?.root === p.root) return;
    this.chat = { root: p.root, state: 'opening' };
    try {
      const session = await this.chatOf.value({ project: { name: p.name, root: p.root }, surface: 'workbench' });
      if (this.chat?.root !== p.root) return;
      this.chat = { root: p.root, state: 'open', session };
      this.data.chatRoute = session.route();
    } catch (e) {
      if (this.chat?.root === p.root) this.chat = { root: p.root, state: 'failed', why: e instanceof Error ? e.message : String(e) };
    }
    this.emit();
  }

  /** The run detail of an operation the Inspector shows: read once, and again while its run goes on. */
  private wantDetail(op: string, live: boolean): void {
    if (!this.detailOf?.ok) return;
    const cur = this.data.details[op];
    if (cur?.state === 'loading') return;
    if (cur && (cur.state === 'ready' || cur.state === 'failed') && (!live || this.now() - cur.at < 1000)) return;
    const of = this.detailOf.value;
    const root = this.data.project.root;
    this.data.details[op] = cur?.state === 'ready' ? cur : { state: 'loading', since: this.now() };
    void (async () => {
      try {
        const got = checkDetail(await of(op, { root }), op);
        this.data.details[op] = got.ok ? { state: 'ready', value: got.detail, at: this.now() } : { state: 'failed', why: got.why, at: this.now() };
      } catch (e) {
        this.data.details[op] = { state: 'failed', why: `the producer failed: ${e instanceof Error ? e.message : String(e)}`, at: this.now() };
      }
      this.emit();
    })();
  }

  frame(columns: number, rows: number): Frame {
    this.size = { columns, rows };
    // a drawer belongs to a size: one that is not a drawer there is closed (in focus mode both are drawers)
    const mode = modeOf(columns);
    if (mode === 'wide' && !this.ui.focusMode) { this.ui.rightOpen = false; this.ui.navOpen = false; }
    if (mode === 'medium' && !this.ui.focusMode) this.ui.navOpen = false;
    this.ui.companion = this.d.companion.state();
    this.ui.studio = this.d.studio.state();
    this.ui.mine = [...this.mine];
    const f = frameOf({ ui: this.ui, data: this.data, g: this.d.glyphs, columns, rows, now: this.now(), can: this.can() });
    for (const d of Object.values(f.regions)) if (d) this.ui.scroll[d.list] = d.scroll;
    // the Inspector, when it shows a job of an operation, draws that operation's run detail
    if (f.regions.right && this.ui.tab === 'inspector') {
      const sel = selectedItem({ ui: this.ui, data: this.data, g: this.d.glyphs, width: 40, height: 10, now: this.now(), can: this.can() });
      if (sel?.kind === 'job' && sel.job.operation) this.wantDetail(sel.job.operation, sel.job.live);
    }
    if (this.ui.focus === 'nav' && !f.regions.nav) this.ui.focus = 'center';
    if (this.ui.focus === 'right' && !f.regions.right) this.ui.focus = 'center';
    if (this.ui.focus === 'center' && !f.regions.center) this.ui.focus = f.regions.right ? 'right' : 'top';
    this.last = f;
    return f;
  }

  private ctx(): ViewCtx {
    const r = this.last?.regions.center?.rect;
    return { ui: this.ui, data: this.data, g: this.d.glyphs, width: Math.max(10, innerWidth(r?.w ?? this.size.columns)), height: Math.max(3, (r?.h ?? this.size.rows) - 2), now: this.now(), can: this.can() };
  }

  selected(): Item | null { return selectedItem(this.ctx()); }

  // ── keys ──────────────────────────────────────────────────────────────────────

  key(input: string, k: Partial<Key>): void {
    const o = this.ui.overlay;
    // a NEEDS YOU box takes every key until it is answered; Ctrl+C denies it (a second Ctrl+C then quits)
    if (o?.kind === 'needs-you') { this.needsYouKey(o, input, k); return; }
    if (k.ctrl && input === 'c') { void this.quit(); return; }
    if (o?.kind === 'quit') { if (k.escape) { this.ui.overlay = null; this.emit(); } return; }
    if (this.ui.input.field) { this.typing(input, k); return; }
    if (o && this.overlayKey(o, input, k)) return;
    if (k.escape) { this.escape(); return; }
    if (k.tab) { this.cycleFocus(k.shift ? -1 : 1); return; }
    if (k.upArrow || (!k.ctrl && input === 'k')) { this.move(-1); return; }
    if (k.downArrow || (!k.ctrl && input === 'j')) { this.move(1); return; }
    if (k.pageUp) { this.move(-this.page()); return; }
    if (k.pageDown) { this.move(this.page()); return; }
    // Home and End: the first or last tab of the right dock (as the reference's tabs), else the first or last row
    if (k.home || k.end) {
      if (this.ui.focus === 'right') { this.ui.tab = RIGHT_TABS[k.home ? 0 : RIGHT_TABS.length - 1]; this.remember(); this.emit(); } else this.move(k.home ? -1e6 : 1e6);
      return;
    }
    if (k.leftArrow) { this.side(-1); return; }
    if (k.rightArrow) { this.side(1); return; }
    if (k.return) { void this.enter(); return; }
    switch (input) {
      case '?': this.open({ kind: 'help' }); return;
      case 'p': this.openPicker(); return;
      case 'n': this.openNew(); return;
      case '/': this.search(); return;
      case 'c': void this.showCompanion(); return;
      case 's': void this.showStudio(); return;
      case 'C': void this.d.companion.stopServing().then((w) => this.say(w)); return;
      case 'S': void this.d.studio.stopServing().then((w) => this.say(w)); return;
      case ',': this.open({ kind: 'settings' }); return;
      case 'x': void this.stop(); return;
      case 'i': this.toggleRight(); return;
      case 'g': this.toggleNav(); return;
      case 'z': this.ui.focusMode = !this.ui.focusMode; this.ui.navOpen = false; this.ui.rightOpen = false; this.ui.focus = 'center'; this.emit(); return;
      case 'a': this.ui.activityOpen = !this.ui.activityOpen; this.remember(); this.emit(); return;
      case 'A': this.ui.activityAll = !this.ui.activityAll; this.emit(); return;
      case 'f': this.ui.related = !this.ui.related; this.emit(); return;
      case 'r': this.refresh(); return;
      case 'm': this.toggleMouse(); return;
      default:
    }
  }

  private page(): number {
    const r = this.last?.regions[this.ui.focus]?.rect;
    return Math.max(1, (r?.h ?? 10) - 4);
  }

  private open(o: Overlay): void {
    this.ui.overlay = o;
    this.ui.cursor.overlay = 0;
    this.ui.scroll.overlay = 0;
    if (modeOf(this.size.columns) !== 'wide' || this.ui.focusMode) { this.ui.rightOpen = false; this.ui.navOpen = false; }
    this.ui.focus = 'center';
    this.emit();
  }

  private escape(): void {
    if (this.ui.overlay) this.ui.overlay = null;
    else if (this.ui.rightOpen) { this.ui.rightOpen = false; this.ui.focus = 'center'; }
    else if (this.ui.navOpen) { this.ui.navOpen = false; this.ui.focus = 'center'; }
    else if (this.ui.focusMode) { this.ui.focusMode = false; }
    this.emit();
  }

  private visibleRegions(): Region[] {
    const f = this.last;
    return REGIONS.filter((r) => (f ? !!f.regions[r] : true));
  }

  cycleFocus(dir: 1 | -1): void {
    const regs = this.visibleRegions();
    const at = regs.indexOf(this.ui.focus);
    this.ui.focus = regs[(at + dir + regs.length) % regs.length] ?? 'center';
    this.emit();
  }

  /** The list a region's cursor moves in. */
  private listOf(region: Region): string {
    if (region === 'center') return this.ui.overlay ? 'overlay' : `center:${this.ui.workspace}`;
    if (region === 'right') return `right:${this.ui.tab}`;
    return region;
  }

  private itemsOf(region: Region): number {
    if (region === 'nav') return NAV_ORDER.length;
    if (region === 'top') return topButtons(this).length;
    return this.last?.regions[region]?.items.length ?? 0;
  }

  move(delta: number): void {
    const region = this.ui.focus;
    this.ui.follow = null;
    if (region === 'nav') {
      const at = NAV_ORDER.indexOf(this.ui.workspace);
      this.selectWorkspace(NAV_ORDER[Math.max(0, Math.min(NAV_ORDER.length - 1, at + delta))]);
      return;
    }
    const list = this.listOf(region);
    const n = this.itemsOf(region);
    if (!n) return;
    this.ui.cursor[list] = Math.max(0, Math.min(n - 1, (this.ui.cursor[list] ?? 0) + delta));
    this.emit();
  }

  private side(dir: 1 | -1): void {
    if (this.ui.focus === 'right' || this.ui.focus === 'center' && !this.last?.regions.center) {
      const at = RIGHT_TABS.indexOf(this.ui.tab);
      this.ui.tab = RIGHT_TABS[(at + dir + RIGHT_TABS.length) % RIGHT_TABS.length];
      this.remember();
      this.emit();
      return;
    }
    if (this.ui.focus === 'top') { this.move(dir); return; }
    if (this.ui.focus === 'nav' && dir === 1) { this.ui.focus = 'center'; this.emit(); }
  }

  selectWorkspace(ws: WorkspaceId): void {
    if (this.ui.workspace !== ws) {
      this.ui.workspace = ws;
      this.ui.overlay = null;
      this.remember();
    }
    this.loadFor(ws);
    if (ws === 'chat') void this.openChat();
    this.emit();
  }

  private search(): void {
    if (this.ui.workspace === 'tools' && this.ui.focus !== 'nav') { this.ui.input = { field: 'tools', text: this.ui.input.text }; this.loadFor('tools'); this.emit(); return; }
    if (modeOf(this.size.columns) === 'narrow' || this.ui.focusMode) this.ui.navOpen = true;
    this.ui.focus = 'nav';
    this.ui.input = { field: 'search', text: '' };
    this.emit();
  }

  private toggleRight(): void {
    if (modeOf(this.size.columns) === 'wide' && !this.ui.focusMode) { this.ui.tab = 'inspector'; this.ui.focus = 'right'; this.emit(); return; }
    this.ui.rightOpen = !this.ui.rightOpen;
    if (this.ui.rightOpen) { this.ui.navOpen = false; this.ui.focus = 'right'; } else this.ui.focus = 'center';
    this.emit();
  }

  private toggleNav(): void {
    if (modeOf(this.size.columns) !== 'narrow' && !this.ui.focusMode) { this.ui.focus = 'nav'; this.emit(); return; }
    this.ui.navOpen = !this.ui.navOpen;
    if (this.ui.navOpen) { this.ui.rightOpen = false; this.ui.focus = 'nav'; } else this.ui.focus = 'center';
    this.emit();
  }

  private toggleMouse(): void {
    this.ui.mouse = !this.ui.mouse;
    this.d.setMouse?.(this.ui.mouse);
    this.say(this.ui.mouse ? 'Mouse: the Workbench takes clicks and the wheel ([m] gives them back to the terminal, to select text).' : 'Mouse: the terminal\'s again (select text as usual; [m] lets the Workbench take clicks).');
  }

  refresh(): void {
    this.readAll();
    this.loadFor(this.ui.workspace, true);
    this.say(`Read ${this.data.project.name}'s records again at ${clock(new Date(this.now()).toISOString())}.`, 'secondary');
  }

  // ── typing into a field ───────────────────────────────────────────────────────

  private typing(input: string, k: Partial<Key>): void {
    const f = this.ui.input.field!;
    if (k.escape) {
      if (f === 'composer' && this.turnAbort) { this.turnAbort.abort(); this.say('Stopping the message being sent (Esc)…', 'secondary'); }
      this.ui.input = { field: null, text: f === 'tools' ? '' : '' };
      if (f === 'picker' || f === 'new') this.ui.overlay = null;
      this.emit();
      return;
    }
    if (k.return) { void this.submit(f, this.ui.input.text); return; }
    if (k.upArrow || k.downArrow) {
      if (f === 'picker') { this.ui.cursor.overlay = Math.max(0, (this.ui.cursor.overlay ?? 0) + (k.upArrow ? -1 : 1)); this.emit(); }
      return;
    }
    if (k.backspace || k.delete) { this.ui.input.text = [...this.ui.input.text].slice(0, -1).join(''); this.emit(); return; }
    if (k.ctrl || k.meta || k.tab) return;
    // printable text only (a paste arrives as one string)
    const text = input.replace(/[\x00-\x1f\x7f]/g, '');
    if (!text) return;
    this.ui.input.text = (this.ui.input.text + text).slice(0, 300);
    if (f === 'picker') this.ui.cursor.overlay = 0;
    this.emit();
  }

  private async submit(field: NonNullable<Ui['input']['field']>, text: string): Promise<void> {
    if (field === 'search') {
      const q = text.trim().toLowerCase();
      const hit = NAV_ORDER.find((id) => this.labelOf(id).toLowerCase().startsWith(q)) ?? NAV_ORDER.find((id) => this.labelOf(id).toLowerCase().includes(q));
      this.ui.input = { field: null, text: '' };
      if (hit) { this.selectWorkspace(hit); this.ui.focus = 'center'; this.ui.navOpen = false; }
      else if (q) { this.selectWorkspace('tools'); this.ui.input = { field: 'tools', text }; this.ui.focus = 'center'; }
      this.emit();
      return;
    }
    if (field === 'tools') { this.ui.input = { field: null, text: '' }; this.ui.cursor['center:tools'] = 0; this.emit(); return; }
    if (field === 'picker') {
      const v = centerView(this.ctx());
      const it = v.items[cursorOf(this.ui, 'overlay', v.items.length)]?.item;
      this.ui.input = { field: null, text: '' };
      this.ui.overlay = null;
      if (it?.kind === 'project') this.switchProject(it.choice.root, `switched to ${it.choice.name}`);
      else if (it?.kind === 'action' && it.action === 'open-path') this.switchProject(text.trim(), `opened ${text.trim()}`);
      else if (it?.kind === 'action' && it.action === 'new-project') { this.openNew(); if (text.trim()) this.ui.input.text = text.trim(); }
      this.emit();
      return;
    }
    if (field === 'new') {
      const o = this.ui.overlay;
      const from = o?.kind === 'new' ? o.from : undefined;
      this.ui.input = { field: null, text: '' };
      this.ui.overlay = null;
      this.makeProject(text.trim(), from);
      return;
    }
    if (field === 'composer') {
      const why = this.can().chatWhy;
      if (why || !text.trim()) { this.ui.input = { field: null, text: '' }; if (why) this.say(`Not sent: ${why}`, 'secondary'); this.emit(); return; }
      if (this.data.turn?.state === 'sending') { this.say('A message is still being sent: Esc stops it, or wait for its answer.', 'secondary'); return; }
      this.ui.input = { field: 'composer', text: '' };
      await this.send(text.trim());
    }
  }

  /** The composer's message, through the chat session (one path for every surface), as one operation, as the REPL does. */
  private async send(text: string): Promise<void> {
    const chat = this.chat;
    if (!chat || chat.root !== this.data.project.root || chat.state !== 'open') return;
    const session = chat.session;
    const ws = this.d.workspace;
    const h = ws.ops.begin({ request: text, via: 'workbench', root: ws.root, project: ws.project.name });
    const turn: NonNullable<Data['turn']> = { text, answer: '', state: 'sending', lines: [], sent: null, tools: [], at: this.now(), operation: h.id };
    this.data.turn = turn;
    const abort = new AbortController();
    this.turnAbort = abort;
    this.emit();
    try {
      const r = await ws.ops.run(h, () => session.send(text, {
        onText: (full) => { turn.answer = full; this.emit(); },
        onTool: (e) => { turn.tools.push({ name: e.name, phase: e.phase, ...(e.outcome ? { outcome: e.outcome } : {}) }); this.emit(); },
        askPerson: (req) => this.askPerson(req),
        signal: abort.signal,
      }));
      Object.assign(turn, {
        state: r.status, answer: r.text || turn.answer, lines: r.lines ?? [], sent: r.sent, costWords: r.costWords,
        ...(r.receipt ? { receipt: r.receipt } : {}), ...(r.model ? { model: r.model } : {}),
      });
      this.say(r.status === 'answered' ? `Answered${r.receipt ? `: receipt ${r.receipt}` : ''} ${this.d.glyphs.sep} ${r.costWords}` : `${r.status === 'refused' ? 'Refused' : r.status === 'cancelled' ? 'Stopped' : 'Failed'}: ${(r.lines ?? [])[0] ?? r.status}${r.sent ? '' : ' Nothing was sent to any model.'}`,
        r.status === 'failed' ? 'failure' : r.status === 'answered' ? 'text' : 'secondary');
    } catch (e) {
      Object.assign(turn, { state: 'failed', lines: [`The chat session failed: ${e instanceof Error ? e.message : String(e)}`] });
      this.say(turn.lines[0], 'failure');
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
      try { this.data.chatRoute = session.route(); } catch { /* as before */ }
      this.data.chat = readChatTail(this.data.project.root);
      this.emit();
    }
  }

  private labelOf(id: WorkspaceId): string { return id === 'overview' ? 'God\'s Eye View' : id === 'create3d' ? '3D Create' : id === 'tools' ? 'All tools' : id === 'control' ? 'Control Room' : id === 'rea' ? 'REA' : id === 'voxvision' ? 'VoxVision' : id.charAt(0).toUpperCase() + id.slice(1); }

  // ── the overlays' own keys ────────────────────────────────────────────────────

  /** True when the overlay took the key. */
  private overlayKey(o: NonNullable<Overlay>, input: string, k: Partial<Key>): boolean {
    if (o.kind === 'settings') {
      const n = SETTING_LABELS.length + PRESETS.length;
      if (k.upArrow || k.downArrow) { this.ui.cursor.overlay = Math.max(0, Math.min(n - 1, (this.ui.cursor.overlay ?? 0) + (k.upArrow ? -1 : 1))); this.emit(); return true; }
      if (input === ' ' || k.return) { this.toggleSetting(cursorOf(this.ui, 'overlay', n)); return true; }
      return false;
    }
    if (o.kind === 'confirm-run') {
      if (k.return) { void this.runBlock(o); return true; }
      return false;
    }
    if (o.kind === 'help' || o.kind === 'message') return false;
    return false;
  }

  // ── NEEDS YOU, drawn here (src/repl/approvals.ts's box, its keys and its guard) ─

  /** The Workspace's askPerson: the box in the center until it is answered; deny is the default. */
  askPerson(req: ApprovalRequest): Promise<Decision> {
    // the operation the asking request runs in (its answer is part of it)
    const operation = currentOperation();
    return new Promise((resolve) => {
      let done = false;
      const answer = (d: Decision): void => {
        if (done) return;
        done = true;
        if (this.ui.overlay?.kind === 'needs-you' && this.ui.overlay.req === req) this.ui.overlay = null;
        resolve(d);
        this.say(d === 'deny' ? `NEEDS YOU: denied ${req.tool}` : d === 'once' ? `NEEDS YOU: allowed ${req.tool} once` : `NEEDS YOU: allowed ${req.tool} for this session`, d === 'deny' ? 'secondary' : 'text', operation ? { operation } : {});
        // the wait leaves the Control Room once the gate has its answer
        setTimeout(() => this.refreshDecisions(), 50).unref?.();
      };
      if (this.disposed) { answer('deny'); return; }
      this.ui.input = { field: null, text: '' };
      this.open({ kind: 'needs-you', req, since: this.now(), answer });
      this.refreshDecisions();
    });
  }

  private needsYouKey(o: Extract<NonNullable<Overlay>, { kind: 'needs-you' }>, input: string, k: Partial<Key>): void {
    // Ctrl+C denies; so does a paste, whatever it holds (a pasted y never approves)
    if ((k.ctrl && input === 'c') || (!k.ctrl && !k.meta && input.length > 1)) { o.answer('deny'); return; }
    if (this.now() - o.since < (this.d.guardMs ?? GUARD_MS)) return;
    if (input === 'y') o.answer('once');
    else if (input === 'a' && o.req.session !== false) o.answer('session');
    else if (input === 'n' || k.escape || k.return) o.answer('deny');
  }

  private refreshDecisions(): void {
    const root = this.data.project.root;
    this.data.decisions = readDecisions(root, this.records, this.chain(), this.data.caps.state === 'ready' ? { checkedAt: new Date(this.data.caps.at).toISOString(), rows: this.data.caps.value } : undefined, this.d.env);
    this.data.activity = activityOf(this.data.jobs, this.data.decisions.total, this.notices);
    this.emit();
  }

  // ── a workflow block, run here ────────────────────────────────────────────────

  /** The REPL's own /run of one block, as one operation (its prediction, its NEEDS YOU, its job and receipts are /run's). */
  private async runBlock(o: Extract<NonNullable<Overlay>, { kind: 'confirm-run' }>): Promise<void> {
    this.ui.overlay = null;
    const ws = this.d.workspace;
    const args = `${o.doc} ${o.block}`;
    const request = `/run ${args}`;
    if (this.starting.has(args)) { this.say(`${request} is already starting here: one press runs it once.`, 'secondary'); return; }
    this.starting.add(args);
    const h = ws.ops.begin({ request, via: 'workbench', root: ws.root, project: ws.project.name });
    this.say(`${request}: operation ${h.id}, through the REPL's own /run${o.risky.length ? '; its NEEDS YOU box asks first' : ''}…`, 'secondary', { operation: h.id });
    try {
      const lines = await ws.ops.run(h, () => ws.run(args));
      const job = h.runs.find((r) => r.kind === 'job')?.id;
      if (job) {
        this.mine.add(job);
        if (this.ui.settings.settings.followSelectedArtifact) { this.ui.follow = job; this.ui.tab = 'inspector'; this.ui.activityAll = false; }
      }
      this.readJobs();
      for (const l of lines) { const w = plain(l).trim(); if (w) this.say(w, roleOf(l.find((x) => x.role && x.role !== 'secondary')?.role ?? l[0]?.role), { operation: h.id }); }
    } catch (e) {
      this.say(`${request} could not start: ${e instanceof Error ? e.message : String(e)}`, 'failure');
    } finally {
      this.starting.delete(args);
      this.emit();
    }
  }

  private toggleSetting(i: number): void {
    const s: WorkbenchSettings = { ...this.ui.settings.settings, layouts: { ...this.ui.settings.settings.layouts } };
    if (i < SETTING_LABELS.length) { const k = SETTING_LABELS[i].key; s[k] = !s[k]; } else Object.assign(s, PRESETS[i - SETTING_LABELS.length].set);
    this.saveSettingsNow(s);
  }

  private saveSettingsNow(s: WorkbenchSettings): void {
    const r = (this.d.settings?.save ?? ((x: WorkbenchSettings) => saveSettings(x, this.d.env)))(s);
    if (r.ok) {
      this.ui.settings = { settings: s, path: r.path, state: 'saved' };
      this.ui.saved = `Saved locally at ${clock(r.at)}`;
    } else {
      this.ui.saved = `Not saved: ${r.error}`;
    }
    this.emit();
  }

  private rememberTimer: NodeJS.Timeout | null = null;

  /** Remember layout: the workspace, the right tab and Activity, per project (only when the setting is on), written at most
   *  every 1.5 s (a run of arrow keys is one write) and once more as the Workbench ends. */
  private remember(): void {
    if (!this.ui.settings.settings.rememberLayout || this.rememberTimer) return;
    this.rememberTimer = setTimeout(() => { this.rememberTimer = null; this.rememberNow(); }, 1500);
    this.rememberTimer.unref?.();
  }

  private rememberNow(): void {
    const s = this.ui.settings.settings;
    if (!s.rememberLayout) return;
    const id = this.data.project.id;
    const prev = s.layouts[id];
    const next = { workspace: this.ui.workspace, tab: this.ui.tab, activity: this.ui.activityOpen };
    if (prev && prev.workspace === next.workspace && prev.tab === next.tab && prev.activity === next.activity) return;
    const r = (this.d.settings?.save ?? ((x: WorkbenchSettings) => saveSettings(x, this.d.env)))({ ...s, layouts: { ...s.layouts, [id]: next } });
    if (r.ok) this.ui.settings = { settings: { ...s, layouts: { ...s.layouts, [id]: next } }, path: r.path, state: 'saved' };
  }

  // ── projects ──────────────────────────────────────────────────────────────────

  private openPicker(): void {
    this.data.projects = projectChoices(this.data.project, this.d.env);
    this.open({ kind: 'picker' });
    this.ui.input = { field: 'picker', text: '' };
    this.emit();
  }

  private openNew(from?: string): void {
    this.open({ kind: 'new', ...(from ? { from } : {}) });
    this.ui.input = { field: 'new', text: '' };
    this.emit();
  }

  /** The REPL's own /project (src/repl/workspace.ts project_): it writes the shared active-project record. */
  switchProject(arg: string, why: string): void {
    if (!arg) return;
    const before = this.d.workspace.project.root;
    const lines = this.d.workspace.project_(arg);
    const after = this.d.workspace.project;
    if (sameFolder(before, after.root) && !sameFolder(arg, after.root)) {
      this.say(lines.map((l) => plain(l).trim()).filter(Boolean).join(' ') || `Not switched: ${arg}`, 'failure');
      return;
    }
    this.use(after, why);
  }

  private makeProject(name: string, from?: string): void {
    if (!name) { this.say('No name was given; nothing was made.', 'secondary'); return; }
    const before = this.d.workspace.project.root;
    const lines = this.d.workspace.project_(`new ${name}${from ? ` --from ${from}` : ''}`);
    const after = this.d.workspace.project;
    if (sameFolder(before, after.root)) { this.say(lines.map((l) => plain(l).trim()).filter(Boolean)[0] ?? `${name} was not made.`, 'failure'); return; }
    this.use(after, from ? `made ${after.name} from ${from}: its files are yours to edit` : `made ${after.name}: a blank project`);
  }

  private use(p: { name: string; root: string; chosen: boolean }, why: string): void {
    this.data = { ...this.emptyData(projectView(p, this.d.env)), caps: this.data.caps, starters: this.data.starters, boards: this.data.boards };
    this.chainCache = null;
    this.ui.follow = null;
    if (this.ui.workspace === 'chat') void this.openChat();
    this.ui.cursor = {};
    this.ui.scroll = {};
    const remembered = this.ui.settings.settings.rememberLayout ? this.ui.settings.settings.layouts[this.data.project.id] : undefined;
    if (remembered) { this.ui.workspace = remembered.workspace; this.ui.tab = remembered.tab; this.ui.activityOpen = remembered.activity; }
    this.readAll();
    this.loadFor(this.ui.workspace);
    this.say(`Now in ${p.name} (${this.data.project.shown}): ${why}. The REPL, the monitor and Studio follow the same record; a running job keeps its own project.`);
  }

  // ── the servers ───────────────────────────────────────────────────────────────

  async showCompanion(why = ''): Promise<void> {
    this.say(`Companion · Show${why ? ` ${why}` : ''}: starting it on 127.0.0.1 if this Workbench has none…`, 'secondary');
    const w = await this.d.companion.show();
    this.say(w, /did not start|failed/.test(w) ? 'failure' : 'text');
  }

  async showStudio(why = ''): Promise<void> {
    this.say(`Studio · Show${why ? ` ${why}` : ''}: as the REPL's /canvas open…`, 'secondary');
    const w = await this.d.studio.show();
    this.say(w, /not running|does not answer/.test(w) ? 'failure' : 'text');
  }

  // ── Stop current ──────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    const sel = this.selected();
    const target = this.ui.workspace === 'control' && sel?.kind === 'job' && sel.job.live ? sel.job : stopWords(this.data).target;
    if (!target) { this.say(`Stop current: nothing runs in ${this.data.project.name}.`, 'secondary'); return; }
    this.say(`Stopping ${target.id} (${target.label})…`, 'secondary');
    const r = await stopCurrent(target, { stop: (id) => this.d.workspace.stop(id), jobs: this.d.workspace.jobs, ...(this.d.stopLeft ? { stopLeft: this.d.stopLeft } : {}) });
    this.readJobs();
    this.say(r.words, r.role);
  }

  // ── Enter ─────────────────────────────────────────────────────────────────────

  async enter(): Promise<void> {
    const region = this.ui.focus;
    if (region === 'nav') { this.ui.focus = 'center'; this.ui.navOpen = false; this.emit(); return; }
    if (region === 'top') {
      const b = topButtons(this)[cursorOf(this.ui, 'top', topButtons(this).length)];
      if (b) this.key(b.key, {});
      return;
    }
    if (region === 'right') {
      if (this.ui.tab === 'tools') {
        const acts = actionsOf(this.ctx(), this.selected());
        const a = acts[cursorOf(this.ui, 'right:tools', acts.length)];
        if (a?.enabled) { if (a.key === 'Enter') await this.activate(this.selected()); else this.key(a.key, {}); } else if (a) this.say(`${a.label}: ${a.why ?? 'not available'}`, 'secondary');
      }
      return;
    }
    if (region === 'center' && this.ui.workspace === 'chat' && !this.ui.overlay) { this.ui.input = { field: 'composer', text: '' }; this.emit(); return; }
    if (region === 'center') await this.activate(this.selected());
  }

  /** What Enter does to the selection: the action its words name. */
  private async activate(item: Item | null): Promise<void> {
    if (!item) return;
    switch (item.kind) {
      case 'block': {
        const acts = actionsOf(this.ctx(), item);
        const run = acts.find((a) => a.key === 'Enter');
        if (run?.enabled) this.open({ kind: 'confirm-run', doc: item.doc.rel, block: item.block.name, order: item.block.order, risky: item.block.risky });
        else if (run) this.say(`${run.label}: ${run.why ?? 'not available'}`, 'secondary');
        return;
      }
      case 'starter': this.openNew(item.name); return;
      case 'server': if (item.which === 'companion') await this.showCompanion(); else await this.showStudio(); return;
      case 'action':
        if (item.key.startsWith('nav:')) { this.selectWorkspace(item.action as WorkspaceId); this.ui.focus = 'center'; this.emit(); }
        return;
      default:
        // the Inspector shows it
        this.ui.tab = 'inspector';
        if (modeOf(this.size.columns) !== 'wide' || this.ui.focusMode) this.ui.rightOpen = true;
        this.emit();
    }
  }

  // ── the mouse ─────────────────────────────────────────────────────────────────

  mouse(m: MouseReport): void {
    const f = this.last;
    if (!f || !this.ui.mouse) return;
    const x = m.x - 1;
    const y = m.y - 1;
    // the wheel moves the list under the pointer
    if (m.button === 64 || m.button === 65) {
      const region = (Object.entries(f.regions) as Array<[Region, NonNullable<Frame['regions'][Region]>]>).find(([, d]) => x >= d.rect.x && x < d.rect.x + d.rect.w && y >= d.rect.y && y < d.rect.y + d.rect.h)?.[0];
      if (region) { this.ui.focus = region; this.move(m.button === 64 ? -1 : 1); }
      return;
    }
    if (!m.press || m.button !== 0) return;
    // a [key] hint presses its key, wherever it is drawn
    const hint = keyAt(f.screen.map((l) => l.map((s) => s.text).join('')), m.x, m.y);
    // a NEEDS YOU box is answered only by its keys (a click on [y] is y); a click elsewhere does nothing
    if (this.ui.overlay?.kind === 'needs-you') { if (hint && hint.length === 1) this.key(hint, {}); return; }
    if (hint) {
      if (hint === 'Enter') { void this.enter(); return; }
      if (hint === 'Esc') { this.escape(); return; }
      if (hint.length === 1) { this.key(hint, {}); return; }
    }
    for (const t of f.tabs) if (y === t.y && x >= t.x0 && x <= t.x1) { this.ui.tab = t.tab; this.ui.focus = 'right'; this.remember(); this.emit(); return; }
    for (const [region, d] of Object.entries(f.regions) as Array<[Region, NonNullable<Frame['regions'][Region]>]>) {
      if (!(x >= d.rect.x && x < d.rect.x + d.rect.w && y >= d.rect.y && y < d.rect.y + d.rect.h)) continue;
      this.ui.focus = region;
      const row = y - d.rect.y - 1 - d.fixed;
      if (x === d.rect.x || x === d.rect.x + d.rect.w - 1) { this.emit(); return; }
      if (row < 0) { this.emit(); return; }
      const line = row + d.scroll;
      const at = d.items.findIndex((it) => it.line === line);
      if (at < 0) { this.emit(); return; }
      const it = d.items[at].item;
      if (region === 'nav' && it.kind === 'action') { this.selectWorkspace(it.action as WorkspaceId); return; }
      const already = (this.ui.cursor[d.list] ?? 0) === at;
      this.ui.cursor[d.list] = at;
      if (region === 'center') this.ui.follow = null;
      this.emit();
      // a second click on the selected row does what Enter does
      if (already && region === 'center') void this.enter();
      return;
    }
  }

  // ── quitting ──────────────────────────────────────────────────────────────────

  async quit(): Promise<void> {
    const live = this.data.jobs.filter((j) => j.live);
    const own = live.filter((j) => j.owner === 'workbench');
    const others = live.filter((j) => j.owner !== 'workbench');
    if (own.length && this.ui.overlay?.kind !== 'quit') { this.open({ kind: 'quit', own, others }); return; }
    const after = others.map((j) => `${j.id} (${j.label}) keeps running: ${j.ownerWords}.`);
    if (own.length) after.push(...own.map((j) => `${j.id} (${j.label}) was stopped as the Workbench ended.`));
    this.dispose();
    try { await this.d.workspace.close({ by: 'as the Workbench ended' }); } catch { /* said below */ }
    try { await this.d.companion.stopServing(); } catch { /* ends with the process */ }
    try { await this.d.studio.stopServing(); } catch { /* ends with the process */ }
    this.d.onExit?.(130, after);
  }
}

/** The REPL's segment roles in the Workbench's. */
function roleOf(r: Segment['role'] | undefined): Role {
  switch (r) {
    case 'strong': return 'strong';
    case 'secondary': return 'secondary';
    case 'failure': case 'diffRemove': return 'failure';
    case 'estimate': return 'attention';
    case 'ai': return 'ai';
    case 'accent': return 'action';
    case 'rule': return 'border';
    default: return 'text';
  }
}

export const DEFAULTS = DEFAULT_SETTINGS;
