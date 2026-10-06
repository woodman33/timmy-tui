import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpProService, type FetchLike } from '../src/pro/client.js';
import { runProCli, type ProCliContext, type ProCliIO } from '../src/pro/cli.js';
import { importVerifyKey } from '../src/pro/license.js';
import { LicenseManager } from '../src/pro/manager.js';
import { PRO_FEATURES } from '../src/pro/plan.js';
import { LicenseStorageError, type LicenseVault } from '../src/pro/ports.js';
import { FileCheckoutStore, FileLicenseVault } from '../src/pro/vault.js';
import { DAY, proSub, proWorld, type ProWorld } from './helpers/pro-harness.js';

let root: string;
let world: ProWorld;
let vault: FileLicenseVault;
let publicKey: CryptoKey;
let claimFaults: Array<'rate-limited' | 'offline'>;
let offlinePaths: Set<string>;

type RecordingIO = ProCliIO & { outText: string[]; errText: string[]; opened: string[]; sleeps: number[]; stdin: string };

function recordingIO(onSleep: (count: number) => void = () => {}): RecordingIO {
  const io: RecordingIO = {
    outText: [], errText: [], opened: [], sleeps: [], stdin: '',
    out: (text) => { io.outText.push(text); },
    err: (text) => { io.errText.push(text); },
    openUrl: (url) => { io.opened.push(url); },
    sleep: async (ms) => { io.sleeps.push(ms); onSleep(io.sleeps.length); },
    readStdin: async () => io.stdin,
  };
  return io;
}

/** The real handler, with scripted faults on /license/claim (one per call, in order) and paths taken offline. */
const faultyFetch = (): FetchLike => async (input, init) => {
  const path = new URL(input).pathname;
  if (offlinePaths.has(path)) throw new TypeError('fetch failed');
  if (path === '/license/claim') {
    const fault = claimFaults.shift();
    if (fault === 'rate-limited') return new Response('{"error":"too many requests","code":"rate_limited"}', { status: 429 });
    if (fault === 'offline') throw new TypeError('fetch failed');
  }
  return world.fetch(input, init);
};

function context(io: ProCliIO, over: { available?: boolean; vault?: LicenseVault; publicKey?: CryptoKey | null } = {}): ProCliContext {
  const service = over.available === false ? null : new HttpProService(world.origin, faultyFetch());
  return {
    manager: new LicenseManager({
      vault: over.vault ?? vault,
      checkouts: new FileCheckoutStore(checkoutFile()),
      service,
      publicKey: over.publicKey === undefined ? publicKey : over.publicKey,
      now: world.now,
    }),
    settings: { serviceUrl: service ? world.origin : null, publicKey: world.publicKey, publicKeySource: 'env', licensePath: vault.location },
    io,
  };
}

const latestSession = () => [...world.stripe.sessions.keys()].at(-1)!;
const output = (io: RecordingIO) => io.outText.join('\n');
const errors = (io: RecordingIO) => io.errText.join('\n');
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const checkoutsCreated = () => world.stripe.calls.filter((call) => call.startsWith('create:')).length;

/** Buys Pro without the CLI and returns the issued key and its subscription. */
async function purchase(status = 'active'): Promise<{ key: string; subscriptionId: string }> {
  const service = new HttpProService(world.origin, world.fetch);
  const { sessionId } = await service.startCheckout();
  const sub = world.stripe.pay(sessionId, proSub(`sub_${sessionId.slice(-8)}`, status));
  const claim = await service.claim(sessionId);
  if (claim.state !== 'ready') throw new Error('expected a ready claim');
  return { key: claim.key, subscriptionId: sub.id };
}

async function activated(status = 'active'): Promise<{ key: string; subscriptionId: string }> {
  const bought = await purchase(status);
  await context(recordingIO()).manager.activate(bought.key);
  return bought;
}

/** Reads the real license file but cannot write it, like a read-only disk. */
const readOnlyVault = (): LicenseVault => ({
  read: () => vault.read(),
  write: () => { throw new LicenseStorageError(`cannot write ${vault.location}: EROFS: read-only file system`, 'write'); },
  clear: () => vault.clear(),
});

function corruptLicenseFile() {
  mkdirSync(dirname(vault.location), { recursive: true });
  writeFileSync(vault.location, 'not json');
}

const KEY_PATTERN = /tpro_[0-9A-Z]{8}(?:-[0-9A-Z]{8}){3}/;

