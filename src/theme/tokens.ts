/**
 * Timmy's shared look: one place for the colors and the type that every surface reads, so a new screen
 * inherits them. The palette is the operator's decision of 2026-10-15 (DESIGN.md §10 B10), which
 * replaces B9's green-for-interaction:
 *
 *   canvas and wells                                   #000000 / #070707
 *   structure, execution, secondary controls          #333333 / #444444
 *   primary and secondary text                         #F2EFE9 / #8E8E93
 *   focus, primary next step, .intent, .predict,
 *   target geometry                                    #FFB000, with the supporting silver #E8E4D9
 *   observed live connection, passed check,
 *   verified sealed receipt                            #28FE14 / #00D700
 *
 * Green is earned: a selectable command, an enabled setting, a recommendation, a running process or a
 * delivered result is never green. Every state also keeps its word and its glyph (✓ verified, ✕ failed,
 * ● live, needs setup), so color alone never says what happened. The palette has no red, blue, cyan,
 * violet or mint; a failure is amber with ✕ and the word, and made-by-a-model is silver with its word.
 *
 * The terminal palette (src/term/palettes.ts, TIMMY_HOMEBREW), the terminal theme files and the browser
 * pages (themeCss) are all built from these values. Pure data and string building: no imports at run
 * time, so Node and the browser pages can both use it. Content keeps its own colors: the canvas's
 * artwork, imported images and video, reference artwork and scientifically meaningful data are never
 * recolored to fit this chrome.
 *
 * R11 round 7 (H175; DESIGN.md §10 B11, the operator's order of 2026-10-24 and the lead's D1/D2; the SHELL
 * CONTRACT v1): the browser companion and Studio take the Card Lab direction on a SECOND registry, `UI`
 * (`--timmy-ui-*` in the theme sheet): one semantic set — surfaces, text, border, focus, verified, type,
 * spacing, radii, elevation, motion — with two theme families on it, Amber (the default) and Glacier
 * (`UI_THEMES`, under html[data-theme]). The family describes surface, depth and the primary action; it
 * never changes a status's meaning: focus stays exact #FFB000 and an observed live / passed / sealed
 * state stays #28FE14 in both. The terminal keeps B10 exactly (`HOMEBREW`, above: byte-identical, pinned
 * by tests/theme-tokens.test.ts), and the B10 web names (`--timmy-ground` …) keep their values for the
 * pages not yet on the contract, the Studio's own sheet and the tests that pin those rendered colours;
 * a page on the contract reads the `--timmy-ui-*` names only. The study's tokens.json v0.1 is the start
 * (D1); the values changed from it, each with its measured reason, are marked "measured" below.
 */
import type { TerminalPalette } from '../term/palettes.js';

/** The green of macOS Terminal's Homebrew profile: observed live, passed, verified and sealed, nothing else. */
export const HOMEBREW_GREEN = '#28FE14';
/** The amber of focus, the primary next step, intent, prediction and target geometry (exactly this; not #E5B550). */
export const HOMEBREW_AMBER = '#FFB000';

/** The browser surfaces' colors (and the terminal palette's defaults). */
export const HOMEBREW = {
  /** The canvas: the page, the terminal, every viewport. */
  ground: '#000000',
  /** Wells: panels and cards. */
  surface: '#070707',
  /** Menus and inputs: wells too, told apart by their border, never by a lighter fill. */
  raised: '#070707',
  /** Hairlines that only separate (low contrast on purpose; never a control's only boundary). */
  line: '#333333',
  /** Structure, execution stages and secondary controls. A control also carries its words or a fill. */
  lineStrong: '#444444',
  /** Primary text. */
  text: '#F2EFE9',
  /** Secondary labels and hints (6.4:1 on the canvas). */
  textSecondary: '#8E8E93',
  /** Focus, the primary next step, .intent and .predict cards, target geometry. */
  accent: HOMEBREW_AMBER,
  /** Text on an amber or green fill. */
  accentInk: '#000000',
  /** The selection's ground: structure grey, so the selection never reads as a state. */
  accentSoft: '#333333',
  /** The supporting silver beside amber: secondary target geometry and neutral highlights. */
  silver: '#E8E4D9',
  /** Waiting for you, estimates, cost: amber, always with its word. */
  attention: HOMEBREW_AMBER,
  /** Failed, refused, destructive: amber with ✕ and the word (the palette has no red). */
  failure: HOMEBREW_AMBER,
  /** Observed live connection, passed check, verified sealed receipt. Nothing selectable, enabled, recommended, running or merely delivered. */
  live: HOMEBREW_GREEN,
  /** The second green of the same meaning (smaller marks, the terminal's bright twin). */
  liveDim: '#00D700',
  /** Made by a model, or sent over the network (B4): silver with its word. */
  ai: '#E8E4D9',
  /** Links: silver, underlined. */
  link: '#E8E4D9',
  /** Diff markers (B5): + keeps green and − keeps red. The one red, and the one green that is not proof. */
  diffAdd: HOMEBREW_GREEN,
  diffRemove: '#FF5F56',
} as const;

