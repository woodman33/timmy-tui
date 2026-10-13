/**
 * Timmy Memory in the REPL (round R4, helper H50): `/recall <words> [--all]`, `/lesson add | check | retire | eval |
 * <id>`, `/lessons [<kind>]`, and the retrieval each /iterate start and /agent call asks for. The workspace gives the
 * project, the runs chain, its seal and its scrub (src/repl/workspace.ts); everything else is here and in the modules it
 * names. Lessons are text with evidence given to an agent as context; no model is trained.
 */
import type { JobRecord } from '../jobs/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';
import { EVAL_MIN_RUNS, evaluateLesson, sideRows } from './eval.js';
import {
  checkLesson, LESSON_ID, LESSON_KINDS, LESSON_TEXT_MAX, LESSONS_ARE, lessonRel, listLessons, newLessonId, oneLine, problemsText, projectRelPath, readLesson,
  resolveEvidence, shortHash, writeLesson, fileShaNow, sealOfFile, type Lesson, type LessonEvidence, type LessonKind, type LessonRead,
} from './lessons.js';
import { BY_WORDS, gatherRecall, recall, recallLines, recallWords, type RecallItem } from './recall.js';
import { NO_LESSONS, retrieveLessons, type LessonQuery, type Retrieval } from './retrieve.js';
import { recordCheck, sealLesson, type LessonSealContext } from './seal.js';
import { lessonUsage } from './usage.js';

type Line = Segment[];

export interface MemoryDeps {
  root: string;
  project: string;
  projectId: string;
  /** the runs chain as it is now */
  chain: () => readonly Receipt[];
  /** the REPL's seal: a short receipt id back, or undefined when sealing failed */
  seal: (input: ReceiptInput) => string | undefined;
  env: NodeJS.ProcessEnv;
  glyphs: GlyphSet;
  /** the project's folder as ".", the home folder as "~" */
  scrub: (text: string) => string;
  /** a project file as a link where the terminal has them */
  link?: (rel: string) => string;
  /** this Timmy's job records (workflow runs) */
  jobs?: () => readonly JobRecord[];
  now?: () => Date;
}

export const RECALL_USAGE = '/recall <words> [--all]';
export const LESSON_USAGE = '/lesson add "<text>" --from <record file|receipt hash> [--from …] [--applies <kind|file|word>…], /lesson check [<id>|all], /lesson <id>, /lesson eval <id>, /lesson retire <id>; /lessons [<kind>]';

const say = (text: string, role: Segment['role'] = 'secondary'): Line[] => [[{ text: `  ${text}`, role }]];
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Words as a shell reads them (quotes group, and are taken off); whether a quote was left open. */
export function splitWords(s: string): { words: string[]; open: boolean } {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { words.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) words.push(cur);
  return { words, open: quote !== null };
}

const sealContext = (d: MemoryDeps): LessonSealContext => ({ root: d.root, project: d.project, projectId: d.projectId, seal: d.seal, ...(d.now ? { now: d.now } : {}) });
const chainOf = (d: MemoryDeps): readonly Receipt[] => { try { return d.chain(); } catch { return []; } };

// ── /recall ──────────────────────────────────────────────────────────────────────

/** `/recall <words> [--all]`: the project's retained records holding the words (by words, not meaning). */
export function recallCommand(d: MemoryDeps, args: string): Line[] {
  const { words } = splitWords(args.trim());
  const all = words.includes('--all');
  const query = words.filter((w) => w !== '--all').join(' ');
  if (!query.trim()) {
    return [
      [{ text: '  Recall     ', role: 'secondary' }, { text: RECALL_USAGE, role: 'strong' }],
      ...say(`           ${BY_WORDS}.`),
      ...say('           It reads flows, VoxVision records, observations, code-agent runs, MCP calls (server, tool and arguments, never the output), native runs, recipe jobs, workflow runs and lessons; each hit names its file and the receipt that seals it.'),
    ];
  }
  if (!recallWords(query).length) return say(`Give words of two characters or more: ${RECALL_USAGE} (${BY_WORDS}).`);
  const r = recall({ root: d.root, chain: chainOf(d), projectId: d.projectId, ...(d.jobs ? { jobs: d.jobs() } : {}) }, query, { all });
  return recallLines(r, { glyphs: d.glyphs, scrub: d.scrub, ...(d.link ? { link: d.link } : {}), all });
}

