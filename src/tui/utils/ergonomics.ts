// v1.0.2 radical de-clutter — pure viewport arithmetic + chrome decisions.
// Everything the shell renders derives from these, so the budget caps are
// testable without a terminal attached.
import { theme } from '../theme.js';
import { readCatalogCache } from '../../models/catalog.js';
import { modelPrice } from '../../agent/model-price.js';
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
  { key: '4', label: 'ESCROW', sub: 'ledger + receipts' },
  { key: '5', label: 'LANES', sub: 'harness lanes + dispatch rail' },
  { key: '6', label: 'LIBRARY', sub: 'browse + files' },
  { key: '7', label: 'PROJECTS', sub: 'projects + clips' },
  { key: '8', label: 'SYSTEM', sub: 'options / setup / models (Tab)' },
  { key: '9', label: 'REVIEW', sub: 'code review + dashboard' }
] as const;

export const FOOTER_KEYS = '[Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit';

export const footerKeysLine = (width: number): string => {
  const compact = '[Tab] Card  [1-9] View  [^K] Palette  [q] Quit';
  return truncateVisible(width >= 66 ? FOOTER_KEYS : compact, width);
};

/**
 * model switching lives strictly in the ^K palette (v1.0.2). R11 Phase 2 (H169, item b): the palette's models were five paid
 * names typed into the code; now they are read from the OpenRouter catalog this computer keeps (src/models/catalog.ts: fetched
 * by `timmy models --refresh`, else the one shipped with Timmy): the free ones, up to eight, each labelled with its price words.
 * No catalog: an empty list (the palette offers no model it cannot name).
 */
export function paletteModels(env: Record<string, string | undefined> = process.env): Array<{ id: string; label: string }> {
  try {
    const kept = readCatalogCache(env);
    if (!kept) return [];
    return kept.cache.models.map((m) => m.id).filter((id) => modelPrice(id, kept.cache).free === true).sort().slice(0, 8)
      .map((id) => ({ id, label: `${id} · free (OpenRouter catalog of ${kept.cache.fetchedAt.slice(0, 10)})` }));
  } catch { return []; }
}
export const PALETTE_MODELS = paletteModels();

/** Active Pane Invariant: focused card theme.lineFocus + ◆; others theme.line. */
export function chromeFor(active: boolean): { border: string; title: string; glyph: string; bold: boolean } {
  return active
    ? { border: theme.accent, title: theme.accent, glyph: '◆', bold: true }
    : { border: theme.line, title: theme.textSecondary, glyph: '◇', bold: false };
}

/** pane counts per view — Tab cycles focus within these bounds */
export const VIEW_PANES = [1, 2, 2, 2, 2, 2, 2, 3, 2];
