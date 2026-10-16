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
 *
 * R6 (H144): and beside it the run INSPECTED (src/ops/run-detail.ts runInspection): its source as it ran, its changes with
 * their diffs, its outputs previewed (an image as a data: address the page draws) and its receipts, each verified by Timmy's
 * own verifier when this answer is made, on this server: the page draws a verified mark only where this answer says one
 * verified, and assumes none. A test's producer may carry its own inspector (`producer.inspect`, a FIXTURE); one without
 * gives the detail alone, and the answer says why there is no inspection. An inspection that cannot be made leaves the
 * detail as it is, with the inspection's own words.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_DETAIL_VERSION, type RunDetail } from '../contracts/run-detail.js';
import type { RunInspection } from '../ops/run-detail.js';
import { scrubHomes, scrubStrings } from '../utils/home-scrub.js';

/** An operation id: o and 8 hex digits (src/contracts/run-detail.ts). */
export const OPERATION_ID = /^o[0-9a-f]{8}$/;

/** What a producer answers: the run detail; or why there is none (`{ error }`, or nothing: no such operation). */
export type RunDetailAnswer = RunDetail | { error: string } | null | undefined;
/** R6 (H144): what an inspector answers: the run inspected (src/ops/run-detail.ts RunInspection), or it throws why not. */
export type RunInspector = (operation: string, o: { project?: string; images?: number }) => unknown | Promise<unknown>;
export type RunDetailProducer = ((operation: string, o: { project?: string }) => RunDetailAnswer | Promise<RunDetailAnswer>) & { inspect?: RunInspector };

export const RUN_NOT_AN_ID = 'Not an operation id: an operation id is o and 8 hex digits (o1a2b3c4d), as Timmy prints it.';
export const RUN_NO_PRODUCER = 'This revision of Timmy has no run-detail producer yet (src/ops/run-detail.ts, which `timmy op` will use), so the companion shows no run detail: nothing was read.';
/** R6 (H144): the inspection this answer is made with: version 1 (src/ops/run-detail.ts RUN_INSPECTION_VERSION). */
export const RUN_INSPECTION_DRAWN = 1;
/** R6 (H144): the largest image an inspection sends as a data: address for the page to draw (IMAGE_DATA_MAX there). */
export const RUN_IMAGE_BYTES = 1024 * 1024;
export const RUN_NO_INSPECTOR = 'Its producer gives no inspection of the run (its source, changes, outputs and receipts), so only its run detail is shown.';

/**
 * Why there is no run detail to draw: no producer in this revision, no such operation (or the producer refused it, in its
 * words), a run detail of another version, something that is not one, or a project the companion does not know.
 */
export type RunRefusal = 'no-producer' | 'unknown' | 'refused' | 'version' | 'not-a-run-detail' | 'project';

/**
 * The answer GET /api/run/:op sends: its status and body. A refusal is an answer (200, ok false, its words): the page asked
 * rightly and is told why there is none, so a page that opens a run Timmy has no record of logs no failed request (r25's
 * D11: the page's console holds no error). An id that is not an operation id is a 400 (the page never asks for one), and a
 * producer that failed a 500, in words. R6 (H144): with it, the run inspected (`inspection`), or null and why not.
 */
export interface RunAnswer {
  status: number;
  body: { ok: true; detail: RunDetail; inspection: RunInspection | null; inspectionWhy?: string } | { ok: false; error: string; reason?: RunRefusal };
}

