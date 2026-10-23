/**
 * R4 (H110): what the Workbench holds while it runs: the records it read (Data) and where the person is (Ui). The views
 * (src/workbench/views.ts) draw from these; the controller (src/workbench/controller.ts) changes them.
 */
import type { RailModels } from './chat-shell.js';
import type { CapabilityRow } from '../capabilities/index.js';
import type { ChatRouteState, ChatSurface } from '../contracts/chat-session.js';
import type { RunDetail } from '../contracts/run-detail.js';
import type { TabId, WorkspaceConnection, WorkspaceFrame } from '../contracts/workspace.js';
import type { ApprovalRequest } from '../repl/approvals.js';
import type { Decision as WaitDecision, DecisionsView } from '../room/decisions.js';
import type { ProjectCard, ProjectOperation } from '../studio/project-cards.js';
import type { BoardTemplate } from '../studio/templates.js';
import type { ControlData, LiveTurnRow } from './control-tab.js';
import type { CreateItem } from './create-tab.js';
import type { FleetData, FleetItem } from './fleet-tab.js';
import type { LogsData, LogsItem } from './logs-tab.js';
import type { WorkspaceId } from './nav.js';
import type { RightTab, SettingsRead } from './settings.js';
import type {
  ActivityEvent, ActivityView, BlockRow, ChatTail, FileRow, FilesView, JobRow, ProjectChoice, ProjectView, RecordRow, RouteView, WorkflowDoc, WorkflowsView,
} from './state.js';
import type { ToolsData, ToolsItem } from './tools-tab.js';
import type { VoxData, VoxItem } from './voxvision-tab.js';
import type { WorkflowsTabData } from './workflows-tab.js';
import type { FreeCatalog, OllamaList, SetupPlan } from './setup-paths.js';
import type { Line, Role } from './text.js';
import type { HoldsReading } from './turn-holds.js';
import type { TurnNow } from './hub.js';
import type { WorkItem } from './home-journey.js';
import type { JourneyRoute, RecentWork } from '../journey/index.js';
import type { BuildInfo } from '../build-info.js';

export type Region = 'nav' | 'top' | 'center' | 'right' | 'bottom';
export const REGIONS: readonly Region[] = ['nav', 'center', 'right', 'bottom', 'top'];

/** Something loaded on demand: not asked yet, being read, read (with when), or why it could not be. */
export type Lazy<T> = { state: 'idle' } | { state: 'loading'; since: number } | { state: 'ready'; value: T; at: number } | { state: 'failed'; why: string; at: number };

export interface ServerState {
  /** started by this Workbench and listening */
  serving: boolean;
  /** its address on this computer, without any token */
  address: string | null;
  /** what the last Show did, in words */
  last: string | null;
  /** serving, but started by another Timmy (Studio at its usual port) */
  other?: boolean;
  starting?: boolean;
}

/** The composer's message and what came of it (src/contracts/chat-session.ts ChatTurnResult, as it arrives). */
export interface TurnView {
  text: string;
  /** the answer so far */
  answer: string;
  state: 'sending' | 'answered' | 'refused' | 'failed' | 'cancelled';
  /** refusal or failure words: cause and fix */
  lines: string[];
  /** whether a request left this process for a model; null while that is not known yet */
  sent: boolean | null;
  receipt?: string;
  costWords?: string;
  model?: string;
  /** the operation the message ran as */
  operation?: string;
  /** R10 (H163; H168's N5): the route's words when it was sent (src/workbench/views.ts routeShown): a failure's fix is the next
   *  step only while the route is still that one */
  route?: string;
  tools: Array<{ name: string; phase: 'start' | 'end'; outcome?: string }>;
  at: number;
  /** R5 (H131): when its answer ended (this process's clock) */
  ended?: number;
  /** R5 (H131; the operator's 22:32 order, item 1): the turn's identity, its hold's id (src/agent/chat-turn.ts TURN_ID), as
   *  the workspace frame names a turn being answered (activity.chatTurn.id) and its receipt seals it (turn_id): read from its
   *  hold while it is answered here, else from its sealed receipt; absent while neither has been read */
  id?: string;
}

