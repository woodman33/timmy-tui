/**
 * Timmy Cloud's backend: a test hook that kills the backend's own process at a named point.
 *
 * Off unless TIMMY_CLOUD_TEST_CRASH_AT is set, as `<point>:<n>`: the n-th time this process reaches <point>, it sends
 * itself SIGKILL, which ends it at once with no handler, no flush and no cleanup: a real crash of a real process. The
 * crash tests (tests/cloud-crash.test.ts) use it to stop the backend between any two writes of its event log.
 *
 * Points: log:before-write (an event is about to be written), log:mid-write (half an event line is written and made
 * durable, then the process dies: a torn line), log:after-write (an event is durable), call:after-intent (a provider
 * call is written ahead and not yet sent), call:after-answer (the provider answered and the answer is not yet written).
 */
export const CRASH_ENV = 'TIMMY_CLOUD_TEST_CRASH_AT';
export const CRASH_POINTS = ['log:before-write', 'log:mid-write', 'log:after-write', 'call:after-intent', 'call:after-answer'] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export class Failpoints {
  private readonly counts = new Map<string, number>();

  constructor(private readonly spec: { point: CrashPoint; nth: number } | null) {}

  /** Reads TIMMY_CLOUD_TEST_CRASH_AT; a malformed value is refused rather than ignored. */
  static fromEnv(env: NodeJS.ProcessEnv): Failpoints {
    const raw = env[CRASH_ENV];
    if (!raw) return new Failpoints(null);
    const m = raw.match(/^([a-z]+:[a-z-]+):([1-9][0-9]*)$/);
    if (!m || !(CRASH_POINTS as readonly string[]).includes(m[1])) {
      throw new Error(`${CRASH_ENV} must be <point>:<n> with a point among ${CRASH_POINTS.join(', ')}.`);
    }
    return new Failpoints({ point: m[1] as CrashPoint, nth: Number(m[2]) });
  }

  get armed(): boolean { return this.spec !== null; }

  /** Counts a visit to `point`; true when this visit is the one the hook names. */
  reached(point: CrashPoint): boolean {
    if (!this.spec || this.spec.point !== point) return false;
    const n = (this.counts.get(point) ?? 0) + 1;
    this.counts.set(point, n);
    return n === this.spec.nth;
  }

  /** Dies here when this visit is the one the hook names. */
  crashIfReached(point: CrashPoint): void {
    if (this.reached(point)) crashNow();
  }
}

/** SIGKILL to this very process: it ends at once, mid-function. */
export function crashNow(): never {
  process.kill(process.pid, 'SIGKILL');
  // SIGKILL is delivered at once; this line exists for the type checker.
  process.exit(137);
}
