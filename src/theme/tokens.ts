/**
 * Timmy's shared look (round R1, DESIGN.md §10 B9): one place for the colors and the type that every
 * surface reads, so a new screen inherits them. The default is Homebrew-inspired: a black ground with
 * charcoal surfaces, readable off-white text, Homebrew green for prompts, selection and primary
 * actions, and a few restrained accents for status and navigation. Green is not proof: every outcome
 * keeps its word (verified, failed, needs setup), so color alone never says what happened.
 *
 * The terminal palette (src/term/palettes.ts, TIMMY_HOMEBREW), the terminal theme files and the browser
 * pages (themeCss) are all built from these values. Pure data and string building: no imports at run
 * time, so Node and the browser pages can both use it. The canvas's artwork colors are tldraw's and the
 * operator's, never these.
 */
import type { TerminalPalette } from '../term/palettes.js';

/** The green of macOS Terminal's Homebrew profile (its text color). */
export const HOMEBREW_GREEN = '#28FE14';

/** The browser surfaces' colors (and the terminal palette's defaults). */
export const HOMEBREW = {
  /** The page and the terminal: black. */
  ground: '#000000',
  /** Panels and cards: charcoal. */
  surface: '#121212',
  /** Menus, inputs and hovered rows on a panel. */
  raised: '#1C1C1C',
  /** Hairlines that only separate. */
  line: '#333333',
  /** Borders that mark a control (3:1 on every ground). */
  lineStrong: '#6B6B6B',
  /** Most text: off-white. */
  text: '#E8E6E1',
  /** Labels and hints. */
  textSecondary: '#BDBDB8',
  /** Prompts, the selection, and primary actions. */
  accent: HOMEBREW_GREEN,
  /** Text on an accent fill. */
  accentInk: '#000000',
  /** The selection's ground. */
  accentSoft: '#14451B',
  /** Waiting for you, estimates, cost. */
  attention: '#E5B550',
  /** Failed, refused, destructive. */
  failure: '#FF5F56',
  /** Made by a model, or sent over the network (B4). */
  ai: '#B58CFF',
  /** Links and navigation. */
  link: '#6CA8FF',
} as const;

/** Timmy Homebrew as a terminal palette: the ground, the text, and the 16 slots Timmy's roles use. */
export const HOMEBREW_TERMINAL: TerminalPalette = {
  name: 'Timmy Homebrew',
  background: HOMEBREW.ground,
  foreground: HOMEBREW.text,
  cursor: '#38FE27',
  selection: HOMEBREW.accentSoft,
  black: '#1C1C1C', red: HOMEBREW.failure, green: HOMEBREW.accent, yellow: HOMEBREW.attention,
  blue: HOMEBREW.link, magenta: HOMEBREW.ai, cyan: '#5CC8D6', white: HOMEBREW.textSecondary,
  brightBlack: HOMEBREW.lineStrong, brightRed: '#FF8A80', brightGreen: '#7DFF6E', brightYellow: '#FFD479',
  brightBlue: '#9CC3FF', brightMagenta: '#D0B3FF', brightCyan: '#8EE3EC', brightWhite: '#FFFFFF',
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
