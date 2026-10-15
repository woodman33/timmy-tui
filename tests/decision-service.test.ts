/**
 * Round R4 (H120): the decision service (src/decision/service.ts), offline. Clef-Omni only scores options Timmy built; an
 * abstention goes to a person; every failure falls back to the deterministic path the caller named, its reason recorded;
 * the same request is decided once. Answers come from the FAKE fixtures (tests/fixtures/clef-omni) or a fetch the test
 * supplies; nothing here reaches a network.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClefRequest } from '../src/decision/clef-contract.js';
import { admission } from '../src/decision/policy.js';
import { ClefOmniProvider } from '../src/decision/provider.js';
import { decide, decideDetailed, listDecisions, readDecision } from '../src/decision/service.js';
import { DEFAULT_DECISION_SETTINGS, type DecisionSettings } from '../src/decision/settings.js';
import { claimPath } from '../src/decision/store.js';
import type { AdmissionChecks, DecisionInput, DecisionOption, DecisionProvider, DecisionRecord } from '../src/decision/types.js';
import { allFiles, FAKE_ACCOUNT, FAKE_TOKEN, fakeAnswer, fakeTokenFile, fixture, readFixture, writeFake } from './fixtures/clef-omni/fake.js';

const ON: DecisionSettings = { ...DEFAULT_DECISION_SETTINGS, useClef: true };

const OPTIONS: DecisionOption[] = [
  { id: 'codex', label: 'Codex', description: 'Codex CLI in its sandbox', available: true },
  { id: 'pi', label: 'Pi', description: 'The Pi coding agent', available: true },
  { id: 'openhands', label: 'OpenHands', description: 'OpenHands in Docker', available: true },
];

let root: string;
let scratch: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'timmy-decide-svc-'));
  scratch = mkdtempSync(join(tmpdir(), 'timmy-decide-scratch-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  kind: 'route',
  operationId: 'o1234abcd',
  project: { root, revision: 'rev-1' },
  instructions: 'Which runtime should take this task?',
  options: OPTIONS,
  state: { task: 'FAKE: fix the failing test' },
  deterministic: { option: 'codex', rule: 'the existing route (codex first)' },
  ...over,
});

/** A provider that counts its calls and keeps each request (around any provider). */
function counted(inner: DecisionProvider): { calls: ClefRequest[]; provider: DecisionProvider } {
  const calls: ClefRequest[] = [];
  return {
    calls,
    provider: { id: inner.id, describe: () => inner.describe(), decide: (req, o) => { calls.push(req); return inner.decide(req, o); } },
  };
}
const fixtureProvider = (): { calls: ClefRequest[]; provider: DecisionProvider } => counted(new ClefOmniProvider({ transport: 'fixture' }));

/** The paid, remote Workers AI transport with a fetch the test supplies (no network). */
function workersAi(f: typeof fetch): DecisionProvider {
  return new ClefOmniProvider({ transport: 'workers-ai', config: { transport: 'workers-ai', account_id: FAKE_ACCOUNT, token_file: fakeTokenFile(scratch) }, fetch: f });
}
function fetchReturning(status: number, body: unknown): { seen: string[]; fetch: typeof fetch } {
  const seen: string[] = [];
  const f = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetch: f };
}

const recordFiles = (): string[] => {
  try { return readdirSync(join(root, '.timmy', 'decisions')).filter((n) => /^d[0-9a-f]{8}\.json$/.test(n)); } catch { return []; }
};