// ── /lesson ──────────────────────────────────────────────────────────────────────

/** `/lesson …`: add, check, retire, eval, or one lesson in full. */
export function lessonCommand(d: MemoryDeps, args: string): Line[] {
  const { words, open } = splitWords(args.trim());
  if (open) return say('A quote is left open: put the lesson\'s text in double quotes, e.g. /lesson add "keep the lid gap at 0.4" --from <record>. Nothing was written.', 'failure');
  const [sub, ...rest] = words;
  if (!sub) return usageLines();
  if (sub === 'add') return add(d, rest);
  if (sub === 'check') return check(d, rest[0] ?? 'all', rest.length > 1);
  if (sub === 'retire') return retire(d, rest[0]);
  if (sub === 'eval') return evalLines(d, rest[0]);
  if (LESSON_ID.test(sub) && !rest.length) return show(d, sub);
  return [...say(`No /lesson ${sub}: nothing was done.`, 'failure'), ...usageLines()];
}

function usageLines(): Line[] {
  return [
    [{ text: '  Lessons    ', role: 'secondary' }, { text: '/lesson add "<text>" --from <record file|receipt hash>', role: 'strong' }, { text: ' [--from …] [--applies <kind|file|word>…]', role: 'secondary' }],
    ...say(`           /lesson check [<id>|all]${' · '}/lesson <id>${' · '}/lesson eval <id>${' · '}/lesson retire <id>${' · '}/lessons [<kind>]`),
    ...say(`           kinds: ${LESSON_KINDS.join(', ')}`),
    ...say(`           ${LESSONS_ARE}`),
  ];
}

/** The newest record a lesson could cite, for the line to type ("--from results/flows/f….json"). */
function exampleRecord(d: MemoryDeps, items: readonly RecallItem[]): string {
  const t = (w?: string): number => { const n = w ? Date.parse(w) : Number.NaN; return Number.isNaN(n) ? 0 : n; };
  const best = [...items].filter((i) => i.file && i.kind !== 'lesson').sort((a, b) => t(b.when) - t(a.when))[0];
  return best?.file ?? '<record file or receipt hash>';
}

/** `--applies` values: a kind, a file in the project (a path, or a name with a dot), or a word. */
function parseApplies(values: readonly string[]): { ok: true; kinds: LessonKind[]; files: string[]; words: string[] } | { ok: false; error: string } {
  const kinds: LessonKind[] = [];
  const files: string[] = [];
  const words: string[] = [];
  for (const v of values.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)) {
    if ((LESSON_KINDS as readonly string[]).includes(v.toLowerCase())) { kinds.push(v.toLowerCase() as LessonKind); continue; }
    if (v.includes('/') || /\.[a-z0-9]{1,8}$/i.test(v)) {
      const rel = projectRelPath(v);
      if (!rel) return { ok: false, error: `--applies ${v}: a file is named by its path inside the project` };
      files.push(rel);
      continue;
    }
    if (v.length < 2 || /[\x00-\x1f\x7f]/.test(v)) return { ok: false, error: `--applies ${v}: a word has two characters or more` };
    words.push(v.toLowerCase());
  }
  return { ok: true, kinds: [...new Set(kinds)], files: [...new Set(files)], words: [...new Set(words)] };
}

