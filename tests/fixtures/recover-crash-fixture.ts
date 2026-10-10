/**
 * A REPL session that crashes, for tests/recover.test.ts (a labelled TEST FIXTURE; nobody runs it as a REPL). It builds a
 * real Workspace on the test's project and jobs folder with the test's FAKE pieces (the SYNTHETIC recipe executor held
 * until the test releases it, the FAKE code agent, the FAKE readback, a held FAKE Blender named by TIMMY_BLENDER), runs
 * /recipe tray, /iterate tray and /blender as its config asks (R4, H46: also /iterate tray held in its agent step, for
 * tests/recover-orphan.test.ts), waits until each is under way, prints what it started as
 * one line (READY {...}) and then waits for the SIGKILL the test sends. Workspace.close and killNow never run, so the
 * recipe's own cancel is never asked: what a crash leaves.
 *
 *   node --import tsx tests/fixtures/recover-crash-fixture.ts <config.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from '../../src/repl/workspace.js';
import { folderProject } from '../../src/project/index.js';
import { glyphSet } from '../../src/term/glyphs.js';
import { jobDirectory } from '../../lanes/recipes/jobs.js';

/**
 * R4 (H46): the `agent` step runs `/iterate tray` with the test's agent (cfg.agent, a TEST DOUBLE that waits until it is
 * stopped) and the words `agentWords` added to its instruction, and is ready once that agent wrote cfg.agentStarted.
 */
interface Config { root: string; jobsDir: string; executor: string; fakePython: string; agent: string; readback: string; seals: string; nativeStarted: string; steps: Array<'recipe' | 'iterate' | 'blender' | 'agent'>; agentStarted?: string; agentWords?: string }
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Config;
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
const executed = (uuid: string): boolean => fs.existsSync(path.join(jobDirectory(cfg.root, uuid), 'executions.txt'));

let sealed = 0;
const ws = new Workspace({
  glyphs: glyphSet(true),
  // FAKE: the code agent (a TEST DOUBLE) on a local endpoint; a Python path that is never executed.
  env: { TIMMY_AGENT_QWEN_BIN: cfg.agent, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: cfg.fakePython },
  onPath: () => null,
  notify: () => {},
  openWeb: (u) => u,
  link: (t) => t,
  // What this session seals is kept in a file the test can read; its ids are labelled as the crashed session's.
  seal: (input) => { fs.appendFileSync(cfg.seals, `${JSON.stringify(input)}\n`); sealed += 1; return `crashed${sealed}`; },
  jobsDir: cfg.jobsDir,
  chdir: () => {},
  receipts: () => [],
  recipeTest: { executor: cfg.executor, pollMs: 100 },
  iterateTest: { readback: (step) => ({ command: process.execPath, args: [cfg.readback, 'match', step.abs, '--as', step.rel] }), settleMs: 15_000 },
}, folderProject(cfg.root));

const out: Record<string, unknown> = {};
try {
  for (const step of cfg.steps) {
    if (step === 'recipe') {
      const said = text(await ws.recipe('tray'));
      const uuid = said.match(/Recipe job\s+([0-9a-f-]{36})/)?.[1];
      const watcher = said.match(/Running\s+(j[0-9a-f]{6})/)?.[1];
      if (!uuid || !watcher) throw new Error(`no recipe started: ${said}`);
      await until('the recipe to start', () => executed(uuid) && !!ws.jobs.get(watcher)?.pid);
      out.recipe = { uuid, watcher, watcherPid: ws.jobs.get(watcher)!.pid };
    } else if (step === 'iterate') {
      const said = text(await ws.iterate('tray "make it 180 mm wide PARAM:width=180"'));
      const id = said.match(/Flow\s+(f[0-9a-f]{8})/)?.[1];
      if (!id) throw new Error(`no flow started: ${said}`);
      const file = path.join(cfg.root, '.timmy', 'flows', id, 'state.json');
      let state: { step?: string; rebuild?: { operation?: string; job?: string }; agent?: { job?: string } } = {};
      await until('the flow to reach its build step', () => {
        try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
        const uuid = state.rebuild?.operation;
        const job = state.rebuild?.job;
        return state.step === 'build' && !!uuid && !!job && executed(uuid) && !!ws.jobs.get(job)?.pid;
      });
      out.flow = { id, uuid: state.rebuild!.operation, watcher: state.rebuild!.job, watcherPid: ws.jobs.get(state.rebuild!.job!)!.pid, agentJob: state.agent?.job };
    } else if (step === 'blender') {
      const said = text(await ws.blender('scene.py'));
      const job = said.match(/Running\s+(j[0-9a-f]{6})/)?.[1];
      if (!job) throw new Error(`no Blender run started: ${said}`);
      await until('the held FAKE Blender to start', () => fs.existsSync(cfg.nativeStarted));
      const runs = path.join(cfg.root, '.timmy', 'native');
      const run = fs.readdirSync(runs).find((r) => {
        try { return JSON.parse(fs.readFileSync(path.join(runs, r, 'started.json'), 'utf8')).job === job; } catch { return false; }
      });
      if (!run) throw new Error('no run folder names the Blender job');
      out.native = { job, run };
    } else if (step === 'agent') {
      const said = text(await ws.iterate(`tray "make it 180 mm wide${cfg.agentWords ? ` ${cfg.agentWords}` : ''}"`));
      const id = said.match(/Flow\s+(f[0-9a-f]{8})/)?.[1];
      const job = said.match(/Agent\s+(j[0-9a-f]{6})/)?.[1];
      if (!id || !job) throw new Error(`no flow started: ${said}`);
      await until('the agent to start', () => !!cfg.agentStarted && fs.existsSync(cfg.agentStarted) && !!ws.jobs.get(job)?.pid);
      out.agent = { flow: id, job, pid: ws.jobs.get(job)!.pid, started: JSON.parse(fs.readFileSync(cfg.agentStarted!, 'utf8')) };
    }
  }
  process.stdout.write(`READY ${JSON.stringify(out)}\n`);
} catch (e) {
  process.stdout.write(`FAILED ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
// The crash comes from outside (SIGKILL): this session never ends by itself.
setInterval(() => {}, 1 << 30);
