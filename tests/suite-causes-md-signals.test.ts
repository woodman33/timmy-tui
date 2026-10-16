/**
 * Round R4 (helper H114): the cause of the full suite's failure of tests/act-md-signals.test.ts › "timmy md, inside the stop
 * (a block that ignores SIGTERM)" at c56303c (the lead's suite, 2026-10-12, a loaded machine; the file passed alone twice
 * afterwards). It expected the end of a second SIGINT inside the stop (exit 3 at once, receipts null) and got the normal
 * stop: why "SIGINT received; job j… stopped", four receipts sealed (predict ok, workflow-block ok, workflow-block cancelled,
 * workflow cancelled).
 *
 * What runs, in order (measured on this machine, quiet): the test sends SIGINT to the run's process group; timmy md handles
 * it about 15 ms later (its `stopping: SIGINT received` line) and stops the run's job: SIGTERM to the pty wrapper's group;
 * the wrapper sends SIGTERM to upmd's group and the block's; the block ignores it (`trap '' TERM`), so 0.8 s later the
 * wrapper sends SIGKILL; md seals and prints its end about 1 s after the first SIGINT. The test sent its second SIGINT 80 ms
 * after the first, on its own timer. That is inside the stop only when md has run its handler for the first SIGINT before
 * the second arrives, and the second arrives before the stop's end. Neither is guaranteed:
 *  - md not scheduled between the two (a loaded machine): two SIGINTs that reach a process before it has run are one (a
 *    signal of a kind is pending once), so md sees one SIGINT and stops normally: the failure's own outcome;
 *  - the test's 80 ms timer firing after the stop's ~1 s: the second SIGINT finds md ended or ending: the same outcome.
 * Not the trap (the lead's first hypothesis): the block's `trap '' TERM` runs before `touch long.started`, which the test
 * waits for, and the wrapper's stop file says SIGTERM then SIGKILL every time (the block outlived the SIGTERM).
 *
 * The product is right in both: one SIGINT stops a run normally, and a SIGINT after the end changes nothing. The test assumed
 * an order nothing guarantees; it now sends its second SIGINT while the FAKE slow stop (tests/fixtures/slow-stop.cjs) holds
 * md at its stop's first signal: the held file says the first SIGINT was handled, and the stop cannot end before the test
 * releases it.
 *
 * Each case makes one condition happen on purpose: md held with SIGSTOP (as a process the machine does not schedule) while
 * the signals are sent, and a second SIGINT sent 1.5 s late. FAKE pieces, each labelled: upmd (tests/fixtures/fake-upmd.mjs;
 * its blocks run through sh) and the slow stop. Everything else is real: Timmy's bin, the CLI, the job manager, the pty
 * wrapper (python3), the signals, the records and the receipts.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_UPMD, opsKit, REPO, sandbox, sleep, until, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
const groups: number[] = [];
const held: number[] = [];
afterEach(async () => {
  for (const p of held.splice(0)) { try { process.kill(p, 'SIGCONT'); } catch { /* ended */ } }
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* ended */ } }
  await kit.cleanup();
}, 60_000);

const LOADER = createRequire(import.meta.url).resolve('tsx');
const BIN = path.join(REPO, 'timmy.ts');
const STOP_HOLD = path.join(REPO, 'tests', 'fixtures', 'slow-stop.cjs');
const F = '```';
// the held shape of tests/act-md-signals.test.ts: a block that ignores SIGTERM, so its stop takes the wrapper's 0.8 s grace
const SLOW = ['# Slow to stop', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, "trap '' TERM", 'touch long.started', 'sleep 30', F, ''].join('\n');

