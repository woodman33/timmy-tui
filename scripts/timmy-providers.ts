import { existsSync, readFileSync } from 'node:fs';
import { auditProviders, type ProviderAuditEntry } from '../src/agent/provider-registry.js';
import { runFal3dCli } from '../src/utils/fal3d-cli.js';

function parseArgs(argv: string[]) {
  const command = argv.find((arg) => !arg.startsWith('-')) || 'audit';
  const json = argv.includes('--json');
  return { command, json };
}

function loadDotEnv(path = '.env'): Record<string, string> {
  if (!existsSync(path)) return {};

  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equals = line.indexOf('=');
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function mergedEnv(): NodeJS.ProcessEnv {
  return { ...loadDotEnv(), ...process.env };
}

function printAudit(entries: ProviderAuditEntry[], json = false) {
  if (json) {
    console.log(JSON.stringify({ providers: entries }, null, 2));
    return;
  }

  console.log('TIMMY Provider Audit');
  console.log('Secrets are checked by environment variable name only; values are never printed.');
  console.log('');

  for (const entry of entries) {
    const enabled = entry.enabled ? 'enabled' : 'disabled';
    const present = entry.presentEnvVars.length > 0 ? entry.presentEnvVars.join(', ') : 'none';
    const missing =
      entry.missingRequiredEnvVars.length > 0 ? ` missing: ${entry.missingRequiredEnvVars.join(', ')}` : '';

    console.log(
      `${entry.id.padEnd(16)} ${entry.classification.padEnd(8)} ${enabled.padEnd(8)} ${entry.readiness.padEnd(12)} env: ${present}${missing}`,
    );
  }
}

const { command, json } = parseArgs(process.argv.slice(2));

if (command === 'fal3d') {
  try { await runFal3dCli(process.argv.slice(3), mergedEnv()); }
  catch (error) { console.error(error instanceof Error ? error.message : 'fal3d operation failed'); process.exitCode = 1; }
} else if (command === 'audit') {
  printAudit(auditProviders(mergedEnv()), json);
} else {
  console.error('Usage: timmy providers audit [--json] | fal3d check|plan|submit|status|collect');
  process.exitCode = 2;
}
