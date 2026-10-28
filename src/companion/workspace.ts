/**
 * R5 (H132, the operator's completion order of 2026-10-15): the workspace frame in the browser companion. The frame
 * (src/contracts/workspace.ts, timmy.workspace/1) is what the terminal Workbench, the companion and Timmy Studio draw around
 * their own content: the project with its switch and new-project commands, the ten tabs, each tab's workflow actions with at
 * most one primary next step, the connections as Timmy last observed them, the activity, the newest log lines, and which
 * surfaces open when the workspace starts. It is made only by src/ops/workspace-frame.ts buildWorkspaceFrame, from the
 * records; the companion computes none of it and only serves it (GET /api/workspace) and changes the two start-up settings a
 * page shows (POST /api/workspace/prefs).
 *
 *   route                          answers
 *   GET /api/workspace             200 the frame of the project the page shows (?project=<id>, else the one followed); 404 in
 *                                  words for a project this companion does not know; 500 in words when it cannot be made
 *   POST /api/workspace/prefs      body {openCompanionAtStart?, openStudioAtStart?, if_revision}: if_revision is the
 *                                  revision of the frame the page shows. Another revision now: 409 {error:'stale', frame},
 *                                  the newer frame, and nothing is written (a change made elsewhere is never overwritten
 *                                  silently). Else saved through src/workbench/settings.ts (the file the terminal Workbench
 *                                  keeps; a temporary file renamed over it): 200 {saved_at, frame}; a file it cannot read or
 *                                  write: 500 {error} in words, and nothing is written. A body it cannot read: 400 {error}.
 *
 * Both need the companion's token (server.ts's withToken, before a body is read). Saves are taken one at a time, each
 * checked against the revision of a frame made after the save before it, so two pages that both showed one revision cannot
 * both write. The frame's revision is the producer's (a digest of the frame without its time): whatever changes the frame
 * changes it.
 *
 * What it reads and writes is the environment it is given (CompanionOptions.workspace, a test's), else this process's.
 */
