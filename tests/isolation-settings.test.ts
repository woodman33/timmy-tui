// R4 (H98, journey-2): every test file gets a settings folder of its own for the monitor's settings store (src/utils/config.ts,
// conf), moved by TIMMY_SETTINGS_DIR (tests/isolation-setup.ts), and the account's own settings folder (~/.config/
// timmy-tui-nodejs on Linux, ~/Library/Preferences/timmy-tui-nodejs on macOS) is watched while the file runs: a file that
// reads or writes there fails. Before, the full suite rewrote this container's own settings file (apiKey "", a model,
// onboarded true); on a Mac that is a person's.
//
// The second test runs vitest itself in a child process, on tests/fixtures/settings-touch.test.ts, with its HOME a temporary
// folder of this test's: the account's settings folder the child watches is under that folder, so nothing of this
// computer's is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfig, saveConfig } from '../src/utils/config.js';
import { settingsFile as setupSettingsFile } from '../src/setup/home.js';
import { settingsFile as doctorSettingsFile } from '../src/utils/model-key.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('the monitor\'s settings folder in tests (R4 H98)', () => {
  it('TIMMY_SETTINGS_DIR is a temporary folder of this file\'s; the settings store, the setup and the doctor all use it', () => {
    const dir = process.env.TIMMY_SETTINGS_DIR;
    expect(dir, 'tests/isolation-setup.ts gives each test file a settings folder').toBeTruthy();
    expect(path.resolve(dir!).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)).toBe(true);
    const file = path.join(dir!, 'config.json');
    expect(getConfig().path).toBe(file);
    expect(setupSettingsFile()).toBe(file);
    expect(doctorSettingsFile()).toBe(file);
    saveConfig({ onboarded: true } as never);
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { onboarded?: boolean }).onboarded).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('a test that uses the account\'s own settings folder fails its file (a child vitest, its HOME a temporary folder)', async () => {
    const home = temp('h98-settings-home-');
    const env: NodeJS.ProcessEnv = { ...withoutRunner(process.env), HOME: home, TIMMY_SETTINGS_TOUCH: home, FORCE_COLOR: '0', NO_COLOR: '1' };
    for (const k of ['TIMMY_SETTINGS_DIR', 'TIMMY_HOME', 'TIMMY_STORE', 'TIMMY_POLICY_DIR', 'TIMMY_DROP_ROOT', 'TIMMY_OUT_ROOT', 'TIMMY_PROJECTS_ROOT', 'TIMMY_SIGNAL_DIR', 'VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID']) delete env[k];
    const r = await runAsync(process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/fixtures/settings-touch.test.ts'], { cwd: process.cwd(), env, timeout: 150_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    const folder = process.platform === 'darwin' ? path.join(home, 'Library', 'Preferences', 'timmy-tui-nodejs') : path.join(home, '.config', 'timmy-tui-nodejs');
    // the fixture's own test passed (it wrote there), and its file failed for it
    expect(out, out).toContain('writes config.json there');
    expect(out, out).toContain(`the account's own settings folder (${folder})`);
    expect(out, out).toMatch(/writeFileSync \S*config\.json/);
    expect(r.status, out).toBe(1);
  }, 180_000);
});
