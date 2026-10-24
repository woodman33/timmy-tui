import { describe, expect, it } from 'vitest';
import { contrastRatio, rgbToHex, type Rgb } from '../src/term/color.js';
import { TIMMY_DAY, TIMMY_HOMEBREW, TIMMY_NIGHT } from '../src/term/palettes.js';
import { HOMEBREW, HOMEBREW_GREEN } from '../src/theme/tokens.js';
import { themeFiles } from '../src/term/theme-files.js';

// zellij's tab bar drew the selected and the unselected tab alike under Timmy Night (both took the
// ink color through the old colour-list format). The component format sets each part explicitly.
const COMPONENTS = ['text_unselected', 'text_selected', 'ribbon_unselected', 'ribbon_selected', 'table_title', 'table_cell_unselected', 'table_cell_selected', 'list_unselected', 'list_selected', 'frame_unselected', 'frame_selected', 'frame_highlight', 'exit_code_success', 'exit_code_error', 'multiplayer_user_colors'];
const kdl = themeFiles()['zellij/timmy.kdl'];

function block(theme: string): string {
  const start = kdl.indexOf(`    ${theme} {`);
  return kdl.slice(start, kdl.indexOf('\n    }', start));
}
function part(theme: string, component: string): Record<string, string> {
  const b = block(theme);
  const at = b.indexOf(`        ${component} {`);
  const body = b.slice(at, b.indexOf('        }', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s+(\w+) (\d+) (\d+) (\d+)$/gm)) out[m[1]] = rgbToHex([Number(m[2]), Number(m[3]), Number(m[4])] as Rgb);
  return out;
}

describe('the zellij theme', () => {
  for (const [theme, palette] of [['timmy-night', TIMMY_NIGHT], ['timmy-day', TIMMY_DAY]] as const) {
    it(`${theme}: sets every component, and the selected tab stands out from the others`, () => {
      for (const c of COMPONENTS) expect(block(theme), c).toContain(`        ${c} {`);
      expect(part(theme, 'ribbon_selected').background).not.toBe(part(theme, 'ribbon_unselected').background);
      // Light pills (C-24) must not make the selected tab blend in: its pill differs from both
      // unselected pills by 2.5:1 or more.
      const selected = part(theme, 'ribbon_selected').background;
      const { background, emphasis_1 } = part(theme, 'ribbon_unselected');
      expect(contrastRatio(selected, background)).toBeGreaterThanOrEqual(2.5);
      expect(contrastRatio(selected, emphasis_1)).toBeGreaterThanOrEqual(2.5);
    });
    it(`${theme}: every text part reads at 7:1 or better, colored parts at 4.5:1, frames at 3:1`, () => {
      for (const c of ['text_unselected', 'text_selected', 'ribbon_unselected', 'ribbon_selected', 'table_title', 'table_cell_unselected', 'table_cell_selected', 'list_unselected', 'list_selected']) {
        const { base, background } = part(theme, c);
        expect(contrastRatio(base, background), c).toBeGreaterThanOrEqual(7);
      }
      for (const c of ['frame_highlight', 'exit_code_error']) expect(contrastRatio(part(theme, c).base, palette.background), c).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(part(theme, 'frame_unselected').base, palette.background)).toBeGreaterThanOrEqual(3);
    });
    it(`${theme}: every second unselected tab (zellij paints it with ribbon_unselected emphasis_1) reads at 7:1 and differs from its neighbours`, () => {
      // C-18 probe: with Timmy selected, Monitor took emphasis_1 as its background, which was the
      // text color (white on white). It must be a background of its own.
      const r = part(theme, 'ribbon_unselected');
      expect(contrastRatio(r.base, r.emphasis_1)).toBeGreaterThanOrEqual(7);
      expect(r.emphasis_1).not.toBe(r.background);
      expect(r.emphasis_1).not.toBe(part(theme, 'ribbon_selected').background);
    });
    it(`${theme}: zellij's swap-layout label (BASE, shown with floating panes) reads at 7:1 in both its states`, () => {
      // C-24, from zellij 0.45.1's compact bar (line.rs): the label is the bar's ground color
      // (text_unselected.background) on ribbon_selected.background, or on
      // ribbon_unselected.background once a floating pane changes the layout. A real capture showed
      // it black on #1F1F1F (1.2:1).
      const ground = part(theme, 'text_unselected').background;
      expect(contrastRatio(ground, part(theme, 'ribbon_selected').background)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(ground, part(theme, 'ribbon_unselected').background)).toBeGreaterThanOrEqual(7);
    });
    it(`${theme}: never uses the proof green`, () => {
      expect(block(theme).toUpperCase()).not.toContain(palette.green.slice(1).toUpperCase());
      const [r, g, b] = [palette.green.slice(1, 3), palette.green.slice(3, 5), palette.green.slice(5, 7)].map((h) => parseInt(h, 16));
      expect(block(theme)).not.toContain(`${r} ${g} ${b}`);
    });
  }
});