interface Run { child: ChildProcess; stdout: () => string; done: Promise<{ code: number | null; stdout: string; stderr: string }> }
/** `timmy md LONG.md long --json` through Timmy's own bin, in its own process group (as tests/act-md-signals.test.ts runs it). */
function md(s: Sandbox, env: NodeJS.ProcessEnv = {}): Run {
  const child = spawn(process.execPath, ['--import', LOADER, BIN, 'md', 'LONG.md', 'long', '--json'], { cwd: s.root, env: { ...s.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  kit.children.push(child);
  if (child.pid) groups.push(child.pid);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  return { child, stdout: () => stdout, done: new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr }))) };
}
const group = (r: Run, sig: NodeJS.Signals): void => { try { process.kill(-r.child.pid!, sig); } catch { /* it has ended */ } };
const lastJson = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
const box = (prefix: string): Sandbox => {
  const s = sandbox(kit, prefix);
  fs.writeFileSync(path.join(s.root, 'LONG.md'), SLOW);
  s.env.UPMD_BIN = FAKE_UPMD;
  return s;
};
const jobsDir = (s: Sandbox): string => path.join(s.home, 'timmy', 'jobs');
/** The run's job record (the one job of the sandbox). */
const jobRecord = (s: Sandbox): Record<string, unknown> => {
  const f = fs.readdirSync(jobsDir(s)).find((x) => /^j[0-9a-f]{6}\.json$/.test(x))!;
  return JSON.parse(fs.readFileSync(path.join(jobsDir(s), f), 'utf8')) as Record<string, unknown>;
};
/** timmy md's own process: the owner its job manager records on the run's job (not the bin, its parent). */
const mdPid = (s: Sandbox): number => (jobRecord(s).owner as { pid: number }).pid;
/**
 * What the pty wrapper wrote when it ended (its --stop-file), once it has: the signals its stop sent. R5 lead (CI at 631392f,
 * once): the held case's stop said only SIGTERM, so the block's group was gone within the wrapper's grace although the
 * block ignores SIGTERM. Each assertion on it now carries the whole record (its `said` names the groups it signalled and
 * whether the process table could be read), so a recurrence says its own cause.
 */
async function wrapperStop(s: Sandbox): Promise<{ why: string; signals?: string[] }> {
  const args = jobRecord(s).args as string[];
  const file = args[args.indexOf('--stop-file') + 1];
  await until(() => fs.existsSync(file), 30_000, 'the pty wrapper\'s stop file');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { why: string; signals?: string[] };
}
/** ps's state of a process ('' once it is gone). */
const stateOf = (pid: number): string => { try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; } };
/**
 * Holds a process from running, as a machine that does not schedule it would: SIGSTOP, and back once ps says it is stopped
 * (T). kill() returns before the stop takes effect: a SIGINT sent in that moment is taken before SIGSTOP (the lower number
 * first), so the signals are sent only once it has stopped; each then waits, pending, until SIGCONT.
 */
async function stopProcess(pid: number): Promise<void> {
  process.kill(pid, 'SIGSTOP');
  held.push(pid);
  await until(() => stateOf(pid).startsWith('T'), 10_000, `process ${pid} to be stopped`);
}
const receipts = (j: Record<string, unknown>): string[] | null =>
  (j.receipts as Array<{ kind: string; status?: string }> | null)?.map((r) => `${r.kind}${r.status ? ` ${r.status}` : ''}`) ?? null;
/** The failure's own outcome at c56303c: the normal stop of one SIGINT. */
const NORMAL_STOP = ['predict ok', 'workflow-block ok', 'workflow-block cancelled', 'workflow cancelled'];

