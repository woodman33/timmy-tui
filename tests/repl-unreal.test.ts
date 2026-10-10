/**
 * Round R4 (H63): /unreal in the REPL and through `timmy act`, end to end: the first pass as a judged native job, its
 * readback started at once in a second process when it is judged ok, the readback's record (readbacks.jsonl) and its
 * receipt on the project's own chain, /unreal readback, /stop on a readback, and an operation whose outcome is the
 * readback's verdict (exit 0 when it agrees, 1 when it differs).
 *
 * FAKE pieces, each labelled: tests/fixtures/fake-unreal.mjs is a TEST DOUBLE of UnrealEditor-Cmd (it checks Timmy's
 * command line and runs the -script file with python3), and tests/fixtures/unreal-stub a stand-in for Unreal's `unreal`
 * module (JSON level files; UNREAL_STUB_LOAD_SHIFT_CM is a FAKE fault: a level that loads otherwise than reported). The
 * harness, the readback worker, the starter, the REPL's Workspace, the job manager, `timmy act` (the CLI through tsx) and
 * the receipt chain are the real ones. No Unreal Engine runs here.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { readOperationRecord } from '../src/ops/operations.js';
import { readUnrealReadbacks } from '../src/native/unreal-readback.js';
import { glyphSet } from '../src/term/glyphs.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';
import { act, FIXTURES, opsKit, replOf, REPO, sandbox, until, type Sandbox } from './helpers/ops-sandbox.js';

const STUB = path.join(FIXTURES, 'unreal-stub');
const STARTER = path.join(REPO, 'templates', 'unreal-starter');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

/** A sandbox (tests/helpers/ops-sandbox.ts) with the Unreal starter in its project (in `sub`, when given) and the FAKE UnrealEditor-Cmd. */
function unrealSandbox(prefix: string, sub = ''): Sandbox & { fake: string } {
  const s = sandbox(kit, prefix);
  const into = path.join(s.root, sub);
  fs.mkdirSync(into, { recursive: true });
  for (const f of fs.readdirSync(STARTER)) fs.copyFileSync(path.join(STARTER, f), path.join(into, f));
  const fake = path.join(s.bin, 'UnrealEditor-Cmd');
  fs.copyFileSync(path.join(FIXTURES, 'fake-unreal.mjs'), fake);
  fs.chmodSync(fake, 0o755);
  Object.assign(s.env, { TIMMY_UNREAL: fake, PYTHONPATH: STUB, FAKE_UNREAL_PYTHON: python, PYTHONDONTWRITEBYTECODE: '1' });
  return { ...s, fake };
}

/** The REPL of a sandbox: this process's environment is the sandbox's (its jobs inherit it), with the FAKE's knobs. */
function repl(s: Sandbox, knobs: Record<string, string> = {}) {
  for (const k of ['TIMMY_UNREAL', 'PYTHONPATH', 'FAKE_UNREAL_PYTHON', 'PYTHONDONTWRITEBYTECODE'] as const) vi.stubEnv(k, s.env[k] ?? '');
  for (const [k, v] of Object.entries(knobs)) vi.stubEnv(k, v);
  const { ws, notes } = replOf(kit, s);
  const printed: string[] = [];
  const ctx = { print: (seg: { text: string }[]) => printed.push(seg.map((x) => x.text).join('')), glyphs: glyphSet(true), workspace: ws } as unknown as ReplContext;
  const slash = async (line: string): Promise<string> => { printed.length = 0; await runSlash(line, ctx); return printed.join('\n'); };
  return { ws, notes, slash, said: () => notes.join('\n') };
}

