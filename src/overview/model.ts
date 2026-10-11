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
 *
 * R4 (H93), God's Eye View slice 2, schema `timmy.overview/2` (the shape changed: three sections were added): `devices`
 * (Timmy Connect's records in this computer's Timmy home: each computer, how it is reached, its last probe and when, its
 * system, what was found on its PATH, its remote jobs), `hosting` (Timmy Cloud's backend as its client last read it: each
 * site, domain and VPS order with its eight steps, each its own state), `costs` (model spend as the first slice has it,
 * beside provider spend per customer against its limits); new kinds in `needs`; the map's dependency edges (a remote job on
 * its device, an order's step on a decision). A probe's time is when it was true, never "online now"; a remote job is
 * running only as its status file said, when it was read; a cached answer says its age, and old past an hour.
 */
import type { DecisionKind } from '../room/decisions.js';

export const OVERVIEW_SCHEMA = 'timmy.overview/2';

/** The sections, in the order the first screen shows them: what needs you first. */
export const OVERVIEW_SECTIONS = ['needs', 'devices', 'hosting', 'agents', 'workflows', 'apps', 'spatial', 'history', 'costs', 'project'] as const;
export type OverviewSectionId = typeof OVERVIEW_SECTIONS[number];
export const SECTION_TITLE: Readonly<Record<OverviewSectionId, string>> = {
  needs: 'Needs you', devices: 'Devices', hosting: 'Hosting', agents: 'Agents', workflows: 'Workflows', apps: 'Apps', spatial: 'Spatial', history: 'History', costs: 'Costs', project: 'Project',
};

/** How many items a section lists; the rest are counted in `more`. */
export const ITEMS_MAX = 8;

/**
 * The board sections that already show a thing (anchors of /board and /board live). R4 (H93): the Overview's own cards for
 * devices, hosting and costs (`ov-devices`, `ov-hosting`, `ov-costs`), where each item opens its detail in place.
 */
export type BoardAnchor = 'room' | 'room-decisions' | 'room-running' | 'room-tools' | 'workflows' | 'jobs' | 'flows' | 'voxvision' | 'review' | 'results' | 'memory' | 'canvas'
  | 'ov-devices' | 'ov-hosting' | 'ov-costs';

/** Where an item comes from: its record (relative to the project; null when it has none there) and the command that opens it. */
export interface OverviewSource {
  record: string | null;
  command: string;
  /** the board section that shows it */
  board?: BoardAnchor;
  /** the short id of the receipt that sealed it, when its reader's own check names one */
  receipt?: string;
  /** R4 (H93): its record in this computer's Timmy home, relative to it (connect/devices.json, jobs/r….json, cloud/overview.json) */
  home?: string;
  /**
   * R4 (H93): the id of its own detail on the board (ov-dev-<id>, ov-job-<id>, ov-order-<id>), inside the Overview card that
   * `board` names: selecting it there, or following a link to it, opens its record's words, its last read and its commands
   */
  detail?: string;
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
  /**
   * the most urgent item, in one line, with its source. R4 (H93): `ago`, how long before the overview was built its time was
   * ("12 min ago"): words that change as the clock moves are kept only in `ago` fields, which the live board's shape leaves out
   */
  urgent?: { text: string; tone: Tone; source: OverviewSource; ago?: string };
  /** records of this section's kind that could not be read */
  unreadable: Unreadable[];
  notes: string[];
}

/** The colour a word is drawn in: only a colour; the word always says it (an outcome is never green). */
export type Tone = 'attention' | 'failed' | 'running' | 'ok' | 'neutral';

// ── needs you ────────────────────────────────────────────────────────────────

/**
 * R4 (H93): what else waits on a person, from this computer's Timmy home: a host key fetched and not confirmed (or none
 * fetched), a host key that changed, a computer whose last probe did not connect, a remote job unknown or whose stop is not
 * confirmed (Timmy Connect); and each item the Timmy Cloud backend's needs_person names, as `cloud-<its kind>`.
 */
export type OverviewNeedKind = 'host-key' | 'host-key-changed' | 'device-unreachable' | 'remote-job' | `cloud-${string}`;

