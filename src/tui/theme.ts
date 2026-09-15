import chalk from 'chalk';
import visualLaw from '../../lanes/visual/tokens.json' with { type: 'json' };

// ═══════════════════════════════════════════════════════════════════════════
// THE LAW — lanes/visual/tokens.json (ORDER ui-v3-t9r2, C1a).
// Every colour the TUI paints is read from that file at import time through
// ONE binding table; nothing under src/tui may carry a hex, a named ink
// colour, a chalk colour method or a raw escape. tests/design-contract.test.ts
// fails on drift, on an unbound token, and on any colour chosen elsewhere.
//
//   black      the void — every ground
//   white      structure — text, rails, borders, and THE THING YOU ARE LOOKING
//              AT (focus, active tab, selected row): interaction is white, not
//              a hue
//   grey-1/2/3 derived from black/white — raised surfaces · structure lines ·
//              muted chrome (dim = absent, off, unverified)
//   seal       SEAL green — receipts, hash links, verified, gate pass. Never
//              decoration.
//   refuse     REFUSE red — governor refusal, gate fail. Only that.
//   predict    PREDICT amber — sealed-before-build predictions, stale rims
//   generated  GENERATED violet — model-made, measured:false
//
// The token names ~1,100 call sites already use are kept and bound to law
// VALUES below. `accent` (was cyan: interaction) and `warn` (was amber:
// attention) are both white now: the law admits neither an interaction hue nor
// an attention hue, and amber means PREDICT only (C1b-1 re-pointed every warn
// site; not installed and paused went to grey-3; queued is a DECLARED mark,
// white and plain, since C1b-2).
// `ident` had zero consumers and is gone.
// ═══════════════════════════════════════════════════════════════════════════

export type LawColor = keyof typeof visualLaw.color;
const hex = (k: LawColor): string => visualLaw.color[k].value;

export { visualLaw };

/** The binding table — the only place a theme token meets a law colour. */
export const BINDINGS = {
  // ground & surfaces — the void and what is raised from it
  ground: 'black',
  surface: 'black',
  surfaceRaised: 'grey-1',
  line: 'grey-2',
  lineFocus: 'white',
  // text ramp — white reads; grey-3 is every label, hint, timestamp and
  // off-state; hierarchy comes from case, weight and spacing (C1c)
  textPrimary: 'white',
  textSecondary: 'grey-3',
  textMuted: 'grey-3',
  // semantic accents. `warn` is ATTENTION (running, next, needs you, blocked,
  // warning): the law has no attention hue, so it is white structure — bold or
  // a glyph carries the emphasis; PREDICT amber is reserved for forecasts.
  accent: 'white',
  seal: 'seal',
  warn: 'white',
  danger: 'refuse',
  // the law's own names, for new code
  void: 'black',
  structure: 'white',
  grey1: 'grey-1',
  grey2: 'grey-2',
  grey3: 'grey-3',
  sealDim: 'seal-dim',
  refuse: 'refuse',
  predict: 'predict',
  generated: 'generated',
} as const satisfies Record<string, LawColor>;

export type ThemeToken = keyof typeof BINDINGS;

export const theme: Record<ThemeToken, string> = Object.fromEntries(
  (Object.entries(BINDINGS) as [ThemeToken, LawColor][]).map(([token, lawName]) => [token, hex(lawName)]),
) as Record<ThemeToken, string>;

// TrueColor vs ANSI-256: Ink/chalk down-convert these hex tokens automatically
// when COLORTERM!=truecolor (bare SSH, CI). Exposed so the status bar can say
// which mode is live; no separate 256 palette to keep in sync.
export const colorLevel: number = chalk.level;

// Named colour wrappers for string output (chalk); the only chalk colour calls
// allowed under src/tui go through these.
export const colors = {
  primary: (t: string) => chalk.hex(theme.textPrimary)(t),
  secondary: (t: string) => chalk.hex(theme.textSecondary)(t),
  muted: (t: string) => chalk.hex(theme.textMuted)(t),
  accent: (t: string) => chalk.hex(theme.accent)(t),
  seal: (t: string) => chalk.hex(theme.seal).bold(t), // the only bold green
  warn: (t: string) => chalk.hex(theme.warn)(t),
  danger: (t: string) => chalk.hex(theme.danger)(t),
  refuse: (t: string) => chalk.hex(theme.refuse)(t),
  predict: (t: string) => chalk.hex(theme.predict)(t),
  generated: (t: string) => chalk.hex(theme.generated)(t),
  border: (t: string) => chalk.hex(theme.line)(t),
  bg: (t: string) => chalk.bgHex(theme.surface)(t),
};
