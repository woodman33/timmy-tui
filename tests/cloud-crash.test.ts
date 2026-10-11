/**
 * Timmy Cloud's backend, slice 1: crashes and local stops, with REAL backend processes (node --import tsx
 * services/cloud/main.ts) against the SIMULATED provider over real HTTP. No real provider is called.
 *
 * One order (a domain whose payment is first "still processing", then paid; then its registration completed) is run
 * with the backend killed (SIGKILL, from the test hook TIMMY_CLOUD_TEST_CRASH_AT) at each of its event-log writes: before
 * the write, half way through it (a cut line), right after a provider call was written ahead, and right after the
 * provider answered. Each time a new backend starts on the same folder and must find a consistent state, finish the
 * order without buying anything twice, and hold exactly what its log rebuilds to. A local stop during a provider call
 * (SIGKILL and SIGTERM from outside) cancels nothing at the provider, and the order says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agencyCredential, http, spawnBackend, tempDir, type SpawnedBackend } from '../services/cloud/test-support.js';
import { SimulatedProvider } from '../services/cloud/simulated-provider.js';
import { newToken, sha256Hex } from '../services/cloud/redaction.js';
import { parseLog } from '../services/cloud/event-log.js';
import { rebuild } from '../services/cloud/reducer.js';
import { STEP_NAMES } from '../services/cloud/types.js';

const DOMAIN = 'crash-test.example';
const credential = agencyCredential();
const operatorToken = newToken();
let template = '';
let customer = { id: '', token: '' };
const dirs: string[] = [];
const sims: SimulatedProvider[] = [];

beforeAll(async () => {
  // One customer, created by a backend of its own, whose log every run starts from.
  const sim = new SimulatedProvider({ credential });
  await sim.start();
  const dir = tempDir('timmy-cloud-template-');
  const b = await spawnBackend({ dataDir: dir, providerUrl: sim.url, credential, operatorToken });
  expect(b.listening, b.stderr()).toBe(true);
  const r = await http(b.url, 'POST', '/v1/operator/customers', { token: operatorToken, body: { limits: { per_order_cents: 5000, monthly_cents: 50_000 }, subscription: 'active' } });
  expect(r.status).toBe(201);
  customer = { id: r.json.customer_id, token: r.json.token };
  b.child.kill('SIGTERM');
  expect((await b.exited).code).toBe(0);
  template = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  await sim.close();
}, 60_000);

afterAll(async () => {
  for (const s of sims) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function world(): Promise<{ dataDir: string; sim: SimulatedProvider }> {
  const dataDir = tempDir('timmy-cloud-crash-');
  dirs.push(dataDir);
  writeFileSync(join(dataDir, 'events.jsonl'), template, { mode: 0o600 });
  const sim = new SimulatedProvider({ credential });
  sims.push(sim);
  await sim.start();
  sim.payments.push({ processing: 1, then: 'paid' });
  return { dataDir, sim };
}

const start = (w: { dataDir: string; sim: SimulatedProvider }, env: Record<string, string> = {}): Promise<SpawnedBackend & { listening: boolean }> =>
  spawnBackend({ dataDir: w.dataDir, providerUrl: w.sim.url, credential, operatorToken, env });

const op = (url: string, method: string, path: string, body?: unknown) => http(url, method, path, { token: operatorToken, body });

/**
 * Drives the order to its end; every request is safe to repeat. A step waiting for a person is answered as a person
 * would, from what the provider actually holds (the simulated provider's own records).
 */
