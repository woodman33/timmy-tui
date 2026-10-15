/**
 * Round R4 (lead): the one fleet service — plan, run, status, events, stop, reconcile, collect — that `timmy fleet`, the
 * MCP tools and every surface call, so each caller gets the same checks and the same words.
 *
 * Identity: a plan carries one Timmy operation id from the moment it is made; its run writes that operation's record
 * (.timmy/operations/<id>.json, via "fleet") and seals its receipts under it: a prediction before anything starts
 * (kind fleet.predict) and the run's outcome after (kind fleet.run). Allocation keys, provider ids, session ids and
 * request ids stay beneath it, in the plan's ledger, which the run receipt names with its sha256.
 *
 * Words: a provider that is not implemented is "unavailable" with why; the FAKE backend says FAKE everywhere and is a
 * simulation; delivered is never verified; a refusal is a refusal, never a smaller run.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendReceipt, type ReceiptInput } from '../utils/receipts.js';
import { consumeApproval, planHashOf } from '../utils/approvals.js';
import { inOperationId, newOperationId } from '../ops/context.js';
import { projectId } from '../project/index.js';
import { OPERATION_SCHEMA, writeOperationRecord, type OperationRecord, type OperationState } from '../ops/operations.js';
import { decideDetailed, type DecideContext } from '../decision/service.js';
import { readSettings } from '../decision/settings.js';
import type { Backend } from './backend.js';
import { fakeBackend, type FakeOptions } from './fake.js';
import { checkPlan, infraCeilingUsd, ISOLATION_WORDS, makePlan, MAX_WORKERS, type FleetPlan, type IsolationClass, type PlanInput, type ProviderCapabilities } from './plan.js';
import { countWorkers, FleetLedger, planDir, runnerOf, type FleetCounts, type FleetState, type WorkerRecord } from './ledger.js';
import { WorkerEvents, type StoredEvent } from './events.js';
import { checkRuntime, collectWorker, reconcileFleet, runFleet, type FleetTimeouts, type RunResult } from './scheduler.js';
import { workerDir } from './ledger.js';

export interface ProviderEntry {
  id: string;
  label: string;
  available: boolean;
  why?: string;
  /** What it is, in a few words, never more than what was checked. */
  about: string;
}

/**
 * Every provider Timmy knows by name, and whether it can be used now. Only the FAKE backend is implemented: the others
 * are named so a plan for them is refused in words rather than run with something else.
 */
export const KNOWN_PROVIDERS: readonly ProviderEntry[] = [
  { id: 'fake', label: 'FAKE', available: true, about: 'the offline test backend: in-memory machines and scripted sessions; no compute, no harness, no model, no cost' },
  { id: 'cloudroom', label: 'Cloudroom Core', available: false, why: 'not implemented in this build yet: its source was read at the pinned revisions (core 3949daa, app f939f41) and the adapter is being written; until it is wired in, nothing reaches a Cloudroom Core', about: 'a self-hosted service that runs coding agents on a Linux machine and saves their history (Rust, Apache-2.0)' },
  { id: 'modal', label: 'Modal', available: false, why: 'no Timmy adapter; a provider in an upstream GUI is not a Timmy integration', about: 'provider sandboxes' },
  { id: 'hostinger', label: 'Hostinger', available: false, why: 'no Timmy adapter; no provisioning API is called or configured', about: 'virtual private servers' },
];

export interface ServiceOptions {
  /** The backend for a provider id; the default knows only the FAKE one. Tests inject their own. */
  backendFor?: (provider: string) => Backend | undefined;
  fake?: FakeOptions;
}

const backends = new Map<string, Backend>();

/** One FAKE backend per process (its machines live only in this process's memory). */
export function defaultBackendFor(provider: string, fake?: FakeOptions): Backend | undefined {
  if (provider !== 'fake') return undefined;
  if (fake) return fakeBackend(fake);
  if (!backends.has('fake')) backends.set('fake', fakeBackend());
  return backends.get('fake');
}

