/**
 * Round R4 (helper H27): an OpenSCAD model's parameters, as /scad and run_native take them and as OpenSCAD gets
 * them (`-D name=value`).
 *
 * OpenSCAD appends each -D text to the model's source as a statement, so a value is code: only three kinds are
 * admitted, and each is written by Timmy, never passed on as typed:
 *   a number          finite, written as JavaScript writes it (60, 0.3, -2.5, 1e+21), which OpenSCAD reads back
 *   true or false
 *   text              written as an OpenSCAD string: in double quotes, with \ and " escaped; control
 *                     characters are refused
 * A name is [A-Za-z_][A-Za-z0-9_]* and not one of OpenSCAD's keywords. Vectors, ranges, expressions, special
 * variables ($fn) and anything else are refused, with the reason.
 *
 * The parameter file: `<model>.params.json` beside the model (box.scad: box.params.json), holding the schema, the
 * model's file name and the parameters, nothing else:
 *   { "schema": "timmy.scad-params/1", "model": "box.scad", "parameters": { "width": 60, "part": "both" } }
 * /scad takes it as the defaults and name=value words override them. A file that does not check is refused with
 * its reason, never quietly dropped; a symbolic link at its place is refused (Timmy reads it only in place).
 * This is the file a later /iterate for OpenSCAD would give a code agent to change.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../project/index.js';

export const SCAD_PARAMS_SCHEMA = 'timmy.scad-params/1';
export type ScadValue = number | boolean | string;
export const SCAD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** OpenSCAD's keywords: assigning one is a syntax error, so a name that is one is refused here. */
const KEYWORDS: ReadonlySet<string> = new Set(['include', 'use', 'module', 'function', 'if', 'else', 'let', 'assert', 'echo', 'for', 'each', 'true', 'false', 'undef']);
/** A number as /scad takes one: digits, an optional point and fraction, an optional exponent. */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** At most this many parameters, this long a text value, this large a parameter file. */
export const SCAD_LIMITS = { parameters: 100, text: 4096, file: 64 * 1024 } as const;

/** Why a parameter name is refused, or undefined when it is admitted. */
export function nameProblem(name: unknown): string | undefined {
  if (typeof name !== 'string' || !SCAD_NAME.test(name)) return `${String(name).slice(0, 60) || '(empty)'} is not a parameter name: letters, digits and _, not starting with a digit`;
  if (KEYWORDS.has(name)) return `${name} is an OpenSCAD keyword, not a parameter name`;
  return undefined;
}

/** Why a value is refused, or undefined when it is a number, true or false, or text OpenSCAD can be given. */
export function valueProblem(name: string, v: unknown): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? undefined : `${name} must be a finite number`;
  if (typeof v === 'boolean') return undefined;
  if (typeof v === 'string') {
    if (CONTROL.test(v)) return `${name}: text with a control character (a newline, a tab…) is refused`;
    if (v.length > SCAD_LIMITS.text) return `${name}: text longer than ${SCAD_LIMITS.text} characters is refused`;
    return undefined;
  }
  return `${name} must be a number, true or false, or text${Array.isArray(v) ? ' (a vector is refused)' : v === null ? ' (null is refused)' : ''}`;
}

/** A value as OpenSCAD source: a number as JavaScript writes it, true or false, or a double-quoted, escaped string. */
export function scadLiteral(v: ScadValue): string {
  if (typeof v === 'number') return Object.is(v, -0) ? '0' : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One -D argument: name=literal. Throws when the name or the value is refused. */
export function defineFor(name: string, v: ScadValue): string {
  const problem = nameProblem(name) ?? valueProblem(name, v);
  if (problem) throw new Error(problem);
  return `${name}=${scadLiteral(v)}`;
}

/** Checks a set of parameters (from the agent or a file): each name and value admitted. */
export function checkScadParams(values: unknown, where = 'parameters'): { ok: true; parameters: Record<string, ScadValue> } | { ok: false; error: string } {
  if (values === undefined) return { ok: true, parameters: {} };
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, error: `${where} must be an object of name: value` };
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length > SCAD_LIMITS.parameters) return { ok: false, error: `${where}: more than ${SCAD_LIMITS.parameters} parameters` };
  const parameters: Record<string, ScadValue> = {};
  for (const [k, v] of entries) {
    const problem = nameProblem(k) ?? valueProblem(k, v);
    if (problem) return { ok: false, error: problem };
    parameters[k] = v as ScadValue;
  }
  return { ok: true, parameters };
}

