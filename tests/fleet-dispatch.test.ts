import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runFleetMission, type FleetResult } from '../src/utils/fleet-dispatch.js';
import { pauseOrCancelLane } from '../src/utils/dispatch.js';
import { issueApproval } from '../src/utils/approvals.js';
import type { UsdScene } from '../src/utils/usd-compiler.js';
import { dispatchTmuxOfItsOwn } from './helpers/dispatch-tmux.js';
import { dispatchTempOfItsOwn } from './helpers/dispatch-temp.js';

// R8 (H156; R7's open item H): this file's six dry-run lane sessions go on a tmux server of its own, stopped after its tests,
// and its afterAll checks that it left none on the default server (it left six there after each full suite up to R7)
dispatchTmuxOfItsOwn();
// R9 (H161; R8's open item K): the lanes' copies are made in a temporary folder of this file's own, counted after its tests
// (six were left after each run before R9). A fleet leaves its lanes running; each test ends them as an operator does, by
// the product's cancel, which removes each lane's copy once its session has ended.
const temp = dispatchTempOfItsOwn();
const endLanes = (r: FleetResult, dir: string): void => {
  for (const l of r.lanes) if (l.plan_id && l.session) expect(pauseOrCancelLane(l.plan_id, 'cancel', dir).copy, `${l.lane}'s copy`).toMatchObject({ state: 'removed' });
};

const scene: UsdScene = {
  schema_version: 'usd/0.1', name: 'fleet-test', meters_per_unit: 0.01, up_axis: 'Z',
  prims: [{ id: 'base', kind: 'cube', size: [2, 2, 1], material: { roughness: 0.5 } }]
};

beforeAll(() => { process.env.TIMMY_DISPATCH_DRYRUN = '1'; });
afterAll(() => { delete process.env.TIMMY_DISPATCH_DRYRUN; });

describe('fleet distribution (v0.9.0)', { timeout: 30000 }, () => {
  it('fans out armed tri-lane renders against one hashed stage, parent receipted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-fleet-t1-'));
    const r = await runFleetMission({ scene, dir, armToken: (_id, hash) => issueApproval(hash).token });
    expect(r.ok).toBe(true);
    expect(r.stage_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.lanes).toHaveLength(3);
    expect(r.lanes.every(l => l.ok && l.plan_id && l.session)).toBe(true);
    expect(r.parent_receipt).toBeTruthy();
    expect(temp.copies()).toHaveLength(3);
    endLanes(r, dir);
    expect(temp.copies()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('unarmed fleet refuses to dispatch (authority stays external)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-fleet-t2-'));
    const r = await runFleetMission({ scene, dir });
    expect(r.ok).toBe(false);
    expect(r.lanes.some(l => !l.ok)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('comfy stem fails closed missing_source without a workflow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-fleet-t3-'));
    const r = await runFleetMission({ scene, dir, comfy: true, armToken: (_id, hash) => issueApproval(hash).token });
    expect(r.comfy?.ok).toBe(false);
    expect(r.comfy?.error_class).toBe('missing_source');
    expect(r.ok).toBe(false);
    expect(r.parent_receipt).toBeTruthy(); // honest failed receipt sealed
    endLanes(r, dir);
    expect(temp.copies()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
