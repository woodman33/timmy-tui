// The 20:14 order, the second installed defect: the next steps an installed user is given must work
// from the installed package. `timmy init` said "`timmy doctor`, then `npm start`", and the doctor it
// names said "Next step: npm start"; an installed package has no scripts to start.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const INIT = pathToFileURL(resolve('src/utils/init.ts')).href;
const DOCTOR = resolve('scripts/timmy-doctor.ts');

/** A home, a working folder and a store of their own, outside the repository, and no model key. */
function box() {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-next-'));
  const home = join(dir, 'home'), work = join(dir, 'work');
  mkdirSync(home); mkdirSync(work);
  const env = { PATH: process.env.PATH, HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_PRIVATE_DIR: join(work, '.timmy', 'private'), TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '' };
  return { dir, work, env };
}

describe('the next steps an installed user is given', () => {
  it('timmy init names `timmy doctor`, then `timmy`, never npm start', () => {
    const b = box();
    try {
      const r = spawnSync(process.execPath, ['--import', LOADER, '--input-type=module', '-e',
        `const init = await import(${JSON.stringify(INIT)}); process.exitCode = await init.runInit(['--yes', '--operator', 'sample operator', '--project', 'sample-project'], { isTTY: false, log: console.log });`],
      { cwd: b.work, env: b.env, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('Next: `timmy doctor`, then `timmy` to open the REPL.');
      expect(r.stdout).not.toContain('npm start');
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it('timmy doctor ends with a next step that works from an installed package, never npm start', () => {
    const b = box();
    try {
      const r = spawnSync(process.execPath, ['--import', LOADER, DOCTOR, 'doctor'], { cwd: b.work, env: b.env, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^Next step: `timmy` opens the REPL/m);
      expect(r.stdout).not.toContain('npm start');
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});
