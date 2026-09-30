// Task 15: forge MCP tool surface tests — implementations in src/forge/mcp-tools.ts
// (NOT through the MCP wire; server.ts dispatch is one line per case).
// All chain/ledger writes go to a tmp dir — the real store is never touched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { forgeRun, forgeStatus, forgeApprove, forgeRunPlanOf } from '../src/forge/mcp-tools.js';
import { planHashOf } from '../src/utils/approvals.js';
import { appendLedger } from '../src/forge/ledger.js';
import { appendReceipt, readChain, receiptsPath, rotateEpoch } from '../src/utils/receipts.js';

let dir: string;
let savedForge: string | undefined, savedCredentials: string | undefined;
const realCwd = process.cwd();
beforeEach(() => {
  savedForge = process.env.TIMMY_FORGE; savedCredentials = process.env.HF_CREDENTIALS;
  dir = mkdtempSync(join(tmpdir(), 'forge-mcp-test-'));
  process.env.TIMMY_FORGE = '1';
  delete process.env.HF_CREDENTIALS;
});
afterEach(() => {
  if (savedForge === undefined) delete process.env.TIMMY_FORGE; else process.env.TIMMY_FORGE = savedForge;
  if (savedCredentials === undefined) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = savedCredentials;
  rmSync(dir, { recursive: true, force: true });
  if (process.cwd() !== realCwd) process.chdir(realCwd);
});

describe('timmy_forge_run (forge.plan)', () => {
  const brief = {
    mission_id: 'mission-x', prompt: 'a keeper who trusts receipts',
    beats: [{ id: 'hook1', t: 0 }, { id: 'turn', t: 2 }], stage: 't2i' as const, provider: 'higgsfield-stub' as const,
    max_spend_usd: 0.5, declared_balance_usd: 4,
  };

  it('builds a plan whose hash matches the exported plan shape', () => {
    const r = forgeRun(brief, dir);
    expect(r.ok).toBe(true);
    expect(r.planHash).toBe(planHashOf(forgeRunPlanOf(brief)));
    expect(r.planHash).toMatch(/^[0-9a-f]{32}$/);
    expect(r.next).toBe(`timmy_forge_approve ${r.planHash}`);
  });

  it('passes caps through and defaults mode to approval', () => {
    const r = forgeRun(brief, dir);
    expect(r.caps).toEqual({ max_spend_usd: 0.5, declared_balance_usd: 4 });
    expect(r.mode).toBe('approval');
  });

  it('defaults caps when omitted', () => {
    const { max_spend_usd: _m, declared_balance_usd: _d, ...rest } = brief;
    const r = forgeRun({ ...rest, max_spend_usd: undefined }, dir);
    expect(r.caps).toEqual({ max_spend_usd: 0, declared_balance_usd: null });
  });

  it('live higgsfield without HF_CREDENTIALS: plan still built, readiness needs_key, warning set, no throw', () => {
    const r = forgeRun({ ...brief, provider: 'higgsfield' }, dir);
    expect(r.ok).toBe(true);
    expect(r.readiness.status).toBe('needs_key');
    expect(r.warning).toMatch(/live spend blocked/);
  });

  it('live higgsfield with valid HF_CREDENTIALS: readiness ready, no warning', () => {
    process.env.HF_CREDENTIALS = 'KEY123:secret456';
    const r = forgeRun({ ...brief, provider: 'higgsfield' }, dir);
    expect(r.readiness.status).toBe('ready');
    expect(r.warning).toBeUndefined();
  });

  it('seals exactly one forge.plan receipt per call', () => {
    const before = readChain('runs', dir).length;
    const r = forgeRun(brief, dir);
    const chain = readChain('runs', dir);
    expect(chain.length).toBe(before + 1);
    expect(chain[chain.length - 1].kind).toBe('forge.plan');
    expect(chain[chain.length - 1].hash).toBe(r.receipt);
  });
});

