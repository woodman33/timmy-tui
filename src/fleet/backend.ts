/**
 * Round R4 (lead): the two seams a fleet runs through — a Provisioner that creates and destroys compute, and a Runtime that
 * runs a harness session on it. Timmy's OpenRouter agent stays the coordinator; a backend is only where work runs.
 *
 * Rules every adapter keeps (the operator, 2026-10-15):
 *   - A capability a backend does not declare is unavailable; it is never emulated.
 *   - "accepted" (HTTP 202) means accepted, never completed; the same request id is reused when a command is resent.
 *   - A create whose outcome is not known is "unknown" until lookup() settles it; Timmy never creates again first.
 *   - Stopping a harness, closing a session and destroying compute are three different calls.
 *   - Native events are kept beside Timmy's normalized ones; a stream cursor is persisted so a reconnect resumes.
 *   - Upstream "completed" is delivery, not a passed acceptance test.
 */
import type { IsolationClass, ProviderCapabilities } from './plan.js';

export interface AllocationSpec {
  planId: string;
  workerIndex: number;
  allocationKey: string;
  isolation: IsolationClass;
  limits: { cpu: number; ramGb: number; diskGb: number };
  ttlMinutes: number;
  /** Labels the provider stores with the compute, so a lookup or an orphan sweep can find it. */
  labels: Record<string, string>;
}

export type CreateOutcome =
  | { outcome: 'created'; providerId: string; expiresAt?: string }
  | { outcome: 'accepted'; providerId?: string }
  | { outcome: 'unknown'; reason: string }
  | { outcome: 'refused'; reason: string };

export type ComputeState = 'creating' | 'ready' | 'stopped' | 'destroyed' | 'expired' | 'failed' | 'absent' | 'unknown';

export interface ComputeRecord {
  providerId: string;
  allocationKey: string;
  state: ComputeState;
  isolation: IsolationClass;
  expiresAt?: string;
  labels: Record<string, string>;
}

export interface Provisioner {
  capabilities(): ProviderCapabilities;
  create(spec: AllocationSpec, requestId: string): Promise<CreateOutcome>;
  /** Settles an unknown create: what the provider holds for this allocation key, or "absent". */
  lookup(allocationKey: string): Promise<{ state: ComputeState; record?: ComputeRecord }>;
  destroy(providerId: string, requestId: string): Promise<{ outcome: 'destroyed' | 'accepted' | 'absent' | 'unknown'; reason?: string }>;
  /** Everything carrying these labels, for orphan sweeps. */
  list(labels: Record<string, string>): Promise<ComputeRecord[]>;
}

export interface RuntimeCapabilities {
  runtime: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
  sessions: boolean;
  messages: boolean;
  events: boolean;
  status: boolean;
  queue: boolean;
  interrupt: boolean;
  close: boolean;
  recover: boolean;
  /** Can a session start children, and do they get their own isolation. */
  childSpawn: 'none' | 'own-isolation' | 'may-share-parent';
  harnesses: string[];
}

/** An event exactly as the runtime sent it (redacted before it is stored). */
export interface NativeEvent {
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export type SessionState = 'accepted' | 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'closed' | 'unknown';

export interface SessionOpen {
  sessionId: string;
  /** The runtime accepted the request; nothing has run yet. */
  accepted: true;
}

export interface Runtime {
  capabilities(): RuntimeCapabilities;
  open(computeId: string, task: { harness: string; model: string; prompt: string; allowChildren: boolean }, requestId: string): Promise<SessionOpen>;
  send(sessionId: string, text: string, requestId: string): Promise<{ accepted: true }>;
  /** Events after `afterSeq`, as they come; ends when the session ends or the connection drops (the caller resumes). */
  events(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<NativeEvent>;
  status(sessionId: string): Promise<{ state: SessionState; lastSeq: number }>;
  interrupt(sessionId: string, requestId: string): Promise<{ accepted: true }>;
  close(sessionId: string, requestId: string): Promise<{ accepted: true }>;
  /** What the runtime still knows about a session after Timmy lost track of it. */
  recover(sessionId: string): Promise<{ state: SessionState; lastSeq: number } | undefined>;
  /** The worker's result files, read before any teardown. */
  collect(sessionId: string): Promise<{ files: Array<{ path: string; bytes: number; sha256: string; content: Buffer }>; summary?: string }>;
}

export interface Backend {
  provisioner: Provisioner;
  runtime: Runtime;
}
