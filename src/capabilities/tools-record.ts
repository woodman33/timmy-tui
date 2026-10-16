/**
 * R6 (H140; the one waiting count, the operator's order of 2026-10-16, priority 2): the last /tools check, as a record every
 * Timmy process reads. The Control Room's "needs setup" items (src/room/decisions.ts: a /tools row that needs setup for a tool
 * a run of this project used) came from rows only the process that checked held in memory, so the Workbench counted an item
 * the workspace frame (the companion, Studio, `timmy workspace`) did not. A check through liveDeps now records what it found
 * here: <TIMMY_HOME>/state/tools.json, mode 0600, written whole (a temporary file renamed over it). It holds each row's id,
 * kind, name, rung, detail and setup step (the rows are scrubbed of home paths; no key or value of a setting is in a row),
 * and the time of the check. It is the check's own result, nothing more: nothing is installed, run or sealed.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { timmyHome } from '../setup/home.js';
import type { CapabilityRow } from './index.js';

type Env = Record<string, string | undefined>;

export const TOOLS_CHECK_SCHEMA = 'timmy.tools-check/1' as const;

/** The rows as the Control Room reads them (src/room/index.ts RoomTools). */
export interface ToolsCheck { checkedAt: string; rows: CapabilityRow[] }

export const toolsCheckPath = (env: Env = process.env): string => join(timmyHome(env), 'state', 'tools.json');

/** Records the check's rows (only the fields a reader uses); a record that cannot be written leaves the last one. */
export function writeToolsCheck(rows: readonly CapabilityRow[], env: Env = process.env, at: Date = new Date()): boolean {
  try {
    const file = toolsCheckPath(env);
    mkdirSync(dirname(file), { recursive: true });
    const kept = rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, rung: r.rung, detail: r.detail, ...(r.setup ? { setup: r.setup } : {}) }));
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, `${JSON.stringify({ schema: TOOLS_CHECK_SCHEMA, checkedAt: at.toISOString(), rows: kept })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** The last recorded check, or undefined when none is readable. */
export function readToolsCheck(env: Env = process.env): ToolsCheck | undefined {
  try {
    const raw = JSON.parse(readFileSync(toolsCheckPath(env), 'utf8')) as { schema?: unknown; checkedAt?: unknown; rows?: unknown };
    if (raw?.schema !== TOOLS_CHECK_SCHEMA || typeof raw.checkedAt !== 'string' || !Number.isFinite(Date.parse(raw.checkedAt)) || !Array.isArray(raw.rows)) return undefined;
    const rows = raw.rows.filter((r): r is CapabilityRow => Boolean(r) && typeof r === 'object' && typeof (r as CapabilityRow).id === 'string' && typeof (r as CapabilityRow).rung === 'string');
    return { checkedAt: raw.checkedAt, rows };
  } catch {
    return undefined;
  }
}

/** The newer of two checks (a caller's own, the recorded one); either may be absent. */
export function newerTools(a: ToolsCheck | undefined, b: ToolsCheck | undefined): ToolsCheck | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.checkedAt) > Date.parse(a.checkedAt) ? b : a;
}
