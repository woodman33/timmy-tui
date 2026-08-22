// v1.0.2 radical de-clutter — pure viewport arithmetic + chrome decisions.
// Everything the shell renders derives from these, so the budget caps are
// testable without a terminal attached.
import { theme } from '../theme.js';
import { truncateVisible } from './text.js';

export const HEADER_ROWS = 1; // strict 1-line status bar
export const FOOTER_ROWS = 1; // strict 1-line keymap

/** Hard layout budget: header 1, footer 1, main gets the rest. */
export function layoutBudget(rows: number): { header: number; footer: number; main: number } {
  const main = Math.max(3, rows - HEADER_ROWS - FOOTER_ROWS);
  return { header: HEADER_ROWS, footer: FOOTER_ROWS, main };
}

export const VIEWS = [
  { key: '1', label: 'COMMAND', sub: 'clean conversation' },
  { key: '2', label: 'MISSION', sub: 'DAG + capsules' },
  { key: '3', label: 'TELEMETRY', sub: 'logs + rain' },
  { key: '4', label: 'ESCROW', sub: 'ledger + receipts' }
] as const;

export const FOOTER_KEYS = '[1-4] Views  [^K] Palette  [Tab] Switch Pane  [q] Quit';

export const footerKeysLine = (width: number): string => {
  const compact = '[1-4] Views  [^K] Palette  [Tab] Pane  [q] Quit';
  return truncateVisible(width >= 54 ? FOOTER_KEYS : compact, width);
};

/** model switching lives strictly in the ^K palette (v1.0.2) */
export const PALETTE_MODELS = [
  { id: 'anthropic/claude-opus-4.7', label: 'Claude 4.7 Opus · reasoning' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5 · general' },
  { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash · fast' },
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6 · long-context' },
  { id: 'qwen/qwen-2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder · open weights' }
];

/** Active Pane Invariant (v1.0.4): focused card #2ac3de + ◆; others muted. */
export function chromeFor(active: boolean): { border: string; title: string; glyph: string; bold: boolean } {
  return active
    ? { border: theme.cardFocus, title: theme.focus, glyph: '◆', bold: true }
    : { border: theme.borderMuted, title: theme.brandDim, glyph: '◇', bold: false };
}

/** pane counts per view — Tab cycles focus within these bounds */
export const VIEW_PANES = [1, 2, 2, 2];
