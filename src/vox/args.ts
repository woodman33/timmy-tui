/**
 * Timmy VoxVision (round R4, helper H49; moved here by H61 so the board and the viewer can use it without an import
 * cycle): a project path written as one argument that the REPL's splitArgs reads back exactly.
 */
import { splitArgs } from '../project/intake.js';

/** A project path written so splitArgs reads it back exactly (the board's buttons and a record's command use it). */
export function voxArg(rel: string): string | null {
  const arg = /^[^\s"'\\]+$/.test(rel) ? rel : `"${rel.replace(/["\\]/g, '\\$&')}"`;
  const back = splitArgs(arg);
  return back.length === 1 && back[0] === rel ? arg : null;
}
