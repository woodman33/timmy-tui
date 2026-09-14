import { existsSync, readFileSync, appendFileSync, mkdirSync, rmdirSync, statSync, writeFileSync, renameSync, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import { publish as busPublish } from '../bus/index.js';
import { signBody, verifyBody } from './signing.js';
import { captureEnvLock, type EnvLock } from './envlock.js';
import type { Edl } from './edl.js';

// TIMMY receipt chain v1 — the spine. Every effect appends a hash-chained,
// tamper-evident receipt: plan → policy → effect → artifacts → cost → prev_hash.
// One schema, append-only, queryable from week 1. cosign checkpoints come
// after the chain is queried weekly (chain first, crypto after).

export interface Receipt {
  v: 1;
  id: string;
  stream: string;
  ts: string;
  kind: string; // generation | refinement | run | export
  subject: string;
  prompt_hash?: string;
  artifacts?: string[];
  cost_usd?: number;
  policy: string; // human-gated | auto
  // receipt v2 (research rulings): OTel-style span tree + PDP decisions ride
  // inside the sealed body, so the receipt is evidence structure, not just
  // integrity.
  spans?: { name: string; kind: 'root' | 'chat' | 'execute_tool' | 'deny' | 'invoke_agent' }[];
  decisions?: { decision: string; effect: string; tier: string; reason: string }[];
  // v2.1 (judge-loop hardening): bind hashes + resolution + economics without
  // ever sealing raw prompts/responses/secrets.
  response_hash?: string;
  model_requested?: string;
  model_resolved?: string;
  via?: string;
  ms?: number;
  tokens?: number;
  plan_hash?: string;
  child_receipts?: string[];
  executors?: unknown[];
  // T1 (specs/edl-v1.md): env-lock + ed25519 signature + failure variant.
  // Receipts without env_lock/signature are T0-grade and must not be built upon.
  env_lock?: EnvLock;
  edl?: Edl;
  output_sha256?: string;
  manifest_sha256?: string;
  sources?: unknown[];
  max_spend?: number;
  tier?: string;
  signer?: string;   // ed25519 public key (SPKI PEM)
  signature?: string; // base64 over canonical body (minus hash/prev_hash/signature)
  status?: 'ok' | 'failed' | 'denied';
  error_class?: string; // exec|missing_source|schema|env|replay_drift|http_4xx|http_5xx|network|approval|unresolved_model|no_key|…
  exit_code?: number;
  partial_artifacts?: string[];
  discrepancies?: string[]; // repo-vs-spec flags, per the T1 work order
  // v0.5 release epochs: legacy (pre-lock) records carry no epoch (=1) and are
  // preserved unchanged as incident evidence; the verifier checks each epoch
  // segment independently so a clean release epoch can start after an incident.
  epoch?: number;
  prev_hash: string;
  hash: string;
}

export type ReceiptInput = Omit<Receipt, 'v' | 'id' | 'ts' | 'stream' | 'prev_hash' | 'hash'>;

const canon = (o: Record<string, unknown>): string =>
  JSON.stringify(
    Object.keys(o)
      .sort()
      .reduce((acc, k) => ({ ...acc, [k]: (o as Record<string, unknown>)[k] }), {})
  );

export const hashOf = (o: Record<string, unknown>): string =>
  'sha256_' + crypto.createHash('sha256').update(canon(o)).digest('hex');

// STORE PIN (v10 fork fix): seals resolve to ONE canonical store regardless
// of cwd. Resolution order: TIMMY_STORE env -> nearest ancestor .timmy/store-pin
// -> nearest ancestor package.json's .timmy/receipts -> legacy cwd.
export function rootStoreDir(dir: string = process.cwd()): string | undefined {
  // TEST ISOLATION (tui-redesign-p6a3 corr 1): under NODE_ENV=test a per-file
  // TIMMY_STORE is the canonical store so the store-pin preflight accepts it.
  if (process.env.NODE_ENV === 'test' && process.env.TIMMY_STORE && dir === process.cwd()) return process.env.TIMMY_STORE;
  // Pass 1: a store-pin anywhere above cwd wins (sub-project package.json
  // files must NOT shadow the canonical store — that's how the v10 fork happened).
  let d = dir;
  for (;;) {
    const pin = join(d, '.timmy', 'store-pin');
    if (existsSync(pin)) return readFileSync(pin, 'utf8').trim();
    const p = dirname(d);
    if (p === d) break;
    d = p;
  }
  // Pass 2: legacy fallback — nearest package.json's store.
  d = dir;
  for (;;) {
    if (existsSync(join(d, 'package.json'))) return join(d, '.timmy', 'receipts');
    const p = dirname(d);
    if (p === d) return undefined;
    d = p;
  }
}

export function receiptsDir(dir: string = process.cwd()): string {
  // per-file test store applies only when the caller didn't pass an explicit dir
  if (process.env.TIMMY_STORE && dir === process.cwd()) return process.env.TIMMY_STORE;
  return rootStoreDir(dir) ?? join(dir, '.timmy', 'receipts');
}

export function receiptsPath(stream: string, dir?: string): string {
  return join(receiptsDir(dir), `${stream}.jsonl`);
}

export function readChain(stream: string, dir?: string): Receipt[] {
  const p = receiptsPath(stream, dir);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l) as Receipt;
      } catch {
        return null;
      }
    })
    .filter((r): r is Receipt => Boolean(r && typeof r.hash === 'string'));
}

export function lastReceipt(stream: string, dir?: string): Receipt | null {
  const chain = readChain(stream, dir);
  return chain[chain.length - 1] || null;
}

