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
import { requestTurnStop, runningTurns } from '../agent/chat-turn.js';
import type { CapabilityRow } from '../capabilities/index.js';
import type { ChatSession, OpenChatSession } from '../contracts/chat-session.js';
import { TABS, tabByKey, type TabId, type WorkspaceAction } from '../contracts/workspace.js';
import type { JobRecord } from '../jobs/index.js';
import { readActiveProject, sameFolder } from '../project/index.js';
import { listStarters } from '../project/starters.js';
import { currentOperation } from '../ops/context.js';
import { operationRel } from '../ops/operations.js';
import { readProcessTable, START_SLACK_MS, startIn, withProcessTable, type ProcessTable } from '../ops/process-proof.js';
import { buildWorkspaceFrame, turnStopCommand, turnStopWords } from '../ops/workspace-frame.js';
import { JOB_CANCELLED } from '../contracts/stop-words.js';
import type { ApprovalRequest, Decision } from '../repl/approvals.js';
import type { Workspace } from '../repl/workspace.js';
import { timmyHome } from '../setup/home.js';
import { projectCards, type ProjectCard, type ProjectOperation } from '../studio/project-cards.js';
import { publicTemplates } from '../studio/templates.js';
import type { Segment } from '../term/theme.js';
import { keyAt, type MouseReport } from '../tui/mouse.js';
import { scrubHomes, tildePath } from '../utils/home-scrub.js';
import { receiptsPath, verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import { isLiveRun } from '../workflows/upmd-live.js';
import { readControl } from './control-tab.js';
import { createCompanionHint } from './create-tab.js';
import { readFleet } from './fleet-tab.js';
import { innerWidth, type Glyphs } from './frame.js';
import { awayOf, chatTurnNow, isHub, pageOf, receiptShort, routeOf, workspaceOfPage, workspacesOf, type TurnNow } from './hub.js';
import { bodyKind, contextIsColumn } from './layout.js';
import { modelRows, ollamaRows, RAIL, RAIL_ITEMS, railCatalog, railProvider, shellControls, type RailModels } from './chat-shell.js';
import { readLogs } from './logs-tab.js';
import { readTools } from './tools-tab.js';
import { readVox } from './voxvision-tab.js';
import type { Data, Item, Lazy, Overlay, Region, Ui, View } from './model.js';
import { companionWhat, handoffWords, homeDefault, inWords, turnEndNotice, type WorkItem } from './home-journey.js';
import { openTarget, recentWork as recentWorkOf, routeNow } from '../journey/index.js';
import { buildInfo } from '../build-info.js';
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
  readWorkflows, FILES_BEING_READ, WORKFLOWS_BEING_READ, type ActivityEvent,
} from './state.js';
import { releaseEndedCopies } from '../utils/dispatch.js';
import { checkRows, realSetupDeps, type OllamaList, type SetupDeps, type SetupPlan } from './setup-paths.js';
import { stopCurrent, type StopDeps } from './stop.js';
import { clock, type Line, type Role } from './text.js';
import { HoldWatch, type HoldsReading } from './turn-holds.js';
import { actionsOf, bottomView, centerView, cursorOf, pageActions, rightView, routeShown, runOfBlock, selectedAction, selectedItem, stopWords, type ViewCtx } from './views.js';
import { endedOnChain, readWorkflowsTab, refreshBlockStates, selectedBlock } from './workflows-tab.js';

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
  /** R6 (H141): the chat-turn holds' watch (src/workbench/turn-holds.ts): how often their names are listed (ms), and a test's
   *  FAKE reading of them; `holdWatch: false` watches through the listing alone */
  holdsEveryMs?: number;
  holdWatch?: boolean;
  /** R5 (H131; the finish line, item 3): the chat's fixes done here (absent: the real modules; a test gives FAKE ones) */
  setup?: Partial<SetupDeps>;
  /** R6 (H141): each key (and paste) as one entry: what arrived, the box and field it met, what took it (run.ts writes them
   *  to the file TIMMY_WORKBENCH_KEYLOG names; a test reads them) */
  keyLog?: (entry: Record<string, unknown>) => void;
}

const plain = (l: Segment[] | Line): string => l.map((s) => s.text).join('');

/** R4 lead: the keys that start or stop something, taken only when pressed alone (never from keys that arrived together). */
const TAKEN_ALONE = new Set(['x', 'c', 's', 'C', 'S']);
/** R10 (H167): the colour probe's answers as Ink hands them on when they come late: an OSC colour ("11;rgb:0000/0000/0000",
 *  "4;7;rgb:c0c0/c0c0/c0c0", with or without its ] and its BEL) or a DA1 answer ("[?1;2c"). Never typed by a person. */
