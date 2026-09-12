import { describe, expect, it } from 'vitest';
import {
  applyCap, applyHandoff, applyKill, applyMode, applyRelease, applyRevive, applySpend, canThink, capFromEnv,
  executeTurn, extractHandsScript, fingerprintToken, fusionPrompt, holderTurnData, initialCommanderState,
  isReadAction, parseBodybuilder, parseCommanderPath, planTurn, sealCommander, turnReceiptData, usageCost, validCommanderRoom, verifyHold
} from '../src/commander-core.js';
import { verifyEdgeChain, type EdgeReceipt } from '../src/chain.js';
import type { Executor } from '../src/code.js';
import type { Env } from '../src/tools.js';

const NOW = '2026-09-07T10:00:00.000Z';
const env: Env = { OPENROUTER_API_KEY: 'k', TIMMY_EDGE_TOKEN: 't', ALLOWED_MODELS: 'google/gemini-3.7-flash,x-ai/grok-4.6', CUSTODY_BASE_URL: 'https://custody.test' };

/** A fake OpenRouter: answers per model, reports cost like usage:{include:true} does. */
function fakeOpenRouter(answers: Record<string, string | { status: number; error: string } | { tool: string; args: Record<string, unknown>; then: string }>, seen: unknown[] = [], headers: Record<string, string>[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; messages: { role: string; content: string }[]; usage?: { include: boolean } };
    seen.push(body);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const a = answers[body.model];
    if (a && typeof a === 'object' && 'status' in a) return Response.json({ error: { message: a.error } }, { status: a.status });
    if (a && typeof a === 'object' && 'tool' in a) {
      // first round: ask for a tool; second round (a tool message is present): answer
      if (!body.messages.some((m) => m.role === 'tool')) return Response.json({ id: 'gen-tool-1', model: body.model, provider: 'Fake', choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: a.tool, arguments: JSON.stringify(a.args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0007 } });
      return Response.json({ id: 'gen-tool-2', model: body.model, provider: 'Fake', choices: [{ message: { content: a.then } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0007 } });
    }
    const content = typeof a === 'string' ? a : `answer from ${body.model}`;
    return Response.json({ id: `gen-${body.model}`, model: body.model, provider: 'Fake', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0007, prompt_tokens_details: { cached_tokens: 2 } } });
  }) as typeof fetch;
}

const fakeExecutor: Executor = {
  async execute(code, connectors) {
    const scope: Record<string, unknown> = {};
    for (const c of connectors) scope[c.name] = c.fns;
    const fn = new Function(...Object.keys(scope), `return (${code})();`) as (...a: unknown[]) => Promise<unknown>;
    try { return { result: await fn(...Object.values(scope)) }; } catch (e) { return { result: null, error: e instanceof Error ? e.message : String(e) }; }
  }
};

describe('commander routes', () => {
  it('parses /commander/:room[/:action] and nothing else', () => {
    expect(parseCommanderPath('/commander/war-room')).toEqual({ room: 'war-room', action: 'state' });
    expect(parseCommanderPath('/commander/war%3Aroom/think')).toEqual({ room: 'war:room', action: 'think' });
    expect(parseCommanderPath('/commander/r/ws')).toEqual({ room: 'r', action: 'ws' });
    expect(parseCommanderPath('/commander/r/nope')).toBeNull();
    expect(parseCommanderPath('/commander')).toBeNull();
    expect(parseCommanderPath('/runs/r/events')).toBeNull();
    expect(isReadAction('state')).toBe(true);
    expect(isReadAction('kill')).toBe(false);
    expect(validCommanderRoom('war:room.1')).toBe(true);
    expect(validCommanderRoom('../x')).toBe(false);
  });
});

