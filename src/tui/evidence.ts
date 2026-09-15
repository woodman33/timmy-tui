import { theme, visualLaw } from './theme.js';

// ═══════════════════════════════════════════════════════════════════════════
// EVIDENCE STATES (ORDER ui-v3-t9r2, C1b-2) — the law's `evidence` block in
// lanes/visual/tokens.json. Every element that carries evidence — a receipt
// row, a hash, a journey step, a run, a hand's last seal, a status glyph, a
// prediction beside its measurement — carries exactly ONE of the five states,
// and the STATE chooses the look; no carrier chooses a colour for itself.
//
//   declared     asserted, not yet built           outline   ○  white
//   constructed  built, not yet checked            fill      ●  white
//   checked      verified against a receipt        fill      ✓  SEAL green, bold
//   inferred     a model produced it (measured:false)         ◉  GENERATED violet
//   stale        was checked; its inputs changed   dim       ◌  PREDICT amber, dim
//
// The glyphs are the terminal's rendering of the law's fill / stroke rules
// (outline → ○, fill → ●, verified → ✓, model-made → ◉, dashed → ◌); every
// colour is read from the law through the theme. The circle set is
// RESERVED for evidence: the card diamonds ◇/◆ are chrome (Active Pane
// Invariant), connectivity is ■/□ (ShellChrome LIVE), attention is ▶, and
// a non-carrier row marks itself · . Among the evidence LOOKS, dim ⇔ the
// law's opacity < 1 (stale): a MARK cell is dim only when stale. Dim on a
// trailing span that carries no evidence — the fact after a hash, an env-lock
// citation, an overflow line, an aged log row — is hierarchy (C1c), never a
// state. For an outline state the stroke is the colour.
//
// Two levels. A RECEIPT is constructed once sealed and checked only when a
// receipted chain verify covers it (its index ≤ the head the verify names);
// what follows the verify is constructed again and the verify goes stale.
// A CLAIM backed by a receipt — a journey step done, a run sealed — is
// checked by that receipt: the law's "verified against a receipt".
// Precedence: refused > stale > inferred > checked > constructed > declared.
// ═══════════════════════════════════════════════════════════════════════════

export const EVIDENCE_STATES = ['declared', 'constructed', 'checked', 'inferred', 'stale'] as const;
export type EvidenceState = typeof EVIDENCE_STATES[number];

export interface EvidenceLook { glyph: string; color: string; bold: boolean; dim: boolean }

const LOOK: Record<EvidenceState, EvidenceLook> = {
  declared: { glyph: '○', color: theme.structure, bold: false, dim: false },
  constructed: { glyph: '●', color: theme.structure, bold: false, dim: false },
  checked: { glyph: '✓', color: theme.seal, bold: true, dim: false },
  inferred: { glyph: '◉', color: theme.generated, bold: false, dim: false },
  stale: { glyph: '◌', color: theme.predict, bold: false, dim: true },
};

/** The law's own fill/stroke for a state (for gates and the companion). */
export const evidenceLaw = (s: EvidenceState) => visualLaw.evidence[s];

export function evidenceLook(s: EvidenceState): EvidenceLook {
  const look = LOOK[s];
  if (!look) throw new Error(`not an evidence state: ${String(s)}`);
  return look;
}

/** A receipt's evidence state from what the chain says about it. */
export function receiptEvidence(
  r: { status?: string },
  opts: { verified?: boolean; measured?: boolean | null; staleInputs?: boolean } = {},
): EvidenceState | 'refused' {
  if (r.status === 'failed' || r.status === 'denied' || r.status === 'refused') return 'refused';
  if (opts.staleInputs) return 'stale';
  if (opts.measured === false) return 'inferred';
  if (r.status === 'ok' && opts.verified) return 'checked';
  if (r.status === 'ok') return 'constructed';
  return 'declared';
}

/** A run's evidence state from its shell state word. */
export function runEvidence(state: string): EvidenceState | 'refused' {
  if (state === 'REFUSED') return 'refused';
  if (state === 'sealed') return 'checked';
  if (state === 'running') return 'constructed';
  return 'declared';
}
