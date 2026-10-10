/**
 * Timmy Memory (round R4, helper H50): lessons with evidence. A lesson is a short text about this project, bound to the
 * records it was learnt from: each evidence item is a project file (a flow record, a VoxVision record, an agent run's
 * result, …) with the sha256 of its bytes when the lesson was added and, where one seals those bytes, the receipt. A
 * lesson is `checked` only while every evidence file still has those bytes and every receipt it names is on the
 * project's chain and verifies (and, where that receipt names the file's sha256, the two agree); otherwise it is
 * `stale`, and the check says which item and why. Lessons are text given to an agent as context when they apply: no
 * model is trained, and a lesson changes no file and runs nothing.
 *
 * Kept as .timmy/memory/lessons/<id>.json, schema timmy.lesson/1 exactly (another view reads lessons by it: no field is
 * added to it), written through a temporary file renamed over it, mode 0600 in folders made 0700 (as other private
 * records), never through a link. Nothing here seals: src/memory/repl.ts seals each add, check and retire.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../project/index.js';
import { hashFile } from '../project/intake.js';
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';

export const LESSON_SCHEMA = 'timmy.lesson/1';
export const LESSONS_DIR = '.timmy/memory/lessons';
/** A lesson's id: 'l' and 8 hex digits (a flow is 'f' and 8, an agent run 'a' and 8). */
export const LESSON_ID = /^l[0-9a-f]{8}$/;
/** The kinds of work a lesson applies to: the five /iterate targets, /agent, VoxVision and workflow runs (/run). */
export const LESSON_KINDS = ['tray', 'blender', 'scad', 'freecad', 'ae', 'agent', 'vox', 'run'] as const;
export type LessonKind = typeof LESSON_KINDS[number];
export type LessonStatus = 'draft' | 'checked' | 'stale' | 'retired';
export const LESSON_STATUSES: readonly LessonStatus[] = ['draft', 'checked', 'stale', 'retired'];

export interface LessonEvidence {
  /** the record file, project-relative */
  path: string;
  /** hex sha256 of its bytes when the lesson was added */
  sha256: string;
  /** the receipt that sealed those bytes (its full hash), or null */
  receipt: string | null;
  why: string;
}

/** timmy.lesson/1, exactly. */
export interface Lesson {
  schema: typeof LESSON_SCHEMA;
  id: string;
  text: string;
  applies_to: { kinds: LessonKind[]; files: string[]; words: string[] };
  evidence: LessonEvidence[];
  status: LessonStatus;
  created: string;
  checked: string | null;
  source: 'user' | 'agent';
  operation: string | null;
}

/** What every lesson says once, wherever lessons are shown. */
export const LESSONS_ARE = 'Lessons are text with evidence, given to an agent as context where they apply; no model is trained, and a lesson changes no file and runs nothing.';

/** The most text a lesson holds, and the largest lesson file read. */
export const LESSON_TEXT_MAX = 1500;
const LESSON_FILE_MAX = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export const lessonRel = (id: string): string => `${LESSONS_DIR}/${id}.json`;
export const shortHash = (h: string | null | undefined): string => (h ? h.replace(/^sha256[_:]/, '').slice(0, 8) : '');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A path inside the project as '/'-separated parts, or null (absolute, a URL, home-relative, or climbing out). */
export function projectRelPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  const t = p.trim();
  if (t.startsWith('/') || t.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('~')) return null;
  const parts = t.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/**
 * A lesson as read from its file, checked against timmy.lesson/1 field by field: the lesson, or what in it is not the
 * schema. `id`: the id its file name gives (a file whose lesson names another id is not that lesson).
 */
