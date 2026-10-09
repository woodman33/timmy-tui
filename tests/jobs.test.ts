// Background jobs (src/jobs): the REPL runs builds, upmd workflow runs and preview servers as jobs that
// report states from real events, keep one private combined log, persist their records, and stop their
// whole process group. Everything here runs real child processes (sh, node) and real HTTP servers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobManager, type JobManagerOptions, type JobRecord, type JobSpec } from '../src/jobs/index.js';

const node = process.execPath;
let dir = '';
let managers: JobManager[] = [];
let strays: number[] = [];
let servers: http.Server[] = [];

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'timmy-jobs-')); });
afterEach(async () => {
  await Promise.all(managers.map((m) => m.stopAll()));
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); })));
  managers = [];
  strays = [];
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

function manager(opts: Partial<JobManagerOptions> = {}): JobManager {
  const m = new JobManager({ dir, ...opts });
  managers.push(m);
  return m;
}

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return { kind: 'task', label: 'test job', project: 'jobs-test', root: dir, command: node, args: ['-e', ''], ...over };
}

const script = (code: string, over: Partial<JobSpec> = {}): JobSpec => spec({ args: ['-e', code], ...over });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** A tiny HTTP server for `node -e`: listens after delayMs, answers with status, and, given exitAfterFirst,
 *  exits with that code shortly after its first request. */
function serverCode(port: number, o: { delayMs?: number; status?: number; exitAfterFirst?: number } = {}): string {
  const exit = o.exitAfterFirst === undefined ? '' : `setTimeout(() => process.exit(${o.exitAfterFirst}), 150);`;
  return `const server = require('node:http').createServer((req, res) => { res.statusCode = ${o.status ?? 200}; res.end('ok'); ${exit} });
setTimeout(() => server.listen(${port}, '127.0.0.1', () => console.log('listening')), ${o.delayMs ?? 0});`;
}

