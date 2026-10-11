/**
 * Slash commands from one registry (playbook §17.7, DESIGN.md §10 B6): dispatched locally before the
 * model, /help generated from the same list, unknown commands answered here and never sent on.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { plural } from './steps.js';
import { nearest } from './suggest.js';

/** The four meanings with a color of their own (DESIGN.md §10 B2, B4). */
export type MeaningRole = 'verified' | 'estimate' | 'failure' | 'ai';

export interface ThemeInfo {
  source: string;
  background: string | null;
  secondary: string;
  tint: string | null;
  files: string;
  /** Whether Timmy emits color here at all (not under NO_COLOR or without color support). */
  color: boolean;
  /** The palette slot each meaning is drawn in here, or null: no color, its mark and word carry it. */
  meanings: Record<MeaningRole, number | null>;
}

const MEANING_WORDS: Record<MeaningRole, string> = { verified: 'verified', estimate: 'estimate', failure: 'failure', ai: 'model' };
const SLOT_WORDS = ['black', 'red', 'green', 'yellow', 'blue', 'violet', 'cyan', 'white'];
const slotWord = (slot: number): string => (slot < 8 ? SLOT_WORDS[slot] : `bright ${SLOT_WORDS[slot - 8]}`);

/**
 * Fourth order, step 2 (readability): the color each meaning takes on this terminal, or the fallback and
 * why. A meaning without color still has its mark and its word (README, "Terminal colors").
 */
function meaningLines(info: ThemeInfo, sep: string): Segment[][] {
  const label = { text: '  Meanings   ', role: 'secondary' as const };
  if (!info.color) return [[label, { text: 'no color: color is off here (NO_COLOR, or no color support), so marks and words carry them' }]];
  if (!info.background) {
    return [
      [label, { text: 'no color: the terminal did not say its background, so marks and words carry them' }],
      [{ text: '  For color  ', role: 'secondary' }, { text: 'timmy theme install', role: 'strong' }, { text: ', then TIMMY_PALETTE=homebrew (or night, day)' }],
    ];
  }
  const entries = Object.entries(info.meanings) as Array<[MeaningRole, number | null]>;
  const lines: Segment[][] = [[label, { text: entries.map(([role, slot]) => `${MEANING_WORDS[role]} ${slot === null ? 'no color' : slotWord(slot)}`).join(sep) }]];
  if (entries.some(([, slot]) => slot === null)) {
    lines.push([{ text: '             ' }, { text: 'no color: under 4.5:1 on this ground, so the mark and the word carry it', role: 'secondary' }]);
  }
  return lines;
}

export interface ReceiptsView {
  verify: { ok: boolean; count: number; reason?: string };
  recent: Array<{ hash: string; kind: string; when: string }>;
}

export interface ReplContext {
  agent: { getModel(): string; setModel(model: string): void; startSession(): string };
  print(segments: Segment[]): void;
  glyphs: GlyphSet;
  themeInfo?: () => ThemeInfo;
  receipts?: () => ReceiptsView;
  /** Opens `timmy watch`; returns where ("in a tmux pane"). */
  openWatch?: () => string;
  /** Opens a web view (C-13); returns one line saying where, or why not. */
  openWeb?: (target: string, allowRemote: boolean) => string;
  /** Runs the setup check and seals it (C-14); returns the lines to print. */
  setup?: () => Segment[][];
  /** The lanes Timmy can run, and whether each is installed (C-10). */
  lanes?: () => Array<{ id: string; label: string; available: boolean; install?: string }>;
  /** Opens the cockpit (`timmy center`); returns one sentence: where, or why not. */
  openCenter?: () => string;
  /** Round R1: Timmy Canvas's state (starting it when nothing serves it), or opens it (`/canvas open`). */
  canvas?: (args: string) => Promise<Segment[][]>;
  /** Round R1: what Timmy can do here, each on the ladder of AGENTS.md §8, from live checks. */
  tools?: (args: string) => Promise<Segment[][]>;
  /** R1 workspace direction: the active project, its files, workflows, jobs, preview and results. */
  workspace?: WorkspaceViews;
}

