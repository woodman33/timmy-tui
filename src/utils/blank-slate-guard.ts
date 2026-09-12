// blank-slate-v1k9: the first import of cli.tsx. ES module imports are hoisted and evaluated in
// order, so this runs before the TUI, the companion server or any panel module loads — on a blank
// slate (no ~/timmy/identity.json) the wizard banner is all that shows, and nothing is written.
// Skipped when headless, under CI, or with TIMMY_SKIP_INIT=1 (tests that drive the TUI directly).
import { isBlankSlate, printBlankSlateBanner } from './init.js';

const headless = process.argv.includes('--headless') || process.argv.includes('-h') || process.argv.includes('--help');
if (!headless && !process.env.CI && !process.env.TIMMY_SKIP_INIT && isBlankSlate()) {
  printBlankSlateBanner();
  console.log('  Run `timmy init` (or `npx tsx src/cli.ts init`) first.\n');
  process.exit(0);
}
