import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const loader = join(root, 'node_modules/tsx/dist/loader.mjs');
const dirs: string[] = [];
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-dispatch-')));
  dirs.push(dir);
  return dir;
}
async function cli(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const result = await run(process.execPath, ['--import', loader, join(root, 'src/cli.ts'), ...args], {
      cwd, env: { ...process.env, TIMMY_PRIVATE_DIR: join(cwd, 'private'), TIMMY_STORE: join(cwd, 'receipts'), ...extraEnv },
      timeout: 30_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return error as { stdout: string; stderr: string; code: number };
  }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('settlement CLI routing', () => {
  it.each([false, true])('forwards native cockpit verbs without launching agents (leading JSON flag: %s)', async leadingJson => {
    const cwd = sandbox(), bin = join(cwd, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), `#!${process.execPath}\nconsole.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));\n`, { mode: 0o700 });
    for (const verb of ['up', 'attach', 'status', 'down', 'hands']) {
      const result = await cli(cwd, [...(leadingJson ? ['--json'] : []), 'cockpit', verb, '--session', 'fixture'], { PATH: `${bin}:${process.env.PATH ?? ''}` });
      expect(result.code, result.stderr).toBe(0);
      const forwarded = JSON.parse(result.stdout.trim());
      expect(forwarded.argv[0]).toBe(join(root, 'lanes/cockpit/cockpit.mjs'));
      expect(forwarded.argv.slice(1)).toEqual([verb, '--session', 'fixture']);
      expect(forwarded.cwd).toBe(cwd);
    }
    const refused = await cli(cwd, ['--json', 'cockpit', 'up', '--out'], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--out requires a directory');
    expect(refused.stdout).toBe('');
  });

  it('explicit TUI settings reject non-terminal input without replacing plain init', async () => {
    const result = await cli(sandbox(), ['init', '--tui']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('settings wizard requires a terminal');
    expect(result.stderr).not.toContain('Cannot find module');
  });

  it('refuses an unknown cockpit verb', async () => {
    const result = await cli(sandbox(), ['cockpit', 'invalid']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('usage: timmy cockpit');
  });

  it('resolves capture input/output at the caller directory without rendering film or sealing', async () => {
    const cwd = sandbox();
    copyFileSync(join(root, 'lanes/demos/hands-8.rounds.md'), join(cwd, 'chart.md'));
    const result = await cli(cwd, ['cockpit', 'shot', '--rounds', 'chart.md', '--out', 'captures', '--marker', 'fixture', '--no-film', '--no-seal', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.directory).toBe(join(cwd, 'captures/fixture'));
    expect(output.sealed).toBeNull();
    const manifest = JSON.parse(readFileSync(join(output.directory, 'manifest.json'), 'utf8'));
    expect(manifest.board.kind).toBe('synthetic-fixture');
    expect(manifest.limits).toMatchObject({ fullShellCapture: false, nativeQualification: false, modelEvidenceAdmission: false });
  });

  it('imports and captures the same board under a private-directory override', async () => {
    const cwd = sandbox();
    copyFileSync(join(root, 'lanes/demos/hands-8.rounds.md'), join(cwd, 'chart.md'));
    const imported = await cli(cwd, ['cockpit', 'board', 'import', 'chart.md', '--json']);
    expect(imported.code, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout).path).toBe(join(cwd, 'private/cockpit/board.json'));
    const captured = await cli(cwd, ['cockpit', 'shot', '--out', 'captures', '--marker', 'private-board', '--no-film', '--no-seal']);
    expect(captured.code, captured.stderr).toBe(0);
    expect(JSON.parse(captured.stdout).board).toMatchObject({ kind: 'private', hands: 8 });
  });

  it.each([
    ['--json', '--out', 'captures', 'cockpit', 'shot'],
    ['cockpit', '--json', '--out', 'captures', 'shot'],
    ['cockpit', 'shot', '--out', 'captures', '--json'],
  ])('accepts global flags around the cockpit shot verbs: %j', async (...prefix) => {
    const cwd = sandbox();
    copyFileSync(join(root, 'lanes/demos/hands-8.rounds.md'), join(cwd, 'chart.md'));
    const result = await cli(cwd, [...prefix, '--rounds', 'chart.md', '--marker', 'global-flags', '--no-film', '--no-seal']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).directory).toBe(join(cwd, 'captures/global-flags'));
  });

  it.each([
    ['cockpit', 'shot', '--out'],
    ['cockpit', 'shot', '--out', 'captures', '--out'],
    ['cockpit', 'shot', '--rounds', '--json', 'chart.md'],
    ['cockpit', 'shot', '--marker', '--out', 'captures', 'name'],
  ])('refuses missing values before removing globals: %j', async (...argv) => {
    const result = await cli(sandbox(), [...argv]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid cockpit shot arguments');
  });
});
