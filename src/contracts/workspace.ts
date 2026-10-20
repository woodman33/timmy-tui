/**
 * R5 lead (2026-10-15, the operator's completion order): the ONE workspace frame every surface draws around its own content:
 * the terminal (the Workbench, `timmy workbench`), the browser companion and Timmy Studio. "All three share canonical project
 * identity, conversation, operations, artifacts and event history." The frame is what they share at the edges of the
 * screen: the current project with its switch and new-project controls, the ten tabs, each tab's workflow actions with one
 * primary next step, the connections as observed, what runs and waits on you, the newest activity, and which surfaces open
 * at start. Each surface draws its own middle (a chat, a canvas, a run) from the records it already reads.
 *
 * Made only by src/ops/workspace-frame.ts, from the records that exist; no surface computes its own. What no record says is
 * listed in `unknown` with why, never guessed. A change of a field's meaning bumps WORKSPACE_VERSION; the producer and every
 * renderer change together, through the lead.
 *
 * Words and colors (DESIGN.md §10 B10): a connection is `live` (green) only when a request it answered was observed, and the
 * frame says when; `configured` is a setting, not a connection. An action is never green: the one primary next step is amber,
 * the others neutral. A log entry is `live` only for an observed live, passed or sealed state.
 */
import type { WorkspaceId } from '../workbench/nav.js';

export const WORKSPACE_VERSION = 1 as const;
export const WORKSPACE_SCHEMA = 'timmy.workspace/1' as const;

/** The ten tabs, in the order of their keys. */
export type TabId = 'home' | 'chat' | 'workflows' | 'studio' | 'voxvision' | 'create' | 'control' | 'fleet' | 'tools' | 'logs';

export interface TabDef {
  id: TabId;
  /** the key that opens it on every surface: '1' to '9', then '0' for the tenth */
  key: string;
  /** the tab's words */
  label: string;
  /** the terminal Workbench workspaces it gathers (src/workbench/nav.ts); the first is the one the tab opens */
  workbench: readonly WorkspaceId[];
  /** the operator's references (codex-ui-references, numbered 01 to 18) whose layout it follows */
  refs: readonly string[];
  /** one line: what the tab is for */
  purpose: string;
  /**
   * R7 lead (the operator's order of 2026-10-16, 22:08 PT: "Keep 3D/Motion, Control Room, Fleet/Clef and Logs/Receipts
   * visibly unfinished until their intended interactions work"): a tab whose intended interactions do not all work yet says
   * so on every surface, in these words: what works on it now, and what it does not do yet. Drawn in structure and text
   * colors only (never amber or green: it is neither a step nor a state). Absent on a tab whose interactions work.
   */
  unfinished?: { works: string; missing: string };
}

/**
 * The tabs. Each reference image numbers its own tabs differently (they describe related states of one product, not eighteen
 * apps), so this is the one stable set: the operator's screens of the completion order, in its order, with the logs last.
 */
