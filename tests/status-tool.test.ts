// status-r1e4: orders status table, session hands detection, order log verb.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { parseOrders, statusReport, renderBoard } from '../src/utils/status.js';
import { detectSession } from '../src/utils/session.js';
import { appendReceipt } from '../src/utils/receipts.js';

let dir = '';
let log = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-status-'));
  log = join(dir, 'orders.log');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('status tool', () => {
  it('states: done / blocked-on-will / in-flight / missing-cite', () => {
    const rec = appendReceipt('runs', { kind: 'seal', subject: 'fixture.done · x', policy: 'auto', status: 'ok' });
    writeFileSync(log, [
      `ORD-1 | 2026-09-07T00:00:00Z | claude | done order | receipt ${rec.hash}`,
      `ORD-2 | 2026-09-07T00:01:00Z | claude | deploy prod (owner's word) | preview ok`,
      `ORD-3 | 2026-09-07T00:02:00Z | qwen | started order |`,
      `ORD-4 | 2026-09-07T00:03:00Z | claude | cites ghost | receipt sha256_deadbeefdeadbeef`,
    ].join('\n') + '\n');
    const rows = parseOrders(log);
    expect(rows[0].state).toBe('done');
    expect(rows[0].lastReceipt).toContain(rec.hash.slice(7, 15));
    expect(rows[1].state).toBe('blocked-on-will');
    expect(rows[2].state).toBe('in-flight');
    expect(rows[3].state).toBe('in-flight');
    expect(rows[3].lastReceipt).toContain('missing');
    const rep = statusReport(log);
    expect(rep.blockedOnWill.map(r => r.id)).toEqual(['ORD-2']);
    expect(renderBoard(rep)).toContain('BLOCKED ON WILL');
  });

  it('detectSession reads the CLI session, never hand-typed', () => {
    process.env.CLAUDECODE = '1';
    expect(detectSession().actor).toBe('claude-code');
    delete process.env.CLAUDECODE;
    process.env.QWEN_CODE = '1';
    expect(detectSession().actor).toBe('qwen-cli');
    expect(detectSession().short).toBe('qwen');
    delete process.env.QWEN_CODE;
    // under a live CLI session the parent chain names the CLI; 'will' only
    // appears when no CLI marker exists anywhere in the chain
    const s3 = detectSession();
    expect(['claude', 'qwen', 'will']).toContain(s3.short);
    expect(typeof s3.hands).toBe('string');
    expect(s3.hands.length).toBeGreaterThan(0);
  });

  it('order log appends actor+hands from the session', () => {
    const log2 = join(dir, 'orders2.log');
    execSync(`npx tsx src/cli.ts order log ORD-T1 --title fixture --evidence none`, {
      cwd: process.cwd(),
      env: { ...process.env, TIMMY_ORDERS_LOG: log2, QWEN_CODE: '1', QWEN_MODEL: 'test-model' },
    });
    const line = readFileSync(log2, 'utf8').trim();
    expect(line).toContain('actor=qwen-cli');
    expect(line).toContain('hands=test-model');
  });
});
