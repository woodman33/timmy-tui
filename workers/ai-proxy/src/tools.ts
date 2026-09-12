// The edge tool set an agent's generated script can call, and the wrapper
// that turns it into a Code Mode connector. Every call is recorded (name,
// args hash, ms, ok) so the run's receipt can list exactly what the script did.
// Paid tools (OpenRouter) refuse without an operator approval token; nothing
// here is destructive, but the flag exists so future tools inherit the gate.
import { z } from 'zod';
import { type EdgeReceipt, appendEdgeReceipt, sha256Hex, verifyEdgeChain } from './chain.js';

export interface Env {
  OPENROUTER_API_KEY?: string;
  TIMMY_EDGE_TOKEN?: string;
  ALLOWED_MODELS?: string;
  RATE_LIMIT_PER_MIN?: string;
  CUSTODY_BASE_URL?: string;
  /** App attribution (HTTP-Referer) on every OpenRouter call; defaults to the custody site. */
  OPENROUTER_REFERER?: string;
  LOADER?: unknown;
  CUSTODY_KV?: import("./head.js").KVLike;
}

export interface ToolCall {
  name: string;
  args_sha256: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface ToolCtx {
  env: Env;
  /** Operator approval token (single-use, minted by `timmy approve`). Absent = paid tools refuse. */
  approval?: string;
  calls: ToolCall[];
  /** In-run receipt chain for receipt_seal (subject = run id). */
  chain: EdgeReceipt[];
  runId: string;
  fetch?: typeof fetch;
}

export interface EdgeTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  paid?: boolean;
  destructive?: boolean;
  run(args: I, ctx: ToolCtx): Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = EdgeTool<any>;

/** Infers the args type from the zod schema so each `run` is typed. */
function tool<I>(t: EdgeTool<I>): AnyTool {
  return t as AnyTool;
}

const custodyBase = (env: Env): string => env.CUSTODY_BASE_URL ?? 'https://custody.timmy.dev';

export const OPENROUTER_REFERER = 'https://custody.timmy.dev';
export const OPENROUTER_CATEGORIES = 'cli-agents,programming';

/** Every OpenRouter request from this worker carries app attribution and asks for router metadata (app-attribution-headers, router-metadata). */
export function openrouterHeaders(env: Env, title = 'TIMMY'): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.OPENROUTER_API_KEY ?? ''}`,
    'HTTP-Referer': env.OPENROUTER_REFERER ?? OPENROUTER_REFERER,
    'X-Title': title,
    'X-OpenRouter-Categories': OPENROUTER_CATEGORIES,
    'X-OpenRouter-Metadata': 'enabled'
  };
}

type OpenRouterModels = { data?: { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[] };
type OpenRouterChat = { choices?: { message?: { content?: string } }[]; usage?: unknown; error?: unknown };

export function edgeTools(): AnyTool[] {
  return [
    tool({
      name: 'tools_list',
      description: 'List every tool available to this script with its JSON schema.',
      input: z.object({}),
      async run() {
        return edgeTools().map((t) => ({ name: t.name, description: t.description, paid: !!t.paid, destructive: !!t.destructive, schema: z.toJSONSchema(t.input) }));
      }
    }),

    tool({
      name: 'custody_verify_tap',
      description: 'Verify a Vault Custody tap URL query (e/c[/d/tt] or u/n/c) against the custody edge; returns the tap outcome JSON (ok, serial, uid, counter, receiptHash) or the refusal.',
      input: z.object({ query: z.string().describe('the query string after /t?, e.g. e=…&c=…') }),
      async run(a, ctx) {
        const f = ctx.fetch ?? fetch;
        const r = await f(`${custodyBase(ctx.env)}/t?${a.query}&format=json`);
        return { status: r.status, body: await r.json() };
      }
    }),

    tool({
      name: 'custody_chain',
      description: "Read a unit's custody chain (timeline + sealed taps + verification) from the custody edge.",
      input: z.object({ serial: z.string().regex(/^[A-Za-z0-9-]{3,32}$/) }),
      async run(a, ctx) {
        const f = ctx.fetch ?? fetch;
        const r = await f(`${custodyBase(ctx.env)}/api/chain/${a.serial}`);
        return { status: r.status, body: await r.json() };
      }
    }),

    tool({
      name: 'openrouter_models',
      description: 'List the models this edge will accept (the allowlist), with context length and pricing.',
      input: z.object({}),
      async run(_a, ctx) {
        const allow = allowlist(ctx.env);
        const f = ctx.fetch ?? fetch;
        if (!ctx.env.OPENROUTER_API_KEY) return { allow, models: [], note: 'OPENROUTER_API_KEY not set on worker' };
        const r = await f('https://openrouter.ai/api/v1/models', { headers: openrouterHeaders(ctx.env, 'TIMMY code mode') });
        if (!r.ok) return { allow, error: `upstream ${r.status}` };
        const j = (await r.json()) as OpenRouterModels;
        return { allow, models: (j.data ?? []).filter((m) => allow.includes(m.id)).map((m) => ({ id: m.id, ctx: m.context_length, in: m.pricing?.prompt, out: m.pricing?.completion })) };
      }
    }),

    tool({
      name: 'openrouter_chat',
      description: 'One chat completion through OpenRouter. PAID: refuses without an operator approval token. Model must be on the allowlist.',
      input: z.object({
        model: z.string(),
        messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).min(1),
        max_tokens: z.number().int().positive().max(8192).optional()
      }),
      paid: true,
      async run(a, ctx) {
        const allow = allowlist(ctx.env);
        if (!isAllowed(allow, a.model)) throw new Error(`model not on allowlist: ${a.model}`);
        if (!ctx.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set on worker');
        const f = ctx.fetch ?? fetch;
        const r = await f('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: openrouterHeaders(ctx.env, 'TIMMY code mode'),
          body: JSON.stringify({ model: a.model, messages: a.messages, max_tokens: a.max_tokens ?? 1024, usage: { include: true } })
        });
        const j = (await r.json()) as OpenRouterChat;
        if (!r.ok) throw new Error(`upstream ${r.status}: ${JSON.stringify(j.error ?? j)}`);
        return { model: a.model, content: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? null };
      }
    }),

    tool({
      name: 'receipt_seal',
      description: "Seal a receipt into this run's chain (prev → this). Returns the receipt with its hash.",
      input: z.object({ kind: z.string().regex(/^[a-z][a-z0-9_.-]{1,64}$/), data: z.record(z.string(), z.unknown()) }),
      async run(a, ctx) {
        return appendEdgeReceipt(ctx.chain, { kind: a.kind, subject: ctx.runId, data: a.data });
      }
    }),

    tool({
      name: 'receipt_verify',
      description: "Walk this run's receipt chain; returns ok/count/head or brokenAt.",
      input: z.object({}),
      async run(_a, ctx) {
        return verifyEdgeChain(ctx.chain);
      }
    })
  ];
}

export function allowlist(env: Env): string[] {
  return String(env.ALLOWED_MODELS ?? 'google/gemini-3.7-flash,x-ai/grok-4.6')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** OpenRouter model-variant suffixes an allowlisted base id may carry (model-variant-suffixes + nitro/floor shorthands). */
export const MODEL_VARIANTS = ['nitro', 'floor', 'free', 'online', 'thinking', 'exacto', 'beta', 'extended'] as const;

/** Split `vendor/model:variant` into its base id and variant (a variant is only the last `:suffix` from MODEL_VARIANTS). */
export function splitVariant(id: string): { base: string; variant: string | null } {
  const i = id.lastIndexOf(':');
  if (i > 0) {
    const v = id.slice(i + 1);
    if ((MODEL_VARIANTS as readonly string[]).includes(v)) return { base: id.slice(0, i), variant: v };
  }
  return { base: id, variant: null };
}

/** A model is allowed when it is on the allowlist, or is an allowlisted base id with a known variant suffix. */
export function isAllowed(allow: string[], id: string): boolean {
  if (allow.includes(id)) return true;
  const { base, variant } = splitVariant(id);
  return variant !== null && allow.includes(base);
}

/** The connector shape @cloudflare/codemode's executor takes: { name, fns }. */
export interface Connector {
  name: string;
  fns: Record<string, (args: unknown) => Promise<unknown>>;
}

/** Wrap the tools for the sandbox: validate, gate, time, record. */
export function connectorFor(ctx: ToolCtx, tools: AnyTool[] = edgeTools()): Connector {
  const fns: Connector['fns'] = {};
  for (const t of tools) {
    fns[t.name] = async (raw: unknown) => {
      const started = Date.now();
      const call: ToolCall = { name: t.name, args_sha256: await sha256Hex(JSON.stringify(raw ?? null)), ms: 0, ok: false };
      ctx.calls.push(call);
      try {
        const parsed = t.input.safeParse(raw ?? {});
        if (!parsed.success) throw new Error(`invalid args for ${t.name}: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
        if ((t.paid || t.destructive) && !ctx.approval) {
          throw new Error(`${t.name} is ${t.paid ? 'paid' : 'destructive'}: operator approval token required (timmy approve <planHash>)`);
        }
        const out = await t.run(parsed.data, ctx);
        call.ok = true;
        return out;
      } catch (e) {
        call.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        call.ms = Date.now() - started;
      }
    };
  }
  return { name: 'timmy', fns };
}

/** TypeScript-ish signature block the script author (human or model) sees. */
export function toolTypes(tools: AnyTool[] = edgeTools()): string {
  return tools
    .map((t) => {
      const schema = JSON.stringify(z.toJSONSchema(t.input));
      const flags = [t.paid ? 'PAID' : '', t.destructive ? 'DESTRUCTIVE' : ''].filter(Boolean).join(' ');
      return `// ${t.description}${flags ? ` [${flags}]` : ''}\nawait timmy.${t.name}(args: ${schema}): Promise<unknown>`;
    })
    .join('\n\n');
}
