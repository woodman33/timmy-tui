// R5 lead (the operator's 22:32 order, items 1 and 2): a chat turn being answered is stopped from another surface, and every
// surface reads its end by the turn's identity.
//
// - Another surface's turn, in a process of its own (the Workbench's composer, as tests/fixtures/chat-surface-fixture.ts runs
//   it), is asked to stop from here as the companion's Stop asks it (src/agent/chat-turn.ts requestTurnStop): that process
//   stops it as its own Esc would, the turn ends stopped, and its receipt names the turn's id (turn_id, its hold's id) and who
//   asked (stopped_by). The shared frame says it running, by that id, until then, and stopped, asked from the companion, after.
// - A stop is refused, writing nothing, for a turn that is not being answered: an id that is not a turn's, a turn that ended,
//   and a turn whose process was killed mid-turn (its hold left behind); after the kill the frame says nothing runs, and the
//   next turn goes (restart recovery).
// - Two turns one after the other each seal their own id, and a turn's own receipt ends it while its hold is still there.
//
// Real pieces: the agent (src/agent/core.ts), the turn (src/repl/turn.ts), the hold and stop files and their process proof
// (ps), signed receipt chains, the shared frame (src/ops/workspace-frame.ts) and the other surface as a real child process.
// FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: no model behind it),
// and the network is a recording fetch in both processes (FAKE: anything but that Ollama is refused before it leaves).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectStore } from '../src/agent/chat-session.js';
import { CHAT_TURNS_DIR, projectTurn, requestTurnStop, runningTurns, takeTurnHold, TURN_ID, watchTurnStop } from '../src/agent/chat-turn.js';
import { createAgent, type Agent } from '../src/agent/core.js';
import { buildWorkspaceFrame } from '../src/ops/workspace-frame.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';
import { readChain } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const PRELOAD = pathToFileURL(resolve('tests/fixtures/record-fetch-preload.mjs')).href;
const FIXTURE = resolve('tests/fixtures/chat-surface-fixture.ts');

const VARS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
let project = '';
let ollama: FakeOllama | null = null;
let restoreNet: (() => void) | null = null;
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'chat-turn-stop-'));
  project = join(box, 'project');
  mkdirSync(join(project, '.timmy'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# demo\n');
  // the project's own store, pinned in its folder (src/utils/receipts.ts rootStoreDir)
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX', 'OLLAMA_HOST'] as const) delete process.env[v];
});
afterEach(async () => {
  for (const c of children.splice(0)) { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }
  restoreNet?.();
  restoreNet = null;
  await ollama?.close();
  ollama = null;
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
}, 30_000);

/** The FAKE Ollama, the setup choosing it for the chat (local, qwen3:8b), and this process's recording fetch. */
async function local(chat: Parameters<typeof startFakeOllama>[0]['chat']): Promise<FakeOllama> {
  ollama = await startFakeOllama({ models: [{ name: 'qwen3:8b' }], chat });
  mkdirSync(process.env.TIMMY_HOME!, { recursive: true });
  writeFileSync(join(process.env.TIMMY_HOME!, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
  writeFileSync(join(process.env.TIMMY_HOME!, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama.url, project: 'demo', chat: 'local', model: 'qwen3:8b' } }));
  restoreNet = recordFetch(onlyPorts(new URL(ollama.url).port)).restore;
  return ollama;
}
const answer = (text: string) => () => ({ chunks: textChunks('qwen3:8b', [text]) });

