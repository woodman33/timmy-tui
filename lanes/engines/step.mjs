// lanes/engines/step.mjs — one engine step = one child process.
//
// Codex's research (docs/brainstorms/2026-09-14-async-software-control-brainstorm.md, "Native engines"):
// the engine loop called spawnSync inside an async function, so a slow step froze Timmy's whole event
// loop for its duration. runWorkflow awaits this function instead. tests/engine-step.test.ts proves
// a slow subprocess leaves the loop free to tick.
import { spawnProcess } from '../../src/runtime/spawn-runtime.js';

/**
 * Run one step's command and report it the way the engine record expects.
 * @param {string} bin  resolved binary
 * @param {string[]} argv
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number }} opts
 * @returns {Promise<{ status: number|null, signal: string|null, stdout: string, stderr: string, timed_out: boolean, error: string|null }>}
 */
export async function runStepCommand(bin, argv, { cwd, env = process.env, timeoutMs = 600000, maxBuffer = 64 * 1024 * 1024 }) {
  const { outcome } = spawnProcess(bin, argv, { cwd, env, timeoutMs, maxBuffer });
  const o = await outcome;
  return { status: o.status, signal: o.signal, stdout: o.stdout, stderr: o.stderr, timed_out: o.timedOut, error: o.error };
}
