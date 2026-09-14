import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVisionApp } from '../src/vision/server.js';
import { listVisionEvents, readVisionEvent, saveVisionEvent, storeVisionImage, visionHash, type VisionEvent } from '../src/vision/store.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=', 'base64');
let dir: string;
let server: Server;
let port: number;
let event: VisionEvent;

function call(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
      ...options.headers,
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-vision-server-'));
  const image = storeVisionImage(PNG, 'image/png', 'card.png', { dir });
  const result = {
    predictions: [{ class: 'card', confidence: 0.4, x: 20, y: 30, width: 10, height: 15 }],
    output_image: { type: 'base64', value: PNG.toString('base64') },
  };
  event = saveVisionEvent({
    state: 'observed', image, result, resultHash: visionHash(result), metadata: {},
    provenance: { runtime: 'http', modelId: 'test-model/1', parametersHash: visionHash({}), workflowDefinitionCaptured: false },
    confidence: { count: 1, min: 0.4, max: 0.4 }, needsReview: true,
  }, { dir });
  server = createServer(createVisionApp(dir));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('local vision HTTP boundaries', () => {
  it('serves actual local evidence to a localhost Host', async () => {
    const response = await call('/api/vision/events', { headers: { Host: `localhost:${port}` } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString()).events[0].id).toBe(event.id);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects a rebinding Host before a mutation can append feedback', async () => {
    const response = await call('/api/vision/feedback', { method: 'POST', headers: { Host: 'attacker.example' },
      body: { eventId: event.id, verdict: 'correct' } });
    expect(response.status).toBe(403);
    expect(listVisionEvents({}, { dir }).events[0].feedback).toBeUndefined();
  });

  it('rejects a cross-origin mutation even with a valid localhost Host', async () => {
    const response = await call('/api/vision/feedback', { method: 'POST', headers: { Origin: 'https://attacker.example' },
      body: { eventId: event.id, verdict: 'correct' } });
    expect(response.status).toBe(403);
    expect(listVisionEvents({}, { dir }).events[0].feedback).toBeUndefined();
  });

  it('accepts operator feedback from its own origin', async () => {
    const response = await call('/api/vision/feedback', { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}` },
      body: { eventId: event.id, verdict: 'incorrect', note: 'The frame contains two cards.' } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString()).state).toBe('recorded');
    expect(listVisionEvents({}, { dir }).events[0].feedback?.verdict).toBe('incorrect');
  });

  it('never accepts a browser request to read an arbitrary local imagePath', async () => {
    const response = await call('/api/vision/run', { method: 'POST', body: { imagePath: event.image.path, modelId: 'test-model/1' } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toMatchObject({ ok: false, state: 'invalid_request' });
    expect(listVisionEvents({}, { dir }).events).toHaveLength(1);
  });

  it('serves verified images and refuses altered bytes with an integrity error', async () => {
    const path = `/api/vision/events/${event.id}/image`;
    const original = await call(path);
    expect(original.status).toBe(200);
    expect(original.body.equals(PNG)).toBe(true);
    expect(original.headers['cache-control']).toBe('no-store');
    writeFileSync(event.image.path, 'changed image');
    const changed = await call(path);
    expect(changed.status).toBe(409);
    expect(JSON.parse(changed.body.toString()).state).toBe('integrity_error');
  });

  it('returns compact output links and serves the exact stored image bytes without rewriting evidence', async () => {
    const journalPath = join(dir, '.timmy/vision/events.jsonl');
    const journalBefore = readFileSync(journalPath);
    const response = await call('/api/vision/events');
    expect(response.status).toBe(200);
    const shown = JSON.parse(response.body.toString()).events[0];
    const digest = createHash('sha256').update(PNG).digest('hex');
    const url = `/api/vision/events/${event.id}/outputs/${digest}`;
    expect(shown.result.output_image).toEqual({ type: 'url', value: url });
    expect(shown.outputs).toEqual([{ sha256: digest, url, mimeType: 'image/png', byteLength: PNG.length }]);
    expect(shown.summary).toMatchObject({ detectionCount: 1, classes: [{ name: 'card', count: 1 }], reviewNeeded: true });
    expect(shown.presentation).toMatchObject({ compacted: true, originalResultHash: event.resultHash });
    expect(response.body.toString()).not.toContain(PNG.toString('base64'));

    const output = await call(url);
    expect(output.status).toBe(200);
    expect(output.body.equals(PNG)).toBe(true);
    expect(output.headers['content-type']).toBe('image/png');
    expect(output.headers['cache-control']).toBe('no-store');
    expect(output.headers['x-content-type-options']).toBe('nosniff');

    const persisted = readVisionEvent(event.id, { dir });
    expect(persisted?.result).toEqual(event.result);
    expect(persisted?.resultHash).toBe(event.resultHash);
    expect(visionHash(persisted?.result)).toBe(event.resultHash);
    expect(journalBefore.equals(readFileSync(journalPath))).toBe(true);
  });

  it('never resolves an output from a different event or an unknown digest', async () => {
    const digest = createHash('sha256').update(PNG).digest('hex');
    const emptyResult = { predictions: [] };
    const other = saveVisionEvent({
      state: 'observed', image: event.image, result: emptyResult, resultHash: visionHash(emptyResult), metadata: {},
      provenance: event.provenance, confidence: { count: 0, min: null, max: null }, needsReview: true,
    }, { dir });
    for (const path of [
      `/api/vision/events/${event.id}/outputs/${'0'.repeat(64)}`,
      `/api/vision/events/${event.id}/outputs/not-a-digest`,
      `/api/vision/events/nonexistent-event/outputs/${digest}`,
      `/api/vision/events/${other.id}/outputs/${digest}`,
    ]) {
      const response = await call(path);
      expect(response.status).toBe(404);
      expect(response.body.equals(PNG)).toBe(false);
    }
  });

  it('compacts learning candidates while preserving their stored result and review state', async () => {
    const response = await call('/api/vision/learning');
    expect(response.status).toBe(200);
    const shown = JSON.parse(response.body.toString()).events[0];
    expect(shown.id).toBe(event.id);
    expect(shown.needsReview).toBe(true);
    expect(shown.summary.reviewNeeded).toBe(true);
    expect(shown.outputs).toHaveLength(1);
    expect(shown.result.output_image).toEqual({ type: 'url', value: shown.outputs[0].url });
    expect(response.body.toString()).not.toContain(PNG.toString('base64'));
    expect((await call(shown.outputs[0].url)).body.equals(PNG)).toBe(true);
    expect(readVisionEvent(event.id, { dir })?.result).toEqual(event.result);
    expect(readVisionEvent(event.id, { dir })?.resultHash).toBe(event.resultHash);
  });
});
