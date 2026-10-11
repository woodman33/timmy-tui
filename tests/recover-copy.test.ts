/**
 * Round R4, the review's R4-8: a recipe's copy (out/recipes/<uuid8>/) is never partial because a copy was cut short, and
 * recovery checks a copy file by file (checkCopy) instead of taking the folder's existence as "delivered".
 *
 * - deliver() writes a new copy in a folder of its own beside that one and renames it into place only once every file
 *   reads back with its verified sha256; a copy that fails partway leaves no out/recipes/<uuid8>/;
 * - a partial or an empty out/recipes/<uuid8>/ (what a copy cut short by an older Timmy, or by a crash, leaves) is
 *   reported at the next start and on /recover as "the copy of <uuid> is incomplete: /recipe copy <uuid>"; nothing in it
 *   is deleted, nothing is delivered over it; /recipe copy then completes it.
 *
 * FAKE pieces, each labelled: the recipe runs through the jobs.ts executor seam with a SYNTHETIC fixture executor (as in
 * tests/recover.test.ts and tests/recipe-repl.test.ts: labelled files and signed receipts, no CadQuery);
 * TIMMY_CADQUERY_PYTHON names a FAKE file that is never executed. SYNTHETIC durable state written by the test, labelled
 * where it is written: a crashed session's watcher record, and the partial copies. A failed write is simulated with
 * vi.spyOn on fs.writeFileSync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { status } from '../lanes/recipes/jobs.js';
import { checkCopy, deliver, EXPORTS, launchRecipe, prepareRecipe, verifiedResult, watcherSpec } from '../src/recipes/index.js';

/** What a delivery copies into out/recipes/<uuid8>/: the five exports and three records. */
const COPIED = [...EXPORTS, 'prediction.json', 'report.json', 'request.json'].sort();

let root: string;
let fixtures: string;
let fakePython: string;
let jobsDir: string;
let supervisors: Promise<void>[] = [];
const spaces: Workspace[] = [];
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}

/** The SYNTHETIC fixture executor of tests/recipe-repl.test.ts ('complete'): labelled files, signed receipts, no geometry. */
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
fs.appendFileSync(path.join(dir,'executions.txt'),'fake execution\\n');
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

/** A recipe job that has succeeded (the SYNTHETIC executor), with nothing copied yet. */
async function succeeded(): Promise<string> {
  const p = prepareRecipe({}, { root, env: { TIMMY_CADQUERY_PYTHON: fakePython }, executor: fakeExecutor() });
  if (!p.ok) throw new Error(p.error);
  const uuid = p.prepared.id;
  await launchRecipe(root, uuid, (child: ChildProcess) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); });
  await until('the recipe to succeed', () => status(root, uuid).state === 'succeeded');
  return uuid;
}

/** SYNTHETIC: what a crashed session's job manager leaves for the recipe's watcher: its record, running, its process gone. */
function staleWatcher(uuid: string): void {
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const spec = watcherSpec({ root, id: uuid, label: `recipe enclosure.tray/1 ${uuid}`, project: 'demo' });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, 'j0dead1.json'), JSON.stringify({ id: 'j0dead1', kind: 'task', label: spec.label, project: 'demo', root, command: spec.command, args: spec.args, state: 'running', pid: gone, startedAt: new Date(Date.now() - 60_000).toISOString(), steps: [], lines: 0 }));
}

/** Every file in a folder (names sorted) and its bytes. */
const contents = (dir: string): Array<[string, string]> => fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]);

function make() {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: { TIMMY_CADQUERY_PYTHON: fakePython },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir,
    chdir: () => {},
    receipts: () => sealed as unknown as Receipt[],
    // FAKE: a fast watcher poll (no watcher is started by these tests unless recovery follows a recipe).
    recipeTest: { pollMs: 100 },
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-copy-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-copy-fixtures-')));
  jobsDir = path.join(fixtures, 'jobs');
  fakePython = path.join(fixtures, 'fake-python');
  fs.writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  supervisors = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of spaces.splice(0)) await w.close();
  await Promise.race([Promise.all(supervisors), sleep(20_000)]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60_000);

