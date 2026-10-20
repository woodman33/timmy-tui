import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import {
  createPlan, armPlan, dispatchPlan, coneToContextManifest, getPlan, pauseOrCancelLane, type DispatchPlan
} from '../src/utils/dispatch.js';
import { issueApproval } from '../src/utils/approvals.js';
import type { ContextCone } from '../src/utils/context-cone.js';
import { dispatchTmuxOfItsOwn } from './helpers/dispatch-tmux.js';
import { dispatchTempOfItsOwn } from './helpers/dispatch-temp.js';

// R8 (H156; R7's open item H): this file's dry-run dispatch session goes on a tmux server of its own, stopped after its tests,
// and its afterAll checks that it left none on the default server (it left one there after each full suite up to R7)
dispatchTmuxOfItsOwn();
// R9 (H161; R8's open item K): its dispatches' copies are made in a temporary folder of its own, counted after its tests (it
// left two after each run before R9: the clean dispatch's, and the copy the refused one made before it was refused)
const temp = dispatchTempOfItsOwn();

const sha = (p: string): string => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');

const basePlan = (over: Partial<DispatchPlan> = {}): DispatchPlan => ({
  schema_version: 'dispatch/0.1',
  objective: 'cone-budgeted capsule',
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

// L0 100 + L1 200 = 300; L2 500 only fits under a >= 800 budget
const cone = (budget: number): ContextCone => ({
  schema_version: 'cone/0.1',
  budget_tokens: budget,
  tiers: {
    L0: [{ id: 'apex', tier: 'L0', kind: 'manifest', summary: 'apex manifest', tokens: 100, path: 'package.json' }],
    L1: [{ id: 'skel', tier: 'L1', kind: 'skeleton', summary: 'dispatch schema', tokens: 200, path: 'schemas/dispatch.cue' }],
    L2: [{ id: 'deep', tier: 'L2', kind: 'diff', summary: 'changelog trace', tokens: 500, path: 'CHANGELOG.md', recency: 1 }]
  }
});

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-cone-dispatch-'));
  process.env.TIMMY_DISPATCH_DRYRUN = '1';
});
afterAll(() => {
  delete process.env.TIMMY_DISPATCH_DRYRUN;
  rmSync(dir, { recursive: true, force: true });
});

describe('Context Cone → dispatch capsule (V-01 rung 2)', () => {
  it('coneToContextManifest selects under budget and sha-pins real slices', () => {
    const r = coneToContextManifest(cone(400), { repoRoot: process.cwd() });
    expect(r.ok).toBe(true);
    expect(r.selection!.tokens).toBe(300); // L2 foraged past, not trimmed
    expect(r.manifest!.map(m => m.path)).toEqual(['package.json', 'schemas/dispatch.cue']);
    expect(r.manifest![0].sha256).toBe(sha(join(process.cwd(), 'package.json')));
  });

  it('createPlan with a cone derives the manifest + provenance (CUE-valid)', () => {
    const c = createPlan(basePlan(), dir, cone(400));
    expect(c.ok).toBe(true);
    const stored = JSON.parse(readFileSync(join(dir, '.timmy', 'dispatch', `${c.id}.json`), 'utf8'));
    expect(stored.plan.context_manifest).toHaveLength(2);
    expect(stored.plan.context_cone.budget_tokens).toBe(400);
    expect(stored.plan.context_cone.selected_tokens).toBe(300);
    expect(stored.plan.context_cone.entries.some((e: { tier: string }) => e.tier === 'L0')).toBe(true);
  });

  it('fails closed when the L0 apex alone exceeds the budget', () => {
    const c = createPlan(basePlan(), dir, cone(50));
    expect(c.ok).toBe(false);
    expect(c.note).toContain('L0 apex');
  });

  it('isolation refuses unconstrained blobs riding a cone plan', () => {
    const plan = basePlan({
      context_manifest: [
        { path: 'package.json', sha256: sha(join(process.cwd(), 'package.json')) },
        { path: 'README.md', sha256: sha(join(process.cwd(), 'README.md')) }
      ],
      context_cone: {
        budget_tokens: 400,
        selected_tokens: 100,
        entries: [{ id: 'apex', tier: 'L0', tokens: 100, path: 'package.json' }]
      }
    });
    const c = createPlan(plan, dir);
    expect(c.ok).toBe(true);
    expect(armPlan(c.id!, issueApproval(c.plan_hash!).token, dir).ok).toBe(true);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(false);
    expect(d.blocked?.state).toBe('blocked');
    expect(d.note).toContain('outside cone selection');
    // R9 (H161): the copy it had begun to seed is removed at once (no session started)
    expect(temp.copies()).toEqual([]);
    expect(getPlan(c.id!, dir)!.copy).toMatchObject({ state: 'removed' });
  });

  it('cone-derived capsule dispatches clean (dry-run, seeded from selection only)', () => {
    const c = createPlan(basePlan(), dir, cone(1000));
    expect(c.ok).toBe(true);
    expect(armPlan(c.id!, issueApproval(c.plan_hash!).token, dir).ok).toBe(true);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(true);
    // R9 (H161): seeded from the selection only, then ended through the product's own path: the cancel removes the copy
    const copy = getPlan(c.id!, dir)!.copy!;
    expect(readFileSync(join(copy.path, 'package.json'), 'utf8')).toBe(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pauseOrCancelLane(c.id!, 'cancel', dir).copy).toMatchObject({ state: 'removed' });
    expect(temp.copies()).toEqual([]);
  });
});
