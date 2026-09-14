// tui-redesign-p6a3 STEP 6 + director FIX 1-4 — RUN shows RUNS (not
// connectors): running orange w/ elapsed+progress · queued dim · sealed
// phosphor w/ real duration + hash · REFUSED red w/ hash; idle connectors
// collapse to one line with [n]; LIVE shows the ticking bar when running,
// the sealed log tail + env-lock for a sealed run, and collapses to one line
// when nothing is selected; no bare hash on non-sealed rows.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { busPath } from '../src/bus/index.js';
import { armEscrow } from '../src/utils/escrow-engine.js';
import { policyPath } from '../src/harness/policy.js';
import { notesPath } from '../src/models/registry.js';

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
const bus = (kind: string, payload: Record<string, unknown>) =>
  appendFileSync(busPath(), JSON.stringify({ ts: new Date().toISOString(), kind, payload }) + '\n', 'utf8');

// picker writes touch real owner files — snapshot + restore around the suite
let policyBackup: string | null = null;
let notesBackup: string | null = null;
const snap = () => {
  policyBackup = existsSync(policyPath()) ? readFileSync(policyPath(), 'utf8') : null;
  notesBackup = existsSync(notesPath()) ? readFileSync(notesPath(), 'utf8') : null;
};
const restore = () => {
  if (policyBackup !== null) writeFileSync(policyPath(), policyBackup);
  if (notesBackup !== null) writeFileSync(notesPath(), notesBackup);
};

describe('RUN tab (spec §04, FIX 1-4)', { timeout: 60000 }, () => {
  it('run rows from bus+chain with real durations; idle line; LIVE tail; escrow verbs', async () => {
    snap();
    appendReceipt('runs', { kind: 'run', subject: 'lane.start · defold build · 38s', policy: 'auto', status: 'ok', ms: 38000 });
    appendReceipt('runs', { kind: 'run', subject: 'custody.open · tamper=BROKEN', policy: 'auto', status: 'denied' });
    bus('dispatch.created', { plan_id: 'p1', plan_hash: 'sha256_1', harness: 'houdini', status: 'stored' });
    bus('dispatch.container_started', { plan_id: 'p2', plan_hash: 'sha256_2', harness: 'rive', status: 'running' });

    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('2');
    let f = await until(view, x => x.includes('◇ RUNS'));
    expect(f).toContain('TIMMY');
    expect(f).toContain('sealed');      // defold build (receipt ok, ms=38s)
    expect(f).toContain('38s');         // FIX 2: real duration on sealed row
    expect(f).toContain('REFUSED');     // custody.open (denied)
    expect(f).toContain('queued');      // houdini (dispatch.created)
    expect(f).toContain('running');     // rive (container_started)
    expect(f).toContain('--:--');        // FIX 2: --:-- only for queued
    expect(f).toMatch(/\d+ idle · \[n\] new run/); // FIX 1: idle connectors collapse
    expect(f).toContain('▮');            // progress on the running row

    // FIX 3: select the sealed run → LIVE shows its sealed log tail + env-lock
    // (rows: 0 houdini queued · 1 rive running · 2 custody REFUSED · 3 defold sealed)
    view.stdin.write('j'); view.stdin.write('j'); view.stdin.write('j');
    f = await until(view, x => x.includes('sealed log tail'));
    expect(f).toContain('env-lock');
    expect(f).toContain('lane.start · defold build');

    // escrow pane only when armed, with [a]/[r]
    expect(f).not.toContain('ESCROW · NEEDS YOU');
    const armed = armEscrow({ plan_hash: 'sha256_abcdef0123456789', ceiling_usd: 1, qa_threshold: 0.5 });
    expect(armed.ok).toBe(true);
    f = await until(view, x => x.includes('ESCROW · NEEDS YOU'));
    expect(f).toContain('est $');
    expect(f).toContain('requested by:');
    view.stdin.write('r');
    f = await until(view, x => x.includes('REFUSE — reason required'));
    view.stdin.write('too pricey');
    view.stdin.write('\r');
    f = await until(view, x => x.includes('escrow refused'));
    expect(f).not.toContain('ESCROW · NEEDS YOU');
    view.unmount();
    restore();
  });

  it('FIX 3: with no runs the LIVE pane collapses to one line', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('2');
    const f = await until(view, x => x.includes('nothing running · [n] new run'));
    expect(f).toContain('no runs yet');
    view.unmount();
  });
});
