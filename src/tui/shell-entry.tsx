import React from 'react';
import chalk from 'chalk';
import { render } from 'ink';
import { ShellV2 } from './components/ShellV2.js';
import { MonitorScreen } from './ui/MonitorScreen.js';
import { screenStream } from '../term/screen-stream.js';
import { visibleWidth } from '../term/width.js';
import { TerminalSession } from '../term/session.js';
import { currentCapabilities, type TerminalCapabilities } from '../term/capabilities.js';
import { lawPalette } from '../term/law-palette.js';
import { measuredFromPalette, namedPalette, type MeasuredColors } from '../term/palettes.js';
import { roleSlots } from '../term/theme.js';
import { visualLaw } from './theme.js';

/** What the monitor knows about the terminal's colors: its color level and what was measured. */
export interface MonitorColors {
  color: TerminalCapabilities['color'];
  measured: MeasuredColors;
}

/** Without a measurement from the caller: TIMMY_PALETTE when set, otherwise nothing measured. */
function knownColors(): MonitorColors {
  const named = namedPalette(process.env.TIMMY_PALETTE);
  return { color: currentCapabilities().color, measured: named ? measuredFromPalette(named) : { background: null, slots: {} } };
}

/**
 * B2 (row 28): chalk writes the law's colors in 24-bit form and the screen stream turns each one into
 * the palette slot of its role, so the terminal's own palette draws them; with no color support, none.
 */
function toPalette(colors: MonitorColors): (text: string) => string {
  chalk.level = colors.color > 0 ? 3 : 0;
  const law = Object.fromEntries(Object.entries(visualLaw.color).map(([name, c]) => [name, c.value]));
  return lawPalette(law, roleSlots({ color: colors.color }, colors.measured));
}

/** The monitor's own screen when the caller has none (the bundled fast path): alternate screen, restored on every exit. */
function ownScreen(): TerminalSession {
  const screen = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  screen.enterAltScreen();
  screen.install();
  return screen;
}

// BOOT (opentui-u4e9): HOME assembles from the light shell entry (ShellV2 +
// keymap/modes/bus only). The full App (agent graph, telemetry, onboarding)
// lazy-loads: onboarding when not completed, agent on first chat send.
/** False for a frame with a line wider than the terminal: drawn, it would wrap and leave pieces behind. */
export function fitsTerminal(text: string, columns = process.stdout.columns): boolean {
  if (!columns) return true;
  return text.split('\n').every((line) => visibleWidth(line) <= columns);
}

export function startShellV2(config: unknown, graphics: string, screen?: TerminalSession, colors: MonitorColors = knownColors()): void {
  const cfg = config as { onboarded?: boolean } | null;
  if (!cfg || cfg.onboarded !== true) {
    void import('./app.js').then(m => m.startTUI(config as never, 'brief', graphics));
    return;
  }
  // C-11: ShellV2 ends itself on Ctrl+C with 130 (cancelled); Ink's own Ctrl+C exit returned 0.
  // The frame follows the terminal's width, resize included (row 27).
  // Frames go through the screen stream (no ED 3), and Ink tears down before the screen is restored,
  // on every exit path: its last frame is a full clear, which after the restore landed on the main
  // screen, erased it and left the frame there.
  const owner = screen ?? ownScreen();
  // C-15: narrowing the terminal reflows the old frame, and Ink erases only the rows it drew; it also
  // redraws the old, wider frame once before the new width reaches the layout. Pieces of the wider frame
  // stayed above the new one. The monitor owns this screen: it clears it on a resize, and a frame wider
  // than the terminal (it would wrap) is never drawn; the next one, at the new width, is.
  const clearOnResize = (): void => { process.stdout.write('\x1b[2J\x1b[H'); };
  process.stdout.prependListener('resize', clearOnResize);
  owner.beforeRestore(() => { process.stdout.off('resize', clearOnResize); });
  const palette = toPalette(colors);
  const app = render(
    React.createElement(MonitorScreen, { children: (columns: number) => React.createElement(ShellV2, { width: columns, config }) }),
    { exitOnCtrlC: false, stdout: screenStream(process.stdout, (text) => (fitsTerminal(text) ? palette(text) : '')) },
  );
  owner.beforeRestore(() => app.unmount());
}
