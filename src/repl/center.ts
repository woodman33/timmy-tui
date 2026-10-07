/**
 * `timmy center` (plan C-12): the cockpit as one layout. zellij when it is installed, with Timmy
 * Night and Day picked automatically from the terminal's own dark or light report; tmux when it is
 * not (UTF-8 forced with -u); the REPL itself, right here, as the last resort.
 * Tabs: Timmy (the REPL), Monitor (`timmy watch`) and Events (`timmy events --follow --human`).
 * The monitor gets its own tab until it can draw narrow (C-11), so nothing is squeezed.
 * Each tab's program runs under a small supervisor (SUPERVISE), so no tab ever ends on its own.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CenterRoute = 'zellij' | 'tmux' | 'repl';

export interface CenterPlan {
  route: CenterRoute;
  command: string;
  args: string[];
  /** The zellij layout to write at `layoutPath` before running (zellij route only). */
  layout?: string;
  /** One line for the operator: what is about to happen. */
  note: string;
}

export interface CenterInputs {
  has: (bin: string) => boolean;
  env: Record<string, string | undefined>;
  /** How to run this Timmy again: the runtime and its leading arguments. */
  self: string[];
  themeDir: string;
  layoutPath: string;
  /** Whether a tmux session named exactly `timmy-center` already runs (outside tmux only). */
  tmuxHasSession: boolean;
  /** zellij's version, when known; dark and light switching needs 0.44.2 or later. */
  zellijVersion?: [number, number, number] | null;
  /** Tab or window names already in the multiplexer session we are inside (to reuse, not stack). */
  existingTabs?: string[];
  /** Whether a zellij session named `timmy-center` exists (outside zellij; only changes the note). */
  zellijHasSession?: boolean;
}

export const SESSION = 'timmy-center';
const TABS: Array<{ name: string; verb: string[] }> = [
  { name: 'Timmy', verb: ['repl'] },
  { name: 'Monitor', verb: ['watch'] },
  { name: 'Events', verb: ['events', '--follow', '--human'] },
];

/**
 * Every tab's program runs under this POSIX sh loop (C-18), so a tab never ends on its own: zellij
 * draws an ended tab's label with no background (white on white after the selected tab), and an
 * ended program should say so and offer a restart. The program and its arguments arrive as
 * positional parameters ("$@"), so sh never parses them; the tab's name is $0. While the program
 * runs, Ctrl+C reaches it and the loop survives (a trap that runs a command is reset to the default
 * action for the program); at the prompt Ctrl+C is ignored. Enter starts the program again; Ctrl+D
 * (end of input) closes the tab with the program's last status.
 */
export const SUPERVISE =
  "while :; do trap : INT QUIT; \"$@\"; s=$?; trap '' INT QUIT; " +
  "printf '\\n  %s ended (exit %d). Enter starts it again, Ctrl+D closes the tab.\\n' \"$0\" \"$s\"; " +
  'read -r reply || exit "$s"; done';

/** The argv that runs `argv` under SUPERVISE as the tab `name`. */
const supervised = (name: string, argv: string[]): string[] => ['sh', '-c', SUPERVISE, name, ...argv];

const kdl = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** tmux reads an argument ending in `;` as the end of a command; `\;` keeps it literal. */
const tmuxArg = (a: string): string => (a.endsWith(';') ? `${a.slice(0, -1)}\\;` : a);
const SECRET = /KEY|TOKEN|SECRET|PASS/i;

/** A running tmux server gives new windows its own environment: hand over PATH and TIMMY_*, never a secret (argv shows in ps). */
function envPairs(env: Record<string, string | undefined>): string[] {
  const names = Object.keys(env).filter((k) => (k === 'PATH' || k.startsWith('TIMMY_')) && !SECRET.test(k) && env[k] !== undefined).sort();
  return names.flatMap((k) => ['-e', `${k}=${env[k]}`]);
}

const atLeast = (v: [number, number, number], min: [number, number, number]): boolean =>
  v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2];

export function zellijLayout(self: string[]): string {
  const tab = ({ name, verb }: (typeof TABS)[number], i: number): string => {
    // close_on_exit: the supervisor only ends when the operator closes the tab (Ctrl+D).
    const [command, ...args] = supervised(name, [...self, ...verb]);
    return [
      `    tab name=${kdl(name)}${i === 0 ? ' focus=true' : ''} {`,
      `        pane name=${kdl(name)} command=${kdl(command)} close_on_exit=true {`,
      `            args ${args.map(kdl).join(' ')}`,
      '        }',
      '    }',
    ].join('\n');
  };
  return [
    'layout {',
    '    default_tab_template {',
    '        pane size=1 borderless=true {',
    '            plugin location="zellij:compact-bar"',
    '        }',
    '        children',
    '    }',
    ...TABS.map(tab),
    '}',
    '',
  ].join('\n');
}