async function drive(url: string, sim: SimulatedProvider): Promise<any> {
  const created = await http(url, 'POST', '/v1/orders', { token: customer.token, body: { kind: 'domain', item_id: 'sim-domain-com-1y', domain: DOMAIN }, headers: { 'Idempotency-Key': 'crash-order' } });
  expect([200, 201], created.text).toContain(created.status);
  const id = created.json.order.order_id as string;
  for (let round = 0; round < 10; round += 1) {
    let o = (await op(url, 'POST', `/v1/operator/orders/${id}/reconcile`)).json.order;
    if (o.steps.approval.state === 'waiting') o = (await op(url, 'POST', `/v1/operator/orders/${id}/approve`)).json.order;
    if (o.steps.provisioning.state === 'completed' && o.resources.length === 1) return o;
    const unknown = STEP_NAMES.find((n) => o.steps[n].state === 'unknown');
    if (unknown && o.needs_person) {
      const ref = sim.domains.get(DOMAIN)?.purchase_id;
      const body = ref ? { action: 'happened', step: unknown, reference: ref, note: 'the provider holds the order' } : { action: 'did_not_happen', step: unknown, note: 'the provider has no such order' };
      await op(url, 'POST', `/v1/operator/orders/${id}/resolve`, body);
    }
  }
  throw new Error('the order did not finish');
}

/** What every recovered run must show: one purchase, one registration, one resource, and a state its log rebuilds to. */
async function checkRecovered(url: string, dataDir: string, sim: SimulatedProvider, order: any): Promise<void> {
  expect(sim.done('purchase')).toHaveLength(1);
  expect(sim.done('complete_domain_registration')).toHaveLength(1);
  expect(order.steps.payment.state).toBe('paid');
  expect(order.steps.acceptance.state).toBe('accepted');
  expect(order.resources.map((r: any) => `${r.kind}:${r.name}`)).toEqual([`domain:${DOMAIN}`]);
  const { events, unreadable } = parseLog(readFileSync(join(dataDir, 'events.jsonl'), 'utf8'));
  expect(unreadable.length).toBeLessThanOrEqual(1);
  expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  // Every call written ahead is closed exactly once (an answer, or "interrupted" by the next start).
  const closes = new Map<string, number>();
  for (const e of events) if (e.type === 'call.answer' || e.type === 'call.interrupted') closes.set(e.call_id, (closes.get(e.call_id) ?? 0) + 1);
  for (const e of events) if (e.type === 'call.intent') expect(closes.get(e.call.call_id), e.call.call_id).toBe(1);
  // The live state is what the log rebuilds to.
  const rebuilt = rebuild(events).orders[order.order_id];
  const live = (await op(url, 'GET', `/v1/operator/orders/${order.order_id}`)).json.order;
  expect(rebuilt.steps).toEqual(live.steps);
  // The overview counts what the order itself says.
  const overview = (await op(url, 'GET', '/v1/operator/overview')).json;
  for (const n of STEP_NAMES) expect(overview.counts[n][live.steps[n].state], n).toBe(1);
  expect(overview.event_log.unreadable_lines).toHaveLength(unreadable.length);
}

/** Runs the order with the backend killed at `point`; false when the run ended before reaching it. */
async function crashAndRecover(point: string): Promise<boolean> {
  const w = await world();
  const first = await start(w, { TIMMY_CLOUD_TEST_CRASH_AT: point });
  expect(first.listening || (await first.exited).signal === 'SIGKILL', first.stderr()).toBe(true);
  let finished = false;
  if (first.listening) {
    try { await drive(first.url, w.sim); finished = true; } catch { /* the backend died mid-request */ }
  }
  if (finished) { first.child.kill('SIGTERM'); await first.exited; return false; }
  const exit = await first.exited;
  expect(exit.signal, `${point}: ${first.stderr()}`).toBe('SIGKILL');
  const second = await start(w);
  expect(second.listening, `${point}: ${second.stderr()}`).toBe(true);
  try {
    const order = await drive(second.url, w.sim);
    await checkRecovered(second.url, w.dataDir, w.sim, order);
    for (const text of [first.stdout(), first.stderr(), second.stdout(), second.stderr(), readFileSync(join(w.dataDir, 'backend.log'), 'utf8'), readFileSync(join(w.dataDir, 'events.jsonl'), 'utf8')]) {
      expect(text.includes(credential)).toBe(false);
    }
  } finally {
    second.child.kill('SIGTERM');
    await second.exited;
  }
  return true;
}

