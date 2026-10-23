// R4 (H103, D1b and D1c): the agent's send path (src/agent/core.ts), where every surface's chat ends.
//
// D1b: off the local route with no model key, Agent.send refuses before anything leaves this process: no request to
// OpenRouter with an empty key, and never the last-resort fallback (a local model nobody chose). Before, the monitor's chat
// reached exactly that: an empty-key request to OpenRouter, then a FAKE-able Ollama answered, while its drawer said nothing
// was sent. The network here is a recording fetch (tests/fixtures/recording-fetch.ts, FAKE): every request is recorded and
// any to an address the test did not allow is refused before it leaves; Ollama is a FAKE on 127.0.0.1
// (tests/fixtures/fake-ollama-chat.ts) that records what it is asked.
//
// D1c: with a key, OpenRouter failed for the model and its fallback model (the OpenRouter client is a FAKE that throws), and
// the last resort, this computer's Ollama, answered: its answer is said, before the answer, in the REPL's own transcript
// ("OpenRouter failed: <cause>; answered by local <model> on this computer's Ollama, the last-resort fallback"), its text
// is shown there too, a cloud-backed model is never picked, and the agent says what answered for the turn's receipt.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent, type Agent } from '../src/agent/core.js';
import { fallbackRoute } from '../src/agent/chat-route.js';
import { sealTurn } from '../src/repl/seal.js';
import { Transcript } from '../src/repl/transcript.js';
import { runTurn } from '../src/repl/turn.js';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { buildTheme } from '../src/term/theme.js';
import { readChain } from '../src/utils/receipts.js';
import { startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

let box = '';
const kept = process.env.OLLAMA_HOST;
const keptFreeOnly = process.env.TIMMY_CHAT_FREE_ONLY;
const fakes: FakeOllama[] = [];
beforeEach(() => { box = mkdtempSync(join(tmpdir(), 'agent-no-route-')); });
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  if (kept === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = kept;
  if (keptFreeOnly === undefined) delete process.env.TIMMY_CHAT_FREE_ONLY; else process.env.TIMMY_CHAT_FREE_ONLY = keptFreeOnly;
  rmSync(box, { recursive: true, force: true });
});
const fake = async (o: Parameters<typeof startFakeOllama>[0]): Promise<FakeOllama> => { const f = await startFakeOllama(o); fakes.push(f); return f; };

