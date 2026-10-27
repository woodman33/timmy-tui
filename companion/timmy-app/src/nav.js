// R12 (the finish brief of 2026-10-25), regrouped in the 07:37 completion pass on the operator's 07:57 word: the permanent left rail
// carries the top functions (Chat; the four apps — image, video, 3D, 2D animation; Control Room and the OpenHands sandbox; MCP →
// CLI, Timmy MCP, Files and Integrations; Runs, Settings and Help at the foot). The other pages (Canvas, Workflows, Motion & 3D,
// VoxVision, Animate, Models & accounts) sit behind the rail's WORKSPACES disclosure, each still its own page.
// Before that: one journey, account and
// model setup → the agent's Chat → tools and workflows → the editable canvas → runs and receipts. Each page says what it is for
// (its kicker, title and lead, in the page head), and `ready` says whether this build draws it: a page that is not drawn yet says
// so in words on the page itself (never a stand-in that looks like the feature).

/** The rail's groups: Chat on its own at the top, then APPS, AGENTS and TOOLS, the WORKSPACES disclosure, Runs/Settings/Help at the foot. */
export const GROUPS = Object.freeze([
  { id: 'start', label: null },
  { id: 'apps', label: 'APPS' },
  { id: 'agents', label: 'AGENTS' },
  { id: 'tools', label: 'TOOLS' },
  { id: 'more', label: 'WORKSPACES', disclosure: true },
  { id: 'foot', label: null },
]);

/**
 * Every page: `group` (the rail), `glyph` (a plain mark beside its name; text, so it reads without an icon font), `kicker`
 * (the page head's number and purpose), `title`, `lead` (what the page is for, in one line), `context` (the right column's
 * heading on a wide window).
 */
export const PAGES = Object.freeze([
  { id: 'chat', group: 'start', glyph: '◆', title: 'Chat', kicker: 'START / A CONVERSATION',
    lead: 'Work with Timmy in this project. Every turn runs the real agent: its tools ask you first, and each answer is sealed with a receipt.',
    context: 'Model & context' },
  // the four launch mini-apps, each its owner's app, hosted through Timmy's frame gateway (or waiting, in words)
  { id: 'card-lab', group: 'apps', glyph: '▧', title: 'Image · Card Lab', kicker: 'APP / IMAGE',
    lead: 'Inspect, research and decide on images and cards, with broadcast controls for a reviewed card.',
    context: 'The app' },
  { id: 'film-room', group: 'apps', glyph: '▶', title: 'Video · Film Room', kicker: 'APP / VIDEO',
    lead: 'Analyze game film: saved projects, clips, annotations and stats.',
    context: 'The app' },
  { id: 'model-studio', group: 'apps', glyph: '◭', title: '3D · Model Studio', kicker: 'APP / 3D',
    lead: 'Sketch → image → generate 3D → studio, with native CAD engines and revisions. Appearance generation is not measured geometry.',
    context: 'The app' },
  { id: 'stream-studio', group: 'apps', glyph: '∿', title: '2D Animation · Stream Studio', kicker: 'APP / 2D ANIMATION',
    lead: 'Compose a scene, animate it, preview and export it (SVG frame, HTML player). Broadcast is not built.',
    context: 'The app' },
  { id: 'control', group: 'agents', glyph: '▣', title: 'Control Room', kicker: 'AGENTS / EVERY HARNESS',
    lead: 'Timmy’s agent harnesses in one room: start one on a copy of this project, follow it, stop it, and read what it changed.',
    context: 'The selected pane' },
  { id: 'openhands', group: 'agents', glyph: '◇', title: 'OpenHands sandbox', kicker: 'AGENTS / OPENHANDS',
    lead: 'OpenHands on a disposable copy of this project: its setup here, its runs, their changed files and receipts.',
    context: 'The selected run' },
  { id: 'mcp-cli', group: 'tools', glyph: '⇄', title: 'MCP → CLI', kicker: 'TOOLS / MCP TO CLI',
    lead: 'Any MCP server’s tools as command-line calls, through MCPorter or the SDK: list, check the arguments, call, and keep the receipt.',
    context: 'The selected call' },
  { id: 'timmy-mcp', group: 'tools', glyph: 'T', title: 'Timmy MCP', kicker: 'TOOLS / TIMMY’S OWN SERVER',
    lead: 'The tools Timmy itself serves over MCP (`timmy mcp serve`), for another agent or editor to call.',
    context: 'The selected tool' },
  { id: 'files', group: 'tools', glyph: '▤', title: 'Files', kicker: 'TOOLS / THE PROJECT’S FILES',
    lead: 'The files of the project this page shows, and what the apps sent back. Open one to read it; nothing here edits a file.',
    context: 'The open file' },
  { id: 'tools', group: 'tools', glyph: '⚙', title: 'Integrations', kicker: 'TOOLS / INTEGRATIONS',
    lead: 'Every adapter in five words kept apart: installed, signed in, discovered, ran here, qualified.',
    context: 'The selected tool' },
  // behind the WORKSPACES disclosure: canvases and the pages that feed them
  { id: 'canvas', group: 'more', glyph: '◫', title: 'Canvas', kicker: 'WORKSPACE / THE DESK',
    lead: 'A bounded desk for this project: Timmy’s cards and Rive components beside your notes and drawings, saved per project.',
    context: 'Selection' },
  { id: 'workflows', group: 'more', glyph: '⇶', title: 'Workflows', kicker: 'WORKSPACE / PLAN & RUN',
    lead: 'The project’s workflows and their documents: what each one does, what it needs, and how it is started.',
    context: 'Workflow' },
  { id: 'motion', group: 'more', glyph: '◎', title: 'Motion & 3D', kicker: 'WORKSPACE / MESHES & SCENES',
    lead: 'Meshes, scenes and their sources, with the routes that can make or change them and which of those routes are available here.',
    context: 'The open item' },
  { id: 'voxvision', group: 'more', glyph: '◈', title: 'VoxVision', kicker: 'WORKSPACE / SPATIAL RECORDS',
    lead: 'The spatial records Timmy keeps for this project: what was observed, generated or checked, each with its provenance.',
    context: 'The open record' },
  { id: 'animate', group: 'more', glyph: '≈', title: 'Timmy Animate', kicker: 'WORKSPACE / THE MOTION ENGINE',
    lead: 'Motion paths, layers, states and exports: the engine inside the 2D animation app, with its own tools.',
    context: 'The app' },
  { id: 'models', group: 'more', glyph: '◉', title: 'Models & accounts', kicker: 'WORKSPACE / WHERE MODELS RUN',
    lead: 'Choose where Timmy’s model runs: on this computer (asked first), or a cloud account you connect.',
    context: 'The chosen model' },
  { id: 'runs', group: 'foot', glyph: '☰', title: 'Runs & receipts', kicker: 'PROOF / RUNS & RECEIPTS',
    lead: 'What ran, with proof: each answer and job, the model or tool that did it, and its sealed receipt.',
    context: 'The selected run' },
  { id: 'settings', group: 'foot', glyph: '⚑', title: 'Settings & options', kicker: 'SETTINGS / THIS APP',
    lead: 'How this app looks and what it may ask this computer: the theme, local-model permission, and the project it shows.',
    context: 'About' },
  { id: 'help', group: 'foot', glyph: '?', title: 'Help & find', kicker: 'HELP / FIND YOUR WAY',
    lead: 'What each page is for, how to start, the keys, and where Timmy keeps what it does.',
    context: 'Keys' },
]);

export const pageOf = (id) => PAGES.find((p) => p.id === id) || PAGES[0];
export const isPage = (id) => PAGES.some((p) => p.id === id);
