/**
 * The unified Workspace order (2026-10-27): the canvas agent (src/companion/canvas-agent.ts) against the real companion, its
 * real chat route and a LABELLED FAKE Ollama (tests/fixtures/fake-ollama-chat.ts: a real HTTP server with no model behind it,
 * its answers scripted here). What is checked: the harness is the project's chat model in this computer's Ollama, else off with
 * why (a refusal recorded as one, `harnessRan: false`); the model is asked with a JSON schema whose every name is an enum of the
 * board as saved; an answer is admitted only when every step names cited handles of that revision, operations whose app is
 * installed, compatible files and parameters in range (else refused with every problem, its raw output kept); a stale board
 * revision is refused; applied steps and Stop are recorded.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const STREAM = fileURLToPath(new URL('./fixtures/fake-stream-studio', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const IMG = 'from-apps/card-lab/c1/card.png';
const MODEL = 'fake-qwen3:8b';
const answer = (v: unknown) => () => ({ chunks: textChunks(MODEL, [JSON.stringify(v)]) });

describe('the canvas agent: plans in the board’s own operations, admitted against the board as saved (FAKE Ollama)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let home = ''; let companion: CompanionServer; let origin = ''; let token = ''; let ollama: FakeOllama;
  const scripts: Array<(req: Record<string, any>) => { chunks?: Array<Record<string, unknown>>; status?: number; error?: string; hang?: boolean }> = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${companion.port}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() as Record<string, any> };
  };
  const snapshot = {
    store: {
      'shape:img': { typeName: 'shape', id: 'shape:img', type: 'timmy-display', props: { path: IMG, kind: 'image', title: 'card.png' } },
      'shape:scene': { typeName: 'shape', id: 'shape:scene', type: 'timmy-display', props: { path: 'scene.json', kind: 'file', title: 'scene.json' } },
      'shape:note': { typeName: 'shape', id: 'shape:note', type: 'note', props: {} },
    },
    schema: { schemaVersion: 2, sequences: {} },
  };
  let revision = 0;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'canvas-agent-'));
    root = join(box, 'project'); home = join(box, 'home');
    mkdirSync(join(root, 'from-apps', 'card-lab', 'c1'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, IMG), PNG);
    writeFileSync(join(root, 'scene.json'), '{"name":"chair","objects":[]}');
    // a scripted answer per /api/chat request, taken from `scripts` in order (FAKE)
    ollama = await startFakeOllama({ models: [{ name: MODEL }], chat: Array.from({ length: 20 }, () => (req: Record<string, any>) => { const s = scripts.shift(); return s ? s(req) : { status: 500, error: 'FAKE: nothing scripted' }; }) });
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TIMMY_STREAM_STUDIO_DIR: STREAM };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
    const saved = await api('POST', '/api/app/desk', { snapshot, baseRevision: 0, revision: 1 });
    expect(saved.json.ok).toBe(true);
    revision = saved.json.revision;
  }, 120_000);
  afterAll(async () => {
    await companion?.shutdown();
    await ollama?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('with no local chat model the agent is off, and a plan is refused without asking any model (harnessRan false)', async () => {
    const h = await api('GET', '/api/canvas-agent/harness');
    expect(h.json.harness.ready).toBe(false);
    const r = await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'animate the card', mode: 'run' });
    expect(r.status).toBe(409);
    expect(r.json.plan).toMatchObject({ state: 'refused', harnessRan: false, steps: [], raw: null });
    expect(ollama.chats()).toHaveLength(0);
  });

  it('the local chat model is the harness: asked once, with every name an enum of the board as saved; a good plan is admitted', async () => {
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host, model: MODEL } }));
    const h = await api('GET', '/api/canvas-agent/harness');
    expect(h.json.harness).toMatchObject({ ready: true, kind: 'ollama-local', model: MODEL });
    scripts.push(answer({ say: 'Animate the card with a pulse.', cites: ['shape:img'], done: false, steps: [
      { do: 'add', ref: 'n1', operation: 'stream-studio.animate-image' },
      { do: 'connect', node: 'n1', port: 'image', from: 'shape:img' },
      { do: 'set', node: 'n1', param: 'motion', value: 'pulse' },
      { do: 'run', node: 'n1' },
    ] }));
    const r = await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'animate the card with a pulse', mode: 'run', revision });
    expect(r.status).toBe(200);
    const p = r.json.plan;
    expect(p).toMatchObject({ state: 'proposed', harnessRan: true, boardRevision: revision, harness: { kind: 'ollama-local', model: MODEL }, cites: ['shape:img'], problems: [] });
    expect(p.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(p.steps.map((s: { do: string }) => s.do)).toEqual(['add', 'connect', 'set', 'run']);
    expect(p.raw.sha256).toBe(createHash('sha256').update(p.raw.text).digest('hex'));
    // what Ollama was asked: the chat's model, temperature 0, a schema whose names are the board's handles and the installed operations
    const sent = ollama.chats().at(-1);
    expect(sent.model).toBe(MODEL);
    expect(sent.options).toEqual({ temperature: 0, num_ctx: 8192, num_predict: 1536 });
    expect(sent.think).toBeUndefined(); // the FAKE lists no thinking capability
    expect(sent.format.properties.cites.items.enum.sort()).toEqual(['shape:img', 'shape:scene']);
    expect(sent.format.properties.steps.items.properties.operation.enum).toEqual(['stream-studio.animate-image']);
    // an added node's parameters typed as the operation declares them
    expect(sent.format.properties.steps.items.properties.params.properties).toMatchObject({ motion: { enum: ['float', 'sway', 'spin', 'pulse', 'flicker', 'orbit', 'still'] }, duration: { type: 'integer', minimum: 1, maximum: 12 } });
    expect(JSON.stringify(sent.messages)).toMatch(/animate\.export: .*not installed|Not available here/);
    const got = await api('GET', `/api/canvas-agent/plans/${p.id}`);
    expect(got.json.plan.id).toBe(p.id);
  });

  it('an answer naming what is not there, uncited, incompatible, unavailable or out of range is refused with every problem, never repaired', async () => {
    scripts.push(answer({ say: 'x', cites: ['shape:ghost'], done: false, steps: [
      { do: 'add', ref: 'n1', operation: 'animate.export' },
      { do: 'add', ref: 'n2', operation: 'stream-studio.animate-image' },
      { do: 'connect', node: 'n2', port: 'image', from: 'shape:img' },
      { do: 'connect', node: 'n2', port: 'image', from: 'shape:scene' },
      { do: 'set', node: 'n2', param: 'duration', value: 99 },
      { do: 'run', node: 'n2' }, { do: 'run', node: 'n2' },
    ] }));
    const r = await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'do it', mode: 'plan' });
    expect(r.status).toBe(422);
    const p = r.json.plan;
    expect(p.state).toBe('refused');
    expect(p.steps).toEqual([]);
    const all = p.problems.join('\n');
    expect(all).toMatch(/cites "shape:ghost", which is not a node on the board as saved/);
    expect(all).toMatch(/Step 1: no operation "animate\.export" can be added here/);
    expect(all).toMatch(/Step 3: it names shape:img without citing it/);
    expect(all).toMatch(/Step 4: it names shape:scene without citing it|Step 4: scene\.json cannot feed Image/);
    expect(all).toMatch(/Step 5: Seconds: 1–12/);
    expect(all).toMatch(/Step 7: a run over the budget of 1/);
    expect(p.raw.text).toContain('shape:ghost');
    // asked again with the refused plan as the previous round: the model is told every reason; the new answer stands on its own
    scripts.push(answer({ say: 'Cited this time.', cites: ['shape:img'], done: false, steps: [{ do: 'add', ref: 'n1', operation: 'stream-studio.animate-image' }, { do: 'connect', node: 'n1', port: 'image', from: 'shape:img' }] }));
    const again = await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'do it', mode: 'plan', previous: p.id });
    expect(again.json.plan).toMatchObject({ state: 'proposed', round: 2, previous: p.id });
    expect(JSON.stringify(ollama.chats().at(-1).messages)).toContain('Your last answer was refused: It cites');
    // not JSON at all: refused, the text kept
    scripts.push(() => ({ chunks: textChunks(MODEL, ['I would animate it.']) }));
    const t = await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'do it', mode: 'plan' });
    expect(t.json.plan).toMatchObject({ state: 'refused', problems: ['The answer is not JSON.'], raw: { text: 'I would animate it.' } });
  });

  it('an added node may carry its parameters: checked as the operation declares them, applied with it', async () => {
    scripts.push(answer({ say: 'ok', cites: ['shape:img'], done: false, steps: [{ do: 'add', ref: 'n1', operation: 'stream-studio.animate-image', params: { motion: 'pulse', duration: 6 } }, { do: 'connect', node: 'n1', port: 'image', from: 'shape:img' }] }));
    const ok = (await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'pulse', mode: 'plan' })).json.plan;
    expect(ok.steps[0]).toMatchObject({ do: 'add', params: { motion: 'pulse', duration: 6 } });
    expect(ok.steps[0].words).toBe('Add “Animate an image” (n1) with Motion pulse, Seconds 6');
    scripts.push(answer({ say: 'x', cites: [], done: false, steps: [{ do: 'add', ref: 'n1', operation: 'stream-studio.animate-image', params: { duration: 40, scene: 'x' } }] }));
    const bad = (await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'pulse', mode: 'plan' })).json.plan;
    expect(bad.problems.join(' ')).toMatch(/Step 1: Seconds: 1–12\. Animate an image has no parameter "scene"/);
  });

  it('a stale board revision is refused before any model is asked; an empty plan is the model’s own “nothing to do”', async () => {
    const before = ollama.chats().length;
    const r = await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'x', mode: 'plan', revision: revision - 1 });
    expect(r.status).toBe(409);
    expect(ollama.chats().length).toBe(before);
    expect((await api('POST', '/api/canvas-agent/plan', { board: 'nope', goal: 'x' })).status).toBe(404);
    scripts.push(answer({ say: 'There is no video on the board to break down.', cites: [], done: false, steps: [] }));
    const e = await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'break down the video', mode: 'plan' });
    expect(e.json.plan).toMatchObject({ state: 'proposed', steps: [], say: 'There is no video on the board to break down.' });
  });

  it('the page’s applied steps and Stop are recorded; a stopped plan takes no more steps; autopilot rounds stay in budget', async () => {
    scripts.push(answer({ say: 'ok', cites: ['shape:img'], done: false, steps: [{ do: 'add', ref: 'n1', operation: 'stream-studio.animate-image' }, { do: 'connect', node: 'n1', port: 'image', from: 'shape:img' }] }));
    const p = (await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'animate', mode: 'autopilot', budget: { steps: 4, runs: 0, rounds: 2 } })).json.plan;
    expect(p.budget).toEqual({ steps: 4, runs: 0, rounds: 2 });
    const a1 = await api('POST', `/api/canvas-agent/plans/${p.id}/applied`, { n: 1, shape: 'shape:abc' });
    expect(a1.json.plan.state).toBe('applying');
    expect((await api('POST', `/api/canvas-agent/plans/${p.id}/applied`, { n: 1 })).status).toBe(409);
    // round 2 (the budget's last), then a third is refused before the model is asked
    scripts.push(answer({ say: 'done', cites: [], done: true, steps: [] }));
    const p2 = (await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'animate', mode: 'autopilot', previous: p.id })).json.plan;
    expect(p2).toMatchObject({ round: 2, previous: p.id, done: true });
    expect(JSON.stringify(ollama.chats().at(-1).messages)).toContain('Last round: ok');
    expect((await api('POST', '/api/canvas-agent/plan', { board: 'desk', goal: 'animate', mode: 'autopilot', previous: p2.id })).status).toBe(409);
    const st = await api('POST', `/api/canvas-agent/plans/${p.id}/stop`);
    expect(st.json.plan.state).toBe('stopped');
    expect((await api('POST', `/api/canvas-agent/plans/${p.id}/applied`, { n: 2 })).status).toBe(409);
    const list = await api('GET', '/api/canvas-agent/plans?board=desk');
    expect(list.json.plans.length).toBeGreaterThanOrEqual(5);
  });
});
