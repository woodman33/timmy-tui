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
import { decide, decideBatch } from '../src/decision/service.js';
import { DEFAULT_DECISION_SETTINGS } from '../src/decision/settings.js';
import type { DecisionInput, DecisionRecord } from '../src/decision/types.js';
import { readClefConfig } from '../src/decision/config.js';
import { callDecisionTool } from '../src/decision/mcp.js';
import { ClefOmniProvider, providerFromConfig } from '../src/decision/provider.js';
import { FAKE_TOKEN, fakeAnswer, fakeTokenFile, gitProject } from './fixtures/clef-omni/fake.js';

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

/** A FAKE answer to every choice question a request asks: its first option 71%, the rest sharing 29%; human_review 10%. */
function answerFor(body: string, model: string): Record<string, unknown> {
  let questions: Record<string, { type?: string; criteria?: Record<string, string> }> = {};
  try { questions = (JSON.parse(body) as { questions?: typeof questions }).questions ?? {}; } catch { /* answered as empty */ }
  const scored: Record<string, Record<string, number>> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type !== 'choice' || !q.criteria) continue;
    const ids = Object.keys(q.criteria);
    scored[id] = Object.fromEntries(ids.map((o, i) => [o, i === 0 ? 0.71 : 0.29 / (ids.length - 1)]));
  }
  return fakeAnswer(scored, { model, usage: { input_tokens: 812, output_tokens: 0 } });
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
      if (req.method === 'POST' && path === '/v1/systemone') { send(200, { ...answerFor(raw, state.answerModel), ...state.extra }); return; }
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
const ON = { ...DEFAULT_DECISION_SETTINGS, useClef: true };
const MCP_OPTIONS = [{ id: 'codex', label: 'Codex' }, { id: 'pi' }, { id: 'openhands' }];

type Rec = Record<string, any>;
/** A refusal recorded as a decision: the deterministic path with its reason, never something that looks like a model's answer. */
const expectRefusal = (j: Rec, reason: RegExp): void => {
  expect(j).toMatchObject({ ok: true, exit_code: 0, outcome: 'fallback', fallback: { used: true, option: 'pi' } });
  expect(String(j.fallback.reason)).toMatch(reason);
  for (const k of ['distribution', 'recommendation', 'judge', 'response', 'latencyMs', 'usage']) expect(j, k).not.toHaveProperty(k);
  expect(j.cost).toMatchObject({ measured: false, estimate_usd: 0, basis: 'no call was made' });
};

