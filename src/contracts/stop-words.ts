/**
 * R6 (H140; the operator's order of 2026-10-16, priority 2: "Preserve truthful distinctions between chat cancellation and
 * workflow-job cancellation"; the R5 interaction review's claim e saw two sets of stop words on the surfaces): the ONE table
 * of stop words. A chat turn and a workflow job are different things, and every surface names each the same way.
 *
 *   kind        word        what the records mean                                          who asked
 *   chat turn   stopped     a person stopped it while it was answered (Esc, Ctrl+C, a page's   its receipt's stopped_by when
 *                           Stop, the Workbench's x): what it had streamed is kept as it was,  another surface asked; else the
 *                           and what its tools did stands: nothing is rolled back              surface that sent it ("by you"
 *                                                                                              there)
 *   job         cancelled   a workflow job ended by a cancel (x, /stop, timmy act, the end of  the job record's own words
 *                           its session): its process group was ended (SIGTERM, then SIGKILL
 *                           after its grace)
 *   job step    cancelled   the step it was running when the cancel came (its record says stopped)
 *               not run     a step it never reached
 *
 * Sealed receipts keep the values they were sealed with (a chat turn's status "cancelled" and its subject "… · cancelled · …";
 * a job step's state "stopped"): receipts are immutable, so only the words shown change, here.
 */

/** A chat turn a person stopped. */
export const TURN_STOPPED = 'stopped' as const;
/** A workflow job a cancel ended. */
export const JOB_CANCELLED = 'cancelled' as const;
/** The step a job was running when the cancel came. */
export const STEP_CANCELLED = 'cancelled' as const;
/** A step a cancelled job never reached. */
export const STEP_NOT_RUN = 'not run' as const;
/** The mark of both (with its word beside it, never alone). */
export const STOP_MARK = '■' as const;
/** What a stopped turn's tools did. */
export const TURN_NOT_ROLLED_BACK = 'what its tools did stands: nothing is rolled back';
/** What a cancel did to a job's processes. */
export const JOB_GROUP_ENDED = 'its process group was ended';

/** The surfaces a chat turn is sent from or stopped from, in words. */
const SURFACE_NAMES: Readonly<Record<string, string>> = {
  repl: 'the REPL', workbench: 'the Workbench', monitor: 'the monitor', companion: 'the companion', unknown: 'another surface',
};
export const surfaceName = (s: string): string => SURFACE_NAMES[s] ?? s;

/** A chat turn's end from its receipt's status (as sealed: ok, cancelled, failed or another error word). */
export const turnState = (status: string | undefined): 'answered' | 'stopped' | 'failed' => ((status ?? 'ok') === 'ok' ? 'answered' : status === 'cancelled' ? 'stopped' : 'failed');

/** Who asked a stopped turn to stop: another surface its receipt names (stopped_by), else the surface that sent it. */
export const turnAsker = (t: { surface: string; stoppedBy?: string }): string => t.stoppedBy || t.surface;

/**
 * A stopped turn in words, with who asked: "stopped (asked from the companion)"; on the surface that asked (`here`), "stopped
 * by you".
 */
export function turnStoppedWords(t: { surface: string; stoppedBy?: string }, here?: string): string {
  const asker = turnAsker(t);
  return here !== undefined && here === asker ? `${TURN_STOPPED} by you` : `${TURN_STOPPED} (asked from ${surfaceName(asker)})`;
}

/** How a chat turn ended, in words: answered, failed, or stopped with who asked (src/contracts/workspace.ts WorkspaceTurn). */
export function turnEndWords(t: { state: 'answered' | 'stopped' | 'failed'; surface: string; stoppedBy?: string }, here?: string): string {
  return t.state === 'stopped' ? turnStoppedWords(t, here) : t.state;
}

/**
 * The REPL's line for a turn it stopped (`by`: the surface that asked, in words, when another one did): "Stopped by you." or
 * "Stopped, asked from the companion."; what its tools did follows it (src/repl/transcript.ts cancelOutcome).
 */
export const turnStopHead = (by?: string): string => (by ? `Stopped, asked from ${by}.` : 'Stopped by you.');

/** A job's state in words (its record's: queued, running, ready, completed, failed, cancelled). */
export const jobStateWords = (state: string): string => (state === 'cancelled' ? JOB_CANCELLED : state);

/** A job step's state in words: the step a cancel ended is cancelled (its record says stopped). */
export const stepStateWords = (state: string): string => (state === 'stopped' || state === 'cancelled' ? STEP_CANCELLED : state);

/** A receipt as sealed (only the fields its words read). */
export interface SealedSubject { kind?: unknown; subject?: unknown; status?: unknown; stopped_by?: unknown }

/** A chat turn's receipt (src/repl/seal.ts sealTurn: kind turn for the REPL's, kind chat "chat.turn · <surface> · …" for the others). */
const turnSurfaceOf = (r: SealedSubject): string | null => {
  if (r.kind === 'turn') return 'repl';
  if (r.kind !== 'chat') return null;
  const m = /^chat\.turn · (repl|monitor|workbench|companion)(?: · |$)/.exec(String(r.subject ?? ''));
  return m ? m[1] : null;
};

/**
 * A receipt's subject as shown: a stopped chat turn's "cancelled" (its sealed status word) is said "stopped (asked from …)",
 * with who asked; every other subject, a job's "cancelled" among them, as sealed. The receipt itself is never changed.
 */
export function receiptSubjectWords(r: SealedSubject): string {
  const subject = String(r.subject ?? '');
  const surface = turnSurfaceOf(r);
  if (!surface || r.status !== 'cancelled') return subject;
  const words = turnStoppedWords({ surface, ...(typeof r.stopped_by === 'string' && r.stopped_by ? { stoppedBy: r.stopped_by } : {}) });
  return subject.replace(/(^| · )cancelled( · |$)/, `$1${words}$2`);
}
