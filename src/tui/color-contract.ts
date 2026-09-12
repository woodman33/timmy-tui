// TUI REDESIGN (spec §08) — the color contract is a GATE, not a style guide.
// phosphor = the chain agrees · orange = a human is here/needed · red = refused
// ONLY · dim = absent/off/unverified · white = the thing you're looking at.
export type Token = 'seal' | 'warn' | 'danger' | 'dim' | 'white';

export function statusColor(status: string): Token {
  const s = status.toLowerCase();
  if (['ok', 'sealed', 'verified', 'connected', 'live', 'passed', 'promoted'].includes(s)) return 'seal';
  if (['running', 'needs-you', 'next', 'insert', 'chat', 'filter', 'queued-human'].includes(s)) return 'warn';
  if (['failed', 'denied', 'refused', 'tamper', 'broken'].includes(s)) return 'danger';
  return 'dim'; // absent, off, unconfigured, unverified, secondary
}

export interface Fixture {
  name: string;
  rows: { status: string; tab: 'HOME' | 'RUN' | 'CHAIN' | 'LIBRARY' }[];
  // FIX C addendum (director): on HOME the orange count is exact, not just
  // ≤1 — 7/7 journey + no pending escrow ⇒ 0 ("nothing needs you"); a pending
  // escrow or a next unsealed step ⇒ exactly 1.
  expectOrange?: number;
}

// Assert the contract over a set of fixture rows: red only on refused/failed,
// orange <=1 outside RUN, phosphor only on chain-confirmed statuses.
export function contractViolations(fx: Fixture): string[] {
  const v: string[] = [];
  for (const r of fx.rows) {
    const t = statusColor(r.status);
    if (t === 'danger' && !['failed', 'denied', 'refused', 'tamper', 'broken'].includes(r.status.toLowerCase())) {
      v.push(`${fx.name}: red on non-refusal status '${r.status}'`);
    }
    if (t === 'seal' && !['ok', 'sealed', 'verified', 'connected', 'live', 'passed', 'promoted'].includes(r.status.toLowerCase())) {
      v.push(`${fx.name}: phosphor on non-chain-confirmed status '${r.status}'`);
    }
  }
  const orange = fx.rows.filter(r => statusColor(r.status) === 'warn').length;
  const outsideRun = fx.rows.filter(r => r.tab !== 'RUN' && statusColor(r.status) === 'warn').length;
  if (outsideRun > 1) v.push(`${fx.name}: ${outsideRun} orange elements outside RUN (max 1)`);
  if (fx.expectOrange !== undefined && orange !== fx.expectOrange) {
    v.push(`${fx.name}: ${orange} orange elements, expected exactly ${fx.expectOrange}`);
  }
  return v;
}

// Negative-control analyzer for raw terminal captures (pre-hotfix view4):
// red spent on valid receipts / off-states is a contract violation.
export function captureViolations(text: string): string[] {
  const v: string[] = [];
  const chainOk = /\[VERIFIED\]|chain ok/i.test(text);
  const failRows = (text.match(/\[FAIL\]/g) ?? []).length;
  if (chainOk && failRows > 0) {
    v.push(`capture: ${failRows} red [FAIL] rows while chain reports verified (red on valid receipts)`);
  }
  if (/DOCKER:\s*DOWN|COMFY:\s*DOWN/i.test(text)) {
    v.push('capture: off-state (DOCKER: DOWN) presented as danger; off is dim, not red');
  }
  return v;
}
