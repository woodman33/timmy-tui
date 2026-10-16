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
import { join } from 'node:path';
import type { Key } from 'ink';
import type { CapabilityRow } from '../capabilities/index.js';
import type { ChatSession, OpenChatSession } from '../contracts/chat-session.js';
import { TABS, tabByKey, tabOf, type TabId, type WorkspaceAction } from '../contracts/workspace.js';
import type { JobRecord } from '../jobs/index.js';
import { readActiveProject, sameFolder } from '../project/index.js';
import { listStarters } from '../project/starters.js';
import { currentOperation } from '../ops/context.js';
import { operationRel } from '../ops/operations.js';
import { buildWorkspaceFrame } from '../ops/workspace-frame.js';
import type { ApprovalRequest, Decision } from '../repl/approvals.js';
import type { Workspace } from '../repl/workspace.js';
import { timmyHome } from '../setup/home.js';
import { projectCards } from '../studio/project-cards.js';
import { publicTemplates } from '../studio/templates.js';
import type { Segment } from '../term/theme.js';
import { keyAt, type MouseReport } from '../tui/mouse.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { receiptsPath, verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import { isLiveRun } from '../workflows/upmd-live.js';
import { readControl } from './control-tab.js';
import { readFleet } from './fleet-tab.js';
import { innerWidth, type Glyphs } from './frame.js';
import { chatTurnNow, isHub, pageOf, receiptShort, routeOf, workspaceOfPage, workspacesOf } from './hub.js';
import { bodyKind, contextIsColumn } from './layout.js';
import { readLogs } from './logs-tab.js';
import type { Data, Item, Lazy, Overlay, Region, Ui } from './model.js';
import { REGIONS } from './model.js';
import { NAV_ORDER, type WorkspaceId } from './nav.js';
import { OutputWatch } from './output.js';
import { checkDetail, realProducers, type Loaded, type Producers, type RunDetailOf } from './producers.js';
import { remember as rememberList, resolve, select } from './select.js';
import type { CompanionControl, StudioControl } from './servers.js';
import { frameOf, type Frame } from './screen.js';
import { DEFAULT_SETTINGS, PRESETS, readSettings, RIGHT_TABS, saveSettings, SETTING_LABELS, type SaveResult, type SettingsRead, type WorkbenchSettings } from './settings.js';
import {
  activityOf, chainOf, jobRow, outputEvents, projectChoices, projectView, readChatTail, readDecisions, readFiles, readJobs, readNativeRows, readPipeline, readRoute, readTurns, readVoxRecords,
  readWorkflows, type ActivityEvent,
} from './state.js';
import { stopCurrent, type StopDeps } from './stop.js';
import { clock, type Line, type Role } from './text.js';
import { actionsOf, bottomView, centerView, cursorOf, pageActions, rightView, runOfBlock, selectedAction, selectedItem, stopWords, type ViewCtx } from './views.js';
import { readWorkflowsTab, refreshBlockStates, selectedBlock } from './workflows-tab.js';

/** R5 (H131): the workspace frame is read again at most this often (the order: "at most once a second"). */
export const FRAME_EVERY_MS = 1000;

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

