/**
 * The test kit for Timmy Connect (round R4, helper H90). Everything here is a stand-in, labelled FAKE where it plays a real
 * program: a FAKE network (a JSON file) that the FAKE ssh, ssh-keyscan and ssh-keygen (Node scripts in this folder, put
 * first on PATH through wrappers made at run time) answer from; FAKE devices whose "remote home" is a folder in this test's
 * temporary folder, where remote commands run for real (/bin/sh, real child processes, signals and files); a FAKE identity
 * (a placeholder private key file that nothing reads, and a real ed25519 public key beside it) and FAKE host keys (real
 * ed25519 public keys, made at run time). No network, no real computer, no real key, and nothing outside the temporary folder.
 *
 * Addresses: 127.0.0.1 with a port per FAKE device; the documentation range 192.0.2.0/24 (TEST-NET-1) for a device that
 * times out or has no route; the reserved name "nosuch.invalid" for a name that does not resolve.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = createRequire(import.meta.url).resolve('tsx');

export type Mode = 'up' | 'refused' | 'timeout' | 'noroute' | 'banner-close' | 'drop-after-run' | 'drop-before-run';
export interface HostKey { type: string; blob: string }
/** `dropWords`: what the FAKE ssh says on stderr when a 'drop-after-run' connection is lost (default: OpenSSH's "Connection
 *  to <host> closed by remote host."; e.g. "Read from remote host <host>: Connection timed out", a loss in mid-session) */
export interface FakeHost { mode: Mode; keys: HostKey[]; users: Record<string, { home: string; authorized: string[] }>; shell: 'posix' | 'cmd' | 'powershell'; path?: string; corrupt?: boolean; probeAnswer?: string; dropWords?: string }
interface Net { label: string; hosts: Record<string, FakeHost>; unresolvable: string[] }

/** An ed25519 public key as OpenSSH writes its blob (base64 of "ssh-ed25519" and the 32-byte key, each length-prefixed). */
export function newHostKey(): HostKey {
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const t = Buffer.from('ssh-ed25519');
  const b = Buffer.alloc(8 + t.length + raw.length);
  b.writeUInt32BE(t.length, 0); t.copy(b, 4); b.writeUInt32BE(raw.length, 4 + t.length); raw.copy(b, 8 + t.length);
  return { type: 'ssh-ed25519', blob: b.toString('base64') };
}

/** The programs a FAKE "macOS-like" device has on its PATH: no setsid and no sha256sum (macOS has neither), but `stat`
 *  (macOS's is BSD; here it is the host's, so a FAKE mac device identifies an open file through whatever this box has). */
const MAC_PROGRAMS = ['sh', 'dash', 'perl', 'ps', 'sed', 'awk', 'date', 'sleep', 'head', 'cut', 'tail', 'tr', 'wc', 'cat', 'mkdir', 'mv', 'rm', 'rmdir', 'grep', 'uname', 'id', 'shasum', 'stat', 'touch', 'env', 'ls', 'kill', 'printf', 'echo', 'true', 'false', 'pwd'];

