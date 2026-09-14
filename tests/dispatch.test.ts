import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createPlan, armPlan, dispatchPlan, tailLane, pauseOrCancelLane, collectRun,
  listLanes, validatePlanCue, type DispatchPlan
} from '../src/utils/dispatch.js';
import { issueApproval, planHashOf } from '../src/utils/approvals.js';
import { readChain } from '../src/utils/receipts.js';

const basePlan = (over: Partial<DispatchPlan> = {}): DispatchPlan => ({
  schema_version: 'dispatch/0.1',
  objective: 'red test to green test',
  deliverables: ['patch'],
  acceptance_tests: ['npm test'],
  harnesses: ['pi'],
  model_policy: { requested: 'local/qwen', allow_paid: false, max_spend_usd: 0 },
  copies: 1,
  cadence: { mode: 'parallel', depends_on: [] },
  context_manifest: [],
  repo_ref: 'main',
  workspace: { kind: 'host-ephemeral' },
  permissions: { filesystem: 'rw-ephemeral', network: false, tools: [], secrets: [] },
  limits: { cost_usd: 0, wall_ms: 60000 },
  retry_limit: 1,
  approval: { required: true, mode: 'manual' },
  expected_artifacts: ['patch.diff'],
  telemetry: { redact: true, events: true },
  ...over
});

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-dispatch-'));
  process.env.TIMMY_DISPATCH_DRYRUN = '1';
});
afterAll(() => {
  delete process.env.TIMMY_DISPATCH_DRYRUN;
  rmSync(dir, { recursive: true, force: true });
});

describe('Command Post v0.1 dispatch contract', { timeout: 30000 }, () => {
  it('plan hashing is stable across key order', () => {
    const a = basePlan();
    const b = JSON.parse(JSON.stringify(a));
    b.limits = { wall_ms: 60000, cost_usd: 0 };
    expect(planHashOf(a)).toBe(planHashOf(b));
  });

  it('CUE validates structure and rejects malformed plans', () => {
    expect(validatePlanCue(basePlan(), process.cwd()).ok).toBe(true);
    const bad = basePlan() as any;
    delete bad.objective;
    const v = validatePlanCue(bad, process.cwd());
    expect(v.ok).toBe(false);
    expect(v.error_class).toBe('schema');
  });

  it('rejects unknown harnesses at plan time (lane selection)', () => {
    const r = createPlan(basePlan({ harnesses: ['skynet'] }) as DispatchPlan, dir);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('unknown harness');
    expect(listLanes().some(l => l.id === 'openhands')).toBe(true);
  });

  it('rejects out-of-envelope copies (delegated limits)', () => {
    const r = createPlan(basePlan({ copies: 9 }) as DispatchPlan, dir);
    expect(r.ok).toBe(false);
  });

  it('dispatch without arm is denied (chat prepares, authority launches)', () => {
    const c = createPlan(basePlan(), dir);
    expect(c.ok).toBe(true);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(false);
    expect(d.note).toContain('not armed');
  });

  it('approval binds the plan; mutation after arm invalidates', () => {
    const c = createPlan(basePlan(), dir);
    const hash = c.plan_hash!;
    const tok = issueApproval(hash).token;
    expect(armPlan(c.id!, tok, dir).ok).toBe(true);
    // mutate the stored plan out-of-band
    const p = join(dir, '.timmy', 'dispatch', `${c.id}.json`);
    const s = JSON.parse(readFileSync(p, 'utf8'));
    s.plan.objective = 'smuggled objective';
    writeFileSync(p, JSON.stringify(s));
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(false);
    expect(d.note).toContain('mutated');
    const last = readChain('runs', dir).at(-1) as any;
    expect(last.status).toBe('denied');
  });

  it('refuses live-checkout workspaces (isolation law, fail closed)', () => {
    const c = createPlan(basePlan({ workspace: { kind: 'host-ephemeral', path: process.cwd() } }), dir);
    const tok = issueApproval(c.plan_hash!).token;
    armPlan(c.id!, tok, dir);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(false);
    expect(d.blocked?.state).toBe('blocked');
    expect(d.note).toContain('live checkout');
  });

  it('docker isolation fails closed when the daemon is unavailable (not_configured)', () => {
    const c = createPlan(basePlan({ workspace: { kind: 'docker', image: 'ubuntu:24.04' } }), dir);
    const tok = issueApproval(c.plan_hash!).token;
    armPlan(c.id!, tok, dir);
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    const d = dispatchPlan(c.id!, dir);
    process.env.PATH = oldPath;
    expect(d.ok).toBe(false);
    expect(d.blocked?.state).toBe('not_configured');
  });

  it('dry-run dispatch → tail → collect → cancel, all receipted', () => {
    const c = createPlan(basePlan(), dir);
    const tok = issueApproval(c.plan_hash!).token;
    expect(armPlan(c.id!, tok, dir).ok).toBe(true);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(true);
    expect(d.session).toBe(`timmy-dp-${c.id}`);
    const t = tailLane(c.id!, dir);
    expect(t.ok).toBe(true);
    const col = collectRun(c.id!, dir);
    expect(col.ok).toBe(true);
    expect(col.receipt).toBeTruthy();
    const x = pauseOrCancelLane(c.id!, 'cancel', dir);
    expect(x.ok).toBe(true);
    const last = readChain('runs', dir).at(-1) as any;
    expect(last.subject).toContain('cancelled');
    // normalized events landed
    const evs = readFileSync(join(dir, '.timmy', 'receipts', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter((e: { hash?: string }) => !e.hash);
    expect(evs.some(e => e.kind === 'dispatch.launched' && e.payload?.plan_hash === c.plan_hash)).toBe(true);
    expect(evs.some(e => e.kind === 'dispatch.cancelled')).toBe(true);
  });
});
