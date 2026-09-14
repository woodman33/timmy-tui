#!/usr/bin/env node
// Seal the wire lane's results (shelf-w6d3 step 3): one wire.snoop and one
// bridge.probe per bridge, one api.snip per OpenAPI lane, one tool.eval per
// evaluated tool. Sequential; cites files by sha256, never pastes transcripts.
//   node lanes/wire/seal.mjs [--dry] [--only <bridge>]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LANE = join(ROOT, 'lanes', 'wire');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();
const R = JSON.parse(readFileSync(join(LANE, 'results.json'), 'utf8'));
const sha = (p) => (p && existsSync(join(ROOT, p)) ? createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex') : null);
const s = (v, n = 400) => (v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\n/g, ' ').slice(0, n));

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).slice(0, 1500)}`);
  if (DRY) { console.log(`${subject} ${a.slice(4).join(' ').slice(0, 200)}…`); return null; }
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  const lines = readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).hash;
}

const out = { snoop: [], probe: [], snip: [], eval: [] };
for (const [name, b] of Object.entries(R.bridges ?? {})) {
  if (only && name !== only) continue;
  const sn = b.snoop ?? {};
  out.snoop.push({ name, receipt: seal('wire.snoop', { bridge: name, kind: b.kind, transport: b.transport, command: s(b.command, 200), ok: sn.ok ? 'true' : 'false', note: s(sn.note, 300), session: sn.session_file ?? null, session_sha256: sn.sha256 ?? sha(sn.session_file), frames: sn.frames ?? 0, tools: sn.tools ?? 0, tool_names: s((sn.tool_names ?? []).join(','), 400), server: s(sn.server, 120), protocol: sn.protocol ?? null, connect_ms: sn.connect_ms ?? null, call: s(sn.call ? `${sn.call.tool}:${sn.call.isError ? 'error' : 'ok'}` : null, 80), tool: `mcpsnoop ${R.tools?.versions?.mcpsnoop?.version ?? ''}`, transcript: `lanes/wire/transcripts/${name}.jsonl`, transcript_sha256: sha(`lanes/wire/transcripts/${name}.jsonl`), order: 'shelf-w6d3' }) });
  const pr = b.probe ?? {};
  out.probe.push({ name, receipt: seal('bridge.probe', { bridge: name, transport: b.transport, ok: pr.ok ? 'true' : 'false', note: s(pr.note, 300), validate_report: pr.validate_report ?? null, validate_sha256: pr.validate_sha256 ?? sha(pr.validate_report), test_report_dir: pr.test_report_dir ?? null, passed: pr.passed ?? 0, failed: pr.failed ?? 0, findings: (pr.findings ?? []).length, findings_preview: s((pr.findings ?? []).slice(0, 4).join(' | '), 500), tool: `mcp-probe ${R.tools?.versions?.['mcp-probe']?.version ?? ''}`, transcript: `lanes/wire/transcripts/${name}.jsonl`, order: 'shelf-w6d3' }) });
}
const openapi = Array.isArray(R.openapi) ? R.openapi : Object.entries(R.openapi ?? {}).map(([k, v]) => ({ name: k, ...v }));
for (const o of openapi) {
  if (only) continue;
  out.snip.push({ name: o.name ?? o.spec_url, receipt: seal('api.snip', { lane: o.name ?? null, spec_url: o.spec_url ?? o.url ?? null, ok: (o.apisnip_ok ?? o.ok) ? 'true' : 'false', out: o.out ?? o.out_file ?? null, out_sha256: o.sha256 ?? sha(o.out ?? o.out_file), endpoints_before: o.endpoints_before ?? o.before ?? null, endpoints_after: o.endpoints_after ?? o.after ?? null, note: s(o.note, 400), tool: `apisnip ${R.tools?.versions?.apisnip?.version ?? ''}`, order: 'shelf-w6d3' }) });
}
const evals = Array.isArray(R.evals) ? R.evals : Object.entries(R.evals ?? {}).map(([k, v]) => ({ tool: k, ...v }));
for (const e of evals) {
  if (only) continue;
  out.eval.push({ tool: e.tool, receipt: seal('tool.eval', { tool: e.tool, version: e.version ?? null, verdict: e.verdict ?? null, reason: s(e.reason, 900), transcript: e.transcript ?? e.transcript_file ?? null, transcript_sha256: e.sha256 ?? sha(e.transcript ?? e.transcript_file), evidence: s(e.evidence, 400), order: 'shelf-w6d3' }) });
}
console.log(JSON.stringify(out, null, 1));