describe('timmy_forge_status', () => {
  it('empty ledger → intake/approval/0/false', () => {
    const r = forgeStatus('mission-x', dir);
    expect(r).toMatchObject({ ok: true, stage: 'intake', submissions_open: 0, toxic: false, mode: 'approval' });
  });

  it('reads latest stage/mode and open submission count from seeded ledger', () => {
    appendLedger({ kind: 'pipeline_submission', mission_id: 'mission-x', prompt_version_id: 'pv1', segment: 'seg1', action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_submission', mission_id: 'mission-x', prompt_version_id: 'pv1', segment: 'seg2', action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_stage', mission_id: 'mission-x', prompt_version_id: 'pv1', from: 'intake', to: 'probe', event: 'submitted' }, dir);
    appendLedger({ kind: 'orchestrator_mode', mission_id: 'mission-x', from: 'approval', to: 'autonomous', reason: 'operator plan approval' }, dir);
    appendLedger({ kind: 'pipeline_stage', mission_id: 'mission-x', prompt_version_id: 'pv1', from: 'probe', to: 'probe_judging', event: 'probe_done' }, dir);
    appendLedger({ kind: 'pipeline_toxic', prompt_version_id: 'pv9' }, dir); // other mission's pv — not toxic for us
    const r = forgeStatus('mission-x', dir);
    expect(r).toMatchObject({ ok: true, stage: 'probe_judging', submissions_open: 2, toxic: false, mode: 'autonomous' });
  });

  it('toxic true when a pipeline_toxic record matches a mission prompt_version', () => {
    appendLedger({ kind: 'pipeline_stage', mission_id: 'mission-x', prompt_version_id: 'pv1', from: 'probe', to: 'quarantined', event: 'nsfw' }, dir);
    appendLedger({ kind: 'pipeline_toxic', prompt_version_id: 'pv1' }, dir);
    expect(forgeStatus('mission-x', dir).toxic).toBe(true);
  });

  it('close actions decrement the open count (floor 0)', () => {
    appendLedger({ kind: 'pipeline_submission', mission_id: 'mission-x', prompt_version_id: 'pv1', segment: 'seg1', action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_submission', mission_id: 'mission-x', prompt_version_id: 'pv1', segment: 'seg1', action: 'close' }, dir);
    appendLedger({ kind: 'pipeline_submission', mission_id: 'mission-x', prompt_version_id: 'pv1', segment: 'seg1', action: 'close' }, dir);
    expect(forgeStatus('mission-x', dir).submissions_open).toBe(0);
  });

  it('other missions’ records do not leak into the count', () => {
    appendLedger({ kind: 'pipeline_submission', mission_id: 'mission-other', prompt_version_id: 'pv1', segment: 'seg1', action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_stage', mission_id: 'mission-other', prompt_version_id: 'pv1', from: 'intake', to: 'probe', event: 'submitted' }, dir);
    expect(forgeStatus('mission-x', dir)).toMatchObject({ stage: 'intake', submissions_open: 0 });
  });

  it('invalid mission_id → {ok:false, reason} + denied forge.status receipt', () => {
    const before = readChain('runs', dir).length;
    const r = forgeStatus('', dir);
    expect(r.ok).toBe(false);
    expect((r as { reason?: string }).reason).toMatch(/mission_id must be a string of 1\.\.128/);
    const chain = readChain('runs', dir);
    expect(chain.length).toBe(before + 1);
    const rec = chain[chain.length - 1];
    expect(rec.kind).toBe('forge.status');
    expect(rec.status).toBe('denied');
    expect(rec.hash).toBe((r as { receipt: string }).receipt);
  });

  it('seals exactly one forge.status receipt per call', () => {
    const before = readChain('runs', dir).length;
    const r = forgeStatus('mission-x', dir);
    const chain = readChain('runs', dir);
    expect(chain.length).toBe(before + 1);
    expect(chain[chain.length - 1].kind).toBe('forge.status');
    expect(chain[chain.length - 1].hash).toBe(r.receipt);
  });
});

describe('timmy_forge_approve (surface-only)', () => {
  const runPlan = () => forgeRun({
    mission_id: 'm', prompt: 'p', stage: 'i2v', provider: 'higgsfield-stub',
  }, dir);

  it('sealed plan → surfaces the operator CLI command, mints nothing', () => {
    const { planHash } = runPlan();
    const r = forgeApprove(planHash, dir);
    expect(r).toMatchObject({
      ok: true, approved: false, needs: 'operator', plan_sealed: true,
      cli: `timmy approve ${planHash}`,
    });
    expect(r.note).toMatch(/agents cannot self-approve/);
    // NO token minted: no token/ttl fields at all (issueApproval is not
    // imported here anymore — this is the structural no-mint assertion).
    expect('token' in r).toBe(false);
    expect('ttl_s' in r).toBe(false);
  });

  it('ok:false for an unknown hash (no sealed forge.plan on the chain)', () => {
    const r = forgeApprove(planHashOf({ tool: 'timmy_forge_run' }), dir);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no sealed forge\.plan for this hash/);
  });

  it('seals one forge.approve receipt with status surfaced for a sealed plan', () => {
    const { planHash } = runPlan();
    const before = readChain('runs', dir).length;
    const r = forgeApprove(planHash, dir);
    const chain = readChain('runs', dir);
    expect(chain.length).toBe(before + 1);
    const rec = chain[chain.length - 1];
    expect(rec.kind).toBe('forge.approve');
    expect(rec.status).toBe('surfaced'); // not a mint
    expect(rec.subject).toBe(planHash);
    expect(rec.hash).toBe(r.receipt);
  });

  it('unknown hash seals one denied forge.approve receipt', () => {
    const unknown = planHashOf({ tool: 'timmy_forge_run' });
    const before = readChain('runs', dir).length;
    const r = forgeApprove(unknown, dir);
    const chain = readChain('runs', dir);
    expect(chain.length).toBe(before + 1);
    expect(chain[chain.length - 1].status).toBe('denied');
    expect(chain[chain.length - 1].hash).toBe(r.receipt);
  });

  it('malformed planHash → error result, not a crash, still receipted', () => {
    const before = readChain('runs', dir).length;
    const r = forgeApprove('not-a-hash', dir);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed planHash/);
    const chain = readChain('runs', dir);
    expect(chain.length).toBe(before + 1);
    expect(chain[chain.length - 1].kind).toBe('forge.approve');
    expect(chain[chain.length - 1].status).toBe('denied');
  });
});

describe('timmy_forge_run brief validation (hostile-caller review)', () => {
  const valid = {
    mission_id: 'm', prompt: 'p', stage: 't2i' as const, provider: 'higgsfield-stub' as const,
  };
  // Every denial: ok:false + reason, exactly one forge.plan denial receipt,
  // and NO ok plan is built.
  const expectDenial = (r: { ok: boolean; reason?: string }, dir: string, why: RegExp) => {
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(why);
    const chain = readChain('runs', dir);
    expect(chain[chain.length - 1].kind).toBe('forge.plan');
    expect(chain[chain.length - 1].status).toBe('denied');
    expect(chain.some(c => c.kind === 'forge.plan' && c.status === 'ok')).toBe(false);
  };

  it('{} brief → denial, not a crash', () => {
    const before = readChain('runs', dir).length;
    const r = forgeRun({} as never, dir);
    expectDenial(r, dir, /mission_id/);
    expect(readChain('runs', dir).length).toBe(before + 1);
  });

  it('missing mission_id → denial', () => {
    const { mission_id: _m, ...rest } = valid;
    expectDenial(forgeRun(rest as never, dir), dir, /mission_id/);
  });

  it('bad stage enum → denial', () => {
    expectDenial(forgeRun({ ...valid, stage: 'x2x' as never }, dir), dir, /stage/);
  });

  it('bad provider enum → denial', () => {
    expectDenial(forgeRun({ ...valid, provider: 'evil-provider' as never }, dir), dir, /provider/);
  });

  it('non-array beats → denial', () => {
    expectDenial(forgeRun({ ...valid, beats: 'hook1' as never }, dir), dir, /beats/);
  });

  it('beats > 100 → denial', () => {
    const beats = Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, t: i }));
    expectDenial(forgeRun({ ...valid, beats }, dir), dir, /at most 100/);
  });

  it('beat with NaN t → denial', () => {
    expectDenial(forgeRun({ ...valid, beats: [{ id: 'b', t: NaN }] }, dir), dir, /finite/);
  });

  it('beat with string id → denial', () => {
    expectDenial(forgeRun({ ...valid, beats: [{ id: 7 as never, t: 1 }] }, dir), dir, /beat\.id/);
  });

  it('negative max_spend_usd → denial', () => {
    expectDenial(forgeRun({ ...valid, max_spend_usd: -1 }, dir), dir, /max_spend_usd/);
  });

  it('string max_spend_usd → denial', () => {
    expectDenial(forgeRun({ ...valid, max_spend_usd: '0.5' as never }, dir), dir, /max_spend_usd/);
  });

  it('Infinity declared_balance_usd → denial', () => {
    expectDenial(forgeRun({ ...valid, declared_balance_usd: Infinity }, dir), dir, /declared_balance_usd/);
  });

  it('oversized prompt (> 256KB) → denial', () => {
    expectDenial(forgeRun({ ...valid, prompt: 'x'.repeat(262145) }, dir), dir, /prompt/);
  });

  it('prompt at exactly 256KB is accepted', () => {
    const r = forgeRun({ ...valid, prompt: 'x'.repeat(262144) }, dir);
    expect(r.ok).toBe(true);
  });

  it('newline/quotes mission_id → chain still parses one-record-per-line', () => {
    const missionId = 'mission\nwith "quotes" and\ttabs';
    const before = readChain('runs', dir).length;
    const r = forgeRun({ ...valid, mission_id: missionId }, dir);
    expect(r.ok).toBe(true);
    // The JSONL chain must round-trip: exactly one new record, parseable.
    const chain = readChain('runs', dir);
    expect(chain.length).toBe(before + 1);
    expect(chain[chain.length - 1].hash).toBe(r.receipt);
    // Re-read from disk proves the physical file stayed one-record-per-line.
    const raw = readChain('runs', dir);
    expect(raw.length).toBe(chain.length);
  });
});