/** An upgrade the user stopped while it waited for payment (Ctrl-C). Returns the checkout it opened. */
async function interruptedUpgrade(): Promise<string> {
  const io = recordingIO(() => { throw new Error('interrupted'); });
  await runProCli(['upgrade', '--no-open'], context(io)).catch(() => 1);
  return latestSession();
}

const checkoutFile = () => join(root, 'pro', 'checkout.json');

async function cancelSubscription(subscriptionId: string) {
  world.stripe.subs.set(subscriptionId, { ...world.stripe.subs.get(subscriptionId)!, status: 'canceled' });
  await world.webhook({ id: `evt_cancel_${subscriptionId}`, type: 'customer.subscription.deleted', data: { object: { id: subscriptionId } } });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'timmy-pro-cli-'));
  world = await proWorld();
  vault = new FileLicenseVault(join(root, 'pro', 'license.json'));
  publicKey = await importVerifyKey(world.publicKey);
  claimFaults = [];
  offlinePaths = new Set();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('timmy pro upgrade', () => {
  it('opens checkout, waits, saves and prints the key', async () => {
    const io = recordingIO((count) => { if (count === 2) world.stripe.pay(latestSession()); });
    expect(await runProCli(['upgrade'], context(io))).toBe(0);
    expect(io.opened).toEqual([`https://checkout.stripe.com/c/pay/${latestSession()}`]);
    expect(io.sleeps).toEqual([5000, 5000]);
    const key = vault.read()?.key;
    expect(key).toMatch(/^tpro_/);
    expect(occurrences(output(io), key!)).toBe(1);
  });

  it('backs off on 429 and survives a network blip', async () => {
    claimFaults = ['rate-limited', 'offline'];
    const io = recordingIO((count) => { if (count === 3) world.stripe.pay(latestSession()); });
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(0);
    expect(io.sleeps).toEqual([5000, 10000, 10000]);
    expect(io.opened).toEqual([]);
    expect(vault.read()?.token).not.toBeNull();
  });

  it('times out with instructions', async () => {
    const io = recordingIO();
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(1);
    expect(io.sleeps.reduce((total, ms) => total + ms, 0)).toBe(30 * 60_000);
    expect(errors(io)).toContain('timmy pro activate');
    expect(errors(io)).toContain('timmy pro upgrade');
    expect(errors(io)).not.toContain('for a day');
    expect(vault.read()).toBeNull();
  });

  it('says when Pro is not available in this build', async () => {
    const io = recordingIO();
    expect(await runProCli(['upgrade'], context(io, { available: false }))).toBe(1);
    expect(errors(io)).toContain('not available');
    expect(io.opened).toEqual([]);
  });

  it('does not sell Pro to someone who has it', async () => {
    await activated();
    const before = checkoutsCreated();
    const io = recordingIO();
    expect(await runProCli(['upgrade'], context(io))).toBe(0);
    expect(output(io)).toContain('already');
    expect(checkoutsCreated()).toBe(before);
  });

  it('does not sell Pro to a key holder whose token lapsed offline', async () => {
    await activated();
    world.advance(8 * DAY);
    offlinePaths.add('/license/activate');
    const before = checkoutsCreated();
    const io = recordingIO();
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(1);
    expect(errors(io)).toContain('timmy pro activate');
    expect(errors(io)).toContain('timmy pro deactivate');
    expect(checkoutsCreated()).toBe(before);
  });

  it('lets a cancelled subscriber buy again', async () => {
    const { key, subscriptionId } = await activated();
    world.stripe.subs.set(subscriptionId, { ...world.stripe.subs.get(subscriptionId)!, status: 'canceled' });
    await world.webhook({ id: 'evt_cancel', type: 'customer.subscription.deleted', data: { object: { id: subscriptionId } } });
    world.advance(6 * DAY);
    const io = recordingIO((count) => { if (count === 1) world.stripe.pay(latestSession()); });
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(0);
    expect(vault.read()?.key).not.toBe(key);
    expect(vault.read()?.token).not.toBeNull();
  });

  it('sends a past-due subscriber to billing instead of selling a second subscription', async () => {
    await activated('past_due');
    world.advance(15 * DAY);
    const before = checkoutsCreated();
    const io = recordingIO();
    expect(await runProCli(['upgrade'], context(io))).toBe(1);
    expect(errors(io)).toContain('past due');
    expect(errors(io)).toContain('timmy pro billing');
    expect(checkoutsCreated()).toBe(before);
    expect(io.opened).toEqual([]);
  });

  it('starts no purchase while the license file is damaged, and says how to fix it', async () => {
    corruptLicenseFile();
    const io = recordingIO();
    expect(await runProCli(['upgrade'], context(io))).toBe(1);
    expect(errors(io)).toContain('cannot be read');
    expect(errors(io)).toContain('timmy pro deactivate');
    expect(errors(io)).not.toContain('There is already a');
    expect(checkoutsCreated()).toBe(0);
  });

  it('prints a purchased key it cannot save, and says to copy it now', async () => {
    const io = recordingIO((count) => { if (count === 1) world.stripe.pay(latestSession()); });
    expect(await runProCli(['upgrade', '--no-open'], context(io, { vault: readOnlyVault() }))).toBe(1);
    const key = output(io).match(KEY_PATTERN)?.[0];
    expect(key).toBeDefined();
    expect(output(io)).not.toContain('Saved to');
    expect(errors(io)).toContain('EROFS');
    expect(errors(io)).toContain('Copy the key above');
    expect((await new HttpProService(world.origin, world.fetch).activate(key!)).token).toBeTruthy();
  });
});

