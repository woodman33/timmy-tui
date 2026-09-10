// Isolated test for the reconcile ledger logic (no network, no seal).
//   npx tsx --test lanes/openrouter/reconcile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAmend, fetchGeneration } from './reconcile.mjs';

const GEN = {
  id: 'gen-abc', total_cost: 0.001234, tokens_prompt: 120, tokens_completion: 340,
  native_tokens_prompt: 118, native_tokens_completion: 339, latency: 820, generation_time: 1900,
  provider_name: 'Fireworks', model: 'x-ai/grok-4.6', finish_reason: 'stop', streamed: false,
  cancelled: false, is_byok: false, upstream_id: 'up-9', origin: 'api',
};

test('buildAmend maps the authoritative figures and cites the original', () => {
  const a = buildAmend(GEN, { generation_id: 'gen-abc', cites: 'sha256_orig', room: 'war-room' });
  assert.equal(a.generation_id, 'gen-abc');
  assert.equal(a.cites, 'sha256_orig');
  assert.equal(a.total_cost_usd, 0.001234);
  assert.equal(a.tokens_prompt, 120);
  assert.equal(a.tokens_completion, 340);
  assert.equal(a.latency_ms, 820);
  assert.equal(a.generation_time_ms, 1900);
  assert.equal(a.served_provider, 'Fireworks'); // served-tier record
  assert.equal(a.model, 'x-ai/grok-4.6');
  assert.equal(a.finish_reason, 'stop');
});

test('buildAmend leaves missing figures null (never zero)', () => {
  const a = buildAmend({ id: 'gen-x' }, { generation_id: 'gen-x', cites: null });
  assert.equal(a.total_cost_usd, null);
  assert.equal(a.tokens_prompt, null);
  assert.equal(a.served_provider, null);
});

test('fetchGeneration returns data on 200 and error otherwise', async () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ data: GEN }) });
  const r = await fetchGeneration('gen-abc', 'key', okFetch);
  assert.ok(r.ok && r.data.id === 'gen-abc');

  const badFetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) });
  const r2 = await fetchGeneration('gen-missing', 'key', badFetch);
  assert.ok(!r2.ok && /404/.test(r2.error));

  const noKey = await fetchGeneration('gen-abc', '', okFetch);
  assert.ok(!noKey.ok && /OPENROUTER_API_KEY/.test(noKey.error));
});