describe('a recommendation', () => {
  it('recommends the leader, keeps one record (0600) and calls it a recommendation, never evidence', async () => {
    const { calls, provider } = fixtureProvider();
    const r = await decideDetailed(input(), { settings: ON, provider, fixture: fixture('response-route-ok.json') });
    const rec = r.record;
    expect(r.reused).toBe(false);
    expect(rec.schema).toBe('timmy.decision/1');
    expect(rec.id).toMatch(/^d[0-9a-f]{8}$/);
    expect(rec.kind).toBe('route');
    expect(rec.outcome).toBe('recommend');
    expect(rec.recommendation).toMatchObject({ option: 'codex', label: 'Codex' });
    expect(rec.judge?.kind).toBe('recommend');
    expect(rec.distribution).toEqual({ codex: 0.71, pi: 0.17, openhands: 0.09, needs_review: 0.03 });
    expect(rec.humanReview).toBe(0.12);
    expect(rec.fallback).toMatchObject({ used: false, option: 'codex', rule: 'the existing route (codex first)' });
    expect(rec.evidence_kind).toBe('machine_inference');
    expect(rec.note).toBe('a model recommendation, not evidence');
    expect(rec.provider).toMatchObject({ transport: 'fixture', endpoint: 'fixture-file', model: 'clef-omni', paid: false, local: true });
    expect(rec.usage).toEqual({ input_tokens: 812, output_tokens: 0 });
    expect(rec.cost).toMatchObject({ measured: false, estimate_usd: 0 });
    expect(rec.operationId).toBe('o1234abcd');
    expect(rec.project.revision).toBe('rev-1');
    expect(rec.thresholds).toEqual({ minTop: 0.6, minMargin: 0.15 });
    expect(rec.options.permitted.map((o) => o.id)).toEqual(['codex', 'pi', 'openhands']);
    expect(rec.options.excluded).toEqual([]);
    expect(rec.inputs.state.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof rec.latencyMs).toBe('number');
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual(['route', 'human_review']);
    expect(calls[0].questions.route).toMatchObject({ type: 'choice', instructions: 'Which runtime should take this task?' });
    expect(Object.keys((calls[0].questions.route as { criteria: Record<string, string> }).criteria)).toEqual(['codex', 'pi', 'openhands', 'needs_review']);
    expect(calls[0].questions.human_review.type).toBe('noul');
    expect(calls[0].model).toBe('clef-omni');
    expect(calls[0].state).toEqual({ task: 'FAKE: fix the failing test' });
    const file = join(root, '.timmy', 'decisions', `${rec.id}.json`);
    expect(r.file).toBe(join('.timmy', 'decisions', `${rec.id}.json`));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readDecision(root, rec.id)).toEqual({ ok: true, record: rec });
    expect(listDecisions(root).map((d) => d.id)).toEqual([rec.id]);
    expect(listDecisions(root, { operationId: 'o1234abcd' })).toHaveLength(1);
    expect(listDecisions(root, { operationId: 'o00000000' })).toEqual([]);
    expect(readDecision(root, 'not-an-id').ok).toBe(false);
    expect(readDecision(root, 'd00000000').ok).toBe(false);
  });

  it('reads the answer out of the Workers AI envelope too', async () => {
    const rec = await decide(input(), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('envelope-route-ok.json') });
    expect(rec.outcome).toBe('recommend');
    expect(rec.recommendation?.option).toBe('codex');
  });

  it('with "Require review before dispatch" on (the default), the recommendation waits for a person', async () => {
    const rec = await decide(input(), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('response-route-ok.json') });
    expect(rec.admission.needsReview).toBe(true);
    expect(rec.admission.admitted).toBe(false);
    expect(rec.admission.of).toBe('recommendation');
    expect(rec.admission.reasons.join('; ')).toMatch(/Require review before dispatch/);
    expect(rec.admission.reasons.join('; ')).toMatch(/not supplied/);
    expect(rec.admission.checked).toEqual({ projectScope: 'not supplied', privacy: 'not supplied', budget: 'not supplied', concurrency: 'not supplied', isolation: 'not supplied', approvals: 'not supplied' });
  });
});

describe('an abstention goes to a person, with the deterministic option as the fallback proposal', () => {
  it.each([
    ['response-route-tie.json', /a tie between codex and pi/],
    ['response-route-low.json', /below the 60\.0% threshold/],
    ['response-route-needs-review.json', /ranked "needs review" first/],
  ])('%s', async (name, why) => {
    const { calls, provider } = fixtureProvider();
    const rec = await decide(input(), { settings: { ...ON, requireReview: false }, provider, fixture: fixture(name) });
    expect(calls).toHaveLength(1);
    expect(rec.outcome).toBe('abstain');
    expect(rec.recommendation).toBeUndefined();
    expect(rec.judge?.kind).toBe('abstain');
    if (rec.judge?.kind === 'abstain') expect(rec.judge.reason).toMatch(why);
    expect(rec.fallback).toMatchObject({ used: false, option: 'codex', rule: 'the existing route (codex first)' });
    expect(rec.admission).toMatchObject({ of: 'nothing', admitted: false, needsReview: true });
    expect(rec.distribution).toBeDefined();
  });
});

