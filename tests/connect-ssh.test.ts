/**
 * Round R4 (helper H90): Timmy Connect against FAKE OpenSSH programs. This container has no OpenSSH, so `ssh`,
 * `ssh-keyscan` and `ssh-keygen` are FAKE stand-ins (tests/fixtures/connect/fake-*.mjs, first on PATH) that follow
 * OpenSSH's argument rules and refusals for the options Timmy uses and answer from a FAKE network file. What a FAKE device
 * runs runs for real here: /bin/sh in the device's "remote home" (a temporary folder), with real child processes, process
 * groups, signals and files; killing a local ssh drops its "connection" as a dropped one would. Everything else is Timmy's
 * own code: the records, the scripts it sends, the receipts chain. A test with the real ssh and sshd is
 * tests/connect-real-ssh.test.ts (it runs only where both exist and TIMMY_TEST_REAL_SSH=1).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDevice } from '../src/connect/devices.js';
import { fingerprintOf, scanDevice, trustKey } from '../src/connect/hostkeys.js';
import { fetchFile, jobFile, readJob, reconcileJob, retryJob, runJob, stopJob } from '../src/connect/jobs.js';
import { probeDevice } from '../src/connect/probe.js';
import { readConnect } from '../src/connect/read.js';
import { connectPaths, findDevice, type ConnectPaths } from '../src/connect/store.js';
import type { RemoteJobRecord } from '../src/connect/types.js';
import { waitingApprovals, type ApprovalRequest, type Decision } from '../src/repl/approvals.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { glyphSet } from '../src/term/glyphs.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';
import { groupRuns, makeKit, newHostKey, startOf, until, type Kit } from './fixtures/connect/kit.js';

let kit: Kit;
let p: ConnectPaths;
beforeEach(() => {
  kit = makeKit();
  kit.stub((k, v) => { vi.stubEnv(k, v as string); });
  p = connectPaths(kit.home);
});
afterEach(() => { vi.unstubAllEnvs(); kit.cleanup(); });

/** A FAKE device added, its host key fetched and confirmed, and probed: ready for jobs. */
async function ready(port: number, o: Parameters<Kit['addHost']>[1] = {}, id = 'dev'): Promise<{ id: string; home: string }> {
  const h = kit.addHost(port, o);
  const added = addDevice(p, { id, address: h.address, port: h.port, user: h.user, identity: kit.key.file });
  expect(added.problems).toEqual([]);
  const scan = await scanDevice(p, id);
  if ('error' in scan) throw new Error(scan.error);
  expect(trustKey(p, id, scan.keys[0].fingerprint, 'cli').ok).toBe(true);
  const probe = await probeDevice(p, id);
  if ('error' in probe) throw new Error(probe.error);
  expect(probe.probe.outcome, probe.probe.words).toBe('connected');
  return { id, home: h.home };
}

const jobDir = (home: string, id: string): string => path.join(home, '.timmy-connect', 'jobs', id);
const remoteStatus = (home: string, id: string): string => { try { return fs.readFileSync(path.join(jobDir(home, id), 'status'), 'utf8'); } catch { return ''; } };
const pgidOf = (home: string, id: string): number => Number(/^pgid=(\d+)$/m.exec(remoteStatus(home, id))?.[1]);
async function ended(id: string): Promise<RemoteJobRecord> {
  return until(async () => { const r = await reconcileJob(p, id); return !('error' in r) && (r.job.state === 'ended' || r.job.state === 'stopped') ? r.job : undefined; }, 30_000, `job ${id} to end`);
}
const lastJson = (stdout: string): Record<string, any> => JSON.parse(stdout.replace(/\r/g, '').trim().split('\n').at(-1)!) as Record<string, any>;
/** A job's local record written by hand (a job folder made here by hand, or a record changed as a test needs). */
const writeRecord = (j: RemoteJobRecord): void => {
  fs.mkdirSync(p.jobs, { recursive: true, mode: 0o700 });
  fs.writeFileSync(jobFile(p, j.id), `${JSON.stringify(j, null, 2)}\n`, { mode: 0o600 });
};
const hasPython = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim().startsWith('/');

