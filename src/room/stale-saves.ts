/**
 * Round R4 (H60): a save from the live board that the board refused because its file changed on disk after the board
 * showed it (a stale save), as this REPL's board knows it. The board's three edits name their file and the sha256 the
 * page was drawn from (set-params: the recipe's parameter file and `base`; set-scad-params: the model's parameter file and
 * `base`; save-workflow: the document and `sha256`), and src/repl/board-edits.ts refuses a save (409) whose file is not
 * those bytes now. Kept in this REPL's memory only, per project; nothing is written.
 *
 * A stale save stays a decision while the file is still the bytes it was when the save was refused: a save of it that
 * the board accepts, or any other change to the file, ends it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paramsFileFor } from '../native/scad-params.js';
import { paramsPath, PARAMS_RECIPES } from '../recipes/params-file.js';

export interface StaleSave {
  /** the file, relative to the project */
  file: string;
  /** what the board was saving in it, in words */
  what: string;
  /** when the board refused the save (ms) */
  at: number;
  /** the sha256 the board had shown (null: it had shown no file there) */
  shown: string | null;
  /** the file's sha256 when the save was refused (null: no file there) */
  found: string | null;
  /** the request (operation) the refused save was */
  operation?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const READ_MAX = 2 * 1024 * 1024;

/** A path inside the project as '/'-separated parts, or null. */
function inProject(p: string): string | null {
  if (!p || p.includes('\0') || p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
}

/** The file an edit body saves, what it saves, and the sha256 the board showed; undefined for any other body. */
export function editTarget(body: unknown): { file: string; what: string; shown: string | null } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const o = body as Record<string, unknown>;
  if (o.action === 'set-params' && typeof o.recipe === 'string' && Object.hasOwn(PARAMS_RECIPES, o.recipe) && (o.base === null || (typeof o.base === 'string' && HEX64.test(o.base)))) {
    return { file: paramsPath(o.recipe), what: `the ${o.recipe} recipe's parameters`, shown: o.base as string | null };
  }
  if (o.action === 'set-scad-params' && typeof o.model === 'string' && /\.scad$/i.test(o.model) && typeof o.base === 'string' && HEX64.test(o.base)) {
    const file = inProject(paramsFileFor(o.model));
    return file ? { file, what: `the OpenSCAD parameters of ${o.model}`, shown: o.base } : undefined;
  }
  if (o.action === 'save-workflow' && typeof o.doc === 'string' && typeof o.sha256 === 'string' && HEX64.test(o.sha256)) {
    const file = inProject(o.doc);
    return file ? { file, what: `the workflow blocks of ${file}`, shown: o.sha256 } : undefined;
  }
  return undefined;
}

/** A project file's sha256 now: null when nothing is there, undefined when it cannot be read (a link, a folder, too large). */
export function fileSha(root: string, rel: string): string | null | undefined {
  try {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > READ_MAX) return undefined;
    return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
}

/** The board's refused saves in this REPL, per project folder. */
export class StaleSaves {
  private readonly saves = new Map<string, StaleSave & { root: string }>();

  /**
   * What an edit's answer means for its file: refused (409) while the file is not the bytes the board showed, a stale
   * save, kept; accepted (200), any stale save of that file ends. Every other answer changes nothing here.
   */
  note(root: string, body: unknown, answer: { status: number }, o: { now?: number; operation?: string } = {}): void {
    const t = editTarget(body);
    if (!t) return;
    const key = `${root}\0${t.file}`;
    if (answer.status === 200) { this.saves.delete(key); return; }
    if (answer.status !== 409) return;
    const found = fileSha(root, t.file);
    if (found === undefined || found === t.shown) return;
    this.saves.set(key, { root, file: t.file, what: t.what, at: o.now ?? Date.now(), shown: t.shown, found, ...(o.operation ? { operation: o.operation } : {}) });
  }

  /** This project's stale saves that still hold: the file is still the bytes it was when the save was refused. Newest first. */
  list(root: string): StaleSave[] {
    const out: StaleSave[] = [];
    for (const [key, s] of this.saves) {
      if (s.root !== root) continue;
      const now = fileSha(root, s.file);
      if (now !== undefined && now !== s.found) { this.saves.delete(key); continue; }
      const { root: _root, ...save } = s;
      out.push(save);
    }
    return out.sort((a, b) => b.at - a.at);
  }
}
