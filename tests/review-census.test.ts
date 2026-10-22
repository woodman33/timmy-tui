// R10 (H163): nothing of a run stays running after it quits, counted by a census that cannot count itself.
//
// R9's Mac run reported "one sh of the run folder still running 15.4 s after the run's tmux server ended". Its census (step E)
// listed `ps -axo pid=,command=` lines holding the run folder, all but its own script, and did not leave out the processes it
// ran under. Run as R9's runner ran it (`sh <run folder>/…/run-steps.sh` starting each step's node script), the runner is such
// a line for exactly as long as the census waits: on Linux that census found "1 (sh)" after 15.2 s, and the sh was its own
// parent. scripts/review/census.mjs leaves out itself and every process it runs under, and counts a process by its command
// line or its working folder (read from /proc on Linux). The second test is the census after the Workbench quits.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { census, describe as said } from '../scripts/review/census.mjs';

const ROOT = join(__dirname, '..');
const CENSUS = join(ROOT, 'scripts', 'review', 'census.mjs');
const dirs: string[] = [];
const left: number[] = [];
afterEach(() => {
  for (const pid of left.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'census-')); dirs.push(d); return d; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const linux = process.platform === 'linux' && existsSync('/proc/self/cwd');
const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

describe('the census of a folder (R10, H163; R9\'s Mac step E)', () => {
  it.skipIf(!linux)('counts a process that works in the folder; never itself, nor the runner in the folder it runs under', () => {
    const dir = temp();
    // the runner inside the folder, as R9's Mac runner was; it leaves one `sleep` behind, working in the folder, then counts
    writeFileSync(join(dir, 'run-steps.sh'), `#!/bin/sh\ncd "$1"\nsleep 60 >/dev/null 2>&1 &\necho $! > "$1/left.pid"\n"$2" "$3" "$1" --json > "$1/census.json"\necho "exit=$?" >> "$1/census.json.exit"\n`);
    const r = spawnSync('sh', [join(dir, 'run-steps.sh'), dir, process.execPath, CENSUS], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const sleeper = Number(readFileSync(join(dir, 'left.pid'), 'utf8').trim());
    left.push(sleeper);
    const found = JSON.parse(readFileSync(join(dir, 'census.json'), 'utf8')) as Array<{ pid: number; program: string; why: string; command: string }>;
    // the sleep it left is counted, by its working folder; the sh runner naming the folder (the census's parent) is not
    expect(found.map((p) => [p.pid, p.program, p.why])).toEqual([[sleeper, 'sleep', 'working folder']]);
    expect(found.some((p) => p.command.includes('run-steps.sh'))).toBe(false);
    expect(readFileSync(join(dir, 'census.json.exit'), 'utf8').trim()).toBe('exit=1');
    // and from here (not under the runner), once the runner has ended: the same one process, said with its parent and why
    const now = census(dir);
    expect(now.map((p) => p.pid)).toEqual([sleeper]);
    expect(said(now[0])).toMatch(new RegExp(`^pid ${sleeper} \\(parent \\d+\\) sleep: the folder is in its working folder: sleep 60$`));
    process.kill(sleeper, 'SIGKILL');
  });

  it.skipIf(!linux)('says so in one line when nothing runs in the folder (exit 0), and names each process when something does (exit 1)', () => {
    const dir = temp();
    const none = spawnSync(process.execPath, [CENSUS, dir], { encoding: 'utf8' });
    expect(none.status).toBe(0);
    expect(none.stdout.trim()).toBe(`No process runs in ${dir} (none names it in its command line or works inside it; this census and the processes it runs under are not counted).`);
    const child = execFileSync('sh', ['-c', 'cd "$1" && (sleep 60 >/dev/null 2>&1 & echo $!)', 'sh', dir], { encoding: 'utf8' }).trim();
    left.push(Number(child));
    const some = spawnSync(process.execPath, [CENSUS, dir], { encoding: 'utf8' });
    expect(some.status).toBe(1);
    expect(some.stdout).toMatch(new RegExp(`^1 process still runs in .*:\\n {2}pid ${child} \\(parent \\d+\\) sleep: the folder is in its working folder: sleep 60\\n$`));
  });
});

/** Three ports nothing listens on now (the Workbench's companion, Studio and log ports, so a run never meets another's). */
async function freePorts(n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
    }));
  }
  return out;
}

