// tui-redesign-p6a3 FIX A — compact 80x24 contract: the ladder keeps every
// row (orange doctor included) and STATUS keeps its dot line. The tmux TTY
// capture at 80x24 drops each card's first child row (ink log-update quirk,
// not reproducible in ink's own frame nor at 120x32) — this test is the
// measurable truth the capture cannot be.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { appendReceipt } from '../src/utils/receipts.js';

process.env.TIMMY_TELEMETRY_URL = 'off';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 20000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f)) return f;
    if (Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

describe('HOME compact 80x24 (FIX A)', { timeout: 60000 }, () => {
  it('keeps the orange doctor row and the STATUS dot line', async () => {
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    appendReceipt('runs', { kind: 'run', subject: 'doctor.fail · 5 ok · 2 skipped · 1 failed (docker daemon)', policy: 'auto', status: 'failed' });
    const view = render(React.createElement(ShellV2, { width: 80 }));
    const f = await until(view, x => x.includes('required check failed')); // post-refresh
    expect(f).toContain('▶ doctor');
    expect(f).toContain('fleet');           // STATUS dot line present
    expect(f).not.toContain('seven steps'); // compact drops purpose lines
    view.unmount();
  });
});
