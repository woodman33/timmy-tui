import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeBalance,
  resolveBalance,
  HF_BALANCE_URL,
  type Fetcher,
  type FetchResponse,
} from '../src/forge/higgsfield/balance.js';
import {
  canSpend,
  applySpend,
  hardStop,
  makeOrchestratorState,
  type OrchestratorState,
  type PlanCaps,
} from '../src/forge/pipeline/orchestrator.js';
import { recordModeSwitch } from '../src/forge/pipeline/runner.js';
import { readLedger } from '../src/forge/ledger.js';

const HF_CREDS = 'hf-test-key-id:hf-test-secret-value';

// finally-restore env hygiene (house pattern from tests/forge-hf-client.test.ts)
async function withHfEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HF_CREDENTIALS;
  try {
    if (value === undefined) delete process.env.HF_CREDENTIALS;
    else process.env.HF_CREDENTIALS = value;
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HF_CREDENTIALS;
    else process.env.HF_CREDENTIALS = prev;
  }
}

// fetcher stub: returns the given response or throws
function fetcherReturning(res: FetchResponse): Fetcher {
  return () => Promise.resolve(res);
}
function fetcherThrowing(err: unknown): Fetcher {
  return () => Promise.reject(err);
}
const okJson = (body: unknown): FetchResponse => ({ status: 200, json: () => Promise.resolve(body) });

const CAPS: PlanCaps = { max_spend_usd: 100, max_probe_calls: 2, max_render_calls: 1 };

function state(over: Partial<OrchestratorState> = {}): OrchestratorState {
  return makeOrchestratorState('m1', over);
}

describe('probeBalance', () => {
  it('measures from {balance_usd} when creds are set and endpoint answers 200', async () => {
    await withHfEnv(HF_CREDS, async () => {
      const b = await probeBalance(fetcherReturning(okJson({ balance_usd: 50 })));
      expect(b).toEqual({ usd: 50, source: 'measured', detail: expect.stringContaining('measured') });
    });
  });

  it('requires explicit USD units instead of treating credits as dollars', async () => {
    await withHfEnv(HF_CREDS, async () => {
      expect((await probeBalance(fetcherReturning(okJson({ credits: 12.5 })))).usd).toBeNull();
      expect((await probeBalance(fetcherReturning(okJson({ balance: { usd: 7 } })))).usd).toBe(7);
    });
  });

  it('is unavailable without creds — never guesses', async () => {
    await withHfEnv(undefined, async () => {
      const b = await probeBalance(fetcherReturning(okJson({ balance_usd: 50 })));
      expect(b.usd).toBeNull();
      expect(b.source).toBe('unavailable');
    });
  });

  it('is unavailable on network error, non-2xx, or unparseable body', async () => {
    await withHfEnv(HF_CREDS, async () => {
      const net = await probeBalance(fetcherThrowing(new Error('ENOTFOUND')));
      expect(net.source).toBe('unavailable');
      expect(net.usd).toBeNull();
      const fiveHundred = await probeBalance(fetcherReturning({ status: 500, json: () => Promise.resolve({}) }));
      expect(fiveHundred.source).toBe('unavailable');
      const garbage = await probeBalance(
        fetcherReturning({ status: 200, json: () => Promise.reject(new Error('not json')) })
      );
      expect(garbage.source).toBe('unavailable');
      // no partial credit: unparseable 200 must not become a number
      expect(garbage.usd).toBeNull();
    });
  });

  it('NEVER throws', async () => {
    await withHfEnv(HF_CREDS, async () => {
      const b = await probeBalance(fetcherThrowing(new Error('anything')));
      expect(b.source).toBe('unavailable');
    });
  });
});

describe('resolveBalance', () => {
  it('prefers measured when creds present and endpoint reachable', async () => {
    await withHfEnv(HF_CREDS, async () => {
      const b = await resolveBalance(fetcherReturning(okJson({ balance_usd: 50 })), 30);
      expect(b.source).toBe('measured');
      expect(b.usd).toBe(50);
    });
  });

  it('falls back to declared when fetcher fails and a declared balance is given', async () => {
    await withHfEnv(HF_CREDS, async () => {
      const b = await resolveBalance(fetcherThrowing(new Error('down')), 30);
      expect(b.source).toBe('declared');
      expect(b.usd).toBe(30);
      expect(b.detail).toMatch(/declared/i);
    });
  });

  it('is unavailable with no creds and no declared balance', async () => {
    await withHfEnv(undefined, async () => {
      const b = await resolveBalance(fetcherReturning(okJson({ balance_usd: 50 })));
      expect(b.usd).toBeNull();
      expect(b.source).toBe('unavailable');
    });
  });

  it('creds present but endpoint 500 → declared fallback, else unavailable', async () => {
    await withHfEnv(HF_CREDS, async () => {
      const fiveHundred: Fetcher = () => Promise.resolve({ status: 500, json: () => Promise.resolve({}) });
      const withDeclared = await resolveBalance(fiveHundred, 30);
      expect(withDeclared.source).toBe('declared');
      expect(withDeclared.usd).toBe(30);
      const without = await resolveBalance(fiveHundred);
      expect(without.source).toBe('unavailable');
      expect(without.usd).toBeNull();
    });
  });

  it('evidence rule: a declared result survives JSON round-trip with source declared, never measured', async () => {
    await withHfEnv(HF_CREDS, async () => {
      const b = await resolveBalance(fetcherThrowing(new Error('down')), 30);
      expect(b.source).toBe('declared');
      const roundTripped = JSON.parse(JSON.stringify(b)) as typeof b;
      expect(roundTripped.source).toBe('declared');
      expect(roundTripped.source).not.toBe('measured');
      expect(roundTripped.usd).toBe(30);
    });
  });
});

