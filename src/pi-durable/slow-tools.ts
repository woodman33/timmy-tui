/**
 * Pi Durable, slice S1 (R4 H118): the two tools S1's FAKE runs use, the smallest pair that exercises both replay classes
 * of plan e.2. They act on real project files (project containment by src/project's resolveInside), and each can be made
 * slow (`delay_ms`, the window a test kills or stops in) and deaf to its abort signal (`ignore_abort`, spike D2). S3
 * replaces them with Timmy's dispatcher tools; Pi's own coding tools and NodeExecutionEnv are never offered (e.2: no root
 * restriction, shell strings).
 *
 * Both file tools refuse any path inside .timmy/, Timmy's own folder, where the worker keeps its token, store and
 * effect ledger (.timmy/private/pi/): by the name asked for, its spelling and the file a link leads to (fix S1 of
 * H119's review).
 *
 * - `slow_read { path }`: read-only, `replay: "safe"`: a call interrupted by a kill reruns by itself (spike B). Each read
 *   is logged to .timmy/private/pi/reads.jsonl, so a test can count them.
 * - `slow_write { path, content, expected_sha256 }`: a compare-and-set write, `replay: "unsafe"` in S1. It refuses when
 *   the file's sha256 is not the expected one ('absent' for no file), writes nothing when the file already has the new
 *   bytes, and otherwise writes `started` to the effect ledger, then the file (temp file and rename), then waits
 *   `delay_ms`, then writes `ended` with a readback of the file's sha256. Its key (tool + path + run) is checked again
 *   here, as the dispatcher's own enforcement behind the guard hook (plan e.3.3).
 * - `trial_shell { argv }` (FIXTURE for plan i.3's case; offered only when the worker is started with
 *   --allow-trial-shell): runs one program, as argv with no shell, in the run's trial folder
 *   <project>/.timmy/private/pi/<run>/trial/ (S6 makes that folder a disposable copy of the project; S1 leaves it
 *   empty), with a small environment (its HOME is the trial folder; no keys). `replay: "unsafe"`: an unreconcilable
 *   effect, never retried by itself. Its key is the run's trial copy, so after one interrupted command every later
 *   command of that run waits for a person. It writes `started` before the process starts and `ended` with the exit
 *   status and the output's sha256 after it ends; its output goes straight to a file
 *   (.timmy/private/pi/<run>/trial-<call>.out), so a kill keeps what it printed, and its pid beside it. A command
 *   stopped by its abort signal (a Stop, a pause, Timmy's exit: pi-durable's Harness.close aborts every call in flight)
 *   is recorded `unknown` with a NEEDS YOU, never `ended`: what it did cannot be read back (fix B1).
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { resolveInside } from '../project/index.js';
import type { PiApi, PiContext, ToolResult, ToolSpec } from './adapter/pi-api.js';
import { argsSha256, effectKey, type EffectLedger } from './effects.js';
import { PI_DIR_REL } from './paths.js';

export const MAX_DELAY_MS = 120_000;
/** The longest path a Pi file tool takes, and the longest command trial_shell runs (its argv's characters): so every
 * effect record, NEEDS YOU and answer that names one stays small (fix S2 of H119's review). */
export const MAX_PATH_CHARS = 1024;
export const MAX_COMMAND_CHARS = 8192;

export interface ToolHost {
  readonly root: string;
  readonly ledger: EffectLedger;
  readonly readsLog: string;
  /** whether trial_shell is offered (the worker's --allow-trial-shell) */
  readonly trialShell?: boolean;
  /** records a NEEDS YOU on the run (an effect a tool cannot read back) */
  needsYou?(run: string, key: string, why: string): void;
  /** the Timmy run of a Pi conversation */
  runOf(conversationId: number): string | undefined;
}

/** A run's trial copy (project-relative), the target of every trial_shell of that run. */
export const trialTarget = (run: string): string => `${PI_DIR_REL}/${run}/trial`;
export const MAX_TRIAL_OUTPUT = 4096;

