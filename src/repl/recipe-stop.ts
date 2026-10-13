/**
 * The REPL's own durable cancel for the recipe jobs it starts (round R4, helper H17; the review of 07f37ec, finding 4).
 *
 * A recipe runs as a durable job whose detached supervisor owns the native process (lanes/recipes/jobs.ts); the REPL
 * follows it with a watcher job (src/recipes/watch.ts) that asks the recipe's own cancel when it is stopped. The
 * watcher can do that only once its module has loaded and installed its SIGTERM handler, so a stop that lands earlier
 * (a /stop right after /recipe tray, the live board's Stop, /stop all, the REPL's end, a signal from elsewhere) would
 * end the watcher and leave the recipe running with nothing following it. The REPL knows each recipe's operation UUID
 * from the moment it is launched, so on every stop path it asks the recipe's own cancel first, keeps the answer, and
 * only then stops the watcher. The cancel is idempotent (the watcher's handler may ask again) and leaves a job that
 * already ended as it ended. Nothing here signals a process or reads a PID from disk.
 */
import { cancel, status, type JobState } from '../../lanes/recipes/jobs.js';

/** What the recipe's own cancel path answered when the REPL asked it. */
export interface RecipeCancel {
  operation: string;
  /** the recipe's state before the request; absent when it could not be read */
  before?: JobState;
  /** the state and progress the recipe reports after the request */
  state?: JobState;
  progress?: string;
  /** a cancel is requested (by this request, or one before it) on a recipe that had not ended; false when it had ended */
  requested: boolean;
  /** why the request failed, when it did */
  error?: string;
}

const LIVE: ReadonlySet<string> = new Set(['queued', 'running']);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Asks the recipe's own cancel path (lanes/recipes/jobs.ts cancel) for one recipe job and says what it answered. Never throws. */
export function cancelRecipe(root: string, operation: string): RecipeCancel {
  try {
    const before = status(root, operation);
    if (!LIVE.has(before.state)) return { operation, before: before.state, state: before.state, progress: before.progress, requested: false };
    const after = cancel(root, operation);
    const requested = after.state === 'cancelled' || after.progress === 'cancellation-requested';
    return { operation, before: before.state, state: after.state, progress: after.progress, requested };
  } catch (e) {
    return { operation, requested: false, error: message(e) };
  }
}

/** One plain sentence for the transcript: what the cancel did, and the exact command that shows or repeats it. */
export function cancelSentence(a: RecipeCancel): string {
  if (a.error) return `recipe ${a.operation}: the cancel request failed (${a.error}); /recipe status shows it; /recipe cancel ${a.operation} asks again`;
  if (a.before && !LIVE.has(a.before)) return `recipe ${a.operation} had already ${a.before}; left as it ended`;
  if (!a.requested) return `recipe ${a.operation} ${a.state} (${a.progress}) when the cancel came; left as it ended`;
  return `recipe ${a.operation}: cancel requested through the recipe's own path; now ${a.state} (${a.progress}); /recipe status shows it end`;
}

/**
 * The recipes being launched right now, by UUID: from just before a recipe's supervisor starts until its watcher job
 * exists (or its start has failed). The REPL's end cancels them too, and stops any watcher from starting after it.
 */
export class RecipeLaunches {
  private readonly launching = new Map<string, string>();
  private readonly starts = new Set<Promise<unknown>>();
  private ending = false;

  /** Once the REPL is ending, no recipe watcher may start. */
  get closing(): boolean { return this.ending; }

  /** A recipe (UUID, project root) is about to be launched; the returned function says its launch has settled. */
  add(operation: string, root: string): () => void {
    this.launching.set(operation, root);
    return () => { this.launching.delete(operation); };
  }

  /** Keeps a start under way (a /recipe command or the agent's run_recipe) until it settles. */
  track<T>(p: Promise<T>): Promise<T> {
    this.starts.add(p);
    const done = (): void => { this.starts.delete(p); };
    p.then(done, done);
    return p;
  }

  /** Settles when every start under way has settled. */
  settled(): Promise<unknown> { return Promise.allSettled([...this.starts]); }

  /** The REPL is ending: no watcher starts from now on, and each recipe being launched is cancelled through its own path. */
  close(): RecipeCancel[] {
    this.ending = true;
    return [...this.launching].map(([operation, root]) => cancelRecipe(root, operation));
  }
}

/**
 * A recipe the REPL can no longer follow, because its watcher did not start: it is cancelled through its own path, and
 * the answer says so with the command that shows it end, or the exact commands when even the cancel failed.
 */
export function cancelUnfollowed(root: string, operation: string, why: string): string {
  const a = cancelRecipe(root, operation);
  if (a.error) return `job ${operation} started, but ${why}, and the cancel request failed (${a.error}); it may still be running: /recipe status shows it, /recipe cancel ${operation} cancels it`;
  if (a.before && !LIVE.has(a.before)) return `job ${operation} started, but ${why}; it had already ${a.before} and was left as it ended: /recipe status`;
  if (!a.requested) return `job ${operation} started, but ${why}; it was ${a.state} (${a.progress}) when the cancel came and was left as it ended: /recipe status`;
  return `job ${operation} started, but ${why}; so that nothing runs unfollowed, cancel requested through the recipe's own path: now ${a.state} (${a.progress}); /recipe status shows it end`;
}
