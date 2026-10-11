import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectTerminal, installTheme, planThemeInstall, themeMain } from '../src/term/theme-install.js';

// C-10 (from C-2): `timmy theme install` puts Timmy Night and Day where your terminal looks for themes,
// as new files only: it never edits a config file (it prints the one line to add) and never replaces
// a file of yours that differs. iTerm2 imports by opening the file, so it only prints that.
const ASSETS = resolve('assets/themes');
const dirs: string[] = [];
const home = (): string => { const d = mkdtempSync(join(tmpdir(), 'timmy-theme-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('which terminal', () => {
  it('reads the terminal from its own variables', () => {
    expect([
      detectTerminal({ TERM_PROGRAM: 'ghostty' }),
      detectTerminal({ TERM_PROGRAM: 'iTerm.app' }),
      detectTerminal({ TERM_PROGRAM: 'WezTerm' }),
      detectTerminal({ TERM: 'xterm-kitty' }),
      detectTerminal({ ALACRITTY_WINDOW_ID: '1' }),
      detectTerminal({ ZELLIJ: '0', TERM_PROGRAM: 'ghostty' }),
      detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }),
      detectTerminal({ TERM_PROGRAM: 'vscode' }),
    ]).toEqual(['ghostty', 'iterm2', 'wezterm', 'kitty', 'alacritty', 'zellij', 'terminal', null]);
  });
});

