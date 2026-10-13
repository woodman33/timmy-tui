/**
 * Pi Durable, slice S1 (R4 H118): the cost words of a Pi run (plan h, test i.9; the operator's "invalid costs", 14:48 PT).
 *
 * pi-ai prices tokens from its own catalog and ignores what a provider reports (spike H), so nothing here is ever a
 * measured charge (`measured: false`). The rules, in order:
 * 1. A model request was in flight when a worker stopped: it is sent again and its first cost is never recorded
 *    (spike G), so the run's cost is unknown from then on, whatever comes after.
 * 2. The FAKE scripted model (faux): no request leaves the machine.
 * 3. A local endpoint is free ONLY under Timmy's one endpoint rule (src/code-agents endpointClass, imported, not
 *    copied): the host is this machine AND the model tag does not end in "cloud" (an Ollama cloud tag goes to a cloud,
 *    although pi-ai computes $0 from its zero rates). Anything else is unknown.
 * 4. OpenRouter: pi-ai's catalog estimate, said as an estimate; `openrouter/auto` has the sentinel price of -1,000,000
 *    per million tokens (spike E: -$1,500 for 1,000 + 500 tokens), and any negative or non-finite figure is unknown:
 *    never a negative number, never an invented 0. With no request yet there is no figure at all.
 */
import { endpointClass } from '../code-agents/index.js';

export const IN_FLIGHT_COST = 'unknown (a model request was in flight when the worker stopped: it is sent again, and its first cost is not recorded)';
export const FAKE_COST = 'no charge: the FAKE scripted model (faux) sends no request off this machine';
export const LOCAL_FREE = 'no charge (local endpoint)';
export const AUTO_UNKNOWN = 'unknown (openrouter/auto has no price in pi-ai\'s catalog: computed from it, the figure would be negative)';

export type CostRoute = 'faux' | 'local' | 'openrouter';
export type CostBasis = 'fake' | 'local endpoint' | 'catalog estimate' | 'unknown' | 'no request yet';

export interface CostInput {
  readonly route: CostRoute;
  /** the model id or tag */
  readonly model?: string;
  /** the local endpoint's base URL (route local) */
  readonly baseUrl?: string;
  /** pi-ai's catalog estimate in USD for the requests so far (route openrouter); absent when no request went out */
  readonly estimateUsd?: number;
  /** a model request was in flight when a worker stopped (sticky for the run) */
  readonly inFlight?: boolean;
}

export interface CostWords {
  /** a figure only when it is a known no-charge or a non-negative estimate; null when unknown or not yet any */
  readonly usd: number | null;
  readonly basis: CostBasis;
  /** never true here: pi-ai's figures are its catalog's, not the provider's charge */
  readonly measured: false;
  readonly words: string;
}

const unknown = (words: string): CostWords => ({ usd: null, basis: 'unknown', measured: false, words });

export function costWords(c: CostInput): CostWords {
  if (c.inFlight) return unknown(IN_FLIGHT_COST);
  if (c.route === 'faux') return { usd: 0, basis: 'fake', measured: false, words: FAKE_COST };
  if (c.route === 'local') {
    if (!c.baseUrl) return unknown('unknown (no endpoint address was recorded)');
    const ep = endpointClass(c.baseUrl, c.model);
    if (ep.local) return { usd: 0, basis: 'local endpoint', measured: false, words: LOCAL_FREE };
    if (c.model && /(?:^|[:\-_.])cloud$/i.test(c.model.trim()) && !ep.credentials) return unknown(`unknown (a cloud model through Ollama: ${c.model.trim()})`);
    return unknown(`unknown (${ep.why ?? 'the endpoint is not this machine'})`);
  }
  // openrouter
  if (c.model === 'openrouter/auto') return unknown(AUTO_UNKNOWN);
  if (c.estimateUsd === undefined) return { usd: null, basis: 'no request yet', measured: false, words: 'none yet (no model request went out)' };
  if (!Number.isFinite(c.estimateUsd) || c.estimateUsd < 0) return unknown(`unknown (pi-ai's catalog gives ${c.model ?? 'this model'} a price that is not a charge: ${String(c.estimateUsd)})`);
  return { usd: c.estimateUsd, basis: 'catalog estimate', measured: false, words: `about $${c.estimateUsd.toFixed(4)} (estimated from pi-ai's catalog prices; not a measured charge)` };
}

/** Whether a route costs nothing by the rules above (what may resume on Timmy's start without the operator: plan b.2). */
export function freeRoute(c: Omit<CostInput, 'inFlight' | 'estimateUsd'>): boolean {
  const w = costWords(c);
  return w.usd === 0 && (w.basis === 'fake' || w.basis === 'local endpoint');
}
