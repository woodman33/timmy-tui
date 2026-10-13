// /observe --qualify through @openrouter/sdk's OWN callModel tool loop (round R3, H14), against a LABELLED FAKE
// Responses server on loopback (127.0.0.1): no network, no key, no paid call. It checks that the request
// evidence.ts builds is accepted by the SDK, that the SDK's loop runs the controller's real cite tool, and that
// the cost meter sums every response's reported cost (snake_case on the wire, camelCase in the SDK).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { qualifyInterpretation } from '../src/vision/evidence.js';
import { DETERMINISTIC, type LookObservation } from '../src/vision/look.js';
import { meteredQualifyClient, sdkQualifyClient } from '../src/vision/qualify-route.js';

const SHA = 'ab'.repeat(32);
const LOOK: LookObservation = {
  ok: true, worker: { name: 'timmy-look', version: 'fake' }, opencv: 'fake', python: 'fake',
  source: { path: 'refs/card.png', sha256: SHA, bytes: 72 }, image: { width: 4, height: 2, channels: 3 },
  measurements: [{ name: 'mean_color', value: { r: 7, g: 7, b: 7, hex: '#070707' }, unit: 'sRGB 8-bit, uncalibrated', tier: DETERMINISTIC, note: '' }],
  uncertainty: [],
};
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const usage = (cost: number) => ({ input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110, cost });
const response = (id: string, output: unknown[], cost: number) => ({
  id, object: 'response', created_at: 1, completed_at: 2, status: 'completed', model: 'fake/sdk-model', output,
  error: null, incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: true,
  frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null, tool_choice: 'auto', tools: [], usage: usage(cost),
});

/** The fake server: first turn calls cite(handle), the next answers with the exact envelope. Records each request body. */
async function fakeResponses(): Promise<{ url: string; bodies: Array<Record<string, any>> }> {
  const bodies: Array<Record<string, any>> = [];
  let first: Record<string, any> | undefined;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, any>;
      bodies.push(body);
      const items = Array.isArray(body.input) ? body.input : [];
      const text = JSON.stringify(items);
      const cited = text.includes('function_call_output');
      // The first request carries what the model was shown; a follow-up may carry only the tool output.
      if (!first) {
        const user = items.find((i: { role?: string }) => i?.role === 'user');
        const part = Array.isArray(user?.content) ? user.content.find((c: { type: string }) => c.type === 'input_text')?.text : user?.content;
        first = JSON.parse(String(part ?? (typeof body.input === 'string' ? body.input : '{}')));
      }
      const shown = first!;
      if (!shown?.observations?.length) { res.writeHead(500); res.end('{}'); return; }
      const out = !cited
        ? response('resp_1', [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'cite', arguments: JSON.stringify({ handle_id: shown.observations?.[0]?.handle_id }), status: 'completed' }], 0.001)
        : response('resp_2', [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ run_id: shown.run_id, source_revision: shown.source_revision, evidence: { answer: [shown.observations[0].handle_id] }, payload: { answer: 'Dark grey.' } }), annotations: [] }] }], 0.002);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

describe('qualified route through the SDK callModel loop (loopback fake server)', () => {
  it('the SDK runs the real cite tool, the answer is admitted, and the cost is the sum of both responses', async () => {
    const srv = await fakeResponses();
    const meter = meteredQualifyClient(sdkQualifyClient('test-key-not-real', srv.url));
    const q = await qualifyInterpretation({ observation: LOOK, question: 'What colour is it?', model: 'fake/sdk-model', client: meter.client, currentRevision: () => SHA });
    const spend = await meter.spend();
    expect(srv.bodies.length).toBeGreaterThanOrEqual(2);
    expect(srv.bodies[0].tools?.[0]?.name ?? srv.bodies[0].tools?.[0]?.function?.name).toBe('cite');
    expect(q.snapshot.citations).toHaveLength(1);
    expect(q.admission).toMatchObject({ ok: true, evidence: 'admitted_references' });
    expect(q.answer).toBe('Dark grey.');
    expect(spend).toMatchObject({ sent: true, cost_usd: 0.003, model: 'fake/sdk-model', responses: 2, tokens: 220 });
  }, 20_000);

  it('a stop while the SDK waits: the exchange ends at once, unadmitted, cost unknown; whether the SDK closed the HTTP request is recorded, not assumed', async () => {
    let closed = false;
    let got: () => void = () => undefined;
    const received = new Promise<void>((resolve) => { got = resolve; });
    const server = createServer((req) => { req.on('close', () => { closed = true; }); got(); /* never answers */ });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stop = new AbortController();
    const meter = meteredQualifyClient(sdkQualifyClient('test-key-not-real', url));
    const pending = qualifyInterpretation({ observation: LOOK, question: 'What colour is it?', model: 'fake/sdk-model', client: meter.client, currentRevision: () => SHA, signal: stop.signal });
    await received;
    const t0 = Date.now();
    stop.abort();
    const q = await pending;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(q.admission).toMatchObject({ ok: false, evidence: 'unknown', reason: 'execution_failed' });
    expect(await meter.spend(stop.signal)).toEqual({ sent: true, cost_usd: null });
    await new Promise((r) => setTimeout(r, 200));
    // Observed, not assumed: the SDK passes the signal to its fetch, so the request's socket closes.
    expect(closed).toBe(true);
  }, 20_000);
});
