/**
 * `timmy tools` (round R1, plan F-0): what Timmy can do here, each on the ladder, from live checks that
 * write nothing and print no secret. The REPL's `/tools` shows the same rows.
 *
 * Round R4 (H76): the plan's whole ladder (src/capabilities/ladder.ts), each rung with its own evidence, and the
 * operator's Mac demonstrations beside it (a separate fact); `timmy tools <name>` shows one row in full.
 */
import { currentCapabilities } from '../term/capabilities.js';
import { measuredFromPalette, namedPalette } from '../term/palettes.js';
import { EXIT } from '../term/session.js';
import { buildTheme, serialize } from '../term/theme.js';
import { capabilities } from './index.js';
import { RUNG_MEANS, RUNG_ORDER } from './ladder.js';
import { liveDeps } from './live.js';
import { capabilityDetailLines, capabilityJson, capabilityLines, findRows } from './render.js';

export function toolsHelp(): string {
  return [
    'timmy tools: what Timmy can do here, checked live.',
    '',
    'Usage: timmy tools [all] [--json]',
    '       timmy tools <name> [--json]',
    '  all      also list each lane and each vision adapter',
    '  <name>   one row in full: each rung\'s evidence, and its demonstrations on the Mac (a row\'s id or name)',
    '  --json   one JSON object {checkedAt, ladder, rungWords, demonstrated, rows}; each row has its rung,',
    '           ladder (one evidence object per rung, null when not reached), notReached and demonstrated',
    '',
    'Each row is on the ladder of AGENTS.md §8 (the plan\'s rule 1), each rung with its own evidence:',
    ...RUNG_ORDER.map((s) => `  ${s.padEnd(12)} ${RUNG_MEANS[s]}`),
    'A rung above installed stands only while the tool is here; a past run never raises a missing tool.',
    'On the Mac: a recorded, scripted demonstration in the ledger (docs/ui-cockpit/CHECKPOINTS.md); never a rung.',
    'OpenRouter is checked only when OPENROUTER_API_KEY is set here; /tools in the REPL checks the key it uses.',
    'Nothing is written, no server is started, no program is run, and no key is printed.',
    '',
    'Exit codes: 0 the check ran (whatever it found), 1 no row has that name, 2 usage.',
  ].join('\n');
}

export async function toolsMain(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${toolsHelp()}\n`);
    return EXIT.ok;
  }
  const words = args.filter((a) => a !== '--json');
  const flag = words.find((a) => a.startsWith('-') && a !== '--all');
  if (flag) {
    process.stderr.write(`timmy tools: unknown option ${flag}. Try timmy tools --help.\n`);
    return EXIT.usage;
  }
  const all = words.length === 1 && (words[0] === 'all' || words[0] === '--all');
  const name = all ? '' : words.join(' ').trim();
  const key = env.OPENROUTER_API_KEY?.trim() || null;
  // A name is looked for among every row, the lanes and vision adapters too.
  const rows = await capabilities(liveDeps({ env, ...(key ? { key: () => key } : {}), model: env.OPENROUTER_MODEL || 'the configured model' }), { all: all || Boolean(name) });
  if (name) {
    const found = findRows(rows, name);
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(capabilityJson(found))}\n`);
      return found.length ? EXIT.ok : EXIT.failure;
    }
    const caps = currentCapabilities();
    const named = namedPalette(env.TIMMY_PALETTE);
    const theme = buildTheme(caps, named ? measuredFromPalette(named) : undefined);
    for (const line of capabilityDetailLines(rows, name, theme.glyphs, caps.columns)) (found.length ? process.stdout : process.stderr).write(`${serialize(line, theme)}\n`);
    return found.length ? EXIT.ok : EXIT.failure;
  }
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
