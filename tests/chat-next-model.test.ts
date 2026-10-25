/**
 * R10 CHAT (H167; H168's pass 3c, R24): a model chosen while a chat session is open (the Workbench's Models writes the
 * settings' OpenRouter model) is that session's next turn's: route() names it at once, and the next send asks it; a turn being
 * answered keeps the model it asked. Through the chat session (src/agent/chat-session.ts, the Workbench's path) with the real
 * agent and a FAKE OpenRouter client, as tests/chat-turn-route.test.ts does: in this process, it records the model each request
 * names and answers FAKE words; nothing leaves this process, no model is called, nothing is charged. The settings are this test
 * file's own (tests/isolation-setup.ts), and their model is put back after each test.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openChatSession } from '../src/agent/chat-session.js';
import { createAgent, type Agent } from '../src/agent/core.js';
import { loadConfig, saveConfig } from '../src/utils/config.js';

let box = '';
let project = '';
let before = '';
const asked: string[] = [];
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'h167-next-model-'));
  project = join(box, 'project');
  mkdirSync(join(project, '.timmy'), { recursive: true });
  mkdirSync(join(box, 'home'), { recursive: true });
  vi.stubEnv('TIMMY_HOME', join(box, 'home'));
  vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '');
  vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('OPENROUTER_MODEL', '');
  vi.stubEnv('OLLAMA_HOST', '127.0.0.1:9');
  before = loadConfig().model;
  asked.length = 0;
});
afterEach(() => {
  saveConfig({ model: before });
  vi.unstubAllEnvs();
  rmSync(box, { recursive: true, force: true });
});

const askPerson = async () => 'deny' as const;

/** The real agent with a FAKE OpenRouter client: each request's model is recorded; `during` runs while it streams. */
function openRouterAgent(model: string, during?: () => void): Agent {
  const agent = createAgent({ apiKey: 'FAKE-openrouter-key', model, instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(project, '.sessions'));
  (agent as unknown as { client: unknown }).client = {
    callModel: (req: { model: string }) => {
      asked.push(req.model);
      return {
        async *getItemsStream() {
          during?.();
          yield { type: 'message', id: 'm1', content: [{ text: 'FAKE: answered (no model behind it).' }] };
        },
        getResponse: async () => ({ id: 'r1', usage: { cost: 0 } }),
        cancel: async () => undefined,
      };
    },
  };
  return agent;
}

describe('a model chosen while the chat session is open is its next turn\'s (R10 CHAT H167; H168\'s pass 3c, R24)', () => {
  it('route() names the chosen model at once and the next send asks it; a choice made during a turn is the next turn\'s', async () => {
    saveConfig({ model: 'fake/opened-with' });
    const agent = openRouterAgent('fake/opened-with', () => saveConfig({ model: 'fake/chosen-during-the-turn' }));
    const chat = await openChatSession({ project: { name: 'tray', root: project }, surface: 'workbench' }, { agent, seal: null });
    expect(chat.route().words).toMatch(/^chat: fake\/opened-with · OpenRouter/);
    // the person chooses another model in the Workbench's Models (it writes the settings' model)
    saveConfig({ model: 'fake/chosen:free' });
    expect(chat.route().words).toMatch(/^chat: fake\/chosen:free · OpenRouter/);
    const first = await chat.send('FIXTURE: a first message', { onText: () => undefined, askPerson });
    expect(first.status).toBe('answered');
    // the turn asked the chosen model, not the one the session opened with (a choice made while it ran: the next turn's)
    expect(asked).toEqual(['fake/chosen:free']);
    expect(chat.route().words).toMatch(/^chat: fake\/chosen-during-the-turn · OpenRouter/);
    await chat.send('FIXTURE: a second message', { onText: () => undefined, askPerson });
    expect(asked).toEqual(['fake/chosen:free', 'fake/chosen-during-the-turn']);
  });

  it('a session given its own config (the monitor\'s) keeps its model: the settings are not followed there', async () => {
    saveConfig({ model: 'fake/settings-model' });
    const agent = openRouterAgent('fake/monitors-own');
    const chat = await openChatSession({ project: { name: 'tray', root: project }, surface: 'monitor' }, { agent, seal: null, config: { apiKey: 'FAKE-openrouter-key', model: 'fake/monitors-own' } });
    saveConfig({ model: 'fake/chosen-elsewhere' });
    await chat.send('FIXTURE: a message', { onText: () => undefined, askPerson });
    expect(asked).toEqual(['fake/monitors-own']);
  });
});
