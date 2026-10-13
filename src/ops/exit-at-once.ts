/**
 * Round R4 (helper H88; the Mac run r23, scripted): a second Ctrl-C to `timmy act` or `timmy md`, while the first one's stop
 * still ran. Both exited 3 at once with nothing on stdout (r23: 0 bytes of JSON), and md left its job record (endedAt null,
 * no receipt) and its operation record ("running", its owner gone) for a later /recover to settle.
 *
 * The second signal still exits at once with 3: nothing slow, nothing awaited. Before it does, what can be settled at once
 * is settled, synchronously, and said:
 *   - what the request started is signalled as before (Workspace.killNow: each live job's process group gets SIGTERM, each
 *     flow and VoxVision action is told to stop), and not waited for;
 *   - each /run job it started that still runs has its record ended now (JobManager.endAtOnce: cancelled, the step that
 *     ran recorded stopped, words naming the second signal, `exitedAtOnce`); nothing is sealed for it now (sealing reads the
 *     receipts chain and the run's files): the receipt of each block not sealed yet is left for /recover, which seals it as
 *     cut by this stop (src/repl/workflow-recover.ts); the run's own receipt is not sealed later either;
 *   - every other run it started (a code agent's job, a flow, a VoxVision action, a native run) keeps its record as it is
 *     now: each writes its end only once what it runs has stopped, which this process no longer waits for; /recover records
 *     it, as it records what an ended REPL left;
 *   - the operation's record is ended now, stopped, with why in words (the first signal's stop, the second signal, what was
 *     settled, what was not sealed and what /recover does);
 * and the caller prints its end (the JSON with --json) with all of it, through writeNow, before it exits.
 */
import { writeSync } from 'node:fs';
import type { JobRecord } from '../jobs/index.js';
import type { Workspace } from '../repl/workspace.js';
import type { OperationHandle } from './operations.js';

/** What the second signal settled at once, did not seal, and left for /recover, in words. */
export interface AtOnce {
  signal: NodeJS.Signals;
  /** each record ended at once: "operation o…: stopped", "job j…: cancelled" */
  settled: string[];
  /** what was not sealed (nothing is sealed at once) */
  not_sealed: string[];
  /** what is left, and what a later /recover does about it */
  left_for_recover: string[];
  /** the job records ended at once, as written */
  jobs: JobRecord[];
  /** the request's end in words: the first signal's stop, then the second signal and all of the above */
  why: string;
}

const ENDED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Settles at once what the second signal can (see the module comment), synchronously. `first`: the first signal's stop words
 * (its why), or '' when none was under way; `closed`: the Workspace was already closed (nothing of it runs); `stopWords`: the
 * words the runs it stops keep (as killNow gives them).
 */
export function exitAtOnce(ws: Workspace, h: OperationHandle, o: { signal: NodeJS.Signals; who: 'timmy act' | 'timmy md'; first: string; closed: boolean; stopWords: string }): AtOnce {
  const { signal, who } = o;
  if (!o.closed) { try { ws.killNow(o.stopWords); } catch { /* it is exiting: what could not be signalled is left for /recover */ } }
  const error = `stopped by ${who} at once (a second ${signal}): ${who} exited without waiting for the run to end; its process group was sent SIGTERM and not waited for, and nothing was sealed for it then`;
  const settled: string[] = [];
  const notSealed: string[] = [];
  const left: string[] = [];
  const jobs: JobRecord[] = [];
  for (const run of h.runs) {
    if (run.kind !== 'job') {
      left.push(`${run.kind} ${run.id}: ${who} exited before its record said how it ended; /recover records what it can`);
      continue;
    }
    const before = ws.jobs.get(run.id);
    if (!before || ENDED.has(before.state)) continue; // it had ended: its own record says how
    const rec = before.kind === 'workflow' ? ws.jobs.endAtOnce(run.id, { error, by: who, signal }) : undefined;
    if (!rec) {
      left.push(`job ${run.id} (${before.label}): sent SIGTERM; its record still says ${before.state}; /recover records its end once its processes have ended`);
      continue;
    }
    jobs.push(rec);
    settled.push(`job ${run.id}: cancelled`);
    rec.steps.forEach((s, i) => {
      if (ws.blockReceiptOf(run.id, i)) return;
      notSealed.push(`block ${s.name} of run ${run.id} (${s.state === 'stopped' ? 'cut by the stop' : s.state === 'failed' ? 'its exit code not seen yet' : s.state})`);
      left.push(`/recover seals the receipt of block ${s.name} of run ${run.id}${s.state === 'stopped' ? ', as cut by this stop' : ''}`);
    });
    notSealed.push(`the run's own receipt (run ${run.id})`);
    left.push(`nothing seals run ${run.id}'s own receipt later: its job record and its block receipts say how it ended`);
  }
  const already = h.ended;
  const why = [
    already ? `it had already ended ${already.state} (${already.why})` : o.first,
    `a second ${signal}: ${who} exited at once, before what it started had ended`,
    settled.length ? `ended now: ${settled.join(', ')}` : '',
    notSealed.length ? `not sealed: ${notSealed.join('; ')}` : '',
    left.length ? `left for /recover: ${left.join('; ')}` : '',
  ].filter(Boolean).join('; ');
  if (!already) {
    ws.ops.end(h, 'stopped', why);
    // a joined operation's record is its first process's to write: only this request's part ended here
    if (h.joined) left.unshift(`operation ${h.id} (joined): its record is written by the Timmy that began it`);
    else if (h.recorded) settled.unshift(`operation ${h.id}: stopped`);
  }
  return { signal, settled, not_sealed: notSealed, left_for_recover: left, jobs, why };
}

/**
 * Writes all of `text` to `fd` now, synchronously, whatever the stream is (a pipe a reader drains a moment later is waited
 * on, up to 2 s): what a process that exits at once prints before process.exit, which does not wait for a stream's queue.
 */
export function writeNow(fd: number, text: string): void {
  const data = Buffer.from(text, 'utf8');
  const until = Date.now() + 2000;
  for (let off = 0; off < data.length;) {
    try { off += writeSync(fd, data, off, data.length - off); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN' || Date.now() > until) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
