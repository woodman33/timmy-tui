/**
 * Timmy Cloud's backend, slice 1: the HTTP API against the SIMULATED provider (no real provider is called).
 *
 * Real HTTP on both sides (the backend and the simulated provider listen on 127.0.0.1), real event-log files in a
 * temporary folder. Covers: cross-customer denial on every customer route, the operator's credential, duplicate
 * requests and notices, limits (per order, monthly, the automatic threshold, past_due), cancellation before and after
 * submission, failed payments, partial provisioning, Pro cancelled, deletion approval, and the overview's counts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { http, newCustomer, startStack, type CustomerHandle, type Stack } from '../services/cloud/test-support.js';
import { STEP_NAMES } from '../services/cloud/types.js';
import { sha256Hex } from '../services/cloud/redaction.js';

const DOMAIN_ITEM = 'sim-domain-com-1y';
const SITE_ITEM = 'sim-agency-site';
const VPS_ITEM = 'sim-vps-small-1m';

let stack: Stack | null = null;
afterEach(async () => { await stack?.close(); stack = null; });

/** A raw POST /v1/orders whose body the caller writes (to send JSON that does not parse). */
function rawOrderRequest(base: string, token: string): ReturnType<typeof request> {
  const u = new URL('/v1/orders', base);
  return request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'raw' } });
}

const states = (order: { steps: Record<string, { state: string }> }): Record<string, string> => Object.fromEntries(Object.entries(order.steps).map(([k, v]) => [k, v.state]));

async function approve(s: Stack, orderId: string): Promise<any> {
  const r = await s.op('POST', `/v1/operator/orders/${orderId}/approve`);
  expect(r.status, r.text).toBe(200);
  return r.json.order;
}

/** A registered domain for the customer, bought and approved through the API. */
async function ownDomain(s: Stack, c: CustomerHandle, domain: string): Promise<string> {
  const r = await c.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain }, `domain-${domain}`);
  expect(r.status, r.text).toBe(201);
  const order = await approve(s, r.json.order.order_id);
  expect(order.steps.provisioning.state).toBe('completed');
  return order.order_id;
}

describe('ownership: another customer\'s id answers exactly as a missing one, on every customer route', () => {
  it('denies B every route on A\'s order, resources and domain, with bodies identical to a missing id', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const b = await newCustomer(stack);
    await ownDomain(stack, a, 'a-shop.example');
    const created = await a.order({ kind: 'site', item_id: SITE_ITEM, domain: 'a-shop.example' }, 'site-1');
    const aOrder = created.json.order.order_id as string;
    const missing = `ord_${randomUUID()}`;

    // GET /v1/orders/:id
    const foreign = await b.get(`/v1/orders/${aOrder}`);
    const absent = await b.get(`/v1/orders/${missing}`);
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe(absent.text);
    expect(foreign.json).toEqual({ error: 'No such order.' });
    // POST /v1/orders/:id/cancel
    const foreignCancel = await b.post(`/v1/orders/${aOrder}/cancel`);
    const absentCancel = await b.post(`/v1/orders/${missing}/cancel`);
    expect(foreignCancel.status).toBe(404);
    expect(foreignCancel.text).toBe(absentCancel.text);
    // An id that is not even well formed reads the same.
    expect((await b.get('/v1/orders/..%2F..%2Fetc')).text).toBe(absent.text);
    // GET /v1/orders and GET /v1/resources list only B's own.
    expect((await b.get('/v1/orders')).json.orders).toEqual([]);
    expect((await b.get('/v1/resources')).json.resources).toEqual([]);
    expect((await a.get('/v1/resources')).json.resources.map((r: any) => r.name)).toContain('a-shop.example');
    // POST /v1/orders naming A's domain reads exactly as a domain nobody has.
    const foreignDomain = await b.order({ kind: 'site', item_id: SITE_ITEM, domain: 'a-shop.example' }, 'b-1');
    const nobodyDomain = await b.order({ kind: 'site', item_id: SITE_ITEM, domain: 'nobody-has-this.example' }, 'b-2');
    expect(foreignDomain.status).toBe(422);
    expect(foreignDomain.text).toBe(nobodyDomain.text);
    // A's Idempotency-Key, used by B, makes B's own order, never A's.
    const sameKey = await b.order({ kind: 'vps', item_id: VPS_ITEM }, 'site-1');
    expect(sameKey.status).toBe(201);
    expect(sameKey.json.order.order_id).not.toBe(aOrder);
    // A's order is untouched by B's attempts.
    const mine = await a.get(`/v1/orders/${aOrder}`);
    expect(mine.status).toBe(200);
    expect(mine.json.order.cancel).toBeNull();
  });

  it('every customer route needs a customer token; operator routes need the operator\'s token', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const routes: Array<[string, string]> = [['GET', '/v1/resources'], ['GET', '/v1/orders'], ['POST', '/v1/orders'], ['GET', `/v1/orders/ord_${randomUUID()}`], ['POST', `/v1/orders/ord_${randomUUID()}/cancel`]];
    for (const [method, path] of routes) {
      for (const token of [undefined, 'tc_not-a-real-token', stack.operatorToken]) {
        const r = await http(stack.url, method, path, { token, body: method === 'POST' ? {} : undefined });
        expect(r.status, `${method} ${path}`).toBe(401);
        expect(r.json.error).toBe('This route needs a customer\'s token.');
      }
    }
    const operatorRoutes: Array<[string, string]> = [['GET', '/v1/operator/overview'], ['POST', '/v1/operator/reconcile'], ['POST', '/v1/operator/customers'], ['POST', `/v1/operator/orders/ord_${randomUUID()}/approve`]];
    for (const [method, path] of operatorRoutes) {
      for (const token of [undefined, a.token]) {
        const r = await http(stack.url, method, path, { token });
        expect(r.status, `${method} ${path}`).toBe(401);
        expect(r.json.error).toBe('This route needs the operator\'s token.');
      }
    }
  });
});

