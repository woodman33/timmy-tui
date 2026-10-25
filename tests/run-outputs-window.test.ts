// R10 (H163; R7's item D, found on CI's fast runners): a run's sealed outputs are the output-folder files it wrote, never one
// another run wrote just before it started.
//
// A job's receipt names as its outputs the output-folder files (out/, results/, renders/ …) whose times fall in the run
// (src/repl/workspace.ts outputsSince). Up to R10 that was every such file from a second before the job's stamped start: on a
// fast machine, a run that began less than a second after another run wrote out/shot.png sealed that image as its own
// output, though it never wrote it (Home's newest run image then named the newer run, which wrote none:
// tests/companion-r7-page-browser.test.ts). Now a sub-second file time counts from the job's start, stamped before its process
// starts, less one clock tick (WRITE_TICK_MS: the kernel dates a write with its coarse clock); a whole-second time, as HFS+,
// FAT and some network shares keep, still has the second's margin, since such a file system can date a write made in the
// run's first second up to a second before it began.
//
// Real: the REPL's Workspace, its /run, its job and the receipt it seals. FAKE, labelled: upmd (tests/fixtures/fake-upmd.mjs,
// the sandbox's TEST DOUBLE) and out/before.png, a file this test writes as another run would have, with its time set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WRITE_TICK_MS, writtenInRun } from '../src/repl/workspace.js';
import { readChain } from '../src/utils/receipts.js';
import { opsKit, replOf, sandbox } from './helpers/ops-sandbox.js';
import { PNG, runOf } from './helpers/run-inspect-fixture.js';

const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);
const F = '```';

/** Whether the temporary folder's file system keeps sub-second file times (ext4, APFS and tmpfs do; HFS+ and FAT do not). */
function subSecondTimes(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-outputs-probe-'));
  try {
    const f = path.join(dir, 'probe');
    fs.writeFileSync(f, '');
    fs.utimesSync(f, 1792675810.1235, 1792675810.1235);
    return fs.statSync(f).mtimeMs % 1000 !== 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const fine = subSecondTimes();
if (!fine) console.warn('run-outputs-window: this temporary folder keeps whole-second file times, so the /run case (which needs sub-second ones) is skipped here');

describe('a run\'s sealed outputs are the files it wrote (R10 H163; R7 item D)', () => {
  it('the rule: a sub-second time counts from the job\'s stamped start, less one clock tick; a whole-second time keeps the second\'s margin', () => {
    const start = Date.parse('2026-10-22T13:36:05.435Z');
    expect(writtenInRun(start + 120.25, start)).toBe(true);                       // written while it ran
    expect(writtenInRun(start - 3.5, start)).toBe(true);                          // dated a clock tick early by the kernel
    expect(writtenInRun(start - WRITE_TICK_MS - 0.25, start)).toBe(false);
    expect(writtenInRun(start - 400.25, start)).toBe(false);                      // written 0.4 s before it began: another's
    expect(writtenInRun(Date.parse('2026-10-22T13:36:05.000Z'), start)).toBe(true);  // a whole second: may be its first second's
    expect(writtenInRun(Date.parse('2026-10-22T13:36:04.000Z'), start)).toBe(false); // more than a second before it began
  });

  it.skipIf(!fine)('through a real /run: a file written just before the run, and not touched by it, is not in the run\'s receipt outputs; the file the run writes is', async () => {
    const s = sandbox(kit, 'run-outputs-');
    fs.writeFileSync(path.join(s.root, 'MAKE.md'), [
      '# FAKE workflow (tests/run-outputs-window.test.ts): one block that writes out/made.txt', '',
      `${F}bash [name:make]`, 'mkdir -p out', "printf 'made by the run\\n' > out/made.txt", F, '',
    ].join('\n'));
    const { ws } = replOf(kit, s);
    // FAKE: out/before.png as another run leaves it, written 0.3 s before this run is asked for (a sub-second time): inside
    // the second before the job's start that R9 counted, and more than a clock tick before it
    fs.mkdirSync(path.join(s.root, 'out'), { recursive: true });
    const before = path.join(s.root, 'out', 'before.png');
    fs.writeFileSync(before, PNG);
    const t = (Date.now() - 300.5) / 1000;
    fs.utimesSync(before, t, t);
    const { job, op } = await runOf(ws, 'MAKE.md', 'make');
    const started = Date.parse(ws.jobs.get(job)!.startedAt);
    const gap = started - fs.statSync(before).mtimeMs;
    const sealed = (readChain('runs', s.root) as Array<{ kind?: string; operation_id?: string; job?: { id?: string }; outputs?: Array<{ path: string; sha256?: string }> }>)
      .filter((r) => r.kind === 'workflow' && r.job?.id === job);
    expect(sealed.map((r) => r.operation_id)).toEqual([op]);
    expect((sealed[0].outputs ?? []).map((o) => o.path), `out/before.png was dated ${gap.toFixed(1)} ms before the job's stamped start, and the run did not touch it`)
      .toEqual(['out/made.txt']);
    // the case is the one this test means: out/before.png's time falls in the second before the job's stamped start (R9's
    // margin), more than a clock tick before it; and the run left it as it was
    expect(gap).toBeGreaterThan(50);
    expect(gap).toBeLessThan(1000);
    expect(fs.readFileSync(path.join(s.root, 'out', 'made.txt'), 'utf8')).toBe('made by the run\n');
    expect(fs.readFileSync(before).equals(PNG)).toBe(true);
  }, 60_000);
});
