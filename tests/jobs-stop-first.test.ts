/**
 * Round R4 (H62; ledger row 159): a stop's first part (JobSpec.stopFirst). OpenHands' job is a docker client that ends as
 * its container ends; on the Mac its job was killed 2 s after its SIGTERM while docker delivered the container's own
 * signal 5 to 7 s later, so the worker's last line never arrived. A job with a first part has it run before any signal,
 * then its group gets a bounded wait to end by itself, its output kept; only a group still there is then signalled.
 *
 * Real child processes, real signals and the real JobManager. The "client" here is a small node program standing in for
 * docker's client: it goes on after a SIGTERM (as docker's signal proxy does) and ends when a marker file appears (what
 * it follows has ended), printing its last line. The first part writes that marker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobManager, type JobSpec, type StopEnding } from '../src/jobs/index.js';

let dir = '';
let managers: JobManager[] = [];
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'timmy-stop-first-')); });
afterEach(async () => {
  await Promise.all(managers.map((m) => m.stopAll()));
  managers = [];
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(20); }
}
/** A client that goes on after SIGTERM and ends (exit 143) with its last line once MARKER exists. */
const FOLLOWS = `const fs=require('fs');process.on('SIGTERM',()=>{console.log('GOT SIGTERM')});console.log('READY');const t=setInterval(()=>{if(fs.existsSync(process.env.MARKER)){clearInterval(t);console.log('LAST LINE (what it followed said as it ended)');process.exitCode=143}},20)`;
/** A client that ends on SIGTERM. */
const ENDS_ON_TERM = `process.on('SIGTERM',()=>{console.log('GOT SIGTERM');process.exit(0)});console.log('READY');setInterval(()=>{},1000)`;
/** A client that ignores SIGTERM. */
const IGNORES_TERM = `process.on('SIGTERM',()=>{console.log('GOT SIGTERM')});console.log('READY');setInterval(()=>{},1000)`;

function job(script: string, first?: JobSpec['stopFirst'], extra: Partial<JobSpec> = {}) {
  const m = new JobManager({ dir: path.join(dir, 'jobs') });
  managers.push(m);
  const marker = path.join(dir, 'ended');
  const j = m.start({ kind: 'task', label: 'a client', project: 'stop-first', root: dir, command: process.execPath, args: ['-e', script], env: { MARKER: marker }, ...(first ? { stopFirst: first } : {}), ...extra });
  return { m, id: j.id, marker };
}
const ready = (m: JobManager, id: string): Promise<void> => until(() => m.tail(id).includes('READY'));

