/**
 * `timmy tools` (round R1, plan F-0): what Timmy can do here, each on the ladder, from live checks that
 * write nothing and print no secret. The REPL's `/tools` shows the same rows.
 */
import { currentCapabilities } from '../term/capabilities.js';
import { measuredFromPalette, namedPalette } from '../term/palettes.js';
import { EXIT } from '../term/session.js';
import { buildTheme, serialize } from '../term/theme.js';
import { capabilities } from './index.js';
import { liveDeps } from './live.js';
import { capabilityJson, capabilityLines } from './render.js';

export function toolsHelp(): string {
  return [
    'timmy tools: what Timmy can do here, checked live.',
    '',
    'Usage: timmy tools [all] [--json]',
    '  all      also list each lane and each vision adapter',
    '  --json   one JSON object {checkedAt, ladder, rows}',
    '',
    'Each row is on the ladder of AGENTS.md §8:',
    '  reachable    a live check answered just now',
    '  installed    what it needs is here; nothing was contacted',
    '  needs setup  the step that sets it up is shown',
    '  not built    planned, or a stub that cannot do its job here',
    'OpenRouter is checked only when OPENROUTER_API_KEY is set here; /tools in the REPL checks the key it uses.',
    'Nothing is written, no server is started, and no key is printed.',
    '',
    'Exit codes: 0 the check ran (whatever it found), 2 usage.',
  ].join('\n');
}

export async function toolsMain(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${toolsHelp()}\n`);
    return EXIT.ok;
  }
  const words = args.filter((a) => a !== '--json');
  if (words.some((a) => a !== 'all' && a !== '--all')) {
    process.stderr.write(`timmy tools: unknown argument ${words.find((a) => a !== 'all' && a !== '--all')}. Try timmy tools --help.\n`);
    return EXIT.usage;
  }
  const key = env.OPENROUTER_API_KEY?.trim() || null;
  const rows = await capabilities(liveDeps({ env, ...(key ? { key: () => key } : {}), model: env.OPENROUTER_MODEL || 'the configured model' }), { all: words.length > 0 });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(capabilityJson(rows))}\n`);
    return EXIT.ok;
  }
  const caps = currentCapabilities();
  const named = namedPalette(env.TIMMY_PALETTE);
  const theme = buildTheme(caps, named ? measuredFromPalette(named) : undefined);
  for (const line of capabilityLines(rows, theme.glyphs, caps.columns)) process.stdout.write(`${serialize(line, theme)}\n`);
  return EXIT.ok;
}
