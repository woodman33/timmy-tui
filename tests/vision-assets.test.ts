import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { copyRuntimeAssets, RUNTIME_ASSETS } from '../scripts/copy-runtime-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = ['scripts/vision-bridge.py', 'scripts/roboflow-bridge.py', 'workers/look/look.py'];

describe('vision execution assets are real distributable files', () => {
  it('ships each required bridge/worker and validates it during the build', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const asset of required) {
      expect(lstatSync(join(root, asset)).isFile(), asset).toBe(true);
      expect(manifest.files, asset).toContain(asset);
      expect(RUNTIME_ASSETS, asset).toContain(asset);
    }
  });

  it('refuses a missing bridge before producing partial runtime output', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'timmy-vision-assets-'));
    try {
      for (const asset of RUNTIME_ASSETS) {
        mkdirSync(dirname(join(fixture, asset)), { recursive: true });
        writeFileSync(join(fixture, asset), 'packaging fixture, not executable evidence');
      }
      rmSync(join(fixture, required[0]));
      expect(() => copyRuntimeAssets(fixture)).toThrow();
      expect(existsSync(join(fixture, 'dist'))).toBe(false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});