/** The workspace surfaces (src/repl/workspace.ts), one per command. */
export interface WorkspaceViews {
  project_(args: string): Segment[][];
  files(args: string): Segment[][];
  open(args: string): Segment[][];
  edit(args: string): Segment[][];
  workflows(args: string): Promise<Segment[][]>;
  run(args: string): Promise<Segment[][]>;
  preview(args: string): Promise<Segment[][]>;
  jobsView(args: string): Segment[][];
  stop(args: string): Promise<Segment[][]>;
  results(args: string): Segment[][];
  /** Round R2, look: files in (/add) and observations out (/observe). */
  add(args: string): Segment[][];
  observe(args: string): Promise<Segment[][]>;
  /** Round R2: native apps as jobs, and MCP servers through command-line routes. */
  c4d(args: string): Promise<Segment[][]>;
  ae(args: string): Promise<Segment[][]>;
  /** Round R3: Blender's own Python, headless, as a judged job. */
  blender(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H28): FreeCAD's freecadcmd, headless, as a judged job; /freecad readback reads its STEP back. */
  freecad?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H63): Unreal's own Python through UnrealEditor-Cmd, headless, as a judged job; a second Unreal process reads its levels back. */
  unreal?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H64): Adobe Illustrator through osascript: author, edit and inspect a document; Timmy reads its SVG back. */
  illustrator?(args: string): Promise<Segment[][]>;
  /** Round R3: the CadQuery enclosure-tray recipe as a durable job (src/repl/recipe.ts). */
  recipe(args: string): Promise<Segment[][]>;
  mcp(args: string): Promise<Segment[][]>;
  /** Round R2: a read-only board of the project (an HTML snapshot), opened in Timmy's Browser. */
  board(args: string): Segment[][];
  /** Round R3: `/board live` serves the board with Stop, Run and Observe on 127.0.0.1; `/board off` stops it. */
  boardLive?(args: string): Promise<Segment[][]>;
  /** Round R3 (helper H13): a code agent (Qwen Code, Claude Code, Codex, OpenCode) as a job in the project. */
  agent?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H24): a local agent edits the recipe's parameter file, the recipe rebuilds, a worker reads it back. */
  iterate?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H32): what a session that ended left running in the project, picked up (src/repl/recover.ts). */
  recover?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H27): OpenSCAD exports an STL from a .scad model as a judged job; Timmy reads the STL back. */
  scad?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H48): the Control Room: who runs what, routes, handoffs, costs as recorded, outputs, tools. */
  room?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H60): what waits on a person in the project: what is needed, why, and the command or step. */
  decisions?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H78): God's Eye View, the project at a glance (src/overview, src/repl/overview.ts). */
  overview?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H49): Timmy VoxVision's four actions over the supported spatial tools (src/repl/vox.ts). */
  inspect?(args: string): Promise<Segment[][]>;
  measure?(args: string): Promise<Segment[][]>;
  detect?(args: string): Promise<Segment[][]>;
  compare?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H61): `/vox`, the viewer layers, and `/vox view <record id> [rerun]` (src/repl/vox-view.ts). */
  voxView?(args: string): Promise<Segment[][]>;
  /** Round R4 (helper H50): Timmy Memory: recall over retained work, and lessons with evidence (src/memory/repl.ts). */
  recall?(args: string): Segment[][];
  lesson?(args: string): Segment[][];
  lessons?(args: string): Segment[][];
  /** Round R4 (helper H51): one operation in full (/op [id]) and the recent operations (/ops). */
  op?(args: string): Segment[][];
  opsView?(args: string): Segment[][];
  /** Round R4 (helper H51): runs one request (a typed line) as an operation: what it starts or seals carries its id. */
  operate?<T>(request: string, via: 'repl' | 'board' | 'act', run: () => T | Promise<T>): Promise<T>;
  /** Round R4 (helper H65): what the newest operations changed (/review [id]), and a checked restore of a kept version. */
  review?(args: string): Segment[][];
  restore?(args: string): Segment[][];
}

