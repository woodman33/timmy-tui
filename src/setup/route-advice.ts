/**
 * R10 (H170; the handoff's TINY_HELPER_TEST.md, the lead's brief CHAT-H170 item 1): the one small setup helper. From facts Timmy
 * already observed (the local probe's verified models, which credentials are present, what this computer knows of each
 * offered model's price) and the route policy (free-only, local-only), it says what to do for the next turn: a permitted
 * route, a choice among permitted models, the existing guided-setup action, or a refusal that asks for a permitted free or
 * local choice. It recommends only. It sends nothing, downloads nothing, signs in to nothing, saves no setting and never
 * falls back to a paid model: nothing here asks a model, a provider, the disk or another process (no request, no file, no
 * child process; tests/setup-route-advice.test.ts traps each and checks the settings and providers files byte for byte).
 *
 * Its words are the existing ones:
 *   route    the shared contract's sources (ollama-local | openrouter | ollama-cloud; src/models/catalog.ts ModelSource,
 *            H169's), ollama-local being the chat route's `local` (src/agent/chat-route.ts) and openrouter its `openrouter`
 *   action   the Workbench's fixes for a chat that cannot answer (src/ops/workspace-frame.ts chatFix: its ChatProblem, label,
 *            command and effect). Held here rather than imported: that module loads the settings store (src/utils/config.ts),
 *            whose loading writes the settings file, and a helper that writes nothing cannot load it. The test checks each one
 *            against chatFix's own answer, word for word.
 *   rule     the decision layer's deterministic path (src/decision/deterministic.ts deterministicProposal over
 *            src/decision/policy.ts allowedChoices: a DeterministicRule {option, rule}): the model selected for the next
 *            turn, else the only permitted option, else a person chooses; nothing is invented
 *   refusal  the shared contract's rule and reasons (src/agent/route-policy.ts checkRoute, H169's): paid-under-free-only,
 *            price-unknown-under-free-only, cloud-under-local-only, decided by checkRoute's own rule (src/agent/route-check.ts
 *            checkRouteWith, which checkRoute is with this computer's catalog prices; the rule reads nothing, so the helper
 *            gives it the prices it was given: an unknown price is not free; a cloud model served through localhost is cloud; a
 *            model on this computer's own Ollama has no per-call charge, as the chat route treats it). R10 (H169, the lead's
 *            18:02 decision): switched from the interim copy of those rules this helper held until route-policy landed.
 */
import { checkRouteWith, type PolicyRefusal, type RoutePolicy } from '../agent/route-check.js';
import { allowedChoices } from '../decision/policy.js';
import { deterministicProposal, type DeterministicProposal } from '../decision/deterministic.js';
import type { DecisionOption, DeterministicRule } from '../decision/types.js';
import type { ModelPrice } from '../agent/model-price.js';
import type { ModelSource } from '../models/catalog.js';
import type { OllamaProbeResult } from '../agent/providers.js';
import type { ChatFix } from '../ops/workspace-frame.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { redactString } from '../utils/redact.js';
import { cloudModelTag } from './ollama-models.js';

/** Where a model runs (src/models/catalog.ts ModelSource) and the route policy (src/agent/route-check.ts RoutePolicy): the shared contract's. */
export type { ModelSource, RoutePolicy };

/** Why the policy refuses a route: checkRoute's reasons. */
export type RouteRefusalReason = PolicyRefusal;

/** What this computer knows of a model's price (src/agent/model-price.ts modelPrice): free true, false or null (unknown). */
export type PriceFacts = Pick<ModelPrice, 'free' | 'words'>;

/** A model some catalog offers. */
export interface OfferedModel { source: ModelSource; id: string; price: PriceFacts | null }

/** What Timmy observed, never a guess. */
export interface RouteFacts {
  /**
   * The local probe (src/agent/providers.ts probeOllama), or null when it was not made. Only the models it verified as
   * installed local completion weights are local candidates; a cloud tag it lists is cloud, from localhost too.
   */
  local: Pick<OllamaProbeResult, 'models' | 'answer'> | null;
  /** The other models the catalogs offer: OpenRouter's (with their price as this computer knows it), Ollama Cloud's. */
  offered: OfferedModel[];
  /** Which credentials are present, never the credentials (src/utils/model-key.ts modelKeySource; the Ollama Cloud key). */
  credentials: { openrouter: boolean; ollamaCloud: boolean };
  /** The model selected for the next turn, when one is. */
  selected?: OfferedModel;
}

/** An existing action, as the Workbench names it (src/ops/workspace-frame.ts ChatFix, without its frame-specific words). */
export type SetupAction = Pick<ChatFix, 'problem' | 'label' | 'command' | 'effect'>;

