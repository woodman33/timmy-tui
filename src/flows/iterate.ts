/**
 * Round R4 (/iterate, helper H24): the connected workflow's own parts, without the REPL. A local code agent
 * changes the recipe's parameter file, the recipe rebuilds as a durable job, a separate worker reads the
 * delivered STEP back, and the result is kept as a flow record. This module holds what those steps decide:
 * the task the agent is given, the check of what it changed, the parameter diff, the readback's command, how
 * its output is read and compared with the sealed prediction, and the record itself
 * (results/flows/<flow-id>.json). The REPL side (src/repl/iterate.ts) runs the steps as Timmy jobs and seals.
 *
 * DOCTRINE §15: the readback measures the CAD file, never a physical part. Wherever measured dimensions
 * appear, the sentence goes with them (DOCTRINE_15 below, the recipe module's verbatim copy).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangeSet, FileChange } from '../code-agents/index.js';
import { DOCTRINE_15, PARAMETER_HELP, PARAMETER_NAMES, RECIPE_ID } from '../recipes/index.js';
import { packagedPath, packageRoot } from '../utils/asset-dirs.js';

export { DOCTRINE_15 };

/** Where the flow records are kept in the project (results/: an output folder), and each flow's raw files. */
export const FLOWS_DIR = 'results/flows';
export const FLOW_WORK_DIR = '.timmy/flows';
export const FLOW_SCHEMA = 'timmy.flow/1';
/** A flow's id: 'f' and 8 hex digits (a job is 'j' and 6, an agent run 'a' and 8). */
export const FLOW_ID = /^f[0-9a-f]{8}$/;
export const newFlowId = (): string => `f${randomBytes(4).toString('hex')}`;
export const flowRecordPath = (id: string): string => `${FLOWS_DIR}/${id}.json`;
export const flowWorkDir = (id: string): string => `${FLOW_WORK_DIR}/${id}`;
/** The STEP the recipe delivers, by name (src/recipes EXPORTS). */
export const STEP_EXPORT = 'console-tray.step';
/** What the readback measures, said once: on the record, on the board, in the notices. */
export const READBACK_SCOPE = 'The readback measures the delivered CAD file (STEP), in its own process; it is not a measurement of a physical part.';

/**
 * workers/readback/step_readback.py at the package root (as src/vision/look.ts finds look.py): from a
 * checkout, the TypeScript build or the bundled CLI; when missing, the place it belongs, so a run fails on the
 * missing file rather than running one from elsewhere.
 */
function packaged(rel: string): string {
  return packagedPath(rel, import.meta.url, { kind: 'file' }) ?? path.join(packageRoot(import.meta.url) ?? fileURLToPath(new URL('.', import.meta.url)), rel);
}
export const READBACK_SCRIPT = packaged('workers/readback/step_readback.py');
/** Its time limit as a job, and the most it may print (a STEP of this recipe reads in seconds). */
export const READBACK_TIMEOUT_MS = 120_000;
export const READBACK_MAX_OUTPUT = 256 * 1024;

/**
 * The readback's tolerance: the recipe's own gate, not loosened (lanes/recipes/tray.ts gate(); build.py
 * BOUND_TOLERANCE and VOLUME_RELATIVE_TOLERANCE): each bounding-box size within 1e-6 mm of the prediction, the
 * volume within 1e-8 of it, relative. The recipe's own "STEP reimport" checks already hold the exported STEP to
 * these values before it is delivered (30 of 30 on the operator's Mac, ledger row 136), and the readback reads
 * that same file with the same OpenCascade, so a looser tolerance would only hide a difference.
 */
export const READBACK_TOLERANCE = { bounds_mm: 1e-6, volume_relative: 1e-8 } as const;

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// ── the agent's task ─────────────────────────────────────────────────────────────

/**
 * What the local code agent is asked: the operator's instruction first (so the agent's job label shows it), then
 * fixed rules. The rules name the one file it may change, keep its schema and recipe fields, allow only the
 * parameters the instruction names, and list the recipe's ranges in millimetres (PARAMETER_HELP, the ranges
 * tray.ts validate() admits). The file's text now is given whole, so the agent edits what is there.
 */
