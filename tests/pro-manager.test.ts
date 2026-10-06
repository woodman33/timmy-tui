import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpProService, type FetchLike } from '../src/pro/client.js';
import { accessMessage, featureAccess, nextStep, type Entitlement, type InactiveReason } from '../src/pro/entitlement.js';
import { generateLicenseKeyPair, importSigningKey, importVerifyKey, signLicenseToken } from '../src/pro/license.js';
import { LicenseInputError, LicenseManager, ProUnavailableError, PurchaseRefusedError } from '../src/pro/manager.js';
import { PRO_FEATURES } from '../src/pro/plan.js';
import { LicenseStorageError, type LicenseVault } from '../src/pro/ports.js';
import { FileLicenseVault } from '../src/pro/vault.js';
import { DAY, proSub, proWorld, type ProWorld } from './helpers/pro-harness.js';

let root: string;
let world: ProWorld;
let vault: FileLicenseVault;
let requests: string[];
let faults: Map<string, () => Promise<Response>>;
let publicKey: CryptoKey;

/** Routes through the real handler, recording each path; a path in `faults` answers with its fault instead. */
const recordingFetch = (): FetchLike => async (input, init) => {
  const path = new URL(input).pathname;
  requests.push(path);
  const fault = faults.get(path);
  return fault ? fault() : world.fetch(input, init);
};
const offline = async (): Promise<Response> => { throw new TypeError('fetch failed'); };
const proxyPage = async () => new Response('<html>Access denied</html>', { status: 403, headers: { 'content-type': 'text/html' } });

function manager(over: Partial<ConstructorParameters<typeof LicenseManager>[0]> = {}) {
  return new LicenseManager({
    vault,
    service: new HttpProService(world.origin, recordingFetch()),
    publicKey,
    now: world.now,
    ...over,
  });
}

/** Buys Pro through the service and returns the issued key without saving it anywhere. */
async function purchasedKey(status = 'active'): Promise<{ key: string; subscriptionId: string }> {
  const service = new HttpProService(world.origin, world.fetch);
  const { sessionId } = await service.startCheckout();
  const sub = world.stripe.pay(sessionId, proSub(`sub_${sessionId.slice(-8)}`, status));
  const claim = await service.claim(sessionId);
  if (claim.state !== 'ready') throw new Error('expected a ready claim');
  return { key: claim.key, subscriptionId: sub.id };
}

async function cancel(subscriptionId: string) {
  world.stripe.subs.set(subscriptionId, { ...world.stripe.subs.get(subscriptionId)!, status: 'canceled' });
  expect((await world.webhook({ id: `evt_cancel_${subscriptionId}`, type: 'customer.subscription.deleted', data: { object: { id: subscriptionId } } })).status).toBe(200);
}

function corruptLicenseFile() {
  mkdirSync(dirname(vault.location), { recursive: true });
  writeFileSync(vault.location, 'not json');
}

/**
 * A service whose first /license/activate waits until `release` is called (with an error to fail
 * it). `arrived` resolves once that request is in flight; with 'answered', the real service has
 * already answered it by then, so the token in hand predates anything done meanwhile.
 */
function holdFirstActivation(when: 'sent' | 'answered') {
  let release!: (failure?: Error) => void;
  const gate = new Promise<Error | undefined>((resolve) => { release = resolve; });
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  let first = true;
  const fetch: FetchLike = async (input, init) => {
    if (!first || new URL(input).pathname !== '/license/activate') return world.fetch(input, init);
    first = false;
    const early = when === 'answered' ? await world.fetch(input, init) : null;
    reached();
    const failure = await gate;
    if (failure) throw failure;
    return early ?? world.fetch(input, init);
  };
  return { service: new HttpProService(world.origin, fetch), arrived, release };
}

