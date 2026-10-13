/**
 * Timmy Cloud's backend: the independent review's findings (R4, H91 on r4/cloud-2), each as a test of the behaviour where
 * it lives: real HTTP, real event-log files, the SIMULATED provider (no real provider is called), and for the lock, two
 * real backend processes racing.
 *
 * H1: reconcile never hands one customer another customer's (or another order's) purchase.
 * M1: a price that moved since the quote holds the order for the operator; a charge above the quote or a cap needs a person.
 * L3: two backends taking over a stale lock at once: exactly one runs.
 * L4: nothing of a cancelled customer's is deleted before its retention date.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { agencyCredential, customerHandle, newCustomer, spawnBackend, startStack, tempDir, until, type CustomerHandle, type Stack } from '../services/cloud/test-support.js';
import { SimulatedProvider } from '../services/cloud/simulated-provider.js';
import { newToken, sha256Hex } from '../services/cloud/redaction.js';

const DOMAIN_ITEM = 'sim-domain-com-1y';
const SITE_ITEM = 'sim-agency-site';

let stack: Stack | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await stack?.close(); stack = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const states = (order: { steps: Record<string, { state: string }> }): Record<string, string> => Object.fromEntries(Object.entries(order.steps).map(([k, v]) => [k, v.state]));
const events = (s: Stack): Array<Record<string, any>> => readFileSync(join(s.dataDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function approve(s: Stack, id: string): Promise<any> {
  const r = await s.op('POST', `/v1/operator/orders/${id}/approve`);
  expect(r.status, r.text).toBe(200);
  return r.json.order;
}
const reconcile = async (s: Stack, id: string): Promise<any> => (await s.op('POST', `/v1/operator/orders/${id}/reconcile`)).json.order;

/**
 * What a backend from before the domain check (r4/cloud-1) would have written for `customer`: a copy of `template`'s own
 * events, each with B's new order, key, customer, call and event ids. `upTo` names the last event type copied:
 * 'order.created' (the order only), or 'call.intent' (created, quoted, approved, and its purchase written ahead but never
 * answered, as when the provider's answer was lost). The backend must be stopped while this is written.
 */
