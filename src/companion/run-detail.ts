/**
 * R4 (H104, second part): one operation's run detail in the companion, opened by its operation id (the operator's direction
 * of 2026-10-11: "one shared Run detail view, linkable from Chat, Studio nodes, Activity, ..."). The page's address for it
 * is http://127.0.0.1:<port>/run/<operation id> (the companion's page, its RUN DETAIL tab open on that id); the page reads the
 * detail from GET /api/run/<operation id>?project=<project id>, with the companion's token, as every content route.
 *
 * The detail is src/contracts/run-detail.ts's RunDetail, made only by its producer, src/ops/run-detail.ts (H102's
 * `runDetail(operationId, { project })`); the companion computes none of it. Where this revision has no producer yet, the
 * endpoint says so in words (ok false) and shows nothing; a test gives a producer of its own (CompanionOptions.runDetail), a
 * FIXTURE labelled as one. What the producer answers is checked before it is sent: a run detail of another version is not
 * drawn as this one (the producer and every renderer change together), and a refusal or failure is sent as words, with the
 * home folder written as ~ and no stack.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_DETAIL_VERSION, type RunDetail } from '../contracts/run-detail.js';
import { scrubHomes, scrubStrings } from '../utils/home-scrub.js';

/** An operation id: o and 8 hex digits (src/contracts/run-detail.ts). */
export const OPERATION_ID = /^o[0-9a-f]{8}$/;

/** What a producer answers: the run detail; or why there is none (`{ error }`, or nothing: no such operation). */
export type RunDetailAnswer = RunDetail | { error: string } | null | undefined;
export type RunDetailProducer = (operation: string, o: { project?: string }) => RunDetailAnswer | Promise<RunDetailAnswer>;

export const RUN_NOT_AN_ID = 'Not an operation id: an operation id is o and 8 hex digits (o1a2b3c4d), as Timmy prints it.';
export const RUN_NO_PRODUCER = 'This revision of Timmy has no run-detail producer yet (src/ops/run-detail.ts, which `timmy op` will use), so the companion shows no run detail: nothing was read.';

/**
 * Why there is no run detail to draw: no producer in this revision, no such operation (or the producer refused it, in its
 * words), a run detail of another version, something that is not one, or a project the companion does not know.
 */
export type RunRefusal = 'no-producer' | 'unknown' | 'refused' | 'version' | 'not-a-run-detail' | 'project';

/**
 * The answer GET /api/run/:op sends: its status and body. A refusal is an answer (200, ok false, its words): the page asked
 * rightly and is told why there is none, so a page that opens a run Timmy has no record of logs no failed request (r25's
 * D11: the page's console holds no error). An id that is not an operation id is a 400 (the page never asks for one), and a
 * producer that failed a 500, in words.
 */
export interface RunAnswer { status: number; body: { ok: true; detail: RunDetail } | { ok: false; error: string; reason?: RunRefusal } }

const words = (s: string, max = 600): string => {
  const one = scrubHomes(String(s)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The producer this revision has (src/ops/run-detail.ts), or null when it is not here. */
export async function builtInProducer(): Promise<RunDetailProducer | null> {
  const beside = (ext: string): string => fileURLToPath(new URL(`../ops/run-detail.${ext}`, import.meta.url));
  if (!existsSync(beside('js')) && !existsSync(beside('ts'))) return null;
  // a name tsc does not resolve: the module is H102's, and may not be in this revision
  const spec = '../ops/run-detail.js';
  const m = (await import(spec)) as { runDetail?: unknown };
  return typeof m.runDetail === 'function' ? (m.runDetail as RunDetailProducer) : null;
}

/** Whether `v` is a run detail of the version this companion draws (the fields it cannot draw without). */
function drawable(v: Record<string, unknown>): boolean {
  return v.version === RUN_DETAIL_VERSION && typeof v.operation === 'string' && v.verdict !== null && typeof v.verdict === 'object'
    && v.stage !== null && typeof v.stage === 'object' && Array.isArray(v.exits) && Array.isArray(v.files) && Array.isArray(v.unknown);
}

/**
 * The run detail of `operation` in the project at `root`, asked of `producer` (the built-in one when it is undefined), as
 * the page is sent it.
 */
export async function runDetailAnswer(operation: string, root: string, producer?: RunDetailProducer): Promise<RunAnswer> {
  if (!OPERATION_ID.test(operation)) return { status: 400, body: { ok: false, error: RUN_NOT_AN_ID } };
  let make: RunDetailProducer | null;
  try { make = producer ?? await builtInProducer(); } catch (err) {
    return { status: 500, body: { ok: false, error: `The run-detail producer could not be loaded: ${words(err instanceof Error ? err.message.split('\n')[0] : String(err))}. Nothing was read.` } };
  }
  if (!make) return { status: 200, body: { ok: false, reason: 'no-producer', error: RUN_NO_PRODUCER } };
  let got: RunDetailAnswer;
  try { got = await make(operation, { project: root }); } catch (err) {
    return { status: 500, body: { ok: false, error: `The run detail of ${operation} could not be made: ${words(err instanceof Error ? err.message.split('\n')[0] : String(err))}` } };
  }
  if (got === null || got === undefined) return { status: 200, body: { ok: false, reason: 'unknown', error: `No operation ${operation} in this project's records.` } };
  const v = got as unknown as Record<string, unknown>;
  if (typeof v.error === 'string') return { status: 200, body: { ok: false, reason: 'refused', error: words(v.error) } };
  if (v.version !== RUN_DETAIL_VERSION && typeof v.version === 'number') {
    return { status: 200, body: { ok: false, reason: 'version', error: `The run detail of ${operation} is version ${v.version}; this companion draws version ${RUN_DETAIL_VERSION}, so it shows none (the producer and the companion change together).` } };
  }
  if (!drawable(v)) return { status: 200, body: { ok: false, reason: 'not-a-run-detail', error: `What the producer gave for ${operation} is not a run detail this companion can draw, so it shows none.` } };
  if (v.operation !== operation) return { status: 200, body: { ok: false, reason: 'not-a-run-detail', error: `The producer gave the run detail of ${words(String(v.operation), 40)} when ${operation} was asked for, so none is shown.` } };
  // the home folder as ~ wherever a path is named (the project's folder, a file, a record)
  return { status: 200, body: { ok: true, detail: scrubStrings(got as RunDetail, (t) => scrubHomes(t)) } };
}
