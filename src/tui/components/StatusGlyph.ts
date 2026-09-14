// Single source of truth for status → (glyph, color, label). Every panel and
// the rain use this map so "running" looks identical everywhere in TIMMY.
// Colours come from the law through src/tui/theme.ts — no hex here. Evidence
// states (C1b-2): sealed = checked ✓ seal · completed / running = constructed ●
// white · queued = declared ◇ white · failed = REFUSE × · idle / missing /
// created carry no evidence and stay grey-3 ◇; waiting / warn are attention ⚠.
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
  running:   { glyph: '●', color: theme.textPrimary, label: 'running' }, // constructed
  waiting:   { glyph: '⚠', color: theme.warn, label: 'waiting on you' },
  created:   { glyph: '·', color: theme.textMuted, label: 'created' }, // no evidence yet
  completed: { glyph: '●', color: theme.textPrimary, label: 'completed' }, // constructed: done is not sealed
  failed:    { glyph: '×', color: theme.refuse, label: 'failed' },
  cancelled: { glyph: '', color: theme.textMuted, label: 'cancelled' },
  sealed:    { glyph: '✓', color: theme.seal, label: 'sealed' }, // checked
  ready:     { glyph: '■', color: theme.accent, label: 'ready · installed' }, // live mark, not evidence
  missing:   { glyph: '·', color: theme.textMuted, label: 'not installed' },
  idle:      { glyph: '·', color: theme.textMuted, label: 'idle' },
  warn:      { glyph: '⚠', color: theme.warn, label: 'warning' },
  queued:    { glyph: '○', color: theme.textPrimary, label: 'queued' } // declared
};

export function statusGlyph(status: TimmyStatus): { glyph: string; color: string; label: string } {
  return STATUS_GLYPH[status];
}
