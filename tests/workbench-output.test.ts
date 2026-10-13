// R4 (H112): what a running job printed, as the terminal Workbench's Activity reads it (src/workbench/output.ts).
// tests/fixtures/upmd-0.2.7-pty-third.bin is REAL upmd 0.2.7 output captured on the operator's Mac (its sha256 is pinned in
// tests/workflow-live.test.ts): a probe document of three blocks, `upmd --ci -b third`, under python3's pty. The other logs here
// are written by this test into a temporary folder (FAKE logs, in the job store's line format); no process runs.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lineText, OutputWatch, PLAIN_MAX, readFrom, type ReadFrom } from '../src/workbench/output.js';

const UPMD = readFileSync('tests/fixtures/upmd-0.2.7-pty-third.bin');
const box = mkdtempSync(join(tmpdir(), 'wb-output-'));
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
const AT = '2026-10-12T10:00:00.000Z';

/** A FAKE reader over bytes that grow by `step` bytes at each look (a log being written while it is read). */
function growing(bytes: Buffer, step: number): ReadFrom & { more: () => boolean } {
  let shown = 0;
  const r = ((_path: string, offset: number, max: number) => {
    shown = Math.min(bytes.length, shown + step);
    const from = Math.max(offset, shown - max, 0);
    // a look may end inside a character (✔ is three bytes): the reader carries its first bytes to the next look
    return { bytes: bytes.subarray(from, shown), size: shown, from };
  }) as ReadFrom & { more: () => boolean };
  r.more = () => shown < bytes.length;
  return r;
}

