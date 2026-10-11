/**
 * One flow at a time in a project, of any kind, also while one is being started (round R4, the review's R4-5).
 *
 * A start of each kind (tray, blender, scad, freecad and, since H41, ae) awaits before its flow is registered as running (the
 * Codex preflight, /agent's own start), and a second start could pass the "one flow at a time" check in that time. So
 * every start takes its project here before its first await and gives it back when it ends, however it ends
 * (src/repl/iterate.ts holds it around each start, for /iterate and for the agent's tools alike); a start made while
 * another holds the project is refused. Once a flow is registered, its kind's running flows say it runs.
 *
 * The project is its folder (its real path when it has one). A start names its flow (its id) before its first await,
 * so a refused start can say which flow holds the project.
 *
 * Round R4 (H51): across processes too. A REPL and a `timmy act` may work in one project at once, so a start also takes
 * the project's hold file (src/ops/flow-hold.ts: its writer's pid and start, never a stale one trusted), kept until its
 * flow ends (keepUntil); a start, and the board's parameter save, see a hold another live process has there (elsewhere).
 */
import fs from 'node:fs';
import path from 'node:path';
import { currentOperation } from '../ops/context.js';
import { otherHolds, takeProjectHold, type OtherHold, type ProjectHold } from '../ops/flow-hold.js';

export type FlowKind = 'tray' | 'blender' | 'scad' | 'freecad' | 'ae';

/** A start that holds a project: its kind, and its flow's id once the start has made one. */
export interface FlowHold {
  readonly key: string;
  readonly kind: FlowKind;
  id?: string;
  /** R4 (H51): this start's hold file in the project (absent when the folder is not there) */
  file?: ProjectHold;
  /** R4 (H51): a refusal: the hold another live process has on the project */
  elsewhere?: OtherHold;
  /** R4 (H51): a refusal: why the hold file could not be taken */
  error?: string;
}

const keyOf = (root: string): string => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };

export class FlowLock {
  private readonly holds = new Map<string, FlowHold>();
  /** R4 (H51): the hold files this lock keeps now (a start's, and a flow's until it ends), by project, by file name */
  private readonly files = new Map<string, Set<string>>();

  /** Takes the project for a start: its hold, or the hold of the start that has it already (here or in another process). */
  take(root: string, kind: FlowKind): { ok: true; hold: FlowHold } | { ok: false; by: FlowHold } {
    const key = keyOf(root);
    const by = this.holds.get(key);
    if (by) return { ok: false, by };
    // R4 (H51): the project's hold file, seen by other processes; one of theirs refuses this start.
    const f = takeProjectHold(root, { kind, ...(currentOperation() ? { operation: currentOperation() } : {}), mine: this.files.get(key) ?? new Set() });
    if (!f.ok) {
      if ('error' in f) return { ok: false, by: { key, kind, error: f.error } };
      return { ok: false, by: { key, kind: (['tray', 'blender', 'scad', 'freecad', 'ae'] as const).find((k) => k === f.by.kind) ?? kind, ...(f.by.flow ? { id: f.by.flow } : {}), elsewhere: f.by } };
    }
    const hold: FlowHold = { key, kind, ...(f.hold ? { file: f.hold } : {}) };
    if (f.hold) this.mine(key).add(f.hold.rel);
    this.holds.set(key, hold);
    return { ok: true, hold };
  }

  /** Names the flow the start holding the project is starting (its first name stays). */
  name(root: string, id: string): void {
    const h = this.holds.get(keyOf(root));
    if (h && !h.id) { h.id = id; h.file?.name(id); }
  }

  /** The start holding the project now, if one does. */
  holder(root: string): FlowHold | undefined { return this.holds.get(keyOf(root)); }

  /** R4 (H51): a live hold another process (or another lock) has on the project, if any. */
  elsewhere(root: string): OtherHold | undefined {
    const key = keyOf(root);
    return otherHolds(root, this.files.get(key) ?? new Set())[0];
  }

  /** Gives the project back; only the hold that took it can. Its hold file goes too, unless its flow keeps it (keepUntil). */
  release(hold: FlowHold, o: { keepFile?: boolean } = {}): void {
    if (this.holds.get(hold.key) === hold) this.holds.delete(hold.key);
    if (!o.keepFile) this.dropFile(hold);
  }

  /** R4 (H51): the hold file stays until the flow the start made has ended (its record written), whatever way it ends. */
  keepUntil(hold: FlowHold, done: Promise<unknown>): void {
    const drop = (): void => this.dropFile(hold);
    done.then(drop, drop);
  }

  private mine(key: string): Set<string> {
    let s = this.files.get(key);
    if (!s) { s = new Set(); this.files.set(key, s); }
    return s;
  }

  private dropFile(hold: FlowHold): void {
    if (!hold.file) return;
    hold.file.release();
    this.files.get(hold.key)?.delete(hold.file.rel);
  }
}
