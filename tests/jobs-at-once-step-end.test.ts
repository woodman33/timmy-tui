// R4 (H97; r23c, ledger row 173: "in md the cut step has no end time where act's has one"). A second Ctrl-C to `timmy md` or
// `timmy act` ends the run's job record at once (JobManager.endAtOnce, src/jobs/index.ts): its step still running was
// recorded stopped with no end time, while a stop whose pty wrapper had already said it was stopping gave the step one
// (src/workflows/upmd-live.ts: `s.endedAt ??= stamp()`). Which of md and act had it on the Mac was a race (whether the
// wrapper's line was read before the second signal: run here, md and act each came out both ways), not a difference
// between them; the cut block's receipt, sealed later by /recover, then had no ended_at and no own time.
//
// A real job manager and a real child process (Node, printing a step's start and then waiting); nothing is FAKE but the
// step's line, which this test's own parser reads.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';

const dirs: string[] = [];
const groups: number[] = [];
afterEach(() => {
  // endAtOnce signals nothing (its caller does): each job's process group is ended here
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* ended */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !pred();) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A running workflow job whose process says `lines` (each "START <name>" or "END <name> <code>"), then waits. */
async function running(lines: string[]): Promise<{ m: JobManager; id: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'h97-at-once-'));
  dirs.push(dir);
  const m = new JobManager({ dir: join(dir, 'jobs') });
  const j = m.start({
    kind: 'workflow', label: 'LONG.md › long', project: 'p', root: dir, command: process.execPath,
    args: ['-e', `for (const l of ${JSON.stringify(lines)}) console.log(l); console.log('WAITING'); setInterval(() => {}, 1000);`],
    parseLine: (line, job) => {
      const [word, name, code] = line.split(' ');
      if (word === 'START') job.steps.push({ name, index: job.steps.length + 1, state: 'running', startedAt: new Date().toISOString() });
      if (word === 'END') { const s = job.steps.find((x) => x.name === name)!; s.state = code === '0' ? 'completed' : 'failed'; s.code = Number(code); s.endedAt = new Date().toISOString(); }
    },
  });
  await until(() => (m.get(j.id)?.lines ?? 0) > lines.length);
  const pid = m.get(j.id)?.pid;
  if (pid) groups.push(pid);
  return { m, id: j.id, dir };
}

describe('a job ended at once: the step it cut gets its end time, as a stop\'s own line gives one (R4 H97)', () => {
  it('the step still running is recorded stopped, ended when the record was ended (in memory and on disk)', async () => {
    const { m, id, dir } = await running(['START first', 'END first 0', 'START long']);
    const before = m.get(id)!;
    expect(before.steps.map((s) => `${s.name} ${s.state}`)).toEqual(['first completed', 'long running']);
    const ended = m.endAtOnce(id, { error: 'stopped by timmy md at once (a second SIGINT): TEST', by: 'timmy md', signal: 'SIGINT' })!;
    expect(ended.state).toBe('cancelled');
    expect(ended.endedAt).toEqual(expect.any(String));
    expect(ended.exitedAtOnce).toMatchObject({ at: ended.endedAt, by: 'timmy md', signal: 'SIGINT', sealed: false });
    // the cut step: stopped, ended then; the step that had ended keeps its own time
    expect(ended.steps[1]).toEqual({ name: 'long', index: 2, state: 'stopped', startedAt: before.steps[1].startedAt, endedAt: ended.endedAt });
    expect(ended.steps[0]).toEqual(before.steps[0]);
    const onDisk = JSON.parse(readFileSync(join(dir, 'jobs', `${id}.json`), 'utf8')) as JobRecord;
    expect(onDisk.steps).toEqual(ended.steps);
  });

  it('steps that had ended (between two blocks, or a stop\'s line read first) keep their own state and time', async () => {
    const { m, id } = await running(['START first', 'END first 0', 'START second', 'END second 3']);
    const before = m.get(id)!;
    expect(before.steps.map((s) => `${s.name} ${s.state}`)).toEqual(['first completed', 'second failed']);
    const ended = m.endAtOnce(id, { error: 'stopped by timmy act at once (a second SIGINT): TEST', by: 'timmy act', signal: 'SIGINT' })!;
    expect(ended.steps).toEqual(before.steps);
  });
});
