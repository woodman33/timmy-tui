import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStrictJsonFile } from '../src/utils/strict-json-file.js';

describe('shared strict request-file boundary', () => {
  it('accepts bounded UTF-8 and refuses ambiguous, linked, oversized or invalid files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'timmy-json-file-'));
    try {
      const good = join(root, 'good'); writeFileSync(good, '{"title":"café"}');
      await expect(readStrictJsonFile(good)).resolves.toEqual({ title: 'café' });
      const cases = [Buffer.from('{"a":1,"a":2}'), Buffer.from([0xff]), Buffer.alloc(65537, 32), Buffer.alloc(0)];
      for (const [index, bytes] of cases.entries()) {
        const path = join(root, `bad-${index}`); writeFileSync(path, bytes);
        await expect(readStrictJsonFile(path)).rejects.toThrow();
      }
      const link = join(root, 'link'); symlinkSync(good, link);
      await expect(readStrictJsonFile(link)).rejects.toThrow();
      await expect(readStrictJsonFile(root)).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'timmy-json-pipe-'));
    try {
      const path = join(root, 'pipe');
      expect(spawnSync('mkfifo', [path]).status).toBe(0);
      await expect(readStrictJsonFile(path)).rejects.toThrow('regular file');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 2000);
});
