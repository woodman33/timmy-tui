/**
 * R10 (H169; the operator's order of 2026-10-22: "Enforce local-only/free-only policies"): the route policy's rule itself,
 * pure: whether a model call may be made under free-only and local-only, from the facts its caller gives (the route, and its
 * price when the caller knows it). It reads nothing and asks nothing. src/agent/route-policy.ts checkRoute, the shared
 * contract's name that the agent and every surface call, is this rule with the price this computer's catalog knows, and
 * re-exports all of it; the setup's helper (src/setup/route-advice.ts), which may load nothing that reads, writes or asks,
 * calls it here with the prices it was given.
 *
 *   free-only    a model known to be free may be asked; one known to cost is refused, and so is one whose price is unknown
 *                (unknown is never free); a tool's own charge counts (describe_image's model is checked like the turn's), and
 *                no paid model is tried in place of a free one. A model on this computer's Ollama, with local weights, costs
 *                nothing; Ollama's cloud and another computer's Ollama cost what this computer cannot know.
 *   local-only   only inference on this computer: OpenRouter, Ollama's cloud, another computer's Ollama and a gateway are
 *                refused; a cloud model served through localhost (its name says cloud, or Ollama names a remote host for it)
 *                is cloud, refused too.
 *
 * A refusal says which rule refused, why, and what the rule permits. A price that neither the route nor a lookup gives is not
 * known here, and so it is not free.
 */
import { cloudModelTag, ollamaAt } from '../setup/ollama-models.js';
import type { CatalogRow } from '../models/catalog.js';
import type { ModelPrice } from './model-price.js';

// ── the shared contract (R10 chat checkpoint) ────────────────────────────────────────────────────────────────────────

export interface RoutePolicy { freeOnly: boolean; localOnly: boolean }

export type PolicyRefusal = 'paid-under-free-only' | 'price-unknown-under-free-only' | 'cloud-under-local-only';

/** A refusal: which rule, its sentence (`words`), and its parts: why (`cause`) and what the rule permits (`permitted`). */
export type RouteCheck = { ok: true } | { ok: false; reason: PolicyRefusal; words: string; cause: string; permitted: string };

/** A model call, as the policy reads it. */
export interface PolicyRoute {
  /** OpenRouter; an Ollama (`host` says whether it is this computer); Ollama's cloud API */
  source: 'openrouter' | 'ollama-local' | 'ollama-cloud';
  model: string;
  /** an Ollama's address as recorded (a loopback one is this computer); absent: Ollama's default, 127.0.0.1:11434 */
  host?: string;
  /** what the call is for: a turn's own request, a model tried in its place, the last-resort local answer, a tool's own call */
  role?: 'turn' | 'fallback' | 'last-resort' | 'tool';
  /** the tool that makes it (role 'tool') */
  tool?: string;
  gateway?: 'none' | 'cloudflare';
  /** the price as the caller knows it; absent: looked up (OpenRouter: the price lookup given; Ollama: by where it runs) */
  free?: boolean | 'unknown';
  /** Ollama named a remote host or model for it (/api/show): cloud, whatever its name says */
  remote?: boolean;
  /** where it runs is not known here (a code agent picks its own model): neither rule permits it; `why` says so */
  unknownWhere?: boolean;
  /** the words for an unknown place */
  why?: string;
}

/** Where a route's inference runs. */
export type InferenceAt = 'this computer' | 'another computer' | 'cloud' | 'not known';

/** What this computer knows of an OpenRouter model's price (src/agent/model-price.ts modelPrice gives it from the catalog). */
export type PriceOf = (id: string) => Pick<ModelPrice, 'free' | 'words'>;

/** Where the model answers: this computer (a loopback Ollama, local weights), another computer's Ollama, or a cloud. */
export function inferenceAt(r: Pick<PolicyRoute, 'source' | 'model' | 'host' | 'remote' | 'unknownWhere'>): InferenceAt {
  if (r.unknownWhere) return 'not known';
  if (r.source !== 'ollama-local') return 'cloud';
  if (r.remote || cloudModelTag(r.model)) return 'cloud';
  const at = ollamaAt(r.host ?? null);
  return 'error' in at || !at.loopback ? 'another computer' : 'this computer';
}

/** The route's place in words: "OpenRouter (cloud)", "Ollama on this computer", "the Ollama at 192.0.2.5:11434 (another computer)". */
export function routeWords(r: Pick<PolicyRoute, 'source' | 'model' | 'host' | 'remote' | 'gateway' | 'unknownWhere' | 'why'>): string {
  const via = r.gateway === 'cloudflare' ? ' through the Cloudflare gateway' : '';
  if (r.unknownWhere) return r.why ?? 'a route this check cannot see';
  if (r.source === 'openrouter') return `OpenRouter (cloud)${via}`;
  if (r.source === 'ollama-cloud') return `Ollama's cloud (ollama.com)${via}`;
  const at = ollamaAt(r.host ?? null);
  const host = 'error' in at ? (r.host ?? 'its address') : at.host;
  const where = inferenceAt(r);
  if (where === 'cloud') return `Ollama's cloud, through the Ollama at ${host}${via}`;
  return where === 'this computer' ? `Ollama on this computer${via}` : `the Ollama at ${host} (another computer)${via}`;
}

const subject = (r: PolicyRoute): string => (r.role === 'fallback' ? `the fallback model ${r.model} was not tried`
  : r.role === 'last-resort' ? `the last-resort local answer (${r.model}) was not tried`
    : r.role === 'tool' ? `${r.tool ?? 'the tool'} did not run (it asks ${r.model})` : 'this message was not sent');