describe.skipIf(!python)('/unreal in the REPL: a judged first pass, then its readback in a second Unreal process', () => {
  it('runs the starter, starts the readback at once, records and seals it: agrees, 9 of 9 actors', async () => {
    const s = unrealSandbox('unreal-repl-');
    const { slash, said } = repl(s);
    const started = await slash('/unreal TimmyStarter.uproject scene.py');
    expect(started).toMatch(/App {8}UnrealEditor-Cmd, headless · it opens TimmyStarter\.uproject and runs Timmy's harness, which runs \.timmy\/native\/[0-9a-f-]{36}\/source\/scene\.py, a read-only copy of scene\.py/);
    expect(started).toMatch(/the first run of a new project makes Unreal build its caches \(slow: minutes\)/);
    expect(started).toMatch(/Running {4}(j[0-9a-f]{6}) {2}Unreal runs scene\.py in TimmyStarter\.uproject · judged by its harness's result file, then read back by a second Unreal process/);
    await until(() => /readback (agrees|differs|failed)/.test(said()), 60_000, 'the readback to end');
    const out = said();
    const run = /native\/([0-9a-f-]{36})\/source/.exec(started)![1];
    // The first pass: judged ok, its file with Timmy's sha256, Unreal's own report, the script's own checks.
    expect(out).toMatch(/✓ j[0-9a-f]{6} ok {2}Unreal · scene\.py in TimmyStarter\.uproject: the result file is this run's/);
    expect(out).toMatch(/saved {4}Content\/Timmy\/TimmyGrid\.umap · created by this run · sha256 [0-9a-f]{12}… \(Timmy's, after the run\)/);
    expect(out).toMatch(/reported \/Game\/Timmy\/TimmyGrid: 9 actors \(9 StaticMeshActor\) · Unreal 5\.8\.2-0\+\+\+UE5\+Release-5\.8 \(stand-in\): Unreal's own report/);
    expect(out).toMatch(/TimmyCube_0_0 \(StaticMeshActor_0\): bounds 100 x 100 x 100 cm, centred at \(0, 0, 50\)/);
    expect(out).toMatch(/checks {3}the script's own: 9 of 9 passed/);
    const rb = /readback (j[0-9a-f]{6}) {2}a second Unreal process opens \/Game\/Timmy\/TimmyGrid \(Content\/Timmy\/TimmyGrid\.umap, sha256 [0-9a-f]{12}…\)/.exec(out);
    expect(rb, out).not.toBeNull();
    // The readback: agrees, with its record and receipt.
    expect(out).toMatch(new RegExp(`✓ ${rb![1]} readback agrees {2}/Game/Timmy/TimmyGrid: 9 of 9 actors agree · Unreal run ${run.slice(0, 8)} · receipt [0-9a-f]{8} · record \\.timmy/native/${run}/readbacks\\.jsonl`));
    expect(out).toMatch(/both are Unreal Engine: agreement shows the saved file holds what the first pass reported, not an independent engine's confirmation/);
    const lines = readUnrealReadbacks(path.join(s.root, '.timmy', 'native', run));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ app: 'unreal', run, job: rb![1], state: 'completed', verdict: 'agrees', log: `.timmy/native/${run}/readback-${rb![1]}.log` });
    expect(fs.existsSync(path.join(s.root, lines[0].log!))).toBe(true);
    // The chain: the first pass's native receipt, then the readback's, naming the first as its child and the file it read.
    const chain = readChain('runs', s.root);
    expect(chain.map((r) => [r.kind, r.status])).toEqual([['native', 'ok'], ['readback', 'ok']]);
    const [native, read] = chain;
    expect(native.native).toMatchObject({ app: 'unreal', outcome: 'ok', run, unreal_version: '5.8.2-0+++UE5+Release-5.8 (stand-in)' });
    expect(read.child_receipts).toEqual([native.hash.slice(7, 15)]);
    expect(read.sources?.[0]).toEqual({ path: 'Content/Timmy/TimmyGrid.umap', sha256: lines[0].levels[0].sha256.recorded, role: 'read' });
    expect(read.sources?.[1]).toMatchObject({ unreal_run: run, verdict: 'agrees', geometry: { provenance: 'generated', evidence: 'checked' } });
    expect(lines[0].receipt).toBe(read.hash.slice(7, 15));
    expect(verifyChain('runs', s.root).ok).toBe(true);
    expect(JSON.stringify(chain)).not.toContain(s.base);
    // /unreal lists the run with its readback; /unreal readback runs it again.
    expect(await slash('/unreal')).toMatch(new RegExp(`✓ ${run.slice(0, 8)} {2}ok · readback agrees`));
    const again = await slash(`/unreal readback ${run.slice(0, 8)}`);
    expect(again).toMatch(/readback j[0-9a-f]{6} {2}a second Unreal process opens \/Game\/Timmy\/TimmyGrid/);
    await until(() => readUnrealReadbacks(path.join(s.root, '.timmy', 'native', run)).length === 2, 60_000, 'the second readback');
    expect(readUnrealReadbacks(path.join(s.root, '.timmy', 'native', run)).map((l) => l.verdict)).toEqual(['agrees', 'agrees']);
  }, 90_000);

  it('/stop on a readback (FAKE: the readback hangs) ends it stopped: recorded and sealed with no verdict', async () => {
    const s = unrealSandbox('unreal-stop-');
    const { slash, said } = repl(s, { FAKE_UNREAL_READBACK: 'sleep' });
    await slash('/unreal TimmyStarter.uproject scene.py');
    await until(() => /readback j[0-9a-f]{6} {2}a second Unreal process/.test(said()), 60_000, 'the readback to start');
    const id = /readback (j[0-9a-f]{6}) {2}a second/.exec(said())![1];
    expect(await slash(`/stop ${id}`)).toMatch(new RegExp(`${id} cancelled`));
    await until(() => new RegExp(`${id} readback stopped`).test(said()), 20_000, 'the stopped readback to be recorded');
    const run = /native\/([0-9a-f-]{36})\//.exec(said())![1];
    const [line] = readUnrealReadbacks(path.join(s.root, '.timmy', 'native', run));
    expect(line).toMatchObject({ job: id, state: 'cancelled', reason: 'stopped before it finished: no verdict' });
    expect(line.verdict).toBeUndefined();
    expect(readChain('runs', s.root).map((r) => [r.kind, r.status])).toEqual([['native', 'ok'], ['readback', 'cancelled']]);
  }, 90_000);

  it('a project file in a folder with a space, quoted, reaches Unreal whole (/unreal is raw)', async () => {
    const s = unrealSandbox('unreal-space-', 'my game');
    fs.renameSync(path.join(s.root, 'my game', 'scene.py'), path.join(s.root, 'scene.py'));
    fs.renameSync(path.join(s.root, 'my game', 'scene.params.json'), path.join(s.root, 'scene.params.json'));
    const { slash, said } = repl(s);
    expect(await slash('/unreal "my game/TimmyStarter.uproject"   scene.py')).toMatch(/Unreal runs scene\.py in my game\/TimmyStarter\.uproject/);
    await until(() => /readback (agrees|differs|failed)/.test(said()), 60_000, 'the readback to end');
    expect(said()).toMatch(/saved {4}my game\/Content\/Timmy\/TimmyGrid\.umap · created by this run/);
    expect(said()).toMatch(/readback agrees/);
  }, 90_000);
});

describe('/unreal says what is missing, and starts nothing', () => {
  it('a missing program, and words in the wrong order', async () => {
    const s = unrealSandbox('unreal-none-');
    s.env.TIMMY_UNREAL = '';
    fs.rmSync(s.fake); // not on the sandbox's PATH either
    const { slash } = repl(s);
    expect(await slash('/unreal scene.py')).toMatch(/Name the project file \(\.uproject\) first, then the script/);
    const out = await slash('/unreal TimmyStarter.uproject scene.py');
    expect(out).toMatch(/Unreal Engine \(UnrealEditor-Cmd, Python, headless\) was not found on this machine/);
    expect(out).toMatch(/Setup: install Unreal Engine 5 \(Epic Games Launcher\), or set TIMMY_UNREAL/);
    expect(fs.existsSync(path.join(s.root, '.timmy', 'native'))).toBe(false);
    expect(await slash('/unreal')).toMatch(/Runs {7}none yet in this project/);
  });
});

describe.skipIf(!python)('timmy act \'/unreal …\' --wait: one operation, whose outcome is the readback\'s verdict', () => {
  const lastJson = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;

  it('agrees: exit 0, succeeded; the first pass, its run and its readback are the operation\'s runs; native and readback receipts', async () => {
    const s = unrealSandbox('unreal-act-');
    const r = await act(kit, s, ['/unreal TimmyStarter.uproject scene.py', '--wait', '--json']).done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const o = lastJson(r.stdout);
    expect(o).toMatchObject({ outcome: 'succeeded', exit_code: 0, request: '/unreal TimmyStarter.uproject scene.py' });
    const runs = o.runs as Array<{ kind: string; id: string }>;
    expect(runs.map((x) => x.kind).sort()).toEqual(['job', 'job', 'native']);
    const run = runs.find((x) => x.kind === 'native')!.id;
    expect(o.records).toEqual([`.timmy/operations/${String(o.operation)}.json`, `.timmy/native/${run}/job.json`]);
    expect((o.receipts as Array<{ kind: string; status: string }>).map((x) => [x.kind, x.status])).toEqual([['native', 'ok'], ['readback', 'ok']]);
    expect(String(o.why)).toMatch(/readback agrees/);
    const rec = readOperationRecord(s.root, String(o.operation));
    expect(rec.ok && rec.record).toMatchObject({ via: 'act', state: 'succeeded' });
    expect(r.stderr).toMatch(/readback agrees/);
    expect(r.stdout + r.stderr).not.toContain(s.home);
  }, 120_000);

  it('differs (FAKE: the level loads otherwise than reported): exit 1, differs, and the numbers say how', async () => {
    const s = unrealSandbox('unreal-act-differs-');
    const r = await act(kit, s, ['/unreal TimmyStarter.uproject scene.py', '--wait', '--json'], { env: { ...s.env, UNREAL_STUB_LOAD_SHIFT_CM: '5' } }).done;
    expect(r.code, r.stdout + r.stderr).toBe(1);
    const o = lastJson(r.stdout);
    expect(o).toMatchObject({ outcome: 'differs', exit_code: 1 });
    expect(String(o.why)).toMatch(/readback differs: \/Game\/Timmy\/TimmyGrid: TimmyCube_0_0 \(StaticMeshActor_0\) location \(cm\) x: first pass 0, readback 5 \(difference 5; tolerance 0\.001 cm\)/);
    expect((o.receipts as Array<{ kind: string; status: string }>).map((x) => [x.kind, x.status])).toEqual([['native', 'ok'], ['readback', 'failed']]);
  }, 120_000);
});
