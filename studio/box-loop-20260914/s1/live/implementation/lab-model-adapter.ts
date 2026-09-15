import { createHash } from 'node:crypto';
import { cpus, platform, arch, release, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { getLocalOllamaBaseUrl, type assertLocalOllamaModel } from '../../agent/providers.js';

export type LabJson = null | boolean | number | string | LabJson[] | { [key: string]: LabJson };
export type LabRecord = { [key: string]: LabJson };
export type LabFetch = typeof fetch;
export const LAB_CONTEXT_WINDOW = 32768;
type LocalMetadata = Awaited<ReturnType<typeof assertLocalOllamaModel>>;
export interface LabHardware { platform: string; architecture: string; osRelease: string; cpu: string | null; logicalCpus: number; memoryBytes: number; gpu: null; vramBytes: null }
export interface LocalLabModelManifest {
  schema: 'timmy.lab-local-model/1'; provider: 'ollama'; endpoint: string; exactTag: string; digest: string;
  sizeBytes: number; quantization: string | null; format: string; family: string | null; parameterSize: string | null;
  capabilities: string[]; contextLength: number; contextWindow: number; toolMode: 'native'; runtimeVersion: string;
  hardware: LabHardware; sampler: { temperature: 0; seed: 42; num_predict: 768 }; sha256: string;
}
export interface LabToolDefinition { type: 'function'; function: { name: string; description?: string; parameters: LabRecord } }
export interface LabMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: LabRecord } }[];
  tool_name?: string; tool_call_id?: string;
}
export interface LabBudget { maxTurns: number; maxAttemptedCalls: number; maxExecutedCalls: number; timeoutMs: number; maxToolOutputBytes: number }
export const LAB_BUDGETS = Object.freeze({
  strict: Object.freeze({ maxTurns: 2, maxAttemptedCalls: 2, maxExecutedCalls: 2, timeoutMs: 60000, maxToolOutputBytes: 6000 }),
  standard: Object.freeze({ maxTurns: 5, maxAttemptedCalls: 8, maxExecutedCalls: 8, timeoutMs: 60000, maxToolOutputBytes: 6000 }),
  extended: Object.freeze({ maxTurns: 8, maxAttemptedCalls: 12, maxExecutedCalls: 12, timeoutMs: 60000, maxToolOutputBytes: 6000 }),
});
export interface LabCallRecord {
  id: string; modelCallId: string | null; name: string; rawArguments: LabJson; args: LabRecord | null;
  output: LabJson; ok: boolean; executed: boolean; error: string | null; durationMs: number;
}
export interface LabRequestRecord {
  turn: number; sha256: string; body: LabRecord; durationMs: number; error: string | null;
  promptTokens: number | null; completionTokens: number | null; evaluationDurationNs: number | null;
  doneReason: string | null;
}
export interface LabEpisodeResult {
  schema: 'timmy.lab-model-episode/1'; model: string; modelDigest: string; manifestSha256: string; toolsSha256: string;
  budget: LabBudget; messages: LabMessage[]; requests: LabRequestRecord[]; calls: LabCallRecord[];
  finalJson: LabRecord | null; error: string | null; turns: number; attemptedCalls: number; executedCalls: number;
  elapsedMs: number; requestDurationMs: number;
  usage: { tokenAccountingAvailable: boolean; promptTokens: number | null; completionTokens: number | null; knownPromptTokens: number; knownCompletionTokens: number; missingRequestCount: number; generationTokensPerSecond: number | null };
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new Error('Expected finite, plain JSON data.');
}
function jsonCopy<T>(value: T): T { return JSON.parse(canonical(value)); }
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, any>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function modelTag(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value) || /(?:^|[:/_-])cloud(?:$|[:/_-])/i.test(value)) {
    throw new Error('Local lab refuses cloud-backed or invalid model tags.');
  }
}
function noRemote(value: Record<string, unknown>) {
  if ([value.remote_host, value.remote_model].some(v => v !== undefined && v !== null && v !== '')) throw new Error('Local lab refuses remote execution metadata.');
}
function failText(error: unknown): string { return error instanceof Error ? error.message : 'Local lab adapter failed.'; }
function nonnegative(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }

