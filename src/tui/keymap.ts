// Mode union kept local after router.tsx was quarantined to src/tui/attic/
// (p10 audit: legacy 8-mode shell superseded by the 9-view dispatcher shell).
export type Mode = 'brief' | 'lanes' | 'gens' | 'slate' | 'clip' | 'browse' | 'logs' | 'files';

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

// ─── REDESIGN v2 (ORDER tui-redesign-p6a3, spec §02/§07) ───────────────────
// The v2 shell keymap: one entry per (mode, tab). Footer hints and the
// which-key overlay render FROM this object; a key absent here does not exist.
export type ShellMode = 'NORMAL' | 'INSERT' | 'CHAT';
export type ShellTab = 'HOME' | 'RUN' | 'CHAIN' | 'LIBRARY' | 'CHAT' | 'COMMAND';
export type KeyGroup = 'NAVIGATE' | 'ACT' | 'MODES' | 'SEAL';
export interface ShellKey { key: string; label: string; group: KeyGroup }

const nav = (key: string, label: string): ShellKey => ({ key, label, group: 'NAVIGATE' });
const act = (key: string, label: string): ShellKey => ({ key, label, group: 'ACT' });
const mod = (key: string, label: string): ShellKey => ({ key, label, group: 'MODES' });
const seal = (key: string, label: string): ShellKey => ({ key, label, group: 'SEAL' });

const NAV: ShellKey[] = [nav('1-4', 'tab'), nav('j/k', 'move'), nav('Enter', 'open'), nav('Tab', 'next pane'), nav('/', 'filter')];
const MODES: ShellKey[] = [mod('i', 'insert (cmd line)'), mod(':', 'command'), mod('c', 'chat (sovereign)'), mod('Esc', 'back / leave mode'), mod('?', 'which-key')];
const SEAL: ShellKey[] = [seal('s', 'seal…'), seal('S', 'seal review note')];

export const KEYMAP_SHELL: Record<`${ShellMode}:${ShellTab}`, ShellKey[]> = {
  'NORMAL:HOME': [...NAV, act('v', 'verify chain'), act('q', 'companion QR'), act('d', 'run doctor'), ...MODES, ...SEAL],
  'NORMAL:RUN': [...NAV, act('a', 'approve'), act('r', 'refuse (needs reason)'), act('n', 'new run'), ...MODES, ...SEAL],
  'NORMAL:CHAIN': [...NAV, act('v', 'verify from here'), act('o', 'open in companion'), act('y', 'copy hash'), ...MODES, ...SEAL],
  'NORMAL:LIBRARY': [...NAV, act('h', 'set for harness'), act('p', 'pin'), act('n', 'edit note'), ...MODES, ...SEAL],
  'INSERT:HOME': [mod('Esc', 'leave insert'), nav('Tab', 'next pane')],
  'INSERT:RUN': [mod('Esc', 'leave insert'), nav('Tab', 'next pane')],
  'INSERT:CHAIN': [mod('Esc', 'leave insert'), nav('Tab', 'next pane')],
  'INSERT:LIBRARY': [mod('Esc', 'leave insert'), nav('Tab', 'next pane')],
  'CHAT:HOME': [mod('Enter', 'send'), mod('Esc', 'leave chat'), nav('Tab', 'next pane')],
  'NORMAL:CHAT': [mod('Enter', 'send'), mod('Esc', 'back'), nav('Tab', 'next pane'), act('s', 'seal')],
  'NORMAL:COMMAND': [nav('1-6', 'focus harness'), act('m', 'model'), act('M', 'harness model'), act('K', 'handoff'), act('X', 'kill'), act('t', 'toggle'), act('b', 'body'), act('f', 'fusion'), act('g', 'generate')],
  'INSERT:CHAT': [mod('Esc', 'leave insert'), nav('Tab', 'next pane')],
  'INSERT:COMMAND': [mod('Esc', 'leave insert'), nav('Tab', 'next pane')],
  'CHAT:CHAT': [mod('Enter', 'send'), mod('Esc', 'leave chat')],
  'CHAT:COMMAND': [mod('Enter', 'send'), mod('Esc', 'leave chat')],
  'CHAT:RUN': [mod('Enter', 'send'), mod('Esc', 'leave chat'), nav('Tab', 'next pane')],
  'CHAT:CHAIN': [mod('Enter', 'send'), mod('Esc', 'leave chat'), nav('Tab', 'next pane')],
  'CHAT:LIBRARY': [mod('Enter', 'send'), mod('Esc', 'leave chat'), nav('Tab', 'next pane')],
};

export const shellKeys = (mode: ShellMode, tab: ShellTab): ShellKey[] => KEYMAP_SHELL[`${mode}:${tab}`];
export const footerHintsShell = (mode: ShellMode, tab: ShellTab): string =>
  shellKeys(mode, tab).map(k => `[${k.key}] ${k.label}`).join('  ');
// SPEC §02 — the footer is ONE line; the full keymap lives in which-key (?).
// This is the curated short set per tab, not a second source of truth: every
// key named here exists in KEYMAP_SHELL for the same (mode, tab).
const FOOTER_ACTS: Record<ShellTab, string> = {
  HOME: '[v] verify  [q] QR  [s] seal',
  RUN: '[a] approve  [r] refuse  [s] seal',
  CHAIN: '[v] verify  [o] open  [y] copy  [s] seal',
  LIBRARY: '[h] harness  [p] pin  [n] note  [f] files  [s] seal',
  CHAT: '[Esc] leave  [s] seal',
  COMMAND: '[m] model  [M] harness-model  [K] handoff  [X] kill  [t] toggle  [b] body  [f] fusion  [g] gen',
};
export const footerHintsShellShort = (mode: ShellMode, tab: ShellTab): string =>
  mode === 'NORMAL'
    ? tab === 'CHAT'
      // FIX 3: on CHAT, Enter means send — one hint, from the keymap
      ? `[1-6] tab  [Enter] send  ${FOOTER_ACTS[tab]}  [?] keys`
      : `[1-6] tab  [Enter] open  ${FOOTER_ACTS[tab]}  [c] chat  [?] keys`
    : footerHintsShell(mode, tab);
export const whichKeyGroupsShell = (mode: ShellMode, tab: ShellTab): { group: KeyGroup; entries: ShellKey[] }[] => {
  const order: KeyGroup[] = ['NAVIGATE', 'ACT', 'MODES', 'SEAL'];
  const ks = shellKeys(mode, tab);
  return order.map(g => ({ group: g, entries: ks.filter(k => k.group === g) })).filter(g => g.entries.length > 0);
};