// ── /scad's words ─────────────────────────────────────────────────────────────

interface Piece { text: string; quote: '"' | "'" | null }

/** Shell-like words that remember which parts were quoted (a quoted value is text). */
function pieces(s: string): Piece[][] | { error: string } {
  const out: Piece[][] = [];
  let word: Piece[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) { word.push({ text: buf, quote }); buf = ''; quote = null; } else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (buf) { word.push({ text: buf, quote: null }); buf = ''; }
      quote = ch; started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) { word.push({ text: buf, quote: null }); buf = ''; }
      if (started) { out.push(word); word = []; started = false; }
      continue;
    }
    buf += ch; started = true;
  }
  if (quote) return { error: `a ${quote === '"' ? 'double' : 'single'} quote is not closed` };
  if (buf) word.push({ text: buf, quote: null });
  if (started) out.push(word);
  return out;
}

export interface ScadWords {
  model?: string;
  /** name=value words, in the order given */
  params: Record<string, ScadValue>;
  png: boolean;
}

export const SCAD_WORDS_USAGE = '/scad <model.scad> [name=value ...] [--png]';

/**
 * /scad's words: the model (one), name=value parameters and --png. A value is a number, true or false, or text in
 * quotes (label="Lid" or label='Lid'); an unquoted word that is none of those is refused, as is a name given twice.
 */
export function parseScadWords(text: string): ScadWords | { error: string } {
  const words = pieces(text.trim());
  if ('error' in words) return words;
  const out: ScadWords = { params: {}, png: false };
  for (const w of words) {
    const joined = w.map((p) => p.text).join('');
    const first = w[0];
    if (first.quote === null && first.text.startsWith('--')) {
      if (joined === '--png' && w.length === 1) { out.png = true; continue; }
      return { error: `unknown option ${joined}: /scad takes --png (Usage: ${SCAD_WORDS_USAGE})` };
    }
    const eq = first.quote === null ? first.text.indexOf('=') : -1;
    if (eq < 0) {
      if (out.model !== undefined) return { error: `one model per run: ${out.model} and ${joined} (a parameter is name=value)` };
      out.model = joined;
      continue;
    }
    const name = first.text.slice(0, eq);
    const problem = nameProblem(name);
    if (problem) return { error: `${joined}: ${problem}` };
    if (Object.hasOwn(out.params, name)) return { error: `${name} is given twice` };
    const rest: Piece[] = [...(first.text.length > eq + 1 ? [{ text: first.text.slice(eq + 1), quote: null }] : []), ...w.slice(1)];
    let value: ScadValue;
    if (rest.length === 1 && rest[0].quote !== null) value = rest[0].text;
    else if (rest.length === 1 && rest[0].quote === null) {
      const raw = rest[0].text;
      if (raw === 'true' || raw === 'false') value = raw === 'true';
      else if (NUMBER.test(raw)) value = Number(raw);
      else return { error: `${joined}: a value is a number, true or false, or text in quotes (${name}="${raw}")` };
    } else if (!rest.length) return { error: `${joined}: give ${name} a value (a number, true or false, or text in quotes)` };
    else return { error: `${joined}: text is one quoted value (${name}="…")` };
    const bad = valueProblem(name, value);
    if (bad) return { error: bad };
    out.params[name] = value;
  }
  if (Object.keys(out.params).length > SCAD_LIMITS.parameters) return { error: `more than ${SCAD_LIMITS.parameters} parameters` };
  return out;
}

// ── the parameter file ────────────────────────────────────────────────────────

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** The parameter file of a model (project-relative): <model>.params.json in the model's folder. */
export function paramsFileFor(modelRel: string): string {
  const posix = modelRel.replace(/\\/g, '/');
  const dir = path.posix.dirname(posix);
  const stem = path.posix.basename(posix).replace(/\.scad$/i, '');
  return dir === '.' ? `${stem}.params.json` : `${dir}/${stem}.params.json`;
}

