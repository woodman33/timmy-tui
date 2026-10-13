/**
 * Timmy Memory (round R4, helper H50): recall for the REPL's agent. The read-only tool recall_project_work
 * (src/agent/project-tools.ts) gives the same hits as /recall (src/memory/recall.ts), by words and not meaning, as data:
 * when, the kind of record, its state in words, one line, the file to open and the receipt that seals it, and every
 * record that could not be read. Free text has the project's folder as "." and the home folder as "~". Nothing is
 * written, sealed or run.
 */
import { scrubPaths } from '../code-agents/index.js';
import { projectId } from '../project/index.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { LESSONS_ARE } from './lessons.js';
import { BY_WORDS, recall, recallWords } from './recall.js';

/** How many hits the tool gives: 10, or 40 when asked for more (a model's context is not a listing). */
export const TOOL_HITS = { some: 10, more: 40 } as const;

export function recallForAgent(root: string, words: string, o: { more?: boolean; chain?: () => readonly Receipt[] } = {}): Record<string, unknown> {
  if (!recallWords(words).length) return { ok: false, error: 'Give words of two characters or more.', how: BY_WORDS };
  let chain: readonly Receipt[] = [];
  try { chain = o.chain ? o.chain() : readChain('runs'); } catch { chain = []; }
  const r = recall({ root, chain, projectId: projectId(root) }, words, { max: o.more ? TOOL_HITS.more : TOOL_HITS.some });
  const s = (t: string): string => scrubPaths(t, root);
  return {
    ok: true, how: BY_WORDS, words: r.words, total: r.total, shown: r.hits.length,
    hits: r.hits.map((h) => ({
      when: h.when ?? null, kind: h.kind, what: h.what, id: h.id, state: s(h.state), line: s(h.line), file: h.file ?? null,
      receipt: h.seal.receipt ?? null, ...(h.seal.note ? { seal_note: s(h.seal.note) } : {}), matched: h.matched,
    })),
    ...(r.unreadable.length ? { unreadable: r.unreadable.map((u) => ({ kind: u.kind, file: u.file, why: s(u.why) })) } : {}),
    note: `Each hit is a record this project kept: read its file with read_project_file before relying on it. A receipt seals the record's bytes; a hit without one says why. ${LESSONS_ARE}`,
  };
}
