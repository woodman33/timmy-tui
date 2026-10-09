/**
 * The model route for `/observe <file> --qualify` (round R3): the observed-handle + cite exchange of
 * src/vision/evidence.ts through @openrouter/sdk's `callModel` agent/tool loop (the same OPENROUTER_API_KEY
 * and current model the plain interpretation of src/vision/route.ts uses), and what that exchange cost.
 *
 * Cost (the absent / null / number rule): nothing was sent, no cost at all; sent, the sum of the cost every
 * response of the exchange reported (each tool round's and the final one's, by response id), or null
 * (unknown, never 0) when any of them reported none, the exchange failed or it was stopped. On the
 * operator's own provider key (BYOK) a response's `cost` is only OpenRouter's fee: the provider's
 * upstream inference cost is added, and its absence makes the total unknown (as route.ts counts one).
 *
 * The client is injected: a test gives a labelled fake. Nothing here sends a request by itself.
 */
import { OpenRouter } from '@openrouter/sdk';
import type { InterpretationClient, InterpretationRequest } from './evidence.js';
import { ANSWER_MAX_BYTES } from './route.js';

/** One exchange's result as the SDK's ModelResult gives it: its final text, and its final response (usage). */
export interface QualifyResult { getText(): Promise<string>; getResponse?(): Promise<unknown> }
/** What the qualified route needs of a model client: @openrouter/sdk's `callModel` fits (sdkQualifyClient). */
export interface QualifyClient {
  callModel(request: InterpretationRequest, options?: { signal?: AbortSignal }): QualifyResult;
}

/** The SDK's own client for this key, as a QualifyClient: the compiler checks that the shapes agree. `serverURL`: a test's local fake server only. */
export const sdkQualifyClient = (apiKey: string, serverURL?: string): QualifyClient => {
  const client: OpenRouter = new OpenRouter({ apiKey, ...(serverURL ? { serverURL } : {}) });
  return client;
};

/** What one qualified exchange spent, by the rule in the module comment. */
export interface QualifySpend {
  /** callModel was invoked: the request may have gone out, so it may have been charged */
  sent: boolean;
  /** with `sent`: the reported total in USD; null when unknown */
  cost_usd: number | null;
  /** with `sent`: the total tokens, when every response reported them */
  tokens?: number;
  /** the model the final response names, when one came */
  model?: string;
  /** how many responses the cost was summed over */
  responses?: number;
}

/** How long spend() waits for the final response (its usage) after the text came. */
const SPEND_WAIT_MS = 30_000;
const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/** A response's reported cost in USD (the SDK's camelCase usage), or null when it reports none. */
function responseCost(response: unknown): number | null {
  const u = obj(obj(response)?.usage);
  if (!u || !money(u.cost)) return null;
  if (u.isByok !== true) return u.cost;
  const upstream = obj(u.costDetails)?.upstreamInferenceCost;
  return money(upstream) ? u.cost + upstream : null;
}

/** Settles as `p` does, or rejects once `signal` aborts: a client that does not honour its signal cannot hold a stop. */
export function unlessAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Wraps a QualifyClient for one exchange: the InterpretationClient to give qualifyInterpretation, and
 * `spend()` to read what it cost once it has settled. The SDK's stop condition is the one place the loop
 * shows each tool round's response, so it is watched (and still decides, unchanged). `onSend` is called as
 * the request is handed to the client.
 */
export function meteredQualifyClient(inner: QualifyClient, onSend?: () => void): { client: InterpretationClient; spend(signal?: AbortSignal): Promise<QualifySpend> } {
  let sent = false;
  let result: QualifyResult | undefined;
  let rounds: unknown[] = [];
  let failed = false;
  return {
    client: {
      callModel(request, options) {
        // Stopped before anything was handed to the client: nothing was sent, so nothing can be charged.
        if (options?.signal?.aborted) { failed = true; return { getText: () => Promise.reject(new Error('stopped before the request was sent')) }; }
        sent = true;
        try { onSend?.(); } catch { /* the caller's notice is not the request's outcome */ }
        const decide = request.stopWhen;
        const watched: typeof decide = (ctx) => {
          rounds = (ctx?.steps ?? []).map((s) => s?.response);
          return decide(ctx);
        };
        const r = inner.callModel({ ...request, stopWhen: watched }, options);
        result = r;
        return {
          getText: () => unlessAborted(r.getText(), options?.signal).catch((e: unknown) => { failed = true; throw e; }),
        };
      },
    },
    async spend(signal) {
      if (!sent) return { sent: false, cost_usd: null };
      // A stopped or failed exchange: its responses may still be charged, and what they cost is not known here.
      if (failed || signal?.aborted || !result?.getResponse) return { sent: true, cost_usd: null };
      let final: unknown;
      // The final response is already in hand once the text came; a client that never gives it cannot hold the record.
      const limit = AbortSignal.timeout(SPEND_WAIT_MS);
      try { final = await unlessAborted(result.getResponse(), signal ? AbortSignal.any([signal, limit]) : limit); } catch { return { sent: true, cost_usd: null }; }
      const seen = new Set<string>();
      const responses: unknown[] = [];
      for (const r of [...rounds, final]) {
        const id = obj(r)?.id;
        if (!obj(r)) continue;
        if (typeof id === 'string') { if (seen.has(id)) continue; seen.add(id); }
        responses.push(r);
      }
      const costs = responses.map(responseCost);
      const tokens = responses.map((r) => obj(obj(r)?.usage)?.totalTokens);
      const model = obj(final)?.model;
      return {
        sent: true,
        cost_usd: costs.length && costs.every((c): c is number => c !== null) ? costs.reduce((a, b) => a + b, 0) : null,
        ...(tokens.length && tokens.every((t): t is number => typeof t === 'number' && Number.isFinite(t)) ? { tokens: tokens.reduce((a, b) => a + b, 0) } : {}),
        ...(typeof model === 'string' && model ? { model } : {}),
        responses: responses.length,
      };
    },
  };
}

/** Text as an observation keeps it: whole up to ANSWER_MAX_BYTES; past that cut on a character boundary, and flagged. */
export function keptText(text: string): { text: string; truncated?: true; bytes?: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= ANSWER_MAX_BYTES) return { text };
  const buf = Buffer.from(text, 'utf8');
  let end = ANSWER_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, bytes };
}