describe('the HTTP surface', () => {
  it('answers only to 127.0.0.1 with its own port, never to a web page, and errors are sentences with no path or stack', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const otherHost = await http(stack.url, 'GET', '/v1/orders', { token: a.token, headers: { Host: 'evil.example' } });
    expect(otherHost.status).toBe(403);
    expect(otherHost.json.error).toBe('Refused: this backend answers only to 127.0.0.1 with its own port.');
    const page = await http(stack.url, 'GET', '/v1/orders', { token: a.token, headers: { Origin: 'http://127.0.0.1:1' } });
    expect(page.status).toBe(403);
    const emptyBody = await http(stack.url, 'POST', '/v1/orders', { token: a.token, headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' } });
    expect(emptyBody.status).toBe(422);
    expect(emptyBody.json.error).toBe('The kind is one of: site, domain, vps. Nothing was created.');
    const notJson = await new Promise<{ status: number; text: string }>((resolve) => {
      const req = rawOrderRequest(stack!.url, a.token);
      req.on('response', (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t })); });
      req.end('{"kind":');
    });
    expect(notJson.status).toBe(400);
    expect(JSON.parse(notJson.text)).toEqual({ error: 'Refused: the body is not valid JSON.' });
    expect((await http(stack.url, 'GET', '/v2/anything')).json).toEqual({ error: 'No such route.' });
    expect((await http(stack.url, 'DELETE', '/v1/orders', { token: a.token })).status).toBe(405);
    for (const r of [otherHost, page, emptyBody]) { expect(r.text).not.toMatch(/\/(home|Users|tmp)\//); expect(r.text).not.toMatch(/\bat \S+ \(/); }
  });
});

