/**
 * Timmy Cloud's backend, slice 1: the reducer, the event log, the SIMULATED provider's modelled behaviours, the provider
 * interface, redaction and the agency credential. Real files in temporary folders, real HTTP on 127.0.0.1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, newCustomer, startStack, tempDir, type Stack } from '../services/cloud/test-support.js';
import { cloneState, emptyState, rebuild, reduce } from '../services/cloud/reducer.js';
import { CUT_MARK, EventLog, parseLog } from '../services/cloud/event-log.js';
import { AGENCY_TOKEN_ENV, CredentialError, REDACTED, Redactor, loadAgencyCredential, newToken, sha256Hex, tokenMatches } from '../services/cloud/redaction.js';
import { IRREVERSIBLE_OPS, OPERATIONS_THAT_DO_NOT_EXIST, PROVIDER_CALL_OPS } from '../services/cloud/provider.js';
import { SimulatedProvider } from '../services/cloud/simulated-provider.js';
import { Failpoints } from '../services/cloud/failpoints.js';
import type { CloudEvent, CloudState } from '../services/cloud/types.js';

let stack: Stack | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await stack?.close(); stack = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real log: a domain bought (paid after "processing"), a site set up on it, a billing notice. */
async function realEvents(): Promise<CloudEvent[]> {
  stack = await startStack();
  const a = await newCustomer(stack);
  stack.sim.payments.push({ processing: 2, then: 'paid' });
  const d = await a.order({ kind: 'domain', item_id: 'sim-domain-com-1y', domain: 'model.example' }, 'k1');
  await stack.op('POST', `/v1/operator/orders/${d.json.order.order_id}/approve`);
  await stack.op('POST', `/v1/operator/orders/${d.json.order.order_id}/reconcile`);
  const s = await a.order({ kind: 'site', item_id: 'sim-agency-site', domain: 'model.example' }, 'k2');
  await stack.op('POST', `/v1/operator/orders/${s.json.order.order_id}/approve`);
  await stack.op('POST', '/v1/operator/billing-notices', { notice_id: 'b-1', customer_id: a.id, state: 'past_due' });
  await stack.engine.idle();
  return parseLog(readFileSync(join(stack.dataDir, 'events.jsonl'), 'utf8')).events;
}

const plain = (s: CloudState): unknown => JSON.parse(JSON.stringify({ ...s, seen: [...s.seen].sort() }));
const withoutCounters = (s: CloudState): unknown => { const p = plain(s) as Record<string, unknown>; delete p.duplicates; return p; };

describe('the reducer is pure, and a duplicate event changes nothing', () => {
  it('the same events always rebuild the same state; reduce never changes its input', async () => {
    const events = await realEvents();
    expect(events.length).toBeGreaterThan(15);
    expect(plain(rebuild(events))).toEqual(plain(rebuild(events)));
    const before = rebuild(events.slice(0, 10));
    const snapshot = JSON.stringify(plain(before));
    const after = reduce(before, events[10]);
    expect(JSON.stringify(plain(before))).toBe(snapshot);
    expect(after).not.toBe(before);
    expect(plain(after)).toEqual(plain(rebuild(events.slice(0, 11))));
    expect(plain(cloneState(before))).toEqual(plain(before));
  });

  it('every event delivered twice (a notice, a line written twice) is applied once', async () => {
    const events = await realEvents();
    const once = rebuild(events);
    const twice = rebuild(events.flatMap((e) => [e, structuredClone(e)]));
    expect(withoutCounters(twice)).toEqual(withoutCounters(once));
    expect(twice.duplicates).toBe(events.length);
    const notice = events.find((e) => e.type === 'billing.notice')!;
    expect(withoutCounters(reduce(once, notice))).toEqual(withoutCounters(once));
    expect(emptyState().applied).toBe(0);
  });
});

