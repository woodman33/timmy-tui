/**
 * Round R4 (helper H90): `timmy connect …`, Timmy Connect from the terminal (src/cli.ts hands it every verb of
 * src/connect/commands.ts; any other word stays the older `timmy connect <tool>`). Lines in Timmy Homebrew's roles, or one
 * JSON object with --json (taken only before `--`, so a remote command's own --json is its own). A Ctrl-C during a wait
 * stops only the local ssh: the words say the remote job was not stopped, with the command that stops it (exit 130).
 */
import { currentCapabilities } from '../term/capabilities.js';
import { measuredFromPalette, namedPalette } from '../term/palettes.js';
import { sanitize } from '../term/sanitize.js';
import { buildTheme, serialize } from '../term/theme.js';
import { connectDo, isConnectVerb, type Line } from './commands.js';

export { isConnectVerb };

export async function connectMain(args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const dash = args.indexOf('--');
  const json = (dash < 0 ? args : args.slice(0, dash)).includes('--json');
  const caps = currentCapabilities();
  const named = namedPalette(env.TIMMY_PALETTE);
  const theme = buildTheme(caps, named ? measuredFromPalette(named) : undefined);
  // every line's words as plain text (a device's words are cleaned when they are read; a record from before is cleaned here):
  // the theme's own colours are the only escape sequences written
  const write = (stream: NodeJS.WriteStream, line: Line): void => { stream.write(`${serialize(line.map((s) => ({ ...s, text: sanitize(s.text) })), theme)}\n`); };
  const controller = new AbortController();
  let signalled: NodeJS.Signals | null = null;
  const onSignal = (sig: NodeJS.Signals) => (): void => { signalled ??= sig; controller.abort(); };
  const onInt = onSignal('SIGINT');
  const onTerm = onSignal('SIGTERM');
  // only a wait takes Ctrl-C itself (it stops the local ssh and says so); any other verb ends as a signal ends it
  const head = dash < 0 ? args : args.slice(0, dash);
  const waits = head.includes('--wait') || head.find((a) => !a.startsWith('-')) === 'wait';
  if (waits) {
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
  }
  try {
    const said = await connectDo(args, {
      glyphs: theme.glyphs, by: 'cli', cwd: process.cwd(), signal: controller.signal,
      // `trust` pins a host key only for a person at a terminal (stdin a TTY)
      terminal: Boolean(process.stdin.isTTY),
      // while a wait runs, its progress goes to stderr (stdout keeps the one JSON object)
      progress: (line) => write(process.stderr, line),
    });
    if (json) process.stdout.write(`${JSON.stringify(said.json)}\n`);
    else for (const line of said.lines) write(said.code === 2 ? process.stderr : process.stdout, line);
    return said.code === 130 && signalled === 'SIGTERM' ? 143 : said.code;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}
