/**
 * Round R4 (helper H78): Timmy God's Eye View, the project overview. This module holds the model's shape only: what
 * src/overview/build.ts returns, what `/overview` prints (src/repl/overview.ts), what the board's Overview section draws
 * (src/repl/board-overview.ts) and what the live board's GET /overview answers. It is plain, JSON-serialisable data.
 *
 * The rules every part keeps (the owner's definition, docs/ui-cockpit/GODS-EYE-VIEW.md):
 * - every section has an `as_of` (when its sources were read) and says `unknown`, with why, when they could not be read;
 * - every item names its source: the record behind it, relative to the project (null when it has none in the project),
 *   and the typed command that opens it; most also name the board section that already shows them;
 * - a run is `running` only when that is proven by a live process; one whose owner process is gone is `left` (it still
 *   runs, and the Timmy that started it has ended) or `stale` (its own process is gone too), never running;
 * - a cost is a reported number, null when a request went out and no cost came back (unknown), or absent when Timmy sent
 *   no request (R4, H73: the Control Room's reading; a chat turn whose receipt records no cost asked a model, so it is null);
 *   an unknown cost is never summed as 0;
 * - counts say what they count, and every list is bounded, its rest counted (`more`).
 */
import type { DecisionKind } from '../room/decisions.js';

export const OVERVIEW_SCHEMA = 'timmy.overview/1';

/** The sections, in the order the first screen shows them: what needs you first. */
export const OVERVIEW_SECTIONS = ['needs', 'agents', 'workflows', 'apps', 'spatial', 'history', 'project'] as const;
export type OverviewSectionId = typeof OVERVIEW_SECTIONS[number];
export const SECTION_TITLE: Readonly<Record<OverviewSectionId, string>> = {
  needs: 'Needs you', agents: 'Agents', workflows: 'Workflows', apps: 'Apps', spatial: 'Spatial', history: 'History', project: 'Project',
};

/** How many items a section lists; the rest are counted in `more`. */
export const ITEMS_MAX = 8;

/** The board sections that already show a thing (anchors of /board and /board live). */
export type BoardAnchor = 'room' | 'room-decisions' | 'room-running' | 'room-tools' | 'workflows' | 'jobs' | 'flows' | 'voxvision' | 'review' | 'results' | 'memory' | 'canvas';

/** Where an item comes from: its record (relative to the project; null when it has none there) and the command that opens it. */
export interface OverviewSource {
  record: string | null;
  command: string;
  /** the board section that shows it */
  board?: BoardAnchor;
  /** the short id of the receipt that sealed it, when its reader's own check names one */
  receipt?: string;
}

/**
 * What is known of a run's life. running: a live process proves it (a job whose process runs and whose starter runs, or a
 * flow this REPL runs); left: it still runs and the Timmy that started it has ended (/recover settles it); stale: it says it
 * runs and its own process is gone; ended: it ended; unknown: neither can be proven (why is said).
 */
export type Life = 'running' | 'left' | 'stale' | 'ended' | 'unknown';

/** A count and what it counts, in words. */
export interface Count { n: number; of: string }

/** A cost as recorded: a reported number (known, or free on a local endpoint), or null when unknown. Absent: no request went out. */
export interface OverviewCost {
  kind: 'known' | 'free' | 'unknown';
  usd: number | null;
  /** an amount recorded as a lower bound beside an unknown cost (a cancelled turn): never summed as a cost */
  at_least?: number;
  words: string;
}

/** A record its reader could not read, named with why. */
export interface Unreadable { record: string; why: string }

export interface SectionBase {
  id: OverviewSectionId;
  title: string;
  /** when its sources were read (ISO) */
  as_of: string;
  /** read; partial (a part could not be read: why says which); unknown (nothing could be read: why says why) */
  state: 'read' | 'partial' | 'unknown';
  why?: string;
  /** the counts in a few words, for the first screen (the counts below say each in full) */
  summary: string;
  counts: Count[];
  /** the most urgent item, in one line, with its source */
  urgent?: { text: string; tone: Tone; source: OverviewSource };
  /** records of this section's kind that could not be read */
  unreadable: Unreadable[];
  notes: string[];
}

