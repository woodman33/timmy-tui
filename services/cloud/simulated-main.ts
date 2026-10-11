/**
 * The SIMULATED provider as a process of its own, for a person trying the backend by hand (and for its two-process test).
 *
 *   TIMMY_CLOUD_AGENCY_TOKEN=<a made-up credential> node --import tsx services/cloud/simulated-main.ts [--port <n>] [--proves-absence]
 *
 * It listens on 127.0.0.1 only and holds everything in memory: nothing real is bought, registered, set up, deployed or
 * deleted, and no network service is contacted. It accepts the same made-up credential the backend is started with
 * (never a real one: it is a stand-in, and it prints nothing but its address). It prints one JSON line once it listens:
 * {"listening": "http://127.0.0.1:<port>", "simulated": true}.
 */
import { SimulatedProvider } from './simulated-provider.js';

const args = process.argv.slice(2);
const credential = process.env.TIMMY_CLOUD_AGENCY_TOKEN ?? '';
delete process.env.TIMMY_CLOUD_AGENCY_TOKEN;
if (!/^[\x21\x23-\x5B\x5D-\x7E]{16,1024}$/.test(credential)) {
  process.stderr.write('Set TIMMY_CLOUD_AGENCY_TOKEN to a made-up credential (16 or more printable characters): the simulated provider accepts only that one. Nothing was started.\n');
  process.exit(2);
}
const i = args.indexOf('--port');
const port = i >= 0 ? Number(args[i + 1]) : 0;
const sim = new SimulatedProvider({ credential, provesAbsence: args.includes('--proves-absence') });
sim.start(Number.isSafeInteger(port) && port >= 0 ? port : 0).then((url) => {
  process.stdout.write(`${JSON.stringify({ listening: url, simulated: true })}\n`);
  const stop = (): void => { void sim.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('The simulated provider could not listen on that port. Nothing was started.\n'); process.exit(2); });
