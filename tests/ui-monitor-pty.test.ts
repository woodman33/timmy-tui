import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutCI } from './fixtures/repl-pty-env.js';
import { parseAnsiFrame, TIMMY_DAY, TIMMY_NIGHT } from '../src/tui/qa/ansi-frame.js';
import { gateFrame } from '../src/tui/qa/contrast-gate.js';
import { visibleWidth } from '../src/term/width.js';

// C-11 in a real PTY: `timmy watch` (the monitor, cli.tsx) owns the alternate screen and gives the
// terminal back on every way out. Before: it sent ESC c (a full reset) and drew in the main screen,
// and Ctrl+C did not end it. A scratch HOME, TIMMY_HOME, repo and store: nothing touches this tree.
const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const MONITOR = resolve('cli.tsx');
const CLI = resolve('src/cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let box: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  box = mkdtempSync('/tmp/tm-');
  const home = join(box, 'home');
  const repo = join(box, 'repo');
  mkdirSync(join(home, '.config', 'timmy-tui-nodejs'), { recursive: true });
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  env = { ...withoutCI(process.env), HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, 'store'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor', TMUX: '', TMUX_TMPDIR: box };
  execFileSync(process.execPath, ['--import', LOADER, CLI, 'init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo'], { cwd: repo, env, stdio: 'ignore' });
  writeFileSync(join(home, '.config', 'timmy-tui-nodejs', 'config.json'), '{"onboarded": true}');
}, 60_000);
afterAll(() => rmSync(box, { recursive: true, force: true }));

