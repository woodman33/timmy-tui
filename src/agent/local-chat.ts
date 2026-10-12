/**
 * R4 (H103): the REPL's chat on a local model, behind the agent's turn interface (src/agent/core.ts send): Ollama's own chat
 * API, POST /api/chat, streamed as JSON lines.
 *
 * Why not @openrouter/sdk's callModel with a serverURL: callModel posts to <serverURL>/responses (the OpenResponses API) and
 * parses the answer with OpenRouter's event schemas. Ollama documents a /v1/responses endpoint (streaming and tools, without
 * state; callModel sends the whole input each step, so it would need none), but only in its recent versions, and whether
 * the SDK's schemas take Ollama's events was not established here (no real Ollama ran). So the OpenRouter path stays as it
 * is, and this client speaks the API every Ollama with tool calls serves, the one src/vision/spatial/local-model-review.ts
 * already uses.
 *
 * The same tools as the OpenRouter route, behind the same gates: each is the agent's own tool (gateTools has wrapped its
 * execute with the NEEDS YOU box), checked and run by the SDK's own executor (executeTool, as callModel runs it), and its
 * answer given back as callModel gives it (JSON; an error as {"error": …}). Tools are offered only when Ollama's /api/show
 * lists `tools` among the model's capabilities; otherwise the turn runs without them and says so ("tools off: <model> does
 * not take tool calls"). A call the model makes is announced only as it starts, and its answer is the tool's own: nothing
 * is invented. Nothing is ever answered by another model: an Ollama that does not answer, a model it does not list, or a
 * cloud-backed model whose name does not say cloud fails the turn with words and the fix.
 *
 * The cost: no charge when Ollama is this computer (a loopback address) and the model runs here (local weights), as the
 * code agents' local runs are recorded; otherwise unknown (Ollama's cloud, or another computer, reports no cost).
 */
import { convertZodToJsonSchema, executeTool } from '@openrouter/sdk/lib/tool-executor.js';
import type { ParsedToolCall, Tool } from '@openrouter/sdk/lib/tool-types.js';
import type { AgentEvents } from './events.js';
import { atWords, boundedText, cloudModelTag, failure, ollamaAt, type OllamaAt } from '../setup/ollama-models.js';

/** The chat's local route: the Ollama address the setup recorded, and the model chosen. */
export interface LocalChatRoute {
  /** providers.json's ollama_host (the setup's answer), else 127.0.0.1:11434 */
  host: string;
  model: string;
}

/** What the agent hands a local turn to tell: its events, and the record a cancel keeps (core.ts cancelRecord). */
export interface LocalTurnHooks {
  emit<E extends keyof AgentEvents>(event: E, ...args: Parameters<AgentEvents[E]>): void;
  /** a tool call, as it starts */
  call(id: string, name: string, args: string): void;
  /** a tool's answer; `late`: it came while a cancel took hold (a real effect, not shown) */
  output(id: string, name: string, output: string, late: boolean): void;
  /** the text of the answer so far */
  text(full: string): void;
}

export interface LocalTurnOptions {
  route: LocalChatRoute;
  instructions?: string;
  /** the conversation so far, this request last */
  history: ReadonlyArray<{ role: string; content: string }>;
  /** the agent's tools, gated (src/repl/approvals.ts gateTools) */
  tools: readonly unknown[];
  /** tool rounds at most (the OpenRouter route's stepCountIs) */
  maxSteps: number;
  signal?: AbortSignal;
  hooks: LocalTurnHooks;
  /** the model's context window (Ollama's num_ctx), only when the operator set one (TIMMY_CHAT_NUM_CTX) */
  numCtx?: number;
}

export interface LocalTurnResult {
  fullText: string;
  /** the model Ollama named in its answer */
  actualModel: string;
  /** tools were offered to the model */
  toolsOn: boolean;
  /** why tools were not offered, in words ("<model> does not take tool calls"); absent when they were */
  toolsOff?: string;
  /** a loopback Ollama and a model with local weights: no charge */
  localEndpoint: boolean;
}

/** An error of the local route, worded as the turn shows it (what; Reason; Next), never an OpenRouter key's fix. */
export class LocalChatError extends Error {
  readonly route = 'ollama' as const;
  constructor(what: string, reason: string, next: string) {
    super(`${what}\nReason: ${reason}\nNext: ${next}`);
    this.name = 'LocalChatError';
  }
}