describe('duplicates: the same request or notice twice changes nothing', () => {
  it('one order per (customer, Idempotency-Key); a different request under the same key is refused', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const body = { kind: 'domain', item_id: DOMAIN_ITEM, domain: 'twice.example' };
    const first = await a.order(body, 'key-1');
    const again = await a.order(body, 'key-1');
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(again.json.order.order_id).toBe(first.json.order.order_id);
    const different = await a.order({ ...body, domain: 'other.example' }, 'key-1');
    expect(different.status).toBe(409);
    expect(different.json.error).toMatch(/already used for a different request: nothing new was created/);
    expect((await a.get('/v1/orders')).json.orders).toHaveLength(1);
    const noKey = await http(stack.url, 'POST', '/v1/orders', { token: a.token, body });
    expect(noKey.status).toBe(400);
    expect(noKey.json.error).toMatch(/Idempotency-Key/);
    await approve(stack, first.json.order.order_id);
    await approve(stack, first.json.order.order_id); // approving twice changes nothing
    expect(stack.sim.done('purchase')).toHaveLength(1);
  });

  it('a billing notice and a provider notice delivered twice are applied once', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const before = (await stack.op('GET', '/v1/operator/overview')).json.event_log.events_applied;
    const n1 = await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'bill-1', customer_id: a.id, state: 'past_due' });
    const n2 = await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'bill-1', customer_id: a.id, state: 'past_due' });
    expect(n1.json.duplicate).toBe(false);
    expect(n2.json.duplicate).toBe(true);
    stack.sim.payments.push({ processing: 2, then: 'paid' });
    await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'bill-2', customer_id: a.id, state: 'active' });
    const order = await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'vps-1');
    const pending = await approve(stack, order.json.order.order_id);
    expect(pending.steps.payment.state).toBe('pending');
    const ref = pending.steps.payment.reference;
    const p1 = await stack.op('POST', '/v1/operator/provider-notices', { notice_id: 'prov-1', reference: ref });
    const afterFirst = (await stack.op('GET', '/v1/operator/overview')).json.event_log.events_applied;
    const p2 = await stack.op('POST', '/v1/operator/provider-notices', { notice_id: 'prov-1', reference: ref });
    const afterSecond = (await stack.op('GET', '/v1/operator/overview')).json.event_log.events_applied;
    expect(p1.json).toMatchObject({ duplicate: false, reconciled: [order.json.order.order_id] });
    expect(p2.json).toEqual({ duplicate: true, reconciled: [] });
    expect(afterSecond).toBe(afterFirst);
    expect(before).toBeGreaterThan(0);
    // The notice moved nothing by itself: the order moved because the provider was read.
    const now = (await a.get(`/v1/orders/${order.json.order.order_id}`)).json.order;
    expect(now.steps.payment.state).toBe('paid');
    expect(now.steps.payment.words).toMatch(/^Read from the provider/);
    expect(stack.sim.done('start_vps_setup')).toHaveLength(1);
  });
});

