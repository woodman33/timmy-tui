/**
 * R10 (H169; the operator's order of 2026-10-22: "Enforce local-only/free-only policies"): the one rule every model call is
 * checked against before it is made: a chat turn's own request (src/agent/chat-route.ts chatRouteNow, read by the REPL, the
 * chat session of the Workbench and the monitor, and the companion's page), every fallback model the agent would try in its
 * place, and every tool that asks a model of its own (src/agent/core.ts: the agent checks them all, whichever surface runs it).
 *
 *   free-only    a model known to be free may be asked; one known to cost is refused, and so is one whose price is unknown
 *                (unknown is never free); a tool's own charge counts (describe_image's model is checked like the turn's), and
 *                no paid model is tried in place of a free one. A model on this computer's Ollama, with local weights, costs
 *                nothing; Ollama's cloud and another computer's Ollama cost what this computer cannot know.
 *   local-only   only inference on this computer: OpenRouter, Ollama's cloud, another computer's Ollama and a gateway are
 *                refused; a cloud model served through localhost (its name says cloud, or Ollama names a remote host for it)
 *                is cloud, refused too.
 *
 * Each is a setting kept beside the other (the settings file's `freeOnly` and `localOnly`; TIMMY_CHAT_FREE_ONLY and
 * TIMMY_CHAT_LOCAL_ONLY win for one process). A refusal says which rule refused, why, and what the rule permits; nothing is
 * sent. Reads files only; no request to anything.
 */
import { readFileSync } from 'node:fs';
import { cloudModelTag, ollamaAt } from '../setup/ollama-models.js';
import { settingsFile } from '../utils/model-key.js';
import { freeOnlyOn, modelPrice, type ModelPrice } from './model-price.js';
import type { CatalogRow } from '../models/catalog.js';

type Env = Record<string, string | undefined>;

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
  /** the price as the caller knows it; absent: looked up (OpenRouter: this computer's catalog; Ollama: by where it runs) */
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

/** The price this computer knows for a route: true, false or unknown, and its words. */
export function routePrice(r: PolicyRoute, price: (id: string) => ModelPrice = (id) => modelPrice(id)): { free: boolean | 'unknown'; words: string } {
  if (r.free !== undefined) return { free: r.free, words: r.free === true ? 'free' : r.free === false ? 'it costs money' : 'its price is not known' };
  if (r.source === 'openrouter') {
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
 * to be free). Pure but for the price, which it reads from this computer's catalog when the route does not carry one.
 */
export function checkRoute(route: PolicyRoute, policy: RoutePolicy, o: { price?: (id: string) => ModelPrice } = {}): RouteCheck {
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
    const pr = routePrice(route, o.price);
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
  return checkRoute({ source: row.source, model: row.id, ...(host ? { host } : {}), free: row.price.free }, policy);
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

/** The policy in a line: "local-only on · free-only off". */
export const policyWords = (p: RoutePolicy): string => `local-only ${p.localOnly ? 'on' : 'off'} · free-only ${p.freeOnly ? 'on' : 'off'}`;

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
