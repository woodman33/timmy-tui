#!/usr/bin/env node
// RouteMux service lane bridge (engine-shelf/v0, service kind). Zero dependencies; Node 18+ fetch.
//
//   node bridge.mjs predict <drop> <out> <stem> [<project>] request hash + idempotency key + predicted tokens/cost  → {stem}.predict.json
//   node bridge.mjs chat    <out> <stem>                    one receipted call to api.routemux.com                  → {stem}.response.json, {stem}.headers.json
//   node bridge.mjs feed    <out> <stem> [<project>]        public pricing feed snapshot + diff vs the last snapshot → {stem}.feed.json, {stem}.feed-diff.json
//   node bridge.mjs balance <out> <stem> [<drop>]           /v1/user/balance + /v1/key/info (+ /v1/account/info), plus the drop's expected_spend_usd → {stem}.balance.json
//   node bridge.mjs report  <workflow> <out> <stem>         analysis: prediction vs actual                         → {stem}.routemux.json
//
// Honesty clause: with no ROUTEMUX_API_KEY the bridge writes {stem}.routemux.json {status:"not_configured"} and
// exits 3, so the engine.run receipt seals ok:false with status=not_configured. The key never appears in any file.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.ROUTEMUX_BASE_URL ?? 'https://api.routemux.com';
const KEY = process.env.ROUTEMUX_API_KEY ?? '';
const UA = 'timmy-tui/engine-shelf routemux-lane';
// sha256 of bytes when given bytes (Buffer/Uint8Array), of the string when given a string, of canonical JSON otherwise.
const sha = (s) => createHash('sha256').update(typeof s === 'string' || s instanceof Uint8Array ? s : JSON.stringify(s)).digest('hex');
const canon = (o) => JSON.stringify(sortKeys(o));
function sortKeys(o) { return Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])) : o; }
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const now = () => new Date().toISOString();

function fail(out, stem, status, note, code = 3) {
  writeJson(join(out, `${stem}.routemux.json`), { ok: false, status, note, at: now() });
  console.log(JSON.stringify({ ok: false, status, note }));
  process.exit(code);
}

function estTokens(messages) {
  // ~4 characters per token for English prose; a prediction, not a measurement
  const text = (messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n');
  return Math.ceil(text.length / 4);
}

// The public feed (GET /public/pricing, exercised 2026-10-04) is {schema_version, success, data: {currency, price_unit:
// "per_1m_tokens", updated_at, models: [{model_name, group_name, input_price, output_price, cache_input_price, enabled, …}]}}.
// Older or other shapes (a bare array, {models}, {items}) are still read; unknown shapes yield no rows, never a crash.
function feedRows(json) {
  if (Array.isArray(json)) return json;
  for (const c of [json?.data?.models, json?.models, json?.data, json?.items]) if (Array.isArray(c)) return c;
  return [];
}
const feedMeta = (json) => ({ price_unit: json?.data?.price_unit ?? json?.price_unit ?? null, currency: json?.data?.currency ?? json?.currency ?? null, updated: json?.data?.updated_at ?? json?.updated_at ?? json?.updated ?? json?.generated_at ?? null });
const rowId = (r) => r.model_name ?? r.id ?? r.model ?? r.slug ?? r.name ?? JSON.stringify(r).slice(0, 40);

// Best-effort price lookup in the public feed: rows are matched on model id; price fields are read from the
// first key that looks like an input/output per-million price. Unknown shapes yield null (reported as such).
function feedPrice(feed, model) {
  const rows = feedRows(feed);
  const row = rows.find((r) => [r.model_name, r.id, r.model, r.slug, r.name].includes(model));
  if (!row) return null;
  const pick = (keys) => { for (const k of keys) if (row[k] != null && !isNaN(Number(row[k]))) return Number(row[k]); const p = row.pricing ?? row.price ?? {}; for (const k of keys) if (p[k] != null && !isNaN(Number(p[k]))) return Number(p[k]); return null; };
  const inp = pick(['input_price', 'input_per_1m', 'input_price_per_1m', 'prompt_per_1m', 'input', 'prompt', 'input_usd_per_1m']);
  const outp = pick(['output_price', 'output_per_1m', 'output_price_per_1m', 'completion_per_1m', 'output', 'completion', 'output_usd_per_1m']);
  if (inp == null && outp == null) return null;
  const cache = pick(['cache_input_price', 'cache_input_per_1m', 'cached_input']);
  return { input_per_1m: inp, output_per_1m: outp, cache_input_per_1m: cache, enabled: row.enabled ?? null, group: row.group_name ?? null, raw_keys: Object.keys(row).slice(0, 12) };
}

// The newest *.feed.json under <project>/out/routemux/model-feed-snapshot/, skipping the run directory that is being
// written right now (otherwise a feed diff would compare the snapshot with itself).
function latestFeed(project, excludeDir = null) {
  if (!project) return null;
  const dir = join(project, 'out', 'routemux', 'model-feed-snapshot');
  if (!existsSync(dir)) return null;
  const skip = excludeDir ? resolve(excludeDir) : null;
  const runs = readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory() && resolve(p) !== skip).sort().reverse();
  for (const r of runs) for (const f of readdirSync(r)) if (f.endsWith('.feed.json')) { try { return { path: join(r, f), feed: readJson(join(r, f)) }; } catch { /* skip */ } }
  return null;
}