describe('limits: a Pro subscription never authorizes unlimited purchases', () => {
  it('refuses a customer with no finite limits', async () => {
    stack = await startStack();
    for (const limits of [{}, { per_order_cents: 1000 }, { per_order_cents: -1, monthly_cents: 10 }, { per_order_cents: 1.5, monthly_cents: 10 }, { per_order_cents: 'unlimited', monthly_cents: 10 }]) {
      const r = await stack.op('POST', '/v1/operator/customers', { limits, subscription: 'active' });
      expect(r.status, JSON.stringify(limits)).toBe(422);
      expect(r.json.error).toMatch(/there is no unlimited/);
    }
  });

  it('per-order limit: refused by rule, nothing sent to the provider', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 1000, monthly_cents: 50_000 });
    const r = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'too-dear.example' }, 'k');
    expect(r.status).toBe(201);
    expect(states(r.json.order)).toMatchObject({ quote: 'quoted', approval: 'refused', payment: 'stopped', provisioning: 'stopped' });
    expect(r.json.order.steps.approval.words).toMatch(/over the per-order limit \(\$10\.00\)/);
    expect((await stack.op('POST', `/v1/operator/orders/${r.json.order.order_id}/approve`)).status).toBe(409);
    expect(stack.sim.done('purchase')).toHaveLength(0);
  });

  it('monthly limit: counted at approval, checked again when the operator approves', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 5000, monthly_cents: 2000 });
    const one = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'one.example' }, 'k1');
    const two = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'two.example' }, 'k2');
    expect(one.json.order.steps.approval.state).toBe('waiting');
    expect(two.json.order.steps.approval.state).toBe('waiting');
    await approve(stack, one.json.order.order_id);
    const refused = await stack.op('POST', `/v1/operator/orders/${two.json.order.order_id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/would pass the monthly limit \(\$20\.00\)/);
    expect((await a.get(`/v1/orders/${two.json.order.order_id}`)).json.order.steps.approval.state).toBe('waiting');
    const three = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'three.example' }, 'k3');
    expect(three.json.order.steps.approval.state).toBe('refused');
    expect(stack.sim.done('purchase')).toHaveLength(1);
    const o = (await stack.op('GET', '/v1/operator/overview')).json.customers.find((c: any) => c.customer_id === a.id);
    expect(o).toMatchObject({ approved_this_month_cents: 1200, paid_this_month_cents: 1200, limits: { monthly_cents: 2000 } });
    // The operator raises the monthly limit; the order that waited can now be approved.
    const raised = await stack.op('PUT', `/v1/operator/customers/${a.id}/limits`, { limits: { per_order_cents: 5000, monthly_cents: 3000 } });
    expect(raised.status, raised.text).toBe(200);
    expect(raised.json.customer.limits).toEqual({ per_order_cents: 5000, monthly_cents: 3000, auto_approve_up_to_cents: 0 });
    expect(raised.json.customer.token_sha256).toBeUndefined();
    expect((await approve(stack, two.json.order.order_id)).steps.payment.state).toBe('paid');
    expect((await stack.op('PUT', `/v1/operator/customers/${a.id}/limits`, { limits: { per_order_cents: 5000 } })).status).toBe(422);
  });

  it('the automatic threshold: 0 by default (every order waits); at or under a set threshold, approved automatically', async () => {
    stack = await startStack();
    const waits = await newCustomer(stack);
    const r1 = await waits.order({ kind: 'vps', item_id: VPS_ITEM }, 'k');
    expect(r1.json.order.steps.approval.state).toBe('waiting');
    expect(r1.json.order.steps.approval.words).toMatch(/no automatic approval/);
    // Even an order that costs nothing (a site on the agency plan) waits when the threshold is 0.
    const free = await waits.order({ kind: 'site', item_id: SITE_ITEM }, 'free');
    expect(free.json.order.quote.total_cents).toBe(0);
    expect(free.json.order.steps.approval.state).toBe('waiting');
    expect(stack.sim.received.filter((x) => x.op === 'start_site_setup')).toHaveLength(0);
    expect(stack.sim.done('purchase')).toHaveLength(0);
    const auto = await newCustomer(stack, { auto_approve_up_to_cents: 700 });
    const r2 = await auto.order({ kind: 'vps', item_id: VPS_ITEM }, 'k');
    expect(r2.json.order.steps.approval.state).toBe('approved');
    expect(r2.json.order.steps.approval.words).toMatch(/Approved automatically/);
    expect(r2.json.order.steps.provisioning.state).toBe('completed');
    const r3 = await auto.order({ kind: 'vps', item_id: 'sim-vps-large-1m' }, 'k2');
    expect(r3.json.order.steps.approval.state).toBe('waiting');
    expect(stack.sim.done('purchase')).toHaveLength(1);
  });

  it('past_due and canceled: no new purchases, and a waiting order cannot be approved', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const waiting = await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'k1');
    await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'n1', customer_id: a.id, state: 'past_due' });
    const refused = await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'k2');
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('No new purchases: the Timmy Pro subscription is past due. Nothing was created.');
    const approveLate = await stack.op('POST', `/v1/operator/orders/${waiting.json.order.order_id}/approve`);
    expect(approveLate.status).toBe(409);
    expect(approveLate.json.error).toMatch(/past due: no new purchases/);
    await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'n2', customer_id: a.id, state: 'canceled' });
    expect((await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'k3')).status).toBe(403);
    expect(stack.sim.done('purchase')).toHaveLength(0);
    expect((await a.get('/v1/orders')).json.orders).toHaveLength(1);
  });
});

describe('cancellation says exactly what happened', () => {
  it('before submission: cancelled here, nothing sent; the approval can no longer happen', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const r = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'never.example' }, 'k');
    const c = await a.post(`/v1/orders/${r.json.order.order_id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.json.cancelled_here).toBe(true);
    expect(c.json.words).toBe('Cancelled here, before anything was sent to the provider: nothing was bought or set up.');
    expect(states(c.json.order)).toMatchObject({ quote: 'quoted', approval: 'cancelled', payment: 'cancelled', provisioning: 'cancelled' });
    expect((await stack.op('POST', `/v1/operator/orders/${r.json.order.order_id}/approve`)).status).toBe(409);
    await stack.op('POST', '/v1/operator/reconcile');
    expect(stack.sim.received.filter((x) => x.op === 'purchase')).toHaveLength(0);
    const again = await a.post(`/v1/orders/${r.json.order.order_id}/cancel`);
    expect(again.json.words).toMatch(/^Already asked: Cancelled here/);
  });

  it('after submission: "cancel asked", the provider operation NOT cancelled, the order still reconciled, then a person decides', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { auto_approve_up_to_cents: 2000 });
    stack.sim.payments.push({ processing: 2, then: 'paid' });
    const r = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'late-cancel.example' }, 'k');
    const id = r.json.order.order_id;
    expect(r.json.order.steps.payment.state).toBe('pending');
    const c = await a.post(`/v1/orders/${id}/cancel`);
    expect(c.json.cancelled_here).toBe(false);
    expect(c.json.words).toMatch(/^Cancel asked\. The provider has no operation that cancels a purchase or a setup, so the provider operation was NOT cancelled/);
    // Reconcile goes on: the payment settles at the provider and is read.
    const after = (await stack.op('POST', `/v1/operator/orders/${id}/reconcile`)).json.order;
    expect(after.steps.payment.state).toBe('paid');
    // No new call that changes anything: the domain's registration was not completed.
    expect(after.steps.provisioning.state).toBe('not_started');
    expect(stack.sim.received.filter((x) => x.op === 'complete_domain_registration')).toHaveLength(0);
    const needs = (await stack.op('GET', '/v1/operator/overview')).json.needs_person;
    expect(needs).toContainEqual(expect.objectContaining({ kind: 'cancel_asked', order_id: id }));
    // A person stops it: what exists stays, nothing is deleted.
    const stopped = await stack.op('POST', `/v1/operator/orders/${id}/resolve`, { action: 'stop', note: 'the customer does not want it; the paid domain stays in the account' });
    expect(states(stopped.json.order)).toMatchObject({ payment: 'paid', provisioning: 'stopped' });
    expect(stopped.json.order.needs_person).toBeNull();
    expect(stack.sim.received.filter((x) => x.op === 'delete_site')).toHaveLength(0);
  });

  it('an order that has ended cannot be cancelled; removing what it made is a deletion', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const id = await ownDomain(stack, a, 'ended.example');
    const c = await a.post(`/v1/orders/${id}/cancel`);
    expect(c.status).toBe(409);
    expect(c.json.error).toMatch(/Nothing to cancel: this order has ended/);
  });
});

