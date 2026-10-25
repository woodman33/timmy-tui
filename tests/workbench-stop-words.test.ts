// R7 (H150; H148's N5, REMAINING-DEFECTS row 8: "A cancelled job's record says 'cancelled' and 'stopped'"): x on a job says
// what came of it in the job's word (src/contracts/stop-words.ts JOB_CANCELLED): "Cancelled j…; its record says cancelled",
// "Not cancelled: j… belongs to another Timmy session …", never "Stopped j…" or "Nothing stopped". Through stopCurrent with
// FAKE answers of recovery's stop (no process is signalled here).
import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../src/jobs/index.js';
import type { LeftJob, LeftStop } from '../src/repl/recover.js';
import type { JobRow } from '../src/workbench/state.js';
import { stopCurrent } from '../src/workbench/stop.js';

const row = { id: 'jfake01', label: 'FAKE job (test): sleep 300', owner: 'other', live: true } as unknown as JobRow;
const rec = { id: 'jfake01', state: 'running' } as unknown as JobRecord;
const deps = (answer: LeftStop | LeftJob) => ({
  stop: async () => [],
  jobs: { get: (id: string) => (id === 'jfake01' ? rec : undefined), list: () => [rec] } as never,
  stopLeft: async () => answer,
});

describe('x on a job: its words are the job\'s (R7 H150; H148\'s N5)', () => {
  it('a left job cancelled by recovery\'s stop says "Cancelled", in full or in part; one another live session runs says "Not cancelled"', async () => {
    const done = await stopCurrent(row, deps({ job: 'jfake01', process_group: 4242, processes: 2, signals: ['SIGTERM'], cleanup: 'complete', recorded: { state: 'cancelled', error: 'FAKE' } }));
    expect(done.words).toMatch(/^Cancelled jfake01; its record says cancelled\. FAKE job \(test\): sleep 300: the session that started it had ended/);
    const part = await stopCurrent(row, deps({ job: 'jfake01', process_group: 4242, processes: 2, signals: ['SIGTERM', 'SIGKILL'], cleanup: 'unresolved', recorded: { state: 'cancelled', error: 'FAKE' } }));
    expect(part.words).toMatch(/^Cancelled jfake01 only in part: some of process group 4242 did not stop/);
    const theirs = await stopCurrent(row, deps({ kind: 'theirs', why: 'FAKE: its session runs' }));
    expect(theirs.words).toMatch(/^Not cancelled: jfake01 belongs to another Timmy session that is still running/);
    const unproven = await stopCurrent(row, deps({ kind: 'unproven', pgid: 4242, members: [], why: 'FAKE: not proven' }));
    expect(unproven.words).toMatch(/^Not cancelled: jfake01's session has ended/);
    for (const r of [done, part, theirs, unproven]) expect(r.words, 'a job is never "stopped" (its processes may be)').not.toMatch(/^(?:Stopped|Nothing stopped)\b/);
  });
});