describe('timmy theme install', () => {
  it('copies both palettes into the terminal\'s theme folder and says the one line to add', () => {
    const h = home();
    const plan = planThemeInstall('ghostty', h, ASSETS);
    const r = installTheme(plan);
    expect(r.written.sort()).toEqual([join(h, '.config/ghostty/themes/timmy-day'), join(h, '.config/ghostty/themes/timmy-homebrew'), join(h, '.config/ghostty/themes/timmy-night')]);
    // Round R1: Timmy Homebrew is the default; the font is Monaspace Argon at 14.
    expect(plan.then).toContain('  theme = timmy-homebrew');
    expect(plan.then).toContain('  font-family = "Monaspace Argon"');
    expect(readFileSync(join(h, '.config/ghostty/themes/timmy-night'), 'utf8')).toBe(readFileSync(join(ASSETS, 'ghostty/timmy-night'), 'utf8'));
    expect(plan.then.join('\n')).toContain('theme = light:timmy-day,dark:timmy-night');
    const again = installTheme(plan);
    expect({ ...again, same: again.same.sort() }).toEqual({ written: [], same: r.written, conflicts: [] });
  });
  it('keeps a different file of yours, and a dry run writes nothing', () => {
    const h = home();
    mkdirSync(join(h, '.config/kitty/themes'), { recursive: true });
    writeFileSync(join(h, '.config/kitty/themes/timmy-night.conf'), '# mine\n');
    const plan = planThemeInstall('kitty', h, ASSETS);
    expect(installTheme(plan, { dryRun: true }).written).toEqual([join(h, '.config/kitty/themes/timmy-homebrew.conf'), join(h, '.config/kitty/themes/timmy-day.conf')]);
    expect(existsSync(join(h, '.config/kitty/themes/timmy-day.conf'))).toBe(false);
    const r = installTheme(plan);
    expect(r.conflicts).toEqual([join(h, '.config/kitty/themes/timmy-night.conf')]);
    expect(readFileSync(join(h, '.config/kitty/themes/timmy-night.conf'), 'utf8')).toBe('# mine\n');
  });
  it('zellij: one file holds Homebrew, Night and Day, and the line to add names Homebrew', () => {
    const h = home();
    const plan = planThemeInstall('zellij', h, ASSETS);
    expect(plan.then).toContain('  theme "timmy-homebrew"');
    expect(plan.then.join('\n')).toContain('timmy-night');
    expect(installTheme(plan).written).toEqual([join(h, '.config/zellij/themes/timmy.kdl')]);
    expect(readFileSync(join(h, '.config/zellij/themes/timmy.kdl'), 'utf8')).toContain('timmy-homebrew {');
  });
  it('iTerm2 imports by opening the file, so nothing is copied', () => {
    const plan = planThemeInstall('iterm2', home(), ASSETS);
    expect(plan.files).toEqual([]);
    expect(plan.then.join('\n')).toContain('Timmy Homebrew.itermcolors');
  });
  it('macOS Terminal imports the profile, font included, by opening it; nothing is copied', () => {
    const plan = planThemeInstall('terminal', home(), ASSETS);
    expect(plan.files).toEqual([]);
    expect(plan.then.join('\n')).toContain(`open "${join(ASSETS, 'terminal', 'Timmy Homebrew.terminal')}"`);
    expect(plan.then.join('\n')).toContain('brew install --cask font-monaspace');
    expect(existsSync(join(ASSETS, 'terminal', 'Timmy Homebrew.terminal'))).toBe(true);
  });
  it('the command installs for the named terminal and exits 0; an unknown one is a usage error', () => {
    const h = home();
    const env = { ...process.env, HOME: h, TIMMY_HOME: join(h, 'timmy') };
    mkdirSync(join(h, 'timmy'), { recursive: true });
    writeFileSync(join(h, 'timmy', 'identity.json'), '{"operator":"Sample"}');
    const tsx = resolve('node_modules/.bin/tsx');
    const ok = spawnSync(tsx, [resolve('src/cli.ts'), 'theme', 'install', '--terminal', 'wezterm'], { cwd: h, env, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("config.color_scheme = 'Timmy Homebrew'");
    expect(ok.stdout).toContain("config.font = wezterm.font('Monaspace Argon')");
    expect(existsSync(join(h, '.config/wezterm/colors/Timmy Night.toml'))).toBe(true);
    const bad = spawnSync(tsx, [resolve('src/cli.ts'), 'theme', 'install', '--terminal', 'nope'], { cwd: h, env, encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });
});

// C-15 (playbook §19.5): errors on stderr, one line; `--json` one envelope and `--quiet` bare values.
describe('timmy theme for scripts', () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = themeMain(args, { HOME: home(), ...env }, (s) => out.push(s), (s) => err.push(s));
    return { code, out, err };
  };
  it('an unknown terminal is one line on stderr and exit 2', () => {
    const r = run(['install', '--terminal', 'nope']);
    expect({ code: r.code, out: r.out, err: r.err.length }).toEqual({ code: 2, out: [], err: 1 });
    expect(r.err[0]).toContain('"nope"');
  });
  it('--json gives one envelope for an install, and for what was detected', () => {
    const r = run(['install', '--terminal', 'ghostty', '--dry-run', '--json']);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const j = JSON.parse(r.out[0]);
    expect({ ok: j.ok, terminal: j.terminal, dryRun: j.dryRun, written: j.written.length, same: j.same, conflicts: j.conflicts, then: j.then.length > 0 })
      .toEqual({ ok: true, terminal: 'ghostty', dryRun: true, written: 3, same: [], conflicts: [], then: true });
    const d = run(['--json'], { TERM_PROGRAM: undefined, TERM: 'xterm-256color' });
    expect(JSON.parse(d.out[0])).toMatchObject({ ok: true, terminal: null });
    const bad = run(['install', '--terminal', 'nope', '--json']);
    expect({ code: bad.code, json: JSON.parse(bad.out[0]).ok }).toEqual({ code: 2, json: false });
  });
  it('--quiet prints the paths it wrote (or would), one a line', () => {
    const r = run(['install', '--terminal', 'ghostty', '--dry-run', '--quiet']);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(3);
    expect(r.out.every((l) => l.endsWith('timmy-homebrew') || l.endsWith('timmy-night') || l.endsWith('timmy-day'))).toBe(true);
  });
});

describe('timmy theme --help', () => {
  it('prints its usage and the flags, and exits 0', () => {
    const out: string[] = [];
    expect(themeMain(['--help'], { HOME: '/nowhere' }, (s) => out.push(s), () => {})).toBe(0);
    expect(out.join('\n')).toMatch(/^Usage: timmy theme \[install\]/m);
    expect(out.join('\n')).toContain('--json');
  });
});

describe('timmy theme --json from the command line', () => {
  it('prints the envelope (the CLI must pass --json on)', () => {
    const h = home();
    const env = { ...process.env, HOME: h, TIMMY_HOME: join(h, 'timmy'), TERM_PROGRAM: 'ghostty' };
    mkdirSync(join(h, 'timmy'), { recursive: true });
    writeFileSync(join(h, 'timmy', 'identity.json'), '{"operator":"Sample"}');
    const r = spawnSync(resolve('node_modules/.bin/tsx'), [resolve('src/cli.ts'), 'theme', '--json'], { cwd: h, env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, terminal: 'ghostty' });
  });
});