const notFound = async () => new Response(JSON.stringify({ error: 'not found', code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });

const checkoutsCreated = () => world.stripe.calls.filter((call) => call.startsWith('create:')).length;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'timmy-pro-manager-'));
  world = await proWorld();
  vault = new FileLicenseVault(join(root, 'pro', 'license.json'));
  requests = [];
  faults = new Map();
  publicKey = await importVerifyKey(world.publicKey);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('activation', () => {
  it('activates a key and verifies the token offline', async () => {
    const { key } = await purchasedKey();
    const entitlement = await manager().activate(key);
    expect(entitlement).toMatchObject({ active: true, features: [...PRO_FEATURES], refreshDue: false, tokenExpiresAt: world.now() + 7 * DAY });
    expect((await manager({ service: null }).currentEntitlement()).active).toBe(true);
    expect(vault.read()?.key).toBe(key);
  });

  it('normalizes pasted keys and rejects malformed ones without a request', async () => {
    const { key } = await purchasedKey();
    expect((await manager().activate(`  ${key.toLowerCase().replace(/-/g, ' ')}\n`)).active).toBe(true);
    expect(vault.read()?.key).toBe(key);

    requests = [];
    await expect(manager().activate('tpro_nope')).rejects.toBeInstanceOf(LicenseInputError);
    expect(requests).toEqual([]);
  });

  it('renewing needs a stored key, and activating needs a service', async () => {
    await expect(manager().renew()).rejects.toBeInstanceOf(LicenseInputError);
    const { key } = await purchasedKey();
    await expect(manager({ service: null }).activate(key)).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it('drops a token that fails verification and remembers why', async () => {
    const { key } = await purchasedKey();
    const otherKey = await importVerifyKey((await generateLicenseKeyPair()).publicRaw);
    expect(await manager({ publicKey: otherKey }).activate(key)).toEqual({ active: false, reason: 'invalid_token', detail: 'signature does not verify' });
    expect(vault.read()).toMatchObject({ key, token: null, problem: { reason: 'invalid_token' } });
    expect(await manager({ publicKey: otherKey, service: null }).currentEntitlement()).toMatchObject({ reason: 'invalid_token' });
  });

  it('says to check the clock when tokens seem to come from the future', async () => {
    const { key } = await purchasedKey();
    const slowClock = () => world.now() - 600;
    expect(await manager({ now: slowClock }).activate(key)).toMatchObject({ active: false, reason: 'clock_skew' });
    expect(vault.read()).toMatchObject({ key, token: null, problem: { reason: 'clock_skew' } });
    expect(nextStep(await manager({ now: slowClock, service: null }).currentEntitlement())).toBe('check_clock');
  });

  it('keeps key and token when no public key is configured', async () => {
    const { key } = await purchasedKey();
    expect(await manager({ publicKey: null }).activate(key)).toMatchObject({ active: false, reason: 'no_public_key' });
    expect(vault.read()?.token?.split('.')[0]).toBe('tpro1');
  });

  it('reports a lapsed token as token_expired', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    world.advance(8 * DAY);
    expect(await manager({ service: null }).currentEntitlement()).toEqual({ active: false, reason: 'token_expired', detail: 'token expired' });
  });

  it('ignores feature ids this build does not know', async () => {
    const signing = await importSigningKey(world.deps.env.LICENSE_SIGNING_KEY!);
    const now = world.now();
    const token = await signLicenseToken({ v: 1, plan: 'pro', features: ['cloud_logs', 'teleport' as never], status: 'active', sub: 'abc', iat: now, exp: now + DAY }, signing);
    vault.write({ v: 1, key: 'tpro_ABCDEFGH-JKMNPQRS-TVWXYZ01-23456789', token, savedAt: now });
    expect(await manager({ service: null }).currentEntitlement()).toMatchObject({ active: true, features: ['cloud_logs'] });
  });

  it('reports a damaged license file as license_unreadable, never as no license', async () => {
    corruptLicenseFile();
    const entitlement = await manager().currentEntitlement();
    expect(entitlement).toMatchObject({ active: false, reason: 'license_unreadable' });
    expect(nextStep(entitlement)).toBe('fix_license_file');
    expect(await manager().refreshIfDue()).toMatchObject({ reason: 'license_unreadable' });
    expect(manager().storedKey()).toBeNull();
  });

  it('says the license file cannot be read when renewing or rotating', async () => {
    corruptLicenseFile();
    await expect(manager().renew()).rejects.toBeInstanceOf(LicenseStorageError);
    await expect(manager().rotate()).rejects.toBeInstanceOf(LicenseStorageError);
  });

  it('says to check the clock when this computer runs ahead of the service', async () => {
    const { key } = await purchasedKey();
    const fastClock = () => world.now() + 10 * DAY;
    expect(await manager({ now: fastClock }).activate(key)).toMatchObject({ active: false, reason: 'clock_skew' });
    expect(vault.read()).toMatchObject({ key, token: null, problem: { reason: 'clock_skew' } });
    requests = [];
    await manager({ now: fastClock }).refreshIfDue();
    expect(requests).toEqual([]);
  });
});

describe('refusals are remembered whichever command hears them', () => {
  it('records a cancelled subscription heard by renew', async () => {
    const { key, subscriptionId } = await purchasedKey();
    await manager().activate(key);
    await cancel(subscriptionId);
    await expect(manager().renew()).rejects.toMatchObject({ code: 'subscription_inactive' });
    expect(vault.read()).toMatchObject({ key, token: null, problem: { reason: 'subscription_inactive', subscriptionStatus: 'canceled' } });
    expect(await manager({ service: null }).currentEntitlement()).toMatchObject({ active: false, reason: 'subscription_inactive', subscriptionStatus: 'canceled' });
  });

  it('records a key that rotate learns was replaced elsewhere', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    await new HttpProService(world.origin, world.fetch).rotate(key);
    await expect(manager().rotate()).rejects.toMatchObject({ code: 'unknown_key' });
    expect(vault.read()).toMatchObject({ key, token: null, problem: { reason: 'key_revoked' } });
  });

  it('never replaces the stored key with a different key the service refused', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const token = vault.read()?.token;
    await expect(manager().activate('tpro_00000000-00000000-00000000-00000000')).rejects.toMatchObject({ code: 'unknown_key' });
    expect(vault.read()).toMatchObject({ key, token });
  });
});

