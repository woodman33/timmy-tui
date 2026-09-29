// ui-next — readers for the capabilities the new lanes added: Unreal (runtime
// paths + render proof), Houdini (engine shelf + drop lane), schema strictness
// (captain's model-strictness table), and the Signal game (checkpoint + budget
// ledger + attention). Every read is defensive: missing lane/state ⇒ inert row,
// never a throw. These lanes are other orders' artifacts; the TUI surfaces
// them, it does not reimplement them.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { hashOf, verifySignature, type Receipt } from '../utils/receipts.js';
import { homedir } from 'node:os';

const root = (): string => process.env.TIMMY_REPO_ROOT ?? process.cwd();
const displayText = (value: string, limit = 80): string => [...value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')].slice(0, limit).join('');
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
  live: boolean; label: 'hold' | 'complete' | 'live' | 'idle' | 'unknown'; round: number; status: string; receipt: string;
  attention: number; reserved: number; rows: number; dir: string;
}
/** The Signal game: only explicit running states are live; ledger
 *  reservations from the first directory that carries reservations.jsonl. */
export function signalState(): SignalState | null {
  const projectDir = process.env.TIMMY_SIGNAL_DIR ?? join(homedir(), 'timmy', 'projects', 'the-signal');
  const cp = readJson(join(projectDir, 'out', 'latest-checkpoint.json'));
  if (!cp) return null;
  const status = String(cp.status ?? '');
  const label = signalLabel(status);
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
    live: label === 'live',
    label,
    round: Number(cp.checkpoint ?? 0),
    status: displayText(String(cp.status ?? '—'), 26),
    receipt: /^sha256_[a-f0-9]{64}$/.test(String(cp.receipt)) ? String(cp.receipt).slice(7, 19) : '—',
    attention: Number(st.attention ?? 0),
    reserved,
    rows: rows.length,
    dir,
  };
}

/** Progress and reservations alone never make a held or unknown state live. */
export function signalLabel(status: string): SignalState['label'] {
  if (/^(?:hold|paused|blocked|not_started)(?:_|$)/.test(status) || status.includes('not_started')) return 'hold';
  if (['complete', 'completed', 'live_day_complete'].includes(status)) return 'complete';
  if (['live', 'running', 'live_day_started'].includes(status) || /^live_day_round_\d+$/.test(status)) return 'live';
  if (['idle', 'ready'].includes(status)) return 'idle';
  return 'unknown';
}

export interface DemoRow {
  id: string; family: string; demo: 'canvas' | 'native'; open: string | null;
  prediction: { text: string; seal: string | null };
  evidence: { path: string | null; seal: string | null };
  status: 'historical refs' | 'unknown'; scope: string; origin: string;
}
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const shortSeal = (r: Receipt | undefined): string | null => r ? r.hash.slice(7, 15) : null;
function historicalReceipt(r: Receipt): boolean {
  try {
    return typeof r.subject === 'string' && typeof r.id === 'string' && r.status === 'ok' && /^sha256_[a-f0-9]{64}$/.test(r.hash)
      && Number.isFinite(Date.parse(r.ts)) && hashOf({ ...r, hash: '' }) === r.hash && verifySignature(r);
  } catch { return false; }
}
/** Integrity-checked historical receipt references only. These never qualify
 * model-authored evidence, current-run observation or an observed cite call. */
export function demosRows(recs: Receipt[] = []): DemoRow[] {
  const registry = readJson(join(root(), 'lanes', 'demos', 'families.json'));
  const families = Array.isArray(registry?.families) ? registry.families : [];
  const verified = recs.filter(historicalReceipt);
  const reference = (id: unknown) => typeof id === 'string' ? verified.find(r => r.hash === id || r.id === id) : undefined;
  const ids = new Set<string>();
  return families.flatMap(value => {
    const f = object(value);
    if (!f || typeof f.id !== 'string' || !f.id || ids.has(f.id)) return [];
    ids.add(f.id);
    const prediction = object(f.prediction), evidence = object(f.evidence);
    const fill = typeof f.fill === 'string' ? f.fill : '';
    const matches = (subject: string) => fill.endsWith('.') ? subject.startsWith(fill) : subject === fill || subject.startsWith(fill + ' ');
    const ev = evidence?.seal != null ? reference(evidence.seal)
      : fill ? [...verified].reverse().find(r => matches(r.subject)) : undefined;
    const src = object(ev?.sources?.[0]);
    const candidate = reference(prediction?.seal ?? src?.prediction_seal ?? src?.prediction_receipt);
    const pred = ev && candidate && candidate !== ev && verified.indexOf(candidate) < verified.indexOf(ev)
      && Date.parse(candidate.ts) <= Date.parse(ev.ts) ? candidate : undefined;
    return [{ id: f.id, family: displayText(typeof f.family === 'string' ? f.family : f.id),
      demo: f.demo === 'native' ? 'native' as const : 'canvas' as const,
      open: typeof f.open === 'string' && f.open ? f.open : null,
      prediction: { text: typeof prediction?.text === 'string' ? prediction.text : '—', seal: shortSeal(pred) },
      evidence: { path: typeof evidence?.path === 'string' ? evidence.path : null, seal: shortSeal(ev) },
      status: ev ? 'historical refs' as const : 'unknown' as const,
      scope: typeof f.scope === 'string' ? f.scope : '—', origin: typeof f.origin === 'string' ? f.origin : '—' }];
  }).sort((a, b) => Number(Boolean(b.evidence.seal)) - Number(Boolean(a.evidence.seal)));
}

export function demoWindow(rows: DemoRow[], selected: number, maxRows: number) {
  const index = Math.min(Math.max(0, selected), Math.max(0, rows.length - 1));
  const count = Math.max(1, Math.floor(maxRows / 2));
  const start = Math.max(0, index - count + 1);
  return { index, start, shown: rows.slice(start, start + count), more: Math.max(0, rows.length - count) };
}

/** Open an explicit repo-local surface; launching never proves its contents. */
export async function openDemo(row: DemoRow): Promise<{ ok: boolean; note: string }> {
  const refuse = (note: string) => ({ ok: false, note: `${displayText(row.family)}: ${note}` });
  if (!row.open) return refuse('no recorded surface yet');
  let path: string;
  try {
    const base = realpathSync(root());
    path = realpathSync(resolve(base, row.open));
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return refuse('surface must remain inside the repository');
  } catch { return refuse('recorded surface is missing'); }
  if (process.env.TIMMY_DEMO === '1') return { ok: true, note: `${displayText(row.family)}: demo no-op open` };
  if (process.platform !== 'darwin') return refuse(`opening unsupported on ${process.platform}`);
  return new Promise(done => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (!ok) { try { child?.kill(); } catch { /* already gone */ } }
      done(ok ? { ok, note: `${displayText(row.family)}: surface open requested` } : refuse('surface opener failed'));
    };
    try {
      child = spawn('/usr/bin/open', [path], { stdio: 'ignore', shell: false });
      child.on('error', () => finish(false)); child.once('close', code => finish(code === 0));
      timer = setTimeout(() => finish(false), 5000);
    } catch { finish(false); }
  });
}
