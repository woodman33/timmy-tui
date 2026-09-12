import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildVolumeModelContext, type SpatialModelContext } from '../src/vision/spatial/model-context.js';
import { buildNativeModelContext } from '../src/vision/spatial/native-model-context.js';
import { localSpatialModels, reviewSpatialContext, validateSpatialReview } from '../src/vision/spatial/local-model-review.js';
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
const metadata = (vision = false) => ({ details: { format: 'gguf', family: 'test' }, capabilities: ['completion', ...(vision ? ['vision'] : [])], model_info: { 'test.context_length': 8192 } });
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
}
function mockOllama(options: ServerOptions = {}) {
  let showCount = 0;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/tags') return jsonResponse({ models: (options.names ?? [modelName]).map(name => ({ name, digest, size: 1_000_000 })) });
    if (path === '/api/show') {
      showCount++;
      return jsonResponse({ ...metadata(options.vision), model_info: { 'test.context_length': options.contextLength ?? 8192 },
        ...(options.aliasTurnsRemote && showCount > 1 ? { remote_model: 'some-remote-model' } : {}) });
    }
    if (path === '/api/chat') {
      if (options.timeout) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('fixture request timed out')), { once: true });
      });
      if (options.failure) return jsonResponse({ error: 'fixture server failure' }, options.failure);
      if (options.excessBody) return new Response('x'.repeat(2 * 1024 * 1024 + 1));
      const request = JSON.parse(String(init?.body));
      const packet = JSON.parse(request.messages[1].content).context as SpatialModelContext;
      return jsonResponse({ model: options.responseModel ?? modelName, remote_host: options.responseRemoteHost,
        remote_model: options.responseRemoteModel, done: true, done_reason: options.doneReason ?? 'stop',
        message: { role: 'assistant', content: JSON.stringify(options.review ?? goodReview(packet)), thinking: 'PRIVATE_DELIBERATION_NOT_RETAINED' },
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
    expect(chatCalls(fetcher)).toHaveLength(1);
    const request = JSON.parse(String(chatCalls(fetcher)[0][1]?.body));
    expect(request.options).toMatchObject({ num_ctx: 8192, temperature: 0 });
    expect(request).toMatchObject({ truncate: false, shift: false });
    expect(request.tools).toBeUndefined();
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
    expect(result.ok).toBe(false); expect(result.review).toBeNull(); expect(result.error).toMatch(/different source/);
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
