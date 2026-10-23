/**
 * R11 (H170; Phase 0 item 6, for H167's model chip and H171's page): the readiness check for one local model, shared by every
 * surface. The operator's first-use failure (the plan's 1.6): after Ollama → This computer → granite4.2:latest → Enter, nothing
 * visibly happened and nothing was asked of Ollama. Now a choice is checked, and the check's answer is what the chip shows:
 *
 *   ready              Ollama on this computer holds the model as local completion weights (its /api/show says so: a gguf or
 *                      safetensors file with the `completion` capability, no remote host)
 *   not-a-chat-model   Ollama holds it, and it cannot chat: an embedding model (no `completion`), or a cloud-backed entry
 *                      (a :cloud tag, or Ollama names a remote host for it), which the local route never uses
 *   not-installed      Ollama answered, and does not have a model of that exact name
 *   unreachable        nothing answered at the address (not running, refused, a time-out), or the address is not this computer
 *
 * One request, POST /api/show through the existing check (src/models/ollama-list.ts assertLocalOllamaModel): it reads the
 * model's facts and runs no model, so it costs nothing and loads nothing. Loopback only (getLocalOllamaBaseUrl). The name
 * is matched exactly as Ollama lists it (`granite4.2:latest`, never a spelling normalised into another model). The words
 * carry the state (DESIGN.md B10: never colour alone), with the one next step where there is one.
 */
import { assertLocalOllamaModel, getLocalOllamaBaseUrl, ollamaAddressNow, type LocalOllamaModelInfo } from '../models/ollama-list.js';
import type { Env } from './home.js';
import { cloudModelTag, validOllamaModelName } from './ollama-models.js';

export type LocalModelState = 'ready' | 'not-a-chat-model' | 'not-installed' | 'unreachable';

/** The finer cause behind a state, for a surface that says more than the state word. */
export type LocalModelWhy =
  | 'completion' | 'no-completion' | 'cloud-tag' | 'remote' | 'invalid-name' | 'not-held'
  | 'not-running' | 'no-answer' | 'not-loopback' | 'bad-answer';

export interface LocalModelCheck {
  state: LocalModelState;
  /** The state in words, with its next step where there is one: what the chip and the status row say. */
  words: string;
  /** When the check was made (ISO). */
  at: string;
  /** The name exactly as asked (never normalised). */
  name: string;
  /** The address asked (origin), or the address refused. */
  origin: string;
  why: LocalModelWhy;
  /** The model's facts as Ollama gave them (ready only). */
  facts?: LocalOllamaModelInfo;
  latencyMs: number;
}

