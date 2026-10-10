/**
 * Round R4 (/iterate scad, helper H33): the OpenSCAD variant of the connected workflow, without the REPL. A local code
 * agent changes only the model's parameter file (<model>.params.json, timmy.scad-params/1), and values only; then
 * /scad's own judged native job runs (src/native/openscad.ts scadJob, with --png), and the flow's verdict comes from
 * that run's judgement and readback: Timmy's own reading of the exported STL (src/native/stl-readback.ts, its own
 * TypeScript) against OpenSCAD's own summary of the same export (--summary all). This module holds what those steps
 * decide: the agent's task, the parameter diff and the names added or removed, the comparison and its verdict, the
 * measurement of an earlier judged-ok /scad run of the same model ("before") and the flow record.
 *
 * Both measurements are of the generated CAD file; DOCTRINE §15's sentence goes with every dimension shown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listNativeRuns, readNativeRecord } from '../native/index.js';
import type { ScadReadout } from '../native/openscad.js';
import { SCAD_PARAMS_SCHEMA, scadLiteral, type ScadValue } from '../native/scad-params.js';
import { STL_READBACK, topologyWords, type StlReadback } from '../native/stl-readback.js';
import { DOCTRINE_15, sizeText, numText, type FlowAgentPart, type NativeFlowRecordBase } from './iterate-native.js';

export { DOCTRINE_15 };

/** What the comparison is, said once: on the record, the board and the notices. */
export const SCAD_COMPARE_SCOPE = "Timmy's own reading of the exported STL (its own TypeScript, independent of OpenSCAD's engine), compared with OpenSCAD's own summary of the same export (--summary all). Both describe the generated CAD file, in its own units (OpenSCAD models are millimetres by convention), never a physical part.";
/** Who measured the before and after numbers. */
export const SCAD_MEASURED_BY = `Timmy's own reading of each run's exported STL (${STL_READBACK}), as each run's readback.json keeps it`;
/** The model's text is given to the agent (to say what each parameter does) up to this size. */
export const SCAD_MODEL_TEXT_MAX = 16 * 1024;

const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(finite);

// ── the agent's task ─────────────────────────────────────────────────────────────

/**
 * What the local code agent is asked: the operator's instruction first (so the agent's job label shows it), then fixed
 * rules: the one file it may change, values only (no name added or removed), the file's shape kept. The file's text now
 * is given whole, and the model's text too (read only, for what each parameter does) when it is small.
 */
export function scadIterateTask(o: { instruction: string; paramsRel: string; modelRel: string; names: string[]; paramsText: string; modelText?: string; modelBytes?: number }): string {
  const lines = [
    o.instruction.trim(),
    '',
    `Do this by changing the file ${o.paramsRel} in this project, and nothing else. It holds the parameters of the OpenSCAD model ${o.modelRel}: after you finish, Timmy gives each one to OpenSCAD as -D name=value, OpenSCAD exports the model to an STL (and a PNG preview) as a judged job, and Timmy reads the STL back itself and compares it with OpenSCAD's own summary.`,
    '',
    'Rules:',
    `- Edit only ${o.paramsRel}. Do not create, change or delete any other file (${o.modelRel} included), and run no commands.`,
    `- Change values only. Keep every name it holds (${o.names.join(', ')}); add no name and remove none.`,
    `- Keep its JSON shape: "schema" stays "${SCAD_PARAMS_SCHEMA}", "model" stays "${path.posix.basename(o.modelRel)}", and "parameters" holds the values. Add no other field.`,
    '- A value is a number, true or false, or text in double quotes; keep each value the kind it is.',
    '- Change only the parameters the instruction names; keep every other value as it is.',
    '- If the instruction cannot be met by changing these values, change nothing and say why.',
    '',
    `${o.paramsRel} now holds:`,
    o.paramsText.trimEnd(),
  ];
  if (o.modelText !== undefined) lines.push('', `${o.modelRel} (read only: what each parameter does) holds:`, o.modelText.trimEnd());
  else if (o.modelBytes !== undefined) lines.push('', `${o.modelRel} is ${o.modelBytes} bytes, so it is not quoted here: read it for what each parameter does, and do not change it.`);
  return lines.join('\n');
}

