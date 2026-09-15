import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Receipt } from '../src/utils/receipts.js';

const { readChain } = vi.hoisted(() => ({ readChain: vi.fn() }));
vi.mock('../src/utils/receipts.js', () => ({ readChain }));
import { receiptsToOtlp } from '../src/utils/otlp.js';

const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  v: 1, id: 'rc_fixture', stream: 'runs', ts: '2026-09-15T12:00:00.000Z',
  kind: 'run', subject: 'PRIVATE TASK', policy: 'PRIVATE POLICY',
  hash: `sha256_${'a'.repeat(64)}`, prev_hash: `sha256_${'b'.repeat(64)}`, ...overrides
});
type Span = { traceId: string; spanId: string; name: string; startTimeUnixNano: string; endTimeUnixNano: string; status?: { code: number }; attributes: { key: string; value: { stringValue?: string; doubleValue?: number } }[] };
type Export = { resourceSpans: { scopeSpans: { scope: { version: string }; spans: Span[] }[] }[] };
const project = () => receiptsToOtlp() as Export;
const first = () => project().resourceSpans[0].scopeSpans[0].spans[0];
const attrs = (s: Span) => Object.fromEntries(s.attributes.map(a => [a.key, a.value.stringValue ?? a.value.doubleValue]));
beforeEach(() => { readChain.mockReset(); readChain.mockImplementation((stream: string) => stream === 'runs' ? [receipt()] : []); });

describe('metadata-only OTLP receipt projection', () => {
  it('includes the runs receipt stream and versions the changed projection', () => {
    const result = project();
    expect(readChain.mock.calls.map(c => c[0])).toEqual(['gens', 'harness', 'context', 'doctor', 'runs']);
    expect(result.resourceSpans).toHaveLength(1);
    expect(result.resourceSpans[0].scopeSpans[0].scope.version).toBe('2');
  });
  it('preserves explicit stream and directory selection without another store', () => {
    receiptsToOtlp(['runs'], '/synthetic/receipts');
    expect(readChain).toHaveBeenCalledExactlyOnceWith('runs', '/synthetic/receipts');
  });
  it.each([['failed', 2], ['denied', 2], ['ok', 1]] as const)('projects explicit %s status only', (status, code) => {
    readChain.mockImplementation((s: string) => s === 'runs' ? [receipt({ status, error_class: 'schema' })] : []);
    const span = first();
    expect(span.status).toEqual({ code });
    expect(attrs(span)).toMatchObject({ 'timmy.receipt.status': status, 'timmy.error_class': 'schema' });
  });
  it('leaves missing status unset even with a declared error class', () => {
    readChain.mockImplementation((s: string) => s === 'runs' ? [receipt({ error_class: 'schema' })] : []);
    const span = first();
    expect(span).not.toHaveProperty('status');
    expect(attrs(span)).not.toHaveProperty('timmy.receipt.status');
  });
  it('preserves the integration runner adapter failure classification', () => {
    readChain.mockImplementation((s: string) => s === 'runs' ? [receipt({
      kind: 'vision.integration.result', status: 'failed', error_class: 'adapter'
    })] : []);
    expect(attrs(first())).toMatchObject({ 'timmy.receipt.status': 'failed', 'timmy.error_class': 'adapter' });
  });
  it('exposes reported duration without fabricating a measured time interval or parent', () => {
    readChain.mockImplementation((s: string) => s === 'runs' ? [receipt({ ms: 250.5 })] : []);
    const span = first();
    expect(span.startTimeUnixNano).toBe('1789473600000000000');
    expect(span.endTimeUnixNano).toBe(span.startTimeUnixNano);
    expect(attrs(span)).toMatchObject({ 'timmy.reported_duration_ms': 250.5, 'timmy.representation': 'receipt_event' });
    expect(span).not.toHaveProperty('parentSpanId');
  });
  it.each([undefined, -1, Infinity, -Infinity, NaN, '25'])('omits invalid duration %s', ms => {
    readChain.mockImplementation((s: string) => s === 'runs' ? [receipt({ ms: ms as number })] : []);
    expect(attrs(first())).not.toHaveProperty('timmy.reported_duration_ms');
  });
  it('keeps a reported zero duration', () => {
    readChain.mockImplementation((s: string) => s === 'runs' ? [receipt({ ms: 0 })] : []);
    expect(attrs(first())['timmy.reported_duration_ms']).toBe(0);
  });
  it('omits sensitive prose and arbitrary field names, retaining only supported metadata', () => {
    readChain.mockImplementation((s: string) => s === 'runs' ? [receipt({
      kind: 'PRIVATE KIND', spans: [{ kind: 'execute_tool', name: 'PRIVATE SPAN' }],
      error_class: 'PRIVATE ERROR', artifacts: ['/PRIVATE/PATH'], cost_usd: Infinity
    })] : []);
    const result = project(), text = JSON.stringify(result);
    expect(text).not.toContain('PRIVATE');
    expect(attrs(result.resourceSpans[0].scopeSpans[0].spans[0])['timmy.projection']).toBe('metadata_only');
    expect(text).not.toContain('Infinity');
  });
  it('keeps deterministic historical IDs and does not change receipt input', () => {
    const r = receipt(), before = structuredClone(r);
    readChain.mockImplementation((s: string) => s === 'runs' ? [r] : []);
    const a = first(), b = first();
    expect(a).toEqual(b);
    expect(a.traceId).toBe('a'.repeat(32));
    expect(a.spanId).toBe(createHash('sha256').update(r.id).digest('hex').slice(0, 16));
    expect(r).toEqual(before);
  });
  it('does not leak malformed hash prose through attributes or the trace ID', () => {
    readChain.mockImplementation((s: string) => s === 'runs' ? [receipt({ hash: 'PRIVATE HASH', prev_hash: 'PRIVATE PREVIOUS' })] : []);
    const span = first();
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(span)).not.toContain('PRIVATE');
    expect(attrs(span)).not.toHaveProperty('timmy.receipt.hash');
  });
});