describe('handoff protocol', () => {
  it('hands the role to a harness, pauses OpenRouter, and only the hold token releases it', async () => {
    const s0 = initialCommanderState('r', NOW, 2);
    expect(canThink(s0)).toEqual({ ok: true });
    const h = await applyHandoff(s0, { harness: 'opencode', holder: 'will', note: 'taking the con' }, NOW);
    expect(h.token).toMatch(/^hold_[0-9a-f]{48}$/);
    expect(h.state.held_by).toMatchObject({ harness: 'opencode', holder: 'will', since: NOW, note: 'taking the con' });
    expect(h.state.held_by?.token_fp).toBe(await fingerprintToken(h.token));
    expect(h.state.openrouter_paused).toBe(true);
    expect(JSON.stringify(h.data)).not.toContain(h.token);
    // the mind is paused while held
    const gate = canThink(h.state);
    expect(gate.ok).toBe(false);
    if (!gate.ok) { expect(gate.status).toBe(423); expect(gate.reason).toContain('held by opencode'); }
    // a second handoff is refused
    await expect(applyHandoff(h.state, { harness: 'pi', holder: 'x' }, NOW)).rejects.toMatchObject({ status: 409 });
    // the holder's own turn needs the token
    await expect(holderTurnData(h.state, { hold_token: 'wrong', did: 'x' }, 'turn_1')).rejects.toMatchObject({ status: 403 });
    const t = await holderTurnData(h.state, { hold_token: h.token, asked: 'q', known: 'k', did: 'edited three files', model: 'local/qwen' }, 'turn_1');
    expect(t).toMatchObject({ by: 'opencode', holder: 'will', source: 'handoff', mode: 'held', openrouter_paused: true, usd: 0, model: 'local/qwen' });
    expect(t.did_sha256).toMatch(/^[0-9a-f]{64}$/);
    // wrong token cannot release; the right one can; force is operator-only and recorded
    await expect(applyRelease(h.state, 'nope', NOW)).rejects.toMatchObject({ status: 403 });
    const later = '2026-09-07T10:05:00.000Z';
    const r = await applyRelease(h.state, h.token, later);
    expect(r.state.held_by).toBeNull();
    expect(r.state.openrouter_paused).toBe(false);
    expect(r.data).toMatchObject({ harness: 'opencode', forced: false, held_ms: 300000 });
    expect(canThink(r.state)).toEqual({ ok: true });
    const f = await applyRelease(h.state, undefined, later, true);
    expect(f.data.forced).toBe(true);
    await expect(applyRelease(s0, 'x', NOW)).rejects.toMatchObject({ status: 409 });
    await expect(verifyHold(s0, 'x')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses bad names', async () => {
    const s0 = initialCommanderState('r', NOW);
    await expect(applyHandoff(s0, { harness: '', holder: 'x' }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(applyHandoff(s0, { harness: 'ok', holder: 'bad name with spaces' }, NOW)).rejects.toMatchObject({ status: 400 });
  });
});

describe('kill switch, modes, cap', () => {
  it('kill stops the mind and handoffs until revive; a held room stays paused after revive', async () => {
    const s0 = initialCommanderState('r', NOW);
    const k = applyKill(s0, NOW, 'runaway');
    expect(k.state).toMatchObject({ killed: true, killed_at: NOW, openrouter_paused: true });
    expect(k.data).toMatchObject({ reason: 'runaway', was_held: false });
    const gate = canThink(k.state);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.status).toBe(423);
    await expect(applyHandoff(k.state, { harness: 'pi', holder: 'x' }, NOW)).rejects.toMatchObject({ status: 423 });
    expect(() => applyRevive(s0, NOW)).toThrow(/not killed/);
    const r = applyRevive(k.state, NOW);
    expect(r.state).toMatchObject({ killed: false, killed_at: null, openrouter_paused: false });
    const held = (await applyHandoff(s0, { harness: 'pi', holder: 'x' }, NOW)).state;
    const r2 = applyRevive(applyKill(held, NOW).state, NOW);
    expect(r2.state.openrouter_paused).toBe(true);
  });

  it('mode and cap are validated and recorded as from/to', () => {
    const s0 = initialCommanderState('r', NOW);
    expect(applyMode(s0, 'fusion', NOW).data).toEqual({ from: 'generate', to: 'fusion' });
    expect(() => applyMode(s0, 'yolo', NOW)).toThrow(/mode must be one of/);
    expect(applyCap(s0, 5, NOW).state.spend.cap_usd).toBe(5);
    expect(() => applyCap(s0, -1, NOW)).toThrow(/cap_usd/);
    // provider-sort-and-price-caps: the room carries a per-request price ceiling too
    const priced = applyCap(s0, undefined, NOW, { prompt: 1.5, completion: 6 });
    expect(priced.state.spend.max_price).toEqual({ prompt: 1.5, completion: 6 });
    expect(priced.data.max_price).toEqual({ prompt: 1.5, completion: 6 });
    expect(applyCap(priced.state, undefined, NOW, null).state.spend.max_price).toBeNull();
    expect(() => applyCap(s0, undefined, NOW, { prompt: -1 })).toThrow(/max_price.prompt/);
    expect(() => applyCap(s0, undefined, NOW)).toThrow(/cap_usd or max_price/);
    expect(capFromEnv({})).toBe(2);
    expect(capFromEnv({ COMMANDER_SPEND_CAP_USD: '0.5' })).toBe(0.5);
    expect(capFromEnv({ COMMANDER_SPEND_CAP_USD: 'x' })).toBe(2);
  });

  it('the spend ledger counts reported cost, flags unreported cost, and the cap gates the mind', () => {
    expect(usageCost({ prompt_tokens: 3, completion_tokens: 4, cost: 0.01 })).toEqual({ usd: 0.01, tokens_in: 3, tokens_out: 4, counted: true, tokens_cached: 0, tokens_reasoning: 0 });
    expect(usageCost({ prompt_tokens: 3 })).toEqual({ usd: 0, tokens_in: 3, tokens_out: 0, counted: false, tokens_cached: 0, tokens_reasoning: 0 });
    expect(usageCost({ prompt_tokens: 30, completion_tokens: 9, cost: 0.02, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 4 } })).toMatchObject({ tokens_cached: 20, tokens_reasoning: 4 });
    const extra = { provider_used: null, model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0 };
    const s0 = initialCommanderState('r', NOW, 0.001);
    const s1 = applySpend(s0, [
      { role: 'mind', model: 'm', ok: true, ms: 1, usd: 0.0007, tokens_in: 10, tokens_out: 5, counted: true, content_sha256: null, error: null, ...extra, tokens_cached: 4, tokens_reasoning: 2 },
      { role: 'actor', model: 'n', ok: true, ms: 1, usd: 0, tokens_in: 1, tokens_out: 1, counted: false, content_sha256: null, error: null, ...extra }
    ], NOW);
    expect(s1.spend).toMatchObject({ usd: 0.0007, calls: 2, tokens_in: 11, tokens_out: 6, tokens_cached: 4, tokens_reasoning: 2, uncounted: 1, last_at: NOW });
    expect(canThink(s1)).toEqual({ ok: true });
    const s2 = applySpend(s1, [{ role: 'mind', model: 'm', ok: true, ms: 1, usd: 0.0007, tokens_in: 1, tokens_out: 1, counted: true, content_sha256: null, error: null, ...extra }], NOW);
    const gate = canThink(s2);
    expect(gate.ok).toBe(false);
    if (!gate.ok) { expect(gate.status).toBe(402); expect(gate.reason).toContain('spend cap reached'); }
  });
});

describe('modes', () => {
  it('plans generate / bodybuilder / fusion against the allowlist', () => {
    const allow = ['a/one', 'b/two', 'c/three'];
    expect(planTurn('generate', allow, {})).toEqual({ mode: 'generate', calls: [{ role: 'mind', model: 'a/one' }], judge: null, fallbacks: [] });
    expect(planTurn('generate', allow, { models: ['b/two'] }).calls[0].model).toBe('b/two');
    // model-fallbacks: in generate mode the extra models become OpenRouter fallbacks
    expect(planTurn('generate', allow, { models: ['b/two', 'c/three'] })).toMatchObject({ calls: [{ role: 'mind', model: 'b/two' }], fallbacks: ['c/three'] });
    // model-variant-suffixes: an allowlisted base id may carry :nitro / :floor / :free …
    expect(planTurn('generate', allow, { models: ['a/one:nitro'] }).calls[0].model).toBe('a/one:nitro');
    expect(() => planTurn('generate', allow, { models: ['a/one:bogus'] })).toThrow(/not on allowlist/);
    expect(planTurn('bodybuilder', allow, {}).calls.map((c) => c.model)).toEqual(allow);
    expect(planTurn('bodybuilder', allow, { models: ['c/three', 'a/one'] }).calls.map((c) => c.role)).toEqual(['actor', 'actor']);
    const f = planTurn('fusion', allow, { models: ['a/one', 'b/two'], judge: 'c/three' });
    expect(f.calls).toEqual([{ role: 'actor', model: 'a/one' }, { role: 'actor', model: 'b/two' }, { role: 'judge', model: 'c/three' }]);
    expect(planTurn('fusion', allow, {}).judge).toBe('c/three');
    expect(() => planTurn('generate', allow, { models: ['z/nope'] })).toThrow(/not on allowlist/);
    expect(() => planTurn('fusion', allow, { judge: 'z/nope' })).toThrow(/judge not on allowlist/);
    expect(() => planTurn('generate', [], {})).toThrow(/allowlist/);
    expect(planTurn('bodybuilder', ['1', '2', '3', '4', '5', '6', '7'], {}).calls).toHaveLength(5);
  });

  it('generate: one mind call, usage accounted, receipt carries hashes not texts', async () => {
    const seen: { model: string; usage?: { include: boolean } }[] = [];
    const r = await executeTurn({ task: 'say hi' }, 'generate', { env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': 'hi there' }, seen) });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe('hi there');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ role: 'mind', model: 'google/gemini-3.7-flash', ok: true, usd: 0.0007, tokens_in: 10, tokens_out: 5, counted: true });
    expect(seen[0].usage).toEqual({ include: true });
    expect(r.usd).toBe(0.0007);
    expect(r.hands).toBeNull();
    const data = await turnReceiptData({ task: 'say hi' }, r, 'openrouter');
    expect(data).toMatchObject({ by: 'openrouter', mode: 'generate', ok: true, usd: 0.0007 });
    expect(JSON.stringify(data)).not.toContain('hi there');
    expect(data.answer_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bodybuilder: fans out to every actor in parallel and keeps every answer', async () => {
    const r = await executeTurn({ task: 't' }, 'bodybuilder', { env, fetch: fakeOpenRouter({}) });
    expect(r.calls.map((c) => c.model)).toEqual(['google/gemini-3.7-flash', 'x-ai/grok-4.6']);
    expect(r.outputs.map((o) => o.content)).toEqual(['answer from google/gemini-3.7-flash', 'answer from x-ai/grok-4.6']);
    expect(r.answer).toContain('[1] google/gemini-3.7-flash');
    expect(r.answer).toContain('[2] x-ai/grok-4.6');
    expect(r.usd).toBe(0.0014);
  });

  it('fusion: actors then one judge that sees every candidate; a failed actor is dropped, not fused', async () => {
    const seen: { model: string; messages: { role: string; content: string }[] }[] = [];
    const r = await executeTurn({ task: 'what is 2+2', judge: 'x-ai/grok-4.6' }, 'fusion', {
      env,
      fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': 'four', 'x-ai/grok-4.6': 'FUSED: 4 (from candidate 1)' }, seen)
    });
    expect(r.ok).toBe(true);
    expect(r.calls.map((c) => c.role)).toEqual(['actor', 'actor', 'judge']);
    const judgeReq = seen[2];
    expect(judgeReq.model).toBe('x-ai/grok-4.6');
    expect(judgeReq.messages[1].content).toContain('candidate 1 (google/gemini-3.7-flash)');
    expect(judgeReq.messages[1].content).toContain('four');
    expect(r.answer).toBe('FUSED: 4 (from candidate 1)');
    expect(fusionPrompt('t', [{ model: 'm', content: '' }])).toContain('(empty)');

    const r2 = await executeTurn({ task: 't' }, 'fusion', { env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': { status: 500, error: 'boom' }, 'x-ai/grok-4.6': 'ok' }) });
    expect(r2.calls[0]).toMatchObject({ ok: false, error: expect.stringContaining('upstream 500') });
    const judgeCall = r2.calls.find((c) => c.role === 'judge');
    expect(judgeCall?.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const r3 = await executeTurn({ task: 't' }, 'fusion', { env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': { status: 500, error: 'a' }, 'x-ai/grok-4.6': { status: 500, error: 'b' } }) });
    expect(r3.ok).toBe(false);
    expect(r3.calls.map((c) => c.role)).toEqual(['actor', 'actor']);
  });

  it('wire-now passthroughs: attribution headers, router metadata, provider/reasoning/schema/fallbacks/session/price cap in the body, cached tokens in the record', async () => {
    const seen: Record<string, unknown>[] = [];
    const headers: Record<string, string>[] = [];
    const r = await executeTurn({ task: 'q', models: ['google/gemini-3.7-flash', 'x-ai/grok-4.6:nitro'], provider: { order: ['Google'], allow_fallbacks: false }, reasoning: { effort: 'low' }, json_schema: { type: 'object', properties: { a: { type: 'string' } } }, plugins: [{ id: 'web' }], zdr: true, data_collection: 'deny', temperature: 0.1 }, 'generate', {
      env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': 'ok' }, seen, headers), room: 'war', spend: { max_price: { prompt: 2 } }
    });
    expect(r.ok).toBe(true);
    const h = headers[0];
    expect(h['HTTP-Referer']).toContain('https://');
    expect(h['X-Title']).toBe('TIMMY commander');
    expect(h['X-OpenRouter-Categories']).toContain('cli-agents');
    expect(h['X-OpenRouter-Metadata']).toBe('enabled');
    expect(seen[0]).toMatchObject({
      model: 'google/gemini-3.7-flash', models: ['google/gemini-3.7-flash', 'x-ai/grok-4.6:nitro'],
      provider: { order: ['Google'], allow_fallbacks: false, max_price: { prompt: 2 }, zdr: true, data_collection: 'deny' },
      reasoning: { effort: 'low' }, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } }, plugins: [{ id: 'web' }],
      session_id: 'commander:war', temperature: 0.1, usage: { include: true }
    });
    expect(r.calls[0]).toMatchObject({ provider_used: 'Fake', model_used: 'google/gemini-3.7-flash', generation_id: 'gen-google/gemini-3.7-flash', tokens_cached: 2 });
    const data = await turnReceiptData({ task: 'q', provider: { order: ['Google'] }, zdr: true }, r, 'openrouter');
    expect(data.passthrough).toMatchObject({ provider: true, zdr: true, fallbacks: 0 });
    expect((data.models as { generation_id: string }[])[0].generation_id).toBe('gen-google/gemini-3.7-flash');
  });

  it('native tool calling: the mind calls an edge tool, the result goes back, one more round answers', async () => {
    const seen: { messages: { role: string; content: string }[]; tools?: unknown[] }[] = [];
    const r = await executeTurn({ task: 'how many tools?', tools: true }, 'generate', { env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': { tool: 'tools_list', args: {}, then: 'seven tools' } }, seen) });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe('seven tools');
    expect(seen[0].tools?.length).toBeGreaterThan(3);
    expect(seen[1].messages.some((m) => m.role === 'tool')).toBe(true);
    expect(r.calls[0].tool_calls).toEqual([{ name: 'tools_list', ok: true, ms: expect.any(Number) }]);
    expect(r.calls[0].usd).toBe(0.0014);
    // a paid tool without the approval token is refused inside the round, and the refusal goes back to the model
    const seen2: { messages: { role: string; content: string }[] }[] = [];
    const r2 = await executeTurn({ task: 'chat', tools: true }, 'generate', { env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': { tool: 'openrouter_chat', args: { model: 'x-ai/grok-4.6', messages: [{ role: 'user', content: 'hi' }] }, then: 'refused' } }, seen2) });
    expect(r2.calls[0].tool_calls?.[0]).toMatchObject({ name: 'openrouter_chat', ok: false, error: expect.stringContaining('approval') });
    expect(seen2[1].messages.find((m) => m.role === 'tool')?.content).toContain('approval');
  });

  it('native routers: fusion → openrouter/fusion in one call; bodybuilder → the router\'s requests run on the allowlist', async () => {
    const seen: { model: string }[] = [];
    const f = await executeTurn({ task: 'q', native: true }, 'fusion', { env, fetch: fakeOpenRouter({ 'openrouter/fusion': 'fused natively' }, seen) });
    expect(f.native).toBe(true);
    expect(f.answer).toBe('fused natively');
    expect(f.calls.map((c) => c.model)).toEqual(['openrouter/fusion']);
    const seen2: { model: string }[] = [];
    const b = await executeTurn({ task: 'q', native: true }, 'bodybuilder', { env, fetch: fakeOpenRouter({ 'openrouter/bodybuilder': '{"requests":[{"model":"x-ai/grok-4.6","messages":[{"role":"user","content":"q1"}]},{"model":"nope/model","messages":[]}]}', 'x-ai/grok-4.6': 'grok says' }, seen2) });
    expect(b.calls.map((c) => c.model)).toEqual(['openrouter/bodybuilder', 'x-ai/grok-4.6']);
    expect(b.answer).toContain('grok says');
    expect(b.answer).toContain('not on the allowlist, not run: nope/model');
    expect(parseBodybuilder('```json\n[{"model":"a/b"}]\n```')).toEqual([{ model: 'a/b', messages: [] }]);
    expect(parseBodybuilder('nothing')).toEqual([]);
    // the abort signal turns into a recorded failure, not a throw
    const ac = new AbortController();
    ac.abort();
    const aborted = await executeTurn({ task: 'q' }, 'generate', { env, fetch: (async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }) as unknown as typeof fetch, signal: ac.signal });
    expect(aborted.ok).toBe(false);
    expect(aborted.calls[0].error).toContain('kill switch');
  });

  it('a missing upstream key is a recorded failure, not a throw', async () => {
    const r = await executeTurn({ task: 't' }, 'generate', { env: { ...env, OPENROUTER_API_KEY: undefined }, fetch: fakeOpenRouter({}) });
    expect(r.ok).toBe(false);
    expect(r.calls[0].error).toContain('OPENROUTER_API_KEY');
  });

  it('refuses an empty task', async () => {
    await expect(executeTurn({ task: '  ' }, 'generate', { env, fetch: fakeOpenRouter({}) })).rejects.toMatchObject({ status: 400 });
  });
});

describe('hands (Code Mode)', () => {
  it('extracts a valid script from the mind and refuses forbidden ones', () => {
    expect(extractHandsScript('```js\nasync () => { return await timmy.tools_list({}); }\n```')).toBe('async () => { return await timmy.tools_list({}); }');
    expect(extractHandsScript('plain prose, no script')).toBeNull();
    expect(extractHandsScript('async () => { return eval("1"); }')).toBeNull();
  });

  it('runs the script through Code Mode and cites its receipt on the turn', async () => {
    const script = 'async () => { const t = await timmy.tools_list({}); return t.length; }';
    const r = await executeTurn({ task: 'count the tools' }, 'generate', { env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': '```js\n' + script + '\n```' }), executor: fakeExecutor });
    expect(r.hands).toMatchObject({ ok: true, error: null, tool_calls: 1 });
    expect(r.hands?.receipt).toMatch(/^[0-9a-f]{64}$/);
    const noExec = await executeTurn({ task: 'count the tools' }, 'generate', { env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': script }) });
    expect(noExec.hands).toBeNull();
    expect(noExec.hands_note).toContain('no Code Mode executor');
    const off = await executeTurn({ task: 'x', hands: false }, 'generate', { env, fetch: fakeOpenRouter({ 'google/gemini-3.7-flash': script }) });
    expect(off.hands).toBeNull();
    expect(off.hands_note).toBeNull();
  });
});

describe('room chain', () => {
  it('every mutation lands on one chain per room that verifies from genesis', async () => {
    const chain: EdgeReceipt[] = [];
    const s0 = initialCommanderState('war', NOW);
    const h = await applyHandoff(s0, { harness: 'jcode', holder: 'will' }, NOW);
    await sealCommander(chain, 'war', 'commander.handoff', h.data);
    const rel = await applyRelease(h.state, h.token, NOW);
    await sealCommander(chain, 'war', 'commander.release', rel.data);
    await sealCommander(chain, 'war', 'commander.kill', applyKill(rel.state, NOW).data);
    expect(chain.map((r) => r.kind)).toEqual(['commander.handoff', 'commander.release', 'commander.kill']);
    expect(chain.every((r) => r.subject === 'commander:war')).toBe(true);
    expect((await verifyEdgeChain(chain)).ok).toBe(true);
    await expect(sealCommander(chain, 'other', 'commander.mode', {})).rejects.toThrow(/subject mismatch/);
  });
});
