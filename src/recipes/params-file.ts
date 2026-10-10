/**
 * Round R4: a recipe's parameter file in the project, `recipes/tray.params.json`. One file, three users:
 * /recipe tray takes it as its defaults (name=value words still override), /iterate gives it to the local
 * code agent as the one file it may change, and the live board's parameter card saves its form into it.
 *
 * The file holds the schema, the recipe id and the named parameters in millimetres, nothing else:
 *   { "schema": "timmy.recipe-params/1", "recipe": "enclosure.tray/1", "parameters": { "width": 140, ... } }
 * It is checked by the same rules as a /recipe request (requestFrom, then tray.ts validate), so a file the
 * recipe would refuse is refused here, with the reason, and never quietly replaced by the defaults.
 * A write replaces the file atomically (a temporary file renamed over it) and first keeps the previous
 * bytes under .timmy/params-history/, so no saved version is lost. A symbolic link at the file's place is
 * refused: Timmy writes this file, not whatever the link points at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validate } from '../../lanes/recipes/tray.js';
import { PARAMETER_NAMES, RECIPE_ID, readCard, requestFrom } from './index.js';

export const PARAMS_SCHEMA = 'timmy.recipe-params/1';
/** Recipes that have a parameter file: the short name /recipe uses, and its card id. */
export const PARAMS_RECIPES: Record<string, string> = { tray: RECIPE_ID };
/** A parameter file is a few lines; anything larger is not one. */
const MAX_BYTES = 16 * 1024;

export const paramsPath = (name = 'tray'): string => `recipes/${name}.params.json`;
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export interface ParamsFile { schema: string; recipe: string; parameters: Record<string, number> }

export type ParamsRead =
  /** the file, checked: `parameters` is the full set the recipe would run (card defaults, then the file) */
  | { ok: true; exists: true; path: string; sha256: string; bytes: number; parameters: Record<string, number> }
  /** no file: the card's defaults */
  | { ok: true; exists: false; path: string; parameters: Record<string, number> }
  | { ok: false; path: string; error: string; sha256?: string };

/** The parameters a request with these values would carry, checked by the recipe's own rules; or why not. */
export function checkParams(values: Record<string, unknown>): { ok: true; parameters: Record<string, number> } | { ok: false; error: string } {
  const r = requestFrom(values);
  if (!r.ok) return r;
  try { validate(r.request); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  return { ok: true, parameters: r.request.parameters };
}

/** Parses and checks a parameter file's text; `parameters` is the full set (card defaults, then the file's). */
export function parseParams(text: string): { ok: true; parameters: Record<string, number> } | { ok: false; error: string } {
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) { return { ok: false, error: `not JSON (${e instanceof Error ? e.message : String(e)})` }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'not a JSON object' };
  const f = json as Record<string, unknown>;
  const extra = Object.keys(f).filter((k) => !['schema', 'recipe', 'parameters'].includes(k));
  if (extra.length) return { ok: false, error: `unexpected field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}: a parameter file holds schema, recipe and parameters only` };
  if (f.schema !== PARAMS_SCHEMA) return { ok: false, error: `schema must be ${PARAMS_SCHEMA}` };
  if (f.recipe !== RECIPE_ID) return { ok: false, error: `recipe must be ${RECIPE_ID}` };
  const p = f.parameters;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'parameters must be an object of numbers' };
  for (const [k, v] of Object.entries(p)) {
    if (!(PARAMETER_NAMES as readonly string[]).includes(k)) return { ok: false, error: `no parameter ${k}: ${PARAMETER_NAMES.join(', ')}` };
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${k} must be a number of millimetres` };
  }
  return checkParams(p as Record<string, unknown>);
}

/** The project-relative path checked: inside the project, no link at the file's place or on the way. */
function place(root: string, name: string): { ok: true; rel: string; abs: string } | { ok: false; rel: string; error: string } {
  const rel = paramsPath(name);
  if (!(name in PARAMS_RECIPES)) return { ok: false, rel, error: `no recipe ${name} has a parameter file (${Object.keys(PARAMS_RECIPES).join(', ')})` };
  const abs = path.join(root, rel);
  for (const p of [path.join(root, 'recipes'), abs]) {
    try { if (fs.lstatSync(p).isSymbolicLink()) return { ok: false, rel, error: `${path.relative(root, p)} is a symbolic link; Timmy reads and writes the parameter file only in place` }; } catch { /* absent */ }
  }
  return { ok: true, rel, abs };
}

/** Reads the parameter file, if there is one, and checks it. */
export function readParams(root: string, name = 'tray'): ParamsRead {
  const at = place(root, name);
  if (!at.ok) return { ok: false, path: at.rel, error: at.error };
  let buf: Buffer;
  try {
    const st = fs.statSync(at.abs);
    if (!st.isFile()) return { ok: false, path: at.rel, error: 'not a regular file' };
    if (st.size > MAX_BYTES) return { ok: false, path: at.rel, error: `larger than ${MAX_BYTES} bytes: not a parameter file` };
    buf = fs.readFileSync(at.abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, exists: false, path: at.rel, parameters: { ...readCard().parameters } };
    return { ok: false, path: at.rel, error: e instanceof Error ? e.message : String(e) };
  }
  const parsed = parseParams(buf.toString('utf8'));
  if (!parsed.ok) return { ok: false, path: at.rel, error: parsed.error, sha256: sha(buf) };
  return { ok: true, exists: true, path: at.rel, sha256: sha(buf), bytes: buf.length, parameters: parsed.parameters };
}

/** The file's text for a full parameter set: stable key order, two-space indent, a final newline. */
export function paramsText(parameters: Record<string, number>): string {
  const ordered: Record<string, number> = {};
  for (const k of PARAMETER_NAMES) if (k in parameters) ordered[k] = parameters[k];
  return `${JSON.stringify({ schema: PARAMS_SCHEMA, recipe: RECIPE_ID, parameters: ordered }, null, 2)}\n`;
}

export type ParamsWrite =
  | { ok: true; path: string; sha256: string; bytes: number; parameters: Record<string, number>; previous?: { sha256: string; kept: string } }
  | { ok: false; path: string; error: string };

/**
 * Checks the values (over the card's defaults) and writes the file. The previous file, if any, is kept first
 * under .timmy/params-history/<name>/; if it cannot be kept, nothing is written.
 */
export function writeParams(root: string, values: Record<string, unknown>, name = 'tray'): ParamsWrite {
  const at = place(root, name);
  if (!at.ok) return { ok: false, path: at.rel, error: at.error };
  const checked = checkParams(values);
  if (!checked.ok) return { ok: false, path: at.rel, error: checked.error };
  const text = paramsText(checked.parameters);
  let previous: { sha256: string; kept: string } | undefined;
  try {
    let old: Buffer | undefined;
    try { old = fs.readFileSync(at.abs); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (old) {
      const h = sha(old);
      const keptRel = path.join('.timmy', 'params-history', name, `${new Date().toISOString().replace(/[:.]/g, '-')}-${h.slice(0, 12)}.json`);
      fs.mkdirSync(path.dirname(path.join(root, keptRel)), { recursive: true });
      fs.writeFileSync(path.join(root, keptRel), old, { flag: 'wx' });
      previous = { sha256: h, kept: keptRel.split(path.sep).join('/') };
    }
    fs.mkdirSync(path.dirname(at.abs), { recursive: true });
    const tmp = `${at.abs}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, at.abs);
  } catch (e) {
    return { ok: false, path: at.rel, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, path: at.rel, sha256: sha(text), bytes: Buffer.byteLength(text), parameters: checked.parameters, ...(previous ? { previous } : {}) };
}
