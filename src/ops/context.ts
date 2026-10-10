/**
 * Round R4 (H51): the operation a piece of work belongs to. An operation is one request: a command typed in the REPL,
 * a live-board action, or a `timmy act` call. It has an id ('o' and 8 hex digits) and, once it has started or sealed
 * something, a small record in the project (src/ops/operations.ts). Everything created while it runs carries its id:
 * jobs, flows, VoxVision records, code-agent runs, native runs, MCP call records (each as `operation`) and receipts
 * (as `operation_id`).
 *
 * In this process the operation is carried by an AsyncLocalStorage scope: the REPL, the live board and `timmy act` run
 * each request inside one (inOperation), and whatever the request starts inherits it through its promise continuations,
 * timers and child-process callbacks. A job keeps its operation in its own record, and its manager runs the job's
 * callbacks (its notices, its seal) back inside that operation (inOperationId), so a job stopped by another request is
 * still recorded under the request that started it. Child processes get it through the environment variable
 * TIMMY_OPERATION, which a job Timmy starts passes on (src/jobs); `timmy act` started with it set joins that operation.
 *
 * This module imports nothing of Timmy's, so the job manager and the receipt chain can use it without a cycle.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/** The environment variable a job passes on to the processes it starts. */
export const OPERATION_ENV = 'TIMMY_OPERATION';
/** An operation's id: 'o' and 8 hex digits (a job is 'j' and 6, a flow 'f' and 8, a VoxVision record 'v' and 8). */
export const OPERATION_ID = /^o[0-9a-f]{8}$/;
export const newOperationId = (): string => `o${randomBytes(4).toString('hex')}`;

/** The runs an operation can start, by the record that names them. */
export type OperationRunKind = 'job' | 'flow' | 'vox' | 'agent' | 'native' | 'mcp';

/** An operation as this process carries it: its id, and where the runs it starts and the receipts it seals are noted. */
export interface OperationScope {
  readonly id: string;
  /** a run started under this operation, in this process (its record carries the id) */
  noteRun?(kind: OperationRunKind, id: string): void;
  /** a receipt was sealed under this operation */
  noteSeal?(): void;
}

const storage = new AsyncLocalStorage<OperationScope | null>();
/** The scopes this process holds open, by id: a job's callbacks run in its operation's own scope while it is open. */
const open = new Map<string, OperationScope>();

/** The operation this code runs in, or undefined outside one. */
export function currentOperation(): string | undefined {
  return storage.getStore()?.id ?? undefined;
}

/** Runs `fn` inside `scope` (null or undefined: outside any operation); what it starts inherits the scope. */
export function inOperation<T>(scope: OperationScope | null | undefined, fn: () => T): T {
  return storage.run(scope ?? null, fn);
}

/**
 * Runs `fn` inside the operation named by `id`: its open scope in this process, else a bare one that only names it; outside
 * any operation when `id` is undefined. A job's callbacks run this way, so a job ended by another request's /stop is still
 * sealed under the operation that started it.
 */
export function inOperationId<T>(id: string | undefined, fn: () => T): T {
  if (!id || !OPERATION_ID.test(id)) return storage.run(null, fn);
  return storage.run(open.get(id) ?? { id }, fn);
}

/** Holds a scope open (see inOperationId); the function returned closes it. */
export function openScope(scope: OperationScope): () => void {
  open.set(scope.id, scope);
  return () => { if (open.get(scope.id) === scope) open.delete(scope.id); };
}

/**
 * The `operation` field of a record made now, and the run noted with its operation: `{ operation: <id> }` inside an
 * operation, `{}` outside one (a record written outside any request, a recovery at start, stays as it was).
 */
export function operationField(kind: OperationRunKind, id: string): { operation?: string } {
  const scope = storage.getStore();
  if (!scope) return {};
  try { scope.noteRun?.(kind, id); } catch { /* the run stands; only its note in the operation's record is lost */ }
  return { operation: scope.id };
}

/**
 * A receipt's input with its operation: the `operation_id` it names already wins (a recovery records the operation the
 * interrupted flow belonged to); otherwise the current operation's, and the seal is noted with it. Outside an operation
 * and without one named, the input is returned as it is: old receipts and receipts of no request stay valid.
 */
export function stampReceipt<T extends { operation_id?: string }>(input: T): T {
  if (typeof input.operation_id === 'string') return input;
  const scope = storage.getStore();
  if (!scope) return input;
  try { scope.noteSeal?.(); } catch { /* the receipt stands */ }
  return { ...input, operation_id: scope.id };
}

/**
 * The environment a job's process gets: this process's, the job's own additions, and TIMMY_OPERATION set to the job's
 * operation (or removed, when the job belongs to none, so a child never joins an operation it is not part of).
 */
export function jobEnvironment(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv | undefined, operation: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  if (operation && OPERATION_ID.test(operation)) env[OPERATION_ENV] = operation;
  else delete env[OPERATION_ENV];
  return env;
}
