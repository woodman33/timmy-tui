/**
 * R10 (H169; the operator's order of 2026-10-22: "Enforce local-only/free-only policies"): the one rule every model call is
 * checked against before it is made: a chat turn's own request (src/agent/chat-route.ts chatRouteNow, read by the REPL, the
 * chat session of the Workbench and the monitor, and the companion's page), every fallback model the agent would try in its
 * place, and every tool that asks a model of its own (src/agent/core.ts: the agent checks them all, whichever surface runs it).
 *
 * The rule itself is ./route-check.ts (pure: free-only and local-only, as it says them); this module gives it the price this
 * computer's catalog knows (checkRoute, the shared contract's name), keeps the setting, and guards the tools that ask a
 * model. Each rule is a setting kept beside the other (the settings file's `freeOnly` and `localOnly`; TIMMY_CHAT_FREE_ONLY and
 * TIMMY_CHAT_LOCAL_ONLY win for one process). A refusal says which rule refused, why, and what the rule permits; nothing is
 * sent. Reads files only; no request to anything.
 */
import { readFileSync } from 'node:fs';
import { settingsFile } from '../utils/model-key.js';
import { freeOnlyOn, modelPrice, type ModelPrice } from './model-price.js';
import { checkRouteWith, routePriceOf, type PolicyRefusal, type PolicyRoute, type RouteCheck, type RoutePolicy } from './route-check.js';

export {
  checkRouteWith, inferenceAt, permits, permittedWords, policyRefusalLines, policyWords, routePriceOf, routeWords,
  type InferenceAt, type PolicyRefusal, type PolicyRoute, type PriceOf, type RouteCheck, type RoutePolicy,
} from './route-check.js';

type Env = Record<string, string | undefined>;

// ── the shared contract (R10 chat checkpoint): the rule with this computer's prices ──────────────────────────────────

/** The price this computer knows for a route: true, false or unknown, and its words (OpenRouter's: this computer's catalog). */
export function routePrice(r: PolicyRoute, price: (id: string) => ModelPrice = (id) => modelPrice(id)): { free: boolean | 'unknown'; words: string } {
  return routePriceOf(r, price);
}

/**
 * Whether the policy lets this call be made (./route-check.ts checkRouteWith): local-only first (nothing off this computer),
 * then free-only (only what is known to be free). Pure but for the price, which it reads from this computer's catalog when
 * the route does not carry one.
 */
export function checkRoute(route: PolicyRoute, policy: RoutePolicy, o: { price?: (id: string) => ModelPrice } = {}): RouteCheck {
  return checkRouteWith(route, policy, o.price ?? ((id) => modelPrice(id)));
}

// ── the setting ──────────────────────────────────────────────────────────────────────────────────────────────────────

const flag = (v: string | undefined): boolean | null => {
  const s = v?.trim().toLowerCase();
  if (!s) return null;
  return ['1', 'true', 'on', 'yes'].includes(s);
};

/** Whether local-only is on: TIMMY_CHAT_LOCAL_ONLY (1/true/on or 0/false/off) wins, else the settings' localOnly, else off. */
export function localOnlyOn(env: Env = process.env): boolean {
  const v = flag(env.TIMMY_CHAT_LOCAL_ONLY);
  if (v !== null) return v;
  try {
    const s = JSON.parse(readFileSync(settingsFile(env), 'utf8')) as { localOnly?: unknown };
    return s?.localOnly === true;
  } catch { return false; }
}

/** The policy now: both settings as this process reads them (each read again at every call). */
export function routePolicyNow(env: Env = process.env): RoutePolicy {
  return { freeOnly: freeOnlyOn(env), localOnly: localOnlyOn(env) };
}

/** Where each setting comes from, in words: "the settings", "TIMMY_CHAT_LOCAL_ONLY for this process". */
export function policyFrom(env: Env = process.env): { freeOnly: 'environment' | 'settings'; localOnly: 'environment' | 'settings' } {
  return { freeOnly: env.TIMMY_CHAT_FREE_ONLY?.trim() ? 'environment' : 'settings', localOnly: env.TIMMY_CHAT_LOCAL_ONLY?.trim() ? 'environment' : 'settings' };
}

