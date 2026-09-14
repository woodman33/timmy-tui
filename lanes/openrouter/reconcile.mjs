#!/usr/bin/env node
// timmy reconcile — the second ledger. Every model call already cites its OpenRouter
// generation id (commander-core.ts ModelCall.generation_id). This fetches the authoritative
// cost/tokens/latency/provider/fallback figures from the OpenRouter generations API and seals
// an AMEND receipt that CITES the original — receipts are append-only, so an amend is a new
// receipt pointing back, never a rewrite (ORDER ledger-r4k2, part 1).
//
//   timmy reconcile <generation-id> --cite <original-receipt-hash> [--room <room>] [--no-seal]
//
// buildAmend + fetchGeneration are exported and pure/injectable for tests.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Map an OpenRouter generation record to the amend fields. Pure; no network. */
export function buildAmend(gen, { generation_id, cites, room }) {
  const g = gen ?? {};
  const served = g.provider_name ?? null;
  // a fallback is when OpenRouter served a different provider/model than the id implies; we
  // record the served provider + upstream id and let the reconciler flag a mismatch.
  return {
    generation_id,
    cites: cites ?? null,          // the original receipt this amends
    room: room ?? null,
    authoritative: 'openrouter-generations-api',
    total_cost_usd: num(g.total_cost),
    tokens_prompt: num(g.tokens_prompt),
    tokens_completion: num(g.tokens_completion),
    native_tokens_prompt: num(g.native_tokens_prompt),
    native_tokens_completion: num(g.native_tokens_completion),
    latency_ms: num(g.latency),
    generation_time_ms: num(g.generation_time),
    moderation_latency_ms: num(g.moderation_latency),
    served_provider: served,       // served-tier record (part 4)
    model: g.model ?? null,
    finish_reason: g.finish_reason ?? null,
    streamed: typeof g.streamed === 'boolean' ? String(g.streamed) : null,
    cancelled: typeof g.cancelled === 'boolean' ? String(g.cancelled) : null,
    is_byok: typeof g.is_byok === 'boolean' ? String(g.is_byok) : null,
    upstream_id: g.upstream_id ?? null,
    origin: g.origin ?? null,
  };
}

/** GET the generation record. Never throws; returns {ok,data|error}. */
export async function fetchGeneration(id, apiKey, fetchImpl = fetch) {
  if (!apiKey) return { ok: false, error: 'OPENROUTER_API_KEY not set' };
  try {
    const r = await fetchImpl(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: `generations api ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
    return { ok: true, data: j?.data ?? j };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  return JSON.parse(readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n').pop()).hash;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const genId = args.find((a) => !a.startsWith('--'));
  if (!genId) { console.error('usage: timmy reconcile <generation-id> --cite <original-receipt-hash> [--room <room>]'); process.exit(2); }
  const g = await fetchGeneration(genId, process.env.OPENROUTER_API_KEY);
  if (!g.ok) { console.error(`[reconcile] ${g.error}`); process.exit(1); }
  const amend = buildAmend(g.data, { generation_id: genId, cites: flag('--cite'), room: flag('--room') });
  const receipt = args.includes('--no-seal') ? null : seal('openrouter.reconcile', amend);
  console.log(JSON.stringify({ ok: true, generation_id: genId, cites: amend.cites, total_cost_usd: amend.total_cost_usd, served_provider: amend.served_provider, latency_ms: amend.latency_ms, receipt }, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`[reconcile] ${e.message}`); process.exit(1); });
