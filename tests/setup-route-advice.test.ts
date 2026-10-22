/**
 * R10 (H170; the handoff's TINY_HELPER_TEST.md): the one tiny setup-helper check. Three deterministic fixtures over
 * src/setup/route-advice.ts adviseRoute; these are fixture assertions, not model-authored evidence: no model is asked.
 *
 *   local ready        local-only; one installed completion model verified; cloud candidates present (OpenRouter's, Ollama
 *                      Cloud's, a cloud tag a local Ollama lists)  ->  the permitted local route, never a cloud one
 *   nothing connected  no credentials, no installed weights  ->  the existing guided-setup action, no answer invented
 *   free policy        free-only on; the selected model has a non-zero price  ->  refused, a permitted free or local choice
 *                      asked for
 *
 * Each fixture records its source data, the expected and the actual result and the assertion's outcome in the ordinary test
 * log (stdout), and asserts that nothing happened besides the advice: no provider request (an injected fetch that fails the
 * test if called), no download and no account or authentication action (no request, and no child process: both trapped), no
 * persistent settings change (TIMMY_HOME and TIMMY_SETTINGS_DIR in a temporary folder of the test's; every file there
 * byte-identical before and after, providers.json and the settings file among them), no paid fallback. The redacted outcome
 * goes through the existing local logger (src/utils/logger.ts writeLog) into the test's own folder, and that line is read back.
 *
 * The validator gap, said plainly: no CUE, Nickel or Organist adapter validates these records. The `cue vet` gates cover other
 * files only (src/forge/timeline.ts and sheet.ts, src/utils/usd-compiler.ts, tripo-adapter.ts and escrow-engine.ts, and the
 * plan, pass and cone schemas of src/utils/dispatch.ts, agent-pass.ts and context-cone.ts); Nickel is a template the REPL's
 * /profiles writes (src/utils/slash-commands.ts), never called; Organist is absent. No validator was added for this check
 * (TINY_HELPER_TEST.md: reuse first): the existing typed contract is the check (src/decision's DeterministicRule and
 * allowedChoices, src/agent/model-price.ts's prices, src/agent/providers.ts's probe facts, src/ops/workspace-frame.ts's actions).
 *
 * The optional decision model (Clef): it may score the same permitted choices only where one is configured and an authorized
 * zero-cost path is confirmed. The last case reads src/decision/config.ts and settings.ts in the test's own Timmy home, finds
 * neither, and is skipped with the missing prerequisite in its words; nothing configures one.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADVICE_ACTIONS, adviceLogLine, adviseRoute, type RouteAdvice, type RouteFacts, type RoutePolicy } from '../src/setup/route-advice.js';
import { freeOnlyOn, modelPrice } from '../src/agent/model-price.js';
import { modelKeySource } from '../src/utils/model-key.js';
import { writeLog } from '../src/utils/logger.js';
import type { ModelCache } from '../src/models/registry.js';

// a download (ollama pull) or a sign-in (a browser opened) would start a process: while a fixture runs, starting one fails it
const trap = vi.hoisted(() => ({ armed: false, calls: [] as string[] }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const wrapped = Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => {
    if (trap.armed) { trap.calls.push(`${n} ${String(args[0])}`); throw new Error(`a child process was started (${n})`); }
    return (real[n] as (...a: unknown[]) => unknown)(...args);
  }]));
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

// FAKE: an OpenRouter catalog of two made-up models (no real model's name or price), read by the real price reader
const CATALOG: ModelCache = {
  fetchedAt: '2026-10-22T00:00:00.000Z',
  models: [
    { id: 'fake-maker/fake-paid-model', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200_000, supported_parameters: ['tools'] },
    { id: 'fake-maker/fake-free-model:free', pricing: { prompt: '0', completion: '0' }, context_length: 131_072, supported_parameters: ['tools'] },
  ],
};
const PAID = 'fake-maker/fake-paid-model';
const FREE = 'fake-maker/fake-free-model:free';
// FAKE local model names, as the slice's FAKE Ollama serves them; a probe result as src/agent/providers.ts probeOllama returns it
const LOCAL = 'fake-qwen3:8b';
const LOCAL_CLOUD_TAG = 'fake-gpt-oss:120b-cloud';
// FAKE: a placeholder where the setup keeps an OpenRouter key: not a key, never printed, never logged
const KEY_PLACEHOLDER = 'FAKE-placeholder-not-a-key-h170';

const fetchTrap = vi.fn((input: unknown) => { throw new Error(`a provider request was made: ${String(input)}`); });
let root = '';
let start = '';
const run = `r${randomBytes(4).toString('hex')}`;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR'] as const;

beforeEach(() => {
  start = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'h170-route-advice-'));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.TIMMY_HOME = join(root, 'home');
  process.env.TIMMY_SETTINGS_DIR = join(root, 'settings');
  for (const d of ['home', 'settings', 'work']) mkdirSync(join(root, d), { recursive: true });
  // the logger writes logs/ in the folder the process is in: the test's own
  process.chdir(join(root, 'work'));
  fetchTrap.mockClear();
  vi.stubGlobal('fetch', fetchTrap);
  trap.calls.length = 0;
  trap.armed = true;
});
afterEach(() => {
  trap.armed = false;
  vi.unstubAllGlobals();
  process.chdir(start);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

/** Only the test's own folders: never this computer's variables (a key in OPENROUTER_API_KEY would change what is present). */
const fixtureEnv = (): Record<string, string> => ({ TIMMY_HOME: join(root, 'home'), TIMMY_SETTINGS_DIR: join(root, 'settings') });