/** What each rule permits, in words (the refusal's last part: the choices that remain). */
export function permittedWords(p: RoutePolicy): string {
  if (p.localOnly) return `permitted: a model with local weights on this computer's Ollama (/model lists them)${p.freeOnly ? '; free-only is on too' : ''}; local-only stays on`;
  return 'permitted: a model known to be free (/model free lists the catalog\'s), or one on this computer\'s Ollama (no charge); free-only stays on';
}

/**
 * The price known for a route, and its words: the route's own (`free`), else for OpenRouter what `price` says (no lookup
 * given: not known here), for an Ollama by where it runs (local weights on this computer cost nothing; another computer's
 * and the cloud's are not known).
 */
export function routePriceOf(r: PolicyRoute, price?: PriceOf): { free: boolean | 'unknown'; words: string } {
  if (r.free !== undefined) return { free: r.free, words: r.free === true ? 'free' : r.free === false ? 'it costs money' : 'its price is not known' };
  if (r.source === 'openrouter') {
    if (!price) return { free: 'unknown', words: 'its price is not known here' };
    const p = price(r.model);
    return { free: p.free === null ? 'unknown' : p.free, words: p.words.split(' (')[0] };
  }
  const where = inferenceAt(r);
  if (where === 'not known') return { free: 'unknown', words: r.why ?? 'where it runs is not known here' };
  if (where === 'this computer') return { free: true, words: 'no charge (local weights on this computer)' };
  if (r.source === 'ollama-cloud' || where === 'cloud') return { free: 'unknown', words: 'Ollama\'s cloud bills by its plans: no price per request is known here' };
  return { free: 'unknown', words: 'another computer\'s Ollama reports no cost, so it is not known here' };
}

/**
 * Whether the policy lets this call be made: local-only first (nothing off this computer), then free-only (only what is known
 * to be free). Pure: the price is the route's own, else what `price` says, else not known (so not free).
 */
export function checkRouteWith(route: PolicyRoute, policy: RoutePolicy, price?: PriceOf): RouteCheck {
  if (policy.localOnly) {
    const where = inferenceAt(route);
    if (where !== 'this computer' || route.gateway === 'cloudflare') {
      const at = ollamaAt(route.host ?? null);
      const host = 'error' in at ? (route.host ?? 'its address') : at.host;
      const why = where === 'not known' ? `${route.why ?? 'where it runs is not known here'}, so it may run off this computer`
        : route.gateway === 'cloudflare' && where === 'this computer' ? 'the Cloudflare gateway is off this computer'
          : route.source === 'ollama-local' && where === 'cloud' ? `${route.model} is a cloud model: the Ollama at ${host} sends it to Ollama's cloud`
            : `${routeWords(route)} runs off this computer`;
      return { ok: false, reason: 'cloud-under-local-only', words: `Local-only is on, so ${subject(route)}: ${why}. Nothing was sent; ${permittedWords(policy)}.`, cause: why, permitted: permittedWords(policy) };
    }
  }
  if (policy.freeOnly) {
    const pr = routePriceOf(route, price);
    if (pr.free === true) return { ok: true };
    if (pr.free === false) {
      const cause = `${route.model} costs ${pr.words}`;
      return { ok: false, reason: 'paid-under-free-only', words: `Free-only is on, so ${subject(route)}: ${cause}. Nothing was sent; ${permittedWords(policy)}.`, cause, permitted: permittedWords(policy) };
    }
    const cause = `${route.model}'s price is not known (${pr.words}), and unknown is never free`;
    return { ok: false, reason: 'price-unknown-under-free-only', words: `Free-only is on, so ${subject(route)}: ${cause}. Nothing was sent; ${permittedWords(policy)}.`, cause, permitted: permittedWords(policy) };
  }
  return { ok: true };
}

/**
 * A refused message's lines, as every chat surface prints a refusal (what; Cause; Try; that nothing was sent). `away`: a
 * surface other than the REPL (its fix is a command any terminal runs, or the REPL's).
 */
export function policyRefusalLines(c: Extract<RouteCheck, { ok: false }>, away = false): string[] {
  const rule = c.reason === 'cloud-under-local-only' ? 'local-only' : 'free-only';
  const choose = c.reason === 'cloud-under-local-only'
    ? (away ? 'choose a model on this computer\'s Ollama: /model in the REPL lists them, or timmy init --chat local --model <name>' : '/model lists the models this computer\'s Ollama has; /setup chat keeps one')
    : (away ? 'choose a free model: /model free in the REPL lists them, or a model on this computer\'s Ollama (no charge)' : '/model free lists the free models this computer knows; or a model on this computer\'s Ollama (no charge)');
  return [`Error: ${rule} is on, so this message was not sent.`, `Cause: ${c.cause}.`, `Try: ${choose} (${rule} stays on)`, 'Nothing was sent to any model.'];
}

/** Whether a catalog row may be chosen under the policy (the Models rail marks the others, with checkRoute's words). */
export function permits(row: Pick<CatalogRow, 'source' | 'id' | 'price'>, policy: RoutePolicy, host?: string): RouteCheck {
  return checkRouteWith({ source: row.source, model: row.id, ...(host ? { host } : {}), free: row.price.free }, policy);
}

/** The policy in a line: "local-only on · free-only off". */
export const policyWords = (p: RoutePolicy): string => `local-only ${p.localOnly ? 'on' : 'off'} · free-only ${p.freeOnly ? 'on' : 'off'}`;
