/**
 * The 2026-10-27 shared-integrator order: what the host knows about Treg without contacting it — where Timmy's own bridge
 * (./treg-bridge.ts) is, whether a sign-in file is there (its shape only: the token and the team are never read out), which
 * of Treg's tools cost money, the arguments the host accepts for each, and how a price or a charge is read from an answer
 * Treg gave. Everything Treg answers is untrusted data: read here for its numbers, shown as Treg's words, never followed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRouteAnswer } from './mcp-records.js';
import type { McpRouteId } from './mcp-cli.js';
import { tregConfigPath, TREG_TOOLS, type TregTool } from './treg-bridge.js';

type Env = Record<string, string | undefined>;
export { tregConfigPath, TREG_TOOLS, type TregTool };

/** The tools that never charge (Treg's own words: catalog lookups and the balance); `call` may. */
export const FREE_TOOLS = ['catalog_search', 'catalog_get', 'balance'] as const satisfies readonly TregTool[];
export type FreeTool = (typeof FREE_TOOLS)[number];
export const isFreeTool = (t: unknown): t is FreeTool => typeof t === 'string' && (FREE_TOOLS as readonly string[]).includes(t);

export const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
/** The parts of a paid call's request the host passes on (no headers, uploads, forms or authorization methods). */
export const CALL_PARTS = ['params', 'method', 'query', 'body'] as const;

const HERE = dirname(fileURLToPath(import.meta.url));

function findUp(file: string): string | null {
  for (let d = HERE; ; d = dirname(d)) {
    if (existsSync(join(d, file))) return join(d, file);
    if (dirname(d) === d) return null;
  }
}

/**
 * The command that starts Timmy's Treg bridge under this node: the built file beside this one (or in Timmy's tsc output),
 * else the source through tsx's loader (as the SDK route runs mcp-sdk-cli from source). null: neither is here.
 */
export function tregBridgeArgv(): string[] | null {
  const pkg = findUp('package.json');
  const root = pkg ? dirname(pkg) : null;
  const built = [join(HERE, 'treg-bridge.js'), ...(root ? [join(root, 'dist', 'src', 'connectors', 'treg-bridge.js')] : [])].find((p) => existsSync(p));
  if (built) return [process.execPath, built];
  const source = [join(HERE, 'treg-bridge.ts'), ...(root ? [join(root, 'src', 'connectors', 'treg-bridge.ts')] : [])].find((p) => existsSync(p));
  let tsx: string | null = null;
  for (let d = HERE; !tsx; d = dirname(d)) {
    const l = join(d, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    if (existsSync(l)) tsx = l;
    if (dirname(d) === d) break;
  }
  return source && tsx ? [process.execPath, '--import', pathToFileURL(tsx).href, source] : null;
}

/** The sign-in, as a file: whether it is there and holds a token (and a team), never what they are. Nothing is contacted. */
export interface TregSignIn {
  /** the file, as the environment names it: TREG_CONFIG or the home's .treg/config.json */
  from: 'TREG_CONFIG' | 'home';
  path: string;
  present: boolean;
  token: boolean;
  team: boolean;
  /** when it was last written (its own time), when present */
  written?: string;
  why?: string;
}

export function tregSignIn(env: Env): TregSignIn {
  const path = tregConfigPath(env);
  const from = env.TREG_CONFIG?.trim() && path === env.TREG_CONFIG.trim() ? 'TREG_CONFIG' as const : 'home' as const;
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return { from, path, present: false, token: false, team: false, why: 'no sign-in file there: run `treg login` (the Treg CLI), or set TREG_CONFIG to the file it wrote' }; }
  if (!st.isFile() || st.size > 64 * 1024) return { from, path, present: true, token: false, team: false, why: 'it is not a sign-in file Timmy reads (not a small file)' };
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown; active_org?: unknown };
    const token = typeof c?.token === 'string' && !!c.token.trim() && !/[\r\n]/.test(c.token);
    const team = typeof c?.active_org === 'string' && !!c.active_org.trim();
    return { from, path, present: true, token, team, written: st.mtime.toISOString(), ...(token ? {} : { why: 'the file holds no token: run `treg login` again' }) };
  } catch { return { from, path, present: true, token: false, team: false, written: st.mtime.toISOString(), why: 'the file is not JSON Timmy can read' }; }
}

/** The arguments the host passes for a free tool, checked; or why not. */
export function freeArgs(tool: FreeTool, a: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const o = a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : {};
  if (tool === 'balance') return { ok: true, args: {} };
  if (tool === 'catalog_get') {
    const id = typeof o.endpoint_id === 'string' ? o.endpoint_id.trim() : '';
    return ENDPOINT_ID.test(id) ? { ok: true, args: { endpoint_id: id } } : { ok: false, error: 'Name the endpoint by its id, as a catalog search lists it (for example tikhub.tiktok.user.profile).' };
  }
  const query = typeof o.query === 'string' ? o.query.trim() : '';
  if (!query || query.length > 200) return { ok: false, error: 'Say what you want to do in plain words (at most 200 characters), for example "backlinks for a domain".' };
  const limit = o.limit === undefined || o.limit === '' ? 5 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return { ok: false, error: 'Ask for 1 to 20 results.' };
  return { ok: true, args: { query, limit } };
}