async function predict([drop, out, stem, projectArg]) {
  const req = readJson(drop);
  const protocol = req.protocol ?? 'openai';
  const body = protocol === 'anthropic'
    ? { model: req.model, max_tokens: req.max_tokens ?? 512, messages: req.messages, ...(req.system ? { system: req.system } : {}) }
    : { model: req.model, messages: req.messages, max_tokens: req.max_tokens ?? 512, ...(req.temperature != null ? { temperature: req.temperature } : {}), ...(req.tools ? { tools: req.tools } : {}) };
  const request_sha256 = sha(canon(body));
  const project = projectArg ?? process.env.TIMMY_PROJECT_DIR ?? req.project ?? null;
  const feed = latestFeed(project);
  const price = feed ? feedPrice(feed.feed, req.model) : null;
  const tokens_in = estTokens(req.messages) + (req.system ? Math.ceil(String(req.system).length / 4) : 0);
  const tokens_out = req.predict?.tokens_out ?? Math.min(body.max_tokens, Math.max(32, Math.round(tokens_in * 0.6)));
  const cost = price ? ((tokens_in * (price.input_per_1m ?? 0)) + (tokens_out * (price.output_per_1m ?? 0))) / 1e6 : null;
  const pred = {
    kind: 'routemux.predict', at: now(), model: req.model, protocol, request_sha256,
    idempotency_key: `timmy-${request_sha256}`,   // the full request hash, namespaced so Timmy's keys never collide with another client's
    predicted: { tokens_in, tokens_out, cost_usd: req.predict?.cost_usd ?? cost, latency_ms: req.predict?.latency_ms ?? null, outcome: req.predict?.outcome ?? 'ok' },
    price_source: feed ? { feed: feed.path.replace(process.env.HOME ?? '', '~'), price } : null,
    body,
    note: price ? 'cost predicted from the latest public pricing snapshot' : 'no pricing snapshot in this project: run model-feed-snapshot first for a cost prediction',
  };
  writeJson(join(out, `${stem}.predict.json`), pred);
  console.log(JSON.stringify({ ok: true, request_sha256, tokens_in, tokens_out, cost_usd: pred.predicted.cost_usd }));
}

