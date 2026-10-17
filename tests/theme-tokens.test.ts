/**
 * Round R1, gap 5 (DESIGN.md §10 B9), re-pointed by B10 (the operator's palette of 2026-10-15): one set of
 * shared settings. The terminal palette and the browser pages read the same colors and type; focus and the
 * next step are amber, green is only observed live, passed or sealed, and outcome words never ride on color
 * alone; Monaspace Argon is preferred, with a monospace fallback that always exists.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/term/color.js';
import { measuredFromPalette, namedPalette, TIMMY_HOMEBREW } from '../src/term/palettes.js';
import { roleSlots } from '../src/term/theme.js';
import { FONT_FILES, HOMEBREW, TYPE, themeCss } from '../src/theme/tokens.js';
import { timmyPalette } from '../src/repl/main.js';

describe('Timmy Homebrew in the terminal', () => {
  it('black ground, off-white text, amber focus, green only for verified, and each meaning in its own readable slot (B10)', () => {
    expect(TIMMY_HOMEBREW).toMatchObject({ name: 'Timmy Homebrew', background: '#000000', foreground: '#F2EFE9', green: '#28FE14', yellow: '#FFB000', white: '#E8E4D9', brightBlack: '#8E8E93' });
    const slots = roleSlots({ color: 3 }, measuredFromPalette(TIMMY_HOMEBREW));
    expect(slots).toMatchObject({ accent: 3, verified: 2, estimate: 3, failure: 3, ai: 7, rule: 8, secondary: 8, diffAdd: 2, diffRemove: 1 });
  });
  it('is named by TIMMY_PALETTE=homebrew and recognized when the terminal answers with it', () => {
    expect(namedPalette('homebrew')).toBe(TIMMY_HOMEBREW);
    expect(namedPalette('HOMEBREW')).toBe(TIMMY_HOMEBREW);
    expect(timmyPalette(measuredFromPalette(TIMMY_HOMEBREW), {})).toBe('homebrew');
    expect(timmyPalette(measuredFromPalette(TIMMY_HOMEBREW), { TIMMY_PALETTE: 'homebrew' })).toBe('homebrew');
  });
  it('reads from the shared settings, not its own copy', () => {
    expect(TIMMY_HOMEBREW.background).toBe(HOMEBREW.ground);
    expect(TIMMY_HOMEBREW.foreground).toBe(HOMEBREW.text);
    expect(TIMMY_HOMEBREW.green).toBe(HOMEBREW.live);
    expect(TIMMY_HOMEBREW.yellow).toBe(HOMEBREW.accent);
    expect(TIMMY_HOMEBREW.white).toBe(HOMEBREW.silver);
    expect(TIMMY_HOMEBREW.brightBlack).toBe(HOMEBREW.textSecondary);
    expect(TIMMY_HOMEBREW.selection).toBe(HOMEBREW.accentSoft);
  });
});

describe('the browser settings', () => {
  it('B10: the exact palette; text at 7:1 and secondary at 6:1 on the canvas and the wells; accents at 4.5:1; focus at 3:1; ink on amber and green at 7:1', () => {
    expect(HOMEBREW).toMatchObject({
      ground: '#000000', surface: '#070707', line: '#333333', lineStrong: '#444444', text: '#F2EFE9', textSecondary: '#8E8E93',
      accent: '#FFB000', silver: '#E8E4D9', live: '#28FE14', liveDim: '#00D700',
    });
    // amber is exact, never the legacy #E5B550; and no red, blue or violet is left in the chrome (diffRemove is B5's diff marker)
    const chrome = Object.entries(HOMEBREW).filter(([k]) => k !== 'diffRemove').map(([, v]) => v.toUpperCase());
    expect(chrome).not.toContain('#E5B550');
    for (const banned of ['#FF5F56', '#B58CFF', '#6CA8FF', '#BD93F9', '#3BE08C']) expect(chrome, banned).not.toContain(banned);
    for (const bg of [HOMEBREW.ground, HOMEBREW.surface, HOMEBREW.raised]) {
      expect(contrastRatio(HOMEBREW.text, bg), `text on ${bg}`).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(HOMEBREW.textSecondary, bg), `secondary on ${bg}`).toBeGreaterThanOrEqual(6);
      for (const accent of [HOMEBREW.accent, HOMEBREW.attention, HOMEBREW.failure, HOMEBREW.ai, HOMEBREW.link, HOMEBREW.silver, HOMEBREW.live, HOMEBREW.liveDim]) {
        expect(contrastRatio(accent, bg), `${accent} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      // separators are low-contrast on purpose (B10); the focus ring is what marks the control you are on
      expect(contrastRatio(HOMEBREW.accent, bg), `focus on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(HOMEBREW.accentInk, HOMEBREW.accent)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(HOMEBREW.accentInk, HOMEBREW.live)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(HOMEBREW.text, HOMEBREW.accentSoft)).toBeGreaterThanOrEqual(7);
  });
  it('the CSS carries every setting as a variable, Monaspace Argon first, and a fallback that always exists', () => {
    const css = themeCss();
    for (const [name, value] of Object.entries(HOMEBREW)) expect(css).toContain(`${value}`), expect(css).toContain(`--timmy-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:`);
    expect(css).toContain(`--timmy-font-mono: ${TYPE.stack};`);
    expect(TYPE.stack.startsWith('"Monaspace Argon"')).toBe(true);
    expect(TYPE.stack.endsWith('monospace')).toBe(true);
    expect(css).toContain(`--timmy-size-body: ${TYPE.size.body}px;`);
    expect(css).toContain(`--timmy-weight-body: ${TYPE.weight.body};`);
    expect(css).toContain(`--timmy-weight-heading: ${TYPE.weight.heading};`);
  });
  it('each face is the installed font when there is one, else the copy Timmy serves, never a remote one', () => {
    const css = themeCss();
    expect(FONT_FILES.map((f) => f.weight)).toEqual(expect.arrayContaining([400, 600, 700]));
    for (const f of FONT_FILES) {
      const face = css.split('@font-face').find((b) => b.includes(f.file))!;
      expect(face).toContain(`font-weight: ${f.weight}`);
      expect(face.indexOf('local(')).toBeLessThan(face.indexOf(`url("/fonts/${f.file}")`));
      expect(face).toContain('font-display: swap');
    }
    expect(css).not.toMatch(/https?:\/\//);
  });
});
