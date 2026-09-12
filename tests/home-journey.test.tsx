// tui-redesign-p6a3 STEP 4 — HOME journey ladder contract (spec §00/§03):
// cold store → the next unsealed step (doctor) is the only ▶ row and nothing
// is done; 7/7 → every step shows receipt hash + one fact, no ▶ row, and the
// journey-complete line appears; refused receipts surface as REFUSED rows.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { armEscrow } from '../src/utils/escrow-engine.js';

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

describe('HOME journey ladder (spec §00/§03)', { timeout: 60000 }, () => {
  it('cold store: ▶ doctor is the next step; nothing done', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    const f = await until(view, x => x.includes('YOUR JOURNEY'));
    expect(f).toContain('▶ doctor');
    expect(f).not.toContain('✓ doctor');
    expect(f).not.toContain('✓ seal');
    expect(f).toMatch(/docker (on|off)/); // capability glyph, never red text
    view.unmount();
  });

  it('7/7: every step shows hash + fact; no ▶ row; journey complete line', async () => {
    appendReceipt('runs', { kind: 'run', subject: 'doctor.pass · 12 checks ok', policy: 'auto', status: 'ok' });
    appendReceipt('runs', { kind: 'env.lock', subject: 'connect.opencode · /opt/bin/opencode', policy: 'human-gated', status: 'ok' });
    appendReceipt('runs', { kind: 'run', subject: 'lane.start · defold build · 38s', policy: 'auto', status: 'ok' });
    appendReceipt('runs', { kind: 'verify', subject: 'chain.verify · ok', policy: 'auto', status: 'ok' });
    appendReceipt('runs', { kind: 'run', subject: 'companion.pair · sse client · port 4310', policy: 'auto', status: 'ok' });
    appendReceipt('runs', { kind: 'seal', subject: 'owner.first · anything', policy: 'human-gated', status: 'ok' });
    const view = render(React.createElement(ShellV2, { width: 120 }));
    const f = await until(view, x => x.includes('journey complete'));
    for (const v of ['doctor', 'connect', 'run', 'receipt', 'verify', 'companion', 'seal']) {
      expect(f).toContain(`✓ ${v}`);
    }
    expect(f).not.toContain('▶');
    expect(f).toContain('prev'); // receipt row fact: prev → this
    // FIX C: 7/7 + no pending escrow + chain ✓ + bus ● ⇒ header says so, dim
    const f2 = await until(view, x => /nothing needs\s+you/.test(x));
    expect(f2).toMatch(/nothing needs\s+you/);
    view.unmount();
  });

  it('FIX B: a failed doctor seals but the row is never ✓', async () => {
    appendReceipt('runs', { kind: 'run', subject: 'doctor.fail · 5 ok · 1 skipped · 1 failed (docker daemon)', policy: 'auto', status: 'failed' });
    const view = render(React.createElement(ShellV2, { width: 120 }));
    const f = await until(view, x => x.includes('1 failed')); // post-refresh frame
    expect(f).toContain('▶ doctor');
    expect(f).not.toContain('✓ doctor');
    view.unmount();
  });

  it('FIX C: pending escrow is the one orange; journey next dims', async () => {
    const armed = armEscrow({ plan_hash: 'sha256_deadbeef', ceiling_usd: 2, qa_threshold: 0.5 });
    expect(armed.ok).toBe(true);
    const view = render(React.createElement(ShellV2, { width: 120 }));
    const f = await until(view, x => x.includes('▶ escrow'));
    expect(f).toContain('▶ escrow');
    expect(f).not.toContain('▶ doctor'); // escrow owns the single orange slot
    expect(f).not.toContain('nothing needs you');
    view.unmount();
  });

  it('refused receipts surface as REFUSED activity rows', async () => {
    appendReceipt('runs', { kind: 'run', subject: 'custody.open · tamper=BROKEN', policy: 'auto', status: 'denied' });
    const view = render(React.createElement(ShellV2, { width: 120 }));
    const f = await until(view, x => x.includes('REFUSED'));
    expect(f).toContain('REFUSED');
    view.unmount();
  });
});
