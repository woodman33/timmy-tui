/**
 * R10 (H169; the operator's order of 2026-10-22: "Support ... Ollama Cloud"): Ollama's hosted API as a route of its own, apart
 * from the local one (src/agent/providers.ts and src/agent/local-chat.ts keep a loopback address only, and refuse cloud
 * models; nothing here changes them). Direct: https://ollama.com/api with the person's key as a Bearer token (Ollama's
 * documentation, docs.ollama.com/cloud and /api/authentication): no local install, no local server and no weights on this
 * computer. Everything it does is remote inference, labelled cloud on every surface, and excluded by local-only; free-only
 * refuses it too (Ollama's cloud is billed by its plans: no price per request is known here, and unknown is never free).
 *
 * The key and the hosted list live below the agent and the catalog (src/models/ollama-list.ts): OLLAMA_API_KEY, else the setup's
 * key store (providers.json ollama_cloud_api_key, H170's src/setup/provider-keys.ts). It is sent to ollama.com only, in the
 * Authorization header: never in a URL, a log, a prompt, a receipt, an error or a page. A turn runs only when a person sent it.
 *
 * In this slice the adapter answers without Timmy's tools (it offers none, and says so), streams the answer, names the model
 * Ollama answered with, and reports no cost (unknown). It is not yet a route the chat session chooses: that needs a third route
 * kind in the chat contract (src/contracts/chat-session.ts ChatRouteState), the lead's decision.
 */
import { cloudFailure, OLLAMA_CLOUD_BASE, ollamaCloudKey } from '../models/ollama-list.js';
import { checkRoute, routePolicyNow, type RoutePolicy } from './route-policy.js';

export { cloudFailure, listOllamaCloudModels, OLLAMA_CLOUD_BASE, ollamaCloudKey, ollamaCloudKeyFrom } from '../models/ollama-list.js';

type Env = Record<string, string | undefined>;

/** A request to Ollama's cloud failed: what, why, the fix, and whether anything left this computer. Never names the key. */
export class OllamaCloudError extends Error {
  readonly route = 'ollama-cloud' as const;
  constructor(what: string, reason: string, next: string, readonly sent: boolean, readonly status?: number) {
    super(`${what}\nReason: ${reason}\nNext: ${next}`);
    this.name = 'OllamaCloudError';
  }
}

/** The route in words, as every surface labels it: never "local". */
export const cloudRouteWords = (model: string): string => `${model} · Ollama Cloud (ollama.com): remote inference, no local weights`;

export interface CloudTurnOptions {
  model: string;
  /** the conversation so far, this request last */
  history: ReadonlyArray<{ role: string; content: string }>;
  instructions?: string;
  /** the text of the answer so far */
  onText?: (full: string) => void;
  /** what the turn says beside its answer (tools off, a cut answer) */
  onNotice?: (text: string) => void;
  signal?: AbortSignal;
  env?: Env;
  /** the key (default: ollamaCloudKey(env)); never logged */
  key?: string | null;
  /** the policy (default: the settings', read now) */
  policy?: RoutePolicy;
  fetch?: typeof fetch;
  /** https://ollama.com (a test gives a FAKE fetch instead of another address) */
  base?: string;
  timeoutMs?: number;
}

