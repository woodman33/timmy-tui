// FIXTURE for tests/isolation-settings.test.ts (R4 H98): skipped unless TIMMY_SETTINGS_TOUCH names this process's home
// folder, a temporary folder the parent test made. Then it writes a file in the account's own settings folder as this
// process sees it (under that temporary home), which tests/isolation-setup.ts must catch: this file then fails, naming the
// folder. It refuses to touch anything when its home is not that temporary folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const asked = process.env.TIMMY_SETTINGS_TOUCH;

describe.skipIf(!asked)('FIXTURE: a test that writes in the account\'s own settings folder', () => {
  it('writes config.json there', () => {
    const home = os.homedir();
    // only ever a temporary home the parent test made: never a person's
    if (asked !== home || !path.resolve(home).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error(`refused: this process's home (${home}) is not the temporary one asked for`);
    const dir = process.platform === 'darwin' ? path.join(home, 'Library', 'Preferences', 'timmy-tui-nodejs') : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'timmy-tui-nodejs');
    if (!path.resolve(dir).startsWith(`${path.resolve(home)}${path.sep}`)) throw new Error(`refused: ${dir} is not under the temporary home`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{"onboarded": true}\n');
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
  });
});