describe('the Workbench leaves nothing behind when it quits (R10, H163)', () => {
  it.skipIf(!linux || !hasTmux)('after c (the companion) and s (Studio), Ctrl+C quits it, and no process of its sandbox is left', async () => {
    const box = temp();
    const home = join(box, 'home');
    const stubs = join(box, 'stubs');
    for (const d of [home, join(home, 'work'), stubs, join(box, 'tmp'), join(box, 'settings')]) mkdirSync(d, { recursive: true });
    // the desktop's opener, stood in for: it notes the launch page it was given and opens nothing
    for (const name of ['xdg-open', 'open']) writeFileSync(join(stubs, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(join(box, 'opened.log'))}\n`, { mode: 0o755 });
    const [studio, logs, companion] = await freePorts(3);
    const tsx = createRequire(import.meta.url).resolve('tsx');
    const label = `census-wb-${process.pid}`;
    const env: Record<string, string> = {
      PATH: `${stubs}:${join(process.execPath, '..')}:/usr/bin:/bin`, HOME: home, USER: 'census', TERM: 'xterm-256color', LANG: 'C.UTF-8',
      TMPDIR: join(box, 'tmp'), TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_MCP_HOME: join(box, 'mcp'),
      TIMMY_STUDIO_PORT: String(studio), TIMMY_LOGS_PORT: String(logs), TIMMY_COMPANION_PORT: String(companion), TIMMY_LOGS_OPEN: '0', TIMMY_NOTIFY: 'off',
    };
    const timmy = (args: string[]) => spawnSync(process.execPath, ['--import', tsx, join(ROOT, 'timmy.ts'), ...args], { cwd: join(home, 'work'), env, encoding: 'utf8', timeout: 60_000 });
    expect(timmy(['init', '--yes']).status).toBe(0);
    // the tmux server keeps its first command line, so the sandbox's folders reach the pane through the environment only
    const tmux = (...a: string[]) => execFileSync('tmux', ['-L', label, ...a], { env: { ...env, TMUX_TMPDIR: tmpdir(), WB_DIR: join(home, 'work'), WB_NODE: process.execPath, WB_TSX: tsx, WB_TIMMY: join(ROOT, 'timmy.ts') }, encoding: 'utf8', timeout: 10_000 });
    const screen = () => tmux('capture-pane', '-p', '-t', 'wb');
    const waitFor = async (ok: () => boolean, ms: number) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) { try { if (ok()) return true; } catch { /* not yet */ } } return false; };
    const opened = () => (existsSync(join(box, 'opened.log')) ? readFileSync(join(box, 'opened.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0);
    try {
      // the pane: the Workbench, then its exit status, then a wait outside the sandbox (so the pane itself is not counted)
      tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'wb', '-x', '122', '-y', '37', '-c', '/', 'sh', '-c',
        'cd "$WB_DIR" && "$WB_NODE" --import "$WB_TSX" "$WB_TIMMY" workbench; echo EXIT=$?; cd /; exec sleep 600');
      expect(await waitFor(() => /Activity/.test(screen()), 90_000), screen()).toBe(true);
      await sleep(1500);
      tmux('send-keys', '-t', 'wb', 'c');
      expect(await waitFor(() => opened() >= 1, 30_000), `no launch page for the companion:\n${screen()}`).toBe(true);
      tmux('send-keys', '-t', 'wb', 's');
      await waitFor(() => opened() >= 2, 30_000);   // Studio from source may not serve (its page is built by the package's build): said on screen
      await sleep(1000);
      const before = census(box);
      expect(before.some((p) => /node/.test(p.program) || /node/.test(p.command)), `the Workbench runs in the sandbox before the quit:\n${before.map(said).join('\n')}`).toBe(true);
      tmux('send-keys', '-t', 'wb', 'C-c');
      expect(await waitFor(() => /EXIT=\d+/.test(screen()), 30_000), screen()).toBe(true);
      expect(screen()).toMatch(/EXIT=0/);
      // what quits ends at once; a process given a moment to end is given at most 5 s
      let after = census(box);
      for (const end = Date.now() + 5000; after.length && Date.now() < end; await sleep(250)) after = census(box);
      expect(after.map(said)).toEqual([]);
    } finally {
      try { tmux('kill-server'); } catch { /* ended */ }
      // tmux leaves the server's socket file: this test's own label's, only a socket
      const sock = join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`, label);
      try { if (lstatSync(sock).isSocket()) rmSync(sock, { force: true }); } catch { /* none */ }
    }
  }, 180_000);
});

describe('./review.sh census, in the package (R10, H163)', () => {
  it('the build ships census.mjs, and review.sh census counts the sandbox with it: none, exit 0', () => {
    expect(readFileSync(join(ROOT, 'scripts', 'review', 'build-review.sh'), 'utf8')).toMatch(/cp scripts\/review\/census\.mjs "\$pkg\/census\.mjs"/);
    const dir = temp();
    for (const f of ['review.sh', 'census.mjs']) writeFileSync(join(dir, f), readFileSync(join(ROOT, 'scripts', 'review', f)), { mode: 0o755 });
    mkdirSync(join(dir, 'sandbox'));
    writeFileSync(join(dir, 'sandbox', 'node.path'), `${process.execPath}\n`);
    const r = spawnSync('bash', [join(dir, 'review.sh'), 'census'], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`No process runs in ${join(dir, 'sandbox')} (none names it in its command line or works inside it; this census and the processes it runs under are not counted).`);
  });
});