function writeOrderAsOldBackend(s: Stack, templateOrderId: string, customer: string, upTo: 'order.created' | 'call.intent'): string {
  const all = events(s);
  const orderId = `ord_${randomUUID()}`;
  const key = sha256Hex(`old-backend-${orderId}`);
  const callId = `call_${randomUUID()}`;
  const now = new Date().toISOString();
  const swap = (x: unknown): unknown => JSON.parse(JSON.stringify(x).split(templateOrderId).join(orderId));
  const mine = all.filter((e) => e.order?.order_id === templateOrderId || e.order_id === templateOrderId || e.call?.order_id === templateOrderId);
  const out: Array<Record<string, any>> = [];
  for (const e of mine) {
    const copy = swap(e) as Record<string, any>;
    copy.at = now;
    copy.id = randomUUID();
    if (copy.type === 'order.created') {
      copy.order = { ...copy.order, customer_id: customer, idempotency_key_sha256: key, created_at: now };
      copy.id = `order.created:${sha256Hex(`${customer}:${key}`)}`;
    }
    if (copy.type === 'call.intent') {
      const old = copy.call.call_id as string;
      Object.assign(copy, JSON.parse(JSON.stringify(copy).split(old).join(callId)));
      copy.call.intent_at = now;
    }
    if (copy.type === 'order.approval' && copy.approved_month === null && upTo === 'call.intent') continue; // keep only the approval
    out.push(copy);
    if (copy.type === upTo) break;
  }
  expect(out[out.length - 1].type).toBe(upTo);
  appendFileSync(join(s.dataDir, 'events.jsonl'), out.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return orderId;
}

describe('H1: reconcile never hands one customer another order\'s purchase', () => {
  it('a domain already registered or ordered here cannot be ordered again, by anyone (the review\'s scenario)', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const b = await newCustomer(stack);
    const open = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'shared.example' }, 'a-1');
    expect(open.status).toBe(201);
    const words = 'This domain is not available to order (it is registered, or an order for it is open). Nothing was created.';
    const whileOpen = await b.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'shared.example' }, 'b-1');
    expect(whileOpen.status).toBe(422);
    expect(whileOpen.json.error).toBe(words);
    await approve(stack, open.json.order.order_id);
    for (const [c, key] of [[b, 'b-2'], [a, 'a-2']] as Array<[CustomerHandle, string]>) {
      const again = await c.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'shared.example' }, key);
      expect(again.status).toBe(422);
      expect(again.json.error).toBe(words);
    }
    expect((await b.get('/v1/orders')).json.orders).toEqual([]);
    expect(stack.sim.received.filter((x) => x.op === 'purchase')).toHaveLength(1);
  });

  it('the review\'s scenario, from an older backend\'s log: B\'s purchase of A\'s domain was written ahead and its answer lost; reconcile does not "find" it', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const b = await newCustomer(stack);
    const aOrder = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'shared.example' }, 'a-1')).json.order.order_id;
    await approve(stack, aOrder);
    await stack.stopBackend();
    const bOrder = writeOrderAsOldBackend(stack, aOrder, b.id, 'call.intent');
    await stack.restartBackend();
    const own = customerHandle(stack, b.id, b.token);
    expect((await own.get(`/v1/orders/${bOrder}`)).json.order.steps.payment.state).toBe('unknown');
    const after = await reconcile(stack, bOrder);
    expect(states(after)).toMatchObject({ payment: 'unknown', acceptance: 'unknown', provisioning: 'not_started' });
    // Either guard holds it: the provider's purchase predates the call (by more than the clocks' margin), or it is already
    // another order's in this backend (here A's, which registered the domain moments before).
    expect(after.needs_person).toMatch(/^Reconcile could not prove the purchase did not happen \(the domain shared\.example is in the account, but (its purchase was placed before this call was sent|that purchase is already another order's in this backend), so it is not this call's/);
    expect(after.cost.charged_cents).toBeNull();
    expect((await own.get('/v1/resources')).json.resources).toEqual([]);
    expect((await own.order({ kind: 'site', item_id: SITE_ITEM, domain: 'shared.example' }, 'b-site')).status).toBe(422);
    expect(JSON.stringify((await own.get(`/v1/orders/${bOrder}`)).json)).not.toContain(aOrder);
  });

  it('an older backend\'s order for a domain already registered here for another order is refused at approval; nothing is sent', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const b = await newCustomer(stack);
    const aOrder = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'taken.example' }, 'a-1')).json.order.order_id;
    await approve(stack, aOrder);
    await stack.stopBackend();
    const bOrder = writeOrderAsOldBackend(stack, aOrder, b.id, 'order.created');
    await stack.restartBackend();
    const quoted = await reconcile(stack, bOrder);
    expect(states(quoted)).toMatchObject({ quote: 'quoted', approval: 'refused', payment: 'stopped' });
    expect(quoted.steps.approval.words).toBe('Refused: the domain is not available (it is registered).');
    expect(stack.sim.received.filter((x) => x.op === 'purchase')).toHaveLength(1);
  });

  it('a purchase newer than the call, but already another order\'s, is not given to this one (only the backend\'s own records can tell)', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const b = await newCustomer(stack);
    const aOrder = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'race.example' }, 'a-1')).json.order.order_id;
    await stack.stopBackend();
    const bOrder = writeOrderAsOldBackend(stack, aOrder, b.id, 'order.created');
    await stack.restartBackend();
    await reconcile(stack, bOrder);
    // B's purchase never reaches the provider; then A's is made, after B's call was written ahead.
    stack.sim.faults.push({ op: 'purchase', mode: 'reset_before' });
    expect((await approve(stack, bOrder)).steps.payment.state).toBe('unknown');
    expect((await approve(stack, aOrder)).steps.provisioning.state).toBe('completed');
    const after = await reconcile(stack, bOrder);
    expect(after.steps.payment.state).toBe('unknown');
    expect(after.needs_person).toMatch(/that purchase is already another order's in this backend, so it is not this call's/);
    expect(after.resources).toEqual([]);
    // A person checks: B's call never arrived. It is not sent again: the domain is now registered here for A.
    const resolved = await stack.op('POST', `/v1/operator/orders/${bOrder}/resolve`, { action: 'did_not_happen', step: 'payment', note: 'the provider has no purchase from this call' });
    expect(states(resolved.json.order)).toMatchObject({ approval: 'refused', acceptance: 'stopped', payment: 'stopped' });
    expect(resolved.json.order.steps.approval.words).toBe('Refused: the domain is not available (it is registered).');
    expect(stack.sim.received.filter((x) => x.op === 'purchase').map((x) => x.result)).toEqual(['reset', 'done']);
    expect((await customerHandle(stack, b.id, b.token).get('/v1/resources')).json.resources).toEqual([]);
  });

  it('a domain bought outside Timmy before the call is not this call\'s purchase', async () => {
    stack = await startStack({ clockMarginMs: 500 });
    const c = await newCustomer(stack);
    const outside = await fetchRaw(stack.sim, 'POST', '/sim/v1/purchases', { items: [{ item_id: DOMAIN_ITEM, quantity: 1 }], domain: 'outside.example' });
    expect(outside.status).toBe(200);
    await new Promise((r) => setTimeout(r, 800)); // the call is written ahead after that purchase, beyond the clocks' margin
    const order = (await c.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'outside.example' }, 'c-1')).json.order.order_id;
    stack.sim.faults.push({ op: 'purchase', mode: 'lose_answer' });
    await approve(stack, order);
    const after = await reconcile(stack, order);
    expect(after.steps.payment.state).toBe('unknown');
    expect(after.needs_person).toMatch(/the domain outside\.example is in the account, but its purchase was placed before this call was sent, so it is not this call's/);
    expect(after.resources).toEqual([]);
  });

  it('a person cannot give an order a purchase that is already another order\'s', async () => {
    stack = await startStack();
    const a = await newCustomer(stack);
    const b = await newCustomer(stack);
    const aDone = await approve(stack, (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'mine.example' }, 'a-1')).json.order.order_id);
    stack.sim.faults.push({ op: 'purchase', mode: 'reset_before' });
    const bOrder = (await b.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'theirs.example' }, 'b-1')).json.order.order_id;
    await approve(stack, bOrder);
    const r = await stack.op('POST', `/v1/operator/orders/${bOrder}/resolve`, { action: 'happened', step: 'payment', reference: aDone.steps.payment.reference, note: 'a typo' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('That reference is already another order\'s purchase: one purchase is never given to two orders. Nothing changed.');
    expect((await stack.op('GET', `/v1/operator/orders/${bOrder}`)).json.order.steps.payment.state).toBe('unknown');
  });
});

