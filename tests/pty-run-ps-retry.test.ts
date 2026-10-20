// R5 lead (CI at 2765dc1): the pty wrapper's stop said "the process table (ps) could not be read, so only its own group is
// signalled", and a block in a process group of its own, holding SIGTERM, was not sent SIGKILL. The wrapper now reads the
// table again when a read fails (three reads in all, 100 ms apart) and says why the last read failed. Here the wrapper
// (workers/upmd/pty_run.py) runs a command that starts a process in a session of its own that ignores SIGTERM, with a FAKE
// ps first on PATH: one that fails its first call and then is the real ps, and one that always fails. Real processes,
// real signals; nothing outside a temporary folder is written, and the held process is always ended by the test.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WRAPPER = join(__dirname, '..', 'workers', 'upmd', 'pty_run.py');
const PYTHON = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
const REAL_PS = spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const held: number[] = [];
afterEach(() => {
  for (const pid of held.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The wrapper over a command whose child takes a session of its own and ignores SIGTERM; `ps` the FAKE ps's script. */
async function run(ps: string): Promise<{ stop: { signals: string[]; said: string; left: number[] }; heldPid: number; exit: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'pty-run-ps-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), ps.replaceAll('REAL_PS', REAL_PS).replaceAll('COUNT', join(dir, 'ps.count')));
  chmodSync(join(bin, 'ps'), 0o755);
  const pidFile = join(dir, 'held.pid');
  const holder = `import os, signal, sys, time\nos.setsid()\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(sys.argv[1], 'w').write(str(os.getpid()))\ntime.sleep(60)\n`;
  writeFileSync(join(dir, 'holder.py'), holder);
  const stopFile = join(dir, 'stop.json');
  const child: ChildProcess = spawn(PYTHON, [WRAPPER, '--stop-file', stopFile, '--', 'sh', '-c', `"${PYTHON}" "${join(dir, 'holder.py')}" "${pidFile}" & wait`],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.resume();
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  for (const end = Date.now() + 15_000; !existsSync(pidFile) && Date.now() < end;) await sleep(25);
  expect(existsSync(pidFile), `the held process started (wrapper said: ${stderr})`).toBe(true);
  const heldPid = Number(readFileSync(pidFile, 'utf8'));
  held.push(heldPid);
  child.kill('SIGTERM');
  const exit = await exited;
  return { stop: JSON.parse(readFileSync(stopFile, 'utf8')) as { signals: string[]; said: string; left: number[] }, heldPid, exit };
}

describe.skipIf(!PYTHON || !REAL_PS)('the pty wrapper reads the process table again when a read fails (R5 lead, CI at 2765dc1)', () => {
  it('a ps that fails once: read again, the held group found, sent SIGTERM then SIGKILL, and gone', async () => {
    const once = `#!/bin/sh\nif [ ! -f "COUNT" ]; then : > "COUNT"; echo "ps: FAKE failure, once" >&2; exit 1; fi\nexec "REAL_PS" "$@"\n`;
    const { stop, heldPid } = await run(once);
    expect(stop.said).not.toMatch(/could not be read/);
    expect(stop.signals).toEqual(['SIGTERM', 'SIGKILL']);
    for (const end = Date.now() + 3000; alive(heldPid) && Date.now() < end;) await sleep(25);
    expect(alive(heldPid)).toBe(false);
  }, 30_000);

  it('a ps that always fails: three reads, and the stop says so with ps\'s own words', async () => {
    const always = '#!/bin/sh\necho "ps: FAKE failure, always" >&2\nexit 1\n';
    const { stop } = await run(always);
    expect(stop.said).toMatch(/the process table \(ps\) could not be read \(ps exited 1: ps: FAKE failure, always, in 3 reads\), so only its own group is signalled/);
  }, 30_000);
});
