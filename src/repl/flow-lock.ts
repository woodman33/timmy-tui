/**
 * One flow at a time in a project, of any kind, also while one is being started (round R4, the review's R4-5).
 *
 * A start of each of the four kinds (tray, blender, scad, freecad) awaits before its flow is registered as running (the
 * Codex preflight, /agent's own start), and a second start could pass the "one flow at a time" check in that time. So
 * every start takes its project here before its first await and gives it back when it ends, however it ends
 * (src/repl/iterate.ts holds it around each start, for /iterate and for the agent's tools alike); a start made while
 * another holds the project is refused. Once a flow is registered, its kind's running flows say it runs.
 *
 * The project is its folder (its real path when it has one). A start names its flow (its id) before its first await,
 * so a refused start can say which flow holds the project. Nothing here is written to disk: it holds this REPL's starts.
 */
import fs from 'node:fs';
import path from 'node:path';

export type FlowKind = 'tray' | 'blender' | 'scad' | 'freecad';

/** A start that holds a project: its kind, and its flow's id once the start has made one. */
export interface FlowHold { readonly key: string; readonly kind: FlowKind; id?: string }

const keyOf = (root: string): string => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };

export class FlowLock {
  private readonly holds = new Map<string, FlowHold>();

  /** Takes the project for a start: its hold, or the hold of the start that has it already. */
  take(root: string, kind: FlowKind): { ok: true; hold: FlowHold } | { ok: false; by: FlowHold } {
    const key = keyOf(root);
    const by = this.holds.get(key);
    if (by) return { ok: false, by };
    const hold: FlowHold = { key, kind };
    this.holds.set(key, hold);
    return { ok: true, hold };
  }

  /** Names the flow the start holding the project is starting (its first name stays). */
  name(root: string, id: string): void {
    const h = this.holds.get(keyOf(root));
    if (h && !h.id) h.id = id;
  }

  /** The start holding the project now, if one does. */
  holder(root: string): FlowHold | undefined { return this.holds.get(keyOf(root)); }

  /** Gives the project back; only the hold that took it can. */
  release(hold: FlowHold): void {
    if (this.holds.get(hold.key) === hold) this.holds.delete(hold.key);
  }
}
