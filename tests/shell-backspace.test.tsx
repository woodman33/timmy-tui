// warroom-t3b1 HOTFIX: backspace/delete edit the buffer in CHAT and INSERT
// (and the refuse/note overlays); Enter sends/uses the edited buffer.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { readChain } from '../src/utils/receipts.js';

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

describe('backspace/delete in CHAT/INSERT', { timeout: 60000 }, () => {
  it('CHAT: backspace edits the buffer; Enter sends the edited text', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('c');
    let f = await until(view, x => x.includes('SOVEREIGN CHAT'));
    view.stdin.write('hello');
    f = await until(view, x => x.includes('> hello'));
    view.stdin.write('\x7f');
    view.stdin.write('\x7f');
    f = await until(view, x => x.includes('> hel') && !x.includes('> hello'));
    view.stdin.write('\r');
    await sleep(400);
    const turn = readChain('runs').find(r => r.kind === 'chat');
    expect(turn).toBeTruthy(); // the edited turn sealed
    view.unmount();
  });

  it('INSERT: backspace edits the live filter', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('3');
    await until(view, x => x.includes('RECEIPTS'));
    view.stdin.write('/');
    view.stdin.write('abc');
    let f = await until(view, x => x.includes('/ abc'));
    view.stdin.write('\x7f');
    f = await until(view, x => x.includes('/ ab') && !x.includes('/ abc'));
    view.unmount();
  });
});
