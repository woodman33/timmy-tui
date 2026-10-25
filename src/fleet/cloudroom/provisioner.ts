/**
 * Round R4 (H121): the Provisioner for one configured, self-hosted Cloudroom Core that many workers share.
 *
 * It makes nothing. Every worker's "compute" is the same running Core: a session on a shared machine (shares the Core's
 * account, files and machine; not isolated), never a VM, a microVM or a provider sandbox, so `shared-session` is the
 * only isolation it offers and a plan that asks for more is refused by checkPlan in words. create() only checks that
 * the Core is ready (GET /v1/ready answers 200) and hands every worker the same compute id. destroy() never stops the
 * Core: it is not Timmy's to stop; Timmy closes its own sessions (the runtime's close) and leaves the Core running.
 *
 * Children: a Core agent can start a child in its own folder (`--shared-sandbox`, or a harness's managed child) and
 * nothing in Core's API turns that off, so childSpawnCanBeDisabled is false; the runtime refuses every child request
 * and sees every child that starts in the folder anyway (childSpawnDetected: detection, not prevention).
 */
import type { AllocationSpec, ComputeRecord, ComputeState, CreateOutcome, Provisioner } from '../backend.js';
import { ISOLATION_WORDS, type ProviderCapabilities } from '../plan.js';
import { CloudroomConnectionError, CloudroomError, type CloudroomClient } from './client.js';

export interface SharedCoreOptions {
  client: CloudroomClient;
  /** The config's label for this Core (no URL, no host): the compute id is "cloudroom-core:<name>". */
  name: string;
  /** Shown beside the provider: FAKE for the FAKE Core, "not verified" for a real one until a live check passes. */
  label: string;
  /** Most sessions Timmy runs on this Core at once (config max_concurrent, default 4). */
  maxConcurrent: number;
  /** Tries of the readiness check on a connection error or a 503 (default 3). */
  tries?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SharedCoreProvisioner implements Provisioner {
  readonly computeId: string;

  constructor(private readonly opts: SharedCoreOptions) {
    this.computeId = `cloudroom-core:${opts.name}`;
  }

  capabilities(): ProviderCapabilities {
    return {
      provider: 'cloudroom',
      label: this.opts.label,
      available: true,
      isolation: ['shared-session'],
      maxConcurrent: this.opts.maxConcurrent,
      paid: false,
      remote: true,
      childSpawnMayShareParent: true,
      childSpawnCanBeDisabled: false,
      childSpawnDetected: true,
      snapshots: false,
    };
  }

  /** Whether the Core answers ready now, and why not when it does not. */
  async readiness(): Promise<{ ready: true } | { ready: false; why: string; state: ComputeState }> {
    const tries = this.opts.tries ?? 3;
    for (let i = 1; ; i++) {
      try {
        await this.opts.client.ready();
        return { ready: true };
      } catch (e) {
        const transient = e instanceof CloudroomConnectionError || (e instanceof CloudroomError && e.status === 503);
        if (transient && i < tries) { await sleep((this.opts.retryDelayMs ?? 150) * i); continue; }
        if (e instanceof CloudroomError && e.status === 503) return { ready: false, state: 'unknown', why: 'the Core says it is not ready (HTTP 503: its storage or database is not usable)' };
        if (e instanceof CloudroomError && (e.status === 401 || e.status === 403)) return { ready: false, state: 'unknown', why: `the Core refused Timmy's token (HTTP ${e.status})` };
        return { ready: false, state: 'unknown', why: `the Core did not answer its readiness check: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }

  private record(allocationKey: string): ComputeRecord {
    return { providerId: this.computeId, allocationKey, state: 'ready', isolation: 'shared-session', labels: {} };
  }

  /** Makes nothing: checks the shared Core is ready and returns its one compute id (the same for every worker). */
  async create(spec: AllocationSpec, _requestId: string): Promise<CreateOutcome> {
    if (spec.isolation !== 'shared-session') {
      return { outcome: 'refused', reason: `a shared Cloudroom Core gives only ${ISOLATION_WORDS['shared-session']}, not ${ISOLATION_WORDS[spec.isolation]}` };
    }
    const r = await this.readiness();
    return r.ready ? { outcome: 'created', providerId: this.computeId } : { outcome: 'refused', reason: r.why };
  }

  /** Reflects readiness: "ready" with the shared compute while the Core answers ready, else "unknown". */
  async lookup(allocationKey: string): Promise<{ state: ComputeState; record?: ComputeRecord }> {
    const r = await this.readiness();
    return r.ready ? { state: 'ready', record: this.record(allocationKey) } : { state: r.state };
  }

  /** Never stops the Core. */
  async destroy(_providerId: string, _requestId: string): Promise<{ outcome: 'absent'; reason: string }> {
    return { outcome: 'absent', reason: "the shared Cloudroom Core is not Timmy's to stop: Timmy closes only its own sessions on it and leaves the Core running" };
  }

  /** Nothing to sweep: Timmy made no compute here. */
  async list(_labels: Record<string, string>): Promise<ComputeRecord[]> {
    return [];
  }
}