export interface Kit {
  root: string;
  /** Timmy home (TIMMY_HOME) */
  home: string;
  /** the account's home here (HOME): nothing of the real account's is read */
  account: string;
  env: NodeJS.ProcessEnv;
  /** the FAKE identity: its private key file (a placeholder nothing reads) and its public blob */
  key: { file: string; blob: string };
  /** a second identity, authorized nowhere (an authentication refusal) */
  otherKey: { file: string; blob: string };
  /** a FAKE device at 127.0.0.1:<port> (or `address`, a documentation address such as 192.0.2.10) */
  addHost(port: number, o?: Partial<FakeHost> & { user?: string; macLike?: boolean; noStartTime?: boolean; address?: string }): { address: string; port: number; user: string; home: string; keys: HostKey[] };
  update(port: number, fn: (h: FakeHost) => void, address?: string): void;
  remoteHome(port: number, user?: string): string;
  /** every call the FAKE programs logged: { prog, pid, argv } */
  calls(prog?: string): Array<{ prog: string; pid: number; argv: string[] }>;
  /** in-process tests: PATH, HOME, TIMMY_HOME and the FAKE's variables set here (restored by the caller's unstubAllEnvs) */
  stub(set: (k: string, v: string | undefined) => void): void;
  /** `timmy connect …` through the CLI (src/cli.ts, as the dev path runs it), in its own process group */
  cli(args: string[], o?: { env?: NodeJS.ProcessEnv; onChild?: (c: ChildProcess) => void }): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
  /**
   * `timmy connect …` with a terminal on its stdin, stdout and stderr: a pseudo-terminal that python3's pty module makes (a
   * program driving a terminal, as a person's terminal would be). Its output comes back as the terminal showed it (\r\n).
   * Null where python3 is not on PATH.
   */
  cliInTerminal(args: string[], o?: { env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; output: string } | null>;
  cleanup(): void;
}

/** A pseudo-terminal for one program (python3's pty module): its output, then its exit code as this script's. */
const PTY_RUNNER = [
  'import os, pty, select, sys',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execvp(sys.argv[1], sys.argv[1:])',
  'out = bytearray()',
  'while True:',
  '    try:',
  '        ready, _, _ = select.select([fd], [], [], 120)',
  '    except InterruptedError:',
  '        continue',
  '    if not ready:',
  '        break',
  '    try:',
  '        data = os.read(fd, 65536)',
  '    except OSError:',
  '        break',
  '    if not data:',
  '        break',
  '    out += data',
  '_, status = os.waitpid(pid, 0)',
  'sys.stdout.buffer.write(bytes(out))',
  'sys.stdout.flush()',
  'code = os.waitstatus_to_exitcode(status)',
  'sys.exit(code if code >= 0 else 128 - code)',
].join('\n');

/** A process's start time as Timmy's scripts read it on a POSIX device (`ps -o lstart=`, LC_ALL=C TZ=UTC). */
export function startOf(pid: number): string {
  return (spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout ?? '').trim();
}

export function makeKit(prefix = 'h90-connect-'): Kit {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'timmy-home');
  const account = path.join(root, 'account-home');
  const macbin = path.join(root, 'mac-bin');
  for (const d of [bin, home, account, macbin, path.join(root, 'keys'), path.join(root, 'remote')]) fs.mkdirSync(d, { recursive: true });
  // FAKE programs first on PATH: wrappers that run the Node scripts of this folder with this Node
  for (const [name, script] of [['ssh', 'fake-ssh.mjs'], ['ssh-keyscan', 'fake-ssh-keyscan.mjs'], ['ssh-keygen', 'fake-ssh-keygen.mjs'], ['tailscale', 'fake-tailscale.mjs']]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n# FAKE ${name} (Timmy Connect's tests)\nexec "${process.execPath}" "${path.join(HERE, script)}" "$@"\n`, { mode: 0o755 });
  }
  // FAKE ps for a device whose ps gives no start time (as busybox's): asked for lstart it answers nothing
  const nolstart = path.join(root, 'nolstart-bin');
  fs.mkdirSync(nolstart);
  const realPs = spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(nolstart, 'ps'), `#!/bin/sh
# FAKE ps: no start time (lstart) here
case "$*" in *lstart*) exit 1 ;; esac
exec ${realPs} "$@"
`, { mode: 0o755 });
  for (const p of MAC_PROGRAMS) {
    const found = spawnSync('sh', ['-c', `command -v ${p}`], { encoding: 'utf8' }).stdout.trim();
    if (found.startsWith('/')) { try { fs.symlinkSync(found, path.join(macbin, p)); } catch { /* there */ } }
  }
  const identity = (name: string): { file: string; blob: string } => {
    const file = path.join(root, 'keys', name);
    const { blob } = newHostKey();
    fs.writeFileSync(file, `FAKE private key placeholder ${randomBytes(8).toString('hex')}: Timmy never reads this file; the FAKE ssh reads only its mode and the .pub beside it\n`, { mode: 0o600 });
    fs.writeFileSync(`${file}.pub`, `ssh-ed25519 ${blob} fake-identity\n`, { mode: 0o644 });
    return { file, blob };
  };
  const key = identity('timmy_test_identity');
  const otherKey = identity('other_identity');
  const netFile = path.join(root, 'net.json');
  const log = path.join(root, 'fake-calls.jsonl');
  const net: Net = { label: 'FAKE: a stand-in network for Timmy Connect\'s tests; nothing here is a real computer', hosts: {}, unresolvable: ['nosuch.invalid'] };
  const save = (): void => fs.writeFileSync(netFile, JSON.stringify(net, null, 2));
  save();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: account, TIMMY_HOME: home, TIMMY_FAKE_NET: netFile, TIMMY_FAKE_SSH_LOG: log,
    TIMMY_FAKE_TAILSCALE_JSON: path.join(root, 'tailscale.json'),
  };
  delete env.SSH_AUTH_SOCK;
  delete env.NODE_PATH;
  const remoteHome = (port: number, user = 'tester'): string => path.join(root, 'remote', String(port), user);
  const kids: ChildProcess[] = [];
  return {
    root, home, account, env, key, otherKey,
    addHost(port, o = {}) {
      const user = o.user ?? 'tester';
      const h = remoteHome(port, user);
      fs.mkdirSync(h, { recursive: true });
      const keys = o.keys ?? [newHostKey()];
      const address = o.address ?? '127.0.0.1';
      net.hosts[`${address}:${port}`] = {
        mode: o.mode ?? 'up', keys, shell: o.shell ?? 'posix',
        users: { [user]: { home: h, authorized: [key.blob] } },
        path: o.macLike ? macbin : o.noStartTime ? `${nolstart}:/usr/local/bin:/usr/bin:/bin` : (o.path ?? '/usr/local/bin:/usr/bin:/bin'),
        ...(o.corrupt ? { corrupt: true } : {}), ...(o.probeAnswer ? { probeAnswer: o.probeAnswer } : {}),
      };
      save();
      return { address, port, user, home: h, keys };
    },
    update(port, fn, address = '127.0.0.1') { fn(net.hosts[`${address}:${port}`]); save(); },
    remoteHome,
    calls(prog) {
      let text = '';
      try { text = fs.readFileSync(log, 'utf8'); } catch { return []; }
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { prog: string; pid: number; argv: string[] }).filter((c) => !prog || c.prog === prog);
    },
    stub(set) {
      for (const k of ['PATH', 'HOME', 'TIMMY_HOME', 'TIMMY_FAKE_NET', 'TIMMY_FAKE_SSH_LOG', 'TIMMY_FAKE_TAILSCALE_JSON']) set(k, env[k]);
      set('SSH_AUTH_SOCK', undefined);
    },
    cli(args, o = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', LOADER, path.join(REPO, 'src', 'cli.ts'), 'connect', ...args], { cwd: root, env: { ...env, TIMMY_STORE: process.env.TIMMY_STORE, ...o.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        kids.push(child);
        o.onChild?.(child);
        let stdout = '';
        let stderr = '';
        child.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
        child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
    },
    cliInTerminal(args, o = {}) {
      const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
      if (!python.startsWith('/')) return Promise.resolve(null);
      return new Promise((resolve) => {
        const child = spawn(python, ['-I', '-c', PTY_RUNNER, process.execPath, '--import', LOADER, path.join(REPO, 'src', 'cli.ts'), 'connect', ...args], { cwd: root, env: { ...env, TIMMY_STORE: process.env.TIMMY_STORE, ...o.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        kids.push(child);
        let output = '';
        child.stdout!.setEncoding('utf8').on('data', (c: string) => { output += c; });
        child.stderr!.setEncoding('utf8').on('data', (c: string) => { output += c; });
        child.on('close', (code) => resolve({ code, output }));
      });
    },
    cleanup() {
      for (const k of kids) { try { if (k.pid) process.kill(-k.pid, 'SIGKILL'); } catch { /* ended */ } }
      // every process a FAKE device started (a job's supervisor names its folder under root): its whole group ended
      const ps = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,args='], { encoding: 'utf8' }).stdout ?? '';
      const groups = new Set<number>();
      for (const line of ps.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m && m[3].includes(root) && Number(m[1]) !== process.pid) groups.add(Number(m[2]));
      }
      for (const dir of fs.existsSync(path.join(root, 'remote')) ? fs.readdirSync(path.join(root, 'remote')) : []) {
        for (const user of fs.readdirSync(path.join(root, 'remote', dir))) {
          const jobs = path.join(root, 'remote', dir, user, '.timmy-connect', 'jobs');
          for (const j of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
            try { const g = /^pgid=(\d+)$/m.exec(fs.readFileSync(path.join(jobs, j, 'status'), 'utf8'))?.[1]; if (g) groups.add(Number(g)); } catch { /* no status */ }
          }
        }
      }
      for (const g of groups) { if (g > 1 && g !== process.pid) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } } }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Whether any process of a process group still runs (zombies do not count). */
export function groupRuns(pgid: number): boolean {
  const out = spawnSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').some((l) => { const [g, s] = l.trim().split(/\s+/); return Number(g) === pgid && s !== undefined && !s.startsWith('Z'); });
}

export async function until<T>(f: () => T | Promise<T>, ms = 20_000, what = 'the condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((z) => setTimeout(z, 100));
  }
}
