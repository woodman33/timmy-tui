/**
 * Shared fixtures for the Pi Durable S1 tests (tests/pi-durable-*.test.ts; R4 H118). REAL: worker processes started by
 * the supervisor (node --import tsx src/pi-durable/worker.ts, detached), pi-durable 1.1.0's SQLite store, the exclusive
 * lock, the socket protocol, the effect ledger, project files. FAKE: every model (pi-ai's in-memory faux provider,
 * scripted per run; no request leaves the machine) and the fixture projects (temporary folders).
 *
 * The pinned packages are installed only on the operator's yes (workers/pi-durable); without them the tests that need a
 * worker are skipped, and say so.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOwner } from '../../src/pi-durable/owner.js';
import { piPaths } from '../../src/pi-durable/paths.js';
import { ensureWorker, type Attached, type EnsureOptions } from '../../src/pi-durable/supervisor.js';
import type { PiClient } from '../../src/pi-durable/protocol.js';
import type { FauxScript } from '../../src/pi-durable/faux.js';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const WORKER_DIR = join(ROOT, 'workers', 'pi-durable');
export const INSTALLED = existsSync(join(WORKER_DIR, 'node_modules', '@earendil-works', 'pi-durable', 'package.json'));
export const SKIP_WHY = 'the pinned Pi Durable packages are not installed in workers/pi-durable (installed only on the operator\'s yes)';

export const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every worker pid a test saw, killed (by pid, only these) when the file ends. */
const pids = new Set<number>();
const folders: string[] = [];

export function project(name: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), `pi-durable-${name}-`));
  folders.push(root);
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
  return root;
}

/** Registers a process the test caused (a worker started another way, a command a worker ran): killed by pid at cleanup. */
export function track(pid: number | undefined): void { if (pid !== undefined && pid > 1) pids.add(pid); }

export async function start(root: string, opts: EnsureOptions = {}): Promise<Attached> {
  const a = await ensureWorker(root, { waitMs: 45_000, surface: 'test', ...opts });
  pids.add(a.client.hello.pid);
  if (a.spawned) pids.add(a.spawned);
  return a;
}

export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 45_000, every = 100): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e; }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 400)})`);
    await sleep(every);
  }
}

/** SIGKILL the project's worker (the pid its owner record names) and wait until it is gone. */
export async function killWorker(root: string): Promise<number> {
  const owner = readOwner(piPaths(root));
  if (!owner) throw new Error('no worker.json to kill');
  pids.add(owner.pid);
  process.kill(owner.pid, 'SIGKILL');
  await until(`pid ${owner.pid} to be gone`, () => !alive(owner.pid), 15_000, 50);
  return owner.pid;
}

export function jsonl<T = Record<string, unknown>>(path: string): T[] {
  try { return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T); } catch { return []; }
}

export interface EffectLine { key: string; run: string; state: string; by: string; outcome?: string; readback?: { sha256: string }; new_sha256?: string; expected_sha256?: string; argv?: string[]; output?: string; exit?: number | null }
export const effects = (root: string, run?: string): EffectLine[] => jsonl<EffectLine>(piPaths(root).effects).filter((e) => !run || e.run === run);
export const fauxCalls = (root: string, run: string): { run: string; last_role: string | null; last_text: string | null; pid: number }[] => jsonl<{ run: string; last_role: string | null; last_text: string | null; pid: number }>(piPaths(root).fauxCalls).filter((c) => c.run === run);
export const reads = (root: string, run: string): { run: string; call_id: string; pid: number }[] => jsonl<{ run: string; call_id: string; pid: number }>(join(piPaths(root).dir, 'reads.jsonl')).filter((c) => c.run === run);

export interface Status {
  run: string; status: string; scheduling: string; submission: { id: number; status: string; reason: string | null; request_id: string } | null;
  tasks: { id: number; kind: string; status: string; phase: string | null; owner: number | null; abort_requested: boolean; inspect: string }[];
  entries: { id: number; kind: string; stop: string | null; text: string }[]; user_entries: number;
  effects: EffectLine[]; needs_you: { key: string; why: string; answered?: { decision: string; by: string; at: string } }[]; stop_requested: unknown; paused: { why: string } | null; interrupted: { why: string } | null;
  cost: { usd: number | null; basis: string; measured: boolean; words: string }; resubmitted: { submission: number; same: boolean }[]; ended: { status: string; reason?: string } | null;
  submissions: number[]; messages: { n: number; key?: string; mode: string; submission: number }[];
}
export const status = (c: PiClient, run: string): Promise<Status> => c.request<Status>('status', { run });

export interface Delegated { ok: boolean; started?: boolean; refused?: string; run: string; submission: number; conversation: number; request_id: string }
export const delegate = (c: PiClient, script: FauxScript, extra: { key?: string; task?: string } = {}): Promise<Delegated> =>
  c.request<Delegated>('delegate', { task: extra.task ?? 'FAKE task for a FAKE model', ...(extra.key ? { key: extra.key } : {}), model: { route: 'faux', script } });

export const ended = (c: PiClient, run: string, ms = 45_000): Promise<Status> => until(`run ${run} to end`, async () => { const s = await status(c, run); return s.ended ? s : undefined; }, ms, 150);

/** At the end of a file: SIGKILL every worker it saw that still runs, then remove its fixture folders. */
export function cleanup(): void {
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  pids.clear();
  for (const f of folders.splice(0)) { rmSync(piPaths(f).socket, { force: true }); rmSync(f, { recursive: true, force: true }); }
}

/** Whether any worker this file saw still runs (none should at the end). */
export const anyAlive = (): number[] => [...pids].filter(alive);
