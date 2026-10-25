/**
 * R9 (H162): what a decision model costs and what it may be sent, from what the operator declared in clef.json
 * (src/decision/config.ts), never from the transport's name, a self-hosted or remote label, or a loopback address:
 *
 *   pricingOf      free: local (declared {"free": "local"}, for a model whose tag is not a cloud tag); paid (a declared price
 *                  and its billing); unknown (none declared, or declared free for a cloud model tag, which is never free); or
 *                  no call (the fixture transport reads a file: nothing is asked and nothing is charged)
 *   limitsOf       Clef-Omni's published limits (64 questions a request, its media limits, its context) for Clef-Omni; for
 *                  another model, the limits clef.json states, or a conservative default, said as such
 *   estimateCost   the estimate at the declared price and billing: per-request bills the input once, per-question once for
 *                  each question in the request (as Liquid documents for d1-ultra)
 *
 * The operator's rule it keeps: unknown pricing never becomes zero. It is refused under free only, refused whenever a budget
 * applies, and refused when neither does, because a call that may cost money needs a budget (src/decision/policy.ts says
 * each in words). A cloud model tag is never free: Ollama serves its cloud models from a localhost address too. The tag rule
 * is Timmy's one rule for it (src/setup/ollama-models.ts cloudModelTag, which src/agent/providers.ts cloudTag uses).
 * Nothing here reads a file or the network.
 */
import { cloudModelTag } from '../setup/ollama-models.js';
import { CLEF_LIMITS, CLEF_OMNI_HOSTED_USD_PER_MILLION_INPUT, CLEF_OMNI_MODEL_ID } from './clef-contract.js';
import type { Billing, LimitsSetting, PricingSetting } from './config.js';

/** Clef-Omni by any name an endpoint gives it: clef-omni, @cf/cloudflare/clef-omni, clef-omni:<tag>. Nothing else is. */
export const isClefOmni = (model: string): boolean => /^(?:@cf\/cloudflare\/)?clef-omni(?::[A-Za-z0-9_.-]+)?$/i.test(model.trim());

/** A model tag that names a cloud model (":cloud", "-cloud" and the like): what it is given leaves this computer. */
export const isCloudModel = (model: string): boolean => cloudModelTag(model.trim());

export interface Pricing {
  kind: 'free-local' | 'paid' | 'unknown' | 'no-call';
  usd_per_million_input?: number;
  billing?: Billing;
  /** How it reads on a screen: "free: local (declared ...)", "$2 per million input tokens, billed per question (declared ...)". */
  words: string;
  /** For unknown: why, with what can be declared. */
  why?: string;
}

/** A declared price in words: "$2 per million input tokens, billed per question". */
export const priceWords = (usd: number, billing: Billing): string => `$${usd} per million input tokens, billed ${billing === 'per-question' ? 'per question' : 'per request'}`;

/** The fixture transport's pricing: no service is called. */
export const FIXTURE_PRICING: Pricing = Object.freeze({ kind: 'no-call', words: 'no call: the fixture transport reads a file (no service is asked, nothing is charged)' }) as Pricing;

/**
 * The pricing as declared for `model`, in words. `workersAi` adds what the model page publishes for Clef-Omni to the words
 * of an undeclared price (said as published, never applied).
 */
export function pricingOf(model: string, declared: PricingSetting | undefined, o: { workersAi?: boolean } = {}): Pricing {
  if (!declared) {
    const published = o.workersAi && isClefOmni(model)
      ? ` (the model page publishes $${CLEF_OMNI_HOSTED_USD_PER_MILLION_INPUT} per million input tokens for ${CLEF_OMNI_MODEL_ID}, billed per request: declare it if that is your price)`
      : '';
    return {
      kind: 'unknown',
      why: `clef.json declares no pricing for ${model}${published}; declare {"free": "local"} for a model you run on hardware you control, or {"usd_per_million_input": <dollars>, "billing": "per-request" | "per-question"}`,
      words: 'unknown: clef.json declares none',
    };
  }
  if ('free' in declared) {
    if (isCloudModel(model)) {
      return {
        kind: 'unknown',
        why: `${model} is a cloud model tag (its name says cloud, as Ollama names the models it sends to its cloud): it is never free, even though clef.json declares {"free": "local"}; declare its price instead`,
        words: `unknown: ${model} is a cloud model tag, never free (the declared {"free": "local"} is refused)`,
      };
    }
    return { kind: 'free-local', words: 'free: local (declared in clef.json: hardware you control, no per-call charge)' };
  }
  return {
    kind: 'paid', usd_per_million_input: declared.usd_per_million_input, billing: declared.billing,
    words: `${priceWords(declared.usd_per_million_input, declared.billing)} (declared in clef.json)`,
  };
}

export interface ModelLimits {
  source: 'published' | 'config' | 'default';
  /** Questions in one request, human_review included. */
  questions: number;
  /** Whether media may go with a question at all: only under published media limits (Clef-Omni's). */
  media: boolean;
  /** The input tokens the model reads at most, when published or stated: the estimate is capped at it, never below. */
  contextTokens?: number;
  words: string;
}

/** The fewest questions a request holds: one choice question and human_review. */
export const DEFAULT_QUESTIONS = 2;

/** Clef-Omni's published limits for Clef-Omni; else the limits clef.json states, or a conservative default, said as such. */
export function limitsOf(model: string, stated?: LimitsSetting): ModelLimits {
  if (isClefOmni(model)) {
    return {
      source: 'published', questions: CLEF_LIMITS.questions.max, media: true, contextTokens: CLEF_LIMITS.contextTokens,
      words: `Clef-Omni's published limits: ${CLEF_LIMITS.questions.max} questions a request, its media limits, a ${CLEF_LIMITS.contextTokens.toLocaleString('en-US')}-token context`,
    };
  }
  if (stated && (stated.questions !== undefined || stated.context_tokens !== undefined)) {
    const q = stated.questions ?? DEFAULT_QUESTIONS;
    return {
      source: 'config', questions: q, media: false, ...(stated.context_tokens !== undefined ? { contextTokens: stated.context_tokens } : {}),
      words: `${model}'s limits as clef.json states them: ${q} questions a request${stated.questions === undefined ? ' (the default)' : ''}${stated.context_tokens !== undefined ? `, a ${stated.context_tokens.toLocaleString('en-US')}-token context` : ', no context stated'}; no media (media limits are published only for Clef-Omni)`,
    };
  }
  return {
    source: 'default', questions: DEFAULT_QUESTIONS, media: false,
    words: `${model}'s limits are not published here and clef.json states none: a conservative default applies (one choice question and human_review a request, no media, no context cap on the estimate)`,
  };
}

/**
 * What a request would cost at the declared price, before it is sent: `tokens` input tokens (the estimate), once per
 * request, or once for each of its `questions` when billed per question. Only a declared price has a cost; the words say how.
 */
export function estimateCost(tokens: number, questions: number, p: Pricing): { usd: number; words: string } {
  if (p.kind !== 'paid' || p.usd_per_million_input === undefined || !p.billing) return { usd: 0, words: p.words };
  const billed = p.billing === 'per-question' ? tokens * questions : tokens;
  return {
    usd: (billed * p.usd_per_million_input) / 1_000_000,
    words: `~${tokens} input tokens at ${priceWords(p.usd_per_million_input, p.billing)}${p.billing === 'per-question' ? ` (${questions} questions): ${billed} tokens billed` : ''}`,
  };
}