// R11 (H169, Phase 0 item 1): the model is one the person chose (there is no shipped default): a free one here, so that
// the last-resort fallback below may answer under free-only (the only case a fallback is taken: the lead's rule of 2026-10-23)
const CHOSEN = 'recursive/flint-v1.0:free';
function agentWith(apiKey: string, model = CHOSEN): Agent {
  const agent = createAgent({ apiKey, model, instructions: '', maxSteps: 1, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(box, 'sessions'));
  return agent;
}

class Sink { writes: string[] = []; isTTY = false; write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }

describe('Agent.send with no model key, off the local route (R4 H103, D1b)', () => {
  it('refuses before any request: nothing to OpenRouter, nothing to Ollama, the conversation untouched, one error with its cause and fix', async () => {
    const ollama = await fake({ models: [{ name: 'granite4.2:latest' }], completions: [() => ({ content: 'FAKE answer nobody asked for' })] });
    process.env.OLLAMA_HOST = ollama.url;
    const net = recordFetch(onlyPorts(new URL(ollama.url).port));
    const agent = agentWith('');
    const errors: Error[] = [];
    let thinking = 0;
    agent.on('error', (e) => errors.push(e));
    agent.on('thinking:start', () => { thinking++; });
    try {
      await expect(agent.send('hello')).rejects.toMatchObject({ name: 'NoModelKeyError', sent: false });
      expect(net.requests).toEqual([]);
      expect(ollama.requests).toEqual([]);
      expect(agent.getHistory()).toEqual([]);
      expect(thinking).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe([
        'No model key, so nothing was sent to any model.',
        'Reason: the chat is set to OpenRouter (the setup did not choose the local model), and no OPENROUTER_API_KEY is set or stored.',
        'Next: timmy init --chat openrouter (it asks for the key, hidden), or the local model: timmy init --chat local --model <name>.',
      ].join('\n'));
      expect(agent.isRunning()).toBe(false);
      expect(agent.lastFallback()).toBeNull();
    } finally { net.restore(); }
  });

  it('a turn the REPL runs with such an agent says the error, its cause and its fix, and seals no cost', async () => {
    const net = recordFetch();
    const agent = agentWith('');
    const out = new Sink();
    const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
    // 200 columns: the transcript cuts an error's lines at the terminal's width (the REPL's own refusal comes first there)
    const transcript = new Transcript(buildTheme(caps), new LiveRegion({ out, err: out }, { live: false }), { columns: 200 });
    try {
      const result = await runTurn(agent, transcript, 'hello', Date.now, undefined, undefined, (facts) => sealTurn({ ...facts, model: agent.getModel() }));
      expect(result).toBe('failed');
      const said = out.text.replace(/\s+/g, ' ');
      expect(said).toContain('No model key, so nothing was sent to any model.');
      expect(said).toContain('Try: timmy init --chat openrouter (it asks for the key, hidden), or the local model: timmy init --chat local --model <name>.');
      expect(net.requests).toEqual([]);
      expect(readChain('runs').at(-1)).toMatchObject({ kind: 'turn', status: 'failed', cost_measured: false });
    } finally { net.restore(); }
  });
});

describe('the last-resort fallback, labelled where the person reads it (R4 H103, D1c; R11 H169: under free-only only, never after a paid model)', () => {
  it('OpenRouter failed with a key, under free-only: a local model on this computer\'s Ollama answers, said before its answer in the REPL, never a cloud-backed one', async () => {
    process.env.TIMMY_CHAT_FREE_ONLY = '1';
    const ollama = await fake({
      models: [{ name: 'kimi-k2:cloud', remote_host: 'https://ollama.com:443' }, { name: 'granite4.2:latest' }],
      completions: [(body) => ({ content: `FAKE local answer to ${String(body.messages?.at(-1)?.content)}` })],
    });
    process.env.OLLAMA_HOST = ollama.url;
    const net = recordFetch(onlyPorts(new URL(ollama.url).port));
    const agent = agentWith('sk-or-FAKE-key');
    const asked: string[] = [];
    (agent as unknown as { client: unknown }).client = { callModel: (req: { model: string }) => { asked.push(req.model); throw new Error('503 Service Unavailable (FAKE)'); } };
    const out = new Sink();
    const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
    const transcript = new Transcript(buildTheme(caps), new LiveRegion({ out, err: out }, { live: false }), { columns: 100 });
    try {
      const result = await runTurn(agent, transcript, 'hello', Date.now, undefined, undefined, (facts) => {
        // the REPL's seal, as src/repl/main.ts would make it with the fallback's route (the one-line change the report gives)
        const fb = agent.lastFallback();
        return sealTurn({ ...facts, model: agent.getModel(), ...(fb ? { route: fallbackRoute(fb) } : {}) });
      });
      expect(result).toBe('ok');
      // (R11 H169: the chosen model once; no paid fallback model is ever asked)
      expect(asked).toEqual([CHOSEN]);
      const said = out.text.replace(/\s+/g, ' ');
      const label = `OpenRouter failed: ${CHOSEN}: 503 Service Unavailable (FAKE); answered by local granite4.2:latest on this computer's Ollama, the last-resort fallback.`;
      expect(said).toContain(label);
      expect(said).toContain('FAKE local answer to hello');
      expect(said.indexOf(label)).toBeLessThan(said.indexOf('FAKE local answer to hello'));
      const port = new URL(ollama.url).port;
      expect(agent.lastFallback()).toEqual({ model: 'granite4.2:latest', host: `127.0.0.1:${port}`, cause: expect.stringMatching(/^recursive\/flint-v1\.0:free: 503/) });
      // never the cloud-backed model: its /api/show is never asked, and the one chat request names the local model
      expect(ollama.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body.model)).toEqual(['granite4.2:latest']);
      expect(ollama.requests.some((r) => JSON.stringify(r.body ?? '').includes('kimi'))).toBe(false);
      // the network: the FAKE OpenRouter client made no request; only this computer's (FAKE) Ollama was asked
      expect(net.requests.every((r) => new URL(r.url).port === port)).toBe(true);
      expect(readChain('runs').at(-1)).toMatchObject({ kind: 'turn', status: 'ok', via: 'ollama', model_resolved: 'ollama/granite4.2:latest', sources: [{ kind: 'ollama', endpoint: 'local', tools: 'off', cost_basis: 'local endpoint' }] });
    } finally { net.restore(); }
  });

  it('with only cloud-backed models on this computer\'s Ollama, nothing answers: the turn fails with OpenRouter\'s words', async () => {
    process.env.TIMMY_CHAT_FREE_ONLY = '1';
    const ollama = await fake({ models: [{ name: 'kimi-k2:cloud', remote_host: 'https://ollama.com:443' }], completions: [() => ({ content: 'never' })] });
    process.env.OLLAMA_HOST = ollama.url;
    const net = recordFetch(onlyPorts(new URL(ollama.url).port));
    const agent = agentWith('sk-or-FAKE-key');
    (agent as unknown as { client: unknown }).client = { callModel: () => { throw new Error('503 Service Unavailable (FAKE)'); } };
    try {
      await expect(agent.send('hello')).rejects.toThrow(/OpenRouter request failed for recursive\/flint-v1\.0:free/);
      expect(ollama.requests.filter((r) => r.path !== '/api/tags')).toEqual([]);
      expect(agent.lastFallback()).toBeNull();
    } finally { net.restore(); }
  });

  it('R11 (H169): with the policy off, a failed model tries nothing else: no paid fallback, no local last resort, the reason and the next step', async () => {
    const ollama = await fake({ models: [{ name: 'granite4.2:latest' }], completions: [() => ({ content: 'never' })] });
    process.env.OLLAMA_HOST = ollama.url;
    const net = recordFetch(onlyPorts(new URL(ollama.url).port));
    const agent = agentWith('sk-or-FAKE-key', 'fake-maker/the-chosen-paid-model');
    const asked: string[] = [];
    (agent as unknown as { client: unknown }).client = { callModel: (req: { model: string }) => { asked.push(req.model); throw new Error('503 Service Unavailable (FAKE)'); } };
    try {
      const err = await agent.send('hello').then(() => null, (e: Error) => e);
      expect(err?.message.split('\n')).toEqual([
        'OpenRouter request failed for fake-maker/the-chosen-paid-model.',
        'Reason: 503 Service Unavailable (FAKE).',
        'Next: choose another model (Models (M) in timmy workbench, or /model <id> in the REPL) or try again. No fallback model was tried: a model nobody chose is never asked in its place.',
      ]);
      expect(asked).toEqual(['fake-maker/the-chosen-paid-model']);
      expect(ollama.requests).toEqual([]);
      expect(agent.lastFallback()).toBeNull();
      expect(agent.getModel()).toBe('fake-maker/the-chosen-paid-model');
    } finally { net.restore(); }
  });
});
