/**
 * R9 (H162): the SystemOne pricing defect, reproduced against FAKE SystemOne servers on 127.0.0.1 (node:http), and the rule
 * that fixes it: pricing is declared in clef.json, never inferred from the transport's name, a self-hosted label or a
 * loopback address; unknown pricing is refused under free only and whenever a budget applies; a cloud model tag is never
 * free, even declared free; every refusal is made before a byte is sent. Each FAKE counts every request it receives and
 * keeps its body, so "nothing was sent" is a count of 0, not a belief.
 *
 * The https FAKE is reached through the existing fetch seam (DecideCliContext.fetch): its address names a FAKE paid service
 * (systemone.fake-paid.example), and the seam carries it to the FAKE on 127.0.0.1. No real decision service, hosted or
 * local, is called, and nothing here reaches a network.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideDo } from '../src/decision/cli.js';
import { callDecisionTool } from '../src/decision/mcp.js';
import { FAKE_TOKEN, fakeTokenFile, gitProject, readFixture } from './fixtures/clef-omni/fake.js';

interface FakeRequest { method: string; path: string; auth?: string; body: string }
interface FakeSystemOne {
  base: string;
  /** every request it received, in order, with its body */
  requests: FakeRequest[];
  /** the inference requests among them (POST /v1/systemone) */
  inference: () => FakeRequest[];
  /** what its answers name as their model, and what GET /api/tags lists (undefined: 404, as a server that is not Ollama) */
  set: (o: { answerModel?: string; tags?: unknown; extra?: Record<string, unknown> }) => void;
  close: () => Promise<void>;
}

