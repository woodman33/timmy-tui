#!/usr/bin/env node
// timmy schema — tool-schema compliance (ORDER captain-y9g4).
//
//   timmy schema check   [--no-seal]     validate Timmy's MCP tool schemas against the STRICTEST validator
//        (arrays carry items, no reserved-name collisions, no keyword a strict model rejects) → schema.compliance
//   timmy schema models  [--no-seal]     empirically classify each model strict|lenient by whether its
//        provider's validator rejects a deliberately-strict-failing tool schema → schema.models (feeds abilities v2)
//   timmy schema gate --model <id> [--harness jcode]   refuse (exit 3) when the harness's schema fails that
//        model's validator; print the reason. Used by every harness lane before it picks a model.
//
// The strict validator models the rules a frontier "strict" provider (Gemini
// class) enforces on function-tool parameters: every array declares `items`;
// no oneOf/allOf/not/patternProperties/$ref; anyOf branches recurse. A tool
// that passes this passes every provider we measured.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'check';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const out = (o) => console.log(JSON.stringify(o, null, has('--compact') ? 0 : 1));
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = join(ROOT, 'src', 'cli.ts');

// the models measured for the tool_schema column of harness.abilities v2
export const MODELS = [
  { id: 'google/gemini-3.8-flash', vendor: 'google' },
  { id: 'x-ai/grok-4.6', vendor: 'xai' },
  { id: 'anthropic/claude-opus-4.8', vendor: 'anthropic' },
  { id: 'openai/gpt-5.6-luna-pro', vendor: 'openai' },
  { id: 'qwen/qwen3.8-flash', vendor: 'qwen' },
  { id: 'moonshotai/kimi-k3', vendor: 'kimi' }
];

/** The strict validator: every issue is something a strict provider rejects. */
export function strictIssues(name, s, path = '') {
  const out = [];
  if (!s || typeof s !== 'object') return out;
  if (s.type === 'array' && !('items' in s)) out.push(`${path || '(root)'}: array without items`);
  if (s.type === 'object' && s.properties) for (const [k, v] of Object.entries(s.properties)) out.push(...strictIssues(name, v, `${path}.${k}`));
  if (s.items) out.push(...strictIssues(name, s.items, `${path}[]`));
  for (const kw of ['oneOf', 'allOf', 'not', 'patternProperties', '$ref', '$defs']) if (kw in s) out.push(`${path}: uses ${kw} (strict providers reject)`);
  if (Array.isArray(s.anyOf)) for (const [i, v] of s.anyOf.entries()) out.push(...strictIssues(name, v, `${path}|anyOf[${i}]`));
  // reserved-name collisions: a property literally named like a schema keyword
  if (s.properties) for (const k of Object.keys(s.properties)) if (['type', 'items', 'properties', 'required', 'enum'].includes(k)) out.push(`${path}.${k}: property name collides with a schema keyword`);
  return out;
}

/** Spawn Timmy's MCP server, initialize, tools/list. */
export async function timmyTools() {
  const child = spawn(TSX, [CLI, 'mcp', 'serve'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  let buf = ''; const pending = new Map(); let id = 0;
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let j; try { j = JSON.parse(line); } catch { continue; } if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } } });
  child.stderr.on('data', () => {});
  const call = (method, params) => new Promise((res, rej) => { const my = ++id; pending.set(my, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n'); setTimeout(() => rej(new Error('timeout ' + method)), 20000); });
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'schema', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const r = await call('tools/list', {});
    return r.result?.tools ?? [];
  } finally { child.kill('SIGTERM'); }
}

function seal(subject, meta) {
  if (has('--no-seal')) return null;
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  return JSON.parse(readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n').pop()).hash;
}

/** One OpenRouter call carrying a probe tool; returns {status, ok, err}. */
async function probeModel(model, toolParams) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { status: 0, ok: false, err: 'OPENROUTER_API_KEY not set' };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://custody.timmy.dev', 'X-Title': 'TIMMY schema probe' },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Call the probe tool with any value.' }], tools: [{ type: 'function', function: { name: 'probe', description: 'a probe', parameters: toolParams } }], tool_choice: 'auto' })
    });
    const j = await r.json();
    return { status: r.status, ok: r.ok, err: r.ok ? null : String(j.error?.message ?? JSON.stringify(j.error ?? j)).slice(0, 160) };
  } catch (e) { return { status: -1, ok: false, err: e instanceof Error ? e.message : String(e) }; }
}

