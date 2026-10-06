import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpProService, type FetchLike } from '../src/pro/client.js';
import { runProCli, type ProCliContext, type ProCliIO } from '../src/pro/cli.js';
import { importVerifyKey } from '../src/pro/license.js';
import { LicenseManager } from '../src/pro/manager.js';
import { PRO_FEATURES } from '../src/pro/plan.js';
import { FileLicenseVault } from '../src/pro/vault.js';
import { proWorld, type ProWorld } from './helpers/pro-harness.js';

let root: string;
let world: ProWorld;
let vault: FileLicenseVault;
let publicKey: CryptoKey;
let claimFaults: Array<'rate-limited' | 'offline'>;

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

/** The real handler, with scripted faults on /license/claim (one per call, in order). */
const faultyFetch = (): FetchLike => async (input, init) => {
  if (new URL(input).pathname === '/license/claim') {
    const fault = claimFaults.shift();
    if (fault === 'rate-limited') return new Response('{"error":"rate limited"}', { status: 429 });
    if (fault === 'offline') throw new TypeError('fetch failed');
  }
  return world.fetch(input, init);
};

function context(io: ProCliIO, over: { available?: boolean } = {}): ProCliContext {
  const service = over.available === false ? null : new HttpProService(world.origin, faultyFetch());
  return {
    manager: new LicenseManager({ vault, service, publicKey, now: world.now }),
    service,
    settings: { serviceUrl: service ? world.origin : null, publicKey: world.publicKey, publicKeySource: 'env', licensePath: vault.location },
    io,
  };
}

const latestSession = () => [...world.stripe.sessions.keys()].at(-1)!;
const output = (io: RecordingIO) => io.outText.join('\n');
const errors = (io: RecordingIO) => io.errText.join('\n');
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** Buys Pro without the CLI and returns the issued key. */
async function purchasedKey(): Promise<string> {
  const service = new HttpProService(world.origin, world.fetch);
  const { sessionId } = await service.startCheckout();
  world.stripe.pay(sessionId);
  const claim = await service.claim(sessionId);
  if (claim.state !== 'ready') throw new Error('expected a ready claim');
  return claim.key;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'timmy-pro-cli-'));
  world = await proWorld();
  vault = new FileLicenseVault(join(root, 'pro', 'license.json'));
  publicKey = await importVerifyKey(world.publicKey);
  claimFaults = [];
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
    expect(vault.read()).toBeNull();
  });

  it('says when Pro is not available in this build', async () => {
    const io = recordingIO();
    expect(await runProCli(['upgrade'], context(io, { available: false }))).toBe(1);
    expect(errors(io)).toContain('not available');
    expect(io.opened).toEqual([]);
  });

  it('does not sell Pro twice', async () => {
    await context(recordingIO()).manager.activate(await purchasedKey());
    world.stripe.calls.length = 0;
    const io = recordingIO();
    expect(await runProCli(['upgrade'], context(io))).toBe(0);
    expect(output(io)).toContain('already');
    expect(world.stripe.calls.filter((call) => call.startsWith('create:'))).toEqual([]);
  });
});

describe('timmy pro status', () => {
  it('reports masked key and features as JSON, never the token', async () => {
    const key = await purchasedKey();
    await context(recordingIO()).manager.activate(key);
    const io = recordingIO();
    expect(await runProCli(['status', '--json'], context(io))).toBe(0);
    const text = output(io);
    const report = JSON.parse(text);
    expect(report.active).toBe(true);
    expect(report.features).toEqual([...PRO_FEATURES]);
    expect(report.license).toBe(`tpro_${key.slice(5, 9)}…${key.slice(-4)}`);
    expect(text).not.toContain(key);
    expect(text).not.toContain('tpro1.');
    expect(text).not.toContain('"token"');
  });

  it('tells a free user how to get Pro', async () => {
    const io = recordingIO();
    expect(await runProCli([], context(io))).toBe(0);
    expect(output(io)).toContain('not active');
    expect(output(io)).toContain('timmy pro upgrade');
  });
});

describe('timmy pro activate, rotate, billing, deactivate', () => {
  it('activate reads the key from stdin with -', async () => {
    const io = recordingIO();
    io.stdin = `${await purchasedKey()}\n`;
    expect(await runProCli(['activate', '-'], context(io))).toBe(0);
    expect(output(io)).toContain('active until');
    expect(vault.read()?.key).toBe(io.stdin.trim());
  });

  it('activate refuses something that is not a key', async () => {
    const io = recordingIO();
    expect(await runProCli(['activate', 'tpro_nope'], context(io))).toBe(2);
    expect(errors(io)).toContain('not a Timmy Pro license key');
  });

  it('rotate prints the new key and the old one stops working', async () => {
    const oldKey = await purchasedKey();
    await context(recordingIO()).manager.activate(oldKey);
    const io = recordingIO();
    expect(await runProCli(['rotate'], context(io))).toBe(0);
    const newKey = vault.read()!.key;
    expect(newKey).not.toBe(oldKey);
    expect(output(io)).toContain(newKey);
    await expect(new HttpProService(world.origin, world.fetch).activate(oldKey)).rejects.toMatchObject({ status: 404 });
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
    await context(recordingIO()).manager.activate(await purchasedKey());
    const io = recordingIO();
    expect(await runProCli(['deactivate'], context(io))).toBe(0);
    expect(vault.read()).toBeNull();
    expect(output(io)).toContain('timmy pro billing');
  });
});

describe('usage', () => {
  it('rejects an unknown subcommand or flag with usage and exit 2', async () => {
    for (const argv of [['frobnicate'], ['status', '--frob']]) {
      const io = recordingIO();
      expect(await runProCli(argv, context(io)), argv.join(' ')).toBe(2);
      expect(errors(io)).toContain('Usage: timmy pro');
    }
  });
});