export const TABS: readonly TabDef[] = [
  { id: 'home', key: '1', label: 'Home', workbench: ['connections', 'overview'], refs: ['01', '13'], purpose: 'The project at a glance, its connections as observed, and the one next step.' },
  { id: 'chat', key: '2', label: 'Chat & Intent', workbench: ['chat'], refs: ['02', '11'], purpose: 'One conversation with Timmy for this project, shared by every surface.' },
  { id: 'workflows', key: '3', label: 'Workflows', workbench: ['workflows'], refs: ['03', '12'], purpose: 'Intent, prediction, sandbox, review, run, logs, receipt and analysis, kept apart.' },
  { id: 'studio', key: '4', label: 'Studio', workbench: ['studio'], refs: ['06'], purpose: 'The tldraw canvas: boards, cards, drafts to accept or discard, saved and reopened.' },
  { id: 'voxvision', key: '5', label: 'VoxVision', workbench: ['voxvision'], refs: ['04', '05', '15', '16'], purpose: 'Every 2D and 3D vision tool with its observed status, and this project\'s observations.' },
  { id: 'create', key: '6', label: '3D & Motion', workbench: ['create3d', 'motion'], refs: ['06'], purpose: 'Native scenes, CAD, compositions and renders Timmy drives, with what each needs.',
    // R7 lead (H153's 3D slice, at its merge): the meshes and the view you can turn work now; the rest does not yet. R9 lead
    // (H159, H160): the meshes are items, and a recording's entities and time range are read through the installed Rerun CLI
    unfinished: { works: 'the project\'s meshes (STL, OBJ and PLY) measured by Timmy\'s own readers, each an item you can select, a view of each you can turn in the companion (Timmy\'s own drawing of the file\'s triangles), a recording\'s header facts and, through the installed Rerun CLI, its entities, timelines and time ranges (or why not), and each native tool\'s status and setup step (Blender, OpenSCAD, FreeCAD, Unreal Engine, CadQuery, After Effects)', missing: 'a native tool\'s render, a motion timeline, scene editing and render previews, and a recording\'s frames drawn or replayed; Rive, Theatre.js and HyperFrames are not in Timmy' } },
  { id: 'control', key: '7', label: 'Control Room', workbench: ['control'], refs: ['07', '14'], purpose: 'Devices, harnesses, jobs, chat turns and decisions: what runs, what ended, what waits.',
    // R8 (H155): the companion's tab 7 draws the panes now (src/companion/client/panel-control.js), read-only
    unfinished: { works: 'this project\'s jobs, chat turns and runs, each run\'s pane (the Workbench draws up to four as a grid, and the companion shows them, read-only) and what waits on you', missing: 'adding or removing harnesses, a broadcast to every pane, and live browser panes' } },
  { id: 'fleet', key: '8', label: 'Fleet & Clef', workbench: ['fleet', 'overview'], refs: ['09', '18'], purpose: 'Fleet plans and their counts, decision-model recommendations and Cloudflare, labelled as they are.',
    // R9 lead (H162's merge): the decision model by name with its pricing as declared, refused before anything is sent
    unfinished: { works: 'fleet plans on the FAKE backend with their counts, the decision model clef.json names with its pricing as declared (routing off by default, thresholds uncalibrated), and each recorded decision with the model that answered; unknown pricing, free only and a budget are refused before anything is sent', missing: 'probability bars, service cards, a switch on any screen for decision-model routing, hosted decision models (deferred: no paid call is authorized), and any real fleet (on HOLD)' } },
  { id: 'tools', key: '9', label: 'Tools & MCP', workbench: ['tools', 'rea', 'templates'], refs: ['08', '17'], purpose: 'Every capability with its rung, both MCP-to-CLI routes, REA, and public templates.' },
  { id: 'logs', key: '0', label: 'Logs & Receipts', workbench: ['logs', 'files'], refs: ['10'], purpose: 'Raw output, structured events and the receipt chain, linked by operation id.',
    unfinished: { works: 'the receipt chain, checked in the Workbench, and each operation\'s raw log and events', missing: 'replaying a run from here, the durable spine table, and a chain check in the companion' } },
];

export const tabOf = (id: TabId): TabDef => TABS.find((t) => t.id === id) ?? TABS[0];
export const tabByKey = (key: string): TabDef | undefined => TABS.find((t) => t.key === key);

/** What an action does when run: what it reads, changes, sends or spends. */
export type ActionEffect = 'read' | 'local change' | 'network' | 'spend';

/** One numbered step of a tab's workflow-actions bar. */
export interface WorkspaceAction {
  /** 1, 2, 3, 4: the order of the bar */
  n: number;
  label: string;
  /** what runs it: a REPL slash command, a `timmy …` command, or a surface's key; the same on every surface */
  command: string;
  /** the one primary next step of the tab (amber); at most one per tab, and none when nothing is next */
  primary: boolean;
  /** false: shown, not available now, and `why` says what is missing */
  enabled: boolean;
  why?: string;
  effect: ActionEffect;
  /**
   * R7 lead (the operator's order of 2026-10-16, 22:08 PT: "Fix Enter unexpectedly stopping another surface's turn"): the
   * one surface that does this action, when only that surface does it (the chat tab's Stop the turn: the surface that sent
   * the turn, as `command` says in words). Any other surface shows the action and where it is done, and never runs it on a
   * key: a stop asked from another surface is its own deliberate step there, never the Enter that a primary next step takes.
   * Absent: the action is done where it is shown.
   */
  doneIn?: 'repl' | 'monitor' | 'workbench' | 'companion';
}

/** A connection, as Timmy last observed it. `live` needs an answered request with its time; a setting alone is `configured`. */
export type ConnectionState = 'live' | 'configured' | 'not set up' | 'unreachable' | 'refused' | 'unknown';

export type ConnectionId = 'openrouter' | 'ollama' | 'cloudflare' | 'clef' | 'cloudroom' | 'companion' | 'studio' | 'mcp-sdk' | 'mcporter';

