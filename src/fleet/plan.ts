/**
 * Round R4 (lead): a fleet plan — "100 agents / 100 VMs" as a target Timmy can check, count and test without starting
 * 100 paid instances.
 *
 * A plan names how many workers are wanted and how many may run at once, on which provider, with which isolation, which
 * harness and model, what each worker may use (CPU, RAM, disk, time) and what the whole run may spend. Planning starts
 * nothing. Nothing is clamped silently: a plan that asks for an isolation its provider cannot give, or for paid compute
 * without a time limit and a budget, is refused in words.
 *
 * Words kept apart on purpose (the operator, 2026-10-15): a requested task is not an admitted worker; an admitted worker
 * is not a running agent; a running agent is not a live allocation; a Core session is not a VM; a Git branch is not an
 * isolation boundary. Containers, provider sandboxes and microVMs are named for what they are, never all "VMs".
 */
import { createHash, randomBytes } from 'node:crypto';

export const PLAN_VERSION = 1;
export const MAX_WORKERS = 100;

/** What actually separates one worker from another, weakest first. */
export const ISOLATION_CLASSES = ['shared-session', 'container', 'provider-sandbox', 'microvm', 'vm'] as const;
export type IsolationClass = (typeof ISOLATION_CLASSES)[number];

export const ISOLATION_WORDS: Record<IsolationClass, string> = {
  'shared-session': 'a session on a shared machine (shares the account, files and machine; not isolated)',
  container: 'a container',
  'provider-sandbox': "a provider's sandbox",
  microvm: 'a microVM',
  vm: 'a virtual machine',
};

export interface FleetTask {
  id: string;
  title: string;
  prompt: string;
}

export interface FleetPolicy {
  /** Every dispatch waits for a person ("Require review before dispatch"). */
  requireReview: boolean;
  /** Nothing leaves this computer and its own machines. */
  localOnly: boolean;
  /** Nothing that costs money; unavailable free capacity never falls back to paid. */
  freeOnly: boolean;
}

export interface FleetPlan {
  version: typeof PLAN_VERSION;
  id: string;
  createdAt: string;
  project: { root: string; revision: string; dirty: boolean };
  /** The one authoritative Timmy operation this plan belongs to; upstream ids are recorded beneath it. */
  operationId: string;
  /** Requested workers (one task each). */
  agents: number;
  /** At most this many run at once. */
  concurrency: number;
  provider: string;
  isolation: IsolationClass;
  /** "dedicated": one allocation per worker; "shared": workers share allocations (only for shared-session/container). */
  perWorker: 'dedicated' | 'shared';
  harness: string;
  model: string;
  limits: { cpu: number; ramGb: number; diskGb: number };
  ttlMinutes: number;
  budgets: { inferenceUsd: number; infraUsd: number };
  tasks: FleetTask[];
  policy: FleetPolicy;
}

/** What a provider says it can do; a capability it does not declare is unavailable. */
export interface ProviderCapabilities {
  provider: string;
  /** Shown beside the provider everywhere: "FAKE" for the test backend, "not verified" until a live check passed. */
  label: string;
  available: boolean;
  unavailableReason?: string;
  isolation: IsolationClass[];
  maxConcurrent: number;
  /** Compute that costs money (any amount). */
  paid: boolean;
  /** Runs off this computer and its own machines. */
  remote: boolean;
  /** The runtime can start child sessions that may share their parent's sandbox. */
  childSpawnMayShareParent: boolean;
  /** The adapter can turn that child path off. */
  childSpawnCanBeDisabled: boolean;
  snapshots: boolean;
  /** Compute ends on its own after this many minutes, whatever Timmy asks. */
  maxTtlMinutes?: number;
  /** Price per worker-minute the provider states, when it states one. */
  usdPerWorkerMinute?: number;
}

export interface PlanInput {
  project: { root: string; revision: string; dirty: boolean };
  operationId: string;
  agents: number;
  concurrency: number;
  provider: string;
  isolation: IsolationClass;
  perWorker?: 'dedicated' | 'shared';
  harness: string;
  model: string;
  limits?: Partial<FleetPlan['limits']>;
  ttlMinutes?: number;
  budgets?: Partial<FleetPlan['budgets']>;
  tasks?: FleetTask[];
  /** When no tasks are given: one task per worker from this prompt. */
  prompt?: string;
  policy?: Partial<FleetPolicy>;
}

export const newPlanId = (): string => `f${randomBytes(4).toString('hex')}`;

