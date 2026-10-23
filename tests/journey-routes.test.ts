// R10 (H164): the journey's read-only routes on the browser companion (src/companion/server.ts), so its page and its screens
// draw the same facts as the terminal Workbench, from src/journey:
//   GET /api/journey/route[?surface=…]           routeNow: the route the next chat turn takes (the page's own Send by default)
//   GET /api/journey/recent?project=…&limit=…     recentWork: the project's newest work, each with where it opens
//   GET /api/journey/run/<operation>?project=…    runSummary: a run's progress, result and receipt, with its project
//   GET /api/journey/open?project=…&<address>     askedOf + shownFor: what an address asks for, and what tab 6 (or tab 5, or the
//                                                 preview) shows for it, with a notice when it is not what was asked (F5, F6)
// Each behind the companion's token, as every content route (a request without it is refused, 401, before anything is read),
// none ever carrying a key or the token.
//
// REAL here: the companion server on 127.0.0.1:4480 (this owner's port), its token check and project rule, the receipts sealed
// into the project's own store through the one writer, Timmy's readers and verifier. FAKE here: the project (FAKE-tray), its
// files (a generated cube STL, a few bytes named .rrd), its operation record and receipts written by the test, and the model
// key in the chat's environment (sk-or-FAKE-…, never sent anywhere: nothing here asks a model).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { hexOfPath } from '../src/journey/index.js';
import { projectId } from '../src/project/index.js';
import { loadConfig } from '../src/utils/config.js';
import { appendReceipt, type Receipt } from '../src/utils/receipts.js';
import { cubeStl } from './helpers/vox-fakes.js';

const PORT = 4480;
const TOKEN = 'd4'.repeat(32);
const KEY = `sk-or-FAKE-${'ab'.repeat(16)}`;
/** FAKE: the OpenRouter model this test's settings choose for the page's Send (not a real id). */
const PAGE_MODEL = 'fake-maker/fake-chosen-model';
/** The environment the companion reads the page's chat route from (the one object: the 'route:' case sets OPENROUTER_MODEL in it). */
const chatEnv: Record<string, string | undefined> = { OPENROUTER_API_KEY: KEY };
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
let box = '';
let root = '';
let pid = '';
let companion: CompanionServer;
const sealed: Record<string, Receipt> = {};

