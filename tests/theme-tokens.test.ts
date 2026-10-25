/**
 * Round R1, gap 5 (DESIGN.md §10 B9), re-pointed by B10 (the operator's palette of 2026-10-15): one set of
 * shared settings. The terminal palette and the browser pages read the same colors and type; focus and the
 * next step are amber, green is only observed live, passed or sealed, and outcome words never ride on color
 * alone; Monaspace Argon is preferred, with a monospace fallback that always exists.
 *
 * R11 round 7 (H175; DESIGN.md §10 B11, the SHELL CONTRACT v1): the B11 registry (`UI`, `UI_THEMES`, `--timmy-ui-*`) beside it,
 * additive: the terminal values (HOMEBREW, HOMEBREW_TERMINAL) stay byte-identical (pinned below), and every B11 text role is
 * re-measured here on every surface it is written on (≥ 4.5:1 text, ≥ 6:1 neutral text), in both families. D12 (the lead's
 * 18:06 ruling on H168's R83/R84, 2026-10-24): the B10 WEB names are aliases of their B11 role (LEGACY_WEB_ALIAS), so the sheet
 * carries ONE palette; the alias map and the aliased text's contrast on every dark surface are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/term/color.js';
import { measuredFromPalette, namedPalette, TIMMY_HOMEBREW } from '../src/term/palettes.js';
import { roleSlots } from '../src/term/theme.js';
import { FONT_FILES, HOMEBREW, HOMEBREW_TERMINAL, LEGACY_WEB_ALIAS, TYPE, TYPE_UI, UI, UI_DEFAULT_THEME, UI_ELEVATION, UI_MOTION, UI_PAPER_END, UI_RADIUS, UI_SPACE, UI_THEMES, UI_WEB_FONT_PATH, themeCss, uiThemeCss } from '../src/theme/tokens.js';
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
    // every B10 name is still a variable of the sheet (an alias since D12: its value is its B11 role's, below)
    for (const name of Object.keys(HOMEBREW)) expect(css).toContain(`--timmy-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: var(--timmy-ui-`);
    expect(css).toContain('--timmy-font-mono: var(--timmy-ui-font-mono);');
    expect(css).toContain(`--timmy-ui-font-mono: ${TYPE.stack};`);
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

describe('B11: the browser registry (--timmy-ui-*), additive beside B10', () => {
  /** The exact B10 values, so a change to them is a change here first (the terminal; the web names are aliases, D12). */
  it('the terminal values are byte-identical to the operator\'s decision of 2026-10-15', () => {
    expect(HOMEBREW).toEqual({
      ground: '#000000', surface: '#070707', raised: '#070707', line: '#333333', lineStrong: '#444444', text: '#F2EFE9', textSecondary: '#8E8E93',
      accent: '#FFB000', accentInk: '#000000', accentSoft: '#333333', silver: '#E8E4D9', attention: '#FFB000', failure: '#FFB000',
      live: '#28FE14', liveDim: '#00D700', ai: '#E8E4D9', link: '#E8E4D9', diffAdd: '#28FE14', diffRemove: '#FF5F56',
    });
    expect(HOMEBREW_TERMINAL).toEqual({
      name: 'Timmy Homebrew', background: '#000000', foreground: '#F2EFE9', cursor: '#FFB000', selection: '#333333',
      black: '#070707', red: '#FF5F56', green: '#28FE14', yellow: '#FFB000', blue: '#6CA8FF', magenta: '#B58CFF', cyan: '#5CC8D6', white: '#E8E4D9',
      brightBlack: '#8E8E93', brightRed: '#FF8A80', brightGreen: '#00D700', brightYellow: '#FFC94D', brightBlue: '#9CC3FF', brightMagenta: '#D0B3FF', brightCyan: '#8EE3EC', brightWhite: '#F2EFE9',
    });
    // the terminal palette is built from HOMEBREW, never from the web aliases
    expect(HOMEBREW_TERMINAL.background).toBe(HOMEBREW.ground);
    expect(HOMEBREW_TERMINAL.brightBlack).toBe(HOMEBREW.textSecondary);
  });
  /** D12 (ONE PALETTE): each B10 web name is an alias of one B11 role; no B10 value is written into the sheet. */
  it('the B10 web names are aliases of their B11 role (D12), the B10 block before the B11 block, and no B10 value is written', () => {
    expect(LEGACY_WEB_ALIAS).toEqual({
      ground: 'canvas', surface: 'surface', raised: 'raised', line: 'border-quiet', lineStrong: 'border', text: 'text', textSecondary: 'text-muted',
      accent: 'accent', accentInk: 'accent-ink', accentSoft: 'accent-glow', silver: 'text-secondary', attention: 'focus', failure: 'focus',
      live: 'verified', liveDim: 'verified-dim', ai: 'text-secondary', link: 'accent-soft', diffAdd: 'diff-add', diffRemove: 'diff-remove',
    });
    const css = themeCss();
    expect(css.indexOf('--timmy-ground: var(--timmy-ui-canvas);')).toBeGreaterThan(0);
    expect(css.indexOf('--timmy-ground: var(--timmy-ui-canvas);')).toBeLessThan(css.indexOf('--timmy-ui-canvas:'));
    for (const line of ['--timmy-surface: var(--timmy-ui-surface);', '--timmy-raised: var(--timmy-ui-raised);', '--timmy-line: var(--timmy-ui-border-quiet);',
      '--timmy-line-strong: var(--timmy-ui-border);', '--timmy-text: var(--timmy-ui-text);', '--timmy-text-secondary: var(--timmy-ui-text-muted);',
      '--timmy-accent: var(--timmy-ui-accent);', '--timmy-accent-ink: var(--timmy-ui-accent-ink);', '--timmy-accent-soft: var(--timmy-ui-accent-glow);',
      '--timmy-silver: var(--timmy-ui-text-secondary);', '--timmy-attention: var(--timmy-ui-focus);', '--timmy-failure: var(--timmy-ui-focus);',
      '--timmy-live: var(--timmy-ui-verified);', '--timmy-live-dim: var(--timmy-ui-verified-dim);', '--timmy-ai: var(--timmy-ui-text-secondary);',
      '--timmy-link: var(--timmy-ui-accent-soft);', '--timmy-diff-add: var(--timmy-ui-diff-add);', '--timmy-diff-remove: var(--timmy-ui-diff-remove);']) expect(css).toContain(line);
    // every alias names a role the B11 block defines (in the shared block or in each family)
    const b11 = css.slice(css.indexOf('/* B11'));
    for (const role of new Set(Object.values(LEGACY_WEB_ALIAS))) expect(b11, role).toMatch(new RegExp(`--timmy-ui-${role}: `));
    // the B10 values themselves are nowhere in the sheet: #000000 ground, #070707 wells, #333333 / #444444 lines, #8E8E93 muted, #F2EFE9 text, #E8E4D9 silver
    for (const value of ['#000000', '#070707', '#333333', '#444444', '#8E8E93', '#F2EFE9', '#E8E4D9']) expect(css, value).not.toContain(value);
    // the type lines keep their values (a legacy h1/h2 has no one B11 size)
    expect(css).toContain(`--timmy-size-small: ${TYPE.size.small}px;`);
    expect(css).toContain(`--timmy-size-h1: ${TYPE.size.h1}px;`);
  });
  /** The aliased muted text (the old #8E8E93, 6.4:1 on black) on each dark surface it is now drawn on — measured, not assumed. */
  it('the aliased text names keep ≥ 6:1 on the canvas, surface and raised; silver\'s and link\'s targets ≥ 4.5:1 on each, in both families', () => {
    const roleValue = (role: string, family: 'amber' | 'glacier'): string => {
      const shared = UI as Record<string, string>;
      const camel = role.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (camel in shared) return shared[camel];
      return (UI_THEMES[family] as unknown as Record<string, string>)[camel];
    };
    const muted = roleValue(LEGACY_WEB_ALIAS.textSecondary, 'amber');
    expect(muted).toBe('#9AAFC3');
    const measured = { canvas: contrastRatio(muted, UI.canvas), surface: contrastRatio(muted, UI.surface), raised: contrastRatio(muted, UI.raised) };
    expect(measured.canvas).toBeGreaterThanOrEqual(8.7);
    expect(measured.surface).toBeGreaterThanOrEqual(7.7);
    expect(measured.raised).toBeGreaterThanOrEqual(6.5);
    for (const bg of [UI.canvas, UI.surface, UI.raised]) {
      for (const name of ['text', 'textSecondary', 'silver', 'ai'] as const) expect(contrastRatio(roleValue(LEGACY_WEB_ALIAS[name], 'amber'), bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(6);
      for (const family of ['amber', 'glacier'] as const) for (const name of ['accent', 'link'] as const) expect(contrastRatio(roleValue(LEGACY_WEB_ALIAS[name], family), bg), `${family} ${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const name of ['attention', 'failure', 'live'] as const) expect(contrastRatio(roleValue(LEGACY_WEB_ALIAS[name], 'amber'), bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // accent-ink on the family accent (the B10 primary's label) and on the verified green (a green fill's label): ≥ 6:1
    for (const family of ['amber', 'glacier'] as const) {
      expect(contrastRatio(UI_THEMES[family].accentInk, UI_THEMES[family].accent)).toBeGreaterThanOrEqual(6);
      expect(contrastRatio(UI_THEMES[family].accentInk, UI.verified)).toBeGreaterThanOrEqual(6);
    }
  });
  it('the shared roles are the study\'s v0.1 values, with the measured changes said (accent-ink, ink-soft, border-quiet); focus and verified are exact in both families', () => {
    expect(UI).toMatchObject({ canvas: '#080B0F', surface: '#111A23', raised: '#1C2936', paper: '#E8EFF5', border: '#44586B', text: '#ECF1F5', textSecondary: '#BDCADA', textMuted: '#9AAFC3', ink: '#1C3043', focus: '#FFB000', verified: '#28FE14' });
    expect(UI_THEMES.amber).toMatchObject({ accent: '#D6AA64', accentSoft: '#EAD0A3', accentStart: '#F0E5D4' });
    expect(UI_THEMES.glacier).toMatchObject({ accent: '#8ABBE3', accentSoft: '#BED9ED', accentStart: '#E1EEF7' });
    // the study's inks measured under 4.5 / 6 on the accent (H168's watch-point): the registry's are the 6:1 ones
    expect(UI_THEMES.amber.accentInk).not.toBe('#5B421D');
    expect(UI_THEMES.glacier.accentInk).not.toBe('#244761');
    expect(UI.focus).toBe(HOMEBREW.accent);
    expect(UI.verified).toBe(HOMEBREW.live);
    expect(UI_DEFAULT_THEME).toBe('amber');
    // no family carries a status colour: the accents are neither the focus amber nor the verified green
    for (const t of Object.values(UI_THEMES)) for (const v of Object.values(t)) expect([UI.focus, UI.verified, UI.verifiedDim]).not.toContain(v.toUpperCase());
  });
  it('contrast: every text role ≥ 4.5:1 on every surface it is written on, neutral text ≥ 6:1, in both families; the focus ring 3:1 by its halo on paper', () => {
    const dark = [UI.canvas, UI.surface, UI.raised];
    for (const bg of dark) {
      for (const neutral of [UI.text, UI.textSecondary, UI.textMuted]) expect(contrastRatio(neutral, bg), `${neutral} on ${bg}`).toBeGreaterThanOrEqual(6);
      for (const role of [UI.focus, UI.verified, UI.verifiedDim]) expect(contrastRatio(role, bg), `${role} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const [name, t] of Object.entries(UI_THEMES)) {
        expect(contrastRatio(t.accent, bg), `${name} accent on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.accentSoft, bg), `${name} accent-soft on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // paper: the ink and its secondary, on the paper and on the paper gradient's darkest stop
    for (const bg of [UI.paper, UI_PAPER_END]) {
      expect(contrastRatio(UI.ink, bg), `ink on ${bg}`).toBeGreaterThanOrEqual(6);
      expect(contrastRatio(UI.inkSoft, bg), `ink-soft on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(UI.inkSoft, UI.paper)).toBeGreaterThanOrEqual(6);
    // the primary action's label on the gradient's dark end (the accent) and its light start: the 6:1 neutral floor
    for (const [name, t] of Object.entries(UI_THEMES)) {
      expect(contrastRatio(t.accentInk, t.accent), `${name} ink on accent`).toBeGreaterThanOrEqual(6);
      expect(contrastRatio(t.accentInk, t.accentStart), `${name} ink on start`).toBeGreaterThanOrEqual(6);
      expect(contrastRatio(t.accentInk, t.accentSoft), `${name} ink on soft`).toBeGreaterThanOrEqual(4.5);
    }
    // focus: 3:1 on every dark surface by itself; on paper by its halo (the 2 px gap under the ring)
    for (const bg of dark) expect(contrastRatio(UI.focus, bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(UI.focus, UI.paper)).toBeLessThan(3); // the measured fact the halo answers
    expect(contrastRatio(UI.focusHalo, UI.paper)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(UI.focus, UI.focusHalo)).toBeGreaterThanOrEqual(3);
    // verified green is never a colour alone on paper (1.2:1): the rule is a word and a glyph on a dark chip
    expect(contrastRatio(UI.verified, UI.paper)).toBeLessThan(3);
  });
  it('the sheet carries every --timmy-ui-* name once in :root, the families under html[data-theme] (amber also without it), motion 0 under reduced motion', () => {
    const css = themeCss(UI_WEB_FONT_PATH);
    const kebab = (n: string): string => n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    for (const [name, value] of Object.entries(UI)) expect(css).toContain(`  --timmy-ui-${kebab(name)}: ${value};`);
    // (each name once in the shared block; the three motion names appear a second time, as 0ms, under reduced motion)
    const shared = css.slice(css.indexOf('--timmy-ui-canvas:'), css.indexOf(':root, :root[data-theme="amber"] {'));
    for (const name of ['font', 'font-mono', 'size-page', 'size-section', 'size-body', 'size-label', 'weight-body', 'weight-medium', 'weight-strong', 'weight-heading', 'leading-tight', 'leading-body', 'leading-label', 'tracking-kicker', 'tracking-title', 'space-1', 'space-8', 'radius-control', 'radius-panel', 'radius-workspace', 'radius-pill', 'elev-canvas', 'elev-surface', 'elev-raised', 'elev-paper', 'elev-primary', 'elev-rail', 'elev-top', 'shadow-panel', 'shadow-raised', 'shadow-paper', 'shadow-primary', 'highlight', 'scrim', 'motion-feedback', 'motion-state', 'motion-panel', 'ease']) {
      expect((shared.match(new RegExp(`--timmy-ui-${name}:`, 'g')) ?? []).length, name).toBe(1);
    }
    expect(css).toContain(`  --timmy-ui-font: ${TYPE_UI.stack};`);
    expect(css).toContain(`  --timmy-ui-swatch-amber: ${UI_THEMES.amber.accent};`);
    expect(css).toContain(`  --timmy-ui-swatch-glacier: ${UI_THEMES.glacier.accent};`);
    expect(css).toContain(`  --timmy-ui-font-mono: ${TYPE.stack};`);
    expect(css).toContain(`  --timmy-ui-size-label: ${TYPE_UI.size.label}px;`);
    expect(TYPE_UI.size.label).toBeGreaterThanOrEqual(13); // the page's floor
    expect(UI_SPACE).toEqual([4, 8, 12, 16, 24, 32, 48, 64]);
    expect(UI_RADIUS).toEqual({ control: 10, panel: 16, workspace: 22, pill: 999 });
    expect(UI_MOTION).toMatchObject({ feedback: 120, state: 180, panel: 220 });
    // the families: amber is the default (no attribute) and the named one; glacier under its attribute; each the four + wash + glow
    const amber = css.slice(css.indexOf(':root, :root[data-theme="amber"] {'), css.indexOf(':root[data-theme="glacier"] {'));
    const glacier = css.slice(css.indexOf(':root[data-theme="glacier"] {'), css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const [block, t] of [[amber, UI_THEMES.amber], [glacier, UI_THEMES.glacier]] as const) {
      expect(block).toContain(`--timmy-ui-accent: ${t.accent};`);
      expect(block).toContain(`--timmy-ui-accent-soft: ${t.accentSoft};`);
      expect(block).toContain(`--timmy-ui-accent-ink: ${t.accentInk};`);
      expect(block).toContain(`--timmy-ui-accent-start: ${t.accentStart};`);
      expect(block).toMatch(/--timmy-ui-accent-wash: rgba\(\d+, \d+, \d+, 0\.08\);/);
      expect(block).toMatch(/--timmy-ui-accent-glow: rgba\(\d+, \d+, \d+, 0\.18\);/);
    }
    expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n  :root { --timmy-ui-motion-feedback: 0ms; --timmy-ui-motion-state: 0ms; --timmy-ui-motion-panel: 0ms; }');
    // elevation: gradients only for surface, depth and the primary action; the family reaches them through var()
    expect(UI_ELEVATION.primary).toContain('var(--timmy-ui-accent-start)');
    expect(UI_ELEVATION.canvas).toContain('var(--timmy-ui-accent-wash)');
    expect(css).not.toMatch(/https?:\/\//);
  });
  it('the UI face is Outfit, local() first; its file is named only under the companion\'s web fonts folder (the Studio\'s /fonts/ gets local() alone, so nothing 404s there)', () => {
    expect(TYPE_UI.stack.startsWith('"Outfit"')).toBe(true);
    expect(TYPE_UI.stack).toContain('"Monaspace Argon"');
    expect(TYPE_UI.stack.endsWith('sans-serif')).toBe(true);
    const web = themeCss(UI_WEB_FONT_PATH);
    const face = web.split('@font-face').find((b) => b.includes('"Outfit"'))!;
    expect(face).toContain('font-weight: 100 900');
    expect(face).toContain('font-display: swap');
    expect(face.indexOf('local("Outfit")')).toBeLessThan(face.indexOf(`url("${UI_WEB_FONT_PATH}${TYPE_UI.file}")`));
    const studio = themeCss();
    const studioFace = studio.split('@font-face').find((b) => b.includes('"Outfit"'))!;
    expect(studioFace).toContain('local("Outfit")');
    expect(studioFace).not.toContain('url(');
    expect(uiThemeCss(null)).not.toContain('url(');
    // the Monaspace faces are as they were, before the Outfit face
    for (const f of FONT_FILES) expect(web).toContain(`url("${UI_WEB_FONT_PATH}${f.file}")`);
    expect(web.indexOf('"Monaspace Argon"')).toBeLessThan(web.indexOf('"Outfit"'));
  });
});
