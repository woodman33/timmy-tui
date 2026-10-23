import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { visionAsset } from '../src/vision/config.js';
import { visionBridgeAvailability } from '../src/vision/runtime.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
let project: string;
beforeEach(() => { project = mkdtempSync(join(tmpdir(), 'timmy-vision-untrusted-project-')); });
afterEach(() => { rmSync(project, { recursive: true, force: true }); });

describe('vision executable asset trust boundary', () => {
  it('uses the shipped bridge even when the active project contains a same-named executable', () => {
    mkdirSync(join(project, 'scripts'));
    writeFileSync(join(project, 'scripts/vision-bridge.py'), 'raise RuntimeError("PROJECT SCRIPT MUST NOT RUN")\n');
    const trusted = join(packageRoot, 'scripts/vision-bridge.py');
    expect(existsSync(trusted)).toBe(true);
    expect(visionAsset('scripts/vision-bridge.py', project)).toBe(trusted);
    expect(visionBridgeAvailability(project)).toEqual({ available: true, bridge: trusted });
  });

  it('does not fall back to a project-only executable when the package lacks that asset', () => {
    mkdirSync(join(project, 'scripts'));
    const relative = 'scripts/vision-unit-spoof.py';
    writeFileSync(join(project, relative), 'raise RuntimeError("PROJECT SCRIPT MUST NOT RUN")\n');
    expect(visionAsset(relative, project)).toBe(join(packageRoot, relative));
    expect(existsSync(visionAsset(relative, project))).toBe(false);
  });
});