function add(d: MemoryDeps, words: readonly string[]): Line[] {
  const text: string[] = [];
  const from: string[] = [];
  const applies: string[] = [];
  let given = false;
  let inApplies = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const eq = /^--(from|applies)=(.*)$/.exec(w);
    if (eq) { if (eq[1] === 'from') { from.push(eq[2]); inApplies = false; } else { applies.push(eq[2]); given = true; inApplies = true; } continue; }
    if (w === '--from') {
      const v = words[i + 1];
      if (v === undefined || v.startsWith('--')) return say('--from needs a record file or a receipt hash. Nothing was written.', 'failure');
      from.push(v); i += 1; inApplies = false; continue;
    }
    if (w === '--applies') { given = true; inApplies = true; continue; }
    if (/^--\S/.test(w)) return say(`No option ${w}: /lesson add takes --from and --applies. Nothing was written.`, 'failure');
    if (inApplies) applies.push(w); else text.push(w);
  }
  const t = text.join(' ').trim();
  if (!t) return [...say('Say what the lesson is, in quotes: nothing was written.', 'failure'), ...usageLines()];
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(t)) return say('The lesson\'s text holds control characters; nothing was written.', 'failure');
  if (t.length > LESSON_TEXT_MAX) return say(`The lesson is ${t.length} characters; a lesson holds at most ${LESSON_TEXT_MAX}. Nothing was written.`, 'failure');
  const chain = chainOf(d);
  let items: RecallItem[] = [];
  try { items = gatherRecall({ root: d.root, chain, projectId: d.projectId, ...(d.jobs ? { jobs: d.jobs() } : {}) }).items; } catch { items = []; }
  if (!from.length) {
    return [
      ...say('A lesson needs evidence: a record it was learnt from. Nothing was written. Type, with the record (or a receipt hash):', 'failure'),
      [{ text: '    ' }, { text: `/lesson add "${t.replace(/"/g, "'")}" --from ${exampleRecord(d, items)}`, role: 'strong' }],
      ...say('/recall <words> finds the records; each names its file and its receipt.'),
    ];
  }
  const describe = (rel: string): { why: string; kind?: LessonKind } | undefined => {
    const it = items.find((x) => x.file === rel);
    return it ? { why: d.scrub(`${it.what} ${it.id}: ${it.state}${it.line ? `; ${oneLine(it.line, 140)}` : ''}`), ...(it.lessonKind ? { kind: it.lessonKind } : {}) } : undefined;
  };
  const evidence: LessonEvidence[] = [];
  const kinds = new Set<LessonKind>();
  const notes: string[] = [];
  for (const f of from) {
    const r = resolveEvidence(f, { root: d.root, chain, projectId: d.projectId, describe });
    if (!r.ok) return say(`Not added: --from ${f}: ${d.scrub(r.error)}. Nothing was written.`, 'failure');
    if (evidence.some((e) => e.path === r.evidence.path)) continue;
    evidence.push(r.evidence);
    if (r.kind) kinds.add(r.kind);
    if (r.note) notes.push(d.scrub(r.note));
  }
  const a = parseApplies(applies);
  if (!a.ok) return say(`Not added: ${a.error}. Nothing was written.`, 'failure');
  const appliesTo = given ? { kinds: a.kinds, files: a.files, words: a.words } : { kinds: [...kinds], files: [], words: [] };
  const lesson: Lesson = {
    schema: 'timmy.lesson/1', id: newLessonId(d.root), text: t, applies_to: appliesTo, evidence, status: 'draft',
    created: (d.now ?? (() => new Date()))().toISOString(), checked: null, source: 'user', operation: d.env.TIMMY_OPERATION?.trim() || null,
  };
  const w = writeLesson(d.root, lesson);
  if (!w.ok) {
    const receipt = sealLesson(sealContext(d), { action: 'add', lesson, error: `the lesson file could not be written: ${w.error}` });
    return say(`Not added: ${d.scrub(w.error)}${receipt ? ` (receipt ${receipt} says so)` : ''}.`, 'failure');
  }
  const receipt = sealLesson(sealContext(d), { action: 'add', lesson, written: w });
  const g = d.glyphs;
  return [
    [{ text: '  Lesson     ', role: 'secondary' }, { text: lesson.id, role: 'strong' }, { text: `  draft${` ${g.sep} `}${oneLine(t, 120)}` }],
    ...evidenceLines(d, evidence),
    ...notes.map((n): Line => [{ text: `             ${n}`, role: 'estimate' }]),
    [{ text: '  Applies    ', role: 'secondary' }, { text: appliesText(appliesTo) }],
    ...(appliesTo.kinds.length + appliesTo.files.length + appliesTo.words.length ? [] : say('           it applies to nothing yet, so it is given to no task: add it again with --applies <kind|file|word>', 'estimate')),
    [{ text: '  Kept       ', role: 'secondary' }, { text: d.link ? d.link(w.rel) : w.rel }, { text: `${` ${g.sep} `}${receipt ? `receipt ${receipt}` : 'the receipt could not be sealed'}${lesson.operation ? `${` ${g.sep} `}operation ${lesson.operation}` : ''}`, role: 'secondary' }],
    [{ text: '  Next       ', role: 'secondary' }, { text: `/lesson check ${lesson.id}`, role: 'strong' }, { text: ': only a checked lesson is given to an agent', role: 'secondary' }],
    ...say(`           ${LESSONS_ARE}`),
  ];
}