describe('R4 (H114): why "a second SIGINT 80 ms after the first" was not inside the stop at c56303c', () => {
  it('md not scheduled while both SIGINTs arrive (held with SIGSTOP, the SIGINTs 80 ms apart, then SIGCONT): it sees one SIGINT and stops normally: the failure\'s own outcome', async () => {
    const s = box('h114-coalesce-');
    const r = md(s);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    const pid = mdPid(s);
    await stopProcess(pid);
    group(r, 'SIGINT');
    await sleep(80);
    group(r, 'SIGINT');
    await sleep(50);
    process.kill(pid, 'SIGCONT');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    const j = lastJson(d.stdout);
    expect(j.why).toMatch(/^SIGINT received; job j[0-9a-f]{6} stopped$/);
    expect(j.at_once).toBeUndefined();
    expect(receipts(j)).toEqual(NORMAL_STOP);
    // one stop, by one SIGINT
    expect(d.stderr.match(/stopping: SIGINT received/g)).toHaveLength(1);
    // the block ignored SIGTERM: the wrapper needed SIGKILL (the trap was in place before the test signalled)
    { const stop = await wrapperStop(s); expect(stop.signals, `the pty wrapper's stop record: ${JSON.stringify(stop)}`).toEqual(['SIGTERM', 'SIGKILL']); }
  }, 120_000);

  it('the second SIGINT once md has printed its end (a test timer that fires after the stop): the stop and md\'s end are over: the same outcome', async () => {
    const s = box('h114-late-');
    const r = md(s);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    group(r, 'SIGINT');
    // R4 lead (full suite 37): this sent its second SIGINT 1.5 s after the first, taking the stop and md's end (about 1 s on a
    // quiet machine) to be over by then. On a loaded one they were not: the second SIGINT came inside the stop and md exited
    // at once ("a second SIGINT: timmy md exited at once"), as it should then, and the test failed. It now sends its second
    // SIGINT once md has printed its end, which is what "a timer that fires after the stop" means, whatever the load.
    await until(() => { try { lastJson(r.stdout()); return true; } catch { return false; } }, 60_000, 'md\'s printed end');
    group(r, 'SIGINT');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    const j = lastJson(d.stdout);
    expect(j.why).toMatch(/^SIGINT received; job j[0-9a-f]{6} stopped$/);
    expect(receipts(j)).toEqual(NORMAL_STOP);
    { const stop = await wrapperStop(s); expect(stop.signals, `the pty wrapper's stop record: ${JSON.stringify(stop)}`).toEqual(['SIGTERM', 'SIGKILL']); }
  }, 120_000);

  it('the fixed test\'s way (FAKE: the stop held at its first signal): with md not scheduled when the first SIGINT comes, and the second sent 1.5 s late, the second lands inside the stop', async () => {
    const s = box('h114-held-');
    const arm = path.join(s.base, 'stop.arm');
    const heldFile = path.join(s.base, 'stop.held');
    const release = path.join(s.base, 'stop.release');
    fs.writeFileSync(arm, '');
    const r = md(s, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${STOP_HOLD}`.trim(), TIMMY_TEST_STOP_ARM: arm, TIMMY_TEST_STOP_HELD: heldFile, TIMMY_TEST_STOP_RELEASE: release });
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    const pid = mdPid(s);
    // the first condition: md is not running when its first SIGINT comes
    await stopProcess(pid);
    group(r, 'SIGINT');
    await sleep(200);
    process.kill(pid, 'SIGCONT');
    await until(() => fs.existsSync(heldFile), 60_000, 'the first SIGINT\'s stop, held at its first signal');
    expect(fs.readFileSync(heldFile, 'utf8')).toBe(String(pid));
    // the second condition: the second SIGINT comes 1.5 s late (longer than the whole stop takes unheld)
    await sleep(1500);
    group(r, 'SIGINT');
    fs.writeFileSync(release, '');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    const j = lastJson(d.stdout);
    expect(j).toMatchObject({ outcome: 'stopped', exit_code: 3, receipts: null, why: expect.stringMatching(/^SIGINT received; a second SIGINT: timmy md exited at once, before what it started had ended; ended now: job j[0-9a-f]{6}: cancelled; /) });
    expect((j.at_once as { settled: string[] }).settled).toEqual([`operation ${String(j.operation)}: stopped`, `job ${(j.job as { id: string }).id}: cancelled`]);
    // the stop md left went on without it: the wrapper still needed SIGKILL for the block
    { const stop = await wrapperStop(s); expect(stop.signals, `the pty wrapper's stop record: ${JSON.stringify(stop)}`).toEqual(['SIGTERM', 'SIGKILL']); }
  }, 120_000);
});
