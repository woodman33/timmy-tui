/**
 * Round R4 (/iterate scad and /iterate freecad, helper H33): what the two native flows share, without the REPL. Each
 * is the connected workflow the tray and Blender flows are: a local code agent changes one file, the app runs as a
 * judged native job, a readback compares, and the flow is kept as a record (results/flows/<flow-id>.json, the tray
 * flow's schema timmy.flow/1, with `target: 'scad'` or `target: 'freecad'`).
 *
 * The script pieces below (the line diff, the Python syntax check, the judge of what the agent changed, the folders the
 * agent's comparison does not see) are COPIED from src/flows/iterate-blender.ts (round R4, H26), not imported or moved:
 * another helper edits that file this round. They behave the same; once both settle, one copy can replace the other.
 */
import { SNAPSHOT_SKIP, type ChangeSet, type ComparedScope } from '../code-agents/index.js';
import { DOCTRINE_15, FLOW_SCHEMA, judgeAgentChanges, type AgentChanges, type FlowOutcome, type OtherChange } from './iterate.js';

export { DOCTRINE_15 };

/** The agent is given the whole file it may change, so the native flows take files up to this size. */
export const NATIVE_FILE_MAX_BYTES = 256 * 1024;
/** How long the syntax check's python3 may take. */
export const SYNTAX_TIMEOUT_MS = 15_000;

const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (finite(v) ? v : null);

// ── where the file may be, and what the agent changed ───────────────────────────

/**
 * Why a file there cannot be iterated, or undefined: the agent's before/after snapshot (src/code-agents) does not look
 * into .git, node_modules, .timmy or dist, so a change to a file inside one could not be seen. Compared without case.
 */
export function unseenFolder(rel: string): string | undefined {
  const skip = new Set([...SNAPSHOT_SKIP].map((s) => s.toLowerCase()));
  return rel.split('/').slice(0, -1).find((part) => skip.has(part.toLowerCase()));
}

/**
 * The agent's own before/after snapshot, judged for a native flow: only `fileRel` may have changed (the tray's
 * judgeAgentChanges with that file as the one file, its sentences naming it).
 */
export function judgeFileChanges(files: (ChangeSet & { truncated?: boolean }) | undefined, fileRel: string): AgentChanges {
  const j = judgeAgentChanges(files, fileRel);
  if (j.ok) return j;
  if (j.reason === 'missing') return { ...j, why: `the agent run left no record of what it changed, so whether it changed only ${fileRel} is not known` };
  if (j.reason === 'incomplete') return { ...j, why: `the project has more files than the agent run compared, so whether it changed only ${fileRel} is not known` };
  return j;
}

// ── a script's change, line by line ─────────────────────────────────────────────

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

/** Lines in a text, as the records count them (a final newline ends the last line). */
export const lineCount = (t: string): number => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);

// ── the Python syntax check ─────────────────────────────────────────────────────

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

/** The check in words, naming the app whose own Python it is not (for the notices, the record's reason and the board). */
export function syntaxWords(s: SyntaxCheck | undefined, app: string): string {
  if (!s) return 'not checked as Python';
  if (!s.checked) return `not checked as Python: ${s.why}`;
  if (s.ok) return `parses as Python (an AST parse by ${s.by} ${s.python}; this machine's python3, not ${app}'s own)`;
  return `does not parse as Python: ${s.error}${s.line !== null ? `, line ${s.line}` : ''} (an AST parse by ${s.by} ${s.python})`;
}

// ── the record's shared parts ───────────────────────────────────────────────────

/** The agent's part of a flow record (as the tray and Blender flows keep it). */
export interface FlowAgentPart {
  run: string; agent: string; version: string | null; route: string; where: string; model: string | null; job: string;
  outcome?: string; why?: string;
  files_changed?: Array<{ path: string; how: 'added' | 'changed' | 'deleted'; sha256_before?: string | null; sha256_after?: string | null }>;
  /** files other than the one it may change that it changed (the flow stopped before the app ran; nothing was reverted) */
  others?: OtherChange[];
  /** R4 review (R4-2): what the check compared (src/flows/iterate.ts FlowRecord) */
  compared?: ComparedScope;
  result?: string; transcript?: string; progress?: string;
  cost_usd?: number | null; cost_basis?: string;
  receipt?: string;
}

/** The two native flows' targets, as their records name them. */
export type NativeTarget = 'scad' | 'freecad';
export const NATIVE_TARGETS: readonly NativeTarget[] = ['scad', 'freecad'];

/** What every native flow record holds (results/flows/<flow-id>.json, schema timmy.flow/1). */
export interface NativeFlowRecordBase {
  flow: 1;
  schema: typeof FLOW_SCHEMA;
  id: string;
  kind: 'iterate';
  target: NativeTarget;
  instruction: string;
  project: string;
  /** Round R4 (H51): the operation (one request) that started the flow; absent before, or outside one */
  operation?: string;
  started_at: string;
  ended_at?: string;
  outcome: FlowOutcome;
  ended_in?: string;
  why?: string;
  agent?: FlowAgentPart;
  receipts: Record<string, string | undefined>;
  child_receipts: string[];
  doctrine: string;
}

/** Whether a record (as read from its file) is a native flow's (scad or freecad). */
export function isNativeFlowRecord(r: unknown): r is NativeFlowRecordBase {
  const o = objOf(r);
  return !!o && o.kind === 'iterate' && (o.target === 'scad' || o.target === 'freecad');
}

/** A number as the records and notices show it: up to 6 decimals, -0 as 0. */
export const numText = (n: number | null | undefined): string => {
  if (!finite(n)) return 'none';
  const v = Math.round(n * 1e6) / 1e6;
  return Object.is(v, -0) ? '0' : String(v);
};
/** Three sizes as "100 x 60 x 6". */
export const sizeText = (v: unknown): string => (Array.isArray(v) && v.length === 3 && v.every(finite) ? v.map(numText).join(' x ') : 'unknown');
