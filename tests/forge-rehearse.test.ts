// Rehearsal runner (Task 20): mission replay at $0 through the REAL state
// machine + orchestrator. Replay keys are mission-namespaced
// (scopedRequestKeyOf), the replay index is mission-scoped
// (buildReplayIndex(dir, mission_id)), and every generation attempt passes
// the real canSpend/applySpend gates with generation served by dryGenerate
// only — NO network, NO hfGenerate, NO credentials (house env hygiene
// deletes HF_CREDENTIALS for the whole suite; rehearsal never reads it).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scopedRequestKeyOf,
  recordGeneration,
  buildReplayIndex,
} from '../src/forge/pipeline/dryrun.js';
import { rehearse, type RehearsalScript } from '../src/forge/pipeline/rehearse.js';
import { readLedger } from '../src/forge/ledger.js';
import type { HfGenResult } from '../src/forge/higgsfield/client.js';

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
  return mkdtempSync(join(tmpdir(), 'forge-rehearse-'));
}

// Record a mission-namespaced generation the way a real recording pass would:
// scoped key + mission_id field (Task-20 contract).
function recordFor(
  dir: string,
  mission_id: string,
  endpoint: string,
  input: Record<string, unknown>,
  response: HfGenResult
): string {
  const key = scopedRequestKeyOf(mission_id, endpoint, input);
  recordGeneration(dir, { request_key: key, response, mode: 'replay', mission_id });
  return key;
}

const PREV_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
  // House env hygiene: no ambient creds may exist anywhere near the $0
  // contract — rehearsal must never need them (dryGenerate only).
  PREV_ENV.HF_CREDENTIALS = process.env.HF_CREDENTIALS;
  delete process.env.HF_CREDENTIALS;
});

afterAll(() => {
  if (PREV_ENV.HF_CREDENTIALS === undefined) delete process.env.HF_CREDENTIALS;
  else process.env.HF_CREDENTIALS = PREV_ENV.HF_CREDENTIALS;
});

