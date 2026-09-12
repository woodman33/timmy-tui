// tui-redesign-p6a3 STEP 5 — CHAIN per spec §05: Telescope-style / filter over
// any field, fixed detail pane in schema order (prev_hash → hash, kind,
// policy, ts, via, sources/env_lock, actions), VERIFY strip that glows ONLY
// after a real verify (which seals), refusals red only.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { appendFileSync } from 'fs';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { busPath } from '../src/bus/index.js';

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

describe('CHAIN tab (spec §05)', { timeout: 60000 }, () => {
  it('list + fixed detail pane + dim VERIFY strip; [v] glows and seals', async () => {
    appendReceipt('runs', { kind: 'run', subject: 'custody.commit · contents_hash=9f3a7c1e', policy: 'auto', status: 'ok' });
    appendReceipt('runs', { kind: 'run', subject: 'lane.start · defold build', policy: 'auto', status: 'ok' });
    appendReceipt('runs', { kind: 'run', subject: 'custody.open · tamper=BROKEN', policy: 'auto', status: 'denied' });
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('3');
    let f = await until(view, x => x.includes('RECEIPTS'));
    expect(f).toContain('DETAIL');
    expect(f).toContain('prev_hash');
    expect(f).toContain('kind');
    expect(f).toContain('policy');
    expect(f).toContain('sources');
    expect(f).toContain('[o] open');
    expect(f).toContain('— not verified · press [v]'); // dim until a real verify
    expect(f).toContain('FAIL');                        // refusal row present

    view.stdin.write('v'); // real verify: seals + glows
    f = await until(view, x => x.includes('✓ chain ok'));
    expect(f).toContain('✓ chain ok');
    expect(f).toContain('epochs');
    const verifies = readChain('runs').filter(r => r.kind === 'verify');
    expect(verifies.length).toBeGreaterThan(0);

    // Telescope filter: matches any field value, not just subject
    view.stdin.write('/');
    view.stdin.write('tamper');
    f = await until(view, x => /\/ tamper · 1\//.test(x));
    expect(f).toMatch(/\/ tamper · 1\//);
    expect(f).toContain('tamper=BROKEN');
    expect(f).not.toContain('defold build');
    view.unmount();
  });

  const ROW = /^(OK|FAIL|—)\s+[0-9a-f]{8} /;
  it('FIX 1+3: column budget holds at 120 and 80; no glyph touches the border; hash prefix 8', async () => {
    appendReceipt('runs', { kind: 'run', subject: 'custody.commit · contents_hash=9f3a7c1e', policy: 'auto', status: 'ok' });
    for (const width of [120, 80]) {
      const view = render(React.createElement(ShellV2, { width }));
      await until(view, x => x.includes('YOUR JOURNEY'));
      view.stdin.write('3');
      const f = await until(view, x => x.includes('RECEIPTS'));
      const limit = width === 120 ? 72 : 78; // gutter 2 before the rail border
      const colw = width === 120 ? 74 : 80;  // left column; at 120 the frame fuses panes
      const rows = f.split('\n').filter(l => ROW.test(l)).map(l => l.slice(0, colw));
      expect(rows.length).toBeGreaterThan(0);
      for (const ln of rows) {
        expect(ln.trimEnd().length, `row over budget at ${width}: ${ln}`).toBeLessThanOrEqual(limit);
        expect(ln, `row touches border at ${width}`).not.toContain('│');
        expect(ln, `hash prefix not 8 at ${width}`).toMatch(/^(OK|FAIL|—)\s+[0-9a-f]{8} /);
      }
      view.unmount();
    }
  });

  it('FIX 2: hashless bus echoes never render as receipts', async () => {
    appendReceipt('runs', { kind: 'run', subject: 'real.receipt · present', policy: 'auto', status: 'ok' });
    appendFileSync(busPath(), JSON.stringify({ ts: new Date().toISOString(), kind: 'receipt.sealed', payload: { subject: 'GHOST echo · not a receipt' } }) + '\n', 'utf8');
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('3');
    const f = await until(view, x => x.includes('RECEIPTS'));
    expect(f).toContain('real.receipt');
    expect(f).not.toContain('GHOST');
    view.unmount();
  });

  it('FIX 4: footer fits by construction at 120 and 80; tokens never split', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    let f = await until(view, x => x.includes('YOUR JOURNEY'));
    let footer = f.split('\n').filter(l => l.includes('NORMAL')).pop() ?? '';
    expect(footer.length).toBeLessThanOrEqual(120);
    expect(footer).toContain('[?] keys'); // full short set fits at 120
    view.unmount();
    const v80 = render(React.createElement(ShellV2, { width: 80 }));
    f = await until(v80, x => x.includes('YOUR JOURNEY'));
    footer = f.split('\n').filter(l => l.includes('NORMAL')).pop() ?? '';
    expect(footer.length).toBeLessThanOrEqual(80);
    expect(footer).toContain('[1-6] tab');      // leftmost tokens kept whole
    expect(footer).not.toContain('[?] keys');   // dropped from the right
    expect(f.split('\n').filter(l => l.includes('NORMAL')).length).toBe(1); // one line, never wrapped
    v80.unmount();
  });
});
