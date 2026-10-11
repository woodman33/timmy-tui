/**
 * Round R4 (helper H82; the review of 6fb765a..4338fdb, finding 1): what one live-board build costs. On the Mac (r22) one
 * live-board page took about 16 minutes: every poll (GET /state, every 2 s a page) built the board, God's Eye View and the
 * Control Room, and each asked the process table once per record (ps), inside a sort's comparator too, read the project's
 * judgements three times and verified the receipts chain up to its head.
 *
 * Here: a project with 300 operation records (250 of them saying they run, written by a live process that is not this
 * one: a real `sleep`), 50 native runs and 50 jobs (10 running in that process), served by the real live board over HTTP on
 * 127.0.0.1. Every ps run is counted twice: through the process table's seam (src/ops/process-proof.ts
 * useProcessTableReader, wrapping the real reader: real ps) and by a `ps` on PATH that logs each run before it runs the
 * real one. Measured at b8fcd54 with the same fixture: 4,154 ps runs and about 32 s per GET /state.
 *
 * FAKE pieces: none. The records are written here in the shapes Timmy's writers write; the native runs are records only
 * (no app runs).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PS_READER, useProcessTableReader, withProcessTable, writerState, type ProcessTableReader } from '../src/ops/process-proof.js';
import type { Overview } from '../src/overview/index.js';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain, type ReceiptInput } from '../src/utils/receipts.js';

const N_OPS = 300;
const N_NATIVE = 50;
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const iso = (ms: number): string => new Date(ms).toISOString();
const hex = (n: number, w: number): string => n.toString(16).padStart(w, '0');

/** The real reader, counted. */
function counted(): { reader: ProcessTableReader; calls: { all: number; one: number } } {
  const calls = { all: 0, one: 0 };
  return { calls, reader: { all: () => { calls.all++; return PS_READER.all(); }, one: (pid) => { calls.one++; return PS_READER.one(pid); } } };
}

describe('one reading of the process table for a view (withProcessTable)', () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  it('inside it, every record of one live process costs one reading; outside it, each check asks ps about its pid (as recovery needs)', () => {
    const c = counted();
    restore = useProcessTableReader(c.reader);
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const owner = { pid: child.pid!, started: new Date().toISOString() };
      const states = withProcessTable(() => Array.from({ length: 40 }, () => writerState(owner)));
      expect(new Set(states)).toEqual(new Set(['alive']));
      expect(c.calls).toEqual({ all: 1, one: 0 });
      // A pid reused by another process (its start an hour from the one recorded) is gone, from the same reading.
      expect(withProcessTable(() => writerState({ pid: child.pid!, started: iso(Date.now() - 3_600_000) }))).toBe('gone');
      expect(c.calls).toEqual({ all: 2, one: 0 });
      for (let i = 0; i < 3; i++) expect(writerState(owner)).toBe('alive');
      expect(c.calls).toEqual({ all: 2, one: 3 });
    } finally { child.kill('SIGKILL'); }
  });

  it('a pid the reading does not hold (FAKE reading: it lists nothing) is asked on its own, once per view; a nested view shares the reading', () => {
    // FAKE reader: a table that lists no process, and one pid's elapsed time; nothing is run.
    const calls = { all: 0, one: 0 };
    restore = useProcessTableReader({ all: () => { calls.all++; return new Map(); }, one: () => { calls.one++; return 5; } });
    const owner = { pid: process.ppid, started: iso(Date.now() - 5000) };
    const out = withProcessTable(() => [writerState(owner), withProcessTable(() => writerState(owner)), writerState(owner)]);
    expect(out).toEqual(['alive', 'alive', 'alive']);
    expect(calls).toEqual({ all: 1, one: 1 });
  });
});

