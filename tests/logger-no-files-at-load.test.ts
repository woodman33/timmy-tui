// R5 lead: loading the logger makes nothing in the folder a process starts in (before, every process that imported it made
// logs/ and five empty log files there, which a project's Files then listed); a line written makes logs/ and its own file.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const LOADER = resolve('node_modules/tsx/dist/loader.mjs');
const LOGGER = resolve('src/utils/logger.ts');
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('the logger', () => {
  it('makes no logs/ folder and no file when it loads; writeLog makes logs/ and the one file it writes', () => {
    dir = mkdtempSync(join(tmpdir(), 'logger-load-'));
    const run = (code: string): void => {
      execFileSync(process.execPath, ['--import', `file://${LOADER}`, '--input-type=module', '-e', code], { cwd: dir, stdio: 'pipe', timeout: 60_000 });
    };
    run(`await import(${JSON.stringify(`file://${LOGGER}`)});`);
    expect(readdirSync(dir)).toEqual([]);
    run(`const m = await import(${JSON.stringify(`file://${LOGGER}`)}); m.writeLog('agent-events.log', 'info', 'FAKE line (test)');`);
    expect(readdirSync(join(dir, 'logs'))).toEqual(['agent-events.log']);
    expect(readFileSync(join(dir, 'logs', 'agent-events.log'), 'utf8')).toContain('FAKE line (test)');
    expect(existsSync(join(dir, 'logs', 'timmy-tui.log'))).toBe(false);
  });

  // R5 lead (the QA round, defect 1): the Workbench owns the screen, and its companion runs in its process
  it('while a view owns the screen (ownScreen), logger and console lines go to the log file, not the terminal, and a child process is not told', () => {
    dir = mkdtempSync(join(tmpdir(), 'logger-screen-'));
    const code = `
      const m = await import(${JSON.stringify(`file://${LOGGER}`)});
      const { spawnSync } = await import('node:child_process');
      m.ownScreen(true);
      m.logger.info('FAKE quiet companion line (test)');
      console.error('FAKE quiet console line (test)');
      const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.TIMMY_TUI_ACTIVE))'], { encoding: 'utf8' });
      m.ownScreen(false);
      m.logger.info('FAKE loud line after (test)');
      process.stdout.write('child saw ' + child.stdout);`;
    const r = spawnSync(process.execPath, ['--import', `file://${LOADER}`, '--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, TIMMY_TUI_ACTIVE: '' } });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('FAKE quiet');
    expect(r.stderr).toContain('FAKE loud line after (test)');
    expect(r.stdout).toBe('child saw ');
    expect(readFileSync(join(dir, 'logs', 'companion.log'), 'utf8')).toContain('FAKE quiet companion line (test)');
    expect(readFileSync(join(dir, 'logs', 'timmy-tui.log'), 'utf8')).toContain('FAKE quiet console line (test)');
  });
});
