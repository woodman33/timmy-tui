import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-docs-refresh-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('docs mirror refresh boundary', () => {
  it('importing the refresh function starts no fetch or store write', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('unexpected network')));
    vi.stubGlobal('fetch', fetch);
    vi.resetModules();
    const module = await import('../scripts/forge-docs-mirror.js');
    expect(module.refreshDocsMirror).toBeTypeOf('function');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the previous mirror when either source fails', async () => {
    const { refreshDocsMirror } = await import('../scripts/forge-docs-mirror.js');
    const root = fixture();
    const target = join(root, '.timmy', 'forge', 'docs-mirror.json');
    mkdirSync(join(root, '.timmy', 'forge'), { recursive: true });
    const previous = '{"previous":"byte-for-byte"}\n';
    writeFileSync(target, previous);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      url.endsWith('openapi.json') ? '{"paths":{}}' : 'unavailable',
      { status: url.endsWith('openapi.json') ? 200 : 503 },
    )));
    await expect(refreshDocsMirror(root)).rejects.toThrow('HTTP 503');
    expect(readFileSync(target, 'utf8')).toBe(previous);
  });

  it('explicit refresh writes both successfully fetched sources', async () => {
    const { refreshDocsMirror } = await import('../scripts/forge-docs-mirror.js');
    const root = fixture();
    const openapi = { paths: { '/fixture': { post: { requestBody: { content: {
      'application/json': { schema: { required: ['mode'], properties: {
        mode: { type: 'string', enum: ['fixture'] },
      } } },
    } } } } } };
    const fetch = vi.fn(async (url: string) => new Response(url.endsWith('openapi.json') ? JSON.stringify(openapi) : 'fixture index'));
    vi.stubGlobal('fetch', fetch);
    const target = await refreshDocsMirror(root);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({
      doc_index: 'fixture index', endpoints: { '/fixture': { required: ['mode'], enums: { mode: ['fixture'] } } },
    });
  });
});