describe('every failure falls back to the deterministic path, with its reason recorded', () => {
  it.each([
    ['malformed-choice-not-argmax.json', /not the highest probability/],
    ['malformed-missing-answer.json', /no answer for "route"/],
    ['malformed-missing-probabilities.json', /probabilities missing/],
    ['malformed-negative.json', /not a number from 0 to 1/],
    ['malformed-sum.json', /sum to 1\.800/],
    ['malformed-unknown-option.json', /hermes/],
    ['malformed-wrong-type.json', /answered as score/],
  ])('a malformed answer: %s', async (name, why) => {
    const { calls, provider } = fixtureProvider();
    const rec = await decide(input(), { settings: ON, provider, fixture: fixture(name) });
    expect(calls).toHaveLength(1);
    expect(rec.outcome).toBe('fallback');
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'malformed', option: 'codex', rule: 'the existing route (codex first)' });
    expect(rec.fallback.reason).toMatch(why);
    expect(rec.distribution).toBeUndefined();
    expect(rec.recommendation).toBeUndefined();
    expect(rec.admission.of).toBe('fallback');
    expect(rec.admission.option).toBe('codex');
  });

  it('an option the model returns that was never offered is malformed, never a recommendation', async () => {
    const rec = await decide(input(), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('malformed-unknown-option.json') });
    expect(rec.outcome).toBe('fallback');
    expect(rec.fallback.reason).toMatch(/choice hermes was not offered/);
    expect(JSON.stringify(rec.options.permitted)).not.toContain('hermes');
  });

  it('an envelope that says success=false: the service is unavailable', async () => {
    const rec = await decide(input(), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('envelope-error.json') });
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'unavailable' });
    expect(rec.fallback.reason).toMatch(/success=false: FAKE: error from the fixture/);
  });

  it('a fixture file that is missing or is not JSON', async () => {
    const missing = await decide(input(), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: join(scratch, 'none.json') });
    expect(missing.fallback).toMatchObject({ used: true, reasonKind: 'unavailable' });
    const notJson = writeFake(scratch, 'x.json', 'placeholder');
    writeFileSync(notJson, 'secret words that are not JSON');
    const bad = await decide(input({ operationId: 'o1234abce' }), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: notJson });
    expect(bad.fallback).toMatchObject({ used: true, reasonKind: 'malformed' });
    expect(JSON.stringify(bad)).not.toContain('secret words');
  });

  it('HTTP 500 from the service', async () => {
    const { seen, fetch } = fetchReturning(500, { success: false, errors: [{ code: 1, message: 'FAKE outage' }] });
    const rec = await decide(input(), { settings: ON, provider: workersAi(fetch), budget: { remainingUsd: 1 } });
    expect(seen).toHaveLength(1);
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'unavailable', option: 'codex' });
    expect(rec.fallback.reason).toMatch(/HTTP 500/);
  });

  it('a timeout', async () => {
    const hanging = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    })) as typeof fetch;
    const t0 = Date.now();
    const rec = await decide(input(), { settings: { ...ON, timeoutMs: 60 }, provider: workersAi(hanging), budget: { remainingUsd: 1 } });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'timeout', option: 'codex' });
    expect(rec.fallback.reason).toMatch(/60 ms/);
  });

  it('a fetch that ignores its signal still cannot hold the decision past the timeout', async () => {
    const deaf = (() => new Promise<Response>(() => { /* never settles, never listens */ })) as typeof fetch;
    const t0 = Date.now();
    const rec = await decide(input(), { settings: { ...ON, timeoutMs: 60 }, provider: workersAi(deaf), budget: { remainingUsd: 1 } });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'timeout' });
  });

  it('a call the caller cancels, before or during it, is recorded as unavailable (cancelled)', async () => {
    const deaf = (() => new Promise<Response>(() => { /* never settles */ })) as typeof fetch;
    const before = new AbortController();
    before.abort();
    const early = await decide(input(), { settings: ON, provider: workersAi(deaf), budget: { remainingUsd: 1 }, signal: before.signal });
    expect(early.fallback).toMatchObject({ used: true, reasonKind: 'unavailable' });
    expect(early.fallback.reason).toMatch(/cancelled/);
    const during = new AbortController();
    setTimeout(() => during.abort(), 30);
    const late = await decide(input({ operationId: 'o1234abce' }), { settings: ON, provider: workersAi(deaf), budget: { remainingUsd: 1 }, signal: during.signal });
    expect(late.fallback.reason).toMatch(/cancelled/);
  });

  it('a network error', async () => {
    const broken = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const rec = await decide(input(), { settings: ON, provider: workersAi(broken), budget: { remainingUsd: 1 } });
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'unavailable' });
    expect(rec.fallback.reason).toMatch(/fetch failed/);
  });

  it('a provider that throws instead of answering is unavailable, and its claim is released', async () => {
    const throwing: DecisionProvider = {
      id: 'clef-omni:fixture', describe: () => new ClefOmniProvider({ transport: 'fixture' }).describe(),
      decide: async () => { throw new Error(`FAKE provider bug near ${FAKE_TOKEN.slice(0, 4)}`); },
    };
    const rec = await decide(input(), { settings: ON, provider: throwing });
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'unavailable', option: 'codex' });
    expect(rec.fallback.reason).toMatch(/the provider failed: FAKE provider bug/);
    expect(readdirSync(join(root, '.timmy', 'decisions', 'claims'))).toEqual([]);
  });

  it('"Use Clef routing" off: no model is asked', async () => {
    const { calls, provider } = fixtureProvider();
    const rec = await decide(input(), { settings: DEFAULT_DECISION_SETTINGS, provider, fixture: fixture('response-route-ok.json') });
    expect(calls).toHaveLength(0);
    expect(rec.outcome).toBe('fallback');
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'clef-off', option: 'codex' });
    expect(rec.fallback.reason).toMatch(/Use Clef routing/);
    expect(rec.cost).toMatchObject({ measured: false, estimate_usd: 0 });
  });

  it('local only refuses the remote transport, before any call', async () => {
    const { seen, fetch } = fetchReturning(200, readFixture('envelope-route-ok.json'));
    const rec = await decide(input(), { settings: ON, provider: workersAi(fetch), policy: { localOnly: true }, budget: { remainingUsd: 1 } });
    expect(seen).toHaveLength(0);
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'egress-denied', option: 'codex' });
    expect(rec.fallback.reason).toMatch(/local only/);
  });

  it('free only refuses the paid transport: no silent switch to paid inference', async () => {
    const { seen, fetch } = fetchReturning(200, readFixture('envelope-route-ok.json'));
    const rec = await decide(input(), { settings: ON, provider: workersAi(fetch), policy: { freeOnly: true }, budget: { remainingUsd: 1 } });
    expect(seen).toHaveLength(0);
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'egress-denied' });
    expect(rec.fallback.reason).toMatch(/free only/);
  });

  it('an exhausted budget, or no budget at all, refuses paid inference before the call', async () => {
    const { seen, fetch } = fetchReturning(200, readFixture('envelope-route-ok.json'));
    const spent = await decide(input(), { settings: ON, provider: workersAi(fetch), budget: { remainingUsd: 0 } });
    expect(spent.fallback).toMatchObject({ used: true, reasonKind: 'budget' });
    expect(spent.fallback.reason).toMatch(/left/);
    const none = await decide(input({ operationId: 'o1234abce' }), { settings: ON, provider: workersAi(fetch) });
    expect(none.fallback).toMatchObject({ used: true, reasonKind: 'budget' });
    expect(none.fallback.reason).toMatch(/budget/);
    expect(seen).toHaveLength(0);
  });

  it('within its budget the paid transport is asked, and the cost is an estimate, never measured', async () => {
    const { seen, fetch } = fetchReturning(200, readFixture('envelope-route-ok.json'));
    const rec = await decide(input(), { settings: ON, provider: workersAi(fetch), budget: { remainingUsd: 0.01 } });
    expect(seen).toHaveLength(1);
    expect(rec.outcome).toBe('recommend');
    expect(rec.provider).toMatchObject({ transport: 'workers-ai', endpoint: 'workers-ai-rest', paid: true, local: false, model: 'clef-omni' });
    expect(rec.cost.measured).toBe(false);
    expect(rec.cost.estimate_usd).toBeGreaterThan(0);
    expect(rec.cost.estimate_usd).toBeLessThan(0.01);
    expect(rec.cost.basis).toMatch(/0\.15/);
    expect(rec.cost.basis).toMatch(/estimate/);
  });

  it('a stale revision: the project moved on, so nothing is asked', async () => {
    const { calls, provider } = fixtureProvider();
    const rec = await decide(input(), { settings: ON, provider, fixture: fixture('response-route-ok.json'), currentRevision: () => 'rev-2' });
    expect(calls).toHaveLength(0);
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'stale-revision', option: 'codex' });
    expect(rec.fallback.reason).toMatch(/rev-2/);
    const same = await decide(input({ operationId: 'o1234abce' }), { settings: ON, provider, fixture: fixture('response-route-ok.json'), currentRevision: 'rev-1' });
    expect(same.outcome).toBe('recommend');
  });

  it('fewer than two permitted options: no model call; the deterministic path, with the others listed and why', async () => {
    const { calls, provider } = fixtureProvider();
    const opts = OPTIONS.map((o) => (o.id === 'codex' ? o : { ...o, available: false, unavailableReason: `${o.label} is not installed` }));
    const rec = await decide(input({ options: opts }), { settings: ON, provider, fixture: fixture('response-route-ok.json') });
    expect(calls).toHaveLength(0);
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'too-few-options', option: 'codex' });
    expect(rec.options.permitted.map((o) => o.id)).toEqual(['codex']);
    expect(rec.options.excluded).toEqual([
      { id: 'pi', label: 'Pi', reason: 'Pi is not installed' },
      { id: 'openhands', label: 'OpenHands', reason: 'OpenHands is not installed' },
    ]);
  });

  it('with no deterministic rule named and one option left, that option is the deterministic path; with none, a person decides', async () => {
    const one = OPTIONS.map((o) => (o.id === 'pi' ? o : { ...o, available: false }));
    const rec = await decide(input({ options: one, deterministic: undefined }), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }) });
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'too-few-options', option: 'pi', rule: 'the only available option' });
    const none = OPTIONS.map((o) => ({ ...o, available: false }));
    const nobody = await decide(input({ operationId: 'o1234abce', options: none, deterministic: undefined }), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }) });
    expect(nobody.fallback.option).toBeUndefined();
    expect(nobody.fallback.rule).toMatch(/a person chooses/);
    expect(nobody.admission).toMatchObject({ of: 'nothing', admitted: false, needsReview: true });
  });

  it('a deterministic option that is unavailable is not used; a person chooses', async () => {
    const opts = OPTIONS.map((o) => (o.id === 'codex' ? { ...o, available: false, unavailableReason: 'Codex is signed out' } : o));
    const rec = await decide(input({ options: opts }), { settings: DEFAULT_DECISION_SETTINGS, provider: new ClefOmniProvider({ transport: 'fixture' }) });
    expect(rec.fallback.used).toBe(true);
    expect(rec.fallback.option).toBeUndefined();
    expect(rec.fallback.rule).toMatch(/Codex is signed out/);
  });

  it('unresolved inputs: no revision, a repeated or reserved option id, a deterministic option never offered', async () => {
    const ctx = { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('response-route-ok.json') };
    const cases: Array<[Partial<DecisionInput>, RegExp]> = [
      [{ project: { root, revision: '' } }, /revision/],
      [{ options: [...OPTIONS, OPTIONS[0]] }, /codex.*more than once/],
      [{ options: [...OPTIONS, { id: 'needs_review', label: 'x', description: 'x', available: true }] }, /needs_review.*reserved/],
      [{ deterministic: { option: 'hermes', rule: 'old' } }, /hermes.*not one of the options/],
      [{ operationId: 'nope' }, /operation/],
      [{ instructions: '   ' }, /instructions/],
    ];
    for (const [over, why] of cases) {
      const rec = await decide(input(over), ctx);
      expect(rec.outcome).toBe('fallback');
      expect(rec.fallback.reasonKind).toBe('unresolved-inputs');
      expect(rec.fallback.reason).toMatch(why);
    }
  });

  it('no project folder, or one that does not exist: refused, nothing recorded anywhere (never the current folder)', async () => {
    const here = join(process.cwd(), '.timmy', 'decisions');
    const before = allFiles(here).map((f) => f.file);
    const ctx = { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('response-route-ok.json') };
    await expect(decide(input({ project: { root: undefined as unknown as string, revision: 'rev-1' } }), ctx)).rejects.toMatchObject({ refusal: 'not recorded', why: 'no project folder was given' });
    await expect(decide(input({ project: { root: join(scratch, 'gone'), revision: 'rev-1' } }), ctx)).rejects.toMatchObject({ refusal: 'not recorded' });
    expect(allFiles(here).map((f) => f.file)).toEqual(before);
    expect(allFiles(join(scratch, 'gone'))).toEqual([]);
  });

  it('no Clef config: the provider is unavailable', async () => {
    const rec = await decide(input(), { settings: ON });
    expect(rec.fallback).toMatchObject({ used: true, reasonKind: 'unavailable', option: 'codex' });
    expect(rec.fallback.reason).toMatch(/clef\.json/);
    expect(rec.provider.transport).toBe('none');
  });
});