describe('a stop\'s first part (JobSpec.stopFirst), before any signal to the job\'s group', () => {
  it('runs first; the group then ends by itself, its last line kept, and no signal was sent', async () => {
    const told: StopEnding[] = [];
    let marker = '';
    const { m, id, marker: file } = job(FOLLOWS, { answerMs: 5000, exitMs: 5000, run: async (ending) => { told.push(ending); await sleep(300); writeFileSync(marker, ''); } });
    marker = file;
    await ready(m, id);
    const t0 = Date.now();
    const done = await m.stop(id);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(told).toEqual([{ state: 'cancelled' }]);
    expect(done).toMatchObject({ state: 'cancelled', exitCode: 143, cleanup: 'complete', stopOrder: { first: 'answered', group: 'ended by itself' } });
    const log = m.tail(id);
    expect(log).toContain('LAST LINE (what it followed said as it ended)');
    expect(log).not.toContain('GOT SIGTERM');
    // the record as written says the same
    expect(new JobManager({ dir: path.join(dir, 'jobs') }).get(id)).toMatchObject({ state: 'cancelled', stopOrder: { first: 'answered', group: 'ended by itself' } });
  });

  it('a group still there after its wait gets SIGTERM, then SIGKILL after the grace; the record says which', async () => {
    const a = job(ENDS_ON_TERM, { answerMs: 1000, exitMs: 200, run: async () => undefined });
    await ready(a.m, a.id);
    expect(await a.m.stop(a.id)).toMatchObject({ state: 'cancelled', stopOrder: { first: 'answered', group: 'SIGTERM' } });
    expect(a.m.tail(a.id)).toContain('GOT SIGTERM');
    const b = job(IGNORES_TERM, { answerMs: 1000, exitMs: 200, run: async () => undefined });
    await ready(b.m, b.id);
    expect(await b.m.stop(b.id, 300)).toMatchObject({ state: 'cancelled', signal: 'SIGKILL', cleanup: 'complete', stopOrder: { first: 'answered', group: 'SIGKILL' } });
  });

  it('a first part that never answers is waited for only answerMs; the group is then stopped as before', async () => {
    const { m, id } = job(ENDS_ON_TERM, { answerMs: 300, exitMs: 100, run: () => new Promise(() => {}) });
    await ready(m, id);
    const t0 = Date.now();
    expect(await m.stop(id)).toMatchObject({ state: 'cancelled', stopOrder: { first: 'no answer', group: 'SIGTERM' } });
    expect(Date.now() - t0).toBeLessThan(3000);
    // a first part that throws counts as answered; the stop goes on
    const t = job(ENDS_ON_TERM, { answerMs: 1000, exitMs: 100, run: () => { throw new Error('a first part that throws'); } });
    await ready(t.m, t.id);
    expect(await t.m.stop(t.id)).toMatchObject({ state: 'cancelled', stopOrder: { first: 'answered', group: 'SIGTERM' } });
  });

  it('a time limit kept outside the job (timeOut) and the job\'s own limit both run the first part, told the job timed out', async () => {
    const told: StopEnding[] = [];
    let marker = '';
    const first = { answerMs: 5000, exitMs: 5000, run: async (ending: StopEnding) => { told.push(ending); writeFileSync(marker, ''); } };
    const a = job(FOLLOWS, first);
    marker = a.marker;
    await ready(a.m, a.id);
    expect(await a.m.timeOut(a.id)).toMatchObject({ state: 'failed', error: 'timed out', exitCode: 143, stopOrder: { first: 'answered', group: 'ended by itself' } });
    expect(a.m.tail(a.id)).toContain('LAST LINE (what it followed said as it ended)');
    rmSync(marker, { force: true });
    const b = job(FOLLOWS, first, { timeoutMs: 600 });
    expect(existsSync(b.marker)).toBe(false);
    const ended = await b.m.done(b.id);
    expect(ended).toMatchObject({ state: 'failed', error: 'timed out', stopOrder: { first: 'answered', group: 'ended by itself' } });
    expect(told).toEqual([{ state: 'failed', error: 'timed out' }, { state: 'failed', error: 'timed out' }]);
    // a second stop while the first is under way joins it: the first part runs once
    rmSync(marker, { force: true });
    let runs = 0;
    const c = job(FOLLOWS, { answerMs: 5000, exitMs: 5000, run: async () => { runs += 1; await sleep(200); writeFileSync(marker, ''); } });
    await ready(c.m, c.id);
    const [x, y] = await Promise.all([c.m.stop(c.id), c.m.timeOut(c.id)]);
    expect(runs).toBe(1);
    expect(x).toMatchObject({ state: 'cancelled' });
    expect(y).toMatchObject({ state: 'cancelled' });
  });

  it('a job without a first part is stopped as before, with no stopOrder; a first part without its bounds is refused', async () => {
    const { m, id } = job(ENDS_ON_TERM);
    await ready(m, id);
    const done = await m.stop(id);
    expect(done).toMatchObject({ state: 'cancelled', cleanup: 'complete' });
    expect(done).not.toHaveProperty('stopOrder');
    expect(() => job(ENDS_ON_TERM, { run: async () => undefined } as unknown as JobSpec['stopFirst'])).toThrow('stopFirst needs run, answerMs and exitMs');
  });
});