// ── the parameters ───────────────────────────────────────────────────────────────

export interface ScadParamChange { name: string; before: ScadValue | null; after: ScadValue | null; changed: boolean }

/** Every parameter, before and after: the file's order before, then any name only after; `changed` where the value differs (its kind included). */
export function scadParamDiff(before: Record<string, ScadValue>, after: Record<string, ScadValue>): ScadParamChange[] {
  const names = [...Object.keys(before), ...Object.keys(after).filter((k) => !Object.hasOwn(before, k)).sort()];
  return names.map((name) => {
    const b = Object.hasOwn(before, name) ? before[name] : null;
    const a = Object.hasOwn(after, name) ? after[name] : null;
    return { name, before: b, after: a, changed: b !== a };
  });
}

/** The names added and removed (each sorted): any of them stops the flow before OpenSCAD runs. */
export function scadNameChanges(before: Record<string, ScadValue>, after: Record<string, ScadValue>): { added: string[]; removed: string[] } {
  return {
    added: Object.keys(after).filter((k) => !Object.hasOwn(before, k)).sort(),
    removed: Object.keys(before).filter((k) => !Object.hasOwn(after, k)).sort(),
  };
}

const valueText = (v: ScadValue | null): string => (v === null ? 'none' : scadLiteral(v));
/** "width 60 → 100, part "both" → "lid"" for each changed parameter; "no value changed" when none. */
export const scadDiffText = (diff: ScadParamChange[], arrow = '→'): string =>
  diff.filter((d) => d.changed).map((d) => `${d.name} ${valueText(d.before)} ${arrow} ${valueText(d.after)}`).join(', ') || 'no value changed';

// ── the comparison ───────────────────────────────────────────────────────────────

export interface ScadCompareCheck { name: string; passed: boolean | null; detail: string }
/** matches; differs; failed; or 'no summary': this OpenSCAD refused --summary, so only Timmy's reading is there (never matches). */
export type ScadVerdict = 'matches' | 'differs' | 'failed' | 'no summary';

/**
 * A run judged ok, compared: Timmy's reading of its STL must be there, closed (edge-manifold) and consistently oriented,
 * and OpenSCAD's own summary bounding box must agree with it. `matches` when all three hold; `differs` when the boxes
 * disagree or the mesh is not closed and consistently oriented; `no summary` when this OpenSCAD refused --summary (the
 * comparison then has Timmy's reading alone); `failed` otherwise, with the reason.
 */
export function compareScadRun(r: Pick<ScadReadout, 'readback' | 'readback_error' | 'summary'>): { verdict: ScadVerdict; checks: ScadCompareCheck[]; reason?: string } {
  const checks: ScadCompareCheck[] = [];
  const m = r.readback;
  if (!m) {
    const why = r.readback_error ? `${r.readback_error.kind}: ${r.readback_error.error}` : 'no reading was made';
    checks.push({ name: "Timmy's reading", passed: false, detail: why });
    return { verdict: 'failed', checks, reason: `Timmy could not read the STL back (${why})` };
  }
  checks.push({ name: "Timmy's reading", passed: true, detail: `${m.format} STL, ${m.triangles} triangles, ${m.corners} corners` });
  checks.push({ name: 'closed mesh', passed: m.manifold, detail: topologyWords(m) });
  checks.push({ name: 'consistent orientation', passed: m.manifold ? m.oriented : null, detail: m.oriented ? 'every edge run once each way' : m.manifold ? `${m.misoriented_edges} edges run the same way by both their triangles` : 'not closed, so not judged' });
  const s = r.summary;
  let summary: boolean | null = null;
  let summaryWhy: string;
  if (s.state === 'written' && s.bbox && s.agrees !== undefined) {
    summary = s.agrees;
    summaryWhy = s.agrees
      ? `OpenSCAD's own bounding box (${sizeText(s.bbox.max.map((v, i) => v - s.bbox!.min[i]))}) agrees with Timmy's within float32 precision`
      : `OpenSCAD's own bounding box, from (${s.bbox.min.map(numText).join(', ')}) to (${s.bbox.max.map(numText).join(', ')}), differs from Timmy's, from (${m.bbox ? m.bbox.min.map(numText).join(', ') : '?'}) to (${m.bbox ? m.bbox.max.map(numText).join(', ') : '?'}), by up to ${numText(s.differs_by)}`;
  } else if (s.state === 'refused') {
    summaryWhy = `this OpenSCAD refused --summary (${s.line ?? 'its line was not kept'}): there is no summary to compare with`;
  } else if (s.state === 'written') {
    summaryWhy = "OpenSCAD's summary file holds no bounding box Timmy can read";
  } else if (s.state === 'not written') {
    summaryWhy = 'OpenSCAD accepted --summary but wrote no summary file';
  } else {
    summaryWhy = `OpenSCAD's summary was not recorded (${s.state})`;
  }
  checks.push({ name: "OpenSCAD's summary", passed: summary, detail: summaryWhy });
  const off = checks.filter((c) => c.passed === false);
  if (off.length) return { verdict: 'differs', checks, reason: off.map((c) => `${c.name}: ${c.detail}`).join('; ') };
  if (s.state === 'refused') return { verdict: 'no summary', checks, reason: summaryWhy };
  if (summary === true) return { verdict: 'matches', checks };
  return { verdict: 'failed', checks, reason: summaryWhy };
}

