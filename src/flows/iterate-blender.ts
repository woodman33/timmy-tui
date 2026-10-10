/**
 * Round R4 (/iterate blender, helper H26): the Blender variant of the connected workflow, without the REPL. A local
 * code agent changes one Blender scene script, Blender runs it as a judged native job (src/native blenderJob, judged
 * by the run's own result file), and a second Blender process opens the .blend that run saved and reads it back
 * (workers/readback/blend_readback.py). This module holds what those steps decide: the agent's task, the check of what
 * it changed (that script only), a summary of the script's change, its Python syntax check, the readback's output, what
 * the run's result file reported, the comparison of the two and the flow record (results/flows/<flow-id>.json, the
 * tray flow's schema with `target: 'blender'`). The REPL side (src/repl/iterate-blender.ts) runs the steps and seals.
 *
 * The readback is labelled as what it is: the same application reading its own file in a separate process, a second
 * pass, not an independent implementation. Its lengths are Blender units of a generated scene; DOCTRINE §15's sentence
 * goes with them wherever they are shown.
 *
 * Round R4 (helper H37, object dimensions): both Blender passes report each object's world-space axis-aligned bounding
 * box (`bounds`: min, max, size and location, Blender units rounded to 1e-6, the scene's unit settings once); the
 * comparison's `dimensions` check holds the run's report against the second pass's within DIMENSIONS_TOLERANCE, and the
 * record's `dimensions` says which objects changed size against a judged-ok Blender run of the same script from before
 * the flow (findBeforeRun), "Cube 2 × 2 × 2 → 3 × 3 × 3 (Blender's report; the second pass agrees)".
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_SKIP, type ChangeSet } from '../code-agents/index.js';
import { listNativeRuns, readNativeRecord, sha256File } from '../native/index.js';
import { resolveInside } from '../project/index.js';
import { packagedPath, packageRoot } from '../utils/asset-dirs.js';
import { DOCTRINE_15, FLOW_SCHEMA, judgeAgentChanges, type AgentChanges, type FlowOutcome, type OtherChange } from './iterate.js';

export { DOCTRINE_15 };

function packaged(rel: string): string {
  return packagedPath(rel, import.meta.url, { kind: 'file' }) ?? path.join(packageRoot(import.meta.url) ?? fileURLToPath(new URL('.', import.meta.url)), rel);
}
/** workers/readback/blend_readback.py at the package root (as READBACK_SCRIPT is found); where it belongs when missing. */
export const BLEND_READBACK_SCRIPT = packaged('workers/readback/blend_readback.py');
/** The second pass's time limit as a job (Blender's start and one file's read), and the most its log may hold. */
export const BLEND_READBACK_TIMEOUT_MS = 180_000;
export const BLEND_READBACK_MAX_OUTPUT = 4 * 1024 * 1024;
/** What the second pass is, said once: on the record, the board and the notices. */
export const BLEND_READBACK_SCOPE = 'A second pass: Blender opened the saved .blend in a separate process and read it back. It is the same application reading its own file, not an independent implementation; its lengths are Blender units of a generated scene, never measurements of a physical object.';
/** The agent is given the whole script, so /iterate blender takes scripts up to this size. */
export const SCRIPT_MAX_BYTES = 256 * 1024;
/** How long the syntax check's python3 may take. */
export const SYNTAX_TIMEOUT_MS = 15_000;
/** The checks that make a comparison: at least one of them must be made for a verdict other than failed. */
export const CORE_CHECKS: readonly BlendCheckName[] = ['objects', 'materials', 'camera'];
/** R4 (H37): how far apart, in Blender units, two reports of an object's bounding box (each of min, max and size, per axis) may be. */
export const DIMENSIONS_TOLERANCE = 1e-6;
/** What the object sizes are and are not, said with them on the record, the card and the notices. */
export const DIMENSIONS_SCOPE = 'Object sizes are world-space axis-aligned bounding boxes in Blender units, as Blender\'s run reported them; the comparison with the saved .blend is a second pass by the same application, not an independent implementation.';

