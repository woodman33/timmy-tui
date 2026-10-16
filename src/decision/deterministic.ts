/**
 * Round R4 (H120): the existing manual or deterministic path, as the caller names it: the option Timmy would pick without
 * a model (`{option, rule}`, the rule in words). It is used, with its reason recorded, whenever Clef is off, unavailable,
 * refused by policy, out of budget, too slow, malformed, stale or given too little to choose between; on an abstention it
 * is shown to the person as the fallback proposal, never applied.
 *
 * The operator's rule it keeps: nothing is invented. A named option that is unavailable is not used (a person chooses);
 * with no rule named, the one available option is the only deterministic choice there is, and with several a person
 * chooses. Nothing here calls a model or writes a file.
 */
import type { AllowedChoices } from './policy.js';
import type { DeterministicRule } from './types.js';

export interface DeterministicProposal {
  /** The option the deterministic path picks; none when a person must choose. */
  option?: string;
  /** The rule in words (and, when it cannot be followed, why). */
  rule: string;
}

export function deterministicProposal(rule: DeterministicRule | undefined, choices: AllowedChoices): DeterministicProposal {
  if (rule && typeof rule.option === 'string') {
    const words = typeof rule.rule === 'string' && rule.rule.trim() ? rule.rule.trim() : `the existing choice (${rule.option})`;
    if (choices.permitted.some((o) => o.id === rule.option)) return { option: rule.option, rule: words };
    const out = choices.excluded.find((e) => e.id === rule.option);
    if (out) return { rule: `${words} names ${rule.option}, which is out (${out.reason}): a person chooses` };
    return { rule: `${words} names ${rule.option}, which is not one of the options: a person chooses` };
  }
  if (choices.permitted.length === 1) return { option: choices.permitted[0].id, rule: 'the only available option' };
  return { rule: choices.permitted.length ? 'no deterministic rule was named: a person chooses' : 'no option is available: a person chooses' };
}
