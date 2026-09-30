import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildVolumeModelContext, type SpatialModelContext } from '../src/vision/spatial/model-context.js';
import { buildNativeModelContext } from '../src/vision/spatial/native-model-context.js';
import { localSpatialModels, reviewSpatialContext as executeReview, validateSpatialReview } from '../src/vision/spatial/local-model-review.js';
import { contextFromSource, runModelCli } from '../src/vision/spatial/model-cli.js';
import { runSpatialCli } from '../src/vision/spatial/cli.js';
import { readChain, verifyChain, verifySignature } from '../src/utils/receipts.js';
import { spatialModelCatalogTool, spatialModelContextTool, spatialModelReviewTool } from '../src/agent/spatial-model-tools.js';
import { defaultTools } from '../src/agent/tools.js';

const canonicalManifest = resolve('studio/spatial-volume-20260912/grid10/manifest.json');
const digest = 'e'.repeat(64);
const modelName = 'fixture-local:latest';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let directory: string;
let context: SpatialModelContext;
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const reviewSpatialContext: typeof executeReview = (packet, options) => executeReview(packet, { currentContext: () => packet as SpatialModelContext, ...options });
const metadata = (vision = false) => ({ details: { format: 'gguf', family: 'test' }, capabilities: ['completion', 'tools', ...(vision ? ['vision'] : [])], model_info: { 'test.context_length': 8192 } });
function goodReview(packet = context) {
  const fact = packet.facts[0];
  return { sourceSha256: packet.source.sha256, summary: 'Review the known location while preserving unknown material.', materialKnown: false, densityKnown: false,
    annotations: [{ entityId: fact.entityId, factIds: [fact.id], comment: 'Inspect the cited source property.', proposedAction: 'inspect' }] };
}
interface ServerOptions {
  vision?: boolean;
  names?: string[];
  review?: unknown;
  doneReason?: string;
  failure?: number;
  timeout?: boolean;
  aliasTurnsRemote?: boolean;
  excessBody?: boolean;
  contextLength?: number;
  responseModel?: string;
  responseRemoteHost?: string;
  responseRemoteModel?: string;
  noTools?: boolean;
  skipCite?: boolean;
  wrongHandle?: boolean;
  excessCalls?: boolean;
  wrongTool?: boolean;
  onChat?: () => void;
  changedWeights?: boolean;
  physicalClaim?: boolean;
  transportBody?: string;
  transportStatus?: number;
}
function mockOllama(options: ServerOptions = {}) {
  let showCount = 0, chatCount = 0, tagsCount = 0;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/tags') { tagsCount++; return jsonResponse({ models: (options.names ?? [modelName]).map(name => ({ name, digest: options.changedWeights && tagsCount > 1 ? 'changed' : digest, size: 1_000_000 })) }); }
    if (path === '/api/show') {
      showCount++;
      return jsonResponse({ ...metadata(options.vision), ...(options.noTools ? { capabilities: ['completion'] } : {}), model_info: { 'test.context_length': options.contextLength ?? 8192 },
        ...(options.aliasTurnsRemote && showCount > 1 ? { remote_model: 'some-remote-model' } : {}) });
    }
    if (path === '/api/chat') {
      chatCount++; options.onChat?.();
      if (options.transportBody !== undefined) return new Response(options.transportBody, { status: options.transportStatus ?? 200 });
      if (options.timeout) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('fixture request timed out')), { once: true });
      });
      if (options.failure) return jsonResponse({ error: 'fixture server failure' }, options.failure);
      if (options.excessBody) return new Response('x'.repeat(2 * 1024 * 1024 + 1));
      const request = JSON.parse(String(init?.body));
      const input = JSON.parse(request.messages[1].content), packet = input.context as SpatialModelContext;
      const handle = input.observations[0].handle_id, entityId = input.observations[0].objectId;
      const format = input.outputSchema;
      const final = { run_id: format.properties.run_id.const, source_revision: options.review ? (options.review as any).sourceSha256 : packet.source.sha256,
        evidence: { [entityId]: [options.wrongHandle ? 'metric_depth' : handle] }, payload: {
          summary: 'Inspect the source without claiming physical truth.', materialKnown: options.physicalClaim ?? false, densityKnown: false,
          annotations: [{ entityId, comment: 'Inspect this retained source declaration.', proposedAction: 'inspect' }] } };
      const calls = Array.from({ length: options.excessCalls ? 9 : 1 }, () => ({ function: { name: options.wrongTool ? 'shell' : 'cite', arguments: { handle_id: options.wrongHandle ? 'metric_depth' : handle } } }));
      return jsonResponse({ model: options.responseModel ?? modelName, remote_host: options.responseRemoteHost,
        remote_model: options.responseRemoteModel, done: true, done_reason: options.doneReason ?? 'stop',
        message: { role: 'assistant', content: chatCount === 1 && !options.skipCite ? '' : JSON.stringify(final),
          ...(chatCount === 1 && !options.skipCite ? { tool_calls: calls } : {}), thinking: 'PRIVATE_DELIBERATION_NOT_RETAINED' },
        prompt_eval_count: 100, eval_count: 25, total_duration: 1_000_000 });
    }
    throw new Error(`Unexpected external or native mutation request: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const chatCalls = (mock: ReturnType<typeof mockOllama>) => mock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/chat');
function nativeFile(kind: 'hana' | 'spline', count = 1) {
  const objects = Array.from({ length: count }, (_, index) => kind === 'spline'
    ? { id: `mesh-${index}`, name: `Mesh ${index}`, size: [80, 80, 80], position: [10 * index, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1], parentId: 'source-parent', mesh: { vertices: 32, triangles: 64 } }
    : { id: `frame-${index}`, name: `Frame ${index}`, size: [1200, 800], center: [600, 400], children: [{ id: 'child', children: [{ id: 'grandchild' }] }] });
  const path = join(directory, `${kind}-${count}.json`);
  const envelope = { tool: kind === 'spline' ? '3d_get_objects' : '2d_get_scene', capturedAtUtc: '2026-09-12T00:00:00Z', response: { content: [{ type: 'text', text: JSON.stringify(kind === 'spline' ? objects : { scene: { objects } }) }] } };
  writeFileSync(path, JSON.stringify(envelope));
  return path;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'timmy-local-spatial-review-'));
  vi.stubEnv('OLLAMA_HOST', 'http://127.0.0.1:11434');
  context = buildVolumeModelContext(canonicalManifest);
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('spatial model review reference validation', () => {
  it('accepts the current source binding and inert annotation', () => {
    expect(validateSpatialReview(goodReview(), context).sourceSha256).toBe(sha(readFileSync(canonicalManifest)));
  });
  it('refuses different sources, dangling entities/facts and cross-entity citations', () => {
    const wrongSource = { ...goodReview(), sourceSha256: 'a'.repeat(64) };
    expect(() => validateSpatialReview(wrongSource, context)).toThrow(/different source/);
    const wrongEntity = goodReview(); wrongEntity.annotations[0].entityId = 'missing';
    expect(() => validateSpatialReview(wrongEntity, context)).toThrow(/unknown entity/);
    const wrongFact = goodReview(); wrongFact.annotations[0].factIds = ['nonexistent.fact'];
    expect(() => validateSpatialReview(wrongFact, context)).toThrow(/unknown fact/);
    const crossEntity = goodReview(); crossEntity.annotations[0].factIds = ['cell-center.fill'];
    expect(() => validateSpatialReview(crossEntity, context)).toThrow(/another entity/);
  });
  it('refuses arbitrary executable actions and undocumented response fields', () => {
    const executable = goodReview(); executable.annotations[0].proposedAction = 'execute_shell';
    expect(() => validateSpatialReview(executable, context)).toThrow();
    expect(() => validateSpatialReview({ ...goodReview(), execute: 'curl something' }, context)).toThrow();
  });
});

describe('retained native app context', () => {
  it('preserves source-parent coordinates and scene units without declaring metric measurement', () => {
    const path = nativeFile('spline'), packet = buildNativeModelContext(path, 'spline');
    expect(packet.source.sha256).toBe(sha(readFileSync(path)));
    expect(packet.frame.units).toBe('scene-unit');
    expect(packet.facts.find(f => f.key === 'positionInParent')?.value).toEqual([0, 0, 0]);
    expect(packet.facts.find(f => f.key === 'parentFrameId')?.value).toBe('source-parent');
    expect(packet.facts.find(f => f.key === 'physicalMaterial')).toMatchObject({ value: null, epistemic: 'unknown' });
    expect(packet.limitations.join(' ')).toContain('No world transform');
  });
  it('counts Hana descendants while keeping pixels separate from physical dimensions', () => {
    const packet = buildNativeModelContext(nativeFile('hana'), 'hana');
    expect(packet.frame.units).toBe('px');
    expect(packet.facts.find(f => f.key === 'descendantCount')).toMatchObject({ value: 2, epistemic: 'computed' });
    expect(packet.facts.find(f => f.key === 'intrinsicDensityKgM3')?.value).toBeNull();
  });
  it('supports two captured objects and remains within the context fact budget for eight', () => {
    for (const kind of ['hana', 'spline'] as const) {
      const two = buildNativeModelContext(nativeFile(kind, 2), kind);
      expect(two.entities).toHaveLength(2);
      const bounded = buildNativeModelContext(nativeFile(kind, 8), kind);
      expect(bounded.entities.length).toBeGreaterThan(0);
      expect(bounded.facts.length).toBeLessThanOrEqual(64);
    }
  });
  it('refuses failed/mismatched MCP captures, missing object IDs and nonfinite coordinates', () => {
    const path = nativeFile('spline');
    expect(() => buildNativeModelContext(path, 'hana')).toThrow(/does not match/);
    expect(() => buildNativeModelContext(path, 'spline', 'missing')).toThrow(/not present/);
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    envelope.response.isError = true; writeFileSync(path, JSON.stringify(envelope));
    expect(() => buildNativeModelContext(path, 'spline')).toThrow(/successful MCP/);
    delete envelope.response.isError;
    const objects = JSON.parse(envelope.response.content[0].text); objects[0].position[0] = null;
    envelope.response.content[0].text = JSON.stringify(objects); writeFileSync(path, JSON.stringify(envelope));
    expect(() => buildNativeModelContext(path, 'spline')).toThrow(/finite/);
  });
});

describe('local inference admission and retained execution', () => {
  it('retains authentic signed receipts and bindings while leaving native edits unexecuted', async () => {
    const fetcher = mockOllama();
    const result = await reviewSpatialContext(context, { model: modelName, question: 'What is known about this volume?', dir: directory });
    expect(result.ok).toBe(true); expect(result.signatureVerified).toBe(true);
    expect(result.scope).toMatchObject({ sourceReferencesChecked: true, semanticCorrectnessChecked: false, nativeEditsExecuted: false, physicalValidation: false });
    const chain = readChain('runs', directory);
    expect(chain.map(r => r.kind)).toEqual(['spatial.model.intent', 'spatial.model.result']);
    expect(chain.every(verifySignature)).toBe(true);
    expect(verifyChain('runs', directory).ok).toBe(true);
    expect(chain[1].plan_hash).toBe(chain[0].hash);
    expect(chain[1].output_sha256).toBe(sha(readFileSync(result.reportPath)));
    expect(chain[0].sources).toEqual([{ source_sha256: context.source.sha256, model_digest: digest, endpoint: 'http://127.0.0.1:11434' }]);
    expect(result.reportPath.startsWith(directory)).toBe(true);
    expect(readFileSync(join(dirname(result.reportPath), 'response.json'), 'utf8')).not.toContain('PRIVATE_DELIBERATION');
    expect(chatCalls(fetcher)).toHaveLength(2);
    const request = JSON.parse(String(chatCalls(fetcher)[0][1]?.body));
    expect(request.options).toMatchObject({ num_ctx: 8192, temperature: 0 });
    expect(request).toMatchObject({ truncate: false, shift: false });
    expect(request.tools[0].function.name).toBe('cite');
    expect(JSON.parse(String(chatCalls(fetcher)[1][1]?.body)).format.properties.evidence).toBeDefined();
  });
  it('caps the allocated context to the model limit while refusing silent truncation', async () => {
    const fetcher = mockOllama({ contextLength: 4096 });
    const result = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
    expect(result.ok).toBe(true);
    const request = JSON.parse(String(chatCalls(fetcher)[0][1]?.body));
    expect(request.options.num_ctx).toBe(4096);
    expect(request).toMatchObject({ truncate: false, shift: false });
  });
  it('rejects remote execution metadata or a different response model after dispatch', async () => {
    for (const config of [{ responseRemoteHost: 'https://ollama.com' },
      { responseRemoteModel: 'remote-model' }, { responseModel: 'different-local:latest' }]) {
      mockOllama(config);
      const result = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
      expect(result.ok).toBe(false); expect(result.review).toBeNull();
      expect(result.error).toMatch(/remote execution|differs from the requested/);
      expect(readChain('runs', directory).at(-1)?.status).toBe('failed');
      expect(result.signatureVerified).toBe(true);
    }
  });
  it('records a failed result when the response cites another source revision', async () => {
    mockOllama({ review: { ...goodReview(), sourceSha256: 'a'.repeat(64) } });
    const result = await reviewSpatialContext(context, { model: modelName, question: 'Review the packet.', dir: directory });
    expect(result.ok).toBe(false); expect(result.review).toBeNull(); expect(result.error).toMatch(/wrong_revision/);
    expect(readChain('runs', directory)[1].status).toBe('failed');
    expect(result.signatureVerified).toBe(true);
  });
  it('does not dispatch cloud tags or image inputs to non-vision models', async () => {
    let fetcher = mockOllama({ names: ['qwen:cloud'] });
    await expect(reviewSpatialContext(context, { model: 'qwen:cloud', question: 'Review.', dir: directory })).rejects.toThrow(/Cloud-backed/);
    expect(chatCalls(fetcher)).toHaveLength(0); expect(readChain('runs', directory)).toHaveLength(0);
    fetcher = mockOllama();
    await expect(reviewSpatialContext(context, { model: modelName, question: 'Review.', imagePath: '/missing/image.png', dir: directory })).rejects.toThrow(/vision support/);
    expect(chatCalls(fetcher)).toHaveLength(0); expect(readChain('runs', directory)).toHaveLength(0);
  });
  it('records failure without dispatch if the local alias becomes remote after selection', async () => {
    const fetcher = mockOllama({ aliasTurnsRemote: true });
    const result = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
    expect(result.ok).toBe(false); expect(result.error).toMatch(/cloud-backed/);
    expect(chatCalls(fetcher)).toHaveLength(0); expect(readChain('runs', directory)[1].status).toBe('failed');
  });
  it('retains image bytes by hash and marks image/geometry alignment unverified', async () => {
    const fetcher = mockOllama({ vision: true });
    const imagePath = join(directory, 'pixel.png');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    writeFileSync(imagePath, image);
    const result = await reviewSpatialContext(context, { model: modelName, question: 'Interpret this view.', imagePath, dir: directory });
    expect(result.input).toEqual({ mode: 'context-and-image', imageSha256: sha(image) });
    const retained = JSON.parse(readFileSync(join(dirname(result.reportPath), 'request.json'), 'utf8'));
    expect(retained.image).toMatchObject({ sha256: sha(image), geometryAlignment: 'not-verified' });
    expect(retained.messages[1].images).toBeUndefined();
    expect(readFileSync(join(dirname(result.reportPath), 'image.bin'))).toEqual(image);
    expect(JSON.parse(String(chatCalls(fetcher)[0][1]?.body)).messages[1].images).toEqual([image.toString('base64')]);
  });
  it('rejects symlinked, oversized and non-image files before inference or receipts', async () => {
    const fetcher = mockOllama({ vision: true });
    const actual = join(directory, 'actual.png'), link = join(directory, 'linked.png');
    writeFileSync(actual, Buffer.from([137,80,78,71,13,10,26,10]));
    symlinkSync(actual, link);
    const huge = join(directory, 'too-large.png'); writeFileSync(huge, Buffer.alloc(4 * 1024 * 1024 + 1));
    const invalid = join(directory, 'invalid.png'); writeFileSync(invalid, 'ordinary text');
    for (const imagePath of [link, huge, invalid]) {
      await expect(reviewSpatialContext(context, { model: modelName, question: 'Review.', imagePath, dir: directory })).rejects.toThrow();
    }
    expect(chatCalls(fetcher)).toHaveLength(0); expect(readChain('runs', directory)).toHaveLength(0);
  });
  it('logs a signed failure after a finite inference timeout', async () => {
    const fetcher = mockOllama({ timeout: true });
    const result = await reviewSpatialContext(context, { model: modelName, question: 'Review.', timeoutMs: 1000, dir: directory });
    expect(result.ok).toBe(false); expect(result.error).toMatch(/timed out/);
    expect(chatCalls(fetcher)).toHaveLength(1);
    expect(readChain('runs', directory)[1].status).toBe('failed'); expect(result.signatureVerified).toBe(true);
  });
  it('rejects truncated and oversized responses without admitting model annotations', async () => {
    for (const config of [{ doneReason: 'length' }, { excessBody: true }]) {
      mockOllama(config);
      const result = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
      expect(result.ok).toBe(false); expect(result.review).toBeNull(); expect(result.signatureVerified).toBe(true);
      expect(result.error).toMatch(/incomplete|2 MiB/);
    }
  });
});

describe('CLI and registered SDK tool surfaces', () => {
  it('routes the spatial models context command to the same read-only packet', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const output: string[] = [];
    expect(await runSpatialCli(['models', 'context', canonicalManifest, '--json'], text => output.push(text))).toBe(0);
    expect(JSON.parse(output[0])).toEqual(context);
    expect(fetcher).not.toHaveBeenCalled(); expect(readChain('runs', directory)).toHaveLength(0);
  });
  it('validates source kinds and CLI options, then performs a bounded explicit review', async () => {
    const fetcher = mockOllama(); const output: string[] = [];
    expect(await runModelCli(['review', canonicalManifest], text => output.push(text), directory)).toBe(2);
    expect(await runModelCli(['context', canonicalManifest, '--json', '--json'], text => output.push(text), directory)).toBe(2);
    expect(await runModelCli(['context', canonicalManifest, '--kind', 'mesh'], text => output.push(text), directory)).toBe(1);
    expect(() => contextFromSource(canonicalManifest, 'volume', 'not-valid-for-volumes')).toThrow(/native sources/);
    expect(chatCalls(fetcher)).toHaveLength(0);
    output.length = 0;
    expect(await runModelCli(['review', canonicalManifest, '--model', modelName, '--question', 'Review.', '--json'], text => output.push(text), directory)).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({ ok: true, signatureVerified: true });
  });
  it('exposes callable SDK tools whose context and catalog operations remain read-only', async () => {
    mockOllama();
    const contextTool = (spatialModelContextTool as any).function;
    const catalogTool = (spatialModelCatalogTool as any).function;
    const reviewTool = (spatialModelReviewTool as any).function;
    expect(contextTool.name).toBe('read_spatial_model_context');
    expect(reviewTool.name).toBe('review_spatial_with_local_model'); expect(typeof reviewTool.execute).toBe('function');
    expect(await contextTool.execute({ sourcePath: canonicalManifest, kind: 'volume' })).toEqual(context);
    const catalog = await catalogTool.execute({});
    expect(catalog.models[0].name).toBe(modelName);
    expect(readChain('runs', directory)).toHaveLength(0);
    expect(defaultTools).toEqual(expect.arrayContaining([spatialModelCatalogTool, spatialModelContextTool, spatialModelReviewTool]));
  });
});


describe('observed spatial citation admission', () => {
  it('refuses an unsupported model before inference and does not invent tool support', async () => {
    const fetcher = mockOllama({ noTools: true });
    await expect(reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory })).rejects.toThrow(/tool support/);
    expect(chatCalls(fetcher)).toHaveLength(0);
  });
  it('requires trusted source readback before model requests', async () => {
    const fetcher = mockOllama();
    await expect(executeReview(context, { model: modelName, question: 'Review.', dir: directory })).rejects.toThrow(/currentContext/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains actual tool outputs and original handle labels in the final raw envelope', async () => {
    mockOllama(); const r = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
    expect(r.ok).toBe(true); expect(r.evidenceAdmission).toMatchObject({ ok: true, evidence: 'admitted_references' });
    const record = JSON.parse(readFileSync(join(dirname(r.reportPath), 'admission.json'), 'utf8'));
    expect(record.controller.citations).toHaveLength(1);
    expect(record.controller.observations[0]).toMatchObject({ kind: 'source_declaration' });
    const raw = JSON.parse(record.decision.raw_output);
    expect(r.review?.evidence).toEqual(raw.evidence);
    expect(r.review?.annotations[0]).not.toHaveProperty('factIds');
  });
  it('refuses uncited, property-name, unknown-tool and excessive-call answers', async () => {
    for (const config of [{ skipCite: true }, { wrongHandle: true }, { wrongTool: true }, { excessCalls: true }]) {
      const fetcher = mockOllama(config);
      const r = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
      expect(r.ok).toBe(false); expect(r.review).toBeNull(); expect(r.evidenceAdmission.ok).toBe(false);
      expect(chatCalls(fetcher)).toHaveLength(1);
      const record = JSON.parse(readFileSync(join(dirname(r.reportPath), 'response.json'), 'utf8'));
      expect(record.transcript).toHaveLength(1);
    }
  });
  it('refuses changed source facts even if the declared source hash is unchanged', async () => {
    const changed = structuredClone(context);
    mockOllama({ onChat: () => { changed.facts[0].value = 123456; } });
    const r = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory, currentContext: () => changed });
    expect(r.ok).toBe(false); expect(r.evidenceAdmission.ok).toBe(false);
  });
  it('respects caller cancellation without a second inference', async () => {
    const abort = new AbortController();
    const fetcher = mockOllama({ onChat: () => abort.abort() });
    const r = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory, signal: abort.signal });
    expect(r.ok).toBe(false); expect(chatCalls(fetcher)).toHaveLength(1);
  });
  it('refuses model alias weight drift before dispatch', async () => {
    const fetcher = mockOllama({ changedWeights: true });
    const r = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/weights identity/); expect(chatCalls(fetcher)).toHaveLength(0);
  });
  it('refuses physical material promotion and retains the exact invalid field', async () => {
    mockOllama({ physicalClaim: true });
    const r = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
    expect(r.ok).toBe(false); expect(r.evidenceAdmission).toMatchObject({ ok: false, reason: 'invalid_output' });
    expect(JSON.parse(r.evidenceAdmission.raw_output).payload.materialKnown).toBe(true);
  });
  it('retains exact HTTP refusal and malformed JSON bodies before parsing', async () => {
    for (const fixture of [{ body: '  {"refusal":"fixture policy denial"}\n', status: 403 },
      { body: '\n{malformed-json with original spaces  ', status: 200 }]) {
      mockOllama({ transportBody: fixture.body, transportStatus: fixture.status });
      const r = await reviewSpatialContext(context, { model: modelName, question: 'Review.', dir: directory });
      expect(r.ok).toBe(false); expect(r.review).toBeNull(); expect(r.evidenceAdmission.ok).toBe(false);
      const retained = JSON.parse(readFileSync(join(dirname(r.reportPath), 'transport-0.json'), 'utf8'));
      expect(retained).toMatchObject({ status: fixture.status, truncated: false, bytes: Buffer.byteLength(fixture.body), sha256: sha(fixture.body) });
      expect(readFileSync(retained.bodyPath)).toEqual(Buffer.from(fixture.body));
      expect(readChain('runs', directory).at(-1)?.status).toBe('failed');
    }
  });
});
