import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProConfigError, resolveProSettings } from '../src/pro/settings.js';

const HOME = join('/tmp', 'timmy-home-fixture');
const EMPTY_BUILD = { serviceUrl: '', publicKey: '' };

describe('resolveProSettings', () => {
  it('uses env over build values and builds the license path', () => {
    const settings = resolveProSettings(
      { TIMMY_PRO_URL: 'https://env.example.com', TIMMY_PRO_PUBLIC_KEY: 'env-key' },
      HOME,
      { serviceUrl: 'https://build.example.com', publicKey: 'build-key' },
    );
    expect(settings).toEqual({
      serviceUrl: 'https://env.example.com',
      publicKey: 'env-key',
      publicKeySource: 'env',
      licensePath: join(HOME, 'pro', 'license.json'),
    });
  });

  it('falls back to build values when env values are blank', () => {
    const settings = resolveProSettings(
      { TIMMY_PRO_URL: '   ', TIMMY_PRO_PUBLIC_KEY: '' },
      HOME,
      { serviceUrl: 'https://build.example.com', publicKey: 'build-key' },
    );
    expect(settings.serviceUrl).toBe('https://build.example.com');
    expect(settings.publicKey).toBe('build-key');
    expect(settings.publicKeySource).toBe('build');
  });

  it('allows https and loopback http, strips a trailing slash', () => {
    const url = (value: string) => resolveProSettings({ TIMMY_PRO_URL: value }, HOME, EMPTY_BUILD).serviceUrl;
    expect(url('https://pro.example.com/')).toBe('https://pro.example.com');
    expect(url('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(url('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(url('http://[::1]:8787')).toBe('http://[::1]:8787');
  });

  it('refuses plain http to a remote host', () => {
    expect(() => resolveProSettings({ TIMMY_PRO_URL: 'http://example.com' }, HOME, EMPTY_BUILD)).toThrow(ProConfigError);
  });

  it('refuses a URL with a path, query, credentials, another scheme, or no URL at all', () => {
    for (const value of ['https://example.com/api', 'https://example.com/?x=1', 'https://user:pw@example.com', 'ftp://example.com', 'not a url']) {
      expect(() => resolveProSettings({ TIMMY_PRO_URL: value }, HOME, EMPTY_BUILD), value).toThrow(ProConfigError);
    }
  });

  it('reports nothing configured when env and build are empty', () => {
    const settings = resolveProSettings({}, HOME, EMPTY_BUILD);
    expect(settings.serviceUrl).toBeNull();
    expect(settings.publicKey).toBeNull();
    expect(settings.publicKeySource).toBeNull();
  });
});