describe('TIMMY_FORGE gate (D1)', () => {
  it('all three tools refuse without TIMMY_FORGE=1, each sealing one receipt', () => {
    delete process.env.TIMMY_FORGE;
    const before = readChain('runs', dir).length;
    const r1 = forgeRun({ mission_id: 'm', prompt: 'p', stage: 't2i', provider: 'higgsfield-stub' }, dir);
    const r2 = forgeStatus('m', dir);
    const r3 = forgeApprove(planHashOf({ x: 1 }), dir);
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(false);
      expect((r as { error?: string }).error).toMatch(/TIMMY_FORGE=1/);
    }
    expect(readChain('runs', dir).length).toBe(before + 3);
  });
});


describe('MCP hostile shapes and verified projections', () => {
  const brief = { mission_id: 'mission-x', prompt: 'synthetic prompt', stage: 't2i' as const, provider: 'higgsfield-stub' as const };
  const submission = { mission_id: 'mission-x', prompt_version_id: 'pv1', segment: 'main' };

  it.each(['stage', 'provider'])('rejects arrays in the %s enum', key => {
    const value = key === 'stage' ? ['t2i'] : ['higgsfield-stub'];
    expect(forgeRun({ ...brief, [key]: value } as never, dir).ok).toBe(false);
    expect(readChain('runs', dir)).toHaveLength(1);
    expect(readChain('runs', dir)[0].status).toBe('denied');
  });

  it('rejects coerced mission and approval identifiers', () => {
    expect(forgeStatus(['mission-x'], dir).ok).toBe(false);
    const plan = forgeRun(brief, dir);
    expect(forgeApprove([plan.planHash], dir).ok).toBe(false);
  });

  it('retains a newer open after a stale exact close and unrelated legacy close', () => {
    const first = appendLedger({ kind: 'pipeline_submission', ...submission, action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_submission', ...submission, action: 'close', open_seq: first.seq }, dir);
    appendLedger({ kind: 'pipeline_submission', ...submission, action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_submission', ...submission, action: 'close', open_seq: first.seq }, dir);
    appendLedger({ kind: 'pipeline_submission', ...submission, segment: 'other', action: 'close' }, dir);
    expect(forgeStatus('mission-x', dir)).toMatchObject({ ok: true, submissions_open: 1 });
  });

  it('refuses cross-triple close identities', () => {
    const first = appendLedger({ kind: 'pipeline_submission', ...submission, action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_submission', ...submission, segment: 'other', action: 'close', open_seq: first.seq }, dir);
    expect(forgeStatus('mission-x', dir)).toMatchObject({ ok: false, reason: 'forge ledger could not be verified' });
    expect(readChain('runs', dir).at(-1)?.status).toBe('failed');
  });

  it('detects toxicity before the first stage and after a partial NSFW transition', () => {
    appendLedger({ kind: 'pipeline_submission', ...submission, action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_toxic', prompt_version_id: 'unrelated' }, dir);
    expect(forgeStatus('mission-x', dir)).toMatchObject({ toxic: false });
    appendLedger({ kind: 'pipeline_stage', ...submission, to: 'quarantined', event: 'nsfw' }, dir);
    expect(forgeStatus('mission-x', dir)).toMatchObject({ toxic: true });
  });

  it('detects global toxic markers for submission-only versions', () => {
    appendLedger({ kind: 'pipeline_submission', ...submission, action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_toxic', prompt_version_id: 'pv1' }, dir);
    expect(forgeStatus('mission-x', dir)).toMatchObject({ toxic: true });
  });

  it.each(['denied', 'failed'])('does not surface a %s plan receipt', status => {
    const hash = planHashOf({ synthetic: true });
    appendReceipt('runs', { kind: 'forge.plan', subject: 'synthetic', policy: 'auto',
      status: status as 'denied' | 'failed', plan_hash: hash, spans: [], artifacts: [] }, dir);
    expect(forgeApprove(hash, dir).ok).toBe(false);
    expect(readChain('runs', dir).at(-1)?.status).toBe('denied');
  });

  it('refuses a plan from a tampered chain', () => {
    const plan = forgeRun(brief, dir);
    const path = receiptsPath('runs', dir);
    writeFileSync(path, readFileSync(path, 'utf8').replace('forge plan mission-x', 'forge plan modified'));
    expect(forgeApprove(plan.planHash, dir)).toMatchObject({ ok: false, error: 'forge plan history could not be verified' });
  });

  it('does not overlook malformed trailing history', () => {
    const plan = forgeRun(brief, dir);
    const path = receiptsPath('runs', dir);
    appendFileSync(path, 'invalid json\n');
    const before = readFileSync(path, 'utf8');
    expect(forgeApprove(plan.planHash, dir).ok).toBe(false);
    expect(readFileSync(path, 'utf8').startsWith(before)).toBe(true);
  });

  it('does not ignore a broken historical epoch when surfacing approval', () => {
    const plan = forgeRun(brief, dir);
    const path = receiptsPath('runs', dir);
    writeFileSync(path, readFileSync(path, 'utf8').replace('forge plan mission-x', 'forge plan modified'));
    rotateEpoch(2, 'synthetic test', dir);
    expect(forgeApprove(plan.planHash, dir).ok).toBe(false);
  });
});


describe('plan-builder input boundary', () => {
  it.each([
    [{ id: 'same', t: 0 }, { id: 'same', t: 1 }],
    [{ id: 'a', t: 0 }, { id: 'b', t: 0 }],
    [{ id: 'a', t: 0, unbound: 'synthetic' }],
  ])('refuses ambiguous or extra beat fields', (...beats) => {
    const result = forgeRun({ mission_id: 'm', prompt: 'p', stage: 't2i', provider: 'higgsfield-stub', beats: beats as never }, dir);
    expect(result.ok).toBe(false);
    expect(readChain('runs', dir)).toHaveLength(1);
    expect(readChain('runs', dir)[0].status).toBe('denied');
  });
});


describe('global runner and status projection agreement', () => {
  it('refuses a foreign-mission close targeting the requested mission opening', () => {
    const opening = appendLedger({ kind: 'pipeline_submission', mission_id: 'wanted',
      prompt_version_id: 'pv1', segment: 'main', action: 'open' }, dir);
    appendLedger({ kind: 'pipeline_submission', mission_id: 'foreign',
      prompt_version_id: 'pv1', segment: 'main', action: 'close', open_seq: opening.seq }, dir);
    expect(forgeStatus('wanted', dir)).toMatchObject({ ok: false, reason: 'forge ledger could not be verified' });
    expect(readChain('runs', dir).at(-1)?.status).toBe('failed');
  });
});
