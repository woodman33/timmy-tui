// Prints the semantic map with the real theme code, for captures:
//   npx tsx scripts/ui/swatch.ts [--assume night|day|basic]
// --assume stands in for what the OSC 11/OSC 4 probe would measure on that terminal.
import { currentCapabilities } from '../../src/term/capabilities.js';
import { measuredFromPalette, TERMINAL_BASIC, TIMMY_DAY, TIMMY_NIGHT } from '../../src/term/palettes.js';
import { buildTheme, serialize, type Segment } from '../../src/term/theme.js';

const assume = process.argv[process.argv.indexOf('--assume') + 1] ?? 'night';
const palette = { night: TIMMY_NIGHT, day: TIMMY_DAY, basic: TERMINAL_BASIC }[assume] ?? TIMMY_NIGHT;
const theme = buildTheme(currentCapabilities(), measuredFromPalette(palette));
const g = theme.glyphs;
const row = (label: string, ...rest: Segment[]): string =>
  serialize([{ text: `  ${label.padEnd(14)}` , role: 'secondary' }, ...rest], theme);
const lines = [
  '',
  serialize([{ text: '  TIMMY', role: 'strong' }, { text: `  semantic map ${g.sep} ${palette.name}`, role: 'secondary' }], theme),
  '',
  row('primary', { text: 'The voiceover lane is ready.' }),
  row('secondary', { text: `~/timmy/launch-video ${g.sep} previews and hints`, role: 'secondary' }),
  row('verified', { text: `${g.ok} RECEIPT 0142`, role: 'verified' }, { text: ' signed and verified' }),
  row('estimate', { text: `${g.estimate} est. $0.42`, role: 'estimate' }, { text: '  ' }, { text: `${g.warn} Wrote`, role: 'estimate' }, { text: ' 2 files' }),
  row('failure', { text: `${g.fail} Error:`, role: 'failure' }, { text: ' the voiceover lane stopped' }),
  row('model-made', { text: `${g.ai} Generated`, role: 'ai' }, { text: ' storyboard.json' }),
  row('rule', { text: g.rule.repeat(12), role: 'rule' }, { text: ` ${g.rail} ${g.railOpen}`, role: 'rule' }),
  row('diff', { text: '+ added line', role: 'diffAdd' }, { text: '  ' }, { text: '- removed line', role: 'diffRemove' }),
  row('lanes', { text: '[x]', role: 'strong' }, { text: ' done  ' }, { text: '[~]', role: 'strong' }, { text: ' running  [ ] waiting' }),
  row('spinner', { text: `${g.spinner[0]} Working`, role: 'secondary' }, { text: ' 3.2s', role: 'secondary' }),
  '',
];
const tint = theme.tint ? `\x1b[${theme.tint}m` : '';
const tinted = (text: string): string => (tint ? `${tint}\x1b[K${text}\x1b[49m` : text);
process.stdout.write(lines.join('\n') + '\n');
process.stdout.write([tinted(''), tinted(` ${g.prompt} Make a 20-second storyboard`), tinted('')].join('\n') + '\n\x1b[K\n');