describe('deliver: a new copy takes its folder\'s name only when it is whole', () => {
  it('every file is written and checked in a folder beside out/recipes/<uuid8>/, which appears only after the last one', async () => {
    const uuid = await succeeded();
    const recipes = path.join(root, 'out', 'recipes');
    const dest = path.join(recipes, uuid.slice(0, 8));
    const real = fs.writeFileSync;
    const writes: Array<{ dir: string; destThere: boolean }> = [];
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (typeof file === 'string' && file.startsWith(recipes + path.sep)) writes.push({ dir: path.dirname(file), destThere: fs.existsSync(dest) });
      return real(file, data, options);
    }) as typeof fs.writeFileSync);
    const d = deliver(root, uuid);
    vi.restoreAllMocks();
    if (!d.ok) throw new Error(`delivery refused: ${d.error}`);
    expect(writes).toHaveLength(COPIED.length);
    for (const w of writes) {
      expect(w.destThere).toBe(false);
      expect(path.dirname(w.dir)).toBe(recipes);
      expect(path.basename(w.dir)).toMatch(new RegExp(`^\\.${uuid.slice(0, 8)}\\.`));
    }
    // Whole, under its name; nothing else left beside it; its folder's mode is a plain mkdir's (the umask's), as before.
    expect(fs.readdirSync(recipes)).toEqual([uuid.slice(0, 8)]);
    expect(fs.readdirSync(dest).sort()).toEqual(COPIED);
    const probe = path.join(fixtures, 'mode-probe');
    fs.mkdirSync(probe);
    expect(fs.statSync(dest).mode & 0o777).toBe(fs.statSync(probe).mode & 0o777);
    expect(checkCopy(root, uuid).ok).toBe(true);
    expect(d.files.map((f) => f.path).sort()).toEqual(COPIED.map((n) => `out/recipes/${uuid.slice(0, 8)}/${n}`));
  }, 60_000);

  it('a copy that fails partway (a write refused: no space left) leaves no out/recipes/<uuid8>/ and no folder of its own', async () => {
    const uuid = await succeeded();
    const recipes = path.join(root, 'out', 'recipes');
    const real = fs.writeFileSync;
    let n = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      // FAKE: the disk fills up at the third file of the copy.
      if (typeof file === 'string' && file.startsWith(recipes + path.sep) && ++n === 3) throw Object.assign(new Error('ENOSPC: no space left on device (simulated by the test)'), { code: 'ENOSPC' });
      return real(file, data, options);
    }) as typeof fs.writeFileSync);
    const d = deliver(root, uuid);
    vi.restoreAllMocks();
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error).toContain('ENOSPC');
    expect(d.error).toContain('nothing kept from this copy (2 written, 2 removed again)');
    expect(fs.existsSync(path.join(recipes, uuid.slice(0, 8)))).toBe(false);
    expect(fs.readdirSync(recipes)).toEqual([]);
    // The next copy is whole.
    expect(deliver(root, uuid).ok).toBe(true);
    expect(checkCopy(root, uuid).ok).toBe(true);
  }, 60_000);
});

describe('recovery checks a copy file by file, never by its folder alone', () => {
  for (const kind of ['partial', 'empty'] as const) {
    it(`${kind === 'empty' ? 'an' : 'a'} ${kind} copy beside a recipe whose watcher's session ended: "the copy … is incomplete: /recipe copy …" at the start and on /recover; nothing deleted or delivered; /recipe copy completes it`, async () => {
      const uuid = await succeeded();
      staleWatcher(uuid);
      const v = verifiedResult(root, uuid);
      if (!v.ok) throw new Error(v.error);
      // SYNTHETIC: a copy cut short (an older Timmy's deliver made the folder first): two of its files, or none.
      const dest = path.join(root, 'out', 'recipes', uuid.slice(0, 8));
      fs.mkdirSync(dest, { recursive: true });
      if (kind === 'partial') for (const f of v.v.files.slice(0, 2)) fs.writeFileSync(path.join(dest, f.name), f.bytes);
      const before = contents(dest);
      const missing = v.v.files[kind === 'partial' ? 2 : 0].name;

      const { ws, notes, sealed } = make();
      const report = (await ws.startRecovery)!;
      expect(report.items).toEqual([expect.objectContaining({ kind: 'recipe', id: uuid, did: 'incomplete', text: `the copy of ${uuid} is incomplete: /recipe copy ${uuid}` })]);
      expect(notes[0]).toBe('  Recovered  1 recipe copy is incomplete: /recipe copy');
      const said = notes.join('\n');
      expect(said).toContain(`the copy of ${uuid} is incomplete: /recipe copy ${uuid}`);
      expect(said).toContain(`out/recipes/${uuid.slice(0, 8)}/${missing} is missing; nothing in out/recipes/${uuid.slice(0, 8)}/ was deleted or replaced`);
      expect(said).not.toContain(root);
      // Nothing deleted, nothing written, nothing sealed.
      expect(contents(dest)).toEqual(before);
      expect(sealed).toEqual([]);
      // /recover says it again, and still changes nothing.
      expect(text(await ws.recover(''))).toContain(`the copy of ${uuid} is incomplete: /recipe copy ${uuid}`);
      expect(contents(dest)).toEqual(before);
      expect(sealed).toEqual([]);

      // /recipe copy completes it in place: the files already there kept, the missing ones written whole.
      expect(text(await ws.recipe(`copy ${uuid}`))).toContain(`Recipe ${uuid} succeeded`);
      expect(fs.readdirSync(dest).sort()).toEqual(COPIED);
      for (const [name, body] of before) expect(fs.readFileSync(path.join(dest, name), 'utf8')).toBe(body);
      expect(checkCopy(root, uuid).ok).toBe(true);
      // Now the copy is whole: recovery has nothing to say about it.
      expect(text(await ws.recover(''))).toContain('nothing to pick up');
    }, 90_000);
  }
});
