/**
 * Round R4 (helper H32): a new REPL session picks up what the last one left running (src/repl/recover.ts).
 *
 * The crash is real: a REPL session runs as its own process (tests/fixtures/recover-crash-fixture.ts, a real Workspace
 * on the test's project and jobs folder) and is killed with SIGKILL, never closed, so the recipe's own cancel is never
 * asked; its recipe watchers are killed with it. A new Workspace on the same project and the same jobs folder must then
 * follow the recipe that still runs with a new watcher (which delivers when it ends), deliver the recipe that finished
 * while no watcher was there, write and seal the record of the flow interrupted during its build, and judge the native
 * run from its result file. Nothing runs twice, and a later start finds nothing left.
 *
 * FAKE pieces, each labelled: the recipe runs a SYNTHETIC fixture executor through the jobs.ts seam (the 'complete' mode
 * of tests/recipe-repl.test.ts fakeExecutor) held after its start until the test writes its release file; the code agent
 * is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE); the readback is tests/fixtures/fake-step-readback.mjs (never
 * reached here); Blender is tests/fixtures/fake-blender.mjs behind a held wrapper; TIMMY_CADQUERY_PYTHON names a FAKE file
 * that is never executed. Two tests write SYNTHETIC durable state by hand (a flow's state file; a recipe's claim and a
 * crashed session's watcher record), each labelled where it is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { COMMANDS } from '../src/repl/commands.js';
import { FLOW_QUIET_MS } from '../src/repl/recover.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { JobManager } from '../src/jobs/index.js';
import { jobDirectory, status } from '../lanes/recipes/jobs.js';
import { deliver, DOCTRINE_15, EXPORTS, launchRecipe, prepareRecipe, watcherSpec } from '../src/recipes/index.js';
import { readNativeRecord } from '../src/native/index.js';

const FIXTURE = path.resolve('tests/fixtures/recover-crash-fixture.ts');
const FAKE_AGENT = path.resolve('tests/fixtures/fake-code-agent.mjs');
const FAKE_READBACK = path.resolve('tests/fixtures/fake-step-readback.mjs');
const FAKE_BLENDER = path.resolve('tests/fixtures/fake-blender.mjs');
const PARAMS = 'recipes/tray.params.json';
const INSTRUCTION = 'make it 180 mm wide PARAM:width=180';
/** What a delivery copies into out/recipes/<uuid8>/: the five exports and three records. */
const COPIED = [...EXPORTS, 'prediction.json', 'report.json', 'request.json'].sort();

let root: string;
let fixtures: string;
let fakePython: string;
let jobsDir: string;
const spaces: Workspace[] = [];
const children: ChildProcess[] = [];
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
/** Lines of a file, or none. */
const lines = (file: string): string[] => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
/** The live processes whose command line names this test's project or fixtures (read from the process table, never a PID file). */
const ours = (): Array<{ pid: number; args: string }> => String(spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m && (m[2].includes(root) || m[2].includes(fixtures)))
  .map((m) => ({ pid: Number(m[1]), args: m[2] }));
const release = (name: string): void => fs.writeFileSync(path.join(fixtures, `release-${name}`), 'released by the test\n');
const executions = (uuid: string): string[] => lines(path.join(jobDirectory(root, uuid), 'executions.txt'));
const noAbsolute = (s: string): void => { for (const p of new Set([root, fixtures, os.tmpdir()])) expect(s).not.toContain(p); };

