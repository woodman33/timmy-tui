/**
 * Round R4 (helper H46, ledger row 153): a typed command whose awaited chain holds nothing of Node's event loop.
 *
 * On the operator's Mac, `/recover` killed the REPL: Node exited with code 13 ("Warning: Detected unsettled top-level
 * await at …/src/cli.ts") and nothing was written. While a typed command runs the REPL's input is paused, so nothing of
 * the REPL holds the loop, and recovery's short wait for a stale job record (src/repl/recover.ts) was a timer that did
 * not hold it either (unref'd). The same held for /iterate tray's status polling during its build step and for the
 * bounded waits ("within") /stop and the REPL's end race against a flow's record.
 *
 * Each case runs a real Workspace in a child process (tests/fixtures/repl-await-fixture.ts, run with tsx as the other
 * child-process tests are) with its stdin read and then paused, awaiting the command at its top level. It must print its
 * DONE line and exit 0. Before the fix each one exited 13 with Node's warning, before DONE.
 *
 * SYNTHETIC state, labelled where it is written: a flow's state file (its agent step) and a job record left running by a
 * session whose process is gone. FAKE pieces: the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE); the
 * recipe runs a SYNTHETIC fixture executor held after its start (tests/recover.test.ts's), so it never ends by itself; the
 * readback is tests/fixtures/fake-step-readback.mjs (never reached); TIMMY_CADQUERY_PYTHON names a FAKE file never run.
 * The /stop case pauses the recipe's supervisor (SIGSTOP) while the flow polls, and resumes it (SIGCONT) from a timer that
 * does not hold the loop, so the polling alone keeps the process alive meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPORTS } from '../src/recipes/index.js';
import { jobDirectory } from '../lanes/recipes/jobs.js';

const FIXTURE = path.resolve('tests/fixtures/repl-await-fixture.ts');
const FAKE_AGENT = path.resolve('tests/fixtures/fake-code-agent.mjs');
const FAKE_READBACK = path.resolve('tests/fixtures/fake-step-readback.mjs');

let root: string;
let fixtures: string;
let jobsDir: string;
const release = (name: string): void => fs.writeFileSync(path.join(fixtures, `release-${name}`), 'released by the test\n');
/** The live processes whose command line names this test's project or fixtures (read from the process table). */
const ours = (): Array<{ pid: number; args: string }> => String(spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m && (m[2].includes(root) || m[2].includes(fixtures)))
  .map((m) => ({ pid: Number(m[1]), args: m[2] }));
async function until(what: string, pred: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
}

/** Runs the fixture in `mode` and resolves with its exit code, its DONE value (if it printed one) and its stderr. */
function run(mode: string, extra: Record<string, unknown> = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null; done?: Record<string, unknown>; out: string; err: string }> {
  const config = path.join(fixtures, `${mode}.json`);
  fs.writeFileSync(config, JSON.stringify({ mode, root, jobsDir, ...extra }));
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, config], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TIMMY_HOME: path.join(fixtures, 'home') } });
  let out = '';
  let err = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  child.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const m = out.match(/^DONE (.*)$/m);
      resolve({ code, signal, ...(m ? { done: JSON.parse(m[1]) as Record<string, unknown> } : {}), out, err });
    });
  });
}

