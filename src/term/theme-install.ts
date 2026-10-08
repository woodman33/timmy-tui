/**
 * `timmy theme install` (C-10, moved from C-2): Timmy Night and Day go where your terminal looks for
 * themes, as new files only. It never edits a config file (it prints the one line to add) and never
 * replaces a file of yours that differs. iTerm2 imports a theme by opening it, so for iTerm2 it only
 * says how. The files are the generated ones in assets/themes (src/term/theme-files.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TERMINAL_APPS = ['ghostty', 'kitty', 'alacritty', 'wezterm', 'iterm2', 'zellij'] as const;
export type TerminalApp = (typeof TERMINAL_APPS)[number];

/** The terminal this runs in, from its own variables. Inside zellij, zellij draws the colors. */
export function detectTerminal(env: Record<string, string | undefined>): TerminalApp | null {
  if (env.ZELLIJ !== undefined) return 'zellij';
  const program = env.TERM_PROGRAM ?? '';
  if (program === 'ghostty') return 'ghostty';
  if (program === 'iTerm.app') return 'iterm2';
  if (program === 'WezTerm') return 'wezterm';
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

export function planThemeInstall(app: TerminalApp, home: string, assets: string): InstallPlan {
  const cfg = (...p: string[]) => join(home, '.config', ...p);
  const both = (folder: string, name: (v: 'night' | 'day') => string, to: (v: 'night' | 'day') => string) =>
    (['night', 'day'] as const).map((v) => ({ from: join(assets, folder, name(v)), to: to(v) }));
  switch (app) {
    case 'ghostty':
      return { app, files: both('ghostty', (v) => `timmy-${v}`, (v) => cfg('ghostty', 'themes', `timmy-${v}`)),
        then: ['Add to ~/.config/ghostty/config:', '  theme = light:timmy-day,dark:timmy-night'] };
    case 'kitty':
      return { app, files: both('kitty', (v) => `timmy-${v}.conf`, (v) => cfg('kitty', 'themes', `timmy-${v}.conf`)),
        then: ['Add to ~/.config/kitty/kitty.conf:', '  include themes/timmy-night.conf'] };
    case 'alacritty':
      return { app, files: both('alacritty', (v) => `timmy-${v}.toml`, (v) => cfg('alacritty', 'themes', `timmy-${v}.toml`)),
        then: ['Add under [general] in ~/.config/alacritty/alacritty.toml:', '  import = ["~/.config/alacritty/themes/timmy-night.toml"]'] };
    case 'wezterm':
      return { app, files: both('wezterm', (v) => `Timmy ${v === 'night' ? 'Night' : 'Day'}.toml`, (v) => cfg('wezterm', 'colors', `Timmy ${v === 'night' ? 'Night' : 'Day'}.toml`)),
        then: ['Add to ~/.config/wezterm/wezterm.lua:', "  config.color_scheme = 'Timmy Night'"] };
    case 'zellij':
      return { app, files: [{ from: join(assets, 'zellij', 'timmy.kdl'), to: cfg('zellij', 'themes', 'timmy.kdl') }],
        then: ['Add to ~/.config/zellij/config.kdl:', '  theme "timmy-night"'] };
    case 'iterm2':
      return { app, files: [],
        then: ['iTerm2 imports a theme when you open it:', `  open "${join(assets, 'iterm2', 'Timmy Night.itermcolors')}"`, 'then choose Timmy Night in Settings > Profiles > Colors > Color Presets.'] };
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

const NAMES: Record<TerminalApp, string> = { ghostty: 'Ghostty', kitty: 'kitty', alacritty: 'Alacritty', wezterm: 'WezTerm', iterm2: 'iTerm2', zellij: 'zellij' };

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
      'timmy theme: Timmy Night and Day for your terminal.',
      '',
      'Usage: timmy theme [install] [--terminal <app>] [--dry-run] [--json | --quiet]',
      '  (no verb)          say which terminal Timmy detected and where the themes are',
      '  install            copy both palettes into the terminal\'s theme folder, as new files only',
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
    out(`Themes: ${tilde(themesDir())} (Ghostty, iTerm2, WezTerm, kitty, Alacritty, zellij)`);
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
  out(`${dryRun ? 'Would install' : 'Installed'} Timmy Night and Day for ${NAMES[app]}:`);
  for (const p of r.written) out(`  ${dryRun ? 'would write' : 'wrote'} ${tilde(p)}`);
  for (const p of r.same) out(`  already there ${tilde(p)}`);
  for (const p of r.conflicts) out(`  kept yours (it differs) ${tilde(p)}`);
  for (const line of plan.then) out(line);
  return code;
}
