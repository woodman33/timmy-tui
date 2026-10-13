/**
 * How a stop is said in a run's record (r19, ledger row 158, finding F2).
 *
 * A flow or a VoxVision action is stopped through its AbortController. The REPL's /stop (and the live board's Stop, which
 * types it) aborts it without a reason; the other stops give their own words as the abort's reason: `timmy act` on a
 * signal, its time limit or a run without --wait, and the REPL ending. r19 saw a flow stopped by a SIGINT to `timmy act`
 * recorded as "stopped with /stop", which no one had typed.
 */

/** The words when no stop said otherwise: the REPL's /stop (or the board's Stop). */
export const STOPPED_WITH_STOP = 'with /stop';

/** The reason a stop gives, at most one line of 200 characters ('' for none). */
export function stopReason(why: string | undefined): string {
  return (why ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** "stopped with /stop", or "stopped <the words its stop gave>" (an abort's string reason). */
export function stoppedWords(signal: AbortSignal): string {
  const r = typeof signal.reason === 'string' ? stopReason(signal.reason) : '';
  return `stopped ${r || STOPPED_WITH_STOP}`;
}

/** The reason `timmy act` gives the runs it stops: "by timmy act (SIGINT received)". */
export const actStopReason = (why: string): string => stopReason(`by timmy act (${why})`);

/** The reason the REPL's end gives the runs it stops. */
export const REPL_END_REASON = 'as the REPL ended';

/**
 * A code agent's cancelled run, from its job's end: the words its stop gave (`timmy act`, the REPL's end), else the
 * REPL's /stop (the job alone cannot tell /stop from an end that gave no words).
 */
export const cancelledWhy = (stopBy?: string): string => `stopped ${stopBy ? stopReason(stopBy) || STOPPED_WITH_STOP : 'with /stop (or the REPL ended)'} before it finished`;
