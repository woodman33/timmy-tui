// EVIDENCE STATES (ORDER ui-v3-t9r2, C1b-2): the five states of the law's
// `evidence` block, one look each, colours from the law, distinct glyphs, and
// the mappings from chain facts to states — with §12 negative controls.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EVIDENCE_STATES, evidenceLook, evidenceLaw, receiptEvidence, runEvidence } from '../src/tui/evidence.js';
import { theme, visualLaw } from '../src/tui/theme.js';
import { evidenceGlyph } from '../src/tui/ui/Evidence.js';

describe('evidence states (lanes/visual/tokens.json evidence block)', () => {
  it('the five states are exactly the law\'s and nothing else', () => {
    const law = Object.keys(visualLaw.evidence).filter(k => !['note', 'hana'].includes(k)).sort();
    expect([...EVIDENCE_STATES].sort()).toEqual(law);
  });
  it('every look paints a law colour, matching the law\'s fill/stroke role', () => {
    const admitted = new Set(Object.values(visualLaw.color).map(c => c.value));
    for (const s of EVIDENCE_STATES) {
      const look = evidenceLook(s);
      expect(admitted.has(look.color), s).toBe(true);
      const rule = evidenceLaw(s) as { fill: string; stroke: string };
      const expected = rule.fill === 'none' ? rule.stroke : rule.fill === 'grey-3' ? rule.stroke : rule.fill;
      expect(look.color, `${s} should paint law.${expected}`).toBe(visualLaw.color[expected as keyof typeof visualLaw.color].value);
    }
    expect(evidenceLook('checked').color).toBe(theme.seal);
    expect(evidenceLook('inferred').color).toBe(theme.generated);
    expect(evidenceLook('stale').color).toBe(theme.predict);
  });
  it('every state has its own glyph, and refusal has one that is none of them', () => {
    const glyphs = EVIDENCE_STATES.map(s => evidenceLook(s).glyph);
    expect(new Set(glyphs).size).toBe(5);
    expect(glyphs).not.toContain(evidenceGlyph('refused'));
    expect(evidenceGlyph('refused')).toBe('×');
  });
  it('only checked is bold; dim is exactly the law\'s opacity < 1', () => {
    expect(EVIDENCE_STATES.filter(s => evidenceLook(s).bold)).toEqual(['checked']);
    const lawDim = EVIDENCE_STATES.filter(s => { const o = (evidenceLaw(s) as { opacity?: number }).opacity; return o !== undefined && o < 1; });
    expect(lawDim).toEqual(['stale']);
    expect(EVIDENCE_STATES.filter(s => evidenceLook(s).dim)).toEqual(lawDim);
  });
  it('the evidence glyphs are reserved: no chrome glyph (card diamonds, live marks, attention, progress, the non-carrier dot) is one of them', async () => {
    const { CARD_GLYPHS } = await import('../src/tui/ui/Card.js');
    const { LIVE } = await import('../src/tui/components/ShellChrome.js');
    const chrome = new Set<string>([...Object.values(CARD_GLYPHS), ...Object.values(LIVE), '▶', '✦', '⊘', '⊗', '▮', '▯', '·', '⚠']);
    for (const s of EVIDENCE_STATES) expect(chrome.has(evidenceLook(s).glyph), s).toBe(false);
    expect(chrome.has(evidenceGlyph('refused'))).toBe(false);
  });
  it('a receipt maps from chain facts, never from a colour', () => {
    expect(receiptEvidence({ status: 'ok' }, { verified: true })).toBe('checked');
    expect(receiptEvidence({ status: 'ok' })).toBe('constructed');
    expect(receiptEvidence({ status: 'ok' }, { verified: true, staleInputs: true })).toBe('stale');
    expect(receiptEvidence({ status: 'ok' }, { measured: false })).toBe('inferred');
    expect(receiptEvidence({ status: 'denied' }, { verified: true })).toBe('refused');
    expect(receiptEvidence({ status: 'failed' })).toBe('refused');
    expect(receiptEvidence({})).toBe('declared');
  });
  it('a run maps from its state word', () => {
    expect(runEvidence('sealed')).toBe('checked');
    expect(runEvidence('running')).toBe('constructed');
    expect(runEvidence('queued')).toBe('declared');
    expect(runEvidence('REFUSED')).toBe('refused');
  });
  it('NEGATIVE CONTROL §12: a state the law does not declare is refused, not styled', () => {
    expect(() => evidenceLook('verified' as never)).toThrow(/not an evidence state/);
  });
  it('NEGATIVE CONTROL §12: a look painted outside the law would fail the colour check', () => {
    const admitted = new Set(Object.values(visualLaw.color).map(c => c.value));
    expect(admitted.has('#3BE08C')).toBe(false);
  });
  it('the module chooses no colour of its own (source checker)', async () => {
    const { sourceColorViolations } = await import('../src/tui/color-contract.js');
    for (const f of ['src/tui/evidence.ts', 'src/tui/ui/Evidence.tsx']) {
      expect(sourceColorViolations(readFileSync(join(process.cwd(), f), 'utf8'), f)).toEqual([]);
    }
  });
});