describe('M1: the price is read again before the money is committed, and the charge is checked after', () => {
  it('the price moved before approval: the approval reads it again, quotes again, and the order waits at the new price', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 100_000, monthly_cents: 200_000 });
    const id = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'moved.example' }, 'k')).json.order.order_id;
    stack.sim.catalog.find((c) => c.id === DOMAIN_ITEM)!.price_cents = 1500;
    const first = await stack.op('POST', `/v1/operator/orders/${id}/approve`);
    expect(first.status).toBe(409);
    expect(first.json.error).toBe('Not approved: the provider\'s price changed since the quote ($12.00 USD, now $15.00 USD). The order was quoted again and waits for the operator\'s approval at the new price.');
    const waiting = (await stack.op('GET', `/v1/operator/orders/${id}`)).json.order;
    expect(waiting.quote.total_cents).toBe(1500);
    expect(waiting.steps.approval.state).toBe('waiting');
    expect(stack.sim.received.filter((x) => x.op === 'purchase')).toHaveLength(0);
    const done = await approve(stack, id);
    expect(done.steps.payment.words).toBe('Paid: $15.00 USD.');
    expect(done.needs_person).toBeNull();
  });

  it('the review\'s scenario: quoted $12, $500 at approval, limits $50 per order and $90 a month: refused at the new price, nothing bought', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 5000, monthly_cents: 9000 });
    const id = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'dear.example' }, 'k')).json.order.order_id;
    stack.sim.catalog.find((c) => c.id === DOMAIN_ITEM)!.price_cents = 50_000;
    const r = await stack.op('POST', `/v1/operator/orders/${id}/approve`);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/^Not approved: the provider's price changed since the quote \(\$12\.00 USD, now \$500\.00 USD\)\. Quoted again, it is refused by the customer's limits: the quote \(\$500\.00\) is over the per-order limit \(\$50\.00\)\./);
    const order = (await a.get(`/v1/orders/${id}`)).json.order;
    expect(states(order)).toMatchObject({ approval: 'refused', payment: 'stopped' });
    expect(stack.sim.received.filter((x) => x.op === 'purchase')).toHaveLength(0);
    const c = (await stack.op('GET', '/v1/operator/overview')).json.customers[0];
    expect(c.paid_this_month_cents).toBe(0);
  });

  it('a price that moves after approval, before the purchase is sent, holds the order: nothing is bought', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 100_000, monthly_cents: 200_000 });
    const id = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'later.example' }, 'k')).json.order.order_id;
    stack.sim.faults.push({ op: 'purchase', mode: 'rate_limit', retryAfterS: 1 });
    const held = await approve(stack, id);
    expect(held.steps.payment.state).toBe('not_started');
    stack.sim.catalog.find((c) => c.id === DOMAIN_ITEM)!.price_cents = 2000;
    await until(() => Date.now() > Date.parse(held.steps.payment.retry_at) + 20, 5000, 'Retry-After');
    const after = await reconcile(stack, id);
    expect(after.steps.approval.state).toBe('waiting');
    expect(after.steps.approval.words).toBe('The provider\'s price changed after the approval ($12.00 USD, now $20.00 USD): nothing was bought. Quoted again, it waits for the operator\'s approval at the new price.');
    expect(after.quote.total_cents).toBe(2000);
    expect(stack.sim.done('purchase')).toHaveLength(0);
  });

  it('an approval while the backend waits out a 429 sends nothing; the price is read again right before the purchase', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 100_000, monthly_cents: 200_000 });
    const first = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'first-paused.example' }, 'k1')).json.order.order_id;
    const second = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'second-paused.example' }, 'k2')).json.order.order_id;
    stack.sim.faults.push({ op: 'purchase', mode: 'rate_limit', retryAfterS: 2 });
    await approve(stack, first);
    const limitedAt = stack.sim.received.find((x) => x.result === 'rate_limited')!.at;
    const paused = await approve(stack, second);
    expect(paused.steps.approval.state).toBe('approved');
    expect(paused.steps.approval.words).toBe('Approved by the operator (quote $12.00). The price could not be read again now; it is read again right before the purchase.');
    expect(stack.sim.received.filter((x) => x.at > limitedAt)).toEqual([]);
    stack.sim.catalog.find((c) => c.id === DOMAIN_ITEM)!.price_cents = 1300;
    await until(() => Date.now() > limitedAt + 2100, 5000, 'Retry-After');
    await stack.op('POST', '/v1/operator/reconcile');
    // Read before the purchase: the new price holds both orders for the operator; nothing was bought.
    for (const id of [first, second]) expect((await stack.op('GET', `/v1/operator/orders/${id}`)).json.order.steps.approval.state).toBe('waiting');
    expect(stack.sim.done('purchase')).toHaveLength(0);
  });

  it('a catalog that does not answer right before the purchase: nothing is bought, the log says why, and the next pass buys once', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 100_000, monthly_cents: 200_000 });
    const id = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'unread.example' }, 'k')).json.order.order_id;
    stack.sim.faults.push({ op: 'catalog', mode: 'server_error' }, { op: 'catalog', mode: 'server_error' }); // at approval, then before the purchase
    const held = await approve(stack, id);
    expect(held.steps.payment.state).toBe('not_started');
    expect(stack.sim.received.filter((x) => x.op === 'purchase')).toHaveLength(0);
    expect(readFileSync(join(stack.dataDir, 'backend.log'), 'utf8')).toContain(`order ${id}: the price could not be read again before the purchase (`);
    const paid = await reconcile(stack, id);
    expect(paid.steps.payment.words).toBe('Paid: $12.00 USD.');
    expect(stack.sim.done('purchase')).toHaveLength(1);
  });

  it('a charge above the quote (taxes the catalog does not show) opens an item for a person, who closes it', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 5000, monthly_cents: 9000 });
    stack.sim.charges.push(1452);
    const id = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'taxed.example' }, 'k')).json.order.order_id;
    const order = await approve(stack, id);
    expect(order.steps.payment.state).toBe('paid');
    expect(order.steps.provisioning.state).toBe('completed');
    expect(order.needs_person).toBe('The provider charged $14.52 USD, more than the quote ($12.00 USD): taxes the catalog does not show, or a price change. A person checks the charge.');
    const needs = (await stack.op('GET', '/v1/operator/overview')).json.needs_person;
    expect(needs).toContainEqual(expect.objectContaining({ kind: 'charge_check', order_id: id }));
    const checked = await stack.op('POST', `/v1/operator/orders/${id}/resolve`, { action: 'charge_reviewed', note: 'VAT at 21%, as invoiced' });
    expect(checked.status, checked.text).toBe(200);
    expect(checked.json.order.needs_person).toBeNull();
    expect(checked.json.order.steps.payment.words).toMatch(/A person checked the charge: VAT at 21%, as invoiced\.$/);
    expect((await stack.op('GET', '/v1/operator/overview')).json.needs_person).toEqual([]);
  });

  it('a charge that passes the monthly limit opens an item for a person', async () => {
    stack = await startStack();
    const a = await newCustomer(stack, { per_order_cents: 5000, monthly_cents: 2000 });
    stack.sim.charges.push(1200, 2500);
    await approve(stack, (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'first.example' }, 'k1')).json.order.order_id);
    stack.sim.catalog.find((c) => c.id === DOMAIN_ITEM)!.price_cents = 700;
    const second = await approve(stack, (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'second.example' }, 'k2')).json.order.order_id);
    expect(second.needs_person).toBe('The provider charged $25.00 USD, more than the quote ($7.00 USD): taxes the catalog does not show, or a price change. With it, this month\'s charges ($37.00) pass the monthly limit ($20.00). A person checks the charge.');
  });
});

