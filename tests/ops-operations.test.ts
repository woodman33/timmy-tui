/**
 * Round R4 (H51): operations' pieces on their own: the id and its scope (what is stamped, what is inherited, what a job's
 * process is given), how an operation's state is decided from its runs, the log's lifecycle (a record only once it starts or
 * seals something; joined only while the operation it names runs; an id it cannot join is its parent), the record's own
 * checks, and how each kind of run's record is read as an outcome. Real files in temporary folders; the runs here are
 * SYNTHETIC (a live flag and an outcome the test sets), since the end-to-end tests (ops-operation, ops-act) run real ones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentOperation, inOperation, inOperationId, jobEnvironment, newOperationId, OPERATION_ENV, OPERATION_ID, openScope, operationField, stampReceipt, type OperationScope } from '../src/ops/context.js';
import { decideState, OperationLog, operationRel, parseOperationRecord, readOperationRecord, writeOperationRecord, type OperationRecord, type OperationRun, type RunOutcome } from '../src/ops/operations.js';
import { flowClaims, flowOutcome, jobOutcome, voxOutcome } from '../src/ops/outcome.js';
import { elapsedSeconds, THIS_PROCESS, writerState } from '../src/ops/process-proof.js';
import type { JobRecord } from '../src/jobs/index.js';

const dirs: string[] = [];
const temp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-unit-'))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe('the operation id and its scope', () => {
  it('ids are o and 8 hex digits; the scope is inherited through awaits and timers, and nothing outside one is stamped', async () => {
    const id = newOperationId();
    expect(id).toMatch(OPERATION_ID);
    expect(currentOperation()).toBeUndefined();
    expect(operationField('job', 'j000001')).toEqual({});
    expect(stampReceipt({ kind: 'x' })).toEqual({ kind: 'x' });
    const noted: string[] = [];
    let seals = 0;
    const scope: OperationScope = { id, noteRun: (k, r) => noted.push(`${k}:${r}`), noteSeal: () => { seals += 1; } };
    await inOperation(scope, async () => {
      await sleep(1);
      const later = await new Promise<string | undefined>((r) => { setTimeout(() => r(currentOperation()), 5); });
      expect(later).toBe(id);
      expect(operationField('flow', 'f00000001')).toEqual({ operation: id });
      expect(stampReceipt({ kind: 'flow' })).toEqual({ kind: 'flow', operation_id: id });
      // A receipt that names its operation already (a recovery's) keeps it, and is not counted as this one's seal.
      expect(stampReceipt({ kind: 'flow', operation_id: 'o00000001' })).toEqual({ kind: 'flow', operation_id: 'o00000001' });
      expect(inOperation(null, () => currentOperation())).toBeUndefined();
    });
    expect(noted).toEqual(['flow:f00000001']);
    expect(seals).toBe(1);
  });

  it('a job\'s callbacks run in its own operation (its open scope, else one that only names it); its process is given the id, or none', () => {
    const id = newOperationId();
    const noted: string[] = [];
    const close = openScope({ id, noteRun: (k, r) => noted.push(`${k}:${r}`) });
    inOperationId(id, () => { expect(currentOperation()).toBe(id); operationField('vox', 'v00000001'); });
    close();
    inOperationId(id, () => { expect(currentOperation()).toBe(id); operationField('vox', 'v00000002'); });
    expect(noted).toEqual(['vox:v00000001']);
    expect(inOperationId(undefined, () => currentOperation())).toBeUndefined();
    expect(inOperationId('not-an-id', () => currentOperation())).toBeUndefined();
    expect(jobEnvironment({ A: '1', [OPERATION_ENV]: 'o11111111' }, { B: '2' }, id)).toEqual({ A: '1', B: '2', [OPERATION_ENV]: id });
    // A job of no operation never passes one on, even one this process was given.
    expect(jobEnvironment({ A: '1', [OPERATION_ENV]: 'o11111111' }, undefined, undefined)).toEqual({ A: '1' });
  });
});

describe('an operation\'s state, from its runs', () => {
  const run = (kind: OperationRun['kind'], id: string): OperationRun => ({ kind, id, at: '' });
  const out = (state: RunOutcome['state'], words: string, claims?: string[]): RunOutcome => ({ state, words, ...(claims ? { claims } : {}) });
  it('stopped, then failed (an unknown counts as failed), then differs, then refused, then succeeded; a claimed run counts with its claimer', () => {
    expect(decideState([])).toEqual({ state: 'answered', why: 'it started nothing: the request was answered' });
    expect(decideState([], 'refused')).toEqual({ state: 'refused', why: 'it started nothing: the request was refused' });
    expect(decideState([{ run: run('job', 'j000001'), out: out('succeeded', 'completed') }]).state).toBe('succeeded');
    // The flow's own agent job failed, but the flow (which names it) decides: it differs.
    expect(decideState([
      { run: run('flow', 'f00000001'), out: out('differs', 'differs (readback differs)', ['job:j000001']) },
      { run: run('job', 'j000001'), out: out('failed', 'failed') },
    ])).toEqual({ state: 'differs', why: 'flow f00000001 differs (readback differs)' });
    expect(decideState([{ run: run('vox', 'v00000001'), out: out('unknown', 'no record') }]).state).toBe('failed');
    expect(decideState([{ run: run('vox', 'v00000001'), out: out('refused', 'needs-setup') }, { run: run('job', 'j000002'), out: out('succeeded', 'completed') }]).state).toBe('refused');
    expect(decideState([{ run: run('job', 'j000001'), out: out('failed', 'failed') }, { run: run('job', 'j000002'), out: out('stopped', 'stopped') }]).state).toBe('stopped');
  });

  it('each record kind read as an outcome: a flow and the runs it names, a VoxVision record and its tool jobs, a job', () => {
    const flow = { outcome: 'differs', readback: { verdict: 'differs' }, ended_in: 'readback', agent: { run: 'a1b2c3d4e', job: 'j0a0b0c' }, openscad: { run: '0f0e0d0c-1111-4222-8333-444455556666', job: 'j1a1b1c' }, readback_job: { job: 'not-a-job' } };
    expect(flowClaims(flow).sort()).toEqual(['agent:a1b2c3d4e', 'job:j0a0b0c', 'job:j1a1b1c', 'native:0f0e0d0c-1111-4222-8333-444455556666'].sort());
    expect(flowOutcome(flow)).toMatchObject({ state: 'differs', words: 'differs (readback differs), ended in its readback step' });
    expect(flowOutcome({ outcome: 'cancelled' }).state).toBe('stopped');
    expect(flowOutcome({ outcome: 'interrupted' }).state).toBe('stopped');
    expect(flowOutcome({ outcome: 'stopped', ended_in: 'checks' }).state).toBe('failed');
    expect(flowOutcome({ outcome: 'weird' }).state).toBe('unknown');
    expect(voxOutcome({ status: 'ok', tools: [{ job: { id: 'j123abc' } }] })).toEqual({ state: 'succeeded', words: 'ok', claims: ['job:j123abc'] });
    expect(voxOutcome({ status: 'needs-setup' }).state).toBe('refused');
    expect(voxOutcome({ status: 'untrusted' }).state).toBe('failed');
    expect(voxOutcome({ status: 'cancelled' }).state).toBe('stopped');
    const job = (j: Partial<JobRecord>): JobRecord => ({ id: 'j000001', kind: 'task', label: 'x', project: 'p', root: '/x', command: 'c', args: [], state: 'completed', startedAt: '', steps: [], logPath: '', lines: 0, ...j });
    expect(jobOutcome(undefined).state).toBe('unknown');
    expect(jobOutcome(job({})).state).toBe('succeeded');
    expect(jobOutcome(job({ state: 'failed', error: 'exit 3' }))).toEqual({ state: 'failed', words: 'failed: exit 3' });
    expect(jobOutcome(job({ state: 'cancelled' })).state).toBe('stopped');
    expect(jobOutcome(job({ state: 'running', stale: true })).state).toBe('stopped');
    expect(jobOutcome(job({ state: 'running' })).state).toBe('running');
  });
});

describe('the operation log: records, joining, ending', () => {
  /** A log over SYNTHETIC runs: which run still runs, and how each ended, are set by the test. */
  function log() {
    const live = new Set<string>();
    const outcomes = new Map<string, RunOutcome>();
    const ops = new OperationLog({
      scrub: (t, root) => t.split(root).join('.'),
      live: (r) => live.has(`${r.kind}:${r.id}`),
      outcome: (r) => outcomes.get(`${r.kind}:${r.id}`) ?? { state: 'unknown', words: 'no record' },
    });
    return { ops, live, outcomes };
  }

  it('a request that starts nothing leaves no record; one that starts a run is recorded at once and ends by its run', async () => {
    const root = temp();
    const { ops, live, outcomes } = log();
    const quiet = ops.begin({ request: '/jobs', via: 'repl', root, project: 'p' });
    await ops.run(quiet, () => 'listed');
    expect(quiet.ended).toMatchObject({ state: 'answered' });
    expect(fs.existsSync(path.join(root, operationRel(quiet.id)))).toBe(false);

    const busy = ops.begin({ request: `/iterate tray "x" in ${root}`, via: 'repl', root, project: 'p' });
    await ops.run(busy, () => { live.add('flow:f00000001'); operationField('flow', 'f00000001'); });
    const running = readOperationRecord(root, busy.id);
    expect(running).toMatchObject({ ok: true, record: { state: 'running', ended: null, request: '/iterate tray "x" in .', runs: [{ kind: 'flow', id: 'f00000001' }], owner: { pid: THIS_PROCESS.pid, started: THIS_PROCESS.started } } });
    expect(ops.live(busy)).toBe(true);
    live.delete('flow:f00000001');
    outcomes.set('flow:f00000001', { state: 'succeeded', words: 'succeeded' });
    await ops.done(busy);
    expect(readOperationRecord(root, busy.id)).toMatchObject({ ok: true, record: { state: 'succeeded', why: 'flow f00000001 succeeded' } });
    ops.closeAll();
  });

  it('a seal alone records it; a stop under way ends it stopped with its why first; closing ends what is open as stopped', async () => {
    const root = temp();
    const { ops, live, outcomes } = log();
    const sealed = ops.begin({ request: '/note', via: 'board', root, project: 'p' });
    await ops.run(sealed, () => { stampReceipt({ kind: 'edit' }); });
    await sleep(80);
    expect(sealed.seals).toBe(1);
    expect(readOperationRecord(root, sealed.id)).toMatchObject({ ok: true, record: { state: 'answered', via: 'board' } });

    const stopped = ops.begin({ request: '/agent qwen x', via: 'act', root, project: 'p', record: true });
    await ops.run(stopped, () => { live.add('agent:a00000001'); operationField('agent', 'a00000001'); });
    ops.stopping(stopped, 'SIGTERM received');
    live.delete('agent:a00000001');
    outcomes.set('agent:a00000001', { state: 'stopped', words: 'cancelled' });
    ops.check();
    expect(stopped.ended).toMatchObject({ state: 'stopped', why: 'SIGTERM received; agent a00000001 cancelled' });

    const open = ops.begin({ request: '/run W.md x', via: 'repl', root, project: 'p' });
    await ops.run(open, () => { live.add('job:j000009'); operationField('job', 'j000009'); });
    ops.closeAll();
    expect(readOperationRecord(root, open.id)).toMatchObject({ ok: true, record: { state: 'stopped', why: 'this Timmy ended before it did' } });
  });

  it('joins an operation this project holds while it runs (its record stays its first process\'s); an ended or a stale one is the parent of a new one', async () => {
    const root = temp();
    const first = log();
    const a = first.ops.begin({ request: '/run W.md result', via: 'repl', root, project: 'p', record: true });
    const before = fs.readFileSync(path.join(root, operationRel(a.id)), 'utf8');
    const second = log();
    const joined = second.ops.begin({ request: '/op', via: 'act', root, project: 'p', join: a.id, record: true });
    expect(joined).toMatchObject({ id: a.id, joined: true, parent: null });
    await second.ops.run(joined, () => { second.live.add('job:j000001'); operationField('job', 'j000001'); });
    second.live.delete('job:j000001');
    second.outcomes.set('job:j000001', { state: 'succeeded', words: 'completed' });
    await second.ops.done(joined);
    expect(joined.ended?.state).toBe('succeeded');
    // The joined process never wrote the record.
    expect(fs.readFileSync(path.join(root, operationRel(a.id)), 'utf8')).toBe(before);

    // Ended: not joined; it is the parent.
    first.ops.end(a, 'succeeded', 'done');
    const after = log().ops.begin({ request: '/op', via: 'act', root, project: 'p', join: a.id, record: true });
    expect(after).toMatchObject({ joined: false, parent: a.id });
    expect(after.id).not.toBe(a.id);
    expect(readOperationRecord(root, after.id)).toMatchObject({ ok: true, record: { parent: a.id, state: 'running', via: 'act' } });

    // A record that says it runs, written by a process that is gone: stale, never joined.
    const stale: OperationRecord = { schema: 'timmy.operation/1', id: 'o0000aaaa', request: '/x', via: 'repl', project: 'p', started: new Date().toISOString(), ended: null, state: 'running', parent: null, runs: [], owner: { pid: THIS_PROCESS.pid, started: '2001-01-01T00:00:00.000Z' } };
    expect(writeOperationRecord(root, stale)).toEqual({ ok: true, rel: operationRel('o0000aaaa') });
    expect(writerState(stale.owner)).toBe('gone');
    expect(log().ops.begin({ request: '/op', via: 'act', root, project: 'p', join: 'o0000aaaa' })).toMatchObject({ joined: false, parent: 'o0000aaaa' });
    // An id this project has no record of: the parent too.
    expect(log().ops.begin({ request: '/op', via: 'act', root, project: 'p', join: 'o0000bbbb' })).toMatchObject({ joined: false, parent: 'o0000bbbb' });
    first.ops.closeAll();
  });
});

