import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOADER, MONITOR, monitorHome, treeOf } from './fixtures/ui-monitor-home.js';
import { parseAnsiFrame, TIMMY_DAY, TIMMY_NIGHT } from '../src/tui/qa/ansi-frame.js';
import { gateFrame } from '../src/tui/qa/contrast-gate.js';
import { visibleWidth } from '../src/term/width.js';

// C-11 in a real PTY: `timmy watch` (the monitor, cli.tsx) owns the alternate screen and gives the
// terminal back on every way out. Before: it sent ESC c (a full reset) and drew in the main screen,
// and Ctrl+C did not end it. Each test has a home of its own (HOME, config folder, Timmy home, repo,
// store and tmux server; tests/fixtures/ui-monitor-home.ts): nothing touches this tree or another test.
// Fourth order, step 1: a test that does not reach the screen it checks fails there; it never checks
// contrast or a resize against the setup screen.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function endMonitorBy(mode: 'ctrl-c' | 'sigterm') {
  const h = monitorHome('initialized', { git: true });
  // The pane's raw output is logged (tmux pipe-pane) before the monitor starts, to see every byte it sends.
  const raw = join(h.box, `raw-${mode}.log`);
  const script = `sleep 1; S0=$(stty -g); printf 'MARKER-BEFORE\\n'; ${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same || echo TTY=changed; sleep 60`;
  try {
    h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '30', '-c', h.repo, 'bash', '--norc', '-c', script);
    h.tmux('pipe-pane', '-o', '-t', 't', `cat >> ${raw}`);
    await h.waitFor(/YOUR JOURNEY/);
    const during = h.tmux('display', '-p', '-t', 't', '#{alternate_on}').trim();
    if (mode === 'ctrl-c') h.tmux('send-keys', '-t', 't', 'C-c');
    else {
      // The signal goes to the monitor this test started, found under this pane's own shell (never by name
      // across the machine: other tests run monitors at the same time).
      const monitors = treeOf(Number(h.tmux('display', '-p', '-t', 't', '#{pane_pid}').trim())).filter((p) => p.args.includes(MONITOR));
      expect(monitors.length).toBe(1);
      process.kill(monitors[0].pid, 'SIGTERM');
    }
    const exit = Number((await h.waitFor(/EXIT=(\d+)/, 15_000))[1]);
    await h.waitFor(/TTY=\w+/, 5_000);
    const after = h.tmux('capture-pane', '-p', '-t', 't');
    const bytes = readFileSync(raw, 'utf8');
    return {
      during, exit, tty: after.match(/TTY=(\w+)/)![1], flags: h.tmux('display', '-p', '-t', 't', '#{cursor_flag} #{alternate_on}').trim(),
      marker: after.includes('MARKER-BEFORE'), frameLeft: after.includes('YOUR JOURNEY'),
      // ED 3 erases saved lines (the scrollback); the monitor never sends it, nor ESC c.
      savedLinesErased: bytes.includes('\x1b[3J') || bytes.includes('\x1bc'),
    };
  } finally {
    await h.dispose();
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
  const h = monitorHome('initialized', { git: true });
  const tmux = h.tmux;
  const [[cols, rows], ...rest] = sizes;
  const script = `${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; sleep 60`;
  const frames: Array<{ cols: number; rows: number; void: number; lines: number; border: string; widest: number }> = [];
  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', String(cols), '-y', String(rows), '-c', h.repo, 'bash', '--norc', '-c', script);
    await h.waitFor(/YOUR JOURNEY/);
    for (const [c, r] of [[cols, rows], ...rest]) {
      if (c !== cols || r !== rows) { tmux('resize-window', '-t', 't', '-x', String(c), '-y', String(r)); await sleep(1500); }
      await h.waitFor(/YOUR JOURNEY/, 5_000); // still the home screen at this size
      const frame = tmux('capture-pane', '-e', '-p', '-N', '-t', 't');
      const plain = frame.replace(/\x1b\[[0-9;:]*m/g, '').split('\n').slice(0, r);
      const top = plain.find((l) => l.startsWith('╭'))?.trimEnd() ?? '';
      frames.push({
        cols: c, rows: r,
        void: parseAnsiFrame(frame, SENTINEL).filter((cell) => cell.bg === '#000000').length,
        lines: plain.length,
        border: `${top.length} ${top.slice(-1)}`,
        // The screen with wrapped rows joined: a piece of an older, wider frame would be wider than the terminal.
        widest: Math.max(...tmux('capture-pane', '-p', '-J', '-t', 't').split('\n').map((l) => visibleWidth(l.trimEnd()))),
      });
    }
    return frames;
  } finally {
    await h.dispose();
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
  const h = monitorHome('initialized', { git: true });
  const script = `TIMMY_PALETTE=${name} ${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; sleep 60`;
  try {
    h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '30', '-c', h.repo, 'bash', '--norc', '-c', script);
    await h.waitFor(/YOUR JOURNEY/);
    const frame = h.tmux('capture-pane', '-e', '-p', '-N', '-t', 't');
    return { palette: name, gate: gateFrame(parseAnsiFrame(frame, name === 'day' ? TIMMY_DAY : TIMMY_NIGHT)).pass, ...sgrKinds(frame) };
  } finally {
    await h.dispose();
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

// Fourth order, step 1: the two fixtures are told apart on screen. A home that has finished onboarding
// opens on the home screen; one that has not opens on the setup screen, never on the home screen.
async function firstScreen(kind: 'initialized' | 'first-run') {
  const h = monitorHome(kind, { git: true });
  try {
    h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '30', '-c', h.repo, 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; sleep 60`);
    const [seen] = await h.waitFor(/YOUR JOURNEY|TIMMY · FIRST RUN/);
    await sleep(1000);
    const screen = h.tmux('capture-pane', '-p', '-t', 't');
    return { kind, seen, home: screen.includes('YOUR JOURNEY'), setup: screen.includes('TIMMY · FIRST RUN') };
  } finally {
    await h.dispose();
  }
}

describe('the monitor\'s fixtures', () => {
  it('an initialized home opens on the home screen; a first-run home opens on the setup screen', async () => {
    expect([await firstScreen('initialized'), await firstScreen('first-run')]).toEqual([
      { kind: 'initialized', seen: 'YOUR JOURNEY', home: true, setup: false },
      { kind: 'first-run', seen: 'TIMMY · FIRST RUN', home: false, setup: true },
    ]);
  }, 120_000);
});

// Fourth order, step 2: in a real PTY the monitor asks for mouse reports in its own screen, a click on a
// tab presses that tab's digit (the keyboard's key), and Ctrl+C gives the setting back.
async function clicks() {
  const h = monitorHome('initialized', { git: true });
  const raw = join(h.box, 'raw-click.log');
  try {
    h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '30', '-c', h.repo, 'bash', '--norc', '-c', `sleep 0.5; ${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; echo EXIT=$?; sleep 60`);
    h.tmux('pipe-pane', '-o', '-t', 't', `cat >> ${raw}`);
    await h.waitFor(/YOUR JOURNEY/);
    const header = () => h.tmux('capture-pane', '-p', '-t', 't').split('\n')[0];
    const cellOf = (line: string, needle: string) => visibleWidth(line.slice(0, line.indexOf(needle))) + 1;
    const click = (x: number, y: number) => h.tmux('send-keys', '-t', 't', '-l', `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
    click(cellOf(header(), ' 2') + 1, 1);
    await h.waitFor(/^TIMMY .*2 RUN/m, 5_000);
    const afterTab = header();
    click(cellOf(afterTab, ' 1') + 1, 1);
    await h.waitFor(/^TIMMY .*1 HOME/m, 5_000);
    const back = header();
    // A hint presses its key: "[c] chat" in the footer opens chat; there, "[Esc] leave" leaves it
    // (while typing, a click on a one-letter hint would type it, so only Enter, Esc and Tab count).
    const rowOf = (needle: string) => {
      const lines = h.tmux('capture-pane', '-p', '-t', 't').split('\n');
      const y = lines.findIndex((l) => l.includes(needle));
      return { x: cellOf(lines[y], needle) + 1, y: y + 1 };
    };
    const chat = rowOf('[c] chat');
    click(chat.x, chat.y);
    await h.waitFor(/\[Esc\] leave/, 5_000);
    const leave = rowOf('[Esc] leave');
    click(leave.x, leave.y);
    await h.waitFor(/\[c\] chat/, 5_000);
    const left = !h.tmux('capture-pane', '-p', '-t', 't').includes('[Esc] leave');
    h.tmux('send-keys', '-t', 't', 'C-c');
    const [, exit] = await h.waitFor(/EXIT=(\d+)/, 15_000);
    const bytes = readFileSync(raw, 'utf8');
    return {
      clickedRun: /2 RUN/.test(afterTab), clickedHome: /1 HOME/.test(back), chatOpenedAndLeft: left, exit,
      askedForMouse: bytes.includes('\x1b[?1000h') && bytes.includes('\x1b[?1006h'),
      gaveItBack: bytes.lastIndexOf('\x1b[?1000l') > bytes.lastIndexOf('\x1b[?1000h') && bytes.lastIndexOf('\x1b[?1006l') > bytes.lastIndexOf('\x1b[?1006h'),
    };
  } finally {
    await h.dispose();
  }
}

describe('the monitor and the mouse', () => {
  it('a click on a tab presses its digit, a click on a hint presses its key; mouse reports are asked for in its screen and given back on exit', async () => {
    expect(await clicks()).toEqual({ clickedRun: true, clickedHome: true, chatOpenedAndLeft: true, exit: '130', askedForMouse: true, gaveItBack: true });
  }, 90_000);
});
