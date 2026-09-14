import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findVisionOutput, publicVisionEvent } from '../src/vision/presentation.js';
import { visionHash, type VisionEvent } from '../src/vision/store.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=';
const bytes = Buffer.from(PNG, 'base64');
const digest = createHash('sha256').update(bytes).digest('hex');
const prediction = (name: string, confidence = 0.8) => ({ class: name, confidence, x: 10, y: 12, width: 5, height: 7 });
function event(result: unknown): VisionEvent {
  return {
    id: 'inspection-1', timestamp: '2026-09-07T12:00:00.000Z', state: 'observed',
    image: { path: '/private/input.png', sha256: 'input-digest', mimeType: 'image/png', filename: 'input.png' },
    provenance: { runtime: 'http', workflowId: 'example', workspace: 'test', workflowDefinitionCaptured: true, parametersHash: 'parameters-digest' },
    metadata: { source: 'test', enabled: true, count: 37 },
    result, resultHash: visionHash(result), confidence: { count: 2, min: 0.4, max: 0.8 },
    needsReview: true, reviewReason: 'Low confidence', receiptHash: 'signed-original-receipt',
  };
}

describe('vision browser presentation', () => {
  it('compacts the SDK Workflow result and summarizes actual boxed detections without changing evidence', () => {
    const original = event([{ count_objects: 3, output_image: PNG, predictions: {
      image: { width: 1280, height: 720 },
      predictions: [prediction('person'), prediction('person', 0.9), prediction('card', 0.4)],
    } }]);
    const before = JSON.stringify(original);
    const result = publicVisionEvent(original);
    expect(result.outputs).toEqual([{ sha256: digest, mimeType: 'image/png', byteLength: bytes.length, url: `/api/vision/events/inspection-1/outputs/${digest}` }]);
    expect(result.result).toEqual([{ count_objects: 3, output_image: result.outputs[0].url, predictions: original.result && (original.result as any[])[0].predictions }]);
    expect(result.summary).toEqual({ detectionCount: 3, classes: [{ name: 'person', count: 2 }, { name: 'card', count: 1 }], predictionSets: 1, reviewNeeded: true, minConfidence: 0.4, maxConfidence: 0.9 });
    expect(result.presentation).toEqual({ compacted: true, inlineImagesReplaced: 1, truncated: false, originalResultHash: original.resultHash });
    expect(result.resultHash).toBe(original.resultHash);
    expect(result.receiptHash).toBe(original.receiptHash);
    expect(JSON.stringify(original)).toBe(before);
    result.metadata.count = 99;
    expect(original.metadata.count).toBe(37);
  });

  it('converts known image wrappers, preserves their metadata, and deduplicates output links', () => {
    const result = publicVisionEvent(event({ a: { type: 'base64', value: PNG, name: 'annotated' }, nested: [PNG], text: 'normal scalar' }));
    expect(result.outputs).toHaveLength(1);
    expect(result.result).toEqual({ a: { type: 'url', value: result.outputs[0].url, name: 'annotated' }, nested: [result.outputs[0].url], text: 'normal scalar' });
    expect(result.presentation.inlineImagesReplaced).toBe(2);
  });

  it('resolves matching bytes by digest only and rejects paths, uppercase, and another digest', () => {
    const original = event([{ output_image: { type: 'base64', value: PNG } }]);
    expect(findVisionOutput(original, digest)).toEqual({ bytes, mimeType: 'image/png' });
    for (const invalid of ['../input.png', '/private/input.png', digest.toUpperCase(), 'a'.repeat(64), 'data:image/png;base64,' + PNG]) {
      expect(findVisionOutput(original, invalid)).toBeUndefined();
    }
  });

  it('retains non-image base64 and rejects malformed or oversized encoded image candidates', () => {
    const malformed = PNG.slice(0, -1) + '!';
    const nonImage = Buffer.from('this is plain text').toString('base64');
    const oversized = 'iVBORw0KGgo' + 'A'.repeat(17 * 1024 * 1024);
    const result = publicVisionEvent(event({ malformed, nonImage, oversized }));
    expect(result.outputs).toEqual([]);
    expect(result.result).toEqual({ malformed, nonImage, oversized });
    expect(findVisionOutput(event({ malformed, nonImage, oversized }), digest)).toBeUndefined();
  });

  it('checks image bytes instead of trusting a wrapper MIME type', () => {
    const result = publicVisionEvent(event({ type: 'base64', value: PNG, mimeType: 'text/html' }));
    expect(result.outputs[0].mimeType).toBe('image/png');
    expect(findVisionOutput(event({ type: 'base64', value: PNG, mimeType: 'text/html' }), digest)?.mimeType).toBe('image/png');
  });

  it('does not count classification scores or an unrelated count as detections', () => {
    const result = publicVisionEvent(event({ count_objects: 22, predictions: [{ class: 'damaged', confidence: 0.9 }] }));
    expect(result.summary.detectionCount).toBeNull();
    expect(result.summary.classes).toEqual([]);
    expect(publicVisionEvent(event({ predictions: [] })).summary.detectionCount).toBe(0);
  });

  it('never follows prototypes, invokes getters, or pollutes Object.prototype', () => {
    let reads = 0;
    const content = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    Object.defineProperty(content, 'getter', { enumerable: true, get() { reads += 1; return PNG; } });
    const inherited = Object.create({ output_image: PNG });
    content.inherited = inherited;
    const original = event(null);
    original.result = content;
    const result = publicVisionEvent(original);
    expect(reads).toBe(0);
    expect(result.outputs).toEqual([]);
    expect(result.presentation.truncated).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(result.result as object, '__proto__')).toBe(true);
  });

  it('bounds depth and cyclic structures without rewriting the original', () => {
    const original = event(null);
    const root: Record<string, unknown> = { output_image: PNG };
    root.cycle = root;
    let deep: unknown = PNG;
    for (let index = 0; index < 40; index += 1) deep = { nested: deep };
    root.deep = deep;
    original.result = root;
    const result = publicVisionEvent(original);
    expect(result.outputs).toHaveLength(1);
    expect(result.presentation.truncated).toBe(true);
    expect((result.result as Record<string, unknown>).cycle).toBeNull();
    expect(root.cycle).toBe(root);
  });

  it('keeps metadata intact and extracts images only from model results', () => {
    const original = event({ note: 'no image' });
    original.metadata.imageExample = PNG;
    const result = publicVisionEvent(original);
    expect(result.metadata.imageExample).toBe(PNG);
    expect(result.presentation.compacted).toBe(false);
    expect(findVisionOutput(original, digest)).toBeUndefined();
  });

  it('keeps links on the same origin and recognizes the operator review state', () => {
    const original = event({ output_image: PNG });
    original.id = '../untrusted?next=https://example.com';
    original.feedback = { id: 'feedback', eventId: original.id, timestamp: original.timestamp, verdict: 'correct', receiptHash: 'feedback-receipt' };
    const result = publicVisionEvent(original);
    expect(result.outputs[0].url).toBe(`/api/vision/events/..%2Funtrusted%3Fnext%3Dhttps%3A%2F%2Fexample.com/outputs/${digest}`);
    expect(result.summary.reviewNeeded).toBe(false);
    original.feedback.verdict = 'incorrect';
    expect(publicVisionEvent(original).summary.reviewNeeded).toBe(true);
  });
});