export interface NeedsItem {
  title: string;
  kind: DecisionKind | OverviewNeedKind;
  /** it blocks a running or requested operation */
  blocks: boolean;
  needed: string;
  why: string;
  commands: string[];
  keys?: string[];
  steps?: string[];
  operation?: string;
  /** R4 (H93): where it comes from when not the project's own records: Timmy Connect, or Timmy Cloud's backend (as last read) */
  from?: 'connect' | 'cloud';
  /** R4 (H93): since when, as its record says, and how long before the overview was built that was */
  since?: string;
  ago?: string;
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
  /**
   * the chain's newest receipt, verified or not, as the existing verifier says; R4 (H82): `verified_at`, when that check ran
   * (once per head: it is checked again when the chain has a new head, not on every build)
   */
  head: { id: string; kind: string; ts: string; verified: boolean; verified_at?: string; words: string; source: OverviewSource } | null;
  costs: {
    /** the reported amounts summed, and how many runs reported one; absent when none did */
    reported?: { usd: number; runs: number };
    /** runs where a request went out and no cost came back: counted, never summed as 0 */
    unknown: { runs: number; at_least_usd?: number };
    free: { runs: number };
    words: string;
  };
  /** R4 (H82): `unchecked`, older records that say they run whose writer was not checked here (only the newest are) */
  operations: { recorded: number; running: number; left: number; unchecked?: number };
  lessons: Record<string, number>;
}

// ── devices (R4, H93: Timmy Connect's records in this computer's Timmy home) ───

/** A probe as its record keeps it: when it was true, what it came to; never "online now". */
export interface DeviceProbeItem {
  at: string;
  outcome: string;
  /** it connected and answered */
  answered: boolean;
  /** how long before the overview was built, in words */
  ago: string;
  /** Timmy Connect's own words for it */
  words: string;
  /** one line: answered its last probe at …, or did not connect at it (and why) */
  line: string;
}
export interface DeviceItem {
  id: string;
  name: string;
  /** how it is reached; a tailnet only when the record's own address is one (a *.ts.net name, or in Tailscale's range) */
  reach: { address: string; port: number; user: string; tailnet: 'name' | 'address' | null; words: string };
  probe: DeviceProbeItem | null;
  /** its system as its probes found it: the operating system and shell from the last probe that connected, the architecture from the last probe when it connected */
  system: { os: string; os_version?: string; arch?: string; shell: string; login_shell?: string; words: string };
  /** the programs its last probe found on its PATH: found, never "supported" or "working" */
  found_on_path: string[];
  found_words: string;
  host_key: { state: 'confirmed' | 'fetched, not confirmed' | 'none fetched' | 'changed'; words: string };
  /** what waits on a person for it, in Timmy Connect's words */
  needs: string[];
  /** Timmy Connect's one line for it */
  words: string;
  /** its remote jobs, by state */
  jobs: Record<string, number>;
  commands: string[];
  source: OverviewSource;
}
export interface RemoteJobItem {
  id: string;
  device: string;
  /** whether its device is still among the computers */
  device_known: boolean;
  label: string;
  /** its state as Timmy Connect says it: submitted, running (as its status file said, read at `read_at`), ended, unknown, stop asked, stopped */
  state: string;
  /** Timmy Connect's words for it */
  words: string;
  /** when its status file was last read on its device (null: never) */
  read_at: string | null;
  submitted_at: string;
  last_seen: string | null;
  stop: { asked_at: string; confirmed_at?: string } | null;
  fetched: number;
  commands: string[];
  source: OverviewSource;
}
export interface DevicesSection extends SectionBase {
  id: 'devices';
  /** what it covers: this computer's Timmy home, not the project */
  scope: string;
  items: DeviceItem[];
  more: number;
  jobs: RemoteJobItem[];
  jobs_more: number;
}

// ── hosting (R4, H93: Timmy Cloud's backend, as its client last read it) ─────

