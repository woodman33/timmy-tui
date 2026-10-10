/**
 * A REPL session that crashes during a /run (round R4, H58), for tests/workflow-recover.test.ts: a labelled TEST FIXTURE;
 * nobody runs it as a REPL. It builds a real Workspace on the test's project and jobs folder, with upmd the TEST DOUBLE
 * tests/fixtures/fake-upmd.mjs (UPMD_BIN; it is not upmd) and this machine's python3 for the pty wrapper, runs
 * `/run <doc> <block>`, waits until the job's record shows `<running>` running, prints what it started as one line
 * (READY {...}) and waits for the SIGKILL the test sends. Workspace.close never runs: what a crash leaves.
 *
 *   node --import tsx tests/fixtures/workflow-crash-fixture.ts <config.json>
 */
import fs from 'node:fs';
import { folderProject } from '../../src/project/index.js';
import { Workspace } from '../../src/repl/workspace.js';
import { glyphSet } from '../../src/term/glyphs.js';

interface Config { root: string; jobsDir: string; upmd: string; python3: string | null; doc: string; block: string; running: string; seals: string }
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Config;
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let sealed = 0;
const ws = new Workspace({
  glyphs: glyphSet(true),
  env: { UPMD_BIN: cfg.upmd },
  onPath: (cmd) => (cmd === 'python3' ? cfg.python3 : null),
  notify: () => {},
  openWeb: (u) => u,
  link: (t) => t,
  // What this session seals is kept in a file the test can read; its ids are labelled as the crashed session's.
  seal: (input) => { fs.appendFileSync(cfg.seals, `${JSON.stringify(input)}\n`); sealed += 1; return `crashed${sealed}`; },
  jobsDir: cfg.jobsDir,
  chdir: () => {},
  receipts: () => [],
  recoverAtStart: false,
}, folderProject(cfg.root));

try {
  const said = text(await ws.run(`${cfg.doc} ${cfg.block}`));
  const job = said.match(/Running\s+(j[0-9a-f]{6})/)?.[1];
  if (!job) throw new Error(`no run started: ${said}`);
  const end = Date.now() + 60_000;
  while (!ws.jobs.get(job)?.steps.some((s) => s.name === cfg.running && s.state === 'running')) {
    if (Date.now() > end) throw new Error(`${cfg.running} did not start: ${JSON.stringify(ws.jobs.get(job))}`);
    await sleep(25);
  }
  process.stdout.write(`READY ${JSON.stringify({ job, pid: ws.jobs.get(job)!.pid, said })}\n`);
} catch (e) {
  process.stdout.write(`FAILED ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
// The crash comes from outside (SIGKILL): this session never ends by itself.
setInterval(() => {}, 1 << 30);