/** The SYNTHETIC fixture executor of tests/recipe-repl.test.ts ('complete'), held after its start until release-<uuid> exists. */
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
const labels=[...Array.from({length:12},(_,i)=>'Stage check '+(i+1)),'Native bounds','Native analytic volume','Native valid single solid','STEP reimport bounds','STEP reimport analytic volume','STEP reimport valid single solid','STL closed, manifold, orientable','STL one component, no self intersections','STL volume agrees within 0.1%','Every construction stage validated',...Array.from({length:8},(_,i)=>'axis '+(i+1))];
const result={schema:'timmy.tray-build/1',engine:'SYNTHETIC fixture',synthetic:true,variant:{measured:{bounds:pred.bounds,volume:pred.volumeMm3},mesh:{engine:'SYNTHETIC mesh fixture'},checks:labels.map((label,i)=>({id:'geometry.'+String(i+1).padStart(2,'0'),label,passed:true}))}};
fs.writeFileSync(path.join(native,'result.json'),JSON.stringify(result));
fs.writeFileSync(path.join(base,'native.log'),'SYNTHETIC native log');
const sources=[path.join(native,'result.json'),path.join(base,'native.log'),...exports.map(e=>path.join(native,e.file))].map(f=>({path:f,sha256:sha(fs.readFileSync(f))}));
const receipt=appendReceipt('runs',{...common,status:'ok',kind:'recipe.build',child_receipts:[prediction_.id],sources},workspace);
const report={state:'succeeded',run,parameters:p,predictionReceipt:prediction_.id,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:30,exports};
fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\\n');
recordResult(root,id,{...report,directory:base});
`);
  return file;
}

/** A held FAKE Blender for TIMMY_BLENDER: notes each start, waits for release-native, then runs fake-blender.mjs (a TEST DOUBLE) with its arguments. */
function heldBlender(): string {
  const mjs = path.join(fixtures, 'held-blender.mjs');
  fs.writeFileSync(mjs, `// HELD FAKE Blender (test fixture): not Blender. Notes its start, waits for the test's release file, then runs the FAKE Blender.
import { spawnSync } from 'node:child_process'; import fs from 'node:fs';
const hold = ${JSON.stringify(path.join(fixtures, 'release-native'))};
fs.appendFileSync(hold + '.runs', 'held fake blender run\\n');
const until = Date.now() + 120000;
while (!fs.existsSync(hold) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
// Its output goes to a file: the session that would have read it may be gone.
const log = fs.openSync(${JSON.stringify(path.join(fixtures, 'held-blender.log'))}, 'a');
const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_BLENDER)}, ...process.argv.slice(2)], { stdio: ['ignore', log, log], env: process.env });
process.exit(r.status ?? 1);
`);
  const bin = path.join(fixtures, 'bin', 'blender');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mjs)} "$@"\n`, { mode: 0o755 });
  return bin;
}

/** A REPL session in this process, on the test's project and jobs folder. */
function make(o: { executor?: string } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: fakePython },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir,
    chdir: () => {},
    receipts: () => sealed as unknown as Receipt[],
    // FAKE: the jobs.ts executor seam when this session starts recipes; a fast watcher poll.
    recipeTest: { pollMs: 100, ...(o.executor ? { executor: o.executor } : {}) },
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