const appliesText = (a: Lesson['applies_to']): string => [
  `kinds ${a.kinds.join(', ') || 'none'}`, `files ${a.files.join(', ') || 'none'}`, `words ${a.words.join(', ') || 'none'}`,
].join(' · ');

function evidenceLines(d: MemoryDeps, evidence: readonly LessonEvidence[]): Line[] {
  return evidence.map((e, i): Line => [
    { text: i === 0 ? '  Evidence   ' : '             ', role: 'secondary' }, { text: `${i + 1}. ` }, { text: d.link && projectRelPath(e.path) === e.path ? d.link(e.path) : e.path },
    { text: `  sha256 ${e.sha256.slice(0, 12)} · ${e.receipt ? `receipt ${shortHash(e.receipt)}` : 'no receipt'} · ${oneLine(d.scrub(e.why), 140)}`, role: 'secondary' },
  ]);
}

/** One lesson by id, read, or why not (named when its file is there but is not a lesson). */
function lessonById(d: MemoryDeps, id: string | undefined): { ok: true; read: LessonRead } | { ok: false; lines: Line[] } {
  if (!id || !LESSON_ID.test(id)) return { ok: false, lines: say(`Name a lesson by its id (l and 8 hex digits): /lessons lists them.`, 'failure') };
  const r = readLesson(d.root, lessonRel(id));
  if (r.ok) return { ok: true, read: { rel: r.rel, lesson: r.lesson, sha256: r.sha256, bytes: r.bytes } };
  if (r.error === 'it does not exist') return { ok: false, lines: say(`No lesson ${id} in this project: /lessons lists them.`, 'failure') };
  return { ok: false, lines: say(`${r.rel} cannot be read as a lesson: ${d.scrub(r.error)}; it is left as it is.`, 'failure') };
}