/** Every file under the Timmy home and the settings folder, by its path there, with its bytes. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of ['home', 'settings']) {
    for (const name of readdirSync(join(root, d), { recursive: true }).map(String).sort()) {
      try { out[`${d}/${name}`] = readFileSync(join(root, d, name)).toString('base64'); } catch { out[`${d}/${name}`] = '(a folder)'; }
    }
  }
  return out;
}

/** Seeds the providers file and the settings file the way the setup and the settings store keep them. */
function seed(o: { key: boolean; settings: Record<string, unknown> }): void {
  writeFileSync(join(root, 'home', 'providers.json'), `${JSON.stringify(o.key ? { openrouter_api_key: KEY_PLACEHOLDER } : {}, null, 1)}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'settings', 'config.json'), `${JSON.stringify(o.settings, null, '\t')}\n`, { mode: 0o600 });
}

/** A route that costs nothing: a model on this computer's Ollama (not a cloud tag), or one the catalog says is free. */
const freeOrLocal = (a: RouteAdvice): boolean => !a.route
  || (a.route.source === 'ollama-local' && !a.route.model.endsWith('-cloud'))
  || modelPrice(a.route.model, CATALOG).free === true;

/**
 * Runs the helper on a fixture, checks it (the fixture's own assertions, nothing else happening, and the redacted line written
 * through the local logger and read back), and records it in the ordinary test log: its source data, the expected and the
 * actual result, and the assertions' outcome (passed, or the first line of the failure).
 */
function fixture(name: string, source: Record<string, unknown>, facts: RouteFacts, policy: RoutePolicy, expected: Record<string, unknown>, assert: (a: RouteAdvice) => void): RouteAdvice {
  const before = snapshot();
  const advice = adviseRoute(facts, policy);
  let outcome = 'passed';
  try {
    assert(advice);
    // nothing happened besides the advice
    expect(fetchTrap, 'a provider request').not.toHaveBeenCalled();
    expect(trap.calls, 'a child process (a download, a browser for a sign-in)').toEqual([]);
    expect(snapshot(), 'the Timmy home and the settings folder, byte for byte').toEqual(before);
    expect(freeOrLocal(advice), 'a paid fallback').toBe(true);
    // the redacted outcome through the existing local logger, into the test's own folder, read back
    writeLog('setup-advice.log', 'info', adviceLogLine(advice, { run, fixture: name }));
    const logged = readFileSync(join(root, 'work', 'logs', 'setup-advice.log'), 'utf8');
    expect(logged).toMatch(new RegExp(`^\\[\\d{4}-\\d\\d-\\d\\dT[^\\]]+\\] \\[INFO\\] setup-advice run=${run} fixture=${name} outcome=${advice.outcome} rule="`, 'm'));
    expect(logged, 'a key in the log').not.toContain(KEY_PLACEHOLDER);
    expect(logged, 'a path in the log').not.toContain(root);
  } catch (e) {
    outcome = `failed: ${String((e as Error).message).split('\n')[0]}`;
    throw e;
  } finally {
    const actual = { outcome: advice.outcome, route: advice.route ?? null, action: advice.action ?? null, refusal: advice.refusal ?? null, rule: advice.proposal.rule, permitted: advice.permitted, excluded: advice.excluded };
    console.log([
      `[route-advice] fixture "${name}" (run ${run}): deterministic fixture assertions, not model-authored evidence`,
      `  source data: ${JSON.stringify(source)}`,
      `  facts and policy: ${JSON.stringify({ facts, policy })}`,
      `  expected: ${JSON.stringify(expected)}`,
      `  actual: ${JSON.stringify(actual)}`,
      `  assertions: ${outcome}`,
    ].join('\n'));
  }
  return advice;
}