export interface WorkspaceConnection {
  id: ConnectionId;
  label: string;
  state: ConnectionState;
  /** plain words: "answered 2 min ago (the key endpoint took the key)", "not running when checked 5 s ago; s in the Workbench, or timmy studio, starts it", "no key: run timmy setup" */
  words: string;
  /** when Timmy last checked it, answered or not (`state` says which); null: never checked, so never live */
  observedAt: string | null;
  /** the step that sets it up or checks it, when there is one */
  setup: string | null;
  /** cost and capability words where known: "free-only", "no charge (local)", "cost unknown" */
  detail?: string;
}

export type LogTone = 'neutral' | 'attention' | 'live' | 'failure';

/** One line of the activity log, newest first. */
export interface WorkspaceLogEntry {
  at: string;
  /** the event's own name, for example "receipt.sealed", "job.ended", "turn.answered" */
  tag: string;
  words: string;
  tone: LogTone;
  operation?: string;
  /** the record it was read from (a path relative to the project, or a receipt id) */
  source: string;
}

/**
 * R5 lead (the finish line, item 3: every surface shows the same conversation): a sealed chat turn of the project as its
 * receipt says it (src/workbench/state.ts readTurns), whichever surface sent it. A receipt keeps the message and the answer as
 * hashes only, and so does this: never a word of either. The words are the ones every surface's log uses.
 */
export interface WorkspaceTurn {
  /** the receipt's short id (8 hex) */
  receipt: string;
  /** the surface that sent it: repl, workbench, monitor or companion */
  surface: string;
  state: 'answered' | 'stopped' | 'failed';
  /** the model that answered, else the one asked for; null: neither is recorded */
  model: string | null;
  /** when it was sealed */
  at: string;
  ms?: number;
  /** the operation it was sealed in; null: none */
  operation: string | null;
  /** its receipt names an Ollama endpoint on this computer (local) or off it (remote); none: the OpenRouter route */
  route: 'local' | 'remote' | 'openrouter';
  /** "turn answered in the Workbench · qwen3:8b · receipt d61b3006 · 4.1 s" */
  words: string;
  /** R5 lead: the turn's identity (its receipt's turn_id): the id a turn being answered had (activity.chatTurn.id) */
  turn?: string;
  /** R5 lead: a stopped turn another surface asked to stop: that surface */
  stoppedBy?: string;
}

export interface SurfaceState {
  /** the operator's setting: reopen this surface when the workspace starts */
  openAtStart: boolean;
  /** its address on this computer when it runs, without its token; null when not running or not known */
  url: string | null;
  state: 'running' | 'not running' | 'unknown';
}

export interface WorkspaceFrame {
  schema: typeof WORKSPACE_SCHEMA;
  version: typeof WORKSPACE_VERSION;
  /** when the frame was made */
  at: string;
  /** a digest of the frame without `at`: a surface that writes sends it back as `if_revision`, and a stale one is refused */
  revision: string;
  project: {
    /** src/project projectId: sha256 of the folder's real path, 16 hex */
    id: string;
    name: string;
    /** the folder from ~ (never the home path itself) */
    shown: string;
    /** a person chose it, rather than the current folder by default */
    chosen: boolean;
    /** the commands that switch to another project and start a new one */
    switch: string;
    create: string;
  };
  /** R5 lead: each tab's purpose too (H132's note), as TABS says it */
  /** R7 lead: `unfinished` as TabDef carries it (a tab whose intended interactions do not all work yet) */
  tabs: Array<{ id: TabId; key: string; label: string; refs: readonly string[]; purpose?: string; waiting: number; unfinished?: { works: string; missing: string } }>;
  actions: Record<TabId, WorkspaceAction[]>;
  connections: WorkspaceConnection[];
  /** R5 lead: `running` counts a chat turn being answered too; `chatTurn` names it (one turn at a time per project) */
  activity: { running: number; waitingOnYou: number; stopCurrent: { job: string | null; words: string }; chatTurn?: { surface: string; since: string; words: string; id?: string } | null };
  log: WorkspaceLogEntry[];
  /** R5 lead: the project's newest sealed chat turns (at most 8, the newest first), every surface's, from their receipts */
  chat?: { turns: WorkspaceTurn[] };
  surfaces: { companion: SurfaceState; studio: SurfaceState };
  unknown: Array<{ field: string; why: string }>;
}