/**
 * R4 (H117): a chat turn of the project as its sealed receipt says it (src/workbench/state.ts readTurns), whichever surface
 * sent it. A receipt holds the message and the answer as hashes only, and so does this: never a word of either.
 */
export interface TurnRow {
  /** the receipt's short id (8 hex) */
  receipt: string;
  /** the surface that sent it, as the receipt names it (src/repl/seal.ts chatTurnOf) */
  surface: ChatSurface;
  /** how it ended, as its receipt's status says: ok answered, cancelled stopped, any other failed */
  state: 'answered' | 'stopped' | 'failed';
  /** the model that answered (model_resolved), else the one asked for (model_requested); null: neither is recorded */
  model: string | null;
  /** when it was sealed (the receipt's ts) */
  at: string;
  /** how long it took, as sealed */
  ms?: number;
  /** the operation it was sealed in (the receipt's operation_id); null: none */
  operation: string | null;
  /** its receipt names its Ollama endpoint (src/room/index.ts turnOllama): true on this computer, false off it; absent: the
   *  receipt names no endpoint (a turn on the OpenRouter route) */
  local?: boolean;
  /** R5 lead: the turn's identity (its receipt's turn_id, its hold's id: src/agent/chat-turn.ts); absent on older receipts */
  turn?: string;
  /** R5 lead: a stopped turn another surface asked to stop: that surface (its receipt's stopped_by) */
  stoppedBy?: string;
}

export interface Data {
  project: ProjectView;
  projects: ProjectChoice[];
  files: FilesView;
  workflows: WorkflowsView;
  jobs: JobRow[];
  decisions: DecisionsView;
  route: RouteView;
  activity: ActivityView;
  chat: ChatTail;
  vox: RecordRow[];
  native: Partial<Record<WorkspaceId, RecordRow[]>>;
  starters: Array<{ name: string; about: string }>;
  boards: BoardTemplate[];
  studio: Lazy<{ cards: ProjectCard[]; notes: string[]; operations: ProjectOperation[] }>;
  overview: Lazy<Line[]>;
  caps: Lazy<CapabilityRow[]>;
  /** each job's run detail (src/contracts/run-detail.ts), by operation id, once asked */
  details: Record<string, Lazy<RunDetail>>;
  /** the chat session's own route (src/contracts/chat-session.ts), once a session is open */
  chatRoute?: ChatRouteState;
  /** the composer's last message */
  turn?: TurnView;
  /** R4 (H117): the project's chat turns from their sealed receipts, every surface's, the newest first (optional: a test's
   *  Data made by hand may leave it out) */
  turns?: TurnRow[];
  /** when the records were last read */
  readAt: number;
  /** the active-project record names another project than the one shown (Follow active project is off) */
  pinnedAway?: string;
  /** R4 (H112): live jobs this Workbench started in another project than the one shown: a run keeps its own project when
   *  the view switches, and Stop and Activity still name it, with where it runs */
  away: JobRow[];
  /** R5 (H131): the one workspace frame (src/ops/workspace-frame.ts buildWorkspaceFrame) the terminal, the companion and
   *  Studio share: the tabs, each tab's actions, the connections as observed, the log. Absent until it is first read. */
  frame?: WorkspaceFrame;
  /** R6 (H141): the project's chat-turn holds as this Workbench last read them (src/workbench/turn-holds.ts), at most a few
   *  hundred ms ago: newer than the frame, they say at once whether another process's turn is being answered */
  holds?: HoldsReading;
  /** R5 (H131): why the frame could not be read, when it could not (the last frame read stays shown) */
  frameError?: string;
  /** R5 (H131): the newest run's intent, prediction, run and receipt, from its records (src/workbench/state.ts readPipeline) */
  pipeline?: PipelineView;
  /** R5 (H134): tab 0's reading (src/workbench/logs-tab.ts readLogs), made only while the tab is shown */
  logs?: LogsData;
  /** R5 (H134): tab 8's reading (src/workbench/fleet-tab.ts readFleet), made only while the tab is shown */
  fleet?: FleetData;
  /** R5 (H134): tab 5's reading (src/workbench/voxvision-tab.ts readVox) and tab 9's (src/workbench/tools-tab.ts readTools),
   *  each made only while its tab is shown */
  voxTab?: VoxData;
  toolsTab?: ToolsData;
  /** R5 (H137): tab 7's reading (src/workbench/control-tab.ts readControl), made only while the tab is shown */
  control?: ControlData;
  /** R5 (H136): tab 3's reading of the selected block's newest run (src/workbench/workflows-tab.ts readWorkflowsTab), made
   *  each frame only while the tab is shown */
  workflowsTab?: WorkflowsTabData;
  /** R10 (H167): the project's recent work (H164's src/journey recentWork), read with the records (readAll), never per frame */
  recent?: RecentWork;
  /** R10 (H167): the route the next chat turn takes (H164's src/journey routeNow), read with the records */
  journeyRoute?: JourneyRoute;
  /** R10 (H167): the build (H163's src/build-info.ts buildInfo), read once: About · diagnostics */
  build?: BuildInfo;
  /** R10 CHAT (H167): what the Models rail lists (src/workbench/chat-shell.ts RailModels): read by the controller, drawn there */
  models?: RailModels;
}