/** The SYNTHETIC fixture executor of tests/recover.test.ts ('complete'), held after its start until release-<uuid> exists. */
function heldExecutor(): string {
  const file = path.join(fixtures, 'fake-recipe-held.mts');
  const module = (name: string) => JSON.stringify(pathToFileURL(path.resolve(name)).href);
  fs.writeFileSync(file, `
// FAKE recipe executor (test fixture): SYNTHETIC files only; no CadQuery, no Open3D, no Python. Held after its start until the test releases it.
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${module('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${module('src/utils/receipts.ts')};
import {sha,prediction,validate} from ${module('lanes/recipes/tray.ts')};
const [,root,id]=process.argv.slice(2), job=loadJob(root,id), dir=jobDirectory(root,id), workspace=path.join(dir,'workspace');
fs.appendFileSync(path.join(dir,'executions.txt'),'fake execution\\n');
const release=${JSON.stringify(fixtures)}+'/release-'+id, until=Date.now()+120000;
while(!fs.existsSync(release)&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
const p=validate(job.request), pred=prediction(p);
const run=randomUUID(), base=path.join(workspace,'.timmy','recipe-runs',run);fs.mkdirSync(base,{recursive:true});
fs.writeFileSync(path.join(base,'request.json'),JSON.stringify(job.request));
fs.writeFileSync(path.join(base,'prediction.json'),JSON.stringify(pred,null,2)+'\\n');
fs.writeFileSync(path.join(base,'build.py'),'SYNTHETIC fixture source; not the recipe');
const common={subject:'SYNTHETIC recipe fixture; no geometry claim',policy:'auto',cost_usd:0};
const prediction_=appendReceipt('runs',{...common,status:'ok',kind:'recipe.prediction',sources:['request.json','prediction.json','build.py'].map(n=>({path:path.join(base,n),sha256:sha(fs.readFileSync(path.join(base,n)))}))},workspace);
const native=path.join(base,'native');fs.mkdirSync(native);
const exports=${JSON.stringify(EXPORTS)}.map(f=>{fs.writeFileSync(path.join(native,f),'SYNTHETIC '+f+'; not geometry');return {file:f,sha256:sha(fs.readFileSync(path.join(native,f)))};});
const result={schema:'timmy.tray-build/1',engine:'SYNTHETIC fixture',synthetic:true,variant:{measured:{bounds:pred.bounds,volume:pred.volumeMm3},mesh:{engine:'SYNTHETIC mesh fixture'},checks:[]}};
fs.writeFileSync(path.join(native,'result.json'),JSON.stringify(result));
const receipt=appendReceipt('runs',{...common,status:'ok',kind:'recipe.build',child_receipts:[prediction_.id],sources:[]},workspace);
const report={state:'succeeded',run,parameters:p,predictionReceipt:prediction_.id,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:0,exports};
fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\\n');
recordResult(root,id,{...report,directory:base});
`);
  return file;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repl-await-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repl-await-fixtures-')));
  jobsDir = path.join(fixtures, 'jobs');
});
afterEach(async () => {
  try { for (const id of fs.readdirSync(path.join(root, '.timmy', 'recipe-jobs'))) release(id); } catch { /* none */ }
  // A fixture that died while a supervisor was paused (SIGSTOP) leaves it paused: resume it, so it can end.
  for (const p of ours()) { try { process.kill(p.pid, 'SIGCONT'); } catch { /* gone */ } }
  try { await until('the test\'s processes to end', () => ours().length === 0); } catch { for (const p of ours()) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60_000);

/** The exit Node gives a top-level await left unsettled once nothing holds the loop. */
const unsettled = (r: { code: number | null; err: string }): string => `exit ${r.code}${/unsettled top-level await/.test(r.err) ? ' (unsettled top-level await)' : ''}: ${r.err.slice(0, 400)}`;

describe('a typed command awaited while the REPL\'s input is paused: Node does not exit under it (R4 H46, row 153)', () => {
  it('/recover with a flow whose step\'s job record is stale: it waits its settle time, writes the record, and returns', async () => {
    // SYNTHETIC: a job record left running by a session whose process is gone (its pid is a process that has exited).
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, 'j0dead1.json'), JSON.stringify({
      id: 'j0dead1', kind: 'task', label: 'agent qwen a0123abcd: make it 160 mm wide', project: 'demo', root, command: FAKE_AGENT, args: ['-p', 'make it 160 mm wide'],
      state: 'running', pid: gone, startedAt: new Date(Date.now() - 60_000).toISOString(), steps: [], lines: 0,
    }));
    // SYNTHETIC: the flow's state file as /iterate writes it while its agent runs (src/repl/iterate.ts saveState).
    const flowDir = path.join(root, '.timmy', 'flows', 'f0000aaaa');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, 'state.json'), `${JSON.stringify({
      flow: 1, schema: 'timmy.flow/1', id: 'f0000aaaa', kind: 'iterate', recipe: 'enclosure.tray/1', instruction: 'make it 160 mm wide', project: 'demo',
      started_at: new Date().toISOString(), outcome: 'running',
      parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: 'a'.repeat(64), values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } } },
      agent: { run: 'a0123abcd', agent: 'qwen', version: null, route: 'local endpoint, no charge', where: '127.0.0.1:11434', model: 'qwen3:4b', job: 'j0dead1', result: '.timmy/agents/a0123abcd/result.json', progress: '.timmy/agents/a0123abcd/progress.log' },
      receipts: {}, child_receipts: [], step: 'agent',
    }, null, 2)}\n`);
    const r = await run('recover');
    expect(r.code, unsettled(r)).toBe(0);
    expect(r.err).not.toContain('unsettled top-level await');
    expect(String(r.done?.said)).toContain('1 flow was interrupted: f0000aaaa (record written)');
    expect(fs.existsSync(path.join(root, 'results', 'flows', 'f0000aaaa.json'))).toBe(true);
  }, 60_000);

  it('/stop <flow> while /iterate tray polls its recipe in the build step (its watcher ended first): the flow ends cancelled and /stop returns', async () => {
    const fakePython = path.join(fixtures, 'fake-python');
    fs.writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
    const r = await run('stop-build', { executor: heldExecutor(), fakePython, agent: FAKE_AGENT, readback: FAKE_READBACK });
    expect(r.code, unsettled(r)).toBe(0);
    expect(r.err).not.toContain('unsettled top-level await');
    const flow = String(r.done?.flow);
    expect(String(r.done?.said)).toContain(`${flow} cancelled`);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${flow}.json`), 'utf8'));
    expect(record).toMatchObject({ outcome: 'cancelled', ended_in: 'build', rebuild: { state: 'cancelled' } });
    // The recipe ended through its own cancel path, never by its release: it ran once and was not replayed.
    const uuid = String(record.rebuild.operation);
    expect(fs.readFileSync(path.join(jobDirectory(root, uuid), 'executions.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 180_000);

  it('the bounded wait itself (src/repl/iterate-native.ts within) gives up after its time when nothing else holds the loop', async () => {
    const r = await run('within');
    expect(r.code, unsettled(r)).toBe(0);
    expect(r.done).toMatchObject({ got: null });
    expect(Number(r.done?.waited)).toBeGreaterThanOrEqual(250);
  }, 60_000);
});
