/**
 * Timmy Memory (round R4, helper H50): a lesson's receipt. Each add, check and retire seals one `lesson` receipt on the
 * runs chain through the REPL's own seal, as the flows and jobs seal theirs: the lesson file it wrote (path, sha256,
 * size, and the sha256 of the file it replaced), the evidence as sources, the lesson's id, action and status, and, for a
 * check that found it stale, each item and why as discrepancies. Never the lesson's text: the receipt binds it through
 * the file's sha256.
 */
import type { ReceiptInput } from '../utils/receipts.js';
import { problemsText, writeLesson, type CheckProblem, type Lesson, type LessonCheck, type LessonRead } from './lessons.js';

export interface LessonSealContext {
  root: string;
  project: string;
  projectId: string;
  seal: (input: ReceiptInput) => string | undefined;
  /** the time now (a test gives its own) */
  now?: () => Date;
}

/** Seals one lesson receipt: its short id back, or undefined when sealing failed. */
export function sealLesson(c: LessonSealContext, o: {
  action: 'add' | 'check' | 'retire';
  lesson: Lesson;
  written?: { rel: string; sha256: string; bytes: number; previous?: string };
  problems?: readonly CheckProblem[];
  /** the file could not be written: why (the receipt says so; nothing else changed) */
  error?: string;
  /** who asked: a person's command (absent), or the check before a task ('retrieval') */
  by?: string;
}): string | undefined {
  const l = o.lesson;
  const failed = !!o.error || (o.action === 'check' && l.status === 'stale');
  try {
    return c.seal({
      kind: 'lesson', subject: `lesson · ${o.action} · ${l.id} · ${l.status}`, policy: 'human-gated', status: failed ? 'failed' : 'ok',
      project: c.project, project_id: c.projectId,
      lesson: { id: l.id, action: o.action, status: l.status, evidence: l.evidence.length, ...(o.by ? { by: o.by } : {}), operation: l.operation },
      ...(o.written ? { files: [{ path: o.written.rel, sha256: o.written.sha256, bytes: o.written.bytes, ...(o.written.previous ? { previous_sha256: o.written.previous } : { created: true }) }] } : {}),
      sources: l.evidence.map((e) => ({ path: e.path, sha256: e.sha256, receipt: e.receipt, role: 'evidence' })),
      ...(o.error || o.problems?.length ? { discrepancies: [...(o.error ? [o.error] : []), ...(o.problems?.length ? [`stale: ${problemsText(o.problems)}`] : [])] } : {}),
    });
  } catch { return undefined; }
}

/**
 * Records a check: the lesson with its new status (checked: now as its `checked` time; stale: its last checked time
 * kept), written whole, and its lesson receipt. A retired lesson is never checked (it stays as it is).
 */
export function recordCheck(c: LessonSealContext, read: LessonRead, check: LessonCheck, by?: string): { lesson: Lesson; receipt?: string; written?: { rel: string; sha256: string; bytes: number; previous?: string }; error?: string } {
  const now = (c.now ?? (() => new Date()))().toISOString();
  const lesson: Lesson = { ...read.lesson, status: check.status, checked: check.status === 'checked' ? now : read.lesson.checked };
  const w = writeLesson(c.root, lesson);
  const receipt = sealLesson(c, { action: 'check', lesson, ...(w.ok ? { written: w } : { error: `the lesson file could not be written: ${w.error}` }), problems: check.problems, ...(by ? { by } : {}) });
  return w.ok ? { lesson, written: w, ...(receipt ? { receipt } : {}) } : { lesson: read.lesson, error: w.error, ...(receipt ? { receipt } : {}) };
}
