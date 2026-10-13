// FAKE (a test fixture, R4 H114): a stop held at its start, loaded with --require into a `timmy act` or `timmy md` process.
// Once the file TIMMY_TEST_STOP_ARM names exists, the first SIGTERM the process sends to a process group from its job
// manager's stop (src/jobs/index.ts, through killProcessGroup: a /run job's stop) is held: it writes TIMMY_TEST_STOP_HELD
// (the process's pid), then waits, before that signal is sent, until the file TIMMY_TEST_STOP_RELEASE names exists
// (TIMMY_TEST_STOP_MS at most, default 30 000), and then sends it. While it waits the process runs nothing else, as a
// process the machine does not schedule would not.
//
// Why (the full suite at c56303c): a test that sends a second SIGINT 80 ms after the first cannot know that the second
// lands inside the first one's stop. Two SIGINTs that reach a process before it has run its handler for the first are one
// (a signal of a kind is pending once), and a test process's timer can fire after the stop (about 1 s) has ended. With
// this hold the held file proves the first signal was handled (the hold is inside its stop), and the stop cannot end
// before the test releases it (its first signal has not been sent), however late the test sends the second signal.
// Nothing else changes: every other signal goes at once, and nothing is written but the held file.
'use strict';
const fs = require('node:fs');

const arm = process.env.TIMMY_TEST_STOP_ARM;
const held = process.env.TIMMY_TEST_STOP_HELD;
const release = process.env.TIMMY_TEST_STOP_RELEASE;
const ms = Number(process.env.TIMMY_TEST_STOP_MS || 30000);
if (arm && held && release) {
  const kill = process.kill;
  let done = false;
  /** Whether this signal is the job manager's stop of a job: a frame of src/jobs/index.ts is on the stack. */
  const fromJobs = () => /[\\/]src[\\/]jobs[\\/]index\.ts/.test(String(new Error().stack));
  process.kill = function heldKill(pid, signal) {
    if (!done && typeof pid === 'number' && pid < -1 && signal === 'SIGTERM' && fs.existsSync(arm) && fromJobs()) {
      done = true;
      fs.writeFileSync(held, String(process.pid));
      const cell = new Int32Array(new SharedArrayBuffer(4));
      const end = Date.now() + ms;
      while (!fs.existsSync(release) && Date.now() < end) Atomics.wait(cell, 0, 0, 10);
    }
    return kill.call(process, pid, signal);
  };
}
