import type { Receipt } from '../utils/receipts.js';

// SPEC §00 — the journey ladder. Seven steps; every step has a verb and a
// receipt kind, and completion is READ from the chain, never asserted. The
// next unsealed step is the ONLY orange element on HOME (color contract §08);
// completed steps show their receipt hash + one fact, never a bare checkmark.
export interface JourneyStep {
  id: string;
  verb: string;
  hint: string;
  proof: (r: Receipt) => boolean;
  fact: (r: Receipt, chain: Receipt[]) => string;
  // FIX B (director): a failed attempt is not a completed step, but its counts
  // are still the most useful thing to print on the next-unsealed row.
  nextFact?: (chain: Receipt[]) => string | null;
}

const h8 = (h?: string): string => (h ? h.slice(7, 15) : '—');
// FIX D (director): the genesis receipt's prev_hash IS 'genesis' — say so,
// never print a bare dash for it.
const prevLabel = (p: string): string => (p.startsWith('genesis') ? 'genesis' : h8(p));

export const JOURNEY: JourneyStep[] = [
  {
    id: 'doctor', verb: 'doctor', hint: 'timmy doctor — read-only posture',
    // FIX B: a ✓ doctor row means doctor PASSED (status ok). A failed doctor
    // seals too, but it never renders as a completed step.
    proof: r => /doctor\./.test(r.subject) && r.status === 'ok',
    fact: r => r.subject,
    nextFact: chain => {
      const d = [...chain].reverse().find(r => /doctor\./.test(r.subject));
      if (!d || d.status === 'ok') return null;
      // keep the fact under the narrowest card width so the orange row never
      // hits truncate (tmux+ink log-update drops truncated first-children at 80)
      const counts = String(d.subject).match(/·\s*(.+?)\s*\(/)?.[1] ?? String(d.subject).replace(/^doctor\.\w+ · /, '');
      return `${counts} · required check failed`;
    }
  },
  {
    id: 'connect', verb: 'connect', hint: 'timmy connect <tool> — env-lock',
    proof: r => /^connect\./.test(r.subject) || r.kind === 'env.lock',
    fact: r => r.subject
  },
  {
    id: 'run', verb: 'run', hint: 'timmy run <lane> — live in RUN',
    proof: r => /lane\.start/.test(r.subject) || (r.kind === 'run' && !/doctor/.test(r.subject)),
    fact: r => r.subject
  },
  {
    id: 'receipt', verb: 'receipt', hint: 'a receipt lands — prev → this',
    proof: r => typeof r.hash === 'string' && Boolean(r.prev_hash),
    fact: r => `prev ${prevLabel(String(r.prev_hash))} → this ${h8(r.hash)}`
  },
  {
    id: 'verify', verb: 'verify', hint: 'press v — chain ok · N',
    proof: r => r.kind === 'verify' || /verify/.test(r.subject),
    fact: (r, chain) => (r.status === 'failed' || r.status === 'denied' ? r.subject : `chain ok · ${chain.length}`)
  },
  {
    id: 'companion', verb: 'companion', hint: 'pair a phone · [q] shows QR',
    proof: r => /companion/.test(r.subject),
    fact: r => r.subject
  },
  {
    id: 'seal', verb: 'seal', hint: 'anything · [s]',
    // owner seals only: system seeds (policy) seal with policy 'auto'
    proof: r => r.kind === 'seal' && r.policy === 'human-gated',
    fact: r => r.subject
  }
];

export interface JourneyRow {
  step: JourneyStep;
  state: 'done' | 'next' | 'todo';
  receipt: Receipt | null;
  hash: string;
  fact: string;
}

export function journeyRows(chain: Receipt[]): JourneyRow[] {
  let nextAssigned = false;
  return JOURNEY.map(step => {
    const r = chain.find(step.proof) ?? null;
    let state: JourneyRow['state'] = r ? 'done' : 'todo';
    if (!r && !nextAssigned) { state = 'next'; nextAssigned = true; }
    return {
      step,
      state,
      receipt: r,
      hash: r ? `${String(r.id).slice(0, 10)}…` : '',
      fact: r ? step.fact(r, chain) : (state === 'next' ? (step.nextFact?.(chain) ?? step.hint) : step.hint)
    };
  });
}

export const journeyDoneCount = (chain: Receipt[]): number =>
  journeyRows(chain).filter(r => r.state === 'done').length;
