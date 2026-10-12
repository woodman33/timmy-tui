/**
 * Pi Durable, slice S1 (R4 H118): the two tools S1's FAKE runs use, the smallest pair that exercises both replay classes
 * of plan e.2. They act on real project files (project containment by src/project's resolveInside), and each can be made
 * slow (`delay_ms`, the window a test kills or stops in) and deaf to its abort signal (`ignore_abort`, spike D2). S3
 * replaces them with Timmy's dispatcher tools; Pi's own coding tools and NodeExecutionEnv are never offered (e.2: no root
 * restriction, shell strings).
 *
 * - `slow_read { path }`: read-only, `replay: "safe"`: a call interrupted by a kill reruns by itself (spike B). Each read
 *   is logged to .timmy/pi/reads.jsonl, so a test can count them.
 * - `slow_write { path, content, expected_sha256 }`: a compare-and-set write, `replay: "unsafe"` in S1. It refuses when
 *   the file's sha256 is not the expected one ('absent' for no file), writes nothing when the file already has the new
 *   bytes, and otherwise writes `started` to the effect ledger, then the file (temp file and rename), then waits
 *   `delay_ms`, then writes `ended` with a readback of the file's sha256. Its key (tool + path + run) is checked again
 *   here, as the dispatcher's own enforcement behind the guard hook (plan e.3.3).
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveInside } from '../project/index.js';
import type { PiApi, PiContext, ToolResult, ToolSpec } from './adapter/pi-api.js';
import { argsSha256, effectKey, type EffectLedger } from './effects.js';

export const MAX_DELAY_MS = 120_000;

export interface ToolHost {
  readonly root: string;
  readonly ledger: EffectLedger;
  readonly readsLog: string;
  /** the Timmy run of a Pi conversation */
  runOf(conversationId: number): string | undefined;
}

/** The file's sha256, or 'absent'. */
export function fileSha256(path: string): string {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return 'absent'; }
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Waits `ms`, ending early when the signal aborts (unless told to ignore it). */
async function wait(ms: number, context: PiContext, ignoreAbort: boolean): Promise<'done' | 'aborted'> {
  const signal = ignoreAbort ? undefined : context.abortSignal;
  if (signal?.aborted) return 'aborted';
  return new Promise((resolveWait) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolveWait('done'); }, ms);
    const onAbort = (): void => { clearTimeout(t); resolveWait('aborted'); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const delayOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(MAX_DELAY_MS, Math.round(v))) : 0);

/** The canonical target of an effect tool's call (a project-relative path), or an error. */
export function writeTarget(root: string, args: Record<string, unknown>): { target: string; path: string } | { error: string } {
  const at = resolveInside(root, String(args.path ?? ''));
  return 'error' in at ? { error: at.error } : { target: at.rel, path: at.path };
}

export function slowTools(pi: PiApi, host: ToolHost): ToolSpec[] {
  const S = pi.schema;
  const slowRead: ToolSpec = {
    name: 'slow_read',
    description: 'Read a project file (read-only; safe to run again). Optionally slow, for tests.',
    parameters: S.object({
      path: S.string({ description: 'project-relative path' }),
      delay_ms: S.optional(S.integer({ minimum: 0, maximum: MAX_DELAY_MS })),
      ignore_abort: S.optional(S.boolean()),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      const at = resolveInside(host.root, String(args.path ?? ''));
      if ('error' in at) return text(`refused: ${at.error}`, true);
      const run = host.runOf(api.conversationId) ?? 'unknown';
      appendFileSync(host.readsLog, `${JSON.stringify({ run, path: at.rel, call_id: api.callId, task: api.taskId, pid: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      const waited = await wait(delayOf(args.delay_ms), context, args.ignore_abort === true);
      if (waited === 'aborted') throw new Error('slow_read stopped by its abort signal');
      const sha = fileSha256(at.path);
      return text(`read ${at.rel}: sha256 ${sha}`);
    },
  };
  const slowWrite: ToolSpec = {
    name: 'slow_write',
    description: 'Compare-and-set write of a project file: writes only when its sha256 is expected_sha256 ("absent" for a new file).',
    parameters: S.object({
      path: S.string({ description: 'project-relative path' }),
      content: S.string(),
      expected_sha256: S.string({ description: 'the sha256 the file must have now, or "absent"' }),
      delay_ms: S.optional(S.integer({ minimum: 0, maximum: MAX_DELAY_MS })),
      ignore_abort: S.optional(S.boolean()),
    }),
    replay: 'unsafe',
    async execute(args, api, context) {
      const t = writeTarget(host.root, args);
      if ('error' in t) return text(`refused: ${t.error}`, true);
      const run = host.runOf(api.conversationId);
      if (!run) return text('refused: no Timmy run for this conversation', true);
      const key = effectKey('slow_write', t.target, run);
      // the dispatcher's own check behind the guard hook: never a second effect over an unreconciled one
      const open = host.ledger.unreconciled(key);
      if (open) return text(`refused by Timmy's dispatcher: NEEDS YOU: an earlier slow_write of ${t.target} in this run is ${open.state === 'unknown' ? 'of unknown outcome' : 'started and never ended'}; reconcile before any retry`, true);
      const content = String(args.content ?? '');
      const expected = String(args.expected_sha256 ?? '');
      const next = createHash('sha256').update(content).digest('hex');
      const current = fileSha256(t.path);
      if (current === next) return text(`no write: ${t.target} already has these bytes (sha256 ${next})`);
      if (current !== expected) return text(`refused (compare-and-set): ${t.target} has sha256 ${current}, expected ${expected}`, true);
      const base = { key, run, tool: 'slow_write', target: t.target, call_id: api.callId, task: api.taskId, args_sha256: argsSha256(args), expected_sha256: expected, new_sha256: next, by: 'tool' as const };
      host.ledger.append({ ...base, state: 'started' });
      const tmp = join(dirname(t.path), `.${randomBytes(6).toString('hex')}.tmp`);
      writeFileSync(tmp, content);
      renameSync(tmp, t.path); // the effect
      const waited = await wait(delayOf(args.delay_ms), context, args.ignore_abort === true);
      const readback = { sha256: fileSha256(t.path) };
      if (waited === 'aborted') {
        host.ledger.append({ ...base, state: 'ended', outcome: 'stopped by its abort signal after the write', readback });
        throw new Error('slow_write stopped by its abort signal (the write had happened)');
      }
      host.ledger.append({ ...base, state: 'ended', outcome: readback.sha256 === next ? 'written' : 'written, but the file now has other bytes', readback });
      return text(`wrote ${t.target} (sha256 ${next})`);
    },
  };
  return [slowRead, slowWrite];
}