/** No downloads, redirects, cloud origins, response retries, or unbounded JSON readers. */
async function boundedJson(base: string, path: string, body: unknown, timeoutMs: number, fetchImpl: LabFetch): Promise<unknown> {
  const endpoint = getLocalOllamaBaseUrl(base), controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`Ollama ${path} timed out after ${timeoutMs} ms.`)); }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(endpoint + path, { redirect: 'error', signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(`Ollama ${path} returned HTTP ${response.status}.`);
      if (!response.body) throw new Error('Ollama response has no body.');
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) { await response.body.cancel(); throw new Error('Ollama response exceeds 1 MiB.'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Ollama response exceeds 1 MiB.'); } chunks.push(next.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    })()]);
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

/** Bounded equivalent of the shared assertion; its return type follows that guard.
 * The shared guard currently calls global fetch().json(), preventing bounded/injected reads. */
async function localMetadata(tag: string, base: string, fetchImpl: LabFetch): Promise<LocalMetadata> {
  modelTag(tag);
  const data = record(await boundedJson(base, '/api/show', { model: tag }, 5000, fetchImpl)); noRemote(data);
  const details = record(data.details), capabilities = Array.isArray(data.capabilities) ? data.capabilities.filter((v: unknown): v is string => typeof v === 'string') : [];
  if (!['gguf', 'safetensors'].includes(details.format) || !capabilities.includes('completion')) throw new Error('Metadata does not establish installed local completion weights.');
  const lengths = Object.entries(record(data.model_info)).filter(([key, value]) => key.endsWith('.context_length') && Number.isSafeInteger(value) && Number(value) > 0).map(([, value]) => Number(value));
  return { name: tag, capabilities: [...new Set(capabilities)].sort(), format: details.format,
    contextLength: lengths.length ? Math.min(...lengths) : null, family: typeof details.family === 'string' ? details.family : null,
    parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : null,
    quantizationLevel: typeof details.quantization_level === 'string' ? details.quantization_level : null };
}
async function catalog(base: string, fetchImpl: LabFetch) {
  const data = record(await boundedJson(base, '/api/tags', undefined, 5000, fetchImpl)); noRemote(data);
  if (!Array.isArray(data.models) || data.models.length > 256) throw new Error('Invalid local Ollama model catalog.');
  return data.models.map(record);
}
async function runtime(base: string, fetchImpl: LabFetch) {
  const data = record(await boundedJson(base, '/api/version', undefined, 5000, fetchImpl)); noRemote(data);
  if (typeof data.version !== 'string' || !data.version.length || data.version.length > 120) throw new Error('Missing Ollama runtime version.');
  return data.version as string;
}
function hardware(): LabHardware {
  let cpu = cpus()[0]?.model ?? null;
  if (platform() === 'darwin') {
    try { cpu = execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8', timeout: 1500, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cpu; } catch { /* OS metadata remains available. */ }
  }
  return { platform: platform(), architecture: arch(), osRelease: release(), cpu, logicalCpus: cpus().length, memoryBytes: totalmem(), gpu: null, vramBytes: null };
}
function identity(item: Record<string, any>, tag: string) {
  modelTag(tag); noRemote(item);
  if (item.name !== tag || !Number.isSafeInteger(item.size) || item.size <= 0 || typeof item.digest !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(item.digest)) throw new Error('Exact local tag, digest, and nonzero weight size are required.');
  return { digest: item.digest as string, sizeBytes: item.size as number };
}
export function labManifestHash(manifest: Omit<LocalLabModelManifest, 'sha256'> | LocalLabModelManifest): string {
  const { sha256: _omitted, ...payload } = manifest as LocalLabModelManifest;
  return sha(canonical(payload));
}
export function labToolSchemaHash(tools: readonly LabToolDefinition[]): string { return sha(canonical(tools)); }

/** preferredTags are exact installed tags, never prefix routing or silent fallbacks. */
export async function discoverLocalLabModels(preferredTags?: string[], options: { baseUrl?: string; fetchImpl?: LabFetch } = {}) {
  const endpoint = getLocalOllamaBaseUrl(options.baseUrl), fetchImpl = options.fetchImpl ?? fetch;
  const [items, runtimeVersion] = await Promise.all([catalog(endpoint, fetchImpl), runtime(endpoint, fetchImpl)]), machine = hardware();
  const names: unknown[] = preferredTags ?? items.map(item => item.name);
  const models: LocalLabModelManifest[] = [], excluded: { exactTag: string; reason: string }[] = [];
  for (const candidate of [...new Set(names)]) {
    const tag = typeof candidate === 'string' ? candidate : '(invalid tag)';
    try {
      modelTag(candidate);
      const matches = items.filter(item => item.name === candidate);
      if (matches.length !== 1) throw new Error('Requested exact tag is missing or ambiguous; no fallback selected.');
      const weights = identity(matches[0], candidate), info = await localMetadata(candidate, endpoint, fetchImpl);
      if (info.contextLength === null || info.contextLength <= 4096) throw new Error('A declared context window above 4096 is required.');
      const payload: Omit<LocalLabModelManifest, 'sha256'> = { schema: 'timmy.lab-local-model/1', provider: 'ollama', endpoint, exactTag: candidate, ...weights,
        quantization: info.quantizationLevel, format: info.format, family: info.family, parameterSize: info.parameterSize,
        capabilities: info.capabilities, contextLength: info.contextLength, contextWindow: Math.min(LAB_CONTEXT_WINDOW, info.contextLength), toolMode: 'native', runtimeVersion,
        hardware: machine, sampler: { temperature: 0, seed: 42, num_predict: 768 } };
      models.push(freeze({ ...payload, sha256: labManifestHash(payload) }));
    } catch (error) { excluded.push({ exactTag: tag, reason: failText(error) }); }
  }
  return freeze({ schema: 'timmy.lab-local-model-catalog/1' as const, endpoint, runtimeVersion, hardware: machine, models, excluded,
    locality: 'Local weight metadata verified; loopback is not an airgap attestation.' });
}
async function revalidate(manifest: LocalLabModelManifest, fetchImpl: LabFetch) {
  if (manifest.sha256 !== labManifestHash(manifest)) throw new Error('Frozen model manifest hash changed.');
  const [items, info, version] = await Promise.all([catalog(manifest.endpoint, fetchImpl), localMetadata(manifest.exactTag, manifest.endpoint, fetchImpl), runtime(manifest.endpoint, fetchImpl)]);
  const matches = items.filter(item => item.name === manifest.exactTag);
  if (matches.length !== 1) throw new Error('Frozen exact model tag is no longer installed uniquely.');
  const weights = identity(matches[0], manifest.exactTag);
  if (weights.digest !== manifest.digest || weights.sizeBytes !== manifest.sizeBytes) throw new Error('Frozen local model digest or size changed.');
  if (version !== manifest.runtimeVersion || info.contextLength !== manifest.contextLength || info.quantizationLevel !== manifest.quantization || info.format !== manifest.format || info.family !== manifest.family || info.parameterSize !== manifest.parameterSize || canonical(info.capabilities) !== canonical(manifest.capabilities)) throw new Error('Frozen model metadata or runtime changed.');
}
function resolveBudget(value: keyof typeof LAB_BUDGETS | Partial<LabBudget> | undefined): LabBudget {
  const budget = typeof value === 'string' ? { ...LAB_BUDGETS[value] } : { ...LAB_BUDGETS.standard, ...value };
  for (const [key, max] of [['maxTurns', 8], ['maxAttemptedCalls', 12], ['maxExecutedCalls', 12], ['timeoutMs', 300000], ['maxToolOutputBytes', 6000]] as const) {
    if (!Number.isInteger(budget[key]) || budget[key] < 1 || budget[key] > max) throw new Error(`Invalid bounded lab budget: ${key}.`);
  }
  if (budget.maxExecutedCalls > budget.maxAttemptedCalls) throw new Error('Executed call budget cannot exceed attempted calls.');
  return budget;
}

/** Actual native Ollama tool loop. Only the caller's dispatcher can execute tools. */
export async function runLabModelEpisode(input: {
  manifest: LocalLabModelManifest; initialMessages: readonly LabMessage[]; tools: readonly LabToolDefinition[];
  dispatch: (name: string, args: LabRecord) => LabJson | Promise<LabJson>;
  budget?: keyof typeof LAB_BUDGETS | Partial<LabBudget>; fetchImpl?: LabFetch;
}): Promise<LabEpisodeResult> {
  const started = performance.now(), budget = resolveBudget(input.budget), manifest = freeze(jsonCopy(input.manifest)), tools = freeze(jsonCopy(input.tools));
  const toolsSha256 = labToolSchemaHash(tools), manifestSha256 = labManifestHash(manifest), messages = jsonCopy([...input.initialMessages]);
  const result: LabEpisodeResult = { schema: 'timmy.lab-model-episode/1', model: manifest.exactTag, modelDigest: manifest.digest, manifestSha256, toolsSha256,
    budget, messages, requests: [], calls: [], finalJson: null, error: null, turns: 0, attemptedCalls: 0, executedCalls: 0, elapsedMs: 0, requestDurationMs: 0,
    usage: { tokenAccountingAvailable: false, promptTokens: null, completionTokens: null, knownPromptTokens: 0, knownCompletionTokens: 0, missingRequestCount: 0, generationTokensPerSecond: null } };
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    modelTag(manifest.exactTag); getLocalOllamaBaseUrl(manifest.endpoint);
    if (manifest.schema !== 'timmy.lab-local-model/1' || manifest.provider !== 'ollama' || manifest.sha256 !== manifestSha256 || manifest.contextWindow !== Math.min(LAB_CONTEXT_WINDOW, manifest.contextLength) || manifest.contextWindow <= 4096 || canonical(manifest.sampler) !== canonical({ temperature: 0, seed: 42, num_predict: 768 })) throw new Error('Invalid frozen local model manifest.');
    if (!messages.length || messages.some(m => !['system', 'user'].includes(m.role) || typeof m.content !== 'string' || Object.keys(m).some(k => !['role', 'content'].includes(k)))) throw new Error('Initial messages must contain only system/user text, without prior observations.');
    const names = new Set<string>();
    for (const tool of tools) {
      if (tool.type !== 'function' || !tool.function || !/^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(tool.function.name) || names.has(tool.function.name) || record(tool.function.parameters).type !== 'object') throw new Error('Invalid or duplicate canonical tool definition.');
      names.add(tool.function.name);
    }
    if (tools.length && !manifest.capabilities.includes('tools')) throw new Error('Frozen model does not advertise native tool support.');
    for (let turn = 1; turn <= budget.maxTurns; turn++) {
      if (labManifestHash(input.manifest) !== manifestSha256 || input.manifest.sha256 !== manifest.sha256 || labToolSchemaHash(input.tools) !== toolsSha256) throw new Error('Frozen manifest or tool schemas changed during the episode.');
      await revalidate(manifest, fetchImpl);
      const body = jsonCopy({ model: manifest.exactTag, stream: false, think: false, truncate: false, shift: false, keep_alive: '2m', tools, messages,
        options: { ...manifest.sampler, num_ctx: manifest.contextWindow } }) as unknown as LabRecord;
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > manifest.contextWindow - 4096) throw new Error('Conservative context budget exhausted; no truncation or silent shift permitted.');
      const request: LabRequestRecord = { turn, sha256: sha(JSON.stringify(body)), body, durationMs: 0, error: null, promptTokens: null, completionTokens: null, evaluationDurationNs: null, doneReason: null };
      result.requests.push(request); result.turns = turn;
      const requestStarted = performance.now(); let response: Record<string, any>;
      try { response = record(await boundedJson(manifest.endpoint, '/api/chat', body, budget.timeoutMs, fetchImpl)); }
      catch (error) { request.error = failText(error); throw error; }
      finally { request.durationMs = performance.now() - requestStarted; result.requestDurationMs += request.durationMs; }
      request.promptTokens = nonnegative(response.prompt_eval_count); request.completionTokens = nonnegative(response.eval_count);
      request.evaluationDurationNs = nonnegative(response.eval_duration); request.doneReason = typeof response.done_reason === 'string' ? response.done_reason : null;
      if (request.completionTokens !== null && request.completionTokens > manifest.sampler.num_predict) throw new Error('Reported generation exceeds the frozen token budget.');
      if (request.promptTokens !== null && request.promptTokens > manifest.contextWindow) throw new Error('Reported prompt exceeds the frozen context budget.');
      noRemote(response);
      if (response.model !== manifest.exactTag) throw new Error('Response model differs from the frozen exact tag.');
      if (response.done !== true || response.done_reason === 'length') throw new Error('Incomplete or token-limited model response.');
      const rawMessage = record(response.message);
      if (rawMessage.role !== 'assistant' || typeof rawMessage.content !== 'string') throw new Error('Invalid assistant response envelope.');
      const rawCalls = rawMessage.tool_calls ?? [];
      if (!Array.isArray(rawCalls)) throw new Error('Malformed native tool_calls array.');
      // Deliberation/thinking fields never enter transcripts, hashes, or future requests.
      if (!rawCalls.length) {
        messages.push({ role: 'assistant', content: rawMessage.content });
        result.finalJson = jsonCopy(record(JSON.parse(rawMessage.content))) as LabRecord;
        break;
      }
      result.attemptedCalls += rawCalls.length;
      if (result.attemptedCalls > budget.maxAttemptedCalls) throw new Error('Attempted tool-call budget exceeded; batch refused before dispatch.');
      const normalized: NonNullable<LabMessage['tool_calls']> = [], records: LabCallRecord[] = [];
      for (const raw of rawCalls) {
        const call = record(raw), fn = call.function && typeof call.function === 'object' ? call.function : {};
        const id = `lab-call-${result.calls.length + records.length + 1}`, name = typeof fn.name === 'string' ? fn.name : '(invalid)';
        let args: LabRecord | null = null, error: string | null = null;
        const rawArguments: LabJson = fn.arguments === undefined ? null : jsonCopy(fn.arguments);
        try { if (!names.has(name)) throw new Error('Tool name is not available in this condition.'); args = jsonCopy(record(typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments)) as LabRecord; }
        catch (caught) { error = failText(caught); }
        const entry: LabCallRecord = { id, modelCallId: typeof call.id === 'string' ? call.id : null, name, rawArguments, args,
          output: null, ok: false, executed: false, error, durationMs: 0 };
        records.push(entry); normalized.push({ id, type: 'function', function: { name, arguments: args ?? {} } });
      }
      messages.push({ role: 'assistant', content: rawMessage.content, tool_calls: normalized });
      for (const entry of records) {
        result.calls.push(entry);
        const dispatchStarted = performance.now();
        if (!entry.error) {
          if (result.executedCalls >= budget.maxExecutedCalls) throw new Error('Executed tool-call budget exhausted before dispatch.');
          result.executedCalls++; entry.executed = true;
          try {
            entry.output = jsonCopy(await input.dispatch(entry.name, entry.args!));
            if (Buffer.byteLength(JSON.stringify(entry.output), 'utf8') > budget.maxToolOutputBytes) throw new Error('Tool output exceeds the bounded observation limit.');
            const output = entry.output && typeof entry.output === 'object' && !Array.isArray(entry.output) ? entry.output : null;
            entry.ok = !(output && (output.ok === false || output.error !== undefined || output.status === 'refused' || output.status === 'error'));
          } catch (error) { entry.error = failText(error); entry.output = null; }
        }
        if (entry.error) entry.output = { error: entry.error, status: 'refused' };
        entry.durationMs = performance.now() - dispatchStarted;
        messages.push({ role: 'tool', tool_name: entry.name, tool_call_id: entry.id, content: JSON.stringify(entry.output) });
      }
    }
    if (result.finalJson === null) throw new Error('Model-turn budget exhausted without a strict JSON answer.');
  } catch (error) { result.error = failText(error); }
  result.elapsedMs = performance.now() - started;
  result.usage.knownPromptTokens = result.requests.reduce((n, r) => n + (r.promptTokens ?? 0), 0);
  result.usage.knownCompletionTokens = result.requests.reduce((n, r) => n + (r.completionTokens ?? 0), 0);
  result.usage.missingRequestCount = result.requests.filter(r => r.promptTokens === null || r.completionTokens === null).length;
  result.usage.tokenAccountingAvailable = result.requests.length > 0 && result.usage.missingRequestCount === 0;
  if (result.usage.tokenAccountingAvailable) { result.usage.promptTokens = result.usage.knownPromptTokens; result.usage.completionTokens = result.usage.knownCompletionTokens; }
  if (result.requests.length > 0 && result.requests.every(r => r.completionTokens !== null && r.evaluationDurationNs !== null && r.evaluationDurationNs > 0)) {
    result.usage.generationTokensPerSecond = result.usage.knownCompletionTokens / (result.requests.reduce((n, r) => n + r.evaluationDurationNs!, 0) / 1e9);
  }
  return result;
}
