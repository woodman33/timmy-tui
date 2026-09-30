import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadDocsMirror, endpointConstraints } from '../src/forge/higgsfield/docs.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// fixture mirror written into <dir>/.timmy/forge/docs-mirror.json (match real
// store-root resolution under an explicit dir)
const FIXTURE = {
  fetched_ts: '2026-09-17T00:00:00Z',
  sources: ['https://example.test/docs'],
  endpoints: {
    '/v1/image2video/dop': {
      params: {
        duration: { type: 'number', max: 15 },
        aspect_ratio: { type: 'enum', choices: ['16:9', '9:16'] },
      },
    },
  },
};

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-docs-'));
  mkdirSync(join(dir, '.timmy', 'forge'), { recursive: true });
  writeFileSync(join(dir, '.timmy', 'forge', 'docs-mirror.json'), JSON.stringify(FIXTURE), 'utf8');
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('docs mirror', () => {
  it('loads fixture mirror and returns endpoint constraints', () => {
    const dir = fixtureDir();
    const mirror = loadDocsMirror(dir);
    expect(mirror).not.toBeNull();
    expect(mirror!.fetched_ts).toBe('2026-09-17T00:00:00Z');
    const c = endpointConstraints(dir, '/v1/image2video/dop');
    expect(c.params?.duration).toMatchObject({ type: 'number', max: 15 });
    // enums are derived from params entries carrying choices/enum arrays
    expect(c.enums?.aspect_ratio).toContain('9:16');
  });

  it('returns empty constraints for unknown endpoint', () => {
    const dir = fixtureDir();
    expect(endpointConstraints(dir, '/v1/unknown')).toEqual({});
  });

  it('endpointConstraints works with the default dir arg', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // TIMMY_STORE pins the store root for the default (cwd) dir resolution
    const dir = mkdtempSync(join(tmpdir(), 'forge-docs-default-dir-'));
    mkdirSync(join(dir, 'forge'), { recursive: true });
    writeFileSync(join(dir, 'forge', 'docs-mirror.json'), JSON.stringify(FIXTURE), 'utf8');
    vi.stubEnv('TIMMY_STORE', dir);
    try {
      const c = endpointConstraints(undefined, '/v1/image2video/dop');
      expect(c.params?.duration).toMatchObject({ type: 'number', max: 15 });
      expect(c.enums?.aspect_ratio).toContain('9:16');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null mirror and empty constraints when absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'forge-docs-absent-'));
    expect(loadDocsMirror(dir)).toBeNull();
    expect(endpointConstraints(dir, '/v1/image2video/dop')).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it('tolerates a malformed mirror without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'forge-docs-broken-'));
    mkdirSync(join(dir, '.timmy', 'forge'), { recursive: true });
    writeFileSync(join(dir, '.timmy', 'forge', 'docs-mirror.json'), '{not json', 'utf8');
    expect(loadDocsMirror(dir)).toBeNull();
    expect(endpointConstraints(dir, '/v1/image2video/dop')).toEqual({});
    expect(warn).toHaveBeenCalled();
  });
});