function check(d: MemoryDeps, which: string, extra: boolean): Line[] {
  if (extra) return say('/lesson check takes one lesson id, or all.', 'failure');
  const g = d.glyphs;
  const chain = chainOf(d);
  let targets: LessonRead[];
  const lines: Line[] = [];
  if (which === 'all') {
    const all = listLessons(d.root);
    targets = all.lessons;
    if (!targets.length && !all.unreadable.length) return say('No lessons in this project yet: /lesson add "<text>" --from <record>.');
    for (const u of all.unreadable) lines.push([{ text: `  ${g.fail} `, role: 'failure' }, { text: u.rel }, { text: `  not checked: ${d.scrub(u.error)}`, role: 'secondary' }]);
  } else {
    const one = lessonById(d, which);
    if (!one.ok) return one.lines;
    targets = [one.read];
  }
  for (const read of targets) {
    const l = read.lesson;
    if (l.status === 'retired') { lines.push([{ text: '    ' }, { text: l.id, role: 'strong' }, { text: '  retired: not checked; it stays as it is', role: 'secondary' }]); continue; }
    const c = checkLesson(l, { root: d.root, chain, projectId: d.projectId });
    const rec = recordCheck(sealContext(d), read, c);
    const tail = `${rec.error ? ` ${g.sep} not recorded: ${d.scrub(rec.error)}` : ''}${rec.receipt ? ` ${g.sep} receipt ${rec.receipt}` : ` ${g.sep} the receipt could not be sealed`}`;
    if (c.status === 'checked') {
      lines.push([{ text: `  ${g.ok} ` }, { text: `${l.id} checked`, role: 'strong' }, { text: `: every evidence file (${l.evidence.length}) has the bytes it was added with, and every receipt it names verifies${tail}`, role: 'secondary' }]);
    } else {
      lines.push([{ text: `  ${g.fail} `, role: 'failure' }, { text: `${l.id} stale`, role: 'failure' }, { text: `: ${d.scrub(problemsText(c.problems))}; it is not given to an agent until it checks again${tail}`, role: 'secondary' }]);
    }
  }
  return lines;
}

function retire(d: MemoryDeps, id: string | undefined): Line[] {
  const one = lessonById(d, id);
  if (!one.ok) return one.lines;
  const l = one.read.lesson;
  if (l.status === 'retired') return say(`${l.id} is retired already; nothing was written.`);
  const lesson: Lesson = { ...l, status: 'retired' };
  const w = writeLesson(d.root, lesson);
  const receipt = sealLesson(sealContext(d), { action: 'retire', lesson, ...(w.ok ? { written: w } : { error: `the lesson file could not be written: ${w.error}` }) });
  if (!w.ok) return say(`${l.id} was not retired: ${d.scrub(w.error)}${receipt ? ` (receipt ${receipt} says so)` : ''}.`, 'failure');
  return [[{ text: '  ' }, { text: `${l.id} retired`, role: 'strong' }, { text: `: it is never given to an agent again; its file and evidence are kept${` ${d.glyphs.sep} `}${receipt ? `receipt ${receipt}` : 'the receipt could not be sealed'}`, role: 'secondary' }]];
}

function show(d: MemoryDeps, id: string): Line[] {
  const one = lessonById(d, id);
  if (!one.ok) return one.lines;
  const { read } = one;
  const l = read.lesson;
  const g = d.glyphs;
  const sep = ` ${g.sep} `;
  const now = checkLesson(l, { root: d.root, chain: chainOf(d), projectId: d.projectId });
  const used = lessonUsage(d.root).get(l.id) ?? [];
  const seal = sealOfFile(chainOf(d), d.projectId, read.rel, read.sha256, ['lesson']);
  return [
    [{ text: '  Lesson     ', role: 'secondary' }, { text: l.id, role: 'strong' }, { text: `  ${l.status}${sep}created ${l.created}${sep}checked ${l.checked ?? 'never'}${sep}source ${l.source}${sep}operation ${l.operation ?? 'none'}`, role: 'secondary' }],
    [{ text: '  Text       ', role: 'secondary' }, { text: d.scrub(oneLine(l.text, LESSON_TEXT_MAX)) }],
    [{ text: '  Applies    ', role: 'secondary' }, { text: d.scrub(appliesText(l.applies_to)) }],
    ...evidenceLines(d, l.evidence),
    [{ text: '  Now        ', role: 'secondary' }, now.status === 'checked'
      ? { text: 'its evidence checks: every file has its bytes and every receipt it names verifies' }
      : { text: `its evidence does not check: ${d.scrub(problemsText(now.problems))}`, role: 'estimate' }, { text: `${sep}read only; /lesson check ${l.id} records it`, role: 'secondary' }],
    [{ text: '  Used by    ', role: 'secondary' }, { text: used.length ? `${used.length} run${used.length === 1 ? '' : 's'}: ${used.slice(0, 8).map((u) => `${u.kind} ${u.id}`).join(', ')}${used.length > 8 ? ` and ${used.length - 8} more` : ''}` : 'no run yet' }],
    [{ text: '  File       ', role: 'secondary' }, { text: d.link ? d.link(read.rel) : read.rel }, { text: `${sep}${'sealed' in seal ? `receipt ${shortHash(seal.sealed.hash)} sealed these bytes` : 'changed' in seal ? `changed after receipt ${shortHash(seal.changed.hash)} sealed it` : 'no lesson receipt seals it'}`, role: 'secondary' }],
    [{ text: '  Next       ', role: 'secondary' }, { text: [...(l.status !== 'retired' ? [`/lesson check ${l.id}`] : []), `/lesson eval ${l.id}`, ...(l.status !== 'retired' ? [`/lesson retire ${l.id}`] : [])].join(sep), role: 'secondary' }],
    ...say(`           ${LESSONS_ARE}`),
  ];
}