const put = (rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const get = (path: string, token: string | null = TOKEN): Promise<Response> => fetch(`http://127.0.0.1:${companion.port}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const json = async (path: string): Promise<any> => { const r = await get(path); expect(r.status, path).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); return r.json(); };

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'journey-routes-'));
  process.env.TIMMY_HOME = join(box, 'home');
  Object.assign(chatEnv, { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') });
  delete process.env.TIMMY_REPO;
  root = join(box, 'home', 'projects', 'FAKE-tray');
  mkdirSync(join(root, '.timmy'), { recursive: true });
  // the project's own store, pinned in its folder
  writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
  pid = projectId(root);
  put('refs/cube.stl', cubeStl(10));
  put('refs/demo.rrd', Buffer.from('RRF2-FAKE'));
  put('out/report.md', '# Report\n');
  put('.timmy/operations/o1111aaaa.json', JSON.stringify({ schema: 'timmy.operation/1', id: 'o1111aaaa', request: '/run REPORT.md report', via: 'repl', project: 'FAKE-tray', started: '2026-10-22T11:00:00.000Z', ended: '2026-10-22T11:02:00.000Z', state: 'succeeded', parent: null, runs: [], owner: { pid: 1, started: '2026-10-22T11:00:00.000Z' } }));
  sealed.predict = appendReceipt('runs', { kind: 'predict', subject: 'predict · REPORT.md › report', policy: 'human-gated', status: 'ok', operation_id: 'o1111aaaa', project_id: pid, ts: '2026-10-22T11:00:00.000Z' } as never, root);
  sealed.workflow = appendReceipt('runs', { kind: 'workflow', subject: 'workflow · REPORT.md › report', policy: 'human-gated', status: 'ok', operation_id: 'o1111aaaa', project_id: pid, outputs: [{ path: 'out/report.md', sha256: sha('# Report\n'), bytes: 9 }], ts: '2026-10-22T11:02:00.000Z' } as never, root);
  sealed.turn = appendReceipt('runs', {
    kind: 'chat', subject: 'chat.turn · workbench · 1 step · qwen3:8b', policy: 'human-gated', status: 'ok', project_id: pid, via: 'ollama', model_requested: 'qwen3:8b', model_resolved: 'qwen3:8b',
    sources: [{ kind: 'ollama', host: '127.0.0.1:11434', endpoint: 'local', tools: 'on', cost_basis: 'local endpoint' }], ts: '2026-10-22T11:05:00.000Z',
  } as never, root);
  // R11 (H169, Phase 0 item 2): the page's Send asks the model chosen in the settings the companion reads (TIMMY_SETTINGS_DIR,
  // by path at each request): none at first; the 'route:' case chooses a FAKE one as Models (M) in the Workbench keeps it
  mkdirSync(join(box, 'settings'), { recursive: true });
  companion = await startCompanionServer(PORT, {
    token: TOKEN,
    chatEnv,
    workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings'), PATH: process.env.PATH }, shareMs: 0 },
  });
}, 60_000);
afterAll(async () => {
  await companion?.shutdown();
  for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (box) rmSync(box, { recursive: true, force: true });
});

describe('the journey\'s routes on the companion (R10 H164)', () => {
  it('every one needs the token: refused (401) without it, before anything is read; a token in an address is refused too', async () => {
    const q = `project=${pid}`;
    for (const path of ['/api/journey/route', `/api/journey/recent?${q}`, `/api/journey/run/o1111aaaa?${q}`, `/api/journey/open?${q}&tab=create`]) {
      const r = await get(path, null);
      expect(r.status, path).toBe(401);
      expect(await r.json()).toEqual({ ok: false, error: expect.stringMatching(/^Refused: this needs the browser companion's token/) });
      expect((await get(path, 'e5'.repeat(32))).status, path).toBe(401);
    }
    expect((await get(`/api/journey/open?${q}&tab=create&t=${TOKEN}`)).status).toBe(401);
  });

  it('route: the page\'s own Send by default (the settings\' chosen model, no tools; none chosen, off), the session\'s on ?surface=workbench; never the key', async () => {
    // R11 (H169, Phase 0 item 2): no model chosen anywhere (a key is): the page's Send is off, saying so, naming no model; the
    // Workbench's route (this process's settings) names none either, and is not ready
    const none = await json('/api/journey/route');
    expect(none).toMatchObject({ ok: true, surface: 'companion', route: { provider: 'openrouter', model: null, ready: false, tools: 'none', surface: 'companion', conversation: 'this page', receipt: false, words: 'No model chosen: choose one in Models · Send is off' } });
    expect(none.route.why).toBe('No model chosen. /model <id> chooses one (/model free lists free ones)');
    expect(await json('/api/chat/route')).toMatchObject({ kind: 'none', ready: false, chat: 'openrouter', reason: 'no-model-chosen', label: 'No model chosen: choose one in Models · Send is off' });
    expect((await json('/api/journey/route?surface=workbench')).route).toMatchObject({ provider: 'openrouter', model: null, ready: false, tools: 'gated', surface: 'workbench' });
    expect(JSON.stringify([none])).not.toMatch(/qwen3\.8-max|claude-opus/);
    // a model chosen in the settings the companion reads (as Models (M) keeps it): the page's Send asks it
    writeFileSync(join(box, 'settings', 'config.json'), JSON.stringify({ model: PAGE_MODEL, modelChosen: PAGE_MODEL }));
    const page = await json('/api/journey/route');
    expect(page).toMatchObject({ ok: true, surface: 'companion', route: { provider: 'openrouter', model: PAGE_MODEL, where: 'cloud', tools: 'none', ready: true, surface: 'companion', conversation: 'this page', receipt: false } });
    // the page's own Send: the same model and the same words the page's chat route gives (GET /api/chat/route), and the plain
    // sentence that it is the page's own chat, not the project's conversation
    const chat = await json('/api/chat/route');
    expect(chat.model).toBe(page.route.model);
    expect(page.route.words).toBe(chat.label);
    expect(chat.scope).toEqual({ conversation: 'this page', tools: 'none', receipt: false, words: 'This page\'s own chat, not the project\'s conversation (the Workbench\'s and the REPL\'s): no tools, no receipt.' });
    expect(chat.words).toMatch(/^This page's own chat, not the project's conversation \(the Workbench's and the REPL's\): no tools, no receipt\. Send asks /);
    // OPENROUTER_MODEL in the environment, a choice for one process: the page's Send and the session's route both name it
    const kept = process.env.OPENROUTER_MODEL;
    try {
      chatEnv.OPENROUTER_MODEL = 'fake-maker/fake-env-model';
      process.env.OPENROUTER_MODEL = 'fake-maker/fake-env-model';
      expect(loadConfig().model).toBe('fake-maker/fake-env-model');
      expect((await json('/api/journey/route')).route).toMatchObject({ provider: 'openrouter', model: 'fake-maker/fake-env-model', ready: true, surface: 'companion' });
      const wb = await json('/api/journey/route?surface=workbench');
      expect(wb.route).toMatchObject({ provider: 'openrouter', model: 'fake-maker/fake-env-model', ready: true, tools: 'gated', surface: 'workbench' });
      expect(JSON.stringify([page, wb])).not.toContain(KEY);
    } finally {
      delete chatEnv.OPENROUTER_MODEL;
      if (kept === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = kept;
    }
    expect((await get('/api/journey/route?surface=nope')).status).toBe(400);
  });

  it('recent: the project\'s newest work, each with where it opens; a project the companion does not know is 404', async () => {
    const r = await json(`/api/journey/recent?project=${pid}&limit=10`);
    expect(r).toMatchObject({ ok: true, project: { name: 'FAKE-tray', id: pid } });
    const kinds = r.items.map((i: { kind: string; id: string }) => `${i.kind}:${i.id}`);
    expect(kinds).toEqual(expect.arrayContaining([`turn:${sealed.turn.hash.slice(7, 15)}`, 'run:o1111aaaa', 'mesh:refs/cube.stl', 'recording:refs/demo.rrd']));
    const run = r.items.find((i: { kind: string }) => i.kind === 'run');
    expect(run).toMatchObject({ state: 'completed', receipt: { id: sealed.workflow.hash.slice(7, 15), verified: true }, results: ['out/report.md'], open: { query: 'tab=workflows&run=o1111aaaa' } });
    expect(r.items.find((i: { kind: string }) => i.kind === 'recording').open.query).toBe(`tab=create&recording=${hexOfPath('refs/demo.rrd')}`);
    expect((await json(`/api/journey/recent?project=${pid}&limit=2`)).items).toHaveLength(2);
    expect((await get('/api/journey/recent?project=0000000000000000')).status).toBe(404);
  });

  it('run: its progress, result and receipt with its project; not an id is 400; an operation with no record is said so', async () => {
    const r = await json(`/api/journey/run/o1111aaaa?project=${pid}`);
    expect(r).toMatchObject({ ok: true, run: { operation: 'o1111aaaa', title: 'Workflow run: report in REPORT.md', project: { name: 'FAKE-tray', id: pid }, progress: { state: 'completed' }, receipt: { id: sealed.workflow.hash.slice(7, 15), kind: 'workflow', verified: true } } });
    expect(r.run.result.outputs.map((o: { path: string }) => o.path)).toEqual(['out/report.md']);
    const bad = await get(`/api/journey/run/nope?project=${pid}`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false });
    expect(await json(`/api/journey/run/o00000000?project=${pid}`)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('open (F5, F6): tab 6 shows the mesh or recording asked for, and says so when it shows something else', async () => {
    const q = `/api/journey/open?project=${pid}`;
    expect(await json(`${q}&tab=create&mesh=${hexOfPath('refs/cube.stl')}`)).toMatchObject({ ok: true, shown: { name: 'mesh', value: 'refs/cube.stl' }, notice: null });
    expect(await json(`${q}&tab=create&recording=${hexOfPath('refs/demo.rrd')}`)).toMatchObject({ shown: { name: 'recording', value: 'refs/demo.rrd' }, notice: null });
    expect(await json(`${q}&tab=create&mesh=${hexOfPath('refs/nope.stl')}`)).toMatchObject({ shown: { name: 'mesh', value: 'refs/cube.stl' }, notice: 'refs/nope.stl is not one of this project\'s meshes, so it is not shown: refs/cube.stl is shown instead.' });
    expect((await json(`${q}&tab=create&mesh=zz-not-hex`)).notice).toBe('The address asks for a mesh as "zz-not-hex", which is not a path written as hex, so it names nothing: refs/cube.stl is shown instead.');
    expect((await json(`${q}&tab=create&mesh=${hexOfPath('/etc/hostname')}`)).notice).toMatch(/^The address names a path outside this project \(\/etc\/hostname\)/);
    // the preview: a file of the project, or a notice that there is none
    expect(await json(`${q}&tab=home&file=${hexOfPath('out/report.md')}`)).toMatchObject({ shown: { name: 'file', value: 'out/report.md' }, notice: null });
    expect(await json(`${q}&tab=home&file=${hexOfPath('out/gone.png')}`)).toMatchObject({ shown: null, notice: 'out/gone.png is not a file of this project, so nothing is previewed.' });
  });
});
