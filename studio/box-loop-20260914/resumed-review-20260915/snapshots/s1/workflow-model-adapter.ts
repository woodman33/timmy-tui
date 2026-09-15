import { createHash } from 'node:crypto';
import { getLocalOllamaBaseUrl } from '../../agent/providers.js';
import { labManifestHash, labToolSchemaHash, type LocalLabModelManifest, type LabJson, type LabRecord, type LabFetch, type LabMessage, type LabToolDefinition, type LabCallRecord } from './lab-model-adapter.js';
import { observedCitationHandles, citationTool, citeObservedHandle, constrainCitationSchema, assertCitedFinal } from './workflow-citations.js';

export const WORKFLOW_CONTEXT_WINDOW = 16384;
export interface WorkflowBudget {
  maxToolRounds: number; maxCalls: number; episodeTimeoutMs: number; requestTimeoutMs: number;
  finalReserveMs: number; maxToolOutputBytes: number; toolPredict: number; finalPredict: number;
}
export const WORKFLOW_BUDGETS = Object.freeze({
  novice: Object.freeze({ maxToolRounds: 1, maxCalls: 2, episodeTimeoutMs: 60000, requestTimeoutMs: 20000, finalReserveMs: 25000, maxToolOutputBytes: 6000, toolPredict: 512, finalPredict: 768 }),
  medium: Object.freeze({ maxToolRounds: 4, maxCalls: 5, episodeTimeoutMs: 90000, requestTimeoutMs: 30000, finalReserveMs: 35000, maxToolOutputBytes: 6000, toolPredict: 512, finalPredict: 768 }),
  hard: Object.freeze({ maxToolRounds: 6, maxCalls: 8, episodeTimeoutMs: 120000, requestTimeoutMs: 30000, finalReserveMs: 35000, maxToolOutputBytes: 6000, toolPredict: 512, finalPredict: 768 }),
});
export interface WorkflowHttpRecord { path: string; sha256: string; body: LabRecord | null; durationMs: number; error: string | null }
export interface WorkflowRequestRecord extends WorkflowHttpRecord {
  turn: number; phase: 'tools' | 'cite' | 'final'; promptTokens: number | null; completionTokens: number | null;
  evaluationDurationNs: number | null; doneReason: string | null;
  rawAssistant: { content: string; nativeToolCalls: LabJson } | null;
}
export interface WorkflowEpisodeResult {
  schema: 'timmy.workflow-model-episode/1'; model: string; modelDigest: string; manifestSha256: string; toolsSha256: string;
  contextWindow: number; budget: WorkflowBudget; messages: LabMessage[]; requests: WorkflowRequestRecord[]; metadataRequests: WorkflowHttpRecord[];
  calls: LabCallRecord[]; finalJson: LabRecord | null; rawFormatValid: boolean; formatValid: boolean;
  normalizations: { kind: 'single_json_fence'; rawSha256: string; normalizedSha256: string }[];
  error: string | null; protocolErrors: string[]; turns: number; toolRounds: number; finalRequests: number; citationRequests: number;
  attemptedCalls: number; executedCalls: number; elapsedMs: number; requestDurationMs: number;
  toolPhaseEnd: 'disabled' | 'ready' | 'round_limit' | 'call_limit' | 'time_reserve' | 'request_error' | null;
  usage: { tokenAccountingAvailable: boolean; promptTokens: number | null; completionTokens: number | null; knownPromptTokens: number; knownCompletionTokens: number; missingRequestCount: number };
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function copy<T>(value: T): T {
  function check(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (Array.isArray(item)) { item.forEach(check); return; }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) { Object.values(item).forEach(check); return; }
    throw new Error('Expected finite, plain JSON data.');
  }
  check(value); return structuredClone(value);
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, any>;
}
const textError = (error: unknown) => (error instanceof Error ? error.message : 'Workflow adapter failed.').slice(0, 400);
const nonnegative = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
function localTag(tag: string) {
  if (!tag || tag.length > 512 || /[\s\x00-\x1f\x7f]/.test(tag) || /(?:^|[:/_-])cloud(?:$|[:/_-])/i.test(tag)) throw new Error('Local workflow refuses cloud-backed or invalid model tags.');
}
function noRemote(value: Record<string, unknown>) {
  if ([value.remote_host, value.remote_model].some(v => v !== undefined && v !== null && v !== '')) throw new Error('Local workflow refuses remote execution metadata.');
}
function budgetFor(value: keyof typeof WORKFLOW_BUDGETS | Partial<WorkflowBudget> | undefined): WorkflowBudget {
  const budget = typeof value === 'string' ? { ...WORKFLOW_BUDGETS[value] } : { ...WORKFLOW_BUDGETS.novice, ...value };
  for (const [key, min, max] of [['maxToolRounds', 0, 6], ['maxCalls', 0, 8], ['episodeTimeoutMs', 1, 120000], ['requestTimeoutMs', 1, 30000], ['finalReserveMs', 1, 35000], ['maxToolOutputBytes', 128, 6000], ['toolPredict', 1, 768], ['finalPredict', 1, 768]] as const) {
    if (!Number.isInteger(budget[key]) || budget[key] < min || budget[key] > max) throw new Error(`Invalid workflow budget: ${key}.`);
  }
  if (budget.finalReserveMs >= budget.episodeTimeoutMs || budget.finalReserveMs < budget.requestTimeoutMs) throw new Error('Final reserve must cover one request and fit inside the episode deadline.');
  return budget;
}

