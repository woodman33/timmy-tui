/**
 * Round R4 (helper H82; the review of 6fb765a..4338fdb, finding 3): the exit codes of `timmy act` and `timmy md` after a
 * signal, and of boot.cjs after a CLI killed by one. On the Mac (r22) `timmy act … --wait --json` stopped by SIGINT printed
 * exit_code 3 in its JSON while the wrapper that ran it reported exit 0. act and md removed their SIGINT and SIGTERM
 * handlers before the end's JSON was printed and the process exited, so a second signal in that window killed the process
 * by default (a signal's death, not 3); and boot.cjs read a CLI killed by a signal as exit 0 (`r.status ?? 0`).
 *
 * Each runs as the installed command runs: Timmy's own bin (timmy.ts, here through tsx's --import loader, as its dev path
 * does), which starts the CLI as a child, passes its status on, and gives 128 plus the signal for a signal's death; each
 * signal goes to the whole process group, as a terminal's Ctrl+C does (the bin ignores SIGINT; the CLI handles it).
 *
 * FAKE pieces, each labelled: the code agent (tests/fixtures/fake-code-agent.mjs, no model), upmd
 * (tests/fixtures/fake-upmd.mjs; its blocks run through sh), and a slow disk for one read
 * (tests/fixtures/slow-end-read.cjs: it holds act's or md's end, at its read of the receipts store, so a second signal can
 * be sent into the end). Everything else is real: the bin, the CLI, the Workspace, the job manager, the records and signals.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_UPMD, opsKit, replOf, REPO, sandbox, text, until, type Sandbox } from './helpers/ops-sandbox.js';
import { readChain } from '../src/utils/receipts.js';

const kit = opsKit();
/** Each run's process group, ended with SIGKILL after its test (the kit kills only the bin itself). */
const groups: number[] = [];
afterEach(async () => {
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* ended */ } }
  await kit.cleanup();
}, 60_000);

const LOADER = createRequire(import.meta.url).resolve('tsx');
const BIN = path.join(REPO, 'timmy.ts');
const HOLD = path.join(REPO, 'tests', 'fixtures', 'slow-end-read.cjs');
const F = '```';
const LONG = ['# Long', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, 'touch long.started', 'sleep 30', F, ''].join('\n');

interface Run { child: ChildProcess; out: () => string; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> }