/** The existing actions this helper can return, as chatFix says them (the test compares each with chatFix's own). */
export const ADVICE_ACTIONS = {
  'no-route': { problem: 'no-route', label: 'Set up chat: an OpenRouter key (asked hidden) or a local model', command: 'timmy init --chat openrouter', effect: 'local change' },
  'free-only': { problem: 'free-only', label: 'Choose a free model (free-only stays on)', command: '/model free', effect: 'local change' },
  'no-local-model': { problem: 'no-local-model', label: 'Choose the local model (from what Ollama lists)', command: '/model', effect: 'local change' },
  'ollama-unreachable': { problem: 'ollama-unreachable', label: 'Start Ollama, then check again (no charge)', command: 'timmy workspace check', effect: 'network' },
  'ollama-no-model': { problem: 'ollama-no-model', label: 'Pull a local model in Ollama, then check again (no charge)', command: 'timmy workspace check', effect: 'network' },
} as const satisfies Record<string, SetupAction>;

export interface RouteAdvice {
  /**
   * route: a permitted route for the next turn; choose: several are permitted and nothing names one, so a person chooses;
   * setup: nothing permitted can answer yet, so the existing setup action; refused: the selected model is not permitted, and
   * a permitted free or local choice is asked for
   */
  outcome: 'route' | 'choose' | 'setup' | 'refused';
  /** The route (outcome route only). */
  route?: { source: ModelSource; model: string };
  /** The existing action (outcomes setup and refused). */
  action?: SetupAction;
  /** Why the policy refuses the selected model (outcome refused only). */
  refusal?: { reason: RouteRefusalReason; words: string };
  /**
   * The deterministic rule as given (absent: none was named) and what the deterministic path made of it: the option's id,
   * and its words with each option named by its model (what a "Why this choice?" shows).
   */
  rule?: DeterministicRule;
  proposal: DeterministicProposal;
  /** The permitted choices, in the order the facts gave them, and the others with why each is out. */
  permitted: Array<{ source: ModelSource; model: string }>;
  excluded: Array<{ source: ModelSource; model: string; reason: string }>;
}

const SOURCE_WORDS: Record<ModelSource, string> = {
  'ollama-local': 'this computer\'s Ollama',
  openrouter: 'OpenRouter (a cloud service)',
  'ollama-cloud': 'Ollama Cloud (a cloud service)',
};

/**
 * Why the policy refuses this model, or null when it permits it: the shared contract's rule (checkRoute's, src/agent/route-check.ts
 * checkRouteWith) decides, from the facts the helper was given: a local model's price is where it runs (local weights on this
 * computer cost nothing; a cloud tag is cloud, from localhost too), another's is what this computer knows of it (unknown when
 * nothing is, and unknown is never free). The words are the helper's own short ones (the setup's lists show them).
 */
export function policyRefusal(m: OfferedModel, p: RoutePolicy): { reason: RouteRefusalReason; words: string } | null {
  const free = m.source === 'ollama-local' ? undefined : m.price?.free === true ? true : m.price?.free === false ? false : 'unknown' as const;
  const c = checkRouteWith({ source: m.source, model: m.id, ...(free === undefined ? {} : { free }) }, p);
  if (c.ok) return null;
  if (c.reason === 'cloud-under-local-only') {
    const via = m.source === 'ollama-local' ? 'a cloud model tag: this computer\'s Ollama sends it to a cloud' : `it runs on ${SOURCE_WORDS[m.source]}`;
    return { reason: c.reason, words: `local only: ${m.id} is not on this computer (${via})` };
  }
  if (c.reason === 'paid-under-free-only') return { reason: c.reason, words: `free only: ${m.id} costs (${m.price?.words ?? 'a price this computer knows'}); a paid model is never used in place of a free one` };
  return { reason: c.reason, words: `free only: the price of ${m.id} is not known (${m.price?.words ?? 'no price is known here'}); an unknown price is not free` };
}

/** Why a model cannot answer here whatever the policy, or null when it can (its route has what it needs). */
function unavailable(m: OfferedModel, f: RouteFacts): string | null {
  if (m.source === 'openrouter') return f.credentials.openrouter ? null : 'no OpenRouter key is set up';
  if (m.source === 'ollama-cloud') return f.credentials.ollamaCloud ? null : 'no Ollama Cloud key is set up';
  if (cloudModelTag(m.id)) return 'a cloud model tag: the local route never uses a cloud-backed model';
  return f.local?.models.includes(m.id) ? null : 'the local probe did not verify it as installed local weights';
}

/** The existing action when nothing permitted can answer: local-only says what the local route lacks; else the guided setup. */
function nothingAction(f: RouteFacts, p: RoutePolicy, offered: OfferedModel[]): SetupAction {
  const state = f.local?.answer?.state;
  if (p.localOnly && state === 'listed') return ADVICE_ACTIONS['ollama-no-model'];
  if (p.localOnly && (state === 'no answer' || state === 'not sent')) return ADVICE_ACTIONS['ollama-unreachable'];
  // a model that could answer and that free-only alone keeps out: choose a free one, free-only staying on
  if (p.freeOnly && offered.some((m) => !unavailable(m, f) && policyRefusal(m, { freeOnly: true, localOnly: false }))) return ADVICE_ACTIONS['free-only'];
  return ADVICE_ACTIONS['no-route'];
}

