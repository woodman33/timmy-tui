// Escrow settlement state machine (V-03 rung 2, v0.7.9):
//   armed → locked → judged → settled
//     └→ settled (cancel refunds ceiling − drawn)
//     └→ slashed (invalid proof / QA below threshold / misbehavior)
// Payout authorization exists only in `settled`, and reaching it requires a
// verified AgentPass Merkle proof + Roboflow QA ≥ threshold at judge time.
// Every transition is CUE-validated, receipted, and fails closed.
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { appendReceipt, receiptsDir } from './receipts.js';
import { publish as appendEvent } from '../bus/index.js';
import { verifyAgentPass, type AgentPass } from './agent-pass.js';

export type EscrowState = 'armed' | 'locked' | 'judged' | 'settled' | 'slashed';

export interface EscrowTransition { from: EscrowState; to: EscrowState; at: string; reason?: string }

export interface Escrow {
  schema_version: 'escrow/0.1';
  escrow_id: string;
  plan_hash: string;
  ceiling_usd: number;
  drawn_usd: number;
  state: EscrowState;
  qa_threshold: number;
  qa_value?: number;
  merkle_root?: string;
  pass_receipt?: string;
  refund_usd?: number;
  transitions: EscrowTransition[];
}

const LEGAL: Record<string, EscrowState[]> = {
  armed: ['locked', 'settled', 'slashed'],
  locked: ['judged', 'settled', 'slashed'],
  judged: ['settled', 'slashed'],
  settled: [],
  slashed: []
};

export function validateEscrowCue(e: unknown): { ok: boolean; note?: string; error_class?: string } {
  const cueBin = spawnSync('cue', ['version'], { encoding: 'utf8' });
  if (cueBin.status !== 0) return { ok: false, error_class: 'not_configured', note: 'cue binary missing (brew install cue)' };
  const schema = fileURLToPath(new URL('../../schemas/escrow.cue', import.meta.url));
  const tmp = join(mkdtempSync(join(tmpdir(), 'timmy-escrowcue-')), 'escrow.json');
  writeFileSync(tmp, JSON.stringify(e));
  const r = spawnSync('cue', ['vet', '-d', '#Escrow', schema, tmp], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error_class: 'schema', note: (r.stderr || r.stdout || 'cue vet failed').slice(0, 400) };
  return { ok: true };
}

const escrowPath = (id: string, dir?: string): string => join(dir ?? dirname(receiptsDir()), 'escrow', `${id}.json`);
const readEscrow = (id: string, dir?: string): Escrow | null => {
  try { return JSON.parse(readFileSync(escrowPath(id, dir), 'utf8')) as Escrow; } catch { return null; }
};
const writeEscrow = (e: Escrow, dir?: string): void => {
  const p = escrowPath(e.escrow_id, dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(e, null, 2));
};

// FIX C (director, tui-redesign step 5): Home needs the pending-escrow set to
// decide the single orange element. Scans the store's escrow dir (honors the
// same resolution as receipts, so tests see their own store).
export function listEscrows(dir?: string): Escrow[] {
  const base = dir ? join(dir, '.timmy', 'escrow') : join(dirname(receiptsDir()), 'escrow');
  try {
    return readdirSync(base)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(base, f), 'utf8')) as Escrow; } catch { return null; } })
      .filter((e): e is Escrow => Boolean(e));
  } catch { return []; }
}

function transition(e: Escrow, to: EscrowState, reason: string | undefined, receiptSubject: string, dir?: string): { ok: boolean; escrow?: Escrow; note?: string } {
  if (!LEGAL[e.state].includes(to)) return { ok: false, note: `illegal transition ${e.state}→${to}` };
  e.transitions.push({ from: e.state, to, at: new Date().toISOString(), ...(reason ? { reason } : {}) });
  e.state = to;
  const v = validateEscrowCue(e);
  if (!v.ok) return { ok: false, note: v.note ?? v.error_class };
  writeEscrow(e, dir);
  appendReceipt('runs', {
    kind: 'verify', subject: `escrow ${e.escrow_id} · ${receiptSubject}`, policy: 'human-gated', status: 'ok',
    plan_hash: e.plan_hash, max_spend: e.ceiling_usd, cost_usd: e.drawn_usd,
    discrepancies: reason ? [reason] : [],
    spans: [{ name: `escrow ${e.state}`, kind: 'execute_tool' }], artifacts: []
  }, dir);
  // live telemetry for the Mission Studio escrow ledger (v0.9.0)
  appendEvent(`escrow.${to}`, {
    escrow_id: e.escrow_id, state: to, drawn_usd: e.drawn_usd,
    ...(e.refund_usd !== undefined ? { refund_usd: e.refund_usd } : {}),
    ...(reason ? { reason } : {})
  }, dir);
  return { ok: true, escrow: e };
}

export function armEscrow(o: { plan_hash: string; ceiling_usd: number; qa_threshold: number; dir?: string }): { ok: boolean; escrow?: Escrow; note?: string } {
  const e: Escrow = {
    schema_version: 'escrow/0.1',
    escrow_id: `esc_${crypto.randomBytes(4).toString('hex')}`,
    plan_hash: o.plan_hash,
    ceiling_usd: o.ceiling_usd,
    drawn_usd: 0,
    state: 'armed',
    qa_threshold: o.qa_threshold,
    transitions: []
  };
  const v = validateEscrowCue(e);
  if (!v.ok) return { ok: false, note: v.note ?? v.error_class };
  writeEscrow(e, o.dir);
  appendReceipt('runs', { kind: 'run', subject: `escrow ${e.escrow_id} armed · ceiling ${o.ceiling_usd}`, policy: 'human-gated', status: 'ok', plan_hash: o.plan_hash, max_spend: o.ceiling_usd, spans: [], artifacts: [] }, o.dir);
  appendEvent('escrow.armed', { escrow_id: e.escrow_id, state: 'armed', ceiling_usd: o.ceiling_usd, drawn_usd: 0 }, o.dir);
  return { ok: true, escrow: e };
}

