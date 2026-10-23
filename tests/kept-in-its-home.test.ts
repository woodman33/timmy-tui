/**
 * R10 (H169; CI at 704d8510, run 39910190145: tests/studio-port.test.ts's real-home guard saw timmy/state/connections.json
 * change in the runner's own home while the suite ran). What Timmy keeps once something has run lands in the Timmy home the
 * run was made under, whatever the environment says by the time it is kept:
 *   - a chat turn's observation of its connection (src/agent/chat-turn.ts, the connections record): it used to be kept after a
 *     promise, reading the home from the environment as it was by then (a test file's restored one: the account's own ~/timmy);
 *   - a catalog fetched from OpenRouter (src/models/catalog.ts loadCatalog), kept after its request.
 * Here the environment names another home the moment the turn returns (as a test file's teardown puts its variables back), or
 * while the request is out. FAKE: the OpenRouter client behind the real agent, and the catalog's fetch (this repository's
 * trimmed copy of OpenRouter's public catalog). Nothing leaves the process.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observationsKept, projectTurn } from '../src/agent/chat-turn.js';
import { createAgent, type Agent } from '../src/agent/core.js';
import { loadCatalog } from '../src/models/catalog.js';

const VARS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_FREE_ONLY', 'TIMMY_CHAT_LOCAL_ONLY'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
let project = '';
let turnHome = '';
let otherHome = '';

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'h169-home-at-call-'));
  project = join(box, 'project');
  mkdirSync(join(project, '.timmy'), { recursive: true });
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  turnHome = join(box, 'turn-home');
  otherHome = join(box, 'other-home');
  for (const d of [turnHome, otherHome]) mkdirSync(d, { recursive: true });
  process.env.TIMMY_HOME = turnHome;
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['OPENROUTER_API_KEY', 'TIMMY_CHAT_FREE_ONLY', 'TIMMY_CHAT_LOCAL_ONLY'] as const) delete process.env[v];
});
afterEach(() => {
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});

/** Every file and folder under a folder, by its path there. */
const filesIn = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

/** The real agent with a FAKE OpenRouter client (no network): it answers, and its response names the model. */
function fakeOpenRouterAgent(): Agent {
  const agent = createAgent({ apiKey: 'FAKE-openrouter-key', model: 'fake/model', instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(project, '.sessions'));
  (agent as unknown as { client: unknown }).client = {
    callModel: () => ({
      async *getItemsStream() { yield { type: 'message', id: 'm1', content: [{ text: 'FAKE: answered.' }] }; },
      getResponse: async () => ({ id: 'r1', model: 'fake/model', usage: { cost: 0 } }),
      cancel: async () => undefined,
    }),
  };
  return agent;
}

describe('kept in the Timmy home the run was made under', () => {
  it('a chat turn\'s observation of its connection, though the environment names another home the moment the turn returns', async () => {
    const r = await projectTurn({ agent: fakeOpenRouterAgent(), project: { name: 'demo', root: project }, surface: 'workbench', text: 'hello', sink: { handle: () => undefined, endTurn: () => undefined } });
    // as a test file's teardown puts its variables back before a note kept later would have run
    process.env.TIMMY_HOME = otherHome;
    await observationsKept();
    expect(r.status).toBe('ok');
    const rec = JSON.parse(readFileSync(join(turnHome, 'state', 'connections.json'), 'utf8')) as { schema: string; checks: Record<string, unknown> };
    expect(rec.schema).toBe('timmy.connections/1');
    expect(rec.checks.openrouter).toMatchObject({ answer: 'accepted', by: 'turn', detail: 'fake/model' });
    expect(filesIn(otherHome)).toEqual([]);
  });

  it('a catalog fetched from OpenRouter, though the environment names another home while the request is out', async () => {
    const publicCatalog = readFileSync(join(import.meta.dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json'), 'utf8');
    const answer = (async () => {
      process.env.TIMMY_HOME = otherHome;
      return new Response(publicCatalog, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const r = await loadCatalog('openrouter', { fetch: answer, refresh: 'always' });
    expect(r.from).toBe('live');
    expect(existsSync(join(turnHome, 'models', 'openrouter-catalog.json'))).toBe(true);
    expect(filesIn(otherHome)).toEqual([]);
  });
});
