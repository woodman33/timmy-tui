/**
 * `timmy theme install` (C-10, moved from C-2): Timmy Homebrew (the default since round R1), Night and
 * Day go where your terminal looks for themes, as new files only. It never edits a config file (it prints the one line to add) and never
 * replaces a file of yours that differs. iTerm2 imports a theme by opening it, so for iTerm2 it only
 * says how. The files are the generated ones in assets/themes (src/term/theme-files.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPE } from '../theme/tokens.js';

export const TERMINAL_APPS = ['terminal', 'ghostty', 'kitty', 'alacritty', 'wezterm', 'iterm2', 'zellij'] as const;
export type TerminalApp = (typeof TERMINAL_APPS)[number];

/** The terminal this runs in, from its own variables. Inside zellij, zellij draws the colors. */
export function detectTerminal(env: Record<string, string | undefined>): TerminalApp | null {
  if (env.ZELLIJ !== undefined) return 'zellij';
  const program = env.TERM_PROGRAM ?? '';
  if (program === 'ghostty') return 'ghostty';
  if (program === 'iTerm.app') return 'iterm2';
  if (program === 'WezTerm') return 'wezterm';
  if (program === 'Apple_Terminal') return 'terminal';
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID) return 'kitty';
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET || env.ALACRITTY_LOG) return 'alacritty';
  return null;
}

export interface InstallPlan {
  app: TerminalApp;
  files: Array<{ from: string; to: string }>;
  /** What the operator does after: the line to add, and where. */
  then: string[];
}

type Variant = 'homebrew' | 'night' | 'day';
const VARIANTS: readonly Variant[] = ['homebrew', 'night', 'day'];
const Title = (v: Variant): string => `Timmy ${v[0].toUpperCase()}${v.slice(1)}`;

/**
 * The font (round R1): a terminal draws Timmy in its own font, so Timmy cannot set it. These are the
 * lines that set Monaspace Argon at a comfortable size; any monospace font works without them.
 */
export function fontLines(app: TerminalApp): string[] {
  const size = TYPE.terminalSize;
  const install = `Font: Monaspace Argon (${TYPE.install}); any monospace font works without it.`;
  switch (app) {
    case 'terminal':
      return [install, `  The profile already asks for it, at ${size} points.`];
    case 'ghostty':
      return [install, '  Add to ~/.config/ghostty/config:', `  font-family = "${TYPE.family}"`, `  font-size = ${size}`];
    case 'kitty':
      return [install, '  Add to ~/.config/kitty/kitty.conf:', `  font_family ${TYPE.family}`, `  font_size ${size}.0`];
    case 'alacritty':
      return [install, '  Add to ~/.config/alacritty/alacritty.toml:', '  [font]', `  normal = { family = "${TYPE.family}" }`, `  size = ${size}`];
    case 'wezterm':
      return [install, '  Add to ~/.config/wezterm/wezterm.lua:', `  config.font = wezterm.font('${TYPE.family}')`, `  config.font_size = ${size}`];
    case 'iterm2':
      return [install, `  Then Settings > Profiles > Text > Font: ${TYPE.family}, ${size}.`];
    case 'zellij':
      return [install, '  zellij draws in the font of the terminal it runs in: set it there.'];
  }
}

export function planThemeInstall(app: TerminalApp, home: string, assets: string): InstallPlan {
  const cfg = (...p: string[]) => join(home, '.config', ...p);
  const each = (folder: string, name: (v: Variant) => string, to: (v: Variant) => string) =>
    VARIANTS.map((v) => ({ from: join(assets, folder, name(v)), to: to(v) }));
  const plan = (files: InstallPlan['files'], then: string[]): InstallPlan => ({ app, files, then: [...then, ...fontLines(app)] });
  switch (app) {
    case 'terminal':
      return plan([], [
        'macOS Terminal imports a profile when you open it:',
        `  open "${join(assets, 'terminal', 'Timmy Homebrew.terminal')}"`,
        'then choose Timmy Homebrew in Terminal > Settings > Profiles and click Default.',
      ]);
    case 'ghostty':
      return plan(each('ghostty', (v) => `timmy-${v}`, (v) => cfg('ghostty', 'themes', `timmy-${v}`)),
        ['Add to ~/.config/ghostty/config:', '  theme = timmy-homebrew', '  (or, to follow light and dark: theme = light:timmy-day,dark:timmy-night)']);
    case 'kitty':
      return plan(each('kitty', (v) => `timmy-${v}.conf`, (v) => cfg('kitty', 'themes', `timmy-${v}.conf`)),
        ['Add to ~/.config/kitty/kitty.conf:', '  include themes/timmy-homebrew.conf']);
    case 'alacritty':
      return plan(each('alacritty', (v) => `timmy-${v}.toml`, (v) => cfg('alacritty', 'themes', `timmy-${v}.toml`)),
        ['Add under [general] in ~/.config/alacritty/alacritty.toml:', '  import = ["~/.config/alacritty/themes/timmy-homebrew.toml"]']);
    case 'wezterm':
      return plan(each('wezterm', (v) => `${Title(v)}.toml`, (v) => cfg('wezterm', 'colors', `${Title(v)}.toml`)),
        ['Add to ~/.config/wezterm/wezterm.lua:', "  config.color_scheme = 'Timmy Homebrew'", "  (Timmy Night and Timmy Day are there too)"]);
    case 'zellij':
      return plan([{ from: join(assets, 'zellij', 'timmy.kdl'), to: cfg('zellij', 'themes', 'timmy.kdl') }],
        ['Add to ~/.config/zellij/config.kdl:', '  theme "timmy-homebrew"', '  (timmy-night and timmy-day are in the same file; timmy center picks the theme itself)']);
    case 'iterm2':
      return plan([],
        ['iTerm2 imports a theme when you open it:', `  open "${join(assets, 'iterm2', 'Timmy Homebrew.itermcolors')}"`, 'then choose Timmy Homebrew in Settings > Profiles > Colors > Color Presets.', `  (Timmy Night and Day: ${join(assets, 'iterm2')})`]);
  }
}

