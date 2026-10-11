/**
 * Timmy Cloud's backend, slice 1: lost answers, reconcile, rate limits and the agency credential, against the SIMULATED
 * provider over real HTTP (no real provider is called).
 *
 * A provider call whose answer is lost leaves its step unknown, never failed and never sent again blindly; reconcile
 * reads the provider and moves it on, or proves it did not happen (then it may be sent again), or waits for a person.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { RECEIVED, folderText, newCustomer, startStack, until, type CustomerHandle, type Stack } from '../services/cloud/test-support.js';
import { SimulatedAdapter } from '../services/cloud/simulated-adapter.js';
import { Redactor, REDACTED } from '../services/cloud/redaction.js';

const DOMAIN_ITEM = 'sim-domain-com-1y';
const SITE_ITEM = 'sim-agency-site';
const VPS_ITEM = 'sim-vps-small-1m';

let stack: Stack | null = null;
afterEach(async () => { await stack?.close(); stack = null; });

const states = (order: { steps: Record<string, { state: string }> }): Record<string, string> => Object.fromEntries(Object.entries(order.steps).map(([k, v]) => [k, v.state]));
const events = (s: Stack): Array<Record<string, any>> => readFileSync(join(s.dataDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function approve(s: Stack, id: string): Promise<any> {
  const r = await s.op('POST', `/v1/operator/orders/${id}/approve`);
  expect(r.status, r.text).toBe(200);
  return r.json.order;
}
async function reconcile(s: Stack, id: string): Promise<any> {
  const r = await s.op('POST', `/v1/operator/orders/${id}/reconcile`);
  expect(r.status, r.text).toBe(200);
  return r.json.order;
}
async function domainOrder(s: Stack, c: CustomerHandle, domain: string): Promise<string> {
  const r = await c.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain }, `k-${domain}`);
  expect(r.status, r.text).toBe(201);
  return r.json.order.order_id;
}
const purchases = (s: Stack): number => s.sim.received.filter((x) => x.op === 'purchase').length;

describe('the provider\'s answer lost after it acted: unknown, then reconcile finds it, and nothing is bought twice', () => {
  for (const mode of ['lose_answer', 'timeout', 'server_error'] as const) {
    it(`${mode}`, async () => {
      stack = await startStack({ timeoutMs: 600 });
      const a = await newCustomer(stack);
      stack.sim.faults.push({ op: 'purchase', mode });
      const id = await domainOrder(stack, a, `lost-${mode.replace('_', '-')}.example`);
      const order = await approve(stack, id);
      expect(states(order)).toMatchObject({ payment: 'unknown', acceptance: 'unknown', provisioning: 'not_started' });
      expect(order.steps.payment.words).toMatch(/^Unknown: .*The provider may have acted\. Nothing is sent again until reconcile reads the provider\./);
      expect(order.cost.charged_cents).toBeNull();
      expect(stack.sim.done('purchase')).toHaveLength(1);
      const settled = await reconcile(stack, id);
      expect(states(settled)).toMatchObject({ payment: 'paid', acceptance: 'accepted', provisioning: 'completed' });
      expect(settled.steps.acceptance.words).toMatch(/^Reconcile found it \(the domain lost-.* is in the account, bought by order sim-order-1001\)/);
      expect(purchases(stack)).toBe(1);
      const kinds = events(stack).filter((e) => e.type === 'call.answer' || e.type === 'reconcile.read').map((e) => `${e.type}:${e.outcome ?? e.finding}`);
      expect(kinds.slice(0, 2)).toEqual(['call.answer:unknown', 'reconcile.read:found']);
    });
  }
});

describe('a purchase that never reached the provider (reset before anything was done)', () => {
  it('a provider that keeps client references: reconcile proves it did not happen; it is sent once more; one purchase in all', async () => {
    stack = await startStack({ sim: { provesAbsence: true } });
    const a = await newCustomer(stack);
    stack.sim.faults.push({ op: 'purchase', mode: 'reset_before' });
    const id = await domainOrder(stack, a, 'never-arrived.example');
    expect((await approve(stack, id)).steps.payment.state).toBe('unknown');
    expect(stack.sim.done('purchase')).toHaveLength(0);
    const settled = await reconcile(stack, id);
    expect(states(settled)).toMatchObject({ payment: 'paid', provisioning: 'completed' });
    expect(stack.sim.done('purchase')).toHaveLength(1);
    expect(purchases(stack)).toBe(2);
    const proof = events(stack).find((e) => e.type === 'reconcile.read' && e.finding === 'proven_absent');
    expect(proof?.steps[0].to.words).toMatch(/^Reconcile proved the call did not take effect \(the provider keeps the client reference of every purchase it receives, and none has this one\)/);
  });

  it('the documented provider (no client references): reconcile cannot prove it, so the order waits for a person; nothing is sent again until a person says so', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    stack.sim.faults.push({ op: 'purchase', mode: 'reset_before' });
    const id = await domainOrder(stack, a, 'unproven.example');
    await approve(stack, id);
    const waiting = await reconcile(stack, id);
    expect(states(waiting)).toMatchObject({ payment: 'unknown', acceptance: 'unknown' });
    expect(waiting.needs_person).toMatch(/^Reconcile could not prove the purchase did not happen \(the domain unproven\.example is not in the account; that does not prove no purchase was placed/);
    expect(waiting.next_action).toMatch(/"happened" \(and the provider's reference\) or "did_not_happen"/);
    const before = events(stack).length;
    await reconcile(stack, id);
    await stack.op('POST', '/v1/operator/reconcile');
    expect(events(stack).length).toBe(before); // read again; nothing new learned, nothing new written
    expect(events(stack).filter((e) => e.type === 'reconcile.read' && e.finding === 'not_proven')).toHaveLength(1);
    expect(purchases(stack)).toBe(1);
    const needs = (await stack.op('GET', '/v1/operator/overview')).json.needs_person;
    expect(needs).toContainEqual(expect.objectContaining({ kind: 'unknown_outcome', order_id: id }));
    const resolved = await stack.op('POST', `/v1/operator/orders/${id}/resolve`, { action: 'did_not_happen', step: 'payment', note: 'checked the provider\'s billing: no such order' });
    expect(resolved.status).toBe(200);
    expect(states(resolved.json.order)).toMatchObject({ payment: 'paid', provisioning: 'completed' });
    expect(purchases(stack)).toBe(2);
    expect(stack.sim.done('purchase')).toHaveLength(1);
  });

  it('a VPS purchase whose answer was lost is not matched by name: a person gives the provider\'s order id', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    stack.sim.faults.push({ op: 'purchase', mode: 'lose_answer' });
    const r = await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'vps');
    await approve(stack, r.json.order.order_id);
    const waiting = await reconcile(stack, r.json.order.order_id);
    expect(waiting.needs_person).toMatch(/1 subscription\(s\) created since the request was sent \(Small VPS, 1 month \(simulated price\)\) may be this purchase; the provider takes no client reference, so which one is not known/);
    const noRef = await stack.op('POST', `/v1/operator/orders/${r.json.order.order_id}/resolve`, { action: 'happened', step: 'payment', note: 'found it' });
    expect(noRef.status).toBe(422);
    const resolved = await stack.op('POST', `/v1/operator/orders/${r.json.order.order_id}/resolve`, { action: 'happened', step: 'payment', reference: 'sim-order-1001', note: 'the provider\'s billing shows order sim-order-1001 at that minute' });
    expect(states(resolved.json.order)).toMatchObject({ payment: 'paid', acceptance: 'accepted', provisioning: 'completed', health: 'ok' });
    expect(purchases(stack)).toBe(1);
    expect(resolved.json.order.decisions).toHaveLength(1);
  });
});

describe('other calls whose answer was lost are settled by reading the provider', () => {
  it('a domain link: found when the site lists the domain; proven absent (and sent again) when it does not', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    for (const [domain, mode] of [['found-link.example', 'lose_answer'], ['absent-link.example', 'reset_before']] as const) {
      const d = await domainOrder(stack, a, domain);
      await approve(stack, d);
      stack.sim.faults.push({ op: 'link_domain', mode });
      const r = await a.order({ kind: 'site', item_id: SITE_ITEM, domain }, `site-${domain}`);
      const order = await approve(stack, r.json.order.order_id);
      expect(states(order)).toMatchObject({ provisioning: 'completed', dns: 'unknown', certificate: 'not_started' });
      const settled = await reconcile(stack, r.json.order.order_id);
      expect(states(settled)).toMatchObject({ dns: 'completed', certificate: 'active', health: 'ok' });
    }
    expect(stack.sim.received.filter((x) => x.op === 'link_domain').map((x) => x.result)).toEqual(['done', 'reset', 'done']);
  });

  it('a site setup: with client references it is found; the site is set up once', async () => {
    stack = await startStack({ sim: { provesAbsence: true } });
    const a = await newCustomer(stack);
    stack.sim.faults.push({ op: 'start_site_setup', mode: 'lose_answer' });
    const r = await a.order({ kind: 'site', item_id: SITE_ITEM }, 'free-site');
    const order = await approve(stack, r.json.order.order_id);
    expect(states(order)).toMatchObject({ acceptance: 'unknown', provisioning: 'unknown' });
    const settled = await reconcile(stack, r.json.order.order_id);
    expect(states(settled)).toMatchObject({ acceptance: 'accepted', provisioning: 'completed', dns: 'not_needed', certificate: 'not_needed', health: 'ok' });
    expect(stack.sim.setups.size).toBe(1);
  });

  it('a site setup on a free subdomain, with no client references: it waits for a person', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    stack.sim.faults.push({ op: 'start_site_setup', mode: 'lose_answer' });
    const r = await a.order({ kind: 'site', item_id: SITE_ITEM }, 'free-site');
    await approve(stack, r.json.order.order_id);
    const waiting = await reconcile(stack, r.json.order.order_id);
    expect(waiting.needs_person).toMatch(/cannot be found by what it asked for/);
    expect(stack.sim.setups.size).toBe(1);
    const setupId = [...stack.sim.setups.keys()][0];
    const resolved = await stack.op('POST', `/v1/operator/orders/${r.json.order.order_id}/resolve`, { action: 'happened', step: 'provisioning', reference: setupId, note: 'the account lists this setup' });
    expect(states(resolved.json.order)).toMatchObject({ acceptance: 'accepted', provisioning: 'completed', health: 'ok' });
    expect(stack.sim.setups.size).toBe(1);
  });
});

describe('a 429 from the provider: nothing at all is sent before its Retry-After', () => {
  it('after a 429, nothing at all is sent before Retry-After; then the call is sent once', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    stack.sim.faults.push({ op: 'purchase', mode: 'rate_limit', retryAfterS: 1 });
    const id = await domainOrder(stack, a, 'patient.example');
    const order = await approve(stack, id);
    expect(order.steps.payment.state).toBe('not_started');
    expect(order.steps.payment.words).toMatch(/^The provider's rate limit answered 429: nothing was done; nothing is sent to it again before its Retry-After/);
    const limitedAt = stack.sim.received.find((x) => x.result === 'rate_limited')!.at;
    const overview = (await stack.op('GET', '/v1/operator/overview')).json;
    expect(Date.parse(overview.provider.paused_until)).toBeGreaterThanOrEqual(limitedAt + 900);
    await reconcile(stack, id);
    await stack.op('POST', '/v1/operator/reconcile');
    expect(purchases(stack)).toBe(1);
    await until(() => Date.now() > Date.parse(order.steps.payment.retry_at) + 20, 5000, 'Retry-After');
    const settled = await reconcile(stack, id);
    expect(states(settled)).toMatchObject({ payment: 'paid', provisioning: 'completed' });
    const after = stack.sim.received.filter((x) => x.at > limitedAt);
    expect(after.length).toBeGreaterThan(0);
    expect(Math.min(...after.map((x) => x.at)) - limitedAt).toBeGreaterThanOrEqual(1000);
    expect(stack.sim.done('purchase')).toHaveLength(1);
  });

  it('the simulator\'s one limit on every route: the orders finish, and no request is sent inside a Retry-After', async () => {
    stack = await startStack({ sim: { rateLimit: { max: 4, windowMs: 1000 } } });
    const a = await newCustomer(stack);
    const ids = [await domainOrder(stack, a, 'w1.example'), await domainOrder(stack, a, 'w2.example')];
    for (const id of ids) await stack.op('POST', `/v1/operator/orders/${id}/approve`);
    await until(async () => {
      await stack!.op('POST', '/v1/operator/reconcile');
      const all = (await a.get('/v1/orders')).json.orders;
      return all.every((o: any) => o.steps.provisioning.state === 'completed');
    }, 15_000, 'both orders');
    const received = stack.sim.received;
    for (const limited of received.filter((x) => x.result === 'rate_limited')) {
      const retryMs = 1000 - ((limited.at - received[0].at) % 1000);
      const next = received.find((x) => x.at > limited.at);
      if (next) expect(next.at - limited.at).toBeGreaterThanOrEqual(Math.min(retryMs, 1000) - 50);
    }
    expect(stack.sim.done('purchase')).toHaveLength(2);
  });

  it('a Retry-After recorded before a restart still holds after it', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    stack.sim.faults.push({ op: 'purchase', mode: 'rate_limit', retryAfterS: 2 });
    const id = await domainOrder(stack, a, 'restart-limit.example');
    const order = await approve(stack, id);
    await stack.stopBackend();
    await stack.restartBackend();
    await reconcile(stack, id);
    expect(purchases(stack)).toBe(1);
    await until(() => Date.now() > Date.parse(order.steps.payment.retry_at) + 20, 5000, 'Retry-After');
    expect((await reconcile(stack, id)).steps.payment.state).toBe('paid');
  });
});

describe('the agency credential appears in no response, event or log line', () => {
  it('a provider error that echoes it is redacted everywhere; tokens are stored as hashes only', async () => {
    RECEIVED.length = 0;
    stack = await startStack();
    const a = await newCustomer(stack);
    stack.sim.faults.push({ op: 'purchase', mode: 'echo_credential' });
    stack.sim.faults.push({ op: 'catalog', mode: 'echo_credential' });
    const id = await domainOrder(stack, a, 'leaky.example');
    expect((await a.get(`/v1/orders/${id}`)).json.order.steps.quote.state).toBe('pending');
    const quoted = await reconcile(stack, id);
    expect(quoted.steps.approval.state).toBe('waiting');
    const order = await approve(stack, id);
    expect(order.steps.acceptance.state).toBe('refused');
    expect(order.steps.acceptance.provider_words).toContain(REDACTED);
    expect(order.steps.acceptance.provider_words).toMatch(/^Request rejected for credentials "Bearer \[redacted: agency credential\]"/);
    await stack.op('GET', '/v1/operator/overview');
    await a.get('/v1/orders');
    const credential = stack.credential;
    const forms = [credential, Buffer.from(credential).toString('base64'), Buffer.from(`Bearer ${credential}`).toString('base64')];
    expect(RECEIVED.length).toBeGreaterThan(5);
    for (const text of RECEIVED) for (const f of forms) expect(text.includes(f)).toBe(false);
    await stack.engine.idle();
    for (const { file, text } of folderText(stack.dataDir)) {
      for (const f of forms) expect(text.includes(f), `${file} holds the credential`).toBe(false);
      expect(text.includes(a.token), `${file} holds a customer token`).toBe(false);
      expect(text.includes(stack.operatorToken), `${file} holds the operator token`).toBe(false);
    }
    expect(readFileSync(join(stack.dataDir, 'backend.log'), 'utf8')).toContain(REDACTED);
    expect(new Redactor([credential]).leaks(JSON.stringify(stack.sim.received))).toBe(false);
  });
});

describe('the adapter', () => {
  it('a connection refused before a byte was written is "not sent"; reads say they failed', async () => {
    const port = await new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
    const adapter = new SimulatedAdapter({ baseUrl: `http://127.0.0.1:${port}`, credential: 'x'.repeat(32), provesAbsence: false, timeoutMs: 1000, redactor: new Redactor(['x'.repeat(32)]) });
    const out = await adapter.call({ op: 'purchase', client_reference: 'call_1', kind: 'vps', item_id: VPS_ITEM, domain: null });
    expect(out).toMatchObject({ kind: 'not_sent' });
    expect((out as { words: string }).words).toMatch(/^The request was not sent: the connection to the provider could not be made \(ECONNREFUSED\)/);
    expect(await adapter.read({ read: 'catalog' })).toMatchObject({ kind: 'failed' });
    expect(adapter.info).toEqual({ name: 'simulated provider', simulated: true, purchase_absence_proof: 'none' });
  });
});