async function endMonitorBy(mode: 'ctrl-c' | 'sigterm') {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'monitor', ...args], { env, encoding: 'utf8' });
  // The pane's raw output is logged (tmux pipe-pane) before the monitor starts, to see every byte it sends.
  const raw = join(box, `raw-${mode}.log`);
  const script = `sleep 1; S0=$(stty -g); printf 'MARKER-BEFORE\\n'; ${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same || echo TTY=changed; sleep 60`;
  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'm', '-x', '100', '-y', '30', '-c', join(box, 'repo'), 'bash', '--norc', '-c', script);
    tmux('pipe-pane', '-o', '-t', 'm', `cat >> ${raw}`);
    const screen = () => tmux('capture-pane', '-p', '-t', 'm');
    const waitFor = async (re: RegExp, ms = 45_000) => {
      for (let i = 0; i < ms / 100; i++) {
        const m = screen().match(re);
        if (m) return m;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${re}: ${screen()}`);
    };
    await waitFor(/YOUR JOURNEY/);
    const during = tmux('display', '-p', '-t', 'm', '#{alternate_on}').trim();
    if (mode === 'ctrl-c') tmux('send-keys', '-t', 'm', 'C-c');
    else tmux('run-shell', `pkill -TERM -f '^${process.execPath} --import'`); // the node process only, never the pane's shell
    const exit = Number((await waitFor(/EXIT=(\d+)/, 15_000))[1]);
    await waitFor(/TTY=\w+/, 5_000);
    const after = screen();
    const bytes = readFileSync(raw, 'utf8');
    return {
      during, exit, tty: after.match(/TTY=(\w+)/)![1], flags: tmux('display', '-p', '-t', 'm', '#{cursor_flag} #{alternate_on}').trim(),
      marker: after.includes('MARKER-BEFORE'), frameLeft: after.includes('YOUR JOURNEY'),
      // ED 3 erases saved lines (the scrollback); the monitor never sends it, nor ESC c.
      savedLinesErased: bytes.includes('\x1b[3J') || bytes.includes('\x1bc'),
    };
  } finally {
    try { tmux('kill-server'); } catch { /* already gone */ }
  }
}

describe('the monitor in a real PTY', () => {
  for (const [mode, code] of [['ctrl-c', 130], ['sigterm', 143]] as const) {
    it(`${mode}: draws in its own screen, exits ${code}, and the terminal comes back as it was`, async () => {
      expect(await endMonitorBy(mode)).toEqual({ during: '1', exit: code, tty: 'same', flags: '1 0', marker: true, frameLeft: false, savedLinesErased: false });
    }, 90_000);
  }
});

// C-11 (row 27): the frame follows the terminal's width after a resize, and the monitor never paints
// the void (DESIGN.md §10 B2: the ground is the palette's). A sentinel ground shows which cells carry
// a background of their own.
const SENTINEL = { ...TIMMY_DAY, name: 'sentinel', background: '#FE01FE' };
async function frameAt(sizes: Array<[number, number]>) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'ground', ...args], { env, encoding: 'utf8' });
  const [[cols, rows], ...rest] = sizes;
  const script = `${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; sleep 60`;
  const frames: Array<{ cols: number; rows: number; void: number; lines: number; border: string; widest: number }> = [];
  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'g', '-x', String(cols), '-y', String(rows), '-c', join(box, 'repo'), 'bash', '--norc', '-c', script);
    for (let i = 0; i < 450 && !tmux('capture-pane', '-p', '-t', 'g').includes('YOUR JOURNEY'); i++) await sleep(100);
    for (const [c, r] of [[cols, rows], ...rest]) {
      if (c !== cols || r !== rows) { tmux('resize-window', '-t', 'g', '-x', String(c), '-y', String(r)); await sleep(1500); }
      const frame = tmux('capture-pane', '-e', '-p', '-N', '-t', 'g');
      const plain = frame.replace(/\x1b\[[0-9;:]*m/g, '').split('\n').slice(0, r);
      const top = plain.find((l) => l.startsWith('╭'))?.trimEnd() ?? '';
      frames.push({
        cols: c, rows: r,
        void: parseAnsiFrame(frame, SENTINEL).filter((cell) => cell.bg === '#000000').length,
        lines: plain.length,
        border: `${top.length} ${top.slice(-1)}`,
        // The screen with wrapped rows joined: a piece of an older, wider frame would be wider than the terminal.
        widest: Math.max(...tmux('capture-pane', '-p', '-J', '-t', 'g').split('\n').map((l) => visibleWidth(l.trimEnd()))),
      });
    }
    return frames;
  } finally {
    try { tmux('kill-server'); } catch { /* already gone */ }
  }
}

describe('the monitor\'s frame', () => {
  it('follows a resize to the new width and never paints the void', async () => {
    expect(await frameAt([[100, 30], [80, 24]])).toEqual([
      { cols: 100, rows: 30, void: 0, lines: 30, border: '100 ╮', widest: 100 },
      { cols: 80, rows: 24, void: 0, lines: 24, border: '80 ╮', widest: 80 },
    ]);
  }, 90_000);
  // C-15 (found by the qualification's dry run, 07:37): narrowing the terminal reflows the old frame, and
  // Ink erases only the rows it drew; pieces of the 100-column frame stayed above the new one.
  it('leaves nothing of the old frame after a narrowing resize', async () => {
    const [, after] = await frameAt([[100, 30], [70, 30]]);
    expect({ border: after.border, widest: after.widest }).toEqual({ border: '70 ╮', widest: 70 });
  }, 90_000);
});

// C-11 under B2 (row 28): with Timmy Day or Night installed (TIMMY_PALETTE says which), the monitor reads
// on it and emits only the palette's 16 colors: no 24-bit or 256-color code, and no background of its
// own (the mode badge is inverse video). Before: law hex, white on Timmy Day's white at 1.00:1.
function sgrKinds(frame: string): { deep: number; painted: number } {
  let deep = 0;
  let painted = 0;
  for (const m of frame.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    const p = m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 38 || p[i] === 48) {
        if (p[i] === 48) painted++;
        if (p[i + 1] === 2 || p[i + 1] === 5) deep++;
        i += p[i + 1] === 2 ? 4 : 2;
      } else if ((p[i] >= 40 && p[i] <= 47) || (p[i] >= 100 && p[i] <= 107)) painted++;
    }
  }
  return { deep, painted };
}
async function paletteFrame(name: 'day' | 'night') {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', `pal-${name}`, ...args], { env, encoding: 'utf8' });
  const script = `TIMMY_PALETTE=${name} ${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; sleep 60`;
  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'p', '-x', '100', '-y', '30', '-c', join(box, 'repo'), 'bash', '--norc', '-c', script);
    for (let i = 0; i < 450 && !tmux('capture-pane', '-p', '-t', 'p').includes('YOUR JOURNEY'); i++) await sleep(100);
    const frame = tmux('capture-pane', '-e', '-p', '-N', '-t', 'p');
    return { palette: name, gate: gateFrame(parseAnsiFrame(frame, name === 'day' ? TIMMY_DAY : TIMMY_NIGHT)).pass, ...sgrKinds(frame) };
  } finally {
    try { tmux('kill-server'); } catch { /* already gone */ }
  }
}

describe('the monitor on Timmy Day and Night (B2)', () => {
  it('passes the contrast gate on both and emits only the 16 palette colors, painting no background', async () => {
    expect([await paletteFrame('day'), await paletteFrame('night')]).toEqual([
      { palette: 'day', gate: true, deep: 0, painted: 0 },
      { palette: 'night', gate: true, deep: 0, painted: 0 },
    ]);
  }, 120_000);
});
