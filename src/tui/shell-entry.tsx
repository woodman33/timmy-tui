import React from 'react';
import chalk from 'chalk';
import { render } from 'ink';
import { ShellV2 } from './components/ShellV2.js';
import { MonitorScreen } from './ui/MonitorScreen.js';
import { screenStream } from '../term/screen-stream.js';
import { MOUSE_OFF, MOUSE_ON, recordFrame } from './mouse.js';
import { visibleWidth } from '../term/width.js';
import { TerminalSession } from '../term/session.js';
import { currentCapabilities, type TerminalCapabilities } from '../term/capabilities.js';
import { lawPalette } from '../term/law-palette.js';
import { measuredFromPalette, namedPalette, type MeasuredColors } from '../term/palettes.js';
import { roleSlots } from '../term/theme.js';
import { visualLaw } from './theme.js';
// R4 (H98): the one guided setup decides what the monitor shows first (src/setup)
import { Onboarding } from './Onboarding.js';
import { answeredBy, pendingQuestions, readSetupState, setupLine } from '../setup/questions.js';
import { loadConfig, saveConfig } from '../utils/config.js';

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

/**
 * R4 (H98): what the monitor does first. Its own FIRST RUN finished (`onboarded`): HOME. Otherwise the setup in the Timmy
 * home decides: every question answered (`timmy init` or `timmy watch` asked them): HOME, with one line of what the setup
 * chose and who answered, and nothing asked; questions without an answer: the FIRST RUN asks those (src/tui/Onboarding.tsx),
 * then HOME on the same screen. Before, a home `timmy init` had set up still opened the monitor's own FIRST RUN, through
 * the legacy shell, with questions of its own (r24).
 */
export function monitorStart(config: unknown): { setup: boolean; intro: string } {
  const cfg = config as { onboarded?: boolean } | null;
  if (cfg?.onboarded === true) return { setup: false, intro: '' };
  const state = readSetupState();
  if (pendingQuestions(state).length) return { setup: true, intro: '' };
  // the answers were given elsewhere: the monitor's settings remember its first run is done, and it says what was chosen
  try { saveConfig({ onboarded: true } as never); } catch { /* said again next time */ }
  return { setup: false, intro: `Set up by ${answeredBy(state) ?? 'timmy init'}: ${setupLine(state)}` };
}

/** The monitor's screen: the FIRST RUN while questions have no answer, then the shell (HOME), with the config's key fresh. */
function MonitorRoot({ columns, config, setup, intro }: { columns: number; config: unknown; setup: boolean; intro: string }): React.ReactElement {
  const [phase, setPhase] = React.useState<'setup' | 'shell'>(setup ? 'setup' : 'shell');
  const [cfg, setCfg] = React.useState<unknown>(config);
  const [line, setLine] = React.useState(intro);
  if (phase === 'setup') {
    return React.createElement(Onboarding, {
      by: 'the monitor',
      onQuit: (code: number) => process.exit(code),
      onDone: () => {
        // a key saved by the setup (providers.json) is the agent's from now on
        let apiKey = (config as { apiKey?: string } | null)?.apiKey ?? '';
        try { apiKey = loadConfig().apiKey || apiKey; } catch { /* as before */ }
        setCfg({ ...(config as object), apiKey, onboarded: true });
        setLine(`Set up here: ${setupLine(readSetupState())}`);
        setPhase('shell');
      },
    });
  }
  return React.createElement(ShellV2, { width: columns, config: cfg, intro: line });
}

export function startShellV2(config: unknown, graphics: string, screen?: TerminalSession, colors: MonitorColors = knownColors()): void {
  void graphics;
  const first = monitorStart(config);
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
  // Fourth order, step 2: in its own screen the monitor takes button reports, so a click presses the key
  // it lands on (src/tui/mouse.ts); every way out gives the setting back. TIMMY_MOUSE=0 leaves it off.
  const mouse = process.stdout.isTTY === true && process.env.TIMMY_MOUSE !== '0';
  if (mouse) {
    process.stdout.write(MOUSE_ON);
    owner.beforeRestore(() => { process.stdout.write(MOUSE_OFF); });
  }
  const app = render(
    React.createElement(MonitorScreen, { children: (columns: number) => React.createElement(MonitorRoot, { columns, config, setup: first.setup, intro: first.intro }) }),
    {
      exitOnCtrlC: false,
      stdout: screenStream(process.stdout, (text) => {
        if (!fitsTerminal(text)) return '';
        recordFrame(text); // the text clicks are read against
        return palette(text);
      }),
    },
  );
  owner.beforeRestore(() => app.unmount());
}