describe('refresh', () => {
  it('refreshes only inside the window', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const before = vault.read()?.token;

    requests = [];
    expect((await manager().refreshIfDue()).active).toBe(true);
    expect(requests).toEqual([]);

    world.advance(6 * DAY);
    expect(await manager().refreshIfDue()).toMatchObject({ active: true, refreshDue: false });
    expect(requests).toEqual(['/license/activate']);
    expect(vault.read()?.token).not.toBe(before);
  });

  it('keeps a valid token when the refresh fails offline, and backs off', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const token = vault.read()?.token;
    world.advance(6 * DAY);
    faults.set('/license/activate', offline);

    requests = [];
    expect((await manager().refreshIfDue()).active).toBe(true);
    expect(vault.read()?.token).toBe(token);
    await manager().refreshIfDue();
    expect(requests).toEqual(['/license/activate']);
    world.advance(301);
    await manager().refreshIfDue();
    expect(requests).toEqual(['/license/activate', '/license/activate']);
  });

  it('shares one refresh between concurrent callers', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    world.advance(6 * DAY);
    const shared = manager();
    requests = [];
    const [first, second] = await Promise.all([shared.refreshIfDue(), shared.refreshIfDue()]);
    expect(first.active && second.active).toBe(true);
    expect(requests).toEqual(['/license/activate']);
  });

  it('never mistakes a proxy page for a cancelled subscription', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const token = vault.read()?.token;
    world.advance(6 * DAY);
    faults.set('/license/activate', proxyPage);
    expect((await manager().refreshIfDue()).active).toBe(true);
    expect(vault.read()).toMatchObject({ token });
    expect(vault.read()?.problem).toBeUndefined();
  });

  it('remembers a refusal, reports it offline, and asks again at most hourly', async () => {
    const { key, subscriptionId } = await purchasedKey();
    await manager().activate(key);
    await cancel(subscriptionId);
    world.advance(6 * DAY);

    requests = [];
    expect(await manager().refreshIfDue()).toMatchObject({ active: false, reason: 'subscription_inactive' });
    expect(vault.read()).toMatchObject({ key, token: null, problem: { reason: 'subscription_inactive', at: world.now() } });
    expect(await manager({ service: null }).currentEntitlement()).toMatchObject({ active: false, reason: 'subscription_inactive' });

    expect(await manager().refreshIfDue()).toMatchObject({ reason: 'subscription_inactive' });
    expect(requests).toEqual(['/license/activate']);
    world.advance(3601);
    await manager().refreshIfDue();
    expect(requests).toEqual(['/license/activate', '/license/activate']);
  });

  it('reports a key replaced from another machine as key_revoked', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    await new HttpProService(world.origin, world.fetch).rotate(key);
    world.advance(6 * DAY);
    expect(await manager().refreshIfDue()).toMatchObject({ active: false, reason: 'key_revoked' });
    expect(vault.read()).toMatchObject({ key, token: null, problem: { reason: 'key_revoked' } });
  });

  it('asks again at most hourly when a renewal comes back short-lived', async () => {
    const { key } = await purchasedKey('past_due');
    await manager().activate(key);
    world.advance(12.5 * DAY);
    requests = [];
    expect(await manager().refreshIfDue()).toMatchObject({ active: true, refreshDue: true });
    expect(await manager().refreshIfDue()).toMatchObject({ active: true });
    expect(requests).toEqual(['/license/activate']);
    world.advance(3601);
    await manager().refreshIfDue();
    expect(requests).toEqual(['/license/activate', '/license/activate']);
  });

  it('asks again at most hourly after a refusal that is not about the key', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    world.advance(8 * DAY);
    faults.set('/license/activate', notFound);
    requests = [];
    await manager().refreshIfDue();
    await manager().refreshIfDue();
    expect(requests).toEqual(['/license/activate']);
    world.advance(3601);
    await manager().refreshIfDue();
    expect(requests).toEqual(['/license/activate', '/license/activate']);
  });

  it('keeps its pacing in memory when the license file cannot be written', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    world.advance(6 * DAY);
    const readOnly: LicenseVault = { read: () => vault.read(), write: () => { throw new LicenseStorageError('cannot write: EROFS', 'write'); }, clear: () => vault.clear() };
    const stuck = manager({ vault: readOnly });
    requests = [];
    expect((await stuck.refreshIfDue()).active).toBe(true);
    expect((await stuck.refreshIfDue()).active).toBe(true);
    expect(requests).toEqual(['/license/activate']);
  });

  it('keeps what it has when the license file cannot be written', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    world.advance(6 * DAY);
    const readOnly: LicenseVault = { read: () => vault.read(), write: () => { throw new LicenseStorageError('cannot write: EROFS', 'write'); }, clear: () => vault.clear() };
    expect((await manager({ vault: readOnly }).refreshIfDue()).active).toBe(true);
  });
});