/** Exactly one bounded request, with no redirects, downloads, fallbacks or retries. */
async function httpJson(endpoint: string, path: string, body: LabRecord | null, milliseconds: number, fetchImpl: LabFetch, entry: WorkflowHttpRecord) {
  const controller = new AbortController(), started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (milliseconds <= 0) throw new Error('Episode deadline exhausted before request.');
    return await Promise.race([
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`Ollama ${path} timed out after ${Math.ceil(milliseconds)} ms.`)); }, milliseconds); }),
      (async () => {
        const response = await fetchImpl(endpoint + path, { redirect: 'error', signal: controller.signal,
          ...(body === null ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        if (!response.ok) throw new Error(`Ollama ${path} returned HTTP ${response.status}.`);
        if (!response.body) throw new Error('Ollama response has no body.');
        const declared = response.headers.get('content-length');
        if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) { await response.body.cancel(); throw new Error('Ollama response exceeds 1 MiB.'); }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Ollama response exceeds 1 MiB.'); } chunks.push(part.value); }
        return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      })(),
    ]);
  } catch (error) { entry.error = textError(error); throw error; }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); entry.durationMs = performance.now() - started; }
}

/** Parse only a whole JSON object or one whole JSON fence; never extract or repair prose. */
export function parseWorkflowFinal(content: string): { value: LabRecord | null; rawFormatValid: boolean; formatValid: boolean; normalization: WorkflowEpisodeResult['normalizations'][number] | null } {
  const parse = (value: string) => { try { return copy(object(JSON.parse(value))) as LabRecord; } catch { return null; } };
  const raw = parse(content);
  if (raw) return { value: raw, rawFormatValid: true, formatValid: true, normalization: null };
  const fence = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(content);
  const normalized = fence && !fence[1].includes('```') ? parse(fence[1]) : null;
  return { value: normalized, rawFormatValid: false, formatValid: normalized !== null,
    normalization: normalized && fence ? { kind: 'single_json_fence', rawSha256: hash(content), normalizedSha256: hash(fence[1]) } : null };
}

/** The task and evidence remain caller supplied. This adapter knows no reference answers.
 * Final format follows https://docs.ollama.com/capabilities/structured-outputs . */