describe('the setup helper (adviseRoute): three deterministic fixtures, no model, no request, nothing saved', () => {
  it('local ready: under local-only, the one verified local model is the route, never a cloud candidate', () => {
    seed({ key: true, settings: { model: PAID } });
    const env = fixtureEnv();
    const keyFrom = modelKeySource(env, process.cwd());
    const facts: RouteFacts = {
      // as probeOllama returns it: Ollama listed two, one a cloud tag; the one local model passed its /api/show check
      local: { models: [LOCAL], answer: { state: 'listed', listed: 2, cloud: 1, checked: 1, failed: 0, late: 0, deadlineMs: 1500 } },
      offered: [
        { source: 'ollama-local', id: LOCAL_CLOUD_TAG, price: null },
        { source: 'openrouter', id: FREE, price: modelPrice(FREE, CATALOG) },
        { source: 'openrouter', id: PAID, price: modelPrice(PAID, CATALOG) },
        { source: 'ollama-cloud', id: 'fake-gpt-oss:120b', price: null },
      ],
      credentials: { openrouter: keyFrom !== null, ollamaCloud: false },
    };
    const policy: RoutePolicy = { freeOnly: freeOnlyOn(env), localOnly: true };
    const a = fixture('local-ready', { 'providers.json': 'holds an OpenRouter key (a FAKE placeholder, never printed)', keyFrom, 'settings freeOnly': policy.freeOnly, 'local-only': 'on (the fixture\'s: no local-only setting exists before H169\'s route policy)', catalog: 'FAKE, of 2026-10-22' }, facts, policy,
      { outcome: 'route', route: { source: 'ollama-local', model: LOCAL }, permitted: [LOCAL], 'cloud candidates': 'excluded, each with why' }, (got) => {
        expect(got.outcome).toBe('route');
        expect(got.route).toEqual({ source: 'ollama-local', model: LOCAL });
        expect(got.permitted).toEqual([{ source: 'ollama-local', model: LOCAL }]);
        expect(got.proposal).toEqual({ option: 'ollama-local.0', rule: 'the only available option' });
        expect(got.excluded.map((e) => e.model).sort()).toEqual([LOCAL_CLOUD_TAG, FREE, PAID, 'fake-gpt-oss:120b'].sort());
        // the OpenRouter models could answer (a key is present): local-only alone keeps them out, and says so
        for (const id of [FREE, PAID]) expect(got.excluded.find((e) => e.model === id)?.reason).toMatch(/^local only: .* is not on this computer \(it runs on OpenRouter/);
        expect(got.action).toBeUndefined();
        expect(got.refusal).toBeUndefined();
      });
    expect(keyFrom).toBe('providers.json');
    expect(a.route?.source).toBe('ollama-local');
  });

  it('nothing connected: no credentials and no installed weights give the existing guided-setup action, and no answer is invented', () => {
    seed({ key: false, settings: { model: PAID } });
    const env = fixtureEnv();
    const keyFrom = modelKeySource(env, process.cwd());
    const facts: RouteFacts = {
      // as probeOllama returns it when nothing listens at the address
      local: { models: [], answer: { state: 'no answer', why: 'the connection failed (ECONNREFUSED)' } },
      // the catalog still lists models: none can answer without a key
      offered: [{ source: 'openrouter', id: FREE, price: modelPrice(FREE, CATALOG) }, { source: 'openrouter', id: PAID, price: modelPrice(PAID, CATALOG) }],
      credentials: { openrouter: keyFrom !== null, ollamaCloud: false },
    };
    const policy: RoutePolicy = { freeOnly: freeOnlyOn(env), localOnly: false };
    fixture('nothing-connected', { 'providers.json': 'no key', keyFrom, 'settings freeOnly': policy.freeOnly, 'local-only': 'off', 'the local probe': 'no answer' }, facts, policy,
      { outcome: 'setup', action: ADVICE_ACTIONS['no-route'], route: null, permitted: [] }, (got) => {
        expect(got.outcome).toBe('setup');
        expect(got.action).toEqual({ problem: 'no-route', label: 'Set up chat: an OpenRouter key (asked hidden) or a local model', command: 'timmy init --chat openrouter', effect: 'local change' });
        expect(got.route).toBeUndefined();
        expect(got.permitted).toEqual([]);
        expect(got.proposal).toEqual({ rule: 'no option is available: a person chooses' });
        expect(got.excluded.every((e) => e.reason === 'no OpenRouter key is set up')).toBe(true);
        // no answer invented: the advice holds the existing action and the deterministic rule's words, nothing else
        expect(Object.keys(got).sort()).toEqual(['action', 'excluded', 'outcome', 'permitted', 'proposal']);
      });
    expect(keyFrom).toBeNull();
  });

  it('free policy: free-only on and a selected model with a non-zero price are refused, and a permitted free or local choice is asked for', () => {
    seed({ key: true, settings: { model: PAID, freeOnly: true } });
    const env = fixtureEnv();
    const keyFrom = modelKeySource(env, process.cwd());
    const paid = modelPrice(PAID, CATALOG);
    const facts: RouteFacts = {
      local: { models: [LOCAL], answer: { state: 'listed', listed: 1, cloud: 0, checked: 1, failed: 0, late: 0, deadlineMs: 1500 } },
      offered: [{ source: 'openrouter', id: FREE, price: modelPrice(FREE, CATALOG) }, { source: 'openrouter', id: PAID, price: paid }],
      credentials: { openrouter: keyFrom !== null, ollamaCloud: false },
      selected: { source: 'openrouter', id: PAID, price: paid },
    };
    const policy: RoutePolicy = { freeOnly: freeOnlyOn(env), localOnly: false };
    fixture('free-policy', { 'providers.json': 'holds an OpenRouter key (a FAKE placeholder, never printed)', keyFrom, 'settings freeOnly': policy.freeOnly, 'local-only': 'off', selected: `${PAID} (${paid.words})` }, facts, policy,
      { outcome: 'refused', refusal: 'paid-under-free-only', action: ADVICE_ACTIONS['free-only'], route: null, permitted: [LOCAL, FREE] }, (got) => {
        expect(policy.freeOnly).toBe(true);
        expect(paid.free).toBe(false);
        expect(got.outcome).toBe('refused');
        expect(got.refusal?.reason).toBe('paid-under-free-only');
        expect(got.refusal?.words).toBe(`free only: ${PAID} costs (${paid.words}); a paid model is never used in place of a free one`);
        expect(got.action).toEqual({ problem: 'free-only', label: 'Choose a free model (free-only stays on)', command: '/model free', effect: 'local change' });
        // no route: never the free or the local model in the selection's place; they are the choices asked for
        expect(got.route).toBeUndefined();
        expect(got.permitted).toEqual([{ source: 'ollama-local', model: LOCAL }, { source: 'openrouter', model: FREE }]);
        expect(got.proposal.option).toBeUndefined();
        expect(got.rule).toEqual({ option: 'openrouter.2', rule: 'the model selected for the next turn' });
        expect(got.proposal.rule).toBe(`the model selected for the next turn names ${PAID}, which is out (${got.refusal?.words}): a person chooses`);
      });
  });

  it('the helper\'s words are the existing ones: each action is chatFix\'s own, and the helper imports nothing that could ask, write or start anything', async () => {
    trap.armed = false;
    // loaded only here: its module graph loads the settings store, which writes its file when it loads (the fixtures above
    // compare that folder byte for byte, so it must not load while they run)
    const { chatFix } = await import('../src/ops/workspace-frame.js');
    const pick = (f: ReturnType<typeof chatFix>) => (f ? { problem: f.problem, label: f.label, command: f.command, effect: f.effect } : null);
    expect(pick(chatFix({ kind: 'none', ready: false }))).toEqual(ADVICE_ACTIONS['no-route']);
    expect(pick(chatFix({ kind: 'openrouter', ready: false, refusal: ['Error: free-only is on, and x is not known to be free, so this message was not sent.'] }))).toEqual(ADVICE_ACTIONS['free-only']);
    expect(pick(chatFix({ kind: 'local', ready: false, refusal: ['Error: no model is chosen for the local chat, so this message was not sent.'] }))).toEqual(ADVICE_ACTIONS['no-local-model']);
    const down = [{ id: 'ollama' as const, state: 'unreachable' as const, words: 'did not answer when checked just now' }];
    expect(pick(chatFix({ kind: 'local', ready: true }, down))).toEqual(ADVICE_ACTIONS['ollama-unreachable']);
    const noModel = [{ id: 'ollama' as const, state: 'not set up' as const, words: `answered with no local model: ${(await import('../src/ops/workspace-frame.js')).NO_MODEL_STEP}` }];
    expect(pick(chatFix({ kind: 'local', ready: true }, noModel))).toEqual(ADVICE_ACTIONS['ollama-no-model']);
    // its own imports: the decision layer's choice set and deterministic path, two word scrubbers, the setup's cloud-tag rule,
    // and types (erased); no network, file or process module
    const source = readFileSync(join(start, 'src', 'setup', 'route-advice.ts'), 'utf8');
    const runtime = [...source.matchAll(/^import (?!type )[^;]*? from '([^']+)';$/gm)].map((m) => m[1]).sort();
    expect(runtime).toEqual(['../decision/deterministic.js', '../decision/policy.js', '../utils/home-scrub.js', '../utils/redact.js', './ollama-models.js']);
  });

  it('optional: a decision model scores the same permitted choices only on a configured, authorized zero-cost path', async (ctx) => {
    const { readClefConfig } = await import('../src/decision/config.js');
    const { readSettings } = await import('../src/decision/settings.js');
    const env = fixtureEnv();
    const clef = readClefConfig(env);
    const settings = readSettings(env);
    const missing: string[] = [];
    if (clef.state !== 'configured') missing.push(`no decision model is configured (clef.json: ${clef.state}, in the test's own Timmy home)`);
    else if (!clef.config.pricing || !('free' in clef.config.pricing)) missing.push('the configured decision model is not declared zero-cost ({"free": "local"})');
    if (!settings.settings.useClef) missing.push(`Use decision-model routing is off (${settings.useClefFrom === 'default' ? 'the default' : settings.useClefFrom}), so no decision model is authorized`);
    expect(missing.length).toBeGreaterThan(0);
    const words = `skipped: ${missing.join('; ')}. Nothing configures one for this check, and no model was asked.`;
    console.log(`[route-advice] optional decision-model check (run ${run}): ${words}`);
    writeLog('setup-advice.log', 'info', `setup-advice run=${run} fixture=decision-model outcome=skipped reason=${JSON.stringify(words)}`);
    expect(readFileSync(join(root, 'work', 'logs', 'setup-advice.log'), 'utf8')).toContain(`fixture=decision-model outcome=skipped`);
    expect(fetchTrap).not.toHaveBeenCalled();
    ctx.skip(words);
  });
});
