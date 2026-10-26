// R12 (the finish brief of 2026-10-25): Timmy's pages, in the order the permanent left rail shows them. One journey: account and
// model setup → the agent's Chat → tools and workflows → the editable canvas → runs and receipts. Each page says what it is for
// (its kicker, title and lead, in the page head), and `ready` says whether this build draws it: a page that is not drawn yet says
// so in words on the page itself (never a stand-in that looks like the feature).

/** The rail's groups: Chat on its own at the top, then WORK, CREATE and CONNECT, Help and Settings at the foot. */
export const GROUPS = Object.freeze([
  { id: 'start', label: null },
  { id: 'work', label: 'WORK' },
  { id: 'create', label: 'CREATE' },
  { id: 'connect', label: 'CONNECT' },
  { id: 'foot', label: null },
]);

/**
 * Every page: `group` (the rail), `glyph` (a plain mark beside its name; text, so it reads without an icon font), `kicker`
 * (the page head's number and purpose), `title`, `lead` (what the page is for, in one line), `context` (the right column's
 * heading on a wide window).
 */
export const PAGES = Object.freeze([
  { id: 'chat', group: 'start', glyph: '◆', title: 'Chat', kicker: '01 / START A CONVERSATION',
    lead: 'Work with Timmy in this project. Every turn runs the real agent: its tools ask you first, and each answer is sealed with a receipt.',
    context: 'Model & context' },
  { id: 'files', group: 'work', glyph: '▤', title: 'Files', kicker: '02 / THE PROJECT’S FILES',
    lead: 'The files of the project this page shows, read through the companion. Open one to read it; nothing here edits a file.',
    context: 'The open file' },
  { id: 'workflows', group: 'work', glyph: '⇶', title: 'Workflows', kicker: '03 / PLAN & RUN',
    lead: 'The project’s workflows and their documents: what each one does, what it needs, and how it is started.',
    context: 'Workflow' },
  { id: 'runs', group: 'work', glyph: '☰', title: 'Runs & receipts', kicker: '04 / PROOF',
    lead: 'What ran, with proof: each answer and job, the model or tool that did it, and its sealed receipt.',
    context: 'The selected run' },
  { id: 'canvas', group: 'work', glyph: '◫', title: 'Canvas', kicker: '05 / THE DESK',
    lead: 'A bounded desk for this project: Timmy’s cards and Rive components beside your notes and drawings, saved per project.',
    context: 'Selection' },
  { id: 'voxvision', group: 'create', glyph: '◈', title: 'VoxVision', kicker: '06 / SPATIAL RECORDS',
    lead: 'The spatial records Timmy keeps for this project: what was observed, generated or checked, each with its provenance.',
    context: 'The open record' },
  { id: 'motion', group: 'create', glyph: '◎', title: 'Motion & 3D', kicker: '07 / CREATE',
    lead: 'Meshes, scenes and their sources, with the routes that can make or change them and which of those routes are available here.',
    context: 'The open item' },
  { id: 'models', group: 'connect', glyph: '◉', title: 'Models & accounts', kicker: '08 / WHERE MODELS RUN',
    lead: 'Choose where Timmy’s model runs: on this computer (asked first), or a cloud account you connect.',
    context: 'The chosen model' },
  { id: 'tools', group: 'connect', glyph: '⚙', title: 'Tools & integrations', kicker: '09 / WHAT THE AGENT CAN USE',
    lead: 'The tools and MCP servers Timmy can call, what each one is for, and whether it was checked on this computer.',
    context: 'The selected tool' },
  { id: 'control', group: 'connect', glyph: '▣', title: 'Control Room', kicker: '10 / THE TERMINALS',
    lead: 'Timmy’s terminal panes and the room they belong to: what is running, where, and since when.',
    context: 'The selected pane' },
  { id: 'help', group: 'foot', glyph: '?', title: 'Help & find', kicker: 'HELP / FIND YOUR WAY',
    lead: 'What each page is for, how to start, the keys, and where Timmy keeps what it does.',
    context: 'Keys' },
  { id: 'settings', group: 'foot', glyph: '⚑', title: 'Settings', kicker: 'SETTINGS / THIS APP',
    lead: 'How this app looks and what it may ask this computer: the theme, local-model permission, and the project it shows.',
    context: 'About' },
]);

export const pageOf = (id) => PAGES.find((p) => p.id === id) || PAGES[0];
export const isPage = (id) => PAGES.some((p) => p.id === id);
