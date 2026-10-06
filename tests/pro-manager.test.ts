import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpProService, type FetchLike } from '../src/pro/client.js';
import { allowsFeature, upgradeMessage, type Entitlement } from '../src/pro/entitlement.js';
import { generateLicenseKeyPair, importVerifyKey } from '../src/pro/license.js';
import { LicenseInputError, LicenseManager, ProUnavailableError } from '../src/pro/manager.js';
import { PRO_FEATURES } from '../src/pro/plan.js';
import { FileLicenseVault } from '../src/pro/vault.js';
import { DAY, proWorld, type ProWorld } from './helpers/pro-harness.js';

let root: string;
let world: ProWorld;
let vault: FileLicenseVault;
let requests: string[];
let failing: Set<string>;
let publicKey: CryptoKey;

/** Routes through the real handler, recording each path; paths in `failing` behave as if offline. */
const recordingFetch = (): FetchLike => async (input, init) => {
  const path = new URL(input).pathname;
  requests.push(path);
  if (failing.has(path)) throw new TypeError('fetch failed');
  return world.fetch(input, init);
};

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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'timmy-pro-manager-'));
  world = await proWorld();
  vault = new FileLicenseVault(join(root, 'pro', 'license.json'));
  requests = [];
  failing = new Set();
  publicKey = await importVerifyKey(world.publicKey);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('activation', () => {
  it('activates a key and verifies the token offline', async () => {
    const { key } = await purchasedKey();
    const entitlement = await manager().activate(key);
    expect(entitlement.active).toBe(true);
    if (!entitlement.active) return;
    expect(entitlement.claims.features).toEqual([...PRO_FEATURES]);
    expect(entitlement.refreshDue).toBe(false);
    expect((await manager({ service: null }).current()).active).toBe(true);
    expect(vault.read()?.key).toBe(key);
  });

  it('normalizes pasted keys and rejects malformed ones without a request', async () => {
    const { key } = await purchasedKey();
    const pasted = `  ${key.toLowerCase().replace(/-/g, ' ')}\n`;
    expect((await manager().activate(pasted)).active).toBe(true);
    expect(vault.read()?.key).toBe(key);

    requests = [];
    await expect(manager().activate('tpro_nope')).rejects.toBeInstanceOf(LicenseInputError);
    expect(requests).toEqual([]);
  });

  it('needs a key and a service to activate', async () => {
    await expect(manager().activate()).rejects.toBeInstanceOf(LicenseInputError);
    const { key } = await purchasedKey();
    await expect(manager({ service: null }).activate(key)).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it('drops a token that fails verification against the build key', async () => {
    const { key } = await purchasedKey();
    const otherKey = await importVerifyKey((await generateLicenseKeyPair()).publicRaw);
    const entitlement = await manager({ publicKey: otherKey }).activate(key);
    expect(entitlement).toEqual({ active: false, reason: 'invalid_token', detail: 'signature does not verify' });
    expect(vault.read()).toMatchObject({ key, token: null });
  });

  it('keeps key and token when no public key is configured', async () => {
    const { key } = await purchasedKey();
    const entitlement = await manager({ publicKey: null }).activate(key);
    expect(entitlement.active).toBe(false);
    if (entitlement.active) return;
    expect(entitlement.reason).toBe('no_public_key');
    expect(vault.read()?.token?.split('.')[0]).toBe('tpro1');
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
    const refreshed = await manager().refreshIfDue();
    expect(requests).toEqual(['/license/activate']);
    expect(refreshed.active && refreshed.refreshDue).toBe(false);
    expect(vault.read()?.token).not.toBe(before);
  });

  it('keeps a valid token when the refresh fails offline', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    const token = vault.read()?.token;
    world.advance(6 * DAY);
    failing.add('/license/activate');
    const entitlement = await manager().refreshIfDue();
    expect(entitlement.active).toBe(true);
    expect(vault.read()?.token).toBe(token);
  });

  it('marks a cancelled subscription revoked on refresh', async () => {
    const { key, subscriptionId } = await purchasedKey();
    await manager().activate(key);
    world.stripe.subs.set(subscriptionId, { ...world.stripe.subs.get(subscriptionId)!, status: 'canceled' });
    expect((await world.webhook({ id: 'evt_cancel', type: 'customer.subscription.deleted', data: { object: { id: subscriptionId } } })).status).toBe(200);
    world.advance(6 * DAY);

    expect(await manager().refreshIfDue()).toEqual({ active: false, reason: 'revoked', detail: 'subscription not active' });
    expect(vault.read()).toMatchObject({ key, token: null });
  });
});

describe('purchase and rotation', () => {
  it('claimPurchase saves the key the first time it is ready', async () => {
    const service = new HttpProService(world.origin, world.fetch);
    const { sessionId } = await service.startCheckout();
    expect(await manager().claimPurchase(sessionId)).toEqual({ state: 'pending' });
    expect(vault.read()).toBeNull();

    world.stripe.pay(sessionId);
    const ready = await manager().claimPurchase(sessionId);
    expect(ready.state).toBe('ready');
    if (ready.state !== 'ready') return;
    expect(ready.entitlement.active).toBe(true);
    expect(vault.read()?.key).toBe(ready.key);
  });

  it('rotate keeps the new key when activation fails', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    failing.add('/license/activate');

    const rotated = await manager().rotate();
    expect(rotated.key).not.toBe(key);
    expect(rotated.activationError).toBe('could not reach the Pro service');
    expect(vault.read()).toMatchObject({ key: rotated.key, token: null });

    failing.clear();
    expect((await manager().refreshIfDue()).active).toBe(true);
    await expect(new HttpProService(world.origin, world.fetch).activate(key)).rejects.toMatchObject({ status: 404 });
  });

  it('deactivate forgets the license on this machine', async () => {
    const { key } = await purchasedKey();
    await manager().activate(key);
    expect(manager().deactivate()).toBe(true);
    expect(await manager().current()).toMatchObject({ active: false, reason: 'not_activated' });
    expect(manager().storedKey()).toBeNull();
  });
});

describe('feature gate', () => {
  const claims = { v: 1 as const, plan: 'pro' as const, features: ['cloud_logs' as const], status: 'active', sub: 'abc', iat: 1, exp: 2 };

  it('allows only the features the verified token lists', () => {
    const active: Entitlement = { active: true, claims, refreshDue: false };
    expect(allowsFeature(active, 'cloud_logs')).toBe(true);
    expect(allowsFeature(active, 'hosted_runs')).toBe(false);
    expect(allowsFeature({ active: false, reason: 'expired', detail: 'token expired' }, 'cloud_logs')).toBe(false);
  });

  it('tells a free user how to get a Pro feature', () => {
    const message = upgradeMessage('cloud_logs');
    expect(message).toContain('Cloud Logs');
    expect(message).toContain('$19/month');
    expect(message).toContain('timmy pro upgrade');
  });
});