export function validateLesson(json: unknown, id?: string): { ok: true; lesson: Lesson } | { ok: false; error: string } {
  const r = obj(json);
  const bad = (what: string): { ok: false; error: string } => ({ ok: false, error: `not a ${LESSON_SCHEMA} lesson: ${what}` });
  if (!r) return bad('not a JSON object');
  if (r.schema !== LESSON_SCHEMA) return bad(`its schema is ${JSON.stringify(r.schema) ?? 'missing'}`);
  if (typeof r.id !== 'string' || !LESSON_ID.test(r.id)) return bad('its id is not l and 8 hex digits');
  if (id !== undefined && r.id !== id) return bad(`it names ${r.id}, but its file is ${id}.json`);
  if (typeof r.text !== 'string' || !r.text.trim()) return bad('it has no text');
  const a = obj(r.applies_to);
  if (!a || !strings(a.kinds) || !strings(a.files) || !strings(a.words)) return bad('applies_to is not { kinds, files, words }, each a list of strings');
  const odd = a.kinds.find((k) => !(LESSON_KINDS as readonly string[]).includes(k));
  if (odd !== undefined) return bad(`applies_to.kinds holds ${JSON.stringify(odd)}, not one of ${LESSON_KINDS.join(', ')}`);
  if (!Array.isArray(r.evidence)) return bad('evidence is not a list');
  for (const [i, e] of r.evidence.entries()) {
    const o = obj(e);
    if (!o || typeof o.path !== 'string' || typeof o.sha256 !== 'string' || !SHA256.test(o.sha256) || !(o.receipt === null || typeof o.receipt === 'string') || typeof o.why !== 'string') {
      return bad(`evidence item ${i + 1} is not { path, sha256 (64 hex digits), receipt (a hash or null), why }`);
    }
  }
  if (typeof r.status !== 'string' || !(LESSON_STATUSES as readonly string[]).includes(r.status)) return bad(`its status is ${JSON.stringify(r.status) ?? 'missing'}`);
  if (typeof r.created !== 'string' || Number.isNaN(Date.parse(r.created))) return bad('created is not an ISO time');
  if (!(r.checked === null || (typeof r.checked === 'string' && !Number.isNaN(Date.parse(r.checked))))) return bad('checked is not an ISO time or null');
  if (r.source !== 'user' && r.source !== 'agent') return bad('source is not user or agent');
  if (!(r.operation === null || typeof r.operation === 'string')) return bad('operation is not a string or null');
  return { ok: true, lesson: r as unknown as Lesson };
}

export interface LessonRead { rel: string; lesson: Lesson; sha256: string; bytes: number }
export interface LessonUnreadable { rel: string; error: string }

/** One lesson file: the lesson, its file's sha256 and size, or why it cannot be read as one (it is left as it is). */
export function readLesson(root: string, rel: string): ({ ok: true } & LessonRead) | ({ ok: false } & LessonUnreadable) {
  const at = resolveInside(root, rel);
  if ('error' in at) return { ok: false, rel, error: at.error };
  let buf: Buffer;
  try {
    const st = lstatSync(at.path);
    if (st.isSymbolicLink()) return { ok: false, rel, error: 'it is a symbolic link; a lesson is read only from a file in place' };
    if (!st.isFile()) return { ok: false, rel, error: 'it is not a regular file' };
    if (st.size > LESSON_FILE_MAX) return { ok: false, rel, error: `it is ${st.size} bytes, larger than a lesson` };
    buf = readFileSync(at.path);
  } catch (e) { return { ok: false, rel, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'it does not exist' : `it cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` }; }
  let json: unknown;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { return { ok: false, rel, error: `it is not JSON (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})` }; }
  const id = path.posix.basename(rel).replace(/\.json$/, '');
  const v = validateLesson(json, id);
  if (!v.ok) return { ok: false, rel, error: v.error };
  return { ok: true, rel, lesson: v.lesson, sha256: sha(buf), bytes: buf.length };
}

/** The project's lessons, newest first, and every file in their folder that could not be read as one (each named). */
export function listLessons(root: string): { lessons: LessonRead[]; unreadable: LessonUnreadable[] } {
  const at = resolveInside(root, LESSONS_DIR);
  if ('error' in at) return { lessons: [], unreadable: [] };
  let names: string[];
  try { names = readdirSync(at.path).filter((n) => !n.startsWith('.')).sort(); } catch { return { lessons: [], unreadable: [] }; }
  const lessons: LessonRead[] = [];
  const unreadable: LessonUnreadable[] = [];
  for (const n of names) {
    const rel = `${LESSONS_DIR}/${n}`;
    if (!/^l[0-9a-f]{8}\.json$/.test(n)) { unreadable.push({ rel, error: 'its name is not <lesson id>.json, so it is not read as a lesson' }); continue; }
    const r = readLesson(root, rel);
    if (r.ok) lessons.push({ rel: r.rel, lesson: r.lesson, sha256: r.sha256, bytes: r.bytes });
    else unreadable.push({ rel: r.rel, error: r.error });
  }
  lessons.sort((a, b) => String(b.lesson.created).localeCompare(String(a.lesson.created)));
  return { lessons, unreadable };
}

