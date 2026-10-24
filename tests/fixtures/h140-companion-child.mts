// R6 (H140): a real browser companion (src/companion/server.ts) in a process of its own, so a test can kill it with SIGKILL, as
// the R5 interaction review saw the Workbench that served one end without its stop being noted. It listens at
// TIMMY_COMPANION_PORT (the address the frame names), prints one line {port, url, pid} (its url carries its token: the test
// keeps it in memory and never writes it out), and serves until it is killed. Nothing in it is FAKE; its home and project are
// the test's own folders (TIMMY_HOME, TIMMY_REPO).
import { startCompanionServer } from '../../src/companion/server.js';

const port = Number(process.env.TIMMY_COMPANION_PORT);
const s = await startCompanionServer(port, { workspace: { env: process.env } });
process.stdout.write(`${JSON.stringify({ port: s.port, url: s.url, pid: process.pid })}\n`);
setInterval(() => { /* serves until it is killed */ }, 60_000);
