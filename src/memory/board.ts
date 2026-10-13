/**
 * Timmy Memory on the board (round R4, helper H50): a small Memory section of the snapshot (/board) and of the live board
 * (/board live). One card per lesson, newest first: its status in words, its text, what it applies to, its evidence (the
 * record as a link and the receipt that sealed it, by its short hash), and how many runs used it. Each lesson is checked
 * against its evidence as the board is drawn (read only: nothing is written or sealed), so a lesson recorded `checked`
 * whose evidence changed since says so, and a stale lesson says what changed. On the live board each lesson that is not
 * retired has a Check button: the typed `/lesson check <id>`, through the live board's action path (its token, Host and
 * Origin rules; src/repl/board-live.ts checkAction), which records the check and seals its receipt. Every string is
 * escaped; a path from a lesson becomes a link only when it is inside the project.
 */
import { esc, type Kit } from '../repl/board-kit.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { Receipt } from '../utils/receipts.js';
import { checkLesson, LESSON_ID, LESSONS_ARE, listLessons, oneLine, projectRelPath, sealOfFile, shortHash, type LessonCheck, type LessonStatus } from './lessons.js';
import { lessonUsage } from './usage.js';

/** How many lesson cards a board shows; the rest are counted. */
export const MEMORY_MAX = 12;

export interface BoardLesson {
  id: string;
  file: string;
  status: LessonStatus;
  text: string;
  applies: { kinds: string[]; files: string[]; words: string[] };
  evidence: Array<{ path: string; inProject: boolean; sha256: string; receipt?: string; why: string }>;
  /** the runs that used it (flows and /agent runs) */
  used: number;
  /** its check now, read only */
  now: LessonCheck;
  checkedAt: string | null;
  /** the lesson receipt that sealed this file's bytes, by its short hash */
  sealed?: string;
}
export interface BoardMemory { lessons: BoardLesson[]; more: number; unreadable: Array<{ file: string; why: string }> }

/** The Memory section's data: the lessons (each checked now against its evidence, read only) and the files that are not lessons. */
export function readBoardMemory(o: { root: string; chain: readonly Receipt[]; projectId: string; scrub: (t: string) => string }): BoardMemory {
  const { lessons, unreadable } = listLessons(o.root);
  let usage: ReturnType<typeof lessonUsage>;
  try { usage = lessonUsage(o.root); } catch { usage = new Map(); }
  const shown = lessons.slice(0, MEMORY_MAX).map((r): BoardLesson => {
    const l = r.lesson;
    const s = sealOfFile(o.chain, o.projectId, r.rel, r.sha256, ['lesson']);
    let now: LessonCheck;
    try { now = checkLesson(l, { root: o.root, chain: o.chain, projectId: o.projectId }); } catch (e) { now = { status: 'stale', problems: [{ item: 0, path: '', why: `it could not be checked (${e instanceof Error ? e.message : String(e)})` }] }; }
    return {
      id: l.id, file: r.rel, status: l.status, text: o.scrub(l.text),
      applies: { kinds: [...l.applies_to.kinds], files: l.applies_to.files.map(o.scrub), words: l.applies_to.words.map(o.scrub) },
      evidence: l.evidence.map((e) => ({ path: o.scrub(e.path), inProject: projectRelPath(e.path) === e.path, sha256: e.sha256, ...(e.receipt ? { receipt: shortHash(e.receipt) } : {}), why: o.scrub(e.why) })),
      used: usage.get(l.id)?.length ?? 0,
      now: { status: now.status, problems: now.problems.map((p) => ({ ...p, path: o.scrub(p.path), why: o.scrub(p.why) })) },
      checkedAt: l.checked,
      ...('sealed' in s ? { sealed: shortHash(s.sealed.hash) } : {}),
    };
  });
  return { lessons: shown, more: Math.max(0, lessons.length - MEMORY_MAX), unreadable: unreadable.map((u) => ({ file: u.rel, why: o.scrub(u.error) })) };
}

/** A lesson's status as the card says it: the recorded word, and what its check now adds. */
function statusOf(l: BoardLesson): { word: string; tone: 'ok' | 'stale' | 'draft' | 'retired'; detail: string } {
  const why = l.now.problems.map((p) => (p.item ? `item ${p.item}: ${p.why}` : p.why));
  if (l.status === 'retired') return { word: 'retired', tone: 'retired', detail: 'never given to an agent; kept as it is' };
  if (l.status === 'checked' && l.now.status === 'checked') return { word: 'checked', tone: 'ok', detail: `every evidence file has its bytes and every receipt it names verifies (checked ${l.checkedAt ?? 'at an unknown time'}, and again now)` };
  if (l.status === 'checked') return { word: 'stale now', tone: 'stale', detail: `recorded checked, but its evidence changed since: ${why.join('; ')}. It is not given to an agent; Check records it.` };
  if (l.status === 'stale') return { word: 'stale', tone: 'stale', detail: l.now.status === 'stale' ? `what changed: ${why.join('; ')}` : 'recorded stale; its evidence checks again now: Check records it as checked' };
  return { word: 'draft', tone: 'draft', detail: l.now.status === 'checked' ? 'not checked yet: Check checks it against its evidence' : `not checked yet, and its evidence does not check now: ${why.join('; ')}` };
}