describe('host keys: fetched, shown, trusted only when a person confirms the exact fingerprint', () => {
  it.skipIf(!hasPython)('adding fetches the keys and trusts none; a wrong fingerprint is refused; the exact one, typed at a terminal, is pinned under the device\'s own name, with a receipt', async () => {
    const h = kit.addHost(2201);
    const add = await kit.cli(['add', 'dev', `${h.user}@${h.address}`, '--port', '2201', '--key', kit.key.file, '--json']);
    expect(add.code, add.stdout + add.stderr).toBe(0);
    const j = lastJson(add.stdout);
    const fp = fingerprintOf(h.keys[0].blob);
    expect(j.scan.keys).toEqual([{ type: 'ED25519', fingerprint: fp }]);
    expect(j.device.host_key).toBeNull();
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toBe('');
    // the CLI's trust, at a terminal (a pseudo-terminal here, as a person's terminal is one)
    const trust = async (args: string[]): Promise<{ code: number | null; output: string }> => (await kit.cliInTerminal(['trust', ...args]))!;
    // a well-formed fingerprint that is not the fetched one: refused, nothing written
    const other = fingerprintOf(newHostKey().blob);
    const wrong = await trust(['dev', other, '--json']);
    expect(wrong.code, wrong.output).toBe(1);
    expect(lastJson(wrong.output).words).toMatch(/is not among the keys fetched from 127\.0\.0\.1:2201 .*nothing was trusted/);
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toBe('');
    // a malformed one, and none at all from the CLI
    expect((await trust(['dev', 'SHA256:short', '--json'])).code).toBe(1);
    expect((await trust(['dev'])).code).toBe(2);
    const right = await trust(['dev', fp, '--json']);
    expect(right.code, right.output).toBe(0);
    expect(lastJson(right.output).device.host_key).toMatchObject({ type: 'ED25519', fingerprint: fp });
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toBe(`timmy-dev ssh-ed25519 ${h.keys[0].blob}\n`);
    expect(fs.statSync(p.knownHosts).mode & 0o777).toBe(0o600);
    expect(fs.statSync(p.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(p.devices).mode & 0o777).toBe(0o600);
    const sealed = readChain('runs').filter((r) => r.kind === 'remote-trust');
    expect(sealed.map((r) => r.subject)).toEqual([`remote-trust · dev · ED25519 ${fp}`]);
    expect(verifyChain('runs').ok).toBe(true);
  }, 60_000);

  it('the CLI\'s trust needs a person at a terminal: from a pipe (a script, an agent\'s command) nothing is pinned; add hands out no fingerprint to paste', async () => {
    const h = kit.addHost(2203);
    const add = await kit.cli(['add', 'dev', `${h.user}@${h.address}`, '--port', '2203', '--key', kit.key.file]);
    expect(add.code, add.stdout + add.stderr).toBe(0);
    const fp = fingerprintOf(h.keys[0].blob);
    expect(add.stdout).toContain(fp);
    // the next step asks the person to read the fingerprint on the computer itself: no ready command holds the fetched one
    const next = add.stdout.split('\n').filter((l) => l.includes('timmy connect trust dev'));
    expect(next).toHaveLength(1);
    expect(next[0]).not.toContain(fp);
    expect(next[0]).toMatch(/on the computer itself/);
    const piped = await kit.cli(['trust', 'dev', fp, '--json']);
    expect(piped.code, piped.stdout + piped.stderr).toBe(1);
    expect(lastJson(piped.stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/needs a person at a terminal .*nothing was trusted/) });
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toBe('');
    expect(findDevice(p, 'dev').device!.host_key).toBeNull();
    expect(readChain('runs').filter((r) => r.kind === 'remote-trust')).toEqual([]);
  }, 60_000);

  it('a host key that changes is refused by ssh, recorded as needing a person, and never re-pinned by Timmy', async () => {
    const { id } = await ready(2202);
    const pinned = fs.readFileSync(p.knownHosts, 'utf8');
    const fresh = newHostKey();
    kit.update(2202, (h) => { h.keys = [fresh]; });
    const r = await probeDevice(p, id);
    if ('error' in r) throw new Error(r.error);
    expect(r.probe.outcome).toBe('host-key-changed');
    expect(r.failure?.offered).toBe(fingerprintOf(fresh.blob));
    expect(r.ssh).toMatch(/REMOTE HOST IDENTIFICATION HAS CHANGED/);
    expect(r.probe.words).toMatch(/Timmy does not replace a confirmed key/);
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toBe(pinned);
    const d = findDevice(p, id).device!;
    expect(d.host_key_refused?.offered).toBe(fingerprintOf(fresh.blob));
    expect(readConnect(kit.home).devices[0].needs.join(' ')).toMatch(/its host key changed .*Timmy refuses it/);
    // nothing is sent to it while its key is refused
    const run = await runJob(p, id, { command: ['true'] });
    expect('error' in run && run.error).toMatch(/^dev's host key changed and Timmy refuses it \(host key changed: .*\); nothing was sent$/);
    // a person fetches the new key and confirms it: only that replaces the pin, and says so
    const scan = await scanDevice(p, id);
    if ('error' in scan) throw new Error(scan.error);
    expect(scan.words).toMatch(/is NOT among them/);
    const t = trustKey(p, id, fingerprintOf(fresh.blob), 'cli');
    expect(t.words).toMatch(/it replaces ED25519 SHA256:/);
    expect(findDevice(p, id).device!.host_key_refused).toBeNull();
    const again = await probeDevice(p, id);
    expect('error' in again ? again.error : again.probe.outcome).toBe('connected');
  }, 60_000);
});

describe('probes: the words and JSON tell each outcome apart', () => {
  it('unreachable (refused, timed out, no route, name not resolved), host key not confirmed, authentication refused, connected', async () => {
    kit.addHost(2210, { mode: 'refused' });
    kit.addHost(22, { mode: 'timeout', address: '192.0.2.10' }); // TEST-NET-1, a documentation address
    kit.addHost(2212, { mode: 'noroute' });
    kit.addHost(2213); // up, never confirmed
    kit.addHost(2214); // up, confirmed, but its key is not authorized for the second identity
    const add = (id: string, address: string, port: number, identity = kit.key.file): void => { expect(addDevice(p, { id, address, port, user: 'tester', identity }).problems).toEqual([]); };
    add('refused', '127.0.0.1', 2210);
    add('slow', '192.0.2.10', 22);
    add('noroute', '127.0.0.1', 2212);
    add('nameless', 'nosuch.invalid', 22);
    add('unconfirmed', '127.0.0.1', 2213);
    add('wrongkey', '127.0.0.1', 2214, kit.otherKey.file);
    const scan = await scanDevice(p, 'wrongkey');
    if ('error' in scan) throw new Error(scan.error);
    trustKey(p, 'wrongkey', scan.keys[0].fingerprint, 'cli');
    const outcome = async (id: string): Promise<[string, string | undefined, string]> => {
      const r = await probeDevice(p, id);
      if ('error' in r) throw new Error(r.error);
      return [r.probe.outcome, r.probe.why, r.probe.words];
    };
    expect(await outcome('refused')).toEqual(['unreachable', 'refused', expect.stringMatching(/^unreachable: 127\.0\.0\.1:2210 refused the connection/)]);
    expect(await outcome('slow')).toEqual(['unreachable', 'timed out', expect.stringMatching(/^unreachable: no answer from 192\.0\.2\.10:22 \(timed out\)/)]);
    expect(await outcome('noroute')).toEqual(['unreachable', 'no route', 'unreachable: no route to 127.0.0.1']);
    expect(await outcome('nameless')).toEqual(['unreachable', 'name not resolved', 'unreachable: the name nosuch.invalid was not resolved']);
    expect(await outcome('unconfirmed')).toEqual(['host-key-unconfirmed', undefined, expect.stringMatching(/^host key not confirmed: Timmy holds no confirmed key for 127\.0\.0\.1:2213/)]);
    expect(await outcome('wrongkey')).toEqual(['auth-refused', undefined, expect.stringMatching(/^authentication refused: 127\.0\.0\.1:2214 did not accept the key .* for tester/)]);
    // ssh's own words are kept beside Timmy's
    const cli = await kit.cli(['probe', 'unconfirmed', '--json']);
    expect(cli.code).toBe(1);
    expect(lastJson(cli.stdout)).toMatchObject({ ok: false, outcome: 'host-key-unconfirmed', ssh: expect.stringMatching(/No ED25519 host key is known for timmy-unconfirmed and you have requested strict checking\.\nHost key verification failed\./) });
  }, 90_000);

  it('connected: what it is, its job folder, how a job detaches, and what is found on its PATH (never "supported")', async () => {
    const { id } = await ready(2220);
    const cli = await kit.cli(['probe', id, '--json']);
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    const j = lastJson(cli.stdout);
    expect(j).toMatchObject({ ok: true, outcome: 'connected', device: { os: 'linux', shell: 'posix' }, facts: { detach: 'setsid', job_folder: 'absent, can be made', found_on_path: expect.arrayContaining(['sh']) } });
    expect(j.words).toMatch(/found on PATH: .*\(found on PATH only: not proven supported or working\)$/);
    expect(j.words.replace('not proven supported or working', '')).not.toMatch(/support|working/);
    // a macOS-like device (no setsid, no sha256sum): a job detaches through perl's setsid
    const mac = await ready(2221, { macLike: true }, 'mac');
    const m = await probeDevice(p, mac.id);
    if ('error' in m) throw new Error(m.error);
    expect(m.probe.facts).toMatchObject({ detach: 'perl', sha256: 'shasum' });
  }, 60_000);
});

describe('remote jobs', () => {
  it('a job detached on the device survives its local ssh being killed during a wait, and status finds it (interrupted connection)', async () => {
    const { id, home } = await ready(2230);
    let cliChild: ChildProcess | undefined;
    const waiting = kit.cli(['run', id, '--wait', '--json', '--', 'sh', '-c', 'echo started; sleep 3; echo finished > done.txt'], { onChild: (c) => { cliChild = c; } });
    // the wait's own ssh: a child of the CLI running the FAKE ssh, in a process group of its own (the submission's is not)
    const ssh = await until(() => {
      const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8' }).stdout;
      return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).find((m) => m && Number(m[2]) === cliChild?.pid && m[1] === m[3] && m[4].includes('fake-ssh.mjs'));
    }, 20_000, 'the wait\'s local ssh');
    process.kill(Number(ssh[1]), 'SIGKILL');
    const done = await waiting;
    expect(done.code, done.stdout + done.stderr).toBe(1);
    const j = lastJson(done.stdout);
    expect(j.end).toBe('dropped');
    expect(j.words).toMatch(/the wait ended without the job's end: .*The remote job was not stopped by Timmy/);
    expect(j.job.state).toBe('unknown');
    // the job ran on; status reads its end from the device
    const end = await ended(j.job.id);
    expect(end.state).toBe('ended');
    expect(end.remote?.exit_status).toBe(0);
    expect(fs.readFileSync(path.join(jobDir(home, j.job.id), 'work', 'done.txt'), 'utf8')).toBe('finished\n');
  }, 90_000);

  it('a connection dropped after the device started a job leaves it unknown; status confirms it, and the kept script copy goes', async () => {
    const { id } = await ready(2231);
    kit.update(2231, (h) => { h.mode = 'drop-after-run'; });
    const r = await runJob(p, id, { command: ['sleep', '2'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state).toBe('unknown');
    expect(r.job.unknown).toMatchObject({ not_known: 'whether the device received it and started it' });
    expect(r.words).toMatch(/^unknown since .*: the connection to 127\.0\.0\.1:2231 ended before Timmy got an answer; last seen never; not known: whether the device received it and started it$/);
    expect(fs.existsSync(path.join(p.jobs, `${r.job.id}.script`))).toBe(true);
    kit.update(2231, (h) => { h.mode = 'up'; });
    const s = await reconcileJob(p, r.job.id);
    if ('error' in s) throw new Error(s.error);
    expect(['running', 'ended']).toContain(s.job.state);
    expect(s.job.confirmed_at).toBeTruthy();
    expect(fs.existsSync(path.join(p.jobs, `${r.job.id}.script`))).toBe(false);
    // a retry reconciles first and sends nothing: the device has this run
    const again = await retryJob(p, r.job.id);
    expect('error' in again ? again.error : again.words).toMatch(/^not sent again: dev has this run already/);
  }, 60_000);

  it('one id submitted twice starts one run (duplicate events)', async () => {
    const { id, home } = await ready(2232);
    kit.update(2232, (h) => { h.mode = 'refused'; });
    const r = await runJob(p, id, { command: ['sh', '-c', 'echo run >> "$HOME/runs.txt"; sleep 1'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state).toBe('submitted');
    expect(r.words).toMatch(/^not sent: unreachable: 127\.0\.0\.1:2232 refused the connection/);
    kit.update(2232, (h) => { h.mode = 'up'; });
    // the same id sent twice at once (a retry racing another): the device starts it once
    const [a, b] = await Promise.all([retryJob(p, r.job.id), retryJob(p, r.job.id)]);
    for (const x of [a, b]) if ('error' in x) throw new Error(x.error);
    const end = await ended(r.job.id);
    expect(end.state).toBe('ended');
    expect(fs.readFileSync(path.join(home, 'runs.txt'), 'utf8')).toBe('run\n');
    expect(fs.readdirSync(path.join(home, '.timmy-connect', 'jobs'))).toEqual([r.job.id]);
    const events = readJob(p, r.job.id)!.events.map((e) => e.what).join('\n');
    expect(events).toMatch(/already started on dev: this submission started nothing|started on dev/);
  }, 60_000);

  it('a device that cannot detach a job answers so: nothing starts, the record says why, and the CLI exits 1', async () => {
    const mac = await ready(2237, { macLike: true }, 'mac');
    // perl goes away after the probe (the FAKE device's PATH loses it): the device itself refuses to start the job
    fs.unlinkSync(path.join(kit.root, 'mac-bin', 'perl'));
    const cli = await kit.cli(['run', 'mac', '--json', '--', 'sleep', '1']);
    expect(cli.code, cli.stdout + cli.stderr).toBe(1);
    const j = lastJson(cli.stdout);
    expect(j.words).toBe('not started: there is no way to detach a job there (no setsid, no perl): it was not started');
    expect(j.job.state).toBe('submitted');
    expect(fs.existsSync(path.join(jobDir(mac.home, j.job.id), 'claim'))).toBe(false);
  }, 60_000);

  it('a stop is confirmed by the device\'s status file, and the job\'s process group is gone', async () => {
    const { id, home } = await ready(2233);
    const r = await runJob(p, id, { command: ['sh', '-c', 'sleep 60 & sleep 60'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state).toBe('running');
    const pgid = pgidOf(home, r.job.id);
    expect(groupRuns(pgid)).toBe(true);
    const cli = await kit.cli(['stop', r.job.id, '--json']);
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    const j = lastJson(cli.stdout);
    expect(j.job).toMatchObject({ state: 'stopped', remote: { state: 'ended', stop_signal: 'TERM' }, stop: { confirmed_at: expect.any(String) } });
    expect(j.words).toMatch(/^stopped on dev: stopped: its supervisor received SIGTERM/);
    expect(groupRuns(pgid)).toBe(false);
  }, 60_000);

  it('a stop never signals a pid whose start time is not the recorded one, nor a process its status file names in place of the recorded one', async () => {
    const { id, home } = await ready(2234);
    const r = await runJob(p, id, { command: ['sleep', '60'] });
    if ('error' in r) throw new Error(r.error);
    const pgid = pgidOf(home, r.job.id);
    // Timmy recorded the job's first process when the device first showed it running this job's run.sh
    expect(r.job.process).toMatchObject({ pid: pgid, pgid, pid_start: expect.stringMatching(/ \d{4}$/) });
    const file = path.join(jobDir(home, r.job.id), 'status');
    // the status file alone names another start time: it no longer names the process Timmy recorded
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^pid_start=.*$/m, 'pid_start=Thu Jan  1 00:00:00 1970'));
    const s = await stopJob(p, r.job.id);
    if ('error' in s) throw new Error(s.error);
    expect(s.job.stop?.result).toMatch(/^its status file there no longer names the process Timmy recorded .*nothing was signalled$/);
    expect(groupRuns(pgid)).toBe(true);
    // the record and the status file agree on a start time ps does not show for that pid (as if the pid had been given to
    // another process since): never signalled
    writeRecord({ ...readJob(p, r.job.id)!, process: { ...r.job.process!, pid_start: 'Thu Jan  1 00:00:00 1970' } });
    const s2 = await stopJob(p, r.job.id);
    if ('error' in s2) throw new Error(s2.error);
    expect(s2.job.stop?.result).toBe('its pid now belongs to another process, which was not signalled');
    expect(groupRuns(pgid)).toBe(true);
  }, 60_000);

  it('a stop never signals what a rewritten status file names: an unrelated process in its own session goes untouched, and so does the job', async () => {
    const { id, home } = await ready(2245);
    const r = await runJob(p, id, { command: ['sleep', '60'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state).toBe('running');
    const jobPgid = pgidOf(home, r.job.id);
    // another program of the same account, in a session and a process group of its own
    const other = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    try {
      const start = await until(() => startOf(other.pid!), 5000, 'the other process to show in ps');
      // the job rewrites its status file (it can: it runs as the same account) to name that process, with lines in the shape
      // of what Timmy's own scripts compute there (they are never taken from the file)
      const file = path.join(jobDir(home, r.job.id), 'status');
      fs.writeFileSync(file, `state=running\npid=${other.pid}\npgid=${other.pid}\npid_start=${start}\nchild=${other.pid}\nstarted_at=2026-10-11T00:00:00Z\nalive=yes\nrunner=yes\nrecorded=same\n`);
      const s = await stopJob(p, r.job.id);
      if ('error' in s) throw new Error(s.error);
      expect(groupRuns(other.pid!), 'the unrelated process was not signalled').toBe(true);
      expect(groupRuns(jobPgid), 'nor was the job').toBe(true);
      expect(s.job.state).toBe('stop asked');
      expect(s.job.stop?.result).toMatch(/^its status file there no longer names the process Timmy recorded .*nothing was signalled$/);
      // with no process recorded (a record from before one was kept), ps decides: that process does not run this job's run.sh
      const rec = readJob(p, r.job.id)!;
      delete rec.process;
      writeRecord(rec);
      const s2 = await stopJob(p, r.job.id);
      if ('error' in s2) throw new Error(s2.error);
      expect(groupRuns(other.pid!)).toBe(true);
      expect(groupRuns(jobPgid)).toBe(true);
      expect(s2.job.stop?.result).toMatch(/^the process its status file names is not this job's supervisor .*nothing was signalled$/);
      expect(readJob(p, r.job.id)!.process, 'a rewritten status file never becomes the recorded process').toBeUndefined();
    } finally {
      try { process.kill(-other.pid!, 'SIGKILL'); } catch { /* ended */ }
    }
  }, 60_000);

  it('a stop that ends a job\'s group itself records the signal it sent (SIGTERM alone: TERM, never KILL)', async () => {
    const { home } = await ready(2246);
    // a job folder made here by hand: its supervisor (of the same shape, sh <folder>/run.sh <folder>) ends at SIGTERM without
    // writing its end, as one stopped before its trap was set would; and a local record for it
    const jobId = 'r5eed0001';
    const dir = jobDir(home, jobId);
    fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'claim'));
    fs.writeFileSync(path.join(dir, 'run.sh'), 'sleep 300\n');
    const sup = spawn('sh', [path.join(dir, 'run.sh'), dir], { cwd: dir, detached: true, stdio: 'ignore' });
    const start = await until(() => startOf(sup.pid!), 5000, 'the supervisor to show in ps');
    fs.writeFileSync(path.join(dir, 'status'), `state=running\npid=${sup.pid}\npgid=${sup.pid}\npid_start=${start}\nchild=\nstarted_at=2026-10-11T00:00:00Z\n`);
    const now = new Date().toISOString();
    writeRecord({ id: jobId, kind: 'remote', label: 'sleep 300', device: 'dev', remote_dir: `.timmy-connect/jobs/${jobId}`, script: { sha256: 'a'.repeat(64), bytes: 10, from: 'command', shell: 'posix' }, state: 'running', submitted_at: now, confirmed_at: now, events: [] });
    const s = await stopJob(p, jobId);
    if ('error' in s) throw new Error(s.error);
    expect(groupRuns(sup.pid!)).toBe(false);
    expect(s.job.state).toBe('stopped');
    expect(s.job.remote).toMatchObject({ state: 'ended', by: 'stop', stop_signal: 'TERM' });
    expect(s.words).toMatch(/SIGTERM/);
    expect(s.words).not.toMatch(/SIGKILL/);
  }, 60_000);

  it('a connection lost in mid-session, after the device took the script, leaves the job unknown: never "not sent"', async () => {
    const { id } = await ready(2243);
    kit.update(2243, (h) => { h.mode = 'drop-after-run'; h.dropWords = 'Read from remote host 127.0.0.1: Connection timed out'; });
    const r = await runJob(p, id, { command: ['sleep', '2'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.words).not.toMatch(/not sent/);
    expect(r.failure).toMatchObject({ notSent: false });
    expect(r.job.state).toBe('unknown');
    expect(r.job.unknown).toMatchObject({ not_known: 'whether the device received it and started it' });
    kit.update(2243, (h) => { h.mode = 'up'; delete h.dropWords; });
    const s = await reconcileJob(p, r.job.id);
    if ('error' in s) throw new Error(s.error);
    expect(s.job.confirmed_at, 'the device had started it').toBeTruthy();
  }, 60_000);

  it('a job\'s output reaches no terminal raw: escape sequences (an OSC 52 clipboard write, cursor moves) are taken out of what is stored and printed', async () => {
    const { id } = await ready(2244);
    const r = await runJob(p, id, { command: ['sh', '-c', String.raw`printf 'a\033]52;c;ZXZpbA==\007b\n\033[1A\033[2K\342\234\223 fake line\n'`] });
    if ('error' in r) throw new Error(r.error);
    await ended(r.job.id);
    const cli = await kit.cli(['status', r.job.id]);
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toContain('out| ab');
    expect(cli.stdout).toContain('✓ fake line');
    for (const raw of ['\x1b]', '\x07', '\x1b[1A', '\x1b[2K']) expect(cli.stdout.includes(raw), JSON.stringify(raw)).toBe(false);
    const stored = JSON.stringify(readJob(p, r.job.id));
    expect(stored).not.toMatch(/\\u001b|\\u0007/);
  }, 60_000);

  it('where ps gives no start time, a job reads as running "unchecked", and a stop refuses to signal it', async () => {
    const { id, home } = await ready(2238, { noStartTime: true });
    const probe = findDevice(p, id).device!.probe!;
    expect(probe.words).toContain('ps gives no start time there (a stop will refuse to signal)');
    const r = await runJob(p, id, { command: ['sleep', '60'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state).toBe('running');
    expect(r.job.remote?.alive).toBe('unchecked');
    expect(r.words).toMatch(/ps gave no start time there, so that it is the same process is not checked/);
    const pgid = pgidOf(home, r.job.id);
    const s = await stopJob(p, r.job.id);
    if ('error' in s) throw new Error(s.error);
    expect(s.job.stop?.result).toMatch(/^no start time was recorded for it there \(ps gave none\).*nothing was signalled$/);
    expect(groupRuns(pgid)).toBe(true);
  }, 60_000);

  it('a stop the device does not answer is recorded as asked and not confirmed; once it answers, the stop is confirmed', async () => {
    const { id } = await ready(2235);
    const r = await runJob(p, id, { command: ['sleep', '60'] });
    if ('error' in r) throw new Error(r.error);
    kit.update(2235, (h) => { h.mode = 'timeout'; }); // FAKE: the device stops answering
    const s = await stopJob(p, r.job.id);
    if ('error' in s) throw new Error(s.error);
    expect(s.job.state).toBe('stop asked');
    expect(s.words).toMatch(/^stop asked .*, not confirmed: unreachable: no answer from 127\.0\.0\.1:2235 \(timed out\)/);
    const cli = await kit.cli(['status', r.job.id, '--json']);
    expect(cli.code).toBe(1);
    expect(lastJson(cli.stdout).job).toMatchObject({ state: 'stop asked', stop: { asked_at: expect.any(String) } });
    kit.update(2235, (h) => { h.mode = 'up'; });
    const read = await reconcileJob(p, r.job.id);
    if ('error' in read) throw new Error(read.error);
    expect(read.job.state).toBe('stop asked');
    expect(read.job.stop?.words).toBe('the stop never reached the device: the job still runs there');
    // the stop reaches the device, and its answer is lost on the way back: still not confirmed, until status reads it
    kit.update(2235, (h) => { h.mode = 'drop-after-run'; });
    const lost = await stopJob(p, r.job.id);
    expect('error' in lost ? lost.error : lost.job.state).toBe('stop asked');
    kit.update(2235, (h) => { h.mode = 'up'; });
    const confirmed = await reconcileJob(p, r.job.id);
    if ('error' in confirmed) throw new Error(confirmed.error);
    expect(confirmed.job.state).toBe('stopped');
    expect(confirmed.job.stop?.confirmed_at).toBeTruthy();
  }, 90_000);

  it('Ctrl-C during a local --wait stops only the local ssh and says the remote job still runs, with the command that stops it', async () => {
    const { id, home } = await ready(2236);
    let cliChild: ChildProcess | undefined;
    const waiting = kit.cli(['run', id, '--wait', '--', 'sleep', '60'], { onChild: (c) => { cliChild = c; } });
    const jobId = await until(() => { try { return fs.readdirSync(path.join(home, '.timmy-connect', 'jobs')).find((n) => remoteStatus(home, n).includes('state=running')); } catch { return undefined; } }, 20_000, 'the job to run');
    await new Promise((z) => setTimeout(z, 800));
    process.kill(cliChild!.pid!, 'SIGINT');
    const done = await waiting;
    expect(done.code, done.stdout + done.stderr).toBe(130);
    expect(done.stdout).toMatch(new RegExp(`only the local ssh was stopped\\. The remote job ${jobId} was not stopped`));
    expect(done.stdout).toContain(`timmy connect stop ${jobId}`);
    const pgid = pgidOf(home, jobId);
    expect(groupRuns(pgid)).toBe(true);
    expect(readJob(p, jobId)!.events.at(-1)!.what).toBe('the local wait was stopped (Ctrl-C): only the local ssh was stopped; the remote job was not');
    const stop = await stopJob(p, jobId);
    expect('error' in stop ? stop.error : stop.job.state).toBe('stopped');
  }, 90_000);
});

describe('fetch: only the job\'s own files, sha256 checked on both computers', () => {
  it('a matching sha256 gives the file and a receipt; a different one keeps .partial and says failed; outside paths and links are refused', async () => {
    const { id } = await ready(2240);
    const r = await runJob(p, id, { command: ['sh', '-c', 'printf "\\000\\001bin\\377" > data.bin; mkdir sub; echo hi > sub/a.txt; ln -s /etc/hostname link.txt; ln -s sub linkdir'] });
    if ('error' in r) throw new Error(r.error);
    await ended(r.job.id);
    const ok = await fetchFile(p, r.job.id, 'work/data.bin');
    expect(ok.ok, ok.words).toBe(true);
    const local = path.join(p.results, r.job.id, 'work', 'data.bin');
    expect(fs.readFileSync(local)).toEqual(Buffer.from([0, 1, 0x62, 0x69, 0x6e, 0xff]));
    expect(ok.sha256).toBe(ok.remote_sha256);
    const receipts = readChain('runs').filter((x) => x.kind === 'remote-fetch');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'ok', outputs: [{ sha256: ok.sha256, bytes: 6 }] });
    expect(verifyChain('runs').ok).toBe(true);
    // never over an existing file
    expect((await fetchFile(p, r.job.id, 'work/data.bin')).words).toMatch(/exists, and Timmy does not replace a file/);
    // only paths inside the job's folder, and no link on the way
    expect((await fetchFile(p, r.job.id, '../other/x')).words).toMatch(/has a "\.\." part/);
    expect((await fetchFile(p, r.job.id, '/etc/passwd')).words).toMatch(/is absolute/);
    expect((await fetchFile(p, r.job.id, 'work/link.txt')).words).toMatch(/symbolic link .*refused/);
    expect((await fetchFile(p, r.job.id, 'work/linkdir/a.txt')).words).toMatch(/symbolic link .*refused/);
    expect((await fetchFile(p, r.job.id, 'work/missing.txt')).words).toMatch(/is not a regular file/);
    // FAKE: the channel flips a byte; the bytes are kept as .partial and the fetch is said failed
    kit.update(2240, (h) => { h.corrupt = true; });
    const to = path.join(kit.root, 'fetched', 'a.txt');
    const cli = await kit.cli(['fetch', r.job.id, 'work/sub/a.txt', '--to', to, '--json']);
    expect(cli.code).toBe(1);
    const j = lastJson(cli.stdout);
    expect(j.words).toMatch(/^fetch failed: the device's sha256 .* differs from the bytes received here/);
    expect(fs.existsSync(to)).toBe(false);
    expect(fs.existsSync(`${to}.partial`)).toBe(true);
    expect(readChain('runs').filter((x) => x.kind === 'remote-fetch').map((x) => x.status)).toEqual(['ok', 'failed']);
  }, 90_000);

  it('a file swapped for a link while it is fetched is never followed out of the job\'s folder (what is hashed and sent is one copy); held still as a regular file, it is fetched whole', async () => {
    // Two claims, one job (R5 H130). SAFETY: while the job swaps work/x between a regular file and a link to a file outside
    // its folder, no byte from outside the folder reaches this computer, whatever the timing: every fetch gives the 7 inside
    // bytes or a refusal that sends nothing. That must hold for every interleaving, so it is asserted of every outcome; how
    // the outcomes fall (all refused, all fetched, a mix) is the machine's timing and is not asserted. LIVENESS: a regular
    // file is fetched, checked deterministically while the job holds x still (a control file it answers), never by hoping a
    // racing fetch lands in a regular-file window: on a loaded runner all 30 racing fetches were refused as links (CI run
    // 38793708710), and a few more process starts in the job's link phase often do the same here.
    const { id, home } = await ready(2247);
    const INSIDE = 'inside\n';
    const insideSha = createHash('sha256').update(INSIDE).digest('hex');
    fs.writeFileSync(path.join(home, 'outside.txt'), 'OUTSIDE-THE-JOB-FOLDER\n');
    // The job, in its folder's work/: swaps x between a regular file (a copy of in.txt) and a link to $HOME/outside.txt as
    // fast as it can, counting each whole swap in ./cycles (with the shell's own echo: no process start more in the loop).
    // While ./hold exists it leaves x a regular file, says so with ./held and waits; once ./hold is gone it removes ./held
    // and swaps on.
    const r = await runJob(p, id, { command: ['sh', '-c', [
      'echo inside > in.txt; n=0',
      'while :; do',
      '  if [ -e hold ]; then cp in.txt f.tmp; mv -f f.tmp x; : > held; while [ -e hold ]; do sleep 0.05; done; rm -f held; fi',
      '  ln -s "$HOME/outside.txt" l.tmp; mv -f l.tmp x; cp in.txt f.tmp; mv -f f.tmp x',
      '  n=$((n + 1)); echo "$n" > cycles',
      'done',
    ].join('\n')] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state).toBe('running');
    const work = path.join(jobDir(home, r.job.id), 'work');
    let swaps = 0;
    /** the whole swaps the job has made so far (a read that meets ./cycles being rewritten keeps the last count) */
    const cycles = (): number => {
      try { const n = Number(fs.readFileSync(path.join(work, 'cycles'), 'utf8')); if (Number.isInteger(n) && n > swaps) swaps = n; } catch { /* not written yet */ }
      return swaps;
    };
    const to = path.join(kit.root, 'race');
    const tried: Array<{ phase: string; dest: string; words: string }> = [];
    const said = (): string => tried.map((t) => `${t.phase}: ${t.words}`).join('\n');
    /** fetches under hostile swaps: at least `min` of them, and on until the job has made at least `min` whole swaps meanwhile */
    const hostile = async (phase: string, min: number): Promise<void> => {
      const from = cycles();
      const end = Date.now() + 30_000;
      for (let i = 0; i < min || cycles() - from < min; i++) {
        if (Date.now() > end) throw new Error(`${phase}: the job made ${cycles() - from} swaps during ${i} fetches\n${said()}`);
        const dest = path.join(to, `${phase}-${i}`);
        tried.push({ phase, dest, words: (await fetchFile(p, r.job.id, 'work/x', { to: dest })).words });
      }
    };
    await until(() => cycles() >= 1, 20_000, 'the job to swap x');
    await hostile('swapping', 15);

    // LIVENESS: the job holds x still, a regular file with the inside bytes, and says so; a fetch then has to succeed
    fs.writeFileSync(path.join(work, 'hold'), '');
    await until(() => fs.existsSync(path.join(work, 'held')), 20_000, 'the job to hold x still');
    const still = cycles();
    expect(fs.lstatSync(path.join(work, 'x')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(work, 'x'), 'utf8')).toBe(INSIDE);
    const heldTo = path.join(to, 'held');
    const held = await fetchFile(p, r.job.id, 'work/x', { to: heldTo });
    tried.push({ phase: 'held', dest: heldTo, words: held.words });
    expect(held.ok, said()).toBe(true);
    expect([held.bytes, held.sha256, held.remote_sha256]).toEqual([7, insideSha, insideSha]);
    expect(fs.readFileSync(heldTo, 'utf8')).toBe(INSIDE);
    expect(cycles(), 'x was swapped while it was held').toBe(still);
    // the swapping resumes: the job removes ./held and makes whole swaps again (x is a link again in each)
    fs.rmSync(path.join(work, 'hold'));
    await until(() => !fs.existsSync(path.join(work, 'held')) && cycles() >= still + 2, 20_000, 'the job to swap x again');
    await hostile('resumed', 15);
    await stopJob(p, r.job.id);

    // SAFETY, over every fetch: whatever reached this computer (a saved file, or a .partial kept after a failed check) holds
    // the inside bytes only
    const received = fs.readdirSync(to).map((n) => ({ n, text: fs.readFileSync(path.join(to, n), 'utf8') }));
    expect(received.map((x) => x.text).join(''), said()).not.toContain('OUTSIDE');
    for (const x of received) expect(x.text, `${x.n}\n${said()}`).toBe(INSIDE);
    // each fetch gave the inside bytes, or was refused and sent nothing
    const fetched = new RegExp(`^fetched work/x from dev: 7 bytes, sha256 ${insideSha} equal on both computers; saved as `);
    const refusals = [
      'not fetched: work/x is or passes through a symbolic link on dev: refused',
      // "could not be copied" is a refusal that sends nothing too. GNU cp -P (this kit's FAKE devices run this computer's
      // cp) lstats the file, opens it with O_NOFOLLOW and checks that what it opened is what it lstat'd (strace: newfstatat
      // AT_SYMLINK_NOFOLLOW, openat O_RDONLY|O_NOFOLLOW, fstat); a swap landing between them fails the copy ("Too many levels
      // of symbolic links", "cannot read symbolic link: Invalid argument"), and the device's script answers no-copy before
      // any byte is sent. Against the same swap loop, 8 of 6000 copies failed so, and none of the 6000 held an outside byte.
      // A BSD cp (macOS's) opens the file without O_NOFOLLOW: not exercised here.
      'not fetched: work/x could not be copied inside the job\'s folder on dev to be sent (a fetch sends one copy, so the file needs room for a copy there): refused',
    ];
    for (const t of tried) {
      if (fetched.test(t.words)) expect(fs.readFileSync(t.dest, 'utf8'), t.words).toBe(INSIDE);
      else {
        expect(refusals, `${t.phase}: ${t.words}`).toContain(t.words);
        expect(fs.existsSync(t.dest), t.words).toBe(false);
      }
    }
    // and nothing else was written: one file per fetch that gave the bytes (no .partial), each with its receipt of them
    const ok = tried.filter((t) => fetched.test(t.words));
    expect(received.map((x) => x.n).sort(), said()).toEqual(ok.map((t) => path.basename(t.dest)).sort());
    const receipts = readChain('runs').filter((x) => x.kind === 'remote-fetch');
    expect(receipts).toHaveLength(ok.length);
    for (const x of receipts) expect(x).toMatchObject({ status: 'ok', outputs: [{ sha256: insideSha, bytes: 7 }], sources: [{ remote_sha256: insideSha, remote_bytes: 7 }] });
  }, 120_000);
});

describe('secrets and words', () => {
  it('no key, token or private-key block in the records, the receipts, the printed words, or ssh\'s argument lists', async () => {
    const { id } = await ready(2250);
    // made at run time, never committed: a token of OpenRouter's shape, one of GitHub's, and a private-key block
    const token = ['sk', 'or', 'v1', randomBytes(24).toString('hex')].join('-');
    const github = `ghp_${randomBytes(18).toString('hex')}`;
    const block = [['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' '), randomBytes(30).toString('base64'), ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')];
    const script = path.join(kit.root, 'leak.sh');
    fs.writeFileSync(script, `echo "${token}"\necho "${github}"\nprintf '%s\\n' '${block.join("' '")}'\n`);
    const run = await kit.cli(['run', id, '--json', '--script', script]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const jobId = lastJson(run.stdout).job.id as string;
    await ended(jobId);
    // the command's own words carry a token too
    const words = await kit.cli(['run', id, '--', 'echo', token]);
    expect(words.code).toBe(0);
    const status = await kit.cli(['status', jobId, '--json']);
    const everything = [
      run.stdout, run.stderr, words.stdout, words.stderr, status.stdout, status.stderr,
      fs.readFileSync(p.devices, 'utf8'), fs.readFileSync(p.knownHosts, 'utf8'),
      ...fs.readdirSync(p.jobs).filter((n) => n.endsWith('.json')).map((n) => fs.readFileSync(path.join(p.jobs, n), 'utf8')),
      JSON.stringify(readConnect(kit.home)), JSON.stringify(readChain('runs')),
      JSON.stringify(kit.calls()),
    ].join('\n');
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(github);
    expect(everything).not.toContain(block[1]);
    expect(everything).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(everything).not.toContain('FAKE private key placeholder');
    // the job's output was read (scrubbed): the words were there
    expect(lastJson(status.stdout).tail.join('\n')).toMatch(/\[REDACTED_OPENROUTER_KEY\][\s\S]*\[REDACTED_GITHUB_TOKEN\][\s\S]*\[REDACTED_PRIVATE_KEY\]/);
    // no record holds key material: a key is named by its file; a host key by its fingerprint
    const record = JSON.parse(fs.readFileSync(p.devices, 'utf8')) as { devices: Array<Record<string, unknown>> };
    expect(JSON.stringify(record)).not.toMatch(/AAAA[A-Za-z0-9+/]{20,}/);
    expect(record.devices[0].identity).toBe(kit.key.file);
  }, 90_000);

  it('a key file under the home is written from ~, and readConnect holds no absolute home path', async () => {
    kit.addHost(2251);
    const keys = path.join(kit.account, 'keys');
    fs.mkdirSync(keys, { recursive: true });
    fs.copyFileSync(kit.key.file, path.join(keys, 'id_timmy'));
    fs.chmodSync(path.join(keys, 'id_timmy'), 0o600);
    fs.copyFileSync(`${kit.key.file}.pub`, path.join(keys, 'id_timmy.pub'));
    expect(addDevice(p, { id: 'home', address: '127.0.0.1', port: 2251, user: 'tester', identity: path.join(keys, 'id_timmy') }).problems).toEqual([]);
    expect(findDevice(p, 'home').device!.identity).toBe('~/keys/id_timmy');
    const scan = await scanDevice(p, 'home');
    if ('error' in scan) throw new Error(scan.error);
    trustKey(p, 'home', scan.keys[0].fingerprint, 'cli');
    const probe = await probeDevice(p, 'home');
    expect('error' in probe ? probe.error : probe.probe.outcome).toBe('connected');
    const view = JSON.stringify(readConnect(kit.home));
    expect(view).toContain('~/keys/id_timmy');
    expect(view).not.toContain(kit.account);
    // ssh got the expanded path (its own business), never the file's contents
    expect(kit.calls('ssh').at(-1)!.argv).toContain(path.join(keys, 'id_timmy'));
  }, 60_000);

  it('every ssh call carries Timmy\'s own settings, and the remote command is the two words sh -s', async () => {
    await ready(2252);
    const calls = kit.calls('ssh');
    expect(calls.length).toBeGreaterThan(1);
    // the version is read once (ssh -V), so an option ssh would refuse is never given
    expect(kit.calls('ssh-version').map((c) => c.argv)).toContainEqual(['-V']);
    for (const c of calls) {
      const a = c.argv;
      const opts = a.flatMap((x, i) => (a[i - 1] === '-o' ? [x] : []));
      expect(a.slice(0, 2)).toEqual(['-F', p.sshConfig]);
      expect(opts).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=yes', `UserKnownHostsFile=${p.knownHosts}`, 'GlobalKnownHostsFile=/dev/null', 'UpdateHostKeys=no', 'HostKeyAlias=timmy-dev', 'ControlPath=none', 'ForwardAgent=no', 'IdentitiesOnly=yes', 'VerifyHostKeyDNS=no', 'KnownHostsCommand=none']));
      expect(opts.some((x) => /^ConnectTimeout=\d+$/.test(x)) && opts.some((x) => /^ServerAliveInterval=\d+$/.test(x))).toBe(true);
      const dash = a.indexOf('--');
      expect(a.slice(dash, dash + 2)).toEqual(['--', '127.0.0.1']);
      expect([['echo', 'TIMMY-PROBE', '%OS%'], ['sh', '-s']]).toContainEqual(a.slice(dash + 2));
    }
  }, 60_000);

  it('a device that opts into the account\'s own ssh config: ssh gets no -F, Timmy\'s settings still win over it, and the words say so', async () => {
    const h = kit.addHost(2253);
    expect(addDevice(p, { id: 'own', address: h.address, port: h.port, user: h.user, identity: kit.key.file, accountConfig: true }).problems).toEqual([]);
    const scan = await scanDevice(p, 'own');
    if ('error' in scan) throw new Error(scan.error);
    trustKey(p, 'own', scan.keys[0].fingerprint, 'cli');
    const cli = await kit.cli(['probe', 'own'], { env: { TIMMY_FAKE_ALLOW_ACCOUNT_CONFIG: '1' } });
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toContain('ssh used your own ssh config (~/.ssh/config), as this device asks');
    // a KnownHostsCommand or VerifyHostKeyDNS there would accept a key Timmy never pinned: Timmy's -o settings come first
    expect(cli.stdout).toMatch(/VerifyHostKeyDNS=no and KnownHostsCommand=none/);
    const last = kit.calls('ssh').at(-1)!.argv;
    expect(last).not.toContain('-F');
    expect(last).toEqual(expect.arrayContaining(['VerifyHostKeyDNS=no', 'KnownHostsCommand=none']));
    expect(readConnect(kit.home).devices[0].words).toContain('ssh uses your own ssh config (~/.ssh/config)');
    // an ssh older than 8.5 has no KnownHostsCommand (it would refuse the option): none is given, and the words say why
    const old = await kit.cli(['probe', 'own'], { env: { TIMMY_FAKE_ALLOW_ACCOUNT_CONFIG: '1', TIMMY_FAKE_SSH_VERSION: 'OpenSSH_8.4p1 FAKE, OpenSSL 1.1.1' } });
    expect(old.code, old.stdout + old.stderr).toBe(0);
    expect(old.stdout).toMatch(/OpenSSH 8\.4 has no KnownHostsCommand/);
    const oldArgs = kit.calls('ssh').at(-1)!.argv;
    expect(oldArgs).toContain('VerifyHostKeyDNS=no');
    expect(oldArgs.some((x) => x.startsWith('KnownHostsCommand'))).toBe(false);
  }, 60_000);
});

describe('surfaces', () => {
  it('one job\'s state reads the same in the CLI\'s JSON, the REPL\'s words and readConnect (consistent UI state)', async () => {
    const { id } = await ready(2260);
    const r = await runJob(p, id, { command: ['sh', '-c', 'exit 3'] });
    if ('error' in r) throw new Error(r.error);
    await ended(r.job.id);
    const cli = lastJson((await kit.cli(['status', r.job.id, '--json'])).stdout);
    expect(cli.job.state).toBe('ended');
    expect(cli.job.words).toMatch(/^ended on dev .*: exit 3$/);
    const printed: string[] = [];
    const ctx = { agent: { getModel: () => 'm', setModel: () => {}, startSession: () => 's' }, print: (s) => printed.push(s.map((x) => x.text).join('')), glyphs: glyphSet(true) } as ReplContext;
    vi.stubEnv('TIMMY_HOME', kit.home);
    await runSlash('/connect jobs', ctx);
    const line = printed.find((l) => l.includes(r.job.id));
    expect(line).toContain(cli.job.words);
    const view = readConnect(kit.home).jobs.find((j) => j.id === r.job.id)!;
    expect(view.state).toBe(cli.job.state);
    expect(view.words).toBe(cli.job.words);
    printed.length = 0;
    await runSlash(`/connect status ${r.job.id} --json`, ctx);
    expect(JSON.parse(printed.at(-1)!).job).toMatchObject({ state: 'ended', words: cli.job.words });
    printed.length = 0;
    await runSlash('/connect', ctx);
    expect(printed[0]).toMatch(/^  Timmy Connect: 1 computer, 1 remote job/);
    expect(printed.find((l) => l.includes(r.job.id))).toContain(cli.job.words);
  }, 60_000);

  it('the REPL confirms a host key through the approval box; denied, or with no box, nothing is trusted', async () => {
    const h = kit.addHost(2261);
    expect(addDevice(p, { id: 'box', address: h.address, port: h.port, user: h.user, identity: kit.key.file }).problems).toEqual([]);
    await scanDevice(p, 'box');
    vi.stubEnv('TIMMY_HOME', kit.home);
    const asked: ApprovalRequest[] = [];
    let listed = false;
    const box = (answer: Decision) => async (req: ApprovalRequest): Promise<Decision> => {
      asked.push(req);
      listed ||= waitingApprovals().some((w) => w.tool === 'connect trust' && w.shown);
      return answer;
    };
    const printed: string[] = [];
    const ctx = (ask?: (req: ApprovalRequest) => Promise<Decision>): ReplContext => ({ agent: { getModel: () => 'm', setModel: () => {}, startSession: () => 's' }, print: (s) => printed.push(s.map((x) => x.text).join('')), glyphs: glyphSet(true), ...(ask ? { workspace: { askBox: ask } as unknown as NonNullable<ReplContext['workspace']> } : {}) });
    await runSlash('/connect trust box', ctx());
    expect(printed.join('\n')).toMatch(/no NEEDS YOU box here .*nothing was trusted/);
    await runSlash('/connect trust box', ctx(box('deny')));
    expect(printed.join('\n')).toMatch(/not confirmed: box's host key stays unconfirmed; nothing was trusted/);
    expect(findDevice(p, 'box').device!.host_key).toBeNull();
    const fp = fingerprintOf(h.keys[0].blob);
    expect(asked[0]).toMatchObject({ tool: 'connect trust', session: false, summary: `box ED25519 ${fp}`, detail: expect.stringContaining(`fingerprint  ${fp}`) });
    expect(listed).toBe(true);
    await runSlash('/connect trust box', ctx(box('once')));
    expect(findDevice(p, 'box').device!.host_key).toMatchObject({ fingerprint: fp, confirmed_by: 'repl' });
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toContain(`timmy-box ssh-ed25519 ${h.keys[0].blob}`);
  }, 60_000);

  it('timmy connect tailnet lists what tailscale status says, read only, and adds nothing', async () => {
    // FAKE tailscale's answer, made at run time (CGNAT-range addresses are built here, never committed)
    const ip = (n: number): string => [100, 64, 0, n].join('.');
    // a peer's own names are other computers' words: one here carries escape sequences (a clipboard write, a screen clear)
    fs.writeFileSync(kit.env.TIMMY_FAKE_TAILSCALE_JSON!, JSON.stringify({ BackendState: 'Running', Self: { HostName: 'this-box', DNSName: 'this-box.example.ts.net.', TailscaleIPs: [ip(1)], OS: 'linux', Online: true }, Peer: { k1: { HostName: 'studio', DNSName: 'studio.example.ts.net.', TailscaleIPs: [ip(2)], OS: 'macOS', Online: true }, k2: { HostName: 'odd', DNSName: 'odd\u001b]52;c;ZXZpbA==\u0007.example.ts.net.', TailscaleIPs: [ip(3), 'not-an-address\u001b[2J'], OS: 'linux\u001b[2J', Online: false } } }));
    const r = await kit.cli(['tailnet', '--json']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const j = lastJson(r.stdout);
    expect(j.peers.map((x: { name: string }) => x.name)).toEqual(['this-box', 'studio', 'odd']);
    expect(j.peers[2]).toMatchObject({ dns_name: 'odd.example.ts.net', os: 'linux', addresses: [ip(3)] });
    expect(j.words).toMatch(/none is added as a device by this/);
    expect(readConnect(kit.home).devices).toEqual([]);
    const shown = await kit.cli(['tailnet']);
    expect(shown.stdout).toContain('odd.example.ts.net');
    for (const raw of ['\x1b]', '\x07', '\x1b[2J']) expect(shown.stdout.includes(raw), JSON.stringify(raw)).toBe(false);
  }, 30_000);

  it('`timmy connect <tool>` stays the journey\'s env.lock step; Timmy Connect\'s verbs and help go to Timmy Connect', async () => {
    const help = await kit.cli(['help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('timmy connect add <id>');
    const legacy = await kit.cli(['sh']);
    expect(legacy.stdout).toMatch(/connect\.sh · \/.*sh · sha256_/);
    expect(readChain('runs').some((r) => r.kind === 'env.lock' && r.subject.startsWith('connect.sh · '))).toBe(true);
  }, 30_000);
});
