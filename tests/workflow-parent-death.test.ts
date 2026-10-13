// Round R4 (H67): the pty wrapper when its parent ends. On the operator's Mac (r20, ledger row 162) a REPL's node process was
// killed with SIGKILL while a run's `second` block ran: workers/upmd/pty_run.py, upmd and the blocks went on, upmd started
// `third` 5 s after the kill, and Timmy's record, the card and /workflows all said "third – not run". The wrapper stopped
// upmd only once a write to its output failed, and nothing was written before `third` started.
//
// Here the wrapper runs under this machine's python3, as a job runs it (the leader of its own process group, its output
// piped), below a parent that is a real process (tests/fixtures/pty-parent-fixture.mjs, a labelled TEST FIXTURE) and is
// killed with SIGKILL while `second` runs. upmd is tests/fixtures/fake-upmd.mjs in its pty mode, a labelled TEST DOUBLE of
// upmd 0.2.7 (it is not upmd) whose blocks run for real, each in a session of its own; each block marks its own start
// with a file, so whether `third` ever started is read from the disk, not from anyone's account. Processes are read from
// the real process table (ps). No network, no paid call.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LineSplitter, type JobStep } from '../src/jobs/index.js';
import { PTY_RUN_SCRIPT, upmdLineParser } from '../src/workflows/upmd-live.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const PARENT = resolve('tests/fixtures/pty-parent-fixture.mjs');
const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!PYTHON3) console.warn('workflow-parent-death: no python3 here, so the wrapper runs are skipped');
const F = '```';
/** first; second needs first and runs 5 s, silent (as r20's blocks were: nothing is written until it ends); third needs
 *  second. Each block marks its start in the run's folder. */
const DOC = [
  '# Three', '',
  `${F}bash [name:first]`, 'touch first.started', 'echo "first done"', F, '',
  `${F}bash [name:second, deps:first]`, 'touch second.started', 'sleep 5', F, '',
  `${F}bash [name:third, deps:second]`, 'touch third.started', 'echo "third ran"', F, '',
].join('\n');

/** The probe document upmd-0.2.7-pty-third.bin was captured from (as tests/workflow-live.test.ts has it). */
const PROBE = [
  '# Probe', '',
  `${F}bash [name:first]`, 'echo "first says hello"', 'sleep 1', 'echo "first done"', F, '',
  `${F}bash [name:second, deps:first]`, 'echo "second starts"', 'sleep 1', 'echo "second fails" >&2', 'exit 3', F, '',
  `${F}bash [name:third, deps:second]`, 'echo "third never runs"', F, '',
].join('\n');

const dirs: string[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, get: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
interface Proc { pid: number; ppid: number; pgid: number; stat: string; args: string }
function table(): Proc[] {
  const out = String(spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'args='], { encoding: 'utf8' }).stdout ?? '');
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], args: m[5].trim() }));
}
/** Whether any process of the group runs (a zombie runs nothing). */
const groupRuns = (pgid: number): boolean => table().some((p) => p.pgid === pgid && !p.stat.startsWith('Z'));

afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  // What a failed test may leave of a run: its process groups are ended.
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The parent runs `python3 -I pty_run.py <options> -- fake-upmd.mjs --ci -b third -d <work> <work>/THREE.md`, with
 * `options(parent pid)` the wrapper's options; the scenario returns once `second` has started, with every process found.
 */
