// Single source of truth for status → (glyph, color, label). Every panel and
// the rain use this map so "running" looks identical everywhere in TIMMY.
// Colours come from the law through src/tui/theme.ts — no hex here. Under the
// law: seal green only for sealed, REFUSE red only for failed, white for
// running / waiting / warning (attention), grey-3 for queued / idle / missing.
import { theme } from '../theme.js';

export type TimmyStatus =
  | 'running'
  | 'waiting'
  | 'created'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'sealed'
  | 'ready'
  | 'missing'
  | 'idle'
  | 'warn'
  | 'queued';

export const STATUS_GLYPH: Record<TimmyStatus, { glyph: string; color: string; label: string }> = {
  running:   { glyph: '●', color: theme.warn, label: 'running' },
  waiting:   { glyph: '⚠', color: theme.warn, label: 'waiting on you' },
  created:   { glyph: '◇', color: theme.textMuted, label: 'created' },
  completed: { glyph: '✓', color: theme.textPrimary, label: 'completed' }, // done is not sealed
  failed:    { glyph: '×', color: theme.danger, label: 'failed' },
  cancelled: { glyph: '', color: theme.textMuted, label: 'cancelled' },
  sealed:    { glyph: '●', color: theme.seal, label: 'sealed' },
  ready:     { glyph: '●', color: theme.accent, label: 'ready · installed' },
  missing:   { glyph: '◇', color: theme.textMuted, label: 'not installed' },
  idle:      { glyph: '◇', color: theme.textMuted, label: 'idle' },
  warn:      { glyph: '⚠', color: theme.warn, label: 'warning' },
  queued:    { glyph: '●', color: theme.textMuted, label: 'queued' }
};

export function statusGlyph(status: TimmyStatus): { glyph: string; color: string; label: string } {
  return STATUS_GLYPH[status];
}