describe('the operation record\'s own checks', () => {
  it('reads a record field by field and names what is wrong; writes never through a link', () => {
    const ok = { schema: 'timmy.operation/1', id: 'o12345678', request: '/x', via: 'act', project: 'p', started: 't', ended: null, state: 'running', parent: null, runs: [{ kind: 'job', id: 'j000001', at: 't' }, 'junk'], owner: { pid: 2, started: 't' } };
    expect(parseOperationRecord(ok)).toMatchObject({ ok: true, record: { runs: [{ kind: 'job', id: 'j000001', at: 't' }] } });
    expect(parseOperationRecord({ ...ok, schema: 'x' })).toEqual({ ok: false, error: 'its schema is not timmy.operation/1' });
    expect(parseOperationRecord(ok, 'o87654321')).toEqual({ ok: false, error: 'its id is not this operation\'s' });
    expect(parseOperationRecord({ ...ok, state: 'great' })).toEqual({ ok: false, error: 'its state "great" is not one Timmy writes' });
    expect(parseOperationRecord({ ...ok, via: 'phone' })).toEqual({ ok: false, error: 'it does not say where its request came from' });
    expect(parseOperationRecord({ ...ok, parent: '../x' })).toEqual({ ok: false, error: 'its parent is not an operation id' });
    expect(parseOperationRecord([])).toEqual({ ok: false, error: 'not a JSON object' });
    const root = temp();
    const elsewhere = temp();
    fs.mkdirSync(path.join(root, '.timmy'));
    fs.symlinkSync(elsewhere, path.join(root, '.timmy', 'operations'));
    expect(writeOperationRecord(root, ok as unknown as OperationRecord)).toEqual({ ok: false, error: '.timmy/operations is a symbolic link; Timmy writes its records only in place' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(readOperationRecord(root, '../../x')).toMatchObject({ ok: false, error: '../../x is not an operation id (o and 8 hex digits)' });
    expect([elapsedSeconds('05'), elapsedSeconds('01:05'), elapsedSeconds('02:01:05'), elapsedSeconds('3-02:01:05')]).toEqual([undefined, 65, 7265, 266465]);
  });
});