const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (finite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numbers = (v: unknown, n?: number): number[] | null => (Array.isArray(v) && (n === undefined || v.length === n) && v.every(finite) ? v as number[] : null);
const names = (xs: string[], max = 12): string => `${xs.slice(0, max).join(', ')}${xs.length > max ? ` and ${xs.length - max} more` : ''}`;

// ── the script: where it may be, and the agent's task ───────────────────────────

/**
 * Why a script there cannot be iterated, or undefined: the agent's before/after snapshot (src/code-agents) does not
 * look into .git, node_modules, .timmy or dist, so a change to a script inside one could not be seen. Compared without
 * case, so a folder that differs only in case on a case-insensitive disk is refused too.
 */
export function unseenFolder(rel: string): string | undefined {
  const skip = new Set([...SNAPSHOT_SKIP].map((s) => s.toLowerCase()));
  return rel.split('/').slice(0, -1).find((part) => skip.has(part.toLowerCase()));
}

/**
 * What the local code agent is asked: the operator's instruction first (so the agent's job label shows it), then
 * fixed rules: the one file it may change, what Timmy does with it after, to keep how it reports its run and to keep
 * that report true to the scene. The script's text now is given whole, so the agent edits what is there.
 */
export function blenderIterateTask(o: { instruction: string; scriptRel: string; scriptText: string }): string {
  return [
    o.instruction.trim(),
    '',
    `Do this by changing the file ${o.scriptRel} in this project, and nothing else. It is a Python script for Blender's own Python (bpy): after you finish, Timmy runs it headless (blender -b --factory-startup --python ${o.scriptRel}), judges the run by the result file it writes, then opens the .blend it saved in a second Blender process and compares what that file holds with what the result reported (objects, materials, camera, and each object's size).`,
    '',
    'Rules:',
    `- Edit only ${o.scriptRel}. Do not create, change or delete any other file, and run no commands.`,
    '- Keep it a script for Blender\'s own Python, and keep how it reports its run as it is (timmy_blender: run_script, save_blend, render_still, and what main returns).',
    '- Keep what it reports true to the scene it builds: the objects, the materials its objects use and the active camera.',
    '- Change only what the instruction asks for; keep everything else as it is.',
    '- If the instruction cannot be done in this script, change nothing and say why.',
    '',
    `${o.scriptRel} now holds:`,
    o.scriptText.trimEnd(),
  ].join('\n');
}

/**
 * The agent's own before/after snapshot, judged for /iterate blender: only the script may have changed (the tray's
 * judgeAgentChanges with the script as the one file, its sentences naming the script).
 */
export function judgeScriptChanges(files: (ChangeSet & { truncated?: boolean }) | undefined, scriptRel: string): AgentChanges {
  const j = judgeAgentChanges(files, scriptRel);
  if (j.ok) return j;
  if (j.reason === 'missing') return { ...j, why: `the agent run left no record of what it changed, so whether it changed only ${scriptRel} is not known` };
  if (j.reason === 'incomplete') return { ...j, why: `the project has more files than the agent run compared, so whether it changed only ${scriptRel} is not known` };
  return j;
}

// ── the script's change ─────────────────────────────────────────────────────────

export interface ScriptHunk {
  /** where it starts, 1-based, in the script before and after */
  before_line: number;
  after_line: number;
  /** the lines taken out and put in (the first 8 of each, each cut at 160 characters) */
  removed: string[];
  added: string[];
  removed_total: number;
  added_total: number;
}
export interface ScriptChange {
  added: number;
  removed: number;
  /** the first 6 places that changed */
  hunks: ScriptHunk[];
  hunks_total: number;
  method: 'line diff (longest common subsequence)' | 'whole middle replaced (too long to compare line by line)';
}

const MAX_HUNKS = 6;
const MAX_HUNK_LINES = 8;
const MAX_LINE_CHARS = 160;
const DIFF_CELLS = 2_250_000;

const linesOf = (s: string): string[] => {
  const l = s.split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
};
const cut = (l: string): string => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l);

/**
 * The script's change, line by line: the common start and end set aside, the middle compared by its longest common
 * subsequence (or, past 1,500 x 1,500 lines, counted as replaced whole), grouped into the places that changed.
 */
export function scriptChange(before: string, after: string): ScriptChange {
  const a = linesOf(before);
  const b = linesOf(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const n = am.length;
  const m = bm.length;
  /** each step: '=' kept, '-' taken out of the before, '+' put into the after; with its index in each middle */
  const ops: Array<{ op: '=' | '-' | '+'; i: number; j: number }> = [];
  let method: ScriptChange['method'] = 'line diff (longest common subsequence)';
  if (n * m <= DIFF_CELLS) {
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ op: '=', i, j }); i++; j++; } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { ops.push({ op: '-', i, j }); i++; } else { ops.push({ op: '+', i, j }); j++; }
    }
    for (; i < n; i++) ops.push({ op: '-', i, j });
    for (; j < m; j++) ops.push({ op: '+', i, j });
  } else {
    method = 'whole middle replaced (too long to compare line by line)';
    for (let i = 0; i < n; i++) ops.push({ op: '-', i, j: 0 });
    for (let j = 0; j < m; j++) ops.push({ op: '+', i: n, j });
  }
  const hunks: ScriptHunk[] = [];
  let total = 0;
  let added = 0;
  let removed = 0;
  for (let k = 0; k < ops.length;) {
    if (ops[k].op === '=') { k++; continue; }
    const start = ops[k];
    const h: ScriptHunk = { before_line: p + start.i + 1, after_line: p + start.j + 1, removed: [], added: [], removed_total: 0, added_total: 0 };
    for (; k < ops.length && ops[k].op !== '='; k++) {
      const o = ops[k];
      if (o.op === '-') { h.removed_total++; if (h.removed.length < MAX_HUNK_LINES) h.removed.push(cut(am[o.i])); } else { h.added_total++; if (h.added.length < MAX_HUNK_LINES) h.added.push(cut(bm[o.j])); }
    }
    total++;
    added += h.added_total;
    removed += h.removed_total;
    if (hunks.length < MAX_HUNKS) hunks.push(h);
  }
  return { added, removed, hunks, hunks_total: total, method };
}

/** "+1 −1 lines in 1 place" */
export const changeText = (c: ScriptChange): string =>
  `+${c.added} −${c.removed} line${c.added + c.removed === 1 ? '' : 's'} in ${c.hunks_total} place${c.hunks_total === 1 ? '' : 's'}`;

// ── the syntax check ────────────────────────────────────────────────────────────

/**
 * Run as `python3 -I -c <this> <name>` with the script's bytes on stdin: an AST parse, nothing executed or imported
 * from the script. One JSON line: ok, the parsing Python's version, and the error with its line when it does not parse.
 */
export const SYNTAX_CHECK_CODE = [
  'import ast, json, sys',
  'src = sys.stdin.buffer.read()',
  'name = sys.argv[1] if len(sys.argv) > 1 else "<script>"',
  'out = {"python": sys.version.split()[0]}',
  'try:',
  '    ast.parse(src, filename=name)',
  '    out["ok"] = True',
  'except SyntaxError as e:',
  '    out.update(ok=False, error="%s: %s" % (type(e).__name__, e.msg), line=e.lineno, offset=e.offset)',
  'except (ValueError, TypeError) as e:',
  '    out.update(ok=False, error="%s: %s" % (type(e).__name__, e))',
  'print(json.dumps(out))',
].join('\n');

export type SyntaxCheck =
  | { checked: true; ok: true; python: string; by: string }
  | { checked: true; ok: false; python: string; by: string; error: string; line: number | null; offset: number | null }
  | { checked: false; why: string };