async function chat([out, stem]) {
  const pred = readJson(join(out, `${stem}.predict.json`));
  if (!KEY) fail(out, stem, 'not_configured', 'ROUTEMUX_API_KEY is not set in the environment');
  const url = pred.protocol === 'anthropic' ? `${BASE}/anthropic/v1/messages` : `${BASE}/v1/chat/completions`;
  const headers = { 'content-type': 'application/json', 'user-agent': UA, 'X-Idempotency-Key': pred.idempotency_key };
  if (pred.protocol === 'anthropic') { headers['x-api-key'] = KEY; headers['anthropic-version'] = '2023-06-01'; } else headers.authorization = `Bearer ${KEY}`;
  const t0 = Date.now();
  let res, text;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(pred.body) }); text = await res.text(); }
  catch (e) { fail(out, stem, 'blocked', `network error: ${e.message}`, 4); }
  const latency_ms = Date.now() - t0;
  const h = {}; res.headers.forEach((v, k) => { if (!/authorization|api-key|cookie/i.test(k)) h[k] = v; });
  let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
  writeJson(join(out, `${stem}.headers.json`), { url, status: res.status, latency_ms, request_id: h['x-request-id'] ?? null, billed: h['x-routemux-billed'] ?? null, idempotency_key: pred.idempotency_key, replayed: res.status === 409, headers: h, at: now() });
  writeJson(join(out, `${stem}.response.json`), json ?? { raw: text.slice(0, 20000) });
  if (!res.ok && res.status !== 409) fail(out, stem, res.status === 401 || res.status === 403 ? 'blocked' : 'failed', `HTTP ${res.status}: ${text.slice(0, 300)}`, 5);
  console.log(JSON.stringify({ ok: true, status: res.status, request_id: h['x-request-id'] ?? null, billed: h['x-routemux-billed'] ?? null, latency_ms }));
}

async function feed([out, stem, project]) {
  const url = `${BASE}/public/pricing`;
  let res, text;
  try { res = await fetch(url, { headers: { 'user-agent': UA } }); text = await res.text(); } catch (e) { fail(out, stem, 'blocked', `network error: ${e.message}`, 4); }
  if (!res.ok) fail(out, stem, 'failed', `HTTP ${res.status} from ${url}`, 5);
  let json; try { json = JSON.parse(text); } catch { fail(out, stem, 'failed', 'pricing feed is not JSON', 5); }
  // previous snapshot first (never this run's own directory), then write the current one
  const prev = latestFeed(project ?? process.env.TIMMY_PROJECT_DIR ?? null, out);
  writeJson(join(out, `${stem}.feed.json`), json);
  const rows = feedRows(json);
  const ids = rowId;
  const prevRows = prev ? feedRows(prev.feed) : [];
  const cur = new Map(rows.map((r) => [ids(r), r])); const old = new Map(prevRows.map((r) => [ids(r), r]));
  const added = [...cur.keys()].filter((k) => !old.has(k)); const removed = [...old.keys()].filter((k) => !cur.has(k));
  // a price change is a change in a PRICE: enabled flips and group moves are reported on their own lists, never as price movement
  const priceOnly = (p) => (p ? { input_per_1m: p.input_per_1m ?? null, output_per_1m: p.output_per_1m ?? null, cache_input_per_1m: p.cache_input_per_1m ?? null } : null);
  const kept = [...cur.keys()].filter((k) => old.has(k));
  const price_changes = kept.filter((k) => canon(priceOnly(feedPrice(rows, k))) !== canon(priceOnly(feedPrice(prevRows, k))));
  const enabled_changes = kept.filter((k) => (cur.get(k).enabled ?? null) !== (old.get(k).enabled ?? null));
  const group_changes = kept.filter((k) => (cur.get(k).group_name ?? null) !== (old.get(k).group_name ?? null));
  const meta = feedMeta(json);
  const diff = { kind: 'routemux.feed-diff', at: now(), feed_sha256: sha(text), models: rows.length, models_enabled: rows.filter((r) => r.enabled !== false).length, groups: [...new Set(rows.map((r) => r.group_name).filter(Boolean))].sort(),
    previous: prev ? prev.path.replace(process.env.HOME ?? '', '~') : null, added, removed, price_changes, enabled_changes, group_changes, feed_updated: meta.updated, price_unit: meta.price_unit, currency: meta.currency };
  writeJson(join(out, `${stem}.feed-diff.json`), diff);
  console.log(JSON.stringify({ ok: true, models: rows.length, added: added.length, removed: removed.length, price_changes: price_changes.length, enabled_changes: enabled_changes.length, group_changes: group_changes.length }));
}

