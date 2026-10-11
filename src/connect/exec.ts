/**
 * Round R4 (helper H90): runs one OpenSSH program (ssh, ssh-keyscan, ssh-keygen) or tailscale as a child process with an
 * argument array: never a shell on this side. Its stdin gets exactly the bytes given (a script, never in argv), its stdout
 * comes back as bytes (a fetched file is binary), its stderr as text. A time limit ends it with SIGTERM, then SIGKILL.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface Ran {
  /** the exit code; null when it ended by a signal or never started */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  /** Timmy's own time limit ended it */
  timedOut: boolean;
  /** the caller stopped it (a Ctrl-C during a wait) */
  aborted: boolean;
  /** it never started: ENOENT (not on PATH), EACCES … */
  spawnError?: string;
  /** stdout went past maxOut and the program was stopped */
  overflow: boolean;
  ms: number;
}

export interface RunOptions {
  input?: Buffer | string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** at most this many stdout bytes are kept (default 8 MiB); past it the program is stopped (overflow) */
  maxOut?: number;
  /** stdout is handed here as it comes and not kept (a fetch streams it to a file) */
  onStdout?: (chunk: Buffer) => void;
  /** the caller's stop (a Ctrl-C): the program gets SIGTERM, then SIGKILL */
  signal?: AbortSignal;
  /** the started child, for a test or a caller that must know its pid */
  onChild?: (child: ChildProcess) => void;
  /** start it in a process group of its own, so a terminal's Ctrl-C reaches only Timmy, which then stops it (a wait) */
  ownGroup?: boolean;
}

const KILL_AFTER_MS = 2000;
const MAX_ERR = 64 * 1024;

export function runProgram(program: string, args: readonly string[], o: RunOptions): Promise<Ran> {
  const started = performance.now();
  const maxOut = o.maxOut ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(program, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: o.env ?? process.env, windowsHide: true, detached: o.ownGroup === true });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, aborted: false, spawnError: (e as NodeJS.ErrnoException).code ?? String(e), overflow: false, ms: 0 });
      return;
    }
    o.onChild?.(child);
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      killTimer ??= setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, KILL_AFTER_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, o.timeoutMs));
    timer.unref();
    const onAbort = (): void => { aborted = true; stop(); };
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      if (o.onStdout) { o.onStdout(chunk); return; }
      if (overflow) return;
      outBytes += chunk.length;
      if (outBytes > maxOut) { overflow = true; stop(); return; }
      out.push(chunk);
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { if (err.length < MAX_ERR) err += chunk.slice(0, MAX_ERR - err.length); });
    child.stdin!.on('error', () => { /* the program ended before it read everything: its exit says why */ });
    child.on('error', (e: NodeJS.ErrnoException) => { spawnError = e.code ?? e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      o.signal?.removeEventListener('abort', onAbort);
      // (a program that never started closes with a negative errno as its code: that is not an exit)
      resolve({ code: spawnError ? null : code, signal, stdout: Buffer.concat(out), stderr: err, timedOut, aborted, ...(spawnError ? { spawnError } : {}), overflow, ms: Math.round(performance.now() - started) });
    });
    if (o.input !== undefined) child.stdin!.end(o.input);
    else child.stdin!.end();
  });
}