/**
 * Timmy Homebrew as a terminal palette: the ground, the text, and the 16 slots. Timmy's roles use
 * slot 2 (green: live, passed, sealed), 3 (amber: focus, next step, estimates, failures), 7 (silver:
 * made by a model), 8 (secondary labels) and 1 (red: diff removals only); the other slots keep
 * conventional values for the other programs in the same terminal and are never Timmy's chrome.
 */
export const HOMEBREW_TERMINAL: TerminalPalette = {
  name: 'Timmy Homebrew',
  background: HOMEBREW.ground,
  foreground: HOMEBREW.text,
  cursor: HOMEBREW.accent,
  selection: HOMEBREW.accentSoft,
  black: HOMEBREW.surface, red: HOMEBREW.diffRemove, green: HOMEBREW.live, yellow: HOMEBREW.accent,
  blue: '#6CA8FF', magenta: '#B58CFF', cyan: '#5CC8D6', white: HOMEBREW.silver,
  brightBlack: HOMEBREW.textSecondary, brightRed: '#FF8A80', brightGreen: HOMEBREW.liveDim, brightYellow: '#FFC94D',
  brightBlue: '#9CC3FF', brightMagenta: '#D0B3FF', brightCyan: '#8EE3EC', brightWhite: HOMEBREW.text,
};

/** Type: Monaspace Argon when it can be had, then the system's monospace faces, then any monospace. */
export const TYPE = {
  family: 'Monaspace Argon',
  /** The name a terminal profile asks for (macOS Terminal stores the PostScript name). */
  postscript: 'MonaspaceArgon-Regular',
  stack: '"Monaspace Argon", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
  /** Pixels in the browser. */
  size: { body: 14, small: 12.5, h2: 15, h1: 18 },
  weight: { body: 400, strong: 600, heading: 700 },
  lineHeight: 1.55,
  /** Points in a terminal profile: comfortable, a step above the usual 12. */
  terminalSize: 14,
  /** How to install it on a Mac (Homebrew's cask). */
  install: 'brew install --cask font-monaspace',
} as const;

/** The faces Timmy serves from 127.0.0.1 when the font is not installed (OFL-1.1, unmodified). */
export const FONT_FILES = [
  { weight: 400, style: 'normal', local: ['Monaspace Argon Regular', 'MonaspaceArgon-Regular'], file: 'monaspace-argon-latin-400-normal.woff2' },
  { weight: 400, style: 'italic', local: ['Monaspace Argon Italic', 'MonaspaceArgon-Italic'], file: 'monaspace-argon-latin-400-italic.woff2' },
  { weight: 600, style: 'normal', local: ['Monaspace Argon SemiBold', 'MonaspaceArgon-SemiBold'], file: 'monaspace-argon-latin-600-normal.woff2' },
  { weight: 700, style: 'normal', local: ['Monaspace Argon Bold', 'MonaspaceArgon-Bold'], file: 'monaspace-argon-latin-700-normal.woff2' },
] as const;

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// B11: the browser surfaces' registry (`--timmy-ui-*`). Values are the study's tokens.json v0.1 unless
// marked "measured" (contrast measured with WCAG 2.x relative luminance, as tests/theme-tokens.test.ts
// re-measures them: every text role ≥ 4.5:1 on every surface it is written on, neutral text ≥ 6:1).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The shared B11 roles: the same in both families. */
export const UI = {
  /** The page ground. */
  canvas: '#080B0F',
  /** A panel, a well. */
  surface: '#111A23',
  /** A raised card, an input, a menu. */
  raised: '#1C2936',
  /** The ONE light focal object of a task (B11: intentional light-on-dark; never a page background). */
  paper: '#E8EFF5',
  /** A control's or a card's border: structure (low contrast on purpose; a control is also told by its words or fill). */
  border: '#44586B',
  /** Hairlines that only separate (added: the study drew these as literal hexes). */
  borderQuiet: '#1E2A36',
  /** Primary text (17.3:1 on the canvas, 13.0:1 on raised). */
  text: '#ECF1F5',
  /** Secondary text and labels (8.9:1 on raised). */
  textSecondary: '#BDCADA',
  /** Hints and fine print (6.55:1 on raised: the 6:1 neutral floor, B3/B10). */
  textMuted: '#9AAFC3',
  /** Text on paper and on the family accent's light end (11.7:1 on paper). */
  ink: '#1C3043',
  /** Secondary text on paper (measured: added, 7.1:1 on paper; the study's muted on paper is 1.95). */
  inkSoft: '#3B5168',
  /** The focus ring, the primary next step's edge, .intent / .predict, what waits on you, a failure (with ✕ and its word). Exact, both families. */
  focus: HOMEBREW_AMBER,
  /** The 2 px gap drawn under the focus ring, so the ring is seen on paper too (focus on paper alone is 1.58:1). */
  focusHalo: '#080B0F',
  /** An OBSERVED live connection, a passed check, a verified sealed receipt — nothing selectable, running or delivered. Both families. */
  verified: HOMEBREW_GREEN,
  /** The same meaning, smaller marks. */
  verifiedDim: '#00D700',
  /** Diff markers (B5): the one green that is not proof, and the one red. */
  diffAdd: HOMEBREW_GREEN,
  diffRemove: '#FF5F56',
} as const;

