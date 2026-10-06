import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpProService } from '../src/pro/client.js';
import { checkProFeature } from '../src/pro/gate.js';
import { LicenseManager } from '../src/pro/manager.js';
import { loadLicenseManager } from '../src/pro/runtime.js';
import { proWorld, type ProWorld } from './helpers/pro-harness.js';

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

describe('checkProFeature', () => {
  it('tells a free user how to get the feature', async () => {
    const access = await checkProFeature('cloud_logs', { env, overrides: overrides() });
    expect(access).toMatchObject({ allowed: false, reason: 'no_license' });
    expect(access.allowed ? '' : access.message).toContain('timmy pro upgrade');
  });

  it('allows a feature once the license on this machine is active', async () => {
    const service = new HttpProService(world.origin, world.fetch);
    const { sessionId } = await service.startCheckout();
    world.stripe.pay(sessionId);
    const claim = await service.claim(sessionId);
    if (claim.state !== 'ready') throw new Error('expected a ready claim');
    await (await loadLicenseManager(env, overrides())).activate(claim.key);

    expect(await checkProFeature('cloud_logs', { env, overrides: overrides() })).toEqual({ allowed: true });
  });

  it('turns a bad configuration into a denial instead of an exception', async () => {
    const access = await checkProFeature('cloud_logs', { env: { ...env, TIMMY_PRO_URL: 'http://example.com' } });
    expect(access).toMatchObject({ allowed: false, reason: 'config_error' });
    expect(access.allowed ? '' : access.message).toContain('TIMMY_PRO_URL');
  });

  it('turns an unreadable license into a denial instead of an exception', async () => {
    const broken = new LicenseManager({
      vault: { read: () => { throw new Error('EPERM: operation not permitted'); }, write: () => {}, clear: () => false },
      service: null,
      publicKey: null,
      now: world.now,
    });
    const access = await checkProFeature('cloud_logs', { manager: broken });
    expect(access).toMatchObject({ allowed: false, reason: 'license_unreadable' });
    expect(access.allowed ? '' : access.message).toContain('EPERM');
  });
});
