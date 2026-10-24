/**
 * R6 (H139): each project's own board. Studio project isolation, the operator's words (2026-10-16, priority 1 of the round):
 * "Project identity, board, drafts, jobs, artifact links and save/action targets must change together. Block edits while
 * switching." Until R6 the canvas was one document per Timmy home (<TIMMY_HOME>/canvas/canvas.json, with its jobs ledger jobs.json
 * and its drafts record drafts.jsonl): every project's boards and cards in it. A project switch left the board, its pending draft
 * (with Accept and Discard) and its canvas jobs on screen under the new project's name (the R5 interaction review, defect 1).
 *
 * Now each project has a folder of its own, keyed by the id its receipts name it with (src/project/index.ts projectId: a hash of
 * its real folder, never its path):
 *
 *   <TIMMY_HOME>/canvas/projects/<projectId>/canvas.json    its board, the tldraw document (revision-checked, as before)
 *                                            jobs.json      its canvas jobs, each with its project and the revision it produced
 *                                            drafts.jsonl   its drafts record (proposed, refused, accepted, discarded)
 *                                            copies/        a page's versions, kept beside its board
 *                                            adopted.json   only in a project that took over the old layout's files: what, and why
 *
 * Why there: the canvas stays in Timmy's home, where it always was and where the page says it saves; nothing is written into a
 * project's own folder (often a git repository); a project id names no path, and the same folder always finds the same board. A
 * project folder that moves gets a new id and so a new, blank board; its old board stays, under its old id.
 *
 * The old layout (the lead's note of 10:02 PT): its files are never rewritten or deleted. Once, when a server first starts on this
 * layout, they become the board of the project they belonged to (adoptOldLayout): the active project of this Timmy home
 * (state/active-project.json, the project the canvas followed and showed), else the one project their cards name. They are copied
 * byte for byte into that project's folder, and canvas/legacy-adopted.json says what went where and why, with each file's sha256.
 * When neither tells, nothing is copied: the old files stay where they are, and a project's blank board says so (oldLayoutWords).
 *
 * Imports node's own modules and Timmy's project id only, so the shared frame (src/ops/workspace-frame.ts) can read pendingDrafts.
 */
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectId as idOfFolder } from '../project/index.js';
import { readActiveFile } from './active-follow.js';
import { CanvasDocuments, canvasDir, DRAFT_ID, shownPath } from './document.js';

/** A project's id as its receipts and the canvas name it: 16 hex. */
export const PROJECT_ID = /^[0-9a-f]{16}$/;
/** Which project something belongs to: its id, and its name as it was named (the name is what a person reads). */
export interface ProjectRef { id: string; name: string }
/** The folder of the canvas folder that holds the projects' boards. */
export const BOARDS = 'projects';
/** The old layout's files, as the canvas folder held them for the whole Timmy home before R6. */
export const OLD_LAYOUT_FILES = ['canvas.json', 'jobs.json', 'drafts.jsonl'] as const;
/** The record, in the canvas folder, of where the old layout's files went (written once, never rewritten). */
export const ADOPTION_RECORD = 'legacy-adopted.json';

type Env = Record<string, string | undefined>;

/** The folder of project `id`'s board in the canvas folder `canvasRoot`. */
export function boardDir(canvasRoot: string, id: string): string {
  if (!PROJECT_ID.test(id)) throw new Error(`Not a project id: ${JSON.stringify(id).slice(0, 40)}`);
  return join(canvasRoot, BOARDS, id);
}

/** The board of the project in folder `projectRoot`, in the Timmy home of `env` (its canvas folder). */
export function boardOfFolder(projectRoot: string, env: Env = process.env, o: { maxBytes?: number } = {}): CanvasDocuments {
  return new CanvasDocuments(boardDir(canvasDir(env), idOfFolder(projectRoot)), o);
}

/**
 * Every project's board in one canvas folder, each opened once. Nothing is created by opening one: a board's folder is made by
 * its first save (CanvasDocuments makes it as it writes).
 */
export class CanvasBoards {
  private readonly opened = new Map<string, CanvasDocuments>();
  constructor(readonly root: string, private readonly o: { maxBytes?: number } = {}) {}

  /** Project `id`'s board. */
  of(id: string): CanvasDocuments {
    let docs = this.opened.get(id);
    if (!docs) {
      docs = new CanvasDocuments(boardDir(this.root, id), this.o);
      this.opened.set(id, docs);
    }
    return docs;
  }

  /** The projects with a board folder here (ids only). */
  ids(): string[] {
    try { return readdirSync(join(this.root, BOARDS)).filter((n) => PROJECT_ID.test(n)).sort(); } catch { return []; }
  }