/** /help's sections, in order: what you work on, what you look at, setup, the session. */
export type CommandGroup = 'work' | 'look' | 'setup' | 'session';
export const GROUPS: readonly CommandGroup[] = ['work', 'look', 'setup', 'session'];
export const GROUP_LABEL: Readonly<Record<CommandGroup, string>> = { work: 'WORK', look: 'LOOK', setup: 'SETUP', session: 'SESSION' };

type CommandResult = 'exit' | void;

export interface SlashCommand {
  name: string;
  description: string;
  group: CommandGroup;
  /**
   * R4 (H40): true gives run() its arguments as typed: everything after the command's name and the spaces after it,
   * the line's two ends trimmed, every space inside kept (/mcp call's JSON holds strings whose spaces are data).
   * Without it a command gets its words joined by one space, as before.
   */
  raw?: true;
  /** A command may wait (a live check); the REPL waits for it before the next prompt. */
  run(args: string, ctx: ReplContext): CommandResult | Promise<CommandResult>;
}

/** A workspace command: prints what its view returns, or says the workspace is not here. */
const inWorkspace = (pick: (w: WorkspaceViews, args: string) => Segment[][] | Promise<Segment[][]>) => async (args: string, ctx: ReplContext): Promise<void> => {
  if (!ctx.workspace) return void ctx.print([{ text: '  The workspace is not available here.', role: 'secondary' }]);
  for (const line of await pick(ctx.workspace, args)) ctx.print(line);
};

/** Prints what an async view returns, or says it is not available here. */
async function printView(view: ((args: string) => Promise<Segment[][]>) | undefined, args: string, ctx: ReplContext, missing: string): Promise<void> {
  if (!view) return void ctx.print([{ text: `  ${missing}`, role: 'secondary' }]);
  for (const line of await view(args)) ctx.print(line);
}

