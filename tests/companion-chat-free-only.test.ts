/**
 * R5 (H132, the lead's free-only policy, 39d21ec): the browser companion's chat route (GET /api/chat/route, what the page's Send
 * shows) under free-only, over real HTTP on 127.0.0.1. The page's model is named to the one chat route (src/agent/chat-route.ts
 * chatRouteNow), so its price can be known (src/agent/model-price.ts, from OpenRouter's catalog). Free-only on and the model
 * not known to be free: Send is off in the policy's own words (free-only, its cause, what to try), never "no key". Free by the
 * catalog: the route is ready, and the label says free-only passed.
 *
 * R11 (H169, Phase 0 item 2): the page's model is the one chosen in the settings (the Workbench's Models choice, read by
 * path: src/companion/chat-route.ts pageModel), never one of the page's own; with none chosen, Send is off ("No model chosen:
 * choose one in Models"). R11 round 4 (H169, contract C3): the legacy POST /chat stream is gone (404; the FAKE upstream it
 * posted to receives nothing): the page's chat is the real turn, POST /api/chat/turn (tests/companion-chat-run.test.ts).
 *
 * FAKE pieces, labelled: the catalog (a file in this test's TIMMY_HOME, prices made up), the model (FAKE: chosen in this
 * test's own settings file), the OpenRouter key (FAKE-…) and the upstream (a server on 127.0.0.1 that records what reaches
 * it: nothing, now). Nothing leaves this computer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';

const KEY = 'FAKE-openrouter-key-free-only';
/** FAKE: the model this test's settings choose (it is not a real OpenRouter id; the FAKE catalog lists it). */
const MODEL = 'fake-maker/fake-page-model';