/** A theme family: what describes surface, depth and the primary action (never a status). */
export interface UiThemeFamily {
  /** The family's key colour: the primary action's dark end, the active rail cue, the kicker's number. */
  readonly accent: string;
  /** The light half: active words on a dark surface, the active tool's fill. */
  readonly accentSoft: string;
  /** Text on the accent (the primary button's label), ≥ 6:1 on the accent. */
  readonly accentInk: string;
  /** The light start of the primary gradient. */
  readonly accentStart: string;
}

/** The two families (D1). Amber is the default. */
export const UI_THEMES: Readonly<Record<'amber' | 'glacier', UiThemeFamily>> = {
  // measured: accent-ink was #5B421D = 4.37:1 on #D6AA64 (the label on the gradient's dark end); #402E14 = 6.05:1
  amber: { accent: '#D6AA64', accentSoft: '#EAD0A3', accentInk: '#402E14', accentStart: '#F0E5D4' },
  // measured: accent-ink was #244761 = 4.79:1 on #8ABBE3; #1D3848 = 6.02:1, the same floor as amber's
  glacier: { accent: '#8ABBE3', accentSoft: '#BED9ED', accentInk: '#1D3848', accentStart: '#E1EEF7' },
};
export type UiThemeName = keyof typeof UI_THEMES;
export const UI_DEFAULT_THEME: UiThemeName = 'amber';
/** Where a viewer's choice is kept (localStorage; the theme is cosmetic and never changes a status's meaning). */
export const UI_THEME_STORAGE_KEY = 'timmy.theme';

/**
 * Type (D2, B11): the UI face for titles, labels and body is Outfit (the Card Lab's face; served by the companion's built
 * web assets, @fontsource-variable/outfit, OFL-1.1); paths, hashes, commands and code keep Monaspace Argon (TYPE above).
 * One scale: page / section / body / label; 13 px is the page's floor (no text under it).
 */
export const TYPE_UI = {
  family: 'Outfit',
  /** The face's local names first; Monaspace Argon then the system's sans faces, so a stack always resolves. */
  stack: '"Outfit", "Outfit Variable", "Monaspace Argon", system-ui, sans-serif',
  local: ['Outfit', 'Outfit Variable'],
  /** The variable file the companion's web build serves at `/web/fonts/` (scripts/companion-web-build.mjs FONTS). */
  file: 'outfit-latin-wght-normal.woff2',
  weightRange: '100 900',
  size: { page: 30, section: 18, body: 14, label: 13 },
  weight: { body: 400, medium: 500, strong: 600, heading: 600 },
  leading: { tight: 1.15, body: 1.55, label: 1.35 },
  tracking: { kicker: '0.14em', title: '-0.02em' },
} as const;

/** The one spacing scale, in px (`--timmy-ui-space-1` … `-8`). */
export const UI_SPACE = [4, 8, 12, 16, 24, 32, 48, 64] as const;
/** Radii: a control, a panel, the workspace's outer frame, a pill. */
export const UI_RADIUS = { control: 10, panel: 16, workspace: 22, pill: 999 } as const;
/** Motion, in ms (`--timmy-ui-motion-*`); under prefers-reduced-motion the sheet sets the three to 0ms. */
export const UI_MOTION = { feedback: 120, state: 180, panel: 220, ease: 'cubic-bezier(.2, .7, .2, 1)' } as const;

