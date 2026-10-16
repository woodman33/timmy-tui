/**
 * R5 (H137; the rehearsal's one console error): the states of a canvas page's session that this server keeps, but that does not
 * count for the project named now: given for another project (`project`), or by another REPL than the one holding it now
 * (`holder`). A page in one is paused: its cards are diagrams until it counts again (companion/studio-canvas/src/cards.js). It
 * learns of it only from an answer: a REPL's /canvas open names its project while the page is open, and the page's next reading
 * is the first to hear it. So a reading the page makes by itself refuses a paused session with a plain 200 and nothing of the
 * project (src/studio/canvas-auth.ts refuseReading): no failed request for the browser to log. No credential, a forged one and
 * a session that ended (`none`, `unknown`, `expired`) are still refused with 401, as every write and action is.
 *
 * Imports nothing: the routes of project-link.ts, card-relay.ts and canvas-auth.ts all use it.
 */

/** The paused states of a session this server keeps. */
export const PAUSED_SESSION: ReadonlySet<string> = new Set(['project', 'holder']);

/** Whether a refusal is of a paused session, rather than of none, a forged one or one that ended. */
export const pausedRefusal = (why: string): boolean => PAUSED_SESSION.has(why);
