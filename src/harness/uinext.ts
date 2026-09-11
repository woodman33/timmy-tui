// ui-next — readers for the capabilities the new lanes added: Unreal (runtime
// paths + render proof), Houdini (engine shelf + drop lane), schema strictness
// (captain's model-strictness table), and the Signal game (checkpoint + budget
// ledger + attention). Every read is defensive: missing lane/state ⇒ inert row,
// never a throw. These lanes are other orders' artifacts; the TUI surfaces
// them, it does not reimplement them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = (): string => process.env.TIMMY_REPO_ROOT ?? process.cwd();
const readJson = (p: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

export interface UnrealRow {
  present: boolean; root: 'env' | 'shared' | 'unset'; rc: boolean; py: 'pending' | 'ok';
  lastRender: { hash: string; stage: string } | null;
}
/** Unreal: project root token (never the raw path — privacy), RC channel =
 *  resolved root exists, Python channel stays 'pending' until a native
 *  unreal.render receipt qualifies it (lane README: not qualified yet). */
export function unrealRow(recs: { subject: string; hash?: string; sources?: unknown[] }[]): UnrealRow {
  const lane = join(root(), 'lanes', 'unreal');
  const envRoot = process.env.UNREAL_ENGINE_ROOT ?? null;
  const shared = join(homedir(), '..', 'Shared', 'Epic Games');
  const rcRoot = envRoot ?? (existsSync(shared) ? shared : null);
  const render = [...recs].reverse().find(r => String(r.subject).startsWith('unreal.render')) ?? null;
  const m = (render?.sources?.[0] ?? {}) as Record<string, unknown>;
  return {
    present: existsSync(lane),
    root: envRoot ? 'env' : rcRoot ? 'shared' : 'unset',
    rc: Boolean(rcRoot && existsSync(rcRoot)),
    py: render ? 'ok' : 'pending',
    lastRender: render ? { hash: String(render.hash ?? '').slice(7, 15), stage: String(m.stage ?? m.stage_sha256 ?? '—').slice(0, 18) } : null,
  };
}

export interface HoudiniRow {
  present: boolean; installed: boolean; version: string; bridge: string;
  templates: number; proven: number; dropRuns: number;
}
/** Houdini: engine-shelf inventory + drop-lane state (sealed drop runs). */
export function houdiniRow(recs: { subject: string; sources?: unknown[] }[]): HoudiniRow {
  const eng = (readJson(join(root(), 'lanes', 'engines', 'engines.json'))?.engines ?? []) as Record<string, unknown>[];
  const inv = (readJson(join(root(), 'lanes', 'engines', 'inventory.json'))?.engines ?? []) as Record<string, unknown>[];
  const e = eng.find(x => x.id === 'houdini') ?? inv.find(x => x.id === 'houdini') ?? null;
  const i = inv.find(x => x.id === 'houdini') ?? null;
  const count = (v: unknown): number => (Array.isArray(v) ? v.length : Number(v ?? 0) || 0);
  const dropRuns = recs.filter(r => {
    const subject = String(r.subject);
    if (subject !== 'engine.run' && subject !== 'engine.refuse') return false;
    const meta = (Array.isArray(r.sources) && typeof r.sources[0] === 'object' && r.sources[0] !== null ? r.sources[0] : {}) as Record<string, unknown>;
    return meta.engine === 'houdini';
  }).length;
  return {
    present: Boolean(e),
    installed: Boolean(e?.installed),
    version: String(e?.version ?? '—').split(' (')[0].slice(0, 18),
    bridge: Array.isArray(e?.bridge) ? (e?.bridge as string[]).join(',') : '—',
    templates: count(i?.templates),
    proven: count(i?.proven),
    dropRuns,
  };
}

export interface StrictRow { model: string; schema: 'strict' | 'lenient' | 'never'; }
/** captain's schema lane: per-model tool-schema strictness; unlisted = never measured. */
export function modelStrictness(): StrictRow[] {
  const j = readJson(join(root(), 'lanes', 'schema', 'model-strictness.json'));
  const rows = (j?.rows ?? []) as Record<string, unknown>[];
  return rows.map(r => ({
    model: String(r.model ?? '?'),
    schema: r.tool_schema === 'strict' ? 'strict' : r.tool_schema === 'lenient' ? 'lenient' : 'never',
  }));
}

export interface SignalState {
  live: boolean; round: number; status: string; receipt: string;
  attention: number; reserved: number; rows: number; dir: string;
}
/** the Signal game: live when a checkpoint exists and is not complete; ledger
 *  reservations from the first directory that carries reservations.jsonl. */
export function signalState(): SignalState | null {
  const projectDir = process.env.TIMMY_SIGNAL_DIR ?? join(homedir(), 'timmy', 'projects', 'the-signal');
  const cp = readJson(join(projectDir, 'out', 'latest-checkpoint.json'));
  if (!cp) return null;
  const live = String(cp.status ?? '') !== 'complete';
  const opening = readJson(join(projectDir, 'out', 'opening-state.json'));
  const st = (opening?.state ?? opening ?? {}) as Record<string, unknown>;
  let dir = '';
  let rows: Record<string, unknown>[] = [];
  for (const cand of [join(projectDir, 'out', 'ledger'), join(projectDir, 'out'), join(root(), '.timmy', 'signal')]) {
    if (existsSync(join(cand, 'reservations.jsonl'))) {
      dir = cand;
      try { rows = readFileSync(join(cand, 'reservations.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>); } catch { rows = []; }
      break;
    }
  }
  const reserved = rows.reduce((n, r) => n + Number(r.usd ?? r.reserve_usd ?? r.amount ?? 0), 0);
  return {
    live,
    round: Number(cp.checkpoint ?? 0),
    status: String(cp.status ?? '—').slice(0, 26),
    receipt: String(cp.receipt ?? '').replace(/^sha256_/, '').slice(0, 12),
    attention: Number(st.attention ?? 0),
    reserved,
    rows: rows.length,
    dir,
  };
}
