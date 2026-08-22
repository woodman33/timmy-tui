import type { Mode } from './router.js';

export interface KeyHint { key: string; label: string }

// ─── ONE GRAMMAR, EVERY VIEW (v1.0.5-fix: aligned to the 4-view shell) ───
// Only keys the shell actually implements are listed here. Legacy verb
// letters (n/k/g/v/t/o/…) live on inside the mounted panels that still
// implement them (Slate/Gens/Logs) and are documented per-panel, not
// globally.
//   1-4 views · Tab/⇧Tab switch card · ↵ input/select · Esc back/blur
//   ^K model palette · ? keymap · q quit

export const GLOBAL_KEYS: KeyHint[] = [
  { key: '1-4', label: 'views' },
  { key: 'Tab/⇧Tab', label: 'switch card' },
  { key: '↵', label: 'input / select' },
  { key: 'Esc', label: 'back / blur input' },
  { key: '^K', label: 'model palette' },
  { key: '?', label: 'keys' },
  { key: 'q', label: 'quit' }
];

export const MODE_KEYS: Record<Mode, KeyHint[]> = {
  brief: [
    { key: '→', label: 'model rail' },
    { key: 'd', label: 'model detail' },
    { key: 'o', label: 'open model page' },
    { key: '1-3', label: 'home buttons (empty chat)' }
  ],
  lanes: [
    { key: 't/↵', label: 'type task' },
    { key: 'g', label: 'approve' },
    { key: 'n', label: 'spawn' },
    { key: 'k', label: 'kill' },
    { key: 'o', label: 'attach' },
    { key: 'y', label: 'yank attach cmd' },
    { key: 'v', label: 'tmux tabs' },
    { key: 'G', label: 'tiled grid' }
  ],
  gens: [
    { key: 'n', label: 'new prompt' },
    { key: ']/[', label: 'option (while typing)' },
    { key: 'y', label: 'yank gen line' },
    { key: '1/2', label: 'failed → reroute / note' }
  ],
  slate: [
    { key: 'n', label: 'new project' },
    { key: 'P', label: 'publish site' },
    { key: 'c', label: 'TIMMY Clip job' },
    { key: 'v', label: 'canvas pane' },
    { key: 'o', label: 'site pane' }
  ],
  clip: [
    { key: 'n', label: 'new job' },
    { key: 'r', label: 'run headless + seal' },
    { key: 'o', label: 'runbook in $EDITOR' },
    { key: 'y', label: 'yank ffmpeg lines' }
  ],
  browse: [
    { key: 'n', label: 'new pane' },
    { key: 't', label: 'type into pane' },
    { key: 'k', label: 'kill pane' }
  ],
  logs: [
    { key: '←→/1-5', label: 'file' },
    { key: 'h', label: 'human/raw' },
    { key: 'f', label: 'follow' },
    { key: 'r', label: 'refresh' }
  ],
  files: [
    { key: 'p', label: 'preview' },
    { key: 'v', label: 'carbonyl' },
    { key: 'o', label: '$EDITOR' },
    { key: 's', label: 'sync logs' },
    { key: 'e', label: 'training export' },
    { key: 'i', label: 'reindex' }
  ]
};

// Two reserved description-bar lines per tab, generated from the same table
// so the bar, the ? overlay and the panel hint bar can never disagree.
export function submenuLines(mode: Mode): [string, string] {
  const verbs = MODE_KEYS[mode].map(h => `${h.key} ${h.label}`);
  const half = Math.ceil(verbs.length / 2);
  return [verbs.slice(0, half).join(' · ') || '—', verbs.slice(half).join(' · ') || ''];
}
