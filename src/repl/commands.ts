/**
 * Slash commands from one registry (playbook §17.7, DESIGN.md §10 B6): dispatched locally before the
 * model, /help generated from the same list, unknown commands answered here and never sent on.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { plural } from './steps.js';
import { nearest } from './suggest.js';

export interface ThemeInfo {
  source: string;
  background: string | null;
  secondary: string;
  tint: string | null;
  files: string;
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
}

export interface SlashCommand {
  name: string;
  description: string;
  run(args: string, ctx: ReplContext): 'exit' | void;
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
      ctx.print([{ text: '  Themes     ', role: 'secondary' }, { text: info.files }, { text: ' (Ghostty, iTerm2, WezTerm, kitty, Alacritty, zellij)', role: 'secondary' }]);
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

export function runSlash(input: string, ctx: ReplContext): 'exit' | 'handled' {
  const [word, ...rest] = input.trim().slice(1).split(/\s+/);
  const command = COMMANDS.find((c) => c.name === word);
  if (!command) {
    const near = nearest(word, COMMANDS.map((c) => c.name));
    ctx.print([{ text: `  Unknown command: /${word}.${near ? ` Did you mean /${near}?` : ''} Type /help for available commands.`, role: 'secondary' }]);
    return 'handled';
  }
  return command.run(rest.join(' ').trim(), ctx) === 'exit' ? 'exit' : 'handled';
}