export function iterateTask(o: { instruction: string; paramsRel: string; fileText: string }): string {
  const ranges = PARAMETER_NAMES.map((n) => `  ${n}: ${PARAMETER_HELP[n]}`).join('\n');
  return [
    o.instruction.trim(),
    '',
    `Do this by changing the file ${o.paramsRel} in this project, and nothing else. It holds the parameters of the CadQuery recipe ${RECIPE_ID} (a tray); Timmy rebuilds the recipe from it after you finish.`,
    '',
    'Rules:',
    `- Edit only ${o.paramsRel}. Do not create, change or delete any other file, and run no commands.`,
    `- Keep its JSON shape: "schema" stays "timmy.recipe-params/1", "recipe" stays "${RECIPE_ID}", and "parameters" holds numbers only. Add no other field.`,
    '- Change only the parameters the instruction names; keep every other value as it is.',
    '- Values are millimetres, within the recipe\'s ranges:',
    ranges,
    '- If the instruction cannot be met within these ranges, change nothing and say why.',
    '',
    `${o.paramsRel} now holds:`,
    o.fileText.trimEnd(),
  ].join('\n');
}

// ── what the agent changed ───────────────────────────────────────────────────────

export interface OtherChange { path: string; how: 'added' | 'changed' | 'deleted'; sha256_before?: string | null; sha256_after?: string | null }

export type AgentChanges =
  | { ok: true; params: 'changed' | 'unchanged'; change?: FileChange }
  | { ok: false; reason: 'others' | 'deleted' | 'incomplete' | 'missing'; why: string; others: OtherChange[] };

/**
 * The agent's own before/after snapshot (its result's `files`), judged for /iterate: only the parameter file may
 * have changed. Anything else changed, added or deleted stops the flow before the build (nothing is reverted);
 * a deleted parameter file, or a comparison that did not cover the project, stops it too.
 */
export function judgeAgentChanges(files: (ChangeSet & { truncated?: boolean }) | undefined, paramsRel: string): AgentChanges {
  if (!files) return { ok: false, reason: 'missing', why: 'the agent run left no record of what it changed, so whether it changed only the parameter file is not known', others: [] };
  const others: OtherChange[] = [
    ...files.added.filter((c) => c.path !== paramsRel).map((c) => ({ path: c.path, how: 'added' as const, sha256_after: c.sha256 })),
    ...files.changed.filter((c) => c.path !== paramsRel).map((c) => ({ path: c.path, how: 'changed' as const, sha256_before: c.previous_sha256 ?? null, sha256_after: c.sha256 })),
    ...files.deleted.filter((c) => c.path !== paramsRel).map((c) => ({ path: c.path, how: 'deleted' as const, sha256_before: c.previous_sha256 ?? null })),
  ];
  if (others.length) {
    const named = others.slice(0, 12).map((o) => `${o.path} (${o.how})`).join(', ');
    return { ok: false, reason: 'others', why: `the agent changed files other than ${paramsRel}: ${named}${others.length > 12 ? ` and ${others.length - 12} more` : ''}`, others };
  }
  if (files.deleted.some((c) => c.path === paramsRel)) return { ok: false, reason: 'deleted', why: `the agent deleted ${paramsRel}`, others: [] };
  if (files.truncated) return { ok: false, reason: 'incomplete', why: 'the project has more files than the agent run compared, so whether it changed only the parameter file is not known', others: [] };
  const change = files.changed.find((c) => c.path === paramsRel) ?? files.added.find((c) => c.path === paramsRel);
  return change ? { ok: true, params: 'changed', change } : { ok: true, params: 'unchanged' };
}

// ── the parameters ───────────────────────────────────────────────────────────────

export interface ParamChange { name: string; before: number | null; after: number | null; changed: boolean }

/** Every parameter, before and after, in the recipe's order; `changed` where the value differs. */
export function paramDiff(before: Record<string, number>, after: Record<string, number>): ParamChange[] {
  const names = [...PARAMETER_NAMES, ...Object.keys({ ...before, ...after }).filter((k) => !(PARAMETER_NAMES as readonly string[]).includes(k)).sort()];
  return names.map((name) => {
    const b = typeof before[name] === 'number' ? before[name] : null;
    const a = typeof after[name] === 'number' ? after[name] : null;
    return { name, before: b, after: a, changed: b !== a };
  });
}

