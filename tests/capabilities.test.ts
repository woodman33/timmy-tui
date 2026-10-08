/**
 * Round R1, gap 3: `/tools` and `timmy tools` (plan F-0): what Timmy can do here, each on the ladder of
 * AGENTS.md §8, from checks that are free, quick, write nothing and print no secret. A key or a program
 * on disk is never "working": reachable means a live check answered just now.
 */
import { describe, expect, it } from 'vitest';
import { capabilities, type CapabilityRow, type ProbeDeps } from '../src/capabilities/index.js';
import { capabilityLines, capabilityJson } from '../src/capabilities/render.js';
import { exercisedTools, openRouterProbe } from '../src/capabilities/live.js';
import { glyphSet } from '../src/term/glyphs.js';
import { replTools } from '../src/repl/main.js';

const none: ProbeDeps = {
  env: {},
  onPath: () => false,
  canvasBuilt: () => false,
  studio: async () => ({ state: 'not-running' }),
  studioBase: 'http://127.0.0.1:4337',
  ollama: async () => ({ ok: false, models: [] }),
  openrouter: async () => 'no-key',
  modelKeySource: () => null,
  model: 'anthropic/claude-opus-4.7',
  http: async () => null,
  lanes: () => [{ id: 'pi', label: 'pi', available: false, install: 'npm i -g pi' }, { id: 'hermes', label: 'Hermes', available: false }],
  adapters: () => [{ id: 'viser', name: 'Viser interactive 3D', installedAdapter: false }],
  receipts: () => ({ ok: true, count: 0 }),
  exercised: () => new Map(),
  edgeSet: () => false,
  exists: () => false,
};
const all: ProbeDeps = {
  ...none,
  env: { DAYTONA_API_KEY: 'dtn_synthetic', TRIGGER_SECRET_KEY: 'tr_synthetic', COMPOSIO_API_KEY: 'ck_synthetic', TASKFORGE_API_URL: 'http://127.0.0.1:3901/api', AGENTPASS_REPO_PATH: '/srv/agentpass', API_BASE_URL: 'https://cards.example.test', TIMMY_USERNAME: 'op' },
  onPath: () => true,
  canvasBuilt: () => true,
  studio: async () => ({ state: 'running', pageConnected: true, built: true, revision: 3, jobs: 1, latestJob: null, tldrawVersion: '5.5.2' }),
  ollama: async () => ({ ok: true, models: ['qwen3:4b'] }),
  openrouter: async () => 'accepted',
  modelKeySource: () => 'environment',
  http: async () => 200,
  lanes: () => [{ id: 'pi', label: 'pi', available: true }, { id: 'hermes', label: 'Hermes', available: false }],
  adapters: () => [{ id: 'viser', name: 'Viser interactive 3D', installedAdapter: true }],
  receipts: () => ({ ok: true, count: 12 }),
  edgeSet: () => true,
  exists: () => true,
};
const byId = (rows: CapabilityRow[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

describe('the ladder, from the checks', () => {
  it('nothing set up: each row says what is missing and the step that fixes it', async () => {
    const r = byId(await capabilities(none));
    expect(r.repl).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('timmy init') });
    expect(r.openrouter).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('OPENROUTER_API_KEY') });
    expect(r.canvas).toMatchObject({ rung: 'needs setup', setup: 'npm run build:canvas' });
    expect(r['canvas-tools']).toMatchObject({ rung: 'needs setup' });
    expect(r.trigger).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('TRIGGER_SECRET_KEY') });
    expect(r.stress).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('oha') });
    expect(r.flag).toMatchObject({ rung: 'not built' });
    expect(r.workspace).toMatchObject({ rung: 'installed', detail: expect.stringContaining('this machine') });
    expect(r.taskforge).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('TASKFORGE_API_URL') });
    expect(r.agentpass).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('AGENTPASS_REPO_PATH') });
    expect(r.lanes).toMatchObject({ rung: 'needs setup', detail: '0 of 2 installed' });
  });
  it('everything answering: reachable only where a live check answered just now', async () => {
    const r = byId(await capabilities(all));
    expect(r.openrouter).toMatchObject({ rung: 'reachable' });
    expect(r.canvas).toMatchObject({ rung: 'reachable', detail: expect.stringContaining('page open') });
    expect(r['canvas-tools']).toMatchObject({ rung: 'reachable' });
    expect(r.ollama).toMatchObject({ rung: 'reachable', detail: '1 local model' });
    expect(r.taskforge).toMatchObject({ rung: 'reachable' });
    // A key on disk is installed, never reachable: nothing was contacted.
    expect(r.trigger).toMatchObject({ rung: 'installed' });
    expect(r.workspace).toMatchObject({ rung: 'installed', detail: expect.stringContaining('Daytona') });
    expect(r.composio.detail).toMatch(/not built/);
    expect(r.lanes).toMatchObject({ rung: 'installed', detail: '1 of 2 installed' });
  });
  it('a refused key and a port held by another program each say how to fix them', async () => {
    const r = byId(await capabilities({ ...none, modelKeySource: () => 'settings', openrouter: async () => 'rejected', canvasBuilt: () => true, studio: async () => ({ state: 'other', detail: 'HTTP 404, not Timmy Canvas' }) }));
    expect(r.openrouter).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('timmy init') });
    expect(r.canvas).toMatchObject({ rung: 'needs setup', setup: expect.stringContaining('TIMMY_STUDIO_PORT') });
  });
  it('every tool the REPL gives the agent has a row', async () => {
    const covered = new Set((await capabilities(none)).flatMap((r) => r.tools ?? []));
    const names = replTools().map((t) => (t as unknown as { function: { name: string } }).function.name);
    expect(names.filter((n) => !covered.has(n))).toEqual([]);
  });
  it('a tool a sealed receipt shows completed says when it was last used', async () => {
    const r = byId(await capabilities({ ...all, exercised: () => new Map([['canvas_exec', '2026-10-08T21:04:00Z'], ['canvas_read', '2026-10-07T10:00:00Z']]) }));
    expect(r['canvas-tools'].exercised).toBe('2026-10-08T21:04:00Z');
    expect(r.trigger.exercised).toBeUndefined();
  });
  it('an API lane needs its key, not only curl on PATH (round R1 review)', async () => {
    const lanes = () => [{ id: 'retool', label: 'Retool', available: true, key: 'RETOOL_API_KEY' }, { id: 'pi', label: 'pi', available: true }];
    const without = await capabilities({ ...all, lanes }, { all: true });
    expect(byId(without).lanes).toMatchObject({ rung: 'installed', detail: '1 of 2 installed' });
    expect(byId(without)['lane:retool']).toMatchObject({ rung: 'needs setup', detail: 'no key', setup: 'set RETOOL_API_KEY' });
    const withKey = byId(await capabilities({ ...all, env: { ...all.env, RETOOL_API_KEY: 'rt_synthetic' }, lanes }, { all: true }));
    expect(withKey['lane:retool']).toMatchObject({ rung: 'installed', detail: 'key set; not contacted' });
    expect(withKey.lanes.detail).toBe('2 of 2 installed');
  });
  it('canvas tools are reachable only when a page answered; an older canvas that cannot say is installed', async () => {
    const r = byId(await capabilities({ ...all, studio: async () => ({ state: 'running', pageConnected: null, built: null, revision: null, jobs: 0, latestJob: null, tldrawVersion: null }) }));
    expect(r['canvas-tools']).toMatchObject({ rung: 'installed', detail: expect.stringContaining('cannot say') });
  });
  it('a workspace command asks each time: the row says so', async () => {
    expect(byId(await capabilities(none)).workspace.detail).toBe('runs on this machine (asks each time)');
  });
  it('/tools all lists each lane and each adapter', async () => {
    const rows = await capabilities(all, { all: true });
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['lane:pi', 'lane:hermes', 'adapter:viser']));
    expect(byId(rows)['lane:hermes'].rung).toBe('needs setup');
  });
});

