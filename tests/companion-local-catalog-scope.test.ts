/**
 * R12 (the finish brief: "close the two-user connection-result regression across cached results … project scope and
 * provider/endpoint configuration changes; private cache scope must include the server-verified principal/project/configuration
 * identity"): the local Ollama's answer the Chat's view keeps for a moment (src/companion/chat-view.ts companionCatalog) is kept
 * per principal, per project and per configuration — one person's answer is never served to another, nor to another project, nor
 * after the Ollama address changed.
 *
 * FAKE, labelled: two Ollama stand-ins on 127.0.0.1 (no model behind them) that answer /api/tags and /api/show and count the
 * /api/tags requests they get; each stand-in names its models after itself, so an answer says which server it came from.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { companionCatalog, forgetLocalCatalog, localCatalogKey } from '../src/companion/chat-view.js';

interface Stand { server: Server; port: number; tags: number }
function standIn(name: string): Promise<Stand> {
  return new Promise((resolve) => {
    const s: Stand = { server: createServer(), port: 0, tags: 0 };
    s.server.on('request', (req, res) => {
      const json = (o: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/tags') { s.tags += 1; json({ models: [{ name: `${name}-fake:latest`, model: `${name}-fake:latest`, size: 1_000_000, details: { format: 'gguf', family: 'fake', parameter_size: '1B', quantization_level: 'Q4_K_M' } }] }); return; }
      if (req.url === '/api/show') { json({ capabilities: ['completion', 'tools'], model_info: { 'general.context_length': 8192 }, details: { format: 'gguf', family: 'fake', parameter_size: '1B', quantization_level: 'Q4_K_M' } }); return; }
      if (req.url === '/api/ps') { json({ models: [] }); return; }
      if (req.url === '/api/version') { json({ version: '0.0.0-fake' }); return; }
      res.writeHead(404); res.end();
    });
    s.server.listen(0, '127.0.0.1', () => { s.port = (s.server.address() as AddressInfo).port; resolve(s); });
  });
}

describe('the local Ollama answer the Chat keeps is private to its principal, project and configuration (R12)', () => {
  let a: Stand;
  let b: Stand;
  let home = '';
  beforeAll(async () => { a = await standIn('alpha'); b = await standIn('beta'); home = mkdtempSync(join(tmpdir(), 'r12-local-scope-')); });
  afterAll(() => { a.server.close(); b.server.close(); rmSync(home, { recursive: true, force: true }); });
  beforeEach(() => { forgetLocalCatalog(); a.tags = 0; b.tags = 0; });
  const envAt = (s: Stand): Record<string, string | undefined> => ({ ...process.env, TIMMY_HOME: home, OLLAMA_HOST: `127.0.0.1:${s.port}`, OLLAMA_BASE_URL: undefined, TIMMY_CHAT_MODEL: undefined });

  it('two principals with the same env each get their own answer (the second is asked again, never served the first)', async () => {
    const env = envAt(a);
    const first = await companionCatalog('ollama-local', env, { scope: { principal: 'user:A', project: '/p/one' } });
    expect(first.rows.map((r) => r.id), first.error ?? first.words).toEqual(['alpha-fake:latest']);
    expect(a.tags).toBe(1);
    await companionCatalog('ollama-local', env, { scope: { principal: 'user:B', project: '/p/one' } });
    expect(a.tags).toBe(2);
    // A again within the moment: A's own kept answer
    await companionCatalog('ollama-local', env, { scope: { principal: 'user:A', project: '/p/one' } });
    expect(a.tags).toBe(2);
  });

  it('another project of the same principal is asked again', async () => {
    const env = envAt(a);
    await companionCatalog('ollama-local', env, { scope: { principal: 'operator', project: '/p/one' } });
    await companionCatalog('ollama-local', env, { scope: { principal: 'operator', project: '/p/two' } });
    expect(a.tags).toBe(2);
  });

  it('a changed Ollama address is asked at once (no answer of the old address is kept for the new one)', async () => {
    const scope = { principal: 'operator', project: '/p/one' };
    const before = await companionCatalog('ollama-local', envAt(a), { scope });
    const after = await companionCatalog('ollama-local', envAt(b), { scope });
    expect(before.rows.map((r) => r.id)).toEqual(['alpha-fake:latest']);
    expect(after.rows.map((r) => r.id)).toEqual(['beta-fake:latest']);
    expect([a.tags, b.tags]).toEqual([1, 1]);
  });

  it('the key names the principal, the project and the resolved address; a page with no scope reads as the operator', () => {
    const k = JSON.parse(localCatalogKey(envAt(a), { principal: 'user:A', project: '/p/one' })) as string[];
    expect(k[0]).toBe('user:A');
    expect(k[1]).toBe('/p/one');
    expect(k[3]).toContain(String(a.port));
    expect(JSON.parse(localCatalogKey(envAt(a)))[0]).toBe('operator');
  });
});
