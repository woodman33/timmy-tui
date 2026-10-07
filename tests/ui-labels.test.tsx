// Fourth order, step 2 (semantic color plus text labels): a color or a mark never carries a meaning alone.
// Found in Terminal on the Mac (row 52): the MODELS table had no header, so `1M $3/$15 T·R $0.00 edge ◉—`
// was unlabeled, and the status marks (○ ● ✓ ◉ ◌ ×) were named nowhere on screen.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShellV2 } from '../src/tui/components/ShellV2.js';

process.env.TIMMY_TELEMETRY_URL = 'off';
Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 20000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f) || Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('labels beside colors and marks', { timeout: 60000 }, () => {
  it('the MODELS table names its columns, fit among them', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, (x) => x.includes('YOUR JOURNEY'));
    view.stdin.write('4');
    const f = strip(await until(view, (x) => x.includes('◇ MODELS')));
    view.unmount();
    expect(f).toMatch(/│ {3}model {16}ctx {3}\$in\/\$out {3}caps {6}spend {2}node {3}fit/);
  });
  it('the keys overlay names each status mark in words, and on LIBRARY what caps and fit mean', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, (x) => x.includes('YOUR JOURNEY'));
    view.stdin.write('?');
    const home = strip(await until(view, (x) => x.includes('KEYS ·')));
    view.stdin.write('\x1b');
    await sleep(100);
    view.stdin.write('4');
    await until(view, (x) => x.includes('◇ MODELS'));
    view.stdin.write('?');
    const library = strip(await until(view, (x) => x.includes('KEYS ·')));
    view.unmount();
    expect(home).toContain('marks  ○ declared  ● built  ✓ checked  ◉ made by a model  ◌ stale  × refused  ■ on  □ off');
    expect(library).toContain('models  caps: T tools · V vision · R reasoning  fit: ◉ a forecast, not a measurement');
    expect(home).not.toContain('models  caps:');
  });
});
