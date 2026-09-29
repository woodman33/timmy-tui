import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requestKeyOf,
  scopedRequestKeyOf,
  recordGeneration,
  buildReplayIndex,
  dryGenerate,
  simulateSpendCurve,
  estimateRecordedCostFloor,
} from '../src/forge/pipeline/dryrun.js';
import { appendLedger } from '../src/forge/ledger.js';
import type { HfGenResult } from '../src/forge/higgsfield/client.js';
import { transition, type PipelineState } from '../src/forge/pipeline/states.js';

function mkResult(over: Partial<HfGenResult> = {}): HfGenResult {
  return {
    request_id: 'rid-1',
    status: 'completed',
    artifact_url: 'stub://forge/rid-1.mp4',
    cost_usd: 0,
    probe: true,
    cost_measured: true,
    ...over,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-dryrun-'));
}

describe('requestKeyOf', () => {
  it('refuses lossy non-JSON inputs instead of colliding with different requests', () => {
    for (const value of [NaN, Infinity, new Date(0), () => 1, [undefined]]) {
      expect(() => requestKeyOf('endpoint', { value })).toThrow(/JSON/);
    }
    const circular: any = {}; circular.self = circular;
    expect(() => requestKeyOf('endpoint', circular)).toThrow(/acyclic/);
    expect(() => scopedRequestKeyOf('a:b', 'c', {})).toThrow(/colon/);
    expect(() => scopedRequestKeyOf('a', 'b:c', {})).toThrow(/colon/);
  });
  it('is stable across input key order and shaped as <endpoint>:<sha256[:12]>', () => {
    const a = requestKeyOf('dop-turbo', { prompt: 'a fox', seed: 1 });
    const b = requestKeyOf('dop-turbo', { seed: 1, prompt: 'a fox' });
    expect(a).toBe(b);
    expect(a).toMatch(/^dop-turbo:[0-9a-f]{12}$/);
  });

  it('is distinct per prompt and per endpoint', () => {
    const base = requestKeyOf('dop-turbo', { prompt: 'a fox', seed: 1 });
    expect(requestKeyOf('dop-turbo', { prompt: 'a fox', seed: 2 })).not.toBe(base);
    expect(requestKeyOf('dop-turbo', { prompt: 'a wolf', seed: 1 })).not.toBe(base);
    expect(requestKeyOf('other-endpoint', { prompt: 'a fox', seed: 1 })).not.toBe(base);
  });

  it('treats array order as significant ({prompt:[1,2]} ≠ {[2,1]})', () => {
    expect(requestKeyOf('dop-turbo', { prompt: [1, 2] })).not.toBe(
      requestKeyOf('dop-turbo', { prompt: [2, 1] })
    );
  });

  it('drops undefined-valued keys in canonicalization ({a:1} === {a:1,b:undefined})', () => {
    expect(requestKeyOf('dop-turbo', { a: 1 })).toBe(
      requestKeyOf('dop-turbo', { a: 1, b: undefined })
    );
  });
});

describe('recordGeneration → buildReplayIndex round-trip', () => {
  it('replays a recorded response verbatim and refuses unknown requests (fail closed)', () => {
    const dir = tempDir();
    const response = mkResult({ request_id: 'rid-9', artifact_url: 'stub://forge/rid-9.mp4' });
    const req = { endpoint: 'dop-turbo', input: { prompt: 'a fox' } };
    recordGeneration(dir, { request_key: requestKeyOf(req.endpoint, req.input), response, mode: 'stub' });

    const index = buildReplayIndex(dir);
    expect(index.size).toBe(1);

    // replay: the recorded result comes back VERBATIM — the ledger JSON
    // round-trip means a structurally identical copy (not the same object
    // identity), so assert exact values
    const hit = dryGenerate(index, req);
    expect(hit.replayed).toBe(true);
    if (hit.replayed) {
      expect(hit.result).toStrictEqual(response);
      expect(hit.result.request_id).toBe('rid-9');
      expect(hit.result.artifact_url).toBe('stub://forge/rid-9.mp4');
    }

    // miss: fail closed, never a network attempt. dryGenerate is synchronous
    // and takes only the index + the request — no fetcher exists by construction.
    const miss = dryGenerate(index, { endpoint: 'dop-turbo', input: { prompt: 'never recorded' } });
    expect(miss).not.toBeInstanceOf(Promise);
    expect(miss).toEqual({ replayed: false, reason: 'no recorded response — dry run refuses to spend' });
  });

  it('ignores generation records without a request_key (legacy shapes) and latest record wins', () => {
    const dir = tempDir();
    appendLedger({ kind: 'generation', endpoint: 'dop-turbo', cost_usd: 0.05 }, dir);
    const key = requestKeyOf('dop-turbo', { prompt: 'a fox' });
    recordGeneration(dir, { request_key: key, response: mkResult({ request_id: 'first' }), mode: 'stub' });
    recordGeneration(dir, { request_key: key, response: mkResult({ request_id: 'second' }), mode: 'live' });
    const index = buildReplayIndex(dir);
    expect(index.size).toBe(1); // legacy record without request_key skipped
    expect(index.get(key)?.request_id).toBe('second'); // later record overwrites
  });
});

describe('replay aliasing', () => {
  it('returns a clone — mutating the result does not poison the index entry', () => {
    const dir = tempDir();
    const key = requestKeyOf('dop-turbo', { prompt: 'a fox' });
    recordGeneration(dir, { request_key: key, response: mkResult({ request_id: 'rid-1' }), mode: 'stub' });
    const index = buildReplayIndex(dir);

    const first = dryGenerate(index, { endpoint: 'dop-turbo', input: { prompt: 'a fox' } });
    expect(first.replayed).toBe(true);
    if (!first.replayed) return;

    // not the index's internal reference
    expect(first.result).not.toBe(index.get(key));
    // caller mutates the returned result
    first.result.request_id = 'MUTATED';
    first.result.cost_usd = 999;

    // replaying the same key still yields the recorded values
    const second = dryGenerate(index, { endpoint: 'dop-turbo', input: { prompt: 'a fox' } });
    expect(second.replayed).toBe(true);
    if (second.replayed) {
      expect(second.result.request_id).toBe('rid-1');
      expect(second.result.cost_usd).toBe(0);
    }
    expect(index.get(key)?.request_id).toBe('rid-1');
  });
});

describe('replay index shape guard', () => {
  it('refuses conflicting mission tags without rewriting retained records', () => {
    const dir = tempDir();
    const key = scopedRequestKeyOf('mine', 'endpoint', {});
    appendLedger({ kind: 'generation', mission_id: 'other', request_key: key, response: mkResult() }, dir);
    expect(() => buildReplayIndex(dir, 'mine')).toThrow(/mission tag conflicts/);
    expect(() => recordGeneration(dir, { mission_id: 'other', request_key: key, response: mkResult(), mode: 'stub' })).toThrow(/for its mission/);
  });

  it('refuses ambiguous old scoped keys while preserving ordinary historical keys', () => {
    const dir = tempDir();
    appendLedger({ kind: 'generation', request_key: 'a:b:c:123456789abc', response: mkResult() }, dir);
    expect(() => buildReplayIndex(dir, 'a')).toThrow(/ambiguous/);
    expect(buildReplayIndex(dir).size).toBe(1);
  });
  it('skips generation records whose response is not a full HfGenResult', () => {
    const dir = tempDir();
    // malformed: request_id only — missing status/cost_usd/artifact_url/probe
    appendLedger(
      { kind: 'generation', request_key: 'dop-turbo:deadbeef0000', response: { request_id: 'x' } },
      dir
    );
    recordGeneration(dir, {
      request_key: 'dop-turbo:goodshape000',
      response: mkResult({ request_id: 'well-formed' }),
      mode: 'stub',
    });
    const index = buildReplayIndex(dir);
    expect(index.size).toBe(1);
    expect(index.has('dop-turbo:deadbeef0000')).toBe(false);

    // the malformed key refuses (fail closed), the well-formed key replays
    const refused = dryGenerate(index, {
      endpoint: 'dop-turbo',
      input: { prompt: 'never recorded' }, // any input not hashing to the well-formed key
    });
    expect(refused.replayed).toBe(false);
  });

  it('empty ledger → empty index → dryGenerate refuses everything', () => {
    const dir = tempDir();
    const index = buildReplayIndex(dir);
    expect(index.size).toBe(0);
    expect(dryGenerate(index, { endpoint: 'dop-turbo', input: { prompt: 'a fox' } })).toEqual({
      replayed: false,
      reason: 'no recorded response — dry run refuses to spend',
    });
  });
});

describe('cross-mission key collision (legacy unscoped keys)', () => {
  it('same endpoint+prompt from two missions: last write wins (store-wide index)', () => {
    // PINNED legacy behavior: unscoped requestKeyOf keys are MISSION-GLOBAL —
    // endpoint + prompt hash only. Two missions issuing the same
    // endpoint+prompt collide; the whole-store index is last-write-wins.
    // The Task-20 scoping decision RESOLVED this for rehearsal: new code
    // uses scopedRequestKeyOf (mission-namespaced) + buildReplayIndex(dir,
    // mission_id) — see tests/forge-rehearse.test.ts. This legacy flavor
    // remains only for Task-16 records and the intentional whole-store
    // cache use-case.
    const dir = tempDir();
    const key = requestKeyOf('dop-turbo', { prompt: 'a fox' });
    recordGeneration(dir, { request_key: key, response: mkResult({ request_id: 'mission-a' }), mode: 'stub' });
    recordGeneration(dir, { request_key: key, response: mkResult({ request_id: 'mission-b' }), mode: 'stub' });
    const index = buildReplayIndex(dir);
    expect(index.size).toBe(1);
    expect(index.get(key)?.request_id).toBe('mission-b');
  });
});

describe('simulateSpendCurve', () => {
  const est = estimateRecordedCostFloor;

  it('refuses invalid caps even for an empty replay', () => {
    for (const max_spend_usd of [NaN, Infinity, -Infinity, -1]) {
      for (const replay of [[], [mkResult({ cost_usd: 1 })]]) {
        expect(simulateSpendCurve(replay, { max_spend_usd }, est)).toMatchObject({ ok: false, exceeded_at_call: -1 });
      }
    }
  });

  it('refuses accumulated overflow from otherwise finite estimates', () => {
    expect(simulateSpendCurve([mkResult(), mkResult()], { max_spend_usd: Number.MAX_VALUE }, () => Number.MAX_VALUE))
      .toMatchObject({ ok: false, exceeded_at_call: 1 });
  });

  it('passes under the cap with call and spend totals', () => {
    const curve = simulateSpendCurve(
      [mkResult({ cost_usd: 0.25 }), mkResult({ cost_usd: 0.5 })],
      { max_spend_usd: 1 },
      est
    );
    expect(curve).toEqual({ ok: true, spend: { calls: 2, estimated_spend_usd: 0.75, cap_usd: 1 } });
  });

  it('reports the exact call index and amounts on exceedance', () => {
    const curve = simulateSpendCurve(
      [mkResult({ cost_usd: 0.25 }), mkResult({ cost_usd: 0.25 }), mkResult({ cost_usd: 0.5 })],
      { max_spend_usd: 0.5 },
      est
    );
    // 0.25, 0.5 pass; the render at index 2 pushes running to 1.0 > 0.5
    expect(curve).toEqual({ ok: false, exceeded_at_call: 2, running_usd: 1.0, cap_usd: 0.5 });
  });

  it('passes exactly at the cap (boundary: running > cap is the only refusal)', () => {
    const curve = simulateSpendCurve(
      [mkResult({ cost_usd: 0.25 }), mkResult({ cost_usd: 0.5 })],
      { max_spend_usd: 0.75 },
      est
    );
    expect(curve.ok).toBe(true);
  });

  it('empty replay is ok with zero calls', () => {
    expect(simulateSpendCurve([], { max_spend_usd: 0 }, est)).toEqual({
      ok: true,
      spend: { calls: 0, estimated_spend_usd: 0, cap_usd: 0 },
    });
  });

  it('estimates unknown-cost calls (cost_measured falsy) at 0 — a documented floor', () => {
    const unknown = mkResult({ cost_usd: 5, cost_measured: false });
    const unflagged = mkResult({ cost_usd: 5, cost_measured: undefined }); // flag absent = unknown
    const curve = simulateSpendCurve([unknown, unflagged], { max_spend_usd: 0 }, est);
    expect(curve).toEqual({ ok: true, spend: { calls: 2, estimated_spend_usd: 0, cap_usd: 0 } });
    // measured calls still count
    const mixed = simulateSpendCurve([unknown, mkResult({ cost_usd: 0.25 })], { max_spend_usd: 0.25 }, est);
    expect(mixed).toEqual({ ok: true, spend: { calls: 2, estimated_spend_usd: 0.25, cap_usd: 0.25 } });
  });

  it('refuses a NaN estimate at that call (fail closed — NaN would blind the cap check)', () => {
    const curve = simulateSpendCurve(
      [mkResult({ cost_usd: 0.25 }), mkResult({ cost_usd: 0.5 })],
      { max_spend_usd: 100 }, // cap far above the real total — only NaN can trip it
      () => NaN
    );
    expect(curve).toEqual({ ok: false, exceeded_at_call: 0, running_usd: 0, cap_usd: 100 });
  });

  it('refuses a negative estimate at that call (fail closed)', () => {
    const curve = simulateSpendCurve(
      [mkResult({ cost_usd: 0.25 }), mkResult({ cost_usd: 0.5 })],
      { max_spend_usd: 100 },
      () => -1
    );
    expect(curve).toEqual({ ok: false, exceeded_at_call: 0, running_usd: 0, cap_usd: 100 });
  });

  it('default floor estimator is unaffected by the fail-closed guard', () => {
    // estimateRecordedCostFloor returns finite, non-negative values for every
    // recorded shape — measured cost, or 0 for unknown-cost recordings — so
    // the guard never fires on the default estimator.
    const curve = simulateSpendCurve(
      [mkResult({ cost_usd: 0.25 }), mkResult({ cost_usd: 5, cost_measured: false })],
      { max_spend_usd: 0.25 },
      estimateRecordedCostFloor
    );
    expect(curve).toEqual({ ok: true, spend: { calls: 2, estimated_spend_usd: 0.25, cap_usd: 0.25 } });
  });
});

describe('dry mission end-to-end (state machine + budget curve)', () => {
  it('replays probe fail → iterate → probe pass → render at $0 and asserts caps', () => {
    const dir = tempDir();
    const endpoint = 'dop-turbo';
    // three recorded generations in mission order
    const probeFail = mkResult({ request_id: 'probe-1', status: 'failed', artifact_url: '', cost_usd: 0.25 });
    const probePass = mkResult({ request_id: 'probe-2', artifact_url: 'stub://forge/probe-2.mp4', cost_usd: 0.25 });
    const render = mkResult({ request_id: 'render-1', artifact_url: 'stub://forge/render-1.mp4', cost_usd: 0.5, probe: false });
    for (const g of [probeFail, probePass, render]) {
      recordGeneration(dir, { request_key: requestKeyOf(endpoint, { id: g.request_id }), response: g, mode: 'stub' });
    }
    const index = buildReplayIndex(dir);

    let state: PipelineState = {
      mission_id: 'm1',
      stage: 'intake',
      prompt_version_id: 'pv1',
      probe_attempts: 0,
      iterations: 0,
      degraded: false,
      toxic: false,
      config: { on_budget_exhausted: 'escalate', max_probe_attempts: 2, max_iterations: 3 },
      history: [],
    };
    const fire = (e: Parameters<typeof transition>[1]) => {
      state = transition(state, e).state;
    };

    fire('submitted');
    fire('passed');
    expect(state.stage).toBe('probe');

    // probe 1 fails → iterate → revise → probe again (all replayed, $0)
    const r1 = dryGenerate(index, { endpoint, input: { id: 'probe-1' } });
    expect(r1.replayed).toBe(true);
    fire('failed');
    expect(state.stage).toBe('iterate');
    fire('revised');
    expect(state.stage).toBe('probe');

    const r2 = dryGenerate(index, { endpoint, input: { id: 'probe-2' } });
    expect(r2.replayed).toBe(true);
    fire('completed');
    expect(state.stage).toBe('probe_judging');
    fire('passed');
    expect(state.stage).toBe('full_render');

    const r3 = dryGenerate(index, { endpoint, input: { id: 'render-1' } });
    expect(r3.replayed).toBe(true);
    fire('completed');
    expect(state.stage).toBe('chain');
    fire('completed');
    expect(state.stage).toBe('done');

    const replayed = [r1, r2, r3].map(r => (r as { replayed: true; result: HfGenResult }).result);
    const total = 0.25 + 0.25 + 0.5;

    // cap at the estimated total: the curve never exceeds the cap
    const okCurve = simulateSpendCurve(replayed, { max_spend_usd: total }, estimateRecordedCostFloor);
    expect(okCurve).toEqual({
      ok: true,
      spend: { calls: 3, estimated_spend_usd: total, cap_usd: total },
    });

    // cap below the estimated spend: refused. Two probes already reach 0.5
    // (exactly at cap 0.5 — passes), then the render at index 2 pushes
    // running to 1.0 > 0.5
    const refused = simulateSpendCurve(replayed, { max_spend_usd: 0.5 }, estimateRecordedCostFloor);
    expect(refused).toEqual({ ok: false, exceeded_at_call: 2, running_usd: total, cap_usd: 0.5 });
  });
});