// ── before and after ─────────────────────────────────────────────────────────────

/** A run's measurement as the flow keeps it (Timmy's reading of its STL). */
export interface ScadMeasure {
  stl: string;
  sha256: string;
  size: number[];
  min: number[];
  max: number[];
  /** signed: the enclosed volume only for a closed, consistently oriented mesh */
  volume: number;
  area: number;
  triangles: number;
  manifold: boolean;
  oriented: boolean;
}

/** The signed volume in words: enclosed (normals out or in), or not an enclosed volume. */
export function scadVolumeText(m: Pick<ScadMeasure, 'volume' | 'oriented'>): string {
  if (!m.oriented) return `${numText(m.volume)}, signed: not an enclosed volume (the mesh is not closed and consistently oriented)`;
  return m.volume >= 0 ? `${numText(m.volume)} (enclosed)` : `${numText(m.volume)} (enclosed, negative: the normals face inward)`;
}

export function measureOf(m: StlReadback): ScadMeasure | undefined {
  if (!m.bbox) return undefined;
  return {
    stl: m.file, sha256: m.sha256, size: [...m.bbox.size], min: [...m.bbox.min], max: [...m.bbox.max],
    volume: m.volume, area: m.area, triangles: m.triangles, manifold: m.manifold, oriented: m.oriented,
  };
}

/** Reads a run's readback.json (written once at its first judgement): the measurement, or undefined. */
function readRunReadback(dir: string): StlReadback | undefined {
  try {
    const at = path.join(dir, 'readback.json');
    if (!fs.lstatSync(at).isFile()) return undefined;
    const r = objOf(JSON.parse(fs.readFileSync(at, 'utf8')));
    const m = objOf(r?.readback) as unknown as StlReadback | undefined;
    if (r?.ok !== true || !m || !objOf(m.bbox) || !triple(m.bbox!.size) || !finite(m.volume) || typeof m.file !== 'string' || typeof m.sha256 !== 'string') return undefined;
    return m;
  } catch { return undefined; }
}

/**
 * The newest /scad run of this model judged ok whose Timmy reading is kept, started before `before` (the flow's own
 * start): its run token, its job's id, when it started and its measurement. Undefined, with the reason, when none.
 */
export function previousScadRun(root: string, modelRel: string, before: string): { run: string; job?: string; started_at: string; measure: ScadMeasure } | { none: string } {
  let runs: ReturnType<typeof listNativeRuns> = [];
  try { runs = listNativeRuns(root); } catch { runs = []; }
  let ofModel = 0;
  for (const r of runs) {
    if (r.app !== 'openscad' || r.started_at >= before) continue;
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(root, r.run); } catch { continue; }
    if (!rec || rec.job.input?.path !== modelRel) continue;
    ofModel++;
    if (r.verdicts.at(-1)?.outcome !== 'ok') continue;
    const m = readRunReadback(rec.dir);
    const measure = m ? measureOf(m) : undefined;
    if (!measure) continue;
    return { run: r.run, ...(rec.started?.job ? { job: rec.started.job } : {}), started_at: r.started_at, measure };
  }
  return { none: ofModel ? `no earlier /scad run of ${modelRel} was judged ok with Timmy's reading kept` : `no earlier /scad run of ${modelRel} in this project` };
}

