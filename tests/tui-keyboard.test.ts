import { describe, it, expect } from 'vitest';
import { shellOnKey, initialShell } from '../src/tui/shell-mode.js';
import { footerHintsShell, whichKeyGroupsShell } from '../src/tui/keymap.js';

describe('keyboard contract (tui-redesign-p6a3 spec §02)', () => {
  it('INSERT: digits are text, tab unchanged', () => {
    let s = initialShell();
    s = shellOnKey(s, 'i').state;
    expect(s.mode).toBe('INSERT');
    for (const d of ['2', '3', '4', '5', '6']) s = shellOnKey(s, d).state;
    expect(s.input).toBe('23456');
    expect(s.tab).toBe('HOME');
  });
  it('CHAT: digits are text; Enter sends once', () => {
    let s = initialShell();
    s = shellOnKey(s, 'c').state;
    expect(s.mode).toBe('CHAT');
    s = shellOnKey(s, '2').state;
    expect(s.input).toBe('2');
    const step = shellOnKey(s, 'Enter');
    expect(step.actions).toEqual(['chat-send']);
  });
  it('NORMAL: digit switches tab', () => {
    const s = shellOnKey(initialShell(), '3').state;
    expect(s.tab).toBe('CHAIN');
  });
  it('Enter never triggers two actions', () => {
    const step = shellOnKey(initialShell(), 'Enter');
    expect(step.actions.length).toBe(1);
  });
  it('Esc never triggers zero', () => {
    const step = shellOnKey(initialShell(), 'Esc');
    expect(step.handled).toBe(true);
    expect(step.actions.length).toBeGreaterThan(0);
  });
  it('footer + which-key render from the keymap object', () => {
    expect(footerHintsShell('NORMAL', 'HOME')).toContain('[v] verify chain');
    expect(footerHintsShell('NORMAL', 'HOME')).toContain('[?] which-key');
    const g = whichKeyGroupsShell('NORMAL', 'HOME').map(x => x.group);
    expect(g).toEqual(['NAVIGATE', 'ACT', 'MODES', 'SEAL']);
    expect(footerHintsShell('CHAT', 'RUN')).toContain('[Enter] send');
  });
});

// Fourth order, step 2 (action guidance): the keys overlay and the footer name the tab keys from the tab
// list itself. The overlay said "1-4 tab" while the monitor has six tabs and the footer said [1-6].
describe('the tab keys the monitor names', () => {
  it('match its six tabs, in the overlay and in the footer', () => {
    const navigate = whichKeyGroupsShell('NORMAL', 'HOME').find((g) => g.group === 'NAVIGATE')?.entries ?? [];
    expect({ overlay: navigate.find((e) => e.label === 'tab')?.key, footer: footerHintsShell('NORMAL', 'HOME').includes('[1-6] tab') }).toEqual({ overlay: '1-6', footer: true });
  });
});
