import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProCommand } from '../src/pro/runtime.js';

let home: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'timmy-pro-runtime-'));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('runProCommand', () => {
  it('runs offline with nothing configured and reports Pro as not active', async () => {
    expect(await runProCommand(['status', '--json'], { TIMMY_HOME: home })).toBe(0);
    const report = JSON.parse(stdout.join(''));
    expect(report).toMatchObject({ active: false, reason: 'not_activated', license: null, service: null, publicKey: null });
  });

  it('refuses an insecure service URL before sending anything', async () => {
    expect(await runProCommand(['status'], { TIMMY_HOME: home, TIMMY_PRO_URL: 'http://example.com' })).toBe(2);
    expect(stderr.join('')).toContain('TIMMY_PRO_URL must use https');
  });

  it('refuses a public key that is not 32 raw bytes', async () => {
    expect(await runProCommand(['status'], { TIMMY_HOME: home, TIMMY_PRO_PUBLIC_KEY: 'too-short' })).toBe(2);
    expect(stderr.join('')).toContain('TIMMY_PRO_PUBLIC_KEY');
  });
});