describe('L4: the retention date holds', () => {
  it('a retained site is not deleted before its retention date, even with its export done and a person\'s approval', async () => {
    let offsetMs = 0;
    stack = await startStack({ retentionDays: 30, clock: () => new Date(Date.now() + offsetMs) });
    const a = await newCustomer(stack);
    const site = await approve(stack, (await a.order({ kind: 'site', item_id: SITE_ITEM }, 's')).json.order.order_id);
    await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'c1', customer_id: a.id, state: 'canceled' });
    const resource = site.resources[0];
    const item = (await stack.op('GET', '/v1/operator/overview')).json.needs_person.find((n: any) => n.kind === 'export');
    await stack.op('POST', `/v1/operator/retention/${item.item_id}/decide`, { decision: 'exported', note: 'archive handed over' });
    const del = (await stack.op('POST', '/v1/operator/deletions', { resource_id: resource.resource_id, reason: 'the customer asked' })).json.deletion;
    const early = await stack.op('POST', `/v1/operator/deletions/${del.deletion_id}/decide`, { decision: 'approve', confirm_resource_id: resource.resource_id, note: 'ok' });
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/^Not approved: site .+ is retained until .+ \(Timmy Pro was cancelled\), and nothing of a cancelled customer's is deleted before then\. Nothing was deleted\.$/);
    expect(stack.sim.received.filter((x) => x.op === 'delete_site')).toHaveLength(0);
    offsetMs = 31 * 86_400_000;
    const later = await stack.op('POST', `/v1/operator/deletions/${del.deletion_id}/decide`, { decision: 'approve', confirm_resource_id: resource.resource_id, note: 'after the retention date' });
    expect(later.status, later.text).toBe(200);
    expect(later.json.deletion.step.state).toBe('completed');
  });
});

