/**
 * Round R4 (lead): the fleet service, `timmy fleet` and its MCP tools — one service, the same checks for every caller.
 * FAKE: the backend (src/fleet/fake.ts; no compute, no harness, no model, no network). REAL: plan files, the ledger, the
 * scheduler, the operation record, signed receipts in the project's own store, the run detail (`timmy op`), the CLI
 * through the shipped entry in a child process, and operator-minted approval tokens (`timmy approve`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeBackend } from '../src/fleet/fake.js';
import { fleetEvents, planFleet, readFleetView, runPlan, stopPlan, type PlanRequest } from '../src/fleet/service.js';
import { callFleetTool, fleetArgvOf } from '../src/fleet/mcp.js';
import { readOperationRecord } from '../src/ops/operations.js';
import { projectChain, readRunDetail } from '../src/ops/run-detail.js';
import { planHashOf } from '../src/utils/approvals.js';
import { FleetLedger } from '../src/fleet/ledger.js';

const REPO = path.resolve(__dirname, '..');
const LOADER = pathToFileURL(path.join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const CLI = path.join(REPO, 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function gitProject(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-svc-'));
  roots.push(r);
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.email=fake', '-c', 'user.name=FAKE', ...a], { cwd: r, encoding: 'utf8' });
  g('init', '-q');
  g('commit', '-q', '--allow-empty', '-m', 'FAKE');
  return r;
}
const req = (over: Partial<PlanRequest> = {}): PlanRequest => ({ agents: 6, concurrency: 2, provider: 'fake', isolation: 'vm', harness: 'codex', model: 'fake-model', prompt: 'FAKE task', ...over });

describe('plan', () => {
  it('writes a plan it can honour, with a preview that says SIMULATION and names the isolation honestly', () => {
    const root = gitProject();
    const r = planFleet(root, req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.simulation).toBe(true);
    expect(r.preview.lines.join('\n')).toMatch(/SIMULATION on the FAKE backend/);
    expect(r.preview.lines.join('\n')).toMatch(/each a simulated virtual machine \(FAKE: nothing is allocated\)/);
    expect(r.plan.project.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(readFleetView(root, r.plan.id)?.status).toBe('planned');
  });

  it('refuses a provider that is not implemented, in words, and writes nothing', () => {
    const root = gitProject();
    const r = planFleet(root, req({ provider: 'cloudroom' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.join('\n')).toMatch(/provider "cloudroom" is unavailable: not implemented in this build yet: its source was read at the pinned revisions/);
    expect(fs.existsSync(path.join(root, '.timmy', 'fleet'))).toBe(false);
  });
});

describe('run', () => {
  it("a person's run: one operation, a prediction sealed before and the run after, in the project's own store, and `timmy op` reads it", async () => {
    const root = gitProject();
    const made = planFleet(root, req());
    if (!made.ok) throw new Error('not planned');
    const rep = await runPlan(root, made.plan.id, { by: 'person', backendFor: () => fakeBackend() });
    expect(rep.status).toBe('finished');
    expect(rep.counts.delivered).toBe(6);
    const chain = projectChain(root).filter((x) => x.operation_id === made.plan.operationId);
    expect(chain.map((x) => x.kind)).toEqual(['fleet.predict', 'fleet.run']);
    expect(chain[1].fleet).toMatchObject({ plan: made.plan.id, simulation: true, status: 'finished' });
    expect(chain[1].outputs?.map((o) => o.path)).toEqual([`.timmy/fleet/${made.plan.id}/allocations.jsonl`, `.timmy/fleet/${made.plan.id}/state.json`]);
    const op = readOperationRecord(root, made.plan.operationId);
    expect(op.ok && op.record).toMatchObject({ via: 'fleet', state: 'succeeded', runs: [{ kind: 'fleet', id: made.plan.id }] });
    const detail = readRunDetail(made.plan.operationId, { project: root });
    if (!('detail' in detail)) throw new Error(`no run detail: ${JSON.stringify(detail)}`);
    expect(detail.detail.verdict.state).toBe('completed'); // the run detail's word for an operation that succeeded
    expect(detail.detail.prediction?.receipt).toBe(rep.predictReceipt);
    expect(detail.detail.sourceRevision?.value).toMatch(new RegExp(`^git ${made.plan.project.revision}`));
  });

  it('an agent needs a token a person minted for this plan; without one nothing starts', async () => {
    const root = gitProject();
    const made = planFleet(root, req());
    if (!made.ok) throw new Error('not planned');
    const backend = fakeBackend();
    const no = await runPlan(root, made.plan.id, { by: 'agent', backendFor: () => backend });
    expect(no.status).toBe('refused');
    expect(no.refusals[0]).toMatch(/review before dispatch: a person runs it from a terminal, or approves it first \(timmy approve [0-9a-f]{32}\)/);
    expect(backend.provisioner.creates).toBe(0);
    const seen: string[] = [];
    const yes = await runPlan(root, made.plan.id, { by: 'agent', approval: 'TOKEN', consume: (t, h) => { seen.push(`${t}:${h}`); return { ok: true }; }, backendFor: () => backend });
    expect(yes.status).toBe('finished');
    expect(seen).toEqual([`TOKEN:${planHashOf(made.plan)}`]);
  });

  it('a provider that costs money needs an approval even from a person', async () => {
    const root = gitProject();
    const paid = () => fakeBackend({ paid: true, usdPerWorkerMinute: 0.02 });
    const made = planFleet(root, req({ budgets: { infraUsd: 10, inferenceUsd: 0 }, policy: { freeOnly: false } }), { backendFor: paid });
    if (!made.ok) throw new Error(`not planned: ${JSON.stringify(made)}`);
    expect(made.preview.ceilingUsd).toBe(3.6); // 6 workers x 30 min x $0.02
    const r = await runPlan(root, made.plan.id, { by: 'person', backendFor: paid });
    expect(r.refusals[0]).toMatch(/costs money: a person must approve this plan first/);
  });

  it('one plan runs in one process at a time; stop asks it; events read back per worker', async () => {
    const root = gitProject();
    const made = planFleet(root, req({ agents: 4, concurrency: 1 }));
    if (!made.ok) throw new Error('not planned');
    const backend = fakeBackend({ messagesPerTask: 40, eventDelayMs: 5 });
    const first = runPlan(root, made.plan.id, { by: 'person', backendFor: () => backend });
    await new Promise((r) => setTimeout(r, 80));
    const second = await runPlan(root, made.plan.id, { by: 'person', backendFor: () => backend });
    expect(second.refusals[0]).toMatch(/is already running in process \d+/);
    const stop = stopPlan(root, made.plan.id);
    expect(stop.words).toMatch(/asked the process running .* to stop/);
    const done = await first;
    expect(done.status).toBe('stopped');
    expect(readOperationRecord(root, made.plan.operationId).ok && (readOperationRecord(root, made.plan.operationId) as { record: { state: string } }).record.state).toBe('stopped');
    const one = fleetEvents(root, made.plan.id, { worker: 1 });
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((e) => e.worker === 1)).toBe(true);
    expect(fleetEvents(root, made.plan.id, { worker: 1, after: 3 }).every((e) => e.n > 3)).toBe(true);
    expect(stopPlan(root, made.plan.id).words).toMatch(/no process runs/);
  }, 60_000);
});

describe('MCP tools answer what the CLI answers', () => {
  it('maps tool arguments onto the CLI parser and refuses unknown ones', () => {
    expect(fleetArgvOf('timmy_fleet_plan', { workers: 3, isolation: 'vm', local_only: true })).toEqual(['plan', '--workers', '3', '--isolation', 'vm', '--local-only']);
    expect(fleetArgvOf('timmy_fleet_run', { plan: 'f0000aaaa', approval_token: 'x' })).toEqual(['run', 'f0000aaaa', '--approve', 'x']);
  });

  it('plans, refuses an agent run without a token, and reports status', async () => {
    const root = gitProject();
    const planned = await callFleetTool('timmy_fleet_plan', { workers: 3, concurrency: 3, project: root });
    expect(planned).toMatchObject({ schema: 'timmy.fleet/1', ok: true, exit_code: 0 });
    const id = String(planned.plan);
    const run = await callFleetTool('timmy_fleet_run', { plan: id, project: root });
    expect(run).toMatchObject({ ok: false, exit_code: 1, status: 'refused' });
    expect(String((run.refusals as string[])[0])).toMatch(/review before dispatch/);
    const status = await callFleetTool('timmy_fleet_status', { plan: id, project: root });
    expect(status).toMatchObject({ ok: true, view: { planId: id, status: 'planned', simulation: true } });
    expect(await callFleetTool('timmy_fleet_plan', { workers: 3, color: 'green', project: root })).toMatchObject({ ok: false, exit_code: 2 });
  });
});

describe('the CLI through the shipped entry', () => {
  const timmy = (cwd: string, ...args: string[]) => {
    const home = path.join(cwd, '.fake-home');
    const r = spawnSync(process.execPath, ['--import', LOADER, CLI, ...args], {
      cwd, encoding: 'utf8', timeout: 90_000,
      env: { PATH: process.env.PATH, HOME: home, TIMMY_HOME: path.join(home, 'timmy'), TIMMY_SETTINGS_DIR: path.join(home, 'settings'), TMPDIR: process.env.TMPDIR },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('plan, a refused non-terminal run, an approval minted by `timmy approve`, the run, status and op', () => {
    const root = gitProject();
    const plan = timmy(root, 'fleet', 'plan', '--workers', '3', '--concurrency', '2', '--json');
    expect(plan.code).toBe(0);
    const p = JSON.parse(plan.out.trim().split('\n').pop()!) as { plan: string; operation: string };
    const refused = timmy(root, 'fleet', 'run', p.plan, '--json');
    expect(refused.code).toBe(1);
    const hash = /timmy approve ([0-9a-f]{32})/.exec(refused.out)?.[1];
    expect(hash).toBeDefined();
    const minted = timmy(root, 'approve', hash!);
    const token = /approval ([0-9a-f]{32})/.exec(minted.out)?.[1];
    expect(token).toBeDefined();
    const ran = timmy(root, 'fleet', 'run', p.plan, '--approve', token!, '--json');
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.out.trim().split('\n').pop()!)).toMatchObject({ status: 'finished', counts: { delivered: 3, verified: 0 }, simulation: true });
    const replay = timmy(root, 'fleet', 'run', p.plan, '--approve', token!, '--json');
    expect(replay.out).toMatch(/approval already used/);
    const status = timmy(root, 'fleet', 'status', p.plan);
    expect(status.out).toMatch(/delivered 3 \(not verified\)/);
    const op = timmy(root, 'op', p.operation);
    expect(op.out).toMatch(/verdict\s+succeeded: 3 of 3 delivered \(not verified\)/);
    expect(timmy(root, 'fleet', 'nonsense').code).toBe(2);
    expect(FleetLedger.list(root)).toEqual([p.plan]);
  }, 120_000);
});
