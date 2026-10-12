/**
 * R4 (H110): what the Workbench holds while it runs: the records it read (Data) and where the person is (Ui). The views
 * (src/workbench/views.ts) draw from these; the controller (src/workbench/controller.ts) changes them.
 */
import type { CapabilityRow } from '../capabilities/index.js';
import type { ChatRouteState } from '../contracts/chat-session.js';
import type { RunDetail } from '../contracts/run-detail.js';
import type { ApprovalRequest } from '../repl/approvals.js';
import type { Decision as WaitDecision, DecisionsView } from '../room/decisions.js';
import type { ProjectCard, ProjectOperation } from '../studio/project-cards.js';
import type { BoardTemplate } from '../studio/templates.js';
import type { WorkspaceId } from './nav.js';
import type { RightTab, SettingsRead } from './settings.js';
import type {
  ActivityEvent, ActivityView, BlockRow, ChatTail, FileRow, FilesView, JobRow, ProjectChoice, ProjectView, RecordRow, RouteView, WorkflowDoc, WorkflowsView,
} from './state.js';
import type { Line, Role } from './text.js';

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
  tools: Array<{ name: string; phase: 'start' | 'end'; outcome?: string }>;
  at: number;
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
  /** when the records were last read */
  readAt: number;
  /** the active-project record names another project than the one shown (Follow active project is off) */
  pinnedAway?: string;
}

export type Item =
  | { kind: 'file'; key: string; file: FileRow }
  | { kind: 'doc'; key: string; doc: WorkflowDoc }
  | { kind: 'block'; key: string; doc: WorkflowDoc; block: BlockRow }
  | { kind: 'job'; key: string; job: JobRow }
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
  | { kind: 'action'; key: string; action: string };

/** A view's rows and where its selectable items are among them. */
export interface View { lines: Line[]; items: Array<{ line: number; item: Item }>; note?: string }

export type Overlay =
  | null
  | { kind: 'help' }
  | { kind: 'picker' }
  | { kind: 'new'; from?: string }
  | { kind: 'settings' }
  | { kind: 'confirm-run'; doc: string; block: string; order: string[]; risky: Array<{ name: string; command: string }> }
  | { kind: 'needs-you'; req: ApprovalRequest; since: number; answer: (d: 'once' | 'session' | 'deny') => void }
  | { kind: 'quit'; own: JobRow[]; others: JobRow[] }
  | { kind: 'message'; title: string; lines: Line[] };

export interface Ui {
  workspace: WorkspaceId;
  focus: Region;
  tab: RightTab;
  navOpen: boolean;
  rightOpen: boolean;
  activityOpen: boolean;
  /** Activity shows every operation's events (else the selected one's) */
  activityAll: boolean;
  overlay: Overlay;
  /** the text being typed, where a field has the keyboard (search, the picker, a name, the composer) */
  input: { field: 'search' | 'picker' | 'new' | 'composer' | 'tools' | null; text: string };
  /** each list's selected row, by list ("center:files", "right:files", "nav", "top", "bottom", "overlay") */
  cursor: Record<string, number>;
  /** each list's first shown row */
  scroll: Record<string, number>;
  /** the last notice, with when it came (it stays in Activity) */
  flash: { text: string; role: Role; at: number } | null;
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
  /** Follow selected artifact: the job a run started here, shown by the Inspector and Activity until the cursor moves */
  follow?: string | null;
}