/** The colour a word is drawn in: only a colour; the word always says it (an outcome is never green). */
export type Tone = 'attention' | 'failed' | 'running' | 'ok' | 'neutral';

// ── needs you ────────────────────────────────────────────────────────────────

export interface NeedsItem {
  title: string;
  kind: DecisionKind;
  /** it blocks a running or requested operation */
  blocks: boolean;
  needed: string;
  why: string;
  commands: string[];
  keys?: string[];
  steps?: string[];
  operation?: string;
  source: OverviewSource;
}
export interface NeedsSection extends SectionBase {
  id: 'needs';
  /** every item waiting, shown or not */
  total: number;
  items: NeedsItem[];
  more: number;
  /** when /tools was last checked for the setup part, or why that part is not known */
  tools: { checked_at?: string; note?: string };
}

// ── agents ───────────────────────────────────────────────────────────────────

/** One step of a handoff: to whom (a step's owner, you, the review) and in what state. */
export interface Handoff { to: string; state: string; source?: OverviewSource }

export interface AgentItem {
  kind: 'agent' | 'flow' | 'chat';
  id: string;
  /** who owns it (the crew), as the Control Room names it */
  owner: string;
  /** what it was asked, in its own record's words, and where those words are; null when no record of it says */
  assignment: { text: string; from: string } | null;
  harness?: string;
  model?: string;
  route: string;
  endpoint?: 'local' | 'remote';
  life: Life;
  /** why its life is left, stale or unknown, in words */
  life_why?: string;
  /** its state in its own record's words */
  state: string;
  step?: string;
  progress?: string;
  elapsed?: string;
  handoffs: Handoff[];
  cost?: OverviewCost;
  /** no cost recorded: why, in the Control Room's words */
  cost_none?: string;
  operation?: string;
  role?: string;
  source: OverviewSource;
}
export interface OperationItem {
  id: string;
  request: string;
  state: string;
  life: Life;
  life_why?: string;
  runs: number;
  waiting: string[];
  source: OverviewSource;
}
export interface AgentsSection extends SectionBase {
  id: 'agents';
  items: AgentItem[];
  more: number;
  operations: OperationItem[];
  operations_more: number;
}

// ── workflows ────────────────────────────────────────────────────────────────

export interface WorkflowBlockItem {
  name: string;
  needs: string[];
  /** its state in its newest run (runBlocks' word), or "not run yet" */
  word: string;
  detail?: string;
}
export interface Blocker { block: string; why: string; source: OverviewSource }
export interface WorkflowItem {
  doc: string;
  title?: string;
  /** the blocks in the document's order with their needs and their state in the newest run that included them */
  blocks: WorkflowBlockItem[];
  /** the newest run: its target, its blocks in run order with each one's state (src/workflows/run-blocks.ts) */
  last_run?: { job: string; target: string; word: string; life: Life; life_why?: string; order_from: string; blocks: Array<{ name: string; word: string; detail?: string }>; receipt?: string; met?: boolean; source: OverviewSource };
  blockers: Blocker[];
  readable: boolean;
  why?: string;
  source: OverviewSource;
}
export interface JobItem { id: string; kind: string; label: string; life: Life; life_why?: string; state: string; source: OverviewSource }
export interface WorkflowsSection extends SectionBase {
  id: 'workflows';
  items: WorkflowItem[];
  more: number;
  /** the project's jobs that say they run, each with what is proven of it */
  jobs: JobItem[];
  jobs_more: number;
}

// ── apps, artifacts and results ──────────────────────────────────────────────

export interface AppRunItem {
  kind: 'native' | 'recipe' | 'mcp' | 'viewer';
  id: string;
  app: string;
  harness?: string;
  state: string;
  tone: Tone;
  life: Life;
  life_why?: string;
  outputs: number;
  operation?: string;
  source: OverviewSource;
}
export interface ArtifactItem {
  path: string;
  /** editable: a native file an app edits; preview: an image, render or document to look at; export: an exchange file */
  kind: 'editable' | 'preview' | 'export';
  /** the application whose native file it is (editable) or that reads it best, in words */
  editor?: string;
  role: string;
  by: string;
  source: OverviewSource;
}
export interface ResultItem {
  operation: string;
  request: string;
  changes: number;
  first?: { path: string; how: string; now: string };
  source: OverviewSource;
}
export interface AppsSection extends SectionBase {
  id: 'apps';
  runs: AppRunItem[];
  runs_more: number;
  artifacts: ArtifactItem[];
  artifacts_more: number;
  results: ResultItem[];
  results_more: number;
}