describe('the allowed-choice set', () => {
  it('excluded options (unavailable, or forbidden by policy) are never shown to the model', async () => {
    const opts: DecisionOption[] = [
      ...OPTIONS.map((o) => (o.id === 'openhands' ? { ...o, available: false, unavailableReason: 'Docker is not running' } : o)),
      { id: 'hermes', label: 'Hermes', description: 'Hermes agent', available: true },
    ];
    const answer = writeFake(scratch, 'two.json', fakeAnswer({ route: { codex: 0.8, pi: 0.15, needs_review: 0.05 } }));
    const { calls, provider } = fixtureProvider();
    const rec = await decide(input({ options: opts }), { settings: ON, provider, fixture: answer, forbid: { hermes: 'policy: hermes is not allowed in this project' } });
    expect(rec.outcome).toBe('recommend');
    expect(Object.keys((calls[0].questions.route as { criteria: Record<string, string> }).criteria)).toEqual(['codex', 'pi', 'needs_review']);
    expect(JSON.stringify(calls[0])).not.toContain('hermes');
    expect(JSON.stringify(calls[0])).not.toContain('openhands');
    expect(rec.options.excluded).toEqual([
      { id: 'openhands', label: 'OpenHands', reason: 'Docker is not running' },
      { id: 'hermes', label: 'Hermes', reason: 'policy: hermes is not allowed in this project' },
    ]);
    expect(rec.options.needsReview).toEqual({ id: 'needs_review', label: 'A person should decide' });
  });

  it('an unavailable option given no reason still says why it is out', async () => {
    const opts = [...OPTIONS, { id: 'jcode', label: 'jcode', description: 'jcode', available: false }];
    const rec = await decide(input({ options: opts }), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('response-route-ok.json') });
    expect(rec.options.excluded).toEqual([{ id: 'jcode', label: 'jcode', reason: 'unavailable (no reason was given)' }]);
  });
});