export function makePlan(input: PlanInput, id = newPlanId(), now = new Date()): FleetPlan {
  const tasks = input.tasks?.length
    ? input.tasks
    : Array.from({ length: input.agents }, (_, i) => ({ id: `t${String(i + 1).padStart(3, '0')}`, title: `Worker ${i + 1}`, prompt: input.prompt ?? '' }));
  return {
    version: PLAN_VERSION,
    id,
    createdAt: now.toISOString(),
    project: input.project,
    operationId: input.operationId,
    agents: input.agents,
    concurrency: input.concurrency,
    provider: input.provider,
    isolation: input.isolation,
    perWorker: input.perWorker ?? (input.isolation === 'shared-session' ? 'shared' : 'dedicated'),
    harness: input.harness,
    model: input.model,
    limits: { cpu: input.limits?.cpu ?? 2, ramGb: input.limits?.ramGb ?? 4, diskGb: input.limits?.diskGb ?? 10 },
    ttlMinutes: input.ttlMinutes ?? 30,
    budgets: { inferenceUsd: input.budgets?.inferenceUsd ?? 0, infraUsd: input.budgets?.infraUsd ?? 0 },
    tasks,
    policy: { requireReview: input.policy?.requireReview ?? true, localOnly: input.policy?.localOnly ?? false, freeOnly: input.policy?.freeOnly ?? true },
  };
}

/** Refusals in words; an empty list means the plan may be previewed and, with approval, run. */
export function checkPlan(plan: FleetPlan, caps: ProviderCapabilities | undefined): string[] {
  const p: string[] = [];
  if (!Number.isInteger(plan.agents) || plan.agents < 1 || plan.agents > MAX_WORKERS) p.push(`workers must be 1 to ${MAX_WORKERS}, not ${plan.agents}`);
  if (!Number.isInteger(plan.concurrency) || plan.concurrency < 1) p.push(`concurrency must be a whole number of at least 1, not ${plan.concurrency}`);
  else if (plan.concurrency > plan.agents) p.push(`concurrency ${plan.concurrency} is more than the ${plan.agents} workers`);
  if (plan.tasks.length !== plan.agents) p.push(`${plan.tasks.length} tasks for ${plan.agents} workers: one task per worker`);
  if (new Set(plan.tasks.map((t) => t.id)).size !== plan.tasks.length) p.push('task ids repeat');
  if (!(ISOLATION_CLASSES as readonly string[]).includes(plan.isolation)) p.push(`unknown isolation "${plan.isolation}"`);
  if (plan.perWorker === 'shared' && plan.isolation !== 'shared-session' && plan.isolation !== 'container') {
    p.push(`isolation "${plan.isolation}" is per worker; "shared" workers would not have it`);
  }
  if (!caps) {
    p.push(`provider "${plan.provider}" is not known to Timmy`);
    return p;
  }
  if (!caps.available) p.push(`provider "${plan.provider}" is unavailable: ${caps.unavailableReason ?? 'no reason given'}`);
  if (!caps.isolation.includes(plan.isolation)) {
    p.push(`provider "${plan.provider}" cannot give ${ISOLATION_WORDS[plan.isolation]} (it offers: ${caps.isolation.join(', ') || 'nothing'}); refused rather than run with less`);
  }
  if (plan.perWorker === 'dedicated' && (plan.isolation === 'vm' || plan.isolation === 'microvm' || plan.isolation === 'provider-sandbox')
    && caps.childSpawnMayShareParent && !caps.childSpawnCanBeDisabled) {
    p.push(`provider "${plan.provider}" can start child sessions in their parent's sandbox and that cannot be turned off, so one ${plan.isolation} per worker cannot be kept`);
  }
  if (plan.concurrency > caps.maxConcurrent) p.push(`concurrency ${plan.concurrency} is more than provider "${plan.provider}" allows (${caps.maxConcurrent})`);
  if (plan.policy.localOnly && caps.remote) p.push(`policy is local only and provider "${plan.provider}" runs elsewhere`);
  if (plan.policy.freeOnly && caps.paid) p.push(`policy is free only and provider "${plan.provider}" costs money`);
  if (caps.paid) {
    if (!(plan.ttlMinutes > 0)) p.push('paid compute needs a time limit (TTL)');
    if (!(plan.budgets.infraUsd > 0)) p.push('paid compute needs an infrastructure budget above $0');
  }
  if (caps.maxTtlMinutes !== undefined && plan.ttlMinutes > caps.maxTtlMinutes) {
    p.push(`TTL ${plan.ttlMinutes} min is longer than provider "${plan.provider}" keeps compute (${caps.maxTtlMinutes} min)`);
  }
  if (!(plan.limits.cpu > 0) || !(plan.limits.ramGb > 0) || !(plan.limits.diskGb > 0)) p.push('CPU, RAM and disk limits must be above 0');
  return p;
}

/** The most a plan could cost if every worker ran its whole TTL, when the provider states a price; otherwise unknown. */
export function infraCeilingUsd(plan: FleetPlan, caps: ProviderCapabilities | undefined): number | undefined {
  if (!caps) return undefined;
  if (!caps.paid) return 0;
  if (caps.usdPerWorkerMinute === undefined) return undefined;
  const allocations = plan.perWorker === 'dedicated' ? plan.agents : plan.concurrency;
  return Math.round(allocations * plan.ttlMinutes * caps.usdPerWorkerMinute * 100) / 100;
}

/** A stable digest of what a plan asks for (not its id or time), for receipts and idempotent submission. */
export function planDigest(plan: FleetPlan): string {
  const { id: _id, createdAt: _c, ...asked } = plan;
  return createHash('sha256').update(JSON.stringify(asked)).digest('hex');
}
