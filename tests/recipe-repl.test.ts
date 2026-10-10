/**
 * Round R3 (/recipe, helper H11): the CadQuery enclosure-tray recipe as a REPL workflow with a durable job,
 * driven end to end through the Workspace: refusal and a missing runtime start nothing; a started job runs
 * through lanes/recipes/jobs.ts (enqueue, detached supervisor, status, cancel, recover) and a watcher job;
 * a succeeded job's exports are copied only after their sha256 values match the verified result.
 *
 * FAKE: no CadQuery, Open3D or Python runs here. The recipe jobs use the jobs.ts executor seam with a
 * SYNTHETIC fixture executor (written below, as in tests/recipe-jobs.test.ts) that writes labeled
 * synthetic files and signed receipts; TIMMY_CADQUERY_PYTHON points at a FAKE file that is never executed.
 * These tests exercise the REPL wiring, the job lifecycle and the copy checks, not native geometry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { ReceiptInput } from '../src/utils/receipts.js';
import { sha } from '../lanes/recipes/tray.js';
import { cancel, jobDirectory, status } from '../lanes/recipes/jobs.js';
import { recipeEnded, type RecipeContext } from '../src/repl/recipe.js';
import { cancelRecipe, cancelSentence, cancelUnfollowed } from '../src/repl/recipe-stop.js';
import type { JobRecord } from '../src/jobs/index.js';
import { checkCopy, deliver, DOCTRINE_15, EXPORTS, launchRecipe, outcomeLines, prepareRecipe, recipeCapabilityRow, recipeExercisedAt } from '../src/recipes/index.js';
import { capabilities, type ProbeDeps } from '../src/capabilities/index.js';
import { listProjectFiles } from '../src/project/index.js';
import { createRecipeTools } from '../src/agent/recipe-tools.js';

let root: string;
let fixtures: string;
let fakePython: string;
const spaces: Workspace[] = [];
let supervisors: Promise<void>[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** A SYNTHETIC fixture executor for the jobs.ts seam: labeled files, signed receipts, no geometry. */
function fakeExecutor(mode: 'complete' | 'reported-failure' | 'wait'): string {
  const file = path.join(fixtures, `fake-recipe-${mode}.mts`);
  const module = (name: string) => JSON.stringify(pathToFileURL(path.resolve(name)).href);
  fs.writeFileSync(file, `
// FAKE recipe executor (test fixture): SYNTHETIC files only; no CadQuery, no Open3D, no Python.
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${module('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${module('src/utils/receipts.ts')};
import {sha,prediction,validate} from ${module('lanes/recipes/tray.ts')};
const mode=${JSON.stringify(mode)};
const [,root,id]=process.argv.slice(2), job=loadJob(root,id), dir=jobDirectory(root,id), workspace=path.join(dir,'workspace');
fs.appendFileSync(path.join(dir,'executions.txt'),'fake execution\\n');
if(mode==='wait')await new Promise(r=>setTimeout(r,10000));
const p=validate(job.request), pred=prediction(p);
const run=randomUUID(), base=path.join(workspace,'.timmy','recipe-runs',run);fs.mkdirSync(base,{recursive:true});
fs.writeFileSync(path.join(base,'request.json'),JSON.stringify(job.request));
fs.writeFileSync(path.join(base,'prediction.json'),JSON.stringify(pred,null,2)+'\\n');
fs.writeFileSync(path.join(base,'build.py'),'SYNTHETIC fixture source; not the recipe');
const common={subject:'SYNTHETIC recipe fixture; no geometry claim',policy:'auto',cost_usd:0};
const prediction_=appendReceipt('runs',{...common,status:'ok',kind:'recipe.prediction',sources:['request.json','prediction.json','build.py'].map(n=>({path:path.join(base,n),sha256:sha(fs.readFileSync(path.join(base,n)))}))},workspace);
const native=path.join(base,'native');fs.mkdirSync(native);
const failed=mode==='reported-failure';
const exports=failed?[]:${JSON.stringify(EXPORTS)}.map(f=>{fs.writeFileSync(path.join(native,f),'SYNTHETIC '+f+'; not geometry');return {file:f,sha256:sha(fs.readFileSync(path.join(native,f)))};});
const labels=[...Array.from({length:12},(_,i)=>'Stage check '+(i+1)),'Native bounds','Native analytic volume','Native valid single solid','STEP reimport bounds','STEP reimport analytic volume','STEP reimport valid single solid','STL closed, manifold, orientable','STL one component, no self intersections','STL volume agrees within 0.1%','Every construction stage validated',...Array.from({length:8},(_,i)=>'axis '+(i+1))];
const result={schema:'timmy.tray-build/1',engine:'SYNTHETIC fixture',synthetic:true,variant:{measured:{bounds:pred.bounds,volume:pred.volumeMm3},mesh:{engine:'SYNTHETIC mesh fixture'},checks:labels.map((label,i)=>({id:'geometry.'+String(i+1).padStart(2,'0'),label,passed:!failed}))}};
fs.writeFileSync(path.join(native,'result.json'),JSON.stringify(result));
fs.writeFileSync(path.join(base,'native.log'),failed?'SYNTHETIC native failure for the test':'SYNTHETIC native log');
const sources=[path.join(native,'result.json'),path.join(base,'native.log'),...exports.map(e=>path.join(native,e.file))].map(f=>({path:f,sha256:sha(fs.readFileSync(f))}));
const receipt=appendReceipt('runs',{...common,status:failed?'failed':'ok',kind:'recipe.build',child_receipts:[prediction_.id],sources},workspace);
const report={state:failed?'failed':'succeeded',run,parameters:p,predictionReceipt:prediction_.id,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:failed?null:30,exports,error:failed?'SYNTHETIC failure':undefined};
fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\\n');
recordResult(root,id,{...report,directory:base});
`);
  return file;
}