export function planCenter(i: CenterInputs): CenterPlan {
  // Each window runs Timmy under the supervisor: sh runs a fixed script and gets Timmy's argv as
  // positional parameters, so no shell ever parses a path (no quoting to get wrong in any shell).
  const run = (name: string, verb: string[]): string[] => supervised(name, [...i.self, ...verb]).map(tmuxArg);
  const pass = envPairs(i.env);
  // The current tab is bold (a window option, set while the new window is current). No
  // remain-on-exit: a window only ends when the operator closes it at the supervisor's prompt.
  const keep = ['set-option', '-w', 'window-status-current-style', 'bold', ';'];
  const [first, ...rest] = TABS;
  const open = i.existingTabs?.includes(first.name) ?? false;
  if (i.env.ZELLIJ !== undefined && i.has('zellij')) {
    if (open) return { route: 'zellij', command: 'zellij', args: ['action', 'go-to-tab-name', first.name], note: 'The cockpit is already open here: switched to its Timmy tab.' };
    return { route: 'zellij', command: 'zellij', args: ['--layout', i.layoutPath], layout: zellijLayout(i.self), note: 'Adding the cockpit tabs to this zellij session.' };
  }
  if (i.env.TMUX && i.has('tmux')) {
    if (open) return { route: 'tmux', command: 'tmux', args: ['select-window', '-t', `:=${first.name}`], note: 'The cockpit is already open here: switched to its Timmy window.' };
    // Inside tmux: the REPL's window is made last, so it is the one selected. No nested zellij.
    const args = rest.flatMap((t) => ['new-window', '-n', t.name, ...pass, ...run(t.name, t.verb), ';', ...keep]);
    return {
      route: 'tmux',
      command: 'tmux',
      args: [...args, 'new-window', '-n', first.name, ...pass, ...run(first.name, first.verb), ';', ...keep.slice(0, -1)],
      note: 'Adding the cockpit windows to this tmux session.',
    };
  }
  if (i.has('zellij')) {
    const theme = i.env.TIMMY_PALETTE === 'day' ? 'timmy-day' : 'timmy-night';
    const follow = i.zellijVersion && atLeast(i.zellijVersion, [0, 44, 2]) ? ['--theme-dark', 'timmy-night', '--theme-light', 'timmy-day'] : [];
    // One named session: attach when it runs (a second run never stacks), create it otherwise.
    if (i.zellijHasSession) return { route: 'zellij', command: 'zellij', args: ['attach', SESSION], note: 'Attaching to the running cockpit.' };
    return {
      route: 'zellij',
      command: 'zellij',
      // The name goes through options: `--session` and `attach --create` both drop simplified-ui and
      // the theme. simplified-ui: no Powerline arrows, which most fonts lack (they draw as boxes).
      // Fourth order, step 2: the tabs take clicks (zellij's own mouse mode, on explicitly).
      args: ['--layout', i.layoutPath, 'options', '--session-name', SESSION, '--attach-to-session', 'true', '--theme-dir', i.themeDir, '--theme', theme, ...follow, '--simplified-ui', 'true', '--mouse-mode', 'true'],
      layout: zellijLayout(i.self),
      note: 'Opening the cockpit in zellij.',
    };
  }
  if (i.has('tmux')) {
    if (i.tmuxHasSession) {
      return { route: 'tmux', command: 'tmux', args: ['-u', 'attach-session', '-t', `=${SESSION}`], note: 'Attaching to the running cockpit.' };
    }
    const args = [
      '-u', 'new-session', '-s', SESSION, '-n', first.name, ...pass, ...run(first.name, first.verb), ';',
      ...keep,
      // The status line follows the terminal's own colors (Night or Day).
      'set-option', 'status-style', 'bg=default,fg=default', ';',
      // Fourth order, step 2: in this session a click on a tab switches to it, and the status line says
      // the keys that do the same, in the session's own prefix. A session you are already in keeps its own.
      'set-option', 'mouse', 'on', ';',
      'set-option', 'status-right', ' click a tab · #{prefix} n next · #{prefix} p prev ', ';',
      'set-option', 'status-right-length', '60', ';',
      // The default left side, "[session name]" cut at 10 cells, ran into the first tab ("[timmy-cen0:Timmy").
      'set-option', 'status-left', '[cockpit] ', ';',
      ...rest.flatMap((t) => ['new-window', '-n', t.name, ...pass, ...run(t.name, t.verb), ';', ...keep]),
      'select-window', '-t', `=${SESSION}:${first.name}`,
    ];
    return { route: 'tmux', command: 'tmux', args, note: 'Opening the cockpit in tmux.' };
  }
  return { route: 'repl', command: i.self[0], args: [...i.self.slice(1), 'repl'], note: 'No zellij or tmux found: running the REPL here.' };
}

