// OpenRouter is primary. The fallback accepts only installed local Ollama
// weights: a localhost endpoint can also advertise cloud-backed models.
//
// R10 (H169; the lead's note of 2026-10-22): the probe (probeOllama, assertLocalOllamaModel, getLocalOllamaBaseUrl) moved below
// both the agent and the Models rail's catalog, unchanged, to src/models/ollama-list.ts; every caller imports it from here as
// before. The catalog reads it there, so it imports nothing of the agent.
import { cloudModelTag, validOllamaModelName } from '../setup/ollama-models.js';
import { assertLocalOllamaModel, getLocalOllamaBaseUrl, ollamaDeadline } from '../models/ollama-list.js';

export {
  assertLocalOllamaModel, getLocalOllamaBaseUrl, listLocalOllama, probeOllama,
  type LocalOllamaListing, type LocalOllamaModelInfo, type OllamaAnswer, type OllamaProbeResult,
} from '../models/ollama-list.js';

// R4 (H103): one rule for each, kept with the chat's model list (src/setup/ollama-models.ts: the setup imports nothing outside
// its folder), the same regular expressions as were here.
function cloudTag(model: string): boolean {
  return cloudModelTag(model);
}

function validModelName(model: string): boolean {
  return validOllamaModelName(model);
}

/** Input should come from probeOllama; completion rechecks metadata before use. */
export function pickOllamaModel(models: string[], preferredPrefixes: string[]): string | null {
  const candidates = models.filter(model => validModelName(model) && !cloudTag(model));
  for (const prefix of preferredPrefixes) {
    const hit = candidates.find(model => model.startsWith(prefix));
    if (hit) return hit;
  }
  return candidates[0] || null;
}

export async function ollamaChatCompletion(
  model: string,
  messages: { role: string; content: string }[],
  timeoutMs = 60_000,
): Promise<string> {
  const signal = ollamaDeadline(timeoutMs);
  const base = getLocalOllamaBaseUrl();
  await assertLocalOllamaModel(model, Math.min(timeoutMs, 1500), { baseUrl: base, signal });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: 2048 }),
    signal, redirect: 'error',
  });
  if (!response.ok) throw new Error(`Ollama chat failed: HTTP ${response.status}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '';
}