/**
 * Keeps either setting (the REPL's /model free-only keeps freeOnly the same way). A variable set for this process still wins:
 * the answer says so. Writes the settings file only; the next call reads it.
 */
export async function saveRoutePolicy(patch: Partial<RoutePolicy>, env: Env = process.env): Promise<{ policy: RoutePolicy; overridden: Array<keyof RoutePolicy> }> {
  const { saveConfig } = await import('../utils/config.js');
  saveConfig({ ...(patch.freeOnly !== undefined ? { freeOnly: patch.freeOnly } : {}), ...(patch.localOnly !== undefined ? { localOnly: patch.localOnly } : {}) });
  const from = policyFrom(env);
  return { policy: routePolicyNow(env), overridden: (Object.keys(patch) as Array<keyof RoutePolicy>).filter((k) => from[k] === 'environment') };
}

// ── tools that ask a model of their own ──────────────────────────────────────────────────────────────────────────────

/**
 * The tools whose call asks a model itself (beside the turn's own request), and the route that call takes. describe_image asks
 * OpenRouter (the model it names, else the chat's OpenRouter model); review_spatial_with_local_model asks this computer's
 * Ollama (local weights, checked by its own code); iterate_recipe and iterate_native start a code agent whose model route is
 * set in that agent's own setup, which this check cannot see: under either rule they do not run (unknown is never permitted).
 */
export const TOOL_MODEL_CALLS: Readonly<Record<string, (args: Record<string, unknown>, o: { openRouterModel?: () => string }) => PolicyRoute>> = {
  describe_image: (a, o) => ({ source: 'openrouter', model: typeof a.model === 'string' && a.model ? a.model : (o.openRouterModel?.() ?? 'the chat\'s OpenRouter model'), role: 'tool', tool: 'describe_image' }),
  review_spatial_with_local_model: (a) => ({ source: 'ollama-local', model: typeof a.model === 'string' ? a.model : 'a local model', role: 'tool', tool: 'review_spatial_with_local_model' }),
  iterate_recipe: () => ({ source: 'ollama-local', model: 'its code agent\'s model', role: 'tool', tool: 'iterate_recipe', unknownWhere: true, why: 'its code agent picks its own model in that agent\'s setup, which this check cannot see' }),
  iterate_native: () => ({ source: 'ollama-local', model: 'its code agent\'s model', role: 'tool', tool: 'iterate_native', unknownWhere: true, why: 'its code agent picks its own model in that agent\'s setup, which this check cannot see' }),
};

interface ToolLike { function?: { name?: string; execute?: (args: unknown, ctx: unknown) => unknown } }

/**
 * The tools, each call of a model-calling one checked against the policy first (before any NEEDS YOU box: wrap the gated
 * tools): a refused call does not run, and its error says why (the model reads it as the tool's error). Other tools are as
 * given. `policy` is read at each call.
 */
export function policyTools<T>(tools: readonly T[], policy: () => RoutePolicy, o: { openRouterModel?: () => string; price?: (id: string) => ModelPrice } = {}): T[] {
  return tools.map((original) => {
    const t = original as unknown as ToolLike;
    const name = t.function?.name;
    const execute = t.function?.execute;
    if (!name || typeof execute !== 'function' || !Object.hasOwn(TOOL_MODEL_CALLS, name)) return original;
    const checked = async (args: Record<string, unknown>, ctx: unknown) => {
      const p = policy();
      if (p.freeOnly || p.localOnly) {
        const c = checkRoute(TOOL_MODEL_CALLS[name](args ?? {}, o), p, o.price ? { price: o.price } : {});
        if (!c.ok) throw Object.assign(new Error(c.words), { policy: c.reason, sent: false });
      }
      return execute(args, ctx);
    };
    return { ...t, function: { ...t.function, execute: checked } } as unknown as T;
  });
}

/** A turn refused by the policy before anything was sent (src/agent/core.ts send's own check). */
export class PolicyRefusedError extends Error {
  readonly sent = false as const;
  constructor(readonly reason: PolicyRefusal, words: string) {
    super(words);
    this.name = 'PolicyRefusedError';
  }
}
