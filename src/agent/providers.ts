// OpenRouter is primary. The fallback accepts only installed local Ollama
// weights: a localhost endpoint can also advertise cloud-backed models.

export interface OllamaProbeResult {
  ok: boolean;
  models: string[];
  latencyMs?: number;
}

export interface LocalOllamaModelInfo {
  name: string;
  capabilities: string[];
  contextLength: number | null;
  format: string;
  family: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
}

function deadline(timeoutMs: number): AbortSignal {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('Ollama timeout must be an integer from 1 to 120000 milliseconds');
  }
  return AbortSignal.timeout(timeoutMs);
}

/** Resolve a local client endpoint without permitting credentials or redirects. */
export function getLocalOllamaBaseUrl(base?: string): string {
  const configured = base ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const url = new URL(configured.includes('://') ? configured : `http://${configured}`);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Local Ollama requires a loopback HTTP(S) origin without credentials, path or query');
  }
  return url.origin;
}

function cloudTag(model: string): boolean {
  return /(?:^|[:/_-])cloud(?:$|[:/_-])/i.test(model);
}

function validModelName(model: string): boolean {
  return typeof model === 'string' && model.length > 0 && model.length <= 512 &&
    !/[\s\x00-\x1f\x7f]/.test(model);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Read-only verification; does not load or download model weights. */
export async function assertLocalOllamaModel(
  model: string,
  timeoutMs = 1500,
  options: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<LocalOllamaModelInfo> {
  if (!validModelName(model) || cloudTag(model)) {
    throw new Error('Local Ollama fallback refuses cloud-backed or invalid model tags');
  }
  const ownDeadline = deadline(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, ownDeadline]) : ownDeadline;
  const base = getLocalOllamaBaseUrl(options.baseUrl);
  const response = await fetch(`${base}/api/show`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }), signal, redirect: 'error',
  });
  if (!response.ok) throw new Error(`Ollama model verification failed: HTTP ${response.status}`);
  const data = record(await response.json());
  if ((data.remote_host !== undefined && data.remote_host !== null && data.remote_host !== '') ||
      (data.remote_model !== undefined && data.remote_model !== null && data.remote_model !== '')) {
    throw new Error('Local Ollama fallback refuses cloud-backed model metadata');
  }
  const details = record(data.details);
  const format = details.format;
  const capabilities = Array.isArray(data.capabilities)
    ? data.capabilities.filter((value): value is string => typeof value === 'string') : [];
  if ((format !== 'gguf' && format !== 'safetensors') || !capabilities.includes('completion')) {
    throw new Error('Ollama model metadata does not establish installed local completion weights');
  }
  const contextLengths = Object.entries(record(data.model_info))
    .filter(([key, value]) => key.endsWith('.context_length') && Number.isSafeInteger(value) && Number(value) > 0)
    .map(([, value]) => Number(value));
  const stringField = (key: string) => typeof details[key] === 'string' ? details[key] as string : null;
  return {
    name: model, capabilities, format,
    contextLength: contextLengths.length ? Math.min(...contextLengths) : null,
    family: stringField('family'), parameterSize: stringField('parameter_size'),
    quantizationLevel: stringField('quantization_level'),
  };
}

/** Only verified local completion models are reported as fallback candidates. */
export async function probeOllama(timeoutMs = 1500): Promise<OllamaProbeResult> {
  try {
    const start = Date.now();
    const signal = deadline(timeoutMs);
    const base = getLocalOllamaBaseUrl();
    const response = await fetch(`${base}/api/tags`, { signal, redirect: 'error' });
    if (!response.ok) return { ok: false, models: [] };
    const data = record(await response.json());
    if (!Array.isArray(data.models) || data.models.length > 256) return { ok: false, models: [] };
    const candidates = [...new Set(data.models.map(value => record(value).name)
      .filter((name): name is string => typeof name === 'string' && validModelName(name) && !cloudTag(name)))];
    const checked = await Promise.all(candidates.map(async model => {
      try {
        await assertLocalOllamaModel(model, timeoutMs, { baseUrl: base, signal });
        return model;
      } catch { return null; }
    }));
    const models = checked.filter((model): model is string => model !== null);
    return { ok: models.length > 0, models, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, models: [] };
  }
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
  const signal = deadline(timeoutMs);
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
