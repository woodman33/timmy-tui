/**
 * R4 (H110): the Workbench's navigation, as the operator's terminal reference lays it out (TERMINAL-REFERENCE.txt, 2026-10-11):
 * CREATE (Chat, Studio, VoxVision, 3D Create, Motion), OPERATE (Workflows, Control Room, God's Eye View, REA), LIBRARY (Files,
 * Templates, All tools), and Connections at the foot. Each workspace has a title, one line saying what this terminal view
 * shows, and the family of tools it gathers. The words are Timmy's own: nothing here is the browser prototype's sample text.
 */

export type WorkspaceId =
  | 'chat' | 'studio' | 'voxvision' | 'create3d' | 'motion'
  | 'workflows' | 'control' | 'overview' | 'rea'
  | 'files' | 'templates' | 'tools'
  | 'connections';

export type GroupId = 'create' | 'operate' | 'library' | 'foot';

export interface NavItem {
  id: WorkspaceId;
  group: GroupId;
  /** its name in the navigation */
  label: string;
  /** the top's title */
  title: string;
  /** one line: what this view shows here, in the terminal */
  purpose: string;
  /** what the bottom row calls this task's controls */
  task: string;
}

export const NAV: readonly NavItem[] = [
  { id: 'chat', group: 'create', label: 'Chat', title: 'Chat · conversation', task: 'Conversation', purpose: 'Talk to Timmy about this project; the route says where a message would go and what it costs.' },
  { id: 'studio', group: 'create', label: 'Studio', title: 'Studio · boards and cards', task: 'Studio outline', purpose: 'The project\'s Studio cards in outline, by operation; Studio · Show opens the rich canvas.' },
  { id: 'voxvision', group: 'create', label: 'VoxVision', title: 'VoxVision · 2D and 3D inspection', task: 'Inspection', purpose: 'All of Timmy\'s vision tools with their real status, and this project\'s VoxVision records.' },
  { id: 'create3d', group: 'create', label: '3D Create', title: '3D Create · native scenes and CAD', task: 'Scenes and CAD', purpose: 'The 3D and CAD apps Timmy drives, what each needs, and this project\'s runs of them.' },
  { id: 'motion', group: 'create', label: 'Motion', title: 'Motion · compositions and renders', task: 'Compositions', purpose: 'After Effects as Timmy drives it, what it needs, and this project\'s renders.' },
  { id: 'workflows', group: 'operate', label: 'Workflows', title: 'Workflows · plan and run', task: 'Workflow', purpose: 'Each workflow document\'s named blocks, which need you, and how each one last ended.' },
  { id: 'control', group: 'operate', label: 'Control Room', title: 'Control Room · jobs and decisions', task: 'Jobs and decisions', purpose: 'What runs, what ended and what waits on you, each with its job and operation.' },
  { id: 'overview', group: 'operate', label: 'God\'s Eye View', title: 'God\'s Eye View · the project at a glance', task: 'Overview', purpose: 'What needs you first, then agents, workflows, apps, artifacts and history, each with its source.' },
  { id: 'rea', group: 'operate', label: 'REA', title: 'REA · analysis', task: 'Analysis', purpose: 'REA\'s registered capabilities and this project\'s REA records, as this revision has them.' },
  { id: 'files', group: 'library', label: 'Files', title: 'Files · the project tree', task: 'Files', purpose: 'Every project file by kind: editable source, references, workflows, results and run records.' },
  { id: 'templates', group: 'library', label: 'Templates', title: 'Templates · public starters', task: 'Templates', purpose: 'Public project starters and Studio board templates; none holds private work.' },
  { id: 'tools', group: 'library', label: 'All tools', title: 'All tools · capabilities', task: 'Tool library', purpose: 'Every capability Timmy registers, its rung, and the step that sets it up.' },
  { id: 'connections', group: 'foot', label: 'Connections', title: 'Connections · this computer', task: 'Connections', purpose: 'This Workbench\'s Companion and Studio servers, the chat route and where receipts are kept.' },
];

export const GROUP_LABEL: Readonly<Record<GroupId, string>> = { create: 'CREATE', operate: 'OPERATE', library: 'LIBRARY', foot: '' };

export const navItem = (id: WorkspaceId): NavItem => NAV.find((n) => n.id === id) ?? NAV[0];

/** The workspaces in the order the arrow keys move through them. */
export const NAV_ORDER: readonly WorkspaceId[] = NAV.map((n) => n.id);

/** The workspaces whose label matches `query` (any word's start, without case). */
export function findWorkspaces(query: string): NavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...NAV];
  return NAV.filter((n) => n.label.toLowerCase().split(/[\s']+/).some((w) => w.startsWith(q)) || n.label.toLowerCase().startsWith(q) || n.title.toLowerCase().includes(q));
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
export const FAMILY_APPS: Readonly<Partial<Record<WorkspaceId, readonly string[]>>> = {
  create3d: ['c4dpy', 'blender', 'openscad', 'freecad', 'unreal'],
  motion: ['aerender', 'afterfx'],
};
