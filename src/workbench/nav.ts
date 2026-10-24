/**
 * R4 (H110): the Workbench's navigation. R11 round 7 (H177; the operator's order of 2026-10-24 and the lead's D3): grouped as
 * the Chat screen's rail groups the destinations (src/workbench/destinations.ts): Chat; WORK (Files, Workflows, Runs & receipts,
 * Canvas); CREATE (Vision, Motion & 3D); CONNECT (Models & accounts, Tools & integrations, Control Room), each page's other
 * workspaces after it (Motion after 3D Create; God's Eye View, REA, Templates and Fleet & Clef under CONNECT). Each workspace
 * has a title (its page head's), one line saying what this terminal view shows (the page head's description, kept to 76
 * cells so an 80-column terminal shows it whole), and the family of tools it gathers. The words are Timmy's own: nothing here
 * is the browser prototype's sample text. Before round 7 the groups were the terminal reference's CREATE, OPERATE, LIBRARY and
 * Connections at the foot.
 */

export type WorkspaceId =
  | 'chat' | 'studio' | 'voxvision' | 'create3d' | 'motion'
  | 'workflows' | 'control' | 'overview' | 'rea' | 'fleet' | 'logs'
  | 'files' | 'templates' | 'tools'
  | 'connections';

export type GroupId = 'chat' | 'work' | 'create' | 'connect';

export interface NavItem {
  id: WorkspaceId;
  group: GroupId;
  /** its name in the navigation */
  label: string;
  /** the page head's title: the destination's name as the rail says it, then what the page is */
  title: string;
  /** one line: what this view shows here, in the terminal (the page head's description; at most 76 cells) */
  purpose: string;
  /** what the bottom row calls this task's controls */
  task: string;
  /** R11 (H167; step 3a): the Chat screen's rail names for it (the plan's section 2), which the finder matches too */
  also?: readonly string[];
  /** R11 phase 2 (H168's pass 4b R45): the Chat screen's rail name for it, where the rail names it otherwise (the finder leads with it) */
  rail?: string;
}

export const NAV: readonly NavItem[] = [
  { id: 'chat', group: 'chat', label: 'Chat', title: 'Chat · conversation', task: 'Conversation', purpose: 'Talk to Timmy about this project; the route says where it goes and its cost.' },
  { id: 'files', group: 'work', label: 'Files', title: 'Files · the project tree', task: 'Files', purpose: 'Every project file by kind: source, references, workflows, results, records.' },
  { id: 'workflows', group: 'work', label: 'Workflows', title: 'Workflows · plan and run', task: 'Workflow', purpose: 'Each workflow document\'s blocks, which need you, and how each last ended.' },
  { id: 'logs', group: 'work', label: 'Logs & Receipts', title: 'Runs & receipts · events, operations and the chain', task: 'Logs and receipts', purpose: 'The event log newest first, each operation to its receipt, and the chain.', rail: 'Runs & receipts', also: ['Runs & receipts', 'Logs & records'] },
  { id: 'studio', group: 'work', label: 'Studio', title: 'Canvas · Studio boards and cards', task: 'Studio outline', purpose: 'This project\'s Studio cards in outline, by operation; s opens the canvas.', rail: 'Canvas', also: ['Canvas'] },
  { id: 'voxvision', group: 'create', label: 'VoxVision', title: 'Vision · VoxVision, 2D and 3D inspection', task: 'Inspection', purpose: 'Every vision tool with its status as observed, and this project\'s records.', rail: 'Vision', also: ['Vision'] },
  // R5 (H131; the QA of e7f853e, defect 23): the pane says the tab's own name (6 3D & Motion), and which of its two views
  { id: 'create3d', group: 'create', label: '3D Create', title: 'Motion & 3D · scenes, CAD and compositions', task: 'Scenes and CAD', purpose: 'The 3D, CAD and motion apps Timmy drives, what each needs, their runs here.', rail: 'Motion & 3D', also: ['Motion & 3D'] },
  { id: 'motion', group: 'create', label: 'Motion', title: 'Motion & 3D · compositions and renders first', task: 'Compositions', purpose: 'After Effects as Timmy drives it, what it needs, and this project\'s renders.', also: ['Motion & 3D'] },
  { id: 'connections', group: 'connect', label: 'Connections', title: 'Models & accounts · connections and recent work', task: 'Connections', purpose: 'Chat\'s keys and servers as last observed, and this project\'s recent work.', rail: 'Models & accounts', also: ['Models & accounts', 'Models & keys'] },
  { id: 'overview', group: 'connect', label: 'God\'s Eye View', title: 'God\'s Eye View · the project at a glance', task: 'Overview', purpose: 'What needs you first, then agents, workflows, apps, artifacts and history.' },
  { id: 'tools', group: 'connect', label: 'All tools', title: 'Tools & integrations · capabilities', task: 'Tool library', purpose: 'Every capability Timmy registers, its rung, and the step that sets it up.', rail: 'Tools & integrations', also: ['Tools & integrations', 'Tools & MCP'] },
  { id: 'rea', group: 'connect', label: 'REA', title: 'REA · analysis', task: 'Analysis', purpose: 'REA\'s registered capabilities and this project\'s REA records, as they are.' },
  { id: 'templates', group: 'connect', label: 'Templates', title: 'Templates · public starters', task: 'Templates', purpose: 'Public project starters and Studio board templates; none holds private work.' },
  { id: 'control', group: 'connect', label: 'Control Room', title: 'Control Room · jobs, chat turns and decisions', task: 'Jobs, chat turns and decisions', purpose: 'What runs, what ended and what waits on you; every surface\'s chat turns.' },
  // R5 (H134): tab 8's and tab 0's bodies (src/workbench/fleet-tab.ts, src/workbench/logs-tab.ts)
  { id: 'fleet', group: 'connect', label: 'Fleet & Clef', title: 'Fleet & Clef · plans, recommendations and services', task: 'Fleet and Clef', purpose: 'Fleet plans with their counts, Clef-Omni\'s decisions, Cloudflare, services.' },
];