async function startUnderParent(options: (stopFile: string) => string[]) {
  const work = temp('h67-work-');
  const runs = temp('h67-run-');
  writeFileSync(join(work, 'THREE.md'), DOC);
  const stopFile = join(runs, 'stop.json');
  const log = join(runs, 'parent.log');
  const config = join(runs, 'parent.json');
  writeFileSync(config, JSON.stringify({
    command: PYTHON3, log,
    args: ['-I', PTY_RUN_SCRIPT, ...options(stopFile), '--', FAKE_UPMD, '--ci', '-b', 'third', '-d', work, join(work, 'THREE.md')],
  }));
  const parent = spawn(process.execPath, [PARENT, config], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(parent);
  let said = '';
  const ready = await new Promise<{ pid: number; parent: number }>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`the parent did not get ready: ${said}`)), 20_000);
    parent.stdout!.on('data', (b: Buffer) => {
      said += b.toString('utf8');
      const m = /^READY (.*)$/m.exec(said);
      if (m) { clearTimeout(timer); ok(JSON.parse(m[1])); } else if (/^FAILED /m.test(said)) { clearTimeout(timer); fail(new Error(said)); }
    });
    parent.once('exit', (code, signal) => { clearTimeout(timer); fail(new Error(`the parent ended (${code ?? signal}) before it was ready: ${said}`)); });
  });
  const wrapper = ready.pid;
  groups.push(wrapper);
  await until('second to start', () => existsSync(join(work, 'second.started')));
  const upmd = await until('upmd under the wrapper', () => table().find((p) => p.ppid === wrapper));
  const block = await until("second's shell under upmd", () => table().find((p) => p.ppid === upmd.pid && p.args.includes('second.started')));
  groups.push(upmd.pgid, block.pgid);
  return { parent, parentPid: ready.parent, wrapper, upmd: upmd.pgid, block: block.pgid, work, stopFile, log };
}

