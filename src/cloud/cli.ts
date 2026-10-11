/**
 * Round R4 (helper H93): `timmy cloud …`, Timmy Cloud's client from the terminal (src/cli.ts hands it the words after
 * `cloud`): `use <url> --token-file <file>`, `status [--json]` (also with no verb), `help`. Lines in Timmy Homebrew's roles,
 * or one JSON object with --json. The operator's token is never printed, in either.
 */
import { currentCapabilities } from '../term/capabilities.js';
import { measuredFromPalette, namedPalette } from '../term/palettes.js';
import { buildTheme, serialize } from '../term/theme.js';
import { cloudDo, type Line } from './commands.js';

export async function cloudMain(args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const caps = currentCapabilities();
  const named = namedPalette(env.TIMMY_PALETTE);
  const theme = buildTheme(caps, named ? measuredFromPalette(named) : undefined);
  const write = (stream: NodeJS.WriteStream, line: Line): void => { stream.write(`${serialize(line, theme)}\n`); };
  const said = await cloudDo(args, { glyphs: theme.glyphs, by: 'cli', cwd: process.cwd() });
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(said.json)}\n`);
  else for (const line of said.lines) write(said.code === 2 ? process.stderr : process.stdout, line);
  return said.code;
}
