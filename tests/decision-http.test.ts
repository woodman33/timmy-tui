/**
 * Round R4 (H120): the two HTTP transports against FAKE services on 127.0.0.1 (node:http), the only network these tests
 * use. The Workers AI transport is pointed at the FAKE endpoint through the provider's internal base-URL override (tests
 * only; the default stays api.cloudflare.com). The FAKE service checks the path, the Bearer header and the body's shape;
 * afterwards no file Timmy wrote may hold the token or the account id.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decideDo } from '../src/decision/cli.js';
import { clefConfigPath } from '../src/decision/config.js';
import { decide } from '../src/decision/service.js';
import { DEFAULT_DECISION_SETTINGS } from '../src/decision/settings.js';
import type { DecisionInput } from '../src/decision/types.js';
import { decisionLines } from '../src/decision/view.js';
import { allFiles, FAKE_ACCOUNT, FAKE_TOKEN, fakeTokenFile, gitProject, readFixture } from './fixtures/clef-omni/fake.js';

interface Seen { method?: string; url?: string; auth?: string; ctype?: string; body: Record<string, unknown> }
let server: http.Server;
let base = '';
let seen: Seen[] = [];
let answer: (s: Seen) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* checked below */ }
      const s: Seen = { method: req.method, url: req.url, auth: req.headers.authorization, ctype: req.headers['content-type'], body };
      seen.push(s);
      const a = answer(s);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

/** fetch, refusing anything but this computer: no test may reach a network. */
const loopbackOnly = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url);
  if (!u.startsWith('http://127.0.0.1:')) throw new Error(`test refused a non-loopback address: ${u}`);
  return fetch(u, init);
}) as typeof fetch;

const ON = { ...DEFAULT_DECISION_SETTINGS, useClef: true };
let root: string;
let secrets: string;
beforeEach(() => {
  seen = [];
  root = mkdtempSync(join(tmpdir(), 'timmy-decide-http-'));
  secrets = mkdtempSync(join(tmpdir(), 'timmy-decide-secret-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(secrets, { recursive: true, force: true });
  rmSync(clefConfigPath(), { force: true });
});

const writeConfig = (body: unknown): void => {
  const file = clefConfigPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
};

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  kind: 'route', operationId: 'o5555aaaa', project: { root, revision: 'rev-http' },
  instructions: 'Which runtime should take this task?', state: { task: 'FAKE: tidy the docs' },
  options: [
    { id: 'codex', label: 'Codex', description: 'Codex CLI', available: true },
    { id: 'pi', label: 'Pi', description: 'Pi', available: true },
    { id: 'openhands', label: 'OpenHands', description: 'OpenHands', available: true },
  ],
  deterministic: { option: 'pi', rule: 'the existing route' },
  ...over,
});

const expectNoSecretsIn = (dir: string): void => {
  const files = allFiles(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    expect(f.text, f.file).not.toContain(FAKE_TOKEN);
    expect(f.text, f.file).not.toContain(FAKE_ACCOUNT);
    expect(f.text, f.file).not.toContain(base);
  }
};

