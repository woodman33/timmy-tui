/**
 * Timmy Memory (round R4, helper H50): retrieval before a task. When `/iterate <kind>` (tray, blender, scad, freecad,
 * ae, from the REPL or the agent's iterate tools) or `/agent` starts, Timmy picks the CHECKED lessons that apply to it
 * (its kind, a file it works on, or a lesson's words found in its instruction), at most 3 and at most 2,000 characters,
 * and checks each again against its evidence: one whose evidence changed since its check is not given, is recorded
 * stale (its file and a lesson receipt, as /lesson check records it) and is named. The ones given go into the agent's
 * task as one delimited section (each task builder's optional `lessons`), the start line names them, and the flow
 * record or the /agent run record keeps `lessons: [{ id, sha256, status }]`, which its receipt names.
 *
 * A lesson is text given to an agent as context: it changes no file and runs nothing, and no model is trained.
 */
import type { Segment } from '../term/theme.js';
import type { Receipt } from '../utils/receipts.js';
import { checkLesson, LESSON_TEXT_MAX, listLessons, oneLine, problemsText, projectRelPath, type LessonCheck, type LessonKind, type LessonRead } from './lessons.js';
import { recordCheck, type LessonSealContext } from './seal.js';

/** The section's first and last lines: the agent sees where the lessons begin and end. */
export const LESSONS_HEAD = '---- Lessons from this project, each checked against its evidence; use one only where it applies: ----';
export const LESSONS_END = '---- end of lessons ----';
/** At most this many lessons, and this many characters for the whole section, go into one task. */
export const LESSONS_MAX = 3;
export const LESSONS_CHARS = 2000;

/** A lesson as a record keeps it: its id, its file's sha256 when it was given, and its status then. */
export interface LessonUse { id: string; sha256: string; status: 'checked' }

/** What a task is: its kind, its instruction (or /agent's task) and the files it works on, project-relative. */
export interface LessonQuery { root: string; project: string; kind: LessonKind; instruction: string; files: string[] }

export interface Retrieval {
  /** the lessons given, in the order given, each with why it applies */
  used: Array<{ id: string; sha256: string; text: string; why: string }>;
  /** lessons that apply but were not given, each with why (stale, a draft, past the limits) */
  notUsed: Array<{ id: string; why: string }>;
  /** the delimited section for the task ('' when none is given) */
  section: string;
  /** what the record keeps */
  record: LessonUse[];
}
export const NO_LESSONS: Retrieval = { used: [], notUsed: [], section: '', record: [] };

/** A lesson's text as the section gives it: one line, and no line of dashes that could look like the section's end. */
const sectionText = (text: string): string => oneLine(text, LESSON_TEXT_MAX).replace(/-{3,}/g, '--');

/** The section for these lessons ('' for none). */
export function lessonsSection(lessons: ReadonlyArray<{ id: string; text: string }>): string {
  if (!lessons.length) return '';
  return [LESSONS_HEAD, ...lessons.map((l) => `[${l.id}] ${sectionText(l.text)}`), LESSONS_END].join('\n');
}

/** /agent's task with the lessons section after the operator's own words (so its job label still shows them). */
export function agentTask(o: { task: string; lessons?: string }): string {
  return o.lessons ? `${o.task.trimEnd()}\n\n${o.lessons}` : o.task;
}

/** Why a lesson applies to a task, or undefined: its kind, a file the task works on (or names), its words in the instruction. */
function applies(read: LessonRead, q: LessonQuery): { score: number; why: string } | undefined {
  const a = read.lesson.applies_to;
  const instruction = q.instruction.toLowerCase();
  const files = new Set(q.files.map((f) => projectRelPath(f)).filter((f): f is string => !!f));
  const kind = a.kinds.includes(q.kind);
  const file = a.files.map((f) => projectRelPath(f)).filter((f): f is string => !!f).find((f) => files.has(f) || instruction.includes(f.toLowerCase()));
  const words = a.words.filter((w) => w.trim().length >= 2 && instruction.includes(w.trim().toLowerCase()));
  if (!kind && !file && !words.length) return undefined;
  const why = [kind ? `kind ${q.kind}` : '', file ? `file ${file}` : '', words.length ? `words ${words.join(', ')}` : ''].filter(Boolean).join(', ');
  return { score: (file ? 4 : 0) + (kind ? 2 : 0) + words.length, why };
}

