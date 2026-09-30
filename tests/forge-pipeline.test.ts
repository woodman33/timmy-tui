import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transition, type PipelineState, type Stage, type EventName } from '../src/forge/pipeline/states.js';
import {
  submitMission,
  recordTransition,
  recordRunStarted,
  closeStaleSubmissions,
} from '../src/forge/pipeline/runner.js';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appendLedger, readLedger } from '../src/forge/ledger.js';

const ownedDirs: string[] = [];
afterEach(() => { for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeState(over: Partial<PipelineState> = {}): PipelineState {
  return {
    mission_id: 'm1',
    stage: 'intake',
    prompt_version_id: 'pv1',
    probe_attempts: 0,
    iterations: 0,
    degraded: false,
    toxic: false,
    config: { on_budget_exhausted: 'escalate', max_probe_attempts: 2, max_iterations: 3 },
    history: [],
    ...over,
  };
}

function to(stage: Stage, over: Partial<PipelineState> = {}): PipelineState {
  return makeState({ ...over, stage });
}

// drive a sequence of events from a starting state
function run(state: PipelineState, events: EventName[]): PipelineState {
  let s = state;
  for (const e of events) s = transition(s, e).state;
  return s;
}

describe('pipeline transition (pure)', () => {
  it('intake accepts only submitted and lands in pre_vetting', () => {
    const { state, entered } = transition(makeState(), 'submitted');
    expect(entered).toBe('pre_vetting');
    expect(state.stage).toBe('pre_vetting');
  });

  it('illegal transitions throw naming state + event', () => {
    expect(() => transition(to('probe'), 'submitted')).toThrow(/illegal: probe \+ submitted/);
    expect(() => transition(to('intake'), 'passed')).toThrow(/illegal: intake \+ passed/);
    expect(() => transition(to('chain'), 'revised')).toThrow(/illegal: chain \+ revised/);
  });

  it('never mutates the input state', () => {
    const s = makeState();
    const before = JSON.parse(JSON.stringify(s));
    transition(s, 'submitted');
    expect(s).toEqual(before);
  });

  it('pre_vetting: passed→probe, failed→iterate, hard_failed→quarantined', () => {
    expect(transition(to('pre_vetting'), 'passed').entered).toBe('probe');
    const it = transition(to('pre_vetting'), 'failed');
    expect(it.entered).toBe('iterate');
    expect(it.state.iterations).toBe(1);
    expect(transition(to('pre_vetting'), 'hard_failed').entered).toBe('quarantined');
  });

  it('probe: completed→probe_judging, failed/timeout→iterate with attempts+1', () => {
    expect(transition(to('probe'), 'completed').entered).toBe('probe_judging');
    const f = transition(to('probe'), 'failed');
    expect(f.entered).toBe('iterate');
    expect(f.state.probe_attempts).toBe(1);
    const t = transition(to('probe'), 'timeout');
    expect(t.entered).toBe('iterate');
    expect(t.state.probe_attempts).toBe(1);
    expect(transition(to('probe', { probe_attempts: 2 }), 'completed').state.probe_attempts).toBe(2);
  });

  it('retry rule: attempts beyond max_probe_attempts quarantine with reason', () => {
    const s = to('probe', { probe_attempts: 2, config: { ...makeState().config, max_probe_attempts: 2 } });
    const r = transition(s, 'failed');
    expect(r.entered).toBe('quarantined');
    expect(r.state.probe_attempts).toBe(3);
    // same for timeout
    expect(transition(s, 'timeout').entered).toBe('quarantined');
  });

  it('organic path: repeated probe failures quarantine at the cap — not toxic, attempts monotonic 1,2,3', () => {
    const cfg = { ...makeState().config, max_probe_attempts: 2 };
    let s = makeState({ config: cfg });
    const step = (e: EventName) => {
      const r = transition(s, e);
      s = r.state;
      return r;
    };
    step('submitted'); // intake → pre_vetting
    step('passed'); // pre_vetting → probe (fresh counter)
    let r = step('failed'); // probe #1 fail → iterate, attempts 1
    expect(r.entered).toBe('iterate');
    expect(s.probe_attempts).toBe(1);
    step('revised'); // iterate → probe (no reset)
    r = step('failed'); // probe #2 fail → iterate, attempts 2
    expect(r.entered).toBe('iterate');
    expect(s.probe_attempts).toBe(2);
    step('revised');
    r = step('failed'); // probe #3 fail exceeds cap → quarantined
    expect(r.entered).toBe('quarantined');
    expect(s.probe_attempts).toBe(3);
    expect(s.stage).toBe('quarantined');
    // retry-exhaustion quarantine is NOT toxic — the version may still be revised by hand
    expect(s.toxic).toBe(false);
  });

  it('pre_vetting + passed still resets the probe counter for a fresh version line', () => {
    const s = to('pre_vetting', { probe_attempts: 2 });
    const r = transition(s, 'passed');
    expect(r.entered).toBe('probe');
    expect(r.state.probe_attempts).toBe(0);
  });

  it('toxic rule: nsfw in probe tags toxic + quarantines; toxic refuses revised/submitted', () => {
    const r = transition(to('probe'), 'nsfw');
    expect(r.entered).toBe('quarantined');
    expect(r.state.toxic).toBe(true);
    expect(() => transition(r.state, 'revised')).toThrow(/toxic prompt version — refusing to rerun/);
    expect(() => transition(r.state, 'submitted')).toThrow(/toxic prompt version — refusing to rerun/);
  });

  it('probe_judging: passed/escalated_passed→full_render, failed/escalated_failed→iterate', () => {
    expect(transition(to('probe_judging'), 'passed').entered).toBe('full_render');
    expect(transition(to('probe_judging'), 'escalated_passed').entered).toBe('full_render');
    expect(transition(to('probe_judging'), 'failed').entered).toBe('iterate');
    expect(transition(to('probe_judging'), 'escalated_failed').entered).toBe('iterate');
  });

  it('budget exhausted: escalate config → escalate with degraded=true; abort config → aborted', () => {
    const e = transition(to('iterate'), 'budget_exhausted');
    expect(e.entered).toBe('escalate');
    expect(e.state.degraded).toBe(true);
    const a = transition(
      to('iterate', { config: { ...makeState().config, on_budget_exhausted: 'abort' } }),
      'budget_exhausted'
    );
    expect(a.entered).toBe('aborted');
  });

  it('iterate: revised→probe (attempts preserved — the cap bounds total failures), max_iterations→escalate', () => {
    const r = transition(to('iterate', { probe_attempts: 2 }), 'revised');
    expect(r.entered).toBe('probe');
    expect(r.state.probe_attempts).toBe(2);
    expect(transition(to('iterate'), 'max_iterations').entered).toBe('escalate');
  });

  it('iteration cap: entering iterate past max_iterations escalates with max_iterations event', () => {
    const cfg = { ...makeState().config, max_iterations: 1 };
    // first iterate entry is fine
    const s1 = transition(to('pre_vetting', { config: cfg }), 'failed');
    expect(s1.entered).toBe('iterate');
    expect(s1.state.iterations).toBe(1);
    // revise, probe again, fail again → second iterate entry exceeds cap
    const s2 = run(s1.state, ['revised', 'failed']);
    expect(s2.stage).toBe('escalate');
    const last = s2.history[s2.history.length - 1];
    expect(last.event).toBe('max_iterations');
    expect(last.stage).toBe('escalate');
    // escalations via the cap do NOT set degraded
    expect(s2.degraded).toBe(false);
  });

  it('escalate: approved→full_render (degraded preserved), denied→aborted', () => {
    const ap = transition(to('escalate', { degraded: true }), 'approved');
    expect(ap.entered).toBe('full_render');
    expect(ap.state.degraded).toBe(true);
    expect(transition(to('escalate'), 'denied').entered).toBe('aborted');
  });

  it('full_render: completed→chain, failed→iterate, nsfw→toxic quarantined', () => {
    expect(transition(to('full_render'), 'completed').entered).toBe('chain');
    expect(transition(to('full_render'), 'failed').entered).toBe('iterate');
    const n = transition(to('full_render'), 'nsfw');
    expect(n.entered).toBe('quarantined');
    expect(n.state.toxic).toBe(true);
  });

  it('chain: completed→done, failed→aborted', () => {
    expect(transition(to('chain'), 'completed').entered).toBe('done');
    expect(transition(to('chain'), 'failed').entered).toBe('aborted');
  });

  it('terminal states reject any event', () => {
    for (const stage of ['done', 'quarantined', 'aborted'] as Stage[]) {
      for (const ev of ['submitted', 'passed', 'revised', 'completed'] as EventName[]) {
        expect(() => transition(to(stage), ev)).toThrow(/illegal event for terminal state/);
      }
    }
  });

  it('history appends {stage, event, at_seq} with pure at_seq = history.length', () => {
    let s = makeState();
    let r = transition(s, 'submitted');
    expect(r.state.history).toEqual([{ stage: 'pre_vetting', event: 'submitted', at_seq: 0 }]);
    r = transition(r.state, 'passed');
    expect(r.state.history[1]).toEqual({ stage: 'probe', event: 'passed', at_seq: 1 });
  });

  it('full happy path intake→done via valid events', () => {
    const final = run(makeState(), [
      'submitted', // intake → pre_vetting
      'passed', // → probe
      'completed', // → probe_judging
      'passed', // → full_render
      'completed', // → chain
      'completed', // → done
    ]);
    expect(final.stage).toBe('done');
    expect(final.history).toHaveLength(6);
  });
});

describe('pipeline runner (ledger I/O)', () => {
  const submission = { mission_id: 'm1', prompt_version_id: 'pv1', segment: 'seg1' };

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-pipeline-'));
    ownedDirs.push(dir);
    return dir;
  }

  it('submitMission accepts a new submission and writes an open record', () => {
    const dir = freshDir();
    const r = submitMission(dir, submission);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.at_seq).toBe(0);
    const rows = readLedger(dir);
    expect(rows[0].kind).toBe('pipeline_submission');
    expect(rows[0].action).toBe('open');
    expect(rows[0].mission_id).toBe('m1');
  });

  it('refuses duplicate in-flight submission with the same triple', () => {
    const dir = freshDir();
    expect(submitMission(dir, submission).ok).toBe(true);
    const dup = submitMission(dir, submission);
    expect(dup).toEqual({ ok: false, reason: 'duplicate submission in flight' });
  });

  it('allows a different triple while one is in flight', () => {
    const dir = freshDir();
    expect(submitMission(dir, submission).ok).toBe(true);
    expect(submitMission(dir, { ...submission, segment: 'seg2' }).ok).toBe(true);
  });

  it('clears the triple on region exit (probe→iterate), allowing resubmission', () => {
    const dir = freshDir();
    submitMission(dir, submission);
    const prev = to('probe');
    const next = transition(prev, 'failed').state;
    recordTransition(dir, prev, next, 'failed');
    expect(submitMission(dir, submission).ok).toBe(true);
  });

  it('closes the triple on probe_judging→iterate (judge rejects the probe), allowing resubmission', () => {
    const dir = freshDir();
    submitMission(dir, submission);
    // probe → probe_judging: no close
    const prev1 = to('probe');
    const next1 = transition(prev1, 'completed').state;
    recordTransition(dir, prev1, next1, 'completed');
    expect(submitMission(dir, submission)).toEqual({ ok: false, reason: 'duplicate submission in flight' });
    // probe_judging → iterate via failed: region exit closes the triple
    const prev2 = next1;
    const next2 = transition(prev2, 'failed').state;
    expect(next2.stage).toBe('iterate');
    recordTransition(dir, prev2, next2, 'failed');
    expect(submitMission(dir, submission).ok).toBe(true);
  });

  it('recordTransition writes a pipeline_stage record with from/to/event', () => {
    const dir = freshDir();
    const prev = to('probe');
    const next = transition(prev, 'completed').state;
    recordTransition(dir, prev, next, 'completed');
    const rows = readLedger(dir);
    expect(rows[0].kind).toBe('pipeline_stage');
    expect(rows[0].from).toBe('probe');
    expect(rows[0].to).toBe('probe_judging');
    expect(rows[0].event).toBe('completed');
  });

  it('full_render exit also closes the submission', () => {
    const dir = freshDir();
    submitMission(dir, submission);
    const prev = to('full_render');
    const next = transition(prev, 'completed').state;
    recordTransition(dir, prev, next, 'completed');
    expect(submitMission(dir, submission).ok).toBe(true);
  });

  it('nsfw writes a pipeline_toxic record bound to the prompt version', () => {
    const dir = freshDir();
    const prev = to('probe');
    const next = transition(prev, 'nsfw').state;
    recordTransition(dir, prev, next, 'nsfw');
    const rows = readLedger(dir);
    const toxic = rows.find(r => r.kind === 'pipeline_toxic');
    expect(toxic).toBeDefined();
    expect(toxic!.prompt_version_id).toBe('pv1');
  });

  it('duplicate detection survives unrelated records and closes', () => {
    const dir = freshDir();
    submitMission(dir, submission); // open pv1/seg1
    // unrelated mission activity
    submitMission(dir, { mission_id: 'm2', prompt_version_id: 'pv9', segment: 'seg9' });
    expect(submitMission(dir, submission).ok).toBe(false);
    // close pv1/seg1 via probe exit, then a stale close for an already-closed open is a no-op hazard;
    // the fresh open must still be detected
    const prev = to('probe');
    const next = transition(prev, 'failed').state;
    recordTransition(dir, prev, next, 'failed');
    expect(submitMission(dir, submission).ok).toBe(true);
  });

  it('organic path: submission stays open probe→probe_judging→full_render, closes at full_render→chain', () => {
    const dir = freshDir();
    expect(submitMission(dir, submission).ok).toBe(true);
    // probe → probe_judging: no close — same triple still refused
    const prev1 = to('probe');
    const next1 = transition(prev1, 'completed').state;
    recordTransition(dir, prev1, next1, 'completed');
    expect(submitMission(dir, submission)).toEqual({ ok: false, reason: 'duplicate submission in flight' });
    // probe_judging → full_render: no new open needed; the paid full_render is still guarded
    const prev2 = next1;
    const next2 = transition(prev2, 'passed').state;
    recordTransition(dir, prev2, next2, 'passed');
    expect(submitMission(dir, submission)).toEqual({ ok: false, reason: 'duplicate submission in flight' });
    // full_render → chain: region exit closes the triple; resubmission accepted
    const prev3 = next2;
    const next3 = transition(prev3, 'completed').state;
    recordTransition(dir, prev3, next3, 'completed');
    expect(submitMission(dir, submission).ok).toBe(true);
  });

  it('closeStaleSubmissions reaps crash-stale opens with seq < beforeSeq only', () => {
    const dir = freshDir();
    const r = submitMission(dir, submission);
    expect(r.ok).toBe(true);
    const openSeq = r.ok ? r.at_seq : -1;
    // crash: no close record lands. Reaping at/before the open seq is a no-op.
    expect(closeStaleSubmissions(dir, openSeq)).toBe(0);
    expect(submitMission(dir, submission)).toEqual({ ok: false, reason: 'duplicate submission in flight' });
    // Operator-authorized reap beyond the open seq: close lands, resubmission accepted.
    expect(closeStaleSubmissions(dir, openSeq + 1)).toBe(1);
    expect(submitMission(dir, submission).ok).toBe(true);
  });

  it('recordRunStarted lands a pipeline_run_started record readable via readLedger', () => {
    const dir = freshDir();
    recordRunStarted(dir, {
      mission_id: 'm1',
      prompt_version_id: 'pv1',
      segment: 'seg1',
      stage: 'full_render',
      endpoint: 'fal.ai/xyz',
      plan_seq: 7,
    });
    const rows = readLedger(dir);
    const rec = rows.find(r => r.kind === 'pipeline_run_started');
    expect(rec).toBeDefined();
    expect(rec!.mission_id).toBe('m1');
    expect(rec!.prompt_version_id).toBe('pv1');
    expect(rec!.segment).toBe('seg1');
    expect(rec!.stage).toBe('full_render');
    expect(rec!.endpoint).toBe('fal.ai/xyz');
    expect(rec!.plan_seq).toBe(7);
  });

  it('refuses admission and reaping on a tampered chain', () => {
    const dir = freshDir();
    submitMission(dir, submission);
    const path = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    const bad = readFileSync(path, 'utf8').replace('seg1', 'changed');
    writeFileSync(path, bad);
    expect(() => submitMission(dir, submission)).toThrow(/chain broken/);
    expect(() => closeStaleSubmissions(dir, 999)).toThrow(/chain broken/);
    expect(readFileSync(path, 'utf8')).toBe(bad);
  });

  it('reaps only the exact stale segment and preserves newer guards', () => {
    const dir = freshDir();
    submitMission(dir, submission);
    submitMission(dir, { ...submission, segment: 'seg2' });
    expect(closeStaleSubmissions(dir, 1)).toBe(1);
    expect(submitMission(dir, { ...submission, segment: 'seg2' }).ok).toBe(false);
    expect(submitMission(dir, submission).ok).toBe(true);
    // A duplicate old close must not clear the new open for the same triple.
    appendLedger({ kind: 'pipeline_submission', ...submission, action: 'close', open_seq: 0 }, dir);
    expect(submitMission(dir, submission).ok).toBe(false);
  });

  it('matches legacy close records by full triple', () => {
    const dir = freshDir();
    submitMission(dir, submission);
    submitMission(dir, { ...submission, segment: 'seg2' });
    appendLedger({ kind: 'pipeline_submission', ...submission, action: 'close' }, dir);
    expect(submitMission(dir, { ...submission, segment: 'seg2' }).ok).toBe(false);
    expect(submitMission(dir, submission).ok).toBe(true);
  });

  it('refuses ambiguous transitions before writing and accepts exact open identity', () => {
    const dir = freshDir();
    const first = submitMission(dir, submission);
    submitMission(dir, { ...submission, segment: 'seg2' });
    const prev = to('probe'), next = transition(prev, 'failed').state;
    const before = readLedger(dir);
    expect(() => recordTransition(dir, prev, next, 'failed')).toThrow(/ambiguous/);
    expect(readLedger(dir)).toEqual(before);
    recordTransition(dir, prev, next, 'failed', first.ok ? first.at_seq : -1);
    expect(submitMission(dir, submission).ok).toBe(true);
    expect(submitMission(dir, { ...submission, segment: 'seg2' }).ok).toBe(false);
  });

  it('rejects toxic versions from retained markers and partial transition writes', () => {
    for (const kind of ['pipeline_toxic', 'pipeline_stage']) {
      const dir = freshDir();
      appendLedger({ kind, prompt_version_id: 'pv1', event: 'nsfw' }, dir);
      expect(submitMission(dir, submission)).toEqual({ ok: false, reason: 'toxic prompt version — refusing to rerun' });
    }
  });

  it('does not alias delimiter-containing identities', () => {
    const dir = freshDir();
    expect(submitMission(dir, { ...submission, prompt_version_id: 'p::x', segment: 'y' }).ok).toBe(true);
    expect(submitMission(dir, { ...submission, prompt_version_id: 'p', segment: 'x::y' }).ok).toBe(true);
  });

  it('admits only one concurrent process for an identical submission', async () => {
    const dir = freshDir();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/forge/pipeline/runner.ts')).href;
    const source = `import { submitMission } from ${JSON.stringify(moduleUrl)};
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => { console.log(JSON.stringify(submitMission(${JSON.stringify(dir)}, ${JSON.stringify(submission)}))); });`;
    const children = Array.from({ length: 4 }, () => spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] }));
    const results = children.map(child => new Promise<string>((resolve, reject) => {
      let output = '', err = '';
      child.stdout.on('data', data => { output += String(data); });
      child.stderr.on('data', data => { err += String(data); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output) : reject(new Error(err)));
    }));
    try {
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve()); child.once('error', reject);
      })));
      for (const child of children) child.stdin.end('go');
      const outputs = await Promise.all(results);
      const accepted = outputs.map(output => JSON.parse(output.trim().split('\n').at(-1)!));
      expect(accepted.filter(r => r.ok)).toHaveLength(1);
      expect(readLedger(dir)).toHaveLength(1);
    } finally { for (const child of children) child.kill(); }
  });
});

describe('bounded pipeline retry state', () => {
  it('retains total failures through a completed probe rejected by judging', () => {
    const state = run(to('probe', { config: { ...makeState().config, max_iterations: 20 } }),
      ['failed', 'revised', 'completed', 'failed', 'revised', 'failed', 'revised', 'failed']);
    expect(state.stage).toBe('quarantined');
    expect(state.probe_attempts).toBe(3);
  });
  it('handles a full render timeout as a retryable failure', () => {
    expect(transition(to('full_render'), 'timeout').entered).toBe('iterate');
  });
  it.each([NaN, Infinity, -1, 1.5])('refuses malformed counters or limits: %s', value => {
    expect(() => transition(to('probe', { probe_attempts: value }), 'failed')).toThrow(/invalid pipeline/);
    expect(() => transition(to('probe', { iterations: value }), 'failed')).toThrow(/invalid pipeline/);
    expect(() => transition(to('probe', { config: { ...makeState().config, max_probe_attempts: value } }), 'failed')).toThrow(/invalid pipeline/);
    expect(() => transition(to('probe', { config: { ...makeState().config, max_iterations: value } }), 'failed')).toThrow(/invalid pipeline/);
  });
});
