import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { onPath, packageRoot, planCenter, shouldFallBack, SUPERVISE, type CenterInputs } from '../src/repl/center.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { visibleWidth } from '../src/term/width.js';

// `timmy center` (plan C-12): zellij when installed (Timmy Night or Day, switching with the terminal
// where zellij can), tmux when not (UTF-8 forced with -u), the REPL itself as the last resort.
// Tabs: Timmy, Monitor, Events. Inside a multiplexer the tabs join the session you are in.
const SELF = ['/usr/bin/node', '--import', 'tsx', '/pkg/src/cli.ts'];
const inputs = (over: Partial<CenterInputs> & { bins?: string[] } = {}): CenterInputs => ({
  has: (bin) => (over.bins ?? ['zellij', 'tmux']).includes(bin),
  env: {},
  self: SELF,
  themeDir: '/pkg/assets/themes/zellij',
  layoutPath: '/tmp/x/center.kdl',
  tmuxHasSession: false,
  zellijVersion: [0, 45, 1],
  ...over,
});
const seq = (args: string[], part: string[]) => args.some((_, i) => part.every((p, j) => args[i + j] === p));

describe('timmy center routes', () => {
  it('opens zellij with a Timmy theme, switching dark and light with the terminal, and no Powerline glyphs', () => {
    const p = planCenter(inputs());
    expect(p.route).toBe('zellij');
    // One named session, created with the cockpit layout. The name goes through `options` (with
    // attach-to-session), because `--session` and `attach --create` both drop simplified-ui and
    // the theme (Powerline arrows and default colors came back in real captures).
    expect([p.command, ...p.args]).toEqual(['zellij', '--layout', '/tmp/x/center.kdl', 'options', '--session-name', 'timmy-center', '--attach-to-session', 'true', '--theme-dir', '/pkg/assets/themes/zellij', '--theme', 'timmy-night', '--theme-dark', 'timmy-night', '--theme-light', 'timmy-day', '--simplified-ui', 'true', '--mouse-mode', 'true']);
    expect(p.note).toBe('Opening the cockpit in zellij.');
    const again = planCenter(inputs({ zellijHasSession: true }));
    expect([again.command, ...again.args]).toEqual(['zellij', 'attach', 'timmy-center']);
    expect(again.note).toBe('Attaching to the running cockpit.');
    expect(p.layout).toContain('tab name="Timmy" focus=true');
    // Each tab runs under the supervisor (sh -c SUPERVISE <tab> <program...>), so it never ends on
    // its own; its pane closes only when the operator closes it (Ctrl+D at the ended prompt).
    expect(p.layout?.match(/command="sh" close_on_exit=true/g)).toHaveLength(3);
    expect(p.layout).toContain('"Timmy" "/usr/bin/node" "--import" "tsx" "/pkg/src/cli.ts" "repl"');
    expect(p.layout).toContain('"Monitor" "/usr/bin/node" "--import" "tsx" "/pkg/src/cli.ts" "watch"');
    expect(p.layout).toContain('"Events" "/usr/bin/node" "--import" "tsx" "/pkg/src/cli.ts" "events" "--follow" "--human"');
  });
  it('picks Timmy Homebrew under TIMMY_PALETTE=homebrew, and follows the terminal to Day in light mode', () => {
    const p = planCenter(inputs({ env: { TIMMY_PALETTE: 'homebrew' } }));
    expect(seq(p.args, ['--theme', 'timmy-homebrew'])).toBe(true);
    expect(seq(p.args, ['--theme-dark', 'timmy-homebrew', '--theme-light', 'timmy-day'])).toBe(true);
    // On a zellij too old for dark and light switching the theme stays fixed.
    const old = planCenter(inputs({ env: { TIMMY_PALETTE: 'homebrew' }, zellijVersion: [0, 43, 1] }));
    expect(seq(old.args, ['--theme', 'timmy-homebrew'])).toBe(true);
    expect(old.args).not.toContain('--theme-dark');
    // The other palettes are as they were.
    expect(seq(planCenter(inputs({ env: { TIMMY_PALETTE: 'night' } })).args, ['--theme', 'timmy-night'])).toBe(true);
    expect(seq(planCenter(inputs({ env: { TIMMY_PALETTE: 'day' } })).args, ['--theme', 'timmy-day'])).toBe(true);
    expect(seq(planCenter(inputs({ env: {} })).args, ['--theme', 'timmy-night'])).toBe(true);
  });
  it('keeps a fixed Timmy theme on a zellij too old for dark and light switching (before 0.44.2)', () => {
    const args = planCenter(inputs({ zellijVersion: [0, 43, 1] })).args;
    expect(args).toContain('--theme');
    expect(args).not.toContain('--theme-dark');
    expect(planCenter(inputs({ zellijVersion: null, env: { TIMMY_PALETTE: 'day' } })).args).toEqual(expect.arrayContaining(['--theme', 'timmy-day']));
  });
  it('adds the tabs to the current session from inside zellij', () => {
    expect([planCenter(inputs({ env: { ZELLIJ: '0' } })).command, ...planCenter(inputs({ env: { ZELLIJ: '0' } })).args]).toEqual(['zellij', '--layout', '/tmp/x/center.kdl']);
  });
  it('stays in tmux from inside tmux even when zellij is installed (no nested multiplexer)', () => {
    const p = planCenter(inputs({ env: { TMUX: '/tmp/s,1,0', PATH: '/bin' } }));
    expect(p.route).toBe('tmux');
    expect(p.args[0]).toBe('new-window');
    expect(p.args).not.toContain('new-session');
  });
  it('falls back to tmux with -u when zellij is missing: one window per tab under the supervisor, the REPL selected', () => {
    const p = planCenter(inputs({ bins: ['tmux'], env: { PATH: '/bin' } }));
    expect(p.route).toBe('tmux');
    expect(p.args.slice(0, 6)).toEqual(['-u', 'new-session', '-s', 'timmy-center', '-n', 'Timmy']);
    expect(p.args.filter((a) => a === 'new-window')).toHaveLength(2);
    expect(seq(p.args, ['new-window', '-n', 'Monitor', '-e', 'PATH=/bin', 'sh', '-c', SUPERVISE, 'Monitor', '/usr/bin/node', '--import', 'tsx', '/pkg/src/cli.ts', 'watch'])).toBe(true);
    expect(p.args.slice(-3)).toEqual(['select-window', '-t', '=timmy-center:Timmy']);
  });
  // Fourth order, step 2: the cockpit's tabs take clicks. zellij with its mouse mode on; the cockpit's
  // own tmux session with the mouse on for that session only, and a status line that says how to switch
  // tabs with the keyboard too, in the session's own prefix key. A session the operator is already in
  // keeps its own mouse setting.
  it('makes the cockpit\'s tabs clickable, and says the keys for them', () => {
    const z = planCenter(inputs());
    const t = planCenter(inputs({ bins: ['tmux'] }));
    const inside = planCenter(inputs({ bins: ['tmux'], env: { TMUX: '/tmp/s,1,0' } }));
    expect({
      zellij: seq(z.args, ['--mouse-mode', 'true']),
      tmuxMouse: seq(t.args, ['set-option', 'mouse', 'on', ';']),
      tmuxGuide: seq(t.args, ['set-option', 'status-right', ' click a tab · #{prefix} n next · #{prefix} p prev ', ';']) && seq(t.args, ['set-option', 'status-right-length', '60', ';']) && seq(t.args, ['set-option', 'status-left', '[cockpit] ', ';']),
      insideKeepsItsOwn: inside.args.includes('mouse'),
    }).toEqual({ zellij: true, tmuxMouse: true, tmuxGuide: true, insideKeepsItsOwn: false });
  });
  it('gives new windows the caller\'s PATH and TIMMY_ settings, never a secret', () => {
    const env = { PATH: '/bin', TIMMY_HOME: '/h', TIMMY_EDGE_TOKEN: 'x', TIMMY_API_KEY: 'y', OPENROUTER_API_KEY: 'k' };
    for (const p of [planCenter(inputs({ bins: ['tmux'], env })), planCenter(inputs({ bins: ['tmux'], env: { ...env, TMUX: '/tmp/s,1,0' } }))]) {
      expect(p.args).toContain('TIMMY_HOME=/h');
      expect(p.args.join(' ')).not.toMatch(/TOKEN=|KEY=/);
    }
  });
  it('attaches to exactly timmy-center instead of stacking a second set of windows', () => {
    expect([planCenter(inputs({ bins: ['tmux'], tmuxHasSession: true })).command, ...planCenter(inputs({ bins: ['tmux'], tmuxHasSession: true })).args]).toEqual(['tmux', '-u', 'attach-session', '-t', '=timmy-center']);
  });
  it('runs every tmux window under the supervisor (no dead windows to keep), each with the bold current-tab style', () => {
    for (const env of [{}, { TMUX: '/tmp/s,1,0' }]) {
      const args = planCenter(inputs({ bins: ['tmux'], env })).args;
      expect(args.filter((a, i) => a === SUPERVISE && args[i - 1] === '-c' && args[i - 2] === 'sh')).toHaveLength(3);
      expect(args).not.toContain('remain-on-exit');
      expect(args.filter((a, i) => a === 'window-status-current-style' && args[i - 1] === '-w')).toHaveLength(3);
    }
  });
  it('runs the REPL right here when neither is installed', () => {
    const p = planCenter(inputs({ bins: [] }));
    expect(p.route).toBe('repl');
    expect([p.command, ...p.args]).toEqual([...SELF, 'repl']);
    expect(p.note).toBe('No zellij or tmux found: running the REPL here.');
  });
  it('passes odd paths to tmux as plain arguments (a trailing ; escaped) and escapes them for KDL', () => {
    const odd = ['/opt/it\'s here/node', '/pkg/a "b"\\c.ts;'];
    const args = planCenter(inputs({ bins: ['tmux'], self: odd })).args;
    expect(seq(args, ['/opt/it\'s here/node', '/pkg/a "b"\\c.ts\\;', 'repl'])).toBe(true);
    expect(planCenter(inputs({ self: odd })).layout).toContain('"Timmy" "/opt/it\'s here/node" "/pkg/a \\"b\\"\\\\c.ts;" "repl"');
  });
});