describe('bookkeeping never overwrites a newer license', () => {
  async function dueLicense(): Promise<void> {
    const { key } = await purchasedKey();
    await manager().activate(key);
    world.advance(6 * DAY);
  }

  it('keeps a key rotated while a refresh was failing', async () => {
    await dueLicense();
    const held = holdFirstActivation('sent');
    const refreshing = manager({ service: held.service }).refreshIfDue();
    await held.arrived;
    const rotated = await manager().rotate();
    held.release(new TypeError('fetch failed'));
    await refreshing;
    expect(vault.read()).toMatchObject({ key: rotated.key });
    expect(vault.read()?.token).toBeTruthy();
  });

  it('keeps a key rotated after the service answered a refresh for the old one', async () => {
    await dueLicense();
    const held = holdFirstActivation('answered');
    const refreshing = manager({ service: held.service }).refreshIfDue();
    await held.arrived;
    const rotated = await manager().rotate();
    held.release();
    expect(await refreshing).toMatchObject({ active: true });
    expect(vault.read()).toMatchObject({ key: rotated.key });
  });

  it('does not bring back a license removed while a refresh was failing', async () => {
    await dueLicense();
    const held = holdFirstActivation('sent');
    const refreshing = manager({ service: held.service }).refreshIfDue();
    await held.arrived;
    expect(manager().deactivate()).toBe(true);
    held.release(new TypeError('fetch failed'));
    await refreshing;
    expect(vault.read()).toBeNull();
  });
});