describe('L3: two backends taking over a stale lock at the same moment', () => {
  it('exactly one runs; the other is refused (with both held between finding the lock stale and taking it)', async () => {
    const credential = agencyCredential();
    const sim = new SimulatedProvider({ credential });
    await sim.start();
    try {
      for (let round = 0; round < 3; round += 1) {
        const dataDir = tempDir('timmy-cloud-lockrace-');
        dirs.push(dataDir);
        // A lock left by a process that is gone (it was killed).
        const gone = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
        const pid = gone.pid!;
        gone.kill('SIGKILL');
        await new Promise((r) => gone.once('exit', r));
        writeFileSync(join(dataDir, 'backend.lock'), `${pid}\n`, { mode: 0o600 });
        const env = { TIMMY_CLOUD_TEST_LOCK_PAUSE_MS: '600' };
        const operatorToken = newToken();
        const [one, two] = await Promise.all([
          spawnBackend({ dataDir, providerUrl: sim.url, credential, operatorToken, env }),
          spawnBackend({ dataDir, providerUrl: sim.url, credential, operatorToken, env }),
        ]);
        const running = [one, two].filter((b) => b.listening);
        const refused = [one, two].filter((b) => !b.listening);
        for (const b of running) { b.child.kill('SIGTERM'); await b.exited; }
        expect(running, `round ${round}: ${one.stderr()} | ${two.stderr()}`).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect((await refused[0].exited).code).toBe(2);
        expect(refused[0].stderr()).toContain('Another backend is running on this data folder');
      }
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('a lock left naming the starting process\'s own pid (a restart that got the same pid, as in a container) is taken over', async () => {
    stack = await startStack();
    await stack.stopBackend();
    const lockNames = (): string[] => readdirSync(stack!.dataDir).filter((n) => n.startsWith('backend.lock')).sort();
    expect(lockNames()).toEqual(['backend.lock.1']);
    expect(readFileSync(join(stack.dataDir, 'backend.lock.1'), 'utf8')).toBe('released\n');
    // A crash, not a close: the lock still names a pid, and the new backend happens to have that pid.
    writeFileSync(join(stack.dataDir, 'backend.lock.1'), `${process.pid}\n`);
    await stack.restartBackend();
    expect(lockNames()).toEqual(['backend.lock.2']);
    expect(readFileSync(join(stack.dataDir, 'backend.lock.2'), 'utf8')).toBe(`${process.pid}\n`);
  });
});

/** A raw request to the simulated provider, as the operator would buy something by hand outside Timmy. */
async function fetchRaw(sim: SimulatedProvider, method: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const { http } = await import('../services/cloud/test-support.js');
  const r = await http(sim.url, method, path, { token: sim.opts.credential, body });
  return { status: r.status, json: r.json };
}