// Round R1 (DESIGN.md §10 B9), re-pointed by B10 (the operator's palette of 2026-10-15): Timmy Homebrew for
// zellij. The selected tab, row, cell and frame are amber (focus), every other part keeps Night's
// guarantees, and nothing is green: a zellij part is never an observed live, passed or sealed state.
describe('the zellij theme: Timmy Homebrew', () => {
  const theme = 'timmy-homebrew';
  const upper = (h: string) => h.toUpperCase();
  it('sets every component', () => {
    for (const c of COMPONENTS) expect(block(theme), c).toContain(`        ${c} {`);
  });
  it('paints the selected tab amber with black text, and every other tab in the structure greys with off-white text', () => {
    const sel = part(theme, 'ribbon_selected');
    expect(upper(sel.background)).toBe(HOMEBREW.accent.toUpperCase());
    expect(upper(part(theme, 'ribbon_unselected').background)).toBe(HOMEBREW.lineStrong.toUpperCase());
    expect(upper(part(theme, 'ribbon_unselected').emphasis_1)).toBe(HOMEBREW.line.toUpperCase());
    expect(upper(sel.base)).toBe(HOMEBREW.ground.toUpperCase());
    const un = part(theme, 'ribbon_unselected');
    expect(upper(un.base)).toBe(HOMEBREW.text.toUpperCase());
    expect(contrastRatio(un.background, TIMMY_HOMEBREW.background)).toBeLessThan(contrastRatio(sel.background, TIMMY_HOMEBREW.background));
  });
  it('keeps the selected tab 2.5:1 from both unselected pills', () => {
    const selected = part(theme, 'ribbon_selected').background;
    const { background, emphasis_1 } = part(theme, 'ribbon_unselected');
    expect(contrastRatio(selected, background)).toBeGreaterThanOrEqual(2.5);
    expect(contrastRatio(selected, emphasis_1)).toBeGreaterThanOrEqual(2.5);
    expect(part(theme, 'ribbon_selected').background).not.toBe(background);
  });
  it('reads every text part at 7:1 or better, frames at 3:1, the highlight and errors at 4.5:1', () => {
    for (const c of ['text_unselected', 'text_selected', 'ribbon_unselected', 'ribbon_selected', 'table_title', 'table_cell_unselected', 'table_cell_selected', 'list_unselected', 'list_selected']) {
      const { base, background } = part(theme, c);
      expect(contrastRatio(base, background), c).toBeGreaterThanOrEqual(7);
    }
    for (const c of ['frame_highlight', 'exit_code_error']) expect(contrastRatio(part(theme, c).base, TIMMY_HOMEBREW.background), c).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(part(theme, 'frame_unselected').base, TIMMY_HOMEBREW.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(part(theme, 'frame_selected').base, TIMMY_HOMEBREW.background)).toBeGreaterThanOrEqual(3);
  });
  it('keeps the second unselected pill readable at 7:1 and apart from its neighbours', () => {
    const r = part(theme, 'ribbon_unselected');
    expect(contrastRatio(r.base, r.emphasis_1)).toBeGreaterThanOrEqual(7);
    expect(r.emphasis_1).not.toBe(r.background);
    expect(r.emphasis_1).not.toBe(part(theme, 'ribbon_selected').background);
  });
  it('shows the swap-layout label (BASE) at 7:1 on the selected tab; on an unselected one it is the measured limit, 2.1:1', () => {
    // The label is the bar's ground on the tab's pill. The unselected pill is the operator's structure grey
    // (#444444, B10), which holds the off-white tab text at 8.4:1 but gives a black label only 2.16:1. This
    // pins the trade so it cannot drift lower unseen.
    const ground = part(theme, 'text_unselected').background;
    expect(contrastRatio(ground, part(theme, 'ribbon_selected').background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(ground, part(theme, 'ribbon_unselected').background)).toBeGreaterThanOrEqual(2.1);
  });
  it('uses amber for the selection (the selected tab, row, cell and frame) and no green anywhere: not even a player or an exit code', () => {
    const amber = HOMEBREW.accent.toUpperCase();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(HOMEBREW_GREEN.slice(i, i + 2), 16));
    expect(block(theme)).not.toContain(`${r} ${g} ${b}`);
    for (const c of ['text_unselected', 'ribbon_unselected', 'table_title', 'table_cell_unselected', 'list_unselected', 'frame_unselected', 'exit_code_success']) {
      const body = Object.values(part(theme, c)).map(upper);
      expect(body, c).not.toContain(amber);
    }
    for (const c of ['ribbon_selected', 'text_selected', 'table_cell_selected', 'list_selected']) expect(Object.values(part(theme, c)).map(upper), c).toContain(amber);
    expect(upper(part(theme, 'frame_selected').base)).toBe(amber);
  });
  it('uses the shared settings: off-white text, black ground, amber highlight, an error exit amber (B10 has no red)', () => {
    expect(upper(part(theme, 'text_unselected').base)).toBe(HOMEBREW.text.toUpperCase());
    expect(upper(part(theme, 'text_unselected').background)).toBe(HOMEBREW.ground.toUpperCase());
    expect(upper(part(theme, 'frame_highlight').base)).toBe(HOMEBREW.attention.toUpperCase());
    expect(upper(part(theme, 'exit_code_error').base)).toBe(HOMEBREW.failure.toUpperCase());
  });
  it('leaves Night and Day as they were: Homebrew is an added theme in the same file', () => {
    expect(kdl).toContain('    timmy-night {');
    expect(kdl).toContain('    timmy-day {');
    expect(kdl).toContain('    timmy-homebrew {');
  });
});