import express, { type Application, type RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { deliveredPath, deliverInto } from './miniapps/receipts.js';
import { projectId } from '../project/index.js';
import { gaussianPlyHeader } from '../spatial/tools.js';
import { appendReceipt } from '../utils/receipts.js';
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, extname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import type { WorkspaceFrame } from '../contracts/workspace.js';
import { readActiveProject } from '../project/index.js';
import { scrubHomes, tildePath } from '../utils/home-scrub.js';
import { failRequest } from '../utils/server-failure.js';
import { readSettings, saveSettings, type SaveResult, type SettingsRead, type WorkbenchSettings } from '../workbench/settings.js';

type Env = Record<string, string | undefined>;

/** The project a page shows (src/companion/project.ts): its name and its folder. */
/** The project a page shows; `env` when it is a signed-in user's (R11 round 4, H171): the frame and the settings are read and
 *  written under the user's own env, never this companion's (the user's project root is theirs alone, so the share by root holds). */
export interface ShownProject { name: string; root: string; env?: Env }

/**
 * What makes a frame for a project: src/ops/workspace-frame.ts buildWorkspaceFrame unless a test gives one. `project` is
 * named only when the page shows another project than the one the producer reads by itself (a page pinned to its own, or a
 * folder TIMMY_REPO fixed while another project is recorded as active).
 */
export type FrameProducer = (o: { cwd: string; env: Env; project?: ShownProject }) => Promise<WorkspaceFrame>;

export interface WorkspaceDeps {
  /** the environment the frame and the settings are read and written with; this process's when absent */
  env?: Env;
  /** the frame's producer (a test's FAKE); the built-in one when absent */
  frame?: FrameProducer;
  /** the Workbench's settings, read and saved (a test's, to make a save fail); src/workbench/settings.ts when absent */
  read?: (env: Env) => SettingsRead;
  save?: (s: WorkbenchSettings, env: Env) => SaveResult;
  /** how long one made frame answers every page that asks for it (several pages polling one project); 750 ms */
  shareMs?: number;
}

/** The two settings a page may change: whether the companion and Studio open when the workspace starts. */
export const PREF_KEYS = ['openCompanionAtStart', 'openStudioAtStart'] as const;
export type PrefKey = typeof PREF_KEYS[number];

export const WORKSPACE_FAILED = 'The workspace frame could not be made';
export const PREFS_BAD_BODY = 'This page\'s settings change could not be read: it is {openCompanionAtStart?, openStudioAtStart?, if_revision}, with at least one of the two settings true or false and if_revision the revision of the frame the page shows. Nothing was written.';

export type Answer = { status: number; body: unknown };

/** One line of words (the first: never a stack), no control characters, the home folder as ~, at most `max` characters. */
const words = (s: unknown, max = 400): string => {
  const one = scrubHomes(String(s instanceof Error ? s.message : s).split('\n')[0]).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export class CompanionWorkspace {
  private readonly shared = new Map<string, { at: number; made: Promise<WorkspaceFrame> }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: WorkspaceDeps = {}) {}

  private env(shown?: ShownProject): Env { return shown?.env ?? this.d.env ?? process.env; }

  /**
   * A frame for `shown`, made now. The producer reads the active project (the one chosen, else the folder it is given) by
   * itself; it is told the page's project only when that is another one, so a following page gets the very frame the
   * terminal Workbench draws.
   */
  private async make(shown: ShownProject): Promise<WorkspaceFrame> {
    let own = false;
    try { own = readActiveProject(shown.root).root === shown.root; } catch { own = false; }
    const o = { cwd: shown.root, env: this.env(shown), ...(own ? {} : { project: { name: shown.name, root: shown.root } }) };
    if (this.d.frame) return this.d.frame(o);
    const { buildWorkspaceFrame } = await import('../ops/workspace-frame.js');
    return buildWorkspaceFrame(o);
  }

  /** The frame for `shown`; one made in the last `shareMs` answers again unless `fresh`. */
  frame(shown: ShownProject, fresh = false): Promise<WorkspaceFrame> {
    const now = Date.now();
    const key = `${shown.root}\n${shown.name}`;
    const had = this.shared.get(key);
    if (!fresh && had && now - had.at < (this.d.shareMs ?? 750)) return had.made;
    const made = this.make(shown);
    this.shared.set(key, { at: now, made });
    made.catch(() => { if (this.shared.get(key)?.made === made) this.shared.delete(key); });
    return made;
  }

  /**
   * R5 lead (the final QA of a77d80d, defect 1): the frames shared for the project in `root` are let go, so the next read makes
   * one after what just happened there (the bus brought a sealed receipt: a turn's end, a run's).
   */
  forget(root: string): void {
    for (const k of [...this.shared.keys()]) if (k.startsWith(`${root}\n`)) this.shared.delete(k);
  }

  /** GET /api/workspace: the frame, or why there is none, in words. */
  async answerFrame(shown: ShownProject): Promise<Answer> {
    try {
      return { status: 200, body: await this.frame(shown) };
    } catch (err) {
      return { status: 500, body: { ok: false, error: `${WORKSPACE_FAILED}: ${words(err)}. Nothing was changed.` } };
    }
  }

  /** POST /api/workspace/prefs, one at a time (see the module's comment). */
  answerPrefs(shown: ShownProject, body: unknown): Promise<Answer> {
    const run = this.queue.then(() => this.prefsNow(shown, body), () => this.prefsNow(shown, body));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async prefsNow(shown: ShownProject, body: unknown): Promise<Answer> {
    if (!isObject(body)) return { status: 400, body: { error: PREFS_BAD_BODY } };
    const extra = Object.keys(body).filter((k) => k !== 'if_revision' && !(PREF_KEYS as readonly string[]).includes(k));
    const asked = PREF_KEYS.filter((k) => typeof body[k] === 'boolean');
    const wrong = PREF_KEYS.filter((k) => k in body && typeof body[k] !== 'boolean');
    const revision = body.if_revision;
    if (extra.length || wrong.length || !asked.length || typeof revision !== 'string' || !revision || revision.length > 128) return { status: 400, body: { error: PREFS_BAD_BODY } };
    let now: WorkspaceFrame;
    try { now = await this.frame(shown, true); } catch (err) {
      return { status: 500, body: { error: `${WORKSPACE_FAILED} to check this change against: ${words(err)}. Nothing was written.` } };
    }
    if (now.revision !== revision) return { status: 409, body: { error: 'stale', frame: now } };
    const env = this.env(shown);
    const read = (this.d.read ?? ((e: Env) => readSettings(e)))(env);
    if (read.state === 'unreadable') {
      return { status: 500, body: { error: `the Workbench's settings file could not be read (${words(read.error ?? 'unreadable')}), so nothing was written over it` } };
    }
    const next: WorkbenchSettings = { ...read.settings, layouts: { ...read.settings.layouts } };
    for (const k of asked) next[k] = body[k] as boolean;
    let saved: SaveResult;
    try { saved = (this.d.save ?? ((s: WorkbenchSettings, e: Env) => saveSettings(s, e)))(next, env); } catch (err) {
      saved = { ok: false, error: err instanceof Error ? err.message : String(err), path: '' };
    }
    if (!saved.ok) return { status: 500, body: { error: `the Workbench's settings file could not be written (${words(saved.error)}); nothing was changed` } };
    try {
      return { status: 200, body: { saved_at: saved.at, frame: await this.frame(shown, true) } };
    } catch (err) {
      // saved; the page asks for the frame again on its next poll
      return { status: 200, body: { saved_at: saved.at, frame: null, frame_error: `${WORKSPACE_FAILED}: ${words(err)}` } };
    }
  }
}

// ── R11 round 7 (H173): the project's FILES — read-only, for the Files page and Chat's attachments ───────────────────────
//
//   route                                       answers
//   GET /api/files?project=<id>&path=<rel>      200 the folder at `path` (the project's root when absent) of the project the
//                                               request is about: { ok, project: { id, name }, where, path, parent, entries,
//                                               count, truncated, words }; a path with "..", an absolute one, one leading out
//                                               of the project (a link) or one that is not there: 400 / 404 in words
//   GET /api/files/file?project=<id>&path=<rel> 200 the file: a text file as JSON { ok, kind: 'text', path, name, size, mtime,
//                                               text, truncated } (the first 256 KB; more is said); an image as its bytes with
//                                               its type (png, jpeg, gif, webp; at most 8 MB); anything else 415 in words
//                                               (kind 'binary': nothing is guessed at); a folder 400
//
// The project is identity.projectFor(req) (src/companion/identity/routes.ts): the signed-in user's own by ?project=<id>, else
// their default; the operator's by the companion's own rule. Every path is relative to THAT project's root and is resolved
// with links followed: whatever lands outside the root is not the project's and answers 404. Nothing here writes.
//
// THE ATTACHMENT SHAPE (for H171's Chat "+ Attach" and H169's turn): a file is named as { project: <id>, path: <rel> } —
// the same two the routes take; resolveProjectPath(root, path) is how a reader (the turn's) gets the real file or a refusal.

/** What an entry is: a folder, a file (with what the page may show of it), a link that leads out, or something else. */
export interface FileEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'other';
  size?: number;
  mtime?: string;
  /** a file's kind for the page: a text it may read, an image it may show, or neither */
  view?: 'text' | 'image' | 'binary';
  /** a folder the page lists lazily and names as heavy (node_modules, .git, dist …): shown, not opened by default */
  heavy?: boolean;
}

export interface FilesListing {
  ok: true;
  project: { id: string; name: string };
  /** where this project lives: its folder (from ~), and the Timmy home its records are under (from ~) */
  where: { root: string; home: string };
  path: string;
  parent: string | null;
  entries: FileEntry[];
  count: number;
  truncated: boolean;
  words: string;
}

export const FILES_LIMIT = 400;
export const FILE_TEXT_MAX = 256 * 1024;
export const FILE_IMAGE_MAX = 8 * 1024 * 1024;
const HEAVY = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', '.timmy']);
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env.example', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.html', '.htm', '.css', '.scss', '.less', '.svg', '.xml', '.csv', '.tsv', '.sql', '.graphql', '.gql', '.proto', '.lock', '.log', '.cast', '.rml', '.usda', '.obj', '.mtl', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.dockerfile', '.tf', '.lua', '.vim', '.el', '.clj', '.ex', '.exs', '.erl', '.hs', '.ml', '.r', '.jl', '.m', '.mm', '.pl', '.php', '.scala', '.dart', '.vue', '.svelte', '.astro', '.mdx', '.rst', '.tex', '.bib', '.ipynb', '.plist', '.pem', '.pub', '.txt~']);

export const FILES_WORDS = Object.freeze({
  badPath: 'That path is not one inside this project: a relative path, with no "..", names a file or folder of the project\'s.',
  outside: 'That is not inside this project (a link that leads out, or a path that is not there), so nothing was read.',
  notFolder: 'That is a file, not a folder; open it with /api/files/file.',
  notFile: 'That is a folder, not a file; list it with /api/files.',
  binary: 'This file is neither text nor an image this page shows (or it is larger than the page reads), so it is not opened here. Its size and place are shown; a tool of a turn can still read it.',
  tooLarge: (max: string) => `This file is larger than ${max}, so it is not opened here.`,
  empty: 'This project has no files yet. Start a conversation, or add files to its folder.',
  noProject: 'That project is not one of this account\'s (its id names none of your projects, or the path is outside them), so nothing was read.',
});

const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + sep);

