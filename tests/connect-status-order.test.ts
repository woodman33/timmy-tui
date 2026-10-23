/**
 * R6 lead (CI at cce00f8: tests/connect-ssh.test.ts "interrupted connection" read a job that had ended by itself as ended
 * with no exit status): the POSIX status read asks whether the job's process runs before it reads the status file. Read the
 * other way round, a supervisor that wrote its end and exited between the two reads gave "state=running" and "alive=no", an
 * end with no code.
 *
 * The race is made here on purpose, and every time: a FAKE `ps` on PATH (a TEST DOUBLE) writes the supervisor's last status
 * (ended, exit 0) at the moment the status read asks it about the process, and then says the process is gone. The status
 * script itself is Timmy's own (src/connect/remote-posix.ts posixStatusScript), run by this machine's sh.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseStatus } from '../src/connect/jobs.js';
import { posixStatusScript } from '../src/connect/remote-posix.js';

const box = mkdtempSync(join(tmpdir(), 'r6-connect-order-'));
afterAll(() => rmSync(box, { recursive: true, force: true }));

describe('a remote job\'s status is read after its process is asked about (R6 lead)', () => {
  it('a supervisor that writes its end and exits while it is read is read as ended with its exit status, never as an end with no code', () => {
    const remote = join(box, 'remote');
    const id = 'rd0000aa1';
    const job = join(remote, id);
    mkdirSync(join(job, 'claim'), { recursive: true });
    const running = ['state=running', 'pid=999999', 'pgid=999999', 'pid_start=Fri Oct 16 00:00:00 2026', 'child=999998', 'started_at=2026-10-16T00:00:00Z'];
    writeFileSync(join(job, 'status'), `${running.join('\n')}\n`);
    // FAKE ps: as the read asks for the supervisor's start time, the supervisor writes its end and is gone
    const bin = join(box, 'bin');
    mkdirSync(bin, { recursive: true });
    const ended = [...running.map((l) => l.replace('state=running', 'state=ended')), 'ended_at=2026-10-16T00:00:03Z', 'exit_status=0', 'by=supervisor'];
    writeFileSync(join(bin, 'ps'), `#!/bin/sh\n# TEST DOUBLE: the supervisor ends right now\nprintf '%s\\n' ${ended.map((l) => `'${l}'`).join(' ')} > ${JSON.stringify(join(job, 'status'))}\nexit 1\n`);
    chmodSync(join(bin, 'ps'), 0o755);
    const out = spawnSync('sh', ['-s'], { input: posixStatusScript(remote, id), encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, LC_ALL: 'C' } });
    expect(out.status, out.stderr).toBe(0);
    const s = parseStatus(out.stdout);
    expect(s).toMatchObject({ where: 'status', state: 'ended', exit_status: 0, alive: 'no', by: 'supervisor' });
  });
});
