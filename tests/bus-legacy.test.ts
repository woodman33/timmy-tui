import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendEvent, readEvents } from '../src/utils/eventbus.js';
import { readChain } from '../src/utils/receipts.js';

describe('ONE BUS shim (onebus-m5f2)', () => {
  it('appendEvent forwards to the runs.jsonl bus, logs bus.legacy-write, and never writes the legacy file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-onebus-'));
    try {
      appendEvent('test.straggler', { note: 'shim probe' }, dir);
      const legacy = join(dir, '.timmy', 'runs', 'timmy-events.jsonl');
      expect(existsSync(legacy)).toBe(false); // zero legacy writes
      const evs = readEvents(0, dir);
      expect(evs.some(e => e.kind === 'test.straggler')).toBe(true); // forwarded to bus
      const chain = readChain('runs', dir);
      expect(chain.some(c => String(c.subject).includes('bus.legacy-write'))).toBe(true); // findable
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
