/**
 * R4 (H104): scripts/openhands-sdk-bridge.py's re-prompt. When the agent stopped with the task's acceptance still failing,
 * the bridge asked again with an instruction written for one test fixture (edit /work/add.js, "a - b" to "a + b"), whatever
 * the task was. Now a re-prompt is built from the task's own acceptance commands that still fail and the end of each one's
 * last output, bounded, at most three times, and each one sent is recorded in the result.
 *
 * Without the SDK: python3 (a real child process) loads the bridge as a module (its SDK imports are inside main()) and builds
 * re-prompts for FIXTURE tasks, their acceptance commands run for real in a temporary folder. With a FAKE SDK
 * (tests/fixtures/openhands-sdk-fake: no model and no agent; its conversation records each message and, on a chosen run,
 * writes the change an agent would make): the bridge runs as a script, as the adapter and the runner image run it, on a
 * temporary git workspace, through its loop and its patch lifecycle. The real SDK runs only on the operator's Mac.
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

interface AcceptanceResult { cmd: string; code: number; output: string }
interface Built { text: string; acceptance?: AcceptanceResult[]; limits: { tail: number; max: number; rounds: number } }

/** The bridge loaded as a module (no SDK), its acceptance run for real when `cwd` is given, and one re-prompt built. */
function build(input: { commands?: string[]; cwd?: string; results?: AcceptanceResult[]; round: number; rounds?: number; max?: number }): Built {
  const driver = [
    'import importlib.util, json, sys',
    "spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])",
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'inp = json.loads(sys.argv[2]); out = {}',
    "if inp.get('cwd'): out['acceptance'] = m.acceptance(inp['commands'], inp['cwd'])",
    "results = inp.get('results') or out.get('acceptance')",
    "out['text'] = m.reprompt(results, inp['round'], inp.get('rounds') or m.REPROMPT_ROUNDS, inp.get('max') or m.REPROMPT_MAX)",
    "out['limits'] = {'tail': m.OUTPUT_TAIL, 'max': m.REPROMPT_MAX, 'rounds': m.REPROMPT_ROUNDS}",
    'print(json.dumps(out))',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-B', '-c', driver, BRIDGE, JSON.stringify(input)], { encoding: 'utf8', env: PY_ENV, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`python3 exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as Built;
}

/** Words written for the one fixture the old re-prompt named, which no re-prompt may carry now. */
const FIXTURE_WORDS = /add\.js|a - b|a \+ b|str_replace|npm test/;

describe.skipIf(!python)('the OpenHands bridge\'s re-prompt is built from the task\'s own acceptance (R4 H104)', () => {
  it('names the task\'s acceptance commands that still fail, each with its exit code and the end of its output, and none that pass (FIXTURE: a Node task)', () => {
    const cwd = temp('h104-bridge-node-');
    const failing = 'node -e "process.stdout.write(\'FIXTURE: 3 tests, 1 failing: sum(2, 3) expected 5, got -1\'); process.exit(1)"';
    const out = build({ commands: [failing, 'true'], cwd, round: 1 });
    expect(out.acceptance!.map((a) => [a.cmd, a.code])).toEqual([[failing, 1], ['true', 0]]);
    expect(out.text).toContain('The task is not finished: 1 of its 2 acceptance checks still fails in the working directory (re-prompt 1 of 3).');
    expect(out.text).toContain(`$ ${failing}\n(exit code 1)\nFIXTURE: 3 tests, 1 failing: sum(2, 3) expected 5, got -1`);
    expect(out.text).not.toContain('$ true');
    expect(out.text).toContain('change them so that every acceptance command exits 0; then run it yourself with the terminal tool. Do not change the acceptance command.');
    expect(out.text).not.toMatch(FIXTURE_WORDS);
  });

  it('follows another task\'s commands and output word for word, round by round (FIXTURE: a Python task, two failing checks)', () => {
    const cwd = temp('h104-bridge-py-');
    const a = 'python3 -c "import sys; print(\'FIXTURE AssertionError: area(3, 4) returned 7, expected 12\'); sys.exit(2)"';
    const b = 'sh -c "echo FIXTURE lint: line 3 too long >&2; exit 3"';
    const out = build({ commands: [a, b], cwd, round: 2 });
    expect(out.text).toContain('2 of its 2 acceptance checks still fail in the working directory (re-prompt 2 of 3). Each command, its exit code');
    expect(out.text).toContain(`$ ${a}\n(exit code 2)\nFIXTURE AssertionError: area(3, 4) returned 7, expected 12`);
    // stderr is quoted too
    expect(out.text).toContain(`$ ${b}\n(exit code 3)\nFIXTURE lint: line 3 too long`);
    expect(out.text).toContain('then run them yourself with the terminal tool. Do not change the acceptance commands.');
    expect(out.text).not.toMatch(FIXTURE_WORDS);
    // a single check says "its acceptance check"
    expect(build({ results: [{ cmd: 'make check', code: 2, output: 'FIXTURE' }], round: 3 }).text).toContain('The task is not finished: its acceptance check still fails in the working directory (re-prompt 3 of 3). The command, its exit code');
    // nothing failing: no re-prompt
    expect(build({ results: [{ cmd: 'true', code: 0, output: '' }], round: 1 }).text).toBe('');
  });

  it('is bounded: each command\'s output to its last OUTPUT_TAIL characters without terminal codes, the whole to REPROMPT_MAX, a cut said where it is made', () => {
    const cwd = temp('h104-bridge-long-');
    // 100,000 characters of output, with colour codes, and its last line the one that matters
    writeFileSync(join(cwd, 'noisy.sh'), 'i=0; while [ $i -lt 2000 ]; do printf "\\033[31mFIXTURE noise line %04d ................................\\033[0m\\n" $i; i=$((i+1)); done; echo "FIXTURE last line: 1 failing"; exit 1\n');
    const out = build({ commands: ['sh noisy.sh'], cwd, round: 1 });
    const quoted = out.acceptance![0].output;
    expect(quoted.length).toBeLessThanOrEqual(out.limits.tail + 60);
    expect(quoted).toMatch(/^\[\.\.\. \d+ earlier characters not shown\]\n/);
    expect(quoted.endsWith('FIXTURE last line: 1 failing')).toBe(true);
    expect(quoted).not.toContain('\u001b');
    expect(out.text.length).toBeLessThanOrEqual(out.limits.max);
    expect(out.text).toContain('FIXTURE last line: 1 failing');
    // many long failing commands: every one named, the whole within the limit, each cut block saying so, the footer kept
    const many = Array.from({ length: 6 }, (_, i) => ({ cmd: `FIXTURE check ${i}`, code: 1, output: `FIXTURE ${'x'.repeat(1_190)} end ${i}` }));
    const big = build({ results: many, round: 1 });
    expect(big.text.length).toBeLessThanOrEqual(big.limits.max);
    for (let i = 0; i < 6; i++) expect(big.text).toContain(`$ FIXTURE check ${i}`);
    expect(big.text).toContain('[... cut: this re-prompt is at its length limit]');
    expect(big.text.endsWith('Do not change the acceptance commands.')).toBe(true);
    expect(big.limits).toEqual({ tail: 1200, max: 4000, rounds: 3 });
  });

  it('the bridge no longer carries the fixture\'s instruction', () => {
    const source = readFileSync(BRIDGE, 'utf8');
    expect(source).not.toContain('/work/add.js');
    expect(source).not.toContain('"a - b"');
    expect(source).toContain("if __name__ == '__main__':");
  });
});

/** A git workspace whose acceptance (sh check.sh) passes only when answer.txt holds 42; it holds 41. */
function workspace(): { work: string; pristine: string; log: string } {
  const dir = temp('h104-bridge-run-');
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

/** The bridge run as a script on the FAKE SDK; its result envelope (the last JSON line) and the messages the FAKE received. */
function runBridge(w: ReturnType<typeof workspace>, fixOnRun: number, acceptance: string[]): { result: Record<string, any>; messages: string[] } {
  const stdin = JSON.stringify({ task: 'FIXTURE task: make answer.txt hold 42 so that sh check.sh passes.', workspace: w.work, acceptance, pristine_dir: w.pristine });
  const r = spawnSync('python3', ['-B', BRIDGE], {
    input: stdin, encoding: 'utf8', timeout: 60_000,
    env: { ...PY_ENV, PYTHONPATH: FAKE_SDK, FAKE_OH_LOG: w.log, FAKE_OH_FIX_ON_RUN: String(fixOnRun), FAKE_OH_FIX_FILE: 'answer.txt', FAKE_OH_FIX_TEXT: '42\n', LLM_MODEL: 'ollama/FAKE' },
  });
  if (r.status !== 0) throw new Error(`the bridge exited ${r.status}: ${r.stderr}`);
  const last = r.stdout.trim().split('\n').pop() ?? '';
  let messages: string[] = [];
  try { messages = readFileSync(w.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { message: string }).message); } catch { messages = []; }
  return { result: JSON.parse(last) as Record<string, any>, messages };
}

describe.skipIf(!python)('the OpenHands bridge runs its bounded re-prompt loop (a FAKE SDK: no model, no agent) (R4 H104)', () => {
  it('fixed after the first re-prompt: one re-prompt, recorded with its round, the failing command and its text; then green in the workspace and in a pristine clone with the patch alone', () => {
    const w = workspace();
    const { result, messages } = runBridge(w, 2, ['sh check.sh']);
    expect(result.ok).toBe(true);
    expect(result.host_canary).toBe(false);
    expect(result.reprompt_rounds).toBe(3);
    expect(result.reprompts).toHaveLength(1);
    expect(result.reprompts[0]).toMatchObject({ round: 1, failing: [{ cmd: 'sh check.sh', code: 1 }] });
    expect(result.reprompts[0].text).toContain('$ sh check.sh\n(exit code 1)\nFIXTURE: answer.txt holds 41, expected 42');
    expect(result.reprompts[0].text).not.toMatch(FIXTURE_WORDS);
    // the FAKE received the task, then exactly the re-prompt recorded
    expect(messages).toEqual(['FIXTURE task: make answer.txt hold 42 so that sh check.sh passes.', result.reprompts[0].text]);
    expect(result.work_acceptance).toEqual([{ cmd: 'sh check.sh', code: 0 }]);
    expect(result.patch).toContain('-41');
    expect(result.patch).toContain('+42');
    expect(result.patch_applied).toBe(true);
    expect(result.pristine_acceptance).toEqual([{ cmd: 'sh check.sh', code: 0 }]);
  });

  it('never fixed: three re-prompts at most, each recorded (1 of 3, 2 of 3, 3 of 3), and the acceptance still failing in the result', () => {
    const w = workspace();
    const { result, messages } = runBridge(w, 0, ['sh check.sh']);
    expect(result.ok).toBe(true);
    expect(result.reprompts.map((r: { round: number }) => r.round)).toEqual([1, 2, 3]);
    expect(result.reprompts.map((r: { text: string }) => /re-prompt (\d) of 3/.exec(r.text)?.[1])).toEqual(['1', '2', '3']);
    expect(messages).toHaveLength(4);
    expect(result.work_acceptance).toEqual([{ cmd: 'sh check.sh', code: 1 }]);
    expect(result.patch).toBe('');
    expect(result.patch_applied).toBe(false);
  });

  it('a task with no acceptance commands is not re-prompted', () => {
    const w = workspace();
    const { result, messages } = runBridge(w, 0, []);
    expect(result.ok).toBe(true);
    expect(result.reprompts).toEqual([]);
    expect(messages).toEqual(['FIXTURE task: make answer.txt hold 42 so that sh check.sh passes.']);
  });
});