// The operator's expectation comes from the dropped *.reconcile.json ({expected_spend_usd, since?}); TIMMY_EXPECTED_SPEND_USD
// is only a fallback for a drop that carries none. A non-numeric or negative value is recorded as invalid, not coerced.
function expectation(drop) {
  let req = null;
  if (drop && existsSync(drop)) { try { req = readJson(drop); } catch (e) { return { expected_spend_usd: null, since: null, source: 'drop', error: `drop is not JSON: ${e.message}` }; } }
  const fromDrop = req?.expected_spend_usd;
  if (fromDrop != null) {
    const n = Number(fromDrop);
    return Number.isFinite(n) && n >= 0 ? { expected_spend_usd: n, since: req.since ?? null, source: 'drop' } : { expected_spend_usd: null, since: req.since ?? null, source: 'drop', error: `expected_spend_usd ${JSON.stringify(fromDrop)} is not a non-negative number` };
  }
  const env = process.env.TIMMY_EXPECTED_SPEND_USD;
  if (env != null && env !== '') { const n = Number(env); return Number.isFinite(n) && n >= 0 ? { expected_spend_usd: n, since: req?.since ?? null, source: 'env' } : { expected_spend_usd: null, since: null, source: 'env', error: `TIMMY_EXPECTED_SPEND_USD ${JSON.stringify(env)} is not a non-negative number` }; }
  return { expected_spend_usd: null, since: req?.since ?? null, source: null };
}

