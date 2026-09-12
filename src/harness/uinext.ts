// ui-next — readers for the capabilities the new lanes added: Unreal (runtime
// paths + render proof), Houdini (engine shelf + drop lane), schema strictness
// (captain's model-strictness table), and the Signal game (checkpoint + budget
// ledger + attention). Every read is defensive: missing lane/state ⇒ inert row,
// never a throw. These lanes are other orders' artifacts; the TUI surfaces
// them, it does not reimplement them.
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
export function houdiniRow(recs: { subject: string }[]): HoudiniRow {
  const eng = (readJson(join(root(), 'lanes', 'engines', 'engines.json'))?.engines ?? []) as Record<string, unknown>[];
  const inv = (readJson(join(root(), 'lanes', 'engines', 'inventory.json'))?.engines ?? []) as Record<string, unknown>[];
  const e = eng.find(x => x.id === 'houdini') ?? inv.find(x => x.id === 'houdini') ?? null;
  const i = inv.find(x => x.id === 'houdini') ?? null;
  const count = (v: unknown): number => (Array.isArray(v) ? v.length : Number(v ?? 0) || 0);
  const dropRuns = recs.filter(r => /^engine\.drop|^drop\./.test(String(r.subject))).length;
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
  live: boolean; label: string; round: number; status: string; receipt: string;
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
  // FILM-PLAN-v2: the label DERIVES from state — a held or not-started day is
  // never 'live'; live requires a started day with progress or reservations
  const statusNow = String(cp.status ?? '');
  const roundNow = Number(cp.checkpoint ?? 0);
  const label = statusNow.includes('not_started') ? 'hold'
    : statusNow === 'complete' ? 'complete'
    : (roundNow > 0 || reserved > 0) ? 'live'
    : 'idle';
  return {
    live: label === 'live',
    label,
    round: roundNow,
    status: statusNow.slice(0, 26),
    receipt: String(cp.receipt ?? '').replace(/^sha256_/, '').slice(0, 12),
    attention: Number(st.attention ?? 0),
    reserved,
    rows: rows.length,
    dir,
  };
}

export interface DemoRow {
  id: string; family: string; demo: 'canvas' | 'native'; open: string | null;
  prediction: { text: string; seal: string | null };
  evidence: { path: string | null; seal: string | null };
  scope: string; origin: string; fill: string | null; evSubject: string | null;
}
/** ui-next-2: the curated portfolio-family demo index (lanes/demos/families.json).
 *  Missing registry ⇒ empty list; null seals render as inert dashes. */
export function demosRows(recs: { subject: string; hash?: string; sources?: unknown[] }[] = []): DemoRow[] {
  const j = readJson(join(root(), 'lanes', 'demos', 'families.json'));
  const fams = (j?.families ?? []) as (DemoRow & { fill?: string })[];
  return fams.map(f => {
    const fill = f.fill ? String(f.fill) : null;
    // null seals fill from the lane's receipts the moment those exist:
    // EV from the newest matching receipt, PRED from its prediction reference
    const src = fill ? [...recs].reverse().find(r => String(r.subject).startsWith(fill)) ?? null : null;
    const m = (src?.sources?.[0] ?? {}) as Record<string, unknown>;
    const h8 = (v: unknown): string | null => (typeof v === 'string' && v ? String(v).replace(/^sha256_/, '').slice(0, 8) : null);
    return {
      id: String(f.id ?? f.family ?? '?'),
      family: String(f.family ?? f.id ?? '?'),
      demo: (f.demo === 'native' ? 'native' : 'canvas') as 'native' | 'canvas',
      open: f.open ? String(f.open) : null,
      prediction: {
        text: String(f.prediction?.text ?? '—'),
        seal: f.prediction?.seal ? h8(f.prediction.seal) : (src ? h8(m.prediction_seal ?? m.prediction_receipt) : null),
      },
      evidence: {
        path: f.evidence?.path ? String(f.evidence.path) : null,
        seal: f.evidence?.seal ? h8(f.evidence.seal) : (src ? h8(src.hash) : null),
      },
      scope: String(f.scope ?? '—'),
      origin: String(f.origin ?? '—'),
      fill,
      evSubject: src ? (String(src.subject).split(' ').pop() ?? '').trim() : null,
    };
  }).sort((a, b) => {
    // filled families (sealed evidence) rise so the Reuse moment is above the fold
    const fa = a.evidence.seal || a.evSubject ? 1 : 0;
    const fb = b.evidence.seal || b.evSubject ? 1 : 0;
    return fb - fa;
  });
}

/** [Enter] on an armed demo row: canvas opens in the browser worker surface,
 *  native opens the specialist result. TIMMY_DEMO (tests/demo capture) no-ops. */
export function openDemo(row: DemoRow): { ok: boolean; note: string } {
  if (!row.open) return { ok: false, note: `${row.family}: no recorded surface yet` };
  const p = join(root(), row.open);
  if (!existsSync(p)) return { ok: false, note: `${row.family}: ${row.demo} surface missing (${row.open})` };
  if (process.env.TIMMY_DEMO === '1') return { ok: true, note: `${row.family}: demo no-op open` };
  const c = spawn('open', [p], { stdio: 'ignore', detached: true });
  c.unref();
  return { ok: true, note: `${row.family}: opened ${row.demo} surface` };
}
