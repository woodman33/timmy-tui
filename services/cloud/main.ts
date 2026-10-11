/**
 * Timmy Cloud's backend, slice 1: the process.
 *
 *   node --import tsx services/cloud/main.ts --data <folder> --provider-url <simulated provider's URL> [options]
 *
 * The only provider in this slice is the SIMULATED one: no real provider is called, nothing is bought, no DNS changes,
 * nothing is deployed. The agency credential comes from TIMMY_CLOUD_AGENCY_TOKEN or --agency-token-file <file> (0600);
 * the operator's token is given only as its sha256 (--operator-token-sha256 or TIMMY_CLOUD_OPERATOR_TOKEN_SHA256).
 *
 * Options: --port <n> (0: any free port; the backend listens on 127.0.0.1 only), --tick-ms <n> (how often it goes on by
 * itself; 0: only when asked, default 2000), --poll-ms <n> (least time between two unattended reads of the same thing,
 * default 10000), --provider-timeout-ms <n> (default 10000), --retention-days <n> (default 30),
 * --provider-proves-absence (the simulated provider was started keeping client references).
 *
 * It prints one JSON line on stdout once it listens: {"listening": "http://127.0.0.1:<port>", ...}. A refusal at start is
 * a sentence on stderr, with no path and no value, and exit code 2.
 */
import { CloudEngine } from './engine.js';
import { CloudHttpServer } from './http.js';
import { CredentialError, Redactor, loadAgencyCredential, loadOperatorTokenSha256 } from './redaction.js';
import { SimulatedAdapter } from './simulated-adapter.js';
import { Failpoints } from './failpoints.js';
import { DataFolderError } from './event-log.js';

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function num(args: string[], name: string, fallback: number): number {
  const v = flag(args, name);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new CredentialError(`${name} is a whole number, 0 or more.`);
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const provider = flag(args, '--provider') ?? 'simulated';
  if (provider !== 'simulated') throw new CredentialError('Only the simulated provider exists in this slice: no real provider is called. Nothing was started.');
  const dataDir = flag(args, '--data');
  if (!dataDir) throw new CredentialError('Name the data folder with --data <folder>. Nothing was started.');
  const providerUrl = flag(args, '--provider-url');
  if (!providerUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(providerUrl)) throw new CredentialError('Name the simulated provider with --provider-url http://127.0.0.1:<port>. Nothing was started.');

  const credential = loadAgencyCredential({ file: flag(args, '--agency-token-file'), env: process.env });
  const operatorTokenSha256 = loadOperatorTokenSha256({ given: flag(args, '--operator-token-sha256'), env: process.env });
  const redactor = new Redactor([credential.value]);
  const failpoints = Failpoints.fromEnv(process.env);

  const adapter = new SimulatedAdapter({
    baseUrl: providerUrl, credential: credential.value, provesAbsence: args.includes('--provider-proves-absence'),
    timeoutMs: num(args, '--provider-timeout-ms', 10_000), redactor,
  });
  const engine = CloudEngine.open({
    dataDir, provider: adapter, redactor, operatorTokenSha256, failpoints, logToStderr: true,
    retentionDays: num(args, '--retention-days', 30), pollIntervalMs: num(args, '--poll-ms', 10_000),
  });
  const http = new CloudHttpServer(engine, redactor);
  const url = await http.start(num(args, '--port', 0));
  engine.startTicker(num(args, '--tick-ms', 2000));
  engine.logLine(`listening on ${url}; agency credential from the ${credential.source}${failpoints.armed ? '; a TEST crash hook is armed' : ''}`);
  process.stdout.write(`${JSON.stringify({ listening: url, provider: adapter.info.name, simulated: adapter.info.simulated })}\n`);

  const stop = (): void => {
    void http.close().finally(() => { engine.close(); process.exit(0); });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((e: unknown) => {
  const words = e instanceof CredentialError || e instanceof DataFolderError ? e.message : 'The backend could not start (an internal error).';
  process.stderr.write(`${words}\n`);
  process.exit(2);
});
