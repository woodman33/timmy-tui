// Contrast gate for one capture:  npx tsx scripts/ui/gate.ts FILE.ansi [--palette night|day|audited] [--json]
// Exit 0 when every run meets its floor, 1 when any fails, 2 on bad usage.
import { readFileSync } from 'node:fs';
import { parseAnsiFrame } from '../../src/tui/qa/ansi-frame.js';
import { gateFrame } from '../../src/tui/qa/contrast-gate.js';
import { CAPTURE_PALETTES } from './palettes.js';

const args = process.argv.slice(2);
let file: string | undefined;
let paletteName = 'night';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--palette') paletteName = args[++i] ?? '';
  else if (args[i] !== '--json') file ??= args[i];
}
const palette = CAPTURE_PALETTES[paletteName];
if (!file || !palette) {
  console.error(`usage: gate.ts FILE.ansi [--palette ${Object.keys(CAPTURE_PALETTES).join('|')}] [--json]`);
  process.exit(2);
}
const report = gateFrame(parseAnsiFrame(readFileSync(file, 'utf8'), palette));
if (args.includes('--json')) {
  console.log(JSON.stringify({ file, palette: palette.name, ...report }));
} else {
  const counts = report.violations.reduce<Record<string, number>>((acc, v) => ((acc[v.rule] = (acc[v.rule] ?? 0) + 1), acc), {});
  console.log(`${report.pass ? 'PASS' : 'FAIL'} · ${palette.name} · ${report.runs} runs measured · ${JSON.stringify(counts)}`);
  for (const v of report.violations) {
    console.log(`  row ${String(v.row).padStart(2)}  ${v.rule.padEnd(12)} ${v.ratio.toFixed(2)}:1 < ${v.floor}  ${v.fg} on ${v.bg}  "${v.text.slice(0, 48)}"`);
  }
}
process.exit(report.pass ? 0 : 1);