const fmt = (n: number | null): string => (n === null ? 'none' : String(Math.round(n * 1e6) / 1e6));
/** "width 140 → 180" for each changed parameter, joined; "no value changed" when none. */
export const diffText = (diff: ParamChange[], arrow = '→'): string => diff.filter((d) => d.changed).map((d) => `${d.name} ${fmt(d.before)} ${arrow} ${fmt(d.after)}`).join(', ') || 'no value changed';

// ── the readback ─────────────────────────────────────────────────────────────────

export interface ReadbackMeasured {
  ok: true;
  worker: { name: string; version: string };
  python?: string;
  engine?: Record<string, unknown>;
  source: { name: string; sha256: string; bytes: number };
  unit_in_effect?: string | null;
  valid: boolean;
  solids: number;
  bounds: { min: number[]; max: number[]; size: number[]; method?: string };
  volume_mm3: number;
  volume_method?: string;
  tier?: string;
}
export interface ReadbackFailure { ok: false; worker?: { name: string; version: string }; code: string; error: string }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(finite);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/**
 * The worker's output (stdout and stderr as the job logged them): its one JSON line is the last line that parses
 * as an object naming a worker. A success must carry every measured value it claims; anything less is a failure,
 * with the reason. Nothing is filled in.
 */
export function parseReadbackOutput(output: string): ReadbackMeasured | ReadbackFailure {
  let found: Record<string, unknown> | undefined;
  for (const line of output.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = objOf(JSON.parse(t));
      if (o && objOf(o.worker) && typeof o.ok === 'boolean') { found = o; break; }
    } catch { /* not the worker's line */ }
  }
  if (!found) return { ok: false, code: 'no-output', error: output.trim() ? 'the worker printed no result line (its output is kept in the log)' : 'the worker printed nothing' };
  const w = objOf(found.worker)!;
  const worker = text(w.name) && text(w.version) ? { name: w.name, version: w.version } : undefined;
  if (!worker) return { ok: false, code: 'malformed', error: 'the result line names no worker version' };
  if (found.ok !== true) {
    const e = objOf(found.error);
    return { ok: false, worker, code: text(e?.code) ? e!.code as string : 'failed', error: text(e?.message) ? (e!.message as string).slice(0, 400) : 'the worker reported a failure without a message' };
  }
  const src = objOf(found.source);
  const b = objOf(found.bounds);
  if (!src || !text(src.sha256) || !/^[0-9a-f]{64}$/.test(src.sha256 as string) || !finite(src.bytes)) return { ok: false, worker, code: 'malformed', error: 'the result line has no sha256 of what it read' };
  if (typeof found.valid !== 'boolean' || !finite(found.solids)) return { ok: false, worker, code: 'malformed', error: 'the result line has no validity or solid count' };
  if (!b || !triple(b.size) || !triple(b.min) || !triple(b.max)) return { ok: false, worker, code: 'malformed', error: 'the result line has no bounding box' };
  if (!finite(found.volume_mm3)) return { ok: false, worker, code: 'malformed', error: 'the result line has no volume' };
  if (found.units !== 'mm') return { ok: false, worker, code: 'malformed', error: `the result line's units are ${String(found.units)}, not mm` };
  return {
    ok: true, worker,
    ...(text(found.python) ? { python: found.python } : {}),
    ...(objOf(found.engine) ? { engine: objOf(found.engine) } : {}),
    source: { name: text(src.name) ? src.name : '', sha256: src.sha256 as string, bytes: src.bytes as number },
    ...(found.unit_in_effect === null || text(found.unit_in_effect) ? { unit_in_effect: found.unit_in_effect as string | null } : {}),
    valid: found.valid, solids: found.solids as number,
    bounds: { min: b.min as number[], max: b.max as number[], size: b.size as number[], ...(text(b.method) ? { method: b.method } : {}) },
    volume_mm3: found.volume_mm3 as number,
    ...(text(found.volume_method) ? { volume_method: found.volume_method } : {}),
    ...(text(found.tier) ? { tier: found.tier } : {}),
  };
}

export interface ReadbackCheck { name: string; predicted: number | boolean; measured: number | boolean; difference: number | null; tolerance: string; passed: boolean }
export type Verdict = 'matches' | 'differs' | 'failed';

