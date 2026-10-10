/**
 * A REPL's typed command awaited alone, for tests/repl-await.test.ts (a labelled TEST FIXTURE; nobody runs it as a REPL).
 *
 * While a typed command runs, the REPL's input is paused (src/repl/input.ts pauses stdin once a prompt is submitted), so
 * nothing of the REPL holds Node's event loop: what the command awaits must hold it. src/cli.ts awaits the REPL at its
 * top level, so a command whose awaited chain holds nothing makes Node exit at once with code 13 ("Warning: Detected
 * unsettled top-level await"), the command unfinished (round R4, ledger row 153: /recover on the Mac). This process does
 * what the REPL does around such a command: a real Workspace on the test's project and jobs folder, its stdin read and
 * then paused, the command awaited at the top level. Once the command returns it prints `DONE <json>` and exits 0.
 *
 * Modes (config.mode):
 *   recover     `/recover` (Workspace.recover) on a project the test prepared (a flow whose step's job record is stale)
 *   stop-build  `/iterate tray` with the FAKE code agent and the test's held SYNTHETIC recipe executor; once the flow is in
 *               its build step, the recipe's supervisor is paused (SIGSTOP, so it cannot act on a cancel yet) and the
 *               watcher job's process group is killed (SIGKILL: the watcher ended, its recipe did not; the Workspace asks
 *               the recipe's cancel, as it does for a watcher ended by a signal). The flow then polls the recipe's status.
 *               `/stop <flow>` is awaited; a timer that does not hold the loop resumes the supervisor (SIGCONT) 800 ms
 *               later, so the recipe ends cancelled and the flow writes its record
 *   within      the exported `within` of src/repl/iterate-native.ts, awaited on a promise that never settles
 *
 *   node --import tsx tests/fixtures/repl-await-fixture.ts <config.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from '../../src/repl/workspace.js';
import { within } from '../../src/repl/iterate-native.js';
import { folderProject } from '../../src/project/index.js';
import { glyphSet } from '../../src/term/glyphs.js';
import { jobDirectory } from '../../lanes/recipes/jobs.js';

interface Config { mode: 'recover' | 'stop-build' | 'within'; root: string; jobsDir: string; executor?: string; fakePython?: string; agent?: string; readback?: string }
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Config;
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
/** The fixture's own waits hold the loop (a plain timer): only the awaited command must stand alone. */
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await pause(50); }
}
const done = (value: unknown): never => { process.stdout.write(`DONE ${JSON.stringify(value)}\n`); process.exit(0); };

const notes: string[] = [];
const sealed: unknown[] = [];
/** The recipe supervisors this session starts (the jobs.ts observer seam): their pids, to pause and resume one. */
const supervisors: number[] = [];
const ws = new Workspace({
  glyphs: glyphSet(true),
  // FAKE: the code agent (a TEST DOUBLE) on a local endpoint; a Python path that is never executed.
  env: { ...(cfg.agent ? { TIMMY_AGENT_QWEN_BIN: cfg.agent, TIMMY_AGENT_MODEL: 'qwen3:4b' } : {}), ...(cfg.fakePython ? { TIMMY_CADQUERY_PYTHON: cfg.fakePython } : {}) },
  onPath: () => null,
  notify: (l) => { notes.push(l.map((s) => s.text).join('')); },
  openWeb: (u) => u,
  link: (t) => t,
  seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
  jobsDir: cfg.jobsDir,
  chdir: () => {},
  receipts: () => [],
  // The REPL's own start pass is not this test's: /recover is the command awaited.
  recoverAtStart: false,
  ...(cfg.executor ? { recipeTest: { executor: cfg.executor, pollMs: 100, onSupervisor: (child: { pid?: number }) => { if (child.pid) supervisors.push(child.pid); } } } : {}),
  ...(cfg.readback ? { iterateTest: { readback: (step: { abs: string; rel: string }) => ({ command: process.execPath, args: [cfg.readback!, 'match', step.abs, '--as', step.rel] }), settleMs: 15_000 } } : {}),
}, folderProject(cfg.root));

/** What the REPL does once a prompt is submitted: its input is paused while the command runs. */
function pauseInput(): void {
  process.stdin.resume();
  process.stdin.pause();
}

if (cfg.mode === 'recover') {
  pauseInput();
  const said = text(await ws.recover(''));
  done({ said, sealed: sealed.length });
}

if (cfg.mode === 'within') {
  pauseInput();
  const t0 = Date.now();
  const got = await within(new Promise<string>(() => { /* never settles */ }), 300);
  done({ got: got ?? null, waited: Date.now() - t0 });
}

if (cfg.mode === 'stop-build') {
  const started = text(await ws.iterate('tray "make it 180 mm wide PARAM:width=180"'));
  const id = started.match(/Flow\s+(f[0-9a-f]{8})/)?.[1];
  if (!id) throw new Error(`no flow started: ${started}`);
  const stateFile = path.join(cfg.root, '.timmy', 'flows', id, 'state.json');
  let state: { step?: string; rebuild?: { operation?: string; job?: string } } = {};
  await until('the flow to reach its build step', () => {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return false; }
    const uuid = state.rebuild?.operation;
    const job = state.rebuild?.job;
    return state.step === 'build' && !!uuid && !!job && fs.existsSync(path.join(jobDirectory(cfg.root, uuid), 'executions.txt')) && !!ws.jobs.get(job)?.pid;
  });
  // The supervisor (its own process group) is paused first, so the cancel the watcher's end asks waits for it.
  const supervisor = supervisors.at(-1);
  if (!supervisor) throw new Error('no recipe supervisor was observed');
  process.kill(-supervisor, 'SIGSTOP');
  // The watcher ends while its recipe still runs (held): the flow then polls the recipe's status until it ends.
  const watcher = ws.jobs.get(state.rebuild!.job!)!;
  process.kill(-watcher.pid!, 'SIGKILL');
  await until('the watcher job to end', () => ['completed', 'failed', 'cancelled'].includes(ws.jobs.get(watcher.id)?.state ?? ''));
  await pause(300);
  // Resumed later by a timer that does not hold the loop: only what /stop awaits may keep this process alive meanwhile.
  setTimeout(() => { try { process.kill(-supervisor, 'SIGCONT'); } catch { /* gone */ } }, 800).unref();
  pauseInput();
  const said = text(await ws.stop(id));
  done({ said, flow: id });
}