/** The check's line: its answer, or undefined when python3 printed none (then the check did not run). */
export function parseSyntaxOutput(stdout: string): { ok: true; python: string } | { ok: false; python: string; error: string; line: number | null; offset: number | null } | undefined {
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: Record<string, unknown> | undefined;
    try { o = objOf(JSON.parse(t)); } catch { continue; }
    if (!o || typeof o.ok !== 'boolean' || !text(o.python)) continue;
    if (o.ok) return { ok: true, python: o.python };
    return { ok: false, python: o.python, error: text(o.error) ? o.error.slice(0, 300) : 'SyntaxError', line: numOrNull(o.line), offset: numOrNull(o.offset) };
  }
  return undefined;
}

/** The check in words, for the notices, the record's reason and the board. */
export function syntaxText(s: SyntaxCheck | undefined): string {
  if (!s) return 'not checked as Python';
  if (!s.checked) return `not checked as Python: ${s.why}`;
  if (s.ok) return `parses as Python (an AST parse by ${s.by} ${s.python}; this machine's python3, not Blender's own)`;
  return `does not parse as Python: ${s.error}${s.line !== null ? `, line ${s.line}` : ''} (an AST parse by ${s.by} ${s.python})`;
}

// ── the second pass's output ────────────────────────────────────────────────────

export interface BlendObject { name: string; type: string; dimensions: number[] | null; location: number[] | null; materials: string[] }
export interface BlendScene { name: string; objects: number | null; camera: string | null; frame_start: number | null; frame_end: number | null; resolution: number[] | null; resolution_percentage: number | null; engine: string | null }

/** R4 (H37): the scene's unit settings as Blender reported them (what a Blender unit is shown as); never applied. */
export interface BlendUnits { system?: string; scale_length?: number; length_unit?: string }
/** One object's world-space axis-aligned bounding box and its location (matrix_world's translation), in Blender units. */
export interface BlendObjectBounds { name: string; type: string; min: number[]; max: number[]; size: number[]; location: number[] }
/**
 * R4 (H37): the object sizes a Blender pass reported (`bounds`, from workers/blender/timmy_blender.py in the run's result
 * and from workers/readback/blend_readback.py in the second pass's line): each object that has a bounding box, sorted
 * by name, at most what the worker listed (objects_total: all of them).
 */
export interface BlendBounds {
  method: string | null;
  /** true: taken from the evaluated objects, through the depsgraph; false: the objects as they were (not_evaluated says why) */
  evaluated: boolean | null;
  not_evaluated?: string;
  units: BlendUnits | null;
  rounding: number | null;
  objects: BlendObjectBounds[];
  objects_total: number;
  /** the objects without a bounding box (empties, cameras, lights) */
  without_bounds: number | null;
}

/**
 * A `bounds` report, read: the report, the reason the worker gave for having none (`failed`: its own report failed), or
 * why it is not in the form the workers write (`malformed`). Nothing is filled in.
 */
export function parseBounds(v: unknown): { ok: true; bounds: BlendBounds } | { ok: false; failed: boolean; error: string } {
  const b = objOf(v);
  if (!b) return { ok: false, failed: false, error: 'bounds is not an object' };
  if (text(b.error)) return { ok: false, failed: true, error: b.error.slice(0, 300) };
  if (!Array.isArray(b.objects) || !finite(b.objects_total)) return { ok: false, failed: false, error: 'bounds has no objects and objects_total' };
  const objects: BlendObjectBounds[] = [];
  for (const x of b.objects) {
    const o = objOf(x);
    const min = numbers(o?.min, 3);
    const max = numbers(o?.max, 3);
    const size = numbers(o?.size, 3);
    const location = numbers(o?.location, 3);
    if (!o || !text(o.name) || !text(o.type) || !min || !max || !size || !location) return { ok: false, failed: false, error: 'bounds lists an object without its name, type, min, max, size and location' };
    objects.push({ name: o.name, type: o.type, min, max, size, location });
  }
  const u = objOf(b.units);
  const units: BlendUnits | null = u ? {
    ...(text(u.system) ? { system: u.system } : {}), ...(finite(u.scale_length) ? { scale_length: u.scale_length } : {}), ...(text(u.length_unit) ? { length_unit: u.length_unit } : {}),
  } : null;
  return {
    ok: true,
    bounds: {
      method: strOrNull(b.method), evaluated: typeof b.evaluated === 'boolean' ? b.evaluated : null, ...(text(b.not_evaluated) ? { not_evaluated: b.not_evaluated.slice(0, 300) } : {}),
      units, rounding: numOrNull(b.rounding), objects: objects.sort((p, q) => (p.name < q.name ? -1 : p.name > q.name ? 1 : 0)),
      objects_total: b.objects_total as number, without_bounds: numOrNull(b.without_bounds),
    },
  };
}

/** A number as the records show it: rounded to 1e-6, without a trailing zero or a negative zero ("3", "1.4", "-0.5"). */
export const lengthText = (n: number): string => { const r = Math.round(n * 1e6) / 1e6; return String(r === 0 ? 0 : r); };
/** A size as "2 × 2 × 2". */
export const sizeText = (v: number[]): string => v.map(lengthText).join(' × ');
/** A tolerance as the records say it: "1e-6". */
export const toleranceText = (t: number): string => t.toExponential();
const pointText = (v: number[]): string => `(${v.map(lengthText).join(', ')})`;
/** The unit settings in words: "system METRIC, scale_length 1, length_unit METERS". */
export const unitsText = (u: BlendUnits | null | undefined): string => {
  if (!u) return 'not reported';
  const parts = [...(u.system ? [`system ${u.system}`] : []), ...(u.scale_length !== undefined ? [`scale_length ${lengthText(u.scale_length)}`] : []), ...(u.length_unit ? [`length_unit ${u.length_unit}`] : [])];
  return parts.join(', ') || 'not reported';
};
/** What the second pass read from the .blend (Blender units, rounded to 1e-6 by the worker). */
export interface BlendRead {
  scene: string | null;
  /** the active scene's objects, by name; at most what fitted in the worker's line (objects_total: all of them) */
  objects: BlendObject[];
  objects_total: number;
  /** every material in the file, with its user count as Blender reports it */
  materials: Array<{ name: string; users: number | null; fake_user: boolean }>;
  /** the materials in the slots of the active scene's objects */
  materials_used: string[];
  cameras: Array<{ name: string; data: string | null; lens: number | null }>;
  active_camera: string | null;
  scenes: BlendScene[];
  frame_range: number[] | null;
  render_resolution: number[] | null;
  resolution_percentage: number | null;
  units: Record<string, unknown> | null;
  /** R4 (H37): each object's world-space bounding box; null when the worker reported none (bounds_error: why, when it said) */
  bounds: BlendBounds | null;
  bounds_error?: string;
}
export interface BlendReadback { ok: true; worker: { name: string; version: string }; blender_version: string | null; python?: string; file: { name: string; opened: string | null }; read: BlendRead }
export interface BlendReadbackFailure { ok: false; worker?: { name: string; version: string }; code: string; error: string }

