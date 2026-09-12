import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { verifyChain, readChain, withLockDir } from '../src/utils/receipts.js';

// v0.5 concurrency gate: N separate PROCESSES append to the same stream at the
// same time. The single-writer mkdir lock must serialize read-tail → sign →
// append so the epoch segment has no forks, no missing records, and no
// duplicate predecessors.
const WORKERS = 8;

describe('receipt chain concurrency (multi-process)', () => {
  it('uses a real clock for stale locks even when global Date is frozen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-lock-clock-'));
    const lock = join(dir, '.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(Number.MAX_SAFE_INTEGER));
    const RealDate = Date;
    const staleTime = new RealDate(RealDate.now() - 20000);
    utimesSync(lock, staleTime, staleTime);
    class FrozenDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(1767225600000);
        else super(...(args as [number]));
      }
      static now(): number { return 1767225600000; }
    }
    try {
      (globalThis as unknown as { Date: typeof Date }).Date = FrozenDate as unknown as typeof Date;
      const result = withLockDir(lock, () => 'ok');
      expect(result).toBe('ok');
    } finally {
      (globalThis as unknown as { Date: typeof Date }).Date = RealDate;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes parallel appends across processes without forks or dupes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-conc-'));
    const repo = process.cwd();
    // cwd stays at the repo so `--import tsx` resolves; the target stream dir
    // is passed explicitly (appendReceipt's dir arg) — same code path, isolated store.
    const code = `
      import { appendReceipt } from ${JSON.stringify(join(repo, 'src/utils/receipts.ts'))};
      appendReceipt('runs', { kind: 'run', subject: 'conc-' + process.env.N, policy: 'auto', spans: [], artifacts: [] }, process.env.DIR);
    `;
    const kids = Array.from({ length: WORKERS }, (_, i) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
        env: { ...process.env, N: String(i), DIR: dir }
      });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.on('exit', c => {
        if (c !== 0) writeFileSync(join(dir, `child-${i}.err`), err);
        resolve(c ?? 1);
      });
    }));
    const codes = await Promise.all(kids);
    expect(codes).toEqual(Array(WORKERS).fill(0));

    const r = verifyChain('runs', dir);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(WORKERS);
    expect(r.current_epoch).toBe(1);
    expect(r.segments).toHaveLength(1);

    // single path: no duplicate predecessors, no fork
    const chain = readChain('runs', dir);
    const prevs = chain.map(c => c.prev_hash);
    expect(new Set(prevs).size).toBe(prevs.length);
    expect(chain[0].prev_hash).toBe('genesis');
    for (let i = 1; i < chain.length; i++) expect(chain[i].prev_hash).toBe(chain[i - 1].hash);
    // every worker's receipt landed
    const subjects = new Set(chain.map(c => c.subject));
    for (let i = 0; i < WORKERS; i++) expect(subjects.has(`conc-${i}`)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  }, 60000);
});