function evalLines(d: MemoryDeps, id: string | undefined): Line[] {
  const one = lessonById(d, id);
  if (!one.ok) return one.lines;
  const l = one.read.lesson;
  const e = evaluateLesson(d.root, l);
  const sep = ` ${d.glyphs.sep} `;
  const lines: Line[] = [
    [{ text: '  Eval       ', role: 'secondary' }, { text: l.id, role: 'strong' }, { text: `  ${d.scrub(oneLine(l.text, 100))}`, role: 'secondary' }],
    ...say(`           from the flow records only: ${e.kinds.length ? `${e.kinds.join(', ')} flows` : 'no flow kind'} that did not use it${e.firstUse ? ` (started before its first use, ${e.firstUse})` : ' (it has not been used yet)'}, beside the flows that used it`),
  ];
  if (!e.kinds.length) lines.push(...say('           it names no flow kind and no flow used it, so there are no flows to set beside each other', 'estimate'));
  if (e.notFlowKinds.length) lines.push(...say(`           not compared: ${e.notFlowKinds.join(', ')} (no flow records; /agent runs, VoxVision actions and workflow runs are not counted here)`));
  const w = sideRows(e.without);
  const u = sideRows(e.with);
  const rows: Array<[string, keyof typeof w]> = [['runs (n)', 'runs'], ['completion', 'completion'], ['correctness', 'correctness'], ['duration', 'duration'], ['cost', 'cost'], ['interventions', 'interventions'], ['recovery', 'recovery']];
  lines.push([{ text: '                            ', role: 'secondary' }, { text: 'without', role: 'strong' }, { text: '  │  ', role: 'secondary' }, { text: 'with', role: 'strong' }]);
  for (const [label, k] of rows) lines.push([{ text: `  ${label.padEnd(26)}`, role: 'secondary' }, { text: w[k] }, { text: '  │  ', role: 'secondary' }, { text: u[k] }]);
  if (e.tooFew) lines.push(...say(`too few runs to compare: ${e.without.n} without and ${e.with.n} with (${EVAL_MIN_RUNS} or more on each side are needed); the numbers are counts from the records`, 'estimate'));
  lines.push(...say('No significance is claimed either way: these are counts and a median from the flow records, not a test.'));
  if (e.unreadable.length) lines.push(...say(`Not counted: ${e.unreadable.length} flow record${e.unreadable.length === 1 ? '' : 's'} that could not be read (${e.unreadable.slice(0, 3).map((x) => `${x.rel}: ${d.scrub(x.error)}`).join('; ')}${e.unreadable.length > 3 ? '; …' : ''})`, 'failure'));
  lines.push(...say(`Durations run from each flow's recorded start to its recorded end${sep}costs are the agents' costs as each flow recorded them.`));
  lines.push(...say(LESSONS_ARE));
  return lines;
}

// ── /lessons ─────────────────────────────────────────────────────────────────────