describe('canSpend (pure)', () => {
  const bal = (usd: number | null) =>
    usd === null
      ? { usd: null, source: 'unavailable' as const, detail: 'no balance source' }
      : { usd, source: 'measured' as const, detail: 'measured' };

  it('approval mode refuses any spend with the approval reason', () => {
    const r = canSpend(state({ mode: 'approval' }), CAPS, bal(100), 1, 'probe');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/approval mode/);
  });

  it('autonomous under budget and caps passes', () => {
    const r = canSpend(state({ mode: 'autonomous' }), CAPS, bal(100), 10, 'probe');
    expect(r).toEqual({ ok: true });
  });

  it('over max_spend refuses with plan-budget reason', () => {
    const s = state({ mode: 'autonomous', spent_usd: 90 });
    const r = canSpend(s, CAPS, bal(100), 11, 'render');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/plan budget exhausted/);
  });

  it('probe cap and render cap refuse independently', () => {
    const probes = state({ mode: 'autonomous', probe_calls: 2 });
    const rp = canSpend(probes, CAPS, bal(100), 1, 'probe');
    expect(rp.ok).toBe(false);
    if (!rp.ok) expect(rp.reason).toMatch(/probe/);
    // render cap not reached → render still allowed
    expect(canSpend(probes, CAPS, bal(100), 1, 'render')).toEqual({ ok: true });
    const renders = state({ mode: 'autonomous', render_calls: 1 });
    const rr = canSpend(renders, CAPS, bal(100), 1, 'render');
    expect(rr.ok).toBe(false);
    if (!rr.ok) expect(rr.reason).toMatch(/render/);
  });

  it('balance exactly covering passes; balance short refuses AND flags hard stop', () => {
    const exact = canSpend(state({ mode: 'autonomous', spent_usd: 40 }), CAPS, bal(10), 10, 'probe');
    expect(exact).toEqual({ ok: true });
    const short = canSpend(state({ mode: 'autonomous', spent_usd: 40 }), CAPS, bal(9.99), 10, 'probe');
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.hard_stop).toBe(true);
      expect(short.reason).toMatch(/balance/);
    }
  });

  it('unavailable balance hard-stops autonomous spending', () => {
    const r = canSpend(state({ mode: 'autonomous' }), CAPS, bal(null), 10, 'probe');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hard_stop).toBe(true);
  });

  it('hard_stopped state refuses everything, even in autonomous mode', () => {
    const s = state({ mode: 'autonomous', hard_stopped: true });
    for (const kind of ['probe', 'render'] as const) {
      const r = canSpend(s, CAPS, bal(100), 1, kind);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/hard stop active/);
    }
  });

  it('hard stop takes precedence over budget reasons', () => {
    const s = state({ mode: 'autonomous', hard_stopped: true, spent_usd: 500 });
    const r = canSpend(s, CAPS, bal(0), 1, 'probe');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/hard stop active/);
  });
});

