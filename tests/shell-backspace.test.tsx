// warroom-t3b1 HOTFIX: backspace/delete edit the buffer in CHAT and INSERT
// (and the refuse/note overlays); Enter sends/uses the edited buffer.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import type { Agent } from '../src/agent/core.js';
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

/**
 * R4 (H103): a FAKE agent with a key: its send records the text and answers at once (no model, no network). Before, this
 * test sent through the shell's no-op agent, and the monitor sealed a chat turn that no model ever saw (D1); a message now
 * goes only by a route, here the OpenRouter route of an agent with a key.
 */
function fakeAgent() {
  const sent: string[] = [];
  const agent = Object.assign(new EventEmitter(), {
    getModel: () => 'fake/model', openRouterModel: () => 'fake/model', conversation: { getHistory: () => [] }, totalCost: 0,
    clearHistory: () => undefined, setModel: () => undefined, setTools: () => undefined, setInstructions: () => undefined,
    useLocalChat: () => undefined, localChatRoute: () => null, lastLocalTurn: () => null, lastFallback: () => null,
    hasModelKey: () => true, isRunning: () => false, updateApiKey: () => undefined,
    send: async (text: string) => { sent.push(text); agent.emit('stream:end', 'ok'); return 'ok'; },
  });
  return { agent: agent as unknown as Agent, sent };
}

describe('backspace/delete in CHAT/INSERT', { timeout: 60000 }, () => {
  it('CHAT: backspace edits the buffer; Enter sends the edited text', async () => {
    const fake = fakeAgent();
    const view = render(React.createElement(ShellV2, { width: 120, agent: fake.agent }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('c');
    let f = await until(view, x => x.includes('SOVEREIGN CHAT'));
    view.stdin.write('hello');
    f = await until(view, x => x.includes('> hello'));
    view.stdin.write('\x7f');
    view.stdin.write('\x7f');
    f = await until(view, x => x.includes('> hel') && !x.includes('> hello'));
    view.stdin.write('\r');
    for (let i = 0; i < 150 && !readChain('runs').some(r => r.kind === 'chat'); i++) await sleep(100);
    expect(fake.sent).toEqual(['hel']); // the edited text was sent
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