export function providerCaps(provider: string, opts: ServiceOptions = {}): ProviderCapabilities | undefined {
  const known = KNOWN_PROVIDERS.find((p) => p.id === provider);
  const b = (opts.backendFor ?? ((id) => defaultBackendFor(id, opts.fake)))(provider);
  if (b) return b.provisioner.capabilities();
  if (!known) return undefined;
  return {
    provider, label: known.label, available: false, unavailableReason: known.why, isolation: [], maxConcurrent: 0, paid: false, remote: true,
    childSpawnMayShareParent: false, childSpawnCanBeDisabled: false, snapshots: false,
  };
}

/** The project's revision as git says it, or "no-git"; dirty when git reports changes. */
export function projectRevision(root: string): { revision: string; dirty: boolean } {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  if (head.status !== 0) return { revision: 'no-git', dirty: false };
  const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  return { revision: head.stdout.trim(), dirty: st.status === 0 && st.stdout.trim().length > 0 };
}

export interface PlanPreview {
  planId?: string;
  operationId?: string;
  provider: string;
  backend: string;
  simulation: boolean;
  workers: number;
  concurrency: number;
  /** At most this many at once: the plan's cap, or the provider's when lower. */
  effectiveConcurrency: number;
  isolation: IsolationClass;
  isolationWords: string;
  perWorker: 'dedicated' | 'shared';
  allocations: number;
  harness: string;
  model: string;
  limits: FleetPlan['limits'];
  ttlMinutes: number;
  budgets: FleetPlan['budgets'];
  /** The most the compute could cost if every worker ran its whole TTL; null when the provider states no price. */
  ceilingUsd: number | null;
  inference: string;
  policy: FleetPlan['policy'];
  revision: string;
  dirty: boolean;
  refusals: string[];
  /** Plain lines for a terminal. */
  lines: string[];
}

export type PlanRequest = Omit<PlanInput, 'project' | 'operationId'>;

export function preview(plan: FleetPlan, caps: ProviderCapabilities | undefined, refusals: string[]): PlanPreview {
  const simulation = plan.provider === 'fake';
  const ceiling = infraCeilingUsd(plan, caps);
  const allocations = plan.perWorker === 'dedicated' ? plan.agents : plan.concurrency;
  const effective = Math.max(0, Math.min(plan.concurrency, caps?.maxConcurrent ?? plan.concurrency));
  const backend = caps?.label ?? plan.provider;
  const lines = [
    `Fleet plan${refusals.length ? ' (refused)' : ''}${simulation ? ' — SIMULATION on the FAKE backend: no compute, no harness, no model, no cost' : ''}`,
    `  ${plan.agents} workers, at most ${effective} at once (${plan.concurrency} asked${caps && caps.maxConcurrent < plan.concurrency ? `, the provider allows ${caps.maxConcurrent}` : ''})`,
    `  ${allocations} allocation${allocations === 1 ? '' : 's'}: ${plan.perWorker === 'dedicated' ? 'one per worker' : 'shared by workers'}, each ${simulation ? `a simulated ${ISOLATION_WORDS[plan.isolation].replace(/^an? /, '')} (FAKE: nothing is allocated)` : ISOLATION_WORDS[plan.isolation]}`,
    `  on ${backend}; harness ${plan.harness}, model ${plan.model}`,
    ...(caps?.childSpawnMayShareParent && plan.perWorker === 'dedicated' && ['vm', 'microvm', 'provider-sandbox'].includes(plan.isolation)
      ? [caps.childSpawnCanBeDisabled
        ? '  child sessions: turned off for this plan'
        : caps.childSpawnDetected
          ? "  child sessions: refused when asked; one an agent starts in its own sandbox anyway is detected and fails its worker (detection, not prevention)"
          : '']
      : []).filter(Boolean),
    `  each: ${plan.limits.cpu} CPU, ${plan.limits.ramGb} GB RAM, ${plan.limits.diskGb} GB disk, ${plan.ttlMinutes} min`,
    `  compute ceiling: ${ceiling === undefined ? 'unknown (the provider states no price)' : `$${ceiling.toFixed(2)}`}; budgets: compute $${plan.budgets.infraUsd}, inference $${plan.budgets.inferenceUsd}`,
    `  inference: the harness's own model route; not counted by the fleet${plan.budgets.inferenceUsd ? '' : ' (no inference budget set)'}`,
    `  policy: ${plan.policy.requireReview ? 'review before dispatch' : 'no review step'}; ${plan.policy.localOnly ? 'local only' : 'remote allowed'}; ${plan.policy.freeOnly ? 'free only' : 'paid allowed'}`,
    `  project revision ${plan.project.revision.slice(0, 12)}${plan.project.dirty ? ' (with uncommitted changes)' : ''}`,
    ...refusals.map((r) => `  REFUSED: ${r}`),
  ];
  return {
    planId: plan.id, operationId: plan.operationId, provider: plan.provider, backend, simulation, workers: plan.agents, concurrency: plan.concurrency,
    effectiveConcurrency: effective, isolation: plan.isolation, isolationWords: ISOLATION_WORDS[plan.isolation], perWorker: plan.perWorker, allocations,
    harness: plan.harness, model: plan.model, limits: plan.limits, ttlMinutes: plan.ttlMinutes, budgets: plan.budgets,
    ceilingUsd: ceiling === undefined ? null : ceiling, inference: "the harness's own model route; not counted by the fleet",
    policy: plan.policy, revision: plan.project.revision, dirty: plan.project.dirty, refusals, lines,
  };
}