/** Where a program on the PATH really is, links followed, or null when it is not on the PATH (step 3). */
export function realOnPath(bin: string, env: Record<string, string | undefined>): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return realpathSync(join(dir, bin));
    } catch {
      /* not here */
    }
  }
  return null;
}

export function onPath(bin: string, env: Record<string, string | undefined>): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

export function centerHelp(): string {
  return [
    'Usage: timmy center',
    '',
    'Opens the cockpit: the REPL, the monitor and the event feed as tabs.',
    'Uses zellij when installed (Timmy Night or Day, following the terminal),',
    'then tmux, and runs the REPL here when neither is installed.',
    '',
    'Inside zellij or tmux, the tabs are added to the session you are in.',
  ].join('\n');
}

/** zellij that exits with an error within this long never really started: try tmux instead. */
const FAILED_START_MS = 3000;

export function shouldFallBack(route: CenterRoute, status: number | null, elapsedMs: number): boolean {
  return route === 'zellij' && status !== 0 && elapsedMs < FAILED_START_MS;
}

const lines = (out: string | undefined): string[] => (out ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

/** The installed package's root (where package.json is), from wherever this module was built to. */
export function packageRoot(from = fileURLToPath(new URL('.', import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return fileURLToPath(new URL('../../', import.meta.url));
}

function zellijVersion(): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(spawnSync('zellij', ['--version'], { encoding: 'utf8' }).stdout ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function runCenter(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${centerHelp()}\n`);
    return 0;
  }
  const env = process.env;
  const has = (bin: string): boolean => onPath(bin, env);
  const insideZellij = env.ZELLIJ !== undefined && has('zellij');
  const insideTmux = !insideZellij && !!env.TMUX && has('tmux');
  const existingTabs = insideZellij
    ? lines(spawnSync('zellij', ['action', 'query-tab-names'], { encoding: 'utf8' }).stdout)
    : insideTmux
      ? lines(spawnSync('tmux', ['list-windows', '-F', '#{window_name}'], { encoding: 'utf8' }).stdout)
      : [];
  const outsideZellij = !insideZellij && !insideTmux && has('zellij');
  const zellijHasSession = outsideZellij && lines(spawnSync('zellij', ['list-sessions', '--short', '--no-formatting'], { encoding: 'utf8' }).stdout).includes(SESSION);
  const tmuxHasSession = !env.TMUX && has('tmux') && spawnSync('tmux', ['has-session', '-t', `=${SESSION}`], { stdio: 'ignore' }).status === 0;
  const dir = has('zellij') ? mkdtempSync(join(tmpdir(), 'timmy-center-')) : null;
  const inputs = {
    env,
    self: [process.execPath, ...process.execArgv, process.argv[1]],
    themeDir: join(packageRoot(), 'assets', 'themes', 'zellij'),
    layoutPath: dir ? join(dir, 'center.kdl') : '',
    tmuxHasSession,
    zellijVersion: has('zellij') ? zellijVersion() : null,
    existingTabs,
    zellijHasSession,
  };
  const run = (plan: CenterPlan): { status: number | null; ms: number } => {
    if (plan.layout && dir) writeFileSync(join(dir, 'center.kdl'), plan.layout, { mode: 0o600 });
    process.stderr.write(`${plan.note}\n`);
    const started = Date.now();
    const r = spawnSync(plan.command, plan.args, { stdio: 'inherit' });
    if (r.error) process.stderr.write(`timmy center: could not start ${plan.command} (${r.error.message}).\n`);
    return { status: r.error ? 1 : r.status, ms: Date.now() - started };
  };
  try {
    const plan = planCenter({ ...inputs, has });
    const first = run(plan);
    if (shouldFallBack(plan.route, first.status, first.ms)) {
      process.stderr.write(`zellij did not start (exit ${first.status ?? 'by signal'}); trying tmux.\n`);
      const second = run(planCenter({ ...inputs, has: (bin) => bin !== 'zellij' && has(bin) }));
      return second.status ?? 1;
    }
    return first.status ?? 1;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