describe('media: sent only when "Allow cloud analysis" is on, the item is marked not private and fits the limits', () => {
  const b64 = (bytes: Buffer): string => bytes.toString('base64');
  const writeMedia = (): Record<string, Buffer> => {
    const files: Record<string, Buffer> = {
      'private.png': Buffer.from('FAKE private picture bytes'),
      'ok.png': Buffer.from('FAKE shareable picture bytes'),
      'nodims.png': Buffer.from('FAKE picture with no size'),
      'anim.gif': Buffer.from('FAKE gif'),
      'big.png': Buffer.alloc(4 * 1024 * 1024 + 1, 7),
    };
    for (const [n, b] of Object.entries(files)) writeFileSync(join(root, n), b);
    return files;
  };
  const media = [
    { path: 'private.png', kind: 'image' as const, contentType: 'image/png', width: 10, height: 10 },
    { path: 'ok.png', kind: 'image' as const, contentType: 'image/png', width: 10, height: 10, private: false },
    { path: 'nodims.png', kind: 'image' as const, contentType: 'image/png', private: false },
    { path: 'anim.gif', kind: 'image' as const, contentType: 'image/gif', width: 10, height: 10, private: false },
    { path: 'big.png', kind: 'image' as const, contentType: 'image/png', width: 10, height: 10, private: false },
    { path: 'missing.png', kind: 'image' as const, contentType: 'image/png', width: 10, height: 10, private: false },
  ];

  it('only the one shareable image within the limits is sent; the record keeps hashes and sizes, never the bytes', async () => {
    const files = writeMedia();
    const { calls, provider } = fixtureProvider();
    const rec = await decide(input({ media }), { settings: { ...ON, allowCloudAnalysis: true }, provider, fixture: fixture('response-route-ok.json') });
    expect(rec.outcome).toBe('recommend');
    expect(calls[0].images).toEqual([{ content_type: 'image/png', base64: b64(files['ok.png']) }]);
    expect(calls[0].audio).toBeUndefined();
    const byRef = Object.fromEntries(rec.inputs.media.map((m) => [m.ref, m]));
    expect(byRef['ok.png']).toMatchObject({ sent: true, bytes: files['ok.png'].length });
    expect(byRef['ok.png'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byRef['private.png']).toMatchObject({ sent: false });
    expect(byRef['private.png'].reason).toMatch(/private/);
    expect(byRef['nodims.png'].reason).toMatch(/size unknown/);
    expect(byRef['anim.gif'].reason).toMatch(/not PNG, JPEG or WebP/);
    expect(byRef['big.png'].reason).toBe('image over 4 MiB');
    expect(byRef['missing.png'].reason).toMatch(/cannot be read/);
    const text = readFileSync(join(root, '.timmy', 'decisions', `${rec.id}.json`), 'utf8');
    for (const b of Object.values(files)) expect(text).not.toContain(b64(b));
  });

  it('with "Allow cloud analysis" off, nothing is sent, said so for each item', async () => {
    writeMedia();
    const { calls, provider } = fixtureProvider();
    const rec = await decide(input({ media }), { settings: ON, provider, fixture: fixture('response-route-ok.json') });
    expect(calls[0].images).toBeUndefined();
    expect(rec.inputs.media.every((m) => !m.sent && /Allow cloud analysis is off/.test(m.reason ?? ''))).toBe(true);
  });

  it('a private item is never sent, whatever else allows it', async () => {
    writeMedia();
    const { calls, provider } = fixtureProvider();
    await decide(input({ media: [media[0]] }), { settings: { ...ON, allowCloudAnalysis: true }, provider, fixture: fixture('response-route-ok.json') });
    expect(calls[0].images).toBeUndefined();
  });
});

describe('duplicate delivery: the same request is decided once', () => {
  it('a second delivery returns the recorded decision: no second call, no second record', async () => {
    const { calls, provider } = fixtureProvider();
    const ctx = { settings: ON, provider, fixture: fixture('response-route-ok.json') };
    const a = await decideDetailed(input(), ctx);
    const b = await decideDetailed(input(), ctx);
    expect(calls).toHaveLength(1);
    expect(b.reused).toBe(true);
    expect(b.record).toEqual(a.record);
    expect(recordFiles()).toHaveLength(1);
    const index = readFileSync(join(root, '.timmy', 'decisions', 'index.jsonl'), 'utf8').trim().split('\n');
    expect(index).toHaveLength(1);
    expect(JSON.parse(index[0])).toMatchObject({ requestKey: a.record.requestKey, id: a.record.id });
  });

  it('deliveries at the same moment share one call', async () => {
    const { calls, provider } = fixtureProvider();
    const ctx = { settings: ON, provider, fixture: fixture('response-route-ok.json') };
    const all = await Promise.all(Array.from({ length: 10 }, () => decideDetailed(input(), ctx)));
    expect(calls).toHaveLength(1);
    expect(new Set(all.map((r) => r.record.id)).size).toBe(1);
    expect(all.filter((r) => !r.reused)).toHaveLength(1);
    expect(recordFiles()).toHaveLength(1);
  });

  it('a recorded fallback is returned too (a transport retry is not a second call)', async () => {
    const { calls, provider } = fixtureProvider();
    const ctx = { settings: ON, provider, fixture: fixture('malformed-sum.json') };
    const a = await decide(input(), ctx);
    const b = await decide(input(), { ...ctx, fixture: fixture('response-route-ok.json') });
    expect(calls).toHaveLength(1);
    expect(b.id).toBe(a.id);
    expect(b.outcome).toBe('fallback');
  });

  it('another revision, operation, state or option set is another request', async () => {
    const { calls, provider } = fixtureProvider();
    const ctx = { settings: ON, provider, fixture: fixture('response-route-ok.json') };
    const a = await decide(input(), ctx);
    const b = await decide(input({ project: { root, revision: 'rev-9' } }), ctx);
    const c = await decide(input({ operationId: 'o9999abcd' }), ctx);
    const d = await decide(input({ state: { task: 'FAKE: another task' } }), ctx);
    const e = await decide(input({ instructions: 'Which runtime should take this other task?' }), ctx);
    expect(new Set([a.requestKey, b.requestKey, c.requestKey, d.requestKey, e.requestKey]).size).toBe(5);
    expect(calls).toHaveLength(5);
    // the option order does not make another request
    const f = await decide(input({ options: [...OPTIONS].reverse() }), ctx);
    expect(f.id).toBe(a.id);
    expect(calls).toHaveLength(5);
  });

  it('a request key the caller gives is the one used', async () => {
    const rec = await decide(input({ requestKey: 'caller-key-1' }), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('response-route-ok.json') });
    expect(rec.requestKey).toBe('caller-key-1');
  });
});