describe('timmy pro upgrade after an earlier one stopped', () => {
  it('resumes the checkout it opened instead of opening a second one', async () => {
    const first = await interruptedUpgrade();
    const io = recordingIO((count) => { if (count === 1) world.stripe.pay(first); });
    expect(await runProCli(['upgrade'], context(io))).toBe(0);
    expect(checkoutsCreated()).toBe(1);
    expect(io.opened).toEqual([`https://checkout.stripe.com/c/pay/${first}`]);
    expect(output(io)).toContain('still open');
    expect(vault.read()?.token).not.toBeNull();
  });

  it('saves a checkout that was paid after the wait stopped, without opening it again', async () => {
    const first = await interruptedUpgrade();
    world.stripe.pay(first);
    const io = recordingIO();
    expect(await runProCli(['upgrade'], context(io))).toBe(0);
    expect(checkoutsCreated()).toBe(1);
    expect(io.opened).toEqual([]);
    expect(io.sleeps).toEqual([]);
    expect(vault.read()?.token).not.toBeNull();
  });

  it('opens a new checkout once the earlier one expired unpaid', async () => {
    const first = await interruptedUpgrade();
    world.stripe.expire(first);
    const io = recordingIO((count) => { if (count === 1) world.stripe.pay(latestSession()); });
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(0);
    expect(checkoutsCreated()).toBe(2);
    expect(latestSession()).not.toBe(first);
    expect(existsSync(checkoutFile())).toBe(false);
  });

  it('stops waiting when the checkout expires', async () => {
    const io = recordingIO((count) => { if (count === 1) world.stripe.expire(latestSession()); });
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(1);
    expect(io.sleeps).toHaveLength(1);
    expect(errors(io)).toContain('expired');
    expect(errors(io)).toContain('timmy pro upgrade');
    expect(existsSync(checkoutFile())).toBe(false);
  });

  it('opens no second checkout while an earlier paid one is still active', async () => {
    const first = await interruptedUpgrade();
    world.stripe.pay(first);
    await new HttpProService(world.origin, world.fetch).claim(first); // the welcome page showed the key, once
    world.advance(DAY + 60);
    const io = recordingIO();
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(1);
    expect(checkoutsCreated()).toBe(1);
    expect(errors(io)).toContain('timmy pro activate');
    expect(errors(io)).toContain('timmy pro billing');
    expect(errors(io)).not.toContain('deactivate');
  });

  it('lets a customer whose earlier subscription ended buy again', async () => {
    const first = await interruptedUpgrade();
    const sub = world.stripe.pay(first);
    const welcome = await new HttpProService(world.origin, world.fetch).claim(first); // the key the welcome page showed
    if (welcome.state !== 'ready') throw new Error('expected a ready claim');
    expect(await runProCli(['activate', welcome.key], context(recordingIO()))).toBe(0);
    await cancelSubscription(sub.id);
    world.advance(DAY + 60);
    const io = recordingIO((count) => { if (count === 1) world.stripe.pay(latestSession()); });
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(0);
    expect(checkoutsCreated()).toBe(2);
    expect(vault.read()?.key).not.toBe(welcome.key);
    expect(vault.read()?.token).not.toBeNull();
  });

  it('keeps an open checkout through deactivate', async () => {
    const first = await interruptedUpgrade();
    expect(await runProCli(['deactivate'], context(recordingIO()))).toBe(0);
    const io = recordingIO((count) => { if (count === 1) world.stripe.pay(first); });
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(0);
    expect(checkoutsCreated()).toBe(1);
    expect(output(io)).toContain('still open');
  });

  it('forgets a checkout the service does not know and opens a new one', async () => {
    mkdirSync(join(root, 'pro'), { recursive: true });
    const unknown = 'cs_test_fromanotheraccount';
    writeFileSync(checkoutFile(), JSON.stringify({ v: 1, sessionId: unknown, url: `https://checkout.stripe.com/c/pay/${unknown}`, openedAt: world.now() }));
    const io = recordingIO((count) => { if (count === 1) world.stripe.pay(latestSession()); });
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(0);
    expect(checkoutsCreated()).toBe(1);
    expect(existsSync(checkoutFile())).toBe(false);
  });

  it('starts no checkout while the record of an open checkout is damaged', async () => {
    mkdirSync(join(root, 'pro'), { recursive: true });
    writeFileSync(checkoutFile(), 'not json');
    const io = recordingIO();
    expect(await runProCli(['upgrade', '--no-open'], context(io))).toBe(1);
    expect(checkoutsCreated()).toBe(0);
    expect(errors(io)).toContain('checkout.json');
  });

  it('treats a recorded checkout whose link is not https as damaged', async () => {
    const first = await interruptedUpgrade();
    writeFileSync(checkoutFile(), JSON.stringify({ v: 1, sessionId: first, url: `http://checkout.stripe.com/c/pay/${first}`, openedAt: world.now() }));
    const io = recordingIO();
    expect(await runProCli(['upgrade'], context(io))).toBe(1);
    expect(io.opened).toEqual([]);
    expect(checkoutsCreated()).toBe(1);
    expect(errors(io)).toContain('checkout.json');
  });
});

