// R4 (H113, part 4): one route. The REPL's header and its refusal (src/repl/main.ts), the chat session's route (the terminal
// Workbench's and the monitor's: src/agent/chat-session.ts), the monitor's top line (ShellV2 reads chatRouteNow with its
// narrow model name) and the companion page's Send, on or off and why (src/companion/chat-route.ts pageRoute) all come from
// src/agent/chat-route.ts chatRouteNow, so for each setup they agree: the same route, ready or not, and the same cause; each
// surface names its own way to the fix. With both a local model chosen and an OpenRouter key, the local model answers and
// nothing goes to OpenRouter (the strict free policy).
//
// Real files in this test's own Timmy home and settings (the setup's answers, providers.json); the key is FAKE, made at run
// time. The one turn goes to a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts, no model behind it) through a
// recording fetch (FAKE network: anything else is refused before it leaves, and recorded).
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatRouteNow, REPL_NO_ROUTE_TRY, refusalSegments } from '../src/agent/chat-route.js';
import { openChatSession } from '../src/agent/chat-session.js';
import { drawerStatus } from '../src/tui/monitor-chat.js';
import { pageRoute } from '../src/companion/chat-route.js';
import { loadConfig } from '../src/utils/config.js';
import { modelKeySource } from '../src/utils/model-key.js';
import { glyphSet } from '../src/term/glyphs.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

const VARS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TIMMY_CHAT_MODEL', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
let project = '';
let ollama: FakeOllama | null = null;
const restore: Array<() => void> = [];
beforeEach(async () => {
  box = mkdtempSync(join(tmpdir(), 'chat-one-route-'));
  project = join(box, 'project');
  mkdirSync(project, { recursive: true });
  // the project's own store, pinned in its folder (src/utils/receipts.ts rootStoreDir): its seals land there, whatever is above it
  mkdirSync(join(project, '.timmy'), { recursive: true });
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TIMMY_CHAT_MODEL', 'OLLAMA_HOST'] as const) delete process.env[v];
  ollama = await startFakeOllama({ models: [{ name: 'qwen3:8b' }], chat: [() => ({ chunks: textChunks('qwen3:8b', ['Free and local.']) })] });
});
afterEach(async () => {
  for (const r of restore.splice(0)) r();
  await ollama?.close();
  ollama = null;
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});

type Setup = 'no key' | 'local model chosen' | 'OpenRouter key' | 'both';
/** The setup's files as `timmy init` writes them: setup.json's answers, and providers.json (its Ollama, and a FAKE key when asked). */
function setUp(s: Setup): void {
  const home = process.env.TIMMY_HOME!;
  mkdirSync(home, { recursive: true });
  const local = s === 'local model chosen' || s === 'both';
  const key = s === 'OpenRouter key' || s === 'both';
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: ollama!.url, ...(key ? { openrouter_api_key: `sk-or-FAKE-${randomBytes(8).toString('hex')}` } : {}) }));
  writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama!.url, project: 'demo', chat: local ? 'local' : 'openrouter', ...(local ? { model: 'qwen3:8b' } : {}) } }));
}