export interface CloudTurnResult {
  text: string;
  /** the model Ollama named in its answer */
  returned: string;
  /** a request left this computer for Ollama's cloud */
  sent: true;
  /** Ollama's cloud reports no cost per request: unknown, never zero */
  cost: { usd: null; measured: false; words: string };
  route: { source: 'ollama-cloud'; inference: 'cloud'; endpoint: string; gateway: 'none' };
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;
const said = (v: unknown, max = 200): string => {
  const s = String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const NOWHERE_ELSE = 'no other model is tried';
const cancelled = (): Error => Object.assign(new Error('Cancelled.'), { name: 'AbortError' });

/**
 * One chat turn on Ollama's cloud: POST <base>/api/chat, streamed as JSON lines. Refused before any request when the route
 * policy refuses it (local-only, free-only), when no key is set up, or when the model is not named. Throws an
 * OllamaCloudError (with `sent`) or an AbortError; otherwise the answer and the model Ollama named.
 */
export async function runOllamaCloudTurn(o: CloudTurnOptions): Promise<CloudTurnResult> {
  const env = o.env ?? process.env;
  const base = (o.base ?? OLLAMA_CLOUD_BASE).replace(/\/+$/, '');
  const endpoint = new URL(base).host;
  const policy = o.policy ?? routePolicyNow(env);
  const check = checkRoute({ source: 'ollama-cloud', model: o.model, role: 'turn' }, policy);
  if (!check.ok) throw new OllamaCloudError('This message was not sent to Ollama Cloud.', check.cause, `${check.permitted}`, false);
  if (!o.model || /\s/.test(o.model) || o.model.length > 300) throw new OllamaCloudError('No Ollama Cloud model is named, so nothing was sent.', 'the turn names no model', 'choose one in the Models rail (Ollama Cloud lists them)', false);
  const key = o.key === undefined ? ollamaCloudKey(env) : o.key;
  if (!key) throw new OllamaCloudError('Ollama Cloud is not set up, so nothing was sent.', 'no key (an Ollama account\'s key, from ollama.com/settings/keys)', 'set it up in Connections (the key is kept on this computer only)', false);
  if (o.signal?.aborted) throw cancelled();
  o.onNotice?.('tools off: Ollama Cloud turns run without Timmy\'s tools here. This answer comes from Ollama\'s cloud (remote inference), and no cost comes back (unknown).');
  const f = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 120_000;
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer;
  const messages = [
    ...(o.instructions?.trim() ? [{ role: 'system', content: `${o.instructions.trim()}\n\nNo tools are available in this conversation: you cannot read or change files or run anything.` }] : []),
    ...o.history.map((m) => ({ role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user', content: m.content })),
  ];
  let res: Response;
  try {
    res = await f(`${base}/api/chat`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ model: o.model, messages, stream: true }), signal, redirect: 'error',
    });
  } catch (err) {
    if (o.signal?.aborted) throw cancelled();
    const w = cloudFailure(err, timer.aborted, timeoutMs);
    throw new OllamaCloudError(w.sent ? 'Ollama Cloud did not answer.' : 'The request to Ollama Cloud was not sent.', w.why, `check this computer's network, then send again; ${NOWHERE_ELSE}`, w.sent);
  }
  if (res.status === 401 || res.status === 403) {
    try { await res.body?.cancel(); } catch { /* none */ }
    throw new OllamaCloudError('Ollama Cloud refused the key, so nothing was answered.', `HTTP ${res.status}`, `give a working key in Connections (ollama.com/settings/keys); ${NOWHERE_ELSE}`, true, res.status);
  }
  if (!res.ok || !res.body) {
    let words = '';
    try { words = said(obj(JSON.parse(await res.text())).error); } catch { /* none readable */ }
    throw new OllamaCloudError(`Ollama Cloud answered HTTP ${res.status} for ${o.model}.`, `its words: ${words || 'none'}`, res.status === 429 ? `its plan's limit was reached; see ollama.com/settings; ${NOWHERE_ELSE}` : `send again; ${NOWHERE_ELSE}`, true, res.status);
  }
  let text = '';
  let returned = o.model;
  let buffered = '';
  const decoder = new TextDecoder('utf-8');
  const reader = res.body.getReader();
  const onAbort = (): void => { reader.cancel().catch(() => undefined); };
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const take = (line: string): void => {
    let chunk: Record<string, unknown>;
    try { chunk = obj(JSON.parse(line)); } catch { throw new OllamaCloudError('Ollama Cloud gave an answer Timmy could not read.', 'a line of its answer is not JSON', `send again; ${NOWHERE_ELSE}`, true); }
    if (chunk.error !== undefined && chunk.error !== null) throw new OllamaCloudError('Ollama Cloud stopped the answer with an error.', `its words: ${said(chunk.error) || 'none'}`, `send again; ${NOWHERE_ELSE}`, true);
    if (typeof chunk.model === 'string' && chunk.model) returned = said(chunk.model, 200);
    const content = obj(chunk.message).content;
    if (typeof content === 'string' && content) { text += content; o.onText?.(text); }
    if (chunk.done === true && chunk.done_reason === 'length') o.onNotice?.(`${o.model} stopped at its output limit: the answer above is cut there.`);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (o.signal?.aborted) throw cancelled();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > 16 * 1024 * 1024) throw new OllamaCloudError('Ollama Cloud\'s answer was too long to read.', 'over 16 MiB', `send again; ${NOWHERE_ELSE}`, true);
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) take(line);
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) take(buffered.trim());
  } catch (err) {
    if (o.signal?.aborted) throw cancelled();
    if (err instanceof OllamaCloudError) throw err;
    throw new OllamaCloudError('Ollama Cloud stopped answering.', timer.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'the connection ended', `send again; ${NOWHERE_ELSE}`, true);
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
  return {
    text, returned, sent: true,
    cost: { usd: null, measured: false, words: 'cost unknown: Ollama\'s cloud reports none per request (its plans bill it)' },
    route: { source: 'ollama-cloud', inference: 'cloud', endpoint, gateway: 'none' },
  };
}