describe('when a tool was last used', () => {
  it('counts only turns sealed under outcome rule 2: older receipts sealed every step completed (round R1 review)', () => {
    const chain = [
      { kind: 'turn', ts: '2026-10-05T10:00:00Z', tool_outcomes: [{ name: 'trigger_background_workflow', outcome: 'completed' }] },
      { kind: 'turn', ts: '2026-10-08T21:00:00Z', outcome_rule: 2, tool_outcomes: [{ name: 'canvas_exec', outcome: 'completed' }, { name: 'get_env', outcome: 'failed' }] },
    ];
    expect([...exercisedTools(chain)]).toEqual([['canvas_exec', '2026-10-08T21:00:00Z']]);
  });
});

describe('showing it', () => {
  it('groups the rows, names each rung in words, fits the width, and explains the ladder', async () => {
    const lines = capabilityLines(await capabilities(none), glyphSet(true), 80).map((l) => l.map((s) => s.text).join(''));
    expect(lines).toContain('  WHERE YOU WORK');
    expect(lines).toContain('  AGENT TOOLS');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
    // A step too long for its row gets a line of its own, whole: a cut step cannot be followed.
    const at = lines.findIndex((l) => l.startsWith('  REPL (timmy)') && /needs setup/.test(l));
    expect(lines[at + 1]).toBe('      do: timmy init, or export OPENROUTER_API_KEY');
    expect(lines.at(-1)).toMatch(/reachable: answered just now/);
  });
  it('the JSON carries every row and the time of the check', async () => {
    const json = capabilityJson(await capabilities(all), new Date('2026-10-08T21:30:00Z'));
    expect(json).toMatchObject({ checkedAt: '2026-10-08T21:30:00.000Z' });
    expect((json.rows as unknown[]).length).toBeGreaterThan(20);
  });
});

describe('the OpenRouter check', () => {
  // Synthetic, built at run time so no key-shaped literal sits in the source (the privacy gate).
  const KEY = ['sk', 'or', 'v1', 'ab'.repeat(32)].join('-');
  it('asks the key endpoint, which costs nothing, and never returns the key', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const fetcher = async (url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get('authorization') };
      return new Response(JSON.stringify({ data: { label: 'x' } }), { status: 200 });
    };
    expect(await openRouterProbe(KEY, fetcher as typeof fetch)).toBe('accepted');
    expect(seen).toEqual({ url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${KEY}` });
    expect(await openRouterProbe(KEY, (async () => new Response('', { status: 401 })) as typeof fetch)).toBe('rejected');
    expect(await openRouterProbe(KEY, (async () => { throw new Error('offline'); }) as typeof fetch)).toBe('unreachable');
    expect(await openRouterProbe(null, fetcher as typeof fetch)).toBe('no-key');
  });
});