/**
 * The measured values against the sealed prediction: one valid solid, each bounding-box size within the
 * tolerance in mm, the volume within the relative tolerance. Every check is kept with its numbers.
 */
export function compareReadback(predicted: { bounds: number[]; volume: number }, m: ReadbackMeasured, tol: { bounds_mm: number; volume_relative: number } = READBACK_TOLERANCE): { verdict: 'matches' | 'differs'; checks: ReadbackCheck[] } {
  const checks: ReadbackCheck[] = [
    { name: 'valid shape', predicted: true, measured: m.valid, difference: null, tolerance: 'exact', passed: m.valid === true },
    { name: 'solids', predicted: 1, measured: m.solids, difference: m.solids - 1, tolerance: 'exact', passed: m.solids === 1 },
    ...['x', 'y', 'z'].map((axis, i) => {
      const d = m.bounds.size[i] - predicted.bounds[i];
      return { name: `bounds ${axis} (mm)`, predicted: predicted.bounds[i], measured: m.bounds.size[i], difference: d, tolerance: `${tol.bounds_mm} mm`, passed: Math.abs(d) <= tol.bounds_mm };
    }),
    (() => {
      const d = m.volume_mm3 - predicted.volume;
      const rel = predicted.volume ? Math.abs(d) / Math.abs(predicted.volume) : Number.POSITIVE_INFINITY;
      return { name: 'volume (mm3)', predicted: predicted.volume, measured: m.volume_mm3, difference: d, tolerance: `${tol.volume_relative} relative`, passed: rel <= tol.volume_relative };
    })(),
  ];
  return { verdict: checks.every((c) => c.passed) ? 'matches' : 'differs', checks };
}

/** The tolerance as the notices and the board say it: "1e-6 mm and 1e-8 relative". */
export const toleranceText = (t: { bounds_mm: number; volume_relative: number }): string => `${t.bounds_mm.toExponential()} mm and ${t.volume_relative.toExponential()} relative`;

/** Numbers as the records and notices show them: up to 6 decimals for mm, 3 for mm3. */
export const mmText = (b: number[]): string => b.map((n) => String(Math.round(n * 1e6) / 1e6)).join(' x ');
export const mm3Text = (n: number): string => (Math.round(n * 1000) / 1000).toLocaleString('en-US');

// ── the flow record ──────────────────────────────────────────────────────────────

export type FlowOutcome = 'running' | 'succeeded' | 'differs' | 'stopped' | 'failed' | 'cancelled';
export type FlowStep = 'prepare' | 'agent' | 'checks' | 'build' | 'readback' | 'record';

export interface FlowRecord {
  flow: 1;
  schema: typeof FLOW_SCHEMA;
  id: string;
  kind: 'iterate';
  recipe: typeof RECIPE_ID;
  instruction: string;
  project: string;
  started_at: string;
  ended_at?: string;
  outcome: FlowOutcome;
  /** the step it ended in, and why, in a sentence (absent while it runs) */
  ended_in?: FlowStep;
  why?: string;
  parameters: {
    path: string;
    /** true when /iterate wrote the file from the recipe card's defaults before the agent ran */
    created: boolean;
    before: { sha256: string; values: Record<string, number> };
    after?: { sha256: string; values: Record<string, number> };
    diff?: ParamChange[];
    /** an invalid file the agent left: its sha256 and why it is refused (the file is left as it is) */
    invalid?: { sha256?: string; error: string };
  };
  agent?: {
    run: string; agent: string; version: string | null; route: string; where: string; model: string | null; job: string;
    outcome?: string; why?: string;
    files_changed?: Array<{ path: string; how: 'added' | 'changed' | 'deleted'; sha256_before?: string | null; sha256_after?: string | null }>;
    /** files other than the parameter file it changed (the flow stopped before the build; nothing was reverted) */
    others?: OtherChange[];
    result?: string; transcript?: string; progress?: string;
    cost_usd?: number | null; cost_basis?: string;
    receipt?: string;
  };
  rebuild?: {
    operation?: string; job?: string; state: string; progress?: string; reason?: string;
    stage?: string; error?: string;
    request_sha256?: string; source_sha256?: string;
    predicted?: { bounds_mm: number[]; volume_mm3: number };
    prediction_receipt?: string;
    parameters_file?: { path: string; sha256: string };
    outputs?: Array<{ path: string; sha256: string; bytes: number }>;
    failure_files?: string[];
    receipt?: string;
    discrepancies?: string[];
  };
  readback?: {
    job?: string; state: string;
    worker?: { name: string; version: string };
    engine?: Record<string, unknown>;
    step?: { path: string; sha256: string };
    measured?: { bounds_mm: number[]; volume_mm3: number; valid: boolean; solids: number; sha256: string; unit_in_effect?: string | null };
    tolerance: { bounds_mm: number; volume_relative: number };
    checks?: ReadbackCheck[];
    verdict?: Verdict;
    reason?: string;
    log?: string;
    receipt?: string;
    scope: string;
  };
  receipts: { agent?: string; prediction?: string; build?: string; readback?: string };
  child_receipts: string[];
  doctrine: string;
}

