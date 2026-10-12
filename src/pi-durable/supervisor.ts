/**
 * Pi Durable, slice S1 (R4 H118): how any Timmy process gets the project's Pi worker (plan b.1.6).
 *
 * `ensureWorker(root)`: read worker.json; when its writer is alive (the writerState proof: pid AND process start) and its
 * hello answers with this project's id and store, attach. Otherwise start `node <worker entry> --project <root>`
 * DETACHED (its own process group, its output appended to .timmy/pi/worker.log) and wait up to 10 s for its hello. A
 * started worker that exits 3 found the store owned (another starter won the race): attach to that owner. The SQLite
 * lock is the guarantee that one store never has two workers; worker.json is only the directory.
 *
 * `attachWorker(root)` only attaches; it never starts anything (what a UI that is just looking does).
 */
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { THIS_PROCESS } from '../ops/process-proof.js';
import { ownerState, readOwner, readToken, sha256Hex } from './owner.js';
import { piPaths, STORE_REL, type PiPaths } from './paths.js';
import { PiClient } from './protocol.js';

export const START_WAIT_MS = 10_000;
/** provider keys the worker never needs in S1 (its only model is FAKE): blanked in its environment, as planAgent blanks OPENROUTER_API_KEY */
export const BLANKED_KEYS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

export interface EnsureOptions {
  readonly workerDir?: string;
  /** how long to wait for a started worker's hello (default 10 s) */
  readonly waitMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** who is asking, sent in hello */
  readonly surface?: string;
}

export interface Attached {
  readonly client: PiClient;
  readonly how: 'attached' | 'started' | 'attached after exit 3';
  /** the pid this call started, when it started one (it may have exited 3) */
  readonly spawned?: number;
  readonly spawnedExit?: number | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Attaches to the project's live worker, or answers why not (never starts one). */
export async function attachWorker(root: string, surface = 'timmy'): Promise<PiClient | { error: string }> {
  const paths = piPaths(root);
  const owner = readOwner(paths);
  if (!owner) return { error: 'no Pi worker record (worker.json) in this project' };
  const state = ownerState(owner);
  if (state === 'gone') return { error: `the Pi worker recorded (pid ${owner.pid}) is gone` };
  if (owner.project_id !== paths.projectId || owner.store !== STORE_REL) return { error: 'worker.json names another project or store' };
  const token = readToken(paths);
  if (!token || owner.token_sha256 !== sha256Hex(token)) return { error: 'the Pi worker token does not match worker.json' };
  let client: PiClient;
  try {
    client = await PiClient.connect(owner.socket, { token, pid: THIS_PROCESS.pid, started: THIS_PROCESS.started, surface }, 5000);
  } catch (e) { return { error: `the Pi worker (pid ${owner.pid}) did not answer hello: ${e instanceof Error ? e.message : String(e)}` }; }
  if (client.hello.project_id !== paths.projectId || client.hello.store !== STORE_REL || client.hello.pid !== owner.pid) {
    client.close();
    return { error: 'the worker that answered is not this project\'s (its hello names another project, store or pid)' };
  }
  return client;
}


/** The worker's entry and how node runs it: the built .js as it is, the source .ts through tsx's loader. */
export function workerCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.ts')) {
    const entry = fileURLToPath(new URL('./worker.ts', import.meta.url));
    const loader = createRequire(import.meta.url).resolve('tsx');
    return { command: process.execPath, args: ['--import', loader, entry] };
  }
  return { command: process.execPath, args: [fileURLToPath(new URL('./worker.js', import.meta.url))] };
}

/** The last lines of the worker's log, for a failure's words. */
export function logTail(paths: PiPaths, n = 12): string {
  try { return readFileSync(paths.log, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return '(no worker log)'; }
}

/** Starts one worker, detached, with its output appended to worker.log. */
function startWorker(paths: PiPaths, opts: EnsureOptions): { pid: number; exited: Promise<number | null> } {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const fd = openSync(paths.log, 'a', 0o600);
  const { command, args } = workerCommand();
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  for (const k of BLANKED_KEYS) delete env[k];
  const child = spawn(command, [...args, '--project', paths.root, ...(opts.workerDir ? ['--worker-dir', opts.workerDir] : [])], {
    cwd: paths.root, env, detached: true, stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
    child.once('error', () => resolveExit(null));
  });
  child.unref();
  if (child.pid === undefined) throw new Error('the Pi worker could not be started');
  return { pid: child.pid, exited };
}

/**
 * Attach to the live owner, or start the worker and attach to it. Never a second worker for one store: a start that
 * lost the race exits 3 and this call attaches to the winner. One more start is tried only when no owner appears at all.
 */
export async function ensureWorker(root: string, opts: EnsureOptions = {}): Promise<Attached> {
  const paths = piPaths(root);
  const surface = opts.surface ?? 'timmy';
  const first = await attachWorker(root, surface);
  if (first instanceof PiClient) return { client: first, how: 'attached' };
  const waitMs = opts.waitMs ?? START_WAIT_MS;
  let lastExit: number | null | undefined;
  let spawned: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = startWorker(paths, opts);
    spawned = started.pid;
    let exit: number | null | undefined;
    void started.exited.then((code) => { exit = code; });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(100);
      const c = await attachWorker(root, surface);
      if (c instanceof PiClient) {
        if (c.hello.pid === started.pid) return { client: c, how: 'started', spawned: started.pid };
        return { client: c, how: 'attached after exit 3', spawned: started.pid, spawnedExit: exit ?? (await Promise.race([started.exited, sleep(3000).then(() => undefined)])) ?? null };
      }
      if (exit !== undefined && exit !== 3) {
        throw new Error(`the Pi worker exited ${exit} before it answered: ${logTail(paths)}`);
      }
    }
    lastExit = exit;
    if (exit === undefined) throw new Error(`the Pi worker (pid ${started.pid}) did not answer hello within ${waitMs} ms: ${logTail(paths)}`);
    // it exited 3 and no owner answered in time: one more start
  }
  throw new Error(`no Pi worker could be started or attached (last start exited ${String(lastExit)}, pid ${String(spawned)}): ${logTail(paths)}`);
}