/**
 * Picks the lessons for a task (see the module comment) and records each that its check finds stale now. `chain` is the
 * runs chain as it is now; `c` seals and writes as /lesson check does.
 */
export function retrieveLessons(q: LessonQuery, c: LessonSealContext & { chain: readonly Receipt[] }): Retrieval {
  const { lessons } = listLessons(q.root);
  const notUsed: Retrieval['notUsed'] = [];
  const candidates: Array<{ read: LessonRead; score: number; why: string }> = [];
  for (const read of lessons) {
    if (read.lesson.status === 'retired') continue;
    const fit = applies(read, q);
    if (!fit) continue;
    if (read.lesson.status === 'draft') { notUsed.push({ id: read.lesson.id, why: `a draft, not checked yet: /lesson check ${read.lesson.id}` }); continue; }
    if (read.lesson.status === 'stale') { notUsed.push({ id: read.lesson.id, why: `stale since its last check: /lesson ${read.lesson.id} says why` }); continue; }
    candidates.push({ read, ...fit });
  }
  candidates.sort((a, b) => b.score - a.score || String(b.read.lesson.checked ?? '').localeCompare(String(a.read.lesson.checked ?? '')));
  const used: Retrieval['used'] = [];
  for (const cand of candidates) {
    const id = cand.read.lesson.id;
    if (used.length >= LESSONS_MAX) { notUsed.push({ id, why: `more than ${LESSONS_MAX} lessons apply; the ${LESSONS_MAX} that apply most are given` }); continue; }
    // Checked again now: evidence that changed since its check keeps the lesson out, and the change is recorded.
    const check: LessonCheck = checkLesson(cand.read.lesson, { root: q.root, chain: c.chain, projectId: c.projectId });
    if (check.status === 'stale') {
      const rec = recordCheck(c, cand.read, check, 'retrieval');
      notUsed.push({ id, why: `stale: ${oneLine(problemsText(check.problems), 160)}${rec.receipt ? ` (recorded, receipt ${rec.receipt})` : rec.error ? ` (not recorded: ${rec.error})` : ''}` });
      continue;
    }
    const next = [...used.map((u) => ({ id: u.id, text: u.text })), { id, text: cand.read.lesson.text }];
    if (lessonsSection(next).length > LESSONS_CHARS) { notUsed.push({ id, why: `it would take the lessons past ${LESSONS_CHARS.toLocaleString('en-US')} characters` }); continue; }
    used.push({ id, sha256: cand.read.sha256, text: cand.read.lesson.text, why: cand.why });
  }
  return {
    used, notUsed, section: lessonsSection(used),
    record: used.map((u) => ({ id: u.id, sha256: u.sha256, status: 'checked' as const })),
  };
}

/** The start line's words: "lessons: l… (checked), …" or "lessons: none apply", and the ones not given with why. */
export function lessonsLine(r: Retrieval): string {
  const used = r.used.length ? r.used.map((u) => `${u.id} (checked)`).join(', ') : r.notUsed.length ? 'none given' : 'none apply';
  const not = r.notUsed.length ? `; not given: ${r.notUsed.map((n) => `${n.id} (${n.why})`).join('; ')}` : '';
  return `lessons: ${used}${not}`;
}

/** The start line as the REPL prints it ("  lessons: …"), the ids given in the strong role. */
export function lessonsStartLine(r: Retrieval): Segment[] {
  const text = lessonsLine(r);
  const ids = r.used.length ? r.used.map((u) => `${u.id} (checked)`).join(', ') : '';
  return ids
    ? [{ text: '  lessons: ', role: 'secondary' }, { text: ids, role: 'strong' }, { text: text.slice(`lessons: ${ids}`.length), role: 'secondary' }]
    : [{ text: `  ${text}`, role: 'secondary' }];
}

/**
 * The lessons for a start, when its REPL asks for them (src/repl/iterate*.ts call it with their own deps; a test that
 * builds a flow without a workspace gives none, and then no line, section or record field claims anything).
 */
export function pickLessons(d: { lessons?: (q: LessonQuery) => Retrieval }, q: LessonQuery): Retrieval | undefined {
  return d.lessons ? d.lessons(q) : undefined;
}
