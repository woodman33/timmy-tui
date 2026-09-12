import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, afterEach } from 'vitest';

// TEST ISOLATION (tui-redesign-p6a3 corr 1): EVERY TEST gets its own temp
// receipt store via TIMMY_STORE (honored by the store resolver), so neither
// parallel files nor sibling tests in a file contend on a shared chain, and a
// test's process.chdir cannot leak store resolution into another test.
let store = '';
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'timmy-store-'));
  mkdirSync(join(store, 'receipts'), { recursive: true });
  process.env.TIMMY_STORE = join(store, 'receipts');
});
afterEach(() => {
  delete process.env.TIMMY_STORE;
  try { rmSync(store, { recursive: true, force: true }); } catch { /* gone */ }
});