/** R5 (H131): one stage of the newest run's pipeline, as its records say it. */
export interface PipelineStage {
  /** done: a record says it happened; none: the run has no such record; not run yet: nothing has run; running; failed: it
   *  failed, or (a receipt) it does not verify; unknown: its record could not be read */
  state: 'done' | 'none' | 'not run yet' | 'running' | 'failed' | 'unknown';
  words: string;
  /** a receipt this Workbench verified (its chain link, body hash and signature), by verifyReceiptIn */
  verified?: boolean;
}

/** R5 (H131): the Chat tab's pipeline row: intent → predict → sandbox → receipt, of the project's newest run. */
export interface PipelineView {
  operation: string | null;
  /** the run's job, by its label (a chat turn: "chat turn in the Workbench") */
  label: string | null;
  /** R5 (H131; the QA round's defect 8): what the newest operation is: a job's run, or a chat turn (answered, or being answered) */
  kind?: 'job' | 'chat';
  /** R5 (H131): a chat turn being answered here now (its request is the message this Workbench sent; no receipt yet) */
  live?: boolean;
  intent: PipelineStage;
  predict: PipelineStage;
  sandbox: PipelineStage;
  receipt: PipelineStage;
}

export type Item =
  | { kind: 'file'; key: string; file: FileRow }
  | { kind: 'doc'; key: string; doc: WorkflowDoc }
  | { kind: 'block'; key: string; doc: WorkflowDoc; block: BlockRow }
  | { kind: 'job'; key: string; job: JobRow }
  | { kind: 'turn'; key: string; turn: TurnRow }
  | { kind: 'decision'; key: string; decision: WaitDecision }
  | { kind: 'card'; key: string; card: ProjectCard }
  | { kind: 'operation'; key: string; op: ProjectOperation }
  | { kind: 'cap'; key: string; row: CapabilityRow }
  | { kind: 'record'; key: string; rec: RecordRow }
  | { kind: 'starter'; key: string; name: string; about: string }
  | { kind: 'board'; key: string; board: BoardTemplate }
  | { kind: 'server'; key: string; which: 'companion' | 'studio' }
  | { kind: 'message'; key: string; role: string; text: string }
  | { kind: 'event'; key: string; event: ActivityEvent }
  | { kind: 'project'; key: string; choice: ProjectChoice }
  | { kind: 'action'; key: string; action: string }
  /** R5 (H131): a connection card of Home, as the workspace frame has it */
  | { kind: 'conn'; key: string; conn: WorkspaceConnection }
  /** R5 (H134): tab 5's VoxVision records and tab 9's MCP calls (their tools are `cap` rows) */
  | Extract<VoxItem, { kind: 'vox-record' }>
  | Extract<ToolsItem, { kind: 'mcp-call' }>
  /** R5 (H134): tab 0's rows (a receipt, an operation, another event) and tab 8's (a fleet plan, a decision) */
  | LogsItem
  | FleetItem
  /** R5 (H137): a chat turn being answered, as its hold names it (tab 7's pane) */
  | { kind: 'live-turn'; key: string; live: LiveTurnRow }
  /** R9 (H160): tab 6's meshes and recordings (src/workbench/create-tab.ts) */
  | CreateItem
  /** R10 (H167): an item of Home's recent work (src/workbench/home-journey.ts): a run, a chat turn, an observation, a result
   *  or what waits on you, opened where it belongs */
  | { kind: 'work'; key: string; work: WorkItem };