describe('failed payments end the order failed, with the provider\'s words, and create nothing', () => {
  it('declined at once', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    stack.sim.payments.push('declined');
    const r = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'declined.example' }, 'k');
    const order = await approve(stack, r.json.order.order_id);
    expect(states(order)).toMatchObject({ acceptance: 'accepted', payment: 'failed', provisioning: 'stopped' });
    expect(order.steps.payment.provider_words).toBe('The payment was declined by the payment method on file (simulated).');
    expect(order.summary).toMatch(/^The payment failed \(the provider: "The payment was declined/);
    expect(order.resources).toEqual([]);
    expect((await a.get('/v1/resources')).json.resources).toEqual([]);
    expect(stack.sim.domains.has('declined.example')).toBe(false);
    const c = (await stack.op('GET', '/v1/operator/overview')).json.customers[0];
    expect(c.approved_this_month_cents).toBe(0);
    expect(c.paid_this_month_cents).toBe(0);
  });

  it('accepted as processing (202), then failed when read', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    stack.sim.payments.push({ processing: 2, then: 'failed' });
    const r = await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'k');
    const pending = await approve(stack, r.json.order.order_id);
    expect(pending.steps.payment.state).toBe('pending');
    expect(pending.cost).toEqual({ quoted_cents: 700, currency: 'USD', charged_cents: null });
    const order = (await stack.op('POST', `/v1/operator/orders/${r.json.order.order_id}/reconcile`)).json.order;
    expect(states(order)).toMatchObject({ payment: 'failed', provisioning: 'stopped', health: 'stopped' });
    expect(order.steps.payment.provider_words).toMatch(/declined \(simulated\)/);
    expect(order.resources).toEqual([]);
    expect(stack.sim.received.filter((x) => x.op === 'start_vps_setup')).toHaveLength(0);
  });
});