function make(o: { python?: boolean; mode?: 'complete' | 'reported-failure' | 'wait'; sealFails?: boolean } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const jobsDir = path.join(fs.mkdtempSync(path.join(fixtures, 'jobs-')), 'jobs');
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: o.python === false ? {} : { TIMMY_CADQUERY_PYTHON: fakePython },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { if (o.sealFails) return undefined; sealed.push(input); return `id${sealed.length}`; },
    jobsDir,
    chdir: () => {},
    receipts: () => [],
    // FAKE: the jobs.ts executor seam and a fast watcher poll; the supervisor is observed so teardown can wait for it.
    recipeTest: {
      ...(o.mode ? { executor: fakeExecutor(o.mode) } : {}),
      pollMs: 100,
      onSupervisor: (child: ChildProcess) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); },
    },
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed, jobsDir };
}

const jobIdIn = (out: string): string => { const m = out.match(/Running\s+(j[0-9a-f]{6})/); if (!m) throw Error(`no job in: ${out}`); return m[1]; };
const uuidIn = (out: string): string => { const m = out.match(/Recipe job\s+([0-9a-f-]{36})/); if (!m) throw Error(`no recipe job in: ${out}`); return m[1]; };
async function until(pred: () => boolean, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}
const recipeJobs = (): string[] => { try { return fs.readdirSync(path.join(root, '.timmy', 'recipe-jobs')); } catch { return []; } };
/** The durable recipe job's own end states (lanes/recipes/jobs.ts). */
const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
/** The live processes whose command line names this recipe job (its supervisor, the FAKE executor, a watcher), read from the process table, never from a PID file. */
const processesNaming = (id: string): string[] =>
  String(spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8' }).stdout ?? '').split('\n').filter((l) => l.includes(id));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-repl-project-'));
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-repl-fixtures-'));
  fakePython = path.join(fixtures, 'fake-python');
  fs.writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  supervisors = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of spaces.splice(0)) await w.close();
  await Promise.race([Promise.all(supervisors), new Promise((r) => setTimeout(r, 15000))]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
});

describe('/recipe with the project parameter file (round R4)', () => {
  it('takes recipes/tray.params.json as its defaults, words override it, and the sealed prediction names the file', async () => {
    const { ws, sealed } = make({ mode: 'complete' });
    fs.mkdirSync(path.join(root, 'recipes'));
    const file = JSON.stringify({ schema: 'timmy.recipe-params/1', recipe: 'enclosure.tray/1', parameters: { width: 160, wall: 2.5 } });
    fs.writeFileSync(path.join(root, 'recipes', 'tray.params.json'), file);
    expect(text(await ws.recipe(''))).toMatch(/Defaults\s+recipes\/tray\.params\.json\s+width 160, wall 2\.5/);
    const out = text(await ws.recipe('tray wall=3'));
    expect(out).toMatch(/Predicted\s+160 x 80 x 30 mm/);
    expect(out).toMatch(/Parameters\s+recipes\/tray\.params\.json\s+sha256 [0-9a-f]{12}/);
    const predicted = sealed.find((r) => r.kind === 'predict');
    const sources = (predicted?.sources ?? []) as Array<Record<string, unknown>>;
    expect(sources[0]).toMatchObject({ parameters: { width: 160, wall: 3, supportOffset: 10, bore: 3 } });
    expect(sources[1]).toMatchObject({ path: 'recipes/tray.params.json', sha256: sha(Buffer.from(file)), role: 'parameter file' });
    const id = uuidIn(out);
    await until(() => status(root, id).state === 'succeeded');
  });

  it('a parameter file the recipe would refuse stops the start with the reason; the card defaults are not used instead', async () => {
    const { ws, sealed } = make({ mode: 'complete' });
    fs.mkdirSync(path.join(root, 'recipes'));
    fs.writeFileSync(path.join(root, 'recipes', 'tray.params.json'), '{"schema":"timmy.recipe-params/1","recipe":"enclosure.tray/1","parameters":{"width":20}}');
    const out = text(await ws.recipe('tray'));
    expect(out).toContain('Refused before any native start');
    expect(out).toContain('recipes/tray.params.json is not a usable parameter file');
    expect(out).toContain('Conflicting tray dimensions');
    expect(recipeJobs()).toEqual([]);
    expect(sealed).toEqual([]);
  });
});