/** Checks a parameter file's text against the model's file name. */
export function parseScadParams(text: string, modelName: string): { ok: true; parameters: Record<string, ScadValue> } | { ok: false; error: string } {
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) { return { ok: false, error: `not JSON (${e instanceof Error ? e.message : String(e)})` }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'not a JSON object' };
  const f = json as Record<string, unknown>;
  const extra = Object.keys(f).filter((k) => !['schema', 'model', 'parameters'].includes(k));
  if (extra.length) return { ok: false, error: `unexpected field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}: a parameter file holds schema, model and parameters only` };
  if (f.schema !== SCAD_PARAMS_SCHEMA) return { ok: false, error: `schema must be ${SCAD_PARAMS_SCHEMA}` };
  if (f.model !== modelName) return { ok: false, error: `model must be ${modelName}, the file it sits beside${typeof f.model === 'string' ? ` (it says ${f.model.slice(0, 80)})` : ''}` };
  return checkScadParams(f.parameters ?? {}, 'parameters');
}

export type ScadParamsRead =
  | { ok: true; exists: false; path: string }
  | { ok: true; exists: true; path: string; sha256: string; bytes: number; parameters: Record<string, ScadValue> }
  | { ok: false; path: string; error: string; sha256?: string };

/** Reads and checks the model's parameter file, when there is one. `modelRel` is relative to the project. */
export function readScadParams(root: string, modelRel: string): ScadParamsRead {
  const rel = paramsFileFor(modelRel);
  const at = resolveInside(root, rel);
  if ('error' in at) return { ok: false, path: rel, error: at.error };
  let st;
  try { st = lstatSync(path.join(root, rel)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, exists: false, path: rel };
    return { ok: false, path: rel, error: (e as Error).message };
  }
  if (st.isSymbolicLink()) return { ok: false, path: rel, error: `${rel} is a symbolic link; Timmy reads a parameter file only in place` };
  if (!st.isFile()) return { ok: false, path: rel, error: `${rel} is not a regular file` };
  if (st.size > SCAD_LIMITS.file) return { ok: false, path: rel, error: `${rel} is larger than ${SCAD_LIMITS.file} bytes: not a parameter file` };
  let buf: Buffer;
  try { buf = readFileSync(at.path); } catch (e) { return { ok: false, path: rel, error: (e as Error).message }; }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const parsed = parseScadParams(buf.toString('utf8'), path.posix.basename(toPosix(modelRel)));
  if (!parsed.ok) return { ok: false, path: rel, error: parsed.error, sha256 };
  return { ok: true, exists: true, path: rel, sha256, bytes: buf.length, parameters: parsed.parameters };
}

/** A parameter file's text: the schema, the model's file name and the parameters, two-space indent, a final newline. */
export function scadParamsText(modelName: string, parameters: Record<string, ScadValue>): string {
  const checked = checkScadParams(parameters);
  if (!checked.ok) throw new Error(checked.error);
  return `${JSON.stringify({ schema: SCAD_PARAMS_SCHEMA, model: modelName, parameters: checked.parameters }, null, 2)}\n`;
}

/** A parameter as a run used it, and where it came from. */
export interface ScadParam { value: ScadValue; from: 'file' | 'words' }

/** The file's parameters, then the words' (a word overrides the file): each with its source, and the -D arguments in that order. */
export function mergeScadParams(file: Record<string, ScadValue>, words: Record<string, ScadValue>): { params: Record<string, ScadParam>; defines: string[] } {
  const params: Record<string, ScadParam> = {};
  for (const [k, v] of Object.entries(file)) params[k] = { value: v, from: 'file' };
  for (const [k, v] of Object.entries(words)) params[k] = { value: v, from: 'words' };
  return { params, defines: Object.entries(params).map(([k, p]) => defineFor(k, p.value)) };
}

/**
 * The names with no `name = …` at the start of a line of the model's own text (comments removed): OpenSCAD defines
 * a -D name whether or not the model uses it, so a misspelt name changes nothing. A hint, not a check: an included
 * file may assign it, and an indented assignment inside a module also counts here.
 */
export function unassignedNames(modelText: string, names: string[]): string[] {
  const code = modelText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  return names.filter((n) => !new RegExp(`^[ \\t]*${n}[ \\t]*=(?!=)`, 'm').test(code));
}