/** A view's rows and where its selectable items are among them; `rows`: how many rows an item takes (a card), else one; `x`
 *  (R5, H137): the cells of the zone's rows it is drawn in, when its view draws columns side by side (a click on that row in
 *  another column is not on it); `near` (R5, H137): where each arrow moves from it, when its view lays items out as a grid
 *  (an arrow it does not name moves as in any list); `unfinished` (R7 lead): how many of its first rows are the Unfinished box
 *  (src/workbench/views.ts unfinishedBox), so the page opens at its top (src/workbench/screen.ts). R8 (H157): `pin`, how many
 *  of its first rows stay on the window's first rows while the rest scrolls (an Unfinished box cut to its title, where even
 *  that leaves the first item no room); `unfinishedRest`, the box leaves some of its words out, and Context shows them. R9
 *  (H160): `firstWhole`, the box leaves room for the first item's every row, not only its first (tab 6's first mesh). */
export interface View { lines: Line[]; items: Array<{ line: number; item: Item; rows?: number; x?: { from: number; to: number }; near?: { up?: number; down?: number; left?: number; right?: number } }>; note?: string; unfinished?: number; pin?: number; unfinishedRest?: boolean; firstWhole?: boolean; footRows?: number }

export type Overlay =
  | null
  | { kind: 'help' }
  | { kind: 'picker' }
  | { kind: 'new'; from?: string }
  | { kind: 'settings' }
  | { kind: 'confirm-run'; doc: string; block: string; order: string[]; risky: Array<{ name: string; command: string }> }
  | { kind: 'needs-you'; req: ApprovalRequest; since: number; answer: (d: 'once' | 'session' | 'deny') => void }
  | { kind: 'quit'; own: JobRow[]; others: JobRow[] }
  /** R7 (H150; H148's N3): x on a chat turn another surface is answering asks first, naming that surface */
  | { kind: 'confirm-stop'; turn: TurnNow; back?: Region }
  | { kind: 'message'; title: string; lines: Line[] }
  // R5 (H131; the finish line, item 3): the chat's fixes, done here (src/workbench/setup-paths.ts)
  | { kind: 'free-models'; state: 'reading' }
  | { kind: 'free-models'; state: 'listed'; catalog: FreeCatalog }
  | { kind: 'free-models'; state: 'failed'; why: string }
  | { kind: 'local-models'; state: 'asking' }
  | { kind: 'local-models'; state: 'listed'; list: OllamaList }
  | { kind: 'local-models'; state: 'failed'; list: OllamaList }
  // the setup's own path (a shell's): the command, what it asks now, where the key in use comes from; `local`: a local model
  // can be chosen here instead; `blank`: the setup has not run on this computer
  | { kind: 'setup'; which: 'init' | 'chat'; command: string; asks: string[] | null; keyFrom: SetupPlan['keyFrom']; local: boolean; blank: boolean }
  /** R10 CHAT (H167; the lead's Mac check of 50237ef, item 3): OpenRouter connected here, by its sign-in (H170's PKCE flow,
   *  src/setup/openrouter-signin.ts: the address shown, opened only on the person's Enter, the manual code typed into Timmy's
   *  own hidden field) or a key pasted into a hidden field (src/setup/provider-keys.ts saveKey). `step`: the choice; the
   *  sign-in starting; its address shown while OpenRouter's answer is awaited; the code's field; the key's field; what came
   *  of it (`ok`, its words, the route as read then). `note`: the newest answer to a step (an opened page, a code taken, a
   *  key refused), never what was typed */
  | { kind: 'connect'; provider: 'openrouter'; step: 'choose' | 'starting' | 'signin' | 'code' | 'paste' | 'done'; url?: string; note?: { text: string; failed?: boolean }; ok?: boolean; words?: string; route?: string };