  /** Where project `id`'s board is, as a page shows it (~/... under the home folder). */
  shown(id: string): string { return shownPath(boardDir(this.root, id)); }

  /**
   * The board whose jobs ledger holds job `job`: project `first`'s, else every other board's. A receipt is linked to its canvas
   * job in the board that ran it, whichever project the canvas shows now. Null when no board has it.
   */
  findJob(job: string, first: string | null = null): { project: string; docs: CanvasDocuments } | null {
    const order = [...(first && PROJECT_ID.test(first) ? [first] : []), ...this.ids().filter((id) => id !== first)];
    for (const id of order) {
      const docs = this.of(id);
      if (docs.jobs().some((j) => j.id === job)) return { project: id, docs };
    }
    return null;
  }
}

// ── the old layout: one canvas for the whole Timmy home ─────────────────────────────────────────────────────────────

/** What canvas/legacy-adopted.json records: the old layout's files, where each went, and why that project. */
export interface Adoption {
  format: 'timmy-canvas-adoption';
  version: 1;
  at: string;
  project: ProjectRef;
  /** how the project was told, in words */
  why: string;
  files: Array<{ name: string; bytes: number; sha256: string; to: string | null; note?: string }>;
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFile = (p: string): boolean => { try { return lstatSync(p).isFile(); } catch { return false; } };

/** The projects the old canvas's own records name (drawn cards, placed notes, pinned boards): id → name. */
export function projectsNamedIn(snapshot: unknown): Map<string, string> {
  const named = new Map<string, string>();
  const store = isObject(snapshot) && isObject(snapshot.store) ? snapshot.store : {};
  const add = (id: unknown, name: unknown): void => {
    if (typeof id !== 'string' || !PROJECT_ID.test(id)) return;
    if (!named.has(id) || named.get(id) === id) named.set(id, typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : id);
  };
  for (const r of Object.values(store)) {
    if (!isObject(r)) continue;
    if (r.typeName === 'shape' && isObject(r.props) && typeof r.type === 'string' && r.type.startsWith('timmy-')) add(r.props.projectId, r.props.project);
    const meta = isObject(r.meta) ? r.meta : {};
    if (isObject(meta.timmyProjectCard)) add(meta.timmyProjectCard.projectId, meta.timmyProjectCard.project);
    if (isObject(meta.timmyPin)) add(meta.timmyPin.projectId, meta.timmyPin.project);
  }
  return named;
}

/** The adoption already recorded in canvas folder `root`, or null. */
export function readAdoption(root: string): Adoption | null {
  try {
    const a = JSON.parse(readFileSync(join(root, ADOPTION_RECORD), 'utf8')) as Adoption;
    return a && a.format === 'timmy-canvas-adoption' && isObject(a.project) && typeof a.project.id === 'string' ? a : null;
  } catch { return null; }
}

/** Which old-layout files canvas folder `root` holds (regular files only). */
export function oldLayoutFiles(root: string): string[] {
  return OLD_LAYOUT_FILES.filter((f) => isFile(join(root, f)));
}

/**
 * Once: the old layout's files of canvas folder `root` become the board of the project they belonged to. `activeFile`: the Timmy
 * home's state/active-project.json (the project the canvas followed and showed); by default the one beside this canvas folder.
 * Never rewrites or deletes a file: each is copied (never over an existing one) and the record is written only if none exists.
 * Returns the adoption recorded (now or before), or null when there is nothing to adopt or no project to give it to.
 */
export function adoptOldLayout(root: string, o: { activeFile?: string; now?: Date } = {}): Adoption | null {
  const before = readAdoption(root);
  if (before) return before;
  const files = oldLayoutFiles(root);
  if (files.length === 0) return null;
  let owner: ProjectRef | null = null;
  let why = '';
  const active = readActiveFile(o.activeFile ?? join(dirname(root), 'state', 'active-project.json'));
  if (active) {
    owner = { id: active.id, name: active.name };
    why = `the active project of this Timmy home (state/active-project.json), which the canvas followed and showed: ${active.name}`;
  } else {
    let snapshot: unknown = null;
    try { snapshot = (JSON.parse(readFileSync(join(root, 'canvas.json'), 'utf8')) as { snapshot?: unknown }).snapshot ?? null; } catch { snapshot = null; }
    const named = projectsNamedIn(snapshot);
    if (named.size === 1) {
      const [[id, name]] = [...named];
      owner = { id, name };
      why = `the one project the old canvas's cards name: ${name} (no active project was recorded)`;
    }
  }
  if (!owner) return null;
  const to = boardDir(root, owner.id);
  const taken = OLD_LAYOUT_FILES.some((f) => existsSync(join(to, f)));
  const record: Adoption = { format: 'timmy-canvas-adoption', version: 1, at: (o.now ?? new Date()).toISOString(), project: owner, why, files: [] };
  if (!taken) mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of files) {
    const from = join(root, name);
    const bytes = readFileSync(from);
    const entry: Adoption['files'][number] = { name, bytes: bytes.length, sha256: sha256(bytes), to: null };
    if (taken) entry.note = `not copied: ${owner.name}'s board already has files of its own`;
    else {
      try {
        copyFileSync(from, join(to, name), constants.COPYFILE_EXCL);
        entry.to = `${BOARDS}/${owner.id}/${name}`;
      } catch (e) {
        entry.note = `not copied (${e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : 'error'})`;
      }
    }
    record.files.push(entry);
  }
  const text = `${JSON.stringify(record, null, 1)}\n`;
  try { writeFileSync(join(root, ADOPTION_RECORD), text, { mode: 0o600, flag: 'wx' }); } catch { return readAdoption(root); }
  if (!taken) { try { writeFileSync(join(to, 'adopted.json'), text, { mode: 0o600, flag: 'wx' }); } catch { /* the canvas folder's record stands */ } }
  return record;
}

