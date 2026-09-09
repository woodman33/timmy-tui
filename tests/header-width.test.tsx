// warroom-t3b1 FIX 1: header width budget at 120 and 80 with the 6-tab shell.
// brand never wraps; tabs collapse to "n" + active label when width demands;
// no "…" anywhere in the header; header occupies at most two lines.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShellV2 } from '../src/tui/components/ShellV2.js';

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
const headerLines = (f: string): string[] => {
  const lines = f.split('\n');
  const rule = lines.findIndex(l => /^─+$/.test(l.trim()));
  return lines.slice(0, rule === -1 ? 2 : rule);
};

describe('header width budget (6-tab fixture)', { timeout: 60000 }, () => {
  for (const width of [120, 80]) {
    it(`header fits at ${width}: brand intact, no ellipsis, ≤2 lines, tabs collapsed when demanded`, async () => {
      const view = render(React.createElement(ShellV2, { width }));
      const f = await until(view, x => x.includes('YOUR JOURNEY') || x.includes('TIMMY'));
      const hdr = headerLines(f);
      expect(hdr.length).toBeLessThanOrEqual(2);
      const joined = hdr.join('\n');
      expect(joined).toContain('TIMMY');          // brand never wraps/truncates
      expect(joined).not.toContain('…');          // no ellipsis in any header cell
      // tab labels: either all full labels fit, or collapsed form (digits +
      // active label only) — never mid-word cuts
      const labels = ['HOME', 'RUN', 'CHAIN', 'LIBRARY', 'CHAT', 'COMMAND'];
      const full = labels.every((l, i) => new RegExp(`${i + 1} ${l}(\\s|$)`).test(joined));
      const active = labels.findIndex(l => new RegExp(`${labels.indexOf(l) + 1} ${l}(\\s|$)`).test(joined));
      const collapsed = labels.every((l, i) =>
        i === active
          ? new RegExp(`${i + 1} ${l}(\\s|$)`).test(joined)
          : new RegExp(`(^|\\s)${i + 1}(\\s|$)`).test(joined)
            && !joined.includes(`${i + 1} ${l.slice(0, 4)}`)
            && !new RegExp(`(^|\\s)${l}(\\s|$)`).test(joined));
      expect(full || collapsed).toBe(true);
      if (width === 80) expect(collapsed).toBe(true); // 80 demands the collapsed form
      view.unmount();
    });
  }
});