describe('across processes: a claim keeps a request to one decision', () => {
  /** The record another process would have written for input(), made in a scratch project (the key does not depend on the folder). */
  async function theirs(): Promise<{ other: string; record: DecisionRecord }> {
    const other = mkdtempSync(join(tmpdir(), 'timmy-decide-other-'));
    const r = await decideDetailed(input({ project: { root: other, revision: 'rev-1' } }), { settings: ON, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('response-route-ok.json') });
    return { other, record: r.record };
  }
  const claimFor = (key: string, pid: number, id: string): void => {
    mkdirSync(join(root, '.timmy', 'decisions', 'claims'), { recursive: true });
    writeFileSync(claimPath(root, key), JSON.stringify({ pid, at: new Date().toISOString(), id }));
  };
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid as number;

  it('a live process holding the claim is waited for; its record is returned, with no call', async () => {
    const { other, record } = await theirs();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    try {
      claimFor(record.requestKey, child.pid as number, record.id);
      const { calls, provider } = fixtureProvider();
      const pending = decideDetailed(input(), { settings: { ...ON, timeoutMs: 3000 }, provider, fixture: fixture('response-route-ok.json') });
      await new Promise((r) => setTimeout(r, 150));
      // the other process records its decision and lets the claim go
      copyFileSync(join(other, '.timmy', 'decisions', `${record.id}.json`), join(root, '.timmy', 'decisions', `${record.id}.json`));
      appendFileSync(join(root, '.timmy', 'decisions', 'index.jsonl'), `${JSON.stringify({ requestKey: record.requestKey, id: record.id, at: record.createdAt })}\n`);
      unlinkSync(claimPath(root, record.requestKey));
      const r = await pending;
      expect(calls).toHaveLength(0);
      expect(r.reused).toBe(true);
      expect(r.record.id).toBe(record.id);
    } finally {
      child.kill();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('a claim whose process died without a record is taken over: one call, one record, no claim left', async () => {
    const { other, record } = await theirs();
    rmSync(other, { recursive: true, force: true });
    claimFor(record.requestKey, deadPid(), 'd00000001');
    const { calls, provider } = fixtureProvider();
    const r = await decideDetailed(input(), { settings: ON, provider, fixture: fixture('response-route-ok.json') });
    expect(calls).toHaveLength(1);
    expect(r.reused).toBe(false);
    expect(recordFiles()).toEqual([`${r.record.id}.json`]);
    expect(existsSync(claimPath(root, record.requestKey))).toBe(false);
  });

  it('a claim whose process died after writing its record: the record is indexed and returned, never decided again', async () => {
    const { other, record } = await theirs();
    mkdirSync(join(root, '.timmy', 'decisions'), { recursive: true });
    copyFileSync(join(other, '.timmy', 'decisions', `${record.id}.json`), join(root, '.timmy', 'decisions', `${record.id}.json`));
    rmSync(other, { recursive: true, force: true });
    claimFor(record.requestKey, deadPid(), record.id);
    const { calls, provider } = fixtureProvider();
    const r = await decideDetailed(input(), { settings: ON, provider, fixture: fixture('response-route-ok.json') });
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({ reused: true, record: { id: record.id } });
    expect(readFileSync(join(root, '.timmy', 'decisions', 'index.jsonl'), 'utf8')).toContain(record.id);
    const again = await decideDetailed(input(), { settings: ON, provider, fixture: fixture('response-route-ok.json') });
    expect(again).toMatchObject({ reused: true, record: { id: record.id } });
    expect(calls).toHaveLength(0);
  });

  it('a claim naming this process\'s id that this process did not make (an earlier process given the same id) is taken over', async () => {
    const { other, record } = await theirs();
    rmSync(other, { recursive: true, force: true });
    claimFor(record.requestKey, process.pid, 'd00000002');
    const { calls, provider } = fixtureProvider();
    const t0 = Date.now();
    const r = await decideDetailed(input(), { settings: ON, provider, fixture: fixture('response-route-ok.json') });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(calls).toHaveLength(1);
    expect(r.reused).toBe(false);
  });
});

describe('admission is independent of the model', () => {
  const ALL_OK: AdmissionChecks = {
    projectScope: { ok: true, words: 'inside the project' }, privacy: { ok: true, words: 'nothing private leaves' },
    budget: { ok: true, words: 'within budget' }, concurrency: { ok: true, words: '2 of 4 running' },
    isolation: { ok: true, words: 'a container per worker' }, approvals: { ok: true, words: 'approved by the operator' },
  };

  it('admits only when every check is supplied and passes; review still waits when required', () => {
    const a = admission({ of: 'recommendation', option: 'codex' }, ALL_OK, { requireReview: false });
    expect(a).toMatchObject({ of: 'recommendation', option: 'codex', admitted: true, needsReview: false });
    const r = admission({ of: 'recommendation', option: 'codex' }, ALL_OK, { requireReview: true });
    expect(r).toMatchObject({ admitted: true, needsReview: true });
    expect(r.reasons.join('; ')).toMatch(/Require review before dispatch/);
  });

  it('a failing or missing check is not admitted, in the caller\'s words', () => {
    const failing = admission({ of: 'recommendation', option: 'codex' }, { ...ALL_OK, concurrency: { ok: false, words: '4 of 4 running' } }, { requireReview: false });
    expect(failing).toMatchObject({ admitted: false, needsReview: true });
    expect(failing.reasons.join('; ')).toMatch(/4 of 4 running/);
    expect(failing.checked.concurrency).toBe('refused');
    const { approvals: _a, ...missing } = ALL_OK;
    const m = admission({ of: 'recommendation', option: 'codex' }, missing, { requireReview: false });
    expect(m.admitted).toBe(false);
    expect(m.checked.approvals).toBe('not supplied');
    expect(admission({ of: 'nothing' }, ALL_OK, { requireReview: false })).toMatchObject({ admitted: false, needsReview: true });
  });

  it('answers only admitted or not, with reasons: nothing in it can raise workers, approve, start or seal', () => {
    const a = admission({ of: 'recommendation', option: 'codex' }, ALL_OK, { requireReview: false });
    expect(Object.keys(a).sort()).toEqual(['admitted', 'at', 'checked', 'needsReview', 'of', 'option', 'reasons']);
  });

  it('the service records the caller\'s checks; with review off and every check passing, it is admitted', async () => {
    const rec = await decide(input(), { settings: { ...ON, requireReview: false }, provider: new ClefOmniProvider({ transport: 'fixture' }), fixture: fixture('response-route-ok.json'), checks: ALL_OK });
    expect(rec.admission).toMatchObject({ of: 'recommendation', option: 'codex', admitted: true, needsReview: false });
  });
});

describe('secrets', () => {
  it('the token and account id appear in no record, even when the service echoes them', async () => {
    const echo = { success: false, errors: [{ code: 7, message: `FAKE: bad token ${FAKE_TOKEN} for account ${FAKE_ACCOUNT}` }] };
    const { fetch } = fetchReturning(401, echo);
    const rec = await decide(input(), { settings: ON, provider: workersAi(fetch), budget: { remainingUsd: 1 } });
    expect(rec.fallback.reasonKind).toBe('unavailable');
    for (const f of allFiles(join(root, '.timmy'))) {
      expect(f.text).not.toContain(FAKE_TOKEN);
      expect(f.text).not.toContain(FAKE_ACCOUNT);
    }
    expect(JSON.stringify(rec)).not.toContain(FAKE_TOKEN);
  });
});
