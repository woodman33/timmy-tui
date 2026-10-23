import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { roboflowReady } from '../src/vox/tools.js';

describe('VoxVision Roboflow interpreter selection agrees with the adapter', () => {
  it('finds an explicit executable without a project venv, without claiming inference', () => {
    const root = mkdtempSync(join(tmpdir(), 'timmy-vox-python-'));
    try {
      // Node stands in as an existing executable: this tests configuration only.
      const result = roboflowReady({ root, onPath: () => null, env: { ROBOFLOW_API_KEY: 'unit-only', TIMMY_VISION_PYTHON: process.execPath } });
      expect(result).toMatchObject({ ready: true, command: process.execPath });
      if (result.ready) expect(result.via).toContain('not checked');
      expect(roboflowReady({ root, onPath: () => null, env: { ROBOFLOW_API_KEY: 'unit-only', TIMMY_VISION_PYTHON: 'python3' } })).toMatchObject({ ready: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