/**
 * The second pass's output (stdout and stderr as the job logged them, Blender's own lines among them): its one JSON
 * line is the last line that parses as an object naming a worker. A success must carry every value it claims;
 * anything less is a failure with the reason. Nothing is filled in.
 */
export function parseBlendReadback(output: string): BlendReadback | BlendReadbackFailure {
  let found: Record<string, unknown> | undefined;
  for (const line of output.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = objOf(JSON.parse(t));
      if (o && objOf(o.worker) && typeof o.ok === 'boolean') { found = o; break; }
    } catch { /* Blender's own line, not the worker's */ }
  }
  if (!found) return { ok: false, code: 'no-output', error: output.trim() ? 'the second pass printed no result line (its output is kept in the log)' : 'the second pass printed nothing' };
  const w = objOf(found.worker)!;
  const worker = text(w.name) && text(w.version) ? { name: w.name, version: w.version } : undefined;
  if (!worker) return { ok: false, code: 'malformed', error: 'the result line names no worker version' };
  if (found.ok !== true) {
    const e = objOf(found.error);
    return { ok: false, worker, code: text(e?.code) ? e!.code as string : 'failed', error: text(e?.message) ? (e!.message as string).slice(0, 400) : 'the worker reported a failure without a message' };
  }
  const bad = (what: string): BlendReadbackFailure => ({ ok: false, worker, code: 'malformed', error: `the result line has no ${what}` });
  const file = objOf(found.file);
  if (!file || !text(file.name)) return bad('file name');
  if (!Array.isArray(found.objects) || !finite(found.objects_total)) return bad('objects');
  const objects: BlendObject[] = [];
  for (const x of found.objects) {
    const o = objOf(x);
    if (!o || !text(o.name) || !text(o.type)) return bad('name and type for each object');
    objects.push({ name: o.name, type: o.type, dimensions: numbers(o.dimensions, 3), location: numbers(o.location, 3), materials: Array.isArray(o.materials) ? o.materials.filter(text) : [] });
  }
  if (!Array.isArray(found.materials) || !Array.isArray(found.materials_used)) return bad('materials');
  const materials: BlendRead['materials'] = [];
  for (const x of found.materials) {
    const m = objOf(x);
    if (!m || !text(m.name)) return bad('name for each material');
    materials.push({ name: m.name, users: numOrNull(m.users), fake_user: m.fake_user === true });
  }
  if (!found.materials_used.every(text)) return bad('names for the materials in use');
  if (!(found.active_camera === null || text(found.active_camera))) return bad('active camera (a name or null)');
  if (!Array.isArray(found.cameras) || !Array.isArray(found.scenes)) return bad('cameras and scenes');
  const cameras = found.cameras.map(objOf).filter((c): c is Record<string, unknown> => !!c && text(c.name)).map((c) => ({ name: c.name as string, data: strOrNull(c.data), lens: numOrNull(c.lens) }));
  const scenes = found.scenes.map(objOf).filter((s): s is Record<string, unknown> => !!s && text(s.name)).map((s) => ({
    name: s.name as string, objects: numOrNull(s.objects), camera: strOrNull(s.camera), frame_start: numOrNull(s.frame_start), frame_end: numOrNull(s.frame_end),
    resolution: numbers(s.resolution, 2), resolution_percentage: numOrNull(s.resolution_percentage), engine: strOrNull(s.engine),
  }));
  // R4 (H37): the object sizes, when the worker reports them (0.2.0 on); claimed but unreadable is a failure, as above
  let bounds: BlendBounds | null = null;
  let boundsError: string | undefined;
  if (found.bounds !== undefined && found.bounds !== null) {
    const p = parseBounds(found.bounds);
    if (p.ok) bounds = p.bounds;
    else if (p.failed) boundsError = p.error;
    else return bad(`bounds in the form the worker writes (${p.error})`);
  }
  return {
    ok: true, worker, blender_version: strOrNull(found.blender_version), ...(text(found.python) ? { python: found.python } : {}),
    file: { name: file.name as string, opened: strOrNull(file.opened) },
    read: {
      scene: strOrNull(found.scene), objects, objects_total: found.objects_total as number, materials, materials_used: found.materials_used as string[],
      cameras, active_camera: (found.active_camera as string | null), scenes,
      frame_range: numbers(found.frame_range, 2), render_resolution: numbers(found.render_resolution, 2), resolution_percentage: numOrNull(found.resolution_percentage),
      units: objOf(found.units) ?? null, bounds, ...(boundsError ? { bounds_error: boundsError } : {}),
    },
  };
}

// ── what the run reported, and the comparison ──────────────────────────────────

/**
 * What the run's result file reported that the second pass can be compared with; `unreadable`: fields there in a form
 * that cannot be. R4 (H37): `bounds`, the scene's object sizes as timmy_blender reported them when the script's main
 * returned (`bounds_error`: the reason it gave for having none).
 */
export interface BlendReported { objects?: string[]; materials?: string[]; camera?: string | null; resolution?: number[]; frame_range?: number[]; bounds?: BlendBounds; bounds_error?: string; unreadable?: string[] }

