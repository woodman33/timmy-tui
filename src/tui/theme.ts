import chalk from 'chalk';

// ═══════════════════════════════════════════════════════════════════════════
// "Clearinghouse" — the ONE palette. Governed by DESIGN.md §2.
// No raw hex anywhere outside this file (rg-enforced, DESIGN.md §9.1).
//
// Semantic law (§2.3) — each accent has ONE meaning, meanings never overlap:
//   accent  = interaction (focus, active tab, selected row, links, live)
//   seal    = cryptographic truth ONLY (sealed receipts, verified chains,
//             settled escrow, passed QA) — never decorates anything else
//   warn    = warning · queued · pending approval · cost figures
//   danger  = fail · denied · slashed · destructive confirm
//   ident   = View 2 DAG identity nodes ONLY — nowhere else in the app
// ═══════════════════════════════════════════════════════════════════════════

const clearinghouse = {
  // §2.1 ground & surfaces (cool navy family)
  ground: '#070C14',        // terminal field / deepest background
  surface: '#0B1322',       // card interior fill (when bg is drawn)
  surfaceRaised: '#111C30', // overlays: palette, modals, pills
  line: '#20304C',          // ALL default borders — hairline, barely-there
  lineFocus: '#37D2FF',     // focused card border only (= accent)

  // §2.2 text (three steps, no more)
  textPrimary: '#D9E4F5',   // values, content, anything the user reads
  textSecondary: '#8CA0BE', // labels, subtitles, key hints
  textMuted: '#46587A',     // chrome, timestamps, disabled, empty-state prose

  // §2.3 semantic accents
  accent: '#37D2FF',        // interaction
  seal: '#3BE08C',          // cryptographic truth ONLY
  warn: '#F0B454',          // warning · queued · cost
  danger: '#FF5D75',        // fail · denied · slashed
  ident: '#B49AF5',         // View 2 DAG nodes ONLY
};

// Phase E: the deprecated-alias bridge is gone. `theme` exports exactly the
// §2 token set — tests/design-contract.test.ts locks this surface.
export const theme = { ...clearinghouse };

// TrueColor vs ANSI-256: Ink/chalk down-convert these hex tokens automatically
// when COLORTERM!=truecolor (bare SSH, CI). Exposed so the status bar can say
// which mode is live; no separate 256 palette to keep in sync.
export const colorLevel: number = chalk.level;

// Named color wrappers for quick use (registers per DESIGN.md §2.4)
export const colors = {
  primary: (t: string) => chalk.hex(theme.textPrimary)(t),
  secondary: (t: string) => chalk.hex(theme.textSecondary)(t),
  muted: (t: string) => chalk.hex(theme.textMuted)(t),
  accent: (t: string) => chalk.hex(theme.accent)(t),
  seal: (t: string) => chalk.hex(theme.seal).bold(t), // Proof register: the only bold green
  warn: (t: string) => chalk.hex(theme.warn)(t),
  danger: (t: string) => chalk.hex(theme.danger)(t),
  border: (t: string) => chalk.hex(theme.line)(t),
  bg: (t: string) => chalk.bgHex(theme.surface)(t),
};