/** `#RRGGBB` at alpha `a`, as `rgba(r, g, b, a)`. */
const rgba = (hex: string, a: number): string => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/**
 * Elevation (B11: gradients describe surface, depth and the primary action — nothing else is tinted). Each is a CSS value a
 * page writes as `background: var(--timmy-ui-elev-<name>)`; the family's colours reach them through var() references.
 * `paperEnd` is the paper gradient's darkest stop, measured against the ink (≥ 6:1) in the tests.
 */
export const UI_ELEVATION = {
  canvas: 'radial-gradient(ellipse at 24% 0%, var(--timmy-ui-accent-wash), transparent 38%), var(--timmy-ui-canvas)',
  surface: 'linear-gradient(140deg, #141E29, #0E161F 60%, #111A23)',
  raised: 'linear-gradient(145deg, #22303E, #16212C)',
  paper: 'radial-gradient(ellipse at 0% 0%, #FFFFFF, transparent 50%), linear-gradient(135deg, #F2F5F8, #E4EAF0 52%, #BDCBD9)',
  primary: 'linear-gradient(120deg, var(--timmy-ui-accent-start), var(--timmy-ui-accent))',
  rail: 'linear-gradient(160deg, #121A24, #0A0F15 70%)',
  top: `radial-gradient(ellipse at 0 0, ${rgba('#FFFFFF', 0.025)}, transparent 60%), #0E151D`,
} as const;
/** The paper gradient's darkest stop (the ink is measured on it). */
export const UI_PAPER_END = '#BDCBD9';

/** Shadows and the two alpha colours (a page may write no rgba() of its own: the policy test's sheet rule). */
export const UI_SHADOW = {
  panel: `inset 0 1px 0 ${rgba('#FFFFFF', 0.04)}`,
  raised: `0 10px 30px ${rgba('#000000', 0.35)}, inset 0 1px 0 ${rgba('#FFFFFF', 0.06)}`,
  paper: `0 26px 65px ${rgba('#000000', 0.4)}, inset 0 1px 0 #FFFFFF`,
  primary: `inset 0 1px 0 ${rgba('#FFFFFF', 0.75)}, 0 7px 25px var(--timmy-ui-accent-glow), 0 3px 6px ${rgba('#000000', 0.25)}`,
  /** The 1 px top light on a dark material. */
  highlight: rgba('#FFFFFF', 0.06),
  /** Behind a sheet or the Help & find overlay. */
  scrim: rgba('#020509', 0.62),
} as const;

/** The companion page's web fonts folder: the one place the Outfit file is served from (src/companion/page.ts THEME_FONT_PATH). */
export const UI_WEB_FONT_PATH = '/web/fonts/';

/**
 * The B11 block of the theme sheet: the Outfit face, the shared `--timmy-ui-*` variables, the two families (amber also
 * without the attribute), and the reduced-motion rule. `uiFontPath` names where the Outfit file is served; null leaves the
 * face with its local() sources only (no request is made where the file is not served: the Studio's /fonts/).
 */