export interface InstallResult {
  written: string[];
  /** Already there, byte for byte. */
  same: string[];
  /** A different file of yours is there: kept, not replaced. */
  conflicts: string[];
}

export function installTheme(plan: InstallPlan, opts: { dryRun?: boolean } = {}): InstallResult {
  const r: InstallResult = { written: [], same: [], conflicts: [] };
  for (const { from, to } of plan.files) {
    const content = readFileSync(from, 'utf8');
    if (existsSync(to)) {
      (readFileSync(to, 'utf8') === content ? r.same : r.conflicts).push(to);
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, content, { mode: 0o644 });
    }
    r.written.push(to);
  }
  return r;
}

/** assets/themes, from the source (src/term) or the build (dist/src/term). */
export function themesDir(): string {
  const candidates = ['../../assets/themes', '../../../assets/themes'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

const NAMES: Record<TerminalApp, string> = { terminal: 'macOS Terminal', ghostty: 'Ghostty', kitty: 'kitty', alacritty: 'Alacritty', wezterm: 'WezTerm', iterm2: 'iTerm2', zellij: 'zellij' };

/**
 * `timmy theme` and `timmy theme install [--terminal <app>] [--dry-run] [--json | --quiet]`. Returns the
 * exit code. Errors go to `err` (stderr), one line each; `--json` prints one envelope on `out` instead
 * (errors too, as `{ ok: false, error }`), and `--quiet` prints only the paths written (or that would be).
 */
export function themeMain(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  out: (s: string) => void = (s) => process.stdout.write(`${s}\n`),
  err: (s: string) => void = (s) => process.stderr.write(`${s}\n`),
): number {
  if (args.includes('--help') || args.includes('-h')) {
    for (const line of [
      'timmy theme: Timmy Homebrew (the default), Night and Day for your terminal, and the font.',
      '',
      'Usage: timmy theme [install] [--terminal <app>] [--dry-run] [--json | --quiet]',
      '  (no verb)          say which terminal Timmy detected and where the themes are',
      '  install            copy the palettes into the terminal\'s theme folder, as new files only,',
      '                     and say the lines that pick Timmy Homebrew and Monaspace Argon',
      `  --terminal <app>   ${TERMINAL_APPS.join(', ')}`,
      '  --dry-run          say what would be written, write nothing',
      '  --json             one JSON envelope; --quiet: only the paths written',
      '',
      'Exit codes: 0 done, 1 a file of yours differs (kept), 2 usage.',
    ]) out(line);
    return 0;
  }
  const home = env.HOME || homedir();
  const tilde = (p: string): string => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  const fail = (message: string): number => {
    if (json) out(JSON.stringify({ ok: false, error: message }));
    else err(message);
    return 2;
  };
  const at = args.indexOf('--terminal');
  const named = at >= 0 ? args[at + 1] : undefined;
  if (named !== undefined && !(TERMINAL_APPS as readonly string[]).includes(named)) {
    return fail(`timmy theme: no theme for "${named}". Terminals: ${TERMINAL_APPS.join(', ')}.`);
  }
  const app = (named as TerminalApp | undefined) ?? detectTerminal(env);
  if (args[0] !== 'install') {
    if (json) {
      out(JSON.stringify({ ok: true, terminal: app ?? null, themes: themesDir() }));
      return 0;
    }
    if (quiet) {
      if (app) out(app);
      return 0;
    }
    out(`Terminal: ${app ? NAMES[app] : 'not one Timmy knows'}${env.TIMMY_PALETTE ? ` · TIMMY_PALETTE=${env.TIMMY_PALETTE}` : ''}`);
    out(`Themes: ${tilde(themesDir())} (macOS Terminal, Ghostty, iTerm2, WezTerm, kitty, Alacritty, zellij)`);
    out(`Font: Monaspace Argon (${TYPE.install}); any monospace font works without it`);
    out(app ? 'Install: timmy theme install' : `Install: timmy theme install --terminal <${TERMINAL_APPS.join('|')}>`);
    return 0;
  }
  if (!app) return fail(`timmy theme install: say which terminal: --terminal <${TERMINAL_APPS.join('|')}>.`);
  const dryRun = args.includes('--dry-run');
  const plan = planThemeInstall(app, home, themesDir());
  const r = installTheme(plan, { dryRun });
  const code = r.conflicts.length ? 1 : 0;
  if (json) {
    out(JSON.stringify({ ok: code === 0, terminal: app, dryRun, written: r.written, same: r.same, conflicts: r.conflicts, then: plan.then }));
    return code;
  }
  if (quiet) {
    for (const p of r.written) out(p);
    return code;
  }
  out(plan.files.length ? `${dryRun ? 'Would install' : 'Installed'} Timmy Homebrew, Night and Day for ${NAMES[app]}:` : `Timmy Homebrew for ${NAMES[app]}:`);
  for (const p of r.written) out(`  ${dryRun ? 'would write' : 'wrote'} ${tilde(p)}`);
  for (const p of r.same) out(`  already there ${tilde(p)}`);
  for (const p of r.conflicts) out(`  kept yours (it differs) ${tilde(p)}`);
  for (const line of plan.then) out(line);
  return code;
}