async function balance([out, stem, drop]) {
  if (!KEY) fail(out, stem, 'not_configured', 'ROUTEMUX_API_KEY is not set in the environment');
  const get = async (path) => { try { const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${KEY}`, 'user-agent': UA } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* text */ } return { status: r.status, body: j ?? t.slice(0, 2000), request_id: r.headers.get('x-request-id') }; } catch (e) { return { status: 0, error: e.message }; } };
  const result = { kind: 'routemux.balance', at: now(), expectation: expectation(drop), balance: await get('/v1/user/balance'), key: await get('/v1/key/info'), account: await get('/v1/account/info') };
  writeJson(join(out, `${stem}.balance.json`), result);
  if (result.balance.status === 401 || result.balance.status === 403) fail(out, stem, 'blocked', `balance endpoint HTTP ${result.balance.status}`, 5);
  console.log(JSON.stringify({ ok: result.balance.status === 200, balance_status: result.balance.status }));
}

const num = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((a, kk) => (a == null ? a : a[kk]), o); if (v != null && !isNaN(Number(v))) return Number(v); } return null; };
const pct = (p, a) => (p == null || a == null || a === 0 ? null : Math.round(Math.abs(p - a) / a * 1000) / 10);

function report([workflow, out, stem]) {
  const rd = (n) => (existsSync(join(out, n)) ? readJson(join(out, n)) : null);
  let rep;
  if (workflow === 'chat-receipted') {
    const pred = rd(`${stem}.predict.json`), hd = rd(`${stem}.headers.json`), resp = rd(`${stem}.response.json`);
    const usage = resp?.usage ?? {};
    const tokens_in = num(usage, ['prompt_tokens', 'input_tokens']); const tokens_out = num(usage, ['completion_tokens', 'output_tokens']);
    const price = pred?.price_source?.price ?? null;
    const cost_usd = num(usage, ['cost', 'cost_usd', 'total_cost']) ?? (price && tokens_in != null ? ((tokens_in * (price.input_per_1m ?? 0)) + ((tokens_out ?? 0) * (price.output_per_1m ?? 0))) / 1e6 : null);
    rep = {
      ok: !!hd && (hd.status === 200 || hd.replayed), status: hd ? (hd.replayed ? 'replayed' : hd.status === 200 ? 'ok' : 'failed') : 'failed',
      model: resp?.model ?? pred?.model ?? null, request_id: hd?.request_id ?? null, billed: hd?.billed ?? null, idempotency_key: pred?.idempotency_key ?? null,
      tokens_in, tokens_out, cost_usd, latency_ms: hd?.latency_ms ?? null,
      cost_predicted_usd: pred?.predicted?.cost_usd ?? null, tokens_in_predicted: pred?.predicted?.tokens_in ?? null, tokens_out_predicted: pred?.predicted?.tokens_out ?? null,
      analysis: { tokens_in_error_pct: pct(pred?.predicted?.tokens_in, tokens_in), tokens_out_error_pct: pct(pred?.predicted?.tokens_out, tokens_out), cost_error_pct: pct(pred?.predicted?.cost_usd, cost_usd), latency_error_pct: pct(pred?.predicted?.latency_ms, hd?.latency_ms ?? null), outcome_as_predicted: (pred?.predicted?.outcome ?? 'ok') === (hd?.status === 200 ? 'ok' : 'failed') },
      finish_reason: resp?.choices?.[0]?.finish_reason ?? resp?.stop_reason ?? null, response_sha256: resp ? sha(canon(resp)) : null, at: now(),
    };
  } else if (workflow === 'model-feed-snapshot') {
    const d = rd(`${stem}.feed-diff.json`);
    rep = { ok: !!d, status: d ? 'ok' : 'failed', models: d?.models ?? null, models_enabled: d?.models_enabled ?? null, groups: d?.groups?.length ?? null, feed_sha256: d?.feed_sha256 ?? null, feed_updated: d?.feed_updated ?? null, price_unit: d?.price_unit ?? null, added: d?.added?.length ?? null, removed: d?.removed?.length ?? null, price_changes: d?.price_changes?.length ?? null, enabled_changes: d?.enabled_changes?.length ?? null, group_changes: d?.group_changes?.length ?? null, added_ids: d?.added ?? [], removed_ids: d?.removed ?? [], price_changed_ids: d?.price_changes ?? [], enabled_changed_ids: d?.enabled_changes ?? [], group_changed_ids: d?.group_changes ?? [], at: now() };
  } else if (workflow === 'balance-reconcile') {
    const b = rd(`${stem}.balance.json`);
    const balance_usd = num(b?.balance?.body ?? {}, ['balance', 'balance_usd', 'data.balance', 'credits', 'remaining']);
    const spent_usd = num(b?.key?.body ?? {}, ['spent', 'spent_usd', 'usage', 'data.spent', 'total_spend']);
    const exp = b?.expectation ?? expectation(null);           // the drop's expectation was captured by the read step
    const expected = exp.expected_spend_usd ?? null;
    rep = { ok: b?.balance?.status === 200, status: b?.balance?.status === 200 ? 'ok' : 'failed', balance_usd, spend_observed_usd: spent_usd, spend_predicted_usd: expected, spend_predicted_source: exp.source ?? null, since: exp.since ?? null,
      reconciled: expected != null && spent_usd != null ? Math.abs(expected - spent_usd) <= Math.max(0.01, 0.05 * expected) : null, request_id: b?.balance?.request_id ?? null, ...(exp.error ? { expectation_error: exp.error } : {}), at: now() };
  } else { console.log(JSON.stringify({ ok: false, error: `unknown workflow ${workflow}` })); process.exit(2); }
  writeJson(join(out, `${stem}.routemux.json`), rep);
  console.log(JSON.stringify(rep));
  if (!rep.ok) process.exit(5);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { predict, chat, feed, balance, report };
if (!cmds[cmd]) { console.log(JSON.stringify({ ok: false, error: 'usage: bridge.mjs predict|chat|feed|balance|report ...' })); process.exit(2); }
await cmds[cmd](rest);
