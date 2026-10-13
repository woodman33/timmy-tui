// spawnSync's result, without blocking the test worker (R4 H31).
//
// A vitest worker runs its tests and its RPC to the main process on one event loop. spawnSync, execSync and
// execFileSync stop that loop until the child exits, and vitest does not yield between tests, so back-to-back
// synchronous tests add up. When the loop stays blocked for 60 s, the reply to the worker's last RPC sits
// unread until birpc's 60 s timer fires first: "[vitest-worker]: Timeout calling "onTaskUpdate"", an
// unhandled error that fails the run although every test passed. A synchronous call that never returns
// also keeps vitest's own testTimeout from firing, so the worker hangs until something outside kills it.
// Awaiting this instead keeps the loop running: replies are read on time, and a test that hangs fails at
// its timeout.
import { spawn } from 'node:child_process';

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not start, or when `timeout` stopped it (code ETIMEDOUT), as with spawnSync. */
  error?: Error;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed (spawnSync's `input`); with none, stdin is closed at once. */
  input?: string;
  /** Stop the child after this many ms with `killSignal`, as spawnSync's `timeout` does. */
  timeout?: number;
  killSignal?: NodeJS.Signals;
}

export function runAsync(command: string, args: readonly string[] = [], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let error: Error | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const settle = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, ...(error ? { error } : {}) });
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (e) => { error = e; if (child.pid === undefined) settle(null, null); });
    child.on('close', (status, signal) => settle(status, signal));
    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        error = Object.assign(new Error(`spawn ${command} ETIMEDOUT`), { code: 'ETIMEDOUT' });
        child.kill(options.killSignal ?? 'SIGTERM');
        // As spawnSync does: stop reading pipes that a grandchild may still hold open.
        child.stdout.destroy();
        child.stderr.destroy();
      }, options.timeout);
    }
    child.stdin.on('error', () => { /* the child may exit without reading its input */ });
    child.stdin.end(options.input ?? '');
  });
}