export interface Ui {
  /** R5 (H131): the active tab of the ten (src/contracts/workspace.ts TABS), the frame's own ids */
  page: TabId;
  /** R5 (H131): the workspace each tab showed last (a tab that gathers several returns to the one left) */
  pageWs?: Partial<Record<TabId, WorkspaceId>>;
  workspace: WorkspaceId;
  focus: Region;
  tab: RightTab;
  navOpen: boolean;
  rightOpen: boolean;
  /** R10 (H167; the lead's 12:23 finding): the zone that had the keyboard when i opened the right drawer (the Inspector); its
   *  closing (i again, or Escape) gives the keyboard back to it */
  rightFrom?: Region;
  activityOpen: boolean;
  /** Activity shows every operation's events (else the selected one's) */
  activityAll: boolean;
  overlay: Overlay;
  /** the text being typed, where a field has the keyboard (search, the picker, a name, the composer) */
  input: { field: 'search' | 'picker' | 'new' | 'composer' | 'tools' | 'secret' | 'msearch' | null; text: string };
  /** each list's selected row, by list ("center:files", "right:files", "nav", "top", "bottom", "overlay") */
  cursor: Record<string, number>;
  /** each list's first shown row */
  scroll: Record<string, number>;
  /** R4 (H112): each list's selected item by its key: the selection stays on the same thing (a job, a file, an event) while
   *  rows arrive, end or move, rather than on the same place (src/workbench/select.ts) */
  sel: Record<string, string>;
  /** R4 (H112): each list's anchor, the item kept on the same row of its zone as rows arrive or go: the selected one, or the
   *  first one shown when the wheel scrolled the list */
  anchor: Record<string, { key: string; row: number }>;
  /** R4 (H112): lists the wheel scrolled: their view stays where the wheel left it, and the selection is brought into view
   *  only when the person moves it */
  wheel: Record<string, boolean>;
  /** R4 (H112): lists whose selection the person chose (an arrow, a click, a search's first match): kept when its workspace
   *  is opened again; a list whose selection was only its first row starts on its first row again (src/workbench/select.ts) */
  chosen?: Record<string, boolean>;
  /** R4 (H112): Activity follows its newest row (the selection is the newest, and new rows keep it so); it stops when the
   *  person selects an older row, and starts again on the newest (End) */
  activityFollow: boolean;
  /** R4 (H112): All tools' search words, kept when Enter closes the search (Esc clears them) */
  toolsQuery: string;
  /** the last notice, with when it came (it stays in Activity) */
  /** R7 (H150): `whileTurn`: a notice about a turn being answered (its id): drawn as fresh only while that turn is answered */
  flash: { text: string; role: Role; at: number; whileTurn?: string } | null;
  mouse: boolean;
  /** the right Files tab shows only the files related to the selection */
  related: boolean;
  settings: SettingsRead;
  /** the last save's words: "Saved locally at 14:02:05", or why not */
  saved: string | null;
  companion: ServerState;
  studio: ServerState;
  /** the job ids this Workbench started */
  mine: string[];
  /** R4 (H112): the runs (doc › block) being started here: their confirm was answered and their job has not started yet */
  starting?: string[];
  /** R4 (H112): the navigation was drawn in the last frame (a column, or an open drawer) */
  navShown?: boolean;
  /** Follow selected artifact: the job a run started here, shown by the Inspector and Activity until the cursor moves */
  follow?: string | null;
  /** focus mode ([z]): the center alone, with the top and the bottom */
  focusMode?: boolean;
  /** R10 CHAT (H167): the Models rail's provider (else the next turn's route's), Ollama's Local or Cloud, its sort and search;
   *  whether the Models drawer is open where the rail does not fit beside the conversation */
  modelsProvider?: 'openrouter' | 'ollama-local' | 'ollama-cloud' | 'cloudflare';
  modelsSort?: 'recent' | 'name' | 'price' | 'context';
  modelsSearch?: string;
  /** R10 CHAT (H167): Models' Cost filter (free: only the ones the catalog prices at 0; paid: only priced ones; all); unset:
   *  free where the route is free-only, else all */
  modelsCost?: 'free' | 'all' | 'paid';
  /** R10 CHAT (H167; H168's pass 3b, R17): Cost is Free only as Models' starting filter after a key was saved (said "Free
   *  (start)"), not the person's choice; a change of Cost ends it */
  modelsCostStart?: boolean;
  /** R10 CHAT (H167; H168's pass 3a, R3): Models' Maker, Capability and Context filters (H169's CatalogQuery maker, capability
   *  and minContext); unset: All */
  modelsMaker?: string;
  modelsCap?: 'tools' | 'vision' | 'reasoning';
  modelsContext?: number;
  /** R10 CHAT (H167; H168's pass 3a, R3): the control of Models' OpenRouter list the keyboard is on (MODEL_CONTROLS: 0 Search,
   *  1 Sort, 2 Maker, 3 Capability, 4 Cost, 5 Context); unset: its list */
  modelsControl?: number;
  modelsOpen?: boolean;
  /** R10 CHAT (H167): Models shows the selected model's every field in place of its list ([ Details ], i) */
  modelsDetails?: boolean;
  /** R10 CHAT (H167): what was typed in the composer when it was left (Esc, Tab): kept, and given back when it opens again */
  draft?: string;
  /** R10 CHAT (H167): the zone that had the keyboard when M gave it to the Models rail (Esc gives it back) */
  modelsFrom?: Region;
  /** R11 (H167; step 1a, the operator's first-use failure): the readiness check of the local model last chosen (H170's
   *  checkLocalModel: one POST /api/show of that exact name, no model run): `checking` while Ollama is asked, then its
   *  answer, kept until the next choice. The model chip and the chosen row say it in words (B10: never colour alone);
   *  green only on `ready`, which is Ollama's own answer, with its time. */
  modelCheck?: { model: string; state: 'checking' | 'ready' | 'not-a-chat-model' | 'not-installed' | 'unreachable'; at: number; words: string; why?: string; origin?: string; /** the setup made the identity on this choice (a home that had none) */ setUp?: boolean };
  /** R10 CHAT (H167): the first run's question answered in this Workbench (a choice made, or Continue without a model; Review
   *  setup choices asks it again). Not kept: a later start with still no model asks it again */
  firstRunDone?: boolean;
  /** R10 CHAT (H167): the first run's Timmy guide shown (Show / Hide) */
  guide?: boolean;
  /** R10 CHAT (H167): the drawer a control of the Chat screen's bottom opened (Logs, Budget; More below WIDE_COLUMNS): over
   *  the conversation, the keyboard staying on that control (↑ ↓ in the drawer, Enter acts, Esc closes it) */
  shellDrawer?: 'logs' | 'budget' | 'more';
  /** R10 CHAT (H167): the Chat tab as it was before the shell (row 2's actions, the pipeline, the event log), where this
   *  Workbench was started with TIMMY_WORKBENCH_CHAT=classic (the tests that check that layout); else the shell */
  chatClassic?: boolean;
}