/** The last `n` bytes of a file as text ('' when it cannot be read). */
export function fileTail(path: string, n: number): { text: string; bytes: number } {
  try {
    const buf = readFileSync(path);
    return { text: buf.subarray(Math.max(0, buf.length - n)).toString('utf8'), bytes: buf.length };
  } catch { return { text: '', bytes: 0 }; }
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

/** Whether a project-relative path is in Timmy's own folder, .timmy/ (any spelling: macOS's usual file system ignores case). */
const inTimmyFolder = (rel: string): boolean => rel.split('/').filter((part) => part && part !== '.')[0]?.toLowerCase() === '.timmy';
const timmyRefused = (shown: string): { error: string } => ({
  error: `${shown} is inside .timmy/, Timmy's own folder (its Pi worker's token, store and effect ledger live there): Pi's file tools never read or write it`,
});

/**
 * A path's real file relative to the project's real folder: links resolved and, where the system keeps it so (macOS's
 * usual file system), the case and form of each name as stored on disk; a part that does not exist yet is kept as asked.
 */
function realRelative(realRoot: string, path: string): string {
  const tail: string[] = [];
  let probe = path;
  for (;;) {
    try { return relative(realRoot, join(realpathSync.native(probe), ...tail)).split(sep).join('/'); } catch { /* not there yet: climb */ }
    const parent = dirname(probe);
    if (parent === probe) return relative(realRoot, path).split(sep).join('/');
    tail.unshift(basename(probe));
    probe = parent;
  }
}

/**
 * The file a Pi file tool's call names: inside the project (src/project's resolveInside: links resolved, private files
 * refused) and never inside .timmy/ (fix S1), by the name asked for, by its spelling and by the file a link leads to.
 * `target` is the real file relative to the project's real folder (fix S6 of H119's review: a link alias, a dotted
 * spelling, a linked folder or, on macOS, a case variant used to key apart, so a write of unknown outcome could be done
 * again under another name without a person); `path` is the resolved file the tool acts on. Or an error.
 */
export function fileTarget(root: string, args: Record<string, unknown>): { target: string; path: string } | { error: string } {
  const asked = String(args.path ?? '').trim();
  if (asked.length > MAX_PATH_CHARS) return { error: `the path is ${asked.length.toLocaleString('en-US')} characters long; Pi's file tools take at most ${MAX_PATH_CHARS.toLocaleString('en-US')}` };
  const lexical = asked && !asked.includes('\0') ? relative(resolve(root), resolve(root, asked)).split(sep).join('/') : '';
  if (inTimmyFolder(lexical)) return timmyRefused(lexical);
  const at = resolveInside(root, asked);
  if ('error' in at) return { error: at.error };
  if (inTimmyFolder(at.rel)) return timmyRefused(at.rel);
  let real: string;
  try { real = realRelative(realpathSync.native(root), at.path); } catch { return { error: 'the project folder is gone' }; }
  if (inTimmyFolder(real)) return timmyRefused(`${at.rel} (it leads to ${real})`);
  if (!at.rel || !real) return { error: 'name a file inside the project, not the project folder itself' };
  if (real === '..' || real.startsWith('../')) return { error: `${at.rel} leads outside the project` };
  return { target: real, path: at.path };
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
      const t = fileTarget(host.root, args);
      if ('error' in t) return text(`refused: ${t.error}`, true);
      const run = host.runOf(api.conversationId) ?? 'unknown';
      appendFileSync(host.readsLog, `${JSON.stringify({ run, path: t.target, call_id: api.callId, task: api.taskId, pid: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      const waited = await wait(delayOf(args.delay_ms), context, args.ignore_abort === true);
      if (waited === 'aborted') throw new Error('slow_read stopped by its abort signal');
      const sha = fileSha256(t.path);
      return text(`read ${t.target}: sha256 ${sha}`);
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
      const t = fileTarget(host.root, args);
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
  const trialShell: ToolSpec = {
    name: 'trial_shell',
    description: 'FIXTURE: run one program (argv, no shell) in this run\'s trial folder. Never retried by itself; an interrupted command waits for a person.',
    parameters: S.object({ argv: S.array(S.string(), { minItems: 1, maxItems: 64 }) }),
    replay: 'unsafe',
    async execute(args, api, context) {
      const run = host.runOf(api.conversationId);
      if (!run) return text('refused: no Timmy run for this conversation', true);
      const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
      if (!argv.length || !argv[0]) return text('refused: argv names no program', true);
      const chars = argv.reduce((n, a) => n + a.length, 0);
      if (chars > MAX_COMMAND_CHARS) return text(`refused: the command is ${chars.toLocaleString('en-US')} characters long; trial_shell takes at most ${MAX_COMMAND_CHARS.toLocaleString('en-US')}`, true);
      const target = trialTarget(run);
      const key = effectKey('trial_shell', target, run);
      const open = host.ledger.unreconciled(key);
      if (open) return text(`refused by Timmy's dispatcher: NEEDS YOU: an earlier trial_shell in this run's trial copy is ${open.state === 'unknown' ? 'of unknown outcome' : 'started and never ended'}; a person decides before any other command runs there`, true);
      const dir = join(host.root, target);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const safeCall = api.callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(-48);
      const outRel = `${PI_DIR_REL}/${run}/trial-${safeCall}.out`;
      const outAbs = join(host.root, outRel);
      const base = { key, run, tool: 'trial_shell', target, call_id: api.callId, task: api.taskId, args_sha256: argsSha256(args), argv, output: outRel, by: 'tool' as const };
      host.ledger.append({ ...base, state: 'started' }); // before the process exists
      const fd = openSync(outAbs, 'a', 0o600);
      let exit: { code: number | null; signal: string | null; error?: string };
      let aborted = false;
      try {
        const child = spawn(argv[0], argv.slice(1), {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: dir, TMPDIR: process.env.TMPDIR ?? tmpdir() },
          stdio: ['ignore', fd, fd],
        });
        if (child.pid !== undefined) writeFileSync(`${outAbs}.pid`, `${child.pid}\n`, { mode: 0o600 });
        const signal = context.abortSignal;
        const onAbort = (): void => {
          aborted = true;
          child.kill('SIGTERM');
          setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000).unref();
        };
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        exit = await new Promise((resolveExit) => {
          child.once('error', (e) => resolveExit({ code: null, signal: null, error: e.message }));
          child.once('exit', (code, sig) => resolveExit({ code, signal: sig }));
        });
        signal?.removeEventListener('abort', onAbort);
      } finally { closeSync(fd); }
      const readback = { sha256: fileSha256(outAbs) };
      const how = exit.error ? `could not start: ${exit.error}` : exit.code !== null ? `exited ${exit.code}` : `ended by ${exit.signal}`;
      if (aborted) {
        // stopped mid-command: what it did to the trial copy cannot be read back, so its outcome is unknown (plan e.2),
        // and only a person moves it on; the guard refuses every later command of the run until then
        const tail = fileTail(outAbs, 400);
        const why = `stopped by its abort signal (${how}): what the command did cannot be read back: NEEDS YOU. The command: ${JSON.stringify(argv)}. Its output so far (${tail.bytes} bytes${tail.bytes > 400 ? ', its end' : ''}): ${JSON.stringify(tail.text)}`;
        host.ledger.append({ ...base, state: 'unknown', exit: exit.code, outcome: why, readback });
        host.needsYou?.(run, key, why);
        throw new Error(`trial_shell stopped by its abort signal (${how}); its outcome is unknown: NEEDS YOU`);
      }
      host.ledger.append({ ...base, state: 'ended', exit: exit.code, outcome: how, readback });
      const tail = fileTail(outAbs, MAX_TRIAL_OUTPUT);
      return text(`${how}; output ${statSize(outAbs)} bytes${tail.bytes > MAX_TRIAL_OUTPUT ? ' (its end)' : ''}:\n${tail.text}`, exit.code !== 0);
    },
  };
  return host.trialShell ? [slowRead, slowWrite, trialShell] : [slowRead, slowWrite];
}

const statSize = (p: string): number => { try { return statSync(p).size; } catch { return 0; } };