describe('timmy pro status', () => {
  it('reports a versioned JSON status with a masked key and never the token', async () => {
    const { key } = await activated();
    const io = recordingIO();
    expect(await runProCli(['status', '--json'], context(io))).toBe(0);
    const text = output(io);
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 1,
      active: true,
      reason: null,
      detail: null,
      nextStep: 'none',
      plan: 'pro',
      priceUsdMonthly: 19,
      features: [...PRO_FEATURES],
      licenseKeyMasked: `tpro_${key.slice(5, 9)}…${key.slice(-4)}`,
      tokenExpiresAt: new Date((world.now() + 7 * DAY) * 1000).toISOString(),
      refreshDue: false,
      serviceUrl: world.origin,
      publicKeySource: 'env',
    });
    expect(text).not.toContain(key);
    expect(text).not.toContain('tpro1.');
  });

  it('tells a free user how to get Pro', async () => {
    const io = recordingIO();
    expect(await runProCli([], context(io))).toBe(0);
    expect(output(io)).toContain('not active');
    expect(output(io)).toContain('timmy pro upgrade');
  });

  it('never tells a key holder to buy', async () => {
    await activated();
    world.advance(8 * DAY);
    offlinePaths.add('/license/activate');
    const io = recordingIO();
    expect(await runProCli(['status'], context(io))).toBe(0);
    expect(output(io)).toContain('timmy pro activate');
    expect(output(io)).not.toContain('timmy pro upgrade');
  });

  it('explains a damaged license file instead of offering a purchase', async () => {
    corruptLicenseFile();
    const io = recordingIO();
    expect(await runProCli(['status', '--json'], context(io))).toBe(0);
    expect(JSON.parse(output(io))).toMatchObject({ active: false, reason: 'license_unreadable', nextStep: 'fix_license_file', licenseKeyMasked: null });
  });
});

