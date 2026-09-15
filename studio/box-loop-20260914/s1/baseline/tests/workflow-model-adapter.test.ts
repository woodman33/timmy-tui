import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { labManifestHash, type LocalLabModelManifest, type LabFetch, type LabToolDefinition, type LabMessage } from '../src/vision/spatial/lab-model-adapter.js';
import { runWorkflowModelEpisode, parseWorkflowFinal, WORKFLOW_BUDGETS, WORKFLOW_CONTEXT_WINDOW } from '../src/vision/spatial/workflow-model-adapter.js';

const endpoint = 'http://127.0.0.1:11434', tag = 'fixture:latest', digest = 'a'.repeat(64);
const tool: LabToolDefinition = { type: 'function', function: { name: 'inspect', description: 'Inspect scene.', parameters: { type: 'object', properties: { revision: { type: 'string' } }, required: ['revision'], additionalProperties: false } } };
const prompts: LabMessage[] = [{ role: 'system', content: 'Keep measurements separate from claims.' }, { role: 'user', content: 'Report solid fill and unknown regions from scene s1.' }];
function manifest(overrides: Partial<LocalLabModelManifest> = {}): LocalLabModelManifest {
  const value: LocalLabModelManifest = { schema: 'timmy.lab-local-model/1', provider: 'ollama', endpoint, exactTag: tag, digest, sizeBytes: 1000000, quantization: 'Q4_K_M', format: 'gguf', family: 'fixture', parameterSize: '4B', capabilities: ['completion', 'tools'], contextLength: 32768, contextWindow: 32768, toolMode: 'native', runtimeVersion: '0.33.1', hardware: { platform: 'test', architecture: 'arm64', osRelease: 'test', cpu: null, logicalCpus: 1, memoryBytes: 1000000, gpu: null, vramBytes: null }, sampler: { temperature: 0, seed: 42, num_predict: 768 }, sha256: '', ...overrides };
  value.sha256 = labManifestHash(value); return value;
}
const metadata = () => ({ capabilities: ['completion', 'tools'], details: { format: 'gguf', family: 'fixture', parameter_size: '4B', quantization_level: 'Q4_K_M' }, model_info: { 'fixture.context_length': 32768 } });
const call = (args: unknown = { revision: 'r1' }, name = 'inspect') => ({ id: 'native-id', type: 'function', function: { name, arguments: args } });
const reply = (content = '{"status":"answered","facts":{},"evidenceByFact":{}}', calls?: unknown[]) => ({ model: tag, done: true, done_reason: 'stop', message: { role: 'assistant', content, thinking: 'PRIVATE_THINKING_SENTINEL', ...(calls ? { tool_calls: calls } : {}) }, prompt_eval_count: 120, eval_count: 20, eval_duration: 1000000000 });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function server(options: { chats?: unknown[]; chat?: (body: any, n: number, signal?: AbortSignal | null) => Promise<Response> | Response; tags?: (n: number) => unknown; show?: () => unknown; version?: string } = {}) {
  let chats = 0, catalogs = 0;
  return vi.fn(async (url: Parameters<LabFetch>[0], init?: RequestInit) => {
    const actual = new URL(String(url)); expect(actual.origin).toBe(endpoint); expect(init?.redirect).toBe('error');
    if (actual.pathname === '/api/tags') return response(options.tags?.(++catalogs) ?? { models: [{ name: tag, size: 1000000, digest }] });
    if (actual.pathname === '/api/show') return response(options.show?.() ?? metadata());
    if (actual.pathname === '/api/version') return response({ version: options.version ?? '0.33.1' });
    if (actual.pathname === '/api/chat') {
      const body = JSON.parse(String(init?.body)); chats++;
      expect(body).toMatchObject({ model: tag, stream: false, think: false, truncate: false, shift: false, options: { temperature: 0, seed: 42, num_ctx: 16384 } });
      expect(body.options.num_predict).toBe(body.tools ? 512 : 768);
      return options.chat ? options.chat(body, chats, init?.signal) : response(options.chats?.[chats - 1] ?? reply());
    }
    throw new Error('Unexpected URL');
  });
}
const run = (fetchImpl: LabFetch, extra: Partial<Parameters<typeof runWorkflowModelEpisode>[0]> = {}) => runWorkflowModelEpisode({ manifest: manifest(), initialMessages: prompts, tools: [tool], dispatch: () => ({ evidenceId: 'e1', solidFill: 0.2, occupancyProbability: null, massDensity: null, humidity: null, unknownRegions: ['u1'], provenance: 'generated' }), fetchImpl, ...extra });
const chatRequests = (fetcher: ReturnType<typeof server>) => fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/chat');