describe('/recipe before any start', () => {
  it('lists the recipe with its parameters in mm, defaults, the runtime state and the DOCTRINE §15 sentence', async () => {
    const { ws } = make();
    const out = text(await ws.recipe(''));
    expect(out).toContain('enclosure.tray/1');
    for (const p of ['width', 'wall', 'supportOffset', 'bore']) expect(out).toContain(p);
    expect(out).toMatch(/width\s+140 mm/);
    expect(out).toContain('TIMMY_CADQUERY_PYTHON is set');
    expect(out).toContain(DOCTRINE_15);
    expect(out).not.toContain(fixtures);
  });

  it('refuses wall=0 in the REPL with the reason, and writes and starts nothing', async () => {
    const { ws, sealed } = make({ mode: 'complete' });
    const out = text(await ws.recipe('tray wall=0'));
    expect(out).toContain('Refused before any native start');
    expect(out).toContain('Conflicting tray dimensions');
    expect(recipeJobs()).toEqual([]);
    expect(ws.jobs.list()).toEqual([]);
    expect(sealed).toEqual([]);
    expect(text(await ws.recipe('tray depth=9'))).toContain('no parameter depth');
  });

  it('without TIMMY_CADQUERY_PYTHON says exactly what to set and starts nothing', async () => {
    const { ws, sealed } = make({ python: false, mode: 'complete' });
    const out = text(await ws.recipe('tray'));
    expect(out).toContain('TIMMY_CADQUERY_PYTHON is not set');
    expect(out).toContain('set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery and Open3D');
    expect(recipeJobs()).toEqual([]);
    expect(ws.jobs.list()).toEqual([]);
    expect(sealed).toEqual([]);
  });
});

describe('run_recipe (the agent\'s start, through the same workspace path)', () => {
  it('answers refusals and a missing runtime as data, starting nothing; the tool passes only the given parameters', async () => {
    const { ws } = make({ mode: 'complete' });
    expect(await ws.runRecipe({ wall: 0 })).toMatchObject({ ok: false, stage: 'refused' });
    const bare = make({ python: false, mode: 'complete' });
    expect(await bare.ws.runRecipe({})).toMatchObject({ ok: false, stage: 'setup', setup: expect.stringContaining('CadQuery and Open3D') });
    expect(recipeJobs()).toEqual([]);
    const seen: Record<string, unknown>[] = [];
    const [tool] = createRecipeTools({ start: async (p) => { seen.push(p); return { ok: true }; } });
    const fn = (tool as unknown as { function: { name: string; execute: (i: unknown) => Promise<unknown> } }).function;
    expect(fn.name).toBe('run_recipe');
    await fn.execute({ recipe: 'enclosure.tray/1', parameters: { width: 150, wall: undefined } });
    expect(seen).toEqual([{ width: 150 }]);
  });
});

describe('/recipe tray with no sealed prediction', () => {
  it('writes the job but starts nothing when the prediction cannot be sealed', async () => {
    const { ws } = make({ mode: 'complete', sealFails: true });
    const out = text(await ws.recipe('tray'));
    expect(out).toContain('the prediction could not be sealed');
    expect(ws.jobs.list()).toEqual([]);
    const [id] = recipeJobs();
    expect(status(root, id).state).toBe('queued');
    expect(fs.existsSync(path.join(jobDirectory(root, id), 'claim.json'))).toBe(false);
  });
});