describe('scopedRequestKeyOf', () => {
  it('is distinct per mission for the same endpoint+prompt, shaped <mission>:<endpoint>:<sha256[:12]>', () => {
    const a = scopedRequestKeyOf('m1', 'dop-turbo', { prompt: 'a fox' });
    const b = scopedRequestKeyOf('m2', 'dop-turbo', { prompt: 'a fox' });
    expect(a).toMatch(/^m1:dop-turbo:[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    // the mission collision that plagued unscoped keys is resolved
    expect(a).toBe(scopedRequestKeyOf('m1', 'dop-turbo', { prompt: 'a fox' }));
  });
});

describe('mission-scoped replay index (buildReplayIndex dir, mission_id)', () => {
  it('sees only the mission own records; another mission index does NOT (collision resolved)', () => {
    const dir = tempDir();
    const input = { prompt: 'a fox' };
    // SAME endpoint+prompt from two missions — the exact legacy collision
    recordFor(dir, 'm1', 'dop-turbo', input, mkResult({ request_id: 'mission-a' }));
    recordFor(dir, 'm2', 'dop-turbo', input, mkResult({ request_id: 'mission-b' }));

    const m1 = buildReplayIndex(dir, 'm1');
    const m2 = buildReplayIndex(dir, 'm2');
    expect(m1.size).toBe(1);
    expect(m2.size).toBe(1);
    expect(m1.get(scopedRequestKeyOf('m1', 'dop-turbo', input))?.request_id).toBe('mission-a');
    expect(m2.get(scopedRequestKeyOf('m2', 'dop-turbo', input))?.request_id).toBe('mission-b');
    // cross-mission views cannot see each other
    expect(m1.has(scopedRequestKeyOf('m2', 'dop-turbo', input))).toBe(false);
    expect(m2.has(scopedRequestKeyOf('m1', 'dop-turbo', input))).toBe(false);

    // legacy whole-store index remains for the cache use-case
    const whole = buildReplayIndex(dir);
    expect(whole.size).toBe(2);
  });
});

const PROBE_INPUT = { prompt: 'a fox' };
const RENDER_INPUT = { prompt: 'a fox', full: true };

function happyScript(mission_id: string, over: Partial<RehearsalScript> = {}): RehearsalScript {
  return {
    mission_id,
    caps: { max_spend_usd: 1, max_probe_calls: 3, max_render_calls: 1 },
    declared_balance_usd: 10,
    stages: [
      { stage: 'probe', request: { endpoint: 'dop-turbo', input: PROBE_INPUT }, kind: 'probe' },
      { stage: 'full_render', request: { endpoint: 'dop-turbo', input: RENDER_INPUT }, kind: 'render' },
    ],
    outcomes: ['completed', 'completed'],
    ...over,
  };
}

function recordHappyPath(dir: string, mission_id: string): void {
  recordFor(dir, mission_id, 'dop-turbo', PROBE_INPUT, mkResult({ request_id: 'probe-1', cost_usd: 0.25 }));
  recordFor(dir, mission_id, 'dop-turbo', RENDER_INPUT, mkResult({ request_id: 'render-1', cost_usd: 0.5, probe: false }));
}

describe('rehearse', () => {
  it('refuses a render disguised as a probe before adding any ledger records', async () => {
    const dir = tempDir();
    recordHappyPath(dir, 'm1');
    const before = readLedger(dir);
    const script = happyScript('m1');
    script.caps.max_render_calls = 0;
    script.stages[1].kind = 'probe';
    await expect(rehearse(dir, script)).rejects.toThrow(/stage and call kind mismatch/);
    expect(readLedger(dir)).toEqual(before);
  });

  it('refuses recorded probe/render classification inconsistent with the script', async () => {
    const dir = tempDir();
    recordFor(dir, 'm1', 'dop-turbo', PROBE_INPUT, mkResult({ probe: false }));
    await expect(rehearse(dir, happyScript('m1'))).rejects.toThrow(/recorded result and stage kind mismatch/);
    expect(readLedger(dir).filter(r => r.kind === 'pipeline_run_started')).toHaveLength(0);
  });

  it('refuses invalid caps and outcomes before writing run evidence', async () => {
    for (const script of [happyScript('m1', { caps: { max_spend_usd: NaN, max_probe_calls: 2, max_render_calls: 1 } }),
      happyScript('m1', { outcomes: ['invented' as any] })]) {
      const dir = tempDir();
      await expect(rehearse(dir, script)).rejects.toThrow(/invalid/);
      expect(readLedger(dir)).toEqual([]);
    }
  });
  it('happy path: probe completed → probe_judging passed → render completed → chain done, within caps, ledger on chain, one mode receipt', async () => {
    const dir = tempDir();
    recordHappyPath(dir, 'm1');

    const res = await rehearse(dir, happyScript('m1'));
    expect(res.final_stage).toBe('done');
    expect(res.spent_usd).toBe(0.75);
    expect(res.spent_usd).toBeLessThanOrEqual(1);
    expect(res.probe_calls).toBe(1);
    expect(res.render_calls).toBe(1);
    expect(res.curve).toEqual({ ok: true });
    expect(res.hard_stopped).toBe(false);

    // ledger integrity: sealed chain verifies (throws on any break)
    const rows = readLedger(dir, { verify: true });
    const byKind = (k: string) => rows.filter(r => r.kind === k);
    // exactly one orchestrator_mode entry (approval → autonomous)
    expect(byKind('orchestrator_mode')).toHaveLength(1);
    expect(byKind('orchestrator_mode')[0]).toMatchObject({ from: 'approval', to: 'autonomous' });
    // one run_started per generation attempt
    expect(byKind('pipeline_run_started')).toHaveLength(2);
    // 6 transitions: submitted, passed, probe completed, judging passed,
    // render completed, chain completed
    expect(byKind('pipeline_stage')).toHaveLength(6);
    // the runner reported every seq it wrote
    expect(res.ledger_seqs).toHaveLength(1 + 2 + 6);
    // submission guard opened and closed exactly once across the paid path
    const opens = byKind('pipeline_submission').filter(r => r.action === 'open');
    const closes = byKind('pipeline_submission').filter(r => r.action === 'close');
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
    // rehearsal replays; it does not record new generations
    expect(byKind('generation')).toHaveLength(2);
  });

  it('probe failed then completed: iterate path retries, probe_attempts increment', async () => {
    const dir = tempDir();
    recordHappyPath(dir, 'm1');

    // outcomes is per ATTEMPT: probe fails once, re-probe passes, render passes
    const res = await rehearse(dir, happyScript('m1', { outcomes: ['failed', 'completed', 'completed'] }));
    expect(res.final_stage).toBe('done');
    expect(res.probe_calls).toBe(2); // the retry is a real gated probe call
    expect(res.render_calls).toBe(1);

    const rows = readLedger(dir, { verify: true });
    const byKind = (k: string) => rows.filter(r => r.kind === k);
    expect(byKind('pipeline_run_started')).toHaveLength(3);
    // transitions: submitted, passed, probe failed, revised, probe completed,
    // judging passed, render completed, chain completed
    expect(byKind('pipeline_stage')).toHaveLength(8);
    // the iterate cycle is visible in the ledger
    const tos = byKind('pipeline_stage').map(r => r.to);
    expect(tos).toContain('iterate');
    expect(tos.filter(t => t === 'probe')).toHaveLength(2);
  });

  it('nsfw outcome: quarantined + toxic, remaining stages NOT consumed', async () => {
    const dir = tempDir();
    recordHappyPath(dir, 'm1');

    const res = await rehearse(dir, happyScript('m1', { outcomes: ['nsfw'] }));
    expect(res.final_stage).toBe('quarantined');
    expect(res.probe_calls).toBe(1);
    expect(res.render_calls).toBe(0); // the render stage was never consumed

    const rows = readLedger(dir, { verify: true });
    const byKind = (k: string) => rows.filter(r => r.kind === k);
    expect(byKind('pipeline_toxic')).toHaveLength(1);
    expect(byKind('pipeline_run_started')).toHaveLength(1); // probe only
    expect(byKind('pipeline_stage').map(r => r.to)).not.toContain('full_render');
  });

  it('canSpend refusal (declared balance below estimate): hard stop semantics, hard_stopped true', async () => {
    const dir = tempDir();
    recordHappyPath(dir, 'm1');

    const res = await rehearse(dir, happyScript('m1', { declared_balance_usd: 0.1 }));
    expect(res.hard_stopped).toBe(true);
    expect(res.final_stage).toBe('probe'); // stopped at the first gated call
    expect(res.spent_usd).toBe(0); // nothing passed the gate

    const rows = readLedger(dir, { verify: true });
    const modes = rows.filter(r => r.kind === 'orchestrator_mode');
    expect(modes).toHaveLength(2); // approval→autonomous, then the hard-stop receipt
    expect(modes[1]).toMatchObject({ from: 'autonomous', to: 'approval' });
    // A refused spend leaves NO submission evidence: the gate runs BEFORE
    // submitMission, so opens === closes (both zero) and no run_started.
    const subs = rows.filter(r => r.kind === 'pipeline_submission');
    expect(subs.filter(r => r.action === 'open')).toHaveLength(0);
    expect(subs.filter(r => r.action === 'close')).toHaveLength(0);
    expect(rows.filter(r => r.kind === 'pipeline_run_started')).toHaveLength(0);
  });

  it('render failed past max_iterations (4 failures, cap 3): escalate finish, no throw, ledger balanced', async () => {
    const dir = tempDir();
    recordHappyPath(dir, 'm1');

    // Each iterate pass re-drives probe → judging → render, so stages
    // alternate probe/render; the 4th render failure redirects
    // iterate → escalate (fixed rehearsal max_iterations 3).
    const stages: RehearsalScript['stages'] = [
      { stage: 'probe', request: { endpoint: 'dop-turbo', input: PROBE_INPUT }, kind: 'probe' },
      { stage: 'full_render', request: { endpoint: 'dop-turbo', input: RENDER_INPUT }, kind: 'render' },
      { stage: 'probe', request: { endpoint: 'dop-turbo', input: PROBE_INPUT }, kind: 'probe' },
      { stage: 'full_render', request: { endpoint: 'dop-turbo', input: RENDER_INPUT }, kind: 'render' },
      { stage: 'probe', request: { endpoint: 'dop-turbo', input: PROBE_INPUT }, kind: 'probe' },
      { stage: 'full_render', request: { endpoint: 'dop-turbo', input: RENDER_INPUT }, kind: 'render' },
      { stage: 'probe', request: { endpoint: 'dop-turbo', input: PROBE_INPUT }, kind: 'probe' },
      { stage: 'full_render', request: { endpoint: 'dop-turbo', input: RENDER_INPUT }, kind: 'render' },
    ];
    const outcomes = ['completed', 'failed', 'completed', 'failed', 'completed', 'failed', 'completed', 'failed'];

    const res = await rehearse(
      dir,
      happyScript('m1', {
        caps: { max_spend_usd: 10, max_probe_calls: 4, max_render_calls: 4 },
        stages,
        outcomes,
      })
    );
    expect(res.final_stage).toBe('escalate');
    expect(res.note).toBe('iteration cap reached — escalated to operator');
    expect(res.probe_calls).toBe(4);
    expect(res.render_calls).toBe(4);
    expect(res.hard_stopped).toBe(false);

    const rows = readLedger(dir, { verify: true });
    const subs = rows.filter(r => r.kind === 'pipeline_submission');
    expect(subs.filter(r => r.action === 'open').length)
      .toBe(subs.filter(r => r.action === 'close').length);
  });

  it('outcomes exhausted mid-pipeline: finish honestly before any spend/run evidence for the phantom stage', async () => {
    const dir = tempDir();
    recordHappyPath(dir, 'm1');

    // Only the probe outcome is scripted; the render stage is unconsumed.
    const res = await rehearse(dir, happyScript('m1', { outcomes: ['completed'] }));
    expect(res.final_stage).toBe('full_render'); // stage stays as-is
    expect(res.note).toBe('script outcomes exhausted');
    expect(res.probe_calls).toBe(1);
    expect(res.render_calls).toBe(0); // the phantom render attempt never ran
    expect(res.spent_usd).toBe(0.25); // probe only

    const rows = readLedger(dir, { verify: true });
    const byKind = (k: string) => rows.filter(r => r.kind === k);
    expect(byKind('pipeline_run_started')).toHaveLength(1); // probe only
    // no spend evidence for the unconsumed render stage
    expect(byKind('pipeline_run_started').map(r => r.stage)).not.toContain('full_render');
  });

  it('fail closed: a stage missing from the replay index throws (no recorded response)', async () => {
    const dir = tempDir();
    // only the probe is recorded; the render stage has no recording
    recordFor(dir, 'm1', 'dop-turbo', PROBE_INPUT, mkResult({ request_id: 'probe-1', cost_usd: 0.25 }));

    await expect(rehearse(dir, happyScript('m1'))).rejects.toThrow(
      /^rehearsal: no recorded response for m1:dop-turbo:[0-9a-f]{12}$/
    );
  });
});