const STRICT_FAIL = { type: 'object', properties: { xs: { type: 'array' } }, required: ['xs'] };       // array without items
const CLEAN = { type: 'object', properties: { xs: { type: 'array', items: { type: 'string' } } }, required: ['xs'] };

async function classifyModels() {
  const rows = [];
  for (const m of MODELS) {
    const strictFail = await probeModel(m.id, STRICT_FAIL);
    const clean = await probeModel(m.id, CLEAN);
    // strict = the provider's validator REJECTED the array-without-items schema; lenient = accepted it
    const schemaRejected = strictFail.status === 400 || /items|schema|function_declarations|parameters/i.test(strictFail.err ?? '');
    const cls = clean.ok ? (schemaRejected ? 'strict' : 'lenient') : 'unknown';
    rows.push({ model: m.id, vendor: m.vendor, tool_schema: cls, strict_fail_status: strictFail.status, clean_ok: clean.ok, evidence: (strictFail.err ?? '').slice(0, 80) });
  }
  return rows;
}

/** The gate a harness lane calls: may this harness use this model? */
export function schemaGate(modelStrictness, harnessIssueCount) {
  if (harnessIssueCount > 0 && modelStrictness === 'strict') return { ok: false, reason: `the harness tool schema has ${harnessIssueCount} strict-schema issue(s) and ${'the model'} runs a strict validator; pick a lenient model or fix the schema` };
  return { ok: true };
}

try {
  if (cmd === 'check') {
    const tools = await timmyTools();
    const issues = tools.map((t) => ({ tool: t.name, issues: strictIssues(t.name, t.inputSchema) })).filter((x) => x.issues.length);
    const ok = issues.length === 0;
    const receipt = seal('schema.compliance', { subject: 'timmy-mcp-server', tools: tools.length, ok, strict_issues: issues.length, issues: issues.map((i) => `${i.tool}:${i.issues.join('|')}`).join(' ; ') || 'none', validator: 'strict (Gemini-class): array items required, no oneOf/allOf/not/patternProperties/$ref, no keyword-name property collisions', schema_sha256: sha(JSON.stringify(tools.map((t) => [t.name, t.inputSchema]))), order: 'captain-y9g4' });
    out({ ok, tools: tools.length, strict_issues: issues, receipt });
    process.exit(ok ? 0 : 1);
  } else if (cmd === 'models') {
    const rows = await classifyModels();
    mkdirSync(join(ROOT, 'lanes', 'schema'), { recursive: true });
    writeFileSync(join(ROOT, 'lanes', 'schema', 'model-strictness.json'), JSON.stringify({ v: 1, measured_at: new Date().toISOString(), rows }, null, 1) + '\n');
    const receipt = seal('schema.models', { measured: rows.length, strict: rows.filter((r) => r.tool_schema === 'strict').map((r) => r.model).join(','), lenient: rows.filter((r) => r.tool_schema === 'lenient').map((r) => r.model).join(','), unknown: rows.filter((r) => r.tool_schema === 'unknown').map((r) => r.model).join(','), method: 'OpenRouter probe: an array-without-items tool schema; strict = provider validator rejected it (400), lenient = accepted; clean-schema control must 200', file: 'lanes/schema/model-strictness.json', order: 'captain-y9g4' });
    out({ ok: true, rows, receipt });
  } else if (cmd === 'gate') {
    const model = flag('--model');
    if (!model) { console.error('usage: timmy schema gate --model <id> [--harness jcode]'); process.exit(2); }
    const map = existsSync(join(ROOT, 'lanes', 'schema', 'model-strictness.json')) ? JSON.parse(readFileSync(join(ROOT, 'lanes', 'schema', 'model-strictness.json'), 'utf8')).rows : [];
    const strictness = map.find((r) => r.model === model)?.tool_schema ?? 'unknown';
    const tools = await timmyTools();
    const issueCount = tools.reduce((n, t) => n + strictIssues(t.name, t.inputSchema).length, 0);
    const g = schemaGate(strictness, issueCount);
    out({ model, tool_schema: strictness, timmy_schema_issues: issueCount, ...g });
    process.exit(g.ok ? 0 : 3);
  } else { console.error('usage: timmy schema <check|models|gate> …'); process.exit(2); }
} catch (e) { console.error(`[schema] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
