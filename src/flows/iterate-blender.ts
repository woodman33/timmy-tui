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
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_SKIP, type ChangeSet } from '../code-agents/index.js';
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
    `Do this by changing the file ${o.scriptRel} in this project, and nothing else. It is a Python script for Blender's own Python (bpy): after you finish, Timmy runs it headless (blender -b --factory-startup --python ${o.scriptRel}), judges the run by the result file it writes, then opens the .blend it saved in a second Blender process and compares what that file holds with what the result reported (objects, materials, camera).`,
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
  return {
    ok: true, worker, blender_version: strOrNull(found.blender_version), ...(text(found.python) ? { python: found.python } : {}),
    file: { name: file.name as string, opened: strOrNull(file.opened) },
    read: {
      scene: strOrNull(found.scene), objects, objects_total: found.objects_total as number, materials, materials_used: found.materials_used as string[],
      cameras, active_camera: (found.active_camera as string | null), scenes,
      frame_range: numbers(found.frame_range, 2), render_resolution: numbers(found.render_resolution, 2), resolution_percentage: numOrNull(found.resolution_percentage),
      units: objOf(found.units) ?? null,
    },
  };
}

// ── what the run reported, and the comparison ──────────────────────────────────

/** What the run's result file reported that the second pass can be compared with; `unreadable`: fields there in a form that cannot be. */
export interface BlendReported { objects?: string[]; materials?: string[]; camera?: string | null; resolution?: number[]; frame_range?: number[]; unreadable?: string[] }

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
  if (unreadable.length) out.unreadable = unreadable;
  return out;
}

export type BlendCheckName = 'objects' | 'materials' | 'camera' | 'resolution' | 'frame range';
export interface BlendCheck {
  name: BlendCheckName;
  /** what the run's result file reported, and what the second pass read */
  reported: unknown;
  read: unknown;
  /** null: not compared (the note says why) */
  passed: boolean | null;
  differences: string[];
  note?: string;
}
export type BlendVerdict = 'matches' | 'differs' | 'failed';

const sameList = (a: number[], b: number[] | null): boolean => !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What the run's result reported against what the second pass read, check by check, for each thing the result
 * reported: its objects (the active scene's, by name), its materials (each in the file, and every material the scene's
 * objects use reported), its active camera, and, when reported, the render resolution and the frame range. A
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