describe('a live-board build of a project with many records (real ps, real HTTP)', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h82-board-cost-')));
  const root = path.join(base, 'project');
  const jobsDir = path.join(base, 'jobs');
  const shim = path.join(base, 'shim');
  const log = path.join(base, 'ps.log');
  let foreign: ChildProcess;
  let ws: Workspace;
  let port = 0;
  let token = '';
  const c = counted();
  let restore: () => void = () => {};
  const psRuns = (): number => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const get = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x: Buffer) => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  /** One build, measured: its answer, its time and the ps runs it started (through the seam, and on PATH). */
  async function build(p: string): Promise<{ status: number; body: string; ms: number; seam: { all: number; one: number }; onPath: number }> {
    const before = { ...c.calls };
    const logged = psRuns();
    const t0 = performance.now();
    const r = await get(p);
    return { ...r, ms: performance.now() - t0, seam: { all: c.calls.all - before.all, one: c.calls.one - before.one }, onPath: psRuns() - logged };
  }

  beforeAll(async () => {
    for (const d of [root, jobsDir, shim]) fs.mkdirSync(d, { recursive: true });
    // Every ps any code here runs is logged first (the seam's reader runs ps through PATH too), then the real one runs.
    const realPs = String(spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout ?? '').trim();
    expect(realPs).toMatch(/^\/.*\/ps$/);
    fs.writeFileSync(path.join(shim, 'ps'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realPs}" "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${shim}${path.delimiter}${process.env.PATH ?? ''}`);
    restore = useProcessTableReader(c.reader);
    // The live process that wrote the open records: another Timmy, as far as these records say.
    foreign = spawn('sleep', ['600'], { stdio: 'ignore' });
    const owner = { pid: foreign.pid!, started: new Date().toISOString() };
    const now = Date.now();
    const write = (rel: string, body: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    const ops: string[] = [];
    for (let i = 0; i < N_OPS; i++) {
      const id = `o${hex(i + 1, 8)}`;
      ops.push(id);
      const ended = i % 6 === 0;
      write(`.timmy/operations/${id}.json`, JSON.stringify({
        schema: 'timmy.operation/1', id, request: `/agent qwen task ${i}`, via: 'repl', project: 'p', started: iso(now - (N_OPS - i) * 60_000),
        ended: ended ? iso(now - (N_OPS - i) * 60_000 + 30_000) : null, state: ended ? 'succeeded' : 'running', parent: null, runs: [], owner,
      }, null, 2));
    }
    for (let k = 0; k < N_NATIVE; k++) {
      const run = randomUUID();
      const job = `j${hex(0x100000 + k, 6)}`;
      write(`.timmy/native/${run}/job.json`, JSON.stringify({ record: 'timmy-native-run', v: 1, app: 'blender', run, program: 'blender', label: `blender scene ${k}`, project: 'p', args: [], expect: [], pre: {}, started_at: iso(now - k * 90_000), operation: ops[k] }));
      write(`.timmy/native/${run}/started.json`, JSON.stringify({ job, started_at: iso(now - k * 90_000) }));
      write(`.timmy/native/${run}/verdicts.jsonl`, `${JSON.stringify({ judged_at: iso(now - k * 90_000 + 20_000), job, outcome: k % 5 === 0 ? 'failed' : 'ok', why: 'as recorded', exit: { state: 'completed', code: 0 }, files: [] })}\n`);
    }
    // 10 jobs running in the live process (their group is it, so their records are not stale), 40 ended.
    for (let j = 0; j < 50; j++) {
      const id = `j${hex(0x200000 + j, 6)}`;
      const running = j < 10;
      fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify({
        id, kind: 'task', label: `agent qwen a${hex(j, 8)}: task ${j}`, project: 'p', root, command: 'sleep', args: ['1'], state: running ? 'running' : 'completed',
        pid: foreign.pid, startedAt: iso(now - j * 120_000), ...(running ? {} : { endedAt: iso(now - j * 120_000 + 5000), exitCode: 0 }), steps: [], lines: 0,
        owner: { pid: owner.pid, startedAt: owner.started }, operation: ops[j],
      }));
    }
    for (let r = 0; r < 200; r++) appendReceipt('runs', { kind: 'note', subject: `note ${r}`, policy: 'human-gated', status: 'ok' } as ReceiptInput, root);
    ws = new Workspace({
      glyphs: glyphSet(true), env: { ...process.env }, onPath: () => null, notify: () => {}, openWeb: (u) => u, link: (t) => t,
      seal: (input) => appendReceipt('runs', input, root).hash.slice(7, 15), receipts: () => readChain('runs', root), jobsDir, chdir: () => {},
      recoverAtStart: false, roomTools: async () => [],
    }, folderProject(root));
    await ws.boardLive('live');
    const lb = ws.liveBoard!;
    port = lb.port;
    token = lb.url.split('#t=')[1];
  }, 120_000);

  afterAll(async () => {
    await ws?.close();
    restore();
    vi.unstubAllEnvs();
    foreign?.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('GET /state: one reading of the process table a build, in a few seconds at most (b8fcd54: 4,154 ps runs, about 32 s)', async () => {
    // judgeIndex is the only reader of verdicts.jsonl through the fs object (src/room/judge.ts); each build read it three times
    const verdictReads = vi.spyOn(fs, 'readFileSync');
    try {
      for (let i = 0; i < 2; i++) {
        verdictReads.mockClear();
        const b = await build('/state');
        expect(b.status, b.body).toBe(200);
        expect(b.seam).toEqual({ all: 1, one: 0 });
        expect(b.onPath).toBe(1);
        expect(b.ms).toBeLessThan(10_000);
        // the project's judgements read once a build (each native run's verdicts once), not three times
        const reads = verdictReads.mock.calls.filter((a) => String(a[0]).endsWith('verdicts.jsonl')).length;
        expect(reads).toBe(N_NATIVE);
      }
    } finally { verdictReads.mockRestore(); }
  }, 120_000);

  it("GET /overview: the same; the newest 50 open operations checked and the rest counted; the chain head verified once, again only when it changes", async () => {
    const a = await build('/overview');
    expect(a.status, a.body).toBe(200);
    expect(a.seam).toEqual({ all: 1, one: 0 });
    expect(a.ms).toBeLessThan(10_000);
    const o1 = JSON.parse(a.body) as Overview;
    const open = N_OPS - Math.ceil(N_OPS / 6);
    expect(o1.history.operations).toEqual({ recorded: N_OPS, running: 50, left: 0, unchecked: open - 50 });
    expect(o1.history.counts.map((n) => `${n.n} ${n.of}`)).toContain(`${open - 50} older operations whose records say they run, not checked here (the newest 50 were)`);
    const head1 = o1.history.head!;
    expect(head1.verified).toBe(true);
    expect(head1.words).toMatch(/^verified at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC: every link of its epoch up to it, each body hash and its signature \(verifyReceiptIn; checked again when the chain has a new head; timmy verify checks the whole chain\)$/);
    // The same head on a later build: the same check (its time, to the millisecond), not a new one.
    await sleep(30);
    const o2 = JSON.parse((await build('/overview')).body) as Overview;
    expect(o2.history.head).toEqual(head1);
    // A new head: checked again.
    appendReceipt('runs', { kind: 'note', subject: 'a new head', policy: 'human-gated', status: 'ok' } as ReceiptInput, root);
    await sleep(30);
    const o3 = JSON.parse((await build('/overview')).body) as Overview;
    expect(o3.history.head!.id).not.toBe(head1.id);
    expect(o3.history.head!.verified).toBe(true);
    expect(Date.parse(o3.history.head!.verified_at!)).toBeGreaterThan(Date.parse(head1.verified_at!));
  }, 120_000);
});