/** Every surface's view of the route now, each as its own code reads it. */
async function surfaces() {
  const config = loadConfig();
  const model = config.model;
  // the REPL (src/repl/main.ts: its loadConfig() key, its OpenRouter model)
  const repl = chatRouteNow({ env: process.env, session: null, key: Boolean(config.apiKey), openRouterModel: model, surface: 'repl' });
  // the terminal Workbench's (and the monitor's) chat session
  const workbench = (await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' })).route();
  // the monitor's top line (ShellV2: a key the agent has or the setup stored, its model's last part, its own /setup)
  const monitor = chatRouteNow({ env: process.env, key: modelKeySource() !== null, openRouterModel: model, short: true, surface: 'monitor' });
  // the companion page's Send
  const page = pageRoute(process.env, project);
  return { repl, workbench, monitor, page, model };
}

// R11 (H169, Phase 0 item 1): a key alone chooses no model (there is no shipped default): the route is OpenRouter's, not
// ready, and its words say so on every surface; `pageReady`: the companion page's own Send (item 2 makes it the settings'
// chosen model too; until then it names its own)
const EXPECTED: Record<Setup, { kind: 'none' | 'local' | 'openrouter'; ready: boolean; pageReady?: boolean; repl: (m: string) => string; monitor: (m: string) => string; page: string }> = {
  'no key': { kind: 'none', ready: false, repl: () => 'chat: no model key · /setup', monitor: () => 'chat: no model key · /setup', page: 'no chat route here · Send is off' },
  'local model chosen': { kind: 'local', ready: true, repl: () => 'chat: local qwen3:8b · Ollama', monitor: () => 'chat: local qwen3:8b · Ollama', page: 'local qwen3:8b · Ollama · this page\'s own chat · no tools' },
  'OpenRouter key': { kind: 'openrouter', ready: false, pageReady: true, repl: () => 'chat: OpenRouter · no model chosen', monitor: () => 'chat: OpenRouter · no model chosen', page: 'qwen/qwen3.8-max · OpenRouter · this page\'s own chat · each message spends credits' },
  both: { kind: 'local', ready: true, repl: () => 'chat: local qwen3:8b · Ollama', monitor: () => 'chat: local qwen3:8b · Ollama', page: 'local qwen3:8b · Ollama · this page\'s own chat · no tools' },
};

describe('one route for every surface (R4 H113, part 4)', () => {
  for (const setup of Object.keys(EXPECTED) as Setup[]) {
    it(`${setup}: the REPL's header, the Workbench's and the monitor's route words and the companion's Send agree`, async () => {
      setUp(setup);
      const want = EXPECTED[setup];
      const { repl, workbench, monitor, page, model } = await surfaces();
      // the same route, ready or not, on every surface
      expect([repl.state.kind, workbench.kind, monitor.state.kind]).toEqual([want.kind, want.kind, want.kind]);
      const pageReady = want.pageReady ?? want.ready;
      expect([repl.state.ready, workbench.ready, monitor.state.ready, page.ready]).toEqual([want.ready, want.ready, want.ready, pageReady]);
      expect(page.kind).toBe(pageReady ? want.kind : 'none');
      // the words: the REPL's header and the Workbench's are the same words; the monitor's names the model's last part
      expect(repl.state.words).toBe(want.repl(model));
      expect(workbench.words).toBe(repl.state.words);
      expect(monitor.state.words).toBe(want.monitor(model));
      expect(page.label).toBe(want.page);
      if (!want.ready) {
        // the same why on every surface (the cause, and that nothing is sent); each its own way to the fix
        const why = (lines: readonly string[] | undefined) => (lines ?? []).filter((l) => !/^Try:/.test(l));
        expect(why(workbench.refusal)).toEqual(why(repl.state.refusal));
        expect(why(monitor.state.refusal)).toEqual(why(repl.state.refusal));
        if (page.kind === 'none') expect(why(page.refusal)).toEqual(why(repl.state.refusal));
      }
      if (setup === 'OpenRouter key') {
        // R11 (H169): the one sentence, and no model named anywhere (the shipped default is none)
        expect(repl.state.refusal?.[0]).toBe('Error: No model chosen. /model <id> chooses one (/model free lists free ones).');
        expect(repl.state.refusal?.at(-1)).toBe('Nothing was sent to any model.');
        expect(workbench.refusal).toContain('Try: Models (M) in timmy workbench, /model <id> in the REPL (timmy), or timmy init --chat openrouter --model <id>');
        expect(model).toBe('');
        expect(drawerStatus(monitor, 'not checked')).toMatch(/^Error: No model chosen\. \/model <id> chooses one/);
      }
      if (setup === 'no key') {
        expect(repl.state.refusal).toContain(REPL_NO_ROUTE_TRY);
        expect(workbench.refusal).toContain('Try: timmy init --chat openrouter (it asks for the key, hidden), or the local model: timmy init --chat local --model <name>');
        // the REPL prints them with its failure glyph first, the rest quiet (src/repl/main.ts prepareChat)
        expect(refusalSegments(repl.state.refusal!, glyphSet(true)).map((row) => row.map((s) => s.text).join(''))).toEqual([
          '✖ Error: no model key, and the chat is not set to the local model, so this message was not sent.',
          '  Cause: no OPENROUTER_API_KEY, and the setup stored no key; its chat answer is OpenRouter, or none yet.',
          `  ${REPL_NO_ROUTE_TRY}`,
          '  Nothing was sent to any model.',
        ]);
        // the monitor's drawer says the same: no key, nothing sent
        expect(drawerStatus(monitor, 'not checked')).toMatch(/^No model key: nothing is sent to a model\. /);
        expect(page.kind === 'none' && page.words).toMatch(/^Send is off: the setup chose OpenRouter for chat, and no OpenRouter key is set/);
      }
    });
  }

  it('both a local model chosen and an OpenRouter key: the local model answers, and nothing goes to OpenRouter (the strict free policy)', async () => {
    setUp('both');
    const net = recordFetch(onlyPorts(new URL(ollama!.url).port));
    restore.push(net.restore);
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' });
    const r = await chat.send('hello', { onText: () => undefined, askPerson: async () => 'deny' });
    expect(r).toMatchObject({ status: 'answered', text: 'Free and local.', sent: true, model: 'qwen3:8b', costWords: 'no charge (local endpoint)' });
    expect(net.requests.length).toBeGreaterThan(0);
    expect(net.requests.every((q) => new URL(q.url).port === new URL(ollama!.url).port)).toBe(true);
    expect(net.requests.some((q) => /openrouter/i.test(q.url))).toBe(false);
  });

  it('the local model chosen but none named: every surface says the local route is not ready, the same cause, and Send is off', async () => {
    const home = process.env.TIMMY_HOME!;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: ollama!.url }));
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama!.url, project: 'demo', chat: 'local' } }));
    const { repl, workbench, monitor, page } = await surfaces();
    expect([repl.state.ready, workbench.ready, monitor.state.ready, page.ready]).toEqual([false, false, false, false]);
    expect(repl.state.words).toBe('chat: local · no model chosen · /model');
    expect(workbench.words).toBe(repl.state.words);
    expect(monitor.state.words).toBe('chat: local · no model chosen · /setup');
    expect(page).toMatchObject({ kind: 'none', chat: 'local', label: 'chat: local · no model chosen · Send is off' });
    const cause = (lines: readonly string[] | undefined) => (lines ?? []).filter((l) => /^(Error|Cause):/.test(l));
    expect(cause(workbench.refusal)).toEqual(cause(repl.state.refusal));
    expect(cause(monitor.state.refusal)).toEqual(cause(repl.state.refusal));
    expect(page.kind === 'none' && cause(page.refusal)).toEqual(cause(repl.state.refusal));
    expect(cause(repl.state.refusal)[0]).toBe('Error: the chat is set to the local model, and no model is chosen.');
    expect(repl.state.refusal).toContain('Try: /model (lists what Ollama has), then /model <name>; /setup chat keeps one');
  });
});