/**
 * The advice for the next turn. Pure: the same facts and policy give the same advice, and nothing outside its arguments is
 * read or changed.
 */
export function adviseRoute(f: RouteFacts, p: RoutePolicy): RouteAdvice {
  // the candidates: the probe's verified local models first (in its order), then what the catalogs offer, then the selection
  const all: OfferedModel[] = [];
  const add = (m: OfferedModel): void => { if (!all.some((x) => x.source === m.source && x.id === m.id)) all.push(m); };
  for (const id of f.local?.models ?? []) add({ source: 'ollama-local', id, price: null });
  for (const m of f.offered) add(m);
  if (f.selected) add(f.selected);
  // option ids the decision layer accepts (src/decision/policy.ts OPTION_ID): a model id holds ':' and '/', so each has a number
  const optId = (i: number): string => `${all[i].source}.${i}`;
  const refusals = new Map<string, { reason: RouteRefusalReason; words: string }>();
  const options: DecisionOption[] = all.map((m, i) => {
    const why = unavailable(m, f);
    const r = policyRefusal(m, p);
    if (r) refusals.set(optId(i), r);
    return { id: optId(i), label: m.id, description: `${m.id} on ${SOURCE_WORDS[m.source]}`, available: why === null, ...(why ? { unavailableReason: why } : {}) };
  });
  const forbid = Object.fromEntries([...refusals].map(([id, r]) => [id, r.words]));
  const choices = allowedChoices(options, forbid);
  const byId = (id: string): OfferedModel => all[Number(id.slice(id.lastIndexOf('.') + 1))];
  const permitted = choices.permitted.map((o) => ({ source: byId(o.id).source, model: byId(o.id).id }));
  const excluded = choices.excluded.map((e) => ({ source: byId(e.id).source, model: byId(e.id).id, reason: e.reason }));
  const selectedAt = f.selected ? all.findIndex((x) => x.source === f.selected!.source && x.id === f.selected!.id) : -1;
  const rule: DeterministicRule | undefined = selectedAt >= 0 ? { option: optId(selectedAt), rule: 'the model selected for the next turn' } : undefined;
  const decided = deterministicProposal(rule, choices);
  // its words name an option by its id: said with the model's own name (the longest ids first, so .1 never cuts .10)
  const ids = all.map((m, i) => [optId(i), m.id] as const).sort((a, b) => b[0].length - a[0].length);
  const proposal: DeterministicProposal = { ...decided, rule: ids.reduce((w, [id, name]) => w.split(id).join(name), decided.rule) };
  const base = { ...(rule ? { rule } : {}), proposal, permitted, excluded };
  if (proposal.option) {
    const m = byId(proposal.option);
    return { outcome: 'route', route: { source: m.source, model: m.id }, ...base };
  }
  const refused = rule ? refusals.get(rule.option) : undefined;
  if (refused) {
    // the policy keeps the selection out (with a key or without one): never another model in its place, a person picks a
    // permitted one
    const action = refused.reason === 'cloud-under-local-only'
      ? (permitted.some((m) => m.source === 'ollama-local') ? ADVICE_ACTIONS['no-local-model'] : nothingAction(f, p, all))
      : ADVICE_ACTIONS['free-only'];
    return { outcome: 'refused', refusal: refused, action, ...base };
  }
  if (permitted.length && !rule) return { outcome: 'choose', ...base };
  return { outcome: 'setup', action: permitted.length ? ADVICE_ACTIONS['no-route'] : nothingAction(f, p, all), ...base };
}

/**
 * One line for the local log (src/utils/logger.ts writeLog): the run and fixture, the outcome, the rule and what it chose, the
 * action and the refusal's reason. Never a prompt (the helper has none), a key (it has none) or a path; a key-shaped string or
 * a home folder in any word is taken out all the same.
 */
export function adviceLogLine(a: RouteAdvice, ids: { run: string; fixture: string }): string {
  const q = (s: string): string => JSON.stringify(s);
  const parts = [
    'setup-advice', `run=${ids.run}`, `fixture=${ids.fixture}`, `outcome=${a.outcome}`, `rule=${q(a.proposal.rule)}`,
    `choice=${a.route ? `${a.route.source}:${a.route.model}` : '-'}`, `action=${a.action?.problem ?? '-'}`, `refusal=${a.refusal?.reason ?? '-'}`,
    `permitted=${a.permitted.length}`, `excluded=${a.excluded.length}`,
  ];
  return scrubHomes(redactString(parts.join(' ')));
}