export const getEscrow = (id: string, dir?: string): Escrow | null => readEscrow(id, dir);

export function lockEscrow(id: string, dir?: string): { ok: boolean; escrow?: Escrow; note?: string } {
  const e = readEscrow(id, dir);
  if (!e) return { ok: false, note: 'unknown escrow' };
  return transition(e, 'locked', undefined, 'locked (dispatch started)', dir);
}

export function drawEscrow(id: string, usd: number, dir?: string): { ok: boolean; escrow?: Escrow; note?: string; error_class?: string } {
  const e = readEscrow(id, dir);
  if (!e) return { ok: false, note: 'unknown escrow' };
  if (e.state !== 'locked') return { ok: false, note: `draw requires locked (state ${e.state})`, error_class: 'illegal_state' };
  if (e.drawn_usd + usd > e.ceiling_usd) return { ok: false, note: 'overspend: draw exceeds ceiling', error_class: 'overspend' };
  e.drawn_usd += usd;
  const v = validateEscrowCue(e);
  if (!v.ok) return { ok: false, note: v.note };
  writeEscrow(e, dir);
  appendReceipt('runs', { kind: 'run', subject: `escrow ${id} draw ${usd}`, policy: 'human-gated', status: 'ok', cost_usd: usd, plan_hash: e.plan_hash, spans: [], artifacts: [] }, dir);
  return { ok: true, escrow: e };
}

// judged requires BOTH gates: verified AgentPass Merkle proof and Roboflow
// QA ≥ threshold. Either failure slashes — no payout path around them.
export function judgeEscrow(id: string, o: { pass: AgentPass; qa_value: number; pass_receipt?: string; dir?: string }): { ok: boolean; escrow?: Escrow; note?: string } {
  const e = readEscrow(id, o.dir);
  if (!e) return { ok: false, note: 'unknown escrow' };
  if (e.state !== 'locked') return { ok: false, note: `judge requires locked (state ${e.state})` };
  const proof = verifyAgentPass(o.pass, o.dir);
  if (!proof.ok) {
    return transition(e, 'slashed', `agent-pass broken at ${proof.brokenAt}`, 'slashed (merkle/chain proof failed)', o.dir);
  }
  if (o.qa_value < e.qa_threshold) {
    return transition(e, 'slashed', `qa ${o.qa_value} < threshold ${e.qa_threshold}`, 'slashed (QA below threshold)', o.dir);
  }
  e.qa_value = o.qa_value;
  e.merkle_root = o.pass.merkle_root;
  e.pass_receipt = o.pass_receipt;
  return transition(e, 'judged', undefined, `judged (proof + QA verified · merkle ${e.merkle_root.slice(0, 16)}…)`, o.dir);
}

export function settleEscrow(id: string, dir?: string): { ok: boolean; escrow?: Escrow; note?: string } {
  const e = readEscrow(id, dir);
  if (!e) return { ok: false, note: 'unknown escrow' };
  if (e.state !== 'judged') return { ok: false, note: `settle requires judged (state ${e.state})` };
  e.refund_usd = Math.round((e.ceiling_usd - e.drawn_usd) * 1e6) / 1e6;
  return transition(e, 'settled', undefined, `settled · refund ${e.refund_usd}`, dir);
}

// cancel refunds the undrawn ceiling (register V-03 criterion); an optional
// human reason rides in the transition + receipt discrepancies (spec §02: r
// refuses with a reason).
export function cancelEscrow(id: string, reason?: string, dir?: string): { ok: boolean; escrow?: Escrow; note?: string } {
  const e = readEscrow(id, dir);
  if (!e) return { ok: false, note: 'unknown escrow' };
  if (e.state !== 'armed' && e.state !== 'locked') return { ok: false, note: `cancel requires armed|locked (state ${e.state})` };
  e.refund_usd = Math.round((e.ceiling_usd - e.drawn_usd) * 1e6) / 1e6;
  return transition(e, 'settled', reason ? `cancelled by human: ${reason}` : 'cancelled: refund ceiling − drawn', `cancelled · refund ${e.refund_usd}`, dir);
}

export function slashEscrow(id: string, reason: string, dir?: string): { ok: boolean; escrow?: Escrow; note?: string } {
  const e = readEscrow(id, dir);
  if (!e) return { ok: false, note: 'unknown escrow' };
  return transition(e, 'slashed', reason, 'slashed', dir);
}

export function verifyEscrow(id: string, dir?: string): { ok: boolean; brokenAt?: 'state' | 'refund' | 'schema'; note?: string } {
  const e = readEscrow(id, dir);
  if (!e) return { ok: false, brokenAt: 'state', note: 'unknown escrow' };
  const v = validateEscrowCue(e);
  if (!v.ok) return { ok: false, brokenAt: 'schema', note: v.note };
  let s: EscrowState = 'armed';
  for (const t of e.transitions) {
    if (t.from !== s || !LEGAL[s].includes(t.to)) return { ok: false, brokenAt: 'state', note: `illegal transition ${t.from}→${t.to}` };
    s = t.to;
  }
  if (s !== e.state) return { ok: false, brokenAt: 'state', note: 'terminal state mismatch' };
  if (e.state === 'settled' && e.refund_usd !== Math.round((e.ceiling_usd - e.drawn_usd) * 1e6) / 1e6) return { ok: false, brokenAt: 'refund', note: 'refund ≠ ceiling − drawn' };
  return { ok: true };
}
