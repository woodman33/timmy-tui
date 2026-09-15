import { integrationCatalog } from './registry.js';
import { runIntegration } from './runner.js';
import { readStrictJsonFile } from '../../utils/strict-json-file.js';

export async function runIntegrationsCli(args: string[]) {
  if (!args.length || args[0] === 'list') {
    console.log(JSON.stringify({ integrations: integrationCatalog(), note: 'Presence is not qualification; run a declared operation to collect evidence.' }, null, 2)); return;
  }
  if (args.includes('--help')) {
    console.log('timmy vision integrations list\ntimmy vision integrations run <id> --request FILE\nRequest JSON requires operation. Timmy supplies an isolated output directory and records intent before dispatch.'); return;
  }
  if (args.length !== 4 || args[0] !== 'run' || args[2] !== '--request') throw new Error('Use vision integrations run <id> --request FILE.');
  const report = await runIntegration(args[1], await readStrictJsonFile(args[3]));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
