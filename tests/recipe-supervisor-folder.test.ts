/**
 * Round R4, task H29 (1): the recipe supervisor's heartbeat runs on a timer. A job folder that disappears under a
 * running job (a test removing its temporary project, a person deleting .timmy) made that timer throw an uncaught
 * ENOENT: the supervisor died and left its native process group running, with nobody to stop it.
 *
 * Everything here is real: the detached supervisor (lanes/recipes/job-worker.ts supervise), the native worker it
 * starts as the leader of its own process group, and the FAKE executor that worker runs (a fixture seam of
 * lanes/recipes/jobs.ts: it records its pids outside the job folder and waits; it builds nothing).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { enqueue, jobDirectory, start, status } from '../lanes/recipes/jobs.js';
import { groupLive } from '../src/runtime/process-group.js';

const request = { schema: 'timmy.recipe-request/1', recipe: 'enclosure.tray/1', parameters: { width: 140, wall: 3, supportOffset: 10, bore: 3 } };
type Supervisor = { id: string; child: ChildProcess; code?: number | null; signal?: NodeJS.Signals | null; closed: boolean; done: Promise<void> };
let root = '';
let supervisors: Supervisor[] = [];
/** Native process groups a test saw running: stopped here if the code under test left them running. */
let groups: number[] = [];

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-supervisor-folder-')); supervisors = []; groups = []; });
afterEach(async () => {
  // the test's own processes: never left running, whatever the code under test did
  for (const g of groups) if (groupLive(g)) try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ }
  await Promise.race([Promise.all(supervisors.map((s) => s.done)), new Promise((r) => setTimeout(r, 10_000))]);
  for (const s of supervisors) if (!s.closed && s.child.pid) try { process.kill(-s.child.pid, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A fake executor: writes {pid, leader} to `pids` (outside the job folder), then waits without building anything. */
function holdExecutor(pids: string): string {
  const file = path.join(root, 'fake-hold.mts');
  fs.writeFileSync(file, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ pid: process.pid, leader: process.ppid }));
setTimeout(() => {}, 120000);
`);
  return file;
}
async function launch(id: string): Promise<Supervisor> {
  let entry!: Supervisor;
  await start(root, id, {
    onSupervisor: (child) => {
      let finish!: () => void;
      entry = { id, child, closed: false, done: new Promise((r) => { finish = r; }) };
      child.once('close', (code, signal) => { entry.code = code; entry.signal = signal; entry.closed = true; finish(); });
      supervisors.push(entry);
    },
  });
  return entry;
}
const wait = async (what: string, pred: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};
/** Everything written to an open file so far, also after its name was removed. */
function readAllFd(fd: number): string {
  const size = fs.fstatSync(fd).size;
  const b = Buffer.alloc(size);
  let at = 0;
  while (at < size) { const n = fs.readSync(fd, b, at, size - at, at); if (n <= 0) break; at += n; }
  return b.subarray(0, at).toString('utf8');
}
/** A running job: its supervisor, its job folder, and the fake native group's leader and member pids. */
async function running(): Promise<{ id: string; dir: string; sup: Supervisor; leader: number; pid: number }> {
  const pids = path.join(root, 'native-pids.json');
  const id = enqueue(request, { root, executor: holdExecutor(pids) }).job.id;
  const dir = jobDirectory(root, id);
  const sup = await launch(id);
  await wait('the fake native process', () => fs.existsSync(pids) && fs.existsSync(path.join(dir, 'heartbeat.json')));
  const { pid, leader } = JSON.parse(fs.readFileSync(pids, 'utf8')) as { pid: number; leader: number };
  groups.push(leader);
  expect(groupLive(leader), 'the fake native group runs before the change').toBe(true);
  return { id, dir, sup, leader, pid };
}

describe.skipIf(process.platform === 'win32')('a recipe supervisor whose job folder stops taking writes (FAKE executor)', () => {
  it('stops the native process group and exits when the job folder disappears under a running job', async () => {
    const { dir, sup, leader, pid } = await running();
    // worker.log is the supervisor's stdout and stderr: an open descriptor still reads it after the folder is gone
    const log = fs.openSync(path.join(dir, 'worker.log'), 'r');
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await wait('the supervisor to exit', () => sup.closed, 15_000);
      await wait('the native process group to be gone', () => !groupLive(leader), 5_000);
      expect(groupLive(pid)).toBe(false);
      // nothing could be recorded where the job was; the supervisor says so and exits 1
      expect(sup.code).toBe(1);
      const said = readAllFd(log);
      expect(said).toContain('Job folder could not be written (ENOENT); native process group stopped; no terminal state recorded');
      expect(said, 'no uncaught exception (a stack trace) in the supervisor output').not.toMatch(/\n\s+at /);
    } finally { fs.closeSync(log); }
  }, 60_000);

  it('stops the native process group and records interrupted when the heartbeat cannot be written but the folder remains', async () => {
    const { id, dir, sup, leader } = await running();
    const heartbeat = path.join(dir, 'heartbeat.json');
    // heartbeat.json replaced, in one rename, by a link: the supervisor refuses to write through it (a link is not
    // the regular job file it owns). Put back if a heartbeat write landed in the same instant.
    const substitute = () => { const link = `${heartbeat}.link`; fs.symlinkSync(path.join(dir, 'job.json'), link); fs.renameSync(link, heartbeat); };
    substitute();
    await wait('the supervisor to exit', () => { if (!sup.closed && !fs.lstatSync(heartbeat).isSymbolicLink()) substitute(); return sup.closed; }, 15_000);
    await wait('the native process group to be gone', () => !groupLive(leader), 5_000);
    expect(sup.code).toBe(0);
    const s = status(root, id);
    expect(s).toMatchObject({ state: 'interrupted', progress: 'finished', reason: 'Heartbeat could not be written (Expected regular job file); native process group stopped; no replay' });
    expect(fs.readFileSync(path.join(dir, 'worker.log'), 'utf8'), 'no uncaught exception (a stack trace) in the supervisor output').not.toMatch(/\n\s+at /);
  }, 60_000);
});