/** A new lesson id, free in this project. */
export function newLessonId(root: string): string {
  for (;;) {
    const id = `l${randomBytes(4).toString('hex')}`;
    try { lstatSync(path.join(root, ...lessonRel(id).split('/'))); } catch { return id; }
  }
}

/**
 * Writes a lesson to its file: a temporary file in the same folder (created new, mode 0600 whatever the umask, written
 * whole and synced) renamed over it, so a reader sees the old lesson or the new one, never part of one. The folders
 * .timmy/memory/lessons are made 0700 where missing; none of them may be a link. Its sha256 and size back, with the
 * sha256 of the file it replaced.
 */
export function writeLesson(root: string, lesson: Lesson): { ok: true; rel: string; sha256: string; bytes: number; previous?: string } | { ok: false; rel: string; error: string } {
  const rel = lessonRel(lesson.id);
  const v = validateLesson(lesson, lesson.id);
  if (!v.ok) return { ok: false, rel, error: v.error };
  let realRoot: string;
  try { realRoot = path.resolve(root); statSync(realRoot); } catch { return { ok: false, rel, error: 'the project folder is gone' }; }
  // Each folder in place, never a link: made 0700 when missing.
  let dir = realRoot;
  for (const part of LESSONS_DIR.split('/')) {
    dir = path.join(dir, part);
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, rel, error: `${path.relative(realRoot, dir).split(path.sep).join('/')} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a folder'}; a lesson is written only in place, so nothing was written` };
    } catch {
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, rel, error: `${path.relative(realRoot, dir)} could not be made (${(e as NodeJS.ErrnoException).code ?? 'error'})` }; }
    }
  }
  const at = resolveInside(root, rel);
  if ('error' in at) return { ok: false, rel, error: at.error };
  let previous: string | undefined;
  try {
    const st = lstatSync(at.path);
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, rel, error: `${rel} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}; it was left as it is` };
    previous = sha(readFileSync(at.path));
  } catch { /* a new lesson */ }
  const body = `${JSON.stringify(lesson, null, 2)}\n`;
  const tmp = path.join(path.dirname(at.path), `.${lesson.id}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    const buf = Buffer.from(body, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, at.path);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
    try { unlinkSync(tmp); } catch { /* not made, or renamed */ }
    return { ok: false, rel, error: `${rel} could not be written (${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : 'error')})` };
  }
  return { ok: true, rel, sha256: sha(body), bytes: Buffer.byteLength(body), ...(previous ? { previous } : {}) };
}

// ── files and receipts ───────────────────────────────────────────────────────────

/**
 * A file's sha256 now: null when it is not there, undefined when it cannot be read (with why). The live board asks every
 * 2 s, so a hash is kept with the file's size, mtime and ctime and taken again only when one of them changes.
 */
const hashes = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; sha256: string }>();
export function fileShaNow(root: string, rel: string): { sha256: string; bytes: number } | { gone: true } | { error: string } {
  const at = resolveInside(root, rel);
  if ('error' in at) return { error: at.error };
  try {
    const st = lstatSync(at.path);
    if (st.isSymbolicLink()) {
      const target = statSync(at.path);
      if (!target.isFile()) return { error: 'it is a link to something that is not a file' };
    } else if (!st.isFile()) return { error: 'it is not a regular file' };
    const s = statSync(at.path);
    const known = hashes.get(at.path);
    if (known && known.size === s.size && known.mtimeMs === s.mtimeMs && known.ctimeMs === s.ctimeMs) return { sha256: known.sha256, bytes: s.size };
    const now = hashFile(at.path);
    if (hashes.size > 2000) hashes.clear();
    hashes.set(at.path, { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, sha256: now });
    return { sha256: now, bytes: s.size };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { gone: true } : { error: `it cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