/** The groups in the rail's order, with their labels (the Chat group has none: Chat stands alone above WORK). */
export const GROUPS: readonly GroupId[] = ['chat', 'work', 'create', 'connect'];
export const GROUP_LABEL: Readonly<Record<GroupId, string>> = { chat: '', work: 'WORK', create: 'CREATE', connect: 'CONNECT' };

/** The widest a workspace's one-line description is (an 80-column terminal's page head shows it whole). */
export const PURPOSE_CELLS = 76;

export const navItem = (id: WorkspaceId): NavItem => NAV.find((n) => n.id === id) ?? NAV[0];

/** The workspaces in the order the arrow keys move through them. */
export const NAV_ORDER: readonly WorkspaceId[] = NAV.map((n) => n.id);

/**
 * The workspaces whose name matches `query`, best first: the ones whose name (the navigation's, or the Chat screen's rail's:
 * `also`, R11 step 3a) or any word of it starts with the words, then the ones whose name or title holds them. Every
 * workspace with no words.
 */
export function findWorkspaces(query: string): NavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...NAV];
  const names = (n: NavItem): string[] => [n.label, ...(n.also ?? [])].map((x) => x.toLowerCase());
  const starts = NAV.filter((n) => names(n).some((x) => x.startsWith(q) || x.split(/[\s']+/).some((w) => w.startsWith(q))));
  const holds = NAV.filter((n) => !starts.includes(n) && (names(n).some((x) => x.includes(q)) || n.title.toLowerCase().includes(q)));
  return [...starts, ...holds];
}

/**
 * Which capability rows (src/capabilities, the /tools ladder) each tool workspace gathers, by row id. VoxVision is the whole
 * collection of Timmy's 2D and 3D vision (its `vox:` rows, the Look worker and the vision adapters); REA has no row in this
 * revision (src/rea is being built), which its view says.
 */
export const FAMILY_ROWS: Readonly<Partial<Record<WorkspaceId, (id: string, kind: string) => boolean>>> = {
  voxvision: (id, kind) => kind === 'vox' || id === 'look' || id === 'adapters',
  create3d: (id) => ['c4dpy', 'blender', 'openscad', 'freecad', 'unreal', 'recipe-tray'].includes(id),
  motion: (id) => ['aerender', 'afterfx'].includes(id),
  rea: (id) => id === 'rea' || id.startsWith('rea:'),
};

/** The native apps whose runs each tool workspace lists (src/native's records in .timmy/native). */
/**
 * R5 (H131; the QA of e7f853e, defect 23): motion apps tab 6 names that Timmy has no tool for yet: said so, with why, never
 * as a rung (no plan file of this revision names them, so not even "proposed").
 */
export const NOT_IN_TIMMY: Readonly<Partial<Record<WorkspaceId, ReadonlyArray<{ name: string; why: string }>>>> = {
  create3d: [
    { name: 'Rive', why: 'no adapter drives Rive\'s editor or its runtime here yet' },
    { name: 'Theatre.js', why: 'no adapter drives Theatre.js here yet' },
    { name: 'HyperFrames', why: 'no tool here yet: /lanes names a renderer lane for it (npx --yes hyperframes, a download when first run), and no run of it is recorded here' },
  ],
};

export const FAMILY_APPS: Readonly<Partial<Record<WorkspaceId, readonly string[]>>> = {
  create3d: ['c4dpy', 'blender', 'openscad', 'freecad', 'unreal'],
  motion: ['aerender', 'afterfx'],
};

