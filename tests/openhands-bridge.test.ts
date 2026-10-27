/**
 * scripts/openhands-sdk-bridge.py, as adopted from the OpenHands attempts checkpoint b56c36f0 (timmy-new-1, 2026-10-27).
 *
 * History kept: R4 (H104) replaced a re-prompt written for one test fixture ("edit /work/add.js") with one built from the
 * task's own failing acceptance commands, sent at most three times. b56c36f0 keeps that rule (the corrective message names
 * the task's own failing checks, never a fixture edit) and replaces the loop with one bounded budget: the initial run and
 * one corrective run share max_iterations (1..16); each check runs with a time limit (1..60 s) and its process group is
 * killed at the limit; the patch is taken against the source the run started from (agent commits included); and `ok` now
 * means the checks pass in the workspace and in a pristine clone with the patch alone. An empty acceptance list is refused
 * before the SDK is loaded. The re-prompt's quoted output tails (OUTPUT_TAIL, REPROMPT_MAX) went with the loop.
 *
 * Real: python3, the bridge run as a script (as the adapter and the runner image run it), a disposable git workspace and its
 * checks. FAKE: the SDK (tests/fixtures/openhands-sdk-fake: no model, no agent; its conversation records each message and,
 * on a chosen run, writes the change an agent would make). The owner's own offline tests (tests/test_openhands_sdk_bridge.py,
 * a fake conversation patched in) run here too, through python3's unittest.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BRIDGE = resolve('scripts/openhands-sdk-bridge.py');
const FAKE_SDK = resolve('tests/fixtures/openhands-sdk-fake');
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
if (!python) console.warn('openhands-bridge: no python3 here, so the bridge is not checked');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
// never a __pycache__ beside the bridge or in the FAKE SDK
const PY_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };

/** Words written for the one fixture the old re-prompt named, which no corrective message may carry. */
const FIXTURE_WORDS = /add\.js|a - b|a \+ b|str_replace|npm test/;

/** A git workspace whose acceptance (sh check.sh) passes only when answer.txt holds 42; it holds 41. */
function workspace(): { work: string; pristine: string; log: string } {
  const dir = temp('oh-bridge-run-');
  const work = join(dir, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'answer.txt'), '41\n');
  writeFileSync(join(work, 'check.sh'), 'a=$(cat answer.txt); if [ "$a" = 42 ]; then echo ok; else echo "FIXTURE: answer.txt holds $a, expected 42"; exit 1; fi\n');
  const git = (args: string[]): void => { const r = spawnSync('git', args, { cwd: work, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.email=timmy@local', '-c', 'user.name=timmy', 'commit', '-q', '-m', 'FIXTURE: red']);
  return { work, pristine: join(dir, 'pristine'), log: join(dir, 'messages.jsonl') };
}

/** The bridge run as a script on the FAKE SDK: its exit, its result envelope (the last JSON line) and the messages sent. */
function runBridge(w: ReturnType<typeof workspace>, fixOnRun: number, acceptance: string[], more: Record<string, unknown> = {}): { code: number | null; result: Record<string, any>; messages: string[] } {
  const stdin = JSON.stringify({ task: 'FIXTURE task: make answer.txt hold 42 so that sh check.sh passes.', workspace: w.work, acceptance, pristine_dir: w.pristine, ...more });
  const r = spawnSync('python3', ['-B', BRIDGE], {
    input: stdin, encoding: 'utf8', timeout: 60_000,
    env: { ...PY_ENV, PYTHONPATH: FAKE_SDK, FAKE_OH_LOG: w.log, FAKE_OH_FIX_ON_RUN: String(fixOnRun), FAKE_OH_FIX_FILE: 'answer.txt', FAKE_OH_FIX_TEXT: '42\n', LLM_MODEL: 'ollama/FAKE' },
  });
  const last = r.stdout.trim().split('\n').pop() ?? '';
  let messages: string[] = [];
  try { messages = readFileSync(w.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { message: string }).message); } catch { messages = []; }
  return { code: r.status, result: JSON.parse(last) as Record<string, any>, messages };
}

describe.skipIf(!python)('the OpenHands bridge (b56c36f0) on a FAKE SDK: one bounded correction from the task\'s own checks', () => {
  it('fixed by the corrective run: the message names the task\'s own failing check, never a fixture edit; green in the workspace and in a pristine clone with the patch alone', () => {
    const w = workspace();
    const { code, result, messages } = runBridge(w, 2, ['sh check.sh']);
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.host_canary).toBe(false);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe('FIXTURE task: make answer.txt hold 42 so that sh check.sh passes.');
    expect(messages[1]).toContain('[{"cmd": "sh check.sh", "code": 1}]'); // python's json.dumps spacing
    expect(messages[1]).toMatch(/Do not weaken, replace, or bypass the acceptance checks/);
    expect(messages[1]).not.toMatch(FIXTURE_WORDS);
    expect(result.work_acceptance).toEqual([{ cmd: 'sh check.sh', code: 0 }]);
    expect(result.patch).toContain('-41');
    expect(result.patch).toContain('+42');
    expect(result.patch_applied).toBe(true);
    expect(result.pristine_acceptance).toEqual([{ cmd: 'sh check.sh', code: 0 }]);
  });

  it('never fixed: one correction at most, then the failing checks are the result (ok false, exit 1), with an empty patch', () => {
    const w = workspace();
    const { code, result, messages } = runBridge(w, 0, ['sh check.sh']);
    expect(code).toBe(1);
    expect(result.ok).toBe(false);
    expect(messages).toHaveLength(2);
    expect(result.work_acceptance).toEqual([{ cmd: 'sh check.sh', code: 1 }]);
    expect(result.patch).toBe('');
    expect(result.note).toBe('working or pristine acceptance failed');
  });

  it('a budget of one iteration has no correction; a task with no acceptance commands is refused before the SDK runs', () => {
    const w = workspace();
    const one = runBridge(w, 0, ['sh check.sh'], { max_iterations: 1 });
    expect(one.messages).toHaveLength(1);
    expect(one.result.ok).toBe(false);
    const w2 = workspace();
    const none = runBridge(w2, 0, []);
    expect(none.result.ok).toBe(false);
    expect(none.result.note).toMatch(/acceptance command is required/);
    expect(none.messages).toEqual([]);
  });

  it('the bridge carries no fixture instruction', () => {
    const source = readFileSync(BRIDGE, 'utf8');
    expect(source).not.toContain('/work/add.js');
    expect(source).not.toContain('"a - b"');
    expect(source).toContain("if __name__ == '__main__':");
  });

  it('the owner\'s offline bridge tests pass (python3 unittest, a fake conversation patched in)', () => {
    const r = spawnSync('python3', ['-B', '-m', 'unittest', '-v', 'tests/test_openhands_sdk_bridge.py'], { encoding: 'utf8', env: PY_ENV, timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Ran 8 tests/);
  }, 130_000);
});
