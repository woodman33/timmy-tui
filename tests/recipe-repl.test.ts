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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { ReceiptInput } from '../src/utils/receipts.js';
import { sha } from '../lanes/recipes/tray.js';
import { jobDirectory, status } from '../lanes/recipes/jobs.js';
import { DOCTRINE_15, EXPORTS, recipeCapabilityRow, recipeExercisedAt } from '../src/recipes/index.js';
import { capabilities, type ProbeDeps } from '../src/capabilities/index.js';

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
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: o.python === false ? {} : { TIMMY_CADQUERY_PYTHON: fakePython },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { if (o.sealFails) return undefined; sealed.push(input); return `id${sealed.length}`; },
    jobsDir: path.join(fs.mkdtempSync(path.join(fixtures, 'jobs-')), 'jobs'),
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
  return { ws, notes, sealed };
}

const jobIdIn = (out: string): string => { const m = out.match(/Running\s+(j[0-9a-f]{6})/); if (!m) throw Error(`no job in: ${out}`); return m[1]; };
const uuidIn = (out: string): string => { const m = out.match(/Recipe job\s+([0-9a-f-]{36})/); if (!m) throw Error(`no recipe job in: ${out}`); return m[1]; };
async function until(pred: () => boolean, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}
const recipeJobs = (): string[] => { try { return fs.readdirSync(path.join(root, '.timmy', 'recipe-jobs')); } catch { return []; } };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-repl-project-'));
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-repl-fixtures-'));
  fakePython = path.join(fixtures, 'fake-python');
  fs.writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  supervisors = [];
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  await Promise.race([Promise.all(supervisors), new Promise((r) => setTimeout(r, 15000))]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
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
    const recovered = text(await again.ws.recipe(`recover ${id}`));
    expect(recovered).toContain(`${id} cancelled`);
    expect(recovered).toContain('nothing changed');
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
