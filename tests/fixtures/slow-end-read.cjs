// FAKE (a test fixture, R4 H82): a slow disk for one read, loaded with --require into a `timmy act` or `timmy md` process.
// The one read it slows is the receipts store's runs.jsonl read by act's or md's own end (src/ops/act.ts, src/cli-md.ts:
// the readChain that gathers the operation's receipts for the last JSON), once the file TIMMY_TEST_HOLD_ARM names exists:
// it writes TIMMY_TEST_HOLD_HELD (the process's pid) and blocks for TIMMY_TEST_HOLD_MS (default 3000) before reading, as a
// slow disk would. That holds the end open long enough for a test to send a second signal into it. Nothing else changes:
// every other read goes through at once, and nothing is written but the held file.
'use strict';
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const arm = process.env.TIMMY_TEST_HOLD_ARM;
const held = process.env.TIMMY_TEST_HOLD_HELD;
const ms = Number(process.env.TIMMY_TEST_HOLD_MS || 3000);
if (arm && held) {
  const read = fs.readFileSync;
  let done = false;
  /** Whether this read is the end's: the frame after readChain's is in src/ops/act.ts or src/cli-md.ts. */
  const atTheEnd = () => {
    const frames = String(new Error().stack).split('\n');
    const at = frames.findIndex((l) => /\breadChain\b/.test(l));
    return at >= 0 && /[\\/]src[\\/](ops[\\/]act|cli-md)\.ts/.test(frames[at + 1] || '');
  };
  fs.readFileSync = function readFileSync(file, ...rest) {
    if (!done && typeof file === 'string' && file.endsWith('runs.jsonl') && fs.existsSync(arm) && atTheEnd()) {
      done = true;
      fs.writeFileSync(held, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    return read.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
}