/** From the run's result file (as timmy_blender writes it, with what the script's main returned in it). */
export function reportedByResult(result: unknown): BlendReported {
  const r = objOf(result);
  if (!r) return { unreadable: ['the result file is not a JSON object'] };
  const out: BlendReported = {};
  const unreadable: string[] = [];
  const list = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const got = v.map((x) => (typeof x === 'string' ? x : text(objOf(x)?.name) ? objOf(x)!.name as string : undefined));
    return got.every((x): x is string => typeof x === 'string') ? got : undefined;
  };
  for (const key of ['objects', 'materials'] as const) {
    if (!(key in r)) continue;
    const got = list(r[key]);
    if (got) out[key] = got; else unreadable.push(`${key} is not a list of names`);
  }
  if ('camera' in r) {
    const c = r.camera;
    if (c === null || typeof c === 'string') out.camera = c;
    else if (text(objOf(c)?.name)) out.camera = objOf(c)!.name as string;
    else unreadable.push('camera is not a name');
  }
  for (const [key, name] of [['resolution', 'resolution'], ['frame_range', 'frame_range']] as const) {
    if (!(key in r)) continue;
    const got = numbers(r[key], 2);
    if (got && got.every(Number.isInteger)) out[name] = got; else unreadable.push(`${key} is not two whole numbers`);
  }
  if ('bounds' in r && r.bounds !== null) {
    const p = parseBounds(r.bounds);
    if (p.ok) out.bounds = p.bounds;
    else if (p.failed) out.bounds_error = p.error;
    else unreadable.push(`bounds is not in the form timmy_blender writes (${p.error})`);
  }
  if (unreadable.length) out.unreadable = unreadable;
  return out;
}

export type BlendCheckName = 'objects' | 'materials' | 'camera' | 'resolution' | 'frame range' | 'dimensions';
export interface BlendCheck {
  name: BlendCheckName;
  /** what the run's result file reported, and what the second pass read */
  reported: unknown;
  read: unknown;
  /** null: not compared (the note says why) */
  passed: boolean | null;
  differences: string[];
  note?: string;
  /** R4 (H37), the dimensions check: how far apart two values may be, in Blender units */
  tolerance?: number;
}
export type BlendVerdict = 'matches' | 'differs' | 'failed';

const sameList = (a: number[], b: number[] | null): boolean => !!b && a.length === b.length && a.every((x, i) => x === b[i]);
/**
 * Two lengths the same within the tolerance. The slack above it is only float64's own error in the subtraction (a few
 * units in the last place of the larger value, at least 1e-12), so two values rounded to 1e-6 one step apart still are.
 */
const near = (a: number[], b: number[], tol = DIMENSIONS_TOLERANCE): boolean =>
  a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol + Math.max(1e-12, 4 * Number.EPSILON * Math.max(Math.abs(x), Math.abs(b[i]))));
/** The most differences a dimensions check lists (the rest are counted). */
const MAX_DIFFERENCES = 24;
const sameUnits = (a: BlendUnits | null, b: BlendUnits | null): boolean =>
  !a || !b || (a.system === b.system && a.length_unit === b.length_unit && (a.scale_length === undefined || b.scale_length === undefined ? a.scale_length === b.scale_length : near([a.scale_length], [b.scale_length])));
const boxText = (o: BlendObjectBounds): string => `${sizeText(o.size)} from ${pointText(o.min)} to ${pointText(o.max)}`;

/**
 * R4 (H37): the dimensions check. Each object the run's result reported with a bounding box against the one the second
 * pass read from the saved .blend, by name: min, max and size, per axis, within DIMENSIONS_TOLERANCE; an object in one
 * report and not the other is a difference, as is another type or other unit settings. Not compared (passed null, with
 * the reason) when either side reported no sizes, or listed only some of them.
 */
export function compareDimensions(reported: BlendReported, read: BlendRead): BlendCheck {
  const tolerance = DIMENSIONS_TOLERANCE;
  const count = (b: BlendBounds | null | undefined): { objects: number; units: BlendUnits | null } | null => (b ? { objects: b.objects_total, units: b.units } : null);
  const base = { name: 'dimensions' as const, reported: count(reported.bounds), read: count(read.bounds), differences: [] as string[], tolerance };
  if (!reported.bounds) return { ...base, passed: null, note: `Blender's run reported no object sizes${reported.bounds_error ? ` (${reported.bounds_error})` : ''}, so the dimensions were not compared` };
  if (!read.bounds) return { ...base, passed: null, note: `the second pass reported no object sizes${read.bounds_error ? ` (${read.bounds_error})` : ' (a worker from before they were reported)'}, so the dimensions were not compared` };
  const rep = reported.bounds;
  const got = read.bounds;
  if (rep.objects_total > rep.objects.length || got.objects_total > got.objects.length) {
    return { ...base, passed: null, note: `Blender's run listed ${rep.objects.length} of ${rep.objects_total} objects with a size and the second pass ${got.objects.length} of ${got.objects_total}, so the dimensions were not compared` };
  }
  const have = new Map(got.objects.map((o) => [o.name, o]));
  const said = new Map(rep.objects.map((o) => [o.name, o]));
  const missing = [...said.keys()].filter((n) => !have.has(n)).sort();
  const extra = [...have.keys()].filter((n) => !said.has(n)).sort();
  const differences = [
    ...(missing.length ? [`with a size in the run's report, none in the .blend: ${names(missing)}`] : []),
    ...(extra.length ? [`with a size in the .blend, none in the run's report: ${names(extra)}`] : []),
  ];
  for (const [name, r] of [...said].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const k = have.get(name);
    if (!k) continue;
    if (r.type !== k.type) differences.push(`${name}: the run reported a ${r.type}; the second pass read a ${k.type}`);
    else if (!near(r.min, k.min) || !near(r.max, k.max) || !near(r.size, k.size)) differences.push(`${name}: the run reported ${boxText(r)}; the second pass read ${boxText(k)}`);
  }
  if (!sameUnits(rep.units, got.units)) differences.push(`units: the run reported ${unitsText(rep.units)}; the second pass read ${unitsText(got.units)}`);
  const listed = differences.length > MAX_DIFFERENCES ? [...differences.slice(0, MAX_DIFFERENCES), `and ${differences.length - MAX_DIFFERENCES} more differences`] : differences;
  return { ...base, passed: !differences.length, differences: listed };
}

