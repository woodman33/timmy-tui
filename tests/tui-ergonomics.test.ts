import { describe, it, expect } from 'vitest';
import {
  layoutBudget, footerKeysLine, chromeFor, VIEWS, VIEW_PANES, PALETTE_MODELS,
  HEADER_ROWS, FOOTER_ROWS
} from '../src/tui/utils/ergonomics.js';
import { isNoise } from '../src/tui/components/CommandView.js';

describe('v1.0.2 de-cluttered shell', () => {
  it('strict budget: header 1 + footer 1, main = rows − 2 at 80×24 / 120×40 / 200×50', () => {
    for (const rows of [24, 40, 50]) {
      const b = layoutBudget(rows);
      expect(b.header).toBe(HEADER_ROWS);
      expect(b.footer).toBe(FOOTER_ROWS);
      expect(b.main).toBe(rows - 2);
    }
    expect(layoutBudget(24).main).toBe(22);
    expect(layoutBudget(40).main).toBe(38);
    expect(layoutBudget(50).main).toBe(48);
    expect(layoutBudget(4).main).toBeGreaterThanOrEqual(3);
  });

  it('footer is the single specified keymap line, clamped to viewport', () => {
    for (const w of [80, 120, 200]) {
      const line = footerKeysLine(w);
      expect(line.length).toBeLessThanOrEqual(w);
    }
    expect(footerKeysLine(200)).toContain('[1-4] Views');
    expect(footerKeysLine(200)).toContain('[^K] Palette');
    expect(footerKeysLine(200)).toContain('[Tab] Switch Pane');
    expect(footerKeysLine(200)).toContain('[q] Quit');
    expect(footerKeysLine(200)).not.toContain('J-BANG');
  });

  it('Active Pane Invariant: card #2ac3de + ◆ when active, muted #292e42 + ◇ when not', () => {
    const on = chromeFor(true);
    const off = chromeFor(false);
    expect(on.border).toBe('#2ac3de');
    expect(on.glyph).toBe('◆');
    expect(on.bold).toBe(true);
    expect(off.border).toBe('#292e42');
    expect(off.glyph).toBe('◇');
    expect(off.bold).toBe(false);
  });

  it('four views, [1-4] keys, pane budgets for Tab focus', () => {
    expect(VIEWS.map(v => v.key)).toEqual(['1', '2', '3', '4']);
    expect(VIEWS.map(v => v.label)).toEqual(['COMMAND', 'MISSION', 'TELEMETRY', 'ESCROW']);
    expect(VIEW_PANES).toHaveLength(4);
    expect(VIEW_PANES[0]).toBe(1);
  });

  it('model switching lives in the palette, not a sidebar', () => {
    expect(PALETTE_MODELS.length).toBeGreaterThanOrEqual(4);
    for (const m of PALETTE_MODELS) expect(m.id).toMatch(/^[a-z0-9.-]+\//);
  });

  it('chat noise filter hides internal system chatter', () => {
    expect(isNoise('☁️ [Saved to Cloudflare Durable Object SQLite Session]')).toBe(true);
    expect(isNoise('⚙️ [SYSTEM] state-sync ok')).toBe(true);
    expect(isNoise('run.created rc_123')).toBe(true);
    expect(isNoise('explain the escrow refund invariant')).toBe(false);
    expect(isNoise('▶ what is the context cone?')).toBe(false);
  });
});
