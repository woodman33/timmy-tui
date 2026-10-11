/**
 * Round R4 (helper H90): Timmy Connect's records and checks without any device: what reaches an argument list, what a record
 * may hold (never a key or a token), how ssh's own words are read, how remote output is scrubbed, and that the job readers of
 * Timmy's jobs folder read past a remote job's record. No FAKE program runs here; the files are real, in temporary folders.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDevice, checkDeviceInput } from '../src/connect/devices.js';
import { listJobs, parseStatus } from '../src/connect/jobs.js';
import { probeDevice } from '../src/connect/probe.js';
import { readConnect } from '../src/connect/read.js';
import { splitWords, wrapLine } from '../src/connect/repl.js';
import { scrubRemote, scrubShown } from '../src/connect/scrub.js';
import { classifySsh, sshArgs } from '../src/connect/ssh.js';
import { connectPaths, ensureConnect, readDevices, type ConnectPaths } from '../src/connect/store.js';
import type { DeviceRecord, RemoteJobRecord } from '../src/connect/types.js';
import { checkAddress, checkIdentity, checkJobPath, checkPort, checkRemoteDir, checkUser } from '../src/connect/validate.js';
import { exitWords, jobWords } from '../src/connect/words.js';
import type { Ran } from '../src/connect/exec.js';
import { JobManager } from '../src/jobs/index.js';
import { readProjectJobs } from '../src/studio/project-cards.js';

let root: string;
let p: ConnectPaths;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h90-records-')));
  p = connectPaths(path.join(root, 'timmy-home'));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function keyFile(name = 'id_test', mode = 0o600): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, `placeholder ${randomBytes(4).toString('hex')}\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const device = (o: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id: 'dev', name: 'dev', address: '127.0.0.1', port: 2222, user: 'tester', identity: 'agent', ssh_config: 'timmy', os: 'linux', shell: 'posix',
  host_key: null, host_key_scan: null, host_key_refused: null, remote_dir: '.timmy-connect/jobs', added_at: '2026-10-11T00:00:00Z', probe: null, ...o,
});
const ran = (stderr: string, o: Partial<Ran> = {}): Ran => ({ code: 255, signal: null, stdout: Buffer.alloc(0), stderr, timedOut: false, aborted: false, overflow: false, ms: 10, ...o });

describe('what reaches an argument list is checked first', () => {
  it('addresses, users, ports, remote folders, key files and fetch paths', () => {
    expect(checkAddress('-oProxyCommand=x')).toMatch(/starts with "-", which ssh would read as an option/);
    expect(checkAddress('host name')).toMatch(/whitespace/);
    expect(checkAddress('host\u0007')).toMatch(/whitespace or a control character/);
    expect(checkAddress('user@host')).toMatch(/is not a hostname or an IP address/);
    for (const ok of ['127.0.0.1', 'studio', 'studio.example.ts.net', '::1', '192.0.2.10']) expect(checkAddress(ok)).toBeNull();
    expect(checkUser('-l')).toMatch(/starts with "-"/);
    expect(checkUser('a b')).toMatch(/whitespace/);
    expect(checkUser('DOMAIN\\user')).toBeNull();
    for (const bad of [0, 65536, 1.5, Number.NaN]) expect(checkPort(bad)).toMatch(/is not a whole number from 1 to 65535/);
    expect(checkPort(22)).toBeNull();
    expect(checkRemoteDir('../up')).toMatch(/"\.\." part/);
    expect(checkRemoteDir('a b')).toMatch(/holds a character/);
    expect(checkRemoteDir('/srv/timmy-jobs')).toBeNull();
    expect(checkRemoteDir('C:/timmy/jobs')).toBeNull();
    expect(checkIdentity('keys/id')).toMatch(/is not an absolute path or one from ~/);
    expect(checkIdentity('~/.ssh/id_%h')).toMatch(/"%", "\$\{" or a quote/);
    expect(checkIdentity('~/.ssh/id_${HOME}')).toMatch(/"%", "\$\{" or a quote/);
    expect(checkIdentity('~/.ssh/id.pub')).toMatch(/that is a public key/);
    expect(checkIdentity('agent')).toBeNull();
    expect(checkJobPath('../x')).toMatch(/"\.\." part/);
    expect(checkJobPath('/etc/passwd')).toMatch(/is absolute/);
    expect(checkJobPath('~/x')).toMatch(/is absolute/);
    expect(checkJobPath('a\\b')).toMatch(/backslash/);
    expect(checkJobPath('work//x')).toMatch(/empty or "\." part/);
    expect(checkJobPath('work/out file.txt')).toBeNull();
  });

  it('a key file must exist, be a file, and be readable by its owner only; an id must be a slug and unique', () => {
    expect(checkDeviceInput({ id: 'Bad_Id', address: '127.0.0.1', user: 'tester', identity: 'agent' })).toEqual([expect.stringMatching(/is not a slug/)]);
    expect(checkDeviceInput({ id: 'dev', address: '127.0.0.1', user: 'tester', identity: path.join(root, 'missing') })).toEqual([expect.stringMatching(/does not exist/)]);
    expect(checkDeviceInput({ id: 'dev', address: '127.0.0.1', user: 'tester', identity: keyFile('open', 0o644) })).toEqual([expect.stringMatching(/can be read by others \(mode 644\); ssh refuses such a key: chmod 600 it/)]);
    const first = addDevice(p, { id: 'dev', address: '127.0.0.1', user: 'tester', identity: keyFile() });
    expect(first.problems).toEqual([]);
    expect(addDevice(p, { id: 'dev', address: '127.0.0.1', user: 'tester', identity: 'agent' }).problems).toEqual([expect.stringMatching(/a device dev exists already/)]);
  });

  it('every ssh call names Timmy\'s own files; "%" in a path is doubled and a space quoted; "agent" is IdentityFile=none', () => {
    const odd = connectPaths(path.join(root, 'odd 100%', 'home'));
    const a = sshArgs(device({ identity: 'agent' }), odd, ['sh', '-s']);
    expect(a).toContain(`UserKnownHostsFile="${path.join(root, 'odd 100%%', 'home', 'connect', 'known_hosts')}"`);
    expect(a).toContain('IdentityFile=none');
    expect(a).not.toContain('-i');
    expect(a.slice(-4)).toEqual(['--', '127.0.0.1', 'sh', '-s']);
    expect(a.slice(0, 2)).toEqual(['-F', odd.sshConfig]);
    expect(sshArgs(device({ ssh_config: 'account' }), p, ['sh', '-s'])).not.toContain('-F');
  });

  it('Timmy\'s own ssh config must be empty: with anything in it, nothing is sent and the probe says why', async () => {
    fs.mkdirSync(p.dir, { recursive: true });
    ensureConnect(p);
    fs.writeFileSync(p.sshConfig, 'ProxyCommand nc %h %p\n');
    fs.writeFileSync(p.devices, JSON.stringify({ schema: 'timmy.connect.devices/1', devices: [device()] }));
    const r = await probeDevice(p, 'dev');
    if ('error' in r) throw new Error(r.error);
    expect(r.probe.outcome).toBe('error');
    expect(r.probe.words).toMatch(/Timmy's own ssh config .* is not empty, and ssh would apply what it holds/);
  });
});

describe('records', () => {
  it('a device record holds no key and no token: the key is named by its file, and the files are 0600 in a 0700 folder', () => {
    const file = keyFile();
    const secret = `sk-or-v1-${randomBytes(20).toString('hex')}`;
    fs.writeFileSync(file, `${['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')}\n${secret}\n`, { mode: 0o600 });
    expect(addDevice(p, { id: 'dev', address: '127.0.0.1', user: 'tester', identity: file, name: 'Studio' }).problems).toEqual([]);
    const text = fs.readFileSync(p.devices, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/PRIVATE KEY/);
    expect(readDevices(p).devices[0]).toMatchObject({ identity: file, host_key: null, os: 'unknown', shell: 'unknown', remote_dir: '.timmy-connect/jobs' });
    expect(fs.statSync(p.dir).mode & 0o777).toBe(0o700);
    for (const f of [p.devices, p.knownHosts, p.sshConfig]) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p.sshConfig, 'utf8')).toBe('');
  });

  it('the job readers of Timmy\'s jobs folder read past a remote job\'s record, and Connect lists only its own', async () => {
    const jobs = new JobManager({ dir: p.jobs });
    const local = jobs.start({ kind: 'task', label: 'true', project: 'x', root, command: 'true', args: [] });
    await jobs.done(local.id);
    const remote: RemoteJobRecord = { id: 'r0123abcd', kind: 'remote', label: 'sleep 1', device: 'dev', remote_dir: '.timmy-connect/jobs/r0123abcd', script: { sha256: 'a'.repeat(64), bytes: 8, from: 'command', shell: 'posix' }, state: 'running', submitted_at: new Date().toISOString(), events: [] };
    fs.writeFileSync(path.join(p.jobs, 'r0123abcd.json'), JSON.stringify(remote));
    // a remote record named like the job readers' own ids is read past too (its kind is not one of theirs)
    fs.writeFileSync(path.join(p.jobs, 'jabcdef1.json'), JSON.stringify({ ...remote, id: 'jabcdef1' }));
    const listed = new JobManager({ dir: p.jobs }).list();
    expect(listed.map((j) => j.id)).toEqual([local.id]);
    expect(new JobManager({ dir: p.jobs }).get('r0123abcd')).toBeUndefined();
    expect(readProjectJobs(p.jobs, root).map((j) => j.id)).toEqual([local.id]);
    expect(listJobs(p).map((j) => j.id)).toEqual(['r0123abcd']);
  });

  it('readConnect: plain JSON, a record it cannot read named with why, no absolute home path', () => {
    vi.stubEnv('HOME', root);
    fs.mkdirSync(p.jobs, { recursive: true });
    fs.mkdirSync(path.join(root, '.ssh'), { recursive: true });
    const file = path.join(root, '.ssh', 'id_timmy');
    fs.writeFileSync(file, 'placeholder\n', { mode: 0o600 });
    expect(addDevice(p, { id: 'dev', address: '127.0.0.1', user: 'tester', identity: file }).problems).toEqual([]);
    fs.writeFileSync(path.join(p.jobs, 'r0000beef.json'), '{ not json');
    const view = readConnect(p.home);
    expect(view.schema).toBe('timmy.connect/1');
    expect(view.devices[0]).toMatchObject({ id: 'dev', identity: '~/.ssh/id_timmy', host_key: null, needs: [expect.stringMatching(/no host key fetched yet: timmy connect scan dev/)] });
    expect(view.unreadable).toEqual([{ record: 'jobs/r0000beef.json', why: 'not a readable remote job record' }]);
    expect(JSON.stringify(view)).not.toContain(root);
    fs.writeFileSync(p.devices, 'nonsense');
    expect(readConnect(p.home).unreadable[0]).toEqual({ record: 'connect/devices.json', why: expect.stringMatching(/is not valid JSON/) });
  });
});

describe('ssh\'s own words, read', () => {
  it('each refusal and failure in OpenSSH\'s words (Linux and macOS spellings) becomes its outcome', () => {
    const d = device();
    const fp = `SHA256:${'A'.repeat(43)}`;
    const changed = classifySsh(ran(`@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nThe fingerprint for the ED25519 key sent by the remote host is\n${fp}.\nHost key for timmy-dev has changed and you have requested strict checking.\nHost key verification failed.\n`), d);
    expect(changed).toMatchObject({ outcome: 'host-key-changed', offered: fp, notSent: true });
    expect(classifySsh(ran('No ED25519 host key is known for timmy-dev and you have requested strict checking.\nHost key verification failed.\n'), d)?.outcome).toBe('host-key-unconfirmed');
    expect(classifySsh(ran('tester@127.0.0.1: Permission denied (publickey,password).\n'), d)?.outcome).toBe('auth-refused');
    const why = (stderr: string): string | undefined => classifySsh(ran(stderr), d)?.why;
    expect(why('ssh: connect to host 127.0.0.1 port 2222: Connection refused')).toBe('refused');
    expect(why('ssh: connect to host 127.0.0.1 port 2222: Connection timed out')).toBe('timed out');
    expect(why('ssh: connect to host 127.0.0.1 port 2222: Operation timed out')).toBe('timed out');
    expect(why('ssh: connect to host 127.0.0.1 port 2222: No route to host')).toBe('no route');
    expect(why('ssh: connect to host 127.0.0.1 port 2222: Network is unreachable')).toBe('network unreachable');
    expect(why('ssh: Could not resolve hostname studio: Name or service not known')).toBe('name not resolved');
    expect(why('ssh: Could not resolve hostname studio: nodename nor servname provided, or not known')).toBe('name not resolved');
    expect(classifySsh(ran('kex_exchange_identification: Connection closed by remote host'), d)).toMatchObject({ why: 'closed', notSent: true });
    expect(classifySsh(ran('Connection to 127.0.0.1 closed by remote host.'), d)).toMatchObject({ why: 'closed', notSent: false });
    expect(classifySsh(ran('', { spawnError: 'ENOENT', code: null }), d)).toMatchObject({ words: 'ssh is not on PATH here, so nothing was sent', notSent: true });
    // the remote command ran (its marker came back): whatever its exit, ssh connected
    expect(classifySsh(ran('', { code: 255, stdout: Buffer.from('TIMMY-STATUS-BEGIN\n') }), d, 'TIMMY-STATUS-BEGIN')).toBeNull();
  });
});

describe('scrubbing what a device sends', () => {
  it('private-key blocks (whole, cut at either end, or a lone key line) and token shapes go; paths under the home are written from ~', () => {
    const begin = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    const end = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    const body = Array.from({ length: 3 }, () => randomBytes(48).toString('base64'));
    expect(scrubRemote(`before\n${begin}\n${body.join('\n')}\n${end}\nafter`)).toBe('before\n[REDACTED_PRIVATE_KEY]\nafter');
    expect(scrubRemote(`before\n${begin}\n${body[0]}`)).toBe('before\n[REDACTED_PRIVATE_KEY]');
    expect(scrubRemote(`${body[1]}\n${body[2]}\n${end}\nafter`)).toBe('[REDACTED_PRIVATE_KEY]\nafter');
    expect(scrubRemote(`x\n${body[1]}\ny`)).toBe('x\n[REDACTED_KEY_LINE]\ny');
    expect(scrubRemote('sha256 ' + 'ab'.repeat(32))).toBe('sha256 ' + 'ab'.repeat(32));
    const gh = `ghp_${randomBytes(18).toString('hex')}`;
    const hf = `hf_${randomBytes(12).toString('hex')}`;
    const or = ['sk', 'or', 'v1', randomBytes(20).toString('hex')].join('-');
    expect(scrubRemote(`${gh} ${hf} ${or}`)).toBe('[REDACTED_GITHUB_TOKEN] [REDACTED_HF_TOKEN] [REDACTED_OPENROUTER_KEY]');
    vi.stubEnv('HOME', '/home/user');
    expect(scrubShown('/home/user/x/y')).toBe('~/x/y');
  });

  it('a status answer is read as the device wrote it, its output lines scrubbed together', () => {
    const begin = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
    const end = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
    const s = parseStatus(['noise', 'TIMMY-STATUS-BEGIN', 'where=status', 'state=ended', 'pid=10', 'pgid=10', 'pid_start=Sun Oct 11 09:00:00 2026', 'exit_status=143', 'stop_signal=TERM', 'by=supervisor', 'alive=no', 'stop.asked_at=2026-10-11T09:00:05Z', 'stop.signals=TERM', `out|${begin}`, `out|${randomBytes(48).toString('base64')}`, `out|${end}`, 'out|done', 'TIMMY-STATUS-END'].join('\n'), 'T');
    expect(s).toEqual({ read_at: 'T', where: 'status', state: 'ended', pid: 10, pgid: 10, pid_start: 'Sun Oct 11 09:00:00 2026', exit_status: 143, stop_signal: 'TERM', by: 'supervisor', alive: 'no', stop: { asked_at: '2026-10-11T09:00:05Z', signals: ['TERM'] }, tail: ['[REDACTED_PRIVATE_KEY]', 'done'] });
    expect(parseStatus('TIMMY-STATUS-BEGIN\nwhere=absent\nTIMMY-STATUS-END')).toMatchObject({ where: 'absent' });
    expect(parseStatus('no markers')).toBeNull();
  });

  it('exit words say what the shell reported, and a signal only as what it may mean', () => {
    const s = (o: object) => ({ read_at: 'T', where: 'status' as const, state: 'ended' as const, ...o });
    expect(exitWords(s({ exit_status: 0 }))).toBe('exit 0');
    expect(exitWords(s({ exit_status: 3 }))).toBe('exit 3');
    expect(exitWords(s({ exit_status: 143, stop_signal: 'TERM' }))).toMatch(/^stopped: its supervisor received SIGTERM, and the job ended with status 143/);
    expect(exitWords(s({ exit_status: 137 }))).toBe('exit status 137 (a shell reports a death by SIGKILL so; it may also have exited with that code)');
    expect(exitWords(s({ exit_status: null, by: 'stop', stop: { signals: ['TERM', 'KILL'] } }))).toMatch(/^ended by its stop with SIGKILL \(signals sent: TERM, KILL\); no exit status was recorded/);
    const j: RemoteJobRecord = { id: 'r0123abcd', kind: 'remote', label: 'x', device: 'dev', remote_dir: 'd', script: { sha256: 'a'.repeat(64), bytes: 1, from: 'command', shell: 'posix' }, state: 'unknown', submitted_at: 'T', last_seen: '2026-10-11T09:00:00Z', unknown: { since: '2026-10-11T09:05:00Z', why: 'unreachable: no route to 127.0.0.1', not_known: 'whether it still runs' }, events: [] };
    expect(jobWords(j)).toBe('unknown since 2026-10-11 09:05 UTC: unreachable: no route to 127.0.0.1; last seen 2026-10-11 09:00 UTC; not known: whether it still runs');
  });
});

describe('the REPL\'s words', () => {
  it('splits a line into words: quotes keep spaces, a backslash keeps the next character, an open quote is said', () => {
    expect(splitWords(`run dev -- sh -c 'echo a  b' "x \\"y\\"" z\\ w`)).toEqual(['run', 'dev', '--', 'sh', '-c', 'echo a  b', 'x "y"', 'z w']);
    expect(splitWords(`run dev -- 'open`)).toEqual({ error: 'a single quote is not closed' });
    expect(splitWords('  ')).toEqual([]);
  });

  it('a long line becomes rows the REPL will not cut (words whole, roles kept, continuation indented)', () => {
    const rows = wrapLine([{ text: '  ✓ ', role: 'verified' }, { text: 'connected: macOS 15.1 arm64, user op, shell POSIX sh; job folder writable; found on PATH: sh, git (found on PATH only: not proven supported or working)' }], 40);
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(r.map((x) => x.text).join('').length).toBeLessThanOrEqual(40);
    expect(rows.map((r) => r.map((x) => x.text).join('').trim()).join(' ')).toBe('✓ connected: macOS 15.1 arm64, user op, shell POSIX sh; job folder writable; found on PATH: sh, git (found on PATH only: not proven supported or working)');
    expect(rows[0][0]).toEqual({ text: '  ✓ ', role: 'verified' });
    expect(rows[1][0].text).toBe('      ');
    expect(wrapLine([{ text: 'short' }], 40)).toEqual([[{ text: 'short' }]]);
  });
});
