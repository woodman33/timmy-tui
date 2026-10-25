// Explicit missing-installation controls. Test doubles are injected through the
// asset resolver; production must never run a project-supplied Python script.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVisionCli } from '../src/vision/cli.js';
import { visionAsset } from '../src/vision/config.js';

const assets = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/vision/config.js', async (original) => {
  const real = await original<typeof import('../src/vision/config.js')>();
  return { ...real, visionAsset: (path: string, dir = process.cwd()) =>
    assets.root && path.startsWith('scripts/') ? join(assets.root, path) : real.visionAsset(path, dir) };
});

let dir: string;
let before: string;
let exitBefore: typeof process.exitCode;
const pythonBefore = process.env.TIMMY_VISION_PYTHON;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-vision-cli-'));
  before = process.cwd();
  exitBefore = process.exitCode;
  process.chdir(dir);
  assets.root = dir;
});
afterEach(() => {
  process.chdir(before);
  process.exitCode = exitBefore;
  if (pythonBefore === undefined) delete process.env.TIMMY_VISION_PYTHON; else process.env.TIMMY_VISION_PYTHON = pythonBefore;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('timmy vision doctor and stream without their scripts', () => {
  for (const sub of ['doctor', 'stream'] as const) {
    it(`${sub} says its script is not in this build and exits 2`, async () => {
      const script = `scripts/vision-${sub}.py`;
      expect(visionAsset(script)).toBe(join(dir, script)); // explicitly simulated missing installation
      const said: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
      await runVisionCli([sub]);
      expect(process.exitCode).toBe(2);
      expect(said.join('\n')).toContain(`timmy vision ${sub} cannot run in this build: its script (${script}) is not included.`);
    });
  }

  it('UNIT child control: an explicitly injected script runs (node stands in for Python; no real doctor)', async () => {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'vision-doctor.py'), 'process.exit(0);\n');
    process.env.TIMMY_VISION_PYTHON = process.execPath;
    const said: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
    await runVisionCli(['doctor']);
    expect(process.exitCode).toBe(0);
    expect(said.join('\n')).not.toContain('cannot run in this build');
  });
});
