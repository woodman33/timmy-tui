/**
 * Pi Durable S1 (R4 H118), plan b.2 and b.3: the supervisor's start budget, what Timmy's exit does to the worker, the
 * worker's idle exit, and Timmy's start-up recovery. REAL: Pi worker processes started detached by the supervisor,
 * SIGKILL, leases (the worker's authenticated socket connections), a separate client process that attaches and is
 * killed (a crashed Timmy), worker.log, .timmy/private/pi/starts.jsonl, the run records, pi-durable 1.1.0's store.
 * FAKE: the model (pi-ai's scripted faux provider), the fixture projects, and the "Timmy" processes (this test and its
 * child). Timings are shortened through the worker's own options (--lease-grace-ms, --idle-ms); the defaults are 15 s
 * and 10 minutes. The worker's environment is read from /proc (Linux) and holds only the allowlist (fix S9 of H119's
 * review: it was the parent's environment less 12 key names, while pi-ai reads some 40).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readOwner } from '../src/pi-durable/owner.js';
import { piPaths } from '../src/pi-durable/paths.js';
import { readRun } from '../src/pi-durable/runs.js';
import { PiNeedsYou, recoverOnStart, startsInWindow, START_BUDGET } from '../src/pi-durable/supervisor.js';
import { alive, anyAlive, cleanup, delegate, ended, INSTALLED, killWorker, project, reads, SKIP_WHY, start, status, track, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
afterAll(() => { cleanup(); });

const slowRead = (ms: number) => ({ first: { tool: 'slow_read', args: { path: 'b.txt', delay_ms: ms } } });
const log = (root: string): string => { try { return readFileSync(piPaths(root).log, 'utf8'); } catch { return ''; } };

describe.skipIf(!INSTALLED)(`the supervisor and the worker's life (plan b.2, b.3)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('the start budget: 3 starts in 10 minutes; a fourth is refused with NEEDS YOU words and the end of worker.log, and nothing starts', async () => {
    expect(START_BUDGET).toEqual({ limit: 3, windowMs: 600_000 });
    const root = project('sup-budget');
    const pids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await start(root);
      pids.push(a.client.hello.pid);
      a.client.close();
      await killWorker(root); // a worker that keeps dying
    }
    expect(startsInWindow(piPaths(root), START_BUDGET.windowMs).map((s) => s.pid)).toEqual(pids);
    let refused: unknown;
    try { await start(root); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(PiNeedsYou);
    const words = (refused as PiNeedsYou).words;
    expect(words).toMatch(new RegExp(`^NEEDS YOU: the Pi worker was started 3 times in the last 10 minutes without ending cleanly \\(pids ${pids.join(', ')}\\); it is not started again by itself\\. The end of its log`));
    expect((refused as PiNeedsYou).log).toMatch(/pi-worker pid \d+: ready on its socket/);
    expect(startsInWindow(piPaths(root), START_BUDGET.windowMs)).toHaveLength(3); // the refusal started nothing
    expect(readOwner(piPaths(root))?.pid).toBe(pids[2]); // the last (killed) worker's record, never withdrawn by a SIGKILL,
    expect(alive(pids[2])).toBe(false); // names a process that is gone
  });

  it('the budget counts only starts that did not end cleanly: four Timmy sessions within minutes, each worker exiting cleanly, start a fifth (S4)', async () => {
    const root = project('sup-budget-clean');
    const clean: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = await start(root); // before the fix, the fourth was refused: "started 3 times in the last 10 minutes"
      const pid = a.client.hello.pid;
      clean.push(pid);
      await a.client.request('shutdown');
      a.client.close();
      await until('the worker to exit', () => !alive(pid), 30_000, 50);
    }
    const lines = readFileSync(piPaths(root).starts, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { pid: number; clean_exit?: true });
    expect(lines.filter((l) => l.clean_exit).map((l) => l.pid)).toEqual(clean); // written by each worker itself
    expect(startsInWindow(piPaths(root), START_BUDGET.windowMs)).toEqual([]);
    const fifth = await start(root);
    expect(fifth.how).toBe('started');
    expect(startsInWindow(piPaths(root), START_BUDGET.windowMs).map((x) => x.pid)).toEqual([fifth.client.hello.pid]);
    await fifth.client.request('shutdown');
    fifth.client.close();
  });

  it('one bad line in starts.jsonl is skipped, not the whole budget; lost races, clean exits and old starts do not count (S4)', () => {
    const root = project('sup-budget-lines');
    const p = piPaths(root);
    mkdirSync(p.dir, { recursive: true });
    const now = Date.now();
    const at = (ago: number): string => new Date(now - ago).toISOString();
    const lines = [
      { at: at(1000), pid: 101 },
      { at: at(2000), pid: 102 },
      'a line cut by a crash {"at":',
      { at: at(3000), pid: 103 },
      { at: at(4000), pid: 104 }, { at: at(3900), pid: 104, lost_race: true },
      { at: at(5000), pid: 105 }, { at: at(500), pid: 105, clean_exit: true },
      { at: at(700_000), pid: 106 },
    ];
    writeFileSync(p.starts, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
    expect(startsInWindow(p, START_BUDGET.windowMs, now).map((x) => x.pid)).toEqual([101, 102, 103]);
  });

  it('a start that lost the race (exit 3) does not count against the budget', async () => {
    const root = project('sup-race');
    const [x, y] = await Promise.all([start(root), start(root)]);
    expect(x.client.hello.pid).toBe(y.client.hello.pid);
    await until('the losing start to be recorded', () => readFileSync(piPaths(root).starts, 'utf8').includes('"lost_race":true'), 10_000);
    expect(startsInWindow(piPaths(root), START_BUDGET.windowMs).map((s) => s.pid)).toEqual([x.client.hello.pid]);
    await x.client.request('shutdown');
    x.client.close();
    y.client.close();
  });

  it('Timmy exits (its last lease ends): after the grace the worker pauses its live run and exits; the next worker shows it paused and Resume continues it', async () => {
    const root = project('sup-exit', { 'b.txt': 'x' });
    const a = await start(root, { worker: { leaseGraceMs: 500 } });
    const pid = a.client.hello.pid;
    expect(a.client.hello).toMatchObject({ leases: 1, setting: { on_exit: 'pause', lease_grace_ms: 500, idle_ms: 600_000 } });
    const d = await delegate(a.client, slowRead(8000));
    await until('the read to be running', () => reads(root, d.run).length === 1);
    const t0 = Date.now();
    a.client.close(); // the last Timmy process detaches
    await until('the worker to exit', () => !alive(pid), 20_000, 50);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(400);
    expect(log(root)).toMatch(/shutting down \(no Timmy process has been attached for 500 ms\): pause on exit/);
    expect(readRun(piPaths(root), d.run)?.paused?.why).toBe('Timmy exited (no Timmy process has been attached for 500 ms)');
    expect(existsSync(piPaths(root).owner)).toBe(false);

    const b = await start(root);
    expect(b.client.hello.scheduling).toBe('paused');
    expect((await status(b.client, d.run)).status).toBe('paused');
    await b.client.request('resume');
    expect((await ended(b.client, d.run)).status).toBe('completed');
    await b.client.request('shutdown');
    b.client.close();
  });

  it('a lease holds the worker; a Timmy process that dies (SIGKILL) ends its lease, and the worker pauses and exits', async () => {
    const root = project('sup-crash', { 'b.txt': 'x' });
    const a = await start(root, { worker: { leaseGraceMs: 500 } });
    const pid = a.client.hello.pid;
    const d = await delegate(a.client, slowRead(20_000));
    await until('the read to be running', () => reads(root, d.run).length === 1);
    // a second "Timmy" process: attaches with the token, says hello, and stays
    const script = "const net=require('net'),fs=require('fs'),p=require('path');const r=process.argv[1];"
      + "const o=JSON.parse(fs.readFileSync(p.join(r,'.timmy/private/pi/worker.json'),'utf8'));const t=fs.readFileSync(p.join(r,'.timmy/private/pi/worker.token'),'utf8').trim();"
      + "const s=net.createConnection(o.socket,()=>s.write(JSON.stringify({id:1,method:'hello',params:{token:t,pid:process.pid,surface:'fake-timmy'}})+'\\n'));"
      + "s.on('data',(d)=>{if(String(d).includes('\"ok\":true'))process.stdout.write('attached\\n');});setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ['-e', script, root], { stdio: ['ignore', 'pipe', 'inherit'] });
    track(child.pid);
    let said = '';
    child.stdout.on('data', (b: Buffer) => { said += b.toString(); });
    await until('the second Timmy process to be attached', () => said.includes('attached'), 20_000);
    a.client.close(); // one lease is left: the child's
    await new Promise((r) => setTimeout(r, 2000)); // four grace periods
    expect(alive(pid)).toBe(true);
    expect(log(root)).toMatch(/lease \d+ ended \(1 left\)/);
    child.kill('SIGKILL'); // that Timmy crashes: its connection closes with it
    await until('the worker to exit', () => !alive(pid), 20_000, 50);
    expect(log(root)).toMatch(/lease \d+ ended \(0 left\)[\s\S]*shutting down \(no Timmy process has been attached for 500 ms\)/);
    expect(readRun(piPaths(root), d.run)?.paused?.why).toMatch(/^Timmy exited/);
  });

  it('keep working: with no lease the worker goes on until its work ends, then exits after the idle time', async () => {
    const root = project('sup-keep', { 'b.txt': 'x' });
    const a = await start(root, { worker: { onExit: 'keep-working', idleMs: 1500, leaseGraceMs: 200 } });
    const pid = a.client.hello.pid;
    expect(a.client.hello.setting).toMatchObject({ on_exit: 'keep-working', idle_ms: 1500 });
    const d = await delegate(a.client, slowRead(2500));
    a.client.close(); // Timmy exits; the run is not paused
    await until('the run to end with no Timmy attached', () => readRun(piPaths(root), d.run)?.ended, 30_000);
    expect(readRun(piPaths(root), d.run)?.ended?.status).toBe('completed');
    expect(readRun(piPaths(root), d.run)?.paused ?? null).toBeNull();
    expect(alive(pid)).toBe(true); // still within its idle time
    await until('the worker to exit when idle', () => !alive(pid), 20_000, 50);
    expect(log(root)).toMatch(/shutting down \(idle: no live work and no Timmy process attached for 1500 ms\)/);
    expect(existsSync(piPaths(root).owner)).toBe(false);
  });

  it('Timmy\'s start-up pass: nothing pending starts nothing; "never" starts nothing; pending FAKE (free) work restarts the worker and resumes it', async () => {
    const empty = project('sup-recover-empty');
    expect(await recoverOnStart(empty)).toEqual({ started: false, resumed: false, words: 'nothing pending: the Pi worker is not started' });
    expect(existsSync(piPaths(empty).owner)).toBe(false);

    const root = project('sup-recover', { 'b.txt': 'x' });
    const a = await start(root);
    const d = await delegate(a.client, slowRead(6000));
    await until('the read to be running', () => reads(root, d.run).length === 1);
    a.client.close();
    await killWorker(root);
    const never = await recoverOnStart(root, { resumeOnStart: 'never' });
    expect(never).toEqual({ started: false, resumed: false, words: 'the setting is "never": the Pi worker is not started; 1 run(s) wait for Resume' });
    expect(readOwner(piPaths(root))).toBeDefined(); // the dead worker's record is still there,
    expect(alive(readOwner(piPaths(root))!.pid)).toBe(false); // and nothing new runs

    const rec = await recoverOnStart(root, { waitMs: 45_000, surface: 'test' });
    track(rec.attached?.client.hello.pid);
    expect(rec).toMatchObject({ started: true, resumed: true, words: 'resumed 1 free run(s) (the FAKE route costs nothing)' });
    expect(rec.resume?.resumed).toEqual([{ run: d.run, submission: d.submission, same: true }]);
    const end = await ended(rec.attached!.client, d.run);
    expect(end.status).toBe('completed');
    await rec.attached!.client.request('shutdown');
    rec.attached!.client.close();
  });

  it.skipIf(!existsSync('/proc/self/environ'))('the worker\'s environment is built from an allowlist: a provider key, a token or a proxy setting in Timmy\'s environment does not reach it (S9)', async () => {
    const root = project('sup-env');
    // FAKE values, set only in the environment this test hands the supervisor
    const env: NodeJS.ProcessEnv = {
      ...process.env, HF_TOKEN: 'FAKE-hf', ANTHROPIC_OAUTH_TOKEN: 'FAKE-oauth', COPILOT_GITHUB_TOKEN: 'FAKE-copilot', AZURE_OPENAI_API_KEY: 'FAKE-azure',
      OPENAI_API_KEY: 'FAKE-openai', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_OPTIONS: '--max-old-space-size=4096', SOME_OTHER_SETTING: 'FAKE',
      TIMMY_PI_LOCK_WAIT_MS: '2000', LC_ALL: 'C.UTF-8', TERM: 'xterm',
    };
    const a = await start(root, { env });
    const names = readFileSync(`/proc/${a.client.hello.pid}/environ`, 'utf8').split('\0').filter(Boolean).map((kv) => kv.slice(0, kv.indexOf('=')));
    const allowed = (k: string): boolean => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'].includes(k) || k.startsWith('LC_') || k.startsWith('TIMMY_PI_');
    expect(names.filter((k) => !allowed(k))).toEqual([]);
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'TERM', 'LC_ALL', 'TIMMY_PI_LOCK_WAIT_MS']) expect(names).toContain(k);
    await a.client.request('shutdown');
    a.client.close();
  });

  it('leaves no worker running: every worker this file started has exited (shut down, idle, or killed by the test on purpose)', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
