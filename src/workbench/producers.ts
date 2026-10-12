/**
 * R4 (H110): the two producers the Workbench draws from but does not own, used once they are in this Timmy:
 *
 *   the run detail    src/ops/run-detail.ts (H102): `runDetail(operation, { project })` gives one RunDetail (adapted below)
 *                     (src/contracts/run-detail.ts), from the project's own records
 *   the chat session  src/agent/chat-session.ts (H103): `openChatSession({ project, surface })` gives a ChatSession
 *                     (src/contracts/chat-session.ts), the one chat path every surface sends through
 *
 * Each module is imported by a specifier held in a variable, so this revision builds and runs without it, and each is
 * checked before it is used: a module that is not here, or has no such export, is said in words, never worked around; a
 * run detail of another version or of another operation is refused by name. Tests give FIXTURE producers instead (each
 * labelled there). If a producer lands with another export name or signature, the change is here and nowhere else.
 */
import type { OpenChatSession } from '../contracts/chat-session.js';
import { RUN_DETAIL_VERSION, type RunDetail } from '../contracts/run-detail.js';

export type RunDetailOf = (operation: string, o: { root: string }) => RunDetail | Promise<RunDetail>;

export type Loaded<T> = { ok: true; value: T } | { ok: false; why: string };

export interface Producers {
  runDetail(): Promise<Loaded<RunDetailOf>>;
  openChat(): Promise<Loaded<OpenChatSession>>;
}

// held in variables: TypeScript does not resolve them, so a revision without the module still type-checks
const RUN_DETAIL_MODULE: string = '../ops/run-detail.js';
const CHAT_SESSION_MODULE: string = '../agent/chat-session.js';

async function load<T>(spec: string, name: string, what: string): Promise<Loaded<T>> {
  let m: Record<string, unknown>;
  try {
    m = await import(spec) as Record<string, unknown>;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // its own file missing, not something it imports (the words never carry a path of this computer)
    const base = spec.replace(/^.*\//, '').replace(/\.js$/, '');
    if ((err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') && String(err.message).includes(base)) return { ok: false, why: `${what} is not in this revision` };
    return { ok: false, why: `${what} could not be loaded (${err.code ?? (e instanceof Error ? e.name : 'an error')})` };
  }
  const f = m[name];
  return typeof f === 'function' ? { ok: true, value: f as T } : { ok: false, why: `${what} has no ${name} export` };
}

/** H102's producer as it landed: `runDetail(operation, { project: <folder>, waiting? })`. */
type ProducedRunDetail = (operation: string, o: { project?: string; waiting?: (operation: string) => string | undefined }) => RunDetail;
const APPROVALS_MODULE: string = '../repl/approvals.js';

export const realProducers: Producers = {
  // R4 lead (merge of H102 and H110): the producer takes the project folder as `project`, and a NEEDS YOU box this
  // process is showing (the Workbench draws the REPL's own boxes) is passed as `waiting`, so the verdict says needs you
  runDetail: async () => {
    const got = await load<ProducedRunDetail>(RUN_DETAIL_MODULE, 'runDetail', 'src/ops/run-detail.ts (H102\'s run detail)');
    if (!got.ok) return got;
    let waiting: ((operation: string) => string | undefined) | undefined;
    try {
      const m = await import(APPROVALS_MODULE) as { waitingApprovals?: () => Array<{ operation?: string; summary: string }> };
      if (typeof m.waitingApprovals === 'function') waiting = (op) => m.waitingApprovals!().find((w) => w.operation === op)?.summary;
    } catch { /* no waiting boxes known: the records alone */ }
    const value: RunDetailOf = (operation, o) => got.value(operation, { project: o.root, ...(waiting ? { waiting } : {}) });
    return { ok: true, value };
  },
  openChat: () => load<OpenChatSession>(CHAT_SESSION_MODULE, 'openChatSession', 'src/agent/chat-session.ts (H103\'s chat session)'),
};

/** A run detail as the contract has it, for this operation; else why it is not drawn. */
export function checkDetail(d: unknown, operation: string): { ok: true; detail: RunDetail } | { ok: false; why: string } {
  if (!d || typeof d !== 'object') return { ok: false, why: 'the producer gave no run detail' };
  const r = d as Partial<RunDetail>;
  if (r.version !== RUN_DETAIL_VERSION) return { ok: false, why: `its version (${String(r.version)}) is not the one this Workbench draws (${RUN_DETAIL_VERSION})` };
  if (r.operation !== operation) return { ok: false, why: `it is ${String(r.operation)}'s, not ${operation}'s` };
  const missing = (['verdict', 'stage', 'exits', 'freshness', 'acceptance', 'time', 'cost', 'checks', 'files', 'receipts', 'unknown'] as const).filter((k) => r[k] === undefined || r[k] === null);
  if (missing.length) return { ok: false, why: `it lacks ${missing.join(', ')}, which the contract names` };
  return { ok: true, detail: r as RunDetail };
}
