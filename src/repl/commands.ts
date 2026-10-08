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
}

type CommandResult = 'exit' | void;

export interface SlashCommand {
  name: string;
  description: string;
  /** A command may wait (a live check); the REPL waits for it before the next prompt. */
  run(args: string, ctx: ReplContext): CommandResult | Promise<CommandResult>;
}

/** Prints what an async view returns, or says it is not available here. */
async function printView(view: ((args: string) => Promise<Segment[][]>) | undefined, args: string, ctx: ReplContext, missing: string): Promise<void> {
  if (!view) return void ctx.print([{ text: `  ${missing}`, role: 'secondary' }]);
  for (const line of await view(args)) ctx.print(line);
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'List these commands',
    run: (_args, ctx) => {
      for (const c of COMMANDS) ctx.print([{ text: `  /${c.name.padEnd(11)}`, role: 'strong' }, { text: ` ${c.description}`, role: 'secondary' }]);
    },
  },
  {
    name: 'model',
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
    description: 'Start a new conversation',
    run: (_args, ctx) => {
      ctx.agent.startSession();
      ctx.print([{ text: '  New conversation.', role: 'strong' }]);
    },
  },
  {
    name: 'setup',
    description: 'Check what Timmy needs, and seal it',
    run: (_args, ctx) => {
      const lines = ctx.setup?.();
      if (!lines) return void ctx.print([{ text: '  The setup check is not available here.', role: 'secondary' }]);
      for (const line of lines) ctx.print(line);
    },
  },
  {
    name: 'theme',
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
    name: 'receipts',
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
    name: 'web',
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
    name: 'lanes',
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
    name: 'tools',
    description: 'What works here, checked live; /tools all',
    run: (args, ctx) => printView(ctx.tools, args, ctx, 'The tool check is not available here.'),
  },
  {
    name: 'canvas',
    description: 'Timmy Canvas: where, its state; /canvas open',
    run: (args, ctx) => printView(ctx.canvas, args, ctx, 'Timmy Canvas is not available here.'),
  },
  {
    name: 'center',
    description: 'Open the cockpit (timmy center)',
    run: (_args, ctx) => {
      ctx.print([{ text: `  ${ctx.openCenter?.() ?? 'The cockpit is not available here.'}`, role: 'secondary' }]);
    },
  },
  {
    name: 'watch',
    description: 'Open the full-screen monitor (timmy watch)',
    run: (_args, ctx) => {
      const where = ctx.openWatch?.();
      ctx.print([{ text: where ? `  Watch opened ${where}.` : '  Watch is not available here.', role: 'secondary' }]);
    },
  },
  { name: 'exit', description: 'Quit Timmy', run: () => 'exit' },
];

/** Runs a command: at once for most, or a promise for one that waits on a live check (round R1). */
export function runSlash(input: string, ctx: ReplContext): 'exit' | 'handled' | Promise<'exit' | 'handled'> {
  const [word, ...rest] = input.trim().slice(1).split(/\s+/);
  const command = COMMANDS.find((c) => c.name === word);
  if (!command) {
    const near = nearest(word, COMMANDS.map((c) => c.name));
    ctx.print([{ text: `  Unknown command: /${word}.${near ? ` Did you mean /${near}?` : ''} Type /help for available commands.`, role: 'secondary' }]);
    return 'handled';
  }
  const ran = command.run(rest.join(' ').trim(), ctx);
  const settle = (r: CommandResult): 'exit' | 'handled' => (r === 'exit' ? 'exit' : 'handled');
  return ran instanceof Promise ? ran.then(settle) : settle(ran);
}