describe('partial provisioning: each step\'s state and the next action named', () => {
  it('a site whose domain link failed is partial; a person\'s retry finishes it', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    await ownDomain(stack, a, 'linkme.example');
    stack.sim.linkOutcomes.push('fail');
    const r = await a.order({ kind: 'site', item_id: SITE_ITEM, domain: 'linkme.example' }, 'site');
    const order = await approve(stack, r.json.order.order_id);
    expect(states(order)).toMatchObject({ payment: 'not_needed', acceptance: 'accepted', provisioning: 'completed', dns: 'failed', certificate: 'stopped', health: 'ok' });
    expect(order.partial).toBe(true);
    expect(order.steps.dns.provider_words).toMatch(/does not point to this hosting yet/);
    expect(order.summary).toMatch(/^Partly provisioned: the site exists .*the domain link failed .*the certificate was not started/);
    expect(order.next_action).toMatch(/retry the link: POST \/v1\/operator\/orders\/.+\/resolve with action "retry" and step "dns"/);
    expect(order.resources.map((x: any) => x.kind)).toEqual(['site']);
    const needs = (await stack.op('GET', '/v1/operator/overview')).json.needs_person;
    expect(needs).toContainEqual(expect.objectContaining({ kind: 'failed_step', order_id: order.order_id }));
    const retried = await stack.op('POST', `/v1/operator/orders/${order.order_id}/resolve`, { action: 'retry', step: 'dns', note: 'nameservers set' });
    expect(states(retried.json.order)).toMatchObject({ dns: 'completed', certificate: 'active', health: 'ok' });
    expect(retried.json.order.partial).toBe(false);
    expect(retried.json.order.summary).toMatch(/^Done/);
  });

  it('a site whose certificate failed is partial, with the provider\'s words', async () => {
    stack = await startStack({ sim: { certificateCooldownMs: 0 } });
    const a = await newCustomer(stack);
    await ownDomain(stack, a, 'certfail.example');
    stack.sim.certificateOutcomes.push('fail');
    const r = await a.order({ kind: 'site', item_id: SITE_ITEM, domain: 'certfail.example' }, 'site');
    const order = await approve(stack, r.json.order.order_id);
    expect(states(order)).toMatchObject({ provisioning: 'completed', dns: 'completed', certificate: 'failed', health: 'ok' });
    expect(order.partial).toBe(true);
    expect(order.steps.certificate.provider_words).toMatch(/could not validate the domain/);
    expect(order.next_action).toMatch(/retry the certificate: .*three certificate setups per domain in seven days/);
    const retried = await stack.op('POST', `/v1/operator/orders/${order.order_id}/resolve`, { action: 'retry', step: 'certificate', note: 'validation fixed' });
    expect(retried.json.order.steps.certificate.state).toBe('active');
  });
});

