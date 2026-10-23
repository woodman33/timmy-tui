import { describe, it, expect } from 'vitest';
import { detectRoboflow, roboflowUpload } from '../src/utils/roboflow.js';

describe('roboflow connector', () => {
  it('reports honest status without configuration', () => {
    delete process.env.ROBOFLOW_API_KEY;
    const st = detectRoboflow();
    expect(st.key).toBe(false);
    expect(st.via).toBe('not configured');
  });

  it('degrades honestly on upload without a key', async () => {
    delete process.env.ROBOFLOW_API_KEY;
    const r = await roboflowUpload('demo-north');
    expect(r.ok).toBe(false);
    expect(r.uploaded).toBe(0);
    expect(r.reason).toContain('ROBOFLOW_API_KEY');
  });
});

// R11 (H170; Phase 0 item 3): the key never enters a URL (a URL lands in logs, histories and error text); it goes in the
// Authorization header, as src/vision/platform.ts sends it. A FAKE fetch records every request; nothing leaves this process.
import { afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('roboflow upload: the key is never in a URL', () => {
  const keyBefore = process.env.ROBOFLOW_API_KEY;
  let dir = '';
  afterEach(() => {
    vi.unstubAllGlobals();
    if (keyBefore === undefined) delete process.env.ROBOFLOW_API_KEY; else process.env.ROBOFLOW_API_KEY = keyBefore;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('sends the key in the Authorization header only; every URL asked is free of it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'timmy-roboflow-url-'));
    const gens = join(dir, 'studio', 'demo-north', 'gens');
    mkdirSync(gens, { recursive: true });
    writeFileSync(join(gens, 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=', 'base64'));
    writeFileSync(join(gens, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const key = 'FAKE-roboflow-key-never-sent-h170';
    process.env.ROBOFLOW_API_KEY = key;
    const asked: Array<{ url: string; auth: string | null; type: string }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const form = init?.body as FormData;
      asked.push({ url, auth: headers.get('authorization'), type: (form.get('file') as Blob).type });
      return new Response('{"success":true}', { status: 200 });
    });
    const r = await roboflowUpload('demo-north', dir);
    expect(r).toEqual({ ok: true, uploaded: 2, reason: undefined });
    expect(asked).toHaveLength(2);
    for (const a of asked) {
      expect(a.url).toBe('https://api.roboflow.com/dataset/timmy-demo-north/upload');
      expect(a.url).not.toContain(key);
      expect(a.url).not.toMatch(/api_key/);
      expect(a.auth).toBe(`Bearer ${key}`);
    }
    expect(asked.map((a) => a.type).sort()).toEqual(['image/jpeg', 'image/png']);
    // the repository's own text: no URL with an api_key query is built anywhere in the two Roboflow paths
    const { readFileSync } = await import('node:fs');
    for (const file of ['src/utils/roboflow.ts', 'src/vision/platform.ts', 'src/utils/roboflow-adapter.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/[?&]api_key=/);
    }
  });
});