// ---- release epochs -------------------------------------------------------
export function epochPath(dir?: string): string {
  return join(receiptsDir(dir), 'EPOCH.json');
}
export function currentEpoch(dir?: string): number {
  try {
    return Number(JSON.parse(readFileSync(epochPath(dir), 'utf8')).current) || 1;
  } catch {
    return 1;
  }
}
const genesisOf = (epoch: number): string => (epoch <= 1 ? 'genesis' : `genesis-e${epoch}`);

// ---- single-writer lock ----------------------------------------------------
// v0.5 concurrency fix: the read-tail → sign → append transaction is serialized
// across processes with an atomic mkdir lock. No queue, no daemon, no DB.
// v0.5.0 review fix (local-model review): a stale lock is only stolen when its
// holder PID is DEAD — a stalled-but-alive writer keeps the critical section,
// and waiters time out instead of corrupting the chain.
const LOCK_STALE_MS = 10000;
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
export function withLockDir<T>(lock: string, fn: () => T): T {
  mkdirSync(dirname(lock), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let steal = false;
      try {
        const stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
        const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
        steal = stale && !pidAlive(pid);
      } catch { steal = false; }
      if (steal) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ } }
      if (Date.now() - t0 > 30000) throw new Error(`lock timeout (held by live writer): ${lock}`);
      spawnSync('sleep', ['0.05']);
    }
  }
  try { writeFileSync(join(lock, 'pid'), String(process.pid)); } catch { /* best-effort */ }
  try {
    return fn();
  } finally {
    try { unlinkSync(join(lock, 'pid')); } catch { /* best-effort */ }
    try { rmdirSync(lock); } catch { /* already released */ }
  }
}

function withChainLock<T>(dir: string | undefined, fn: () => T): T {
  return withLockDir(join(receiptsDir(dir), '.lock'), fn);
}

// v0.5.0 review fix: epoch rotation is atomic (write-temp + rename) so a
// concurrent verifier can never read a half-written EPOCH file.
export function rotateEpoch(n: number, reason: string, dir?: string): void {
  const p = epochPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ current: n, startedAt: new Date().toISOString(), reason }, null, 2) + '\n');
  renameSync(tmp, p);
}

export function appendReceipt(stream: string, input: ReceiptInput, dir?: string): Receipt {
  return withChainLock(dir, () => {
    const epoch = currentEpoch(dir);
    const prev = lastReceipt(stream, dir);
    const sameEpochPrev = prev && (prev.epoch ?? 1) === epoch ? prev : null;
    const base = {
      v: 1 as const,
      id: `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      stream,
      ts: new Date().toISOString(),
      env_lock: input.env_lock ?? captureEnvLock(['ffmpeg', 'ffprobe'], dir),
      ...input,
      epoch,
      prev_hash: sameEpochPrev?.hash ?? genesisOf(epoch)
    };
    const { signer, signature } = signBody(base as unknown as Record<string, unknown>, dir);
    const signed = { ...base, signer, signature };
    const rec: Receipt = { ...signed, hash: hashOf({ ...signed, hash: '' }) };
    const p = receiptsPath(stream, dir);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
    // CONTROL PLANE: every seal also publishes onto the runs.jsonl event bus
    busPublish('receipt.sealed', { stream, id: rec.id, hash: rec.hash, kind: rec.kind, subject: rec.subject, epoch }, dir);
    return rec;
  });
}

export function verifySignature(rec: Receipt): boolean {
  return verifyBody(rec as unknown as Record<string, unknown>);
}

export interface EpochSegment {
  epoch: number;
  count: number;
  ok: boolean;
  brokenAt?: string;
  reason?: string;
  // legacy segments (epoch < current) are preserved unchanged as incident
  // evidence; their breakage does not fail the release verification.
  incident?: boolean;
}

export interface VerifyResult {
  ok: boolean; // current release epoch verifies clean
  count: number;
  current_epoch: number;
  segments: EpochSegment[];
  brokenAt?: string;
  reason?: string;
}

const verifySegment = (recs: Receipt[], epoch: number, incident: boolean): EpochSegment => {
  let prev = genesisOf(epoch);
  for (const r of recs) {
    if (r.prev_hash !== prev) {
      return { epoch, count: recs.length, ok: false, brokenAt: r.id, reason: `prev_hash mismatch (chain link broken before ${r.id})`, incident };
    }
    const { hash, ...rest } = r;
    if (hashOf({ ...rest, hash: '' }) !== hash) {
      return { epoch, count: recs.length, ok: false, brokenAt: r.id, reason: `body hash mismatch (receipt ${r.id} was tampered with)`, incident };
    }
    prev = r.hash;
  }
  return { epoch, count: recs.length, ok: true, incident };
};

export function verifyChain(stream: string, dir?: string): VerifyResult {
  const chain = readChain(stream, dir);
  const current = currentEpoch(dir);
  const byEpoch = new Map<number, Receipt[]>();
  for (const r of chain) {
    const e = r.epoch ?? 1;
    byEpoch.set(e, [...(byEpoch.get(e) ?? []), r]);
  }
  const segments = [...byEpoch.keys()].sort((a, b) => a - b)
    .map(e => verifySegment(byEpoch.get(e)!, e, e < current));
  const cur = segments.find(s => s.epoch === current) ?? { epoch: current, count: 0, ok: true };
  const result: VerifyResult = { ok: cur.ok, count: chain.length, current_epoch: current, segments };
  if (!cur.ok) {
    result.brokenAt = cur.brokenAt;
    result.reason = cur.reason;
  }
  return result;
}