describe('Pro cancelled: everything retained, nothing deleted, every domain decided by a person', () => {
  it('retains each resource with a date, lists the exports and the domain decisions, and deletes only on approval', async () => {
    stack = await startStack({ retentionDays: 30 });
    const a = await newCustomer(stack);
    await ownDomain(stack, a, 'keep.example');
    const site = await a.order({ kind: 'site', item_id: SITE_ITEM, domain: 'keep.example' }, 'site');
    await approve(stack, site.json.order.order_id);
    const vps = await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'vps');
    await approve(stack, vps.json.order.order_id);
    expect((await a.get('/v1/resources')).json.resources.map((r: any) => r.kind).sort()).toEqual(['certificate', 'domain', 'site', 'vps']);

    const notice = await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'cancel-1', customer_id: a.id, state: 'canceled' });
    expect(notice.status).toBe(200);
    const resources = (await a.get('/v1/resources')).json.resources;
    expect(resources.every((r: any) => r.state === 'retained')).toBe(true);
    const until = Date.parse(resources[0].retained.until);
    expect(until - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(resources[0].retained.words).toMatch(/Nothing is deleted/);
    expect(stack.sim.received.filter((x) => x.op === 'delete_site')).toHaveLength(0);
    expect([...stack.sim.sites.values()].every((s) => s.state === 'active')).toBe(true);

    const needs = (await stack.op('GET', '/v1/operator/overview')).json.needs_person.filter((n: any) => n.customer_id === a.id);
    expect(needs.map((n: any) => n.kind).sort()).toEqual(['domain_decision', 'export', 'export']);
    const domainItem = needs.find((n: any) => n.kind === 'domain_decision');
    expect(domainItem.reason).toMatch(/decide domain keep\.example: transfer it to the customer, renew it, or let it lapse; its registration ends on .* \(36[45] days\)\. The backend never lets a domain lapse without a person's decision\./);
    expect((await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'after')).status).toBe(403);

    // Deleting the site: a separate request, refused while its export is open, then approved by a person.
    const siteRes = resources.find((r: any) => r.kind === 'site');
    const del = await stack.op('POST', '/v1/operator/deletions', { resource_id: siteRes.resource_id, reason: 'the customer asked for the data to be removed' });
    expect(del.status).toBe(201);
    expect(stack.sim.received.filter((x) => x.op === 'delete_site')).toHaveLength(0);
    const early = await stack.op('POST', `/v1/operator/deletions/${del.json.deletion.deletion_id}/decide`, { decision: 'approve', confirm_resource_id: siteRes.resource_id, note: 'ok' });
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/export of this site is still open/);
    const exportItem = needs.find((n: any) => n.kind === 'export' && n.resource_id === siteRes.resource_id);
    expect((await stack.op('POST', `/v1/operator/retention/${exportItem.item_id}/decide`, { decision: 'exported', note: 'archive handed to the customer' })).status).toBe(200);
    const wrongName = await stack.op('POST', `/v1/operator/deletions/${del.json.deletion.deletion_id}/decide`, { decision: 'approve', confirm_resource_id: 'res_other', note: 'ok' });
    expect(wrongName.status).toBe(422);
    const approved = await stack.op('POST', `/v1/operator/deletions/${del.json.deletion.deletion_id}/decide`, { decision: 'approve', confirm_resource_id: siteRes.resource_id, note: 'export done; customer confirmed' });
    expect(approved.status).toBe(200);
    expect(approved.json.deletion.step.state).toBe('completed');
    expect(stack.sim.done('delete_site')).toHaveLength(1);
    const after = (await a.get('/v1/resources')).json.resources;
    expect(after.find((r: any) => r.kind === 'site').state).toBe('deleted');
    expect(after.filter((r: any) => r.kind !== 'site').every((r: any) => r.state === 'retained')).toBe(true);

    // The domain is decided by a person; the decision is recorded and nothing is done at the provider.
    const d = await stack.op('POST', `/v1/operator/retention/${domainItem.item_id}/decide`, { decision: 'let_lapse', note: 'the customer does not want it' });
    expect(d.json.words).toMatch(/a person decided to let keep\.example lapse on .*Nothing was done at the provider/);
    const left = (await stack.op('GET', '/v1/operator/overview')).json.needs_person.filter((n: any) => n.customer_id === a.id);
    expect(left.map((n: any) => n.kind)).toEqual(['export']);
  });
});