export async function runWorkflowModelEpisode(input: {
  manifest: LocalLabModelManifest; initialMessages: readonly LabMessage[]; tools: readonly LabToolDefinition[];
  dispatch: (name: string, args: LabRecord, signal?: AbortSignal) => LabJson | Promise<LabJson>;
  budget?: keyof typeof WORKFLOW_BUDGETS | Partial<WorkflowBudget>; finalFormat?: 'json' | LabRecord; fetchImpl?: LabFetch;
  citationBinding?: boolean;
}): Promise<WorkflowEpisodeResult> {
  const started = performance.now(), budget = budgetFor(input.budget), deadline = started + budget.episodeTimeoutMs;
  const manifest = freeze(copy(input.manifest)), tools = freeze(copy(input.tools)), messages = copy([...input.initialMessages]);
  const manifestSha256 = labManifestHash(manifest), toolsSha256 = labToolSchemaHash(tools), contextWindow = WORKFLOW_CONTEXT_WINDOW;
  const result: WorkflowEpisodeResult = { schema: 'timmy.workflow-model-episode/1', model: manifest.exactTag, modelDigest: manifest.digest, manifestSha256, toolsSha256, contextWindow, budget,
    messages, requests: [], metadataRequests: [], calls: [], finalJson: null, rawFormatValid: false, formatValid: false, normalizations: [], error: null, protocolErrors: [],
    turns: 0, toolRounds: 0, finalRequests: 0, citationRequests: 0, attemptedCalls: 0, executedCalls: 0, elapsedMs: 0, requestDurationMs: 0, toolPhaseEnd: null,
    usage: { tokenAccountingAvailable: false, promptTokens: null, completionTokens: null, knownPromptTokens: 0, knownCompletionTokens: 0, missingRequestCount: 0 } };
  const fetchImpl = input.fetchImpl ?? fetch;
  const finalFormat = freeze(copy(input.finalFormat ?? 'json'));
  const finalFormatHash = hash(JSON.stringify(finalFormat));
  const citationBinding = input.citationBinding === true, citedHandles: string[] = [];
  const assertFrozen = () => {
    if ((input.citationBinding === true) !== citationBinding) throw Error('Frozen citation binding mode changed.');
    if (labManifestHash(input.manifest) !== manifestSha256 || input.manifest.sha256 !== manifest.sha256 || labToolSchemaHash(input.tools) !== toolsSha256 || hash(JSON.stringify(input.finalFormat ?? 'json')) !== finalFormatHash) throw new Error('Frozen manifest, tool schemas or final format changed during the episode.');
  };
  const remaining = () => deadline - performance.now();
  async function revalidate(until: number) {
    assertFrozen();
    const request = async (path: string, body: LabRecord | null) => {
      const entry: WorkflowHttpRecord = { path, body: freeze(copy(body)), sha256: hash(body === null ? '' : JSON.stringify(body)), durationMs: 0, error: null };
      if (until <= performance.now()) throw new Error('Episode deadline exhausted before identity check.');
      result.metadataRequests.push(entry);
      const data = await httpJson(manifest.endpoint, path, entry.body, Math.min(5000, until - performance.now()), fetchImpl, entry); noRemote(data); return data;
    };
    // Settle all bounded reads before returning, so the recorded metadata cannot change later.
    const checked = await Promise.allSettled([request('/api/tags', null), request('/api/show', { model: manifest.exactTag }), request('/api/version', null)]);
    const failed = checked.find(check => check.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const [catalog, show, runtime] = checked.map(check => (check as PromiseFulfilledResult<Record<string, any>>).value);
    if (!Array.isArray(catalog.models) || catalog.models.length > 256) throw new Error('Invalid local model catalog.');
    const matches = catalog.models.map(object).filter(model => model.name === manifest.exactTag);
    if (matches.length !== 1) throw new Error('Frozen exact model tag is missing or ambiguous.');
    noRemote(matches[0]);
    if (matches[0].digest !== manifest.digest || matches[0].size !== manifest.sizeBytes) throw new Error('Frozen local model digest or size changed.');
    const details = object(show.details), lengths = Object.entries(object(show.model_info)).filter(([key, value]) => key.endsWith('.context_length') && Number.isSafeInteger(value) && Number(value) > 0).map(([, value]) => Number(value));
    const capabilities = Array.isArray(show.capabilities) ? [...new Set(show.capabilities.filter((v: unknown): v is string => typeof v === 'string'))].sort() : [];
    if (runtime.version !== manifest.runtimeVersion || !lengths.length || Math.min(...lengths) !== manifest.contextLength || (details.quantization_level ?? null) !== manifest.quantization || details.format !== manifest.format || (details.family ?? null) !== manifest.family || (details.parameter_size ?? null) !== manifest.parameterSize || JSON.stringify(capabilities) !== JSON.stringify([...manifest.capabilities].sort())) throw new Error('Frozen model metadata or runtime changed.');
  }
  async function chat(phase: 'tools' | 'cite' | 'final', until: number) {
    await revalidate(until);
    const body = freeze(copy({ model: manifest.exactTag, stream: false, think: false, truncate: false, shift: false, keep_alive: '2m',
      messages, ...(phase === 'tools' ? { tools } : phase === 'cite' ? { tools: [citationTool(observedCitationHandles(result.calls))] } : { format: citationBinding ? constrainCitationSchema(finalFormat, citedHandles) : finalFormat }),
      options: { temperature: 0, seed: 42, num_ctx: contextWindow, num_predict: phase === 'final' ? budget.finalPredict : budget.toolPredict } })) as unknown as LabRecord;
    if (Buffer.byteLength(JSON.stringify(body)) > contextWindow - 4096) throw new Error('Conservative context budget exhausted; no truncation or silent shift permitted.');
    if (until <= performance.now()) throw new Error('Episode deadline exhausted before chat.');
    const entry: WorkflowRequestRecord = { path: '/api/chat', turn: result.requests.length + 1, phase, body, sha256: hash(JSON.stringify(body)), durationMs: 0, error: null, promptTokens: null, completionTokens: null, evaluationDurationNs: null, doneReason: null, rawAssistant: null };
    result.requests.push(entry); result.turns++; if (phase === 'tools') result.toolRounds++; else if (phase === 'cite') result.citationRequests++; else result.finalRequests++;
    try {
      const response = await httpJson(manifest.endpoint, '/api/chat', body, Math.min(budget.requestTimeoutMs, until - performance.now()), fetchImpl, entry);
      entry.promptTokens = nonnegative(response.prompt_eval_count); entry.completionTokens = nonnegative(response.eval_count); entry.evaluationDurationNs = nonnegative(response.eval_duration); entry.doneReason = typeof response.done_reason === 'string' ? response.done_reason : null;
      const message = object(response.message);
      if (message.role !== 'assistant' || typeof message.content !== 'string') throw new Error('Invalid assistant envelope.');
      entry.rawAssistant = { content: message.content, nativeToolCalls: copy(message.tool_calls ?? []) };
      // Preserve only content and native calls, never private thinking fields.
      const nativeCalls = message.tool_calls ?? [];
      if (!Array.isArray(nativeCalls)) { result.attemptedCalls++; throw new Error('Malformed native tool_calls array.'); }
      result.attemptedCalls += nativeCalls.length;
      noRemote(response); if (response.model !== manifest.exactTag) throw new Error('Response model differs from frozen exact tag.');
      if (entry.completionTokens !== null && entry.completionTokens > (phase === 'final' ? budget.finalPredict : budget.toolPredict)) throw new Error('Reported generation exceeds frozen token budget.');
      if (entry.promptTokens !== null && entry.promptTokens > contextWindow) throw new Error('Reported prompt exceeds frozen context budget.');
      if (response.done !== true || response.done_reason === 'length') throw new Error('Incomplete or token-limited model response.');
      return { content: message.content as string, calls: nativeCalls as unknown[] };
    } catch (error) { entry.error = textError(error); throw error; }
    finally { result.requestDurationMs += entry.durationMs; }
  }
  try {
    localTag(manifest.exactTag); getLocalOllamaBaseUrl(manifest.endpoint);
    if (manifest.schema !== 'timmy.lab-local-model/1' || manifest.provider !== 'ollama' || manifest.sha256 !== manifestSha256 || !/^(sha256:)?[a-f0-9]{64}$/i.test(manifest.digest) || manifest.sizeBytes <= 0 || manifest.contextLength < contextWindow || !['gguf', 'safetensors'].includes(manifest.format) || !manifest.capabilities.includes('completion')) throw new Error('Invalid frozen local model manifest.');
    if (!messages.length || messages.some(m => !['system', 'user'].includes(m.role) || typeof m.content !== 'string' || Object.keys(m).some(key => !['role', 'content'].includes(key)))) throw new Error('Initial messages must contain only system/user text.');
    const names = new Set<string>();
    for (const tool of tools) {
      if (tool.type !== 'function' || !tool.function || !/^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(tool.function.name) || names.has(tool.function.name) || object(tool.function.parameters).type !== 'object') throw new Error('Invalid or duplicate tool definition.');
      names.add(tool.function.name);
    }
    if (tools.length && !manifest.capabilities.includes('tools')) throw new Error('Frozen model does not advertise native tools.');
    if (typeof finalFormat === 'string' ? finalFormat !== 'json' : object(finalFormat).type !== 'object') throw new Error('Final format must be json or a JSON schema describing an object.');
    if (!tools.length || !budget.maxToolRounds || !budget.maxCalls) result.toolPhaseEnd = 'disabled';
    else for (let round = 0; round < budget.maxToolRounds; round++) {
      if (result.attemptedCalls >= budget.maxCalls) { result.toolPhaseEnd = 'call_limit'; break; }
      if (remaining() <= budget.finalReserveMs) { result.toolPhaseEnd = 'time_reserve'; break; }
      messages.push({ role: 'user', content: `WORKFLOW CONTROL: ${budget.maxToolRounds - round} tool rounds and ${budget.maxCalls - result.attemptedCalls} tool calls remain. Use only calls needed for the requested facts. Keep tool-phase text short. When evidence is sufficient, reply READY with no tool calls. A separate FINAL response is reserved after this phase; do not repeat completed work.` });
      let reply: { content: string; calls: unknown[] };
      try { reply = await chat('tools', deadline - budget.finalReserveMs); }
      catch (error) {
        // A timed-out tool phase gets its separately budgeted final attempt, never a retry.
        // Identity, token-accounting and envelope failures remain fatal.
        if (/timed out|deadline exhausted/.test(textError(error))) { result.toolPhaseEnd = 'request_error'; break; }
        throw error;
      }
      if (!reply.calls.length) { messages.push({ role: 'assistant', content: reply.content }); result.toolPhaseEnd = 'ready'; break; }
      const batchOverBudget = result.attemptedCalls > budget.maxCalls;
      const records: LabCallRecord[] = [], normalized: NonNullable<LabMessage['tool_calls']> = [];
      for (const raw of reply.calls) {
        const id = `workflow-call-${result.calls.length + records.length + 1}`;
        let name = '(invalid)', args: LabRecord | null = null, rawArguments: LabJson = null, modelCallId: string | null = null, error: string | null = null;
        try {
          const call = object(raw), fn = object(call.function); name = typeof fn.name === 'string' ? fn.name : '(invalid)'; modelCallId = typeof call.id === 'string' ? call.id : null;
          rawArguments = fn.arguments === undefined ? null : copy(fn.arguments);
          if (batchOverBudget) throw new Error('Tool-call batch exceeds remaining calls; whole batch refused.');
          if (!names.has(name)) throw new Error('Tool name is not available in this condition.');
          args = copy(object(typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments)) as LabRecord;
        } catch (caught) { error = textError(caught); }
        records.push({ id, modelCallId, name, rawArguments, args, output: null, ok: false, executed: false, error, durationMs: 0 });
        normalized.push({ id, type: 'function', function: { name, arguments: args ?? {} } });
      }
      messages.push({ role: 'assistant', content: reply.content, tool_calls: normalized });
      for (const entry of records) {
        result.calls.push(entry); const dispatchStarted = performance.now();
        if (!entry.error && remaining() <= budget.finalReserveMs) entry.error = 'Tool phase deadline reached; final response time reserved.';
        if (!entry.error) {
          const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
          result.executedCalls++; entry.executed = true;
          try {
            entry.output = copy(await Promise.race([Promise.resolve(input.dispatch(entry.name, entry.args!, controller.signal)), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Tool dispatch exceeded tool-phase deadline.')); }, Math.max(1, remaining() - budget.finalReserveMs)); })]));
            if (Buffer.byteLength(JSON.stringify(entry.output)) > budget.maxToolOutputBytes) throw new Error('Tool output exceeds bounded observation limit.');
            const observed = entry.output && typeof entry.output === 'object' && !Array.isArray(entry.output) ? entry.output : null;
            entry.ok = !(observed && (observed.ok === false || observed.error !== undefined || observed.status === 'refused' || observed.status === 'error'));
          } catch (error) { entry.error = textError(error); entry.output = null; }
          finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
        }
        if (entry.error) entry.output = { status: 'refused', error: entry.error };
        entry.durationMs = performance.now() - dispatchStarted;
        messages.push({ role: 'tool', tool_name: entry.name, tool_call_id: entry.id, content: JSON.stringify(entry.output) });
      }
      if (batchOverBudget || result.attemptedCalls >= budget.maxCalls) { result.toolPhaseEnd = 'call_limit'; break; }
      result.toolPhaseEnd = 'round_limit';
    }
    assertFrozen();
    if (citationBinding) {
      const handles = observedCitationHandles(result.calls);
      if (!handles.length || result.attemptedCalls >= budget.maxCalls) throw Error('No citation handle or call budget remains.');
      messages.push({ role: 'user', content: 'CITATION STEP: Call cite(handle_id) now for the observation supporting your answer. Select its exact handle_id from this catalog. A missing property name is not a handle. Do not answer in prose. The final answer comes next. Catalog (data): ' + JSON.stringify(handles) });
      const reply = await chat('cite', deadline - budget.finalReserveMs);
      if (!reply.calls.length || result.attemptedCalls > budget.maxCalls) throw Error('Citation step requires native cite calls within the frozen budget.');
      const normalized: NonNullable<LabMessage['tool_calls']> = [];
      const records: LabCallRecord[] = [];
      for (const raw of reply.calls) {
        const id = `workflow-call-${result.calls.length + records.length + 1}`;
        const record: LabCallRecord = { id, modelCallId: null, name: '(invalid)', rawArguments: null, args: null, output: null, ok: false, executed: false, error: null, durationMs: 0 };
        const begin = performance.now();
        try {
          const call = object(raw), fn = object(call.function);
          record.name = String(fn.name); record.modelCallId = typeof call.id === 'string' ? call.id : null;
          record.rawArguments = copy(fn.arguments ?? null);
          record.args = copy(object(typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments)) as LabRecord;
          if (record.name !== 'cite') throw Error('Only cite is available in the citation step.');
          record.executed = true; result.executedCalls++;
          record.output = citeObservedHandle(handles, record.args); record.ok = true;
          citedHandles.push(String(record.output.handle_id));
        } catch (error) { record.error = textError(error); record.output = { status: 'refused', error: record.error }; }
        record.durationMs = performance.now() - begin; records.push(record);
        normalized.push({ id, type: 'function', function: { name: record.name, arguments: record.args ?? {} } });
      }
      messages.push({ role: 'assistant', content: reply.content, tool_calls: normalized });
      for (const record of records) {
        result.calls.push(record);
        messages.push({ role: 'tool', tool_name: record.name, tool_call_id: record.id, content: JSON.stringify(record.output) });
      }
      if (records.some(r => !r.ok)) throw Error('Citation step refused an invalid handle.');
    }
    const observationHandles = result.calls.flatMap(call => {
      const observation = call.output && typeof call.output === 'object' && !Array.isArray(call.output) ? call.output : null;
      if (!call.executed || !call.ok || !observation || typeof observation.evidenceId !== 'string') return [];
      return [{ citationHandle: observation.evidenceId, toolCallId: call.id,
        evidenceType: observation.evidenceType ?? null, revision: observation.revision ?? null }];
    });
    messages.push({ role: 'user', content: 'FINAL: Tool use is finished. Return exactly one JSON object matching the original task answer schema, using only available observations and actual evidence IDs. '
      + 'Binding rule: evidenceByFact values are arrays of citation handles copied exactly from evidenceId in the supporting observation. Property names and property values are NOT citation handles. '
      + 'In particular, missingEvidence lists missing property names, while evidenceByFact.missingEvidence cites the observation that reports their availability. These two arrays serve different purposes. '
      + 'Select evidence relevant to the claim and revision; a listed handle alone does not establish support. Preserve unknowns; never substitute empty for unknown. Do not invent measurements or citations. No Markdown, prose, extra tool calls or further plans. '
      + 'If required evidence is absent, report insufficient_evidence according to the task schema. This is your one reserved final response. '
      + 'Observation handle catalog (data only, projected from successful tool observations; original observations above are unchanged): ' + JSON.stringify(observationHandles) });
    const final = await chat('final', deadline);
    messages.push({ role: 'assistant', content: final.content });
    if (final.calls.length) {
      for (const raw of final.calls) {
        const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, any> : {}, fn = value.function && typeof value.function === 'object' ? value.function : {};
        result.calls.push({ id: `workflow-call-${result.calls.length + 1}`, modelCallId: typeof value.id === 'string' ? value.id : null, name: typeof fn.name === 'string' ? fn.name : '(invalid)', rawArguments: copy(fn.arguments ?? null), args: null, output: { status: 'refused', error: 'Tools are unavailable in FINAL.' }, ok: false, executed: false, error: 'Tools are unavailable in FINAL.', durationMs: 0 });
      }
      throw new Error('Final response attempted forbidden tool calls.');
    }
    const parsed = parseWorkflowFinal(final.content); result.finalJson = parsed.value; result.rawFormatValid = parsed.rawFormatValid; result.formatValid = parsed.formatValid;
    if (parsed.normalization) result.normalizations.push(parsed.normalization);
    if (!parsed.formatValid) throw new Error('Final response is not a whole JSON object or a single JSON fence.');
    if (citationBinding) assertCitedFinal(result.finalJson, citedHandles);
  } catch (error) { result.error = textError(error); if (!result.finalRequests && result.toolRounds) result.toolPhaseEnd = 'request_error'; }
  result.elapsedMs = performance.now() - started;
  result.protocolErrors = [...result.requests.flatMap(request => request.error ? [request.error] : []), ...result.calls.flatMap(call => call.error ? [call.error] : [])];
  result.usage.knownPromptTokens = result.requests.reduce((n, request) => n + (request.promptTokens ?? 0), 0);
  result.usage.knownCompletionTokens = result.requests.reduce((n, request) => n + (request.completionTokens ?? 0), 0);
  result.usage.missingRequestCount = result.requests.filter(request => request.promptTokens === null || request.completionTokens === null).length;
  result.usage.tokenAccountingAvailable = result.requests.length > 0 && result.usage.missingRequestCount === 0;
  if (result.usage.tokenAccountingAvailable) { result.usage.promptTokens = result.usage.knownPromptTokens; result.usage.completionTokens = result.usage.knownCompletionTokens; }
  return result;
}