/**
 * What the run's result reported against what the second pass read, check by check, for each thing the result
 * reported: its objects (the active scene's, by name), its materials (each in the file, and every material the scene's
 * objects use reported), its active camera, and, when reported, the render resolution, the frame range and (R4, H37)
 * the objects' sizes (compareDimensions). A
 * material in the file that no object uses and the result did not report is noted, not counted. `matches` when every
 * check made passes and at least one of objects, materials and camera was compared; `differs` when one does not;
 * `failed` when none of those three could be compared.
 */
export function compareBlendReadback(reported: BlendReported, read: BlendRead): { verdict: BlendVerdict; checks: BlendCheck[]; reason?: string } {
  const checks: BlendCheck[] = [];
  if (reported.objects) {
    const inFile = read.objects.map((o) => o.name);
    if (read.objects_total > read.objects.length) {
      checks.push({ name: 'objects', reported: reported.objects, read: inFile, passed: null, differences: [], note: `the second pass listed ${read.objects.length} of the scene's ${read.objects_total} objects, so the objects were not compared` });
    } else {
      const have = new Set(inFile);
      const said = new Set(reported.objects);
      const missing = [...said].filter((x) => !have.has(x)).sort();
      const extra = [...have].filter((x) => !said.has(x)).sort();
      const differences = [
        ...(missing.length ? [`reported, not in the .blend's scene: ${names(missing)}`] : []),
        ...(extra.length ? [`in the .blend's scene, not reported: ${names(extra)}`] : []),
      ];
      checks.push({ name: 'objects', reported: reported.objects, read: inFile, passed: !differences.length, differences });
    }
  }
  if (reported.materials) {
    const inFile = new Set(read.materials.map((m) => m.name));
    const used = new Set(read.materials_used);
    const said = new Set(reported.materials);
    const missing = [...said].filter((x) => !inFile.has(x)).sort();
    const unreported = [...used].filter((x) => !said.has(x)).sort();
    const idle = [...inFile].filter((x) => !used.has(x) && !said.has(x)).sort();
    const differences = [
      ...(missing.length ? [`reported, not in the .blend: ${names(missing)}`] : []),
      ...(unreported.length ? [`used by the scene's objects, not reported: ${names(unreported)}`] : []),
    ];
    checks.push({
      name: 'materials', reported: reported.materials, read: { in_file: [...inFile].sort(), used: [...used].sort() }, passed: !differences.length, differences,
      ...(idle.length ? { note: `in the .blend but used by no object of its scene, and not reported (not counted): ${names(idle)}` } : {}),
    });
  }
  if ('camera' in reported) {
    const same = (reported.camera ?? null) === read.active_camera;
    checks.push({ name: 'camera', reported: reported.camera ?? null, read: read.active_camera, passed: same, differences: same ? [] : [`the .blend's active camera is ${read.active_camera ?? 'none'}; the result reported ${reported.camera ?? 'none'}`] });
  }
  if (reported.resolution) {
    const same = sameList(reported.resolution, read.render_resolution);
    checks.push({ name: 'resolution', reported: reported.resolution, read: read.render_resolution, passed: same, differences: same ? [] : [`the .blend renders at ${read.render_resolution?.join(' x ') ?? 'an unknown size'}; the result reported ${reported.resolution.join(' x ')}`] });
  }
  if (reported.frame_range) {
    const same = sameList(reported.frame_range, read.frame_range);
    checks.push({ name: 'frame range', reported: reported.frame_range, read: read.frame_range, passed: same, differences: same ? [] : [`the .blend's frames are ${read.frame_range?.join('–') ?? 'unknown'}; the result reported ${reported.frame_range.join('–')}`] });
  }
  // R4 (H37): the object sizes, when the run reported them (or said why it could not)
  if (reported.bounds || reported.bounds_error) checks.push(compareDimensions(reported, read));
  const core = checks.filter((c) => CORE_CHECKS.includes(c.name) && c.passed !== null);
  if (checks.some((c) => c.passed === false)) return { verdict: 'differs', checks };
  if (!core.length) {
    const unreadable = reported.unreadable?.length ? ` (${reported.unreadable.join('; ')})` : '';
    return { verdict: 'failed', checks, reason: `the run's result file reported none of objects, materials or camera in a form that could be compared${unreadable}, so the second pass had nothing to compare with` };
  }
  return { verdict: 'matches', checks };
}

/** The differences, one sentence (for the record's why, a notice, a receipt). */
export const differencesText = (checks: BlendCheck[]): string => checks.filter((c) => c.passed === false).map((c) => `${c.name}: ${c.differences.join('; ')}`).join('; ');

// ── the sizes before and after (R4, H37) ──────────────────────────────────────

/** A judged-ok native Blender run of the same script, from before the flow started: the sizes its result reported. */
export interface DimensionsBefore {
  /** the run's token: its folder is .timmy/native/<run>/ */
  run: string;
  started_at: string;
  /** when its last judgement (outcome ok) was made */
  judged_at: string | null;
  /** the script it ran, as submitted: the flow's script before the agent ran (the same path and sha256) */
  script: { path: string; sha256: string };
  /** its result file (project-relative), and that file's sha256 as read when the flow started */
  result: string;
  result_sha256: string | null;
  bounds: BlendBounds;
}

/**
 * The newest native Blender run (.timmy/native/<run>/) that ran this script's exact bytes (its submitted input: the
 * same path and sha256), started before `startedAt` and was last judged ok, with the object sizes its result file
 * reported (the result still naming that run and script). Otherwise why there are no sizes from before. Read only.
 */