/** Every failure's fix ends with this: the local route never falls back to OpenRouter or another model. */
const NOWHERE_ELSE = 'no other model is tried.';
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;
/** Words from Ollama (an error it gave), cleaned and bounded for a line. */
const said = (v: unknown, max = 200): string => {
  const s = String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const cancelled = (): Error => Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
const MAX_STEP_BYTES = 16 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;

/** What /api/show says of a model: its capabilities (null when Ollama lists none), and a remote host when it has one. */
export interface ShownModel { capabilities: string[] | null; remote: string | null }

/** POST /api/show for one model: what it can do, and whether Ollama sends it elsewhere. Throws a LocalChatError. */
export async function showModel(at: OllamaAt, model: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<ShownModel> {
  const timer = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, timer]) : timer;
  let res: Response;
  try {
    res = await fetch(`${at.origin}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: both, redirect: 'error' });
  } catch (err) {
    if (signal?.aborted) throw cancelled();
    const f = failure(err, timer.aborted, timeoutMs);
    throw new LocalChatError(f.state === 'not sent' ? `The request to ${atWords(at)} was not sent.` : `${atWords(at)} did not answer, so nothing was sent.`, f.why,
      `start Ollama (the Ollama app, or ollama serve), or /setup chat; ${NOWHERE_ELSE}`);
  }
  let text = '';
  try { text = await boundedText(res, 4 * 1024 * 1024); } catch (err) {
    if (signal?.aborted) throw cancelled();
    throw new LocalChatError(`${atWords(at)} gave an answer Timmy could not read.`, err instanceof Error ? err.message : String(err), `send again; ${NOWHERE_ELSE}`);
  }
  let data: Record<string, unknown> = {};
  try { data = obj(JSON.parse(text)); } catch { /* worded below */ }
  if (res.status === 404 || (/not found/i.test(String(data.error ?? '')) && !res.ok)) {
    throw new LocalChatError(`${atWords(at)} has no model named ${model}, so nothing was sent.`, `its answer: ${said(data.error) || `HTTP ${res.status}`} (Timmy downloads nothing)`,
      `/model lists what it has; ollama pull ${model} installs it; ${NOWHERE_ELSE}`);
  }
  if (!res.ok) {
    throw new LocalChatError(`${atWords(at)} answered HTTP ${res.status} about ${model}, so nothing was sent.`, `its words: ${said(data.error) || 'none'}`, `send again; if it repeats, see Ollama's own log; ${NOWHERE_ELSE}`);
  }
  const caps = Array.isArray(data.capabilities) ? data.capabilities.filter((c): c is string => typeof c === 'string') : null;
  const remote = typeof data.remote_host === 'string' && data.remote_host.trim() ? said(data.remote_host, 120)
    : typeof data.remote_model === 'string' && data.remote_model.trim() ? `its remote model ${said(data.remote_model, 80)}` : null;
  return { capabilities: caps, remote };
}

/** One tool as Ollama's chat API takes it (the JSON schema the OpenRouter route sends, from the same zod schema). */
function apiTool(t: unknown): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  const f = obj(obj(t).function);
  return { type: 'function', function: { name: String(f.name), description: typeof f.description === 'string' ? f.description : '', parameters: convertZodToJsonSchema(f.inputSchema as never) } };
}

/** JSON lines from a streamed body, each parsed; a line too long, or a body over the limit, is refused. */
async function* jsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffered = '';
  let total = 0;
  const parse = (line: string): Record<string, unknown> => {
    try { return obj(JSON.parse(line)); } catch { throw new Error('a line of its answer is not JSON'); }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_STEP_BYTES) throw new Error(`its answer is longer than ${MAX_STEP_BYTES / 1024 / 1024} MiB`);
      buffered += decoder.decode(value, { stream: true });
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) yield parse(line);
      }
      if (buffered.length > MAX_LINE) throw new Error('a line of its answer is longer than 1 MiB');
    }
    buffered += decoder.decode();
    if (buffered.trim()) yield parse(buffered.trim());
  } finally {
    reader.releaseLock();
  }
}

/** A tool call as Ollama gives it: its function's name and arguments (an object; some versions send a JSON string). */
interface OllamaCall { function?: { name?: unknown; arguments?: unknown }; id?: unknown }