describe('canSpend estimate validation', () => {
  const bal = (usd: number | null) =>
    usd === null
      ? { usd: null, source: 'unavailable' as const, detail: 'no balance source' }
      : { usd, source: 'measured' as const, detail: 'measured' };

  it('NaN estimate is refused — and subsequent canSpend calls still enforce the guards', () => {
    const s = state({ mode: 'autonomous' });
    const poisoned = canSpend(s, CAPS, bal(100), NaN, 'probe');
    expect(poisoned.ok).toBe(false);
    if (!poisoned.ok) expect(poisoned.reason).toMatch(/non-finite or negative estimate refused/);
    // the poisoned estimate must not have leaked into any guard: a normal
    // call afterwards still enforces budget, caps, and balance
    const after = canSpend(s, CAPS, bal(100), 10, 'probe');
    expect(after).toEqual({ ok: true });
    const over = canSpend(state({ mode: 'autonomous', spent_usd: 95 }), CAPS, bal(100), 10, 'probe');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/plan budget exhausted/);
  });

  it('negative estimate is refused (no refund-shaped spend)', () => {
    const r = canSpend(state({ mode: 'autonomous' }), CAPS, bal(100), -5, 'probe');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/non-finite or negative estimate refused/);
  });

  it('zero estimate passes — free probes are real', () => {
    expect(canSpend(state({ mode: 'autonomous' }), CAPS, bal(100), 0, 'probe')).toEqual({ ok: true });
  });

  it('balance 0 with est 0 passes; est > 0 refuses with the source in the reason', () => {
    const declared = { usd: 0, source: 'declared' as const, detail: 'operator-declared' };
    expect(canSpend(state({ mode: 'autonomous' }), CAPS, declared, 0, 'render')).toEqual({ ok: true });
    const r = canSpend(state({ mode: 'autonomous' }), CAPS, declared, 0.01, 'render');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hard_stop).toBe(true);
      // the declared label survives into the refusal (mode-switch receipts
      // carry this string verbatim)
      expect(r.reason).toMatch(/declared/);
    }
  });
});

describe('applySpend / hardStop (pure)', () => {
  it('applySpend increments the right counter and adds the estimate to the spend', () => {
    const s = state({ mode: 'autonomous' });
    const after = applySpend(s, 'probe', 3.5);
    expect(after.probe_calls).toBe(1);
    expect(after.render_calls).toBe(0);
    expect(after.spent_usd).toBe(3.5);
    // purity: original untouched
    expect(s.probe_calls).toBe(0);
    expect(s.spent_usd).toBe(0);
  });

  it('applySpend throws on a hard-stopped state — the act enforces the stop', () => {
    const stopped = hardStop(state({ mode: 'autonomous', spent_usd: 12, probe_calls: 1 }));
    expect(() => applySpend(stopped, 'probe', 1)).toThrow(/autonomous mode \/ after hard stop/);
    // state untouched by the refused act
    expect(stopped.spent_usd).toBe(12);
    expect(stopped.probe_calls).toBe(1);
  });

  it('applySpend throws in approval mode even without a hard stop', () => {
    expect(() => applySpend(state({ mode: 'approval' }), 'render', 1)).toThrow(/outside autonomous mode/);
  });

  it('applySpend throws on non-finite or negative estimates (defense in depth)', () => {
    const s = state({ mode: 'autonomous' });
    expect(() => applySpend(s, 'probe', NaN)).toThrow(/non-finite or negative/);
    expect(() => applySpend(s, 'probe', -0.01)).toThrow(/non-finite or negative/);
    expect(s.spent_usd).toBe(0);
  });

  it('hardStop is idempotent: twice → still stopped, counters preserved', () => {
    const s = state({ mode: 'autonomous', spent_usd: 5, probe_calls: 2, render_calls: 1 });
    const once = hardStop(s);
    const twice = hardStop(once);
    expect(twice.hard_stopped).toBe(true);
    expect(twice.mode).toBe('approval');
    expect(twice.spent_usd).toBe(5);
    expect(twice.probe_calls).toBe(2);
    expect(twice.render_calls).toBe(1);
    // and canSpend still refuses after the second stop
    const r = canSpend(twice, CAPS, { usd: 100, source: 'measured', detail: 'd' }, 1, 'probe');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/hard stop active/);
  });

  it('hardStop flips to approval and sets the irreversible flag', () => {
    const s = state({ mode: 'autonomous' });
    const stopped = hardStop(s);
    expect(stopped.mode).toBe('approval');
    expect(stopped.hard_stopped).toBe(true);
    expect(s.mode).toBe('autonomous');
  });
});

