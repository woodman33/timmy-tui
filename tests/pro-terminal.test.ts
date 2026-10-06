import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProCommand } from '../src/pro/terminal.js';
import { resolveTimmyHome } from '../src/utils/timmy-home.js';

let home: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'timmy-pro-terminal-'));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('runProCommand', () => {
  it('runs offline with nothing configured and reports Pro as not active', async () => {
    expect(await runProCommand(['status', '--json'], { TIMMY_HOME: home })).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      schemaVersion: 1, active: false, reason: 'no_license', nextStep: 'buy', licenseKeyMasked: null, serviceUrl: null, publicKeySource: null,
    });
  });

  it('refuses an insecure service URL before sending anything', async () => {
    expect(await runProCommand(['status'], { TIMMY_HOME: home, TIMMY_PRO_URL: 'http://example.com' })).toBe(2);
    expect(stderr.join('')).toContain('TIMMY_PRO_URL must use https');
  });

  it('answers --help and usage errors even when Pro is misconfigured', async () => {
    const misconfigured = { TIMMY_HOME: home, TIMMY_PRO_URL: 'http://example.com' };
    expect(await runProCommand(['--help'], misconfigured)).toBe(0);
    expect(stdout.join('')).toContain('Usage: timmy pro');
    expect(stderr.join('')).toBe('');
    expect(await runProCommand(['frobnicate'], misconfigured)).toBe(2);
    expect(stderr.join('')).toContain('timmy pro: unknown command "frobnicate"');
    expect(stderr.join('')).not.toContain('must use https');
  });

  it('refuses a public key that is not 32 raw bytes', async () => {
    expect(await runProCommand(['status'], { TIMMY_HOME: home, TIMMY_PRO_PUBLIC_KEY: 'too-short' })).toBe(2);
    expect(stderr.join('')).toContain('TIMMY_PRO_PUBLIC_KEY');
  });

  it('reads the license only from the TIMMY_HOME it is given', async () => {
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(join(elsewhere, 'pro'), { recursive: true });
    writeFileSync(join(elsewhere, 'pro', 'license.json'), JSON.stringify({ v: 1, key: 'tpro_ABCDEFGH-JKMNPQRS-TVWXYZ01-23456789', token: null, savedAt: 1 }));
    vi.stubEnv('TIMMY_HOME', elsewhere);
    expect(await runProCommand(['status', '--json'], { TIMMY_HOME: home })).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ reason: 'no_license', licenseKeyMasked: null });
  });
});

describe('resolveTimmyHome', () => {
  it('uses the given environment and never falls back to process.env', () => {
    vi.stubEnv('TIMMY_HOME', join(home, 'from-process'));
    expect(resolveTimmyHome({ TIMMY_HOME: join(home, 'given') })).toBe(join(home, 'given'));
    expect(resolveTimmyHome({})).toBe(join(homedir(), 'timmy'));
  });
});
