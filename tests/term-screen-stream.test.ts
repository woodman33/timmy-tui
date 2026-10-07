import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ERASE_SAVED_LINES, screenStream } from '../src/term/screen-stream.js';

// C-11 (row 27): Ink clears the whole terminal with ED 2 + ED 3 + home on a frame that fills or
// overflows the screen and on its last frame at exit. ED 3 erases saved lines, and some terminals
// (VTE) drop the main screen's scrollback even when it is sent from the alternate screen. The
// monitor draws through this stream, which passes everything else unchanged.
function fakeTty() {
  const out = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  out.isTTY = true;
  out.columns = 100;
  out.rows = 30;
  let written = '';
  out.on('data', (d: Buffer) => { written += d.toString('utf8'); });
  return { out, written: () => written };
}

describe('the monitor\'s screen stream', () => {
  it('drops ED 3 and passes every other byte, including the rest of a full clear', async () => {
    const { out, written } = fakeTty();
    const s = screenStream(out as unknown as NodeJS.WriteStream);
    s.write(`\x1b[2J${ERASE_SAVED_LINES}\x1b[Hframe`);
    s.write('\x1b[3Jtail\x1b[3J');
    await new Promise((r) => setImmediate(r));
    expect(written()).toBe('\x1b[2J\x1b[Hframetail');
  });
  it('runs every text chunk through its transform, after dropping ED 3', async () => {
    const { out, written } = fakeTty();
    const s = screenStream(out as unknown as NodeJS.WriteStream, (t) => t.toUpperCase());
    s.write(`a${ERASE_SAVED_LINES}b`);
    await new Promise((r) => setImmediate(r));
    expect(written()).toBe('AB');
  });
  it('is the terminal for everything else: size, TTY, resize events, the write callback', async () => {
    const { out } = fakeTty();
    const s = screenStream(out as unknown as NodeJS.WriteStream);
    let resized = 0;
    s.on('resize', () => { resized++; });
    out.emit('resize');
    out.columns = 80;
    const done = await new Promise<boolean>((r) => s.write('', () => r(true)));
    expect({ isTTY: s.isTTY, columns: s.columns, rows: s.rows, resized, done }).toEqual({ isTTY: true, columns: 80, rows: 30, resized: 1, done: true });
  });
});