describe('the companion\'s chat under free-only: refused in the policy\'s words for a model not known to be free, sent for a free one (R5 H132)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let home = '';
  let upstream: Server;
  const posted: string[] = [];
  let companion: CompanionServer;
  let base = '';
  let token = '';
  const env: Record<string, string | undefined> = {};

  /** FAKE: OpenRouter's catalog as `timmy models --refresh` keeps it in the Timmy home, the page's model at `prompt`/`completion` per token. */
  const catalog = (pricing: { prompt: string; completion: string } | null): void => {
    mkdirSync(join(home, 'models'), { recursive: true });
    const models = pricing ? [{ id: MODEL, name: 'FAKE listing', context_length: 131072, pricing, supported_parameters: ['tools'] }] : [];
    writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-15T00:00:00.000Z', models }));
  };
  /** R11 (H169): the settings file this companion reads by path (TIMMY_SETTINGS_DIR), with a model chosen or none. */
  const settings = (model: string | null): void => {
    mkdirSync(join(box, 'settings'), { recursive: true });
    writeFileSync(join(box, 'settings', 'config.json'), JSON.stringify(model ? { model, modelChosen: model } : {}));
  };
  const route = async (): Promise<Record<string, unknown>> => {
    const r = await fetch(`${base}/api/chat/route`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    return await r.json() as Record<string, unknown>;
  };
  /** The legacy POST /chat: gone (R11 round 4). Its status, and that the FAKE upstream saw nothing. */
  const legacyChat = async (message: string): Promise<number> => {
    const r = await fetch(`${base}/chat`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    await r.text();
    return r.status;
  };

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'h132-free-only-'));
    home = join(box, 'home');
    mkdirSync(join(box, 'project'), { recursive: true });
    // the catalog is read from this process's Timmy home (src/models/registry.ts catalogPath): this test's own
    process.env.TIMMY_HOME = home;
    Object.assign(env, { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(box, 'settings'), OPENROUTER_API_KEY: KEY, TIMMY_CHAT_FREE_ONLY: '1' });
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => {
        posted.push(`${req.headers.authorization ?? ''} ${body}`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FAKE free answer' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    process.env.TIMMY_REPO = join(box, 'project');
    companion = await startCompanionServer(0, { chatEnv: env, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/chat/completions` });
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
    base = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  });

  afterAll(async () => {
    await companion?.shutdown();
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('R11 (H169, item 2): no model chosen in the settings: Send is off saying "No model chosen: choose one in Models", nothing names a model of the page\'s own; the legacy POST /chat is gone', async () => {
    catalog({ prompt: '0', completion: '0' });
    settings(null);
    const r = await route();
    expect(r).toMatchObject({ kind: 'none', ready: false, chat: 'openrouter', reason: 'no-model-chosen', label: 'No model chosen: choose one in Models · Send is off' });
    const words = String(r.words);
    expect(words).toMatch(/^Send is off: No model chosen: choose one in Models \(this page's Chat, or M in timmy workbench: the same choice serves both\), and nothing is sent to a model nobody chose\. Nothing is sent from this page until then\. /);
    expect(r.refusal).toEqual(expect.arrayContaining(['Error: No model chosen. /model <id> chooses one (/model free lists free ones).', 'Nothing was sent to any model.']));
    expect(JSON.stringify(r)).not.toMatch(/qwen|claude-opus|fake-page-model/);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(await legacyChat('FAKE: a message no model was chosen for')).toBe(404);
    expect(posted).toEqual([]);
  });

  it('free-only on, the page\'s model priced by the catalog: Send is off, saying free-only and its price, not a missing key; the legacy POST /chat is gone', async () => {
    catalog({ prompt: '0.000003', completion: '0.000015' });
    settings(MODEL);
    const r = await route();
    expect(r).toMatchObject({ kind: 'none', ready: false, chat: 'openrouter', label: 'free-only · Send is off' });
    const words = String(r.words);
    expect(words).toMatch(/^Send is off: free-only is on, and fake-maker\/fake-page-model is not known to be free, so this message was not sent\. /);
    expect(words).toContain(`Cause: ${MODEL} costs $3 in / $15 out per 1M tokens.`);
    expect(words).toContain('Try: choose a free model: /model free in the REPL lists them, then /model <id>:free (free-only stays on)');
    // R5 lead (the finish line, item 3): turning free-only off is never the fix offered
    expect(words).not.toMatch(/free-only off|TIMMY_CHAT_FREE_ONLY=0/);
    expect(words).not.toMatch(/no OpenRouter key/);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(await legacyChat('FAKE: a message free-only must not send')).toBe(404);
    expect(posted).toEqual([]);
  });

  it('free-only on and the catalog does not list the page\'s model: unknown is refused too, never passed', async () => {
    catalog(null);
    const r = await route();
    expect(r).toMatchObject({ kind: 'none', ready: false, chat: 'openrouter', label: 'free-only · Send is off' });
    expect(String(r.words)).toContain(`Cause: ${MODEL}: price unknown: the OpenRouter catalog of 2026-10-15 does not list it (timmy models --refresh).`);
    expect(await legacyChat('FAKE: not sent either')).toBe(404);
    expect(posted).toEqual([]);
  });

  it('free-only on and the page\'s model free by the catalog: the route is ready, and the label and words say free-only passed; the legacy stream is gone', async () => {
    catalog({ prompt: '0', completion: '0' });
    const r = await route();
    expect(r).toMatchObject({ kind: 'openrouter', ready: true, freeOnly: true, model: MODEL, label: `${MODEL} · OpenRouter · the project's conversation · free-only: free` });
    expect(String(r.words)).toBe(`The project's conversation, the one the Workbench and the REPL continue: the agent's tools, gated at NEEDS YOU; every turn sealed with a receipt. Send asks ${MODEL} (the model chosen in Models) through OpenRouter with this computer's key (found in the environment). Free-only is on, and this model is free: free (OpenRouter catalog of 2026-10-15) · 131k context · tools.`);
    // R11 round 4: the raw stream to the upstream is gone; the real turn (POST /api/chat/turn) is the page's chat
    expect(await legacyChat('FAKE: a free message')).toBe(404);
    expect(posted).toEqual([]);
  });

  it('free-only off: a priced model is sent, and its price is said, never as free', async () => {
    catalog({ prompt: '0.000003', completion: '0.000015' });
    env.TIMMY_CHAT_FREE_ONLY = '0';
    try {
      const r = await route();
      expect(r).toMatchObject({ kind: 'openrouter', ready: true, freeOnly: false, model: MODEL, label: `${MODEL} · OpenRouter · the project's conversation · each message spends credits`, price: '$3 in / $15 out per 1M tokens (OpenRouter catalog of 2026-10-15) · 131k context · tools' });
      expect(String(r.words)).toContain('each message spends its credits. Its price: $3 in / $15 out per 1M tokens');
    } finally { env.TIMMY_CHAT_FREE_ONLY = '1'; }
  });
});
