/**
 * Round R4 (H75): Timmy Canvas's drawn cards act through the REPL that holds the project, never in the canvas server. Over real
 * HTTP to a real canvas server on 127.0.0.1, with a real Workspace (the REPL's side: tests/fixtures/fake-upmd.mjs, a labelled
 * TEST DOUBLE of upmd 0.2.7, for /run; a FAKE recipe executor for /recipe tray: SYNTHETIC files and signed receipts, no
 * CadQuery) and a real CanvasProject asking the server for actions. Receipts are sealed by appendReceipt into a temporary store.
 *
 * Checked: every page route is refused without the session, with a wrong one, from another page or host, not as JSON, too
 * large or of another shape, and nothing changed (the parameter file's bytes, the receipts, the jobs); the REPL's routes are
 * refused to a page and without the token; a grant is good once; a card's save goes through the live board's save path (the
 * file guard, the previous version kept, a human-gated edit receipt that names Timmy Canvas); Run and Rebuild run as the
 * REPL's own jobs (a real job record, its outcome receipt) and the project's cards then say so; no answer holds a path.
 */
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { status as recipeStatus } from '../lanes/recipes/jobs.js';
import { EXPORTS } from '../src/recipes/index.js';
import { folderProject, projectId } from '../src/project/index.js';
import { CanvasProject } from '../src/repl/canvas-project.js';
import { Workspace } from '../src/repl/workspace.js';
import { CardRelay } from '../src/studio/card-relay.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { makeCanvasProject, type CanvasProject as Fixture } from './helpers/canvas-project.js';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
/** A document upmd runs (the shared fixture's BUILD.md is for reading, not running): two blocks, the second needing the first. */
const F = '```';
const RUN_DOC = ['# Make', '', 'Prose that stays.', '', `${F}bash [name:setup]`, 'mkdir -p dist', F, '', `${F}bash [name:build, deps:setup]`, 'echo built > dist/out.txt', F, ''].join('\n');
const temps: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
const closers: Array<() => Promise<void> | void> = [];
let supervisors: Promise<void>[] = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  await Promise.race([Promise.all(supervisors), new Promise((r) => setTimeout(r, 15000))]);
  supervisors = [];
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until<T>(f: () => T | Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A FAKE recipe executor (the jobs.ts seam, as tests/board-edits.test.ts writes it): SYNTHETIC files, signed receipts, no geometry. */
function fakeExecutor(dir: string): string {
  const file = join(dir, 'fake-recipe-complete.mts');
  const mod = (name: string) => JSON.stringify(pathToFileURL(resolve(name)).href);
  writeFileSync(file, `
// FAKE recipe executor (test fixture): SYNTHETIC files only; no CadQuery, no Open3D, no Python.
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${mod('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${mod('src/utils/receipts.ts')};
import {sha,prediction,validate} from ${mod('lanes/recipes/tray.ts')};
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

interface Reply { status: number; body: string; json: Record<string, unknown> }

interface World {
  p: Fixture;
  ws: Workspace;
  server: StudioServer;
  port: number;
  base: string;
  cp: CanvasProject;
  store: string;
  notes: string[];
  jobs: string;
  call: (method: string, path: string, o?: { headers?: Record<string, string>; body?: string }) => Promise<Reply>;
  receipts: () => Array<Record<string, unknown>>;
}

async function world(o: { listen?: boolean } = {}): Promise<World> {
  const p = await makeCanvasProject('card-relay-');
  temps.push(p.base);
  p.write('RUN.md', RUN_DOC);
  const home = temp('card-relay-home-');
  const storeBase = temp('card-relay-store-');
  const store = join(storeBase, '.timmy', 'receipts');
  const fixtures = temp('card-relay-fixtures-');
  const fakePython = join(fixtures, 'fake-python');
  writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  const jobs = join(temp('card-relay-jobs-'), 'jobs');
  const notes: string[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs'), TIMMY_CADQUERY_PYTHON: fakePython },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => `Open ${url} in your browser.`,
    link: (t) => t,
    // Real receipts, into a store of this test's own (its keys there too).
    seal: (input) => appendReceipt('runs', input, storeBase).hash.slice(7, 15),
    receipts: () => { try { return readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    jobsDir: jobs,
    chdir: () => {},
    recipeTest: { executor: fakeExecutor(fixtures), pollMs: 100, onSupervisor: (child: ChildProcess) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); } },
  }, folderProject(p.root));
  closers.push(() => ws.close());
  const server = await startStudioServer(0, { env: { TIMMY_HOME: home } });
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const cp = new CanvasProject({
    base: () => base, env: { TIMMY_HOME: home }, project: () => ws.project, projectId,
    jobsDir: jobs, receipts: () => store, board: () => null, ownToken: () => server.projectToken,
    ...(o.listen === false ? {} : { act: (e: unknown) => ws.canvasAct(e) }), pollMs: 30_000,
  });
  closers.push(() => cp.stop());
  const call = (method: string, path: string, x: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> => new Promise((done, fail) => {
    const headers = { Host: `127.0.0.1:${port}`, ...(x.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(x.body)) } : {}), ...x.headers };
    const req = request({ host: '127.0.0.1', port, method, path, headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => { let json: Record<string, unknown> = {}; try { json = JSON.parse(body) as Record<string, unknown>; } catch { /* not JSON */ } done({ status: res.statusCode ?? 0, body, json }); });
    });
    req.on('error', fail);
    if (x.body !== undefined) req.write(x.body);
    req.end();
  });
  const receipts = (): Array<Record<string, unknown>> => { try { return readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; } };
  return { p, ws, server, port, base, cp, store, notes, jobs, call, receipts };
}

const page = (w: World, extra: Record<string, string> = {}): Record<string, string> => ({ Origin: `http://127.0.0.1:${w.port}`, 'Content-Type': 'application/json', ...extra });
async function session(w: World): Promise<string> {
  const told = await w.cp.handOff({ grant: true });
  expect(told).toEqual({ ok: true, name: 'demo' });
  // The board's canvas line says the cards act through this REPL.
  expect(w.cp.boardLine().words).toBe('Timmy Canvas shows this project; no canvas page is open. Its cards\' Run, Save and Rebuild act through this REPL.');
  const t = w.cp.openTarget();
  expect(t.secret).toBe(true);
  const grant = /#code=([0-9a-f]{32})$/.exec(t.target)![1];
  const r = await w.call('POST', '/api/project/session', { headers: page(w), body: JSON.stringify({ grant }) });
  expect(r.status).toBe(200);
  expect(String(r.json.token)).toMatch(/^[0-9a-f]{64}$/);
  // A grant is good once.
  expect((await w.call('POST', '/api/project/session', { headers: page(w), body: JSON.stringify({ grant }) })).status).toBe(403);
  return String(r.json.token);
}
const act = (w: World, token: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  w.call('POST', '/api/project/act', { headers: page(w, { Authorization: `Bearer ${token}`, ...headers }), body: typeof body === 'string' ? body : JSON.stringify(body) });
const TRAY = 'recipes/tray.params.json';
const trayFile = (w: World): Buffer => readFileSync(join(w.p.root, TRAY));
const jobFiles = (w: World): string[] => (existsSync(w.jobs) ? readdirSync(w.jobs) : []);

describe("Timmy Canvas's card actions: carried to the REPL that holds the project, refused otherwise", () => {
  it('refuses a page action without the session, with a wrong one, from another page or host, not as JSON, too large, of another shape, or for another project, and nothing changes', async () => {
    const w = await world();
    const token = await session(w);
    const before = { tray: trayFile(w), receipts: w.receipts().length, jobs: jobFiles(w) };
    const save = { project: w.p.pid, card: `params:${TRAY}`, act: { action: 'set-params', recipe: 'tray', base: sha(before.tray), parameters: { width: 150, wall: 3, supportOffset: 10, bore: 3 } } };
    const cases: Array<[string, Promise<Reply>, number]> = [
      ['no session', w.call('POST', '/api/project/act', { headers: page(w), body: JSON.stringify(save) }), 401],
      ['a wrong session', act(w, 'f'.repeat(64), save), 401],
      ['the project token as a session', act(w, w.server.projectToken, save), 401],
      ['a malformed session', act(w, token.slice(1), save), 401],
      ['another site', act(w, token, save, { Origin: 'http://evil.example' }), 403],
      ['another page on this machine', act(w, token, save, { Origin: 'http://127.0.0.1:5173' }), 403],
      ['no Origin (not a page)', w.call('POST', '/api/project/act', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(save) }), 403],
      ['a rebound name', act(w, token, save, { Host: `evil.example:${w.port}` }), 403],
      ['another port', act(w, token, save, { Host: `127.0.0.1:${w.port + 1}`, Origin: `http://127.0.0.1:${w.port + 1}` }), 403],
      ['text/plain', act(w, token, JSON.stringify(save), { 'Content-Type': 'text/plain' }), 415],
      ['too large', act(w, token, { ...save, act: { ...save.act, pad: 'x'.repeat(40_000) } }), 413],
      ['not JSON', act(w, token, '{"project": '), 400],
      ['an extra key', act(w, token, { ...save, path: '/etc/passwd' }), 400],
      ['a board action no card sends (stop)', act(w, token, { ...save, act: { action: 'stop', job: 'x' } }), 400],
      ['a board action no card sends (restore)', act(w, token, { ...save, act: { action: 'restore', file: TRAY, from: 'x' } }), 400],
      ['Run on a parameter card', act(w, token, { ...save, act: { action: 'run', doc: 'BUILD.md', block: 'render' } }), 400],
      ['a save of another file than its card', act(w, token, { ...save, card: 'params:box.params.json' }), 400],
      ['another project', act(w, token, { ...save, project: 'ffffffffffffffff' }), 409],
    ];
    for (const [what, pending, status] of cases) {
      const r = await pending;
      expect(r.status, what).toBe(status);
      expect(r.body, what).not.toContain(w.p.root);
      expect(r.body, what).not.toContain(token);
    }
    expect(trayFile(w)).toEqual(before.tray);
    expect(w.receipts().length).toBe(before.receipts);
    expect(jobFiles(w)).toEqual(before.jobs);
    expect(w.notes).toEqual([]);
  }, 60_000);

  it("refuses the REPL's routes to a page and without the token, a grant to anyone but the REPL, and a holder that is not the project's", async () => {
    const w = await world({ listen: false });
    expect((await w.call('POST', '/api/project/grant')).status).toBe(401);
    expect((await w.call('POST', '/api/project/grant', { headers: { Authorization: `Bearer ${w.server.projectToken}`, Origin: `http://127.0.0.1:${w.port}` } })).status).toBe(403);
    const ok = await w.call('POST', '/api/project/grant', { headers: { Authorization: `Bearer ${w.server.projectToken}` } });
    expect(ok.status).toBe(200);
    // A grant this server never made, a malformed one, and one sent from another page: no session.
    expect((await w.call('POST', '/api/project/session', { headers: page(w), body: JSON.stringify({ grant: 'a'.repeat(32) }) })).status).toBe(403);
    expect((await w.call('POST', '/api/project/session', { headers: page(w), body: JSON.stringify({ grant: 'not hex' }) })).status).toBe(400);
    expect((await w.call('POST', '/api/project/session', { headers: page(w, { Origin: 'http://127.0.0.1:5173' }), body: JSON.stringify({ grant: ok.json.grant }) })).status).toBe(403);
    // The inbox: the REPL's token, no Origin, the named project's holder only.
    expect(await w.cp.handOff()).toEqual({ ok: true, name: 'demo' });
    const holder = 'a'.repeat(32);
    expect((await w.call('GET', `/api/project/inbox?holder=${holder}`)).status).toBe(401);
    expect((await w.call('GET', `/api/project/inbox?holder=${holder}`, { headers: { Authorization: `Bearer ${w.server.projectToken}`, Origin: `http://127.0.0.1:${w.port}` } })).status).toBe(403);
    expect((await w.call('GET', '/api/project/inbox?holder=xyz', { headers: { Authorization: `Bearer ${w.server.projectToken}` } })).status).toBe(400);
    // This REPL took no actions (no act): the project has no holder, so no one is given its actions.
    expect((await w.call('GET', `/api/project/inbox?holder=${holder}`, { headers: { Authorization: `Bearer ${w.server.projectToken}` } })).status).toBe(409);
    expect((await w.call('POST', `/api/project/inbox/${'0'.repeat(8)}-0000-4000-8000-000000000000`, { headers: { Authorization: `Bearer ${w.server.projectToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ holder, status: 200, text: 'x' }) })).status).toBe(404);
    // The project's reading says no REPL takes its actions, in words.
    const read = await w.call('GET', '/api/project?detail=1');
    expect(read.json.actions).toMatchObject({ holder: false });
    expect(String((read.json.actions as { words: string }).words)).toMatch(/does not take card actions/);
  }, 60_000);

  it('with no REPL taking the actions, a page action is refused with what to type, and nothing changes', async () => {
    const w = await world();
    const token = await session(w);
    // The REPL stops asking (it ends): after its last ask the canvas waits for it, then says no REPL takes the actions.
    w.cp.stop();
    const before = { tray: trayFile(w), receipts: w.receipts().length };
    const r = await until(() => act(w, token, { project: w.p.pid, card: 'workflow:BUILD.md', act: { action: 'run', doc: 'BUILD.md', block: 'render' } }), (x) => x.status !== 200, 60_000);
    expect([503]).toContain(r.status);
    expect(String(r.json.error ?? r.json.text)).toMatch(/nothing was run/);
    expect(trayFile(w)).toEqual(before.tray);
    expect(w.receipts().length).toBe(before.receipts);
    expect(jobFiles(w)).toEqual([]);
  }, 90_000);

  it("a card's save goes through the live board's save path: checked, the previous version kept, a human-gated edit receipt naming Timmy Canvas", async () => {
    const w = await world();
    const token = await session(w);
    const was = trayFile(w);
    const values = { width: 150, wall: 3, supportOffset: 10, bore: 3 };
    // A value the recipe refuses: refused by the REPL, nothing written.
    const bad = await act(w, token, { project: w.p.pid, card: `params:${TRAY}`, act: { action: 'set-params', recipe: 'tray', base: sha(was), parameters: { ...values, bore: 50 } } });
    expect(bad.status).toBe(422);
    expect(bad.json.text).toMatch(/^Refused: .*Nothing was written/);
    expect(trayFile(w)).toEqual(was);
    // A save over a file that changed since the card was drawn: refused, nothing written.
    const stale = await act(w, token, { project: w.p.pid, card: `params:${TRAY}`, act: { action: 'set-params', recipe: 'tray', base: 'ab'.repeat(32), parameters: values } });
    expect(stale.status).toBe(409);
    expect(stale.json.text).toMatch(/changed since the board showed it/);
    // The save.
    const r = await act(w, token, { project: w.p.pid, card: `params:${TRAY}`, act: { action: 'set-params', recipe: 'tray', base: sha(was), parameters: values } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.text).toMatch(/^Saved recipes\/tray\.params\.json: width 145 → 150, wall 3, supportOffset 10, bore 3 \(mm\)\. sha256 [0-9a-f]{12}; the previous version is kept at \.timmy\/params-history\/tray\/[^ ]+; receipt [0-9a-f]{8}\./);
    expect(JSON.parse(trayFile(w).toString()).parameters).toEqual(values);
    const edit = w.receipts().find((x) => x.kind === 'edit')!;
    expect(edit).toMatchObject({ kind: 'edit', policy: 'human-gated', status: 'ok', subject: `edit · ${TRAY} · parameters from Timmy Canvas (the live board's save path)`, project_id: w.p.pid });
    expect((edit.files as Array<Record<string, unknown>>)[0]).toMatchObject({ path: TRAY, sha256: sha(trayFile(w)), previous_sha256: sha(was) });
    // The kept previous version holds exactly the bytes that were there.
    const kept = /kept at (\.timmy\/params-history\/tray\/\S+?);/.exec(String(r.json.text))![1];
    expect(readFileSync(join(w.p.root, kept))).toEqual(was);
    // The transcript says the canvas sent it.
    expect(w.notes.some((n) => n.startsWith('  canvas  saved recipes/tray.params.json: width 145 → 150'))).toBe(true);
    // The card shows the saved file.
    const read = await w.call('GET', '/api/project?detail=1');
    const card = (read.json.cards as Array<{ id: string; detail: Record<string, unknown> }>).find((c) => c.id === `params:${TRAY}`)!;
    expect(card.detail).toMatchObject({ type: 'params', engine: 'tray', state: 'ok', base: sha(trayFile(w)), rebuild: true, save: { offered: true } });
    expect(read.body).not.toContain(w.p.root);
    expect(read.body).not.toContain(homedir());
  }, 60_000);

  it("a workflow card's Run runs as the REPL's own job (test-double upmd): a real job record and its outcome receipt, and the card follows them", async () => {
    const w = await world();
    const token = await session(w);
    const r = await act(w, token, { project: w.p.pid, card: 'workflow:RUN.md', act: { action: 'run', doc: 'RUN.md', block: 'build' } });
    expect(r.status).toBe(200);
    expect(String(r.json.text).split('\n')[0]).toBe('canvas /run RUN.md build');
    expect(w.notes[0]).toBe('  canvas  /run RUN.md build');
    // A real job record of this REPL, ended, with its outcome receipt.
    const job = await until(() => w.ws.jobs.list().find((j) => j.kind === 'workflow'), (j) => !!j && ['completed', 'failed', 'cancelled'].includes(j.state), 30_000);
    expect(job!.state, JSON.stringify({ error: job!.error, steps: job!.steps, log: w.notes })).toBe('completed');
    expect(jobFiles(w).some((f) => f.startsWith(job!.id))).toBe(true);
    const outcome = await until(() => w.receipts().find((x) => x.kind === 'workflow' && (x.job as { id?: string } | undefined)?.id === job!.id), (x) => !!x, 10_000);
    const short = String(outcome!.hash).slice(7, 15);
    // The project's card follows the records: its newest run, each block's state, its receipt.
    const read = await until(() => w.call('GET', '/api/project?detail=1'), (x) => {
      const c = (x.json.cards as Array<{ id: string; detail?: { last?: { receipt?: string } } }> | undefined)?.find((y) => y.id === 'workflow:RUN.md');
      return c?.detail?.last?.receipt === short;
    }, 10_000);
    const card = (read.json.cards as Array<{ id: string; detail: { last: Record<string, unknown>; blocks: Array<Record<string, unknown>>; running: boolean } }>).find((c) => c.id === 'workflow:RUN.md')!;
    expect(card.detail.last).toMatchObject({ job: job!.id, target: 'build', word: 'completed', receipt: short });
    expect(card.detail.blocks.map((b) => [b.name, b.word])).toEqual([['setup', 'completed'], ['build', 'completed']]);
    expect(readFileSync(join(w.p.root, 'dist/out.txt'), 'utf8')).toBe('built\n');
    expect(card.detail.running).toBe(false);
    expect(read.body).not.toContain(w.p.root);
  }, 60_000);

  it("a parameter card's Rebuild runs the REPL's /recipe tray (FAKE executor): a recipe job, its receipts, and the card's newest build", async () => {
    const w = await world();
    const token = await session(w);
    const r = await act(w, token, { project: w.p.pid, card: `params:${TRAY}`, act: { action: 'rebuild', recipe: 'tray' } });
    expect(r.status).toBe(200);
    expect(String(r.json.text).split('\n')[0]).toBe('canvas /recipe tray');
    const id = /Recipe job\s+([0-9a-f-]{36})/.exec(String(r.json.text))![1];
    await until(() => recipeStatus(w.p.root, id).state, (s) => s === 'succeeded', 30_000);
    const read = await until(() => w.call('GET', '/api/project?detail=1'), (x) => {
      const c = (x.json.cards as Array<{ id: string; detail?: { build?: { word?: string } } }> | undefined)?.find((y) => y.id === `params:${TRAY}`);
      return c?.detail?.build?.word === 'succeeded';
    }, 15_000);
    const card = (read.json.cards as Array<{ id: string; detail: { build: Record<string, unknown> } }>).find((c) => c.id === `params:${TRAY}`)!;
    expect(card.detail.build).toMatchObject({ title: `recipe enclosure.tray/1 · ${id.slice(0, 8)}`, word: 'succeeded' });
    expect(read.body).not.toContain(w.p.root);
  }, 60_000);

  it('the REPL refuses an action for another project, an act no card sends, and one that does not fit its card, even when the canvas server is not asked', async () => {
    const w = await world({ listen: false });
    const before = { tray: trayFile(w), receipts: w.receipts().length };
    const pid = projectId(w.p.root);
    expect(await w.ws.canvasAct({ id: 'x', project: 'ffffffffffffffff', card: 'workflow:BUILD.md', act: { action: 'run', doc: 'BUILD.md', block: 'render' } })).toMatchObject({ status: 409 });
    expect(await w.ws.canvasAct({ id: 'x', project: pid, card: 'workflow:BUILD.md', act: { action: 'restore', file: TRAY, from: 'x' } })).toMatchObject({ status: 400 });
    expect(await w.ws.canvasAct({ id: 'x', project: pid, card: 'workflow:OTHER.md', act: { action: 'run', doc: 'BUILD.md', block: 'render' } })).toMatchObject({ status: 400 });
    expect(await w.ws.canvasAct({ id: 'x', project: pid, card: 'workflow:BUILD.md', act: { action: 'run', doc: 'BUILD.md', block: 'nope' } })).toMatchObject({ status: 404 });
    expect(await w.ws.canvasAct('not an envelope')).toMatchObject({ status: 400 });
    expect(trayFile(w)).toEqual(before.tray);
    expect(w.receipts().length).toBe(before.receipts);
    expect(w.ws.jobs.list().length).toBe(0);
  }, 30_000);
});

describe('a REPL and an older Timmy Canvas (from before card actions)', () => {
  it('names its project there without the holder field, and takes no actions from it', async () => {
    const sent: Array<Record<string, unknown>> = [];
    // FAKE older canvas: answers the handoff as H55's server does, refusing a field it does not know.
    const older = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sent.push(body);
      const reply = 'holder' in body
        ? { status: 400, json: { ok: false, error: 'Unknown field: "holder". The fields are root, name, jobs, receipts and board.' } }
        : { status: 200, json: { ok: true, project: { name: 'demo', id: 'abcdef0123456789' }, board: false } };
      expect(String(url)).toMatch(/\/api\/project\/active$/);
      return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const root = temp('card-relay-older-');
    const cp = new CanvasProject({
      base: () => 'http://127.0.0.1:4999', env: {}, project: () => ({ root, name: 'demo' }), projectId, jobsDir: root, receipts: () => root, board: () => null,
      ownToken: () => 'e'.repeat(64), fetch: older, act: async () => ({ status: 200, text: 'never called' }),
    });
    closers.push(() => cp.stop());
    expect(await cp.handOff()).toEqual({ ok: true, name: 'demo' });
    expect(sent.map((b) => 'holder' in b)).toEqual([true, false]);
    expect(cp.actions).toBe('not asked');
    // Once known, the field is not sent to it again.
    expect(await cp.handOff()).toEqual({ ok: true, name: 'demo' });
    expect(sent.map((b) => 'holder' in b)).toEqual([true, false, false]);
  });
});

describe('the relay itself: what a page is told when no REPL takes its action, or none answers', () => {
  const H = 'a'.repeat(32);
  const env = (id = '11111111-2222-4333-8444-555555555555') => ({ id, project: 'p', card: 'workflow:RUN.md', act: { action: 'run', doc: 'RUN.md', block: 'build' } });
  it('a grant is good once and only until it expires; a session is known by its token only', () => {
    let now = 1_000_000;
    const r = new CardRelay({ now: () => now, grantMs: 1000 });
    const a = r.grant().grant;
    const token = r.exchange(a)!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.exchange(a)).toBeNull();
    expect(r.session(`Bearer ${token}`)).toBe(true);
    expect(r.session(`Bearer ${'0'.repeat(64)}`)).toBe(false);
    expect(r.session(token)).toBe(false);
    const b = r.grant().grant;
    now += 1001;
    expect(r.exchange(b)).toBeNull();
  });
  it('an action no REPL picks up was not run; one picked up but not answered may have run; an answer comes back', async () => {
    const r = new CardRelay({ pickupMs: 50, answerMs: 80, pollMs: 2000 });
    // Not picked up: the holder asked before, but no poll waits now.
    let end = (): void => {};
    const first = r.poll(H, (e) => { end = e; });
    end();
    expect(await first).toBeNull();
    expect(await r.submit(H, env())).toEqual({ status: 503, text: expect.stringMatching(/^No Timmy REPL took the action in 0 s; nothing was run\./) });
    // Picked up and answered.
    const polled = r.poll(H, () => {});
    const sent = r.submit(H, env());
    const got = await polled;
    expect(got).toMatchObject({ id: env().id, act: { action: 'run' } });
    expect(r.answer('b'.repeat(32), got!.id, { status: 200, text: 'x' })).toBe(false);
    expect(r.answer(H, got!.id, { status: 200, text: 'canvas /run RUN.md build' })).toBe(true);
    expect(await sent).toEqual({ status: 200, text: 'canvas /run RUN.md build' });
    // Picked up, never answered.
    const polled2 = r.poll(H, () => {});
    const sent2 = r.submit(H, env('11111111-2222-4333-8444-666666666666'));
    await polled2;
    expect(await sent2).toEqual({ status: 504, text: expect.stringMatching(/did not answer in 0 s; it may have run/) });
  });
  it('another holder now: queued actions are refused unrun; the server stopping: queued refused, handed said unanswered', async () => {
    const r = new CardRelay({ pickupMs: 5000, answerMs: 5000, pollMs: 2000 });
    const queued = r.submit(H, env());
    r.heldBy('c'.repeat(32));
    expect(await queued).toMatchObject({ status: 409, text: expect.stringMatching(/nothing was run/) });
    const q2 = r.submit(H, env('11111111-2222-4333-8444-777777777777'));
    const p2 = r.poll(H, () => {});
    await p2;
    const q3 = r.submit(H, env('11111111-2222-4333-8444-888888888888'));
    r.close();
    expect(await q2).toMatchObject({ status: 504 });
    expect(await q3).toMatchObject({ status: 503, text: expect.stringMatching(/nothing was run/) });
    expect(r.listening(H)).toBe(false);
    expect(await r.poll(H, () => {})).toBeNull();
  });
});
