/**
 * Ask the terminal for its real colors (playbook §17.3): OSC 11 for the background, OSC 4 for
 * palette slots 7 and 8 (the gray, B3), 1, 2, 3 and 5 (the meanings, so one that misses its floor
 * is dropped: row 28) and their bright twins 9, 10, 11 and 13 (one of which a meaning takes when its
 * own slot misses: fourth order, step 2), then DA1 as a sentinel every terminal answers, so a terminal
 * that ignores OSC queries ends the wait early. Only on an interactive terminal; 200ms at most; raw
 * mode and the paused stdin are restored on every outcome.
 */
import type { TerminalCapabilities } from './capabilities.js';
import { rgbToHex } from './color.js';
import { measuredFromPalette, namedPalette, type MeasuredColors } from './palettes.js';

export interface ProbeStreams {
  stdin: Pick<NodeJS.ReadStream, 'on' | 'off' | 'resume' | 'pause' | 'setRawMode'> & { isTTY?: boolean; isRaw?: boolean };
  stdout: Pick<NodeJS.WriteStream, 'write'> & { isTTY?: boolean };
}

const SLOTS = [7, 8, 1, 2, 3, 5, 9, 10, 11, 13];
export const COLOR_QUERY = `\x1b]11;?\x07${SLOTS.map((n) => `\x1b]4;${n};?\x07`).join('')}\x1b[c`;
const REPLY = /\x1b\](11|4;(\d{1,3}));rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/gi;
const DA1 = /\x1b\[\?[\d;]*c/;

const channel = (hex: string): number => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);

export function parseColorReplies(text: string): MeasuredColors {
  const result: MeasuredColors = { background: null, slots: {} };
  for (const m of text.matchAll(REPLY)) {
    const hex = rgbToHex([channel(m[3]), channel(m[4]), channel(m[5])]);
    if (m[1] === '11') result.background = hex;
    else result.slots[Number(m[2])] = hex;
  }
  return result;
}

export function probeTerminalColors(io: ProbeStreams, caps: { interactive: boolean }, timeoutMs = 200): Promise<MeasuredColors> {
  if (!caps.interactive || !io.stdin.isTTY || !io.stdout.isTTY) return Promise.resolve({ background: null, slots: {} });
  const { stdin } = io;
  const wasRaw = stdin.isRaw === true;
  return new Promise((resolve) => {
    let buffer = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } finally {
        stdin.pause();
        resolve(parseColorReplies(buffer));
      }
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (DA1.test(buffer)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      io.stdout.write(COLOR_QUERY);
    } catch {
      finish();
    }
  });
}

/** Over SSH the terminal's answer makes a round trip; 200ms is too short and a late reply would be typed into the prompt. */
const PROBE_MS = { local: 200, ssh: 1000 };

/** `TIMMY_PALETTE=night|day` says which palette is installed; otherwise ask the terminal (200ms, 1s over SSH). */
export function measureTerminal(
  caps: Pick<TerminalCapabilities, 'interactive'> & Partial<Pick<TerminalCapabilities, 'ssh'>>,
  env: Record<string, string | undefined>,
  io: ProbeStreams,
  probe: typeof probeTerminalColors = probeTerminalColors,
): Promise<MeasuredColors> {
  const named = namedPalette(env.TIMMY_PALETTE);
  if (named) return Promise.resolve(measuredFromPalette(named));
  return probe(io, caps, caps.ssh ? PROBE_MS.ssh : PROBE_MS.local);
}