async function until<T>(probe: () => T | undefined, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The pid a `sh -c 'sleep 30 & echo child=$!; wait'` job printed for its background child. */
function childPid(m: JobManager, id: string): number | undefined {
  const line = m.tail(id, 10).find((l) => l.startsWith('child='));
  return line ? Number(line.slice('child='.length)) : undefined;
}

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const SH_WITH_CHILD = ['-c', 'sleep 30 & echo child=$!; wait'];

describe('JobManager', () => {
  it('starts a task at once and reports queued, running and completed from its process', async () => {
    const states: string[] = [];
    const m = manager({ onChange: (job) => states.push(job.state) });
    const job = m.start(script('setTimeout(() => process.exit(0), 100)'));
    expect(job.id).toMatch(/^j[0-9a-f]{6}$/);
    expect(job.state).toBe('queued');
    const done = await m.done(job.id);
    expect(done).toMatchObject({ id: job.id, kind: 'task', label: 'test job', project: 'jobs-test', root: dir, state: 'completed', exitCode: 0, signal: null });
    expect(done.pid).toBeGreaterThan(1);
    expect(done.endedAt).toBeDefined();
    expect(done.error).toBeUndefined();
    expect(states).toEqual(['queued', 'running', 'completed']);
  });

  it('ends failed on a nonzero exit, on a signal it did not get from us, and on a spawn error', async () => {
    const m = manager();
    expect(await m.done(m.start(script('process.exit(3)')).id)).toMatchObject({ state: 'failed', exitCode: 3, signal: null });
    expect(await m.done(m.start(script("process.kill(process.pid, 'SIGKILL')")).id)).toMatchObject({ state: 'failed', exitCode: null, signal: 'SIGKILL' });
    const states: string[] = [];
    const quiet = manager({ onChange: (job) => states.push(job.state) });
    const missing = await quiet.done(quiet.start(spec({ command: path.join(dir, 'no-such-program') })).id);
    expect(missing.state).toBe('failed');
    expect(missing.error).toMatch(/ENOENT/);
    expect(missing.pid).toBeUndefined();
    expect(states).toEqual(['queued', 'failed']);
  });

  it('runs parseLine on every line so a workflow reports its steps, and onChange fires for each step change', async () => {
    const changes: JobRecord[] = [];
    const m = manager({ onChange: (job) => changes.push(job) });
    const parseLine = (line: string, job: JobRecord): void => {
      const match = /^step (\d+) (\S+) (start|ok|fail)$/.exec(line);
      if (!match) return;
      const index = Number(match[1]);
      if (match[3] === 'start') { job.steps.push({ name: match[2], index, state: 'running' }); return; }
      const step = job.steps.find((s) => s.index === index);
      if (step) { step.state = match[3] === 'ok' ? 'completed' : 'failed'; step.code = match[3] === 'ok' ? 0 : 1; }
    };
    const code = ['step 1 build start', 'compiling', 'step 1 build ok', 'step 2 test start', 'step 2 test fail'].map((l) => `console.log(${JSON.stringify(l)});`).join(' ');
    const job = m.start(script(`${code} process.exitCode = 1;`, { kind: 'workflow', parseLine }));
    const done = await m.done(job.id);
    expect(done).toMatchObject({ kind: 'workflow', state: 'failed', exitCode: 1, lines: 5 });
    expect(done.steps).toEqual([{ name: 'build', index: 1, state: 'completed', code: 0 }, { name: 'test', index: 2, state: 'failed', code: 1 }]);
    expect(changes.map((c) => `${c.state} [${c.steps.map((s) => `${s.name}:${s.state}`).join(' ')}]`)).toEqual([
      'queued []',
      'running []',
      'running [build:running]',
      'running [build:completed]',
      'running [build:completed test:running]',
      'running [build:completed test:failed]',
      'failed [build:completed test:failed]',
    ]);
  });

  it('writes stdout and stderr lines to one private log, counts them and tails the last ones', async () => {
    const parsed: string[] = [];
    const m = manager();
    const code = [
      "process.stdout.write('one\\ntwo\\r\\nthr');",
      "setTimeout(() => process.stdout.write('ee\\r'), 30);",
      "setTimeout(() => process.stdout.write('\\n\\rdownload 50%\\rdownload 100%\\n'), 60);",
      "setTimeout(() => process.stderr.write('warning on stderr\\n'), 120);",
      "setTimeout(() => process.stdout.write('last line, unterminated'), 300);",
    ].join('\n');
    const job = m.start(script(code, { parseLine: (line) => { parsed.push(line); } }));
    const done = await m.done(job.id);
    const stdout = ['one', 'two', 'three', 'download 50%', 'download 100%', 'last line, unterminated'];
    const all = [...stdout, 'warning on stderr'];
    expect(done).toMatchObject({ state: 'completed', lines: all.length, logPath: path.join(dir, `${job.id}.log`) });
    // each stream keeps its order; the two pipes may interleave either way
    expect([...parsed].sort()).toEqual([...all].sort());
    expect(parsed.filter((l) => l !== 'warning on stderr')).toEqual(stdout);
    const log = readFileSync(done.logPath, 'utf8');
    expect(log.endsWith('\n')).toBe(true);
    const logged = log.split('\n').slice(0, -1);
    expect(logged).toEqual(parsed);
    expect(m.tail(job.id, 1)).toEqual(['last line, unterminated']);
    expect(m.tail(job.id, 3)).toEqual(logged.slice(-3));
    expect(m.tail(job.id, 100)).toEqual(logged);
    expect(statSync(done.logPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, `${job.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it('marks a server ready once its address answers with any status, and never completed for that', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const states: string[] = [];
    const m = manager({ onChange: (job) => states.push(job.state) });
    const job = m.start(spec({ kind: 'server', args: ['-e', serverCode(port, { delayMs: 300, status: 503 })], ready: { url, timeoutMs: 4000 } }));
    const ready = await m.ready(job.id);
    expect(ready).toMatchObject({ state: 'ready', url });
    expect(ready.readyAt).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(m.get(job.id)?.state).toBe('ready');
    const stopped = await m.stop(job.id);
    expect(stopped).toMatchObject({ state: 'cancelled', signal: 'SIGTERM', url });
    expect(states).toEqual(['queued', 'running', 'ready', 'cancelled']);
  });

  it('fails a server that exits before it is ready; one that exits on its own after ready completes on code 0, else fails', async () => {
    const m = manager();
    const early = await m.done(m.start(spec({ kind: 'server', args: ['-e', 'setTimeout(() => {}, 50)'], ready: { url: `http://127.0.0.1:${await freePort()}/` } })).id);
    expect(early).toMatchObject({ state: 'failed', exitCode: 0, error: 'exited before it was ready' });
    expect(early.readyAt).toBeUndefined();
    for (const [exitCode, state] of [[0, 'completed'], [2, 'failed']] as const) {
      const port = await freePort();
      const job = m.start(spec({ kind: 'server', args: ['-e', serverCode(port, { exitAfterFirst: exitCode })], ready: { url: `http://127.0.0.1:${port}/` } }));
      expect((await m.ready(job.id)).state).toBe('ready');
      const done = await m.done(job.id);
      expect(done).toMatchObject({ state, exitCode, url: `http://127.0.0.1:${port}/` });
      expect(done.readyAt).toBeDefined();
    }
  });

  it('never calls a server ready on an answer from something that already held its address', async () => {
    const other = http.createServer((_req, res) => { res.end('someone else'); });
    servers.push(other);
    await new Promise<void>((resolve) => { other.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${(other.address() as net.AddressInfo).port}/`;
    const states: string[] = [];
    const m = manager({ onChange: (job) => states.push(`${job.id} ${job.state}`) });
    const busy = m.start(spec({ kind: 'server', args: ['-e', 'setInterval(() => {}, 1000)'], ready: { url } }));
    const done = await m.done(busy.id);
    expect(done).toMatchObject({ state: 'failed', error: `${url} already answered before this server started` });
    expect(done.pid).toBeUndefined();
    // stopped while its address is still being checked: cancelled, and nothing was spawned
    const early = m.start(spec({ kind: 'server', args: ['-e', 'setInterval(() => {}, 1000)'], ready: { url: `http://127.0.0.1:${await freePort()}/` } }));
    const stopped = await m.stop(early.id);
    expect(stopped).toMatchObject({ state: 'cancelled', exitCode: null });
    expect(stopped?.pid).toBeUndefined();
    expect(states).toEqual([`${busy.id} queued`, `${busy.id} failed`, `${early.id} queued`, `${early.id} cancelled`]);
  });

  it('stops a server whose address does not answer within ready.timeoutMs, and fails it', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const m = manager();
    const job = m.start(spec({ kind: 'server', args: ['-e', 'setInterval(() => {}, 1000)'], ready: { url, timeoutMs: 500 } }));
    const done = await m.done(job.id);
    expect(done).toMatchObject({ state: 'failed', signal: 'SIGTERM', error: `not ready: no answer from ${url} within 500 ms` });
    expect(exists(done.pid as number)).toBe(false);
  });

  it('stop() cancels the job and stops the processes it started (its whole process group)', async () => {
    const m = manager();
    const job = m.start(spec({ command: 'sh', args: SH_WITH_CHILD }));
    const child = await until(() => childPid(m, job.id));
    strays.push(child);
    expect(exists(child)).toBe(true);
    const stopped = await m.stop(job.id);
    expect(stopped).toMatchObject({ state: 'cancelled', signal: 'SIGTERM' });
    expect(() => process.kill(child, 0)).toThrow();
    expect(exists(stopped?.pid as number)).toBe(false);
    strays = strays.filter((pid) => pid !== child);
  });

  it('a stopped job is cancelled whatever its exit code, and SIGKILL follows when SIGTERM is ignored', async () => {
    const m = manager();
    const armed = (id: string) => (m.tail(id).includes('armed') ? true : undefined);
    const polite = m.start(script("process.on('SIGTERM', () => process.exit(0)); console.log('armed'); setInterval(() => {}, 1000);"));
    await until(() => armed(polite.id));
    expect(await m.stop(polite.id)).toMatchObject({ state: 'cancelled', exitCode: 0, signal: null });
    const stubborn = m.start(script("process.on('SIGTERM', () => {}); console.log('armed'); setInterval(() => {}, 1000);"));
    await until(() => armed(stubborn.id));
    const t0 = performance.now();
    expect(await m.stop(stubborn.id, 300)).toMatchObject({ state: 'cancelled', exitCode: null, signal: 'SIGKILL' });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('timeoutMs stops the whole group and ends the job failed with "timed out"', async () => {
    const m = manager();
    const job = m.start(spec({ command: 'sh', args: SH_WITH_CHILD, timeoutMs: 400 }));
    const child = await until(() => childPid(m, job.id));
    strays.push(child);
    const done = await m.done(job.id);
    expect(done).toMatchObject({ state: 'failed', error: 'timed out', exitCode: null, signal: 'SIGTERM' });
    expect(() => process.kill(child, 0)).toThrow();
    strays = strays.filter((pid) => pid !== child);
  });

  it('persists the record at every state change and lists earlier sessions newest first, marking dead ones stale', async () => {
    const persisted: string[] = [];
    const m = manager({ onChange: (job) => persisted.push(JSON.parse(readFileSync(path.join(dir, `${job.id}.json`), 'utf8')).state) });
    const job = m.start(script("console.log('built')"));
    await m.done(job.id);
    expect(persisted).toEqual(['queued', 'running', 'completed']);
    expect(readdirSync(dir).sort()).toEqual([`${job.id}.json`, `${job.id}.log`]); // no temp file is left behind
    // what earlier sessions left: a job that never ended and whose process is gone, one whose process lives, junk
    const earlier = { kind: 'server', label: 'preview', project: 'jobs-test', root: dir, command: 'npm', args: ['run', 'dev'], steps: [], lines: 3, logPath: 'elsewhere' };
    writeFileSync(path.join(dir, 'j0dead0.json'), JSON.stringify({ ...earlier, id: 'j0dead0', state: 'running', pid: 2147483646, startedAt: '2001-01-01T00:00:00.000Z' }));
    writeFileSync(path.join(dir, 'j0beef0.json'), JSON.stringify({ ...earlier, id: 'j0beef0', state: 'ready', pid: process.pid, url: 'http://127.0.0.1:9/', startedAt: '2001-01-02T00:00:00.000Z' }));
    writeFileSync(path.join(dir, 'j0bad00.json'), '{ not json');
    writeFileSync(path.join(dir, 'notes.json'), '{}');
    const later = manager();
    const listed = later.list();
    expect(listed.map((j) => j.id)).toEqual([job.id, 'j0beef0', 'j0dead0']);
    expect(listed[0]).toMatchObject({ state: 'completed', exitCode: 0, lines: 1 });
    expect(listed[1]).toMatchObject({ state: 'ready', pid: process.pid });
    expect(listed[1].stale).toBeUndefined();
    expect(listed[2]).toMatchObject({ state: 'running', stale: true, logPath: path.join(dir, 'j0dead0.log') }); // its recorded state, no invented end
    expect(m.list().map((j) => j.id)).toEqual([job.id, 'j0beef0', 'j0dead0']); // its own job once, from memory
    expect(later.get('j0dead0')).toMatchObject({ state: 'running', stale: true });
    expect(later.tail(job.id)).toEqual(['built']);
    expect(await later.done('j0dead0')).toMatchObject({ state: 'running', stale: true });
    await expect(later.done('j0fff00')).rejects.toThrow(/no job/);
    await expect(later.ready('j0fff00')).rejects.toThrow(/no job/);
    // another session's job is never signalled from here: its pid (this test's own process) is left alone
    expect(await later.stop('j0beef0')).toMatchObject({ state: 'ready' });
    expect(exists(process.pid)).toBe(true);
  });

  it('seals once at the terminal state and stores the receipt before the final persist and onChange', async () => {
    const sealed: JobRecord[] = [];
    const changes: JobRecord[] = [];
    const persistedReceipts: Array<string | undefined> = [];
    const m = manager({
      seal: (job) => { sealed.push(job); return `receipt-${job.id}`; },
      onChange: (job) => {
        changes.push(job);
        persistedReceipts.push(JSON.parse(readFileSync(path.join(dir, `${job.id}.json`), 'utf8')).receipt);
      },
    });
    const job = m.start(script('process.exit(0)'));
    const done = await m.done(job.id);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ id: job.id, state: 'completed', exitCode: 0 });
    expect(sealed[0].receipt).toBeUndefined();
    expect(done.receipt).toBe(`receipt-${job.id}`);
    expect(changes.map((c) => c.receipt)).toEqual([undefined, undefined, `receipt-${job.id}`]);
    expect(persistedReceipts).toEqual([undefined, undefined, `receipt-${job.id}`]);
    // stopped twice, by stopAll as well, and awaited twice: still sealed once
    const long = m.start(script('setInterval(() => {}, 1000)'));
    await until(() => (m.get(long.id)?.state === 'running' ? true : undefined));
    await Promise.all([m.stop(long.id), m.stop(long.id), m.stopAll(), m.done(long.id), m.ready(long.id)]);
    expect(sealed.filter((j) => j.id === long.id).map((j) => j.state)).toEqual(['cancelled']);
    expect(m.get(long.id)?.receipt).toBe(`receipt-${long.id}`);
  });

  it('never blocks: start() returns at once and the event loop keeps running while the job does', async () => {
    const m = manager();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const t0 = performance.now();
    const job = m.start(script('setTimeout(() => {}, 600)'));
    const took = performance.now() - t0;
    expect(job.state).toBe('queued');
    expect(took).toBeLessThan(300);
    const done = await m.done(job.id);
    clearInterval(timer);
    expect(done.state).toBe('completed');
    // ~30 ticks are due during a 600 ms job; a blocked loop delivers none
    expect(ticks).toBeGreaterThanOrEqual(10);
    for (const file of ['../src/jobs/index.ts', '../src/runtime/spawn-runtime.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\b(spawnSync|execSync|execFileSync)\s*\(/);
      expect(source).not.toMatch(/import\s*\{[^}]*\b(spawnSync|execSync|execFileSync)\b[^}]*\}/);
    }
  });

  it('stopAll() stops every job still going and leaves finished ones as they ended', async () => {
    const m = manager();
    const finished = m.start(script('process.exit(0)'));
    await m.done(finished.id);
    const task = m.start(script('setInterval(() => {}, 1000)'));
    const server = m.start(spec({ kind: 'server', args: ['-e', 'setInterval(() => {}, 1000)'] }));
    await until(() => (m.get(task.id)?.state === 'running' && m.get(server.id)?.state === 'running' ? true : undefined));
    await m.stopAll();
    expect(m.get(finished.id)?.state).toBe('completed');
    expect(m.get(task.id)?.state).toBe('cancelled');
    expect(m.get(server.id)?.state).toBe('cancelled');
    expect(await m.ready(task.id)).toMatchObject({ state: 'cancelled' });
  });
});