// R9 step 1 committed these as it.fails, because each failed on the code before (the FAKE was called: POST /v1/systemone, the
// https FAKE with the token as Bearer; the body named clef-omni). Step 3 made them pass.
describe('the SystemOne pricing defect (each of these failed on the code before R9: the FAKE was called)', () => {
  it('no pricing declared: free only refuses before anything is sent, through the CLI and the MCP tool', async () => {
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

  it('no pricing declared: a budget cannot be checked against it, so nothing is sent', async () => {
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

  it('an https SystemOne address (a FAKE paid service, through the fetch seam) with a token file: refused, and the token is never sent', async () => {
    const env = configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', token_file: fakeTokenFile(secrets) });
    const free = await decideDo(route('--free-only'), { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    expectRefusal(free.json, /^free only: the pricing of d1-ultra on the SystemOne endpoint on another computer is unknown/);
    const budgeted = await decideDo(route('--budget-usd', '1', '--operation', 'o0000f00d'), { env, fetch: seam(fake) });
    expectRefusal(budgeted.json, /^unknown pricing cannot be checked against the budget, so no call is made/);
    expect(fake.requests).toEqual([]);
    expect(JSON.stringify([free, budgeted])).not.toContain(FAKE_TOKEN);
  });

  it('a declared price is budgeted with its billing: a per-question price over what is left is refused before anything is sent', async () => {
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

  it('a localhost address whose model is a cloud tag is never free, even declared {"free": "local"}: refused, with why', async () => {
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

  it('explicitly configured local inference still works: clef-flash:latest on 127.0.0.1 declared {"free": "local"}, under free only and local only', async () => {
    const env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing: { free: 'local' } });
    const out = await decideDo(route('--free-only', '--local-only'), { env, fetch: seam(fake) });
    expect(out.json).toMatchObject({ ok: true, outcome: 'recommend', recommendation: { option: 'codex' } });
    expect(fake.inference()).toHaveLength(1);
    expect(JSON.parse(fake.inference()[0].body)).toMatchObject({ model: 'clef-flash:latest' });
    expect(out.json.provider).toMatchObject({ id: 'systemone:clef-flash:latest', transport: 'systemone', endpoint: 'systemone-loopback', paid: false, local: true, pricing: { kind: 'free-local' } });
    expect(JSON.stringify(out.json)).not.toMatch(/clef-omni/);
    expect(out.json.cost).toMatchObject({ measured: false, estimate_usd: 0 });
  });
});

describe('pricing is declared in clef.json, never inferred (the config and the provider\'s description)', () => {
  const read = (clef: Record<string, unknown>) => readClefConfig(configure(clef));
  const described = (clef: Record<string, unknown>) => providerFromConfig(readClefConfig(configure(clef))).describe();

  it('systemone names its model; pricing is one of the two declared shapes, and nothing else is read as pricing', () => {
    expect(read({ transport: 'systemone', systemone_url: fake.base })).toMatchObject({ state: 'invalid', why: expect.stringMatching(/systemone needs model: the model the deployment serves, as it names it \(for example clef-flash:latest\); Timmy never assumes one/) });
    const ok = read({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing: { free: 'local' }, limits: { questions: 8 } });
    expect(ok).toMatchObject({ state: 'configured', config: { model: 'clef-flash:latest', pricing: { free: 'local' }, limits: { questions: 8 } } });
    expect(read({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', pricing: { usd_per_million_input: 2, billing: 'per-question' } }))
      .toMatchObject({ state: 'configured', config: { pricing: { usd_per_million_input: 2, billing: 'per-question' } } });
    const refused: Array<[unknown, RegExp]> = [
      [{ free: 'yes' }, /pricing\.free must be "local"/],
      [{ free: true }, /pricing\.free must be "local"/],
      [{ usd_per_million_input: 0, billing: 'per-request' }, /a price of 0 is not a price: an endpoint that charges nothing is declared \{"free": "local"\}/],
      [{ usd_per_million_input: -1, billing: 'per-request' }, /above 0/],
      [{ usd_per_million_input: 1 }, /pricing must be \{"free": "local"\} or \{"usd_per_million_input"/],
      [{ usd_per_million_input: 1, billing: 'per-token' }, /pricing\.billing must be "per-request" or "per-question"/],
      [{ free: 'local', usd_per_million_input: 1, billing: 'per-request' }, /and nothing else/],
      ['free', /pricing must be/],
      [{ self_hosted: true }, /pricing must be/],
    ];
    for (const [pricing, why] of refused) expect(read({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing }), JSON.stringify(pricing)).toMatchObject({ state: 'invalid', why: expect.stringMatching(why) });
    expect(read({ transport: 'systemone', systemone_url: fake.base, model: 'clef flash' })).toMatchObject({ state: 'invalid', why: expect.stringMatching(/model must be the model's name/) });
    expect(read({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', limits: { questions: 1 } })).toMatchObject({ state: 'invalid', why: expect.stringMatching(/limits\.questions must be a whole number from 2 to 64/) });
    expect(read({ transport: 'workers-ai', account_id: 'FAKEaccount0000tests', token_file: fakeTokenFile(secrets), pricing: { free: 'local' } }))
      .toMatchObject({ state: 'invalid', why: expect.stringMatching(/workers-ai runs on Cloudflare's hardware, not yours: \{"free": "local"\} cannot be declared for it/) });
    expect(read({ transport: 'workers-ai', account_id: 'FAKEaccount0000tests', token_file: fakeTokenFile(secrets), model: 'clef-omni' }))
      .toMatchObject({ state: 'invalid', why: expect.stringMatching(/a Workers AI model id \(@cf\/<namespace>\/<name>\)/) });
  });

  it('nothing is free by its transport, its address or a label: only {"free": "local"} is, and never for a cloud model tag', () => {
    const undeclared = [
      { transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest' },
      { transport: 'systemone', systemone_url: 'http://localhost:11434', model: 'clef-flash:latest' },
      { transport: 'systemone', systemone_url: PAID_FAKE, model: 'jev-1' },
      { transport: 'workers-ai', account_id: 'FAKEaccount0000tests', token_file: fakeTokenFile(secrets) },
    ];
    for (const c of undeclared) {
      const d = described(c);
      expect(d.pricing, JSON.stringify(c)).toMatchObject({ kind: 'unknown', words: 'unknown: clef.json declares none' });
      expect(d.paid, JSON.stringify(c)).toBe(true);
    }
    const local = described({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing: { free: 'local' } });
    expect(local).toMatchObject({ id: 'systemone:clef-flash:latest', model: 'clef-flash:latest', requestModel: 'clef-flash:latest', endpoint: 'systemone-loopback', paid: false, local: true, cloudModel: false, pricing: { kind: 'free-local' } });
    // hardware the operator controls, on another computer: free as declared, and still not local (local only refuses it)
    expect(described({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', pricing: { free: 'local' } })).toMatchObject({ endpoint: 'systemone-remote', paid: false, local: false, pricing: { kind: 'free-local' } });
    for (const model of ['kimi-k3:cloud', 'nemotron-3-nano:30b-cloud', 'gpt-oss:120b-cloud']) {
      const d = described({ transport: 'systemone', systemone_url: fake.base, model, pricing: { free: 'local' } });
      expect(d, model).toMatchObject({ endpoint: 'systemone-loopback', paid: true, local: false, cloudModel: true, pricing: { kind: 'unknown' } });
      expect(d.pricing.why, model).toMatch(new RegExp(`^${model}.*is a cloud model tag .*it is never free, even though clef\\.json declares \\{"free": "local"\\}`));
    }
    const paid = described({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', pricing: { usd_per_million_input: 2, billing: 'per-question' } });
    expect(paid).toMatchObject({ paid: true, local: false, pricing: { kind: 'paid', usd_per_million_input: 2, billing: 'per-question', words: '$2 per million input tokens, billed per question (declared in clef.json)' } });
  });

  it('the provider id names the model; clef-omni appears only when Clef-Omni is the model; its published limits are Clef-Omni\'s alone', () => {
    const wa = described({ transport: 'workers-ai', account_id: 'FAKEaccount0000tests', token_file: fakeTokenFile(secrets), pricing: { usd_per_million_input: 0.15, billing: 'per-request' } });
    expect(wa).toMatchObject({ id: 'workers-ai:@cf/cloudflare/clef-omni', model: '@cf/cloudflare/clef-omni', requestModel: 'clef-omni', paid: true, local: false, pricing: { kind: 'paid', billing: 'per-request' }, limits: { source: 'published', questions: 64, media: true } });
    // an undeclared Workers AI Clef-Omni says what its page publishes, and stays unknown
    expect(described({ transport: 'workers-ai', account_id: 'FAKEaccount0000tests', token_file: fakeTokenFile(secrets) }).pricing.why).toMatch(/the model page publishes \$0\.15 per million input tokens for @cf\/cloudflare\/clef-omni, billed per request: declare it if that is your price/);
    for (const model of ['clef-flash:latest', 'jev-1', 'd1-ultra']) {
      const d = described({ transport: 'systemone', systemone_url: fake.base, model, pricing: { free: 'local' } });
      expect(d.id).toBe(`systemone:${model}`);
      expect(JSON.stringify(d), model).not.toMatch(/clef-omni|Clef-Omni's published/i);
      expect(d.limits, model).toMatchObject({ source: 'default', questions: 2, media: false });
      expect(d.limits.words, model).toMatch(/limits are not published here and clef\.json states none: a conservative default applies/);
    }
    expect(described({ transport: 'systemone', systemone_url: fake.base, model: 'clef-omni', pricing: { free: 'local' } })).toMatchObject({ id: 'systemone:clef-omni', limits: { source: 'published', questions: 64 } });
    expect(described({ transport: 'systemone', systemone_url: fake.base, model: 'd1-ultra', limits: { questions: 8, context_tokens: 32000 } }).limits).toMatchObject({ source: 'config', questions: 8, contextTokens: 32000, media: false });
    expect(new ClefOmniProvider({ transport: 'fixture' }).describe()).toMatchObject({ id: 'fixture:clef-omni', paid: false, local: true, pricing: { kind: 'no-call' } });
    const none = providerFromConfig(readClefConfig({ ...process.env, TIMMY_HOME: join(home, 'nothing-here') })).describe();
    expect(none).toMatchObject({ id: 'none', available: false, pricing: { kind: 'no-call' } });
    expect(JSON.stringify(none)).not.toMatch(/clef-omni/i);
  });
});

describe('refusals before inference, and the estimate at the declared price and billing', () => {
  const ROUTE_ANSWER_TOKENS = 812;

  it('a declared price is asked within its budget: per question bills the whole input once for each question', async () => {
    const costs: Record<string, Rec> = {};
    for (const billing of ['per-request', 'per-question'] as const) {
      const env = configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', token_file: fakeTokenFile(secrets), pricing: { usd_per_million_input: 2, billing } });
      const before = fake.inference().length;
      const out = await decideDo(route('--budget-usd', '1', '--operation', billing === 'per-request' ? 'o0000aaa1' : 'o0000aaa2'), { env, fetch: seam(fake) });
      expect(out.json).toMatchObject({ ok: true, outcome: 'recommend', provider: { id: 'systemone:d1-ultra', endpoint: 'systemone-remote', paid: true, local: false, pricing: { kind: 'paid', usd_per_million_input: 2, billing } } });
      expect(fake.inference()).toHaveLength(before + 1);
      const sent = fake.inference()[before];
      expect(JSON.parse(sent.body)).toMatchObject({ model: 'd1-ultra' });
      // the declared, budgeted call is the one that carries the token
      expect(sent.auth).toBe(`Bearer ${FAKE_TOKEN}`);
      costs[billing] = out.json.cost;
    }
    expect(costs['per-request'].measured).toBe(false);
    expect(costs['per-question'].estimate_usd).toBeCloseTo(costs['per-request'].estimate_usd * 2, 12);
    expect(costs['per-request'].basis).toMatch(/^an estimate, not a measured cost: ~\d+ input tokens at \$2 per million input tokens, billed per request, the price clef\.json declares/);
    expect(costs['per-question'].basis).toMatch(/billed per question \(2 questions\): \d+ tokens billed, the price clef\.json declares/);
    expect(costs['per-question'].basis).toMatch(new RegExp(`the service reported ${ROUTE_ANSWER_TOKENS} input tokens, \\$${((ROUTE_ANSWER_TOKENS * 2 * 2) / 1e6).toFixed(6).replace('.', '\\.')} at the declared price`));
  });

  it('{"free": "local"} on another computer (hardware the operator controls): free only allows it, local only refuses it', async () => {
    const env = configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'jev-1', pricing: { free: 'local' } });
    const local = await decideDo(route('--local-only'), { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    expectRefusal(local.json, /^local only: the SystemOne deployment on another computer runs off this computer, so it is not asked$/);
    const free = await decideDo(route('--free-only', '--operation', 'o0000aaa3'), { env, fetch: seam(fake) });
    expect(free.json).toMatchObject({ outcome: 'recommend', provider: { id: 'systemone:jev-1', paid: false, local: false, pricing: { kind: 'free-local' } }, cost: { measured: false, estimate_usd: 0 } });
    expect(free.json.cost.basis).toMatch(/^declared free in clef\.json/);
    expect(fake.inference()).toHaveLength(1);
  });

  it('a declared price with no budget is refused before anything is sent, as paid inference always was', async () => {
    const env = configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', pricing: { usd_per_million_input: 2, billing: 'per-request' } });
    const out = await decideDo(route(), { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    expectRefusal(out.json, /^paid inference needs a budget; none was given, so no paid call is made$/);
    expect(out.json.fallback.reasonKind).toBe('budget');
  });
});

/** A FAKE digest: 64 hex digits that are no model's. */
const FAKE_DIGEST = 'fa4e'.repeat(16);
/** A FAKE Ollama list, as GET /api/tags gives one. */
const tagsListing = (...models: Array<{ name: string; digest?: unknown; remote_host?: string }>) => ({
  models: models.map((m) => ({ name: m.name, model: m.name, size: 1234, ...(m.digest !== undefined ? { digest: m.digest } : {}), details: { parameter_size: 'FAKE' } })),
});
const OPTIONS3 = [
  { id: 'codex', label: 'Codex', description: 'Codex CLI', available: true },
  { id: 'pi', label: 'Pi', description: 'Pi', available: true },
  { id: 'openhands', label: 'OpenHands', description: 'OpenHands', available: true },
];

describe('the model\'s identity, exact', () => {
  it('keeps the model asked for, the model and version the answer names, and the local digest from Ollama\'s list (GET /api/tags, no inference)', async () => {
    fake.set({ tags: tagsListing({ name: 'other:7b', digest: 'b0b0'.repeat(16) }, { name: 'clef-flash:latest', digest: FAKE_DIGEST }), extra: { model_version: '2026-10-01-FAKE', version: 3 } });
    const env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing: { free: 'local' } });
    const out = await decideDo(route('--free-only', '--local-only'), { env, fetch: seam(fake) });
    expect(out.json.model).toEqual({
      requested: 'clef-flash:latest', request_model: 'clef-flash:latest', returned: 'clef-flash:latest', version: { model_version: '2026-10-01-FAKE', version: '3' },
      digest: FAKE_DIGEST, digest_source: 'Ollama\'s list on this computer (GET /api/tags; no inference)',
      limits: { source: 'default', questions: 2, words: expect.stringMatching(/^clef-flash:latest's limits are not published here and clef\.json states none: a conservative default applies/) },
    });
    expect(out.json.provider).toMatchObject({ id: 'systemone:clef-flash:latest', model: 'clef-flash:latest' });
    // exactly the read-only list and the scoring path: never a chat or text-generation endpoint
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/tags', 'POST /v1/systemone']);
    expect(fake.requests[0].auth).toBeUndefined();
    expect(fake.requests[0].body).toBe('');
    expect(JSON.stringify(out.json)).not.toMatch(/clef-omni/i);
  });

  it('a model the list does not name, an endpoint that is not Ollama, or one off this computer: the digest is "not available", with why', async () => {
    const cases: Array<{ clef: Record<string, unknown>; tags?: unknown; why: RegExp }> = [
      { clef: { systemone_url: fake.base }, tags: tagsListing({ name: 'other:7b', digest: FAKE_DIGEST }), why: /^Ollama's list on this computer \(GET \/api\/tags\) does not name clef-flash:latest$/ },
      { clef: { systemone_url: fake.base }, tags: tagsListing({ name: 'clef-flash:latest', digest: 'not-a-digest' }), why: /names clef-flash:latest without a sha256 digest$/ },
      { clef: { systemone_url: fake.base }, tags: { FAKE: 'not a list' }, why: /answered GET \/api\/tags without a list of models, as Ollama gives one$/ },
      { clef: { systemone_url: fake.base }, tags: undefined, why: /^the endpoint on this computer answered GET \/api\/tags with HTTP 404: it does not list models as Ollama does$/ },
      { clef: { systemone_url: PAID_FAKE }, tags: tagsListing({ name: 'clef-flash:latest', digest: FAKE_DIGEST }), why: /^the endpoint is not on this computer, so there is no local digest to read$/ },
    ];
    for (const [i, c] of cases.entries()) {
      fake.set({ tags: c.tags });
      const before = fake.requests.length;
      const env = configure({ transport: 'systemone', model: 'clef-flash:latest', pricing: { free: 'local' }, ...c.clef });
      const out = await decideDo(route('--operation', `o0000ab${String(i).padStart(2, '0')}`), { env, fetch: seam(fake) });
      expect(out.json.outcome, String(i)).toBe('recommend');
      expect(out.json.model, String(i)).toMatchObject({ requested: 'clef-flash:latest', digest: 'not available', digest_source: expect.stringMatching(c.why) });
      // the address is never in the record's words
      expect(JSON.stringify(out.json.model)).not.toContain(fake.base);
      const paths = fake.requests.slice(before).map((r) => r.path);
      expect(paths, String(i)).toEqual(c.clef.systemone_url === PAID_FAKE ? ['/v1/systemone'] : ['/api/tags', '/v1/systemone']);
    }
    // a refusal reads no list at all: nothing was sent
    const env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest' });
    const before = fake.requests.length;
    const refused = await decideDo(route('--free-only', '--operation', 'o0000abff'), { env, fetch: seam(fake) });
    expect(fake.requests.length).toBe(before);
    expect(refused.json.model).toMatchObject({ requested: 'clef-flash:latest', digest: 'not available', digest_source: 'no call was made, so no model list was read' });
  });

  it('an answer that names another model is recorded and said: "asked for X; the answer names Y"', async () => {
    fake.set({ answerModel: 'clef-omni' });
    const env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing: { free: 'local' } });
    const out = await decideDo(route(), { env, fetch: seam(fake) });
    expect(out.json.model).toMatchObject({ requested: 'clef-flash:latest', returned: 'clef-omni', differs: 'asked for clef-flash:latest; the answer names clef-omni' });
    expect(out.json.provider.id).toBe('systemone:clef-flash:latest');
    // an untagged name and its :latest are the same model; Workers AI's Clef-Omni answering "clef-omni" is what was asked
    fake.set({ answerModel: 'clef-flash' });
    const same = await decideDo(route('--operation', 'o0000ac01'), { env, fetch: seam(fake) });
    expect(same.json.model).not.toHaveProperty('differs');
  });

  it('Clef-Omni\'s published limits apply to Clef-Omni; another model gets its stated limits, or a conservative default, said as such', async () => {
    const batch = (n: number, op: string): DecisionInput[] => Array.from({ length: n }, (_, i) => ({
      kind: 'route', operationId: op, project: { root: project.root, revision: project.head }, questionId: `task-${i}`,
      instructions: `Which runtime should take FAKE task ${i}?`, options: OPTIONS3, state: { tasks: n }, deterministic: { option: 'pi', rule: 'the existing route' },
    }));
    const run = async (clef: Record<string, unknown>, op: string): Promise<{ posts: number; questions: number[]; records: DecisionRecord[] }> => {
      const before = fake.inference().length;
      const env = configure({ transport: 'systemone', systemone_url: fake.base, pricing: { free: 'local' }, ...clef });
      const results = await decideBatch(batch(3, op), { settings: ON, env, fetch: seam(fake), currentRevision: project.head });
      const sent = fake.inference().slice(before);
      return { posts: sent.length, questions: sent.map((r) => Object.keys((JSON.parse(r.body) as { questions: object }).questions).length), records: results.map((r) => r.record) };
    };
    const flash = await run({ model: 'clef-flash:latest' }, 'o0000ad01');
    expect(flash).toMatchObject({ posts: 3, questions: [2, 2, 2] });
    expect(flash.records[0].model?.limits).toMatchObject({ source: 'default', questions: 2 });
    const stated = await run({ model: 'clef-flash:latest', limits: { questions: 8 } }, 'o0000ad02');
    expect(stated).toMatchObject({ posts: 1, questions: [4] });
    expect(stated.records[0].model?.limits.words).toMatch(/^clef-flash:latest's limits as clef\.json states them: 8 questions a request, no context stated; no media \(media limits are published only for Clef-Omni\)$/);
    const omni = await run({ model: 'clef-omni' }, 'o0000ad03');
    expect(omni).toMatchObject({ posts: 1, questions: [4] });
    expect(omni.records[0].model?.limits).toMatchObject({ source: 'published', questions: 64, words: expect.stringMatching(/^Clef-Omni's published limits: 64 questions a request/) });
    expect(omni.records[0].provider.id).toBe('systemone:clef-omni');
  });

  it('media goes only to a model whose media limits are published: another model gets none, said so', async () => {
    const png = join(project.root, 'FAKE-shot.png');
    writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const media = [{ path: png, kind: 'image' as const, contentType: 'image/png', width: 4, height: 4, private: false }];
    const settings = { ...ON, allowCloudAnalysis: true };
    const one = (op: string): DecisionInput => ({ kind: 'route', operationId: op, project: { root: project.root, revision: project.head }, instructions: 'Which runtime?', options: OPTIONS3, state: {}, media, deterministic: { option: 'pi', rule: 'the existing route' } });
    let env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing: { free: 'local' } });
    const flash = await decide(one('o0000ae01'), { settings, env, fetch: seam(fake), currentRevision: project.head });
    expect(flash.inputs.media[0]).toMatchObject({ sent: false, reason: 'clef-flash:latest\'s media limits are not published here: no media item is sent' });
    expect(JSON.parse(fake.inference()[0].body)).not.toHaveProperty('images');
    env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-omni', pricing: { free: 'local' } });
    const omni = await decide(one('o0000ae02'), { settings, env, fetch: seam(fake), currentRevision: project.head });
    expect(omni.inputs.media[0]).toMatchObject({ sent: true });
    expect((JSON.parse(fake.inference()[1].body) as { images?: unknown[] }).images).toHaveLength(1);
  });
});
