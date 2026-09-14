import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ReceiptOpenContext } from '../src/tui/components/ReceiptDetail.js';
import { ReceiptDetail } from '../src/tui/components/ReceiptDetail.js';
import { EscrowReceiptsView } from '../src/tui/components/EscrowReceiptsView.js';

const H1 = 'sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const H2 = 'sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const H3 = 'sha256_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

// Sealed receipts carry NO status:'ok' field (they carry kind/policy). The C1
// bug treated anything !== 'ok' as [FAIL]. A verified chain must render [OK].
vi.mock('../src/utils/receipts.js', () => ({
  readChain: vi.fn(() => [
    { hash: H1, subject: 'seal.one', kind: 'seal', policy: 'auto' },
    { hash: H2, subject: 'seal.two', kind: 'seal', policy: 'auto' },
    { hash: H3, subject: 'seal.three', kind: 'seal', policy: 'auto' },
  ]),
  verifyChain: vi.fn(() => ({ ok: true, count: 3 })),
}));

describe('C1 — receipt chain color semantics (ui.audit 3f6b191b6)', () => {
  it('verified chain renders phosphor [OK] and ZERO red [FAIL] cells', async () => {
    const { lastFrame } = render(<EscrowReceiptsView paneFocus={1} width={100} height={24} />);
    await new Promise(r => setTimeout(r, 60));
    const out = lastFrame() ?? '';
    expect(out).toContain('[OK]');
    expect(out).not.toContain('[FAIL]');
    expect(out).toContain('[VERIFIED]');
  });

  it('unverified chain renders dim [—], not red', async () => {
    const mod = await import('../src/utils/receipts.js');
    vi.mocked(mod.verifyChain).mockReturnValueOnce({ ok: false, count: 3, brokenAt: H2 } as any);
    const { lastFrame } = render(<EscrowReceiptsView paneFocus={1} width={100} height={24} />);
    await new Promise(r => setTimeout(r, 60));
    const out = lastFrame() ?? '';
    expect(out).toContain('[—]');
  });
});

describe('C2 — select + Enter opens receipt detail (ui.audit 3f6b191b6)', () => {
  it('Enter on a chain row opens detail showing hash and prev → this; Esc returns', async () => {
    function Harness() {
      const [h, setH] = useState<string | null>(null);
      return (
        <ReceiptOpenContext.Provider value={(x: string) => setH(x)}>
          <EscrowReceiptsView paneFocus={1} width={100} height={24} />
          {h && <ReceiptDetail hash={h} />}
        </ReceiptOpenContext.Provider>
      );
    }
    const { lastFrame, stdin } = render(<Harness />);
    await new Promise(r => setTimeout(r, 60));
    stdin.write('\r'); // Enter on selected (newest) row
    await new Promise(r => setTimeout(r, 60));
    const out = lastFrame() ?? '';
    expect(out).toContain('RECEIPT DETAIL');
    expect(out).toContain(H3.slice(7, 15));
    expect(out).toMatch(/prev .* → this /);
  });
});