describe('a crash between any two writes leaves a consistent state, and nothing is bought twice', () => {
  for (const kind of ['log:before-write', 'log:mid-write'] as const) {
    it(`killed at each ${kind}`, async () => {
      let reached = 0;
      for (let n = 1; n <= 20; n += 1) {
        if (!(await crashAndRecover(`${kind}:${n}`))) break;
        reached += 1;
      }
      // The order's run writes about ten events; every one of them was a crash point.
      expect(reached).toBeGreaterThanOrEqual(9);
    }, 240_000);
  }

  it('killed after a provider call was written ahead and before it was sent, and after it was answered and before the answer was written', async () => {
    for (const point of ['call:after-intent:1', 'call:after-intent:2', 'call:after-answer:1', 'call:after-answer:2']) {
      expect(await crashAndRecover(point), point).toBe(true);
    }
  }, 120_000);
});

describe('a local stop during a provider call cancels nothing at the provider, and the order says so', () => {
  for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
    it(`${signal} while the purchase is out`, async () => {
      const w = await world();
      w.sim.payments.length = 0; // paid at once
      w.sim.faults.push({ op: 'purchase', mode: 'delay', delayMs: 3000 });
      const first = await start(w);
      const created = await http(first.url, 'POST', '/v1/orders', { token: customer.token, body: { kind: 'domain', item_id: 'sim-domain-com-1y', domain: DOMAIN }, headers: { 'Idempotency-Key': 'stop-order' } });
      const id = created.json.order.order_id;
      const atProvider = w.sim.nextRequest('purchase');
      const approving = op(first.url, 'POST', `/v1/operator/orders/${id}/approve`).catch((e: Error) => e);
      await atProvider; // the provider has the purchase and is answering slowly
      first.child.kill(signal);
      const exit = await first.exited;
      expect(signal === 'SIGKILL' ? exit.signal : exit.code).toBe(signal === 'SIGKILL' ? 'SIGKILL' : 0);
      expect(await approving).toBeInstanceOf(Error); // its answer never came
      expect(w.sim.done('purchase')).toHaveLength(1); // the stop cancelled nothing at the provider

      const second = await start(w);
      try {
        const after = (await http(second.url, 'GET', `/v1/orders/${id}`, { token: customer.token })).json.order;
        expect(after.steps.payment.state).toBe('unknown');
        expect(after.steps.payment.words).toBe('Unknown: the backend stopped while this call was out (a crash or a local stop). Stopping the backend cancels nothing at the provider: it may have acted. Nothing is sent again until reconcile reads the provider.');
        expect(after.cost.charged_cents).toBeNull();
        const settled = (await op(second.url, 'POST', `/v1/operator/orders/${id}/reconcile`)).json.order;
        expect(settled.steps.payment.state).toBe('paid');
        expect(settled.steps.provisioning.state).toBe('completed');
        expect(w.sim.received.filter((x) => x.op === 'purchase')).toHaveLength(1);
      } finally {
        second.child.kill('SIGTERM');
        await second.exited;
      }
    }, 60_000);
  }

  it('one backend at a time: a second one on the same data folder is refused', async () => {
    const w = await world();
    const first = await start(w);
    const second = await start(w);
    try {
      expect(second.listening).toBe(false);
      expect((await second.exited).code).toBe(2);
      expect(second.stderr()).toBe('Another backend is running on this data folder (its lock names a live process): one backend at a time writes the event log. Nothing was started.\n');
    } finally {
      first.child.kill('SIGTERM');
      await first.exited;
    }
    // A lock left by a killed backend does not keep the next one out.
    const killed = await start(w);
    killed.child.kill('SIGKILL');
    await killed.exited;
    const next = await start(w);
    expect(next.listening, next.stderr()).toBe(true);
    next.child.kill('SIGTERM');
    await next.exited;
    expect(sha256Hex(operatorToken)).toHaveLength(64);
  }, 60_000);
});