/** Starts a REPL session as its own process, runs `steps` there and resolves with what it started once it is ready. */
async function crashableSession(steps: Array<'recipe' | 'iterate' | 'blender'>): Promise<{ child: ChildProcess; ready: Record<string, any>; seals: string }> {
  const seals = path.join(fixtures, 'crashed-seals.jsonl');
  const config = path.join(fixtures, 'crashed-session.json');
  fs.writeFileSync(config, JSON.stringify({ root, jobsDir, executor: heldExecutor(), fakePython, agent: FAKE_AGENT, readback: FAKE_READBACK, seals, nativeStarted: path.join(fixtures, 'release-native.runs'), steps }));
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, config], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TIMMY_BLENDER: heldBlender(), TIMMY_HOME: path.join(fixtures, 'home') },
  });
  children.push(child);
  let out = '';
  let err = '';
  const ready = await new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the session did not get ready: ${out}${err}`)), 170_000);
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      const m = out.match(/^READY (.*)$/m);
      if (m) { clearTimeout(timer); resolve(JSON.parse(m[1]) as Record<string, any>); } else if (/^FAILED /m.test(out)) { clearTimeout(timer); reject(new Error(`${out}${err}`)); }
    });
    child.stderr!.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`the session ended (${code ?? signal}) before it was ready: ${out}${err}`)); });
  });
  return { child, ready, seals };
}

/** The crash: the session's process is killed with SIGKILL, and its recipe watchers with it (each its own process group). */
async function crash(child: ChildProcess, watchers: Array<{ id: string; pid: number }>): Promise<void> {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await gone;
  for (const w of watchers) { try { process.kill(-w.pid, 'SIGKILL'); } catch { /* already gone */ } }
  // What any later session reads: each watcher's record left running, its process gone (stale).
  const view = new JobManager({ dir: jobsDir });
  await until('the watchers\' records to be stale', () => watchers.every((w) => view.get(w.id)?.stale === true), 30_000);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-project-'));
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-fixtures-'));
  jobsDir = path.join(fixtures, 'jobs');
  fakePython = path.join(fixtures, 'fake-python');
  fs.writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'scene.py'), '# a stand-in scene: the FAKE Blender hashes it and runs nothing\n');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const w of spaces.splice(0)) await w.close();
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  // Every hold is released, so what is left of a crashed session ends by itself; whatever still runs after that is ended.
  try { for (const id of fs.readdirSync(path.join(root, '.timmy', 'recipe-jobs'))) release(id); } catch { /* none */ }
  release('native');
  try { await until('the test\'s processes to end', () => ours().length === 0, 30_000); } catch { for (const p of ours()) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 90_000);

describe('a REPL session that crashed: the next one picks up what it left running', () => {
  it('follows the running recipe again and it delivers, delivers the finished one, records the interrupted flow, judges the native run; once', async () => {
    const { child, ready, seals } = await crashableSession(['recipe', 'iterate', 'blender']);
    const a: string = ready.recipe.uuid;
    const flow: string = ready.flow.id;
    const b: string = ready.flow.uuid;
    const nativeJob: string = ready.native.job;
    const run: string = ready.native.run;
    await crash(child, [{ id: ready.recipe.watcher, pid: ready.recipe.watcherPid }, { id: ready.flow.watcher, pid: ready.flow.watcherPid }]);
    // While no session is there: recipe A and the Blender run finish; the flow's rebuild (recipe B) is still held.
    release(a);
    release('native');
    const view = new JobManager({ dir: jobsDir });
    await until('recipe A to succeed with no watcher', () => status(root, a).state === 'succeeded');
    await until('the Blender run to end with no session', () => view.get(nativeJob)?.stale === true);
    expect(status(root, b)).toMatchObject({ state: 'running' });
    expect(fs.existsSync(path.join(root, 'out', 'recipes', a.slice(0, 8)))).toBe(false);
    expect(readNativeRecord(root, run)?.verdicts).toEqual([]);
    expect(fs.existsSync(path.join(root, 'results', 'flows', `${flow}.json`))).toBe(false);
    const crashedSeals = lines(seals).map((l) => JSON.parse(l) as ReceiptInput);

    // The next session.
    const { ws, notes, sealed } = make();
    const report = (await ws.startRecovery)!;
    const followed = report.items.find((i) => i.did === 'followed');
    expect(followed).toMatchObject({ kind: 'recipe', id: b, state: 'running' });
    const watcher = followed!.job!;
    expect(report.items.map((i) => [i.kind, i.id, i.did]).sort()).toEqual([['flow', flow, 'interrupted'], ['native', run, 'judged'], ['recipe', a, 'delivered'], ['recipe', b, 'followed']].sort());
    // What the start says: one summary line, then each item.
    expect(notes[0]).toContain(`1 recipe job still running: following it as ${watcher}`);
    expect(notes[0]).toContain('1 recipe job finished while no REPL followed it: exports delivered');
    expect(notes[0]).toContain(`1 flow was interrupted: ${flow} (record written)`);
    expect(notes[0]).toContain('1 native run judged from its result file');
    const said = notes.join('\n');
    expect(said).toContain(`recipe ${b} was running (native-build) with no REPL following it: following it as ${watcher}; /jobs ${watcher} shows it, /stop ${watcher} cancels it`);
    expect(said).toContain(`flow ${flow} was interrupted in its build step (its job ${ready.flow.watcher} was left running and its process is gone)`);
    expect(said).toContain(`next: /recipe recover ${b}, or /iterate tray again`);
    expect(said).toMatch(new RegExp(`Blender run ${run.slice(0, 8)} \\(job ${nativeJob}\\) judged ok from its result file`));
    expect(said).toContain(DOCTRINE_15);
    noAbsolute(said);

    // Recipe A: its exports delivered from one verified snapshot, each sha256 the signed result's; sealed as a recover receipt.
    const destA = path.join(root, 'out', 'recipes', a.slice(0, 8));
    expect(fs.readdirSync(destA).sort()).toEqual(COPIED);
    const envelopeA = JSON.parse(fs.readFileSync(path.join(jobDirectory(root, a), 'result.json'), 'utf8'));
    for (const e of envelopeA.result.exports as Array<{ file: string; sha256: string }>) expect(sha(fs.readFileSync(path.join(destA, e.file)))).toBe(e.sha256);
    const recovered = sealed.find((r) => r.kind === 'recover');
    expect(recovered).toMatchObject({ subject: `recover · recipe · enclosure.tray/1 · ${a} · delivered`, status: 'ok', sources: [{ operation: a, action: 'delivered' }] });
    expect(recovered!.outputs!.map((o) => o.path).sort()).toEqual(COPIED.map((f) => `out/recipes/${a.slice(0, 8)}/${f}`).sort());

    // Recipe B: followed again by a watcher of this session, labelled with its UUID.
    expect(ws.jobs.get(watcher)?.label).toContain(`recipe enclosure.tray/1 ${b}`);
    expect(ws.jobs.get(watcher)?.label).toContain('re-attached');

    // The flow: its record, once, as interrupted in its build step, with what to do next; sealed as a flow receipt.
    const recordFile = path.join(root, 'results', 'flows', `${flow}.json`);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(record).toMatchObject({ schema: 'timmy.flow/1', id: flow, outcome: 'interrupted', ended_in: 'build', instruction: INSTRUCTION, rebuild: { operation: b, job: ready.flow.watcher, state: 'running', followed_again: watcher } });
    expect(record).not.toHaveProperty('step');
    expect(record.why).toBe(`the REPL running it ended during its rebuild (its job ${ready.flow.watcher} was left running and its process is gone); recipe job ${b} still runs; nothing was read back; recorded after a restart, and nothing was run again`);
    expect(record.parameters).toMatchObject({ path: PARAMS, after: { values: { width: 180 } } });
    expect(record.recovered.next).toEqual(expect.arrayContaining([
      `recipe job ${b} is followed again as ${watcher}: its exports reach out/recipes/${b.slice(0, 8)}/ once its signed result verifies`,
      `/recipe recover ${b} reads recipe job ${b} again; nothing is rerun`,
      `/iterate tray "${INSTRUCTION}" starts a new flow from ${PARAMS} as it is now`,
    ]));
    const stateFile = path.join(root, '.timmy', 'flows', flow, 'state.json');
    expect(record.recovered.state_file).toEqual({ path: `.timmy/flows/${flow}/state.json`, sha256: sha(fs.readFileSync(stateFile)) });
    expect(record.recovered.job).toEqual({ id: ready.flow.watcher, state: 'running', stale: true });
    // The child receipts are the crashed session's own: its agent run's and its sealed prediction's.
    const agentSeal = crashedSeals.findIndex((r) => r.kind === 'agent');
    const predictSeal = crashedSeals.findIndex((r) => r.kind === 'predict' && String(r.subject).includes(b));
    expect(record.child_receipts).toEqual([`crashed${agentSeal + 1}`, `crashed${predictSeal + 1}`]);
    const flowSeal = sealed.find((r) => r.kind === 'flow');
    expect(flowSeal).toMatchObject({ subject: `flow · iterate · tray · ${flow} · interrupted`, status: 'failed', child_receipts: record.child_receipts });
    expect(flowSeal!.outputs).toEqual([{ path: `results/flows/${flow}.json`, sha256: sha(fs.readFileSync(recordFile)), bytes: fs.statSync(recordFile).size }]);
    // The state file stays as the crashed session wrote it.
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ outcome: 'running', step: 'build' });

    // The Blender run: judged from its result file, the exit not recorded (its session was gone), appended once.
    const verdicts = readNativeRecord(root, run)!.verdicts;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ outcome: 'ok', job: nativeJob, exit: { state: 'unknown', code: null } });

    // Recipe B ends now: the watcher that follows it again delivers its verified exports, and its end is said.
    release(b);
    await until('the re-attached watcher to end', () => ['completed', 'failed', 'cancelled'].includes(ws.jobs.get(watcher)?.state ?? ''));
    expect(ws.jobs.get(watcher)?.state).toBe('completed');
    expect(status(root, b).state).toBe('succeeded');
    const destB = path.join(root, 'out', 'recipes', b.slice(0, 8));
    expect(fs.readdirSync(destB).sort()).toEqual(COPIED);
    const envelopeB = JSON.parse(fs.readFileSync(path.join(jobDirectory(root, b), 'result.json'), 'utf8'));
    for (const e of envelopeB.result.exports as Array<{ file: string; sha256: string }>) expect(sha(fs.readFileSync(path.join(destB, e.file)))).toBe(e.sha256);
    await until('the watcher\'s end notice', () => notes.some((n) => n.includes(`${watcher} Recipe ${b} succeeded`)));

    // Nothing ran twice: each recipe executed once, the Blender run started once, one agent run, and no readback.
    expect(executions(a)).toHaveLength(1);
    expect(executions(b)).toHaveLength(1);
    expect(lines(path.join(fixtures, 'release-native.runs'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, '.timmy', 'agents'))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, '.timmy', 'flows', flow, 'readback.log'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(recordFile, 'utf8'))).toEqual(record);

    // A later start finds nothing left: it prints nothing and seals nothing; /recover says so.
    const later = make();
    const again = (await later.ws.startRecovery)!;
    expect(again.items.filter((i) => i.did !== 'left')).toEqual([]);
    expect(later.notes).toEqual([]);
    expect(text(await later.ws.recover(''))).toContain(`nothing to pick up in ${path.basename(root)}`);
    expect(later.sealed).toEqual([]);
    expect(readNativeRecord(root, run)!.verdicts).toHaveLength(1);
    expect(executions(a)).toHaveLength(1);
    expect(executions(b)).toHaveLength(1);
  }, 300_000);
});

describe('a session that is still running is left alone', () => {
  it('its recipe and its native run: nothing is followed again or judged, and /recover says who follows them', async () => {
    vi.stubEnv('TIMMY_BLENDER', heldBlender());
    const first = make({ executor: heldExecutor() });
    const out = text(await first.ws.recipe('tray'));
    const uuid = out.match(/Recipe job\s+([0-9a-f-]{36})/)![1];
    const watcher = out.match(/Running\s+(j[0-9a-f]{6})/)![1];
    await until('the recipe to start', () => executions(uuid).length === 1 && first.ws.jobs.get(watcher)?.state === 'running');
    const started = text(await first.ws.blender('scene.py'));
    const nativeJob = started.match(/Running\s+(j[0-9a-f]{6})/)![1];
    await until('the held FAKE Blender to start', () => lines(path.join(fixtures, 'release-native.runs')).length === 1);

    // A second session on the same project and jobs folder, while the first still runs.
    const second = make();
    const report = (await second.ws.startRecovery)!;
    expect(report.items.filter((i) => i.did !== 'left')).toEqual([]);
    expect(second.notes).toEqual([]);
    const said = text(await second.ws.recover(''));
    expect(said).toContain(`recipe ${uuid}: followed by ${watcher} (another session)`);
    expect(said).toMatch(new RegExp(`Blender run [0-9a-f]{8} still runs as ${nativeJob} \\(another session\\); it is judged when it ends`));
    expect(second.sealed).toEqual([]);
    // Only the first session's watcher follows the recipe.
    expect(new JobManager({ dir: jobsDir }).list().filter((j) => j.args.at(-1) === uuid)).toHaveLength(1);

    // The first session goes on as before: its watcher delivers, and it judges its own run.
    release(uuid);
    release('native');
    await until('the first session\'s jobs to end', () => first.ws.jobs.get(watcher)?.state === 'completed' && first.ws.jobs.get(nativeJob)?.state === 'completed');
    expect(fs.readdirSync(path.join(root, 'out', 'recipes', uuid.slice(0, 8))).sort()).toEqual(COPIED);
    expect(executions(uuid)).toHaveLength(1);
    expect(text(await second.ws.recover(''))).toContain('nothing to pick up');
  }, 180_000);
});

describe('flows: interrupted once nothing about them moves', () => {
  /** SYNTHETIC: a flow's state file as /iterate writes it while its agent runs (src/repl/iterate.ts saveState). */
  const state = (id: string) => ({
    flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', recipe: 'enclosure.tray/1', instruction: 'make it 160 mm wide', project: 'demo',
    started_at: new Date().toISOString(), outcome: 'running',
    parameters: { path: PARAMS, created: false, before: { sha256: 'a'.repeat(64), values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } } },
    agent: { run: 'a0123abcd', agent: 'qwen', version: null, route: 'local endpoint, no charge', where: '127.0.0.1:11434', model: 'qwen3:4b', job: 'j0aaaa1', result: '.timmy/agents/a0123abcd/result.json', progress: '.timmy/agents/a0123abcd/progress.log' },
    receipts: {}, child_receipts: [], doctrine: DOCTRINE_15, step: 'agent',
  });
  const write = (rel: string, body: string): string => { const at = path.join(root, rel); fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, body); return at; };

  it('a fresh one is left and said only on /recover; a quiet one gets its record and receipt once; a file at a record\'s place is never written over', async () => {
    const stateFile = write('.timmy/flows/f0000aaaa/state.json', `${JSON.stringify(state('f0000aaaa'), null, 2)}\n`);
    write('.timmy/flows/f0000bbbb/state.json', `${JSON.stringify(state('f0000bbbb'), null, 2)}\n`);
    const other = write('results/flows/f0000bbbb.json', 'kept as it is\n');
    const { ws, notes, sealed } = make();
    expect((await ws.startRecovery)!.items.map((i) => [i.id, i.did])).toEqual([['f0000aaaa', 'left']]);
    expect(notes).toEqual([]);
    const listed = text(await ws.recover(''));
    expect(listed).toMatch(/flow f0000aaaa says its agent step runs; no job of that step runs here, and it last changed \d+ s ago: it is recorded as interrupted once nothing about it has changed for 10 min/);
    expect(listed).not.toContain('f0000bbbb');
    expect(sealed).toEqual([]);
    // Ten minutes pass with no change.
    const old = new Date(Date.now() - FLOW_QUIET_MS - 60_000);
    fs.utimesSync(stateFile, old, old);
    const said = text(await ws.recover(''));
    expect(said).toContain('1 flow was interrupted: f0000aaaa (record written)');
    const recordFile = path.join(root, 'results', 'flows', 'f0000aaaa.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(record).toMatchObject({ id: 'f0000aaaa', outcome: 'interrupted', ended_in: 'agent', instruction: 'make it 160 mm wide' });
    expect(record.why).toBe('the REPL running it ended while its agent ran (its job j0aaaa1 has no record in this Timmy\'s jobs folder); nothing was built; recorded after a restart, and nothing was run again');
    expect(record.recovered.next).toEqual([
      `the agent's run a0123abcd keeps its progress in .timmy/agents/a0123abcd/progress.log; ${PARAMS} may hold its change (sha256 before it: ${'a'.repeat(12)})`,
      `/iterate tray "make it 160 mm wide" starts a new flow from ${PARAMS} as it is now`,
    ]);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ kind: 'flow', subject: 'flow · iterate · tray · f0000aaaa · interrupted', status: 'failed', outputs: [{ path: 'results/flows/f0000aaaa.json', sha256: sha(fs.readFileSync(recordFile)) }], sources: [{ path: '.timmy/flows/f0000aaaa/state.json', sha256: sha(fs.readFileSync(stateFile)) }] });
    // The state file and the other flow's file stay as they were; a second pass writes and seals nothing.
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).outcome).toBe('running');
    expect(fs.readFileSync(other, 'utf8')).toBe('kept as it is\n');
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
    expect(sealed).toHaveLength(1);
  });

  it('a results/ folder linked outside the project: no record is made there, nothing is sealed, and the start says why', async () => {
    const stateFile = write('.timmy/flows/f0000cccc/state.json', `${JSON.stringify(state('f0000cccc'), null, 2)}\n`);
    const old = new Date(Date.now() - FLOW_QUIET_MS - 60_000);
    fs.utimesSync(stateFile, old, old);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-elsewhere-'));
    try {
      fs.symlinkSync(elsewhere, path.join(root, 'results'));
      const { ws, notes, sealed } = make();
      expect((await ws.startRecovery)!.items).toMatchObject([{ kind: 'flow', id: 'f0000cccc', did: 'failed' }]);
      expect(notes.join('\n')).toContain('flow f0000cccc was interrupted in its agent step, but its record could not be written: results/flows leads outside the project');
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(sealed).toEqual([]);
      noAbsolute(notes.join('\n'));
    } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
  });

  it('interrupted during a rebuild that has since succeeded and was copied: the record says so and where its exports are; nothing is delivered again', async () => {
    // A real recipe job through the jobs.ts seam (the held SYNTHETIC executor, released at once), copied as its watcher copies it.
    const p = prepareRecipe({ width: 180 }, { root, env: { TIMMY_CADQUERY_PYTHON: fakePython }, executor: heldExecutor() });
    if (!p.ok) throw new Error(p.error);
    const uuid = p.prepared.id;
    release(uuid);
    await launchRecipe(root, uuid);
    await until('the recipe to succeed', () => status(root, uuid).state === 'succeeded');
    expect(deliver(root, uuid).ok).toBe(true);
    // SYNTHETIC: the flow's state as /iterate saves it once its rebuild started (src/repl/iterate.ts buildStep); its watcher has no record here.
    const s = {
      ...state('f0000dddd'), step: 'build',
      parameters: { ...state('f0000dddd').parameters, after: { sha256: 'b'.repeat(64), values: { width: 180, wall: 3, supportOffset: 10, bore: 3 } }, diff: [{ name: 'width', before: 140, after: 180, changed: true }] },
      rebuild: { operation: uuid, job: 'j0bbbb2', state: 'running', predicted: { bounds_mm: [180, 80, 30], volume_mm3: 1 }, prediction_receipt: 'rcP' },
      receipts: { agent: 'rcA', prediction: 'rcP' },
    };
    const stateFile = write('.timmy/flows/f0000dddd/state.json', `${JSON.stringify(s, null, 2)}\n`);
    const old = new Date(Date.now() - FLOW_QUIET_MS - 60_000);
    fs.utimesSync(stateFile, old, old);
    const { ws, notes, sealed } = make();
    const report = (await ws.startRecovery)!;
    expect(report.items.map((i) => [i.kind, i.id, i.did])).toEqual([['flow', 'f0000dddd', 'interrupted']]);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', 'f0000dddd.json'), 'utf8'));
    expect(record).toMatchObject({ outcome: 'interrupted', ended_in: 'build', rebuild: { operation: uuid, job: 'j0bbbb2', state: 'succeeded' }, child_receipts: ['rcA', 'rcP'] });
    expect(record.why).toBe(`the REPL running it ended during its rebuild (its job j0bbbb2 has no record in this Timmy's jobs folder); recipe job ${uuid} has succeeded; nothing was read back; recorded after a restart, and nothing was run again`);
    expect(record.recovered.next).toEqual([
      `recipe job ${uuid} succeeded: /recipe status shows whether its exports are in out/recipes/${uuid.slice(0, 8)}/, and /recipe copy ${uuid} copies them when they are not`,
      `/recipe recover ${uuid} reads recipe job ${uuid} again; nothing is rerun`,
      `${PARAMS} holds the agent's change (width 140 → 180): /recipe tray builds from it`,
      `/iterate tray "make it 160 mm wide" starts a new flow from ${PARAMS} as it is now`,
    ]);
    expect(notes[0]).toBe('  Recovered  1 flow was interrupted: f0000dddd (record written)');
    expect(sealed.map((r) => r.kind)).toEqual(['flow']);
    expect(executions(uuid)).toHaveLength(1);
  });
});