function lessonCard(l: BoardLesson, k: Kit): string {
  const s = statusOf(l);
  const applies = [l.applies.kinds.length ? `kinds ${l.applies.kinds.join(', ')}` : '', l.applies.files.length ? `files ${l.applies.files.join(', ')}` : '', l.applies.words.length ? `words ${l.applies.words.join(', ')}` : ''].filter(Boolean).join(' · ') || 'nothing yet: it is given to no task';
  const evidence = l.evidence.map((e, i) => `<li>${esc(`${i + 1}. `)}${e.inProject ? k.fileLink(e.path, 'file') : `<span class="file">${esc(e.path)}</span>`}`
    + `<span class="meta">${esc(` · sha256 ${e.sha256.slice(0, 12)} · ${e.receipt ? `receipt ${e.receipt}` : 'no receipt'} · ${oneLine(e.why, 160)}`)}</span></li>`).join('');
  return `<article class="card lesson lesson-${esc(s.tone)}" data-lesson-card="${esc(l.id)}">`
    + `<div class="jobhead"><strong class="name">${esc(l.id)}</strong><span class="lesson-status">${esc(s.word)}</span></div>`
    + `<p class="lesson-text">${esc(oneLine(l.text, 600))}</p>`
    + `<p class="meta">${esc(s.detail)}</p>`
    + `<dl><dt>applies to</dt><dd>${esc(applies)}</dd><dt>used by</dt><dd>${esc(`${l.used} run${l.used === 1 ? '' : 's'} (flows and /agent runs whose records name it)`)}</dd>`
    + `<dt>sealed</dt><dd>${esc(l.sealed ? `lesson receipt ${l.sealed}` : 'no lesson receipt seals this file\'s bytes')}</dd></dl>`
    + `<h4>evidence</h4><ul class="evidence-list">${evidence || `<li class="nomodel">${esc('no evidence')}</li>`}</ul>`
    + (l.status !== 'retired' ? k.act('Check', { act: 'lesson-check', lesson: l.id }) : '')
    + k.cmds([`/lesson ${l.id}`, ...(l.status !== 'retired' ? [`/lesson check ${l.id}`] : []), `/lesson eval ${l.id}`])
    + '</article>';
}

/** The Memory section: its table-of-contents entry and its HTML. */
export function memorySection(m: BoardMemory, k: Kit): { toc: string; html: string } {
  const n = m.lessons.length + m.more;
  return {
    toc: `<a href="#memory">Memory <b>${n}</b></a>`,
    html: [
      `<h2 id="memory">Memory <span class="count">${n}</span></h2>`,
      `<section class="memory"><p class="sub">${esc(`${LESSONS_ARE} A lesson is given only while it is checked against its evidence.${k.live ? ' Check runs the typed /lesson check <id>.' : ''}`)}</p>`,
      m.lessons.length ? `<div class="grid wide">${m.lessons.map((l) => lessonCard(l, k)).join('')}</div>` : k.empty('No lessons yet: /lesson add "<text>" --from <record file or receipt hash> keeps one with its evidence.'),
      m.more ? `<p class="more">${esc(`${m.more} more: /lessons lists them all`)}</p>` : '',
      ...m.unreadable.map((u) => `<p class="nomodel">${esc(`not read as a lesson: ${u.file} (${u.why})`)}</p>`),
      k.cmds(['/lessons', '/recall <words>']),
      '</section>',
    ].join('\n'),
  };
}

export const MEMORY_CSS = `
.memory .card.lesson { border-left: 3px solid ${HOMEBREW.lineStrong}; }
.memory .lesson-stale { border-left-color: ${HOMEBREW.attention}; }
.memory .lesson-retired { opacity: .8; border-left-style: dashed; }
.memory .lesson-status { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.text}; }
.memory .lesson-stale .lesson-status { color: ${HOMEBREW.attention}; }
.memory .lesson-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-weight: ${TYPE.weight.strong}; }
.memory .evidence-list { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; font-size: ${TYPE.size.small}px; }
.memory .evidence-list .file { overflow-wrap: anywhere; }
`;

type LessonChecked = { ok: true; command: { name: 'lesson'; args: string; line: string } } | { ok: false; status: number; error: string };

/**
 * A live-board lesson action, checked against the lessons the board shows: exactly {"action":"lesson","verb":"check",
 * "id":"<lesson id>"}, the id one of a lesson on this board now. The typed command it stands for, or why not.
 */
export function checkLessonAction(body: Record<string, unknown>, lessons: readonly string[]): LessonChecked {
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'action,id,verb' || body.verb !== 'check' || typeof body.id !== 'string') return { ok: false, status: 400, error: 'A lesson action is {"action":"lesson","verb":"check","id":"<lesson id>"}.' };
  if (!LESSON_ID.test(body.id)) return { ok: false, status: 422, error: `${body.id.slice(0, 40)} is not a lesson id (l and 8 hex digits).` };
  if (!lessons.includes(body.id)) return { ok: false, status: 404, error: `No lesson ${body.id} on this board: /lessons lists them.` };
  return { ok: true, command: { name: 'lesson', args: `check ${body.id}`, line: `/lesson check ${body.id}` } };
}