/** `timmy <args>` through Timmy's own bin, in its own process group (signals go to the group, as a terminal's do). */
function timmy(s: Sandbox, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const child = spawn(process.execPath, ['--import', LOADER, BIN, ...args], { cwd: s.root, env: { ...s.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  kit.children.push(child);
  if (child.pid) groups.push(child.pid);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, out: () => `${stdout}${stderr}`, done };
}
/** A signal to the run's process group (its bin and the CLI), as Ctrl+C sends one. */
const group = (r: Run, sig: NodeJS.Signals): void => { try { process.kill(-r.child.pid!, sig); } catch { /* it has ended */ } };
const lastJson = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;

/** The slow disk's seam for one run: armed from the start (it acts only at the end's read), and the file it writes when it holds. */
function hold(s: Sandbox): { env: NodeJS.ProcessEnv; held: string } {
  const arm = path.join(s.base, 'hold.arm');
  const held = path.join(s.base, 'hold.held');
  fs.writeFileSync(arm, '');
  return { held, env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${HOLD}`.trim(), TIMMY_TEST_HOLD_ARM: arm, TIMMY_TEST_HOLD_HELD: held, TIMMY_TEST_HOLD_MS: '3000' } };
}

describe('timmy act: stopped by SIGINT, it exits 3 and says so; a second SIGINT during its end exits 3, never a signal\'s death or 0', () => {
  it('one SIGINT: exit 3, and its JSON says exit_code 3 (outcome stopped)', async () => {
    const s = sandbox(kit, 'h82-act-int-');
    const r = timmy(s, ['act', '/agent qwen FAKE: SLEEP until stopped', '--wait', '--json']);
    await until(() => /\bj[0-9a-f]{6}\b/.test(r.out()), 60_000, 'the agent\'s job');
    await new Promise((z) => { setTimeout(z, 500); });
    group(r, 'SIGINT');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    expect(lastJson(d.stdout)).toMatchObject({ outcome: 'stopped', exit_code: 3, why: expect.stringMatching(/^SIGINT received/) });
  }, 120_000);

  it('a second SIGINT while its end reads the receipts (FAKE: a slow disk holds that read 3 s): exit 3, its JSON printed with exit_code 3', async () => {
    const s = sandbox(kit, 'h82-act-int2-');
    const h = hold(s);
    const r = timmy(s, ['act', '/agent qwen FAKE: SLEEP until stopped', '--wait', '--json'], h.env);
    await until(() => /\bj[0-9a-f]{6}\b/.test(r.out()), 60_000, 'the agent\'s job');
    await new Promise((z) => { setTimeout(z, 500); });
    group(r, 'SIGINT');
    await until(() => fs.existsSync(h.held), 60_000, 'act\'s end to read the receipts');
    group(r, 'SIGINT');
    const d = await r.done;
    // b8fcd54: the handlers were gone by then, so the CLI died of SIGINT and the bin exited 130 (a wrapper reading none, 0)
    expect(d.code, d.stdout + d.stderr).toBe(3);
    expect(lastJson(d.stdout)).toMatchObject({ outcome: 'stopped', exit_code: 3 });
  }, 120_000);
});

describe('timmy md: the same', () => {
  const box = (prefix: string): Sandbox => {
    const s = sandbox(kit, prefix);
    fs.writeFileSync(path.join(s.root, 'LONG.md'), LONG);
    s.env.UPMD_BIN = FAKE_UPMD;
    return s;
  };

  it('one SIGINT while a block runs: exit 3, and its JSON says exit_code 3', async () => {
    const s = box('h82-md-int-');
    const r = timmy(s, ['md', 'LONG.md', 'long', '--json']);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    group(r, 'SIGINT');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    expect(lastJson(d.stdout)).toMatchObject({ outcome: 'stopped', exit_code: 3 });
  }, 120_000);

  it('a second SIGINT while its end reads the receipts (FAKE: a slow disk holds that read 3 s): exit 3, its JSON printed with exit_code 3', async () => {
    const s = box('h82-md-int2-');
    const h = hold(s);
    const r = timmy(s, ['md', 'LONG.md', 'long', '--json'], h.env);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    group(r, 'SIGINT');
    await until(() => fs.existsSync(h.held), 60_000, 'md\'s end to read the receipts');
    group(r, 'SIGINT');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    expect(lastJson(d.stdout)).toMatchObject({ outcome: 'stopped', exit_code: 3 });
  }, 120_000);
});

/**
 * R4 (H88; the Mac run r23, scripted): a Ctrl-C and a second one about 80 ms later, while the first one's stop still runs.
 * `timmy md LONG.md long --json` and `timmy act '/run LONG.md long' --wait --json` exited 3 at once with no JSON on stdout
 * (0 bytes), and md left its job (endedAt null, no receipt) and its operation ("running", its owner gone) for /recover. The
 * second signal still exits at once with 3, nothing awaited; before it does, it settles the operation's end and the run's job
 * record (words naming the second signal) and prints the end JSON, saying what it could not seal and what /recover does.
 *
 * Two shapes: r23's own (a plain `sleep 30` block: here its stop may end within the 80 ms, so the second signal may land in
 * the stop or just after it, and either way the JSON is printed and no record is left running), and a block that ignores
 * SIGTERM (`trap '' TERM`, a real block slow to stop: its stop then takes the pty wrapper's grace, 0.8 s, so the second signal
 * lands inside the stop every time, and what was settled at once is checked).
 */
describe('R4 (H88; r23): a second SIGINT 80 ms after the first, during the stop: exit 3 at once, the end JSON printed, the records settled', () => {
  const SLOW = ['# Slow to stop', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, "trap '' TERM", 'touch long.started', 'sleep 30', F, ''].join('\n');
  const box = (prefix: string, doc = LONG): Sandbox => {
    const s = sandbox(kit, prefix);
    fs.writeFileSync(path.join(s.root, 'LONG.md'), doc);
    s.env.UPMD_BIN = FAKE_UPMD;
    return s;
  };
  const twice = async (r: Run): Promise<void> => {
    group(r, 'SIGINT');
    await new Promise((z) => { setTimeout(z, 80); });
    group(r, 'SIGINT');
  };
  const record = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const jobRecord = (s: Sandbox, id: string): Record<string, unknown> => record(path.join(s.home, 'timmy', 'jobs', `${id}.json`));
  const opRecord = (s: Sandbox, id: string): Record<string, unknown> => record(path.join(s.root, '.timmy', 'operations', `${id}.json`));
  const blocksOf = (s: Sandbox, job: string): Array<{ block: Record<string, unknown> }> =>
    readChain('runs', s.root).filter((x) => x.kind === 'workflow-block' && (x as { block?: { run?: string } }).block?.run === job) as unknown as Array<{ block: Record<string, unknown> }>;

  it('r23\'s shape, timmy md (a plain sleep 30): exit 3, a JSON with exit_code 3, and no job or operation record says running', async () => {
    const s = box('h88-md-r23-');
    const r = timmy(s, ['md', 'LONG.md', 'long', '--json']);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    await twice(r);
    const d = await r.done;
    // before: exit 3 with 0 bytes on stdout (no JSON), the job and the operation left "running"
    expect(d.code, d.stdout + d.stderr).toBe(3);
    const j = lastJson(d.stdout);
    expect(j).toMatchObject({ schema: 'timmy.md/1', outcome: 'stopped', exit_code: 3 });
    const job = (j.job as { id: string }).id;
    expect(jobRecord(s, job)).toMatchObject({ state: 'cancelled', endedAt: expect.any(String) });
    expect(opRecord(s, String(j.operation))).toMatchObject({ state: 'stopped', ended: expect.any(String) });
  }, 120_000);

  it('r23\'s shape, timmy act \'/run LONG.md long\' --wait: exit 3 and a JSON with exit_code 3 (r23: 0 bytes on stdout); no record says running', async () => {
    const s = box('h88-act-r23-');
    const r = timmy(s, ['act', '/run LONG.md long', '--wait', '--json']);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    await twice(r);
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    const j = lastJson(d.stdout);
    expect(j).toMatchObject({ schema: 'timmy.act/1', outcome: 'stopped', exit_code: 3 });
    const job = (j.runs as Array<{ kind: string; id: string }>).find((x) => x.kind === 'job')!.id;
    expect(jobRecord(s, job)).toMatchObject({ state: 'cancelled', endedAt: expect.any(String) });
    expect(opRecord(s, String(j.operation))).toMatchObject({ state: 'stopped', ended: expect.any(String) });
  }, 120_000);

  it('timmy md, inside the stop (a block that ignores SIGTERM): the JSON says it exited at once, what it settled, what it did not seal and what /recover does; the records say so; /recover then seals the cut block, once', async () => {
    const s = box('h88-md-held-', SLOW);
    const r = timmy(s, ['md', 'LONG.md', 'long', '--json']);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    await twice(r);
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    const j = lastJson(d.stdout);
    expect(j).toMatchObject({ schema: 'timmy.md/1', outcome: 'stopped', exit_code: 3, why: expect.stringMatching(/^SIGINT received; a second SIGINT: timmy md exited at once, before what it started had ended; ended now: job j[0-9a-f]{6}: cancelled; not sealed: /), receipts: null });
    const op = String(j.operation);
    const job = (j.job as { id: string }).id;
    expect(j.job).toMatchObject({ id: expect.stringMatching(/^j[0-9a-f]{6}$/), state: 'cancelled', exit_code: null });
    expect(j.at_once).toEqual({
      signal: 'SIGINT',
      settled: [`operation ${op}: stopped`, `job ${job}: cancelled`],
      not_sealed: [`block long of run ${job} (cut by the stop)`, `the run's own receipt (run ${job})`],
      left_for_recover: [`/recover seals the receipt of block long of run ${job}, as cut by this stop`, `nothing seals run ${job}'s own receipt later: its job record and its block receipts say how it ended`],
      receipts: `not read: timmy md exited at once, without reading the receipts chain; /op ${op} lists them`,
    });
    // the first block's receipt was sealed as it ended; the cut one's was not
    // R4 (H107; r25 D3): each with upmd's own verdict as its own field (null for the cut block: upmd gave none)
    expect(j.blocks).toEqual([{ name: 'first', state: 'completed', exit_code: 0, upmd: { state: 'completed', exit_code: 0 }, receipt: expect.stringMatching(/^[0-9a-f]{8}$/) }, { name: 'long', state: 'stopped', exit_code: null, upmd: null, receipt: null }]);
    // what it settled at once, on disk: neither record says running
    expect(opRecord(s, op)).toMatchObject({ state: 'stopped', ended: expect.any(String), why: expect.stringContaining('a second SIGINT: timmy md exited at once') });
    const jobRec = jobRecord(s, job);
    expect(jobRec).toMatchObject({ state: 'cancelled', endedAt: expect.any(String), exitCode: null, error: expect.stringMatching(/^stopped by timmy md at once \(a second SIGINT\)/), exitedAtOnce: { by: 'timmy md', signal: 'SIGINT', sealed: false } });
    expect((jobRec.steps as Array<{ name: string; state: string }>).map((x) => `${x.name} ${x.state}`)).toEqual(['first completed', 'long stopped']);
    // R4 (H97; r23c): the cut step has its end time (the record's own, or the stop's line's when that was read first)
    expect((jobRec.steps as Array<{ endedAt?: string }>)[1].endedAt).toEqual(expect.any(String));
    expect(blocksOf(s, job).map((x) => x.block.name)).toEqual(['first']);
    // /recover (a REPL of the same Timmy) seals the cut block's receipt, as cut by that stop, once
    const { ws } = replOf(kit, s);
    const said = text(await ws.recover('')).replace(/\s+/g, ' ');
    expect(said).toContain(`run ${job} of LONG.md › long was stopped at once by its timmy md (a second SIGINT), which ended its record then and sealed nothing for it; sealed now, as cut by that stop: block long: receipt `);
    expect(said).toContain('1 workflow run stopped at once by its Timmy');
    const sealed = blocksOf(s, job);
    expect(sealed.map((x) => `${String(x.block.name)} ${String(x.block.outcome)}`)).toEqual(['first completed', 'long interrupted']);
    expect(sealed[1].block).toMatchObject({ interrupted_by: 'stop', stop_words: expect.stringMatching(/^stopped by timmy md at once \(a second SIGINT\)/), ended_at: expect.any(String), ms: expect.any(Number) });
    expect(jobRecord(s, job)).toMatchObject({ exitedAtOnce: { sealed: true } });
    await ws.recover('');
    expect(blocksOf(s, job)).toHaveLength(2);
    // R4 (H88; r23): /op calls the run by its record's own word (cancelled), as /jobs does; it said "stopped"
    const card = text(ws.op(op));
    expect(card).toMatch(new RegExp(`${job}[^\\n]*cancelled · `));
    expect(card).not.toMatch(/\bstopped · /);
  }, 120_000);

  it('R4 (H88; r23): timmy md killed (SIGKILL) while a block runs: /recover names timmy md as what started it; /jobs says how it ran (no absolute path) and when its end was recorded, not "88 min"', async () => {
    const s = box('h88-md-killed-');
    const r = timmy(s, ['md', 'LONG.md', 'long', '--json']);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    await new Promise((z) => { setTimeout(z, 300); });
    group(r, 'SIGKILL');
    await r.done;
    const job = fs.readdirSync(path.join(s.home, 'timmy', 'jobs')).find((f) => /^j[0-9a-f]{6}\.json$/.test(f))!.slice(0, 7);
    // its pty wrapper sees its parent gone, stops upmd and writes its stop file; then a REPL's recovery records the run
    await until(() => { const j = jobRecord(s, job) as { pid?: number }; try { process.kill(-j.pid!, 0); return false; } catch { return true; } }, 30_000, 'the run\'s wrapper to end');
    const { ws } = replOf(kit, s);
    await ws.recover('');
    const rec = jobRecord(s, job) as { error?: string; note?: string; state: string };
    // before: "interrupted: its REPL ended while long was running; …" for a run timmy md started
    expect(`${rec.error ?? ''}${rec.note ?? ''}`).toMatch(/^interrupted: its timmy md ended while long was running/);
    expect(`${rec.error ?? ''}${rec.note ?? ''}`).not.toContain('its REPL');
    const said = text(ws.jobsView(job));
    const lines = said.split('\n');
    expect(lines[0]).toMatch(new RegExp(`${job} .* ended unseen: a later recovery recorded its end at \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC, after the Timmy that ran it had ended`));
    expect(lines[0]).toMatch(/ ended unseen: a later recovery recorded its end at .+; its blocks' own times: first (<0\.1|\d+\.\d) s, long \d+\.\d s · interrupted: its session ended while long ran; its pty wrapper saw its timmy md end/);
    expect(lines[0]).not.toMatch(/steps · \d/);
    const ran = lines.find((l) => l.startsWith('  Ran      '))!;
    expect(ran).toMatch(/^ {2}Ran {6}\S*python3(\.\d+)? -I \[Timmy\]\/workers\/upmd\/pty_run\.py --parent \d+ --stop-file \[Timmy home\]\/jobs\/runs\/w[0-9a-f]{8}\/\S+ -- \[Timmy\]\/tests\/fixtures\/fake-upmd\.mjs --ci -b long -d \[project project\] \[Timmy home\]\/jobs\/runs\/w[0-9a-f]{8}\/checked\.md$/);
    expect(said).not.toContain(s.base);
  }, 120_000);

  it('timmy act \'/run …\', inside the stop (a block that ignores SIGTERM): its JSON says it exited at once and settled the run\'s job record', async () => {
    const s = box('h88-act-held-', SLOW);
    const r = timmy(s, ['act', '/run LONG.md long', '--wait', '--json']);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    await twice(r);
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    const j = lastJson(d.stdout);
    const job = (j.runs as Array<{ kind: string; id: string }>).find((x) => x.kind === 'job')!.id;
    expect(j).toMatchObject({
      schema: 'timmy.act/1', outcome: 'stopped', exit_code: 3, receipts: null, why: expect.stringMatching(/a second SIGINT: timmy act exited at once/),
      at_once: { signal: 'SIGINT', settled: [`operation ${String(j.operation)}: stopped`, `job ${job}: cancelled`], not_sealed: [`block long of run ${job} (cut by the stop)`, `the run's own receipt (run ${job})`] },
    });
    expect(jobRecord(s, job)).toMatchObject({ state: 'cancelled', endedAt: expect.any(String), error: expect.stringMatching(/^stopped by timmy act at once \(a second SIGINT\)/), exitedAtOnce: { by: 'timmy act', sealed: false } });
    expect(opRecord(s, String(j.operation))).toMatchObject({ state: 'stopped', ended: expect.any(String) });
  }, 120_000);
});

describe('boot.cjs (npm start) passes a CLI\'s end on: its status, or 128 plus the signal that killed it, never 0', () => {
  /** A folder whose dist/cli.js is `body` (boot.cjs runs ./dist/cli.js from the folder it starts in). */
  const folder = (body: string): string => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h82-boot-')));
    kit.dirs.push(d);
    fs.mkdirSync(path.join(d, 'dist'));
    fs.writeFileSync(path.join(d, 'dist', 'cli.js'), body);
    return d;
  };
  const boot = (cwd: string): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [path.join(REPO, 'boot.cjs'), 'act', '/op'], { cwd, encoding: 'utf8', timeout: 30_000 });

  it('a CLI killed by SIGTERM: 143; by SIGKILL: 137; one that exits 3: 3', () => {
    expect(boot(folder("process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n")).status).toBe(143);
    expect(boot(folder("process.kill(process.pid, 'SIGKILL');\nsetTimeout(() => {}, 5000);\n")).status).toBe(137);
    expect(boot(folder('process.exit(3);\n')).status).toBe(3);
  });
});