describe('mode lifecycle with ledger records', () => {
  it('enter autonomous → spend → balance drop → hard stop → reapproval, all receipted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-orch-'));

    // operator approves the plan: enter autonomous
    const rec1 = recordModeSwitch(dir, {
      mission_id: 'm1',
      from: 'approval',
      to: 'autonomous',
      reason: 'operator approved dispatch plan',
    });
    expect(rec1.kind).toBe('orchestrator_mode');

    // spend within caps
    let s = makeOrchestratorState('m1');
    s = { ...s, mode: 'autonomous' };
    expect(canSpend(s, CAPS, { usd: 80, source: 'measured', detail: 'd' }, 10, 'probe')).toEqual({ ok: true });
    s = applySpend(s, 'probe', 10);

    // balance drops below remaining → canSpend flags hard stop
    const drop = canSpend(s, CAPS, { usd: 9, source: 'measured', detail: 'd' }, 10, 'probe');
    expect(drop.ok).toBe(false);
    if (!drop.ok) expect(drop.hard_stop).toBe(true);

    // hard stop: revert to approval, receipted
    s = hardStop(s);
    expect(s.mode).toBe('approval');
    expect(s.hard_stopped).toBe(true);
    recordModeSwitch(dir, {
      mission_id: 'm1',
      from: 'autonomous',
      to: 'approval',
      reason: 'balance below remaining budget — hard stop',
    });

    // operator reapproval: fresh state, stop flag cleared, receipted
    const fresh = { ...makeOrchestratorState('m1'), mode: 'autonomous' as const, hard_stopped: false };
    expect(fresh.hard_stopped).toBe(false);
    recordModeSwitch(dir, {
      mission_id: 'm1',
      from: 'approval',
      to: 'autonomous',
      reason: 'operator reapproved after hard stop',
    });

    const rows = readLedger(dir).filter(r => r.kind === 'orchestrator_mode');
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.to)).toEqual(['autonomous', 'approval', 'autonomous']);
    expect(rows[1].reason).toMatch(/hard stop/);
    expect(rows.every(r => r.mission_id === 'm1')).toBe(true);
  });
});

describe('HF_BALANCE_URL', () => {
  it('is a documented best-guess constant (UNVERIFIED until first live run)', () => {
    expect(HF_BALANCE_URL).toMatch(/^https:\/\/api\.higgsfield\.ai\//);
  });
});

describe('budget and balance admission regressions', () => {
  const measured = { usd: 100, source: 'measured' as const, detail: 'fixture' };
  it.each([NaN, Infinity, -1])('rejects invalid budget/state/balance numbers: %s', value => {
    const s = state({ mode: 'autonomous' });
    expect(canSpend(s, { ...CAPS, max_spend_usd: value }, measured, 1, 'probe').ok).toBe(false);
    expect(canSpend(s, { ...CAPS, max_probe_calls: value }, measured, 1, 'probe').ok).toBe(false);
    expect(canSpend({ ...s, spent_usd: value }, CAPS, measured, 1, 'probe').ok).toBe(false);
    expect(canSpend({ ...s, probe_calls: value }, CAPS, measured, 1, 'probe').ok).toBe(false);
    expect(canSpend(s, CAPS, { ...measured, usd: value }, 1, 'probe').ok).toBe(false);
    expect(() => applySpend({ ...s, spent_usd: value }, 'probe', 1)).toThrow();
  });
  it('rejects fractional call caps and unsupported call kinds', () => {
    const s = state({ mode: 'autonomous' });
    expect(canSpend(s, { ...CAPS, max_probe_calls: 1.5 }, measured, 1, 'probe').ok).toBe(false);
    expect(canSpend(s, CAPS, measured, 1, 'other' as 'probe').ok).toBe(false);
    expect(() => applySpend(s, 'other' as 'probe', 1)).toThrow();
  });
  it('subtracts prior mission spend only from the declared starting balance', () => {
    const s = state({ mode: 'autonomous', spent_usd: 40 });
    expect(canSpend(s, CAPS, { ...measured, usd: 10 }, 10, 'probe').ok).toBe(true);
    expect(canSpend(s, CAPS, { ...measured, usd: 10, source: 'declared' }, 10, 'probe').ok).toBe(false);
    expect(canSpend(s, CAPS, { ...measured, usd: 50, source: 'declared' }, 10, 'probe').ok).toBe(true);
  });
  it('refuses counter or amount overflow at the accounting boundary', () => {
    expect(() => applySpend(state({ mode: 'autonomous', probe_calls: Number.MAX_SAFE_INTEGER }), 'probe', 0)).toThrow();
    expect(() => applySpend(state({ mode: 'autonomous', spent_usd: Number.MAX_VALUE }), 'probe', Number.MAX_VALUE)).toThrow();
  });
  it.each(['', ' ', '0x10', 'Infinity'])('does not coerce ambiguous USD strings %j', async value => {
    await withHfEnv(HF_CREDS, async () => {
      expect((await probeBalance(fetcherReturning(okJson({ balance_usd: value })))).source).toBe('unavailable');
    });
  });
  it('does not retain raw credential-bearing network or parser errors', async () => {
    await withHfEnv(HF_CREDS, async () => {
      const error = new Error(`request authorization ${HF_CREDS}`);
      const results = [
        await probeBalance(fetcherThrowing(error)),
        await probeBalance(fetcherReturning({ status: 200, json: async () => { throw error; } })),
      ];
      for (const result of results) {
        expect(result.source).toBe('unavailable');
        expect(JSON.stringify(result)).not.toContain(HF_CREDS);
        expect(JSON.stringify(result)).not.toContain('hf-test-secret-value');
      }
    });
  });
});