describe('workflow phases and accountable budgets', () => {
  it('uses two visible tool rounds then one separately reserved structured FINAL request with tools absent', async () => {
    const fetcher = server({ chats: [reply('', [call()]), reply('', [call()]), reply()] });
    const result = await run(fetcher, { budget: { maxToolRounds: 2 } });
    expect(result.error).toBeNull(); expect(result.toolRounds).toBe(2); expect(result.finalRequests).toBe(1); expect(result.attemptedCalls).toBe(2); expect(result.executedCalls).toBe(2);
    expect(result.requests.map(r => r.phase)).toEqual(['tools', 'tools', 'final']);
    expect(JSON.stringify(result.requests[0].body)).toContain('2 tool rounds and 2 tool calls remain');
    expect(JSON.stringify(result.requests[1].body)).toContain('1 tool rounds and 1 tool calls remain');
    expect(result.requests[2].body).not.toHaveProperty('tools'); expect(result.requests[2].body).toHaveProperty('format', 'json');
    expect(result.requests[2].body).toMatchObject({ options: { num_predict: 768 } });
    expect(result.requests[0].body).toMatchObject({ options: { num_predict: 512 } });
    expect(result.requests[0].sha256).toBe(createHash('sha256').update(String(chatRequests(fetcher)[0][1]?.body)).digest('hex'));
    expect(result.requests[0].rawAssistant).toMatchObject({ content: '', nativeToolCalls: [call()] });
    expect(Object.isFrozen(result.requests[0].body)).toBe(true); expect(result.metadataRequests).toHaveLength(9);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_THINKING'); expect(JSON.stringify(result)).not.toContain('"thinking"');
    expect(result.usage).toMatchObject({ tokenAccountingAvailable: true, promptTokens: 360, completionTokens: 60 });
  });
  it('has concise, finite novice, medium and hard budgets', () => {
    expect(WORKFLOW_CONTEXT_WINDOW).toBe(16384);
    expect(WORKFLOW_BUDGETS.novice).toMatchObject({ maxToolRounds: 1, maxCalls: 2, episodeTimeoutMs: 60000 });
    expect(WORKFLOW_BUDGETS.medium).toMatchObject({ maxToolRounds: 4, maxCalls: 5, episodeTimeoutMs: 90000 });
    expect(WORKFLOW_BUDGETS.hard).toMatchObject({ maxToolRounds: 6, maxCalls: 8, episodeTimeoutMs: 120000 });
  });
  it('applies the medium and hard round ceilings while reserving their final request', async () => {
    for (const level of ['medium', 'hard'] as const) {
      const rounds = WORKFLOW_BUDGETS[level].maxToolRounds;
      const result = await run(server({ chats: [...Array.from({ length: rounds }, () => reply('', [call()])), reply()] }), { budget: level });
      expect(result.error).toBeNull(); expect(result.toolRounds).toBe(rounds); expect(result.finalRequests).toBe(1); expect(result.requests).toHaveLength(rounds + 1); expect(result.executedCalls).toBe(rounds);
    }
  });
  it('defaults novice to one acquisition request followed directly by FINAL without an extra READY turn', async () => {
    const result = await run(server({ chats: [reply('', [call()]), reply()] }));
    expect(result.error).toBeNull(); expect(result.toolRounds).toBe(1); expect(result.finalRequests).toBe(1);
    expect(result.requests.map(r => r.phase)).toEqual(['tools', 'final']); expect(result.executedCalls).toBe(1);
    expect(JSON.stringify(result.requests[0].body)).toContain('1 tool rounds and 2 tool calls remain');
  });
  it('ends tool phase on READY, then still requests and grades a separate final response', async () => {
    const result = await run(server({ chats: [reply('READY'), reply('{"status":"insufficient_evidence","missingEvidence":["depth"]}')] }));
    expect(result.error).toBeNull(); expect(result.toolPhaseEnd).toBe('ready'); expect(result.requests).toHaveLength(2); expect(result.finalJson?.status).toBe('insufficient_evidence');
  });
  it('makes exactly one FINAL request in reasoning-only mode, preserving supplied observations verbatim', async () => {
    const observations: LabMessage[] = [...prompts, { role: 'user', content: 'Observed e1: solidFill=0.2, opacity=0.5, occupancyProbability=unknown, massDensity=unknown, humidity=0.1; unknown is not empty; generated texture.' }];
    const dispatch = vi.fn(), result = await run(server(), { tools: [], initialMessages: observations, dispatch });
    expect(result.error).toBeNull(); expect(result.toolRounds).toBe(0); expect(result.requests).toHaveLength(1); expect(result.requests[0].body).not.toHaveProperty('tools');
    expect(result.requests[0].body.messages).toEqual([...observations, result.messages[observations.length]]); expect(dispatch).not.toHaveBeenCalled();
    expect(result.toolPhaseEnd).toBe('disabled');
  });
  it('preserves the measurement observation without replacing uncertainty or provenance', async () => {
    const result = await run(server({ chats: [reply('', [call()]), reply()] }));
    const message = result.messages.find(m => m.role === 'tool');
    expect(JSON.parse(message!.content)).toEqual({ evidenceId: 'e1', solidFill: 0.2, occupancyProbability: null, massDensity: null, humidity: null, unknownRegions: ['u1'], provenance: 'generated' });
  });
  it('counts every excessive native attempt and refuses the whole over-budget batch before any execution', async () => {
    const dispatch = vi.fn(), result = await run(server({ chats: [reply('', [call(), call(), call()]), reply()] }), { dispatch });
    expect(result.error).toBeNull(); expect(result.attemptedCalls).toBe(3); expect(result.calls).toHaveLength(3); expect(result.executedCalls).toBe(0); expect(result.finalRequests).toBe(1);
    expect(result.calls.every(c => c.error?.includes('batch'))).toBe(true); expect(dispatch).not.toHaveBeenCalled();
  });
  it('keeps malformed attempts as bounded observations and permits one visible correction', async () => {
    const dispatch = vi.fn(() => ({})); const result = await run(server({ chats: [reply('', [call('not json')]), reply('', [call()]), reply()] }), { dispatch, budget: { maxToolRounds: 2 } });
    expect(result.error).toBeNull(); expect(result.attemptedCalls).toBe(2); expect(result.executedCalls).toBe(1); expect(result.calls[0].error).not.toBeNull(); expect(result.protocolErrors).toHaveLength(1); expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('never executes tools emitted during FINAL and retains attempted calls separately', async () => {
    const dispatch = vi.fn(), result = await run(server({ chats: [reply('', [call()])] }), { tools: [], dispatch });
    expect(result.error).toMatch(/forbidden tool/); expect(result.attemptedCalls).toBe(1); expect(result.calls[0]).toMatchObject({ executed: false, error: 'Tools are unavailable in FINAL.' }); expect(dispatch).not.toHaveBeenCalled();
  });
  it('records one failed tool request plus a distinct final request, with no timeout retry', async () => {
    const fetcher = server({ chat: (_body, n) => n === 1 ? new Promise(() => {}) : response(reply()) });
    const result = await run(fetcher, { budget: { episodeTimeoutMs: 120, requestTimeoutMs: 10, finalReserveMs: 40 } });
    expect(result.error).toBeNull(); expect(result.protocolErrors[0]).toMatch(/timed out/); expect(result.requests).toHaveLength(2); expect(result.requests.map(r => r.phase)).toEqual(['tools', 'final']); expect(result.elapsedMs).toBeLessThan(120);
  });
  it('bounds an uncooperative transport by the total deadline and preserves FINAL time', async () => {
    const fetcher = server({ chat: () => new Promise(() => {}) });
    const result = await run(fetcher, { budget: { episodeTimeoutMs: 70, requestTimeoutMs: 20, finalReserveMs: 30 } });
    expect(result.error).toMatch(/timed out/); expect(result.requests).toHaveLength(2); expect(result.elapsedMs).toBeLessThan(100); expect(result.finalRequests).toBe(1);
  });
  it('aborts an overdue dispatcher, reports its refusal and retains reserved FINAL time', async () => {
    let signal: AbortSignal | undefined;
    const result = await run(server({ chats: [reply('', [call()]), reply()] }), { budget: { episodeTimeoutMs: 100, requestTimeoutMs: 20, finalReserveMs: 40 }, dispatch: (_name, _args, abort) => { signal = abort; return new Promise(() => {}); } });
    expect(result.error).toBeNull(); expect(result.calls[0].error).toMatch(/dispatch exceeded/); expect(signal?.aborted).toBe(true); expect(result.finalRequests).toBe(1); expect(result.elapsedMs).toBeLessThan(130);
  });
});

describe('strict accountable formatting and local identity', () => {
  it('separates raw JSON compliance from whole-fence normalization; never repairs prose', async () => {
    expect(parseWorkflowFinal('{"status":"answered"}')).toMatchObject({ rawFormatValid: true, formatValid: true, normalization: null });
    const result = await run(server({ chats: [reply('```json\n{"status":"answered"}\n```')] }), { tools: [] });
    expect(result.error).toBeNull(); expect(result.rawFormatValid).toBe(false); expect(result.formatValid).toBe(true); expect(result.normalizations).toHaveLength(1); expect(result.requests[0].rawAssistant?.content).toContain('```');
    for (const content of ['Here is JSON: {}', '{} extra', 'null', '[]', '```json\n{}\n```\n```json\n{}\n```', '```json {} ```', '{bad}']) expect(parseWorkflowFinal(content).formatValid).toBe(false);
  });
  it('sends caller final schema only during FINAL and freezes its exact body', async () => {
    const format = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };
    const result = await run(server({ chats: [reply('READY'), reply('{"status":"answered"}')] }), { finalFormat: format });
    expect(result.requests[0].body).not.toHaveProperty('format'); expect(result.requests[1].body?.format).toEqual(format);
  });
  it('revalidates exact tag, backing, digest and runtime before every inference phase', async () => {
    const changed = server({ chats: [reply('READY')], tags: n => ({ models: [{ name: tag, size: 1000000, digest: n === 1 ? digest : 'b'.repeat(64) }] }) });
    const result = await run(changed); expect(result.error).toMatch(/digest/); expect(chatRequests(changed)).toHaveLength(1); expect(result.finalRequests).toBe(0);
    for (const fetcher of [server({ version: 'other' }), server({ show: () => ({ ...metadata(), remote_host: 'https://cloud.invalid' }) })]) { const refused = await run(fetcher); expect(refused.error).toMatch(/runtime|remote/); expect(chatRequests(fetcher)).toHaveLength(0); }
  });
  it('rejects external/cloud manifests and altered inputs before inference', async () => {
    for (const model of [manifest({ endpoint: 'https://ollama.com' }), manifest({ exactTag: 'fixture:cloud' }), manifest({ contextLength: 8000 })]) { const fetcher = server(); expect((await run(fetcher, { manifest: model })).error).not.toBeNull(); expect(chatRequests(fetcher)).toHaveLength(0); }
    const changed = structuredClone([tool]);
    const result = await run(server({ chats: [reply('', [call()])] }), { tools: changed, dispatch: () => { changed[0].function.description = 'changed'; return {}; } });
    expect(result.error).toMatch(/Frozen/); expect(result.requests).toHaveLength(1);
  });
  it('rejects invalid response identity and token overages before tool dispatch but keeps raw evidence', async () => {
    for (const extra of [{ model: 'other' }, { remote_model: 'cloud' }, { eval_count: 513 }, { prompt_eval_count: 16385 }, { done: false }]) {
      const dispatch = vi.fn(), result = await run(server({ chats: [{ ...reply('', [call()]), ...extra }] }), { dispatch });
      expect(result.error).not.toBeNull(); expect(dispatch).not.toHaveBeenCalled(); expect(result.requests).toHaveLength(1);
    }
  });
  it('guards actual serialized context and bounded observations without truncating', async () => {
    const fetcher = server(), result = await run(fetcher, { initialMessages: [{ role: 'user', content: 'x'.repeat(13000) }] });
    expect(result.error).toMatch(/context budget/); expect(chatRequests(fetcher)).toHaveLength(0);
    const observed = await run(server({ chats: [reply('', [call()]), reply()] }), { dispatch: () => ({ huge: 'x'.repeat(6001) }) });
    expect(observed.calls[0].error).toMatch(/bounded observation/); expect(observed.messages.find(m => m.role === 'tool')!.content.length).toBeLessThan(200);
  });
  it('bounds responses to 1 MiB and distinguishes absent token counts from zero', async () => {
    const huge = await run(server({ chat: () => new Response('x'.repeat(1024 * 1024 + 1)) })); expect(huge.error).toMatch(/1 MiB/);
    const absent: any = reply(); delete absent.prompt_eval_count;
    const result = await run(server({ chats: [absent] }), { tools: [] });
    expect(result.error).toBeNull(); expect(result.usage).toMatchObject({ tokenAccountingAvailable: false, promptTokens: null, knownCompletionTokens: 20, missingRequestCount: 1 });
  });
});
