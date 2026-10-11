/**
 * R4 (H62; ledger row 159): Timmy's OpenHands worker, run for real under this machine's python3 and stopped by a real
 * signal (docker stop sends SIGTERM; Ctrl+C through docker's signal proxy, SIGINT). It prints its result line, status
 * stopped, with the run's token, its steps and its tokens so far and the signal, flushes it and exits 128 + the signal's
 * number. The OpenHands SDK is not installed here: the worker runs on a FAKE SDK (tests/fixtures/fake-openhands-sdk.py, a
 * TEST DOUBLE that calls no model and runs no tool), so the worker's own code runs: its stdin, its lines, its handler.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newProgress } from '../src/code-agents/index.js';
import { judgeOpenHands, openHandsProgressLine, watchOpenHands } from '../src/code-agents/openhands.js';

const WORKER = join(__dirname, '..', 'workers', 'openhands', 'timmy_openhands.py');
const FAKE_SDK = join(__dirname, 'fixtures', 'fake-openhands-sdk.py');
const TOKEN = 'ab'.repeat(16);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(20); }
}

/** The worker on the FAKE SDK, its request on stdin (left open with `open`), as its container runs it. */
function runWorker(task: string, o: { env?: Record<string, string>; open?: boolean } = {}) {
  const child = spawn('python3', ['-B', FAKE_SDK, WORKER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', LLM_MODEL: 'ollama_chat/qwen3:4b', LLM_BASE_URL: 'http://host.docker.internal:11434', LLM_API_KEY: 'ollama', TIMMY_OPENHANDS_MAX_ITERATIONS: '40', PYTHONDONTWRITEBYTECODE: '1', ...o.env },
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
  child.stderr.setEncoding('utf8').on('data', (c: string) => { err += c; });
  const request = `${JSON.stringify({ v: 1, task, token: TOKEN })}\n`;
  if (o.open) child.stdin.write(request); else child.stdin.end(request);
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('close', (code, signal) => r({ code, signal })));
  return { child, out: () => out, err: () => err, exited };
}
const parsed = (out: string): Array<Record<string, unknown>> => out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const actions = (out: string): number => (out.match(/"type": "action"/g) ?? []).length;

describe('the OpenHands worker, stopped by a signal (python3, a FAKE SDK)', () => {
  it('SIGTERM: its result line (status stopped, its token, its steps and tokens so far, the signal), flushed, exit 143; Timmy reads it', async () => {
    const w = runWorker('HANG a long task');
    await until(() => actions(w.out()) >= 2);
    w.child.kill('SIGTERM');
    expect(await w.exited).toEqual({ code: 143, signal: null });
    const lines = parsed(w.out());
    expect(lines.map((l) => l.type)).toEqual(['started', 'action', 'observation', 'action', 'observation', 'result']);
    expect(lines.at(-1)).toEqual({ v: 1, type: 'result', token: TOKEN, status: 'stopped', finished: false, steps: 2, max_iterations: 40, signal: 'SIGTERM', usage: { input: 900, output: 30 } });
    expect(w.err()).not.toContain('Traceback');
    // Timmy's reader believes it (its token) and its judge says it beside how Timmy stopped the run
    const progress = newProgress();
    watchOpenHands(progress, TOKEN);
    const shown = w.out().trim().split('\n').map((l) => openHandsProgressLine(l, progress, '/proj'));
    expect(shown.at(-1)).toBe('done  not finished: it was stopped (SIGTERM) · 2 steps · 900 tokens in, 30 out');
    expect(judgeOpenHands({ state: 'cancelled', exitCode: 143 }, progress, 'with /stop').why).toBe('stopped with /stop before it finished; the worker\'s own last line: stopped at step 2 (SIGTERM), 900 tokens in, 30 out');
  }, 30_000);

  it('SIGINT (Ctrl+C through docker\'s signal proxy): the same line, its signal named, exit 130', async () => {
    const w = runWorker('HANG a long task');
    await until(() => actions(w.out()) >= 2);
    w.child.kill('SIGINT');
    expect(await w.exited).toEqual({ code: 130, signal: null });
    expect(parsed(w.out()).at(-1)).toMatchObject({ type: 'result', status: 'stopped', steps: 2, signal: 'SIGINT', usage: { input: 900, output: 30 } });
    expect(w.err()).not.toContain('Traceback');
  }, 30_000);

  it('a signal arriving while it writes a line: that line is finished first, then its result line; every line is whole', async () => {
    const w = runWorker('HANG a long task', { env: { FAKE_SDK_SIGNAL_IN_WRITE: '1' } });
    expect(await w.exited).toEqual({ code: 143, signal: null });
    const lines = parsed(w.out()); // throws on a broken line
    expect(lines.map((l) => l.type)).toEqual(['started', 'action', 'result']);
    expect(lines[1]).toMatchObject({ token: TOKEN, n: 1, tool: 'terminal', command: 'ls' });
    expect(lines[2]).toEqual({ v: 1, type: 'result', token: TOKEN, status: 'stopped', finished: false, steps: 1, max_iterations: 40, signal: 'SIGTERM', usage: { input: 450, output: 15 } });
    expect(w.err()).not.toContain('Traceback');
  }, 30_000);

  it('an SDK that installs a SIGTERM handler of its own while its conversation is made does not take the stop away', async () => {
    const w = runWorker('HANG a long task', { env: { FAKE_SDK_OWN_HANDLER: '1' } });
    await until(() => actions(w.out()) >= 2);
    w.child.kill('SIGTERM');
    const ended = await Promise.race([w.exited, sleep(10_000).then(() => 'still running' as const)]);
    if (ended === 'still running') w.child.kill('SIGKILL');
    expect(ended).toEqual({ code: 143, signal: null });
    expect(parsed(w.out()).at(-1)).toMatchObject({ type: 'result', status: 'stopped', steps: 2, signal: 'SIGTERM' });
  }, 30_000);

  it('a signal before it has read its task: no protocol line (it has no token to give one), its words on stderr, exit 143', async () => {
    const w = runWorker('HANG a long task', { open: true });
    await until(() => w.err().includes('the worker is loaded'));
    w.child.kill('SIGTERM');
    expect(await w.exited).toEqual({ code: 143, signal: null });
    expect(w.out()).toBe('');
    expect(w.err()).toContain('timmy_openhands: stopped (SIGTERM) before it read its task');
  }, 30_000);

  it('a run that finished keeps its own result: a signal after it is not a second result', async () => {
    const w = runWorker('a short task');
    expect(await w.exited).toEqual({ code: 0, signal: null });
    const lines = parsed(w.out());
    expect(lines.map((l) => l.type)).toEqual(['started', 'action', 'observation', 'result']);
    expect(lines.at(-1)).toMatchObject({ status: 'finished', finished: true, steps: 1, usage: { input: 450, output: 15 } });
  }, 30_000);
});
