// warroom-t3b1: profile roundtrip, tmux war room lifecycle + activity resize,
// CHAT tab transcript, COMMAND tab commander + harness panes.
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { appendReceipt } from '../src/utils/receipts.js';
import * as warroom from '../src/harness/warroom.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 15000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f)) return f;
    if (Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

beforeEach(() => { warroom.killWar(); });

describe('warroom', () => {
  it('profile save/load roundtrip', () => {
    const p: warroom.WarProfile = {
      name: 'roundtrip-test',
      harnesses: [{ id: 'jcode', model: null, weight: 2 }, { id: 'pi', model: 'qwen/qwen3-coder', weight: 1 }],
      commander: { model: 'openrouter/auto', ws: null },
    };
    const f = warroom.saveProfile(p);
    const loaded = warroom.loadProfile('roundtrip-test');
    expect(loaded?.harnesses.length).toBe(2);
    expect(loaded?.harnesses[1].model).toBe('qwen/qwen3-coder');
    expect(f).toContain('profile.cue');
  });

  it('war room starts tmux panes; activity weight resizes', () => {
    const p: warroom.WarProfile = {
      name: 'tmux-test',
      harnesses: [{ id: 'sh:sleep 60', model: null, weight: 1 }, { id: 'sh:sleep 61', model: null, weight: 1 }],
      commander: { model: 'openrouter/auto', ws: null },
    };
    const r = warroom.startWarRoom(p);
    expect(r.ok).toBe(true);
    const panes = warroom.panes();
    expect(panes.length).toBe(2);
    const active = warroom.setActivity(p, 'sh:sleep 60', 'responding');
    const after = warroom.panes().find(x => x.name === 'sh:sleep 60');
    expect(after?.height ?? 0).toBeGreaterThanOrEqual(12);
    void active;
    expect(warroom.killWar().ok).toBe(true);
  });

  it('CHAT tab shows transcript from receipts; COMMAND tab shows commander + harness panes', async () => {
    appendReceipt('runs', {
      kind: 'chat', subject: 'chat.turn · openrouter/auto', policy: 'human-gated', status: 'ok',
      sources: [{ role: 'user', text: 'status of the war room?' }],
    });
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('5');
    let f = await until(view, x => /CHAT · SOVEREIGN/i.test(x));
    expect(f).toContain('you: status of the war room?');
    expect(f).toContain('LOG RAIN');
    view.stdin.write('\x1b'); // back to NORMAL
    view.stdin.write('6');
    // wait for the rail ROWS, not just the card title: the first COMMAND frame
    // is a reflow transient (left card still at the previous tab's width)
    f = await until(view, x => /COMMANDER ·/i.test(x) && /\s(off|idle|think|resp|REFUSED)\s+h=\s*\d+/.test(x));
    expect(f).toContain('HARNESS PANES');
    expect(f).toContain('cmdr');
    // FIX 2 (warroom fixes): the rail speaks one fixed vocabulary at fixed
    // width — off · idle · think · resp · REFUSED — and no cell ellipsizes.
    // The rail is the RIGHT column; read only that segment of each line so a
    // reflow transient in the left card can't poison the assertion.
    const rightCol = (l: string): string => {
      // right column = text between its opening border (second-to-last │)
      // and its closing border; lines without a right column pass through
      const close = l.lastIndexOf('│');
      if (close === -1) return l;
      const open = l.lastIndexOf('│', close - 1);
      return open === -1 ? l : l.slice(open + 1);
    };
    const lines = f.split('\n');
    const railStart = lines.findIndex(l => l.includes('HARNESS PANES'));
    const block = lines.slice(railStart).map(rightCol);
    const railEnd = block.findIndex((l, i) => i > 0 && l.includes('╰'));
    const rail = block.slice(0, railEnd === -1 ? block.length : railEnd + 1);
    expect(rail.join('\n')).not.toContain('…');
    const railRows = rail.filter(l => /\s(off|idle|think|resp|REFUSED)\s+h=\s*\d+/.test(l));
    expect(railRows.length).toBeGreaterThan(0);
    for (const l of railRows) {
      expect(l).toMatch(/^\s*\d \S+\s+\S+\s+(off|idle|think|resp|REFUSED)\s+h=\s*\d+\s*│?\s*$/);
    }
    view.unmount();
  });
});
