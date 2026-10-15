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

/**
 * The shared settings as CSS: the font faces (an installed Monaspace Argon first, else the copy at
 * `/fonts/`), then every color and type setting as a `--timmy-*` variable. Pages style themselves
 * with the variables; nothing here touches a page's elements, and nothing is fetched from elsewhere.
 */
export function themeCss(fontPath = '/fonts/'): string {
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
  return [`/* Timmy's shared look (src/theme/tokens.ts); DESIGN.md §10 B9. */`, ...faces, ':root {', '  color-scheme: dark;', ...vars, '}', ''].join('\n');
}