// ── the flow record ──────────────────────────────────────────────────────────────

export type ScadFlowStep = 'prepare' | 'agent' | 'checks' | 'openscad' | 'readback' | 'record';

/** An OpenSCAD flow's record, results/flows/<flow-id>.json: the flow schema (timmy.flow/1) with target 'scad'. */
export interface ScadFlowRecord extends NativeFlowRecordBase {
  target: 'scad';
  ended_in?: ScadFlowStep;
  /** the model the parameters are for: never changed by the flow */
  model: { path: string; sha256: string; bytes: number };
  parameters: {
    path: string;
    /** as read before the agent ran; `kept`: a copy of those bytes in the flow's folder */
    before: { sha256: string; bytes: number; values: Record<string, ScadValue>; kept?: string };
    after?: { sha256: string; bytes: number; values: Record<string, ScadValue> };
    diff?: ScadParamChange[];
    /** names the agent added or removed (the flow stopped before OpenSCAD ran) */
    names?: { added: string[]; removed: string[] };
    /** a file the agent left that does not check: its sha256 and why (the file is left as it is) */
    invalid?: { sha256?: string; error: string };
  };
  agent?: FlowAgentPart;
  openscad?: {
    job?: string;
    /** the native run's token and its own folder (.timmy/native/<run>/: job.json, scad.json, runner.json, logs/, readback.json) */
    run?: string;
    record?: string;
    state: string;
    /** the judgement of the run (src/native/openscad.ts judgeScadJob) */
    outcome?: 'ok' | 'failed' | 'unknown';
    why?: string;
    version?: string;
    /** the read-only copy of the model OpenSCAD ran, and the -D arguments it was given */
    copy?: { path: string; sha256: string };
    defines?: string[];
    params_file?: { path: string; sha256: string };
    stl?: { path: string; made: boolean; change?: string; sha256?: string; bytes?: number };
    png?: { path: string; made: boolean; change?: string; sha256?: string; why?: string };
    messages?: { errors: number; warnings: number; lines: string[] };
    readback_file?: string;
    summary_file?: string;
    log?: string;
    failure_files?: string[];
    receipt?: string;
    error?: string;
  };
  readback?: {
    verdict?: ScadVerdict;
    /** Timmy's reading of the STL (src/native/stl-readback.ts) */
    measured?: ScadMeasure & { measured_by: string };
    /** OpenSCAD's own summary: its state and bounding box (its report, not Timmy's) */
    summary?: { state: string; path?: string; sha256?: string; min?: number[]; max?: number[]; agrees?: boolean; differs_by?: number; line?: string };
    checks?: ScadCompareCheck[];
    reason?: string;
    scope: string;
  };
  /** an earlier judged-ok /scad run of the same model (before the flow started) and this run, as Timmy measured each */
  before_after?: {
    measured_by: string;
    before: (ScadMeasure & { run: string; job?: string; started_at: string }) | null;
    before_note?: string;
    after?: ScadMeasure & { run: string; job?: string };
  };
  receipts: { agent?: string; openscad?: string };
}

/** Whether a record (as read from its file) is an OpenSCAD flow's. */
export function isScadFlowRecord(r: unknown): r is ScadFlowRecord {
  const o = objOf(r);
  return !!o && o.kind === 'iterate' && o.target === 'scad' && !!objOf(o.parameters) && !!objOf(o.model);
}

/** An OpenSCAD flow in a few words for /iterate's list ("scad box.scad width 60 → 100"); '' for any other record. */
export function scadFlowSummary(r: unknown, arrow = '→'): string {
  if (!isScadFlowRecord(r)) return '';
  const p = typeof r.model.path === 'string' ? r.model.path : '?';
  const diff = Array.isArray(r.parameters.diff) ? ` ${scadDiffText(r.parameters.diff, arrow)}` : '';
  return `scad ${p}${diff}`;
}