/** A FAKE SystemOne deployment on 127.0.0.1: POST /v1/systemone answers a FAKE route answer; GET /api/tags lists FAKE models when told to. */
async function fakeSystemOne(): Promise<FakeSystemOne> {
  const requests: FakeRequest[] = [];
  const state: { answerModel: string; tags?: unknown; extra: Record<string, unknown> } = { answerModel: 'clef-flash:latest', extra: {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      requests.push({ method: req.method ?? '', path, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body: raw });
      const send = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && path === '/v1/systemone') { send(200, { ...readFixture('response-route-ok.json'), model: state.answerModel, ...state.extra }); return; }
      if (req.method === 'GET' && path === '/api/tags' && state.tags !== undefined) { send(200, state.tags); return; }
      send(404, { error: 'FAKE: no such route' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    inference: () => requests.filter((r) => r.method === 'POST' && r.path === '/v1/systemone'),
    set: (o) => { if (o.answerModel !== undefined) state.answerModel = o.answerModel; if ('tags' in o) state.tags = o.tags; if (o.extra) state.extra = o.extra; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The FAKE paid service's address: never resolved; the seam below carries it to the FAKE on 127.0.0.1. */
const PAID_FAKE = 'https://systemone.fake-paid.example';

/** The fetch seam: the FAKE paid address goes to the FAKE on 127.0.0.1, a loopback address goes as is, anything else is refused. */
const seam = (fake: FakeSystemOne): typeof fetch => ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.startsWith(PAID_FAKE)) return fetch(`${fake.base}${u.slice(PAID_FAKE.length)}`, init);
  if (u.startsWith('http://127.0.0.1:')) return fetch(u, init);
  throw new Error(`the FAKE seam refused an address that is not this test's: ${u}`);
}) as typeof fetch;

let fake: FakeSystemOne;
let home: string;
let secrets: string;
let project: ReturnType<typeof gitProject>;
beforeEach(async () => {
  fake = await fakeSystemOne();
  home = mkdtempSync(join(tmpdir(), 'timmy-price-home-'));
  secrets = mkdtempSync(join(tmpdir(), 'timmy-price-secret-'));
  project = gitProject('timmy-price-proj-');
});
afterEach(async () => {
  await fake.close();
  for (const d of [home, secrets, project.root]) rmSync(d, { recursive: true, force: true });
});

/** Timmy's home for this test, with decision/clef.json as given; decision-model routing on (TIMMY_CLEF=1) for this process only. */
const configure = (clef: Record<string, unknown>): Record<string, string | undefined> => {
  mkdirSync(join(home, 'decision'), { recursive: true });
  writeFileSync(join(home, 'decision', 'clef.json'), JSON.stringify(clef));
  return { ...process.env, TIMMY_HOME: home, TIMMY_CLEF: '1' };
};
const route = (...more: string[]): string[] => ['route', '--option', 'codex:Codex', '--option', 'pi', '--option', 'openhands', '--deterministic', 'pi', '--project', project.root, ...more, '--json'];
const MCP_OPTIONS = [{ id: 'codex', label: 'Codex' }, { id: 'pi' }, { id: 'openhands' }];

type Rec = Record<string, any>;
/** A refusal recorded as a decision: the deterministic path with its reason, never something that looks like a model's answer. */
const expectRefusal = (j: Rec, reason: RegExp): void => {
  expect(j).toMatchObject({ ok: true, exit_code: 0, outcome: 'fallback', fallback: { used: true, option: 'pi' } });
  expect(String(j.fallback.reason)).toMatch(reason);
  for (const k of ['distribution', 'recommendation', 'judge', 'response', 'latencyMs', 'usage']) expect(j, k).not.toHaveProperty(k);
  expect(j.cost).toMatchObject({ measured: false, estimate_usd: 0, basis: 'no call was made' });
};

// R9 step 1: marked it.fails, because each fails on this code (the FAKE is called: POST /v1/systemone, the https FAKE with the
// token as Bearer; the body names clef-omni). The fix makes them pass and turns them into it().
describe('the SystemOne pricing defect (each of these failed on the code before R9: the FAKE was called)', () => {
  it.fails('no pricing declared: free only refuses before anything is sent, through the CLI and the MCP tool', async () => {
    const env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest' });
    const out = await decideDo(route('--free-only'), { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    expectRefusal(out.json, /^free only: the pricing of clef-flash:latest on the SystemOne endpoint on this computer is unknown \(clef\.json declares no pricing for clef-flash:latest/);
    expect(String(out.json.fallback.reason)).toMatch(/unknown pricing is never taken as free, and no call is made$/);
    expect(out.lines.join('\n')).toMatch(/^Why: free only: the pricing of clef-flash:latest .* is unknown/m);
    const mcp = await callDecisionTool('timmy_decide_route', { options: MCP_OPTIONS, deterministic: 'pi', project: project.root, free_only: true, operation: 'o0000beef' }, { env, fetch: seam(fake) });
    expectRefusal(mcp, /^free only: the pricing of clef-flash:latest .* is unknown/);
    expect(fake.requests).toEqual([]);
  });

  it.fails('no pricing declared: a budget cannot be checked against it, so nothing is sent', async () => {
    const env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest' });
    const out = await decideDo(route('--budget-usd', '5'), { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    expectRefusal(out.json, /^unknown pricing cannot be checked against the budget, so no call is made: the pricing of clef-flash:latest .* is unknown/);
    expect(out.json.fallback.reasonKind).toBe('pricing');
    // and with neither free only nor a budget: a call that may cost money needs a budget, so it is refused too
    const bare = await decideDo(route('--operation', 'o0000f00d'), { env, fetch: seam(fake) });
    expectRefusal(bare.json, /^the pricing of clef-flash:latest .* is unknown \(.*\): a call that may cost money needs a budget, and unknown pricing cannot be checked against one, so no call is made$/);
    expect(fake.requests).toEqual([]);
  });

  it.fails('an https SystemOne address (a FAKE paid service, through the fetch seam) with a token file: refused, and the token is never sent', async () => {
    const env = configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', token_file: fakeTokenFile(secrets) });
    const free = await decideDo(route('--free-only'), { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    expectRefusal(free.json, /^free only: the pricing of d1-ultra on the SystemOne endpoint on another computer is unknown/);
    const budgeted = await decideDo(route('--budget-usd', '1', '--operation', 'o0000f00d'), { env, fetch: seam(fake) });
    expectRefusal(budgeted.json, /^unknown pricing cannot be checked against the budget, so no call is made/);
    expect(fake.requests).toEqual([]);
    expect(JSON.stringify([free, budgeted])).not.toContain(FAKE_TOKEN);
  });

  it.fails('a declared price is budgeted with its billing: a per-question price over what is left is refused before anything is sent', async () => {
    const env = configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', pricing: { usd_per_million_input: 2, billing: 'per-question' } });
    const out = await decideDo(route('--budget-usd', '0.000001'), { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    expectRefusal(out.json, /is more than the \$0\.000001 left of the budget/);
    expect(out.json.fallback.reasonKind).toBe('budget');
    expect(String(out.json.fallback.reason)).toMatch(/\$2 per million input tokens, billed per question \(2 questions\)/);
    // free only refuses a declared price before the budget is weighed
    const free = await decideDo(route('--free-only', '--budget-usd', '5', '--operation', 'o0000f00d'), { env, fetch: seam(fake) });
    expectRefusal(free.json, /^free only: d1-ultra on the SystemOne endpoint on another computer is declared paid \(\$2 per million input tokens, billed per question\)/);
    expect(fake.requests).toEqual([]);
  });

  it.fails('a localhost address whose model is a cloud tag is never free, even declared {"free": "local"}: refused, with why', async () => {
    let env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'kimi-k3:cloud', pricing: { free: 'local' } });
    const free = await decideDo(route('--free-only'), { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    expectRefusal(free.json, /^free only: the pricing of kimi-k3:cloud on the SystemOne endpoint on this computer is unknown \(kimi-k3:cloud is a cloud model tag .*it is never free, even though clef\.json declares \{"free": "local"\}/);
    const budgeted = await decideDo(route('--budget-usd', '5', '--operation', 'o0000f00d'), { env, fetch: seam(fake) });
    expectRefusal(budgeted.json, /^unknown pricing cannot be checked against the budget, so no call is made: .*kimi-k3:cloud is a cloud model tag/);
    env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'nemotron-3-nano:30b-cloud', pricing: { free: 'local' } });
    const local = await decideDo(route('--local-only', '--operation', 'o0000d00d'), { env, fetch: seam(fake) });
    expectRefusal(local.json, /^local only: nemotron-3-nano:30b-cloud is a cloud model tag: the SystemOne endpoint on this computer sends it to a cloud, so it is not asked$/);
    expect(fake.requests).toEqual([]);
  });

  it.fails('explicitly configured local inference still works: clef-flash:latest on 127.0.0.1 declared {"free": "local"}, under free only and local only', async () => {
    const env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing: { free: 'local' } });
    const out = await decideDo(route('--free-only', '--local-only'), { env, fetch: seam(fake) });
    expect(out.json).toMatchObject({ ok: true, outcome: 'recommend', recommendation: { option: 'codex' } });
    expect(fake.inference()).toHaveLength(1);
    expect(JSON.parse(fake.inference()[0].body)).toMatchObject({ model: 'clef-flash:latest' });
    expect(out.json.provider).toMatchObject({ id: 'systemone:clef-flash:latest', transport: 'systemone', endpoint: 'systemone-loopback', paid: false, local: true, pricing: { kind: 'free-local' } });
    expect(out.json.model).toMatchObject({ requested: 'clef-flash:latest', returned: 'clef-flash:latest' });
    expect(JSON.stringify(out.json)).not.toMatch(/clef-omni/);
    expect(out.json.cost).toMatchObject({ measured: false, estimate_usd: 0 });
  });
});