/** The project-relative folder checked: inside the project, through no link that leads out of it. */
function insideProject(root: string, rel: string): { ok: true; abs: string } | { ok: false; error: string } {
  const abs = path.join(root, rel);
  try {
    const realRoot = fs.realpathSync(root);
    let existing = abs;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    const real = fs.realpathSync(existing);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { ok: false, error: `${rel} leads outside the project` };
    return { ok: true, abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Writes a JSON file in the project through a temporary file renamed over it (never through a link that leads
 * out of the project); its sha256 and size back. Used for the record and for the flow's working files.
 */
export function writeProjectJson(root: string, rel: string, value: unknown): { ok: true; path: string; sha256: string; bytes: number } | { ok: false; path: string; error: string } {
  const dir = insideProject(root, path.dirname(rel));
  if (!dir.ok) return { ok: false, path: rel, error: dir.error };
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.mkdirSync(dir.abs, { recursive: true });
    const again = insideProject(root, path.dirname(rel));
    if (!again.ok) return { ok: false, path: rel, error: again.error };
    const abs = path.join(root, rel);
    try { if (fs.lstatSync(abs).isSymbolicLink()) return { ok: false, path: rel, error: `${rel} is a symbolic link; it was left as it is` }; } catch { /* absent */ }
    const tmp = `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, body, { flag: 'wx' });
    fs.renameSync(tmp, abs);
  } catch (e) {
    return { ok: false, path: rel, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, path: rel, sha256: sha(body), bytes: Buffer.byteLength(body) };
}

/** The flow's record: results/flows/<flow-id>.json. */
export const writeFlowRecord = (root: string, record: FlowRecord) => writeProjectJson(root, flowRecordPath(record.id), record);

/** A record read back: the parsed record and its file's sha256, or why it is not one. */
export function readFlowRecord(root: string, rel: string): { ok: true; record: FlowRecord; sha256: string; text: string } | { ok: false; error: string } {
  try {
    const at = insideProject(root, rel);
    if (!at.ok) return { ok: false, error: at.error };
    if (fs.lstatSync(at.abs).isSymbolicLink()) return { ok: false, error: `${rel} is a symbolic link` };
    const buf = fs.readFileSync(at.abs);
    if (buf.length > 1024 * 1024) return { ok: false, error: `${rel} is larger than a flow record` };
    const json = JSON.parse(buf.toString('utf8')) as FlowRecord;
    if (!json || json.schema !== FLOW_SCHEMA || typeof json.id !== 'string' || !FLOW_ID.test(json.id)) return { ok: false, error: `${rel} is not a flow record` };
    return { ok: true, record: json, sha256: sha(buf), text: buf.toString('utf8') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The project's flow records, newest first (by their start time). */
export function listFlows(root: string): Array<{ rel: string; record: FlowRecord; sha256: string }> {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(root, FLOWS_DIR)).filter((n) => /^f[0-9a-f]{8}\.json$/.test(n)); } catch { return []; }
  const out: Array<{ rel: string; record: FlowRecord; sha256: string }> = [];
  for (const n of names) {
    const rel = `${FLOWS_DIR}/${n}`;
    const r = readFlowRecord(root, rel);
    if (r.ok) out.push({ rel, record: r.record, sha256: r.sha256 });
  }
  return out.sort((a, b) => String(b.record.started_at).localeCompare(String(a.record.started_at)));
}
