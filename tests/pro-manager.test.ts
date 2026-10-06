import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpProService, type FetchLike } from '../src/pro/client.js';
import { accessMessage, featureAccess, nextStep, type Entitlement, type InactiveReason } from '../src/pro/entitlement.js';
import { generateLicenseKeyPair, importSigningKey, importVerifyKey, signLicenseToken } from '../src/pro/license.js';
import { LicenseInputError, LicenseManager, ProUnavailableError } from '../src/pro/manager.js';
import { PRO_FEATURES } from '../src/pro/plan.js';
import type { LicenseVault, StoredLicense } from '../src/pro/ports.js';
import { FileLicenseVault } from '../src/pro/vault.js';
import { DAY, proWorld, type ProWorld } from './helpers/pro-harness.js';

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
async function purchasedKey(): Promise<{ key: string; subscriptionId: string }> {
  const service = new HttpProService(world.origin, world.fetch);
  const { sessionId } = await service.startCheckout();
  const sub = world.stripe.pay(sessionId);
  const claim = await service.claim(sessionId);
  if (claim.state !== 'ready') throw new Error('expected a ready claim');
  return { key: claim.key, subscriptionId: sub.id };
}

async function cancel(subscriptionId: string) {
  world.stripe.subs.set(subscriptionId, { ...world.stripe.subs.get(subscriptionId)!, status: 'canceled' });
  expect((await world.webhook({ id: `evt_cancel_${subscriptionId}`, type: 'customer.subscription.deleted', data: { object: { id: subscriptionId } } })).status).toBe(200);
}

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

  it('drops a token that fails verification against the build key', async () => {
    const { key } = await purchasedKey();
    const otherKey = await importVerifyKey((await generateLicenseKeyPair()).publicRaw);
    expect(await manager({ publicKey: otherKey }).activate(key)).toEqual({ active: false, reason: 'invalid_token', detail: 'signature does not verify' });
    expect(vault.read()).toMatchObject({ key, token: null });
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

  it('keeps a valid token when the refresh fails offline', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const token = vault.read()?.token;
    world.advance(6 * DAY);
    faults.set('/license/activate', offline);
    expect((await manager().refreshIfDue()).active).toBe(true);
    expect(vault.read()?.token).toBe(token);
  });

  it('never mistakes a proxy page for a cancelled subscription', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const token = vault.read()?.token;
    world.advance(6 * DAY);
    faults.set('/license/activate', proxyPage);
    expect((await manager().refreshIfDue()).active).toBe(true);
    expect(vault.read()).toMatchObject({ token });
    expect(vault.read()?.refusal).toBeUndefined();
  });

  it('remembers a refusal, reports it offline, and asks again at most hourly', async () => {
    const { key, subscriptionId } = await purchasedKey();
    await manager().activate(key);
    await cancel(subscriptionId);
    world.advance(6 * DAY);

    requests = [];
    expect(await manager().refreshIfDue()).toMatchObject({ active: false, reason: 'subscription_inactive' });
    expect(vault.read()).toMatchObject({ key, token: null, refusal: { reason: 'subscription_inactive', at: world.now() } });
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
    expect(vault.read()).toMatchObject({ key, token: null, refusal: { reason: 'key_revoked' } });
  });
});

describe('purchase, billing and rotation', () => {
  it('starts a purchase, then saves the key the first time it is ready', async () => {
    const { url, sessionId } = await manager().startPurchase();
    expect(url).toBe(`https://checkout.stripe.com/c/pay/${sessionId}`);
    expect(await manager().claimPurchase(sessionId)).toEqual({ state: 'pending' });
    expect(vault.read()).toBeNull();

    world.stripe.pay(sessionId);
    const ready = await manager().claimPurchase(sessionId);
    expect(ready.state).toBe('ready');
    if (ready.state !== 'ready') return;
    expect(ready.entitlement.active).toBe(true);
    expect(vault.read()?.key).toBe(ready.key);
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
    expect(rotated).toMatchObject({ saved: true, followUpError: { kind: 'unreachable' } });
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
      write: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
      clear: () => vault.clear(),
    };

    const rotated = await manager({ vault: failingWrites }).rotate();
    expect(rotated).toMatchObject({ saved: false, followUpError: { message: 'EACCES: permission denied' } });
    expect(rotated.key).toMatch(/^tpro_/);
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
  const inactive = (reason: InactiveReason): Entitlement => ({ active: false, reason, detail: 'x' });

  it('allows only the features the verified token lists', () => {
    expect(featureAccess(active, 'cloud_logs')).toEqual({ allowed: true });
    const missing = featureAccess(active, 'hosted_runs');
    expect(missing).toMatchObject({ allowed: false, reason: 'not_in_plan' });
    expect(missing.allowed ? '' : missing.message).toContain('timmy pro activate');
    expect(featureAccess(inactive('no_license'), 'cloud_logs')).toMatchObject({ allowed: false, reason: 'no_license' });
  });

  it('points each reason at the one step that fixes it', () => {
    const cases: Array<[InactiveReason, string, string]> = [
      ['no_license', 'buy', 'timmy pro upgrade'],
      ['key_not_activated', 'renew', 'timmy pro activate'],
      ['token_expired', 'renew', 'timmy pro activate'],
      ['subscription_inactive', 'billing', 'timmy pro billing'],
      ['key_revoked', 'use_newest_key', 'timmy pro activate -'],
      ['invalid_token', 'update_timmy', 'TIMMY_PRO_PUBLIC_KEY'],
      ['no_public_key', 'update_timmy', 'TIMMY_PRO_PUBLIC_KEY'],
    ];
    for (const [reason, step, command] of cases) {
      expect(nextStep(inactive(reason)), reason).toBe(step);
      expect(accessMessage(inactive(reason), 'cloud_logs'), reason).toContain(command);
    }
    expect(nextStep(active)).toBe('none');
    expect(accessMessage(inactive('no_license'), 'cloud_logs')).toContain('$19/month');
  });
});