describe('where the themes are', () => {
  it('finds the package root from wherever the code was built to, so the themes path is right in dist too', () => {
    expect(packageRoot(resolve('dist/src/repl'))).toBe(resolve('.'));
    expect(existsSync(join(packageRoot(), 'assets', 'themes', 'zellij', 'timmy.kdl'))).toBe(true);
  });
});

describe('running timmy center again', () => {
  it('switches to the Timmy tab already open in this zellij session instead of adding three more', () => {
    const p = planCenter(inputs({ env: { ZELLIJ: '0' }, existingTabs: ['Tab #1', 'Timmy', 'Monitor', 'Events'] }));
    expect([p.command, ...p.args]).toEqual(['zellij', 'action', 'go-to-tab-name', 'Timmy']);
    expect(planCenter(inputs({ env: { ZELLIJ: '0' }, existingTabs: ['Tab #1'] })).args).toEqual(['--layout', '/tmp/x/center.kdl']);
  });
  it('selects the Timmy window already in this tmux session instead of adding three more', () => {
    const p = planCenter(inputs({ bins: ['tmux'], env: { TMUX: '/tmp/s,1,0' }, existingTabs: ['zsh', 'Timmy', 'Monitor', 'Events'] }));
    expect([p.command, ...p.args]).toEqual(['tmux', 'select-window', '-t', ':=Timmy']);
  });
  it('falls back to tmux when zellij exits with an error before it really started', () => {
    expect(shouldFallBack('zellij', 1, 400)).toBe(true);
    expect(shouldFallBack('zellij', 1, 60_000)).toBe(false); // a session that ran and then failed is not a failed start
    expect(shouldFallBack('zellij', 0, 400)).toBe(false);
    expect(shouldFallBack('tmux', 1, 400)).toBe(false);
  });
});

