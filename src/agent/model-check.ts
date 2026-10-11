/**
 * Where the agent's explicit model check sends its one request (R4 H87).
 *
 * The check (Agent.testModelHealth, `/model test`) runs only when the operator asks, never when a monitor or an agent starts.
 * It goes to OpenRouter, unless TIMMY_MODEL_CHECK_URL names a test's FAKE upstream: honoured only for plain http on
 * 127.0.0.1, so the variable can never send the operator's key to another computer.
 */
export const OPENROUTER_CHECK_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function modelCheckUrl(env: Record<string, string | undefined> = process.env): string {
  const asked = env.TIMMY_MODEL_CHECK_URL?.trim();
  if (asked) {
    try {
      const u = new URL(asked);
      if (u.protocol === 'http:' && u.hostname === '127.0.0.1') return u.href;
    } catch { /* not an address: OpenRouter */ }
  }
  return OPENROUTER_CHECK_URL;
}
