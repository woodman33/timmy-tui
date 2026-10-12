/**
 * R4 (H104, second part): the project the browser companion shows (the operator's direction of 2026-10-11: one project, three
 * connected workspaces; "every surface prominently shows the project ... following windows change project together; pinned
 * windows keep their visibly identified project").
 *
 * The project is the active one: src/project/index.ts readActiveProject, the record <TIMMY_HOME>/state/active-project.json
 * that the REPL's /project, the monitor, Timmy Canvas and the terminal Workbench write; with no record (or one naming a
 * folder that is gone), the folder this companion was started in. A change of the record is followed: its folder is watched
 * (fs.watch), and read again once a second at most as well (a watch can miss a change on some file systems, or the folder
 * may not exist yet). TIMMY_REPO, when it is set as the companion starts, fixes the folder instead (the lanes and tests that
 * start a companion of their own name it), and the page says so: that companion follows nothing.
 *
 * What the companion tails for a page, its event bus (the Chat Mirror's REPL turns) and its receipts, is the shown project's
 * own: <root>/.timmy/receipts/runs.jsonl and <root>/.timmy/runs/timmy-events.jsonl, where the REPL writes them while it works
 * in that project (src/bus busPath: the REPL's working folder, which /project changes). A page may pin the project it shows
 * (server.ts keeps each page's own); this module only knows the active one and the projects a page may name by id.
 *
 * A page is never sent a path but a folder written from ~ (src/utils/home-scrub.ts tildePath), and names a project by its id
 * (src/project/index.ts projectId: a hash of its folder), which the companion maps back only to a folder it knows: one it
 * has shown, or one under <TIMMY_HOME>/projects.
 */
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { activeProjectPath, folderProject, listProjects, projectId, readActiveProject, type ActiveProject } from '../project/index.js';
import { tildePath } from '../utils/home-scrub.js';

/** How often the record is read again besides the watch: never more often than once a second (the operator's rule). */
export const PROJECT_POLL_MS = 1000;
/** A burst of watch events (a write, then its rename) is read once, this long after the last. */
const SETTLE_MS = 50;

/** A project id as the page sends it: 16 hex (src/project/index.ts projectId). */
export const PROJECT_ID = /^[0-9a-f]{16}$/;

/** Why the page shows the project it shows. */
export type ProjectMode = 'following' | 'pinned' | 'fixed';

/** What a page is told of the project it shows (never a path: folders are written from ~). */
export interface ProjectView {
  id: string;
  name: string;
  /** its folder, from ~ */
  folder: string;
  /** chosen in Timmy (the active-project record names it), or the folder this companion was started in */
  chosen: boolean;
  mode: ProjectMode;
  /** where the active project is recorded, from ~ */
  record: string;
  /** the active project now: a pinned page says so when it is another one */
  active: { id: string; name: string; folder: string };
  /** a pin the page asked for that this companion could not keep, in words */
  note?: string;
}

const same = (a: ActiveProject, b: ActiveProject): boolean => a.root === b.root && a.name === b.name && a.chosen === b.chosen;

export class ProjectFollower {
  private cur: ActiveProject;
  private readonly fixedRoot: string | null;
  private readonly record: string;
  private readonly known = new Map<string, ActiveProject>();
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private settle: NodeJS.Timeout | null = null;
  private stopped = false;

  /**
   * `cwd`: the folder this companion was started in (the project when nothing is recorded). `fixed`: TIMMY_REPO as it was
   * when the companion started (then nothing is followed). `onChange`: the active project changed (not called when fixed).
   */
  constructor(private readonly o: { cwd: string; fixed?: string | null; pollMs?: number; onChange: (p: ActiveProject) => void }) {
    this.fixedRoot = o.fixed ? o.fixed : null;
    this.record = activeProjectPath();
    this.cur = this.fixedRoot ? folderProject(this.fixedRoot) : readActiveProject(o.cwd);
    this.remember(this.cur);
    if (this.fixedRoot) return;
    this.watchRecord();
    this.poll = setInterval(() => { this.watchRecord(); this.check(); }, Math.max(PROJECT_POLL_MS, o.pollMs ?? PROJECT_POLL_MS));
    this.poll.unref();
  }

  /** The project a following page shows now: the active one (or the fixed folder). */
  current(): ActiveProject { return this.cur; }

  /** Whether TIMMY_REPO fixed the folder (nothing is followed or pinned). */
  get fixed(): boolean { return this.fixedRoot !== null; }

  /** The project a page names by its id: one this companion has shown, or one under <TIMMY_HOME>/projects; else null. */
  find(id: string): ActiveProject | null {
    if (!PROJECT_ID.test(id)) return null;
    const seen = this.known.get(id);
    if (seen) return seen;
    for (const p of listProjects()) {
      const project: ActiveProject = { name: p.name, root: p.root, chosen: true };
      if (projectId(p.root) === id) { this.remember(project); return project; }
    }
    return null;
  }

  /** What a page is told of `shown`, in `mode`. */
  view(shown: ActiveProject, mode: ProjectMode, note?: string): ProjectView {
    const active = this.cur;
    return {
      id: projectId(shown.root), name: shown.name, folder: tildePath(shown.root), chosen: shown.chosen, mode,
      record: tildePath(this.record),
      active: { id: projectId(active.root), name: active.name, folder: tildePath(active.root) },
      ...(note ? { note } : {}),
    };
  }

  /** Reads the record now; tells `onChange` when the active project is another one (or renamed). */
  check(): void {
    if (this.stopped || this.fixedRoot) return;
    let next: ActiveProject;
    try { next = readActiveProject(this.o.cwd); } catch { return; }
    if (same(next, this.cur)) return;
    this.cur = next;
    this.remember(next);
    this.o.onChange(next);
  }

  stop(): void {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.settle) clearTimeout(this.settle);
    this.watcher?.close();
    this.watcher = null;
  }

  private remember(p: ActiveProject): void { this.known.set(projectId(p.root), p); }

  /** Watches the record's folder (the record is replaced by a rename: its own file's watch would end there). */
  private watchRecord(): void {
    if (this.watcher || this.stopped) return;
    try {
      const name = basename(this.record);
      this.watcher = watch(dirname(this.record), { persistent: false }, (_event, file) => {
        // the record, or the temporary file its writer renames over it (src/project/index.ts saveActiveProject)
        if (file && !String(file).startsWith(name)) return;
        if (this.settle) clearTimeout(this.settle);
        this.settle = setTimeout(() => { this.settle = null; this.check(); }, SETTLE_MS);
        this.settle.unref();
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      // no state folder yet: the poll watches again once it is there
      this.watcher = null;
    }
  }
}

/** The bus files the companion tails in a project's folder (src/bus busPath; the legacy file older writers use). */
export function busFilesOf(root: string): string[] {
  return [join(root, '.timmy', 'receipts', 'runs.jsonl'), join(root, '.timmy', 'runs', 'timmy-events.jsonl')];
}