/** R4 lead: the keys that start or stop something, taken only when pressed alone (never from keys that arrived together). */
const TAKEN_ALONE = new Set(['x', 'c', 's', 'C', 'S']);

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
  /** R4 (H112): the notices' own order, and the lines running jobs printed (as first seen) */
  private noticeSeq = 0;
  private readonly output = new OutputWatch();
  /** R4 (H112): each run detail's job record as it was when the detail was read (wantDetail reads it again once it changed).
   *  R5 (H131): and its operation's own record (see wantDetail) */
  private readonly detailSig = new Map<string, string>();
  /** R5 (H131): each run detail's reading: its number (only the newest one's result is kept) and the records it was for */
  private readonly detailRead = new Map<string, { n: number; sig: string; busy: boolean }>();
  /** R5 (H131): each drawn run detail's operation record as the tick last saw it (onTick draws again once per change) */
  private readonly detailOpSeen = new Map<string, string>();
  /** R5 (H131): the workspace frame's reading: one at a time, at most every FRAME_EVERY_MS, once more when asked meanwhile */
  private readonly frameRead: { running: boolean; again: boolean; at: number; timer: NodeJS.Timeout | null } = { running: false, again: false, at: 0, timer: null };
  /** R5 (H131): the receipts this Workbench verified (src/utils/receipts.ts verifyReceiptIn), by the chain as read and the hash */
  private verified: { key: string; hash: string; v: { ok: true } | { ok: false; reason: string } } | null = null;

  constructor(private readonly d: ControllerDeps) {
    const settings = (d.settings?.read ?? (() => readSettings(d.env)))();
    const project = projectView(d.workspace.project, d.env);
    const remembered = settings.settings.rememberLayout ? settings.settings.layouts[project.id] : undefined;
    // R5 (H131): the Workbench opens on Home (the operator's opening hub, references 01 and 13), or where this project was left;
    // the workflow actions have the keyboard first, their one primary next step selected (Tab: the body)
    const workspace = remembered?.workspace ?? 'connections';
    this.ui = {
      page: pageOf(workspace), workspace, focus: 'top', tab: remembered?.tab ?? 'inspector',
      navOpen: false, rightOpen: false, activityOpen: remembered?.activity ?? false, activityAll: false, overlay: null,
      input: { field: null, text: '' }, cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, activityFollow: true, toolsQuery: '',
      flash: null, mouse: false, related: false, settings, saved: null,
      companion: d.companion.state(), studio: d.studio.state(), mine: [], starting: [],
    };
    this.data = this.emptyData(project);
    this.readAll();
    this.refreshFrame();
  }

  private now(): number { return this.d.now?.() ?? Date.now(); }

  private emptyData(project: ReturnType<typeof projectView>): Data {
    return {
      project, projects: [], files: { total: 0, truncated: false, groups: [] }, workflows: { upmd: false, docs: [] }, jobs: [], away: [],
      decisions: { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [] }, route: readRoute(this.d.env),
      activity: { running: 0, waiting: 0, last: null, events: [] }, chat: { session: null, total: 0, messages: [] }, vox: [], native: {},
      starters: [], boards: [], studio: { state: 'idle' }, overview: { state: 'idle' }, caps: { state: 'idle' }, details: {}, readAt: 0,
    };
  }

  /** Activity from the jobs (the shown project's and, R4 H112, this Workbench's runs in another), the notices and the lines
   *  jobs printed. */
  private activity(): Data['activity'] {
    const shown = this.data.project.root;
    const where = (job: string): string => {
      const j = this.records.find((r) => r.id === job);
      return j && !sameFolder(j.root, shown) ? ` (in ${j.project})` : '';
    };
    // the lines of the jobs Activity shows: the shown project's, and this Workbench's own elsewhere (never another project's)
    const shownJobs = new Set([...this.data.jobs, ...this.data.away].map((j) => j.id));
    const output = outputEvents(this.output.all().filter((l) => shownJobs.has(l.job)), { where, bar: this.d.glyphs.unicode ? '│' : '|' });
    return activityOf(this.data.jobs, this.data.decisions.total, this.notices, { away: this.data.away, shown, output });
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
    // R4 (H112): each notice has a name of its own (Activity's selection stays on it) and its place among notices of its time
    const n = ++this.noticeSeq;
    this.notices.unshift({ at, words: text, key: `note:${n}`, seq: n, ...(job ? { job: job.id } : {}), ...(operation ? { operation } : {}), ...(role === 'failure' ? { failed: true } : {}), ...(role === 'attention' ? { attention: true } : {}) });
    this.notices.splice(60);
    this.data.activity = this.activity();
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
    // R4 (H112): a run this Workbench started keeps its own project when the view switches: still named, with where
    this.data.away = this.records.filter((j) => this.mine.has(j.id) && !sameFolder(j.root, root)).slice(0, 12).map((j) => jobRow(j, { mine: this.mine }));
    this.readOutput();
    this.data.activity = this.activity();
  }

  /** R4 (H112): what each running job printed since the last look (its log; src/workbench/output.ts), kept as first seen; a
   *  job seen running is read once more after it ends, so its last lines are not lost. */
  private readOutput(): void {
    const at = new Date(this.now()).toISOString();
    const shown = new Set([...this.data.jobs, ...this.data.away].map((j) => j.id));
    for (const rec of this.records) {
      if (!shown.has(rec.id)) continue;
      const live = (rec.state === 'queued' || rec.state === 'running' || rec.state === 'ready') && !rec.stale;
      if (!live && !this.output.watching(rec.id)) continue;
      this.output.read({
        id: rec.id, ...(rec.operation ? { operation: rec.operation } : {}), logPath: rec.logPath, live,
        drawn: rec.kind === 'workflow' && isLiveRun(rec.args),
      }, at, (t) => scrubHomes(t.split(rec.root).join('.'), this.d.env));
    }
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
    // R4 (H117): the project's chat turns, every surface's, from their sealed receipts in the same chain (the Control Room's)
    this.data.turns = readTurns(chain, root);
    this.data.activity = this.activity();
    // R4 lead: the one route (chatRouteNow), read as the chat session reads it (this process's folder), and the open session's
    // own route read again with it, so the top line, Chat and Settings follow a /setup made elsewhere
    this.data.route = readRoute(this.d.env);
    if (this.chat?.state === 'open' && this.chat.root === root) { try { this.data.chatRoute = this.chat.session.route(); } catch { /* as it was */ } }
    this.data.chat = readChatTail(root);
    this.data.vox = readVoxRecords(root);
    this.data.native = { create3d: readNativeRows(root, 'create3d'), motion: readNativeRows(root, 'motion') };
    this.data.projects = projectChoices(this.data.project, this.d.env);
    if (!this.data.starters.length) { try { this.data.starters = listStarters(); } catch { this.data.starters = []; } }
    if (!this.data.boards.length) { try { this.data.boards = publicTemplates(); } catch { this.data.boards = []; } }
    this.readPipeline(chain);
    this.readTab();
    this.data.readAt = this.now();
  }

  /**
   * R5 (H134): tab 0's and tab 8's readings (src/workbench/logs-tab.ts readLogs, src/workbench/fleet-tab.ts readFleet), only
   * while the tab is shown: the receipt chain verified once per reading, each receipt on screen checked once per reading.
   * Files only: no network, no VM, no paid call. A reading that fails says why in Activity (once until it changes).
   */
  private tabError = '';
  private readTab(ws: WorkspaceId = this.ui.workspace): void {
    if (ws !== 'logs' && ws !== 'fleet' && ws !== 'control') return;
    const root = this.data.project.root;
    try {
      if (ws === 'logs') this.data.logs = readLogs({ home: timmyHome(this.d.env), root, env: this.d.env, records: this.records, now: this.now() });
      // R5 (H137): tab 7's reading: the lanes on PATH, Connect's devices, the turns being answered, each pane's log and receipt
      else if (ws === 'control') this.data.control = readControl({ home: timmyHome(this.d.env), root, env: this.d.env, records: this.records, jobs: this.data.jobs, away: this.data.away, chain: this.chain(), now: this.now() });
      else this.data.fleet = readFleet({ home: timmyHome(this.d.env), root, env: this.d.env, now: this.now() });
      this.tabError = '';
    } catch (e) {
      const why = `${ws === 'logs' ? 'Logs & Receipts' : ws === 'control' ? 'Control Room' : 'Fleet & Clef'} could not be read: ${e instanceof Error ? e.message : String(e)}`;
      if (why !== this.tabError) { this.tabError = why; this.say(why, 'failure'); }
    }
  }

  /**
   * R5 (H136): tab 3's reading, for each frame while it is shown (src/workbench/workflows-tab.ts): each block's state read
   * again from the newest job records (the review of 2026-10-15 saw a row say waiting more than 2 s after its job had ended:
   * the documents are read every few seconds, the jobs every second), and the selected block's newest run: its record, its
   * log's last lines (the job store's own tail) and its receipt, verified once per chain reading and hash. Files only.
   */
  private wfError = '';
  private wfVerified: { key: string; by: Map<string, { ok: true } | { ok: false; reason: string }> } = { key: '', by: new Map() };
  private readWorkflowsTab(): void {
    const root = this.data.project.root;
    const own = this.records.filter((j) => sameFolder(j.root, root));
    try {
      const chain = this.chain();
      const key = this.chainCache?.key ?? '';
      if (this.wfVerified.key !== key) this.wfVerified = { key, by: new Map() };
      const seen = this.wfVerified.by;
      this.data.workflows = refreshBlockStates(this.data.workflows, own, chain);
      const sel = selectedBlock({ ui: this.ui, data: this.data });
      this.data.workflowsTab = readWorkflowsTab({
        records: own, chain, selected: sel ? { doc: sel.doc, block: sel.block.name } : null, now: this.now(),
        tail: (j, n) => this.d.workspace.jobs.tail(j.id, n),
        verify: (hash) => {
          let v = seen.get(hash);
          if (!v) { const r = verifyReceiptIn(chain, hash); v = r.ok ? { ok: true } : { ok: false, reason: r.reason }; seen.set(hash, v); }
          return v;
        },
        scrub: (t) => scrubHomes(t.split(root).join('.'), this.d.env),
      });
      this.wfError = '';
    } catch (e) {
      const why = `Workflows could not be read: ${e instanceof Error ? e.message : String(e)}`;
      if (why !== this.wfError) { this.wfError = why; this.say(why, 'failure'); }
    }
  }

  /** R5 (H131): the newest run's pipeline (the Chat tab's row), its receipt verified here once per chain as read. */
  private readPipeline(chain: Receipt[] = this.chain()): void {
    const key = this.chainCache?.key ?? '';
    try {
      // R5 (H131; the QA round's defect 8): a chat turn too, sealed or being answered here
      const turn = this.data.turn;
      this.data.pipeline = readPipeline(this.data.project.root, this.data.jobs, chain, (hash) => {
        if (this.verified?.key === key && this.verified.hash === hash) return this.verified.v;
        const r = verifyReceiptIn(chain, hash);
        const v = r.ok ? { ok: true as const } : { ok: false as const, reason: r.reason };
        this.verified = { key, hash, v };
        return v;
      }, { turns: this.data.turns ?? [], sending: turn?.state === 'sending' && turn.operation ? { operation: turn.operation, request: turn.text } : null });
    } catch (e) {
      const why = `its records could not be read: ${e instanceof Error ? e.message : String(e)}`;
      const unknown = { state: 'unknown' as const, words: why };
      this.data.pipeline = { operation: null, label: null, intent: unknown, predict: unknown, sandbox: unknown, receipt: unknown };
    }
  }

  /**
   * R5 (H131): the workspace frame (src/ops/workspace-frame.ts buildWorkspaceFrame), the one the companion and Studio draw too:
   * read from the records this Workbench already read (its jobs and its chain, passed in), at most every FRAME_EVERY_MS, one
   * reading at a time (a call while one runs asks for one more after it). A frame of the same revision draws nothing again.
   */
  refreshFrame(): void {
    if (this.disposed) return;
    const r = this.frameRead;
    if (r.running) { r.again = true; return; }
    const wait = r.at + FRAME_EVERY_MS - Date.now();
    if (r.at && wait > 0) {
      if (!r.timer) { r.timer = setTimeout(() => { r.timer = null; this.refreshFrame(); }, wait); r.timer.unref?.(); }
      return;
    }
    r.running = true;
    r.at = Date.now();
    const root = this.data.project.root;
    // R5 lead: the frame of the project this Workbench shows, named to it (pinned to its own while another surface chose
    // another, its actions are still its project's)
    void buildWorkspaceFrame({ env: this.d.env, cwd: root, project: { name: this.data.project.name, root }, jobsDir: this.d.jobsDir, onPath: this.d.onPath, jobs: () => this.records, chain: () => this.chain(), now: this.now() })
      .then((f) => {
        if (this.disposed || !sameFolder(root, this.data.project.root)) return;
        const before = this.data.frame?.revision;
        this.data.frame = f;
        const hadError = this.data.frameError !== undefined;
        this.data.frameError = undefined;
        if (before !== f.revision || hadError) this.emit();
      })
      .catch((e: unknown) => {
        if (this.disposed) return;
        this.data.frameError = e instanceof Error ? e.message : String(e);
        this.emit();
      })
      .finally(() => {
        r.running = false;
        if (r.again && !this.disposed) { r.again = false; this.refreshFrame(); }
      });
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
    // R5 (H131): Home's preview says Studio's board too
    if (ws === 'studio' || ws === 'connections') {
      void this.lazy('studio', async () => {
        const p = this.data.project;
        const r = projectCards({ root: p.root, name: p.name, jobs: this.d.jobsDir, receipts: null }, { chain: this.chain(), jobs: this.records.filter((j) => sameFolder(j.root, p.root)) });
        return { cards: r.cards, notes: r.notes, operations: r.operations ?? [] };
      }, force);
    }
    if (['voxvision', 'create3d', 'motion', 'rea', 'tools'].includes(ws)) void this.lazy('caps', () => this.d.capabilities(), force);
    // R5 (H134): tab 0 and tab 8 read when opened (then with the slow reading while they are shown)
    if (ws === 'logs' || ws === 'fleet' || ws === 'control') this.readTab(ws);
  }

  // ── timers ────────────────────────────────────────────────────────────────────

  start(): void {
    void this.loadProducers();
    const tick = this.d.tickMs ?? 1000;
    const slow = this.d.slowMs ?? 5000;
    this.timers.push(setInterval(() => this.onTick(), tick));
    // R5 (H131): the workspace frame with the slow reading too (at most once a second; the same revision draws nothing again)
    this.timers.push(setInterval(() => { this.readAll(); this.refreshFrame(); this.emit(); }, slow));
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
    // R5 (H137): the Control Room's panes follow their logs and the turns being answered at the tick, while it is shown
    if (this.ui.workspace === 'control') this.readTab('control');
    // Activity's words change with the time, and a spinner turns while something runs. R4 (H112): with the mouse given back
    // to the terminal (m), so that a person can select text, the screen is drawn again only when something new happened (a
    // job's state, a block, a line, a notice), never for the spinner or a running time alone: a selection holds between events
    const sig = JSON.stringify([this.data.jobs.map((j) => [j.id, j.state, j.steps.length, j.word]), this.data.away.map((j) => [j.id, j.state, j.steps.length]), this.data.activity.last?.words, this.ui.flash?.at]);
    const ticking = this.data.activity.running > 0 && this.ui.mouse;
    // R5 (H131): the operation record of a run detail drawn changed (a later session's recovery ends it after the job's
    // record): the next frame reads it again (wantDetail), whether or not a job changed
    // (once for each change: a detail no longer shown is not drawn again every second)
    const root = this.data.project.root;
    let opChanged = false;
    for (const [op, was] of this.detailSig) {
      if (this.data.details[op]?.state !== 'ready') continue;
      const now = this.operationSig(root, op);
      if (this.detailOpSeen.get(op) === now) continue;
      this.detailOpSeen.set(op, now);
      if (!was.endsWith(` ${now}`)) opChanged = true;
    }
    if (opChanged) this.emit();
    if (sig !== this.signature) {
      // R5 (H131): a job started, moved or ended: the workspace frame (its log, its counts, its actions) and the newest run's
      // pipeline are read again (the frame at most once a second)
      this.readPipeline();
      this.refreshFrame();
    }
    if (sig !== this.signature || ticking || (this.ui.flash && this.now() - this.ui.flash.at < 7000)) { this.signature = sig; this.emit(); }
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
    if (this.frameRead.timer) { clearTimeout(this.frameRead.timer); this.frameRead.timer = null; }
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

  /**
   * The run detail of an operation the Inspector shows: read once, and again while its run goes on. R4 (H112): and again once
   * its job's record changed since (`sig`: a run that ended, one a later session's recovery ended), and after [r] (found in
   * tmux: a detail read while a run was stale still said "left running" after /recover had ended it).
   *
   * R5 (H131; the recovery PTY test's flake, reproduced here under load): a later session's recovery ends the job's record
   * first and the operation's record after it. A reading between the two said "left running" (the operation's record still
   * open, its writer gone), and it stayed drawn beside the job's "ended by recovery": the job's record did not change again,
   * and [r] read the detail again while the old one stayed on screen until the new one came, so a screen read meanwhile said
   * what the records no longer said. Now (1) the operation's own record is part of what a detail is read for, so its change
   * reads the detail again; (2) once what it was read for has changed (or after [r]), the old detail is not drawn as if it
   * were so: "reading…" until the new one comes, from the very frame that sees the change (true: frame() composes that frame
   * again); (3) one reading at a time for the same records, and only the newest reading's result is kept (an older one that
   * ends later is dropped). A live run read again with the same records keeps its detail on screen meanwhile (nothing has
   * contradicted it).
   */
  private wantDetail(op: string, live: boolean, sig = ''): boolean {
    if (!this.detailOf?.ok) return false;
    const root = this.data.project.root;
    const full = `${sig} ${this.operationSig(root, op)}`;
    const cur = this.data.details[op];
    const read = this.detailRead.get(op);
    const changed = this.detailSig.get(op) !== full;
    // a reading of these very records is on its way
    if (read?.busy && read.sig === full) return false;
    if (!changed && cur && (cur.state === 'ready' || cur.state === 'failed') && (!live || this.now() - cur.at < 1000)) return false;
    this.detailSig.set(op, full);
    const n = (read?.n ?? 0) + 1;
    this.detailRead.set(op, { n, sig: full, busy: true });
    // what is drawn changes: the frame being drawn is composed again (frame())
    let drawn = false;
    if (changed || cur?.state !== 'ready') {
      drawn = cur?.state !== 'loading';
      this.data.details[op] = { state: 'loading', since: this.now() };
    }
    const of = this.detailOf.value;
    void (async () => {
      let next: Data['details'][string];
      try {
        const got = checkDetail(await of(op, { root }), op);
        next = got.ok ? { state: 'ready', value: got.detail, at: this.now() } : { state: 'failed', why: got.why, at: this.now() };
      } catch (e) {
        next = { state: 'failed', why: `the producer failed: ${e instanceof Error ? e.message : String(e)}`, at: this.now() };
      }
      // a newer reading was asked for meanwhile (its records changed, or [r]): this one's result is dropped
      const now = this.detailRead.get(op);
      if (this.disposed || now?.n !== n) return;
      now.busy = false;
      this.data.details[op] = next;
      this.emit();
    })();
    return drawn;
  }

  /** R5 (H131): an operation's own record as it is on disk now (its size and time), for wantDetail; '' when it has none. */
  private operationSig(root: string, op: string): string {
    try { const st = statSync(join(root, operationRel(op))); return `${st.size}:${st.mtimeMs}`; } catch { return ''; }
  }

  frame(columns: number, rows: number): Frame {
    this.size = { columns, rows };
    // a drawer belongs to a size: Context is no drawer where it is a column beside the workspace (R5, H131: the navigation is
    // a drawer at every size)
    if (this.contextColumn()) this.ui.rightOpen = false;
    this.ui.companion = this.d.companion.state();
    this.ui.studio = this.d.studio.state();
    this.ui.mine = [...this.mine];
    this.ui.starting = [...this.starting];
    this.ui.navShown = this.ui.navOpen;
    // R4 (H112): each list's selection is found again by its item, wherever the records moved it, before anything is drawn
    this.reselect();
    // R5 (H136): tab 3 reads its blocks' states and its selected block's newest run from the newest records, for each frame
    const wf = !isHub(this.ui.page) && this.ui.workspace === 'workflows' && !this.ui.overlay;
    if (wf) this.readWorkflowsTab();
    const compose = (): Frame => frameOf({ ui: this.ui, data: this.data, g: this.d.glyphs, columns, rows, now: this.now(), can: this.can() });
    let f = compose();
    // R5 (H136): tab 3's .predict card, its checks and its verdict are the run detail of the selected block's newest run, read
    // as the Inspector reads a job's (and this very frame composed again when what it was read for changed)
    const run = wf ? this.data.workflowsTab?.run : undefined;
    if (run?.operation && this.wantDetail(run.operation, run.live, `${run.state} ${run.endedAt ?? ''} ${run.stale}`)) f = compose();
    // the Inspector, when it shows a job of an operation, draws that operation's run detail; R4 (H117): a chat turn's too (a
    // sealed turn has ended: its receipt is what the detail is read again for). R5 (H131): when what a detail was read for has
    // changed (or after [r]), this very frame is composed again with it said as being read: a frame never shows a detail beside
    // the records that contradict it (the recovery PTY test caught the frame that drew [r]'s notice with the verdict before it)
    // R5 (H137): and the Control Room's own right column, which draws the selected run's detail whether or not Context does
    if ((f.regions.right && (f.layout.rightAs === 'column' || f.layout.rightAs === 'drawer') && this.ui.tab === 'inspector') || (this.ui.workspace === 'control' && !this.ui.overlay)) {
      const sel = selectedItem({ ui: this.ui, data: this.data, g: this.d.glyphs, width: 40, height: 10, now: this.now(), can: this.can() });
      let again = false;
      if (sel?.kind === 'job' && sel.job.operation) again = this.wantDetail(sel.job.operation, sel.job.live, `${sel.job.state} ${sel.job.endedAt ?? ''} ${sel.job.stale}`);
      if (sel?.kind === 'turn' && sel.turn.operation) again = this.wantDetail(sel.turn.operation, false, sel.turn.receipt) || again;
      if (again) f = compose();
    }
    // and the next frame keeps each list's selected item, and its anchor on the same row
    for (const d of Object.values(f.regions)) {
      if (!d || d.list === 'top') continue;
      if (d.list === 'nav') {
        const active = d.items.findIndex((it) => it.item.kind === 'action' && it.item.action === this.ui.workspace);
        if (active >= 0) this.ui.cursor.nav = active;
      }
      rememberList(this.ui, d.list, d.items, d.scroll);
    }
    if (this.ui.focus === 'nav' && !f.regions.nav) this.ui.focus = 'center';
    if (this.ui.focus === 'right' && !f.regions.right) this.ui.focus = 'center';
    if (this.ui.focus === 'center' && !f.regions.center) this.ui.focus = f.regions.right ? 'right' : 'top';
    this.last = f;
    return f;
  }

  /** R5 (H131): Context (Tools, Inspector, Files) is a column beside the workspace at this size (else a drawer, [i]). */
  private contextColumn(): boolean {
    return contextIsColumn(this.size.columns, bodyKind(isHub(this.ui.page), this.ui.workspace), this.ui.focusMode === true);
  }

  /** R5 (H131): the right column is Home's preview or Chat's event log now (not Context). */
  private hubColumn(): boolean {
    return this.last?.layout.rightAs === 'hub';
  }

  /**
   * R4 (H112): each list's cursor set to its selected item's place now (src/workbench/select.ts): the center's first (the
   * Inspector and Activity read its selection), then the right dock's tab and Activity (which follows its newest while
   * Ui.activityFollow holds). Called before a frame is drawn and before a key or a click acts, so what the person acts on is
   * the item they see selected, never the item that moved into its place.
   */
  reselect(): void {
    if (this.ui.overlay) return;
    const c = this.ctx();
    // R5 (H131; the QA round's defect 8): the conversation's newest message is the selection until the person selects one
    resolve(this.ui, `center:${this.ui.workspace}`, centerView(c).items, this.ui.workspace === 'chat' && !this.ui.chosen?.['center:chat'] ? { follow: true } : {});
    const right = rightView(c).items;
    resolve(this.ui, `right:${this.ui.tab}`, right);
    resolve(this.ui, 'bottom', bottomView(c).items, { follow: this.ui.activityFollow });
  }

  private ctx(): ViewCtx {
    const r = this.last?.regions.center?.rect;
    return { ui: this.ui, data: this.data, g: this.d.glyphs, width: Math.max(10, innerWidth(r?.w ?? this.size.columns)), height: Math.max(3, (r?.h ?? this.size.rows) - 2), now: this.now(), can: this.can(), columns: this.size.columns };
  }

  selected(): Item | null { return selectedItem(this.ctx()); }

  // ── keys ──────────────────────────────────────────────────────────────────────

  key(input: string, k: Partial<Key>): void {
    const o = this.ui.overlay;
    // a NEEDS YOU box takes every key until it is answered; Ctrl+C denies it (a second Ctrl+C then quits)
    if (o?.kind === 'needs-you') { this.needsYouKey(o, input, k); return; }
    if (k.ctrl && input === 'c') { void this.quit(); return; }
    if (o?.kind === 'quit') { if (k.escape) { this.ui.overlay = null; this.emit(); } return; }
    // R4 (H112; found in tmux under load): keys that arrive together reach Ink as one chunk, and Ink takes a chunk with a
    // carriage return in it for text: "Workflows\r" lost its Enter, and two quick Enters ("\r\r") did nothing at all. A
    // chunk of text followed by Enters is that text, then each Enter (one press each: a second Run is refused by its own
    // guard). In the composer the Enter is not taken: what leaves this computer is sent only by an Enter of its own.
    const chunk = !k.ctrl && !k.meta && input.length > 1 ? /^([^\x00-\x1f\x7f]*)(\r+)$/.exec(input) : null;
    if (chunk && this.ui.input.field !== 'composer' && (chunk[1] === '' || this.ui.input.field || chunk[1].startsWith('/'))) {
      if (chunk[1]) this.key(chunk[1], {});
      for (let i = 0; i < chunk[2].length; i++) this.key('\r', { return: true });
      return;
    }
    if (this.ui.input.field) { this.typing(input, k); return; }
    // R4 lead (2026-10-12; found by the integrated suite under load, tests/workbench-interaction-pty.test.ts): keys typed one
    // after another that reach Ink together (the Workbench busy drawing, the computer loaded) come as one chunk, which no key
    // matched, so all of them were lost: "a" then "/" did nothing, "a" then Tab did nothing. Outside a field, with no box
    // open, such a chunk is its keys, each in turn (a Tab among them too): each acts as it would alone, so a "/" opens the
    // finder and the letters after it are typed into it. Pasted text never comes this way: the terminal marks a paste
    // (src/workbench/app.tsx usePaste) and paste() takes it, never as keys.
    if (!o && !k.ctrl && !k.meta && input.length > 1 && /^[\x20-\x7e\t]+$/.test(input)) {
      for (const ch of input) {
        // a key that starts or stops something (x Stop, c and s Show, C and S Stop serving) is taken only alone: a chunk is
        // taken up to it, and the Workbench says so (a terminal that does not mark pastes could deliver one this way)
        if (!this.ui.input.field && TAKEN_ALONE.has(ch)) {
          this.say(`Keys that arrived together were taken up to ${ch}: ${ch === 'x' ? 'x stops the current job' : 'c, s, C and S start or stop a server'}, so it is taken only when pressed alone. Press it again.`, 'attention');
          return;
        }
        this.key(ch === '\t' ? '' : ch, ch === '\t' ? { tab: true } : {});
      }
      return;
    }
    // R4 (H112): what the key acts on is the item the person sees selected, wherever the records have moved it since
    this.reselect();
    if (o && this.overlayKey(o, input, k)) return;
    if (k.escape) { this.escape(); return; }
    if (k.tab) { this.cycleFocus(k.shift ? -1 : 1); return; }
    if (k.upArrow || (!k.ctrl && input === 'k')) { this.move(-1); return; }
    if (k.downArrow || (!k.ctrl && input === 'j')) { this.move(1); return; }
    if (k.pageUp) { this.move(-this.page()); return; }
    if (k.pageDown) { this.move(this.page()); return; }
    // Home and End: the first or last tab of the right dock (as the reference's tabs), else the first or last row (End on
    // Activity follows its newest again)
    if (k.home || k.end) {
      if (this.ui.focus === 'right') { this.ui.tab = RIGHT_TABS[k.home ? 0 : RIGHT_TABS.length - 1]; this.remember(); this.emit(); } else this.move(k.home ? -1e6 : 1e6);
      return;
    }
    if (k.leftArrow) { this.side(-1); return; }
    if (k.rightArrow) { this.side(1); return; }
    if (k.return) { void this.enter(); return; }
    // R4 lead: keys typed quickly can arrive as one chunk ("/Control" over a busy terminal or SSH): a chunk that starts with
    // the search key opens the search with the rest as its text. Any other chunk of several characters is not taken as
    // keys (a paste never presses x, Stop, or any other key here).
    if (input.length > 1 && input.startsWith('/') && !k.ctrl && !k.meta) { this.search(); this.typing(input.slice(1), {}); return; }
    // R5 (H131): 1 to 9, then 0: the ten tabs (no field has the keyboard here: a field took the key above)
    if (!k.ctrl && !k.meta && /^[0-9]$/.test(input)) {
      const t = tabByKey(input);
      if (t) { this.selectPage(t.id); return; }
    }
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
    // a box is drawn in the body's left column: the drawers close (R5, H131: the navigation is a drawer at every size)
    this.ui.rightOpen = false;
    this.ui.navOpen = false;
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
    if (region === 'right') return this.hubColumn() ? `right:hub-${this.ui.page}` : `right:${this.ui.tab}`;
    return region;
  }

  private itemsOf(region: Region): number {
    if (region === 'nav') return NAV_ORDER.length;
    if (region === 'top') return pageActions(this.ctx()).acts.length;
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
    // R5 (H131): the workflow actions: from the one selected (the primary next step until the person moves)
    if (region === 'top') {
      const { acts, at } = selectedAction(this.ctx());
      if (!acts.length) return;
      this.ui.cursor.top = Math.max(0, Math.min(acts.length - 1, at + delta));
      this.emit();
      return;
    }
    // R5 (H131): Home's preview and Chat's event log have no rows to select: the arrows scroll them
    if (region === 'right' && this.hubColumn()) {
      const d = this.last?.regions.right;
      if (d) this.wheel('right', d, delta);
      return;
    }
    const list = this.listOf(region);
    // R4 (H112): the selection is the item moved to (by its key, src/workbench/select.ts); the wheel's view is let go
    const items = this.itemsNow(region);
    const n = items?.length ?? this.itemsOf(region);
    if (!n) return;
    const at = Math.max(0, Math.min(n - 1, (this.ui.cursor[list] ?? 0) + delta));
    if (items) select(this.ui, list, items, at); else { this.ui.cursor[list] = at; delete this.ui.wheel[list]; }
    // Activity follows its newest while the newest is selected, and is held where the person moved otherwise
    if (region === 'bottom') this.ui.activityFollow = at === n - 1;
    this.emit();
  }

  /** R4 (H112): a region's selectable items as they are now (the center's, the right tab's, Activity's). */
  private itemsNow(region: Region): ReadonlyArray<{ line: number; item: Item }> | null {
    const c = this.ctx();
    if (region === 'center') return centerView(c).items;
    if (region === 'right') return this.hubColumn() ? [] : rightView(c).items;
    if (region === 'bottom') return bottomView(c).items;
    return null;
  }

  private side(dir: 1 | -1): void {
    // R5 (H131): Home's preview and Chat's event log have no tabs
    if (this.ui.focus === 'right' && this.hubColumn()) return;
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
    // R5 (H131): the tab that shows it is the active one (its actions in row 2)
    const page = pageOf(ws);
    if (this.ui.page !== page) { this.ui.page = page; delete this.ui.cursor.top; }
    (this.ui.pageWs ??= {})[page] = ws;
    if (this.ui.workspace !== ws) {
      this.ui.workspace = ws;
      this.ui.overlay = null;
      // R4 (H112): a list opened again starts on its first row (its newest), unless the person chose a row in it (that row
      // stays chosen, wherever new rows put it); while the person looks at a list, its selection stays on its item either way
      const list = `center:${ws}`;
      if (!this.ui.chosen?.[list]) { delete this.ui.sel[list]; delete this.ui.anchor[list]; delete this.ui.wheel[list]; this.ui.cursor[list] = 0; this.ui.scroll[list] = 0; }
      this.remember();
    }
    // the navigation shows the workspace chosen, wherever the wheel had scrolled it
    delete this.ui.wheel.nav;
    this.loadFor(ws);
    if (ws === 'chat') void this.openChat();
    this.emit();
  }

  /**
   * R5 (H131): a tab by its key (1 to 9, then 0) or a click: the workspace it showed last (else the one it opens); the same
   * tab again shows its next workspace, where it gathers several (6: 3D Create, Motion; 9: All tools, REA, Templates).
   * Nothing runs by a tab: a box open in the body closes (a NEEDS YOU box and Quit take every key before this).
   */
  selectPage(page: TabId): void {
    const list = workspacesOf(page);
    let ws: WorkspaceId;
    if (this.ui.page === page && !this.ui.overlay) {
      const at = list.indexOf(this.ui.workspace);
      ws = list[(at + 1) % list.length] ?? workspaceOfPage(page);
    } else ws = this.ui.pageWs?.[page] ?? workspaceOfPage(page);
    this.ui.overlay = null;
    this.ui.navOpen = false;
    if (this.ui.input.field === 'search') this.ui.input = { field: null, text: '' };
    if (this.ui.focus === 'nav') this.ui.focus = 'center';
    this.selectWorkspace(ws);
  }

  private search(): void {
    // in All tools, from its list, / searches the tools (R4, H112: from the words the search kept). R5 (H131): only from the
    // list: from the actions bar (where the Workbench starts), Context or Activity, / finds a workspace as on every tab
    if (this.ui.workspace === 'tools' && this.ui.focus === 'center') { this.ui.input = { field: 'tools', text: this.ui.toolsQuery }; this.toolsTop(); this.loadFor('tools'); this.emit(); return; }
    // R5 (H131): the navigation is a drawer at every size: / opens it with its search
    this.ui.navOpen = true;
    this.ui.rightOpen = false;
    this.ui.focus = 'nav';
    this.ui.input = { field: 'search', text: '' };
    this.emit();
  }

  private toggleRight(): void {
    // R5 (H131): where Context is a column beside the workspace, i gives it the keyboard on its Inspector; elsewhere it is a
    // drawer (over Home's preview and Chat's log too)
    if (this.contextColumn()) { this.ui.tab = 'inspector'; this.ui.focus = 'right'; this.emit(); return; }
    this.ui.rightOpen = !this.ui.rightOpen;
    if (this.ui.rightOpen) { this.ui.navOpen = false; this.ui.focus = 'right'; } else this.ui.focus = 'center';
    this.emit();
  }

  private toggleNav(): void {
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
    // R4 (H112): each run detail is read again too, when next shown. R5 (H131): meanwhile it says "reading…", not what the
    // reading before said (wantDetail)
    this.detailSig.clear();
    this.readAll();
    // R5 (H131): and the workspace frame (at most once a second)
    this.refreshFrame();
    this.loadFor(this.ui.workspace, true);
    this.say(`Read ${this.data.project.name}'s records again at ${clock(new Date(this.now()).toISOString())}.`, 'secondary');
  }

  // ── typing into a field ───────────────────────────────────────────────────────

  private typing(input: string, k: Partial<Key>): void {
    const f = this.ui.input.field!;
    if (k.escape) {
      // R5 (H131; the QA round's defect 1): Esc means one thing at a time, and says which: while this Workbench's turn is being
      // answered it stops that turn and the composer stays open (what is typed in it is kept); otherwise it leaves the composer
      if (f === 'composer' && this.turnAbort) {
        this.turnAbort.abort();
        this.say('Esc: stopping the chat turn being answered. The composer stays open (Esc again leaves it).', 'secondary');
        return;
      }
      if (f === 'composer') this.say(`Esc: left the composer${this.ui.input.text.trim() ? ' (what was typed in it was not sent)' : ''}. Enter opens it again.`, 'secondary');
      this.ui.input = { field: null, text: '' };
      if (f === 'picker' || f === 'new') this.ui.overlay = null;
      if (f === 'tools') {
        // R4 (H112; the r26 dry run, where / could not reach the finder from All tools): Esc clears the tools search and,
        // where the navigation is shown, gives it the keyboard, so / finds a workspace in one key (no key changes). Where it
        // is a drawer, the keyboard stays on the list: g, then /.
        this.ui.toolsQuery = '';
        this.toolsTop();
        if (this.last?.regions.nav) {
          this.ui.focus = 'nav';
          this.say('Tools search cleared. The navigation has the keyboard: / finds a workspace; Tab goes back to the tools.', 'secondary');
          return;
        }
        this.say('Tools search cleared. g, then / finds a workspace.', 'secondary');
        return;
      }
      this.emit();
      return;
    }
    if (k.return) { void this.submit(f, this.ui.input.text); return; }
    if (k.upArrow || k.downArrow) {
      if (f === 'picker') { this.ui.cursor.overlay = Math.max(0, (this.ui.cursor.overlay ?? 0) + (k.upArrow ? -1 : 1)); this.emit(); }
      return;
    }
    if (k.backspace || k.delete) { this.ui.input.text = [...this.ui.input.text].slice(0, -1).join(''); if (f === 'tools') this.toolsTop(); this.emit(); return; }
    if (k.ctrl || k.meta || k.tab) return;
    // printable text only (a paste arrives as one string)
    const text = input.replace(/[\x00-\x1f\x7f]/g, '');
    if (!text) return;
    this.ui.input.text = (this.ui.input.text + text).slice(0, 300);
    if (f === 'picker') this.ui.cursor.overlay = 0;
    if (f === 'tools') this.toolsTop();
    this.emit();
  }

  /**
   * R4 (H112; found in tmux at 80x24): All tools' list from its top, its first match selected: the search's own row and its
   * hint (the way to the workspace finder) are the list's first rows, so they are shown while the search is typed in, and
   * after Esc clears it (a row selected far down had scrolled them away).
   */
  private toolsTop(): void {
    const list = 'center:tools';
    this.ui.cursor[list] = 0;
    this.ui.scroll[list] = 0;
    delete this.ui.sel[list];
    delete this.ui.anchor[list];
    delete this.ui.wheel[list];
    if (this.ui.chosen) delete this.ui.chosen[list];
  }

  private async submit(field: NonNullable<Ui['input']['field']>, text: string): Promise<void> {
    if (field === 'search') {
      const q = text.trim().toLowerCase();
      const hit = NAV_ORDER.find((id) => this.labelOf(id).toLowerCase().startsWith(q)) ?? NAV_ORDER.find((id) => this.labelOf(id).toLowerCase().includes(q));
      // R5 (H131): else a tab by its words ("Logs", "Fleet", "Home")
      const tab = !hit && q ? TABS.find((t) => t.label.toLowerCase().startsWith(q)) ?? TABS.find((t) => t.label.toLowerCase().includes(q)) : undefined;
      this.ui.input = { field: null, text: '' };
      if (hit) { this.selectWorkspace(hit); this.ui.focus = 'center'; this.ui.navOpen = false; }
      else if (tab) { this.selectPage(tab.id); this.ui.focus = 'center'; this.ui.navOpen = false; }
      else if (q) { this.selectWorkspace('tools'); this.ui.input = { field: 'tools', text }; this.ui.focus = 'center'; this.ui.navOpen = false; }
      else this.ui.navOpen = false;
      this.emit();
      return;
    }
    if (field === 'tools') {
      // R4 (H112): Enter keeps the matches listed, the first one selected, for the arrows and the Inspector; / changes them
      this.ui.toolsQuery = text.trim();
      this.ui.input = { field: null, text: '' };
      this.ui.focus = 'center';
      const items = this.itemsNow('center');
      if (items?.length) select(this.ui, 'center:tools', items, 0); else this.ui.cursor['center:tools'] = 0;
      this.emit();
      return;
    }
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
      if (this.data.turn?.state === 'sending') { this.say('One turn at a time: the chat turn is still being answered. Esc stops it, or wait for its answer.', 'secondary'); return; }
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
    // R5 (H131; the QA round's defect 8): the conversation follows the new turn (to its answer's end and the composer) until
    // the person selects a message again
    if (this.ui.chosen) delete this.ui.chosen['center:chat'];
    // R5 (H131; the QA round's defects 1 and 8): the frame (its run count, its chat actions) and the pipeline read again for
    // the turn now, and once its first words arrive (its hold is taken by then)
    this.readPipeline();
    this.refreshFrame();
    let heard = false;
    this.emit();
    try {
      // R4 lead: sent once (src/contracts/chat-session.ts sendOnce): the message's key is its operation's, so nothing that
      // sends this message again (a repeat of its Enter, a retry after a timeout, another process) repeats a turn that went out
      const r = await ws.ops.run(h, () => session.sendOnce(`wb-${h.id}`, text, {
        onText: (full) => { turn.answer = full; if (!heard) { heard = true; this.refreshFrame(); } this.emit(); },
        onTool: (e) => { turn.tools.push({ name: e.name, phase: e.phase, ...(e.outcome ? { outcome: e.outcome } : {}) }); this.emit(); },
        askPerson: (req) => this.askPerson(req),
        signal: abort.signal,
      }));
      Object.assign(turn, {
        state: r.status, answer: r.text || turn.answer, lines: r.lines ?? [], sent: r.sent, costWords: r.costWords,
        ...(r.receipt ? { receipt: r.receipt } : {}), ...(r.model ? { model: r.model } : {}),
      });
      // (the receipt by its short id, as the Control Room and the event log name it)
      this.say(r.status === 'answered' ? `Answered${r.receipt ? `: receipt ${receiptShort(r.receipt)}` : ''} ${this.d.glyphs.sep} ${r.costWords}` : `${r.status === 'refused' ? 'Refused' : r.status === 'cancelled' ? 'Stopped' : 'Failed'}: ${(r.lines ?? [])[0] ?? r.status}${r.sent ? '' : ' Nothing was sent to any model.'}`,
        r.status === 'failed' ? 'failure' : r.status === 'answered' ? 'text' : 'secondary', { operation: h.id });
    } catch (e) {
      Object.assign(turn, { state: 'failed', lines: [`The chat session failed: ${e instanceof Error ? e.message : String(e)}`] });
      this.say(turn.lines[0], 'failure', { operation: h.id });
    } finally {
      turn.ended = this.now();
      if (this.turnAbort === abort) this.turnAbort = null;
      try { this.data.chatRoute = session.route(); } catch { /* as before */ }
      this.data.chat = readChatTail(this.data.project.root);
      // R4 (H117): the turn's receipt is sealed by now: the Control Room lists it at once, not at the next reading
      this.data.turns = readTurns(this.chain(), this.data.project.root);
      // R5 (H131): and the pipeline shows the turn just answered; the frame no longer counts it
      this.readPipeline();
      this.refreshFrame();
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

  /**
   * R4 lead (2026-10-12): pasted text (the terminal's bracketed paste, src/workbench/app.tsx usePaste), apart from typed keys:
   * into the field that has the keyboard (its lines joined by spaces, its control characters dropped: a paste never sends);
   * a NEEDS YOU box denies (a pasted y never approves); anywhere else nothing is done with it, and that is said (pasted text
   * is never taken as keys: an x in it never stops a job).
   */
  paste(text: string): void {
    const o = this.ui.overlay;
    if (o?.kind === 'needs-you') { o.answer('deny'); return; }
    if (this.ui.input.field) { this.typing(text.replace(/\r\n|\r|\n/g, ' '), {}); return; }
    this.say('Pasted text is taken only into a field (the composer, a search, a name): nothing was done with it.', 'secondary');
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
    this.data.activity = this.activity();
    // R5 (H131): what waits on you is in the frame too (its tabs' counts, its next step)
    this.refreshFrame();
    this.emit();
  }

  // ── a workflow block, run here ────────────────────────────────────────────────

  /** The REPL's own /run of one block, as one operation (its prediction, its NEEDS YOU, its job and receipts are /run's). */
  private async runBlock(o: Extract<NonNullable<Overlay>, { kind: 'confirm-run' }>): Promise<void> {
    this.ui.overlay = null;
    const ws = this.d.workspace;
    const args = `${o.doc} ${o.block}`;
    const label = `${o.doc} › ${o.block}`;
    const request = `/run ${args}`;
    // R4 (H112): one press, one operation, one job. A run of it being started here, or one that runs now in any session (the
    // job store read again, not the last tick's reading), starts nothing: no operation is begun and nothing is sealed.
    this.ui.starting = [...this.starting];
    this.readJobs();
    const going = runOfBlock({ ui: this.ui, data: this.data }, o.doc, o.block);
    if (going) { this.say(`Not started: ${going.words}.`, 'secondary', going.job?.operation ? { operation: going.job.operation } : {}); return; }
    this.starting.add(label);
    this.ui.starting = [...this.starting];
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
      this.starting.delete(label);
      this.ui.starting = [...this.starting];
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
      // R5 (H131): the frame says which views open at start
      this.refreshFrame();
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
    // R4 (H112): another project's lists: nothing of this one's selection, anchors or wheel is kept (Activity keeps following)
    this.ui.sel = {};
    this.ui.anchor = {};
    this.ui.wheel = {};
    this.ui.chosen = {};
    this.ui.toolsQuery = '';
    const remembered = this.ui.settings.settings.rememberLayout ? this.ui.settings.settings.layouts[this.data.project.id] : undefined;
    if (remembered) { this.ui.workspace = remembered.workspace; this.ui.page = pageOf(remembered.workspace); this.ui.tab = remembered.tab; this.ui.activityOpen = remembered.activity; }
    // R5 (H131): another project's frame: the last one is not shown for it (its actions and log are the other project's)
    delete this.ui.cursor.top;
    this.readAll();
    this.refreshFrame();
    this.loadFor(this.ui.workspace);
    // R4 (H112): this Workbench's runs elsewhere go on, named with where they run
    const away = this.data.away.filter((j) => j.live).map((j) => `${j.id} (${j.label}) keeps running in ${j.project}`);
    this.say(`Now in ${p.name} (${this.data.project.shown}): ${why}. The REPL, the monitor and Studio follow the same record; a running job keeps its own project${away.length ? `: ${away.join('; ')}. Stop still names it` : ''}.`);
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
    this.reselect();
    // R4 (H112): the target the top line names (src/workbench/views.ts stopWords: the Control Room's selected live job there),
    // so what x stops is always what was named beforehand
    const named = stopWords(this.data, this.selected(), this.ui.workspace);
    const target = named.target;
    if (!target) {
      // R5 (H131; the QA round's defect 1): a chat turn is what runs: this Workbench's own stops here; another surface's there
      if (named.turn?.mine && this.turnAbort) { this.turnAbort.abort(); this.say('Stopping the chat turn being answered here (x)…', 'secondary'); return; }
      if (named.turn) { this.say(`Stop current: the chat turn is being answered in ${named.turn.where}; it stops there (Esc in its composer, Ctrl+C in the REPL), not from here.`, 'secondary'); return; }
      this.say(`Stop current: nothing runs in ${this.data.project.name}.`, 'secondary');
      return;
    }
    const where = sameFolder(target.root, this.data.project.root) ? '' : `, in ${target.project}`;
    this.say(`Stopping ${target.id} (${target.label}${where})…`, 'secondary');
    const r = await stopCurrent(target, { stop: (id) => this.d.workspace.stop(id), jobs: this.d.workspace.jobs, ...(this.d.stopLeft ? { stopLeft: this.d.stopLeft } : {}) });
    this.readJobs();
    this.say(r.words, r.role);
  }

  // ── Enter ─────────────────────────────────────────────────────────────────────

  async enter(): Promise<void> {
    const region = this.ui.focus;
    if (region === 'nav') { this.ui.focus = 'center'; this.ui.navOpen = false; this.emit(); return; }
    if (region === 'top') {
      const { acts, at } = selectedAction(this.ctx());
      await this.runAction(acts[at]);
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

  /**
   * R5 (H131): a workflow action of row 2 (the workspace frame's, src/ops/workspace-frame.ts), run through a path this
   * Workbench has: a tab, a key's own path (Stop current, Companion · Show, Studio · Show, New project, Switch project), a
   * workspace, a workflow block's Run confirm (it asks before anything runs), the composer. Any other command is shown to copy,
   * with where it runs: nothing is run for it here, and nothing is said to have happened.
   */
  async runAction(a: WorkspaceAction | undefined): Promise<void> {
    if (!a) { this.say(pageActions(this.ctx()).why ? `No action: ${pageActions(this.ctx()).why}` : 'No action on this tab.', 'secondary'); return; }
    if (!a.enabled) { this.say(`${a.n} ${a.label}: not now: ${a.why ?? 'not available'}`, 'secondary'); return; }
    const r = routeOf(a);
    switch (r.kind) {
      case 'page': this.selectPage(r.page); this.ui.focus = 'center'; this.emit(); return;
      case 'key': this.key(r.key, {}); return;
      case 'workspace': this.selectWorkspace(r.ws); this.ui.focus = 'center'; this.emit(); return;
      case 'composer':
        this.selectWorkspace('chat');
        this.ui.focus = 'center';
        if (this.can().chat) this.ui.input = { field: 'composer', text: '' };
        else this.say(`Not now: ${this.can().chatWhy ?? 'sending is not available here'}`, 'secondary');
        this.emit();
        return;
      case 'abort': {
        const turn = chatTurnNow(this.data);
        if (this.turnAbort) { this.turnAbort.abort(); this.say('Stopping the chat turn being answered here…', 'secondary'); }
        else if (turn) this.say(`The chat turn is being answered in ${turn.where}; it stops there (Esc in its composer, Ctrl+C in the REPL), not from here.`, 'secondary');
        else this.say('No chat turn is being answered: nothing to stop.', 'secondary');
        return;
      }
      case 'run': {
        const doc = this.data.workflows.docs.find((d) => d.rel === r.doc);
        const block = doc?.blocks.find((b) => b.name === r.block);
        if (!doc || !block) { this.say(`${r.doc} › ${r.block} is not in this project's workflows now: nothing was run.`, 'secondary'); return; }
        this.selectWorkspace('workflows');
        await this.activate({ kind: 'block', key: `block:${doc.rel}:${block.key}`, doc, block });
        return;
      }
      default: {
        const lines: Line[] = [
          [{ text: a.label, role: 'strong' }],
          [],
          [{ text: '  ' }, { text: a.command, role: 'action' }],
          [],
          [{ text: `It runs in ${r.where}${a.effect === 'read' ? '' : `, and ${a.effect === 'network' ? 'asks over the network' : a.effect === 'spend' ? 'can spend' : 'changes things on this computer'}`}. Nothing was run from here: the Workbench has no path of its own for it.`, role: 'secondary' }],
          [{ text: 'm gives the mouse back to the terminal, to select the command and copy it.', role: 'secondary' }],
        ];
        this.open({ kind: 'message', title: `Run it in ${r.where}`, lines });
      }
    }
  }

  /** What Enter does to the selection: the action its words name. */
  private async activate(item: Item | null): Promise<void> {
    if (!item) return;
    switch (item.kind) {
      case 'conn': {
        // R5 (H131): a connection card: the companion's and Studio's Show; any other, its step, shown to copy
        const k = item.conn;
        if (k.id === 'companion') { await this.showCompanion(); return; }
        if (k.id === 'studio') { await this.showStudio(); return; }
        if (!k.setup) { this.say(`${k.label}: no step sets it up or checks it from here.`, 'secondary'); return; }
        const where = k.setup.startsWith('/') ? 'the REPL (timmy)' : 'a shell';
        this.open({
          kind: 'message', title: `Run it in ${where}`, lines: [
            [{ text: `${k.label}: its step`, role: 'strong' }], [], [{ text: '  ' }, { text: k.setup, role: 'action' }], [],
            [{ text: `It runs in ${where}. Nothing was run from here, and the card says what was last observed until it is checked again.`, role: 'secondary' }],
            [{ text: 'm gives the mouse back to the terminal, to select the command and copy it.', role: 'secondary' }],
          ],
        });
        return;
      }
      case 'block': {
        // R4 (H112): a run of this block under way (here, or in any session, read now from the job store) starts nothing
        this.ui.starting = [...this.starting];
        this.readJobs();
        const going = runOfBlock({ ui: this.ui, data: this.data }, item.doc.rel, item.block.name);
        if (going) { this.say(`Not started: ${going.words}.`, 'secondary', going.job?.operation ? { operation: going.job.operation } : {}); return; }
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
        // the Inspector shows it (R5, H131: as a drawer where Context is not a column)
        this.ui.tab = 'inspector';
        if (!this.contextColumn()) this.ui.rightOpen = true;
        this.emit();
    }
  }

  // ── the mouse ─────────────────────────────────────────────────────────────────

  /**
   * A mouse report (SGR, as the Workbench asks for them: src/tui/mouse.ts). R4 (H112), the operator's slice C: a click opens a
   * workspace (the navigation), picks a tab (the right dock), selects a row, or presses the [key] it lands on; a click never
   * runs or allows anything: a row is only selected (Enter, the key, acts on it), a click on [Enter] in the Run confirm or on
   * [y] or [a] in a NEEDS YOU box says the key to press instead (a click on [n] denies, the default), and while a field has
   * the keyboard only [Esc] counts (a one-letter hint is never typed into it). The wheel scrolls the list under the pointer
   * by rows, moving no selection and no focus.
   */
  mouse(m: MouseReport): void {
    const f = this.last;
    if (!f || !this.ui.mouse) return;
    const x = m.x - 1;
    const y = m.y - 1;
    const hit = (Object.entries(f.regions) as Array<[Region, NonNullable<Frame['regions'][Region]>]>).find(([, d]) => x >= d.rect.x && x < d.rect.x + d.rect.w && y >= d.rect.y && y < d.rect.y + d.rect.h);
    // the wheel (its modifier bits aside): the list under the pointer scrolls by a row
    const plainButton = m.button & ~(4 | 8 | 16);
    if (plainButton === 64 || plainButton === 65) {
      if (hit && hit[0] !== 'top') this.wheel(hit[0], hit[1], plainButton === 64 ? -1 : 1);
      return;
    }
    if (!m.press || m.button !== 0) return;
    // the [key] hint it lands on, wherever it is drawn
    const hint = keyAt(f.screen.map((l) => l.map((s) => s.text).join('')), m.x, m.y);
    const o = this.ui.overlay;
    if (o?.kind === 'needs-you') {
      if (hint === 'n') this.key('n', {});
      else if (hint === 'y' || hint === 'a') this.say('A click never allows: press y to allow once (or n, Esc or Enter to deny). The box waits for a key.', 'attention');
      return;
    }
    if (this.ui.input.field) {
      if (hint === 'Esc') this.key('', { escape: true });
      else this.say('A field has the keyboard: Esc leaves it (a click on a key\'s hint is never typed into it).', 'secondary');
      return;
    }
    if (o?.kind === 'confirm-run') {
      if (hint === 'Esc') this.escape();
      else if (hint === 'Enter') this.say('A click never starts a run: press Enter, the key, to run it (or Esc).', 'attention');
      return;
    }
    if (o?.kind === 'quit') { if (hint === 'Esc') { this.ui.overlay = null; this.emit(); } return; }
    // R5 (H131): a tab of row 1 opens it (as its key does; a box open in the body closes, nothing runs)
    const page = f.pages.find((p) => y >= p.y0 && y <= p.y1 && x >= p.x0 && x <= p.x1);
    if (page) { this.selectPage(page.page); return; }
    if (o?.kind === 'settings') {
      // a checkbox or a preset is changed by its click, as Space would (a setting, never a run)
      const d = f.regions.center;
      const at = d && hit?.[0] === 'center' ? this.rowAt(d, x, y, false) : -1;
      if (at >= 0) { this.ui.cursor.overlay = at; this.toggleSetting(at); return; }
      if (hint === 'Esc') this.escape();
      return;
    }
    if (o) { if (hint === 'Esc') this.escape(); return; }
    if (!hit) return;
    // a tab of the right dock
    for (const t of f.tabs) if (y === t.y && x >= t.x0 && x <= t.x1) { this.ui.tab = t.tab; this.ui.focus = 'right'; this.remember(); this.emit(); return; }
    // R5 (H131): a workflow action of row 2 is selected by its click, never run (Enter, the key, runs it)
    const act = f.actions.find((a) => y === a.y && x >= a.x0 && x <= a.x1);
    if (act) { this.ui.focus = 'top'; this.ui.cursor.top = act.i; this.emit(); return; }
    const [region, d] = hit;
    const at = this.rowAt(d, x, y, region === 'bottom');
    const it = at >= 0 ? d.items[at].item : null;
    // a workspace in the navigation opens it
    if (region === 'nav' && it?.kind === 'action') { this.ui.focus = 'nav'; this.selectWorkspace(it.action as WorkspaceId); return; }
    // the region under the pointer has the keyboard; the row under it is selected (only selected)
    this.ui.focus = region;
    if (at >= 0) {
      this.reselect();
      select(this.ui, d.list, d.items, at);
      if (region === 'center') this.ui.follow = null;
      if (region === 'bottom') this.ui.activityFollow = at === d.items.length - 1;
    }
    if (hint === 'Esc') { this.escape(); return; }
    // [Enter] does what Enter does to what is now selected: it opens or asks (a run's confirm), and never runs
    if (hint === 'Enter') { void this.enter(); return; }
    if (hint && [...hint].length === 1) { this.key(hint, {}); return; }
    this.emit();
  }

  /** R4 (H112): the item a click at (x, y) lands on in a drawn region, or -1 (a border, a heading, the air). `rows`: an item
   *  takes every row up to the next item's (Activity's wrapped events). */
  private rowAt(d: NonNullable<Frame['regions'][Region]>, x: number, y: number, rows: boolean): number {
    if (x <= d.rect.x || x >= d.rect.x + d.rect.w - 1) return -1;
    const row = y - d.rect.y - 1 - d.fixed;
    if (row < 0 || (d.height && row >= d.height)) return -1;
    const line = row + d.scroll;
    // R5 (H137): an item drawn in a column of its own (`x`: a body with columns side by side) is under the pointer only within
    // its column's cells; an item without `x` takes its whole row, as before
    const cx = x - d.rect.x - 1 - (d.rect.w - 2 >= 6 ? 1 : 0);
    const inCol = (it: { x?: { from: number; to: number } }): boolean => !it.x || (cx >= it.x.from && cx < it.x.to);
    const exact = d.items.findIndex((it) => it.line === line && inCol(it));
    if (exact >= 0) return exact;
    // R5 (H131): an item of several rows (a connection card) is under every one of its rows
    const span = d.items.findIndex((it) => (it.rows ?? 1) > 1 && line >= it.line && line < it.line + (it.rows ?? 1) && inCol(it));
    if (span >= 0 || !rows) return span;
    for (let i = d.items.length - 1; i >= 0; i--) if (d.items[i].line <= line) return i;
    return -1;
  }

  /** R4 (H112): the wheel over a region scrolls its list by `delta` rows: the view only (no selection, no focus moves). */
  private wheel(region: Region, d: NonNullable<Frame['regions'][Region]>, delta: number): void {
    const max = Math.max(0, d.total - d.height);
    const next = Math.max(0, Math.min(max, d.scroll + delta));
    if (next === d.scroll) return;
    this.ui.scroll[d.list] = next;
    this.ui.wheel[d.list] = true;
    delete this.ui.anchor[d.list];
    // Activity scrolled by the wheel is held where it is (its newest is not followed until End)
    if (region === 'bottom') this.ui.activityFollow = false;
    this.emit();
  }

  // ── quitting ──────────────────────────────────────────────────────────────────

  async quit(): Promise<void> {
    // R4 (H112): the job store as it is now (found in tmux: a Ctrl+C just after a run ended asked about that run, read before
    // it ended); this Workbench's runs in another project are its own too: the quit box names them
    this.readJobs();
    const live = [...this.data.jobs, ...this.data.away].filter((j) => j.live);
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
