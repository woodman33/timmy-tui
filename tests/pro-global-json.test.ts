import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
let home: string;

/** `timmy <argv>` from source, with no Pro service configured and an empty TIMMY_HOME. */
async function timmy(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const { NODE_PATH: _ignored, ...env } = process.env;
  try {
    return await run(process.execPath, ['--import', 'tsx', CLI, ...argv], {
      env: { ...env, TIMMY_HOME: home, TIMMY_PRO_URL: '', TIMMY_PRO_PUBLIC_KEY: '' },
      timeout: 60_000,
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'timmy-pro-json-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the global --json flag reaching timmy pro', () => {
  it('does not break a pro command that has no JSON output', async () => {
    const { stderr } = await timmy(['--json', 'pro', 'upgrade', '--no-open']);
    expect(stderr).not.toContain('unknown option');
    expect(stderr).toContain('not available');
  }, 90_000);

  it('still makes pro status print JSON', async () => {
    const { stdout } = await timmy(['--json', 'pro', 'status']);
    expect(JSON.parse(stdout).schemaVersion).toBe(1);
  }, 90_000);
});