/** Makes and checks a plan; a plan that passes is written to the project (nothing starts). */
export function planFleet(root: string, req: PlanRequest, opts: ServiceOptions = {}): { ok: true; plan: FleetPlan; preview: PlanPreview } | { ok: false; preview: PlanPreview; refusals: string[] } {
  const rev = projectRevision(root);
  const plan = makePlan({ ...req, project: { root: '.', revision: rev.revision, dirty: rev.dirty }, operationId: newOperationId() });
  const caps = providerCaps(plan.provider, opts);
  const backend = (opts.backendFor ?? ((id) => defaultBackendFor(id, opts.fake)))(plan.provider);
  const refusals = [...checkPlan(plan, caps), ...(backend ? checkRuntime(plan, backend) : [])];
  const pv = preview(plan, caps, refusals);
  if (refusals.length) return { ok: false, preview: { ...pv, planId: undefined, operationId: undefined }, refusals };
  FleetLedger.create(root, plan);
  return { ok: true, plan, preview: pv };
}

export interface RunReport extends RunResult {
  operationId: string;
  predictReceipt?: string;
  runReceipt?: string;
  backend: string;
  simulation: boolean;
  lines: string[];
}

/** The receipt store as `timmy op` reads it (src/ops/run-detail.ts projectChain): TIMMY_STORE when set, else the project's. */
const storeDir = (root: string): string | undefined => (process.env.TIMMY_STORE ? undefined : root);

const sha256File = (file: string): { sha256: string; bytes: number } | undefined => {
  try {
    const b = fs.readFileSync(file);
    return { sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length };
  } catch { return undefined; }
};

function writeOp(root: string, plan: FleetPlan, state: OperationState, why: string | undefined, started: string, ended: string | null): void {
  const rec: OperationRecord = {
    schema: OPERATION_SCHEMA,
    id: plan.operationId,
    request: `timmy fleet run ${plan.id} (${plan.agents} workers, ${plan.isolation} on ${plan.provider})`,
    via: 'fleet',
    project: '.',
    started,
    ended,
    state,
    ...(why ? { why } : {}),
    parent: null,
    runs: [{ kind: 'fleet', id: plan.id, at: started }],
    owner: { pid: process.pid, started },
  };
  writeOperationRecord(root, rec);
}

function opState(r: RunResult): { state: OperationState; why: string } {
  const c = r.counts;
  const words = `${c.delivered} of ${c.requested} delivered (not verified)${c.failed ? `, ${c.failed} failed` : ''}${c.unknownAllocations ? `, ${c.unknownAllocations} unknown` : ''}${c.cancelled ? `, ${c.cancelled} cancelled` : ''}${c.refused ? `, ${c.refused} refused` : ''}`;
  if (r.status === 'refused') return { state: 'refused', why: r.refusals[0] ?? 'refused' };
  if (r.status === 'stopped') return { state: 'stopped', why: words };
  if (c.delivered === c.requested) return { state: 'succeeded', why: words };
  return { state: 'failed', why: words };
}

/**
 * Runs a written plan in this process (it stays until the run ends; a signal or `timmy fleet stop` cancels). A provider
 * that costs money needs an approval token minted by a person for this plan (`timmy approve <hash>`), the same for the
 * CLI and MCP; the FAKE backend costs nothing and needs none.
 */
