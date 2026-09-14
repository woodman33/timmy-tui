import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getVisionStatus, listLearningCandidates, listVisionEvents, queryCloudVisionEvents,
  recordVisionFeedback, runVisionInspection, syncVisionEvent, type VisionRunner,
} from '../src/vision/runtime.js';
import { imageHash, visionHash } from '../src/vision/store.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=';
let dir: string;
const env = { ROBOFLOW_API_KEY: 'rf_test_key_do_not_persist', TIMMY_VISION_MODEL_ID: 'cards/2', ROBOFLOW_WORKSPACE: 'timmy', TIMMY_VISION_USE_CASE_ID: 'inspections' };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'timmy-vision-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function mockRunner(result: unknown = { predictions: [{ class: 'card', confidence: 0.45, x: 2, y: 2, width: 4, height: 4 }] }) {
  return vi.fn<VisionRunner>(async req => req.action === 'probe' ? {
    ok: true, state: 'checked', dependencies: { inference_sdk: { installed: true, version: '1.5.0' }, roboflow: { installed: true } },
  } : { ok: true, state: 'observed', result, sdkVersion: '1.5.0' });
}

describe('vision execution and evidence', () => {
  it('checks package presence without running inference or probing a remote service', async () => {
    const runner = mockRunner();
    const status = await getVisionStatus({ dir, env, runner });
    expect(status.state).toBe('configured_unchecked');
    expect(status.serverChecked).toBe(false);
    expect(runner.mock.calls[0][0]).toEqual({ action: 'probe' });
    expect(JSON.stringify(status)).not.toContain(env.ROBOFLOW_API_KEY);
    expect(readChain('runs', dir)).toEqual([]);
  });

  it('refuses an unconfigured request before starting a model', async () => {
    const runner = mockRunner();
    const result = await runVisionInspection({ imageBase64: PNG, modelId: 'cards/2' }, { dir, env: {}, runner });
    expect(result).toMatchObject({ ok: false, state: 'not_configured' });
    expect(runner).not.toHaveBeenCalled();
    expect(listVisionEvents({}, { dir }).events).toEqual([]);
  });

  it('stores an actual result with image and output hashes plus an intact receipt', async () => {
    const runner = mockRunner();
    const result = await runVisionInspection({ imageBase64: PNG, templateId: 'card-inspection', filename: '../../card.png' }, { dir, env, runner });
    expect(result.ok).toBe(true);
    const event = listVisionEvents({}, { dir, env }).events[0];
    expect(event.image.filename).toBe('card.png');
    expect(imageHash(readFileSync(event.image.path))).toBe(event.image.sha256);
    expect(visionHash(event.result)).toBe(event.resultHash);
    expect(event.provenance).toMatchObject({ runtime: 'http', modelId: 'cards/2', sdkVersion: '1.5.0' });
    expect(event.confidence.min).toBe(0.45);
    expect(event.needsReview).toBe(true);
    expect(event.receiptHash).toBe(result.receipt);
    expect(verifyChain('runs', dir).ok).toBe(true);
    expect(runner.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });

  it('records workflow provenance and forwards typed parameters', async () => {
    const runner = mockRunner({ output: { predictions: [] } });
    const specification = { version: '1.0', inputs: [{ type: 'InferenceImage', name: 'photo' }], steps: [], outputs: [] };
    const result = await runVisionInspection({ imageBase64: PNG, specification, imageInput: 'photo', parameters: { count: 37 } }, { dir, env, runner });
    expect(result.ok).toBe(true);
    expect(runner.mock.calls[0][0]).toMatchObject({ specification, imageInput: 'photo', parameters: { count: 37 } });
    const event = listVisionEvents({}, { dir }).events[0];
    expect(event.provenance.specificationHash).toBe(visionHash(specification));
    expect(event.provenance.workflowDefinitionCaptured).toBe(true);
    const manifest = event.provenance.executionManifest!;
    expect(JSON.parse(readFileSync(manifest.path, 'utf8'))).toMatchObject({ specification, parameters: { count: 37 }, disableSinks: true });
    expect(manifest.redacted).toBe(false);
    expect(event.confidence.min).toBe(null);
    expect(event.reviewReason).toContain('No confidence values');
  });

  it('runs an explicitly selected model instead of the environment-default Workflow', async () => {
    const runner = mockRunner();
    const result = await runVisionInspection({ imageBase64: PNG, modelId: 'selected/3' }, {
      dir, env: { ...env, TIMMY_VISION_WORKFLOW_ID: 'default-workflow' }, runner,
    });
    expect(result.ok).toBe(true);
    expect(runner.mock.calls[0][0]).toMatchObject({ modelId: 'selected/3' });
    expect(runner.mock.calls[0][0]).not.toHaveProperty('workflowId');
    expect(listVisionEvents({}, { dir }).events[0].provenance).toMatchObject({ modelId: 'selected/3' });
  });

  it('keeps an explicit Workflow selection ahead of the default model', async () => {
    const runner = mockRunner();
    const result = await runVisionInspection({ imageBase64: PNG, workflowId: 'selected-workflow' }, { dir, env, runner });
    expect(result.ok).toBe(true);
    expect(runner.mock.calls[0][0]).toMatchObject({ workflowId: 'selected-workflow', workspace: 'timmy' });
    expect(runner.mock.calls[0][0]).not.toHaveProperty('modelId');
  });

  it('does not attach a default named Workflow identity to an inline definition', async () => {
    const runner = mockRunner();
    const specification = { version: '1.0', inputs: [], steps: [], outputs: [] };
    const result = await runVisionInspection({ imageBase64: PNG, specification }, {
      dir, env: { ...env, TIMMY_VISION_WORKFLOW_ID: 'unrelated-workflow' }, runner,
    });
    expect(result.ok).toBe(true);
    expect(runner.mock.calls[0][0]).toMatchObject({ specification, workflowId: '' });
    expect(listVisionEvents({}, { dir }).events[0].provenance.workflowId).toBeUndefined();
  });

  it('keeps operator feedback append-only and removes corrected cases from the local review queue', async () => {
    await runVisionInspection({ imageBase64: PNG }, { dir, env, runner: mockRunner() });
    const event = listVisionEvents({}, { dir }).events[0];
    expect(listLearningCandidates({}, { dir }).events).toHaveLength(1);
    recordVisionFeedback({ eventId: event.id, verdict: 'incorrect', note: 'Missed the second card' }, { dir });
    recordVisionFeedback({ eventId: event.id, verdict: 'correct', note: 'Rechecked original frame' }, { dir });
    expect(readFileSync(join(dir, '.timmy/vision/feedback.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(listLearningCandidates({}, { dir }).events).toHaveLength(0);
    expect(listVisionEvents({}, { dir }).events[0].feedback?.verdict).toBe('correct');
    expect(verifyChain('runs', dir).ok).toBe(true);
  });

  it('records failures honestly and keeps them out of training candidates', async () => {
    const runner: VisionRunner = async () => ({ ok: false, state: 'not_configured', note: 'SDK missing' });
    const result = await runVisionInspection({ imageBase64: PNG }, { dir, env, runner });
    expect(result).toMatchObject({ ok: false, state: 'not_configured' });
    expect(listVisionEvents({}, { dir }).events[0].state).toBe('failed');
    expect(readChain('runs', dir).at(-1)?.status).toBe('failed');
    expect(listLearningCandidates({}, { dir }).events).toEqual([]);
  });

  it('redacts credentials in upstream data and metadata before persistence', async () => {
    const result = await runVisionInspection({ imageBase64: PNG, metadata: { secret: env.ROBOFLOW_API_KEY } }, {
      dir, env, runner: mockRunner({ note: `Bearer ${env.ROBOFLOW_API_KEY}`, api_key: 'unfamiliar-secret' }),
    });
    expect(JSON.stringify(result)).not.toContain(env.ROBOFLOW_API_KEY);
    expect(JSON.stringify(result)).not.toContain('unfamiliar-secret');
    expect(readFileSync(join(dir, '.timmy/vision/events.jsonl'), 'utf8')).not.toContain(env.ROBOFLOW_API_KEY);
  });

  it('redacts unfamiliar OAuth credentials in upstream fields, metadata, and text', async () => {
    const fields = ['client_secret', 'clientSecret', 'refresh_token', 'refreshToken', 'id_token', 'idToken',
      'access_token', 'accessToken', 'ROBOFLOW_CLIENT_SECRET', 'oauth.clientSecret', 'oauth:refresh_token'];
    const credentials = Object.fromEntries(fields.map((field, index) => [field, `synthetic-credential-${index}`]));
    const result = await runVisionInspection({ imageBase64: PNG, metadata: { oauth: credentials } }, {
      dir, env, runner: mockRunner({ oauth: credentials,
        note: 'clientSecret=synthetic-client-secret refresh_token=synthetic-refresh-token "id_token": "synthetic-id-token"',
        client_id: 'public-client', tokenCount: 23 }),
    });
    expect(result.ok).toBe(true);
    const event = listVisionEvents({}, { dir }).events[0];
    expect(event.result).toMatchObject({ oauth: Object.fromEntries(fields.map(field => [field, '[redacted]'])),
      client_id: 'public-client', tokenCount: 23 });
    expect(event.metadata).toMatchObject({ oauth: Object.fromEntries(fields.map(field => [field, '[redacted]'])) });
    expect(JSON.stringify(result)).not.toContain('synthetic-');
    expect(readFileSync(join(dir, '.timmy/vision/events.jsonl'), 'utf8')).not.toContain('synthetic-');
  });

  it('syncs only on an explicit action and never uploads the image by default', async () => {
    const runner = mockRunner();
    await runVisionInspection({ imageBase64: PNG }, { dir, env, runner });
    expect(runner.mock.calls.map(call => call[0].action)).toEqual(['inspect']);
    const eventId = listVisionEvents({}, { dir }).events[0].id;
    const result = await syncVisionEvent({ eventId }, { dir, env, runner });
    expect(result.state).toBe('synced');
    expect(runner.mock.calls[1][0]).toMatchObject({ action: 'sync_event', includeImage: false });
    const again = await syncVisionEvent({ eventId }, { dir, env, runner });
    expect(again.state).toBe('already_synced');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('refuses cloud image sync when the stored image was modified', async () => {
    const runner = mockRunner();
    await runVisionInspection({ imageBase64: PNG }, { dir, env, runner });
    const event = listVisionEvents({}, { dir }).events[0];
    writeFileSync(event.image.path, 'changed');
    const result = await syncVisionEvent({ eventId: event.id, includeImage: true }, { dir, env, runner });
    expect(result.state).toBe('integrity_error');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('rejects a rewritten observation even if its output hash is recomputed', async () => {
    const runner = mockRunner();
    await runVisionInspection({ imageBase64: PNG }, { dir, env, runner });
    const path = join(dir, '.timmy/vision/events.jsonl');
    const event = JSON.parse(readFileSync(path, 'utf8').trim());
    event.result = { result: 'invented pass' };
    event.resultHash = visionHash(event.result);
    writeFileSync(path, JSON.stringify(event) + '\n');
    const result = await syncVisionEvent({ eventId: event.id }, { dir, env, runner });
    expect(result.state).toBe('integrity_error');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('bounds cloud queries to one page and keeps credentials outside the request', async () => {
    const runner = mockRunner();
    await queryCloudVisionEvents({ limit: 99999, cursor: 'next' }, { dir, env, runner });
    expect(runner.mock.calls[0][0]).toEqual({ action: 'query_events', workspace: 'timmy', useCaseId: 'inspections', limit: 100, cursor: 'next' });
  });

  it('rejects malformed uploads and server addresses with embedded credentials', async () => {
    const runner = mockRunner();
    expect((await runVisionInspection({ imageBase64: 'not an image' }, { dir, env, runner })).state).toBe('invalid_request');
    expect((await runVisionInspection({ imageBase64: PNG }, { dir, env: { ...env, TIMMY_VISION_SERVER_URL: 'https://name:secret@example.com' }, runner })).state).toBe('not_configured');
    expect(runner).not.toHaveBeenCalled();
  });
});