/**
 * The real file or folder a relative `path` names inside `root` (links followed; the result is under the root, or it is
 * refused): { real, rel } or { error } in words. '' or '.' is the root itself.
 */
export function resolveProjectPath(root: string, path: unknown): { real: string; rel: string } | { error: string; status: 400 | 404 } {
  if (typeof path !== 'string') return { error: FILES_WORDS.badPath, status: 400 };
  const slashed = path.replace(/\\/g, '/');
  if (slashed.includes('\0') || isAbsolute(slashed) || slashed.startsWith('/') || slashed.split('/').some((part) => part === '..')) return { error: FILES_WORDS.badPath, status: 400 };
  const clean = posix.normalize(slashed.replace(/\/+$/g, '') || '.');
  const rel = clean === '.' ? '' : clean;
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return { error: FILES_WORDS.outside, status: 404 }; }
  let real: string;
  try { real = realpathSync(resolve(realRoot, ...rel.split('/').filter(Boolean))); } catch { return { error: FILES_WORDS.outside, status: 404 }; }
  if (!under(real, realRoot)) return { error: FILES_WORDS.outside, status: 404 };
  return { real, rel };
}

/** Whether the first bytes of a file read as text: no NUL, and what there is decodes as UTF-8. */
function looksText(real: string, size: number): boolean {
  const n = Math.min(size, 8192);
  if (n === 0) return true;
  const buf = Buffer.alloc(n);
  let fd: number | null = null;
  try { fd = openSync(real, 'r'); const got = readSync(fd, buf, 0, n, 0); const head = buf.subarray(0, got); if (head.includes(0)) return false; try { new TextDecoder('utf-8', { fatal: true }).decode(got < size ? head.subarray(0, Math.max(0, got - 4)) : head); return true; } catch { return false; } }
  catch { return false; }
  finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

/** Which view a file gets: an image by its type, a text by its extension or its bytes, else binary. */
export function viewOf(real: string, name: string, size: number): FileEntry['view'] {
  const ext = extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return size <= FILE_IMAGE_MAX ? 'image' : 'binary';
  if (TEXT_EXT.has(ext) || (!ext && size <= FILE_TEXT_MAX && looksText(real, size))) return 'text';
  if (size <= FILE_TEXT_MAX && looksText(real, size)) return 'text';
  return 'binary';
}

const stamp = (ms: number): string => new Date(ms).toISOString();

/** The folder `rel` of the project at `root`, listed: folders first, then files, by name; at most FILES_LIMIT entries. */
export function listProjectFolder(root: string, rel: string): { entries: FileEntry[]; truncated: boolean } | { error: string; status: 400 | 404 } {
  const at = resolveProjectPath(root, rel);
  if ('error' in at) return at;
  let st; try { st = statSync(at.real); } catch { return { error: FILES_WORDS.outside, status: 404 }; }
  if (!st.isDirectory()) return { error: FILES_WORDS.notFolder, status: 400 };
  let dirents: Dirent[];
  try { dirents = readdirSync(at.real, { withFileTypes: true }); } catch { return { error: FILES_WORDS.outside, status: 404 }; }
  const realRoot = realpathSync(root);
  const rows: FileEntry[] = [];
  for (const d of dirents) {
    const name = d.name;
    const path = at.rel ? `${at.rel}/${name}` : name;
    const full = join(at.real, name);
    let kind: FileEntry['kind'] = 'other';
    let target = full;
    try {
      const l = lstatSync(full);
      if (l.isSymbolicLink()) {
        // a link: followed; one that leads out of the project is listed as "other" (nothing of it is read)
        try { target = realpathSync(full); } catch { rows.push({ name, path, kind: 'other' }); continue; }
        if (!under(target, realRoot)) { rows.push({ name, path, kind: 'other' }); continue; }
      }
      const t = statSync(target);
      if (t.isDirectory()) kind = 'dir'; else if (t.isFile()) kind = 'file';
      if (kind === 'dir') rows.push({ name, path, kind, mtime: stamp(t.mtimeMs), ...(HEAVY.has(name) ? { heavy: true } : {}) });
      else if (kind === 'file') rows.push({ name, path, kind, size: t.size, mtime: stamp(t.mtimeMs), view: viewOf(target, name, t.size) });
      else rows.push({ name, path, kind });
    } catch { rows.push({ name, path, kind: 'other' }); }
  }
  const order = (e: FileEntry): number => (e.kind === 'dir' ? 0 : e.kind === 'file' ? 1 : 2);
  rows.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { entries: rows.slice(0, FILES_LIMIT), truncated: rows.length > FILES_LIMIT };
}

/** The media the Workspace canvas may draw from an app's delivered files (GET /api/files/media). */
export const MEDIA_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  // the unified Workspace order: a 3D model (GLB) and a Rive file, read as bytes by the page's own viewers (never run by the browser)
  '.glb': 'model/gltf-binary', '.riv': 'application/octet-stream',
  // the spatial tools order (2026-10-28): a Gaussian splat (PLY), read as bytes by the Workspace's splat viewer (Spark)
  '.ply': 'application/octet-stream' };