describe('a running job\'s lines for Activity (R4 H112)', () => {
  it('upmd 0.2.7\'s own pty bytes: each block\'s output once, in order, whatever the redraws (it moves up 94, 96 and 112 rows) and however the bytes arrive; its code and its exit lines are not output', () => {
    expect(createHash('sha256').update(UPMD).digest('hex')).toBe('fcd16798c8c52e1f46e81206626d8f28327bf74259a0443995df8313e4f71330');
    const want = ['first says hello', 'first done', 'second starts', 'Block 2 failed - stopping dependency chain', 'second fails'];
    for (const step of [UPMD.length, 97, 13, 1]) {
      const read = growing(UPMD, step);
      const w = new OutputWatch({ read });
      const job = { id: 'j0a0b0c', operation: 'o0a0b0c0d', logPath: 'FAKE', drawn: true, live: true };
      let looks = 0;
      while (read.more() && looks < 10_000) { w.read(job, AT); looks += 1; }
      w.read({ ...job, live: false }, AT); // its last look, after it ended
      expect(w.lines('j0a0b0c').map((l) => l.text), `${step} bytes a look`).toEqual(want);
      expect(w.lines('j0a0b0c').map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
      expect(w.lines('j0a0b0c').every((l) => l.operation === 'o0a0b0c0d' && l.at === AT)).toBe(true);
      // after its last look, nothing more is read
      expect(w.read({ ...job, live: false }, AT)).toEqual([]);
    }
  });

  it('a block that prints the same words as an earlier block shows them again (they are its own); a redraw of the same block never does', () => {
    const w = new OutputWatch();
    const job = { id: 'j111111', drawn: true, live: true };
    const drawing = (n: number, out: string[]) => [` [${n}/2] Bash`, '  echo done', '', '\x1b[38;2;1;2;3m\x1b[0m', ...out.map((o) => `  ${o}`), '  \x1b[7m \x1b[0m'];
    w.feedLines(job, ['\x1b[?25l', ...drawing(1, ['done'])], AT);
    w.feedLines(job, ['\x1b[9A', '\x1b[J', ...drawing(1, ['done']), '\x1b[9A', '\x1b[J', '==> one [block 1]', '  done', '  ✔ exited with code 0', ''], AT);
    w.feedLines(job, [...drawing(2, ['done']), '\x1b[9A', '\x1b[J', ...drawing(2, ['done', 'done']), '\x1b[9A', '\x1b[J', '==> two [block 2]', '  done', '  done', '  ✔ exited with code 0', ''], AT);
    expect(w.lines('j111111').map((l) => l.text)).toEqual(['done', 'done', 'done']);
  });

  it('any other job: each line is new, repeats included, in order; at most the newest PLAIN_MAX a look, the earlier counted with where the whole log is', () => {
    const w = new OutputWatch();
    const job = { id: 'j222222', drawn: false, live: true };
    w.feedLines(job, ['a', 'b', 'a', '', '\x1b[31mred\x1b[0m\tcell'], AT);
    expect(w.lines('j222222').map((l) => l.text)).toEqual(['a', 'b', 'a', 'red  cell']);
    const many = Array.from({ length: PLAIN_MAX + 25 }, (_, i) => `line ${i + 1}`);
    const added = w.feedLines(job, many, AT);
    expect(added).toHaveLength(PLAIN_MAX + 1);
    expect(added[0].text).toBe('… 25 earlier lines printed (/jobs j222222 in the REPL shows its log)');
    expect(added.at(-1)?.text).toBe(`line ${PLAIN_MAX + 25}`);
  });

  it('a real log file: only what was added since the last look is read; a line not ended yet waits; a job first seen with a long log starts near its end at a line\'s start; its last look takes the unended line', () => {
    const log = join(box, 'j333333.log');
    writeFileSync(log, 'one\ntwo\npart');
    const w = new OutputWatch();
    const job = { id: 'j333333', logPath: log, drawn: false, live: true };
    expect(w.read(job, AT).map((l) => l.text)).toEqual(['one', 'two']);
    appendFileSync(log, 'ial\nthree\n');
    expect(w.read(job, AT).map((l) => l.text)).toEqual(['partial', 'three']);
    expect(w.read(job, AT)).toEqual([]);
    appendFileSync(log, 'last, with no line end');
    expect(w.read({ ...job, live: false }, AT).map((l) => l.text)).toEqual(['last, with no line end']);
    // a long log seen first mid-run: from near its end, the cut first line left out
    const big = join(box, 'j444444.log');
    writeFileSync(big, `${'x'.repeat(100)}\n`.repeat(1000) + 'tail one\ntail two\n');
    const got = new OutputWatch().read({ id: 'j444444', logPath: big, drawn: false, live: true }, AT);
    expect(got.length).toBe(PLAIN_MAX + 1);
    expect(got[0].text).toMatch(/^… \d+ earlier lines printed \(\/jobs j444444 in the REPL shows its log\)$/);
    expect(got.slice(-2).map((l) => l.text)).toEqual(['tail one', 'tail two']);
    expect(got.slice(1, -2).every((l) => l.text === 'x'.repeat(100))).toBe(true);
    // a log that is not there gives nothing
    expect(new OutputWatch().read({ id: 'j555555', logPath: join(box, 'none.log'), drawn: false, live: true }, AT)).toEqual([]);
    expect(readFrom(join(box, 'none.log'), 0, 10)).toBe(null);
  });

  it('text only: escapes and control characters removed, the caller\'s scrub applied, a long line cut and said so', () => {
    expect(lineText('\x1b]0;title\x07\x1b[1;32mok\x1b[0m\x07 done  \r')).toBe('ok done');
    const w = new OutputWatch();
    w.feedLines({ id: 'j666666', drawn: false, live: true }, ['saved in FAKE-HOME-FOLDER/proj/out.step', 'y'.repeat(500)], AT, (t) => t.replace('FAKE-HOME-FOLDER', '~'));
    const [first, long] = w.lines('j666666');
    expect(first.text).toBe('saved in ~/proj/out.step');
    expect(long.text).toBe(`${'y'.repeat(400)}… (cut at 400 characters)`);
  });
});