/** The answer of one tool call, as callModel gives it back: the tool's own result as JSON, or {"error": …}. */
async function runCall(tools: readonly unknown[], id: string, name: string, args: unknown, round: number): Promise<string> {
  const tool = tools.find((t) => obj(obj(t).function).name === name);
  if (!tool || typeof obj(obj(tool).function).execute !== 'function') return JSON.stringify({ error: `No tool named ${name} is offered in this chat; nothing ran.` });
  let input = args;
  if (typeof input === 'string') {
    const raw = input;
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch {
      return JSON.stringify({ error: `Failed to parse tool call arguments for "${name}": The model provided invalid JSON. Raw arguments received: "${raw}". Please provide valid JSON arguments for this tool call.` });
    }
  }
  if (input === undefined || input === null) input = {};
  try {
    const call = { id, name, arguments: input } as unknown as ParsedToolCall<Tool>;
    const result = await executeTool(tool as Tool, call, { numberOfTurns: round });
    return result.error ? JSON.stringify({ error: result.error.message }) : JSON.stringify(result.result ?? null);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

let turnSeq = 0;

/**
 * One turn on the local route: /api/show, then /api/chat, streamed, with the tool loop when tools are on. Throws a
 * LocalChatError on any failure, an AbortError on a cancel; the answer's text otherwise.
 */
export async function runLocalTurn(o: LocalTurnOptions): Promise<LocalTurnResult> {
  const { hooks, route } = o;
  const aborted = (): boolean => o.signal?.aborted === true;
  const at = ollamaAt(route.host);
  if ('error' in at) throw new LocalChatError('The Ollama address the setup recorded is not one Timmy uses, so nothing was sent.', at.error, `/setup chat in the REPL, or timmy init --ollama <host>; ${NOWHERE_ELSE}`);
  const model = route.model;
  const cloudName = cloudModelTag(model);
  let cloud = cloudName;
  let localEndpoint = at.loopback && !cloud;
  const notice = (text: string): void => hooks.emit('message:user', { role: 'assistant', content: `⚙️ **[SYSTEM]** ${text}`, timestamp: Date.now() });
  try {
    const shown = await showModel(at, model, o.signal);
    if (shown.remote && !cloudName) {
      throw new LocalChatError('Ollama would send this chat off this computer, so nothing was sent.', `Ollama names ${shown.remote} for ${model}; its name does not say cloud.`,
        `/model to choose one with local weights (cloud ones only by a name that says cloud); ${NOWHERE_ELSE}`);
    }
    if (shown.remote) { cloud = true; localEndpoint = false; }
    if (shown.capabilities && !shown.capabilities.includes('completion')) {
      throw new LocalChatError(`${model} is not a chat model, so nothing was sent.`, `Ollama lists its capabilities as ${said(shown.capabilities.join(', ')) || 'none'}.`, `/model to choose a chat model Ollama lists; ${NOWHERE_ELSE}`);
    }
    let toolsOn = o.tools.length > 0 && shown.capabilities !== null && shown.capabilities.includes('tools');
    let toolsOff: string | undefined = o.tools.length === 0 ? undefined
      : shown.capabilities === null ? `Ollama did not say whether ${model} takes tool calls (its /api/show lists no capabilities)`
        : toolsOn ? undefined : `${model} does not take tool calls`;
    if (toolsOff) notice(`tools off: ${toolsOff}. This turn runs without tools.`);
    if (cloud) notice(`${model} is cloud-backed: Ollama sends this chat off this computer, and no cost comes back (unknown).`);
    else if (!at.loopback) notice(`${atWords(at)}: the chat leaves this computer for that one, and no cost comes back (unknown).`);
    const apiTools = toolsOn ? o.tools.map(apiTool) : [];
    const offNote = 'No tools are available in this conversation: you cannot read or change files or run anything. Never claim a tool ran or quote a tool result; say what the operator could do instead.';
    // the instructions, and without tools a note that there are none; then the conversation, this request last
    const opening = (withTools: boolean): Array<Record<string, unknown>> => {
      const system = [o.instructions?.trim() ?? '', withTools ? '' : offNote].filter(Boolean).join('\n\n');
      return [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...o.history.map((m) => ({ role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user', content: m.content })),
      ];
    };
    const messages = opening(toolsOn);
    const id = `local-${Date.now().toString(36)}-${++turnSeq}`;
    let full = '';
    let actualModel = model;
    let calls = 0;
    hooks.emit('stream:start');
    for (let round = 1; ; round++) {
      if (aborted()) throw cancelled();
      const body = { model, messages, stream: true, ...(toolsOn ? { tools: apiTools } : {}), ...(o.numCtx ? { options: { num_ctx: o.numCtx } } : {}) };
      let res: Response;
      try {
        res = await fetch(`${at.origin}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: o.signal, redirect: 'error' });
      } catch (err) {
        if (aborted()) throw cancelled();
        const f = failure(err, false, 0);
        throw new LocalChatError(`${atWords(at)} stopped answering.`, f.why, `start Ollama and send again; ${NOWHERE_ELSE}`);
      }
      if (!res.ok || !res.body) {
        let words = '';
        try { words = said(obj(JSON.parse(await boundedText(res, 64 * 1024))).error); } catch { /* none readable */ }
        // a model whose /api/show listed tools, refused with them on its first request: the turn goes on without tools, and
        // says so (nothing ran: the refusal came before any answer)
        if (res.status === 400 && toolsOn && round === 1 && /does not support tools/i.test(words)) {
          toolsOn = false;
          toolsOff = `Ollama says ${model} does not support tools`;
          notice(`tools off: ${toolsOff} (${words}). This turn runs without tools.`);
          messages.splice(0, messages.length, ...opening(false));
          round = 0;
          continue;
        }
        throw new LocalChatError(`${atWords(at)} answered HTTP ${res.status} for ${model}.`, `its words: ${words || 'none'}`, `send again; if it repeats, see Ollama's own log; ${NOWHERE_ELSE}`);
      }
      // one step: the text (streamed), any thinking, and the tool calls the model asks for
      const itemId = `${id}-m${round}`;
      let stepText = '';
      let doneReason: string | undefined;
      const asked: OllamaCall[] = [];
      try {
        for await (const chunk of jsonLines(res.body)) {
          if (chunk.error !== undefined && chunk.error !== null) {
            throw new LocalChatError(`${atWords(at)} stopped the answer with an error.`, `its words: ${said(chunk.error) || 'none'}`, `send again; if it repeats, see Ollama's own log; ${NOWHERE_ELSE}`);
          }
          if (typeof chunk.model === 'string' && chunk.model) actualModel = said(chunk.model, 200);
          if ((typeof chunk.remote_host === 'string' && chunk.remote_host) || (typeof chunk.remote_model === 'string' && chunk.remote_model)) {
            // the request has gone: said as it is, never undone or hidden
            if (!cloud) notice(`Ollama says this answer came from ${said(chunk.remote_host || chunk.remote_model, 120)}: the chat left this computer.`);
            cloud = true;
            localEndpoint = false;
          }
          const message = obj(chunk.message);
          if (typeof message.thinking === 'string' && message.thinking) hooks.emit('reasoning:update', message.thinking);
          if (typeof message.content === 'string' && message.content) {
            const delta = (stepText === '' && full !== '' ? '\n\n' : '') + message.content;
            stepText += message.content;
            full += delta;
            hooks.text(full);
            hooks.emit('item:update', { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: stepText }] });
            hooks.emit('stream:delta', delta, full);
          }
          if (Array.isArray(message.tool_calls)) for (const c of message.tool_calls) asked.push(obj(c) as OllamaCall);
          if (chunk.done === true && typeof chunk.done_reason === 'string') doneReason = chunk.done_reason;
        }
      } catch (err) {
        if (aborted()) throw cancelled();
        if (err instanceof LocalChatError) throw err;
        throw new LocalChatError(`${atWords(at)} gave an answer Timmy could not read.`, err instanceof Error ? err.message : String(err), `send again; ${NOWHERE_ELSE}`);
      }
      if (aborted()) throw cancelled();
      if (doneReason === 'length') notice(`${model} stopped at its output limit (Ollama's done_reason: length): the answer above is cut there.`);
      if (!asked.length) break;
      if (!toolsOn) {
        notice(`${model} asked for ${asked.length === 1 ? 'a tool' : `${asked.length} tools`} though none were offered; nothing ran.`);
        break;
      }
      const names = asked.map((c) => said(c.function?.name, 60) || 'unnamed');
      if (round > o.maxSteps) {
        notice(`Stopped at the ${o.maxSteps}-step limit: ${model} asked for ${asked.length === 1 ? 'one more tool call' : `${asked.length} more tool calls`} (${names.join(', ')}), which did not run. Send another message to go on.`);
        break;
      }
      messages.push({ role: 'assistant', content: stepText, tool_calls: asked });
      for (const [i, c] of asked.entries()) {
        // a call starts only while the turn is not cancelled: one not started is never announced as started
        if (aborted()) throw cancelled();
        const callId = `${id}-c${++calls}`;
        const name = names[i];
        const raw = c.function?.arguments;
        const argsText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
        hooks.emit('item:update', { type: 'function_call', id: `fc-${callId}`, callId, name, arguments: argsText, status: 'completed' });
        let parsed: unknown = raw ?? {};
        if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { parsed = {}; } }
        hooks.emit('tool:call', name, parsed);
        hooks.call(callId, name, argsText);
        const output = await runCall(o.tools, callId, name, raw, round);
        const late = aborted();
        hooks.output(callId, name, output, late);
        if (!late) {
          hooks.emit('item:update', { type: 'function_call_output', id: `fco-${callId}`, callId, output });
          hooks.emit('tool:result', name, output);
        }
        messages.push({ role: 'tool', tool_name: name, content: output });
      }
      if (aborted()) throw cancelled();
    }
    return { fullText: full, actualModel, toolsOn, ...(toolsOff ? { toolsOff } : {}), localEndpoint };
  } finally {
    // no charge on a local endpoint, whatever happened (a cancel or a failure costs nothing there); otherwise unknown
    hooks.emit('cost:update', 0, 0, localEndpoint ? { complete: true, basis: 'local endpoint' } : { complete: false });
  }
}
