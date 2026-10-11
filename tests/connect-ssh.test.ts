/**
 * Round R4 (helper H90): Timmy Connect against FAKE OpenSSH programs. This container has no OpenSSH, so `ssh`,
 * `ssh-keyscan` and `ssh-keygen` are FAKE stand-ins (tests/fixtures/connect/fake-*.mjs, first on PATH) that follow
 * OpenSSH's argument rules and refusals for the options Timmy uses and answer from a FAKE network file. What a FAKE device
 * runs runs for real here: /bin/sh in the device's "remote home" (a temporary folder), with real child processes, process
 * groups, signals and files; killing a local ssh drops its "connection" as a dropped one would. Everything else is Timmy's
 * own code: the records, the scripts it sends, the receipts chain. A test with the real ssh and sshd is
 * tests/connect-real-ssh.test.ts (it runs only where both exist and TIMMY_TEST_REAL_SSH=1).
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDevice } from '../src/connect/devices.js';
import { fingerprintOf, scanDevice, trustKey } from '../src/connect/hostkeys.js';
import { fetchFile, readJob, reconcileJob, retryJob, runJob, stopJob } from '../src/connect/jobs.js';
import { probeDevice } from '../src/connect/probe.js';
import { readConnect } from '../src/connect/read.js';
import { connectPaths, findDevice, type ConnectPaths } from '../src/connect/store.js';
import type { RemoteJobRecord } from '../src/connect/types.js';
import { waitingApprovals, type ApprovalRequest, type Decision } from '../src/repl/approvals.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { glyphSet } from '../src/term/glyphs.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';
import { groupRuns, makeKit, newHostKey, until, type Kit } from './fixtures/connect/kit.js';

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
const lastJson = (stdout: string): Record<string, any> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, any>;

describe('host keys: fetched, shown, trusted only when a person confirms the exact fingerprint', () => {
  it('adding fetches the keys and trusts none; a wrong fingerprint is refused; the exact one is pinned under the device\'s own name, with a receipt', async () => {
    const h = kit.addHost(2201);
    const add = await kit.cli(['add', 'dev', `${h.user}@${h.address}`, '--port', '2201', '--key', kit.key.file, '--json']);
    expect(add.code, add.stdout + add.stderr).toBe(0);
    const j = lastJson(add.stdout);
    const fp = fingerprintOf(h.keys[0].blob);
    expect(j.scan.keys).toEqual([{ type: 'ED25519', fingerprint: fp }]);
    expect(j.device.host_key).toBeNull();
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toBe('');
    // a well-formed fingerprint that is not the fetched one: refused, nothing written
    const other = fingerprintOf(newHostKey().blob);
    const wrong = await kit.cli(['trust', 'dev', other, '--json']);
    expect(wrong.code).toBe(1);
    expect(lastJson(wrong.stdout).words).toMatch(/is not among the keys fetched from 127\.0\.0\.1:2201 .*nothing was trusted/);
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toBe('');
    // a malformed one, and none at all from the CLI
    expect((await kit.cli(['trust', 'dev', 'SHA256:short', '--json'])).code).toBe(1);
    expect((await kit.cli(['trust', 'dev'])).code).toBe(2);
    const right = await kit.cli(['trust', 'dev', fp, '--json']);
    expect(right.code, right.stdout + right.stderr).toBe(0);
    expect(lastJson(right.stdout).device.host_key).toMatchObject({ type: 'ED25519', fingerprint: fp });
    expect(fs.readFileSync(p.knownHosts, 'utf8')).toBe(`timmy-dev ssh-ed25519 ${h.keys[0].blob}\n`);
    expect(fs.statSync(p.knownHosts).mode & 0o777).toBe(0o600);
    expect(fs.statSync(p.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(p.devices).mode & 0o777).toBe(0o600);
    const sealed = readChain('runs').filter((r) => r.kind === 'remote-trust');
    expect(sealed.map((r) => r.subject)).toEqual([`remote-trust · dev · ED25519 ${fp}`]);
    expect(verifyChain('runs').ok).toBe(true);
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

  it('a stop never signals a pid whose start time is not the recorded one', async () => {
    const { id, home } = await ready(2234);
    const r = await runJob(p, id, { command: ['sleep', '60'] });
    if ('error' in r) throw new Error(r.error);
    const pgid = pgidOf(home, r.job.id);
    // the record names another start time (as if the pid had been given to another process since)
    const file = path.join(jobDir(home, r.job.id), 'status');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^pid_start=.*$/m, 'pid_start=Thu Jan  1 00:00:00 1970'));
    const s = await stopJob(p, r.job.id);
    if ('error' in s) throw new Error(s.error);
    expect(s.job.stop?.result).toBe('its pid now belongs to another process, which was not signalled');
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
    for (const c of calls) {
      const a = c.argv;
      const opts = a.flatMap((x, i) => (a[i - 1] === '-o' ? [x] : []));
      expect(a.slice(0, 2)).toEqual(['-F', p.sshConfig]);
      expect(opts).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=yes', `UserKnownHostsFile=${p.knownHosts}`, 'GlobalKnownHostsFile=/dev/null', 'UpdateHostKeys=no', 'HostKeyAlias=timmy-dev', 'ControlPath=none', 'ForwardAgent=no', 'IdentitiesOnly=yes']));
      expect(opts.some((x) => /^ConnectTimeout=\d+$/.test(x)) && opts.some((x) => /^ServerAliveInterval=\d+$/.test(x))).toBe(true);
      const dash = a.indexOf('--');
      expect(a.slice(dash, dash + 2)).toEqual(['--', '127.0.0.1']);
      expect([['echo', 'TIMMY-PROBE', '%OS%'], ['sh', '-s']]).toContainEqual(a.slice(dash + 2));
    }
  }, 60_000);

  it('a device that opts into the account\'s own ssh config: ssh gets no -F, and the words say so', async () => {
    const h = kit.addHost(2253);
    expect(addDevice(p, { id: 'own', address: h.address, port: h.port, user: h.user, identity: kit.key.file, accountConfig: true }).problems).toEqual([]);
    const scan = await scanDevice(p, 'own');
    if ('error' in scan) throw new Error(scan.error);
    trustKey(p, 'own', scan.keys[0].fingerprint, 'cli');
    const cli = await kit.cli(['probe', 'own'], { env: { TIMMY_FAKE_ALLOW_ACCOUNT_CONFIG: '1' } });
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toContain('ssh used your own ssh config (~/.ssh/config), as this device asks');
    expect(kit.calls('ssh').at(-1)!.argv).not.toContain('-F');
    expect(readConnect(kit.home).devices[0].words).toContain('ssh uses your own ssh config (~/.ssh/config)');
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
    fs.writeFileSync(kit.env.TIMMY_FAKE_TAILSCALE_JSON!, JSON.stringify({ BackendState: 'Running', Self: { HostName: 'this-box', DNSName: 'this-box.example.ts.net.', TailscaleIPs: [ip(1)], OS: 'linux', Online: true }, Peer: { k1: { HostName: 'studio', DNSName: 'studio.example.ts.net.', TailscaleIPs: [ip(2)], OS: 'macOS', Online: true } } }));
    const r = await kit.cli(['tailnet', '--json']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const j = lastJson(r.stdout);
    expect(j.peers.map((x: { name: string }) => x.name)).toEqual(['this-box', 'studio']);
    expect(j.words).toMatch(/none is added as a device by this/);
    expect(readConnect(kit.home).devices).toEqual([]);
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