/** `/lessons [<kind>]`: each lesson's status, text, evidence count and how many runs used it. */
export function lessonsCommand(d: MemoryDeps, args: string): Line[] {
  const kind = args.trim().toLowerCase();
  if (kind && !(LESSON_KINDS as readonly string[]).includes(kind)) return say(`No kind ${kind}: the kinds are ${LESSON_KINDS.join(', ')}.`, 'failure');
  const { lessons, unreadable } = listLessons(d.root);
  const shown = kind ? lessons.filter((r) => r.lesson.applies_to.kinds.includes(kind as LessonKind)) : lessons;
  const g = d.glyphs;
  const sep = ` ${g.sep} `;
  let usage: ReturnType<typeof lessonUsage>;
  try { usage = lessonUsage(d.root); } catch { usage = new Map(); }
  const lines: Line[] = [[{ text: '  Lessons    ', role: 'secondary' }, { text: `${shown.length}${kind ? ` that apply to ${kind}` : ''} in ${d.project}`, role: 'strong' }, { text: `${sep}newest first${sep}${LESSONS_ARE}`, role: 'secondary' }]];
  if (!shown.length) lines.push(...say(kind ? `None names ${kind}.` : 'None yet: /lesson add "<text>" --from <record file or receipt hash>.'));
  const order: Record<string, number> = { checked: 0, draft: 1, stale: 2, retired: 3 };
  for (const r of [...shown].sort((a, b) => order[a.lesson.status] - order[b.lesson.status])) {
    const l = r.lesson;
    const n = usage.get(l.id)?.length ?? 0;
    lines.push([{ text: `  ${l.status === 'checked' ? g.ok : l.status === 'stale' ? g.fail : ' '} `, role: l.status === 'stale' ? 'failure' : undefined }, { text: l.id, role: 'strong' },
      { text: `  ${l.status.padEnd(8)} `, role: l.status === 'stale' ? 'failure' : undefined }, { text: d.scrub(oneLine(l.text, 90)) },
      { text: `${sep}${l.evidence.length} evidence${sep}used by ${n} run${n === 1 ? '' : 's'}${l.applies_to.kinds.length ? `${sep}${l.applies_to.kinds.join(', ')}` : ''}`, role: 'secondary' }]);
  }
  for (const u of unreadable) lines.push([{ text: `  ${g.fail} `, role: 'failure' }, { text: u.rel }, { text: `  not read as a lesson: ${d.scrub(u.error)}`, role: 'secondary' }]);
  lines.push(...say('One in full: /lesson <id>; check them: /lesson check all; compare runs with and without one: /lesson eval <id>'));
  return lines;
}

// ── retrieval for a task ─────────────────────────────────────────────────────────

/**
 * The lessons for a task (src/memory/retrieve.ts), never failing the task: a failure to read them is said in the line,
 * and no lesson is given.
 */
export function retrieveForTask(c: { seal: (input: ReceiptInput) => string | undefined; chain: () => readonly Receipt[]; projectId: string; now?: () => Date }, q: LessonQuery): Retrieval {
  try {
    let chain: readonly Receipt[] = [];
    try { chain = c.chain(); } catch { chain = []; }
    return retrieveLessons(q, { root: q.root, project: q.project, projectId: c.projectId, seal: c.seal, chain, ...(c.now ? { now: c.now } : {}) });
  } catch (e) {
    return { ...NO_LESSONS, notUsed: [{ id: 'the lessons', why: `could not be read (${msg(e).slice(0, 160)}), so none was given` }] };
  }
}

/** Whether a file the task names exists now (for /agent's files: the instruction's words that are project files). */
export function namedFiles(root: string, text: string): string[] {
  const out: string[] = [];
  for (const w of text.split(/\s+/)) {
    const rel = projectRelPath(w.replace(/^["'`(]+|["'`),.;:]+$/g, ''));
    if (rel && rel.includes('.') && 'sha256' in fileShaNow(root, rel)) out.push(rel);
  }
  return [...new Set(out)].slice(0, 20);
}
