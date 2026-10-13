// BOOT (opentui-u4e9): the bundled fast path. node dist/fast.js paints nothing
// itself (boot.cjs already painted the header) — it loads config, renders the
// shell (HOME assembles), and attaches the companion asynchronously after.
import { loadConfig } from '../utils/config.js';
import { startShellV2 } from './shell-entry.js';

const config = loadConfig() as { apiKey?: string; model?: string; onboarded?: boolean };
const agentConfig = {
  apiKey: config.apiKey || '', // R4 (H87): never a placeholder key
  model: config.model,
  onboarded: config.onboarded === true,
  instructions: '',
  maxSteps: 10,
  maxCost: 1,
} as never;

// R4 (H98): the shell decides what comes first (src/tui/shell-entry.tsx monitorStart): HOME, or the FIRST RUN for questions
// that have no answer yet, then HOME; never the legacy shell.
startShellV2(agentConfig, 'ansi');
// R4 (H84): on 127.0.0.1 with its token; the monitor's pairing card (q on HOME) shows its address with the token.
void import('../companion/server.js')
  .then(m => m.startCompanionServer(parseInt(process.env.TIMMY_COMPANION_PORT || '3001', 10)))
  .then(server => { (global as any).companionServer = server; })
  .catch(() => undefined);