/** The unified Workspace order: an app's HTML export, shown only in an isolated preview (a sandboxed frame of its own origin). */
export const PREVIEW_TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8' };
export const PREVIEW_MAX = 20 * 1024 * 1024;
/** What POST /api/files/import takes (the spatial tools order): a splat, a posed dataset, a model, an image; at most 200 MB. */
export const IMPORT_TYPES: readonly string[] = ['.ply', '.zip', '.glb', '.png', '.jpg', '.jpeg', '.webp'];
export const IMPORT_MAX = 200 * 1024 * 1024;
export const PREVIEW_MS = 5 * 60_000;
/**
 * The policy an HTML preview is sent with: a sandbox WITHOUT allow-same-origin (its origin is opaque: it cannot read Timmy's
 * page, storage or token, and it sends no request back to Timmy), its own inline script and style, images and media only from
 * itself (data:, blob:), no network, framed only by Timmy's own page.
 */
export const PREVIEW_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'";
export const MEDIA_MAX = 200 * 1024 * 1024;

/** A text file's contents (the first FILE_TEXT_MAX bytes) or an image's bytes, or why not. */
export function readProjectFile(root: string, rel: string): { kind: 'text'; name: string; path: string; size: number; mtime: string; text: string; truncated: boolean } | { kind: 'image'; name: string; path: string; size: number; mtime: string; type: string; bytes: Buffer } | { error: string; status: 400 | 404 | 415 } {
  const at = resolveProjectPath(root, rel);
  if ('error' in at) return at;
  let st; try { st = statSync(at.real); } catch { return { error: FILES_WORDS.outside, status: 404 }; }
  if (st.isDirectory()) return { error: FILES_WORDS.notFile, status: 400 };
  if (!st.isFile()) return { error: FILES_WORDS.outside, status: 404 };
  const name = basename(at.real);
  const view = viewOf(at.real, name, st.size);
  const common = { name, path: at.rel, size: st.size, mtime: stamp(st.mtimeMs) };
  if (view === 'image') {
    const type = IMAGE_TYPES[extname(name).toLowerCase()]!;
    let fd: number | null = null;
    try { fd = openSync(at.real, 'r'); const bytes = Buffer.alloc(st.size); const got = readSync(fd, bytes, 0, st.size, 0); return { kind: 'image', ...common, type, bytes: bytes.subarray(0, got) }; }
    catch { return { error: FILES_WORDS.outside, status: 404 }; }
    finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
  }
  if (view === 'text') {
    const n = Math.min(st.size, FILE_TEXT_MAX);
    let fd: number | null = null;
    try { fd = openSync(at.real, 'r'); const buf = Buffer.alloc(n); const got = readSync(fd, buf, 0, n, 0); return { kind: 'text', ...common, text: buf.subarray(0, got).toString('utf8'), truncated: st.size > n }; }
    catch { return { error: FILES_WORDS.outside, status: 404 }; }
    finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
  }
  return { error: st.size > FILE_TEXT_MAX && !IMAGE_TYPES[extname(name).toLowerCase()] ? `${FILES_WORDS.binary} ${FILES_WORDS.tooLarge('256 KB')}` : FILES_WORDS.binary, status: 415 };
}