describe('timmy pro activate, rotate, billing, deactivate', () => {
  it('activate reads the key from stdin with -', async () => {
    const { key } = await purchase();
    const io = recordingIO();
    io.stdin = `${key}\n`;
    expect(await runProCli(['activate', '-'], context(io))).toBe(0);
    expect(output(io)).toContain('active');
    expect(vault.read()?.key).toBe(key);
  });

  it('activate with no key renews the saved one', async () => {
    await activated();
    const before = vault.read()?.token;
    world.advance(DAY);
    const io = recordingIO();
    expect(await runProCli(['activate'], context(io))).toBe(0);
    expect(vault.read()?.token).not.toBe(before);
  });

  it('activate refuses something that is not a key', async () => {
    const io = recordingIO();
    expect(await runProCli(['activate', 'tpro_nope'], context(io))).toBe(2);
    expect(errors(io)).toContain('not a Timmy Pro license key');
  });

  it('activate after a cancellation points to upgrade, not billing', async () => {
    const { subscriptionId } = await activated();
    await cancelSubscription(subscriptionId);
    const io = recordingIO();
    expect(await runProCli(['activate'], context(io))).toBe(1);
    expect(errors(io)).toContain('timmy pro upgrade');
    expect(errors(io)).not.toContain('timmy pro billing');
  });

  it('rotate says when the license file cannot be read', async () => {
    corruptLicenseFile();
    const io = recordingIO();
    expect(await runProCli(['rotate'], context(io))).toBe(1);
    expect(errors(io)).toContain('Could not read the Timmy Pro license file');
  });

  it('activate says when the license file cannot be saved', async () => {
    const { key } = await purchase();
    const io = recordingIO();
    expect(await runProCli(['activate', key], context(io, { vault: readOnlyVault() }))).toBe(1);
    expect(errors(io)).toContain('Could not save the Timmy Pro license file');
    expect(errors(io)).toContain('EROFS');
  });

  it('rotate prints the new key and the old one stops working', async () => {
    const { key: oldKey } = await activated();
    const io = recordingIO();
    expect(await runProCli(['rotate'], context(io))).toBe(0);
    const newKey = vault.read()!.key;
    expect(newKey).not.toBe(oldKey);
    expect(output(io)).toContain(newKey);
    await expect(new HttpProService(world.origin, world.fetch).activate(oldKey)).rejects.toMatchObject({ code: 'unknown_key' });
  });

  it('rotate still prints the new key when it cannot be saved', async () => {
    await activated();
    const io = recordingIO();
    expect(await runProCli(['rotate'], context(io, { vault: readOnlyVault() }))).toBe(1);
    expect(output(io)).toMatch(KEY_PATTERN);
    expect(errors(io)).toContain('EROFS');
    expect(errors(io)).toContain('Copy the key above');
  });

  it('rotate does not claim Pro is active when this build cannot check the new token', async () => {
    await activated();
    const io = recordingIO();
    expect(await runProCli(['rotate'], context(io, { publicKey: null }))).toBe(0);
    expect(output(io)).toMatch(KEY_PATTERN);
    expect(output(io)).not.toContain('is active on this machine');
    expect(output(io)).toContain('cannot check');
  });

  it('billing prints the portal URL and opens it unless asked not to', async () => {
    const quiet = recordingIO();
    expect(await runProCli(['billing', '--no-open'], context(quiet))).toBe(0);
    expect(output(quiet)).toContain('https://billing.stripe.com/p/login/test_portal');
    expect(quiet.opened).toEqual([]);

    const loud = recordingIO();
    expect(await runProCli(['billing'], context(loud))).toBe(0);
    expect(loud.opened).toEqual(['https://billing.stripe.com/p/login/test_portal']);
  });

  it('deactivate removes the local license', async () => {
    await activated();
    const io = recordingIO();
    expect(await runProCli(['deactivate'], context(io))).toBe(0);
    expect(vault.read()).toBeNull();
    expect(output(io)).toContain('timmy pro billing');
  });
});

describe('help and usage', () => {
  it('prints usage for --help and -h anywhere, with exit 0', async () => {
    for (const argv of [['--help'], ['-h'], ['activate', '-h'], ['help']]) {
      const io = recordingIO();
      expect(await runProCli(argv, context(io)), argv.join(' ')).toBe(0);
      expect(output(io)).toContain('Usage: timmy pro');
      expect(io.errText).toEqual([]);
    }
  });

  it('says exactly what was wrong before showing usage, with exit 2', async () => {
    const cases: Array<[string[], string]> = [
      [['frobnicate'], 'timmy pro: unknown command "frobnicate"'],
      [['status', '--frob'], 'timmy pro status: unknown option --frob'],
      [['rotate', 'extra'], 'timmy pro rotate: takes no arguments'],
    ];
    for (const [argv, first] of cases) {
      const io = recordingIO();
      expect(await runProCli(argv, context(io)), argv.join(' ')).toBe(2);
      expect(io.errText[0]).toBe(first);
      expect(errors(io)).toContain('Usage: timmy pro');
    }
  });
});
