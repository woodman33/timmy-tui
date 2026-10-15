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
import type { WorkspaceFrame } from '../contracts/workspace.js';
import { readActiveProject } from '../project/index.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { readSettings, saveSettings, type SaveResult, type SettingsRead, type WorkbenchSettings } from '../workbench/settings.js';

type Env = Record<string, string | undefined>;

/** The project a page shows (src/companion/project.ts): its name and its folder. */
export interface ShownProject { name: string; root: string }

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

  private env(): Env { return this.d.env ?? process.env; }

  /**
   * A frame for `shown`, made now. The producer reads the active project (the one chosen, else the folder it is given) by
   * itself; it is told the page's project only when that is another one, so a following page gets the very frame the
   * terminal Workbench draws.
   */
  private async make(shown: ShownProject): Promise<WorkspaceFrame> {
    let own = false;
    try { own = readActiveProject(shown.root).root === shown.root; } catch { own = false; }
    const o = { cwd: shown.root, env: this.env(), ...(own ? {} : { project: { name: shown.name, root: shown.root } }) };
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
    const env = this.env();
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
