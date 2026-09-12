import { shellKeys, type ShellMode, type ShellTab } from './keymap.js';

// TUI REDESIGN (spec §02) — the mode OWNS the keymap. One key, one meaning per
// mode; the mode is always on screen (footer badge). Pure reducer so the
// keyboard contract is testable without a TTY.
export interface ShellState {
  mode: ShellMode;
  tab: ShellTab;
  input: string;
  overlay: 'whichkey' | 'qr' | 'sealconfirm' | 'refuse' | 'newrun' | 'harnesspick' | 'note' | 'status' | 'cmdharness' | 'cmdmodel' | null;
  filter: string;
  selected: number;
  /** sub-picker cursor (new-run fleet list, harness sub-picker) */
  pick: number;
}
export const initialShell = (): ShellState => ({ mode: 'NORMAL', tab: 'HOME', input: '', overlay: null, filter: '', selected: 0, pick: 0 });

export const TABS: ShellTab[] = ['HOME', 'RUN', 'CHAIN', 'LIBRARY', 'CHAT', 'COMMAND'];

export interface ShellStep { state: ShellState; handled: boolean; actions: string[] }

export function shellOnKey(s: ShellState, key: string): ShellStep {
  const actions: string[] = [];
  const st: ShellState = { ...s };
  // overlay consumes first: a key inside which-key executes + closes
  if (st.mode === 'NORMAL' && st.overlay === 'whichkey') {
    st.overlay = null;
    if (key === 'escape' || key === 'Esc') return { state: st, handled: true, actions: ['close-whichkey'] };
    const inner = shellOnKey({ ...st, overlay: null }, key);
    return { state: inner.state, handled: true, actions: ['close-whichkey', ...inner.actions] };
  }
  // QR overlay: any key closes (it is a read-only chip)
  if (st.mode === 'NORMAL' && st.overlay === 'qr') {
    st.overlay = null;
    return { state: st, handled: true, actions: ['close-overlay'] };
  }
  // seal confirm: Enter/s seals, Esc cancels, anything else is swallowed
  if (st.mode === 'NORMAL' && st.overlay === 'sealconfirm') {
    st.overlay = null;
    if (key === 'escape' || key === 'Esc') return { state: st, handled: true, actions: ['seal-cancel'] };
    if (key === 'return' || key === 'Enter' || key === 's') return { state: st, handled: true, actions: ['seal-now'] };
    return { state: st, handled: true, actions: [] };
  }
  // refuse overlay (§02: r refuses with a reason): the reason travels with the
  // action so the effect can cancel the escrow with it; Esc abandons.
  if (st.mode === 'NORMAL' && st.overlay === 'refuse') {
    if (key === 'escape' || key === 'Esc') { st.overlay = null; st.input = ''; return { state: st, handled: true, actions: ['refuse-cancel'] }; }
    if (key === 'return' || key === 'Enter') {
      const reason = st.input.trim();
      st.overlay = null; st.input = '';
      if (!reason) return { state: st, handled: true, actions: ['refuse-needs-reason'] };
      return { state: st, handled: true, actions: [`escrow-refuse::${reason}`] };
    }
    if (key === '\x7f' || key === '\b' || key === 'backspace' || key === 'delete') { st.input = st.input.slice(0, -1); return { state: st, handled: true, actions: [] }; }
    if (key.length >= 1 && !/[\x00-\x1f\x7f]/.test(key)) st.input += key;
    return { state: st, handled: true, actions: [] };
  }
  // note overlay (LIBRARY [n]): free text, saved against the selected model
  if (st.mode === 'NORMAL' && st.overlay === 'note') {
    if (key === 'escape' || key === 'Esc') { st.overlay = null; st.input = ''; return { state: st, handled: true, actions: ['note-cancel'] }; }
    if (key === 'return' || key === 'Enter') {
      const text = st.input.trim();
      st.overlay = null; st.input = '';
      return { state: st, handled: true, actions: [`note-save::${text}`] };
    }
    if (key === '\x7f' || key === '\b' || key === 'backspace' || key === 'delete') { st.input = st.input.slice(0, -1); return { state: st, handled: true, actions: [] }; }
    if (key.length >= 1 && !/[\x00-\x1f\x7f]/.test(key)) st.input += key;
    return { state: st, handled: true, actions: [] };
  }
  // sub-pickers (new-run fleet, harness): j/k move, Enter chooses, Esc backs out
  if (st.mode === 'NORMAL' && (st.overlay === 'newrun' || st.overlay === 'harnesspick' || st.overlay === 'cmdharness' || st.overlay === 'cmdmodel')) {
    const which = st.overlay === 'newrun' ? 'new-run-now'
      : st.overlay === 'harnesspick' ? 'harness-set-now'
        : st.overlay === 'cmdharness' ? 'cmd-harness-set' : 'cmd-model-set';
    if (key === 'escape' || key === 'Esc') { st.overlay = null; return { state: st, handled: true, actions: ['close-overlay'] }; }
    if (key === 'j') { st.pick += 1; return { state: st, handled: true, actions: [] }; }
    if (key === 'k') { st.pick = Math.max(0, st.pick - 1); return { state: st, handled: true, actions: [] }; }
    if (key === 'return' || key === 'Enter') { st.overlay = null; return { state: st, handled: true, actions: [which] }; }
    return { state: st, handled: true, actions: [] };
  }
  if (st.mode === 'INSERT' || st.mode === 'CHAT') {
    if (key === 'escape' || key === 'Esc') { st.mode = 'NORMAL'; st.input = ''; return { state: st, handled: true, actions: ['leave-mode'] }; }
    if (key === 'tab' || key === 'Tab') { st.tab = TABS[(TABS.indexOf(st.tab) + 1) % TABS.length]; return { state: st, handled: true, actions: ['next-pane'] }; }
    if (st.mode === 'CHAT' && (key === 'return' || key === 'Enter')) { actions.push('chat-send'); st.input = ''; return { state: st, handled: true, actions }; }
    // HOTFIX (warroom-t3b1): backspace/delete edit the buffer in CHAT/INSERT
    if (key === '\x7f' || key === '\b' || key === 'backspace' || key === 'delete') {
      st.input = st.input.slice(0, -1);
      if (st.tab === 'CHAIN' || st.tab === 'LIBRARY') st.filter = st.input;
      return { state: st, handled: true, actions };
    }
    // printable text arrives one key at a time from a TTY but as a whole
    // chunk on paste/programmatic stdin — both are text in INSERT/CHAT.
    if (key.length >= 1 && !/[\x00-\x1f\x7f]/.test(key)) st.input += key;
    // Telescope-style: on list tabs the INSERT buffer IS the live filter
    // (spec §05); Esc leaves the mode, a second Esc at NORMAL clears it.
    if (st.tab === 'CHAIN' || st.tab === 'LIBRARY') st.filter = st.input;
    return { state: st, handled: true, actions };
  }
  // NORMAL
  if (/^[1-6]$/.test(key)) {
    if (st.tab === 'COMMAND') return { state: st, handled: true, actions: [`focus-pane:${Number(key) - 1}`] };
    st.tab = TABS[Number(key) - 1]; return { state: st, handled: true, actions: [`tab:${st.tab}`] };
  }
  // COMMAND center verbs (warroom-t3b1)
  if (st.tab === 'COMMAND') {
    if (key === 'm') return { state: st, handled: true, actions: ['cmd-model'] };
    if (key === 'b') return { state: st, handled: true, actions: ['cmd-body'] };
    if (key === 'f') return { state: st, handled: true, actions: ['cmd-fusion'] };
    if (key === 'g') return { state: st, handled: true, actions: ['cmd-generate'] };
    if (key === 't') return { state: st, handled: true, actions: ['cmd-toggle'] };
    if (key === 'M') { st.overlay = 'cmdharness'; st.pick = 0; return { state: st, handled: true, actions: ['cmd-harness-model'] }; }
    if (key === 'K') return { state: st, handled: true, actions: ['cmd-handoff'] };
    if (key === 'X') return { state: st, handled: true, actions: ['cmd-kill'] };
  }
  // LIBRARY [f]: yazi/broot tmux pane over skills/projects folders
  if (key === 'f' && st.tab === 'LIBRARY') return { state: st, handled: true, actions: ['open-files'] };
  // CHAT tab: printable drops straight into CHAT mode
  if (st.tab === 'CHAT' && key.length === 1 && !/[\x00-\x1f\x7f]/.test(key)) { st.mode = 'CHAT'; st.input = key; return { state: st, handled: true, actions: ['chat-mode'] }; }
  if (key === 'i' || key === ':') { st.mode = 'INSERT'; st.input = ''; return { state: st, handled: true, actions: ['enter-insert'] }; }
  if (key === 'c') { st.mode = 'CHAT'; st.input = ''; return { state: st, handled: true, actions: ['enter-chat'] }; }
  if (key === '?') { st.overlay = 'whichkey'; return { state: st, handled: true, actions: ['open-whichkey'] }; }
  if (key === 'escape' || key === 'Esc') {
    // Esc always has an effect: close overlay > clear filter > clear selection
    if (st.overlay) { st.overlay = null; actions.push('close-overlay'); }
    else if (st.filter) { st.filter = ''; actions.push('clear-filter'); }
    else { st.selected = 0; actions.push('clear-selection'); }
    return { state: st, handled: true, actions };
  }
  if (key === 'j') { st.selected += 1; return { state: st, handled: true, actions: ['move-down'] }; }
  if (key === 'k') { st.selected = Math.max(0, st.selected - 1); return { state: st, handled: true, actions: ['move-up'] }; }
  if (key === 'tab' || key === 'Tab') { st.tab = TABS[(TABS.indexOf(st.tab) + 1) % TABS.length]; return { state: st, handled: true, actions: ['next-pane'] }; }
  if (key === '/') { st.mode = 'INSERT'; st.input = ''; actions.push('filter'); return { state: st, handled: true, actions }; }
  if (key === 'return' || key === 'Enter') { actions.push('open'); return { state: st, handled: true, actions }; }
  // HOME/CHAIN verbs (spec §02 single-meaning keys): the reducer names the
  // effect; ShellV2 performs it (verify flash, QR overlay, doctor spawn, seal).
  if (key === 'v') return { state: st, handled: true, actions: ['verify-now'] };
  if (key === 'q' && st.tab === 'HOME') { st.overlay = 'qr'; return { state: st, handled: true, actions: ['open-qr'] }; }
  if (key === 'd' && st.tab === 'HOME') return { state: st, handled: true, actions: ['doctor-now'] };
  if (key === 's') { st.overlay = 'sealconfirm'; return { state: st, handled: true, actions: ['open-sealconfirm'] }; }
  // CHAIN detail actions (spec §05 O4): cross-link + copy operate on the
  // selected receipt; ShellV2 resolves it from the filtered list.
  if (key === 'o' && st.tab === 'CHAIN') return { state: st, handled: true, actions: ['open-crosslink'] };
  if (key === 'y' && st.tab === 'CHAIN') return { state: st, handled: true, actions: ['copy-hash'] };
  // RUN escrow verbs (spec §04): approve locks; refuse demands a reason.
  if (key === 'a' && st.tab === 'RUN') return { state: st, handled: true, actions: ['escrow-approve'] };
  if (key === 'r' && st.tab === 'RUN') { st.overlay = 'refuse'; st.input = ''; return { state: st, handled: true, actions: ['open-refuse'] }; }
  // RUN [n]: new run picks from the fleet (FIX 1 idle line)
  if (key === 'n' && st.tab === 'RUN') { st.overlay = 'newrun'; st.pick = 0; return { state: st, handled: true, actions: ['open-newrun'] }; }
  // LIBRARY picker verbs (spec §06): harness sub-picker, pin, note
  if (key === 'h' && st.tab === 'LIBRARY') { st.overlay = 'harnesspick'; st.pick = 0; return { state: st, handled: true, actions: ['open-harnesspick'] }; }
  if (key === 'p' && st.tab === 'LIBRARY') return { state: st, handled: true, actions: ['pin-now'] };
  if (key === 'n' && st.tab === 'LIBRARY') { st.overlay = 'note'; st.input = ''; return { state: st, handled: true, actions: ['open-note'] }; }
  // any other single key present in the active keymap = its action
  const entry = shellKeys(st.mode, st.tab).find(k => k.key === key);
  if (entry) { actions.push(`act:${entry.label}`); return { state: st, handled: true, actions }; }
  return { state: st, handled: false, actions };
}
