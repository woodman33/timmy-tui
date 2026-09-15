import crypto from 'crypto';
import { readChain } from './receipts.js';

// Derived, metadata-only OpenTelemetry export. Receipts remain the authority;
// this function neither sends telemetry nor opens a listener. Projection v2
// omits free-text receipt fields: subject, policy, kind, span names and payloads.
// traceId = first 32 hex of the receipt hash (stable, content-addressed);
// spanId = 16 hex derived from the receipt id.
// OTLP JSON uses hex IDs, integer enums and decimal strings for uint64 times:
// https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding

const hex16 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const errorClasses = new Set(['exec', 'adapter', 'missing_source', 'schema', 'env', 'replay_drift', 'http_4xx', 'http_5xx', 'network', 'approval', 'unresolved_model', 'no_key']);
const isHash = (s: string): boolean => /^sha256_[a-f0-9]{64}$/.test(s);

export function receiptsToOtlp(streams: string[] = ['gens', 'harness', 'context', 'doctor', 'runs'], dir?: string): unknown {
  const resourceSpans = streams
    .map(stream => {
      const chain = readChain(stream, dir);
      if (chain.length === 0) return null;
      return {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: `timmy-${stream}` } }] },
        scopeSpans: [{
          scope: { name: 'timmy.receipts', version: '2' },
          spans: chain.map(r => {
            const start = BigInt(Date.parse(r.ts)) * 1000000n;
            return {
              traceId: isHash(r.hash) ? r.hash.slice(7, 39) : crypto.createHash('sha256').update(r.hash).digest('hex').slice(0, 32),
              spanId: hex16(r.id),
              name: 'receipt_event',
              kind: 1,
              startTimeUnixNano: start.toString(),
              endTimeUnixNano: start.toString(),
              attributes: [
                { key: 'timmy.representation', value: { stringValue: 'receipt_event' } },
                { key: 'timmy.projection', value: { stringValue: 'metadata_only' } },
                ...(isHash(r.hash) ? [{ key: 'timmy.receipt.hash', value: { stringValue: r.hash } }] : []),
                ...(isHash(r.prev_hash) ? [{ key: 'timmy.receipt.prev_hash', value: { stringValue: r.prev_hash } }] : []),
                ...(['ok', 'failed', 'denied'].includes(r.status ?? '') ? [{ key: 'timmy.receipt.status', value: { stringValue: r.status! } }] : []),
                ...(r.error_class && errorClasses.has(r.error_class) ? [{ key: 'timmy.error_class', value: { stringValue: r.error_class } }] : []),
                ...(typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd) && r.cost_usd >= 0 ? [{ key: 'timmy.cost_usd', value: { doubleValue: r.cost_usd } }] : []),
                // Receipt ts is a seal timestamp, not a measured operation start.
                // Keep the point event zero-duration; expose ms only as reported.
                ...(typeof r.ms === 'number' && Number.isFinite(r.ms) && r.ms >= 0 ? [{ key: 'timmy.reported_duration_ms', value: { doubleValue: r.ms } }] : [])
              ],
              ...(r.status === 'failed' || r.status === 'denied' ? { status: { code: 2 } } : r.status === 'ok' ? { status: { code: 1 } } : {})
            };
          })
        }]
      };
    })
    .filter(Boolean);
  return { resourceSpans };
}