export function findBeforeRun(root: string, script: { path: string; sha256: string }, startedAt: string): { ok: true; before: DimensionsBefore } | { ok: false; why: string } {
  const label = `${script.path} as it was (sha256 ${script.sha256.slice(0, 12)})`;
  let runs: ReturnType<typeof listNativeRuns>;
  try { runs = listNativeRuns(root); } catch { return { ok: false, why: 'the project\'s native runs could not be read' }; }
  for (const r of runs) {
    if (r.app !== 'blender' || !(r.started_at < startedAt)) continue;
    const last = r.verdicts.at(-1);
    if (!last || last.outcome !== 'ok') continue;
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(root, r.run); } catch { continue; }
    if (!rec || rec.job.input?.path !== script.path || rec.job.input?.sha256 !== script.sha256) continue;
    const short = r.run.slice(0, 8);
    const which = `run ${short}, a judged-ok Blender run of ${label},`;
    if (rec.result.state !== 'read' || !rec.job.result) return { ok: false, why: `${which} has no result file Timmy can read now` };
    const data = objOf(rec.result.data);
    if (!data || data.run !== r.run || data.script_sha256 !== script.sha256) return { ok: false, why: `${which} has a result file that no longer names that run and script` };
    if (data.bounds === undefined || data.bounds === null) return { ok: false, why: `${which} reported no object sizes (it ran before Timmy reported them)` };
    const p = parseBounds(data.bounds);
    if (!p.ok) return { ok: false, why: `${which} ${p.failed ? `could not report its object sizes (${p.error})` : `reported its object sizes in a form Timmy does not read (${p.error})`}` };
    const at = resolveInside(root, rec.job.result);
    return {
      ok: true,
      before: {
        run: r.run, started_at: r.started_at, judged_at: typeof last.judged_at === 'string' ? last.judged_at : null, script: { ...script },
        result: rec.job.result, result_sha256: 'error' in at ? null : sha256File(at.path) ?? null, bounds: p.bounds,
      },
    };
  }
  return { ok: false, why: `no judged-ok Blender run of ${label} from before this flow` };
}

/** An object whose size changed between the run from before and Blender's run in this flow; null: it had no size there. */
export interface DimensionsChange { name: string; before: number[] | null; after: number[] | null }

/** The record's `dimensions`: which objects changed size, against what, and how far the second pass agrees. */
export interface DimensionsSummary {
  scope: string;
  /** Blender units; each value compared within this tolerance */
  tolerance: number;
  /** the scene's unit settings as Blender's run reported them: what a unit is shown as */
  units: BlendUnits | null;
  /** the sizes after: Blender's run's own report (its result's bounds), and the second pass's dimensions check of it */
  after: { from: string; objects: number; agrees: boolean | null; agreement: string };
  /** the sizes before, with the run they come from; null when there is none (before_why says why) */
  before: DimensionsBefore | null;
  before_why?: string;
  /** objects whose size changed (or that have a size only before, or only after), by name; empty when before is null */
  changed: DimensionsChange[];
  /** objects with a size before and after, the same within the tolerance */
  unchanged: number;
  /** when either report listed only some of its objects: only those were set against each other */
  listed_only?: string;
}

const AFTER_FROM = 'Blender\'s run (the bounds in its result file)';

/**
 * The sizes before and after: the earlier run's report against Blender's run's in this flow, object by object (size
 * per axis, within DIMENSIONS_TOLERANCE), and the second pass's word on the sizes after (its dimensions check, or why
 * there is none).
 */
export function dimensionsSummary(o: { after: BlendBounds; before: DimensionsBefore | null; beforeWhy?: string; check?: BlendCheck; notCompared?: string }): DimensionsSummary {
  const c = o.check;
  const agreement = c?.passed === true ? 'the second pass agrees'
    : c?.passed === false ? 'the second pass differs: see its dimensions check'
      : c ? `not compared by the second pass: ${c.note ?? 'no reason given'}`
        : `not compared by the second pass${o.notCompared ? `: ${o.notCompared}` : ''}`;
  const out: DimensionsSummary = {
    scope: DIMENSIONS_SCOPE, tolerance: DIMENSIONS_TOLERANCE, units: o.after.units,
    after: { from: AFTER_FROM, objects: o.after.objects_total, agrees: c ? c.passed : null, agreement },
    before: o.before, ...(o.before ? {} : { before_why: o.beforeWhy ?? 'no run from before the flow was looked for' }),
    changed: [], unchanged: 0,
  };
  if (!o.before) return out;
  const was = new Map(o.before.bounds.objects.map((x) => [x.name, x.size]));
  const now = new Map(o.after.objects.map((x) => [x.name, x.size]));
  const order = [...new Set([...now.keys(), ...was.keys()])].sort();
  for (const name of order) {
    const b = was.get(name) ?? null;
    const a = now.get(name) ?? null;
    if (a && b && near(a, b)) out.unchanged++;
    else out.changed.push({ name, before: b, after: a });
  }
  const partial = [o.before.bounds, o.after].filter((x) => x.objects_total > x.objects.length);
  if (partial.length) out.listed_only = 'a report listed only some of its objects with a size: only the objects listed in both were set against each other';
  return out;
}

/**
 * Whether a record's `dimensions` (read from its file, which anyone may edit) has the shape Timmy writes, so it can be
 * put in words; a record that does not is shown as such, never guessed at.
 */
export function isDimensionsSummary(v: unknown): v is DimensionsSummary {
  const d = objOf(v);
  const a = objOf(d?.after);
  if (!d || !a || !finite(a.objects) || !text(a.agreement) || !finite(d.unchanged) || !finite(d.tolerance) || !Array.isArray(d.changed)) return false;
  if (!(d.units === null || objOf(d.units))) return false;
  const size = (x: unknown): boolean => x === null || numbers(x, 3) !== null;
  if (!d.changed.every((c) => { const o = objOf(c); return !!o && text(o.name) && size(o.before) && size(o.after); })) return false;
  if (d.before === null) return d.before_why === undefined || typeof d.before_why === 'string';
  const b = objOf(d.before);
  return !!b && text(b.run) && (b.judged_at === null || typeof b.judged_at === 'string') && (d.listed_only === undefined || typeof d.listed_only === 'string');
}