describe('the event log', () => {
  it('a cut last line is reported and never applied, not at the next start and not at the one after', () => {
    const dir = tempDir('timmy-cloud-log-');
    dirs.push(dir);
    const e = (id: string): CloudEvent => ({ v: 1, id, at: '2026-10-11T00:00:00.000Z', type: 'provider.notice', notice_id: `provider:${id}`, reference: 'r' });
    const whole = [e('a'), e('b'), e('c')].map((x) => JSON.stringify(x)).join('\n');
    // A complete event short of only its newline: a write cut by a crash just before the end of the line.
    writeFileSync(join(dir, 'events.jsonl'), `${whole}\n${JSON.stringify(e('d'))}`, { mode: 0o600 });
    const first = EventLog.open(dir);
    expect(first.contents.events.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(first.contents.unreadable).toEqual([{ line: 4, bytes: JSON.stringify(e('d')).length, why: expect.stringMatching(/^a last line with no end of line: a write cut short by a crash/) }]);
    first.log.append(e('e'));
    first.log.close();
    const text = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(text.startsWith(`${whole}\n${JSON.stringify(e('d'))}${CUT_MARK}\n`)).toBe(true); // the cut bytes kept as they were
    const second = EventLog.open(dir);
    expect(second.contents.events.map((x) => x.id)).toEqual(['a', 'b', 'c', 'e']);
    expect(second.contents.unreadable).toHaveLength(1);
    expect(second.contents.unreadable[0].why).toMatch(/marked when the log was next opened/);
    second.log.close();
  });

  it('a line that is not an event is kept, reported and skipped; the others are applied', () => {
    const parsed = parseLog(`{"v":1,"id":"x","at":"t","type":"provider.notice","notice_id":"provider:x","reference":"r"}\nnot json\n{"v":2,"id":"y"}\n`);
    expect(parsed.events.map((x) => x.id)).toEqual(['x']);
    expect(parsed.unreadable.map((u) => [u.line, u.why.split(':')[0]])).toEqual([[2, 'not JSON'], [3, 'JSON, but not an event this backend knows']]);
  });

  it('the log file and the data folder are private to their owner', async () => {
    stack = await startStack();
    await newCustomer(stack);
    const { statSync } = await import('node:fs');
    expect(statSync(join(stack.dataDir, 'events.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(join(stack.dataDir, 'backend.log')).mode & 0o777).toBe(0o600);
  });
});

describe('the simulated provider models the documented behaviour (and is labelled simulated)', () => {
  const raw = (s: SimulatedProvider, method: string, path: string, body?: unknown, credential = s.opts.credential) => http(s.url, method, path, { token: credential, body });

  it('a purchase names no payment method (the account\'s default is used); 202 means the payment is still processing, and a domain bought so is not registered until its setup is completed', async () => {
    stack = await startStack();
    const s = stack.sim;
    s.payments.push({ processing: 1, then: 'paid' });
    const p = await raw(s, 'POST', '/sim/v1/purchases', { items: [{ item_id: 'sim-domain-com-1y', quantity: 1 }], domain: 'later.example' });
    expect(p.status).toBe(202);
    expect(p.json).toMatchObject({ status: 'payment_initiated', registered: false });
    expect((await raw(s, 'GET', '/sim/v1/domains/later.example')).json.state).toBe('awaiting_payment');
    expect((await raw(s, 'GET', `/sim/v1/purchases/${p.json.id}`)).json.status).toBe('completed');
    expect((await raw(s, 'GET', '/sim/v1/domains/later.example')).json.state).toBe('awaiting_setup');
    expect((await raw(s, 'POST', '/sim/v1/domains/later.example/setup', {})).status).toBe(202);
    expect((await raw(s, 'GET', '/sim/v1/domains/later.example')).json.state).toBe('registered');
    // Through the backend, the purchase request carries items and no payment method.
    const a = await newCustomer(stack);
    const o = await a.order({ kind: 'vps', item_id: 'sim-vps-small-1m' }, 'k');
    await stack.op('POST', `/v1/operator/orders/${o.json.order.order_id}/approve`);
    const sent = s.received.filter((x) => x.op === 'purchase').pop()!;
    expect(Object.keys(sent.body ?? {}).sort()).toEqual(['client_reference', 'items']);
  });

  it('a site setup answers with a setup id, read until it completes with a site id', async () => {
    stack = await startStack({ sim: { settleAfterReads: 2 } });
    const s = stack.sim;
    const setup = await raw(s, 'POST', '/sim/v1/sites/setups', {});
    expect(setup.status).toBe(202);
    expect(setup.json).toMatchObject({ status: 'running', website_uid: null });
    expect((await raw(s, 'GET', `/sim/v1/sites/setups/${setup.json.setup_uuid}`)).json.status).toBe('running');
    const done = await raw(s, 'GET', `/sim/v1/sites/setups/${setup.json.setup_uuid}`);
    expect(done.json).toMatchObject({ status: 'completed', website_uid: expect.stringMatching(/^site-/) });
  });

  it('deploying an archive overwrites the site\'s contents with no way back; deleting a site is immediate', async () => {
    stack = await startStack();
    const s = stack.sim;
    const setup = await raw(s, 'POST', '/sim/v1/sites/setups', {});
    const site = (await raw(s, 'GET', `/sim/v1/sites/setups/${setup.json.setup_uuid}`)).json.website_uid;
    const a = sha256Hex('archive one');
    const deployed = await raw(s, 'POST', `/sim/v1/sites/${site}/deploy`, { archive_sha256: a });
    expect(deployed.json.message).toMatch(/previous contents were overwritten by the archive; this cannot be undone/);
    expect(s.sites.get(site)!.contents).toBe(a);
    for (const path of [`/sim/v1/sites/${site}/undeploy`, `/sim/v1/sites/${site}/restore`, `/sim/v1/sites/${site}/rollback`]) {
      expect((await raw(s, 'POST', path, {})).json).toEqual({ error: 'No such operation.' });
    }
    expect((await raw(s, 'DELETE', `/sim/v1/sites/${site}`)).status).toBe(202);
    expect((await raw(s, 'GET', `/sim/v1/sites/${site}`)).json.state).not.toBe('active');
    await raw(s, 'GET', `/sim/v1/sites/${site}`);
    expect((await raw(s, 'GET', `/sim/v1/sites/${site}`)).json.state).toBe('deleted');
  });

  it('no operation cancels a purchase or a setup, shares access or makes a sub-account; none is invented', async () => {
    stack = await startStack();
    const s = stack.sim;
    const p = await raw(s, 'POST', '/sim/v1/purchases', { items: [{ item_id: 'sim-vps-small-1m' }] });
    for (const [method, path] of [['POST', `/sim/v1/purchases/${p.json.id}/cancel`], ['DELETE', `/sim/v1/purchases/${p.json.id}`], ['POST', '/sim/v1/sites/setups/x/cancel'], ['POST', '/sim/v1/account/share'], ['POST', '/sim/v1/access'], ['POST', '/sim/v1/subaccounts'], ['POST', '/sim/v1/sub-accounts']] as const) {
      const r = await raw(s, method, path, {});
      expect(r.status, path).toBe(404);
      expect(r.json).toEqual({ error: 'No such operation.' });
    }
    expect(PROVIDER_CALL_OPS.filter((op) => /cancel|share|sub.?account|access/i.test(op))).toEqual([]);
    expect(OPERATIONS_THAT_DO_NOT_EXIST).toHaveLength(4);
    expect([...IRREVERSIBLE_OPS].sort()).toEqual(['delete_site', 'deploy_archive']);
    expect(stack.engine.overview().provider).toMatchObject({ name: 'simulated provider', simulated: true });
  });

  it('its API has a shared rate limit: 429 with Retry-After; a certificate again within a minute is 429 too, and three per seven days', async () => {
    stack = await startStack({ sim: { rateLimit: { max: 2, windowMs: 60_000 } } });
    const s = stack.sim;
    expect((await raw(s, 'GET', '/sim/v1/catalog')).status).toBe(200);
    expect((await raw(s, 'GET', '/sim/v1/catalog')).status).toBe(200);
    const limited = await raw(s, 'GET', '/sim/v1/catalog');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const c = new SimulatedProvider({ credential: s.opts.credential, certificateCooldownMs: 60_000 });
    await c.start();
    try {
      const setup = await raw(c, 'POST', '/sim/v1/sites/setups', {});
      const site = (await raw(c, 'GET', `/sim/v1/sites/setups/${setup.json.setup_uuid}`)).json.website_uid;
      await raw(c, 'POST', `/sim/v1/sites/${site}/domains`, { domain: 'cert.example' });
      c.certificateOutcomes.push('fail');
      expect((await raw(c, 'POST', `/sim/v1/sites/${site}/domains/cert.example/certificate`, {})).status).toBe(202);
      const again = await raw(c, 'POST', `/sim/v1/sites/${site}/domains/cert.example/certificate`, {});
      expect(again.status).toBe(429);
      expect(again.headers['retry-after']).toBe('60');
    } finally { await c.close(); }
  });

  it('it refuses a wrong credential and records only request bodies, never the Authorization header', async () => {
    stack = await startStack();
    const s = stack.sim;
    expect((await raw(s, 'GET', '/sim/v1/catalog', undefined, 'wrong-credential-0000000000')).status).toBe(401);
    expect(new Redactor([s.opts.credential]).leaks(JSON.stringify(s.received))).toBe(false);
  });
});

describe('redaction and credentials', () => {
  it('every form of the credential is replaced', () => {
    const secret = `agency-${'a1b2c3'.repeat(6)}`;
    const r = new Redactor([secret]);
    const forms = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), Buffer.from(`Bearer ${secret}`).toString('base64')];
    for (const f of forms) expect(r.redact(`before ${f} after`)).toBe(`before ${REDACTED} after`);
    expect(r.redactDeep({ a: [`x${secret}y`], b: { c: secret } })).toEqual({ a: [`x${REDACTED}y`], b: { c: REDACTED } });
    expect(r.leaks(`...${secret}...`)).toBe(true);
  });

  it('the credential comes from the environment (then removed from it) or a 0600 file; a looser file, a link, both or none are refused', () => {
    const dir = tempDir('timmy-cloud-cred-');
    dirs.push(dir);
    const secret = `agency-${'f00d'.repeat(8)}`;
    const env: NodeJS.ProcessEnv = { [AGENCY_TOKEN_ENV]: secret };
    expect(loadAgencyCredential({ env })).toEqual({ value: secret, source: 'environment' });
    expect(env[AGENCY_TOKEN_ENV]).toBeUndefined();
    const file = join(dir, 'agency-token');
    writeFileSync(file, `${secret}\n`);
    for (const [mode, ok] of [[0o600, true], [0o400, true], [0o640, false], [0o644, false], [0o604, false]] as const) {
      chmodSync(file, mode);
      if (ok) expect(loadAgencyCredential({ file, env: {} }).value).toBe(secret);
      else expect(() => loadAgencyCredential({ file, env: {} })).toThrow(`The secret file's permissions are ${mode.toString(8).padStart(4, '0')}: it must be readable by its owner only (chmod 600). Nothing was started.`);
    }
    chmodSync(file, 0o600);
    const link = join(dir, 'link');
    symlinkSync(file, link);
    expect(() => loadAgencyCredential({ file: link, env: {} })).toThrow(/symbolic link/);
    expect(() => loadAgencyCredential({ file, env: { [AGENCY_TOKEN_ENV]: secret } })).toThrow(/name one source/);
    expect(() => loadAgencyCredential({ env: {} })).toThrow(CredentialError);
    expect(() => loadAgencyCredential({ env: { [AGENCY_TOKEN_ENV]: 'short' } })).toThrow(/not usable/);
    mkdirSync(join(dir, 'folder'));
    expect(() => loadAgencyCredential({ file: join(dir, 'folder'), env: {} })).toThrow(/not a regular file/);
    for (const fn of [() => loadAgencyCredential({ file: join(dir, 'nope'), env: {} })]) {
      try { fn(); } catch (e) { expect((e as Error).message).not.toContain(dir); }
    }
  });

  it('tokens are compared by their sha256 only', () => {
    const t = newToken();
    expect(t).toMatch(/^tc_[A-Za-z0-9_-]{43}$/);
    expect(tokenMatches(t, sha256Hex(t))).toBe(true);
    expect(tokenMatches(`${t}x`, sha256Hex(t))).toBe(false);
    expect(tokenMatches(t, 'not-a-hash')).toBe(false);
  });

  it('the crash hook is off unless named, and refuses a malformed value', () => {
    expect(Failpoints.fromEnv({}).armed).toBe(false);
    expect(Failpoints.fromEnv({ TIMMY_CLOUD_TEST_CRASH_AT: 'log:before-write:3' }).armed).toBe(true);
    expect(() => Failpoints.fromEnv({ TIMMY_CLOUD_TEST_CRASH_AT: 'anywhere' })).toThrow(/must be <point>:<n>/);
  });
});
