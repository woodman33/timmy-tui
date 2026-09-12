#!/usr/bin/env node
// Engine shelf lane (engine-shelf/v0, shelf-w6d3 step 4).
//
//   timmy engine inventory [--no-fleet]              measure engines.json, write inventory.json, fleet entries, env-locks
//   timmy engine envlock <engine>                    pin the engine's binaries (sha256, size, mtime, version)
//   timmy engine run <engine> <workflow> --project <name> [--input <file>] [--no-seal]
//   timmy engine drop <engine> --project <name> [--workflow <w>] [--no-seal]     process <project>/drop/ by the templates' rules
//   timmy engine shelf [--no-seal]                   the shelf table + engine.shelf receipt
//   timmy engine list
//
// A workflow template is lanes/engines/<engine>/templates/<workflow>/{plan.cue, blueprint.json, <workflow>.rules.cue [, script.*]}
// vetted by lanes/engines/schemas/engine-workflow.cue. `run` goes THROUGH the
// project's drop folder: the input is copied into drop/, matched by the rules,
// executed, and its outputs land in out/<engine>/<workflow>/<stem>-<ts>/. One
// engine.run receipt per run; engine.refuse when a rule refuses a drop.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECTS_ROOT } from '../../fleet/harness-menu.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = join(ROOT, 'lanes', 'engines');
const SCHEMA = join(HERE, 'schemas', 'engine-workflow.cue');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-seal', '--no-fleet', '--once'].includes(args[i - 1])));
const cmd = positional[0] ?? 'list';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const shaText = (s) => createHash('sha256').update(s).digest('hex');
const ENGINES = JSON.parse(readFileSync(join(HERE, 'engines.json'), 'utf8'));
const engineById = (id) => ENGINES.engines.find((e) => e.id === id);

// ------------------------------------------------------------------ binaries + env-lock

function expandPath(p) {
  if (!p) return null;
  const abs = p.startsWith('/') ? p : join(ROOT, p);
  if (!abs.includes('*')) return existsSync(abs) ? abs : null;
  // one glob segment: pick the newest matching directory entry
  const parts = abs.split('/');
  const i = parts.findIndex((s) => s.includes('*'));
  const base = parts.slice(0, i).join('/');
  if (!existsSync(base)) return null;
  const re = new RegExp('^' + parts[i].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const hits = readdirSync(base).filter((n) => re.test(n)).sort().reverse();
  for (const h of hits) {
    const rest = [base, h, ...parts.slice(i + 1)].join('/');
    const r = expandPath(rest);
    if (r) return r;
  }
  return null;
}

function resolveBin(engine, name) {
  if (name.startsWith('/')) return existsSync(name) ? name : null;
  return expandPath(engine.binaries?.[name]);
}

function versionOf(path) {
  for (const a of [['--version'], ['-v'], ['-version'], ['--help']]) {
    const r = spawnSync(path, a, { encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: process.env.HOME } });
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const m = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[+-][\w.]+)?)\b/);
    if (m) return m[1];
  }
  return null;
}