// ── spatial ──────────────────────────────────────────────────────────────────

/** A value with its status word as shown (word), and the record's own word when the check says otherwise (recorded). */
export interface SpatialMetric { title: string; value: string; word: string; note?: string; of?: string; recorded?: string }
export interface SpatialHighlight {
  path: string;
  type?: string;
  /** drawn on the board only when its bytes are the ones its record and receipt name */
  shown: boolean;
  why?: string;
  word?: string;
  /** geometry (drawn from a geometric file's values) or an image (a picture's pixels): never an abstract layout */
  from: 'geometry' | 'image';
  /** "geometry from results/vox/<id>.json" or "image from …" */
  label: string;
}
export interface SpatialItem {
  id: string;
  file: string;
  action: string;
  inputs: Array<{ path: string; kind?: string }>;
  status: string;
  /** verified, stale or unverified, as its receipt check says, with why */
  check: string;
  check_why: string[];
  /** the record's values with their status words exactly as the record labels them (stale or unknown when its check says) */
  metrics: SpatialMetric[];
  metrics_more: number;
  words: Record<string, number>;
  highlights: SpatialHighlight[];
  /** the viewer command (it opens a window on your computer: a person types it) */
  viewer: string;
  source: OverviewSource;
}
export interface SpatialSection extends SectionBase {
  id: 'spatial';
  items: SpatialItem[];
  more: number;
}

// ── history, costs and receipts ──────────────────────────────────────────────

export interface ReceiptItem { id: string; kind: string; ts: string; status?: string; operation?: string; source: OverviewSource }
export interface HistorySection extends SectionBase {
  id: 'history';
  /** known: false when no store was named or it could not be read (why says which): then nothing about receipts is known */
  receipts: { known: boolean; why?: string; total: number; project: number; recent: ReceiptItem[]; recent_more: number };
  /** the chain's newest receipt, verified or not, as the existing verifier says */
  head: { id: string; kind: string; ts: string; verified: boolean; words: string; source: OverviewSource } | null;
  costs: {
    /** the reported amounts summed, and how many runs reported one; absent when none did */
    reported?: { usd: number; runs: number };
    /** runs where a request went out and no cost came back: counted, never summed as 0 */
    unknown: { runs: number; at_least_usd?: number };
    free: { runs: number };
    words: string;
  };
  operations: { recorded: number; running: number; left: number };
  lessons: Record<string, number>;
}

// ── project ──────────────────────────────────────────────────────────────────

export interface ProjectSection extends SectionBase {
  id: 'project';
  name: string;
  /** a hash of the project's folder, as its receipts name it (never the path) */
  project_id: string;
  changed: { at: string | null; basis: string };
  canvas: { state: 'same' | 'other' | 'none' | 'off' | 'unknown' | 'running' | 'not found'; words: string; command?: string };
}

// ── the abstract map ─────────────────────────────────────────────────────────

export const MAP_LABEL = 'layout, not geometry';
export interface MapNode { id: string; label: string; kind: string; life?: Life; source: OverviewSource }
export interface OverviewMap {
  label: typeof MAP_LABEL;
  words: string;
  columns: Array<{ id: 'agents' | 'workflows' | 'artifacts'; title: string; nodes: MapNode[]; more: number }>;
  edges: Array<{ from: string; to: string; why: string }>;
}

export interface Overview {
  schema: typeof OVERVIEW_SCHEMA;
  /** when the overview was built (ISO) */
  as_of: string;
  project: ProjectSection;
  needs: NeedsSection;
  agents: AgentsSection;
  workflows: WorkflowsSection;
  apps: AppsSection;
  spatial: SpatialSection;
  history: HistorySection;
  map: OverviewMap;
  /** what the overview does not show, and where it came from */
  notes: string[];
}
