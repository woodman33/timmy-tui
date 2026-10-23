/**
 * R6 lead (CI at 6dfdb19: connect-ssh's "one id submitted twice starts one run" timed out, "claimed there, and its supervisor
 * wrote no status"). Two submissions of one job can race: the second passes the claim check before the first claims the
 * job, and then writes the supervisor (run.sh) again while the first's `sh run.sh` is starting. Written in place
 * (cat > run.sh), the file is empty or partial for a moment, and a shell reading it then runs nothing and writes no status.
 * The supervisor is now written to a file of its own and renamed over run.sh: the path never shows a partial file, and a
 * shell that opened run.sh keeps the bytes it opened. Shown here with the submit script's own runner step, run by /bin/sh on
 * this computer (as connect-ssh's FAKE device runs it): a new file (inode) each time, whole, no temp file left behind.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER, posixSubmitScript } from '../src/connect/remote-posix.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timmy-runner-replace-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** The submit script's runner step (the shell function that writes run.sh), as the device receives it. */
function runnerStep(): string {
  const body = Buffer.from('true\n');
  const lines = posixSubmitScript(path.join(dir, 'jobs'), 'r0123abcd', body, createHash('sha256').update(body).digest('hex')).split('\n');
  const from = lines.indexOf('timmy_write_runner() {');
  const end = lines.indexOf('TIMMY_RUNNER_END', from);
  expect(from, 'the submit script has its runner step').toBeGreaterThanOrEqual(0);
  expect(lines[end + 1]).toBe('}');
  return lines.slice(from, end + 2).join('\n');
}
const writeRunner = (job: string): number =>
  spawnSync('/bin/sh', ['-c', `job=${JSON.stringify(job)}\numask 077\n${runnerStep()}\ntimmy_write_runner`], { encoding: 'utf8' }).status ?? -1;

describe('Timmy Connect: a submission writes the supervisor whole, by a rename (R6 lead)', () => {
  it('the runner step never writes run.sh in place', () => {
    const step = runnerStep();
    expect(step).not.toMatch(/cat > "\$job\/run\.sh" /);
    expect(step).toContain('cat > "$job/run.sh.tmp.$$" <<\'TIMMY_RUNNER_END\' && mv -f "$job/run.sh.tmp.$$" "$job/run.sh"');
  });

  it('written again while a shell holds run.sh open: a new file at the path, the open one unchanged and whole, no temp file left', () => {
    const job = path.join(dir, 'job');
    fs.mkdirSync(job);
    expect(writeRunner(job)).toBe(0);
    const runSh = path.join(job, 'run.sh');
    const first = fs.statSync(runSh).ino;
    const whole = `${RUNNER.join('\n')}\n`;
    expect(fs.readFileSync(runSh, 'utf8')).toBe(whole);
    // the first submission's shell has run.sh open (as `sh run.sh` has while it runs); the second writes it again
    const held = fs.openSync(runSh, 'r');
    try {
      expect(writeRunner(job)).toBe(0);
      expect(fs.statSync(runSh).ino, 'run.sh is a new file, put in place by a rename').not.toBe(first);
      expect(fs.readFileSync(runSh, 'utf8')).toBe(whole);
      // what the open descriptor reads is the file it opened, whole (an in-place write would have truncated it under it)
      const buf = Buffer.alloc(Buffer.byteLength(whole) + 16);
      const n = fs.readSync(held, buf, 0, buf.length, 0);
      expect(buf.subarray(0, n).toString('utf8')).toBe(whole);
    } finally {
      fs.closeSync(held);
    }
    expect(fs.readdirSync(job).filter((f) => f.startsWith('run.sh.tmp.'))).toEqual([]);
  });
});
