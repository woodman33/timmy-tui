/**
 * A REPL session that stops following a /run, then crashes (round R4, H99, the review), for tests/no-change-recover.test.ts:
 * a labelled TEST FIXTURE; nobody runs it as a REPL. It builds a real Workspace on the test's project, in the environment the
 * test gives it (the sandbox of tests/helpers/ops-sandbox.ts: the real `timmy` CLI on PATH, the FAKE code agent and
 * OpenSCAD), with upmd the TEST DOUBLE tests/fixtures/fake-upmd.mjs (UPMD_BIN; it is not upmd) and this machine's python3
 * for the pty wrapper. It runs `/run <doc> <block>` in an operation of its own, as the REPL runs a typed line, waits until
 * the job's record shows `<running>` running, prints what it started as one line (READY {...}) and waits for the signals
 * the test sends (SIGSTOP, then SIGKILL). Workspace.close never runs: what a crash leaves. It seals on the project's own
 * chain, as the REPL in the test does (two REPLs of one Timmy share runs.jsonl).
 *
 *   node --import tsx tests/fixtures/no-change-crash-fixture.ts <config.json>
 */
import fs from 'node:fs';
import { folderProject } from '../../src/project/index.js';
import { Workspace } from '../../src/repl/workspace.js';
import { glyphSet } from '../../src/term/glyphs.js';
import { appendReceipt, readChain } from '../../src/utils/receipts.js';

interface Config { root: string; jobsDir: string; upmd: string; python3: string; doc: string; block: string; running: string }
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Config;
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ws = new Workspace({
  glyphs: glyphSet(true),
  env: { ...process.env, UPMD_BIN: cfg.upmd },
  onPath: (cmd) => (cmd === 'python3' ? cfg.python3 : null),
  notify: () => {},
  openWeb: (u) => u,
  link: (t) => t,
  seal: (input) => appendReceipt('runs', input, cfg.root).hash.slice(7, 15),
  receipts: () => readChain('runs', cfg.root),
  jobsDir: cfg.jobsDir,
  chdir: () => {},
  recoverAtStart: false,
  roomTools: async () => [],
}, folderProject(cfg.root));

try {
  const said = text(await ws.operate(`/run ${cfg.doc} ${cfg.block}`, 'repl', () => ws.run(`${cfg.doc} ${cfg.block}`)));
  const job = /Running\s+(j[0-9a-f]{6})/.exec(said)?.[1];
  const op = /Operation\s+(o[0-9a-f]{8})/.exec(said)?.[1];
  if (!job || !op) throw new Error(`no run started in an operation: ${said}`);
  const end = Date.now() + 60_000;
  while (!ws.jobs.get(job)?.steps.some((s) => s.name === cfg.running && s.state === 'running')) {
    if (Date.now() > end) throw new Error(`${cfg.running} did not start: ${JSON.stringify(ws.jobs.get(job))}`);
    await sleep(25);
  }
  process.stdout.write(`READY ${JSON.stringify({ job, op, pid: ws.jobs.get(job)!.pid })}\n`);
} catch (e) {
  process.stdout.write(`FAILED ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
// The stop and the crash come from outside (SIGSTOP, then SIGKILL): this session never ends by itself.
setInterval(() => {}, 1 << 30);