export const COMMANDS: SlashCommand[] = [
  { name: 'project', group: 'work', description: 'Projects: new [--from starter], list, <name>', run: inWorkspace((w, a) => w.project_(a)) },
  { name: 'files', group: 'work', description: 'Project files by role; /files <role|folder>', run: inWorkspace((w, a) => w.files(a)) },
  { name: 'open', group: 'work', description: 'Show a file: /open <file>', run: inWorkspace((w, a) => w.open(a)) },
  { name: 'edit', group: 'work', description: 'Edit a file in your editor: /edit <file>', run: inWorkspace((w, a) => w.edit(a)) },
  { name: 'workflows', group: 'work', description: 'Workflow documents (upmd) and their blocks', run: inWorkspace((w, a) => w.workflows(a)) },
  { name: 'run', group: 'work', description: 'Run a workflow block: /run <file> <block>', run: inWorkspace((w, a) => w.run(a)) },
  { name: 'preview', group: 'work', description: 'Serve the project; it opens in Browser', run: inWorkspace((w, a) => w.preview(a)) },
  { name: 'jobs', group: 'work', description: 'Running and finished jobs; /jobs <id>', run: inWorkspace((w, a) => w.jobsView(a)) },
  { name: 'stop', group: 'work', description: 'Stop a job: /stop <id>, or /stop all', run: inWorkspace((w, a) => w.stop(a)) },
  // Round R4 (helper H32): also run as the REPL starts; on demand it lists what it saw.
  { name: 'recover', group: 'work', description: 'Pick up what an ended session left running', run: inWorkspace((w, a) => (w.recover ? w.recover(a) : [[{ text: '  /recover is not available here.', role: 'secondary' }]])) },
  { name: 'results', group: 'work', description: 'Outputs, jobs and changes, linked to files', run: inWorkspace((w, a) => w.results(a)) },
  { name: 'add', group: 'work', description: 'Copy files into refs/: /add <file…>', run: inWorkspace((w, a) => w.add(a)) },
  { name: 'observe', group: 'look', description: 'Image: /observe <file> [--qualify] [question]', run: inWorkspace((w, a) => w.observe(a)) },
  // Round R4 (H49): VoxVision. Raw: a quoted file name keeps its spaces.
  { name: 'inspect', group: 'look', raw: true, description: 'What a file is, and its facts: /inspect <f>', run: inWorkspace((w, a) => (w.inspect ? w.inspect(a) : [[{ text: '  VoxVision is not available here.', role: 'secondary' }]])) },
  { name: 'measure', group: 'look', raw: true, description: 'Labelled measured values: /measure <file>', run: inWorkspace((w, a) => (w.measure ? w.measure(a) : [[{ text: '  VoxVision is not available here.', role: 'secondary' }]])) },
  { name: 'detect', group: 'look', raw: true, description: 'QR, ArUco, a colour: /detect <file> [what]', run: inWorkspace((w, a) => (w.detect ? w.detect(a) : [[{ text: '  VoxVision is not available here.', role: 'secondary' }]])) },
  { name: 'compare', group: 'look', raw: true, description: 'Two files of one kind: /compare <a> <b>', run: inWorkspace((w, a) => (w.compare ? w.compare(a) : [[{ text: '  VoxVision is not available here.', role: 'secondary' }]])) },
  // Round R4 (H61): VoxVision's viewer layers: a record's files in Rerun's viewer (a window on this computer).
  { name: 'vox', group: 'look', description: 'A record in Rerun: /vox view <id>; /vox', run: inWorkspace((w, a) => (w.voxView ? w.voxView(a) : [[{ text: '  VoxVision is not available here.', role: 'secondary' }]])) },
  // Round R3: `/board live` and `/board off` go to the live board; `/board` alone stays the snapshot.
  { name: 'board', group: 'look', description: 'A board of the project; /board live | off', run: inWorkspace((w, a) => (w.boardLive && /^(?:live|off)$/.test(a.trim()) ? w.boardLive(a) : w.board(a))) },
  // Round R4 (helper H50): Timmy Memory. Raw: a quoted lesson text or file name keeps its spaces.
  { name: 'recall', group: 'look', raw: true, description: 'Find retained work by words, not meaning', run: inWorkspace((w, a) => (w.recall ? w.recall(a) : [[{ text: '  Timmy Memory is not available here.', role: 'secondary' }]])) },
  { name: 'lesson', group: 'work', raw: true, description: 'Add, check, eval, retire: text with evidence', run: inWorkspace((w, a) => (w.lesson ? w.lesson(a) : [[{ text: '  Timmy Memory is not available here.', role: 'secondary' }]])) },
  { name: 'lessons', group: 'work', description: 'Lessons as agent context; no model trained', run: inWorkspace((w, a) => (w.lessons ? w.lessons(a) : [[{ text: '  Timmy Memory is not available here.', role: 'secondary' }]])) },
  // Round R4 (helper H51): operations, one request each, followed through what they made (also atop the Control Room).
  { name: 'op', group: 'look', description: 'One request in full: /op [<id>]', run: inWorkspace((w, a) => (w.op ? w.op(a) : [[{ text: '  Operations are not available here.', role: 'secondary' }]])) },
  { name: 'ops', group: 'look', description: 'Recent operations, running first', run: inWorkspace((w, a) => (w.opsView ? w.opsView(a) : [[{ text: '  Operations are not available here.', role: 'secondary' }]])) },
  // Round R4 (helper H65): what each operation changed, checked now; a restore only over the file exactly as its run left it.
  { name: 'review', group: 'look', description: 'What operations changed: /review [<id>]', run: inWorkspace((w, a) => (w.review ? w.review(a) : [[{ text: '  The review is not available here.', role: 'secondary' }]])) },
  { name: 'restore', group: 'work', raw: true, description: 'Kept version back: /restore <f> --from <kept>', run: inWorkspace((w, a) => (w.restore ? w.restore(a) : [[{ text: '  /restore is not available here.', role: 'secondary' }]])) },
  // Round R4 (helper H78): God's Eye View, also the board's first section; it reads, and does nothing itself.
  { name: 'overview', group: 'look', description: "God's Eye View: the project at a glance", run: inWorkspace((w, a) => (w.overview ? w.overview(a) : [[{ text: '  The overview is not available here.', role: 'secondary' }]])) },
  // Round R4 (helper H48): the Control Room, also a section of the board.
  { name: 'room', group: 'look', description: 'Control Room: runs, costs, tools; /room <id>', run: inWorkspace((w, a) => (w.room ? w.room(a) : [[{ text: '  The Control Room is not available here.', role: 'secondary' }]])) },
  // Round R4 (helper H60): what waits on you (also first in the Control Room); it reads, and does nothing itself.
  { name: 'decisions', group: 'look', description: 'What waits on you: what, why, what to type', run: inWorkspace((w, a) => (w.decisions ? w.decisions(a) : [[{ text: '  Decisions are not available here.', role: 'secondary' }]])) },
  { name: 'c4d', group: 'work', description: 'Cinema 4D Python as a job: /c4d <script.py>', run: inWorkspace((w, a) => w.c4d(a)) },
  { name: 'ae', group: 'work', description: 'After Effects: author, edit, inspect, render', run: inWorkspace((w, a) => w.ae(a)) },
  { name: 'blender', group: 'work', description: 'Blender Python as a job: /blender <script.py>', run: inWorkspace((w, a) => w.blender(a)) },
  { name: 'scad', group: 'work', description: 'OpenSCAD to STL, read back: /scad <m.scad>', run: inWorkspace((w, a) => (w.scad ? w.scad(a) : [[{ text: '  /scad is not available here.', role: 'secondary' }]])) },
  { name: 'freecad', group: 'work', description: 'FreeCAD Python as a job: /freecad <script.py>', run: inWorkspace((w, a) => (w.freecad ? w.freecad(a) : [[{ text: '  FreeCAD is not available here.', role: 'secondary' }]])) },
  // Round R4 (helper H63). Raw: a quoted .uproject or script path keeps its spaces.
  { name: 'unreal', group: 'work', raw: true, description: 'Unreal Python: /unreal <p.uproject> <s.py>', run: inWorkspace((w, a) => (w.unreal ? w.unreal(a) : [[{ text: '  Unreal is not available here.', role: 'secondary' }]])) },
  // Round R4 (helper H64): Adobe Illustrator through osascript (src/native/illustrator.ts).
  { name: 'illustrator', group: 'work', description: 'Illustrator: author, edit, inspect artwork', run: inWorkspace((w, a) => (w.illustrator ? w.illustrator(a) : [[{ text: '  Illustrator is not available here.', role: 'secondary' }]])) },
  { name: 'recipe', group: 'work', description: 'CadQuery tray recipe as a job: /recipe tray', run: inWorkspace((w, a) => w.recipe(a)) },
  // R4 (H40): /mcp gets its line as typed, so a JSON string's runs of spaces reach the server as they were written.
  { name: 'mcp', group: 'setup', description: 'MCP servers and tools: /mcp [tools|call]', raw: true, run: inWorkspace((w, a) => w.mcp(a)) },
  // Round R3 (helper H13): a code agent as a durable, cancellable job.
  { name: 'agent', group: 'work', description: 'A code agent as a job: /agent qwen <task>', run: inWorkspace((w, a) => (w.agent ? w.agent(a) : [[{ text: '  Code agents are not available here.', role: 'secondary' }]])) },
  // Round R4 (helper H24): the connected flow: agent, durable rebuild, independent readback, on the board.
  { name: 'iterate', group: 'work', description: 'Agent edits; tray/Blender rebuilds: /iterate', run: inWorkspace((w, a) => (w.iterate ? w.iterate(a) : [[{ text: '  /iterate is not available here.', role: 'secondary' }]])) },
  {
    name: 'web',
    group: 'look',
    description: 'Open a local page here (map: Mission Map)',
    run: (args, ctx) => {
      const parts = args.split(/\s+/).filter(Boolean);
      const allow = parts.includes('--allow-remote');
      const target = parts.filter((p) => p !== '--allow-remote').join(' ');
      if (!target) {
        ctx.print([{ text: '  Usage: /web map | studio | <receipt> | <local url>', role: 'secondary' }]);
        return void ctx.print([{ text: '         /web --allow-remote <url> for any other page', role: 'secondary' }]);
      }
      if (!ctx.openWeb) return void ctx.print([{ text: '  Web views are not available here.', role: 'secondary' }]);
      ctx.print([{ text: `  ${ctx.openWeb(target, allow)}` }]);
    },
  },
  {
    name: 'browser',
    group: 'look',
    description: "Open a page in Timmy's Browser (as /web)",
    run: (args, ctx) => COMMANDS.find((c) => c.name === 'web')!.run(args, ctx),
  },
  {
    name: 'canvas',
    group: 'look',
    description: 'Timmy Canvas: where, its state; /canvas open',
    run: (args, ctx) => printView(ctx.canvas, args, ctx, 'Timmy Canvas is not available here.'),
  },
  {
    name: 'watch',
    group: 'look',
    description: 'Open the full-screen monitor (timmy watch)',
    run: (_args, ctx) => {
      const where = ctx.openWatch?.();
      ctx.print([{ text: where ? `  Watch opened ${where}.` : '  Watch is not available here.', role: 'secondary' }]);
    },
  },
  {
    name: 'center',
    group: 'look',
    description: 'Open the cockpit (timmy center)',
    run: (_args, ctx) => {
      ctx.print([{ text: `  ${ctx.openCenter?.() ?? 'The cockpit is not available here.'}`, role: 'secondary' }]);
    },
  },
  {
    name: 'receipts',
    group: 'look',
    description: 'Verify the chain, then the latest receipts',
    run: (_args, ctx) => {
      const view = ctx.receipts?.();
      if (!view) return void ctx.print([{ text: '  Receipts are not available here.', role: 'secondary' }]);
      const g = ctx.glyphs;
      if (!view.verify.ok) {
        ctx.print([{ text: '  ' }, { text: `${g.fail} Chain broken`, role: 'failure' }, { text: `  ${view.verify.reason ?? 'verification failed'}` }]);
      } else if (view.verify.count === 0) {
        // An empty chain proves nothing: no green check for it.
        ctx.print([{ text: '  No receipts yet: nothing to verify.', role: 'secondary' }]);
      } else {
        ctx.print([{ text: '  ' }, { text: `${g.ok} Chain verified`, role: 'verified' }, { text: `  ${view.verify.count} ${plural('receipt', view.verify.count)}`, role: 'secondary' }]);
      }
      for (const r of view.recent) {
        ctx.print([{ text: `  ${g.bullet} ` }, { text: r.hash.slice(0, 15), role: 'strong' }, { text: `  ${r.kind}  ${r.when}`, role: 'secondary' }]);
      }
    },
  },
  {
    name: 'tools',
    group: 'setup',
    description: 'What works here, checked live; all or <name>',
    run: (args, ctx) => printView(ctx.tools, args, ctx, 'The tool check is not available here.'),
  },
  {
    name: 'lanes',
    group: 'setup',
    description: 'The lanes, ready or not',
    run: (_args, ctx) => {
      const lanes = ctx.lanes?.();
      if (!lanes) return void ctx.print([{ text: '  Lanes are not available here.', role: 'secondary' }]);
      const g = ctx.glyphs;
      const blank = ' '.repeat(g.bullet.length);
      for (const l of lanes) {
        ctx.print(l.available
          ? [{ text: `  ${g.bullet} ` }, { text: l.id.padEnd(10), role: 'strong' }, { text: ` ${l.label} ${g.sep} ready`, role: 'secondary' }]
          : [{ text: `  ${blank} ${l.id.padEnd(10)}` }, { text: ` ${l.label} ${g.sep} not installed${l.install ? `: ${l.install}` : ''}`, role: 'secondary' }]);
      }
    },
  },
  {
    name: 'setup',
    group: 'setup',
    description: 'Check what Timmy needs, and seal it',
    run: (_args, ctx) => {
      const lines = ctx.setup?.();
      if (!lines) return void ctx.print([{ text: '  The setup check is not available here.', role: 'secondary' }]);
      for (const line of lines) ctx.print(line);
    },
  },
  {
    name: 'theme',
    group: 'setup',
    description: 'Your terminal\'s colors, and the palettes',
    run: (_args, ctx) => {
      const info = ctx.themeInfo?.();
      if (!info) return void ctx.print([{ text: '  Palette details are not available here.', role: 'secondary' }]);
      const s = ` ${ctx.glyphs.sep} `;
      ctx.print([{ text: '  Palette    ', role: 'secondary' }, { text: info.source, role: 'strong' }]);
      ctx.print([{ text: '  Measured   ', role: 'secondary' }, { text: `ground ${info.background ?? 'unknown'}${s}secondary ${info.secondary}${s}input tint ${info.tint ?? 'none'}` }]);
      for (const line of meaningLines(info, s)) ctx.print(line);
      ctx.print([{ text: '  Themes     ', role: 'secondary' }, { text: info.files }, { text: ' (Homebrew, Night, Day: timmy theme install)', role: 'secondary' }]);
    },
  },
  {
    name: 'model',
    group: 'setup',
    description: 'Show the model, or switch: /model <id>',
    run: (args, ctx) => {
      const current = ctx.agent.getModel();
      if (!args) return void ctx.print([{ text: '  Model: ', role: 'secondary' }, { text: current, role: 'strong' }]);
      ctx.agent.setModel(args);
      ctx.print([{ text: '  Model: ', role: 'secondary' }, { text: `${current} ${ctx.glyphs.arrow} ` }, { text: args, role: 'strong' }]);
    },
  },
  {
    name: 'new',
    group: 'session',
    description: 'Start a new conversation',
    run: (_args, ctx) => {
      ctx.agent.startSession();
      ctx.print([{ text: '  New conversation.', role: 'strong' }]);
    },
  },
  {
    name: 'help',
    group: 'session',
    description: 'List these commands',
    run: (_args, ctx) => {
      for (const group of GROUPS) {
        ctx.print([{ text: `  ${GROUP_LABEL[group]}`, role: 'secondary' }]);
        for (const c of COMMANDS.filter((x) => x.group === group)) ctx.print([{ text: `  /${c.name.padEnd(11)}`, role: 'strong' }, { text: ` ${c.description}`, role: 'secondary' }]);
      }
    },
  },
  { name: 'exit', group: 'session', description: 'Quit Timmy', run: () => 'exit' },
];

/** Runs a command: at once for most, or a promise for one that waits on a live check (round R1). */
export function runSlash(input: string, ctx: ReplContext): 'exit' | 'handled' | Promise<'exit' | 'handled'> {
  const line = input.trim().slice(1);
  const [word, ...rest] = line.split(/\s+/);
  const command = COMMANDS.find((c) => c.name === word);
  if (!command) {
    const near = nearest(word, COMMANDS.map((c) => c.name));
    ctx.print([{ text: `  Unknown command: /${word}.${near ? ` Did you mean /${near}?` : ''} Type /help for available commands.`, role: 'secondary' }]);
    return 'handled';
  }
  // R4 (H40): a raw command gets the line after its name as typed; the others, its words joined by one space.
  const ran = command.run(command.raw ? line.slice(word.length).trim() : rest.join(' ').trim(), ctx);
  const settle = (r: CommandResult): 'exit' | 'handled' => (r === 'exit' ? 'exit' : 'handled');
  return ran instanceof Promise ? ran.then(settle) : settle(ran);
}
