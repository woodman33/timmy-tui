/**
 * Round R4, the review's R4-2: the /iterate change check covers .timmy and dist at every depth. The agent's run is
 * judged by a snapshot of the whole project (only folders named .git or node_modules are left out, for size, and each one
 * is named in the flow's record and its end line), except Timmy's own writes during the agent step: that run's
 * .timmy/agents/<run>/, the flow's .timmy/flows/<id>/, the jobs folder when it is inside the project, and the folders of
 * the recipe jobs not over when the agent starts (their supervisors' heartbeats; tests/recover.test.ts runs a flow beside
 * such a job, and tests/iterate-judge-parts.test.ts checks which folders those are). Any other change under .timmy stops
 * the flow before its build or app run: "changed while the agent ran: … (Timmy cannot tell who changed it)".
 *
 * FAKE pieces, each labelled: the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing
 * sent; its PARAM and WRITE words change files); the recipe runs through the jobs.ts executor seam with a SYNTHETIC
 * fixture executor (as tests/iterate.test.ts: labelled files and signed receipts, no CadQuery); the readback is
 * tests/fixtures/fake-step-readback.mjs (a TEST DOUBLE); TIMMY_CADQUERY_PYTHON, TIMMY_BLENDER, TIMMY_OPENSCAD,
 * TIMMY_FREECADCMD, TIMMY_AFTERFX and TIMMY_AERENDER name FAKE programs, never run here (those flows stop before their app;
 * R4, H46: /iterate ae too). The folders and files the
 * agent "should not" touch are written by the test or by the FAKE agent, labelled where they are.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { EXPORTS } from '../src/recipes/index.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const TEMPLATES = path.join(REPO, 'templates');
const FAKE_AGENT = path.join(FIXTURES, 'fake-code-agent.mjs');
const FAKE_READBACK = path.join(FIXTURES, 'fake-step-readback.mjs');
const PARAMS = 'recipes/tray.params.json';

let root: string;
let fixtures: string;
let env: Record<string, string>;
const spaces: Workspace[] = [];
let supervisors: Promise<void>[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}
const write = (rel: string, body: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
const flowIdIn = (out: string): string => { const m = out.match(/Flow\s+(f[0-9a-f]{8})/); if (!m) throw Error(`no flow in: ${out}`); return m[1]; };
const ended = (sealed: ReceiptInput[], id: string) => (): boolean => sealed.some((r) => r.kind === 'flow' && String(r.subject).includes(id));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recordOf = (id: string): any => JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8'));

/** The SYNTHETIC fixture executor of tests/iterate.test.ts ('complete'): labelled files, signed receipts, no geometry. */
function fakeExecutor(): string {
  const file = path.join(fixtures, 'fake-recipe-complete.mts');
  const module = (name: string) => JSON.stringify(pathToFileURL(path.resolve(name)).href);
  fs.writeFileSync(file, `
// FAKE recipe executor (test fixture): SYNTHETIC files only; no CadQuery, no Open3D, no Python.
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${module('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${module('src/utils/receipts.ts')};
import {sha,prediction,validate} from ${module('lanes/recipes/tray.ts')};
const [,root,id]=process.argv.slice(2), job=loadJob(root,id), dir=jobDirectory(root,id), workspace=path.join(dir,'workspace');
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

function make(o: { jobsDir?: string } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env,
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: o.jobsDir ?? path.join(fs.mkdtempSync(path.join(fixtures, 'jobs-')), 'jobs'),
    chdir: () => {},
    receipts: () => sealed as unknown as Receipt[],
    // FAKE: the jobs.ts executor seam and a fast watcher poll; the supervisor is observed so teardown can wait for it.
    recipeTest: { executor: fakeExecutor(), pollMs: 100, onSupervisor: (child: ChildProcess) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); } },
    // FAKE: the readback test double instead of TIMMY_CADQUERY_PYTHON workers/readback/step_readback.py.
    iterateTest: { readback: (step) => ({ command: process.execPath, args: [FAKE_READBACK, 'match', step.abs, '--as', step.rel] }), settleMs: 15000 },
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-judge-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-judge-fixtures-')));
  const program = (name: string): string => { const p = path.join(fixtures, 'bin', name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\necho "FAKE: never run by this test"\nexit 1\n', { mode: 0o755 }); return p; };
  env = {
    TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: program('python'),
    TIMMY_BLENDER: program('blender'), TIMMY_OPENSCAD: program('openscad'), TIMMY_FREECADCMD: program('freecadcmd'),
    TIMMY_AFTERFX: program('AfterFX'), TIMMY_AERENDER: program('aerender'),
  };
  supervisors = [];
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  await Promise.race([Promise.all(supervisors), new Promise((r) => setTimeout(r, 25000))]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60_000);

const WRITES = 'WRITE:.timmy/receipts/x WRITE:.timmy/agents/a0000beef/result.json WRITE:dist/x.js';
const TIMMY_WORDS = 'changed while the agent ran: .timmy/receipts/x (added), .timmy/agents/a0000beef/result.json (changed) (Timmy cannot tell who changed it)';

describe('the /iterate change check sees .timmy and dist (R4 review, R4-2)', () => {
  it('tray: an agent that also writes .timmy/receipts/x, another run\'s result.json and dist/x.js is stopped before the build; what was not compared is said', async () => {
    // SYNTHETIC: a .git and a node_modules folder (not looked into, for size, and named), and another agent run's record.
    write('.git/HEAD', 'ref: refs/heads/main\n');
    write('node_modules/left-pad/index.js', 'module.exports = 1;\n');
    write('.timmy/agents/a0000beef/result.json', '{"agent_run":1,"run":"a0000beef"}\n');
    const { ws, notes, sealed } = make();
    const id = flowIdIn(text(await ws.iterate(`tray "make it 180 mm wide PARAM:width=180 ${WRITES}"`)));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks' });
    expect(rec.why).toBe(`the agent changed files other than ${PARAMS}: dist/x.js (added); ${TIMMY_WORDS}; nothing was built, and nothing was reverted; the agent's output is kept: ${rec.agent.transcript}`);
    expect(rec.agent.others.map((o: { path: string; how: string }) => [o.path, o.how])).toEqual([['.timmy/receipts/x', 'added'], ['dist/x.js', 'added'], ['.timmy/agents/a0000beef/result.json', 'changed']]);
    // What the check compared: Timmy's own writes during the step, not counted; the folders not looked into, named.
    expect(rec.agent.compared).toEqual({
      scope: expect.stringContaining('.timmy and dist included'),
      // R4 (H51): operation records and flow holds are Timmy's own bookkeeping too (another request may write them meanwhile).
      own: [`.timmy/agents/${rec.agent.run}/`, `.timmy/flows/${id}/`, '.timmy/operations/', '.timmy/flow-holds/'],
      not_compared: ['.git/', 'node_modules/'],
    });
    // Nothing was built, nothing reverted: the files stay as the agent left them.
    expect(fs.existsSync(path.join(root, '.timmy', 'recipe-jobs'))).toBe(false);
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow']);
    expect(fs.readFileSync(path.join(root, 'dist', 'x.js'), 'utf8')).toContain('FAKE agent');
    // The end line says it, and what was not compared.
    const said = notes.join('\n');
    expect(said).toContain(`${id} stopped: the agent changed files other than ${PARAMS}: dist/x.js (added); ${TIMMY_WORDS}`);
    expect(said).toContain('not compared while the agent ran: .git/, node_modules/ (folders named .git or node_modules are not looked into, for size)');
    for (const p of [root, fixtures]) expect(said).not.toContain(p);
  }, 60_000);

  it('tray: Timmy\'s own writes during the agent step are not counted (its run\'s folder, the flow\'s, and a jobs folder inside the project): the flow goes on and succeeds', async () => {
    // The jobs folder inside the project, as when Timmy's home is in the project folder (~/timmy with the home folder open).
    const jobsDir = path.join(root, 'timmy', 'jobs');
    const { ws, notes, sealed } = make({ jobsDir });
    const id = flowIdIn(text(await ws.iterate('tray "make it 180 mm wide PARAM:width=180"')));
    await until(ended(sealed, id), 90_000);
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'succeeded', ended_in: 'readback', readback: { verdict: 'matches' } });
    expect(rec.agent.files_changed.map((c: { path: string }) => c.path)).toEqual([PARAMS]);
    expect(rec.agent.compared).toEqual({ scope: expect.any(String), own: [`.timmy/agents/${rec.agent.run}/`, `.timmy/flows/${id}/`, 'timmy/jobs/', '.timmy/operations/', '.timmy/flow-holds/'], not_compared: [] });
    // Nothing was skipped here, so the end line says nothing about it.
    expect(notes.join('\n')).not.toContain('not compared while the agent ran');
    // The agent's own record lists the parameter file only, too (its jobs folder's files are Timmy's, not the agent's).
    const result = JSON.parse(fs.readFileSync(path.join(root, '.timmy', 'agents', rec.agent.run, 'result.json'), 'utf8'));
    expect([...result.files.added, ...result.files.changed, ...result.files.deleted].map((c: { path: string }) => c.path)).toEqual([PARAMS]);
  }, 120_000);

  // R4 (H46): /iterate ae passes the same check (before, its agent was judged by its own snapshot, which skips .timmy and dist).
  for (const [kind, file, app] of [['scad', 'box.params.json', 'OpenSCAD'], ['freecad', 'plate.py', 'FreeCAD'], ['blender', 'scene.py', 'Blender'], ['ae', 'author.jsx', 'After Effects']] as const) {
    it(`${kind}: the same agent is stopped before ${app} runs, in the same words`, async () => {
      for (const f of ['box.scad', 'box.params.json']) fs.copyFileSync(path.join(TEMPLATES, 'scad-starter', f), path.join(root, f));
      fs.copyFileSync(path.join(TEMPLATES, 'freecad-starter', 'plate.py'), path.join(root, 'plate.py'));
      fs.copyFileSync(path.join(TEMPLATES, 'blender-starter', 'scene.py'), path.join(root, 'scene.py'));
      fs.copyFileSync(path.join(TEMPLATES, 'ae-starter', 'author.jsx'), path.join(root, 'author.jsx'));
      write('.timmy/agents/a0000beef/result.json', '{"agent_run":1,"run":"a0000beef"}\n');
      const target = kind === 'scad' ? 'box.scad' : file;
      const { ws, sealed } = make();
      const id = flowIdIn(text(await ws.iterate(`${kind} ${target} "${WRITES}"`)));
      await until(ended(sealed, id));
      const rec = recordOf(id);
      expect(rec).toMatchObject({ target: kind, outcome: 'stopped', ended_in: 'checks' });
      expect(rec.why).toBe(`the agent changed files other than ${file}: dist/x.js (added); ${TIMMY_WORDS}; ${app} did not run, and nothing was reverted; the agent's output is kept: ${rec.agent.transcript}`);
      expect(rec.agent.compared).toMatchObject({ own: [`.timmy/agents/${rec.agent.run}/`, `.timmy/flows/${id}/`, '.timmy/operations/', '.timmy/flow-holds/'], not_compared: [] });
      expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow']);
    }, 60_000);
  }
});