describe('Pro cancelled, then later', () => {
  it('a domain whose registration ended with no decision is named as such; nothing lapses silently', async () => {
    let offsetMs = 0;
    stack = await startStack({ clock: () => new Date(Date.now() + offsetMs) });
    const a = await newCustomer(stack);
    await ownDomain(stack, a, 'undecided.example');
    await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'c1', customer_id: a.id, state: 'canceled' });
    offsetMs = 400 * 86_400_000;
    const item = (await stack.op('GET', '/v1/operator/overview')).json.needs_person.find((n: any) => n.kind === 'domain_decision');
    expect(item.reason).toMatch(/its registration ended on .* with no decision\. The backend never lets a domain lapse without a person's decision\./);
    expect((await a.get('/v1/resources')).json.resources[0].state).toBe('retained');
  });

  it('billing saying active again ends the retention and closes the open items', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    await ownDomain(stack, a, 'back.example');
    await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'c1', customer_id: a.id, state: 'canceled' });
    expect((await stack.op('GET', '/v1/operator/overview')).json.needs_person.map((n: any) => n.kind)).toEqual(['domain_decision']);
    const back = await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'c2', customer_id: a.id, state: 'active' });
    expect(back.json.subscription.state).toBe('active');
    expect((await a.get('/v1/resources')).json.resources.map((r: any) => [r.state, r.retained])).toEqual([['active', null]]);
    expect((await stack.op('GET', '/v1/operator/overview')).json.needs_person).toEqual([]);
    expect((await a.order({ kind: 'vps', item_id: VPS_ITEM }, 'again')).status).toBe(201);
  });
});

describe('the overview', () => {
  it('counts every step\'s states exactly as the orders themselves report them', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { auto_approve_up_to_cents: 1500 });
    const b = await newCustomer(stack);
    await ownDomain(stack, a, 'count.example');
    stack.sim.payments.push('declined');
    await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'declined.example' }, 'k1');
    await b.order({ kind: 'vps', item_id: VPS_ITEM }, 'k1');
    await b.order({ kind: 'vps', item_id: 'sim-vps-large-1m' }, 'k2');
    const c = await b.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'cancel.example' }, 'k3');
    await b.post(`/v1/orders/${c.json.order.order_id}/cancel`);
    stack.sim.linkOutcomes.push('fail');
    await a.order({ kind: 'site', item_id: SITE_ITEM, domain: 'count.example' }, 'k2');

    const overview = (await stack.op('GET', '/v1/operator/overview')).json;
    const orders = [...(await a.get('/v1/orders')).json.orders, ...(await b.get('/v1/orders')).json.orders];
    expect(overview.orders).toBe(orders.length);
    for (const step of STEP_NAMES) {
      const own: Record<string, number> = {};
      for (const o of orders) own[o.steps[step].state] = (own[o.steps[step].state] ?? 0) + 1;
      const counted = Object.fromEntries(Object.entries(overview.counts[step]).filter(([, n]) => (n as number) > 0));
      expect(counted, step).toEqual(own);
    }
    const waiting = orders.filter((o) => o.steps.approval.state === 'waiting').map((o) => o.order_id).sort();
    expect(overview.needs_person.filter((n: any) => n.kind === 'approval').map((n: any) => n.order_id).sort()).toEqual(waiting);
    expect(overview.provider).toMatchObject({ simulated: true, purchase_absence_proof: 'none' });
  });
});

describe('the event log', () => {
  it('holds tokens only as sha256 hashes, and rebuilds the same state after a restart', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    await ownDomain(stack, a, 'rebuild.example');
    const before = (await stack.op('GET', '/v1/operator/overview')).json;
    const log = readFileSync(join(stack.dataDir, 'events.jsonl'), 'utf8');
    expect(log).not.toContain(a.token);
    expect(log).not.toContain(stack.operatorToken);
    expect(log).toContain(sha256Hex(a.token));
    await stack.stopBackend();
    await stack.restartBackend();
    const after = (await stack.op('GET', '/v1/operator/overview')).json;
    expect({ ...after, generated_at: null }).toEqual({ ...before, generated_at: null });
    expect((await http(stack.url, 'GET', '/v1/orders', { token: a.token })).json.orders).toHaveLength(1);
  });
});