// The supervisor itself, run by real shells: dash-like `sh` here, and bash (macOS's /bin/sh is bash).
const SHELLS = ['sh', 'bash'].filter((b) => onPath(b, process.env));
const ENDED = (name: string, code: number): string => `${name} ended (exit ${code}). Enter starts it again, Ctrl+D closes the tab.`;

/** Runs the supervisor in its own process group, like a pane; `steps` drive it from its output. */
function supervise(shell: string, argv: string[], steps: (out: () => string, send: (s: string | null) => void, group: (sig: NodeJS.Signals) => void) => Promise<void>, script = SUPERVISE) {
  const child = spawn(shell, ['-c', script, 'Monitor', ...argv], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const send = (s: string | null): void => { if (s === null) child.stdin.end(); else child.stdin.write(s); };
  const group = (sig: NodeJS.Signals): void => { try { process.kill(-(child.pid ?? 0), sig); } catch { /* already gone */ } };
  const timer = setTimeout(() => group('SIGKILL'), 8000);
  return steps(() => out, send, group).then(() => done).then((r) => { clearTimeout(timer); return { ...r, out }; });
}
const until = async (out: () => string, text: string, times = 1): Promise<void> => {
  for (let i = 0; i < 300 && out().split(text).length - 1 < times; i++) await new Promise((r) => setTimeout(r, 20));
};

describe.each(SHELLS)('the tab supervisor under %s', (shell) => {
  it('says how the program ended, starts it again on Enter, and closes the tab on Ctrl+D', () => {
    const r = spawnSync(shell, ['-c', SUPERVISE, 'Monitor', 'sh', '-c', 'echo run; exit 3'], { input: '\n', encoding: 'utf8' });
    expect(r.stdout.split('run\n')).toHaveLength(3); // ran twice: once, then again after Enter
    expect(r.stdout.split(ENDED('Monitor', 3))).toHaveLength(3);
    expect(r.status).toBe(3); // Ctrl+D (end of input) closes the tab with the program's last status
  });
  it('never parses the program or its arguments: they are positional parameters, not shell text', () => {
    const hostile = '$(echo pwned) `echo pwned` ; exit 9 | "q" \'s\'';
    const r = spawnSync(shell, ['-c', SUPERVISE, 'Monitor', 'printf', '%s\\n', hostile], { input: '', encoding: 'utf8' });
    expect(r.stdout.split('\n')[0]).toBe(hostile);
    expect(r.status).toBe(0);
  });
  it('keeps the tab when Ctrl+C stops the program (the whole pane gets SIGINT); the same test fails without the trap', async () => {
    const hit = (script?: string) =>
      supervise(shell, ['sh', '-c', 'echo up; sleep 5'], async (out, send, group) => {
        await until(out, 'up');
        group('SIGINT'); // what Ctrl+C does in a cooked-mode pane: SIGINT to every process in it
        await until(out, 'ended');
        send(null);
      }, script);
    const kept = await hit();
    expect(kept.out).toContain(ENDED('Monitor', 130));
    expect(kept.code).toBe(130);
    // Negative control: the supervisor without its trap dies with the program, so the tab would end.
    const bare = await hit(SUPERVISE.replace('trap : INT QUIT; ', ''));
    expect(bare.out).not.toContain('ended');
    expect(bare.signal ?? bare.code).not.toBe(130);
  });
  it('ignores Ctrl+C at the ended prompt instead of closing the tab', async () => {
    const r = await supervise(shell, ['sh', '-c', 'echo run'], async (out, send, group) => {
      await until(out, 'ended');
      group('SIGINT');
      await new Promise((res) => setTimeout(res, 100));
      send('\n');
      await until(out, 'ended', 2);
      send(null);
    });
    expect(r.out.split('run\n')).toHaveLength(3);
    expect(r.code).toBe(0);
  });
});

// Fourth order, step 2, in a real PTY: the cockpit's own tmux session runs inside a harness terminal (an
// outer tmux); a click on a tab's name in the status line switches to that tab, the status line says the
// keys, and the keyboard does the same. Each tab runs a stand-in for Timmy (sleep) under the supervisor.
describe('the cockpit in tmux, in a real PTY', () => {
  it('a click on a tab switches to it, the status line says the keys, and the prefix keys do the same', async () => {
    const box = mkdtempSync('/tmp/tk-');
    mkdirSync(join(box, 'home'));
    const env = { ...withoutRunner(process.env), HOME: join(box, 'home'), TMUX: '', TMUX_TMPDIR: box, LC_ALL: 'C.UTF-8', TERM: 'xterm-256color' };
    const outer = (...a: string[]) => execFileSync('tmux', ['-L', 'outer', ...a], { env, encoding: 'utf8' });
    const inner = (...a: string[]) => execFileSync('tmux', a, { env, encoding: 'utf8' });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const plan = planCenter(inputs({ bins: ['tmux'], self: ['/bin/sh', '-c', 'sleep 300', 'timmy'] }));
    try {
      // The cockpit's tmux runs from a script: its `;` separators must reach it, not the harness's tmux.
      const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
      // Inside the harness's pane TMUX is set; the cockpit's tmux is a server of its own, not a nested one.
      writeFileSync(join(box, 'cockpit.sh'), `unset TMUX; tmux ${plan.args.map(q).join(' ')}; echo EXIT=$?; sleep 30\n`);
      outer('-f', '/dev/null', 'new-session', '-d', '-s', 'o', '-x', '100', '-y', '20', 'sh', join(box, 'cockpit.sh'));
      // The cockpit's status line: the pane's row that lists the tabs (the harness has a status line too).
      const status = () => {
        const rows = outer('capture-pane', '-p', '-t', 'o').split('\n');
        const y = rows.findIndex((r) => r.includes(':Monitor'));
        return { line: rows[y] ?? '', y: y + 1 };
      };
      for (let i = 0; i < 100 && !status().line; i++) await sleep(50);
      const { line, y } = status();
      const at = (needle: string) => visibleWidth(line.slice(0, line.indexOf(needle))) + 2;
      const current = () => inner('list-windows', '-t', '=timmy-center', '-F', '#{window_active} #{window_name}').split('\n').find((l) => l.startsWith('1 '))?.slice(2) ?? '';
      const first = current();
      outer('send-keys', '-t', 'o', '-l', `\x1b[<0;${at('Monitor')};${y}M\x1b[<0;${at('Monitor')};${y}m`);
      for (let i = 0; i < 40 && current() !== 'Monitor'; i++) await sleep(50);
      const clicked = current();
      outer('send-keys', '-t', 'o', 'C-b', 'n');
      for (let i = 0; i < 40 && current() !== 'Events'; i++) await sleep(50);
      expect({ first, clicked, byKey: current(), guide: line.includes('click a tab · C-b n next · C-b p prev') })
        .toEqual({ first: 'Timmy', clicked: 'Monitor', byKey: 'Events', guide: true });
    } finally {
      try { inner('kill-server'); } catch { /* gone */ }
      try { outer('kill-server'); } catch { /* gone */ }
      rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});
