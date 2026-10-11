/**
 * Round R4 (helper H93): `/cloud …` in the REPL: the verbs of `timmy cloud` (src/cloud/commands.ts) in the REPL's lines.
 * `/cloud` alone reads the backend now (as `/cloud status`), and God's Eye View shows what it kept: /overview hosting.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { splitWords, wrapLine } from '../connect/repl.js';
import { cloudDo } from './commands.js';

export interface CloudReplContext {
  print(segments: Segment[]): void;
  glyphs: GlyphSet;
  /** the folder a relative --token-file is resolved from (the active project's) */
  cwd?: string;
  /** Timmy home (tests; TIMMY_HOME or ~/timmy otherwise) */
  home?: string;
  /** the terminal's width (default: stdout's columns, or 100) */
  columns?: number;
  timeoutMs?: number;
}

export async function cloudRepl(args: string, c: CloudReplContext): Promise<number> {
  const width = Math.max(40, (c.columns ?? process.stdout.columns ?? 100) - 1);
  const print = (line: Segment[]): void => { for (const row of wrapLine(line, width)) c.print(row); };
  const words = splitWords(args);
  if ('error' in words) { c.print([{ text: `  ${words.error}`, role: 'secondary' }]); return 2; }
  const said = await cloudDo(words, { glyphs: c.glyphs, by: 'repl', ...(c.cwd ? { cwd: c.cwd } : {}), ...(c.home ? { home: c.home } : {}), ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}) });
  if (words.includes('--json')) c.print([{ text: JSON.stringify(said.json) }]);
  else for (const line of said.lines) print(line);
  return said.code;
}