export interface LocalModelCheckContext {
  env?: Env;
  /** The Ollama address to ask; absent: the one the chat asks (src/models/ollama-list.ts ollamaAddressNow). */
  origin?: string;
  /** The request (a test's FAKE Ollama on 127.0.0.1); absent: the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const LOCAL_MODEL_TIMEOUT_MS = 2500;

const hostOf = (origin: string): string => origin.replace(/^https?:\/\//, '').replace(/\/+$/, '');

const ctxWords = (n: number | null): string => (n === null ? '' : n >= 1e6 ? `, ${Number((n / 1e6).toFixed(2))}M context` : `, ${Math.round(n / 1000)}k context`);

/**
 * The readiness of `name` on this computer's Ollama, now. It never throws: every outcome is a state with words. No model
 * is run; nothing leaves this computer.
 */
export async function checkLocalModel(name: string, ctx: LocalModelCheckContext = {}): Promise<LocalModelCheck> {
  const started = Date.now();
  const at = new Date(started).toISOString();
  const raw = ctx.origin ?? ollamaAddressNow(ctx.env ?? process.env);
  const done = (state: LocalModelState, why: LocalModelWhy, words: string, origin: string, facts?: LocalOllamaModelInfo): LocalModelCheck =>
    ({ state, words, at, name, origin, why, ...(facts ? { facts } : {}), latencyMs: Date.now() - started });
  if (!validOllamaModelName(name)) return done('not-a-chat-model', 'invalid-name', 'That is not a model name Ollama lists (one word, no spaces): choose one from the list.', raw);
  if (cloudModelTag(name)) return done('not-a-chat-model', 'cloud-tag', `${name} is a cloud model: this computer's Ollama would send the chat to a cloud, so the local route never uses it. Choose a model with local weights, or Ollama Cloud with its key.`, raw);
  let origin: string;
  try { origin = getLocalOllamaBaseUrl(raw); } catch {
    return done('unreachable', 'not-loopback', `${hostOf(raw)} is not this computer: Timmy asks a local Ollama only at a loopback address (127.0.0.1, localhost). Set the address to Ollama on this computer.`, raw);
  }
  const host = hostOf(origin);
  const timeoutMs = ctx.timeoutMs ?? LOCAL_MODEL_TIMEOUT_MS;
  try {
    const facts = await assertLocalOllamaModel(name, timeoutMs, { baseUrl: origin, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
    const size = [facts.parameterSize, facts.quantizationLevel].filter(Boolean).join(' ');
    return done('ready', 'completion', `ready: ${name} is installed on this computer's Ollama (${size || 'size not given'}${ctxWords(facts.contextLength)}); checked just now, no model run.`, origin, facts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const http = /HTTP (\d{3})/.exec(msg);
    if (http?.[1] === '404') return done('not-installed', 'not-held', `Ollama at ${host} does not have ${name}: ollama pull ${name} downloads it (its size shows first), then choose it again.`, origin);
    if (http) return done('unreachable', 'bad-answer', `Something at ${host} answered HTTP ${http[1]} to Ollama's model question: check that Ollama is what listens there.`, origin);
    if (/cloud-backed model metadata/.test(msg)) return done('not-a-chat-model', 'remote', `${name} is cloud-backed: Ollama at ${host} names a remote host for it, so the local route never uses it. Choose a model with local weights.`, origin);
    if (/local completion weights/.test(msg)) return done('not-a-chat-model', 'no-completion', `${name} is not a chat model: Ollama at ${host} lists it without the completion capability (an embedding model, or weights in a form it cannot run). Choose a chat model.`, origin);
    if (/cloud-backed or invalid/.test(msg)) return done('not-a-chat-model', 'cloud-tag', `${name} is a cloud model tag: the local route never uses it.`, origin);
    const aborted = ctx.signal?.aborted === true;
    const cause = (e as { cause?: { code?: unknown } } | undefined)?.cause;
    const code = typeof cause?.code === 'string' && /^[A-Z_]{3,40}$/.test(cause.code) ? cause.code : null;
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') && !aborted) return done('unreachable', 'no-answer', `Ollama at ${host} did not answer within ${timeoutMs / 1000} s: check that it runs (ollama serve), then choose the model again.`, origin);
    if (aborted) return done('unreachable', 'no-answer', `The check of ${name} was cancelled before Ollama at ${host} answered.`, origin);
    if (code === 'ECONNREFUSED') return done('unreachable', 'not-running', `Ollama is not running at ${host} (the connection was refused): start it (ollama serve), then choose the model again.`, origin);
    return done('unreachable', 'no-answer', `Ollama at ${host} did not answer (${code ? `the connection failed (${code})` : 'the request failed'}): start it (ollama serve), then choose the model again.`, origin);
  }
}

/** The chip's readiness glyph and word for a state (B10: green only for an observed answer). */
export function localModelGlyph(state: LocalModelState | 'checking' | 'unknown'): { glyph: '●' | '○' | '✕'; tone: 'live' | 'attention' | 'secondary' | 'failure'; word: string } {
  switch (state) {
    case 'ready': return { glyph: '●', tone: 'live', word: 'ready' };
    case 'checking': return { glyph: '●', tone: 'attention', word: 'checking' };
    case 'unknown': return { glyph: '○', tone: 'secondary', word: 'not checked' };
    case 'not-installed': return { glyph: '✕', tone: 'failure', word: 'not installed' };
    case 'not-a-chat-model': return { glyph: '✕', tone: 'failure', word: 'not a chat model' };
    case 'unreachable': return { glyph: '✕', tone: 'failure', word: 'unreachable' };
  }
}
