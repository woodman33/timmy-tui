// R6 (H141; the interaction review of a77d80d, defect 15): quitting the Workbench. What was typed while it ended is read and
// dropped before the terminal is given back (src/workbench/run.ts dropTypedAhead): here through a FIFO standing in for the
// terminal (a FIXTURE: the real terminal's check is tests/workbench-interaction-pty.test.ts, item 4, LEFT=[]), the bytes
// waiting are read and counted, and a read with nothing waiting ends at once; a path that cannot be opened is no error. The
// help says what each exit code means: 0 for a quit that stopped nothing, 130 for one that stopped work this Workbench started.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { workbenchHelp } from '../src/workbench/cli.js';
import { dropTypedAhead } from '../src/workbench/run.js';

const box = mkdtempSync(join(tmpdir(), 'wb-quit-'));
afterAll(() => { rmSync(box, { recursive: true, force: true }); });

describe('quitting the Workbench (R6 H141; the interaction review of a77d80d, defect 15)', () => {
  it('what was typed while it ended is read and dropped: the bytes waiting, then nothing; a read with nothing waiting ends at once; no terminal is no error', () => {
    const fifo = join(box, 'typed');
    execFileSync('mkfifo', [fifo]);
    // FIXTURE: a writer that stays open (read and write, so opening it does not wait for a reader), holding keys typed
    const writer = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    try {
      writeSync(writer, '7jx');
      expect(dropTypedAhead(fifo)).toBe(3);
      const t0 = Date.now();
      expect(dropTypedAhead(fifo)).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally { closeSync(writer); }
    expect(dropTypedAhead(join(box, 'no-such-terminal'))).toBe(0);
  });

  it('the help says what a quit\'s exit code means', () => {
    const help = workbenchHelp().replace(/\s+/g, ' ');
    expect(help).toContain('0 --json or --help, or Ctrl+C that stopped nothing (another session\'s work keeps running) · 130 Ctrl+C that stopped a job or a chat turn this Workbench started');
  });
});