describe('/recipe tray as a durable job (FAKE executor)', () => {
  it('seals the prediction first, runs, copies the five exports with matching sha256 and states §15', async () => {
    const { ws, notes, sealed } = make({ mode: 'complete' });
    const out = text(await ws.recipe('tray width=180'));
    expect(out).toMatch(/Predicted\s+180 x 80 x 30 mm/);
    const id = uuidIn(out);
    const job = jobIdIn(out);
    expect(sealed[0]).toMatchObject({ kind: 'predict', subject: `recipe · predict · enclosure.tray/1 · ${id}` });
    const label = ws.jobs.get(job)!.label;
    expect(label).toContain(id);
    expect(label).toContain(status(root, id).job.requestHash.slice(0, 12));
    await until(() => TERMINAL.has(ws.jobs.get(job)?.state ?? ''));
    expect(ws.jobs.get(job)!.state).toBe('completed');
    expect(status(root, id).state).toBe('succeeded');
    const dest = path.join(root, 'out', 'recipes', id.slice(0, 8));
    expect(fs.readdirSync(dest).sort()).toEqual([...EXPORTS, 'prediction.json', 'report.json', 'request.json'].sort());
    // Every export matches the sha256 the signed result recorded.
    const envelope = JSON.parse(fs.readFileSync(path.join(jobDirectory(root, id), 'result.json'), 'utf8'));
    for (const e of envelope.result.exports as Array<{ file: string; sha256: string }>) expect(sha(fs.readFileSync(path.join(dest, e.file)))).toBe(e.sha256);
    const notice = notes.join('\n');
    expect(notice).toContain(`recipe`);
    expect(notice).toContain('30 of 30 geometry checks passed');
    expect(notice).toMatch(/Bounds 180 x 80 x 30 mm measured; 180 x 80 x 30 mm in the sealed prediction/);
    expect(notice).toContain('STEP reimport: 3 of 3 checks passed; independent mesh checks: 3 of 3 passed');
    expect(notice).toContain('5 exports with matching sha256');
    expect(notice).toContain(DOCTRINE_15);
    expect(notice).not.toContain(root);
    const listed = text(await ws.recipe('status'));
    expect(listed).toContain(id);
    expect(listed).toContain('succeeded');
    expect(listed).toContain(`copied: out/recipes/${id.slice(0, 8)}/ (every sha256 matches)`);
    // A FAKE executor never counts as exercised, even when its job succeeded.
    expect(recipeExercisedAt(root)).toBeUndefined();
    // The copies are project outputs (what /board and /results list).
    const outputs = listProjectFiles(root).files.filter((f) => f.role === 'output').map((f) => f.rel);
    expect(outputs).toContain(`out/recipes/${id.slice(0, 8)}/console-tray.step`);
    // The run_recipe answer is the same start: a job id and the operation ID at once, never a finished build.
    const started = await ws.runRecipe({ width: 160 });
    expect(started).toMatchObject({ ok: true, operation: expect.stringMatching(/^[0-9a-f-]{36}$/), job: expect.stringMatching(/^j[0-9a-f]{6}$/), doctrine: DOCTRINE_15 });
    if (started.ok) await until(() => TERMINAL.has(ws.jobs.get(started.job)?.state ?? ''));
  }, 40000);

  it('refuses to copy a tampered export, and a copy that would overwrite different bytes', async () => {
    const { ws } = make({ mode: 'complete' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    const job = jobIdIn(out);
    await until(() => TERMINAL.has(ws.jobs.get(job)?.state ?? ''));
    const dest = path.join(root, 'out', 'recipes', id.slice(0, 8));
    // A different file already in the project's copy: nothing is overwritten.
    fs.writeFileSync(path.join(dest, 'outer.stl'), 'not the verified bytes');
    const refusedOverwrite = text(await ws.recipe(`copy ${id}`));
    expect(refusedOverwrite).toContain('Refused to copy');
    expect(refusedOverwrite).toContain('already holds different bytes');
    expect(fs.readFileSync(path.join(dest, 'outer.stl'), 'utf8')).toBe('not the verified bytes');
    // A tampered export in the job's own run: the fresh verification fails and nothing is copied.
    fs.rmSync(dest, { recursive: true });
    const envelope = JSON.parse(fs.readFileSync(path.join(jobDirectory(root, id), 'result.json'), 'utf8'));
    const run = envelope.result.run as string;
    fs.appendFileSync(path.join(jobDirectory(root, id), 'workspace', '.timmy', 'recipe-runs', run, 'native', 'bores.stl'), 'tampered');
    const refused = text(await ws.recipe(`copy ${id}`));
    expect(refused).toContain('Refused to copy');
    expect(refused).toContain('nothing copied');
    expect(fs.existsSync(dest)).toBe(false);
  }, 40000);

  it('a linked out/ that leads outside the project: refused before any folder is made there (the review of ee70b9e)', async () => {
    const { ws } = make({ mode: 'complete' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    const job = jobIdIn(out);
    await until(() => TERMINAL.has(ws.jobs.get(job)?.state ?? ''));
    fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-elsewhere-'));
    fs.symlinkSync(elsewhere, path.join(root, 'out'));
    const refused = text(await ws.recipe(`copy ${id}`));
    expect(refused).toContain('leads outside the project');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }, 40000);

  it('keeps a failed job\'s raw failure and says where it is, project-relative; nothing is copied', async () => {
    const { ws, notes } = make({ mode: 'reported-failure' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    const job = jobIdIn(out);
    await until(() => TERMINAL.has(ws.jobs.get(job)?.state ?? ''));
    expect(ws.jobs.get(job)!.state).toBe('failed');
    expect(status(root, id).state).toBe('failed');
    const notice = notes.join('\n');
    expect(notice).toContain(`recipe ${id} failed`);
    expect(notice).toContain(`.timmy/recipe-jobs/${id}/worker.log`);
    expect(notice).toMatch(/recipe-runs\/[0-9a-f-]{36}\/native\.log/);
    expect(notice).not.toContain(root);
    expect(fs.existsSync(path.join(root, 'out', 'recipes', id.slice(0, 8)))).toBe(false);
    expect(recipeExercisedAt(root)).toBeUndefined();
  }, 40000);

  it('/stop reaches the recipe\'s own cancel path; the native run is cancelled, not killed from a saved PID', async () => {
    const { ws } = make({ mode: 'wait' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    const job = jobIdIn(out);
    const dir = jobDirectory(root, id);
    await until(() => fs.existsSync(path.join(dir, 'executions.txt')));
    const stopped = text(await ws.stop(job));
    expect(stopped).toContain(`${job} cancelled`);
    expect(fs.existsSync(path.join(dir, 'cancel.json'))).toBe(true);
    await until(() => status(root, id).state === 'cancelled');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'terminal.json'), 'utf8')).state).toBe('cancelled');
    expect(fs.readFileSync(path.join(dir, 'executions.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(recipeExercisedAt(root)).toBeUndefined();
    // A new Workspace (a REPL restart) lists the job from the project's .timmy/recipe-jobs.
    const again = make({ mode: 'complete' });
    const listed = text(await again.ws.recipe('status'));
    expect(listed).toContain(id);
    expect(listed).toContain('cancelled');
    // /recipe cancel on a job that already ended changes nothing (the review of ee70b9e, M12)
    expect(text(await again.ws.recipe(`cancel ${id}`))).toContain('nothing to cancel');
    const recovered = text(await again.ws.recipe(`recover ${id}`));
    expect(recovered).toContain(`${id} cancelled`);
    expect(recovered).toContain('nothing changed');
  }, 40000);
});

describe('/recipe cancel (the review of ee70b9e, M12)', () => {
  it('cancels a running job whose watcher is gone, through the recipe\'s own cancel path', async () => {
    const { ws } = make({ mode: 'wait' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    const dir = jobDirectory(root, id);
    await until(() => fs.existsSync(path.join(dir, 'executions.txt')));
    expect(text(await ws.recipe('cancel'))).toContain('Usage: /recipe cancel <uuid>');
    const said = text(await ws.recipe(`cancel ${id}`));
    expect(said).toContain('cancel requested through the recipe\'s own path');
    expect(fs.existsSync(path.join(dir, 'cancel.json'))).toBe(true);
    await until(() => status(root, id).state === 'cancelled');
    expect(fs.readFileSync(path.join(dir, 'executions.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 40000);
});

describe('the /tools row for the recipe route', () => {
  const none: ProbeDeps = {
    env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
    lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map([['run_recipe', '2026-10-09T00:00:00Z']]), edgeSet: () => false, exists: () => false,
  };

  it('is installed or needs setup from TIMMY_CADQUERY_PYTHON alone, and exercised only from a verified success', async () => {
    expect(recipeCapabilityRow({})).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('TIMMY_CADQUERY_PYTHON') });
    expect(recipeCapabilityRow({ TIMMY_CADQUERY_PYTHON: fakePython })).toMatchObject({ rung: 'installed' });
    // A completed run_recipe turn (a submission) does not make the row exercised.
    const rows = await capabilities({ ...none, recipeExercised: () => undefined });
    const row = rows.find((r) => r.id === 'recipe-tray')!;
    expect(row.rung).toBe('needs setup');
    expect(row.exercised).toBeUndefined();
    const used = await capabilities({ ...none, recipeExercised: () => '2026-10-09T01:00:00Z' });
    expect(used.find((r) => r.id === 'recipe-tray')!.exercised).toBe('2026-10-09T01:00:00Z');
  });
});

/**
 * Round R4 (H17), the review of 07f37ec, finding 4: the recipe's watcher cancels it from its SIGTERM handler, which
 * exists only once the watcher's module has loaded. A stop that lands earlier must still reach the durable job: the
 * REPL asks the recipe's own cancel through the operation UUID it kept, before it stops the watcher. Each test stops
 * the watcher within moments of its spawn (Node alone takes far longer to start than that) and checks, from
 * lanes/recipes/jobs.ts status(), that the recipe ends cancelled and that no process naming it is left. FAKE: the
 * recipe runs the SYNTHETIC 'wait' executor, which would finish after 10 s if nothing cancelled it.
 */
describe('an early stop reaches the durable recipe job (the review of 07f37ec, finding 4)', () => {
  /** Waits for the recipe job's own end, and when it was cancelled, for every process naming it to be gone. */
  async function ended(id: string): Promise<string> {
    await until(() => ENDED.has(status(root, id).state), 30000);
    const state = status(root, id).state;
    if (state === 'cancelled') await until(() => processesNaming(id).length === 0, 10000);
    return state;
  }
  /** The FAKE executor ran at most once: nothing was replayed. */
  const ranAtMostOnce = (id: string): void => {
    const file = path.join(jobDirectory(root, id), 'executions.txt');
    if (fs.existsSync(file)) expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  };

  it('/stop right after /recipe tray returns, before the watcher has its SIGTERM handler: the recipe ends cancelled and its FAKE native process is gone', async () => {
    const { ws } = make({ mode: 'wait' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    const job = jobIdIn(out);
    const stopped = text(await ws.stop(job));
    // The watcher died of the signal itself: its own handler never ran, so only the REPL's cancel can have reached the recipe.
    expect(ws.jobs.get(job)).toMatchObject({ state: 'cancelled', signal: 'SIGTERM' });
    expect(ws.jobs.tail(job).join('\n')).not.toContain('stop:');
    expect(await ended(id)).toBe('cancelled');
    expect(processesNaming(id)).toEqual([]);
    expect(stopped).toContain(`${job} cancelled`);
    expect(stopped).toContain(`recipe ${id}: cancel requested through the recipe's own path`);
    expect(fs.existsSync(path.join(jobDirectory(root, id), 'cancel.json'))).toBe(true);
    ranAtMostOnce(id);
  }, 60000);

  it('a SIGTERM sent straight to the watcher before it loads: the REPL sees its watcher end by the signal and cancels the recipe through its own path', async () => {
    const { ws, notes } = make({ mode: 'wait' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    const job = jobIdIn(out);
    let pid: number | undefined;
    while (!(pid = ws.jobs.get(job)?.pid)) await new Promise((r) => setImmediate(r));
    process.kill(pid, 'SIGTERM');
    await until(() => TERMINAL.has(ws.jobs.get(job)?.state ?? ''));
    expect(ws.jobs.get(job)).toMatchObject({ state: 'failed', signal: 'SIGTERM' });
    expect(await ended(id)).toBe('cancelled');
    const notice = notes.join('\n');
    expect(notice).toContain(`${job} recipe ${id}`);
    expect(notice).toContain('cancel requested through the recipe\'s own path');
    ranAtMostOnce(id);
  }, 60000);

  it('the REPL ending right after /recipe tray (Workspace.close): the recipe is cancelled through its own path before its watcher is stopped', async () => {
    const { ws } = make({ mode: 'wait' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    const job = jobIdIn(out);
    await ws.close();
    expect(ws.jobs.get(job)).toMatchObject({ state: 'cancelled', signal: 'SIGTERM' });
    expect(await ended(id)).toBe('cancelled');
    ranAtMostOnce(id);
  }, 60000);

  it('Workspace.killNow (a second Ctrl+C, and the first thing a normal exit runs): the cancel is written before any watcher is signalled', async () => {
    const { ws } = make({ mode: 'wait' });
    const out = text(await ws.recipe('tray'));
    const id = uuidIn(out);
    ws.killNow();
    expect(fs.existsSync(path.join(jobDirectory(root, id), 'cancel.json'))).toBe(true);
    expect(await ended(id)).toBe('cancelled');
    ranAtMostOnce(id);
  }, 60000);

  it('the REPL ending while a recipe is being launched (the agent\'s run_recipe): no watcher starts after it, and the recipe is cancelled through its own path', async () => {
    const { ws } = make({ mode: 'wait' });
    const starting = ws.runRecipe({});
    await ws.close();
    const r = await starting;
    expect(r).toMatchObject({ ok: false, stage: 'start', operation: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    if (r.ok || !r.operation) throw Error('the start should have been refused');
    expect(r.error).toContain('cancel');
    expect(ws.jobs.list()).toEqual([]);
    expect(await ended(r.operation)).toBe('cancelled');
    ranAtMostOnce(r.operation);
  }, 60000);

  it('a recipe whose watcher could not start is cancelled through its own path, and the answer names the command that shows it', async () => {
    const { ws, jobsDir } = make({ mode: 'wait' });
    // The REPL's jobs folder is unusable (a file stands where the folder goes), so the watcher job cannot start.
    fs.writeFileSync(jobsDir, 'not a folder');
    const out = text(await ws.recipe('tray'));
    const id = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/)?.[0];
    if (!id) throw Error(`no recipe job in: ${out}`);
    expect(ws.jobs.list()).toEqual([]);
    expect(await ended(id)).toBe('cancelled');
    expect(out).toContain('its watcher did not start');
    expect(out).toContain('cancel requested through the recipe\'s own path');
    expect(out).toContain('/recipe status');
    ranAtMostOnce(id);
  }, 60000);

  it('a watcher that ended without a signal while its recipe still runs: the notice gives the exact commands, and the recipe is left running', async () => {
    const p = prepareRecipe({}, { root, env: { TIMMY_CADQUERY_PYTHON: fakePython }, executor: fakeExecutor('wait') });
    if (!p.ok) throw Error(p.error);
    const { id } = p.prepared;
    await launchRecipe(root, id, (child) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); });
    const c: RecipeContext = { root, project: 'p', env: {}, glyphs: glyphSet(true), seal: () => undefined, startJob: () => { throw Error('not used'); } };
    // A watcher that exited by itself (exit 5, its status read failed), not by a stop or a signal.
    const watcher = { id: 'j000001', state: 'failed', exitCode: 5, signal: null } as unknown as JobRecord;
    const said = text(recipeEnded(c, watcher, id));
    expect(said).toContain(`j000001 recipe ${id} running`);
    expect(said).toContain(`the recipe still runs: /recipe status follows it; /recipe cancel ${id} cancels it`);
    expect(fs.existsSync(path.join(jobDirectory(root, id), 'cancel.json'))).toBe(false);
    expect(cancel(root, id).progress).toBe('cancellation-requested');
    expect(await ended(id)).toBe('cancelled');
  }, 60000);

  it('a cancel request that fails is said with the exact commands, never as a cancel', () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const a = cancelRecipe(root, missing);
    expect(a).toMatchObject({ operation: missing, requested: false, error: expect.any(String) });
    expect(cancelSentence(a)).toContain(`/recipe status shows it; /recipe cancel ${missing} asks again`);
    const unfollowed = cancelUnfollowed(root, missing, 'its watcher did not start (FAKE reason)');
    expect(unfollowed).toContain('the cancel request failed');
    expect(unfollowed).toContain(`it may still be running: /recipe status shows it, /recipe cancel ${missing} cancels it`);
    expect(unfollowed).not.toContain('cancel requested');
  });
});

/**
 * Round R4 (H17), the review of 07f37ec, M3: verification and delivery consume one verified snapshot. The seam
 * (vi.spyOn on fs.readFileSync, which jobs.ts and src/recipes read through) lets the first read of the signed result,
 * the job's receipt store, one export and the native result see their real bytes, and every later read see changed
 * ones: the files changed on disk right after a verification read them. Delivery and the copy check must copy and
 * report only what that verification read. FAKE: the SYNTHETIC 'complete' executor; no watcher runs here, so
 * nothing is copied before the call under test.
 */
describe('delivery consumes one verified snapshot (the review of 07f37ec, M3)', () => {
  async function succeeded(): Promise<{ id: string; dir: string; base: string }> {
    const p = prepareRecipe({}, { root, env: { TIMMY_CADQUERY_PYTHON: fakePython }, executor: fakeExecutor('complete') });
    if (!p.ok) throw Error(p.error);
    const { id } = p.prepared;
    await launchRecipe(root, id, (child) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); });
    await until(() => status(root, id).state === 'succeeded');
    const dir = jobDirectory(root, id);
    const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    return { id, dir, base: path.join(dir, 'workspace', '.timmy', 'recipe-runs', envelope.result.run) };
  }

  it('the result and its receipt changing after their verification read: delivery and the copy check use only the verified bytes, reading each file once', async () => {
    const { id, dir, base } = await succeeded();
    const resultFile = path.join(dir, 'result.json');
    const runsFile = path.join(dir, 'workspace', '.timmy', 'receipts', 'runs.jsonl');
    const outer = path.join(base, 'native', 'outer.stl');
    const nativeResult = path.join(base, 'native', 'result.json');
    const verifiedOuter = fs.readFileSync(outer);
    // The changed files: a forged export and native result, and the signed result and the build receipt with their
    // recorded sha256 values pointed at those forged bytes (neither re-signed, as a tampering writer would leave them).
    const forgedOuter = Buffer.from('FORGED after the verification read; not the verified bytes');
    const native = JSON.parse(fs.readFileSync(nativeResult, 'utf8'));
    native.variant.measured.bounds = [999, 999, 999];
    const forgedNative = Buffer.from(JSON.stringify(native));
    const envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    envelope.result.exports = envelope.result.exports.map((e: { file: string; sha256: string }) => (e.file === 'outer.stl' ? { ...e, sha256: sha(forgedOuter) } : e));
    const receipts = fs.readFileSync(runsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const forgedRuns = receipts.map((r: { kind: string; sources: Array<{ path: string; sha256: string }> }) => (r.kind !== 'recipe.build' ? r : {
      ...r, sources: r.sources.map((s) => (s.path === outer ? { ...s, sha256: sha(forgedOuter) } : s.path === nativeResult ? { ...s, sha256: sha(forgedNative) } : s)),
    })).map((r: unknown) => JSON.stringify(r)).join('\n') + '\n';
    const later = new Map<string, Buffer>([[resultFile, Buffer.from(JSON.stringify(envelope))], [runsFile, Buffer.from(forgedRuns)], [outer, forgedOuter], [nativeResult, forgedNative]]);
    const reads = new Map<string, number>();
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (typeof file === 'string' && later.has(file)) {
        const n = (reads.get(file) ?? 0) + 1;
        reads.set(file, n);
        if (n > 1) {
          const changed = later.get(file)!;
          const encoding = typeof options === 'string' ? options : (options as { encoding?: BufferEncoding } | undefined)?.encoding;
          return encoding ? changed.toString(encoding) : Buffer.from(changed);
        }
      }
      return real(file as never, options as never);
    }) as typeof fs.readFileSync);

    const d = deliver(root, id);
    const deliverReads = new Map(reads);
    reads.clear();
    const copy = checkCopy(root, id);
    const copyReads = new Map(reads);
    vi.restoreAllMocks();

    if (!d.ok) throw Error(`delivery refused: ${d.error}`);
    const dest = path.join(root, 'out', 'recipes', id.slice(0, 8));
    expect(sha(fs.readFileSync(path.join(dest, 'outer.stl')))).toBe(sha(verifiedOuter));
    expect(d.files.find((f) => f.path.endsWith('/outer.stl'))?.sha256).toBe(sha(verifiedOuter));
    const said = outcomeLines(d.v, d.dir).join('\n');
    expect(said).toContain('Bounds 140 x 80 x 30 mm measured');
    expect(said).not.toContain('999');
    // The copy check (what the REPL's notice and /recipe status show) reads the same way and finds the copy whole.
    if (!copy.ok) throw Error(`the copy check failed: ${copy.error}`);
    expect(outcomeLines(copy.v, copy.dir).join('\n')).toContain('Bounds 140 x 80 x 30 mm measured');
    // Each of the four was read once, by the verification, and never again.
    for (const file of later.keys()) expect([file, deliverReads.get(file)]).toEqual([file, 1]);
    for (const file of later.keys()) expect([file, copyReads.get(file)]).toEqual([file, 1]);
  }, 60000);

  it('a copy that changes under us is refused; what this call wrote is removed again, and the changed file is left as it was found', async () => {
    const { id } = await succeeded();
    const dest = path.join(root, 'out', 'recipes', id.slice(0, 8));
    const step = path.join(dest, 'console-tray.step');
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      realWrite(file, data, options);
      // Another writer changes the copy between this call's write and its read-back.
      if (file === step) realWrite(step, 'CHANGED UNDER US by another writer');
    }) as typeof fs.writeFileSync);
    const d = deliver(root, id);
    vi.restoreAllMocks();
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error).toContain('console-tray.step');
    expect(d.error).toContain('reads back with a different sha256');
    expect(fs.readdirSync(dest)).toEqual(['console-tray.step']);
    expect(fs.readFileSync(step, 'utf8')).toBe('CHANGED UNDER US by another writer');
  }, 60000);
});
