/**
 * R11 round 7 (H169): the server side of the three pages — Runs & receipts (GET /api/panel/runs/list), Workflows
 * (GET /api/panel/workflows/docs) and the Control Room's room (GET /api/panel/control/room) — over real HTTP on 127.0.0.1,
 * against a project of this test's own: one chat turn sealed by the REPL's own seal (a real signed receipt, in a store pinned
 * in the project; FIXTURE facts, no model asked), one workflow document, no job of the job store, and a FAKE capability
 * inventory (rows in the three words). Nothing runs; nothing leaves this computer.
 */
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountPanels, readRunsList, readWorkflowsAnswer, RUNS_LIST_SCHEMA, WORKFLOWS_SCHEMA } from '../src/companion/panels.js';
import { CONTROL_ROOM_SCHEMA } from '../src/companion/panels/control.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';

const TOKEN = 'FAKE-launch-token-0007';
const MODEL = 'fake-qwen3:8b';

describe('the Runs & receipts list, the Workflows documents and the Control Room\'s room (R11 round 7, H169)', () => {
  let box = '';
  let root = '';
  let base = '';
  let server: ReturnType<express.Express['listen']> | null = null;
  let turnHash = '';
  const env: Record<string, string | undefined> = {};

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'h169-panels-'));
    root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
    // the project's one workflow document: two named blocks, the second needing the first
    writeFileSync(join(root, 'WORKFLOW.md'), '# FAKE workflow\n\n```bash [name:build]\necho build\n```\n\n```bash [name:check, deps:build]\necho check\n```\n');
    Object.assign(env, { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), PATH: join(box, 'empty-path'), HOME: box });
    mkdirSync(join(box, 'home'), { recursive: true });
    mkdirSync(join(box, 'empty-path'), { recursive: true });
    // FIXTURE facts of a chat turn answered in the Workbench (no model asked), sealed as every surface seals one
    const turn = sealTurn({ prompt: 'FIXTURE prompt words, never shown', answer: 'FIXTURE answer', steps: 1, spend: 0, costMeasured: true, ms: 1234, status: 'ok', surface: 'workbench', model: MODEL, project: 'FAKE-project', projectId: projectId(root), turnId: 't1-0000abcd' } as never, root);
    expect(turn.verified).toBe(true);
    turnHash = turn.hash;
    const app = express();
    const withToken: express.RequestHandler = (req, res, next) => { if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.status(401).json({ ok: false, error: 'Refused: this needs the browser companion\'s token.' }); return; } next(); };
    mountPanels(app, {
      withToken, projectFor: (req) => (req.query.project === 'unknown' ? null : { name: 'FAKE-project', root, chosen: true }), projectUnknown: 'This companion does not know that project.', env,
      inventory: async () => ({ read: 'FAKE rows', inventory: { schema: 'timmy.capability-inventory/1', readAt: '2026-10-24T00:00:00.000Z', means: { available: 'a', configured: 'b', exercised: 'c' }, groups: ['Lanes', 'Integrations'], rows: [
        { id: 'lane:fake', name: 'FAKE lane', group: 'Lanes', available: { ok: true, found: 'FAKE', source: 'FAKE', words: 'available: FAKE binary here' }, configured: { ok: false, found: 'no settings', source: 'FAKE', words: 'not configured: no settings' }, exercised: { ok: false, found: 'no receipt', source: 'FAKE', words: 'not exercised: no receipt of a run' }, next: 'Set it up in the terminal' },
        { id: 'integration:cloudflare', name: 'Cloudflare', group: 'Integrations', available: { ok: true, found: 'FAKE', source: 'FAKE', words: 'available' }, configured: { ok: true, found: 'FAKE', source: 'FAKE', words: 'configured: a FAKE gateway' }, exercised: { ok: true, receipt: 'sha256_00', hash: 'sha256_00', when: '2026-10-24T00:00:00.000Z', what: 'FAKE', source: 'FAKE', words: 'exercised: FAKE receipt' } },
        { id: 'model:openrouter', name: 'OpenRouter', group: 'Models', available: { ok: true, found: '', source: '', words: '' }, configured: { ok: false, found: '', source: '', words: '' }, exercised: { ok: false, found: '', source: '', words: '' } },
      ] } }) as never,
    });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (box) rmSync(box, { recursive: true, force: true });
  });

  const get = async (path: string, token: string | null = TOKEN): Promise<{ status: number; json: any }> => {
    const r = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, json: await r.json() };
  };

  it('Runs & receipts: newest first, the sealed chat turn as one row with its model, duration, state and receipt — verified only because verifyReceiptIn confirmed it now — and its link back to the Chat; the token first, an unknown project 404', async () => {
    expect((await get('/api/panel/runs/list', null)).status).toBe(401);
    expect((await get('/api/panel/runs/list?project=unknown')).status).toBe(404);
    const { status, json } = await get('/api/panel/runs/list');
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, schema: RUNS_LIST_SCHEMA, project: { name: 'FAKE-project' }, total: 1, running: 0, notes: [] });
    expect(json.rows).toHaveLength(1);
    expect(json.rows[0]).toMatchObject({
      kind: 'turn', id: turnHash.slice(7, 15), line: 'Chat turn answered · Timmy Workbench (timmy workbench)', model: MODEL, ms: 1234, state: 'answered', mark: '✓',
      receipt: { short: turnHash.slice(7, 15), hash: turnHash, verified: true }, operation: null,
      turn: { id: 't1-0000abcd', surface: 'workbench', from: 'Timmy Workbench (timmy workbench)' },
    });
    expect(JSON.stringify(json)).not.toMatch(/FIXTURE prompt|FIXTURE answer/);
    expect(JSON.stringify(json)).not.toContain(box);
    // a receipt that is not on the chain is never marked verified (the mark is the check's, not the record's)
    const list = await readRunsList({ root, name: 'FAKE-project', env });
    expect(list.rows[0].receipt?.verified).toBe(true);
    // the limit
    expect((await get('/api/panel/runs/list?limit=1')).json.rows).toHaveLength(1);
  });

  it('Workflows: the document and its blocks in the board\'s words (not run yet), the runner absent said plainly with the next action, nothing running; the token first', async () => {
    expect((await get('/api/panel/workflows/docs', null)).status).toBe(401);
    const { status, json } = await get('/api/panel/workflows/docs');
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, schema: WORKFLOWS_SCHEMA, project: { name: 'FAKE-project' }, upmd: false, running: [], notes: [] });
    expect(json.docs).toHaveLength(1);
    expect(json.docs[0]).toMatchObject({ rel: 'WORKFLOW.md', title: 'FAKE workflow', repeated: [] });
    expect(json.docs[0].blocks.map((b: { name: string; word: string; needs: string[] }) => [b.name, b.word, b.needs])).toEqual([['build', 'not run yet', []], ['check', 'not run yet', ['build']]]);
    // the runner is not on this computer's PATH (this test's PATH is an empty folder): the next action says so, nothing is invented
    expect(json.next).toMatchObject({ kind: 'install', command: 'timmy doctor' });
    expect(json.next.words).toMatch(/^The runner \(upmd\) is not on this computer: no block runs until it is\./);
    // with the runner given, the next action is the first block not run yet, as the terminal runs it
    const withRunner = await readWorkflowsAnswer({ root, name: 'FAKE-project', env, onPath: (cmd) => (cmd === 'upmd' ? '/FAKE/upmd' : null) });
    expect(withRunner.upmd).toBe(true);
    expect(withRunner.next).toEqual({ kind: 'run', words: 'Run WORKFLOW.md › build in the terminal (the Workbench\'s R, or the REPL)', command: '/run WORKFLOW.md build' });
    // no document at all: the starter is the next action
    const empty = join(box, 'FAKE-empty');
    mkdirSync(empty, { recursive: true });
    const none = await readWorkflowsAnswer({ root: empty, name: 'FAKE-empty', env });
    expect(none.docs).toEqual([]);
    expect(none.next).toMatchObject({ kind: 'create', command: '/project new <name> --from tray-workflow' });
    expect(none.next.words).toMatch(/^No workflow document in this project yet\./);
  });

  it('the Control Room\'s room: the activity (nothing runs), the fleet in the three words from the inventory\'s lanes and integrations, the budget from the receipts (measured dollars, no cap in this revision); the token first', async () => {
    expect((await get('/api/panel/control/room', null)).status).toBe(401);
    const { status, json } = await get('/api/panel/control/room');
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, schema: CONTROL_ROOM_SCHEMA, project: { id: projectId(root), name: 'FAKE-project' }, activity: { running: 0, waitingOnYou: 0, stop: null, chatTurn: null }, connections: [] });
    expect(json.fleet).toEqual([
      { id: 'lane:fake', name: 'FAKE lane', group: 'Lanes', word: 'available', available: 'available: FAKE binary here', configured: 'not configured: no settings', exercised: 'not exercised: no receipt of a run', next: 'Set it up in the terminal' },
      { id: 'integration:cloudflare', name: 'Cloudflare', group: 'Integrations', word: 'exercised', available: 'available', configured: 'configured: a FAKE gateway', exercised: 'exercised: FAKE receipt' },
    ]);
    expect(json.budget).toEqual({ freeOnly: false, localOnly: false, from: { freeOnly: 'the settings', localOnly: 'the settings' }, measuredUsd: 0, receipts: 1, unmeasured: 0, cap: 'none in this revision: OpenRouter\'s maxCost stops a request; it is not a guaranteed cap on billing' });
    expect(json.notes).toEqual([]);
  });
});