const TERMINAL_REPLY = /rgb:[0-9a-f]{1,4}\/[0-9a-f]{0,4}|^\]?(?:\d{1,3};)+rgb:|^\[?\?[\d;]+c$/i;

/** R9 (H161; R8's M): how long the answer to a key keeps the controls row, as long as bottomView draws a notice there (6 s). */
const ANSWER_HOLD_MS = 6000;

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
  /**
   * R9 (H161; R8's open item M): the keys the person has pressed (each one counted as takeKey takes it), and the answer to one
   * held on the controls row (say's `answer`): while no other key has been pressed and it is fresh (ANSWER_HOLD_MS, as long as
   * the row shows a notice: src/workbench/views.ts bottomView), a notice of something else (a run's progress line, a job's
   * end, through the Workspace's notify) goes to Activity's events and its strip without taking the answer's place.
   */
  private keySeq = 0;
  private held: { key: number; at: number } | null = null;
  private readonly output = new OutputWatch();
  /** R5 (H131): the chat's fixes (src/workbench/setup-paths.ts) */
  private readonly setup: SetupDeps;
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
  /**
   * R6 (H141; the interaction review of a77d80d, defect 3): the project's chat-turn holds, watched (src/workbench/turn-holds.ts):
   * another process's turn shows in the run line and is what x stops as soon as its hold is written, and its end as soon as
   * the hold is let go, not at the frame's next reading; x and Enter on Stop the turn read them again before they answer.
   */
  private readonly holds: HoldWatch;
  /**
   * R10 (H163; the turn-holds latency, the lead's item (e)): the process table as last read by a child process the event loop
   * does not wait on (src/ops/process-proof.ts readProcessTable). A tick's readings, and every reading once a table is there,
   * look the writers they name up in it (withTable): no program runs while the Workbench ticks. `looked`: the pids looked up;
   * a new table that says something else of one has those readings read again (readTable).
   */
  private table: ProcessTable | null = null;
  private tableReading = false;
  private looked = new Set<number>();
  private inTick = false;
  private readonly startedAt = Date.now();

  constructor(private readonly d: ControllerDeps) {
    this.holds = new HoldWatch({
      root: () => this.data.project.root, now: () => this.now(), onChange: (r) => this.onHolds(r),
      ...(d.holdsEveryMs ? { everyMs: d.holdsEveryMs } : {}), ...(d.holdWatch === false ? { watch: false } : {}),
    });
    this.setup = { ...realSetupDeps(d.env), ...(d.setup ?? {}) };
    const settings = (d.settings?.read ?? (() => readSettings(d.env)))();
    const project = projectView(d.workspace.project, d.env);
    const remembered = settings.settings.rememberLayout ? settings.settings.layouts[project.id] : undefined;
    // R5 (H131): the Workbench opens on Home (the operator's opening hub, references 01 and 13); the workflow actions have the
    // keyboard first, their one primary next step selected (Tab: the body). R10 (H167; H168's F11): always on Home, the
    // project's last tab one key away (rememberLayout keeps Context's tab and Activity, no longer the tab it opens on)
    const workspace: WorkspaceId = 'connections';
    this.ui = {
      page: pageOf(workspace), workspace, focus: 'top', tab: remembered?.tab ?? 'inspector',
      navOpen: false, rightOpen: false, activityOpen: remembered?.activity ?? false, activityAll: false, overlay: null,
      input: { field: null, text: '' }, cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, activityFollow: true, toolsQuery: '',
      flash: null, mouse: false, related: false, settings, saved: null,
      companion: d.companion.state(), studio: d.studio.state(), mine: [], starting: [],
      // R10 CHAT (H167): the Chat screen's shell, unless this Workbench was started for the classic Chat tab
      ...(d.env.TIMMY_WORKBENCH_CHAT === 'classic' ? { chatClassic: true } : {}),
    };
    this.data = this.emptyData(project);
    // R10 (H163; R9's item B, for the Workbench): the first frame waits on no walk of the project. Its files and workflow
    // documents are read once, right after the first frame (Ink draws it as the app is rendered, before this immediate
    // runs), and the workspace frame is built from that same reading (refreshFrame); until then the screen says they are
    // being read
    this.data.files = FILES_BEING_READ;
    this.data.workflows = WORKFLOWS_BEING_READ;
    this.readAll({ walks: false });
    setImmediate(() => {
      if (this.disposed) return;
      this.readAll();
      this.refreshFrame();
      // the screen drawn again with the reading: the app subscribed as its first frame was drawn (React runs the effects of
      // Ink's first render before render() returns, so before this immediate)
      this.emit();
      // on the next turn: the dispatch copies whose sessions ended outside Timmy released (src/utils/dispatch.ts; R9's F11),
      // bounded: at most 20 copies, 2 s for each question to tmux; said in Activity only when one was released. R10 (H163; the
      // turn-holds latency): no second redraw here; it drew the same screen again, a whole render (0.1 to 0.3 s on a loaded
      // computer) in the Workbench's first second, where another surface's first chat turn could wait behind it
      setTimeout(() => {
        if (this.disposed) return;
        try {
          const done = releaseEndedCopies(this.data.project.root, { max: 20, timeoutMs: 2000 }).filter((x) => x.state !== 'in_use');
          if (done.length) this.say(`Released ${done.length === 1 ? 'a dispatch copy whose session' : `${done.length} dispatch copies whose sessions`} had ended outside Timmy (its outputs kept): ${done.map((x) => x.id).join(', ')}`, 'secondary');
        } catch { /* each copy stays as its record says */ }
      }, 0).unref?.();
    });
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
  say(text: string, role: Role = 'text', meta: { operation?: string; job?: string; whileTurn?: string; answer?: boolean } = {}): void {
    const at = new Date(this.now()).toISOString();
    // R9 (H161; R8's M): an answer to the key just pressed keeps the controls row against notices of other things (held, above)
    const keep = !meta.answer && this.held !== null && this.held.key === this.keySeq && this.now() - this.held.at < ANSWER_HOLD_MS;
    if (!keep) this.ui.flash = { text, role, at: this.now(), ...(meta.whileTurn ? { whileTurn: meta.whileTurn } : {}) };
    if (meta.answer) this.held = { key: this.keySeq, at: this.now() };
    else if (!keep) this.held = null;
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

  /** The jobs and Activity (every tick). R9 (H161): whether the job store could be read (false: nothing of it was). */
  readJobs(): boolean {
    let read = true;
    try { this.records = this.d.workspace.jobs.list(); } catch { this.records = []; read = false; }
    const root = this.data.project.root;
    this.data.jobs = readJobs(this.records, root, { mine: this.mine, chain: this.chain() });
    // R4 (H112): a run this Workbench started keeps its own project when the view switches: still named, with where
    this.data.away = this.records.filter((j) => this.mine.has(j.id) && !sameFolder(j.root, root)).slice(0, 12).map((j) => jobRow(j, { mine: this.mine }));
    this.readOutput();
    this.data.activity = this.activity();
    return read;
  }

  /**
   * R9 (H161; R8's open item M): the run of a workflow block that goes on now, for one press of Run (the block's Enter, and its
   * confirm's Enter): read from the job store again (the press must not start a second run on the last tick's reading alone),
   * and from the reading before it. The fresh reading decides when it has the run going on, or has that job's record ended (it
   * saw the end: Run asks again). When it has no run of it going on and no record of the job the reading before had running
   * (that record could not be read at that moment, or the job store could not be read at all), the job is not known to have
   * ended, so the earlier reading's run stands: the press is refused in the same words and starts nothing.
   */
  private runningNow(doc: string, block: string): ReturnType<typeof runOfBlock> {
    const before = runOfBlock({ ui: this.ui, data: this.data }, doc, block);
    this.ui.starting = [...this.starting];
    const read = this.readJobs();
    const now = runOfBlock({ ui: this.ui, data: this.data }, doc, block);
    if (now || !before?.job) return now;
    return read && this.data.jobs.some((j) => j.id === before.job!.id) ? undefined : before;
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

  /** R10 (H167): the route the next turn takes and the project's recent work (H164's src/journey), and the build once (H163's
   *  buildInfo, which asks git where Timmy runs from source). A reading that fails leaves the one before. */
  private readJourney(chain?: readonly Receipt[]): void { this.withTable(() => this.readJourneyNow(chain)); }
  private readJourneyNow(chain?: readonly Receipt[]): void {
    const p = this.data.project;
    try { this.data.journeyRoute = routeNow({ env: this.d.env, surface: 'workbench' }); } catch { /* as it was */ }
    // (H164's call shape: with the files this Workbench has read, so recentWork lists no folder again, and what a NEEDS YOU box
    // asks of an operation, so a run it blocks is "waiting on you"; H163's first frame: not before the files are read, when
    // Home says its recent work is being read)
    if (!this.data.files.reading) {
      const files = this.data.files.groups.flatMap((g) => g.files);
      const waiting = (op: string): string | undefined => this.data.decisions.items.find((x) => x.blocks && x.operation === op)?.title;
      try { this.data.recent = recentWorkOf({ project: { name: p.name, root: p.root }, env: this.d.env, ...(chain ? { chain } : {}), files, waiting }, 24); } catch { /* as it was */ }
    }
    if (!this.data.build) { try { this.data.build = buildInfo({ env: this.d.env }); } catch { /* unknown */ } }
  }

  /** Everything but the on-demand parts (every few seconds, and on [r]). R10 (H163): `walks` false: all but the walks of the
   *  project (its files, its workflow documents), as the first frame reads it. */
  readAll(o: { walks?: boolean } = {}): void { this.withTable(() => this.readAllNow(o)); }
  private readAllNow(o: { walks?: boolean }): void {
    const root = this.data.project.root;
    this.readJobs();
    const files = o.walks === false ? this.data.files : readFiles(root);
    this.data.files = files;
    const chain = this.chain();
    const own = this.records.filter((j) => sameFolder(j.root, root));
    if (o.walks !== false) this.data.workflows = readWorkflows(root, { jobs: own, chain, files: files.groups.flatMap((g) => g.files.map((f) => f.rel)), env: this.d.env, onPath: this.d.onPath });
    this.data.decisions = readDecisions(root, this.records, chain, this.data.caps.state === 'ready' ? { checkedAt: new Date(this.data.caps.at).toISOString(), rows: this.data.caps.value } : undefined, this.d.env);
    // R4 (H117): the project's chat turns, every surface's, from their sealed receipts in the same chain (the Control Room's)
    this.data.turns = readTurns(chain, root);
    this.data.activity = this.activity();
    // R4 lead: the one route (chatRouteNow), read as the chat session reads it (this process's folder), and the open session's
    // own route read again with it, so the top line, Chat and Settings follow a /setup made elsewhere
    this.data.route = readRoute(this.d.env);
    if (this.chat?.state === 'open' && this.chat.root === root) { try { this.data.chatRoute = this.chat.session.route(); } catch { /* as it was */ } }
    // R10 (H167): the journey's facts from their one source (H164's src/journey): the route the next turn takes and the
    // project's recent work (its receipts verified here), read here with the records, never per frame
    this.readJourney(chain);
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
   * Tab 5's and tab 9's (src/workbench/voxvision-tab.ts readVox, src/workbench/tools-tab.ts readTools) the same way: the
   * project's VoxVision records and MCP calls, with the chain as read here, each receipt verified when it is first shown.
   * Files only: no network, no VM, no paid call. A reading that fails says why in Activity (once until it changes).
   */
  private tabError = '';
  private readTab(ws: WorkspaceId = this.ui.workspace): void { this.withTable(() => this.readTabNow(ws)); }
  private readTabNow(ws: WorkspaceId): void {
    if (ws !== 'logs' && ws !== 'fleet' && ws !== 'control' && ws !== 'voxvision' && ws !== 'tools') return;
    const root = this.data.project.root;
    try {
      if (ws === 'logs') this.data.logs = readLogs({ home: timmyHome(this.d.env), root, env: this.d.env, records: this.records, now: this.now() });
      // R5 (H137): tab 7's reading: the lanes on PATH, Connect's devices, the turns being answered, each pane's log and receipt
      else if (ws === 'control') this.data.control = readControl({ home: timmyHome(this.d.env), root, env: this.d.env, records: this.records, jobs: this.data.jobs, away: this.data.away, chain: this.chain(), now: this.now(), output: this.output, tickMs: this.d.tickMs ?? 1000 });
      else if (ws === 'voxvision') this.data.voxTab = readVox({ root, chain: this.chain(), env: this.d.env, now: this.now() });
      else if (ws === 'tools') this.data.toolsTab = readTools({ root, chain: this.chain(), env: this.d.env, now: this.now() });
      else this.data.fleet = readFleet({ home: timmyHome(this.d.env), root, env: this.d.env, now: this.now() });
      this.tabError = '';
    } catch (e) {
      const tab = ws === 'logs' ? 'Logs & Receipts' : ws === 'control' ? 'Control Room' : ws === 'voxvision' ? 'VoxVision' : ws === 'tools' ? 'Tools & MCP' : 'Fleet & Clef';
      const why = `${tab} could not be read: ${e instanceof Error ? e.message : String(e)}`;
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
    let own = this.records.filter((j) => sameFolder(j.root, root));
    try {
      const chain = this.chain();
      // R5 (H131; the QA of e7f853e, defect 7): a job whose outcome is sealed while its record, as read, still runs: the records
      // (and with them the jobs, Activity, the strip and Stop current) are read again, so all of them follow one reading
      if (endedOnChain(own, chain)) { this.readJobs(); own = this.records.filter((j) => sameFolder(j.root, root)); }
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
  private readPipeline(chain: Receipt[] = this.chain()): void { this.withTable(() => this.readPipelineNow(chain)); }
  private readPipelineNow(chain: Receipt[]): void {
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
    // R10 (H163): with this Workbench's own reading of the files and workflow documents (the frame walks the project no second time)
    // R10 (H163; item (e)): against the process table this Workbench last read (none yet: the frame reads one itself, only if a
    // proof needs it); a pid it looked up has the table read again, without blocking
    const looked = new Set<number>();
    void buildWorkspaceFrame({ env: this.d.env, cwd: root, project: { name: this.data.project.name, root }, jobsDir: this.d.jobsDir, onPath: this.d.onPath, jobs: () => this.records, chain: () => this.chain(), files: () => this.data.files, workflows: () => this.data.workflows, now: this.now(), ...(this.table ? { processTable: this.table, processLooked: looked } : {}) })
      .then((f) => {
        if (looked.size) { for (const pid of looked) this.looked.add(pid); this.readTable(); }
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

  /** Studio's cards for the project shown (src/studio/project-cards.ts), from the records as this Workbench read them. */
  private cardsNow(): { cards: ProjectCard[]; notes: string[]; operations: ProjectOperation[] } { return this.withTable(() => this.cardsRead()); }
  private cardsRead(): { cards: ProjectCard[]; notes: string[]; operations: ProjectOperation[] } {
    const p = this.data.project;
    const r = projectCards({ root: p.root, name: p.name, jobs: this.d.jobsDir, receipts: null }, { chain: this.chain(), jobs: this.records.filter((j) => sameFolder(j.root, p.root)) });
    return { cards: r.cards, notes: r.notes, operations: r.operations ?? [] };
  }

  /** R6 (H141): Studio's cards read again once they have been read (a job started, moved or ended); the cards as read stay drawn
   *  meanwhile, and when a reading fails. */
  private refreshCards(): void {
    if (this.data.studio.state !== 'ready') return;
    try { this.data.studio = { state: 'ready', value: this.cardsNow(), at: this.now() }; } catch { /* the cards as last read */ }
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
    if (ws === 'studio' || ws === 'connections') void this.lazy('studio', async () => this.cardsNow(), force);
    if (['voxvision', 'create3d', 'motion', 'rea', 'tools'].includes(ws)) void this.lazy('caps', () => this.d.capabilities(), force);
    // R5 (H134): tabs 0, 8, 5 and 9 read when opened (then with the slow reading while they are shown); R5 (H137): tab 7 too
    if (ws === 'logs' || ws === 'fleet' || ws === 'control' || ws === 'voxvision' || ws === 'tools') this.readTab(ws);
  }

  // ── the process table (R10 H163; the turn-holds latency, the lead's item (e)) ─────

  /**
   * `fn` (a reading) against the process table as last read, running no program: a writer the table does not list that
   * started before it was read is gone (its pid is another process's now), one that started after is unknown (taken as running)
   * until the next table (src/ops/process-proof.ts writerState). Before the first table: the start's own readings read the
   * table as before, once each; a tick reads against an empty table as of the Workbench's start (nothing it cannot see runs).
   * A reading that looked a pid up has the table read again, without blocking (readTable): what the new one says is applied
   * when it arrives.
   */
  private withTable<T>(fn: () => T): T {
    const table = this.table ?? (this.inTick ? { rows: new Map<number, number>(), at: this.startedAt } : null);
    if (!table) { this.readTable(); return withProcessTable(fn); }
    const seen = new Set<number>();
    try { return withProcessTable(fn, table, seen); } finally {
      for (const pid of seen) this.looked.add(pid);
      if (seen.size) this.readTable();
    }
  }

  /** A tick's work (the tick, the slow reading): read against the table as last read, never a program (withTable). */
  private ticked(fn: () => void): void {
    const was = this.inTick;
    this.inTick = true;
    try { fn(); } finally { this.inTick = was; }
  }

  /**
   * The process table read again by a child process the event loop does not wait on, one reading at a time. When it says
   * something else of a pid a reading looked up (its process ended, started, or is another one now), what those readings
   * decided is read again with it (the journey, Studio's cards, the Control tab, the workspace frame) and the screen drawn.
   */
  private readTable(): void {
    if (this.tableReading || this.disposed) return;
    this.tableReading = true;
    void readProcessTable().then((t) => {
      this.tableReading = false;
      if (this.disposed) return;
      const was = this.table;
      this.table = t;
      const differs = (pid: number): boolean => {
        const a = was ? startIn(was, pid) : undefined;
        const b = startIn(t, pid);
        return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > START_SLACK_MS : a !== b;
      };
      if (![...this.looked].some(differs)) return;
      this.looked = new Set();
      this.readJourney(this.chain());
      this.refreshCards();
      if (this.ui.workspace === 'control') this.readTab('control');
      this.refreshFrame();
      this.emit();
    });
  }

  // ── timers ────────────────────────────────────────────────────────────────────

  start(): void {
    void this.loadProducers();
    // R6 (H141): the chat-turn holds, watched from now on
    this.holds.start();
    const tick = this.d.tickMs ?? 1000;
    const slow = this.d.slowMs ?? 5000;
    this.timers.push(setInterval(() => this.onTick(), tick));
    // R5 (H131): the workspace frame with the slow reading too (at most once a second; the same revision draws nothing again)
    this.timers.push(setInterval(() => { this.ticked(() => this.readAll()); this.refreshFrame(); this.emit(); }, slow));
    this.loadFor(this.ui.workspace);
    if (this.d.interactive) {
      const s = this.ui.settings.settings;
      if (s.openCompanionAtStart) void this.showCompanion('at startup (Quick settings)');
      if (s.openStudioAtStart) void this.showStudio('at startup (Quick settings)');
    }
  }

  private onTick(): void { this.ticked(() => this.withTable(() => this.onTickNow())); }
  private onTickNow(): void {
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
      // R6 (H141; REMAINING-DEFECTS #31): and Studio's cards, which Home's preview and Studio draw: read once when first shown,
      // they said a workflow was "not run yet" above LAST RUN's "completed" for the same run
      this.refreshCards();
      // R10 (H167): and the project's recent work (Home's list): a run that started, moved or ended is said there at once
      this.readJourney(this.chain());
    }
    if (sig !== this.signature || ticking || (this.ui.flash && this.now() - this.ui.flash.at < 7000)) { this.signature = sig; this.emit(); }
  }

  /**
   * R6 (H141; the interaction review of a77d80d, defect 3): the project's chat-turn holds differ from the last reading: a turn
   * began or ended in another process. The run line, Stop current and the chat's actions follow at once (src/workbench/hub.ts
   * chatTurnNow reads the holds when they are no older than the frame); a hold let go is a turn that has ended, its receipt
   * sealed by then, so the turns, the conversation and the pipeline are read again for its end; the frame follows (at most
   * once a second).
   */
  private onHolds(r: HoldsReading): void {
    if (this.disposed || !sameFolder(r.root, this.data.project.root)) return;
    const before = this.data.holds;
    const shown = chatTurnNow(this.data);
    this.data.holds = r;
    if ((before?.turns ?? []).some((t) => !r.turns.some((x) => x.id === t.id))) {
      const root = this.data.project.root;
      try { this.data.turns = readTurns(this.chain(), root); } catch { /* the next reading */ }
      this.data.chat = readChatTail(root);
      this.readPipeline();
      // R10 (H167): the turn that ended is Home's newest recent work at once
      this.readJourney(this.chain());
      // R7 (H150; H148's N3): another surface's turn has ended while a message waits in the composer: said at once, so the
      // screen never keeps saying a turn is being answered beside RUNNING NOW (0)
      if (shown && !shown.mine && !chatTurnNow(this.data) && this.ui.input.field === 'composer' && this.ui.input.text.trim()) {
        this.say(`The chat turn in ${shown.where} has ended: Enter sends what you typed.`, 'secondary');
      }
    }
    if (this.ui.workspace === 'control') this.readTab('control');
    this.emit();
    // the frame's reading (a heavy one) a moment later, so the run line is drawn first
    const t = setTimeout(() => this.refreshFrame(), 40);
    t.unref?.();
  }

  /** R6 (H141): the holds read now, before a key that acts on a turn answers (x, Enter on Stop the turn). */
  private holdsNow(): void {
    this.data.holds = this.holds.readNow();
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
    this.rememberPending();
    // a box nobody can answer any more is denied (deny is the default); a message being sent is stopped
    if (this.ui.overlay?.kind === 'needs-you') this.ui.overlay.answer('deny');
    this.turnAbort?.abort();
    this.disposed = true;
    this.holds.close();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.frameRead.timer) { clearTimeout(this.frameRead.timer); this.frameRead.timer = null; }
    this.d.studio.close();
  }

  // ── the frame ─────────────────────────────────────────────────────────────────

  /** R10 (H167): the chat session is on its way (being looked for, or opening for this project), not refused. */
  private chatOpening(): boolean {
    if (!this.chatOf) return true;
    if (!this.chatOf.ok) return false;
    const chat = this.chat?.root === this.data.project.root ? this.chat : null;
    return !chat || chat.state === 'opening';
  }

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
    if (this.ui.workspace === 'chat') { void this.openChat(); void this.loadModels(); }
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
    // R10 CHAT (H167): the Chat screen's shell has no workflow actions row: the keyboard is on the conversation there
    if (f.layout.shell === 'chat' && this.ui.focus === 'top') this.ui.focus = 'center';
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
    // R10 (H167; H168's F2): Home's list, until the person moves in it, selects its newest work, else the connection the ready
    // route uses: never a connection not set up while a route is ready
    if (this.ui.workspace === 'connections' && !this.ui.chosen?.['center:connections']) this.ui.cursor['center:connections'] = homeDefault({ data: this.data, now: this.now() });
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
    // R6 (H141): with a key log (run.ts, under TIMMY_WORKBENCH_KEYLOG), each key is one line of it: what arrived, the box and
    // the field it met, and what took it. Made to find why CI's slice B `a` did not expand Activity (it was taken, and collapsed
    // an Activity remembered expanded: rememberPending)
    const log = this.d.keyLog;
    if (!log) { this.takeKey(input, k); return; }
    const before = { overlay: this.ui.overlay?.kind ?? null, field: this.ui.input.field, activity: this.ui.activityOpen };
    const took = this.takeKey(input, k);
    // (what is typed into a field is said by its length only: a message or a name is not written to the log)
    const said = before.field && !k.return && !k.escape ? `(${[...input].length} characters)` : input;
    log({ input: said, key: Object.keys(k).filter((n) => k[n as keyof Key] === true), ...before, took, ...(this.ui.activityOpen !== before.activity ? { activityNow: this.ui.activityOpen } : {}) });
  }

  /** What a key does here; it says what took it (the key log's words). */
  private takeKey(input: string, k: Partial<Key>): string {
    // R6 (H141): once the Workbench is ending, a key acts on nothing (it is read, so it is not left for the shell either)
    if (this.disposed) return 'nothing: the Workbench is ending';
    // R9 (H161): a key pressed: an answer held on the controls row gives way to whatever is said from now on
    this.keySeq++;
    // R10 (H167): a terminal's late answers to the colour probe (src/term/probe.ts asks for OSC 11 and OSC 4 colours, then
    // DA1, and listens 200 ms) are never keys, in a box, a field or anywhere. Under load they came after that wait, and Ink
    // handed them on as typed text: "4;7;rgb:c0c0/c0c0/c0c0" was taken as 4, 7, r, g… (a tab, another tab, a reading, the
    // navigation) up to its c; in a field it would have been typed into it
    if (!k.ctrl && TERMINAL_REPLY.test(input)) return 'a terminal\'s late answer to the colour probe: not a key';
    const o = this.ui.overlay;
    // a NEEDS YOU box takes every key until it is answered; Ctrl+C denies it (a second Ctrl+C then quits)
    if (o?.kind === 'needs-you') return `the NEEDS YOU box: ${this.needsYouKey(o, input, k)}`;
    if (k.ctrl && input === 'c') { void this.quit(); return 'Ctrl+C: quit'; }
    if (o?.kind === 'quit') { if (k.escape) { this.ui.overlay = null; this.emit(); return 'the quit box: Esc closed it'; } return 'the quit box: not its key'; }
    // R4 (H112; found in tmux under load): keys that arrive together reach Ink as one chunk, and Ink takes a chunk with a
    // carriage return in it for text: "Workflows\r" lost its Enter, and two quick Enters ("\r\r") did nothing at all. A
    // chunk of text followed by Enters is that text, then each Enter (one press each: a second Run is refused by its own
    // guard). In the composer the Enter is not taken: what leaves this computer is sent only by an Enter of its own.
    const chunk = !k.ctrl && !k.meta && input.length > 1 ? /^([^\x00-\x1f\x7f]*)(\r+)$/.exec(input) : null;
    if (chunk && this.ui.input.field !== 'composer' && (chunk[1] === '' || this.ui.input.field || chunk[1].startsWith('/'))) {
      if (chunk[1]) this.key(chunk[1], {});
      for (let i = 0; i < chunk[2].length; i++) this.key('\r', { return: true });
      return 'keys that arrived together: the text, then each Enter';
    }
    if (this.ui.input.field) { const field = this.ui.input.field; this.typing(input, k); return `the field ${field}`; }
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
          return `keys that arrived together, taken up to ${ch}`;
        }
        this.key(ch === '\t' ? '' : ch, ch === '\t' ? { tab: true } : {});
      }
      return 'keys that arrived together, each in turn';
    }
    // R4 (H112): what the key acts on is the item the person sees selected, wherever the records have moved it since
    this.reselect();
    if (o && this.overlayKey(o, input, k)) return `the box ${o.kind}`;
    if (k.escape) { this.escape(); return 'Esc'; }
    if (k.tab) { this.cycleFocus(k.shift ? -1 : 1); return 'Tab'; }
    if (k.upArrow || (!k.ctrl && input === 'k')) { this.move(-1); return 'up'; }
    if (k.downArrow || (!k.ctrl && input === 'j')) { this.move(1); return 'down'; }
    if (k.pageUp) { this.move(-this.page()); return 'PgUp'; }
    if (k.pageDown) { this.move(this.page()); return 'PgDn'; }
    // Home and End: the first or last tab of the right dock (as the reference's tabs), else the first or last row (End on
    // Activity follows its newest again)
    if (k.home || k.end) {
      if (this.ui.focus === 'right') { this.ui.tab = RIGHT_TABS[k.home ? 0 : RIGHT_TABS.length - 1]; this.remember(); this.emit(); } else this.move(k.home ? -1e6 : 1e6);
      return k.home ? 'Home' : 'End';
    }
    if (k.leftArrow) { this.side(-1); return 'left'; }
    if (k.rightArrow) { this.side(1); return 'right'; }
    if (k.return) { void this.enter(); return 'Enter'; }
    // R4 lead: keys typed quickly can arrive as one chunk ("/Control" over a busy terminal or SSH): a chunk that starts with
    // the search key opens the search with the rest as its text. Any other chunk of several characters is not taken as
    // keys (a paste never presses x, Stop, or any other key here).
    if (input.length > 1 && input.startsWith('/') && !k.ctrl && !k.meta) { this.search(); this.typing(input.slice(1), {}); return 'the search, the rest typed into it'; }
    // R10 CHAT (H167): M gives the keyboard to Models (on the Chat screen; its drawer where it does not fit), Esc gives it back
    if (input === 'M' && this.chatShell()) { this.focusModels(); return 'M: Models'; }
    // R5 (H131): 1 to 9, then 0: the ten tabs (no field has the keyboard here: a field took the key above)
    if (!k.ctrl && !k.meta && /^[0-9]$/.test(input)) {
      const t = tabByKey(input);
      if (t) { this.selectPage(t.id); return `tab ${input}`; }
    }
    switch (input) {
      case '?': this.open({ kind: 'help' }); break;
      case 'p': this.openPicker(); break;
      case 'n': this.openNew(); break;
      case '/': this.search(); break;
      case 'c': void this.showCompanion(); break;
      case 's': void this.showStudio(); break;
      case 'C': void this.d.companion.stopServing().then((w) => this.say(inWords(w))); break;
      case 'S': void this.d.studio.stopServing().then((w) => this.say(inWords(w))); break;
      case ',': this.open({ kind: 'settings' }); break;
      case 'x': void this.stop(); break;
      case 'i': this.toggleRight(); break;
      case 'g': this.toggleNav(); break;
      case 'z': this.ui.focusMode = !this.ui.focusMode; this.ui.navOpen = false; this.ui.rightOpen = false; this.ui.focus = 'center'; this.emit(); break;
      case 'a': this.ui.activityOpen = !this.ui.activityOpen; this.remember(); this.emit(); break;
      case 'A': this.ui.activityAll = !this.ui.activityAll; this.emit(); break;
      case 'f': this.ui.related = !this.ui.related; this.emit(); break;
      case 'r': this.refresh(); break;
      case 'm': this.toggleMouse(); break;
      default: return 'no key here';
    }
    return `the key ${input}`;
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
    // R10 CHAT (H167): Esc on Models gives the keyboard back to where it was (and closes its drawer)
    if (!this.ui.overlay && this.chatShell() && this.ui.focus === 'right' && !this.ui.rightOpen) {
      const from = this.ui.modelsFrom;
      delete this.ui.modelsFrom;
      this.ui.modelsOpen = false;
      this.ui.focus = from && from !== 'right' ? from : 'center';
      this.emit();
      return;
    }
    if (this.ui.overlay) this.ui.overlay = null;
    else if (this.ui.rightOpen) { this.ui.rightOpen = false; this.ui.focus = this.backFromRight(); }
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
    if (region === 'right' && this.chatShell() && !this.ui.rightOpen) return 'right:models';
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
    // R10 CHAT (H167): the rail's cursor moves without opening anything (Enter opens); the controls row moves along its controls
    if (this.chatShell() && region === 'nav') {
      this.ui.cursor.rail = Math.max(0, Math.min(RAIL_ITEMS.length - 1, (this.ui.cursor.rail ?? RAIL_ITEMS.indexOf('chat')) + delta));
      this.emit();
      return;
    }
    if (this.chatShell() && region === 'bottom') {
      this.ui.cursor.shellBottom = Math.max(0, Math.min(shellControls({ data: this.data }).length - 1, (this.ui.cursor.shellBottom ?? 0) + delta));
      this.emit();
      return;
    }
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
    // R6 (H141; the interaction review of a77d80d, defect 6): a box with no rows to select (the Keys list, a message) scrolls by
    // the keys it lists, as the wheel scrolls it: ↑ ↓ (k j) a row, PgUp PgDn a page, Home End to its first or last rows; its
    // title says which rows it shows (a–b of n)
    if (region === 'center' && this.ui.overlay && !this.itemsNow('center')?.length) {
      const d = this.last?.regions.center;
      if (d) this.wheel('center', d, delta);
      return;
    }
    const list = this.listOf(region);
    // R4 (H112): the selection is the item moved to (by its key, src/workbench/select.ts); the wheel's view is let go
    const items = this.itemsNow(region);
    const n = items?.length ?? this.itemsOf(region);
    // R9 (H160): Context's tab with no rows to select (the Inspector: a mesh's measurements under the Unfinished words) scrolls
    // by the keys, as a box with no rows does above
    if (!n && region === 'right' && this.last?.regions.right) { this.wheel('right', this.last.regions.right, delta); return; }
    if (!n) return;
    // R5 (H137): a view that lays its items out as a grid names where ↑ and ↓ move from each (View items' `near`)
    const near = Math.abs(delta) === 1 ? items?.[this.ui.cursor[list] ?? 0]?.near : undefined;
    const at = Math.max(0, Math.min(n - 1, (delta > 0 ? near?.down : near?.up) ?? (this.ui.cursor[list] ?? 0) + delta));
    if (items) select(this.ui, list, items, at); else { this.ui.cursor[list] = at; delete this.ui.wheel[list]; }
    // Activity follows its newest while the newest is selected, and is held where the person moved otherwise
    if (region === 'bottom') this.ui.activityFollow = at === n - 1;
    this.emit();
  }

  /** R4 (H112): a region's selectable items as they are now (the center's, the right tab's, Activity's). */
  private itemsNow(region: Region): View['items'] | null {
    const c = this.ctx();
    if (region === 'right' && this.chatShell() && !this.ui.rightOpen) return this.last?.regions.right?.items ?? [];
    if (region === 'center') return centerView(c).items;
    if (region === 'right') return this.hubColumn() ? [] : rightView(c).items;
    if (region === 'bottom') return bottomView(c).items;
    return null;
  }

  private side(dir: 1 | -1): void {
    // R10 CHAT (H167): on Models, ← → choose the provider (OpenRouter, Ollama, Cloudflare); on the controls row, the control
    if (this.chatShell() && this.ui.focus === 'right' && !this.ui.rightOpen) {
      const order = ['openrouter', 'ollama', 'cloudflare'] as const;
      const at = order.indexOf(railProvider({ ui: this.ui, data: this.data }));
      this.ui.modelsProvider = order[Math.max(0, Math.min(order.length - 1, at + dir))];
      delete this.ui.cursor['right:models'];
      if (this.ui.modelsProvider === 'ollama') void this.loadModels();
      this.emit();
      return;
    }
    if (this.chatShell() && this.ui.focus === 'bottom') { this.move(dir); return; }
    if (this.chatShell() && this.ui.focus === 'nav') { if (dir === 1) { this.ui.focus = 'center'; this.emit(); } return; }
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
    if (this.ui.focus === 'nav' && dir === 1) { this.ui.focus = 'center'; this.emit(); return; }
    // R5 (H137): ← → inside a row of a view that lays its items out as a grid (View items' `near`); elsewhere they move nothing
    if (this.ui.focus === 'center') {
      const list = this.listOf('center');
      const items = this.itemsNow('center');
      const to = items?.[this.ui.cursor[list] ?? 0]?.near?.[dir > 0 ? 'right' : 'left'];
      if (items && to !== undefined) { this.ui.follow = null; select(this.ui, list, items, to); this.emit(); }
    }
  }

  // ── R10 CHAT (H167): the Chat screen's shell ──────────────────────────────────

  /** The last frame was the Chat screen's shell (src/workbench/chat-shell.ts). */
  private chatShell(): boolean { return this.last?.layout.shell === 'chat'; }

  /** M: Models has the keyboard (its drawer opened where it does not fit); Esc gives it back to the zone that had it. */
  private focusModels(): void {
    if (this.ui.focus !== 'right') this.ui.modelsFrom = this.ui.focus;
    this.ui.rightOpen = false;
    this.ui.modelsOpen = true;
    this.ui.focus = 'right';
    void this.loadModels();
    this.emit();
  }

  /** What Models lists: OpenRouter's catalog from files (the one this computer fetched, else the snapshot shipped with Timmy:
   *  no request), once; what the local Ollama lists (one request to it, no model run), when its section is shown. */
  private modelsAsked = { catalog: false, ollama: false };
  async loadModels(force = false): Promise<void> {
    const m: RailModels = (this.data.models ??= {});
    if (!this.modelsAsked.catalog && this.setup.catalog) {
      this.modelsAsked.catalog = true;
      try { const c = await this.setup.catalog(); m.openrouter = { from: c.from, at: c.at, rows: railCatalog(c.models as Parameters<typeof railCatalog>[0]) }; } catch { m.openrouter = { from: 'none', at: null, rows: [] }; }
      this.emit();
    }
    const wantsOllama = railProvider({ ui: this.ui, data: this.data }) === 'ollama' || this.data.route.kind === 'local';
    if (wantsOllama && (force || !this.modelsAsked.ollama)) {
      this.modelsAsked.ollama = true;
      m.ollama = { state: 'reading', where: m.ollama?.where ?? 'Ollama', rows: m.ollama?.rows ?? [] };
      this.emit();
      try {
        const list = await this.setup.ollama();
        m.ollama = list.answered
          ? { state: 'listed', where: list.where, rows: ollamaRows(list.models), at: new Date(this.now()).toISOString(), cloud: list.cloud }
          : { state: 'failed', where: list.where, rows: [], at: new Date(this.now()).toISOString(), ...(list.why ? { why: list.why } : {}) };
      } catch (e) { m.ollama = { state: 'failed', where: 'Ollama', rows: [], why: e instanceof Error ? e.message : String(e) }; }
      this.emit();
    }
  }

  /** Enter on the rail: the project selector lists projects (Home is one key away there), New project, or the menu's item: the
   *  existing workspace as it is today. */
  private openRail(id: string): void {
    if (id === 'project') { this.openPicker(); return; }
    if (id === 'new') { this.openNew(); return; }
    const r = RAIL.find((x) => x.id === id);
    if (!r) return;
    if (r.id === 'chat') { this.ui.focus = 'center'; this.emit(); return; }
    if (r.ws) this.selectWorkspace(r.ws); else this.selectPage(r.page);
    this.ui.focus = 'center';
    this.emit();
  }

  /** Enter on a model of the rail: the next turn's model. A local one through the setup's writer (as Choose the local model
   *  does, saying what changed); an OpenRouter one needs the OpenRouter route (its key), said so; the turn in flight keeps its
   *  route either way, and the draft stays. */
  private async chooseFromRail(): Promise<void> {
    const { rows, source } = modelRows({ ui: this.ui, data: this.data });
    const r = rows[this.ui.cursor['right:models'] ?? 0];
    if (!r) { this.say('No model is listed here to choose.', 'secondary'); return; }
    if (source === 'ollama-local') { await this.chooseLocal(r.id); return; }
    if (this.data.route.kind !== 'openrouter') { this.say(`${r.name} runs on OpenRouter: Connect OpenRouter first (its key); the next turn stays on the route it has.`, 'secondary'); return; }
    try { await this.setup.saveModel(r.id); this.data.route = readRoute(this.d.env); this.say(`The next turn goes to ${r.id} on OpenRouter (${r.price.free === true ? 'free' : 'its price as the catalog says'}); a turn being answered keeps its route.`, 'secondary'); } catch (e) { this.say(`Not saved: ${e instanceof Error ? e.message : String(e)}`, 'failure'); }
    this.emit();
  }

  /** Enter on a control of this conversation: what it opens or does (each backed by a capability; else what it needs). */
  private async shellControl(id: string): Promise<void> {
    const k = shellControls({ data: this.data }).find((x) => x.id === id);
    if (k && !k.on) { this.say(`${k.label}: needs ${k.needs ?? 'what it names'}.`, 'secondary'); return; }
    switch (id) {
      case 'tools': this.selectPage('tools'); this.ui.focus = 'center'; break;
      case 'plan': this.selectPage('workflows'); this.ui.focus = 'center'; break;
      case 'approvals': this.selectPage('control'); this.ui.focus = 'center'; break;
      case 'logs': this.selectPage('logs'); this.ui.focus = 'center'; break;
      case 'stop': await this.stop(); return;
      case 'cloudflare': this.ui.modelsProvider = 'cloudflare'; this.focusModels(); return;
      case 'budget': this.open({ kind: 'settings' }); return;
      default: return;
    }
    this.emit();
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
    if (ws === 'chat') { void this.openChat(); void this.loadModels(); }
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
    // R10 (H167): on Home and Chat, i opens the details (the Inspector: the selected item's ids, receipt and files, then About ·
    // diagnostics), from its first row
    if (this.ui.rightOpen && isHub(this.ui.page)) { this.ui.tab = 'inspector'; this.ui.scroll['right:inspector'] = 0; delete this.ui.wheel['right:inspector']; delete this.ui.anchor['right:inspector']; }
    if (this.ui.rightOpen) {
      // R10 (H167; the lead's 12:23 finding): the zone that had the keyboard, given back when the drawer closes
      if (this.ui.focus !== 'right') this.ui.rightFrom = this.ui.focus;
      this.ui.navOpen = false;
      this.ui.focus = 'right';
    } else this.ui.focus = this.backFromRight();
    this.emit();
  }

  /** R10 (H167): where the keyboard goes as the right drawer closes: back to the zone that had it (the action strip, the
   *  workspace or Activity), else the workspace; a drawer that is shut by then (the navigation) is never given it. */
  private backFromRight(): Region {
    const from = this.ui.rightFrom;
    delete this.ui.rightFrom;
    return from === 'top' || from === 'center' || from === 'bottom' ? from : 'center';
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
      // R5 (H131; the QA round's defect 1): Esc says what it did. R10 (H167; H168's F1, High): while this Workbench's turn is
      // being answered, Esc stops that turn AND leaves the composer: the keys after it are the Workbench's again (a 1 opens a
      // tab), never the start of another message that a later Enter would send; what was typed meanwhile is not sent
      if (f === 'composer' && this.turnAbort) {
        this.turnAbort.abort();
        const typed = this.ui.input.text.trim();
        this.ui.input = { field: null, text: '' };
        // (the keyboard back where launch puts it: the workflow actions, whose one next step reopens the composer; R10 CHAT:
        // in the Chat screen's shell, the conversation, where Enter reopens it)
        this.ui.focus = this.chatShell() ? 'center' : 'top';
        delete this.ui.cursor.top;
        this.say(`Esc: stopping the chat turn being answered, and left the composer${typed ? ' (what was typed in it was not sent)' : ''}. Enter opens it again.`, 'secondary');
        this.emit();
        return;
      }
      if (f === 'composer') {
        this.say(`Esc: left the composer${this.ui.input.text.trim() ? ' (what was typed in it was not sent)' : ''}. Enter opens it again.`, 'secondary');
        // R10 (H167; H168's F1 and F2): the keyboard back on the workflow actions (their one next step reopens it), as at launch;
        // R10 CHAT (H167): in the Chat screen's shell, on the conversation (Enter reopens the composer)
        this.ui.focus = this.chatShell() ? 'center' : 'top';
        delete this.ui.cursor.top;
      }
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
      // R10 (H167): while the session is still opening (Home's next step opens the composer at once), what was typed stays in
      // the composer, and Enter sends it once the session is open: nothing is lost and nothing is sent before then
      if (why && text.trim() && this.chatOpening()) { this.say(`Not sent yet: ${why}. What you typed stays here; Enter sends it once it is open.`, 'secondary'); this.emit(); return; }
      if (why || !text.trim()) { this.ui.input = { field: null, text: '' }; if (why) this.say(`Not sent: ${why}`, 'secondary'); this.emit(); return; }
      if (this.data.turn?.state === 'sending') { this.say('One turn at a time: the chat turn is still being answered. Esc stops it, or wait for its answer.', 'secondary'); return; }
      // R7 (H150; H148's N3): one turn at a time per project, by the one answer RUNNING NOW and the run line read (the holds
      // read now): while another surface answers, what was typed stays in the composer and nothing is sent; once that turn
      // has ended, Enter sends it
      this.holdsNow();
      const other = chatTurnNow(this.data);
      if (other && !other.mine) {
        this.say(`Not sent yet: one turn at a time per project, and a turn is being answered in ${other.where}. What you typed stays here; Enter sends it once that turn has ended (RUNNING NOW 0).`, 'secondary', other.id ? { whileTurn: other.id } : {});
        this.emit();
        return;
      }
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
    const turn: NonNullable<Data['turn']> = { text, answer: '', state: 'sending', lines: [], sent: null, tools: [], at: this.now(), operation: h.id, route: routeShown(this.data).words };
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
        onText: (full) => { turn.answer = full; if (!heard) { heard = true; this.ownTurnId(turn); this.refreshFrame(); } this.emit(); },
        onTool: (e) => { turn.tools.push({ name: e.name, phase: e.phase, ...(e.outcome ? { outcome: e.outcome } : {}) }); this.emit(); },
        askPerson: (req) => this.askPerson(req),
        signal: abort.signal,
      }));
      Object.assign(turn, {
        state: r.status, answer: r.text || turn.answer, lines: r.lines ?? [], sent: r.sent, costWords: r.costWords,
        ...(r.receipt ? { receipt: r.receipt } : {}), ...(r.model ? { model: r.model } : {}),
      });
      // R7 (H150; H148's N3): refused because another turn holds the project (it began between the composer's look and the
      // send): what was typed goes back into the composer, and the holds are read, so RUNNING NOW names that turn too
      if (r.status === 'refused' && !r.sent) {
        if (this.ui.input.field === 'composer' && !this.ui.input.text) this.ui.input.text = text;
        this.holdsNow();
      }
      // (the receipt by its short id, as the Control Room and the event log name it)
      // R7 (H150; H148's N5 "Stopped: Cancelled after the request went out"; the lead's e686809): a stopped turn's line is
      // the session's own, which says "Stopped" itself, printed as it is (a session that still says "Cancelled…" is said
      // "Stopped…"); a refusal or a failure keeps its word before it
      // R10 (H167): the receipt said as sealed; its id is the inspector's ([i] on the turn in Home's recent work)
      // (R10 H167; the lead's note on the A2 captures: the receipt said as sealed, its id the details' ([i] on the turn))
      // R10 (H163; H168's F3): an answer's and a failure's in the face's words (home-journey.ts turnEndNotice): a failure what
      // happened and its next step, its address, code and commands the details' ([i] on Chat)
      this.say(r.status === 'cancelled' ? `${stoppedLine((r.lines ?? [])[0])}${r.sent || /nothing was sent/i.test((r.lines ?? [])[0] ?? '') ? '' : ' Nothing was sent to any model.'}` : turnEndNotice(r, this.d.glyphs),
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
      // R5 (H131; the operator's 22:32 order, item 1): its identity, from its sealed receipt (turn_id) when its hold was not read
      const sealed = turn.receipt ? this.data.turns.find((x) => x.receipt === receiptShort(turn.receipt!)) : undefined;
      if (sealed?.turn) turn.id = sealed.turn;
      // R5 (H131): and the pipeline shows the turn just answered; the frame no longer counts it
      this.readPipeline();
      this.refreshFrame();
      // R10 (H167): and Home's recent work lists it at once (it was the list's first item only at the next reading, so Enter on
      // Home acted on the row under it)
      this.readJourney(this.chain());
      this.emit();
    }
  }

  /** R5 (H131; the operator's 22:32 order, item 1): this Workbench's turn's identity, its hold's id (taken by the chat session
   *  before anything is sent), read while it is answered: the frame names the same id, so its end is told by identity. */
  private ownTurnId(turn: NonNullable<Data['turn']>): void {
    if (turn.id) return;
    try {
      const held = runningTurns(this.data.project.root, undefined, { readOnly: true }).filter((t) => t.mine && t.surface === 'workbench');
      if (held.length === 1) turn.id = held[0].id;
    } catch { /* not read: its receipt names it once sealed */ }
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
    // R7 (H150; H148's N3): x's box for another surface's turn: y asks it to stop there; n, Esc or Enter keep it (the default)
    if (o.kind === 'confirm-stop') {
      // (the keyboard goes back where x was pressed)
      const close = (): void => { this.ui.overlay = null; if (o.back) this.ui.focus = o.back; };
      if (input === 'y') { close(); this.askTurnStop(o.turn, 'x, then y'); this.emit(); return true; }
      if (input === 'n' || k.escape || k.return) { close(); this.say(`Kept: the chat turn in ${o.turn.where} goes on (nothing was asked of it).`, 'secondary'); this.emit(); return true; }
      return true;
    }
    if (o.kind === 'confirm-run') {
      if (k.return) { void this.runBlock(o); return true; }
      return false;
    }
    // R5 (H131; the finish line, item 3): the chat's fixes: Enter takes the selected row (the arrows and Esc as in any box)
    if (o.kind === 'free-models') {
      if (!k.return) return false;
      if (o.state === 'listed') { const m = o.catalog.models[cursorOf(this.ui, 'overlay', o.catalog.models.length)]; if (m) void this.chooseFree(m.id); }
      return true;
    }
    if (o.kind === 'local-models') {
      if (!k.return) return false;
      if (o.state === 'listed') { const m = o.list.models[cursorOf(this.ui, 'overlay', o.list.models.length)]; if (m) void this.chooseLocal(m.name); }
      else if (o.state === 'failed') void this.runCheck();
      return true;
    }
    if (o.kind === 'setup') {
      if (!k.return) return false;
      if (o.local) void this.openLocalModels();
      return true;
    }
    if (o.kind === 'help' || o.kind === 'message') return false;
    return false;
  }

  // ── R5 (H131; the finish line, item 3): the chat's fixes, done here ─────────────

  /** /model free: the free models this computer's catalog lists; Enter on one saves it as the chat's model. */
  private async openFreeModels(): Promise<void> {
    this.open({ kind: 'free-models', state: 'reading' });
    let next: Overlay;
    try { next = { kind: 'free-models', state: 'listed', catalog: await this.setup.freeModels() }; } catch (e) { next = { kind: 'free-models', state: 'failed', why: e instanceof Error ? e.message : String(e) }; }
    if (this.ui.overlay?.kind !== 'free-models') return;
    this.ui.overlay = next;
    this.ui.cursor.overlay = 0;
    this.emit();
  }

  /** Saves `id` as the chat's OpenRouter model, and says exactly what that changed and what it did not. */
  private async chooseFree(id: string): Promise<void> {
    const S = (text: string, role: Role = 'text'): Line[number] => ({ text, role });
    let saved: { path: string };
    try { saved = await this.setup.saveModel(id); } catch (e) {
      this.open({ kind: 'message', title: 'The chat\'s model', lines: [[S(`It was not saved: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`, 'failure')]] });
      return;
    }
    this.data.route = readRoute(this.d.env);
    try { this.data.journeyRoute = routeNow({ env: this.d.env, surface: 'workbench' }); } catch { /* as it was */ }
    this.refreshFrame();
    const lines: Line[] = [
      [S('Saved '), S(id, 'strong'), S(` as the chat's OpenRouter model, in Timmy's settings (${tildePath(saved.path)}).`)],
      [],
      [S('WHAT CHANGED', 'secondary')],
      [S('A chat started after this takes it: a REPL (timmy) opened from now on, and this Workbench when it starts again.')],
      [S(`The route the settings give now: ${this.data.route.words}${this.data.route.ready ? ' (ready)' : ' (not ready)'}.`)],
      [],
      [S('WHAT DID NOT', 'secondary')],
      [S('Free-only is as it was: it is never turned off from here.')],
      [S(`A REPL already running keeps its model until /model ${id} there.`)],
      [S('This Workbench\'s chat keeps the model its session was made with until the Workbench starts again: a session\'s model is not changed from here.')],
      ...(this.d.env.OPENROUTER_MODEL?.trim() ? [[S('OPENROUTER_MODEL is set in this environment, and it wins over this setting wherever it is set.', 'attention')]] : []),
      [S('Nothing was sent to any model.', 'secondary')],
    ];
    this.open({ kind: 'message', title: 'The chat\'s model', lines });
    this.say(`Saved ${id} as the chat's OpenRouter model, in Timmy's settings.`, 'secondary');
  }

  /** /model on the local route: what the configured Ollama lists now; Enter on one makes it the local chat's model. */
  private async openLocalModels(): Promise<void> {
    this.open({ kind: 'local-models', state: 'asking' });
    let list: OllamaList;
    try { list = await this.setup.ollama(); } catch (e) { list = { where: 'Ollama', answered: false, models: [], listed: 0, cloud: 0, why: `Ollama was not asked: ${e instanceof Error ? e.message : String(e)}` }; }
    if (this.ui.overlay?.kind !== 'local-models') return;
    this.ui.overlay = list.answered && list.models.length ? { kind: 'local-models', state: 'listed', list } : { kind: 'local-models', state: 'failed', list };
    this.ui.cursor.overlay = 0;
    this.emit();
  }

  /** Makes `model` the local chat's model through the setup's writer, and says what that changed and what it did not. */
  private async chooseLocal(model: string): Promise<void> {
    const S = (text: string, role: Role = 'text'): Line[number] => ({ text, role });
    const title = 'The local chat\'s model';
    if (await this.setup.blank().catch(() => false)) {
      this.open({ kind: 'message', title, lines: [[S('Timmy is not set up on this computer yet (it has no identity): timmy init, in a shell, sets it up first; then choose the local model here. Nothing was written.', 'attention')]] });
      return;
    }
    let written: string[];
    try { written = (await this.setup.setLocal(model)).written; } catch (e) {
      this.open({ kind: 'message', title, lines: [[S(`Nothing was written: ${e instanceof Error ? e.message : String(e)}.`, 'failure')]] });
      return;
    }
    this.data.route = readRoute(this.d.env);
    try { if (this.chat?.state === 'open' && this.chat.root === this.data.project.root) this.data.chatRoute = this.chat.session.route(); } catch { /* as it was */ }
    try { this.data.journeyRoute = routeNow({ env: this.d.env, surface: 'workbench' }); } catch { /* as it was */ }
    this.refreshFrame();
    const lines: Line[] = [
      [S('The chat is set to the local model '), S(model, 'strong'), S(', as the setup\'s answer (written as timmy init --chat local --model writes it).')],
      ...(written.length ? [[S(`Written: ${written.map((w) => tildePath(w)).join(', ')}.`, 'secondary')]] : []),
      [],
      [S('WHAT CHANGED', 'secondary')],
      [S('The chat reads its route at each message, so its next one takes it: here, and in a REPL already running.')],
      [S(`The route as read now: ${this.data.route.words}${this.data.route.ready ? ' (ready)' : ' (not ready)'}.`)],
      [],
      [S('WHAT DID NOT', 'secondary')],
      [S('A REPL whose /model chose a model for its session keeps that one there.')],
      ...(this.d.env.TIMMY_CHAT_MODEL?.trim() ? [[S('TIMMY_CHAT_MODEL is set in this environment, and it wins over the setup\'s answer wherever it is set.', 'attention')]] : []),
      [S('Nothing was downloaded and nothing was sent to any model: Ollama was asked for its list only.', 'secondary')],
    ];
    this.open({ kind: 'message', title, lines });
    this.say(`The local chat's model is now ${model} (the setup's answer).`, 'secondary');
  }

  /** timmy workspace check, in this process: free requests only; what it asked and what answered, then the frame again. */
  async runCheck(): Promise<void> {
    const S = (text: string, role: Role = 'text'): Line[number] => ({ text, role });
    const title = 'The connections, checked';
    const since = Date.now() - 1;
    this.open({ kind: 'message', title, lines: [[S('Asking each one once, with short timeouts: free requests only, no model called…', 'secondary')]] });
    let res: Awaited<ReturnType<SetupDeps['check']>>;
    try { res = await this.setup.check(); } catch (e) {
      if (this.ui.overlay?.kind === 'message' && this.ui.overlay.title === title) this.ui.overlay = { kind: 'message', title, lines: [[S(`The check did not finish: ${e instanceof Error ? e.message : String(e)}. Nothing was recorded.`, 'failure')]] };
      this.emit();
      return;
    }
    this.refreshFrame();
    const rows = checkRows(res.record, since);
    const asked = rows.filter((r) => !r.words.startsWith('not asked'));
    const lines: Line[] = [
      [S('Checked just now, with free requests only: no model was called and nothing was spent.', 'secondary')],
      [],
      ...rows.map((r): Line => [S(`${r.name}  `, 'strong'), S(r.words, r.answered ? 'text' : 'secondary')]),
      [],
      // R10 (H167; H168's F3 and F13): where it is recorded is the details' ([i])
      [S('Recorded. Home\'s connection rows say these now; a row is live only for an answer seen in the last 30 minutes.', 'secondary')],
    ];
    if (this.ui.overlay?.kind === 'message' && this.ui.overlay.title === title) this.ui.overlay = { kind: 'message', title, lines };
    this.say(`Checked the connections: ${asked.filter((r) => r.answered).length} of ${asked.length} asked answered (free requests only).`, 'secondary');
  }

  /** timmy init …, timmy setup, /setup chat: the setup is a shell's (a key is typed there, hidden); what it asks now. */
  private async openSetup(which: 'init' | 'chat', command: string): Promise<void> {
    let plan: SetupPlan = { asks: null, keyFrom: null };
    let blank: boolean | null = null;
    try { blank = await this.setup.blank(); } catch { /* unknown: nothing that needs the setup to have run is offered */ }
    try { plan = await this.setup.setupPlan(command); } catch { /* what it asks is then said to be unknown */ }
    // a local model is offered here only where it can be chosen honestly: never before the setup ran (its writer would make an
    // identity); for `timmy init --chat local …` always (Ollama is asked on Enter); otherwise where Ollama answered with models
    // (the check accepts only an answer with one)
    const ollama = this.data.frame?.connections.find((x) => x.id === 'ollama');
    const local = which === 'init' && blank === false && (/--chat local\b/.test(command) || ollama?.state === 'live');
    this.open({ kind: 'setup', which, command, asks: plan.asks, keyFrom: plan.keyFrom, local, blank: blank === true });
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
    this.keySeq++; // R9 (H161): the person acted: a held answer gives way
    const o = this.ui.overlay;
    // (the key log, R6 H141: a paste is one line of it too, its length only)
    this.d.keyLog?.({ paste: text.length, overlay: o?.kind ?? null, field: this.ui.input.field, took: o?.kind === 'needs-you' ? 'the NEEDS YOU box: denied' : this.ui.input.field ? `the field ${this.ui.input.field}` : 'nothing: said so' });
    if (o?.kind === 'needs-you') { o.answer('deny'); return; }
    if (this.ui.input.field) { this.typing(text.replace(/\r\n|\r|\n/g, ' '), {}); return; }
    this.say('Pasted text is taken only into a field (the composer, a search, a name): nothing was done with it.', 'secondary');
  }

  private needsYouKey(o: Extract<NonNullable<Overlay>, { kind: 'needs-you' }>, input: string, k: Partial<Key>): string {
    // Ctrl+C denies; so does a paste, whatever it holds (a pasted y never approves)
    if ((k.ctrl && input === 'c') || (!k.ctrl && !k.meta && input.length > 1)) { o.answer('deny'); return 'denied (Ctrl+C, or keys that came together)'; }
    if (this.now() - o.since < (this.d.guardMs ?? GUARD_MS)) return 'within its type-ahead guard: no answer';
    if (input === 'y') { o.answer('once'); return 'allowed once'; }
    if (input === 'a' && o.req.session !== false) { o.answer('session'); return 'allowed for this session'; }
    if (input === 'n' || k.escape || k.return) { o.answer('deny'); return 'denied'; }
    return 'not one of its keys';
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
    // R9 (H161; R8's M): runningNow keeps the earlier reading's run when the fresh one cannot see that job; the refusal is the
    // answer to this key, so a notice of something else does not take its place on the controls row (say's answer)
    const going = this.runningNow(o.doc, o.block);
    if (going) { this.say(`Not started: ${going.words}.`, 'secondary', { answer: true, ...(going.job?.operation ? { operation: going.job.operation } : {}) }); return; }
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
   *  every 1.5 s (a run of arrow keys is one write), and at once before another project is shown and as the Workbench ends
   *  (rememberPending). */
  private remember(): void {
    if (!this.ui.settings.settings.rememberLayout || this.rememberTimer) return;
    this.rememberTimer = setTimeout(() => { this.rememberTimer = null; this.rememberNow(); }, 1500);
    this.rememberTimer.unref?.();
  }

  /**
   * R6 (H141; CI's workbench-pty slice B at 3b6a5b6 and after, as at bfb7fe5, 94e0c01, 0cbadd0 and aa247e5): a layout change
   * not written yet is written now, for the project it was made in. Before, a change made within 1.5 s of a project switch
   * was written when its timer fired, under the project shown by then: the project left kept the layout from before its last
   * change (slice A's Activity, expanded then collapsed, came back expanded, so slice B's `a` collapsed it), and the project
   * switched to was given the other's.
   */
  private rememberPending(): void {
    if (!this.rememberTimer) return;
    clearTimeout(this.rememberTimer);
    this.rememberTimer = null;
    this.rememberNow();
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
    this.d.keyLog?.({ event: r.ok ? 'layout remembered' : `layout not remembered: ${r.error}`, project: this.data.project.name, ...next });
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
    // R6 (H141): the layout of the project left, as it is now, is its own (written before another project is shown)
    this.rememberPending();
    this.data = { ...this.emptyData(projectView(p, this.d.env)), caps: this.data.caps, starters: this.data.starters, boards: this.data.boards };
    this.chainCache = null;
    this.ui.follow = null;
    if (this.ui.workspace === 'chat') { void this.openChat(); void this.loadModels(); }
    this.ui.cursor = {};
    this.ui.scroll = {};
    // R4 (H112): another project's lists: nothing of this one's selection, anchors or wheel is kept (Activity keeps following)
    this.ui.sel = {};
    this.ui.anchor = {};
    this.ui.wheel = {};
    this.ui.chosen = {};
    this.ui.toolsQuery = '';
    const remembered = this.ui.settings.settings.rememberLayout ? this.ui.settings.settings.layouts[this.data.project.id] : undefined;
    if (remembered) { this.ui.tab = remembered.tab; this.ui.activityOpen = remembered.activity; }
    // R10 (H167; H168's F2 and F11): another project opens on the tab shown, with the keyboard where launch puts it: the
    // workflow actions, their one next step selected (Enter does what the screen says first; a list row the person never
    // chose, such as a connection not set up, is not what Enter acts on). Its last tab is one key away (1 to 0)
    this.ui.focus = 'top';
    this.ui.overlay = null;
    this.d.keyLog?.({ event: `now in ${p.name}: ${why}`, activity: this.ui.activityOpen });
    // R5 (H131): another project's frame: the last one is not shown for it (its actions and log are the other project's)
    delete this.ui.cursor.top;
    this.readAll();
    this.refreshFrame();
    this.loadFor(this.ui.workspace);
    // R4 (H112): this Workbench's runs elsewhere go on, named with where they run
    // R10 (H167; H168's F3): said by names (its folder and the jobs' ids are the details', [i])
    const away = this.data.away.filter((j) => j.live).map((j) => `${j.label} keeps running in ${j.project}`);
    this.say(`Now in ${p.name}: ${why}. The REPL, the monitor and Studio follow the same record; a running job keeps its own project${away.length ? `: ${away.join('; ')}. Stop still names it` : ''}.`);
  }

  // ── the servers ───────────────────────────────────────────────────────────────

  async showCompanion(why = '', where?: string): Promise<void> {
    this.say(`Companion · Show${why ? ` ${why}` : ''}: starting it on this computer if this Workbench has none…`, 'secondary');
    const q = where ?? this.companionWhere();
    const w = await this.d.companion.show(q);
    // R10 (H167; H168's F3 and F5): what opened, in words ("Opened in the companion: demo-tray.stl in 3D & Motion"); its
    // address and the companion's own words are the details' ([i]: About · diagnostics, Companion)
    this.say(handoffWords('companion', w, companionWhat(q, why)), /did not start|failed/.test(w) ? 'failure' : 'text');
  }

  /**
   * R6 (H141; the lead's ask, after 66a1323): where Companion · Show opens the page: on the tab shown here (the page has the same
   * ten tabs, by the same ids), and from tab 5 on the VoxVision record selected there (H143's vox=<id>, which the page's
   * VoxVision panel opens).
   */
  /**
   * R10 (H167): Enter on an item of Home's recent work opens it where it belongs: a run on 3 Workflows (its progress, result and
   * receipt), an observation on 5 VoxVision, a chat turn on 2 Chat, what waits on you where it is answered (7, or 4 Studio for a
   * draft), a text result in Files; an image or a mesh, which a terminal cannot draw, in the companion (as c). The item is
   * selected there, so the place opened shows it.
   */
  private async openWork(w: WorkItem): Promise<void> {
    if (w.opens.show) { await this.showCompanion(`for ${w.title}`, w.opens.companion); return; }
    const t = w.opens;
    if (t.select) {
      this.ui.sel[t.select.list] = t.select.key;
      (this.ui.chosen ??= {})[t.select.list] = true;
      delete this.ui.wheel[t.select.list];
      delete this.ui.anchor[t.select.list];
    }
    if (t.ws) { (this.ui.pageWs ??= {})[t.page] = t.ws; }
    this.selectPage(t.page);
    if (t.ws && this.ui.workspace !== t.ws) this.selectWorkspace(t.ws);
    this.ui.focus = 'center';
    this.reselect();
    this.say(`${w.title}: ${t.words.replace(/^opens/, 'opened')}.`, 'secondary');
    this.emit();
  }

  private companionWhere(): string {
    // R10 (H167): from Home, on the item of recent work selected there (a run's detail, an observation, a mesh)
    if (this.ui.page === 'home' && this.ui.workspace === 'connections') {
      const sel = this.selected();
      if (sel?.kind === 'work') return sel.work.opens.companion;
    }
    // R9 (H160): from tab 6, on the mesh selected there (mesh=<its path as hex>, which the page's tab 6 chooses)
    if (this.ui.page === 'create') return createCompanionHint(this.selected());
    // R10 (H167; H168's F4 and F5): from tab 3, on the selected block's newest run (H164's openTarget: its run detail)
    if (this.ui.page === 'workflows') {
      const op = this.data.workflowsTab?.run?.operation;
      if (op) return openTarget({ kind: 'run', id: op }).query;
    }
    // (R10 H167; H168's F5: from tab 5 on the record selected there, as H164's openTarget names an observation)
    const sel = this.ui.page === 'voxvision' ? this.selected() : null;
    if (sel?.kind === 'vox-record') return openTarget({ kind: 'observation', id: sel.row.card.id }).query;
    return `tab=${this.ui.page}`;
  }

  async showStudio(why = ''): Promise<void> {
    this.say(`Studio · Show${why ? ` ${why}` : ''}: as the REPL's canvas opens it…`, 'secondary');
    const w = await this.d.studio.show();
    // R10 (H167; H168's F3): in words ("Opened Studio: it shows tray."); its address is the details' ([i])
    this.say(handoffWords('studio', w, ''), /not running|does not answer/.test(w) ? 'failure' : 'text');
  }

  // ── Stop current ──────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.reselect();
    // R4 (H112): the target the top line names (src/workbench/views.ts stopWords: the Control Room's selected live job there),
    // so what x stops is always what was named beforehand
    const named = stopWords(this.data, this.selected(), this.ui.workspace);
    const target = named.target;
    if (!target) {
      // R6 (H141; the interaction review of a77d80d, defect 3): the holds read now, before x answers: a turn another process
      // began since the last look is what x stops, so x never says nothing runs while a turn is held. A turn the screen named
      // that has ended since is still the one asked (its process refuses, and x says it had ended).
      this.holdsNow();
      const turn = stopWords(this.data, this.selected(), this.ui.workspace).turn ?? named.turn;
      // R5 (H131; the QA round's defect 1): a chat turn is what runs: this Workbench's own stops here; another surface's there
      if (turn?.mine && this.turnAbort) { this.turnAbort.abort(); this.say('Stopping the chat turn being answered here (x)…', 'secondary'); return; }
      // R5 (H131; the QA of e7f853e, item 16): another surface's turn is asked to stop, by its id, as its own key would stop it.
      // R7 (H150; H148's N3): x is the Workbench's own deliberate way to stop another surface's turn: it asks first, naming
      // that surface (the box: y asks it to stop, n keeps it). A turn the screen named that has ended since is asked at once
      // (its hold is gone: nothing is stopped, and x says it had ended)
      const fresh = chatTurnNow(this.data);
      if (turn && fresh && fresh.id === turn.id && !fresh.mine && fresh.id) { this.open({ kind: 'confirm-stop', turn: fresh, back: this.ui.focus }); return; }
      if (turn) { this.askTurnStop(turn, 'x'); return; }
      this.say(`Stop current: nothing runs in ${this.data.project.name}.`, 'secondary');
      return;
    }
    const where = sameFolder(target.root, this.data.project.root) ? '' : `, in ${target.project}`;
    this.say(`Stopping ${target.id} (${target.label}${where})…`, 'secondary');
    const r = await stopCurrent(target, { stop: (id) => this.d.workspace.stop(id), jobs: this.d.workspace.jobs, ...(this.d.stopLeft ? { stopLeft: this.d.stopLeft } : {}) });
    this.readJobs();
    this.say(r.words, r.role);
  }

  /**
   * R5 (H131; the QA of e7f853e, item 16): asks the chat turn another surface is answering to stop, by its identity (the
   * frame's activity.chatTurn.id): the process answering it stops it as its own key would (src/agent/chat-turn.ts
   * requestTurnStop, watchTurnStop) and its receipt records who asked; the frame, read again, shows its end. Refused when that
   * turn is not being answered now (it ended, or its process has); a turn the frame names without an id stops only there.
   */
  private askTurnStop(turn: TurnNow, how: 'x' | 'x, then y'): void {
    const there = turnStopWords(turn.surface);
    if (!turn.id) { this.say(`Stop current: the chat turn is being answered in ${turn.where}; it stops there (${there}), not from here: the workspace frame named no id to ask it by.`, 'secondary'); return; }
    const r = requestTurnStop(this.data.project.root, turn.id, 'workbench');
    if (!r.ok) { this.say(`Nothing stopped (${how}): ${r.why}.`, 'secondary'); this.refreshFrame(); return; }
    this.say(`Stop asked of the turn being answered in ${turn.where} (${how}): it stops there as ${there} would, and its end shows here once its receipt is sealed.`, 'secondary');
    this.refreshFrame();
  }

  // ── Enter ─────────────────────────────────────────────────────────────────────

  async enter(): Promise<void> {
    const region = this.ui.focus;
    if (this.chatShell() && !this.ui.overlay) {
      if (region === 'nav') { this.openRail(RAIL_ITEMS[this.ui.cursor.rail ?? RAIL_ITEMS.indexOf('chat')] ?? 'chat'); return; }
      if (region === 'right' && !this.ui.rightOpen) { await this.chooseFromRail(); return; }
      if (region === 'bottom') { await this.shellControl(shellControls({ data: this.data })[this.ui.cursor.shellBottom ?? 0]?.id ?? 'tools'); return; }
    }
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
    // R6 (H141; the interaction review of a77d80d, defect 3): Stop the turn reads the holds before it answers, even where the bar
    // drew it not available a moment before (a turn another process began since the last look)
    if (routeOf(a).kind === 'abort') { this.stopTurnAction(a); return; }
    // R7 (H150; H148's N3): an action done on another surface (the frame's doneIn) is never run here: it says where
    const away = awayOf(a);
    if (away) { this.say(`${a.n} ${a.label} is done in ${away} (${a.command}): Enter here does not do it.`, 'secondary'); return; }
    if (!a.enabled) { this.say(`${a.n} ${a.label}: not now: ${a.why ?? 'not available'}`, 'secondary'); return; }
    const r = routeOf(a);
    switch (r.kind) {
      case 'page': this.selectPage(r.page); this.ui.focus = 'center'; this.emit(); return;
      case 'key': this.key(r.key, {}); return;
      case 'workspace': this.selectWorkspace(r.ws); this.ui.focus = 'center'; this.emit(); return;
      case 'composer':
        this.selectWorkspace('chat');
        this.ui.focus = 'center';
        // R10 (H167): the composer opens at once, also while the chat session is still opening (its first open, from Home):
        // keys typed then are the message's, never the Workbench's (a capital S was "Stop serving Studio" before)
        if (this.can().chat || this.chatOpening()) this.ui.input = { field: 'composer', text: '' };
        else this.say(`Not now: ${this.can().chatWhy ?? 'sending is not available here'}`, 'secondary');
        this.emit();
        return;
      // R5 (H131; the finish line, item 3): the chat's fixes, done here
      case 'free-models': await this.openFreeModels(); return;
      case 'check': await this.runCheck(); return;
      case 'setup': await this.openSetup(r.which, a.command); return;
      case 'model':
        // the local route: choose among what Ollama lists now; on OpenRouter, /model is the REPL's (shown to copy)
        if (this.data.route.kind === 'local') { await this.openLocalModels(); return; }
        this.open({ kind: 'message', title: 'Run it in the REPL (timmy)', lines: [
          [{ text: a.label, role: 'strong' }], [], [{ text: '  ' }, { text: '/model <id>', role: 'action' }], [],
          [{ text: 'On OpenRouter, the REPL\'s /model switches its session\'s model (and says its price); /model free lists the free ones. Nothing was run from here.', role: 'secondary' }],
        ] });
        return;
      case 'abort': this.stopTurnAction(a); return;
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

  /**
   * Enter on Stop the turn (the chat's action): this Workbench's own turn stops here; another surface's is asked to stop by its
   * identity, as x does (R5, H131; the QA of e7f853e, item 16). R6 (H141): the holds are read first, so a turn another process
   * began since the last look is stopped, and a turn the bar named that has ended since is asked (its process says it ended).
   */
  private stopTurnAction(a: WorkspaceAction): void {
    this.holdsNow();
    const turn = chatTurnNow(this.data);
    if (this.turnAbort) { this.turnAbort.abort(); this.say('Stopping the chat turn being answered here…', 'secondary'); return; }
    // R7 (H150; H148's N3, the operator: "Fix Enter unexpectedly stopping another surface's turn"): a turn another surface is
    // answering is stopped there (the frame's doneIn); Enter here never stops it, and says where; x asks first (stop)
    if (turn && !turn.mine) {
      const command = a.doneIn === turn.surface ? a.command : turnStopCommand(turn.surface);
      this.say(`${a.n} ${a.label} is done in ${turn.where} (${command}): Enter here does not stop it. ${turn.id ? 'x asks you first, then asks it to stop there.' : 'It stops only there.'}`, 'secondary');
      return;
    }
    this.say(a.enabled ? 'No chat turn is being answered: nothing to stop.' : `${a.n} ${a.label}: not now: ${a.why ?? 'no chat turn is being answered'}`, 'secondary');
  }

  /** What Enter does to the selection: the action its words name. */
  private async activate(item: Item | null): Promise<void> {
    if (!item) return;
    switch (item.kind) {
      case 'work': await this.openWork(item.work); return;
      case 'conn': {
        // R5 (H131): a connection card: the companion's and Studio's Show; any other, its step, shown to copy
        const k = item.conn;
        if (k.id === 'companion') { await this.showCompanion(); return; }
        if (k.id === 'studio') { await this.showStudio(); return; }
        if (!k.setup) { this.say(`${k.label}: no step sets it up or checks it from here.`, 'secondary'); return; }
        // R5 (H131; the finish line, item 3): a step the Workbench has a path for (the check, the setup's box) goes there
        const step = routeOf({ command: k.setup });
        if (step.kind === 'check') { await this.runCheck(); return; }
        if (step.kind === 'setup') { await this.openSetup(step.which, k.setup); return; }
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
        // R4 (H112): a run of this block under way (here, or in any session, read now from the job store) starts nothing.
        // R9 (H161; R8's M): read by runningNow (the fresh reading, and the one before it when the fresh one cannot see that
        // job), and said as this key's answer, which a notice of the run itself (its progress, a block's end) does not replace
        const going = this.runningNow(item.doc.rel, item.block.name);
        if (going) { this.say(`Not started: ${going.words}.`, 'secondary', { answer: true, ...(going.job?.operation ? { operation: going.job.operation } : {}) }); return; }
        const acts = actionsOf(this.ctx(), item);
        const run = acts.find((a) => a.key === 'Enter');
        if (run?.enabled) this.open({ kind: 'confirm-run', doc: item.doc.rel, block: item.block.name, order: item.block.order, risky: item.block.risky });
        else if (run) this.say(`${run.label}: ${run.why ?? 'not available'}`, 'secondary', { answer: true });
        return;
      }
      case 'starter': this.openNew(item.name); return;
      case 'server': if (item.which === 'companion') await this.showCompanion(); else await this.showStudio(); return;
      case 'action':
        if (item.key.startsWith('nav:')) { this.selectWorkspace(item.action as WorkspaceId); this.ui.focus = 'center'; this.emit(); }
        return;
      default:
        // the Inspector shows it (R5, H131: as a drawer where Context is not a column); R9 (H160): from its first row, wherever
        // the keys or the wheel left Context (tab 6's mesh: its measurements under the Unfinished words, read on with ↓)
        this.ui.tab = 'inspector';
        if (!this.contextColumn()) this.ui.rightOpen = true;
        this.ui.scroll['right:inspector'] = 0;
        delete this.ui.wheel['right:inspector'];
        delete this.ui.anchor['right:inspector'];
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
    if (!f || !this.ui.mouse || this.disposed) return;
    this.keySeq++; // R9 (H161): the person acted: a held answer gives way
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
    // R7 (H150): a click on [n] keeps the turn; a click never asks a stop ([y] says the key to press)
    if (o?.kind === 'confirm-stop') {
      if (hint === 'n') { this.ui.overlay = null; if (o.back) this.ui.focus = o.back; this.say(`Kept: the chat turn in ${o.turn.where} goes on (nothing was asked of it).`, 'secondary'); this.emit(); }
      else if (hint === 'y') this.say('A click never stops a turn: press y to ask it to stop, or n to keep it.', 'secondary');
      return;
    }
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
    // R6 (H141): from where the last key or tick left it (two keys read before the next frame was drawn scroll twice, never
    // twice from the frame drawn before them), else where the last frame drew it
    const from = Math.max(0, Math.min(max, this.ui.scroll[d.list] ?? d.scroll));
    const next = Math.max(0, Math.min(max, from + delta));
    if (next === from) return;
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
    // R7 (H150; H148's N10): with no job of its own running no box opens, and the words say it quit at once and stopped nothing,
    // then name each job another session started, which keeps running
    const after = [...(others.length && !own.length ? ['The Workbench quit at once: no job it started was running, so it stopped nothing and asked nothing.'] : []), ...others.map((j) => `${j.id} (${j.label}) keeps running: ${j.ownerWords}.`)];
    if (own.length) after.push(...own.map((j) => `${j.id} (${j.label}) was ${JOB_CANCELLED} as the Workbench ended.`)); // R6 (H140): a job's word
    // R6 (H141; the interaction review of a77d80d, defect 15): a chat turn being answered here stops with the Workbench too
    const turnHere = this.data.turn?.state === 'sending' && this.turnAbort !== null;
    if (turnHere) after.push('The chat turn being answered here was stopped as the Workbench ended.');
    this.dispose();
    try { await this.d.workspace.close({ by: 'as the Workbench ended' }); } catch { /* said below */ }
    try { await this.d.companion.stopServing(); } catch { /* ends with the process */ }
    try { await this.d.studio.stopServing(); } catch { /* ends with the process */ }
    // R6 (H141; the interaction review of a77d80d, defect 15): the exit code says whether the quit cut anything short: 130 when it
    // stopped a job or a chat turn this Workbench started (they were interrupted), 0 when it stopped nothing (another session's
    // work keeps running). Every quit exited 130 before, the documented one with nothing running included.
    this.d.onExit?.(own.length || turnHere ? 130 : 0, after);
  }
}

/** R7 (H150; H148's N5): a stopped turn's line in the turn's word: the session's own when it says "Stopped", else "Stopped". */
function stoppedLine(line: string | undefined): string {
  if (!line) return 'Stopped.';
  if (/^Stopped\b/.test(line)) return line;
  if (/^Cancelled\b/.test(line)) return `Stopped${line.slice('Cancelled'.length)}`;
  return `Stopped: ${line}`;
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
