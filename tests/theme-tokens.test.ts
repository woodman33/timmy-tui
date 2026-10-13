/**
 * Round R1, gap 5 (DESIGN.md §10 B9): the Homebrew-inspired default, from one set of shared settings.
 * The terminal palette and the browser pages read the same colors and type; outcome words never ride
 * on green alone; Monaspace Argon is preferred, with a monospace fallback that always exists.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/term/color.js';
import { measuredFromPalette, namedPalette, TIMMY_HOMEBREW } from '../src/term/palettes.js';
import { roleSlots } from '../src/term/theme.js';
import { FONT_FILES, HOMEBREW, TYPE, themeCss } from '../src/theme/tokens.js';
import { timmyPalette } from '../src/repl/main.js';

describe('Timmy Homebrew in the terminal', () => {
  it('black ground, off-white text, Homebrew green, and each meaning in its own readable slot', () => {
    expect(TIMMY_HOMEBREW).toMatchObject({ name: 'Timmy Homebrew', background: '#000000', green: '#28FE14' });
    const slots = roleSlots({ color: 3 }, measuredFromPalette(TIMMY_HOMEBREW));
    expect(slots).toMatchObject({ accent: 2, verified: 2, estimate: 3, failure: 1, ai: 5, rule: 8, secondary: 7 });
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
    expect(TIMMY_HOMEBREW.green).toBe(HOMEBREW.accent);
    expect(TIMMY_HOMEBREW.selection).toBe(HOMEBREW.accentSoft);
  });
});

describe('the browser settings', () => {
  it('text reads at 7:1 on the ground and the charcoal surfaces; accents at 4.5:1; ink on green at 7:1', () => {
    for (const bg of [HOMEBREW.ground, HOMEBREW.surface, HOMEBREW.raised]) {
      expect(contrastRatio(HOMEBREW.text, bg), `text on ${bg}`).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(HOMEBREW.textSecondary, bg), `secondary on ${bg}`).toBeGreaterThanOrEqual(7);
      for (const accent of [HOMEBREW.accent, HOMEBREW.attention, HOMEBREW.failure, HOMEBREW.ai, HOMEBREW.link]) {
        expect(contrastRatio(accent, bg), `${accent} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(HOMEBREW.lineStrong, bg), `lineStrong on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(HOMEBREW.accentInk, HOMEBREW.accent)).toBeGreaterThanOrEqual(7);
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
