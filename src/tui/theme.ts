import chalk from 'chalk';

// One instrument, one voice (docs/UI-VISION.md): Tokyo Night tokens ONLY.
// magenta = identity/DAG nodes ONLY · cyan = active focus/live ·
// green = verified receipts/seals · yellow = warning/queued/fuzz ·
// red = fail/denied · orange = signal/cost · blue = info/chrome.
// No hex values outside this file.
export const theme = {
  brand: '#bb9af7',             // TIMMY identity: logo, active nav, DAG nodes
  brandDim: '#9d7cd8',          // brand muted (inactive identity chrome)
  focus: '#7dcfff',             // active focus · live/streaming
  surfaceBase: '#1a1b26',       // Tokyo Night field
  surfaceRaised: '#1f2337',     // 1 step up
  surfaceOverlay: '#24283b',    // 2 steps up
  textPrimary: '#c0caf5',       // bright neutral
  textSecondary: '#a9b1d6',     // mid
  textTertiary: '#565f89',      // dim
  borderDefault: '#3b4261',     // hairline, barely-there
  borderMuted: '#292e42',       // inactive pane chrome (v1.0.1 ergonomic overhaul)
  accent: '#ff9e64',            // ORANGE — the signal color (cost, singular)
  accentDim: '#565f89',         // muted chrome
  success: '#9ece6a',           // verified receipts · seals · ok
  warning: '#e0af68',           // warning · queued · fuzz
  error: '#f7768e',             // fail · denied
  info: '#7aa2f7',              // cool blue (info/links)
  userColor: '#ff9e64',         // warm orange for user text
  assistantColor: '#c0caf5',    // neutral for assistant
  toolColor: '#a9b1d6',         // greyed tool output
  reasoningColor: '#565f89',    // very dim mono
  // v1.0.4 cyber-command tokens (design refs tui3/tui6/tui7)
  bgDeep: '#16161e',            // palette/overlay field (solid, never transparent)
  neonCyan: '#00f0ff',          // neon accent (header brand block)
  cardFocus: '#2ac3de',         // focused card border
  emerald: '#73daca',           // status pills (docker/comfy ready)
  neonEmerald: '#00ff9d',       // passport seal green
};

// TrueColor vs ANSI-256: Ink/chalk down-convert these hex tokens automatically
// when COLORTERM!=truecolor (bare SSH, CI). Exposed so the status bar can say
// which mode is live; no separate 256 palette to keep in sync.
export const colorLevel: number = chalk.level;

// Named color wrappers for quick use
export const colors = {
  primary: (t: string) => chalk.hex(theme.textPrimary)(t),
  secondary: (t: string) => chalk.hex(theme.textSecondary)(t),
  accent: (t: string) => chalk.hex(theme.accent)(t),
  accentDim: (t: string) => chalk.hex(theme.accentDim)(t),
  success: (t: string) => chalk.hex(theme.success)(t),
  error: (t: string) => chalk.hex(theme.error)(t),
  warning: (t: string) => chalk.hex(theme.warning)(t),
  user: (t: string) => chalk.hex(theme.userColor)(t),
  assistant: (t: string) => chalk.hex(theme.assistantColor)(t),
  tool: (t: string) => chalk.hex(theme.toolColor)(t),
  reasoning: (t: string) => chalk.hex(theme.reasoningColor).italic(t),
  border: (t: string) => chalk.hex(theme.borderDefault)(t),
  bg: (t: string) => chalk.bgHex(theme.surfaceRaised)(t),
};
