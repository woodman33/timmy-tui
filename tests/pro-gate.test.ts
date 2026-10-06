import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpProService, type FetchLike } from '../src/pro/client.js';
import { checkProFeature } from '../src/pro/gate.js';
import { importVerifyKey } from '../src/pro/license.js';
import { LicenseManager } from '../src/pro/manager.js';
import { loadLicenseManager } from '../src/pro/runtime.js';
import { FileLicenseVault } from '../src/pro/vault.js';
import { DAY, proWorld, type ProWorld } from './helpers/pro-harness.js';

let home: string;
let world: ProWorld;
let env: Record<string, string>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'timmy-pro-gate-'));
  world = await proWorld();
  env = { TIMMY_HOME: home, TIMMY_PRO_URL: world.origin, TIMMY_PRO_PUBLIC_KEY: world.publicKey };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const overrides = () => ({ fetch: world.fetch, now: world.now });
const licensePath = () => join(home, 'pro', 'license.json');
const storedToken = () => (JSON.parse(readFileSync(licensePath(), 'utf8')) as { token: string | null }).token;

/** Buys Pro and activates it on this machine (TIMMY_HOME = home). */
async function activatedHere(): Promise<void> {
  const service = new HttpProService(world.origin, world.fetch);
  const { sessionId } = await service.startCheckout();
  world.stripe.pay(sessionId);
  const claim = await service.claim(sessionId);
  if (claim.state !== 'ready') throw new Error('expected a ready claim');
  await (await loadLicenseManager(env, overrides())).activate(claim.key);
}

/** The real service, except that /license/activate waits until released, or until the request is aborted. */
function heldActivation(): { fetch: FetchLike; release: () => void; calls: string[] } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input).pathname;
    calls.push(path);
    if (path === '/license/activate') {
      await new Promise<void>((resolve, reject) => {
        void released.then(resolve);
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    return world.fetch(input, init);
  };
  return { fetch, release, calls };
}

/** The promise's value if it settles within `ms`, else 'still waiting'. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'still waiting'> =>
  Promise.race([promise, new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms))]);

describe('checkProFeature', () => {
  it('tells a free user how to get the feature', async () => {
    const access = await checkProFeature('cloud_logs', { env, overrides: overrides() });
    expect(access).toMatchObject({ allowed: false, reason: 'no_license' });
    expect(access.allowed ? '' : access.message).toContain('timmy pro upgrade');
  });

  it('allows a feature once the license on this machine is active', async () => {
    await activatedHere();
    expect(await checkProFeature('cloud_logs', { env, overrides: overrides() })).toEqual({ allowed: true });
  });

  it('turns a bad configuration into a denial instead of an exception', async () => {
    const access = await checkProFeature('cloud_logs', { env: { ...env, TIMMY_PRO_URL: 'http://example.com' } });
    expect(access).toMatchObject({ allowed: false, reason: 'config_error' });
    expect(access.allowed ? '' : access.message).toContain('TIMMY_PRO_URL');
  });

  it('explains a damaged license file', async () => {
    mkdirSync(join(home, 'pro'), { recursive: true });
    writeFileSync(licensePath(), 'not json');
    const access = await checkProFeature('cloud_logs', { env, overrides: overrides() });
    expect(access).toMatchObject({ allowed: false, reason: 'license_unreadable' });
    expect(access.allowed ? '' : access.message).toContain('cannot be read');
  });

  it('turns an unexpected failure into a denial instead of an exception', async () => {
    const broken = new LicenseManager({
      vault: { read: () => { throw new Error('EPERM: operation not permitted'); }, write: () => {}, clear: () => false },
      service: null,
      publicKey: null,
      now: world.now,
    });
    const access = await checkProFeature('cloud_logs', { manager: broken });
    expect(access).toMatchObject({ allowed: false, reason: 'unexpected_error' });
    expect(access.allowed ? '' : access.message).toContain('EPERM');
  });
});

describe('checkProFeature and the network', () => {
  it('answers at once from an active license and renews it in the background', async () => {
    await activatedHere();
    world.advance(6 * DAY);
    const before = storedToken();
    const held = heldActivation();
    const access = checkProFeature('cloud_logs', { env, overrides: { ...overrides(), fetch: held.fetch } });
    expect(await within(access, 1000)).toEqual({ allowed: true });
    held.release();
    await vi.waitFor(() => expect(storedToken()).not.toBe(before));
  });

  it('waits for a due renewal when asked to', async () => {
    await activatedHere();
    world.advance(6 * DAY);
    const before = storedToken();
    const held = heldActivation();
    const access = checkProFeature('cloud_logs', { env, overrides: { ...overrides(), fetch: held.fetch }, refresh: 'wait' });
    expect(await within(access, 200)).toBe('still waiting');
    held.release();
    expect(await access).toEqual({ allowed: true });
    expect(storedToken()).not.toBe(before);
  });

  it('stays off the network when told to', async () => {
    await activatedHere();
    world.advance(6 * DAY);
    const held = heldActivation();
    expect(await checkProFeature('cloud_logs', { env, overrides: { ...overrides(), fetch: held.fetch }, refresh: 'never' })).toEqual({ allowed: true });
    expect(held.calls).toEqual([]);
  });

  it('waits for a lapsed license to renew, but only briefly', async () => {
    await activatedHere();
    world.advance(8 * DAY);
    const held = heldActivation();
    const access = await within(checkProFeature('cloud_logs', { env, overrides: { ...overrides(), fetch: held.fetch, timeoutMs: 50 } }), 2000);
    expect(access).toMatchObject({ allowed: false, reason: 'token_expired' });
    expect(held.calls).toEqual(['/license/activate']);
  });

  it('keeps a failed background renewal to itself', async () => {
    await activatedHere();
    world.advance(6 * DAY);
    const files = new FileLicenseVault(licensePath());
    const unwritable = new LicenseManager({
      vault: { read: () => files.read(), write: () => { throw new TypeError('vault exploded'); }, clear: () => false },
      service: new HttpProService(world.origin, world.fetch),
      publicKey: await importVerifyKey(world.publicKey),
      now: world.now,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(await checkProFeature('cloud_logs', { manager: unwritable })).toEqual({ allowed: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
