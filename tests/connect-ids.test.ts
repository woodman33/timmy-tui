/**
 * Round R4 (helper H90): a remote job's id drawn again. An id is "r" and 8 hex digits (32 random bits), and a job's folder on
 * the device outlives its local record (another Timmy home, a record removed), so a new job can draw an id whose folder is
 * there already. The device then answers "id-taken" (its folder holds another job: its owner file says so, or, for a folder
 * from before owner files, its script's sha256), Timmy draws a new id and says so; a retry of a record whose id is taken
 * starts nothing. The ids drawn here are fixed (node:crypto's randomBytes, mocked for 4-byte draws only); the rest is as in
 * tests/connect-ssh.test.ts: FAKE OpenSSH programs, and real processes and files in a temporary folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDevice } from '../src/connect/devices.js';
import { scanDevice, trustKey } from '../src/connect/hostkeys.js';
import { readJob, reconcileJob, retryJob, runJob } from '../src/connect/jobs.js';
import { probeDevice } from '../src/connect/probe.js';
import { connectPaths, type ConnectPaths } from '../src/connect/store.js';
import type { RemoteJobRecord } from '../src/connect/types.js';
import { makeKit, until, type Kit } from './fixtures/connect/kit.js';

const draws = vi.hoisted(() => [] as string[]);
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = ((n: number, ...rest: unknown[]) => (n === 4 && draws.length ? Buffer.from(draws.shift()!, 'hex') : (real.randomBytes as (...a: unknown[]) => Buffer)(n, ...rest))) as typeof real.randomBytes;
  return { ...real, randomBytes, default: { ...real, randomBytes } };
});

let kit: Kit;
let p: ConnectPaths;
beforeEach(() => {
  kit = makeKit('h90-ids-');
  kit.stub((k, v) => { vi.stubEnv(k, v as string); });
  p = connectPaths(kit.home);
  draws.length = 0;
});
afterEach(() => { vi.unstubAllEnvs(); kit.cleanup(); });

async function ready(port: number): Promise<{ id: string; home: string }> {
  const h = kit.addHost(port);
  expect(addDevice(p, { id: 'dev', address: h.address, port: h.port, user: h.user, identity: kit.key.file }).problems).toEqual([]);
  const scan = await scanDevice(p, 'dev');
  if ('error' in scan) throw new Error(scan.error);
  expect(trustKey(p, 'dev', scan.keys[0].fingerprint, 'cli').ok).toBe(true);
  const probe = await probeDevice(p, 'dev');
  if ('error' in probe) throw new Error(probe.error);
  expect(probe.probe.outcome, probe.probe.words).toBe('connected');
  return { id: 'dev', home: h.home };
}
async function ended(id: string): Promise<RemoteJobRecord> {
  return until(async () => { const r = await reconcileJob(p, id); return !('error' in r) && r.job.state === 'ended' ? r.job : undefined; }, 30_000, `job ${id} to end`);
}
const folder = (home: string, id: string): string => path.join(home, '.timmy-connect', 'jobs', id);

describe('a remote job id drawn again', () => {
  it('a folder on the device holding another job (even the same command) is not taken for a new one: a new id is drawn, and the words say so', async () => {
    const { id, home } = await ready(2281);
    const command = ['sh', '-c', 'echo ran >> "$HOME/ran.txt"'];
    draws.push('0badc0de');
    const a = await runJob(p, id, { command });
    if ('error' in a) throw new Error(a.error);
    expect(a.job.id).toBe('r0badc0de');
    await ended(a.job.id);
    const before = fs.readFileSync(path.join(folder(home, 'r0badc0de'), 'status'), 'utf8');
    // its local record goes (as in another Timmy home, or one reset); the folder on the device stays
    fs.unlinkSync(path.join(p.jobs, 'r0badc0de.json'));
    draws.push('0badc0de', '0ddba11e');
    const b = await runJob(p, id, { command });
    if ('error' in b) throw new Error(b.error);
    expect(b.job.id).toBe('r0ddba11e');
    expect(b.words).toMatch(/the id r0badc0de was taken on dev by another job's folder \(left as it is\): this job is r0ddba11e/);
    expect(b.job.events.map((e) => e.what).join('\n')).toMatch(/r0badc0de was taken on dev/);
    await ended(b.job.id);
    // both ran, once each; the older folder is as it was, and no record of the taken id was kept
    expect(fs.readFileSync(path.join(home, 'ran.txt'), 'utf8')).toBe('ran\nran\n');
    expect(fs.readFileSync(path.join(folder(home, 'r0badc0de'), 'status'), 'utf8')).toBe(before);
    expect(readJob(p, 'r0badc0de')).toBeUndefined();
    expect(fs.existsSync(path.join(p.jobs, 'r0badc0de.script'))).toBe(false);
  }, 90_000);

  it('a folder from before owner files: its script\'s sha256 decides; a retry of a record whose id is taken starts nothing and says so', async () => {
    const { id, home } = await ready(2282);
    draws.push('0000aaaa');
    const a = await runJob(p, id, { command: ['sh', '-c', 'echo first >> "$HOME/ran.txt"'] });
    if ('error' in a) throw new Error(a.error);
    await ended(a.job.id);
    // as a folder made before owner files were written: none in it
    fs.unlinkSync(path.join(folder(home, 'r0000aaaa'), 'owner'));
    fs.unlinkSync(path.join(p.jobs, 'r0000aaaa.json'));
    draws.push('0000aaaa', '0000bbbb');
    const b = await runJob(p, id, { command: ['sh', '-c', 'echo second >> "$HOME/ran.txt"'] });
    if ('error' in b) throw new Error(b.error);
    expect(b.job.id).toBe('r0000bbbb');
    await ended(b.job.id);
    expect(fs.readFileSync(path.join(home, 'ran.txt'), 'utf8')).toBe('first\nsecond\n');
    // a record whose submission never got through, and meanwhile another job's folder (another Timmy's) took its id there
    kit.update(2282, (h) => { h.mode = 'refused'; });
    draws.push('0000cccc');
    const c = await runJob(p, id, { command: ['sh', '-c', 'echo third >> "$HOME/ran.txt"'] });
    if ('error' in c) throw new Error(c.error);
    expect(c.job).toMatchObject({ id: 'r0000cccc', state: 'submitted' });
    fs.mkdirSync(path.join(folder(home, 'r0000cccc'), 'claim'), { recursive: true });
    fs.writeFileSync(path.join(folder(home, 'r0000cccc'), 'owner'), `${'e'.repeat(32)}\n`);
    kit.update(2282, (h) => { h.mode = 'up'; });
    // a status read says the folder there is another job's (never "claimed" as if it were this one's)
    const read = await reconcileJob(p, 'r0000cccc');
    if ('error' in read) throw new Error(read.error);
    expect(read.job.state).toBe('submitted');
    expect(read.words).toMatch(/the folder for its id there holds another job/);
    const again = await retryJob(p, 'r0000cccc');
    if ('error' in again) throw new Error(again.error);
    expect(again.refused).toMatch(/^not started: the id r0000cccc is taken on dev by another job's folder/);
    expect(again.job.state).toBe('submitted');
    expect(fs.readFileSync(path.join(home, 'ran.txt'), 'utf8')).toBe('first\nsecond\n');
    expect(fs.readdirSync(folder(home, 'r0000cccc')).sort()).toEqual(['claim', 'owner']);
  }, 90_000);
});