describe('purchase guard', () => {
  it('sells to someone with no license', async () => {
    const { url, sessionId } = await manager().startPurchase();
    expect(url).toBe(`https://checkout.stripe.com/c/pay/${sessionId}`);
  });

  it('refuses while Pro is active, or while a key holder only needs to renew', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const before = checkoutsCreated();
    const active = await manager().startPurchase().then(() => null, (e: unknown) => e);
    expect(active).toBeInstanceOf(PurchaseRefusedError);
    expect((active as PurchaseRefusedError).entitlement.active).toBe(true);

    world.advance(8 * DAY);
    faults.set('/license/activate', offline);
    const lapsed = await manager().startPurchase().then(() => null, (e: unknown) => e);
    expect(nextStep((lapsed as PurchaseRefusedError).entitlement)).toBe('renew');
    expect(checkoutsCreated()).toBe(before);
  });

  it('checks with the service even inside the hourly recheck window', async () => {
    const { key, subscriptionId } = await purchasedKey();
    await manager().activate(key);
    await cancel(subscriptionId);
    world.advance(6 * DAY);
    await manager().refreshIfDue();
    world.stripe.subs.set(subscriptionId, { ...world.stripe.subs.get(subscriptionId)!, status: 'active' });
    await world.webhook({ id: 'evt_back', type: 'customer.subscription.updated', data: { object: { id: subscriptionId } } });
    const refused = await manager().startPurchase().then(() => null, (e: unknown) => e);
    expect((refused as PurchaseRefusedError).entitlement.active).toBe(true);
  });

  it('lets a subscriber whose subscription ended buy again', async () => {
    const { key, subscriptionId } = await purchasedKey();
    await manager().activate(key);
    await cancel(subscriptionId);
    expect((await manager().startPurchase()).url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it('sends a past-due subscriber to billing instead of selling a second subscription', async () => {
    const { key } = await purchasedKey('past_due');
    await manager().activate(key);
    world.advance(15 * DAY);
    const refused = await manager().startPurchase().then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(PurchaseRefusedError);
    const entitlement = (refused as PurchaseRefusedError).entitlement;
    expect(entitlement).toMatchObject({ reason: 'subscription_inactive', subscriptionStatus: 'past_due' });
    expect(nextStep(entitlement)).toBe('billing');
  });

  it('refuses while the license file cannot be read', async () => {
    corruptLicenseFile();
    const refused = await manager().startPurchase().then(() => null, (e: unknown) => e);
    expect(nextStep((refused as PurchaseRefusedError).entitlement)).toBe('fix_license_file');
  });
});

describe('purchase, billing and rotation', () => {
  it('saves the key the first time a purchase is ready', async () => {
    const { sessionId } = await manager().startPurchase();
    expect(await manager().claimPurchase(sessionId)).toEqual({ state: 'pending' });
    expect(vault.read()).toBeNull();

    world.stripe.pay(sessionId);
    const ready = await manager().claimPurchase(sessionId);
    expect(ready).toMatchObject({ state: 'ready', saved: true, entitlement: { active: true } });
    expect(ready).not.toHaveProperty('saveError');
    if (ready.state !== 'ready') return;
    expect(vault.read()?.key).toBe(ready.key);
  });

  it('hands back a purchased key even when it cannot be saved', async () => {
    const { sessionId } = await manager().startPurchase();
    world.stripe.pay(sessionId);
    const readOnly: LicenseVault = { read: () => vault.read(), write: () => { throw new LicenseStorageError('cannot write: EROFS', 'write'); }, clear: () => vault.clear() };
    const ready = await manager({ vault: readOnly }).claimPurchase(sessionId);
    expect(ready).toMatchObject({ state: 'ready', saved: false, saveError: { message: 'cannot write: EROFS' } });
    expect(ready).not.toHaveProperty('entitlement');
    if (ready.state !== 'ready') return;
    expect((await new HttpProService(world.origin, world.fetch).activate(ready.key)).token).toBeTruthy();
  });

  it('hands out the billing portal link', async () => {
    expect(await manager().billingPortalUrl()).toBe('https://billing.stripe.com/p/login/test_portal');
    await expect(manager({ service: null }).billingPortalUrl()).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it('rotate keeps the new key when activation fails', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    faults.set('/license/activate', offline);

    const rotated = await manager().rotate();
    expect(rotated).toMatchObject({ saved: true, activationError: { kind: 'unreachable' } });
    expect(rotated.key).not.toBe(key);
    expect(vault.read()).toMatchObject({ key: rotated.key, token: null });

    faults.clear();
    expect((await manager().refreshIfDue()).active).toBe(true);
    await expect(new HttpProService(world.origin, world.fetch).activate(key)).rejects.toMatchObject({ code: 'unknown_key' });
  });

  it('rotate hands back the new key even when it cannot be saved', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const failingWrites: LicenseVault = {
      read: () => vault.read(),
      write: () => { throw new LicenseStorageError('cannot write: EACCES', 'write'); },
      clear: () => vault.clear(),
    };

    const rotated = await manager({ vault: failingWrites }).rotate();
    expect(rotated).toMatchObject({ saved: false, saveError: { message: 'cannot write: EACCES' } });
    expect(rotated).not.toHaveProperty('entitlement');
    expect(rotated.key).not.toBe(key);
    expect((await new HttpProService(world.origin, world.fetch).activate(rotated.key)).token).toBeTruthy();
  });

  it('deactivate forgets the license on this machine', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    expect(manager().deactivate()).toBe(true);
    expect(await manager().currentEntitlement()).toMatchObject({ active: false, reason: 'no_license' });
    expect(manager().storedKey()).toBeNull();
  });
});

describe('feature access and guidance', () => {
  const active: Entitlement = { active: true, features: ['cloud_logs'], status: 'active', tokenExpiresAt: 2, refreshDue: false };
  const inactive = (reason: InactiveReason, subscriptionStatus?: string): Entitlement =>
    ({ active: false, reason, detail: 'x', ...(subscriptionStatus ? { subscriptionStatus } : {}) });

  it('allows only the features the verified token lists', () => {
    expect(featureAccess(active, 'cloud_logs')).toEqual({ allowed: true });
    const missing = featureAccess(active, 'hosted_runs');
    expect(missing).toMatchObject({ allowed: false, reason: 'not_in_plan' });
    expect(missing.allowed ? '' : missing.message).toContain('timmy pro activate');
    expect(featureAccess(inactive('no_license'), 'cloud_logs')).toMatchObject({ allowed: false, reason: 'no_license' });
  });

  it('points each reason at the one step that fixes it', () => {
    const cases: Array<[Entitlement, string, string]> = [
      [inactive('no_license'), 'buy', 'timmy pro upgrade'],
      [inactive('key_not_activated'), 'renew', 'timmy pro activate'],
      [inactive('token_expired'), 'renew', 'timmy pro activate'],
      [inactive('subscription_inactive'), 'billing', 'timmy pro billing'],
      [inactive('subscription_inactive', 'past_due'), 'billing', 'timmy pro billing'],
      [inactive('subscription_inactive', 'canceled'), 'buy', 'timmy pro upgrade'],
      [inactive('key_revoked'), 'use_newest_key', 'timmy pro activate -'],
      [inactive('invalid_token'), 'update_timmy', 'TIMMY_PRO_PUBLIC_KEY'],
      [inactive('no_public_key'), 'update_timmy', 'TIMMY_PRO_PUBLIC_KEY'],
      [inactive('clock_skew'), 'check_clock', 'clock'],
      [inactive('license_unreadable'), 'fix_license_file', 'license file'],
    ];
    for (const [entitlement, step, words] of cases) {
      const label = `${entitlement.active ? '' : `${entitlement.reason} ${entitlement.subscriptionStatus ?? ''}`}`;
      expect(nextStep(entitlement), label).toBe(step);
      expect(accessMessage(entitlement, 'cloud_logs'), label).toContain(words);
    }
    expect(nextStep(active)).toBe('none');
    expect(accessMessage(inactive('no_license'), 'cloud_logs')).toContain('$19/month');
  });
});