describe('Workers AI REST against a FAKE endpoint on 127.0.0.1', () => {
  it('POSTs to the model path with the Bearer token and the published body; the answer becomes a recommendation', async () => {
    writeConfig({ transport: 'workers-ai', account_id: FAKE_ACCOUNT, token_file: fakeTokenFile(secrets) });
    answer = () => ({ status: 200, body: readFixture('envelope-route-ok.json') });
    const rec = await decide(input(), { settings: ON, fetch: loopbackOnly, baseUrl: base, budget: { remainingUsd: 0.01 } });
    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s.method).toBe('POST');
    expect(s.url).toBe(`/client/v4/accounts/${FAKE_ACCOUNT}/ai/run/@cf/cloudflare/clef-omni`);
    expect(s.auth).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(s.ctype).toMatch(/^application\/json/);
    expect(s.body.model).toBe('clef-omni');
    expect(s.body.state).toEqual({ task: 'FAKE: tidy the docs' });
    const q = s.body.questions as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
    expect(Object.keys(q)).toEqual(['route', 'human_review']);
    expect(q.route.type).toBe('choice');
    expect(Object.keys(q.route.criteria)).toEqual(['codex', 'pi', 'openhands', 'needs_review']);
    expect(q.human_review.type).toBe('noul');
    expect(q.human_review.instructions.length).toBeGreaterThan(0);
    expect(s.body).not.toHaveProperty('images');

    expect(rec.outcome).toBe('recommend');
    expect(rec.recommendation?.option).toBe('codex');
    expect(rec.provider).toMatchObject({ transport: 'workers-ai', endpoint: 'workers-ai-rest', paid: true, local: false, model: 'clef-omni' });
    expect(rec.usage).toEqual({ input_tokens: 812, output_tokens: 0 });
    expect(rec.response?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expectNoSecretsIn(join(root, '.timmy'));
    const words = decisionLines(rec).map((l) => l.text).join('\n');
    expect(words).not.toContain(FAKE_TOKEN);
    expect(words).not.toContain(FAKE_ACCOUNT);
  });

  it('HTTP 500 that echoes the token and the account id: a fallback, and neither is kept anywhere', async () => {
    writeConfig({ transport: 'workers-ai', account_id: FAKE_ACCOUNT, token_file: fakeTokenFile(secrets) });
    answer = (s) => ({ status: 500, body: { success: false, result: null, errors: [{ code: 10000, message: `FAKE: ${s.auth} may not use /accounts/${FAKE_ACCOUNT}` }] } });
    const rec = await decide(input(), { settings: ON, fetch: loopbackOnly, baseUrl: base, budget: { remainingUsd: 0.01 } });
    expect(seen).toHaveLength(1);
    expect(rec.outcome).toBe('fallback');
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'unavailable', option: 'pi' });
    expect(rec.fallback.reason).toMatch(/HTTP 500/);
    expectNoSecretsIn(join(root, '.timmy'));
  });

  it('a token file others can read is refused before any call, in words that never hold the token', async () => {
    const file = fakeTokenFile(secrets);
    const { chmodSync } = await import('node:fs');
    chmodSync(file, 0o644);
    writeConfig({ transport: 'workers-ai', account_id: FAKE_ACCOUNT, token_file: file });
    answer = () => ({ status: 200, body: readFixture('envelope-route-ok.json') });
    const rec = await decide(input(), { settings: ON, fetch: loopbackOnly, baseUrl: base, budget: { remainingUsd: 0.01 } });
    expect(seen).toHaveLength(0);
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'unavailable' });
    expect(rec.fallback.reason).toMatch(/can be read or changed by others/);
    expectNoSecretsIn(join(root, '.timmy'));
  });
});

describe('SystemOne (self-hosted, Jev/SystemOne-compatible) on 127.0.0.1', () => {
  it('POSTs the same body to /v1/systemone; free and local, so local-only and free-only both allow it', async () => {
    writeConfig({ transport: 'systemone', systemone_url: base });
    answer = () => ({ status: 200, body: readFixture('response-route-ok.json') });
    const rec = await decide(input(), { settings: ON, fetch: loopbackOnly, policy: { localOnly: true, freeOnly: true } });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/v1/systemone');
    expect(seen[0].auth).toBeUndefined();
    expect((seen[0].body.questions as Record<string, unknown>).route).toBeDefined();
    expect(rec.outcome).toBe('recommend');
    expect(rec.provider).toMatchObject({ transport: 'systemone', endpoint: 'systemone-loopback', paid: false, local: true });
    expect(rec.cost).toMatchObject({ measured: false, estimate_usd: 0 });
    expectNoSecretsIn(join(root, '.timmy'));
  });

  it('with a token file it sends the Bearer token, and still keeps it out of the record', async () => {
    writeConfig({ transport: 'systemone', systemone_url: base, token_file: fakeTokenFile(secrets) });
    answer = () => ({ status: 200, body: readFixture('response-route-tie.json') });
    const rec = await decide(input(), { settings: ON, fetch: loopbackOnly });
    expect(seen[0].auth).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(rec.outcome).toBe('abstain');
    expectNoSecretsIn(join(root, '.timmy'));
  });
});

describe('the CLI path over HTTP', () => {
  it('timmy decide route --json through the FAKE Workers AI endpoint: one JSON line, no secret in it or in the files', async () => {
    const p = gitProject('timmy-decide-http-cli-');
    try {
      writeConfig({ transport: 'workers-ai', account_id: FAKE_ACCOUNT, token_file: fakeTokenFile(secrets) });
      answer = () => ({ status: 200, body: readFixture('envelope-route-ok.json') });
      const args = ['route', '--option', 'codex:Codex', '--option', 'pi', '--option', 'openhands', '--deterministic', 'codex', '--project', p.root, '--budget-usd', '0.01', '--json'];
      const out = await decideDo(args, { env: { ...process.env, TIMMY_CLEF: '1' }, fetch: loopbackOnly, baseUrl: base });
      expect(out.code).toBe(0);
      expect(out.json).toMatchObject({ schema: 'timmy.decision/1', ok: true, outcome: 'recommend', exit_code: 0 });
      const text = JSON.stringify(out.json) + out.lines.join('\n');
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain(FAKE_ACCOUNT);
      expectNoSecretsIn(join(p.root, '.timmy'));
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});
