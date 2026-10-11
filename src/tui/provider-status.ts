/**
 * The monitor's provider status, in words (R4 H87).
 *
 * The monitor asks nothing of a model when it starts (before, every mount of an agent POSTed "Reply OK." to OpenRouter: with
 * no key under a placeholder key, refused; with a real key, a small paid call nobody asked for). So the status says what is
 * known: no model key (and that nothing is sent), not checked (and how to check: `/model test`, one small request), or what
 * the operator's own check found.
 */

export type ModelHealth = 'UNTESTED' | 'READY' | 'ERROR' | 'FALLBACK READY';

/** What the explicit check is and costs, in the words every status uses. */
export const MODEL_CHECK_HOW = '`/model test` checks it (one small request to OpenRouter)';

/** No key: nothing is sent to a model, by the check or anything else at start. */
export const NO_MODEL_KEY = 'No model key: nothing is sent to a model. Add one with `timmy init --tui` (or OPENROUTER_API_KEY), then start the monitor again.';

export function providerStatusWords(s: { hasKey: boolean | undefined; status?: ModelHealth | string; error?: string }): string {
  if (s.hasKey === false) return NO_MODEL_KEY;
  switch (s.status) {
    case 'READY': return 'Provider: OpenRouter answered the check.';
    case 'FALLBACK READY': return 'Provider: OpenRouter did not answer; the local Ollama did.';
    case 'ERROR': return `Provider: the check failed${s.error ? ` (${s.error})` : ''}. ${MODEL_CHECK_HOW[0].toUpperCase()}${MODEL_CHECK_HOW.slice(1)} again.`;
    default: return `Provider: not checked. ${MODEL_CHECK_HOW[0].toUpperCase()}${MODEL_CHECK_HOW.slice(1)}.`;
  }
}