export interface RunPlanOptions extends ServiceOptions {
  approval?: string;
  /** Who asks: a person at a terminal, or an agent (MCP, a script). Under "review before dispatch" an agent needs a person's approval. */
  by?: 'person' | 'agent';
  /** The approval check (default: the operator-minted single-use tokens of src/utils/approvals.ts). */
  consume?: (token: string, planHash: string) => { ok: boolean; note?: string };
  signal?: AbortSignal;
  timeouts?: Partial<FleetTimeouts>;
  onEvent?: (worker: number, e: StoredEvent) => void;
  onChange?: (w: WorkerRecord) => void;
}

export async function runPlan(root: string, planId: string, o: RunPlanOptions = {}): Promise<RunReport> {
  const ledger = FleetLedger.open(root, planId);
  const plan = ledger.plan;
  const backend = (o.backendFor ?? ((id) => defaultBackendFor(id, o.fake)))(plan.provider);
  const caps = backend?.provisioner.capabilities() ?? providerCaps(plan.provider, o);
  const label = caps?.label ?? plan.provider;
  const simulation = plan.provider === 'fake';
  const refuse = (why: string): RunReport => ({ planId, status: 'refused', refusals: [why], counts: ledger.counts(), peakActive: 0, operationId: plan.operationId, backend: label, simulation, lines: [`REFUSED: ${why}`] });
  if (!backend) return refuse(`provider "${plan.provider}" is unavailable: ${caps?.unavailableReason ?? 'not known to Timmy'}`);
  if (runnerOf(root, planId)) return refuse(`plan ${planId} is already running in process ${runnerOf(root, planId)?.pid}`);
  const needsPerson = plan.policy.requireReview && o.by !== 'person';
  if (caps?.paid || needsPerson) {
    const hash = planHashOf(plan);
    if (!o.approval) {
      return refuse(caps?.paid
        ? `provider "${plan.provider}" costs money: a person must approve this plan first (timmy approve ${hash})`
        : `this plan asks for review before dispatch: a person runs it from a terminal, or approves it first (timmy approve ${hash}) and the token is passed`);
    }
    const ok = (o.consume ?? consumeApproval)(o.approval, hash);
    if (!ok.ok) return refuse(`the approval was not accepted: ${ok.note ?? 'no reason given'}`);
  }
  const started = new Date().toISOString();
  writeOp(root, plan, 'running', undefined, started, null);
  const fleetFacts = (status?: string, counts?: FleetCounts): NonNullable<ReceiptInput['fleet']> => ({
    plan: plan.id, provider: plan.provider, backend: label, isolation: plan.isolation, workers: plan.agents, concurrency: plan.concurrency,
    harness: plan.harness, model: plan.model, simulation, ceiling_usd: infraCeilingUsd(plan, caps) ?? null,
    ...(status ? { status } : {}), ...(counts ? { counts: counts as unknown as Record<string, number> } : {}),
    note: `${simulation ? 'SIMULATION: the FAKE backend made no compute and ran no harness or model. ' : ''}Delivered means the runtime said it completed; nothing here was verified.`,
  });
  const predict = inOperationId(plan.operationId, () => appendReceipt('runs', {
    kind: 'fleet.predict',
    project: path.basename(root),
    project_id: projectId(root),
    subject: `fleet ${plan.id}: ${plan.agents} workers, at most ${Math.min(plan.concurrency, caps?.maxConcurrent ?? plan.concurrency)} at once, ${plan.isolation} on ${label}`,
    policy: plan.policy.requireReview ? 'human-gated' : 'auto',
    status: 'ok',
    plan_hash: planHashOf(plan),
    fleet: fleetFacts('predicted'),
  }, storeDir(root)));
  let result: RunResult;
  try {
    result = await runFleet({ backend, ledger, signal: o.signal, timeouts: o.timeouts, onEvent: o.onEvent, onChange: o.onChange });
  } catch (e) {
    writeOp(root, plan, 'failed', `Timmy's own error: ${(e as Error).message}`, started, new Date().toISOString());
    throw e;
  }
  ledger.save(true);
  const { state, why } = opState(result);
  const outs = ['allocations.jsonl', 'state.json'].map((f) => ({ f, s: sha256File(path.join(planDir(root, planId), f)) })).filter((x) => x.s)
    .map((x) => ({ path: `.timmy/fleet/${planId}/${x.f}`, sha256: x.s!.sha256, bytes: x.s!.bytes }));
  const run = inOperationId(plan.operationId, () => appendReceipt('runs', {
    kind: 'fleet.run',
    project: path.basename(root),
    project_id: projectId(root),
    subject: `fleet ${plan.id}: ${why}`,
    policy: plan.policy.requireReview ? 'human-gated' : 'auto',
    status: result.status === 'stopped' ? 'cancelled' : result.status === 'refused' ? 'denied' : state === 'succeeded' ? 'ok' : 'failed',
    plan_hash: planHashOf(plan),
    outputs: outs,
    fleet: fleetFacts(result.status, result.counts),
  }, storeDir(root)));
  writeOp(root, plan, state, why, started, new Date().toISOString());
  const lines = [
    `Fleet ${plan.id} ${result.status}${simulation ? ' (SIMULATION, FAKE backend)' : ''}: ${why}`,
    `  peak at once: ${result.peakActive}; operation ${plan.operationId}; receipts ${predict.hash.slice(7, 15)} (prediction), ${run.hash.slice(7, 15)} (run)`,
    ...result.refusals.map((r) => `  REFUSED: ${r}`),
  ];
  return { ...result, operationId: plan.operationId, predictReceipt: predict.hash.slice(7, 15), runReceipt: run.hash.slice(7, 15), backend: label, simulation, lines };
}