/**
 * What a project's board says about the old layout, or null when there is nothing to say: this project took the old canvas over
 * (when, and why), or the old canvas is kept where it was because Timmy could not tell whose it was, or it went to another project.
 */
export function oldLayoutWords(root: string, id: string): string | null {
  const a = readAdoption(root);
  if (a && a.project.id === id) {
    const copied = a.files.filter((f) => f.to).map((f) => f.name);
    return copied.length
      ? `This board is the canvas this Timmy home had before each project had its own (${copied.join(', ')}, copied ${a.at.slice(0, 10)}): it was ${a.why}. The old files are kept, unchanged, in ${shownPath(root)}.`
      : null;
  }
  if (a) return null;
  const files = oldLayoutFiles(root);
  if (!files.length) return null;
  return `This Timmy home also keeps the canvas it had before each project had its own board (${files.join(', ')} in ${shownPath(root)}), unchanged: Timmy could not tell which project it belonged to (no active project was recorded, and its cards name none, or several), so no project's board shows it.`;
}

// ── what waits for a person on a project's board (for the shared frame) ──────────────────────────────────────────────

/** The saved board's pending drafts, by its file's time and size (the frame asks every few seconds). */
const pendingSeen = new Map<string, { key: string; value: { count: number; jobs: string[] } | null }>();

/**
 * R6 (H139, for H140's shared frame): the drafts that wait for a person's Accept or Discard on the board of the project in folder
 * `projectRoot`, as its board was last saved (the page saves a draft before it answers the call that drew it, and saves an Accept
 * or a Discard at once): how many, and the canvas jobs that drew them. { count: 0 } when the project has no board yet; null when
 * it cannot be told (the board file cannot be read).
 */
export function pendingDrafts(projectRoot: string, env: Env = process.env): { count: number; jobs: string[] } | null {
  let file: string;
  try { file = join(boardDir(canvasDir(env), idOfFolder(projectRoot)), 'canvas.json'); } catch { return null; }
  let key: string;
  try {
    const st = statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { count: 0, jobs: [] } : null;
  }
  const seen = pendingSeen.get(file);
  if (seen && seen.key === key) return seen.value;
  let value: { count: number; jobs: string[] } | null = null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { format?: unknown; snapshot?: unknown };
    if (saved.format === 'timmy-canvas' && isObject(saved.snapshot) && isObject(saved.snapshot.store)) {
      const drafts = new Map<string, string | null>();
      for (const r of Object.values(saved.snapshot.store)) {
        if (!isObject(r) || r.typeName !== 'shape' || !isObject(r.meta) || !isObject(r.meta.timmyDraft)) continue;
        const d = r.meta.timmyDraft;
        if (typeof d.id === 'string' && DRAFT_ID.test(d.id) && !drafts.has(d.id)) drafts.set(d.id, typeof d.job === 'string' ? d.job : null);
      }
      value = { count: drafts.size, jobs: [...new Set([...drafts.values()].filter((j): j is string => !!j))] };
    }
  } catch { value = null; }
  pendingSeen.set(file, { key, value });
  if (pendingSeen.size > 64) pendingSeen.delete(pendingSeen.keys().next().value!);
  return value;
}