const sizeChangeText = (x: DimensionsChange): string => `${x.name} ${x.before ? sizeText(x.before) : '(new)'} → ${x.after ? sizeText(x.after) : '(gone)'}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The summary in words, for the card and the REPL's end lines: `sizes`, the objects whose size changed and a count of
 * the rest ("Cube 2 × 2 × 2 → 3 × 3 × 3 (Blender's report; the second pass agrees) · 3 other objects unchanged in
 * size"), or why the sizes before are unknown; `detail`, where the sizes before come from, the units and the tolerance.
 */
export function dimensionsText(s: DimensionsSummary, max = 12): { sizes: string; detail: string } {
  const how = `Blender's report; ${s.after.agreement}`;
  const units = `Blender units (${unitsText(s.units)}); each within ${toleranceText(s.tolerance)}`;
  if (!s.before) {
    return { sizes: `sizes before the change unknown: ${s.before_why ?? 'no run from before'}; after: ${plural(s.after.objects, 'object')} with a size (${how})`, detail: units };
  }
  const shown = s.changed.slice(0, max).map(sizeChangeText);
  const more = s.changed.length > max ? ` and ${s.changed.length - max} more (the record lists them)` : '';
  const rest = s.unchanged ? ` · ${plural(s.unchanged, 'other object')} unchanged in size` : '';
  const sizes = s.changed.length
    ? `${shown.join(', ')}${more} (${how})${rest}`
    : `no object changed size: ${plural(s.unchanged, 'object')} with a size, each as before (${how})`;
  const b = s.before;
  return { sizes, detail: `before: run ${b.run.slice(0, 8)}'s report (judged ok${b.judged_at ? ` ${b.judged_at.slice(0, 16).replace('T', ' ')} UTC` : ''})${s.listed_only ? ` · ${s.listed_only}` : ''} · ${units}` };
}

// ── the flow record ──────────────────────────────────────────────────────────────

export type BlenderFlowStep = 'prepare' | 'agent' | 'checks' | 'blender' | 'readback' | 'record';

/** A Blender flow's record, results/flows/<flow-id>.json: the tray flow's schema (timmy.flow/1) with target 'blender'. */
export interface BlenderFlowRecord {
  flow: 1;
  schema: typeof FLOW_SCHEMA;
  id: string;
  kind: 'iterate';
  target: 'blender';
  instruction: string;
  project: string;
  started_at: string;
  ended_at?: string;
  outcome: FlowOutcome;
  ended_in?: BlenderFlowStep;
  why?: string;
  script: {
    path: string;
    /** as read before the agent ran; `kept`: a copy of those bytes in the flow's folder */
    before: { sha256: string; bytes: number; lines: number; kept?: string };
    after?: { sha256: string; bytes: number; lines: number };
    change?: ScriptChange;
    syntax?: SyntaxCheck;
  };
  agent?: {
    run: string; agent: string; version: string | null; route: string; where: string; model: string | null; job: string;
    outcome?: string; why?: string;
    files_changed?: Array<{ path: string; how: 'added' | 'changed' | 'deleted'; sha256_before?: string | null; sha256_after?: string | null }>;
    others?: OtherChange[];
    result?: string; transcript?: string; progress?: string;
    cost_usd?: number | null; cost_basis?: string;
    receipt?: string;
  };
  blender?: {
    job?: string;
    /** the native run's token and its own folder (.timmy/native/<run>/: job.json, result.json, verdicts.jsonl) */
    run?: string;
    record?: string;
    state: string;
    /** the judgement of the run by its result file (src/native judgeNativeJob) */
    outcome?: 'ok' | 'failed' | 'unknown';
    why?: string;
    blender_version?: string | null;
    /** the read-only copy of the script Blender ran, kept in the run's folder */
    copy?: { path: string; sha256: string };
    result?: { path: string; sha256?: string };
    files?: Array<{ path: string; sha256?: string; change?: string }>;
    blend?: { path: string; sha256: string };
    renders?: Array<{ path: string; sha256: string }>;
    reported?: BlendReported;
    log?: string;
    failure_files?: string[];
    receipt?: string;
    error?: string;
  };
  readback?: {
    job?: string;
    state: string;
    worker?: { name: string; version: string };
    blender_version?: string | null;
    /** the .blend read, with Timmy's own sha256 of it before the second pass started and after it ended */
    blend?: { path: string; sha256_before: string; sha256_after?: string };
    read?: BlendRead;
    checks?: BlendCheck[];
    verdict?: BlendVerdict;
    reason?: string;
    log?: string;
    receipt?: string;
    scope: string;
  };
  /** R4 (H37): the objects' sizes before and after, when Blender's run was judged ok and reported them */
  dimensions?: DimensionsSummary;
  receipts: { agent?: string; blender?: string; readback?: string };
  child_receipts: string[];
  doctrine: string;
}

/** Whether a record (as read from its file) is a Blender flow's. */
export function isBlenderFlowRecord(r: unknown): r is BlenderFlowRecord {
  const o = objOf(r);
  return !!o && o.kind === 'iterate' && o.target === 'blender' && !!objOf(o.script);
}

/** A Blender flow's record in a few words for /iterate's list ("blender scene.py +1 −1 lines in 1 place"); '' for any other record. */
export function blenderFlowSummary(r: unknown): string {
  if (!isBlenderFlowRecord(r)) return '';
  const p = typeof r.script.path === 'string' ? r.script.path : '?';
  const c = objOf(r.script.change) && finite(r.script.change!.added) ? ` ${changeText(r.script.change!)}` : '';
  return `blender ${p}${c}`;
}