/** What every surface shows for a plan: read from its files only, never from the network. */
export interface FleetView {
  planId: string;
  operationId: string;
  createdAt: string;
  status: FleetState['status'];
  provider: string;
  backend: string;
  simulation: boolean;
  isolation: IsolationClass;
  isolationWords: string;
  perWorker: 'dedicated' | 'shared';
  harness: string;
  model: string;
  counts: FleetCounts;
  runner?: { pid: number; started: string };
  cancelAsked: boolean;
  workers: Array<{ index: number; title: string; phase: WorkerRecord['phase']; allocation: string; compute: string; providerId?: string; session?: string; sessionState: string; events: number; collected: boolean; files: number; verified: string; reason?: string; expiresAt?: string }>;
  needsYou: string[];
  updatedAt: string;
}

export function readFleetView(root: string, planId: string): FleetView | undefined {
  const dir = planDir(root, planId);
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) as FleetPlan;
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as FleetState;
    const known = KNOWN_PROVIDERS.find((p) => p.id === plan.provider);
    const needsYou: string[] = [];
    for (const w of state.workers) {
      if (w.phase === 'unknown') needsYou.push(`worker ${w.index}: ${w.reason ?? 'its compute is unknown'} (timmy fleet reconcile ${planId})`);
    }
    const runner = runnerOf(root, planId);
    if (state.status === 'running' && !runner) needsYou.push(`the process that ran this plan has ended while it was running (timmy fleet reconcile ${planId})`);
    return {
      planId, operationId: plan.operationId, createdAt: plan.createdAt, status: state.status, provider: plan.provider,
      backend: plan.provider === 'fake' ? 'FAKE' : known?.label ?? plan.provider, simulation: plan.provider === 'fake',
      isolation: plan.isolation, isolationWords: ISOLATION_WORDS[plan.isolation], perWorker: plan.perWorker, harness: plan.harness, model: plan.model,
      counts: countWorkers(plan.agents, state.workers), runner, cancelAsked: state.cancelRequested || fs.existsSync(path.join(dir, 'CANCEL')),
      workers: state.workers.map((w) => ({
        index: w.index, title: w.title, phase: w.phase, allocation: w.allocationKey, compute: w.compute.state, providerId: w.compute.providerId,
        session: w.session.sessionId, sessionState: w.session.state, events: w.session.events, collected: w.result.collected, files: w.result.files,
        verified: w.result.verified, reason: w.reason, expiresAt: w.compute.expiresAt,
      })),
      needsYou, updatedAt: state.updatedAt,
    };
  } catch { return undefined; }
}

