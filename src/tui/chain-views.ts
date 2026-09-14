// chain-views-e6p2 — typed CHAIN views for the receipt kinds the war room
// added. Every view reads the receipt's sources[0] meta (where the lanes put
// it) and renders FIXED-WIDTH cells budgeted to ≤42 cols (the DETAIL rail's
// inner width): sliced, never ellipsized. net.policy shows hashes only;
// swarm.airgap carries the ⊘ glyph.
import type { Receipt } from '../utils/receipts.js';

const meta = (r: Receipt): Record<string, unknown> =>
  (Array.isArray(r.sources) && typeof r.sources[0] === 'object' && r.sources[0] !== null ? r.sources[0] : {}) as Record<string, unknown>;
const s = (m: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = m[k];
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  return '—';
};
const money = (v: string): string => (v === '—' ? '——' : `$${Number(v).toFixed(4)}`);
const h12 = (v: string): string => (v === '—' ? '—' : String(v).replace(/^sha256_/, '').slice(0, 12));

/** the run_id a receipt belongs to (swarm cross-link key), else null */
export const runIdOf = (r: Receipt): string | null => {
  const m = meta(r);
  const v = m.run_id;
  return typeof v === 'string' && v ? v : null;
};

/** typed detail lines for the new kinds; [] for kinds with no typed view */
export function typedLines(r: Receipt): string[] {
  const subj = String(r.subject ?? '');
  const m = meta(r);
  switch (subj) {
    case 'swarm.run': {
      const closed = s(m, 'policy').includes('closed') || s(m, 'topology') === 'closed';
      return [
        `${closed ? '⊘' : ' '} run ${s(m, 'run_id').slice(0, 16)} ${s(m, 'where').slice(0, 6)}/${s(m, 'room').slice(0, 8)}`,
        `  swarm ${s(m, 'swarm_id').slice(0, 12)} ${s(m, 'topology').slice(0, 11)} n=${s(m, 'size').slice(0, 2)}`,
        `  spent ${money(s(m, 'usd', 'spend')).slice(0, 7)} · ${s(m, 'ms').slice(0, 5)}ms ok=${s(m, 'ok').slice(0, 4)}`,
        `  judge ${s(m, 'judge_tier', 'judge').slice(0, 6)} · policy ${s(m, 'policy').slice(0, 6)} · ${h12(s(m, 'task_sha256')).slice(0, 8)}`,
      ];
    }
    case 'swarm.member':
      return [
        `  member ${s(m, 'member').slice(0, 10)} (${s(m, 'kind').slice(0, 5)}) ph ${s(m, 'phase').slice(0, 8)}`,
        `  model ${s(m, 'model_used', 'model').split('/').pop()?.slice(0, 14) ?? '—'} @ ${s(m, 'node').slice(0, 4)}/${s(m, 'provider_used', 'provider').slice(0, 8)}`,
        `  ${money(s(m, 'usd')).slice(0, 7)} · ${s(m, 'ms').slice(0, 5)}ms ok=${s(m, 'ok').slice(0, 4)}${s(m, 'killed') === 'true' ? ' KILLED' : ''}`,
        `  run ${s(m, 'run_id').slice(0, 16)} [o]`,
      ];
    case 'swarm.airgap':
      return [
        `⊘ airgap run ${s(m, 'run_id').slice(0, 16)} sw ${s(m, 'swarm_id').slice(0, 8)}`,
        `  egress ${s(m, 'egress').slice(0, 4)} tools ${s(m, 'egress_tools', 'egress_count').slice(0, 6)} hands ${s(m, 'hands').slice(0, 8)}`,
        `  pol ${h12(s(m, 'policy_sha256'))} · run ${h12(s(m, 'swarm_run'))}`,
      ];
    case 'node.join':
      return [
        `  node ${s(m, 'node').slice(0, 8)} ${s(m, 'gpu').slice(0, 20)}`,
        `  mem ${s(m, 'mem_total_gb').slice(0, 4)}G ollama ${s(m, 'ollama').slice(0, 8)} ${s(m, 'transport').slice(0, 10)}`,
        `  lock ${h12(s(m, 'envlock_sha256'))} · fleet ${s(m, 'fleet_entry').slice(0, 10)}`,
      ];
    case 'node.inventory':
      return [
        `  node ${s(m, 'node').slice(0, 8)} · ${s(m, 'transport').slice(0, 10)}`,
        `  models ${s(m, 'models', 'loaded', 'served').slice(0, 28)}`,
        `  avail ${s(m, 'mem_avail_gb', 'mem_free_gb').slice(0, 4)}G · serve ${s(m, 'serve', 'serving').slice(0, 6)}`,
      ];
    case 'net.policy':
      // hashes only — the endpoints themselves never render here
      return [
        `  policy_sha  ${h12(s(m, 'policy_sha256'))}`,
        `  ssh_block   ${h12(s(m, 'ssh_block_sha256'))}`,
        `  fix         ${s(m, 'fix').slice(0, 24)}`,
      ];
    case 'privacy.audit':
      return [
        `  scanners ${s(m, 'scanners').slice(0, 26)}`,
        `  patterns ${h12(s(m, 'patterns_sha256'))} · trees ${s(m, 'trees').slice(0, 4)}`,
        `  hist ${s(m, 'history_commits').slice(0, 6)}c/${s(m, 'history_blobs').slice(0, 6)}b · find ${s(m, 'findings', 'total', 'gated').slice(0, 6)}`,
      ];
    case 'privacy.gate':
      return [
        `  layers ${s(m, 'layers').slice(0, 30)}`,
        `  hook ${s(m, 'hook').slice(0, 12)} · ci ${s(m, 'ci').slice(0, 12)}`,
        `  cites ${h12(s(m, 'cites_audit'))} · refusal ${s(m, 'seal_refusal').slice(0, 10)}`,
      ];
    case 'hands.change':
      return [
        `  model ${s(m, 'before', 'from').split('/').pop()?.slice(0, 14) ?? '—'} → ${s(m, 'after', 'to').split('/').pop()?.slice(0, 14) ?? '—'}`,
        `  trigger ${s(m, 'trigger', 'reason', 'by').slice(0, 26)}`,
      ];
    case 'escrow.human':
      return [
        `  refused ${s(m, 'refused', 'what', 'subject_detail').slice(0, 24)}`,
        `  approved by ${s(m, 'approver', 'approved_by', 'who').slice(0, 12)} · ${s(m, 'reason').slice(0, 12)}`,
      ];
    default:
      return [];
  }
}

/** does this receipt render a typed view? */
export const isTyped = (r: Receipt): boolean => typedLines(r).length > 0;