/** The paths a receipt names with their sha256: its outputs, then its files (what it wrote, and what it read as input). */
function namedFiles(r: Receipt): Array<{ path: string; sha256?: string }> {
  return [...(Array.isArray(r.outputs) ? r.outputs : []), ...(Array.isArray(r.files) ? r.files : [])]
    .filter((x): x is { path: string; sha256?: string } => !!x && typeof x === 'object' && typeof (x as { path?: unknown }).path === 'string');
}

/**
 * Which receipt of this project seals a file's bytes: the newest that names the path with exactly this sha256 (in its
 * outputs or files). Otherwise whether one names the path with other bytes (the file changed after it was sealed).
 */
export function sealOfFile(chain: readonly Receipt[], projectId: string, rel: string, sha256: string, kinds?: readonly string[]): { sealed: Receipt } | { changed: Receipt } | { none: true } {
  let other: Receipt | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const r = chain[i];
    if (!r || r.project_id !== projectId || (kinds && !kinds.includes(r.kind))) continue;
    const named = namedFiles(r).filter((f) => f.path === rel);
    if (!named.length) continue;
    if (named.some((f) => f.sha256 === sha256)) return { sealed: r };
    other ??= r;
  }
  return other ? { changed: other } : { none: true };
}

/** A receipt named by its hash (in full, or its first 8 or more hex digits, as /receipts and the notices show it), of this project. */
export function findReceipt(chain: readonly Receipt[], given: string, projectId: string): { ok: true; receipt: Receipt } | { ok: false; error: string } {
  const hex = given.trim().toLowerCase().replace(/^sha256[_:]/, '');
  if (!/^[0-9a-f]{8,64}$/.test(hex)) return { ok: false, error: `${given} is not a receipt hash (8 to 64 hex digits, as /receipts and the notices show them)` };
  const all = chain.filter((r) => typeof r.hash === 'string' && r.hash.startsWith(`sha256_${hex}`));
  if (!all.length) return { ok: false, error: `no receipt ${given} is on this project's chain` };
  const mine = all.filter((r) => r.project_id === projectId);
  if (!mine.length) return { ok: false, error: `receipt ${given} is on the chain, but it is not this project's` };
  if (new Set(mine.map((r) => r.hash)).size > 1) return { ok: false, error: `${given} names ${new Set(mine.map((r) => r.hash)).size} receipts: give more of its hash` };
  return { ok: true, receipt: mine[mine.length - 1] };
}

export interface EvidenceContext {
  root: string;
  chain: readonly Receipt[];
  projectId: string;
  /** What a record file is, in words, and the kind of work it was (from the readers recall uses), when Timmy knows it. */
  describe?: (rel: string) => { why: string; kind?: LessonKind } | undefined;
}

/**
 * One `--from` value as an evidence item: a record file in the project (its sha256 now; the receipt that sealed those
 * bytes, when one did), or a receipt of this project's chain by its hash (the record file it sealed, whose bytes must
 * still be the ones it names). Why not, when it cannot be evidence; `note`: something to say about it.
 */
