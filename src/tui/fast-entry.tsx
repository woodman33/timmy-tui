// BOOT (opentui-u4e9): the bundled fast path. node dist/fast.js paints nothing
// itself (boot.cjs already painted the header) — it loads config, renders the
// shell (HOME assembles), and attaches the companion asynchronously after.
import { loadConfig } from '../utils/config.js';
import { startShellV2 } from './shell-entry.js';

const config = loadConfig() as { apiKey?: string; model?: string; onboarded?: boolean };
const agentConfig = {
  apiKey: config.apiKey || 'setup_placeholder',
  model: config.model,
  onboarded: config.onboarded === true,
  instructions: '',
  maxSteps: 10,
  maxCost: 1,
} as never;

if ((config as { onboarded?: boolean }).onboarded === true) {
  startShellV2(agentConfig, 'ansi');
  void import('../companion/server.js')
    .then(m => m.startCompanionServer(parseInt(process.env.TIMMY_COMPANION_PORT || '3001', 10)))
    .catch(() => undefined);
} else {
  void import('./app.js').then(m => m.startTUI(agentConfig, 'brief', 'ansi'));
}