/** The REPL's agent in this process, on the chat's local route. */
function replAgent(): Agent {
  const agent = createAgent({ apiKey: '', model: '', instructions: 'You are the REPL (test).', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(project, '.sessions'));
  agent.useLocalChat({ host: ollama!.url, model: 'qwen3:8b' });
  return agent;
}
/** One REPL turn of the project, as src/repl/main.ts runs it (its seal into the project's store). */
async function replTurn(agent: Agent, text: string) {
  return projectTurn({
    agent, project: { name: 'demo', root: project }, surface: 'repl', text, sink: { handle: () => undefined, endTurn: () => undefined },
    seal: (f) => sealTurn({ ...f, model: 'qwen3:8b', project: 'demo', projectId: projectId(project) }, projectStore(project)),
  });
}

/** Another surface in a process of its own (the Workbench's composer): its output, its exit and its turn's result. */
function surface(o: { surface: string; text: string }) {
  const child = spawn(process.execPath, ['--import', LOADER, '--import', PRELOAD, FIXTURE], {
    cwd: box,
    env: {
      PATH: process.env.PATH, HOME: join(box, 'home'), TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR,
      TIMMY_TEST_FETCH_LOG: join(box, 'child-fetches.jsonl'), TIMMY_TEST_FETCH_ALLOW: new URL(ollama!.url).port,
      CHAT_PROJECT: project, CHAT_SURFACE: o.surface, CHAT_TEXT: o.text,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr!.on('data', (c: Buffer) => { err += c.toString(); });
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const waitFor = async (re: RegExp, ms = 30_000): Promise<RegExpExecArray> => {
    const t0 = Date.now();
    for (;;) {
      const m = re.exec(out);
      if (m) return m;
      if (Date.now() - t0 > ms) throw new Error(`waited for ${re} in the surface's output: ${out}\n${err}`);
      await sleep(50);
    }
  };
  return {
    child, exited, waitFor,
    result: async () => JSON.parse((await waitFor(/^RESULT (.*)$/m))[1]) as { status: string; lines?: string[]; sent: boolean; receipt?: string; text: string },
  };
}

/** Waits (by condition, under a deadline) until `f` gives a value (`f` may be async). */
async function until<T>(f: () => T | null | undefined | false | Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`waited ${ms} ms for ${what}`);
    await sleep(50);
  }
}

const frameNow = () => buildWorkspaceFrame({ cwd: project, project: { name: 'demo', root: project }, chain: () => readChain('runs', projectStore(project)), jobs: () => [], onPath: () => null });

describe('a chat turn stopped from another surface, and read by its identity (the operator\'s 22:32 order, items 1 and 2)', () => {
  it('the Workbench\'s turn in a process of its own stops when the companion asks: it ends stopped, its receipt names its id and who asked, and the frame follows it by that id', async () => {
    // FAKE: the model never answers this request (the turn waits until it is stopped)
    await local([() => ({ hang: true })]);
    const wb = surface({ surface: 'workbench', text: 'count to a thousand, slowly' });
    await wb.waitFor(/^SENDING \d+$/m);
    const held = await until(() => runningTurns(project, undefined, { readOnly: true })[0], 'the Workbench\'s turn to hold the project');
    expect(held).toMatchObject({ surface: 'workbench', mine: false, proof: 'alive' });
    expect(held.id).toMatch(TURN_ID);
    await until(() => ollama!.chats().length === 1, 'the turn\'s request to reach the FAKE Ollama');
    // every surface reads the turn being answered from the frame, by its id
    const during = await frameNow();
    expect(during.activity.chatTurn).toMatchObject({ surface: 'workbench', id: held.id });
    expect(during.activity.running).toBeGreaterThanOrEqual(1);

    // the companion's Stop (POST /api/chat/stop) asks it so
    const asked = requestTurnStop(project, held.id, 'companion');
    expect(asked).toMatchObject({ ok: true, surface: 'workbench' });
    const r = await wb.result();
    expect(r.status).toBe('cancelled');
    expect(await wb.exited).toBe(0);

    // its receipt: stopped, its own id, asked from the companion
    const sealed = readChain('runs', projectStore(project)).filter((x) => x.kind === 'chat');
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ status: 'cancelled', turn_id: held.id, stopped_by: 'companion' });
    expect(sealed[0].subject).toMatch(/^chat\.turn · workbench · cancelled · /);
    // nothing holds the project now; the request went with the turn
    expect(runningTurns(project)).toEqual([]);
    expect(readdirSync(join(project, CHAT_TURNS_DIR)).filter((n) => /\.(json|stop)$/.test(n))).toEqual([]);
    // the frame: nothing runs, and the newest turn is that one, stopped, asked from the companion
    const after = await frameNow();
    expect(after.activity.chatTurn).toBeNull();
    expect(after.chat?.turns[0]).toMatchObject({ turn: held.id, state: 'stopped', stoppedBy: 'companion', surface: 'workbench' });
    expect(after.chat?.turns[0].words).toMatch(/^turn stopped \(asked from the companion\) in the Workbench · /);
    // asked again, the stop is refused: that turn ended
    expect(requestTurnStop(project, held.id, 'companion')).toMatchObject({ ok: false, why: expect.stringMatching(/not being answered now/) });
  }, 90_000);

  it('a stop is refused, writing nothing, for an id that is not a turn\'s or a turn not being answered; a turn whose process was killed is no running turn, and the next one goes (restart recovery)', async () => {
    await local([() => ({ hang: true }), answer('FAKE answer after the restart')]);
    expect(requestTurnStop(project, '../outside', 'companion')).toMatchObject({ ok: false, why: 'that is not a chat turn\'s id' });
    expect(requestTurnStop(project, 't1-0000abcd', 'companion')).toMatchObject({ ok: false });
    const wb = surface({ surface: 'workbench', text: 'a long one' });
    await wb.waitFor(/^SENDING \d+$/m);
    const held = await until(() => runningTurns(project, undefined, { readOnly: true })[0], 'the turn to hold the project');
    await until(() => ollama!.chats().length === 1, 'the turn\'s request to reach the FAKE Ollama');
    // the process is killed mid-turn: its hold stays behind
    wb.child.kill('SIGKILL');
    await wb.exited;
    expect(existsSync(join(project, CHAT_TURNS_DIR, `${held.id}.json`))).toBe(true);
    // the frame says nothing runs (its writer is gone), and a stop of it is refused with nothing written
    await until(async () => (await frameNow()).activity.chatTurn === null, 'the frame to say no turn runs');
    expect(requestTurnStop(project, held.id, 'companion')).toMatchObject({ ok: false, why: expect.stringMatching(/process has ended/) });
    expect(existsSync(join(project, CHAT_TURNS_DIR, `${held.id}.stop`))).toBe(false);
    // the next turn goes, and the stale hold is cleared as it is taken
    const r = await replTurn(replAgent(), 'hello again');
    expect(r.status).toBe('ok');
    expect(existsSync(join(project, CHAT_TURNS_DIR, `${held.id}.json`))).toBe(false);
  }, 90_000);

  it('a REPL turn stopped from the companion says so on its own cancel line, as its receipt does (R5 lead: the REPL said only "Cancelled.")', async () => {
    // FAKE: the model never answers this request (the turn waits until it is stopped)
    await local([() => ({ hang: true })]);
    const events: Array<{ type: string; by?: string }> = [];
    const turn = projectTurn({
      agent: replAgent(), project: { name: 'demo', root: project }, surface: 'repl', text: 'count to a thousand, slowly',
      sink: { handle: (e: { type: string; by?: string }) => { events.push(e); }, endTurn: () => undefined },
      seal: (f) => sealTurn({ ...f, model: 'qwen3:8b', project: 'demo', projectId: projectId(project) }, projectStore(project)),
    });
    const held = await until(() => runningTurns(project, undefined, { readOnly: true })[0], 'the REPL\'s turn to hold the project');
    await until(() => ollama!.chats().length === 1, 'the turn\'s request to reach the FAKE Ollama');
    expect(requestTurnStop(project, held.id, 'companion')).toMatchObject({ ok: true, surface: 'repl' });
    expect((await turn).status).toBe('cancelled');
    expect(events.filter((e) => e.type === 'cancelled')).toEqual([expect.objectContaining({ type: 'cancelled', by: 'the companion' })]);
    expect(readChain('runs', projectStore(project)).filter((x) => x.kind === 'turn')).toEqual([expect.objectContaining({ status: 'cancelled', turn_id: held.id, stopped_by: 'companion' })]);
  }, 60_000);

  it('two turns one after the other each seal their own id; a stop asked of this process\'s turn is seen by its watch', async () => {
    await local([answer('FAKE one'), answer('FAKE two')]);
    const agent = replAgent();
    expect((await replTurn(agent, 'one')).status).toBe('ok');
    expect((await replTurn(agent, 'two')).status).toBe('ok');
    const ids = readChain('runs', projectStore(project)).filter((x) => x.kind === 'turn').map((x) => x.turn_id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(TURN_ID);
    expect(new Set(ids).size).toBe(2);
    // a hold of this process, a stop asked of it, and its watch told once, with who asked; closing the watch removes it
    const t = takeTurnHold(project, 'repl');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const seen: Array<string | null> = [];
    const w = watchTurnStop(project, t.hold.id, (by) => seen.push(by), 50);
    expect(requestTurnStop(project, t.hold.id, 'workbench')).toMatchObject({ ok: true, surface: 'repl' });
    await until(() => seen.length === 1, 'the watch to see the stop', 5_000);
    expect(seen).toEqual(['workbench']);
    w.close();
    expect(existsSync(join(project, CHAT_TURNS_DIR, `${t.hold.id}.stop`))).toBe(false);
    t.hold.release();
  }, 60_000);
});
