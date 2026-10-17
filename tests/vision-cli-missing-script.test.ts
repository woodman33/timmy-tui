// R6 (lead, H146's finding): `timmy vision doctor` and `stream` name python scripts that neither the checkout nor the
// package carries. They say so in plain words and exit 2, instead of handing python3 a missing file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVisionCli } from '../src/vision/cli.js';
import { visionAsset } from '../src/vision/config.js';

let dir: string;
let before: string;
let exitBefore: typeof process.exitCode;
const pythonBefore = process.env.TIMMY_VISION_PYTHON;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-vision-cli-'));
  before = process.cwd();
  exitBefore = process.exitCode;
  process.chdir(dir);
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
      expect(visionAsset(script)).toBe(join(dir, script)); // the repository does not carry it either
      const said: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
      await runVisionCli([sub]);
      expect(process.exitCode).toBe(2);
      expect(said.join('\n')).toContain(`timmy vision ${sub} cannot run in this build: its script (${script}) is not included.`);
    });
  }

  it('negative control: with the script present it runs it (node stands in for python, labelled here)', async () => {
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
