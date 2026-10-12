/**
 * Pi Durable, slice S1 (R4 H118): the guard (plan e.3.2 and e.3.4), installed as hooks of the worker's one extension, so
 * every conversation the worker creates selects it.
 *
 * - `beforeTool` on Pi's tool task refuses a call whose effect key (tool + target + run) has an unreconciled record in
 *   the ledger: `started` and never ended, or reconciled to `unknown`. Without it, H115's FAKE model performed an
 *   interrupted write a second time (spike A0); with it, one effect and the repeat refused (A3).
 * - At the first refusal the host aborts the run (spike A2): pi-durable 1.1.0 has no turn limit, and a model that keeps
 *   repeating a refused call loops (A1: 12 times, until its script ran out). The abort is asked for after the hook
 *   returns, never awaited inside it (the abort waits for the very task the hook runs in).
 * - `beforeRequest` on the generation task holds any model request of a run that was refused, until that abort reaches
 *   it, and then fails it: so no model request follows a refusal however the scheduler interleaves (A2 relied on the
 *   abort landing first).
 */
import type { HookSpec, PiContext } from './adapter/pi-api.js';
import { effectKey, type EffectLedger, type EffectRecord } from './effects.js';
import { writeTarget } from './slow-tools.js';

/** The tools whose calls are effects, each with its target (a canonical project path). */
export const EFFECT_TOOLS: Readonly<Record<string, (root: string, args: Record<string, unknown>) => string | undefined>> = Object.freeze({
  slow_write: (root: string, args: Record<string, unknown>) => { const t = writeTarget(root, args); return 'error' in t ? undefined : t.target; },
});

export const HOLD_MS = 30_000;

export interface GuardHost {
  readonly root: string;
  readonly ledger: EffectLedger;
  runOf(conversationId: number): string | undefined;
  /** the first refusal of a run: record NEEDS YOU and ask for the host abort (after the hook returns) */
  refused(run: string, conversationId: number, key: string, open: EffectRecord, words: string): void;
  /** whether this conversation's run was refused in this worker life */
  wasRefused(conversationId: number): boolean;
}

export const refusalWords = (tool: string, target: string, open: EffectRecord): string =>
  `NEEDS YOU: an earlier ${tool} of ${target} in this run is ${open.state === 'unknown' ? 'of unknown outcome' : 'started and never ended'}; reconcile before any retry`;

/** Resolves when the context's signal aborts, or after `ms`. */
function untilAborted(context: PiContext, ms: number): Promise<void> {
  const signal = context.abortSignal;
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    const t = setTimeout(done, ms);
    function done(): void { clearTimeout(t); signal?.removeEventListener('abort', done); resolveWait(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function guardHooks(g: GuardHost): HookSpec {
  return {
    beforeTool(call, api) {
      const targetOf = EFFECT_TOOLS[call.name];
      if (!targetOf) return undefined; // not an effect tool (slow_read): nothing to guard
      const target = targetOf(g.root, call.arguments);
      if (target === undefined) return undefined; // the tool refuses the path itself
      const run = g.runOf(api.conversationId);
      if (!run) return { block: 'NEEDS YOU: this conversation belongs to no Timmy run' };
      const key = effectKey(call.name, target, run);
      const open = g.ledger.unreconciled(key);
      if (!open) return undefined;
      const words = refusalWords(call.name, target, open);
      g.refused(run, api.conversationId, key, open, words);
      return { block: words };
    },
    async beforeRequest(api, context) {
      if (!g.wasRefused(api.conversationId)) return;
      await untilAborted(context, HOLD_MS);
      throw new Error('no model request after a NEEDS YOU refusal: the run is stopped');
    },
  };
}