export function listFleetViews(root: string): FleetView[] {
  return FleetLedger.list(root).map((id) => readFleetView(root, id)).filter((v): v is FleetView => !!v).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function fleetEvents(root: string, planId: string, o: { worker?: number; after?: number; limit?: number } = {}): Array<StoredEvent & { worker: number }> {
  const view = readFleetView(root, planId);
  if (!view) return [];
  const out: Array<StoredEvent & { worker: number }> = [];
  for (const w of view.workers) {
    if (o.worker !== undefined && w.index !== o.worker) continue;
    for (const e of new WorkerEvents(workerDir(root, planId, w.index)).all()) if (e.n > (o.after ?? 0)) out.push({ ...e, worker: w.index });
  }
  out.sort((a, b) => a.at.localeCompare(b.at) || a.worker - b.worker || a.n - b.n);
  return o.limit ? out.slice(-o.limit) : out;
}

/** Asks the process running a plan to stop (it watches the CANCEL file); says plainly when no process runs it. */
export function stopPlan(root: string, planId: string): { asked: boolean; runner?: number; words: string } {
  const view = readFleetView(root, planId);
  if (!view) return { asked: false, words: `no plan ${planId} in this project` };
  const runner = runnerOf(root, planId);
  FleetLedger.open(root, planId).requestCancel();
  if (runner) return { asked: true, runner: runner.pid, words: `asked the process running ${planId} (pid ${runner.pid}) to stop: queued workers will not start; running ones stop, are collected and torn down` };
  return { asked: true, words: `no process runs ${planId} now; it will not start new work if run again${view.simulation ? '' : `; run timmy fleet reconcile ${planId} to settle what it left`}` };
}

const FAKE_ELSEWHERE = 'the FAKE backend lives only inside the process that ran the plan; another process has nothing to reconcile or collect from it';

export async function reconcilePlan(root: string, planId: string, opts: ServiceOptions & { sameProcess?: boolean } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const view = readFleetView(root, planId);
  if (!view) return { ok: false, lines: [`no plan ${planId} in this project`] };
  if (view.simulation && !opts.backendFor && !opts.sameProcess) return { ok: false, lines: [`not reconciled: ${FAKE_ELSEWHERE}`] };
  const backend = (opts.backendFor ?? ((id) => defaultBackendFor(id, opts.fake)))(view.provider);
  if (!backend) return { ok: false, lines: [`provider "${view.provider}" is unavailable`] };
  const r = await reconcileFleet(FleetLedger.open(root, planId), backend);
  return { ok: true, lines: [...r.settled, ...r.orphansDestroyed.map((o) => `orphan destroyed: ${o}`), ...(r.stillUnknown.length ? [`still unknown (a person must check): workers ${r.stillUnknown.join(', ')}`] : []), ...(r.settled.length + r.orphansDestroyed.length ? [] : ['nothing to settle'])] };
}

export async function collectPlan(root: string, planId: string, opts: ServiceOptions & { sameProcess?: boolean } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const view = readFleetView(root, planId);
  if (!view) return { ok: false, lines: [`no plan ${planId} in this project`] };
  if (view.simulation && !opts.backendFor && !opts.sameProcess) return { ok: false, lines: [`not collected: ${FAKE_ELSEWHERE}; what the run collected is in .timmy/fleet/${planId}/w<NNN>/result/`] };
  const backend = (opts.backendFor ?? ((id) => defaultBackendFor(id, opts.fake)))(view.provider);
  if (!backend) return { ok: false, lines: [`provider "${view.provider}" is unavailable`] };
  const ledger = FleetLedger.open(root, planId);
  const lines: string[] = [];
  for (const w of ledger.snapshot().workers) {
    if (w.session.sessionId && !w.result.collected) {
      await collectWorker(ledger, backend, w.index);
      const after = ledger.worker(w.index);
      lines.push(`worker ${w.index}: ${after.result.collected ? `${after.result.files} file(s) collected` : after.reason ?? 'nothing collected'}`);
    }
  }
  ledger.save(true);
  return { ok: true, lines: lines.length ? lines : ['everything delivered was already collected'] };
}

export const FLEET_LIMITS = { maxWorkers: MAX_WORKERS };

// ── R4 (lead): the route advice, one decision per plan (src/decision), shown and never applied ─────────────────────

/** What the decision provider said about a plan's harness: a recommendation, never applied to the plan. */
export interface RouteAdvice {
  decision: string;
  outcome: 'recommend' | 'abstain' | 'fallback';
  recommended?: string;
  top?: number;
  margin?: number;
  /** The harness the plan keeps: always the one it asked for. */
  kept: string;
  /** One line for every surface (amber: a recommendation, not evidence). */
  words: string;
  /** The recorded decision was returned again (asked before; no second call). */
  reused: boolean;
}

export const ROUTE_FILE = 'route.json';
const pct = (n: number | undefined): string => (typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : 'unknown');

/**
 * Asks the decision provider which of the backend's harnesses should take this plan's tasks: once per plan (a 100-worker
 * plan is one question, never 100), bound to the plan's operation and revision, with the plan's inference budget as the
 * budget for a paid call. Only when "Use Clef routing" is on (or a caller passes a provider or a fixture): otherwise
 * nothing is asked or recorded. The answer is written beside the plan (route.json) and shown; the plan keeps its harness
 * whatever the answer is (a person re-plans to follow it, and the new plan is checked again).
 */
export async function adviseRoute(root: string, plan: FleetPlan, opts: ServiceOptions & { decide?: DecideContext } = {}): Promise<RouteAdvice | undefined> {
  const ctx: DecideContext = { ...(opts.decide ?? {}) };
  const settings = ctx.settings ?? readSettings(ctx.env).settings;
  if (!settings.useClef && !ctx.provider && !ctx.fixture) return undefined;
  const backend = (opts.backendFor ?? ((id) => defaultBackendFor(id, opts.fake)))(plan.provider);
  const harnesses = backend?.runtime.capabilities().harnesses ?? [plan.harness];
  const label = backend?.provisioner.capabilities().label ?? plan.provider;
  const options = [...new Set([plan.harness, ...harnesses])].map((h) => ({ id: h, label: h, description: `the ${h} harness on ${label}`, available: harnesses.includes(h) }));
  const { record, reused } = await decideDetailed({
    kind: 'route', operationId: plan.operationId, project: { root, revision: plan.project.revision, dirty: plan.project.dirty },
    instructions: `Which harness should take this fleet's ${plan.agents} tasks?`,
    options, deterministic: { option: plan.harness, rule: 'the harness the plan asked for' },
    // what the model reads: counts and words Timmy already shows, never the tasks' text
    state: { workers: plan.agents, concurrency: plan.concurrency, isolation: plan.isolation, provider: plan.provider, simulation: plan.provider === 'fake' },
    requestKey: `fleet-route-${plan.id}`,
  }, { ...ctx, settings, budget: ctx.budget ?? { remainingUsd: plan.budgets.inferenceUsd }, currentRevision: ctx.currentRevision ?? plan.project.revision });
  const keep = `the plan keeps ${plan.harness}`;
  const words = record.outcome === 'recommend' && record.recommendation
    ? `route: ${record.recommendation.option} recommended (${pct(record.recommendation.top)}, ahead by ${pct(record.recommendation.margin)}): a model recommendation, not evidence; not applied, ${keep}${record.recommendation.option === plan.harness ? '' : ` (to follow it: timmy fleet plan --harness ${record.recommendation.option} …, a new plan checked again)`}`
    : record.outcome === 'abstain'
      ? `route: no recommendation, a person decides (${record.judge?.kind === 'abstain' ? record.judge.reason : 'the model abstained'}); ${keep}`
      : `route: no recommendation (${record.fallback.reason ?? 'the deterministic path was used'}); ${keep}`;
  const advice: RouteAdvice = {
    decision: record.id, outcome: record.outcome, ...(record.recommendation ? { recommended: record.recommendation.option, top: record.recommendation.top, margin: record.recommendation.margin } : {}),
    kept: plan.harness, words, reused,
  };
  fs.writeFileSync(path.join(planDir(root, plan.id), ROUTE_FILE), `${JSON.stringify(advice, null, 2)}\n`, { mode: 0o600 });
  return advice;
}

/** The route advice written beside a plan, when there is one. */
export function readRouteAdvice(root: string, planId: string): RouteAdvice | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(planDir(root, planId), ROUTE_FILE), 'utf8')) as RouteAdvice; } catch { return undefined; }
}
