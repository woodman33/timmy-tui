// R4 (H98): the monitor's top line says "chat: no model key · /setup", and Timmy Studio is /studio in the REPL. Typed in
// the monitor's chat, /setup and /studio are answered in words (where the setup asks; how Timmy Studio opens), and neither
// goes to a model: no agent starts for them. The real ShellV2, rendered by Ink.
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ShellV2 } from '../src/tui/components/ShellV2.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 15000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f) || Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

describe('the monitor\'s chat answers /setup and /studio in words (R4 H98)', () => {
  for (const [typed, words] of [['/studio', 'Timmy Studio: in a terminal, run timmy and type /studio'], ['/setup', 'Setup: leave the monitor (Ctrl+C) and run timmy init']] as const) {
    it(`${typed}: said, and no model is asked`, async () => {
      const view = render(React.createElement(ShellV2, { width: 200, config: { apiKey: '', model: 'test/model', instructions: '', maxSteps: 1, maxCost: 1 } }));
      await until(view, (f) => f.includes('YOUR JOURNEY'));
      expect((view.lastFrame() ?? '').split('\n')[0]).toContain('chat: no model key · /setup');
      view.stdin.write('c');
      await until(view, (f) => f.includes('SOVEREIGN CHAT'));
      view.stdin.write(typed);
      await sleep(100);
      view.stdin.write('\r');
      const f = await until(view, (x) => x.includes(words));
      expect(f).toContain(words);
      expect(f).not.toContain('sovereign chat warming');
      view.unmount();
    });
  }
});
