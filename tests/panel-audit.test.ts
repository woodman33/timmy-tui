// p10 feature audit — the mount audit runs under tsx (the live app's
// resolver; vitest's vite resolver cannot load mcporter's SDK path). This
// test shells out and asserts every panel RENDERED (no CRASHED).
import { describe, it, expect } from 'vitest';
import { runAsync } from './helpers/run-async.js';

describe('panel mount audit', () => {
  it('every panel mounts without crashing', async () => {
    // Awaited, not execSync: the audit takes 9-15 s and a synchronous run holds the worker's event loop all that time,
    // which vitest's worker RPC and its own test timeout both need (R4 H31). A non-zero exit still fails here, as execSync threw.
    const run = await runAsync('npx', ['tsx', 'scripts/audit-panels.tsx'], { timeout: 180000 });
    expect(run.status, run.stderr).toBe(0);
    const out = run.stdout;
    const line = out.split('\n').find(l => l.startsWith('PANEL_AUDIT'));
    expect(line).toBeTruthy();
    const results = JSON.parse(line!.slice('PANEL_AUDIT '.length)) as Record<string, string>;
    // ChatPanel(legacy) is quarantined in src/tui/attic — audit mounts it from there
    const crashed = Object.entries(results).filter(([, v]) => v.startsWith('CRASHED'));
    expect(crashed).toEqual([]);
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(19);
  }, 200000);
});
