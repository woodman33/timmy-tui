// R6 (H140): a Timmy process with one NEEDS YOU box waiting, kept as src/repl/approvals.ts keeps its boxes (the SharedWaiting
// map), so a test can count it from another process, then kill it. FAKE: the box (no model asked for it; nothing runs). It
// works in the folder it is started in (its project), prints one line {pid}, and waits until it is killed or told to answer
// (a line on stdin answers the box: the map deletes it, as an answered box is deleted).
import { SharedWaiting, type SharedBox } from '../../src/ops/waiting-record.js';

const waiting = new SharedWaiting<number, SharedBox>();
waiting.set(1, { tool: process.env.H140_TOOL ?? 'FAKE_tool', reason: 'FAKE: a test box', summary: 'FAKE box (no model asked)', session: true, since: Date.now(), shown: true });
process.stdout.write(`${JSON.stringify({ pid: process.pid })}\n`);
process.stdin.setEncoding('utf8').on('data', () => { waiting.delete(1); process.stdout.write('answered\n'); });
setInterval(() => { /* waits until it is killed */ }, 60_000);