describe.skipIf(!PYTHON3)('the pty wrapper when its parent ends (SIGKILL to the parent while a block runs)', () => {
  it('stops upmd and the block at once: the next block never starts, every process group is gone within 3 s, and its stop file names the running block and the block it saw end', async () => {
    const s = await startUnderParent((stopFile) => ['--stop-file', stopFile]);
    expect(new Set([s.wrapper, s.upmd, s.block]).size).toBe(3);
    const killed = Date.now();
    s.parent.kill('SIGKILL');
    // Every group of the run ends within the bound: the wrapper's, upmd's and the block's.
    await until('every process group of the run to end', () => ![s.wrapper, s.upmd, s.block].some(groupRuns), 3000);
    const took = Date.now() - killed;
    // `second` would have run up to 5 s more and `third` started right after it (r20: 5 s after the kill): wait that and more.
    await sleep(Math.max(0, 6000 - took));
    expect(existsSync(join(s.work, 'first.started'))).toBe(true);
    expect(existsSync(join(s.work, 'third.started')), 'third started after the parent was killed').toBe(false);
    for (const g of [s.wrapper, s.upmd, s.block]) expect(groupRuns(g), `process group ${g}`).toBe(false);
    // The stop file: written by the wrapper before it exited, mode 0600, naming the running block and the one it saw end.
    expect(statSync(s.stopFile).mode & 0o777).toBe(0o600);
    const stop = JSON.parse(readFileSync(s.stopFile, 'utf8'));
    expect(stop).toMatchObject({
      schema: 'timmy.pty-stop/1', wrapper_pid: s.wrapper, command: 'fake-upmd.mjs', why: `its parent (process ${s.parentPid}) ended`,
      parent: { pid: s.parentPid, ended: true }, stopped: true, signals: ['SIGTERM'], left: [],
    });
    expect(stop.groups).toEqual(expect.arrayContaining([s.upmd, s.block]));
    expect(stop.blocks.map((b: { n: number; name?: string; state: string; code?: number }) => [b.n, b.name ?? null, b.state, b.code ?? null]))
      .toEqual([[1, 'first', 'completed', 0], [2, null, 'stopped', null]]);
    expect(stop.blocks[0].count).toBe(3);
    expect(Date.parse(stop.blocks[1].started_at)).toBeLessThanOrEqual(Date.parse(stop.at));
    expect(stop.said).toBe(`its parent (process ${s.parentPid}) ended: stopping fake-upmd.mjs (process group ${s.upmd}) and the 1 process group it started (${s.block}) with SIGTERM`);
    // No path of the machine in it: only the command's name.
    expect(JSON.stringify(stop)).not.toContain(s.work);
    // What the parent read before it was killed: the wrapper's first line and upmd's start of second.
    expect(readFileSync(s.log, 'utf8')).toMatch(/pty_run: fake-upmd\.mjs runs as process \d+, the leader of its own session, on a terminal of its own/);
  }, 40_000);

  it("its own reading of upmd 0.2.7's real terminal bytes (through a real pty) names the blocks as Timmy's reader does", () => {
    // tests/fixtures/upmd-0.2.7-pty-third.bin is REAL upmd 0.2.7 output captured on the operator's Mac (see workflow-live.test.ts);
    // cat writes it to the wrapper's terminal, and the wrapper reads it as it would read upmd.
    const runs = temp('h67-bytes-');
    const stopFile = join(runs, 'stop.json');
    const bytes = resolve('tests/fixtures/upmd-0.2.7-pty-third.bin');
    const done = spawnSync(PYTHON3!, ['-I', PTY_RUN_SCRIPT, '--stop-file', stopFile, '--', 'cat', bytes], { encoding: 'utf8', timeout: 20_000 });
    expect(done.status).toBe(0);
    const stop = JSON.parse(readFileSync(stopFile, 'utf8'));
    expect(stop).toMatchObject({ schema: 'timmy.pty-stop/1', command: 'cat', why: 'cat ended by itself', parent: { ended: false }, stopped: false, exit: 0 });
    expect(stop.signals).toBeUndefined();
    const wrapper = stop.blocks.map((b: { n: number; count: number; name?: string; state: string; code?: number }) => [b.n, b.count, b.name, b.state, b.code]);
    expect(wrapper).toEqual([[1, 3, 'first', 'completed', 0], [2, 3, 'second', 'failed', 3]]);
    // Timmy's reader of the same bytes (src/workflows/upmd-live.ts, as a job splits them) ends at the same states.
    const steps: JobStep[] = [];
    const parse = upmdLineParser(parseWorkflow(PROBE), 'pty');
    const split = new LineSplitter();
    for (const line of [...split.push(readFileSync(bytes).toString('utf8')), ...split.end()]) parse(line, steps);
    expect(steps.map((s) => [s.index, s.name, s.state, s.code])).toEqual(wrapper.map((w: unknown[]) => [w[0], w[2], w[3], w[4]]));
  }, 30_000);

  it('a --parent that is not its parent (already ended): the command is not started, and its stop file says so', () => {
    const runs = temp('h67-gone-');
    const work = temp('h67-gone-work-');
    const stopFile = join(runs, 'stop.json');
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const done = spawnSync(PYTHON3!, ['-I', PTY_RUN_SCRIPT, '--parent', String(gone), '--stop-file', stopFile, '--', 'sh', '-c', `touch ${join(work, 'ran')}`], { encoding: 'utf8', timeout: 20_000 });
    expect(done.status).toBe(1);
    expect(done.stderr).toBe(`pty_run: its parent (process ${gone}) had ended before sh started: it was not started\n`);
    expect(existsSync(join(work, 'ran'))).toBe(false);
    expect(JSON.parse(readFileSync(stopFile, 'utf8'))).toMatchObject({ why: `its parent (process ${gone}) had ended before sh started`, command_pid: null, stopped: false, exit: null, blocks: [], parent: { pid: gone, ended: true } });
    // Its usage, with an option it does not know or one given twice: exit 64, nothing started.
    for (const args of [['--stop', stopFile], ['--parent', '7', '--parent', '8'], ['--parent', 'x'], ['--stop-file']]) {
      const bad = spawnSync(PYTHON3!, ['-I', PTY_RUN_SCRIPT, ...args, '--', 'sh', '-c', `touch ${join(work, 'ran')}`], { encoding: 'utf8', timeout: 20_000 });
      expect(bad.status, args.join(' ')).toBe(64);
    }
    expect(existsSync(join(work, 'ran'))).toBe(false);
  }, 30_000);
});