describe('a recipe whose worker stopped answering', () => {
  it('is named with /recipe recover at start, not followed; nothing runs; the recipe\'s own recover settles it', async () => {
    const p = prepareRecipe({}, { root, env: { TIMMY_CADQUERY_PYTHON: fakePython }, executor: heldExecutor() });
    if (!p.ok) throw new Error(p.error);
    const uuid = p.prepared.id;
    const dir = jobDirectory(root, uuid);
    // SYNTHETIC: what a supervisor that died before its first heartbeat leaves (lanes/recipes/jobs.ts start): its claim, a minute old.
    fs.writeFileSync(path.join(dir, 'claim.json'), `${JSON.stringify({ started: Date.now() - 60_000 })}\n`, { mode: 0o600 });
    // SYNTHETIC: what a crashed session's job manager leaves for its watcher: the record, running, its process gone.
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const spec = watcherSpec({ root, id: uuid, label: `recipe enclosure.tray/1 ${uuid}`, project: 'demo' });
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, 'j0dead1.json'), JSON.stringify({ id: 'j0dead1', kind: 'task', label: spec.label, project: 'demo', root, command: spec.command, args: spec.args, state: 'running', pid: gone, startedAt: new Date(Date.now() - 60_000).toISOString(), steps: [], lines: 0 }));
    const { ws, notes, sealed } = make();
    await ws.startRecovery;
    expect(status(root, uuid)).toMatchObject({ state: 'running', progress: 'starting' });
    expect(notes[0]).toContain('1 recipe job needs /recipe recover');
    expect(notes.join('\n')).toMatch(new RegExp(`recipe ${uuid} says it is running \\(starting\\), but its worker last answered \\d+ s ago, and the REPL that followed it ended: /recipe recover ${uuid} reads it again; nothing is rerun`));
    // Nothing was followed, sealed or run.
    expect(ws.jobs.list().map((j) => j.id)).toEqual(['j0dead1']);
    expect(sealed).toEqual([]);
    expect(executions(uuid)).toEqual([]);
    // The recipe's own recover records how it ended; then nothing is left to pick up.
    expect(text(await ws.recipe(`recover ${uuid}`))).toContain(`${uuid} interrupted`);
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
  });
});

