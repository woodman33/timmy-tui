// R4 (H87): the monitor asks nothing of a model when it starts. Before, every mount of an agent in the monitor (the first-run
// App, the shell's lazy agent, the chat's Conversation) POSTed "Reply OK." to OpenRouter: with no key, under a placeholder
// key, refused (r23b, three times); with a real key, a small paid call nobody asked for. Now the provider status says "not
// checked" and how to check it; a check runs only when the operator asks (`/model test`), and with no key nothing is sent.
//
// The monitor's real App and its real agent (src/agent/core.ts) run here; the network is a FAKE: global fetch is replaced
// for this file, every request is recorded, the model's address (openrouter.ai) answers with a FAKE body and nothing leaves
// this machine.
import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import { createAgent } from '../src/agent/core.js';
import { providerStatusWords } from '../src/tui/provider-status.js';
import { modelCheckUrl, OPENROUTER_CHECK_URL } from '../src/agent/model-check.js';

vi.mock('../src/tui/hooks/useTerminalCapabilities.js', () => ({ useTerminalCapabilities: () => ({ capabilities: null }) }));
vi.mock('../src/tui/hooks/useGraphicsPipeline.js', () => ({ useGraphicsPipeline: () => ({ pipeline: null }) }));
vi.mock('../src/tui/hooks/useTelemetryBridge.js', () => ({ useTelemetryBridge: () => ({ telemetryStatus: 'offline', queuedTelemetryCount: 0 }) }));
vi.mock('../src/tui/hooks/useModeAgentConfig.js', () => ({ useModeAgentConfig: () => {} }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let requests: string[] = [];
let cwd = '';
let dir = '';
const toModel = (): string[] => requests.filter((u) => new URL(u).hostname === 'openrouter.ai');

beforeEach(() => {
  requests = [];
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'timmy-modelcheck-'));
  process.chdir(dir); // the agent's conversation and logs folders
  vi.stubEnv('TIMMY_MODEL_CHECK_URL', '');
  // FAKE network: record every request; the model's address answers as OpenRouter would, everything else is refused here
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    return new URL(url).hostname === 'openrouter.ai'
      ? new Response(JSON.stringify({ provider: 'FAKE', choices: [{ message: { content: 'OK' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('FAKE: no network in this test', { status: 503 });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const config = (apiKey: string, onboarded: boolean) => ({ apiKey, model: 'test/model', instructions: '', maxSteps: 1, maxCost: 1, onboarded }) as never;

describe('the monitor and the model (R4 H87)', () => {
  for (const onboarded of [false, true]) {
    it(`mounting the monitor (${onboarded ? 'set up: the shell' : 'first run: the setup screen'}) with a model key sends nothing to the model`, async () => {
      const app = render(<App config={config('sk-or-FAKE-key', onboarded)} />);
      await sleep(1500);
      expect(toModel()).toEqual([]);
      app.unmount();
    });
  }

  it('the explicit check sends exactly one request (to the FAKE) and says what came back', async () => {
    const agent = createAgent(config('sk-or-FAKE-key', true));
    expect(providerStatusWords({ hasKey: agent.hasModelKey(), status: agent.modelHealthStatus })).toMatch(/not checked.*\/model test/);
    const result = await agent.testModelHealth('test/model');
    expect({ ok: result.ok, provider: result.provider, sent: toModel().length, status: agent.modelHealthStatus }).toEqual({ ok: true, provider: 'FAKE', sent: 1, status: 'READY' });
  });

  it('with no model key, the check sends nothing at all and says there is no model key', async () => {
    const agent = createAgent(config('', true));
    expect(agent.hasModelKey()).toBe(false);
    expect(providerStatusWords({ hasKey: false, status: agent.modelHealthStatus })).toMatch(/no model key/i);
    const result = await agent.testModelHealth('test/model');
    expect({ ok: result.ok, sent: requests.length }).toEqual({ ok: false, sent: 0 });
    expect(result.error).toMatch(/no model key/i);
    expect(agent.lastHealthError).toMatch(/no model key/i);
  });

  it('the check\'s address is OpenRouter\'s unless TIMMY_MODEL_CHECK_URL names a FAKE on 127.0.0.1 (never another computer)', () => {
    expect(modelCheckUrl({})).toBe(OPENROUTER_CHECK_URL);
    expect(modelCheckUrl({ TIMMY_MODEL_CHECK_URL: 'http://127.0.0.1:9/v1/chat/completions' })).toBe('http://127.0.0.1:9/v1/chat/completions');
    for (const elsewhere of ['https://example.invalid/v1', 'http://localhost:9/v1', 'not an address']) {
      expect(modelCheckUrl({ TIMMY_MODEL_CHECK_URL: elsewhere })).toBe(OPENROUTER_CHECK_URL);
    }
  });
});