export interface HostingStep { name: string; label: string; state: string; at: string; words: string; needs_person?: string; retry_at?: string; reference?: string; provider_words?: string }
export interface HostingItem {
  order: string;
  customer: string | null;
  kind: string;
  /** what it is for: the domain, the site and its domain, the VPS item */
  name: string;
  created_at: string;
  /** its steps in order (quote, approval, payment, acceptance, provisioning, DNS, certificate, health), each its own state */
  steps: HostingStep[];
  /** the steps in one line, each with its own state: never one word for all */
  steps_line: string;
  /** the backend's sentence naming the steps that matter now */
  summary: string;
  partial: boolean;
  needs_person: string | null;
  next_action: string;
  cancel: { asked_at: string; before_submission: boolean; words: string } | null;
  /** quoted, charged (null when a purchase went out and no amount came back; absent when none went out), in words */
  cost: { quoted_cents: number | null; currency: string | null; charged_cents?: number | null; words: string };
  resources: Array<{ id: string; kind: string; name: string; state: string; expires_at: string | null; retained_until: string | null }>;
  /** the backend says its provider is simulated */
  simulated: boolean;
  /** one line: its name, the backend's summary, and "simulated" when it is */
  line: string;
  commands: string[];
  source: OverviewSource;
}
export interface HostingSection extends SectionBase {
  id: 'hosting';
  /** whether a backend is set up here (timmy cloud use), and its address */
  backend: { set_up: boolean; url?: string; words: string; command: string };
  /** the cached answer: when it was read, its age, old past an hour, and the newest attempt since that did not read */
  read: { at: string | null; ago?: string; old: boolean; words: string; command: string; failed?: { at: string; why: string } };
  provider: { name: string; simulated: boolean | null; words: string } | null;
  items: HostingItem[];
  more: number;
}

// ── costs (R4, H93: provider spend beside model spend) ───────────────────────

export interface ProviderSpend {
  customer: string;
  subscription: string;
  month: string;
  /** as the backend reports them, in cents (USD in this slice); null when it did not say */
  approved_cents: number | null;
  paid_cents: number | null;
  limits: { per_order_cents: number; monthly_cents: number; auto_approve_up_to_cents: number } | null;
  limits_words: string;
  /** orders whose purchase went out and no amount came back: counted, never summed as 0 */
  unknown_cost_orders: number | null;
  orders: number | null;
  words: string;
  source: OverviewSource;
}
export interface CostsSection extends SectionBase {
  id: 'costs';
  /** model spend, as the first slice has it (the same numbers as History's costs) */
  model: HistorySection['costs'] & { scope: string };
  /** provider spend, from Timmy Cloud's backend as last read */
  provider: {
    known: boolean;
    why?: string;
    read_at?: string;
    ago?: string;
    old?: boolean;
    simulated?: boolean | null;
    customers: ProviderSpend[];
    more: number;
    /** the reported amounts summed over the customers listed; absent when none reported */
    approved_cents?: number;
    paid_cents?: number;
    unknown_cost_orders: number;
    words: string;
  };
}

// ── project ──────────────────────────────────────────────────────────────────

export interface ProjectSection extends SectionBase {
  id: 'project';
  name: string;
  /** a hash of the project's folder, as its receipts name it (never the path) */
  project_id: string;
  changed: { at: string | null; basis: string };
  canvas: { state: 'same' | 'other' | 'none' | 'off' | 'unknown' | 'running'; words: string; command?: string };
}

// ── the abstract map ─────────────────────────────────────────────────────────

export const MAP_LABEL = 'layout, not geometry';
/** R4 (H93): `state`, a remote job's or an order's own word (not a proven life) */
export interface MapNode { id: string; label: string; kind: string; life?: Life; state?: string; source: OverviewSource }
export interface OverviewMap {
  label: typeof MAP_LABEL;
  words: string;
  /** R4 (H93): two more columns, drawn as a second band: remote jobs and orders, and what they depend on (devices, decisions) */
  columns: Array<{ id: 'agents' | 'workflows' | 'artifacts' | 'remote' | 'depends'; title: string; nodes: MapNode[]; more: number }>;
  edges: Array<{ from: string; to: string; why: string }>;
}

export interface Overview {
  schema: typeof OVERVIEW_SCHEMA;
  /** when the overview was built (ISO) */
  as_of: string;
  project: ProjectSection;
  needs: NeedsSection;
  devices: DevicesSection;
  hosting: HostingSection;
  costs: CostsSection;
  agents: AgentsSection;
  workflows: WorkflowsSection;
  apps: AppsSection;
  spatial: SpatialSection;
  history: HistorySection;
  map: OverviewMap;
  /** what the overview does not show, and where it came from */
  notes: string[];
}