describe('/recover', () => {
  it('with nothing left: the start prints nothing, /recover says so plainly; it is a work command that fits /help', async () => {
    const { ws, notes, sealed } = make();
    expect(await ws.startRecovery).toEqual({ project: path.basename(root), items: [] });
    expect(notes).toEqual([]);
    // R4 (H62): it names everything it looked for
    expect(text(await ws.recover(''))).toBe(`  Recovery   nothing to pick up in ${path.basename(root)}: no recipe job, flow, native run, workflow run, code agent run or OpenHands container was left by a REPL that ended`);
    expect(sealed).toEqual([]);
    expect(fs.existsSync(path.join(root, '.timmy'))).toBe(false);
    const c = COMMANDS.find((x) => x.name === 'recover');
    expect(c?.group).toBe('work');
    expect(`  /${'recover'.padEnd(11)} ${c?.description}`.length).toBeLessThanOrEqual(60);
  });

  it('a REPL that is not at a terminal (recoverAtStart false) runs no pass as it starts', async () => {
    const notes: string[] = [];
    const ws = new Workspace({ glyphs: glyphSet(true), env: {}, onPath: () => null, notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (u) => u, link: (t) => t, seal: () => undefined, jobsDir, chdir: () => {}, receipts: () => [], recoverAtStart: false }, folderProject(root));
    spaces.push(ws);
    expect(await ws.startRecovery).toBeUndefined();
    expect(notes).toEqual([]);
  });
});