export interface FilesDeps {
  /** the launch token's check (server.ts withToken), first */
  withToken: RequestHandler;
  /** the session's check (identity.withUser): the user, or the operator when no provider is configured */
  withUser: RequestHandler;
  /** the project the request is about (identity.projectFor): null → 404 in words */
  projectFor: (req: Parameters<RequestHandler>[0]) => { id: string; name: string; root: string } | null;
  /** the user's env (identity.envOf): its Timmy home is "where the records are" */
  envOf: (req: Parameters<RequestHandler>[0]) => Env;
}

/** Mounts GET /api/files and GET /api/files/file (see the section's words). */
export function mountFiles(app: Application, deps: FilesDeps): void {
  const homeOf = (env: Env): string => tildePath(resolve(env.TIMMY_HOME || join(process.env.HOME || '', 'timmy')));
  app.get('/api/files', deps.withToken, deps.withUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = deps.projectFor(req);
    if (!project) { failRequest(res, 404, FILES_WORDS.noProject); return; }
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const listed = listProjectFolder(project.root, rel);
    if ('error' in listed) { failRequest(res, listed.status, listed.error); return; }
    const at = resolveProjectPath(project.root, rel) as { real: string; rel: string };
    const parent = at.rel ? posix.dirname(at.rel).replace(/^\.$/, '') : null;
    const words = listed.entries.length === 0 ? (at.rel ? 'This folder is empty.' : FILES_WORDS.empty) : `${listed.entries.length}${listed.truncated ? ` of more than ${FILES_LIMIT}` : ''} ${listed.entries.length === 1 ? 'item' : 'items'}${listed.truncated ? ' (the first are shown)' : ''}.`;
    const body: FilesListing = { ok: true, project: { id: project.id, name: project.name }, where: { root: tildePath(project.root), home: homeOf(deps.envOf(req)) }, path: at.rel, parent, entries: listed.entries, count: listed.entries.length, truncated: listed.truncated, words };
    res.json(body);
  });
  // The spatial tools order (2026-10-28): a file from this computer brought into the project for the Workspace (a splat to
  // edit, a posed dataset for Brush, a model or an image): written at from-apps/import/<id>/<its name> (never over other
  // bytes) and sealed with ONE receipt (kind import: its name, hash and size; a PLY's own header facts), so it is a project
  // file with provenance like an app's result, and the canvas and the operations take it the same way. Nothing is run.
  app.post('/api/files/import', deps.withToken, deps.withUser, express.raw({ type: () => true, limit: IMPORT_MAX }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = deps.projectFor(req);
    if (!project) { failRequest(res, 404, FILES_WORDS.noProject); return; }
    const name = basename(String(req.get('x-file-name') ?? '')).replace(/[^A-Za-z0-9._ +()-]/g, '_').slice(0, 120);
    const ext = extname(name).toLowerCase();
    if (!name || !IMPORT_TYPES.includes(ext)) { failRequest(res, 415, `Imports take ${IMPORT_TYPES.join(', ')}.`); return; }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) { failRequest(res, 400, 'The file is empty.'); return; }
    const ply = ext === '.ply' ? gaussianPlyHeader(bytes) : null;
    const id = `i${randomBytes(5).toString('hex')}`;
    const rel = deliveredPath('import', id, name);
    if (!rel || !deliverInto(project.root)(rel, bytes)) { failRequest(res, 500, 'The file could not be written into the project.'); return; }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const receipt = appendReceipt('runs', {
      kind: 'import', subject: 'workspace.import', policy: 'person-started', status: 'ok', project: project.name, project_id: projectId(project.root),
      job: { id, kind: 'import', label: name, state: 'completed' }, outputs: [{ path: rel, sha256, bytes: bytes.length }],
      ...(ply ? { imported: { name, gaussian: ply.ok, format: ply.format, vertices: ply.vertices, fixture: ply.fixture, ...(ply.ok ? {} : { why: ply.why ?? null }) } } : { imported: { name } }),
    }, project.root);
    res.json({ ok: true, result: { receipt: receipt.hash.slice(7, 15), app: 'import', title: 'Imported from this computer', job: id, label: name, status: 'ok', at: receipt.ts, files: [{ path: rel, name, sha256, bytes: bytes.length, image: /\.(png|jpe?g|webp)$/i.test(name), sent: [] }] }, ...(ply ? { ply } : {}) });
  });
  // The 07:37 pass (the Mac pass of 1c5da0a): the Workspace canvas draws an app's delivered image, SVG or video from its
  // bytes. Only files under from-apps/ (what the apps delivered, each with its receipt), only these media types, up to
  // MEDIA_MAX; an SVG is sent with a sandboxing CSP (an <img> runs no script anyway). Everything else stays /api/files/file's.
  app.get('/api/files/media', deps.withToken, deps.withUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = deps.projectFor(req);
    if (!project) { failRequest(res, 404, FILES_WORDS.noProject); return; }
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const at = resolveProjectPath(project.root, rel);
    if ('error' in at) { failRequest(res, at.status, at.error); return; }
    if (!/^from-apps\//.test(at.rel)) { failRequest(res, 403, 'Only what an app delivered (from-apps/) is served as media.'); return; }
    const type = MEDIA_TYPES[extname(at.real).toLowerCase()];
    if (!type) { failRequest(res, 415, 'Not an image, SVG, video, GLB model, Rive file or splat (PLY).'); return; }
    let st; try { st = statSync(at.real); } catch { failRequest(res, 404, FILES_WORDS.outside); return; }
    if (!st.isFile()) { failRequest(res, 404, FILES_WORDS.outside); return; }
    if (st.size > MEDIA_MAX) { failRequest(res, 413, 'Larger than 200 MB: open it in its app.'); return; }
    res.set('X-Content-Type-Options', 'nosniff').set('Content-Disposition', 'inline');
    if (type === 'image/svg+xml') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.type(type).sendFile(at.real);
  });

  // The unified Workspace order: an app's HTML export (an animation's player, a page) in an ISOLATED preview. The page asks for a
  // grant (POST, with its token: only from-apps/ HTML up to PREVIEW_MAX); the grant is an unguessable address of that one file,
  // good for PREVIEW_MS, that a sandboxed frame loads without the token (a frame cannot send one). The bytes are read when the
  // frame loads them and sent with PREVIEW_POLICY (an opaque origin: nothing in the file can reach Timmy).
  const grants = new Map<string, { real: string; until: number }>();
  app.post('/api/files/preview', deps.withToken, deps.withUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = deps.projectFor(req);
    if (!project) { failRequest(res, 404, FILES_WORDS.noProject); return; }
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const at = resolveProjectPath(project.root, rel);
    if ('error' in at) { failRequest(res, at.status, at.error); return; }
    if (!/^from-apps\//.test(at.rel)) { failRequest(res, 403, 'Only what an app delivered (from-apps/) is previewed.'); return; }
    if (!PREVIEW_TYPES[extname(at.real).toLowerCase()]) { failRequest(res, 415, 'Not an HTML file.'); return; }
    let st; try { st = statSync(at.real); } catch { failRequest(res, 404, FILES_WORDS.outside); return; }
    if (!st.isFile()) { failRequest(res, 404, FILES_WORDS.outside); return; }
    if (st.size > PREVIEW_MAX) { failRequest(res, 413, 'Larger than 20 MB: open it in its app.'); return; }
    const now = Date.now();
    for (const [k, g] of grants) if (g.until < now) grants.delete(k);
    const id = randomBytes(24).toString('hex');
    grants.set(id, { real: at.real, until: now + PREVIEW_MS });
    res.json({ ok: true, url: `/files-preview/${id}`, until: new Date(now + PREVIEW_MS).toISOString(), policy: PREVIEW_POLICY });
  });
  app.get('/files-preview/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const g = grants.get(String(req.params.id));
    if (!g || g.until < Date.now()) { res.status(404).type('text/plain').send('This preview has ended: open it again from the Workspace.'); return; }
    res.set('Content-Security-Policy', PREVIEW_POLICY).set('X-Frame-Options', 'SAMEORIGIN').set('X-Content-Type-Options', 'nosniff').set('Referrer-Policy', 'no-referrer').set('Cross-Origin-Resource-Policy', 'same-origin');
    res.type(PREVIEW_TYPES[extname(g.real).toLowerCase()] ?? 'text/plain').sendFile(g.real);
  });

  app.get('/api/files/file', deps.withToken, deps.withUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = deps.projectFor(req);
    if (!project) { failRequest(res, 404, FILES_WORDS.noProject); return; }
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const got = readProjectFile(project.root, rel);
    if ('error' in got) { failRequest(res, got.status, got.error); return; }
    if (got.kind === 'image') { res.set('X-Content-Type-Options', 'nosniff').set('Content-Disposition', 'inline').type(got.type).send(got.bytes); return; }
    res.json({ ok: true, kind: 'text', name: got.name, path: got.path, size: got.size, mtime: got.mtime, text: got.text, truncated: got.truncated });
  });
}