export function uiThemeCss(uiFontPath: string | null): string {
  const face = [
    '@font-face {',
    `  font-family: "${TYPE_UI.family}";`,
    '  font-style: normal;',
    `  font-weight: ${TYPE_UI.weightRange};`,
    '  font-display: swap;',
    `  src: ${[...TYPE_UI.local.map((n) => `local("${n}")`), ...(uiFontPath ? [`url("${uiFontPath}${TYPE_UI.file}") format("woff2")`] : [])].join(', ')};`,
    '}',
  ];
  const shared = [
    ...Object.entries(UI).map(([name, value]) => `  --timmy-ui-${kebab(name)}: ${value};`),
    `  --timmy-ui-font: ${TYPE_UI.stack};`,
    `  --timmy-ui-font-mono: ${TYPE.stack};`,
    ...Object.entries(TYPE_UI.size).map(([name, px]) => `  --timmy-ui-size-${name}: ${px}px;`),
    ...Object.entries(TYPE_UI.weight).map(([name, w]) => `  --timmy-ui-weight-${name}: ${w};`),
    ...Object.entries(TYPE_UI.leading).map(([name, v]) => `  --timmy-ui-leading-${name}: ${v};`),
    ...Object.entries(TYPE_UI.tracking).map(([name, v]) => `  --timmy-ui-tracking-${name}: ${v};`),
    ...UI_SPACE.map((px, i) => `  --timmy-ui-space-${i + 1}: ${px}px;`),
    ...Object.entries(UI_RADIUS).map(([name, px]) => `  --timmy-ui-radius-${name}: ${px}px;`),
    ...Object.entries(UI_ELEVATION).map(([name, v]) => `  --timmy-ui-elev-${name}: ${v};`),
    ...Object.entries(UI_SHADOW).filter(([name]) => name !== 'highlight' && name !== 'scrim').map(([name, v]) => `  --timmy-ui-shadow-${name}: ${v};`),
    `  --timmy-ui-highlight: ${UI_SHADOW.highlight};`,
    `  --timmy-ui-scrim: ${UI_SHADOW.scrim};`,
    ...(['feedback', 'state', 'panel'] as const).map((name) => `  --timmy-ui-motion-${name}: ${UI_MOTION[name]}ms;`),
    `  --timmy-ui-ease: ${UI_MOTION.ease};`,
  ];
  // the two families' keys as named swatches (the theme switch shows both while one is active)
  shared.push(...Object.entries(UI_THEMES).map(([name, t]) => `  --timmy-ui-swatch-${name}: ${t.accent};`));
  const family = (t: UiThemeFamily): string[] => [
    `  --timmy-ui-accent: ${t.accent};`,
    `  --timmy-ui-accent-soft: ${t.accentSoft};`,
    `  --timmy-ui-accent-ink: ${t.accentInk};`,
    `  --timmy-ui-accent-start: ${t.accentStart};`,
    `  --timmy-ui-accent-wash: ${rgba(t.accent, 0.08)};`,
    `  --timmy-ui-accent-glow: ${rgba(t.accent, 0.18)};`,
  ];
  return [
    '/* B11 (DESIGN.md §10 B11; SHELL CONTRACT v1): the browser surfaces\' registry, --timmy-ui-*, two families on one set. */',
    ...face,
    ':root {', ...shared, '}',
    `:root, :root[data-theme="${UI_DEFAULT_THEME}"] {`, ...family(UI_THEMES[UI_DEFAULT_THEME]), '}',
    ...Object.entries(UI_THEMES).filter(([name]) => name !== UI_DEFAULT_THEME).flatMap(([name, t]) => [`:root[data-theme="${name}"] {`, ...family(t), '}']),
    '@media (prefers-reduced-motion: reduce) {',
    '  :root { --timmy-ui-motion-feedback: 0ms; --timmy-ui-motion-state: 0ms; --timmy-ui-motion-panel: 0ms; }',
    '}',
    '',
  ].join('\n');
}

/**
 * The shared settings as CSS: the font faces (an installed Monaspace Argon first, else the copy at
 * `/fonts/`), then every color and type setting as a `--timmy-*` variable. Pages style themselves
 * with the variables; nothing here touches a page's elements, and nothing is fetched from elsewhere.
 *
 * R11 round 7 (B11): the B10 block is followed by the B11 block (uiThemeCss). The Outfit file is named only when the
 * caller's font path is the companion's web fonts folder (UI_WEB_FONT_PATH, where the built web assets put it); any
 * other path (the Studio's /fonts/, which serves Monaspace Argon only) gets the face's local() sources alone, so no
 * request can 404 there. `uiFontPath` says it explicitly where a caller wants to.
 */
export function themeCss(fontPath = '/fonts/', uiFontPath: string | null = fontPath === UI_WEB_FONT_PATH ? fontPath : null): string {
  const faces = FONT_FILES.map((f) => [
    '@font-face {',
    `  font-family: "${TYPE.family}";`,
    `  font-style: ${f.style};`,
    `  font-weight: ${f.weight};`,
    '  font-display: swap;',
    `  src: ${f.local.map((n) => `local("${n}")`).join(', ')}, url("${fontPath}${f.file}") format("woff2");`,
    '}',
  ].join('\n'));
  const vars = [
    ...Object.entries(HOMEBREW).map(([name, value]) => `  --timmy-${kebab(name)}: ${value};`),
    `  --timmy-font-mono: ${TYPE.stack};`,
    ...Object.entries(TYPE.size).map(([name, px]) => `  --timmy-size-${name}: ${px}px;`),
    ...Object.entries(TYPE.weight).map(([name, w]) => `  --timmy-weight-${name}: ${w};`),
    `  --timmy-line-height: ${TYPE.lineHeight};`,
  ];
  return [`/* Timmy's shared look (src/theme/tokens.ts); DESIGN.md §10 B9. */`, ...faces, ':root {', '  color-scheme: dark;', ...vars, '}', uiThemeCss(uiFontPath)].join('\n');
}