export function resolveEvidence(from: string, c: EvidenceContext): { ok: true; evidence: LessonEvidence; kind?: LessonKind; note?: string } | { ok: false; error: string } {
  const given = from.trim();
  if (!given) return { ok: false, error: '--from needs a record file or a receipt hash' };
  const asFile = projectRelPath(given);
  const exists = asFile ? !('gone' in fileShaNow(c.root, asFile)) : false;
  if (/^(?:sha256[_:])?[0-9a-f]{8,64}$/i.test(given) && !exists) {
    const found = findReceipt(c.chain, given, c.projectId);
    if (!found.ok) return { ok: false, error: found.error };
    const r = found.receipt;
    const files = namedFiles(r).flatMap((f) => { const rel = projectRelPath(f.path); return rel ? [{ rel, sha256: f.sha256 }] : []; });
    for (const f of files) {
      const now = fileShaNow(c.root, f.rel);
      if (!('sha256' in now)) continue;
      if (f.sha256 && f.sha256 !== now.sha256) return { ok: false, error: `receipt ${shortHash(r.hash)} sealed ${f.rel} as sha256 ${f.sha256.slice(0, 12)}, and the file is ${now.sha256.slice(0, 12)} now: it changed after it was sealed, so it is not that evidence any more` };
      const d = c.describe?.(f.rel);
      return { ok: true, evidence: { path: f.rel, sha256: now.sha256, receipt: r.hash, why: d?.why ?? `sealed by receipt ${shortHash(r.hash)} (${r.kind}: ${String(r.subject ?? '').slice(0, 120)})` }, ...(d?.kind ? { kind: d.kind } : {}) };
    }
    return { ok: false, error: `receipt ${shortHash(r.hash)} (${r.kind}) names no record file that is in this project now: give the record itself with --from <file>` };
  }
  if (!asFile) return { ok: false, error: `${given} is not a file inside the project, nor a receipt hash` };
  const now = fileShaNow(c.root, asFile);
  if ('gone' in now) return { ok: false, error: `${asFile} does not exist in this project` };
  if ('error' in now) return { ok: false, error: `${asFile}: ${now.error}` };
  const seal = sealOfFile(c.chain, c.projectId, asFile, now.sha256);
  const d = c.describe?.(asFile);
  const why = d?.why ?? 'the file as it was when the lesson was added';
  if ('sealed' in seal) return { ok: true, evidence: { path: asFile, sha256: now.sha256, receipt: seal.sealed.hash, why }, ...(d?.kind ? { kind: d.kind } : {}) };
  const note = 'changed' in seal
    ? `${asFile} changed after receipt ${shortHash(seal.changed.hash)} sealed it: no receipt seals these bytes, so the lesson binds the file alone`
    : `no receipt of this project seals ${asFile}: the lesson binds the file alone`;
  return { ok: true, evidence: { path: asFile, sha256: now.sha256, receipt: null, why }, ...(d?.kind ? { kind: d.kind } : {}), note };
}

export interface CheckProblem { item: number; path: string; why: string }
export interface LessonCheck { status: 'checked' | 'stale'; problems: CheckProblem[] }

/**
 * A lesson's check, read only: `checked` when every evidence file exists with the sha256 the lesson holds, and every
 * receipt it names is this project's, on the chain, verifies where it stands (src/utils/receipts.ts verifyReceiptIn)
 * and, where it names that file's sha256, agrees with it; otherwise `stale`, each failing item with why.
 */
export function checkLesson(lesson: Lesson, c: { root: string; chain: readonly Receipt[]; projectId: string }): LessonCheck {
  const problems: CheckProblem[] = [];
  if (!lesson.evidence.length) problems.push({ item: 0, path: '', why: 'it has no evidence' });
  lesson.evidence.forEach((e, i) => {
    const item = i + 1;
    const say = (why: string): void => { problems.push({ item, path: e.path, why }); };
    const rel = projectRelPath(e.path);
    if (!rel) return say('its path is not a file inside the project');
    const now = fileShaNow(c.root, rel);
    if ('gone' in now) say(`${rel} is gone`);
    else if ('error' in now) say(`${rel}: ${now.error}`);
    else if (now.sha256 !== e.sha256) say(`${rel} changed: sha256 ${now.sha256.slice(0, 12)} now, ${e.sha256.slice(0, 12)} when the lesson was added`);
    if (e.receipt === null) return;
    const r = c.chain.find((x) => x.hash === e.receipt);
    if (!r) return say(`receipt ${shortHash(e.receipt)} is not on the chain`);
    if (r.project_id !== c.projectId) return say(`receipt ${shortHash(e.receipt)} is not this project's`);
    const v = verifyReceiptIn(c.chain, r.hash);
    if (!v.ok) return say(`receipt ${shortHash(e.receipt)} does not verify: ${v.reason}`);
    const named = namedFiles(r).filter((f) => f.path === rel && typeof f.sha256 === 'string');
    if (named.length && !named.some((f) => f.sha256 === e.sha256)) say(`receipt ${shortHash(e.receipt)} sealed ${rel} as sha256 ${named[0].sha256!.slice(0, 12)}, not the ${e.sha256.slice(0, 12)} the lesson holds`);
  });
  return { status: problems.length ? 'stale' : 'checked', problems };
}

/** A check's problems in one sentence: "item 1 (results/flows/f….json): it changed …; item 2 …". */
export const problemsText = (problems: readonly CheckProblem[]): string => problems.map((p) => (p.item ? `item ${p.item}: ${p.why}` : p.why)).join('; ');

/** Lesson text as one line: control characters out, white space as single spaces, at most `max` characters. */
export function oneLine(text: string, max = 160): string {
  const t = text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
