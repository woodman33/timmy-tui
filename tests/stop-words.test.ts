/**
 * r19 (ledger row 158), finding F2: how a stop is said in a run's record. The REPL's /stop aborts without a reason and is
 * said "with /stop"; every other stop gives its own words as the abort's reason, kept to one bounded line.
 */
import { describe, expect, it } from 'vitest';
import { actStopReason, cancelledWhy, REPL_END_REASON, stoppedWords, stopReason } from '../src/utils/stop-words.js';

const aborted = (reason?: unknown): AbortSignal => { const c = new AbortController(); c.abort(reason); return c.signal; };

describe('stop words', () => {
  it('/stop gives no reason and is said as /stop; another stop is said in its own words', () => {
    expect(stoppedWords(aborted())).toBe('stopped with /stop');
    expect(stoppedWords(aborted(new Error('not words')))).toBe('stopped with /stop');
    expect(stoppedWords(aborted('   '))).toBe('stopped with /stop');
    expect(stoppedWords(aborted(actStopReason('SIGINT received')))).toBe('stopped by timmy act (SIGINT received)');
    expect(stoppedWords(aborted(REPL_END_REASON))).toBe('stopped as the REPL ended');
  });

  it('a reason is one line of at most 200 characters, control characters out', () => {
    expect(stopReason('by\ntimmy\x1b[31m act')).toBe('by timmy [31m act');
    expect(stopReason('x'.repeat(500))).toHaveLength(200);
    expect(stopReason(undefined)).toBe('');
  });

  it('a code agent\'s cancelled run: the words its stop gave, else /stop or the REPL\'s end, which the job cannot tell apart', () => {
    expect(cancelledWhy()).toBe('stopped with /stop (or the REPL ended) before it finished');
    expect(cancelledWhy(actStopReason('run without --wait'))).toBe('stopped by timmy act (run without --wait) before it finished');
    expect(cancelledWhy(REPL_END_REASON)).toBe('stopped as the REPL ended before it finished');
  });
});