export function engineEnvLock(engine) {
  const tools = {};
  for (const name of engine.envlock_bins ?? []) {
    const p = resolveBin(engine, name);
    if (!p) { tools[name] = null; continue; }
    const st = statSync(p);
    tools[name] = { path: p, sha256: sha(p), size: st.size, mtime: st.mtimeMs, version: name === 'java' || name === 'bob' ? null : versionOf(p) };
  }
  let build = ''; let version;
  try { build = execFileSync('sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim(); version = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(); } catch { /* not macOS */ }
  const lock = { v: 1, engine: engine.id, captured_at: new Date().toISOString(), os: { platform: process.platform, build, version }, arch: process.arch, tools, installed: Object.values(tools).every(Boolean) && Object.keys(tools).length > 0 };
  const text = JSON.stringify(lock, null, 1);
  mkdirSync(join(HERE, engine.id), { recursive: true });
  writeFileSync(join(HERE, engine.id, 'env-lock.json'), text);
  return { lock, sha256: shaText(text), path: join(HERE, engine.id, 'env-lock.json') };
}

// ------------------------------------------------------------------ templates

function cueExport(expr, ...files) {
  const r = spawnSync('cue', ['export', '-e', expr, SCHEMA, ...files], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cue export ${expr} ${files.map((f) => f.replace(ROOT + '/', '')).join(' ')}: ${(r.stderr ?? '').trim()}`);
  return JSON.parse(r.stdout);
}

function templateDir(engineId, workflow) { return join(HERE, engineId, 'templates', workflow); }

export function listTemplates(engineId) {
  const d = join(HERE, engineId, 'templates');
  return existsSync(d) ? readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory() && existsSync(join(d, n, 'plan.cue'))).sort() : [];
}

export function loadTemplate(engineId, workflow) {
  const dir = templateDir(engineId, workflow);
  const plan = join(dir, 'plan.cue');
  const rulesFile = join(dir, `${workflow}.rules.cue`);
  const blueprint = join(dir, 'blueprint.json');
  const missing = [plan, rulesFile, blueprint].filter((f) => !existsSync(f)).map((f) => basename(f));
  if (missing.length) throw new Error(`template ${engineId}/${workflow} is missing ${missing.join(', ')}`);
  const wf = cueExport('workflow', plan);
  const drop = cueExport('drop', rulesFile);
  const files = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).sort();
  const shas = Object.fromEntries(files.map((f) => [f, sha(join(dir, f))]));
  return { dir, workflow: wf, drop, files, shas, template_sha256: shaText(files.map((f) => `${f} ${shas[f]}`).join('\n')) };
}

// glob → regex: * ? {a,b} and ** (on a bare file name)
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function matchRule(drop, fileName, bytes) {
  for (const r of drop.rules) {
    if (!globToRegex(r.match).test(fileName)) continue;
    if (r.max_bytes && bytes > r.max_bytes) continue; // the size-limited rule passes, the next (refuse) catches it
    return r;
  }
  return null;
}

// ------------------------------------------------------------------ run

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  const lines = readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).hash;
}

const proofsPath = join(HERE, 'proofs.json');
const loadProofs = () => (existsSync(proofsPath) ? JSON.parse(readFileSync(proofsPath, 'utf8')) : { v: 1, proofs: {} });

export async function runWorkflow(engineId, workflow, { project, input, noSeal = false, viaDrop = true, rule = null }) {
  const engine = engineById(engineId);
  if (!engine) throw new Error(`unknown engine ${engineId}`);
  const lock = engineEnvLock(engine);
  if (!lock.lock.installed) { const err = new Error(`${engineId} is not installed on this machine (${Object.keys(lock.lock.tools).filter((k) => !lock.lock.tools[k]).join(', ')} missing); template stays unproven`); err.code = 4; throw err; }
  const tpl = loadTemplate(engineId, workflow);
  const projDir = join(PROJECTS_ROOT, project);
  if (!existsSync(projDir)) throw new Error(`no project at ${projDir} (timmy project new ${project})`);
  const dropDir = join(projDir, 'drop');
  mkdirSync(dropDir, { recursive: true });
  // the input goes through drop/
  let dropped = input ? join(dropDir, basename(input)) : null;
  if (input && resolve(input) !== resolve(dropped)) copyFileSync(input, dropped);
  if (!dropped) {
    const first = tpl.workflow.inputs[0];
    const cands = readdirSync(dropDir).filter((n) => !n.startsWith('.') && statSync(join(dropDir, n)).isFile() && (!first || globToRegex(first.glob).test(n))).sort((a, b) => statSync(join(dropDir, b)).mtimeMs - statSync(join(dropDir, a)).mtimeMs);
    if (!cands.length) throw new Error(`nothing in ${dropDir} matches ${first?.glob ?? '*'}`);
    dropped = join(dropDir, cands[0]);
  }
  const stem = basename(dropped, extname(dropped)).replace(/[^A-Za-z0-9._-]+/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const outDir = join(projDir, 'out', engineId, workflow, `${stem}-${ts}`);
  mkdirSync(outDir, { recursive: true });
  const inputSha = sha(dropped);
  const started = Date.now();
  const stepResults = [];
  let ok = true;
  const subst = (s) => String(s).replace(/\{drop\}/g, dropped).replace(/\{out\}/g, outDir).replace(/\{project\}/g, projDir).replace(/\{template\}/g, tpl.dir).replace(/\{stem\}/g, stem);
  for (const step of tpl.workflow.steps) {
    const bin = resolveBin(engine, step.command.bin);
    if (!bin) { stepResults.push({ id: step.id, ok: false, error: `binary ${step.command.bin} not found` }); ok = false; break; }
    const argv = step.command.args.map(subst);
    const cwd = step.command.cwd ? subst(step.command.cwd) : outDir;
    const t0 = Date.now();
    const r = spawnSync(bin, argv, { cwd, encoding: 'utf8', timeout: step.command.timeout_ms ?? 600000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...(step.command.env ?? {}) } });
    writeFileSync(join(outDir, `${step.id}.log`), `$ ${bin} ${argv.join(' ')}\n--- stdout\n${r.stdout ?? ''}\n--- stderr\n${r.stderr ?? ''}\n--- exit ${r.status} signal ${r.signal ?? ''}\n`);
    const produced = (step.produces ?? []).map((g) => { const re = globToRegex(subst(g)); const hits = readdirSync(outDir).filter((n) => re.test(n)); return { glob: subst(g), found: hits }; });
    const missing = produced.filter((p) => !p.found.length).map((p) => p.glob);
    const stepOk = r.status === 0 && !r.error && missing.length === 0;
    stepResults.push({ id: step.id, ok: stepOk, exit: r.status, signal: r.signal ?? null, timed_out: r.error?.code === 'ETIMEDOUT', ms: Date.now() - t0, missing, log: `${step.id}.log` });
    if (!stepOk) { ok = false; break; }
  }
  const outputs = [];
  for (const o of tpl.workflow.outputs) { const re = globToRegex(subst(o.glob)); for (const n of readdirSync(outDir).filter((x) => re.test(x))) outputs.push({ id: o.id, kind: o.kind, file: n, sha256: sha(join(outDir, n)), bytes: statSync(join(outDir, n)).size }); }
  // extra fields from a JSON report the template wrote, if the plan names any
  const extra = {};
  const extraKeys = tpl.workflow.receipt?.extra ?? [];
  if (extraKeys.length) {
    for (const n of readdirSync(outDir).filter((x) => x.endsWith('.json'))) {
      try { const j = JSON.parse(readFileSync(join(outDir, n), 'utf8')); for (const k of extraKeys) if (j[k] != null && extra[k] == null) extra[k] = typeof j[k] === 'object' ? JSON.stringify(j[k]) : String(j[k]); } catch { /* not a report */ }
    }
  }
  const record = { v: 1, engine: engineId, workflow, project, input: dropped, input_sha256: inputSha, via_drop: viaDrop, rule: rule?.id ?? null, out_dir: outDir, steps: stepResults, outputs, ok, ms: Date.now() - started, template_sha256: tpl.template_sha256, template_files: tpl.shas, envlock_sha256: lock.sha256, envlock: lock.lock.tools, bridge: tpl.workflow.bridge, extra, ts: new Date().toISOString() };
  writeFileSync(join(outDir, 'engine.run.json'), JSON.stringify(record, null, 1));
  // the dropped file moves out of drop/ so it is not processed twice
  try { mkdirSync(join(outDir, 'input'), { recursive: true }); renameSync(dropped, join(outDir, 'input', basename(dropped))); record.input = join(outDir, 'input', basename(dropped)); } catch { /* keep in drop */ }
  let receipt = null;
  if (!noSeal) {
    receipt = seal('engine.run', {
      engine: engineId, workflow, project, ok: ok ? 'true' : 'false', bridge: tpl.workflow.bridge, engine_version: engine.version ?? 'unknown',
      input: basename(dropped), input_sha256: inputSha, via_drop: viaDrop ? 'true' : 'false', rule: rule?.id ?? 'explicit',
      outputs: outputs.map((o) => `${o.file}:${o.sha256.slice(0, 16)}`).join(','), outputs_count: outputs.length, out_dir: outDir.replace(process.env.HOME ?? '', '~'),
      template_sha256: tpl.template_sha256, plan_sha256: tpl.shas['plan.cue'], rules_sha256: tpl.shas[`${workflow}.rules.cue`], blueprint_sha256: tpl.shas['blueprint.json'],
      envlock_sha256: lock.sha256, envlock_tools: Object.entries(lock.lock.tools).map(([k, v]) => `${k}:${v ? v.sha256.slice(0, 12) : 'missing'}`).join(','),
      steps: stepResults.map((s) => `${s.id}:${s.ok ? 'ok' : 'fail'}:${s.ms ?? 0}ms`).join(','), ms: record.ms, ...extra, order: 'shelf-w6d3'
    });
    record.receipt = receipt;
    writeFileSync(join(outDir, 'engine.run.json'), JSON.stringify(record, null, 1));
    if (ok) { const p = loadProofs(); p.proofs[`${engineId}/${workflow}`] = { receipt, ts: record.ts, out_dir: record.out_dir, input_sha256: inputSha, template_sha256: tpl.template_sha256 }; writeFileSync(proofsPath, JSON.stringify(p, null, 1)); }
  }
  return record;
}

// ------------------------------------------------------------------ drop

export async function processDrop(engineId, { project, workflow, noSeal = false }) {
  const engine = engineById(engineId);
  if (!engine) throw new Error(`unknown engine ${engineId}`);
  const projDir = join(PROJECTS_ROOT, project);
  const dropDir = join(projDir, 'drop');
  if (!existsSync(dropDir)) throw new Error(`no drop folder at ${dropDir}`);
  const workflows = workflow ? [workflow] : listTemplates(engineId);
  const templates = workflows.map((w) => ({ w, t: loadTemplate(engineId, w) }));
  const files = readdirSync(dropDir).filter((n) => !n.startsWith('.') && statSync(join(dropDir, n)).isFile()).sort();
  const report = { engine: engineId, project, files: files.length, ran: [], staged: [], refused: [], unmatched: [] };
  for (const f of files) {
    const p = join(dropDir, f);
    const bytes = statSync(p).size;
    let hit = null;
    for (const { w, t } of templates) { const r = matchRule(t.drop, f, bytes); if (r) { hit = { w, t, r }; break; } }
    if (!hit) { report.unmatched.push(f); continue; }
    if (hit.r.action === 'refuse') {
      const receipt = noSeal ? null : seal('engine.refuse', { engine: engineId, workflow: hit.w, project, file: f, file_sha256: sha(p), bytes, rule: hit.r.id, reason: hit.r.note ?? 'refused by rule', order: 'shelf-w6d3' });
      mkdirSync(join(projDir, 'out', 'refused'), { recursive: true });
      renameSync(p, join(projDir, 'out', 'refused', f));
      report.refused.push({ file: f, rule: hit.r.id, receipt });
      continue;
    }
    if (hit.r.action === 'stage') {
      mkdirSync(join(projDir, 'out', 'staged'), { recursive: true });
      renameSync(p, join(projDir, 'out', 'staged', f));
      report.staged.push({ file: f, rule: hit.r.id });
      continue;
    }
    const rec = await runWorkflow(engineId, hit.w, { project, input: p, noSeal, viaDrop: true, rule: hit.r });
    report.ran.push({ file: f, workflow: hit.w, rule: hit.r.id, ok: rec.ok, receipt: rec.receipt ?? null, outputs: rec.outputs.length, out_dir: rec.out_dir });
  }
  return report;
}

// ------------------------------------------------------------------ inventory + shelf

function updateFleet(inventory) {
  const fleetPath = join(ROOT, 'fleet', 'fleet.json');
  const fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
  let changed = 0;
  for (const e of inventory.engines) {
    const idx = fleet.findIndex((f) => f.id === e.fleet_id);
    const primary = e.primary_binary ?? null;
    const entry = {
      id: e.fleet_id,
      rank: idx >= 0 ? fleet[idx].rank : fleet.length + 1,
      forms: e.bridge,
      detect: primary ? { cmd: primary } : (fleet[idx]?.detect ?? { cmd: e.id }),
      lane: `lanes/engines/lane.mjs (engine-shelf/v0): timmy engine run ${e.id} <${e.templates.join('|')}> --project <p>; env-lock lanes/engines/${e.id}/env-lock.json`,
      shelf: { engine: e.id, installed: e.installed, version: e.version, templates: e.templates, proven: e.proven },
      note: fleet[idx]?.note ?? `${e.label} · ${e.installed ? 'installed' : 'not installed on this Mac'} · bridge ${e.bridge.join('/')}`
    };
    if (idx >= 0) { fleet[idx] = { ...fleet[idx], ...entry, rank: fleet[idx].rank, note: fleet[idx].note }; } else fleet.push(entry);
    changed++;
  }
  writeFileSync(fleetPath, JSON.stringify(fleet, null, 2) + '\n');
  return changed;
}

export function inventory({ fleet = true } = {}) {
  const proofs = loadProofs().proofs;
  const engines = ENGINES.engines.map((e) => {
    const lock = engineEnvLock(e);
    const bins = Object.fromEntries(Object.keys(e.binaries ?? {}).map((k) => [k, resolveBin(e, k)]));
    const primary = Object.values(bins).find(Boolean) ?? null;
    const templates = listTemplates(e.id);
    const complete = templates.filter((w) => { try { loadTemplate(e.id, w); return true; } catch { return false; } });
    const proven = templates.filter((w) => proofs[`${e.id}/${w}`]);
    return { id: e.id, label: e.label, fleet_id: e.fleet_id, installed: lock.lock.installed, version: e.version, bridge: e.bridge, binaries: bins, primary_binary: primary, envlock_sha256: lock.sha256, envlock: lock.path.replace(ROOT + '/', ''), mcp: e.mcp?.name ?? null, templates, templates_complete: complete.length, proven, unproven: templates.filter((w) => !proofs[`${e.id}/${w}`]) };
  });
  const inv = { v: 1, standard: ENGINES.standard, measured_at: new Date().toISOString(), engines };
  writeFileSync(join(HERE, 'inventory.json'), JSON.stringify(inv, null, 1));
  if (fleet) inv.fleet_entries = updateFleet(inv);
  return inv;
}

const out = (o) => console.log(JSON.stringify(o, null, 1));

try {
  switch (cmd) {
    case 'list': out(ENGINES.engines.map((e) => ({ id: e.id, installed: e.installed, templates: listTemplates(e.id) }))); break;
    case 'inventory': { const inv = inventory({ fleet: !has('--no-fleet') }); out(inv.engines.map((e) => ({ id: e.id, installed: e.installed, version: e.version, primary: e.primary_binary, envlock: e.envlock_sha256.slice(0, 12), templates: e.templates.length, complete: e.templates_complete, proven: e.proven.length }))); break; }
    case 'envlock': { const e = engineById(positional[1]); if (!e) throw new Error('engine?'); out(engineEnvLock(e)); break; }
    case 'run': { const rec = await runWorkflow(positional[1], positional[2], { project: flag('--project'), input: flag('--input'), noSeal: has('--no-seal'), viaDrop: true }); out({ ok: rec.ok, receipt: rec.receipt ?? null, out_dir: rec.out_dir, outputs: rec.outputs, steps: rec.steps, extra: rec.extra }); process.exit(rec.ok ? 0 : 1); }
    case 'drop': { const rep = await processDrop(positional[1], { project: flag('--project'), workflow: flag('--workflow'), noSeal: has('--no-seal') }); out(rep); process.exit(rep.ran.every((r) => r.ok) ? 0 : 1); }
    case 'shelf': {
      const inv = inventory({ fleet: !has('--no-fleet') });
      const proofs = loadProofs();
      const rows = inv.engines.map((e) => ({ engine: e.id, installed: e.installed, version: e.version, bridge: e.bridge.join('/'), templates: e.templates.length, proven: e.proven.length, unproven: e.unproven, envlock: e.envlock_sha256.slice(0, 12), proofs: e.proven.map((w) => `${w}:${proofs.proofs[`${e.id}/${w}`].receipt.slice(7, 19)}`).join(' ') }));
      out(rows);
      const invText = readFileSync(join(HERE, 'inventory.json'), 'utf8');
      if (!has('--no-seal')) {
        const receipt = seal('engine.shelf', {
          standard: ENGINES.standard, engines: inv.engines.length, installed: inv.engines.filter((e) => e.installed).map((e) => `${e.id}@${e.version}`).join(','), not_installed: inv.engines.filter((e) => !e.installed).map((e) => e.id).join(','),
          templates: inv.engines.reduce((a, e) => a + e.templates.length, 0), templates_complete: inv.engines.reduce((a, e) => a + e.templates_complete, 0), proven: inv.engines.reduce((a, e) => a + e.proven.length, 0), unproven: inv.engines.reduce((a, e) => a + e.unproven.length, 0),
          proven_receipts: Object.entries(proofs.proofs).map(([k, v]) => `${k}=${v.receipt.slice(7, 19)}`).join(','), unproven_templates: inv.engines.flatMap((e) => e.unproven.map((w) => `${e.id}/${w}`)).join(','),
          inventory_sha256: shaText(invText), envlocks: inv.engines.map((e) => `${e.id}:${e.envlock_sha256.slice(0, 12)}`).join(','), fleet_entries: inv.fleet_entries ?? 0, schema: 'lanes/engines/schemas/engine-workflow.cue', order: 'shelf-w6d3'
        });
        console.log(JSON.stringify({ receipt }));
      }
      break;
    }
    default: console.error('usage: timmy engine inventory|envlock <engine>|run <engine> <workflow> --project <p> [--input f]|drop <engine> --project <p>|shelf|list'); process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(e.code ?? 1);
}