/** A paid call's request parts, checked: only params, method, query and body; each JSON; at most 8 KB in all. */
export function callParts(r: unknown): { ok: true; parts: Record<string, unknown> } | { ok: false; error: string } {
  if (r === undefined || r === null) return { ok: true, parts: {} };
  if (typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'The request is one JSON object of params, method, query and body.' };
  const o = r as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(CALL_PARTS as readonly string[]).includes(k));
  if (extra.length) return { ok: false, error: `Timmy passes only ${CALL_PARTS.join(', ')} on a paid call, not ${extra.join(', ')}.` };
  if (o.method !== undefined && (typeof o.method !== 'string' || !/^[A-Z]{3,7}$/.test(o.method))) return { ok: false, error: 'The method is an HTTP method in capitals (GET, POST).' };
  if (o.query !== undefined && (typeof o.query !== 'object' || o.query === null || Array.isArray(o.query))) return { ok: false, error: 'The query is an object of names and values.' };
  if (JSON.stringify(o).length > 8 * 1024) return { ok: false, error: 'The request is larger than the 8 KB Timmy passes on a paid call.' };
  return { ok: true, parts: o };
}

/** The value of a tool's answer, from the route's output as output.json keeps it: its structured content, else its first
 *  text item read as JSON, else the text; null when nothing was answered. */
export function answerValue(outputText: string | undefined, route: McpRouteId): unknown {
  if (!outputText) return null;
  const a = readRouteAnswer(outputText, route);
  if (a.kind === 'json') return a.value;
  if (a.kind === 'text') return a.text;
  if (a.kind !== 'result') return null;
  if (a.structured) return a.structured.value;
  const text = a.content.map((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '')).filter(Boolean).join('\n');
  try { return JSON.parse(text); } catch { return text || null; }
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The catalog's quote for one endpoint (catalog_get's endpoint.cost), in Treg's words; null when it states no price in USD. */
export interface TregQuote {
  endpoint_id: string;
  name: string | null;
  method: string | null;
  usd: number;
  /** per_success, per_call, … as Treg says it */
  type: string | null;
  note: string | null;
  checked: string | null;
  confidence: string | null;
}

export function quoteOf(v: unknown): TregQuote | null {
  const e = obj(obj(v)?.endpoint);
  const cost = obj(e?.cost);
  if (!e || !cost) return null;
  const id = str(e.id, 160);
  const currency = str(cost.currency);
  const usd = num(cost.usd) ?? (currency === 'USD' ? num(cost.value) : null);
  if (!id || usd === null) return null;
  return { endpoint_id: id, name: str(e.name), method: str(e.method, 10), usd, type: str(cost.type, 40), note: str(cost.note), checked: str(cost.checked, 40), confidence: str(cost.confidence, 40) };
}

/**
 * What a call's answer says it charged, by the field that says it (Treg's words, never computed here): a number under a key
 * naming a charge (charged…, cost…, billed…, spent…) at the answer's top level or in its envelope objects (_meta, meta,
 * treg, billing, usage, charge, receipt), never inside the upstream data it carries (a product's "cost" is not a charge).
 * Micro-dollars (a key with micro) are given in USD too. null: the answer states no charge where Timmy looks.
 */
export function chargedOf(v: unknown): { usd: number; field: string; raw: number } | null {
  const CHARGE = /^(charged|charge|cost|billed|spent|spend)(_?(usd|micro|microdollars|micro_usd))?$/i;
  const ENVELOPE = /^(_meta|meta|treg|billing|usage|charge|receipt)$/i;
  const walk = (x: unknown, path: string, depth: number): { usd: number; field: string; raw: number } | null => {
    const o = obj(x);
    if (!o || depth > 2) return null;
    for (const [k, val] of Object.entries(o)) {
      const n = num(val);
      if (n !== null && CHARGE.test(k)) return { usd: /micro/i.test(k) ? n / 1_000_000 : n, field: path ? `${path}.${k}` : k, raw: n };
    }
    for (const [k, val] of Object.entries(o)) {
      if (!ENVELOPE.test(k)) continue;
      const hit = walk(val, path ? `${path}.${k}` : k, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(v, '', 0);
}

/** The balance Treg's balance tool answered, in its own fields (USD and micro-dollars); null when it says none. */
export function balanceOf(v: unknown): { usd: number | null; micro: number | null } | null {
  const o = obj(v);
  if (!o) return null;
  const usd = num(o.balance_usd);
  const micro = num(o.balance_micro);
  return usd === null && micro === null ? null : { usd, micro };
}

/** Money as a person reads it: $0.001, $0.25, $12.00. */
export function usdWords(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${usd.toFixed(2)}`;
}