const words = (s: string, max = 600): string => {
  const one = scrubHomes(String(s)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The producer module this revision has (src/ops/run-detail.ts), or null when it is not here. */
async function builtInModule(): Promise<Record<string, unknown> | null> {
  const beside = (ext: string): string => fileURLToPath(new URL(`../ops/run-detail.${ext}`, import.meta.url));
  if (!existsSync(beside('js')) && !existsSync(beside('ts'))) return null;
  // a name tsc does not resolve: loaded when a run detail is first asked for, not when the companion starts
  const spec = '../ops/run-detail.js';
  return (await import(spec)) as Record<string, unknown>;
}

/** The producer this revision has (src/ops/run-detail.ts), with its inspector, or null when it is not here. */
export async function builtInProducer(): Promise<RunDetailProducer | null> {
  const m = await builtInModule();
  if (!m || typeof m.runDetail !== 'function') return null;
  const make = m.runDetail as (operation: string, o: { project?: string }) => RunDetailAnswer;
  const producer: RunDetailProducer = (operation, o) => make(operation, o);
  if (typeof m.runInspection === 'function') producer.inspect = m.runInspection as RunInspector;
  return producer;
}

/** Whether `v` is a run detail of the version this companion draws (the fields it cannot draw without). */
function drawable(v: Record<string, unknown>): boolean {
  return v.version === RUN_DETAIL_VERSION && typeof v.operation === 'string' && v.verdict !== null && typeof v.verdict === 'object'
    && v.stage !== null && typeof v.stage === 'object' && Array.isArray(v.exits) && Array.isArray(v.files) && Array.isArray(v.unknown);
}

/** Whether `v` is an inspection of the version this companion draws, of `operation`. */
function inspectable(v: unknown, operation: string): v is RunInspection {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && o.version === RUN_INSPECTION_DRAWN && o.operation === operation && !!o.source && typeof o.source === 'object'
    && !!o.changes && Array.isArray((o.changes as { list?: unknown }).list) && Array.isArray(o.outputs) && !!o.receipts && Array.isArray((o.receipts as { list?: unknown }).list) && Array.isArray(o.actions);
}

/** Every string but a data: address with the home folder as ~ (a path, a file's line, a record's words). */
const scrubbed = <T>(v: T): T => scrubStrings(v, (t) => (t.startsWith('data:') ? t : scrubHomes(t)));

/** The run inspected by `inspect`, checked, or null and why not (never thrown). */
async function inspected(operation: string, root: string, inspect: RunInspector | undefined): Promise<{ inspection: RunInspection | null; why?: string }> {
  if (!inspect) return { inspection: null, why: RUN_NO_INSPECTOR };
  let got: unknown;
  try { got = await inspect(operation, { project: root, images: RUN_IMAGE_BYTES }); } catch (err) {
    const first = words(err instanceof Error ? err.message.split('\n')[0] : String(err));
    return { inspection: null, why: `The run could not be inspected: ${first}` };
  }
  if (!inspectable(got, operation)) {
    const version = (got as { version?: unknown } | null)?.version;
    return { inspection: null, why: typeof version === 'number' && version !== RUN_INSPECTION_DRAWN ? `Its inspection is version ${version}; this companion draws version ${RUN_INSPECTION_DRAWN}, so it shows none.` : `What the inspector gave for ${operation} is not an inspection this companion can draw, so it shows none.` };
  }
  return { inspection: scrubbed(got) };
}

/**
 * The run detail of `operation` in the project at `root`, asked of `producer` (the built-in one when it is undefined), as
 * the page is sent it; R6 (H144): with the run inspected by the producer's inspector (the built-in one's, when it is the
 * built-in producer).
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
    // R4 lead (merge of H102 and H104): H102's producer throws a RunDetailError (with its `refusal`: 'not an id', 'unknown',
    // 'other project', 'unreadable') for an operation it gives no run detail of: a refusal in words, as the page is told
    const refusal = err instanceof Error ? (err as Error & { refusal?: unknown }).refusal : undefined;
    if (typeof refusal === 'string') {
      return { status: 200, body: { ok: false, reason: refusal === 'unknown' ? 'unknown' : 'refused', error: words(err instanceof Error ? err.message.split('\n')[0] : String(err)) } };
    }
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
  // R6 (H144): the run inspected, made now (its receipts verified now, on this server)
  const ins = await inspected(operation, root, make.inspect);
  // the home folder as ~ wherever a path is named (the project's folder, a file, a record)
  return { status: 200, body: { ok: true, detail: scrubStrings(got as RunDetail, (t) => scrubHomes(t)), inspection: ins.inspection, ...(ins.why ? { inspectionWhy: ins.why } : {}) } };
}
