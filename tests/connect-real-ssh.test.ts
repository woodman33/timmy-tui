/**
 * Round R4 (helper H90): Timmy Connect with the REAL ssh, ssh-keyscan and ssh-keygen against a REAL sshd that this test
 * starts as the current user, on 127.0.0.1, with a temporary host key, authorized_keys and sshd config; every file it
 * makes is in one temporary folder (the sandbox), and the jobs' remote folder is inside it too. It runs only when
 * TIMMY_TEST_REAL_SSH=1 and both ssh and sshd exist (sshd is looked for on PATH, then /usr/sbin/sshd, or given as
 * TIMMY_TEST_SSHD); everywhere else it is skipped. This development container has no OpenSSH: it was skipped here, and is
 * to run on the Mac (r24; docs/ui-cockpit/TIMMY-CONNECT.md, "The real-OpenSSH test").
 *
 * The remote commands start through the current user's login shell, as sshd always does; that shell reads its own startup
 * files (for zsh, ~/.zshenv). Nothing is written outside the sandbox: the test compares the account's ~/.ssh/known_hosts
 * and ~/.ssh/config (their bytes) before and after, and checks that no ~/.timmy-connect folder appeared; after it, no sshd
 * of its own is left and every job's process group is ended.
 *
 * Two cases were added on r4/connect-2 for the independent review's fixes, where macOS differs from the container they were
 * written in: a stop signals only the supervisor Timmy recorded (ps -ww -o args= read on this system), and a fetch sends one
 * copy and never follows a link swapped in while it is fetched (cp -RP on this system). They mirror tests that pass against
 * the FAKE ssh (tests/connect-ssh.test.ts); like the rest of this file, they have NOT RUN anywhere yet.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDevice } from '../src/connect/devices.js';
import { scanDevice, trustKey } from '../src/connect/hostkeys.js';
import { fetchFile, reconcileJob, retryJob, runJob, stopJob } from '../src/connect/jobs.js';
import { probeDevice } from '../src/connect/probe.js';
import { connectPaths, findDevice, type ConnectPaths } from '../src/connect/store.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOADER = createRequire(import.meta.url).resolve('tsx');
const which = (p: string): string | null => { const r = spawnSync('sh', ['-c', `command -v ${p}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const SSHD = process.env.TIMMY_TEST_SSHD ?? which('sshd') ?? (fs.existsSync('/usr/sbin/sshd') ? '/usr/sbin/sshd' : null);
const ENABLED = process.env.TIMMY_TEST_REAL_SSH === '1' && Boolean(which('ssh')) && Boolean(which('ssh-keyscan')) && Boolean(which('ssh-keygen')) && Boolean(SSHD);

const sha = (file: string): string | null => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
const sleep = (ms: number): Promise<void> => new Promise((z) => setTimeout(z, ms));
async function until<T>(f: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(200); }
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => resolve(typeof a === 'object' && a ? a.port : 0)); }); });
}
const groupRuns = (pgid: number): boolean => (spawnSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' }).stdout ?? '').split('\n').some((l) => { const [g, s] = l.trim().split(/\s+/); return Number(g) === pgid && s !== undefined && !s.startsWith('Z'); });

describe.skipIf(!ENABLED)('Timmy Connect with the real ssh against a real sshd on 127.0.0.1 (TIMMY_TEST_REAL_SSH=1)', () => {
  let box: string;
  let p: ConnectPaths;
  let port = 0;
  let sshd: ChildProcess | undefined;
  let sshdLog = '';
  const user = os.userInfo().username;
  const account = os.homedir();
  const watched = [path.join(account, '.ssh', 'known_hosts'), path.join(account, '.ssh', 'config')];
  let before: Array<string | null> = [];
  const remoteJobs = (): string => path.join(box, 'remote-jobs');

  async function startSshd(hostKey: string): Promise<void> {
    const cfg = path.join(box, 'sshd_config');
    const lines = [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `PidFile ${path.join(box, 'sshd.pid')}`,
      `AuthorizedKeysFile ${path.join(box, 'authorized_keys')}`, `AllowUsers ${user}`, 'PubkeyAuthentication yes',
      'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'LogLevel VERBOSE',
    ];
    // OpenSSH 9.8 and later penalise a source address after failed logins; this test fails one on purpose
    fs.writeFileSync(cfg, `${[...lines, 'PerSourcePenalties no'].join('\n')}\n`);
    if (spawnSync(SSHD!, ['-t', '-f', cfg], { encoding: 'utf8' }).status !== 0) fs.writeFileSync(cfg, `${lines.join('\n')}\n`);
    const check = spawnSync(SSHD!, ['-t', '-f', cfg], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(`sshd -t refused the test's config: ${check.stderr}`);
    sshd = spawn(SSHD!, ['-D', '-e', '-f', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
    sshd.stderr!.setEncoding('utf8').on('data', (c: string) => { sshdLog += c; });
    await until(() => /Server listening on 127\.0\.0\.1 port/.test(sshdLog) || sshd?.exitCode !== null, 20_000, 'sshd to listen');
    if (sshd.exitCode !== null) throw new Error(`sshd ended at start: ${sshdLog}`);
  }
  async function stopSshd(): Promise<void> {
    if (!sshd || sshd.exitCode !== null) return;
    sshd.kill('SIGTERM');
    await until(() => sshd!.exitCode !== null || sshd!.signalCode !== null, 10_000, 'sshd to end');
  }
  const keygen = (file: string, comment: string): void => { const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]); if (r.status !== 0) throw new Error(`ssh-keygen: ${r.stderr}`); };
  const fingerprint = (pub: string): string => /SHA256:[A-Za-z0-9+/]{43}/.exec(spawnSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', pub], { encoding: 'utf8' }).stdout)![0];
  const cli = (args: string[], onChild?: (c: ChildProcess) => void): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', LOADER, path.join(REPO, 'src', 'cli.ts'), 'connect', ...args], { cwd: box, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(c);
    let stdout = ''; let stderr = '';
    c.stdout!.setEncoding('utf8').on('data', (x: string) => { stdout += x; });
    c.stderr!.setEncoding('utf8').on('data', (x: string) => { stderr += x; });
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const lastJson = (s: string): Record<string, any> => JSON.parse(s.trim().split('\n').at(-1)!) as Record<string, any>;

  beforeAll(async () => {
    before = watched.map(sha);
    box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h90-real-ssh-')));
    vi.stubEnv('TIMMY_HOME', path.join(box, 'timmy-home'));
    keygen(path.join(box, 'host_ed25519'), 'timmy-test-host');
    keygen(path.join(box, 'host2_ed25519'), 'timmy-test-host-2');
    keygen(path.join(box, 'client_ed25519'), 'timmy-test-client');
    keygen(path.join(box, 'other_ed25519'), 'timmy-test-other');
    fs.writeFileSync(path.join(box, 'authorized_keys'), `restrict ${fs.readFileSync(path.join(box, 'client_ed25519.pub'), 'utf8')}`, { mode: 0o600 });
    port = await freePort();
    await startSshd(path.join(box, 'host_ed25519'));
    p = connectPaths(path.join(box, 'timmy-home'));
    expect(addDevice(p, { id: 'self', address: '127.0.0.1', port, user, identity: path.join(box, 'client_ed25519'), remoteDir: remoteJobs() }).problems).toEqual([]);
  }, 60_000);

  afterAll(async () => {
    // every job's process group, then sshd, then the sandbox; nothing of the account's changed
    for (const j of fs.existsSync(remoteJobs()) ? fs.readdirSync(remoteJobs()) : []) {
      let g: string | undefined;
      try { g = /^pgid=(\d+)$/m.exec(fs.readFileSync(path.join(remoteJobs(), j, 'status'), 'utf8'))?.[1]; } catch { g = undefined; }
      if (g && groupRuns(Number(g))) { try { process.kill(-Number(g), 'SIGKILL'); } catch { /* gone */ } }
    }
    await stopSshd();
    const pid = Number(fs.existsSync(path.join(box, 'sshd.pid')) ? fs.readFileSync(path.join(box, 'sshd.pid'), 'utf8') : 0);
    if (pid) expect(spawnSync('kill', ['-0', String(pid)]).status, 'no sshd of this test is left').not.toBe(0);
    expect(watched.map(sha), 'the account\'s ~/.ssh/known_hosts and ~/.ssh/config are unchanged').toEqual(before);
    expect(fs.existsSync(path.join(account, '.timmy-connect')), 'nothing was made in the account\'s home').toBe(false);
    vi.unstubAllEnvs();
    fs.rmSync(box, { recursive: true, force: true });
  }, 60_000);

  it('fetches the host key with ssh-keyscan, trusts only the exact fingerprint, and probes', async () => {
    const scan = await scanDevice(p, 'self');
    if ('error' in scan) throw new Error(scan.error);
    const real = fingerprint(path.join(box, 'host_ed25519.pub'));
    expect(scan.keys.map((k) => k.fingerprint)).toContain(real);
    expect(trustKey(p, 'self', fingerprint(path.join(box, 'other_ed25519.pub')), 'cli').ok).toBe(false);
    expect(trustKey(p, 'self', real, 'cli').ok).toBe(true);
    const probe = await probeDevice(p, 'self');
    if ('error' in probe) throw new Error(probe.error);
    expect(probe.probe.outcome, `${probe.probe.words}\n${probe.ssh ?? ''}\n${sshdLog.slice(-2000)}`).toBe('connected');
    expect(['macos', 'linux']).toContain(probe.device.os);
    expect(probe.probe.facts?.job_folder).toMatch(/^(writable|absent, can be made)$/);
  }, 60_000);

  it('a detached job survives its local ssh being killed during a wait; status finds its end; fetch checks its sha256', async () => {
    let child: ChildProcess | undefined;
    const waiting = cli(['run', 'self', '--wait', '--json', '--', 'sh', '-c', 'echo started; sleep 4; echo finished > done.txt'], (c) => { child = c; });
    const ssh = await until(() => {
      const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8' }).stdout;
      return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).find((m) => m && Number(m[2]) === child?.pid && m[1] === m[3] && /\bssh\b/.test(m[4]));
    }, 30_000, 'the wait\'s local ssh');
    process.kill(Number(ssh[1]), 'SIGKILL');
    const done = await waiting;
    const j = lastJson(done.stdout);
    expect(j.end, done.stdout + done.stderr).toBe('dropped');
    const end = await until(async () => { const r = await reconcileJob(p, j.job.id); return !('error' in r) && r.job.state === 'ended' ? r.job : undefined; }, 60_000, 'the job to end');
    expect(end.remote?.exit_status).toBe(0);
    const f = await fetchFile(p, j.job.id, 'work/done.txt');
    expect(f.ok, f.words).toBe(true);
    expect(fs.readFileSync(path.join(p.results, j.job.id, 'work', 'done.txt'), 'utf8')).toBe('finished\n');
    expect(readChain('runs').some((r) => r.kind === 'remote-fetch' && r.status === 'ok')).toBe(true);
    expect(verifyChain('runs').ok).toBe(true);
  }, 120_000);

  it('one id sent twice starts one run, and a stop is confirmed by the status file', async () => {
    const counter = path.join(box, 'runs.txt');
    await stopSshd();
    const r = await runJob(p, 'self', { command: ['sh', '-c', `echo run >> '${counter}'; sleep 60`] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state).toBe('submitted');
    await startSshd(path.join(box, 'host_ed25519'));
    await Promise.all([retryJob(p, r.job.id), retryJob(p, r.job.id)]);
    const running = await until(async () => { const s = await reconcileJob(p, r.job.id); return !('error' in s) && s.job.state === 'running' ? s.job : undefined; }, 30_000, 'the job to run');
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\n');
    const stop = await stopJob(p, r.job.id);
    if ('error' in stop) throw new Error(stop.error);
    expect(stop.job.state).toBe('stopped');
    expect(groupRuns(running.remote!.pgid!)).toBe(false);
  }, 120_000);

  it('a stop signals only the supervisor Timmy recorded: a status file rewritten to name an unrelated process is refused; the real stop is then confirmed', async () => {
    const r = await runJob(p, 'self', { command: ['sleep', '60'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state, r.words).toBe('running');
    expect(r.job.process, 'the supervisor was recorded: ps -ww -o args= there showed it running <its folder>/run.sh').toBeDefined();
    const file = path.join(remoteJobs(), r.job.id, 'status');
    const original = fs.readFileSync(file, 'utf8');
    // another program of this account, in a session of its own; the job's status file rewritten to name it
    const other = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    try {
      const start = await until(() => (spawnSync('ps', ['-o', 'lstart=', '-p', String(other.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout ?? '').trim(), 10_000, 'the other process in ps');
      fs.writeFileSync(file, `state=running\npid=${other.pid}\npgid=${other.pid}\npid_start=${start}\nalive=yes\nrunner=yes\n`);
      const refused = await stopJob(p, r.job.id);
      if ('error' in refused) throw new Error(refused.error);
      expect(refused.job.stop?.result, refused.words).toMatch(/nothing was signalled$/);
      expect(groupRuns(other.pid!), 'the unrelated process was not signalled').toBe(true);
      expect(groupRuns(r.job.process!.pgid), 'nor was the job').toBe(true);
    } finally {
      try { process.kill(-other.pid!, 'SIGKILL'); } catch { /* ended */ }
    }
    fs.writeFileSync(file, original);
    const stop = await stopJob(p, r.job.id);
    if ('error' in stop) throw new Error(stop.error);
    expect(stop.job.state, stop.words).toBe('stopped');
    expect(groupRuns(r.job.process!.pgid)).toBe(false);
  }, 120_000);

  it('a fetch sends one copy and never follows a link swapped in while it is fetched', async () => {
    const outside = path.join(box, 'outside.txt');
    fs.writeFileSync(outside, 'OUTSIDE-THE-JOB-FOLDER\n');
    const r = await runJob(p, 'self', { command: ['sh', '-c', `echo inside > in.txt; while :; do ln -s '${outside}' l.tmp; mv -f l.tmp x; cp in.txt f.tmp; mv -f f.tmp x; done`] });
    if ('error' in r) throw new Error(r.error);
    expect(r.job.state, r.words).toBe('running');
    const to = path.join(box, 'race');
    const outcomes: string[] = [];
    for (let i = 0; i < 20; i++) outcomes.push((await fetchFile(p, r.job.id, 'work/x', { to: path.join(to, `x${i}`) })).words);
    const stop = await stopJob(p, r.job.id);
    expect('error' in stop ? stop.error : stop.job.state).toBe('stopped');
    const received = fs.existsSync(to) ? fs.readdirSync(to).map((n) => fs.readFileSync(path.join(to, n), 'utf8')) : [];
    expect(received.join(''), outcomes.join('\n')).not.toContain('OUTSIDE');
    expect(received.length, outcomes.join('\n')).toBeGreaterThan(0);
    for (const text of received) expect(text).toBe('inside\n');
  }, 180_000);

  it('a changed host key is refused by ssh itself and recorded; an unreachable device and a refused key are told apart', async () => {
    await stopSshd();
    const down = await probeDevice(p, 'self');
    expect('error' in down ? down.error : [down.probe.outcome, down.probe.why]).toEqual(['unreachable', 'refused']);
    await startSshd(path.join(box, 'host2_ed25519'));
    const changed = await probeDevice(p, 'self');
    if ('error' in changed) throw new Error(changed.error);
    expect(changed.probe.outcome, changed.ssh).toBe('host-key-changed');
    expect(changed.failure?.offered).toBe(fingerprint(path.join(box, 'host2_ed25519.pub')));
    expect(findDevice(p, 'self').device!.host_key_refused).not.toBeNull();
    await stopSshd();
    await startSshd(path.join(box, 'host_ed25519'));
    expect(addDevice(p, { id: 'other', address: '127.0.0.1', port, user, identity: path.join(box, 'other_ed25519'), remoteDir: remoteJobs() }).problems).toEqual([]);
    const scan = await scanDevice(p, 'other');
    if ('error' in scan) throw new Error(scan.error);
    trustKey(p, 'other', fingerprint(path.join(box, 'host_ed25519.pub')), 'cli');
    const refused = await probeDevice(p, 'other');
    expect('error' in refused ? refused.error : refused.probe.outcome).toBe('auth-refused');
  }, 120_000);
});
