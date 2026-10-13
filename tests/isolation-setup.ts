import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { watchPaths } from './helpers/path-watch.js';

// TEST ISOLATION (tui-redesign-p6a3 corr 1): EVERY TEST gets its own temp
// receipt store via TIMMY_STORE (honored by the store resolver), so neither
// parallel files nor sibling tests in a file contend on a shared chain, and a
// test's process.chdir cannot leak store resolution into another test.
let store = '';
let previousPolicyDirectory: string | undefined;
beforeEach(() => {
  previousPolicyDirectory = process.env.TIMMY_POLICY_DIR;
  store = mkdtempSync(join(tmpdir(), 'timmy-store-'));
  mkdirSync(join(store, 'receipts'), { recursive: true });
  process.env.TIMMY_STORE = join(store, 'receipts');
  // Register the original with Vitest too, so a test's unstubAllEnvs cannot
  // restore this temporary override after our own cleanup has run.
  vi.stubEnv('TIMMY_POLICY_DIR', store);
});
afterEach(() => {
  delete process.env.TIMMY_STORE;
  if (previousPolicyDirectory === undefined) delete process.env.TIMMY_POLICY_DIR;
  else process.env.TIMMY_POLICY_DIR = previousPolicyDirectory;
  try { rmSync(store, { recursive: true, force: true }); } catch { /* gone */ }
});

// R4 (H97; found by H93): EVERY TEST FILE gets a Timmy home of its own. Code that reads Timmy's home (TIMMY_HOME, else
// ~/timmy) read the account's own when a test named none: the overview built through a REPL read ~/timmy/connect,
// ~/timmy/jobs/r*.json and ~/timmy/cloud. Now TIMMY_HOME is a temporary folder of this file's, set before the file's own
// modules load (so one that reads it when it loads gets it too) and again before each test when a test removed it; a test
// that sets its own keeps it (the file's is only what a test that names none gets). The folders under ~/timmy that do not
// follow TIMMY_HOME (the shell's drop and out folders, src/drop/index.ts; the war room's projects, fleet/harness-menu.mjs;
// the Signal's project, src/harness/uinext.ts: each read from the home folder itself) get the same treatment through the
// variables that move them (TIMMY_DROP_ROOT, TIMMY_OUT_ROOT, TIMMY_PROJECTS_ROOT, TIMMY_SIGNAL_DIR), inside the file's
// home. After the file the folder is removed and each variable is as it was.
//
// The check: the account's own Timmy home (~/timmy, and the TIMMY_HOME this process was given, if any) is watched for the
// whole file (tests/helpers/path-watch.ts: every node:fs function, in this process; child processes are not seen), and a
// file that read or wrote anything there fails after its tests, naming each call, its path and where it came from. Nothing
// there is ever read by the check itself. One reader is exempt: R4 H59's guard (tests/fixtures/home-guard.ts), which lists
// the real home's timmy folders on purpose (lstat and readdir only, nothing opened) to catch what a child process writes
// there, which this check cannot see.
const given = process.env.TIMMY_HOME;
const real = watchPaths([join(homedir(), 'timmy'), ...(given ? [given] : [])].map((p) => resolve(p)), { exempt: ['tests/fixtures/home-guard.ts'] });
// R4 (H98, journey-2): the monitor's settings folder too. The settings store (src/utils/config.ts, conf) is made when its module
// loads and keeps its file in the account's own settings folder (Linux: $XDG_CONFIG_HOME or ~/.config, then timmy-tui-nodejs;
// macOS: ~/Library/Preferences/timmy-tui-nodejs); the full suite rewrote this computer's (apiKey "", a model, onboarded
// true). Every file now gets a settings folder of its own (TIMMY_SETTINGS_DIR, which the store, src/setup/home.ts and
// src/utils/model-key.ts follow, set below with the others), and the account's own is watched: a file that read or wrote
// there fails after its tests, naming each call. A child process's use is not seen (the terminal fixtures give theirs a HOME).
const givenSettings = process.env.TIMMY_SETTINGS_DIR;
const accountSettings = process.platform === 'darwin' ? join(homedir(), 'Library', 'Preferences', 'timmy-tui-nodejs')
  : process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'timmy-tui-nodejs', 'Config')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'timmy-tui-nodejs');
const settingsWatch = watchPaths([accountSettings, ...(givenSettings ? [givenSettings] : [])].map((p) => resolve(p)));
// named now (an unguessable name), made before the file's hooks and tests run: a file whose tests are all skipped runs no
// hook, so it leaves no folder behind (code that reads the home when it loads finds it empty, as a fresh home is)
const fileHome = join(tmpdir(), `timmy-home-${randomBytes(9).toString('hex')}`);
const OWN: Readonly<Record<string, string>> = {
  TIMMY_HOME: fileHome,
  TIMMY_DROP_ROOT: join(fileHome, 'drop'),
  TIMMY_OUT_ROOT: join(fileHome, 'out'),
  TIMMY_PROJECTS_ROOT: join(fileHome, 'projects'),
  TIMMY_SIGNAL_DIR: join(fileHome, 'projects', 'the-signal'),
  TIMMY_SETTINGS_DIR: join(fileHome, 'settings'),
};
const before = Object.fromEntries(Object.keys(OWN).map((k) => [k, process.env[k]]));
for (const [k, v] of Object.entries(OWN)) process.env[k] = v;
beforeAll(() => { mkdirSync(fileHome, { recursive: true, mode: 0o700 }); });
beforeEach(() => {
  for (const [k, v] of Object.entries(OWN)) if (!process.env[k]) process.env[k] = v;
});
afterAll(() => {
  real.stop();
  settingsWatch.stop();
  for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(fileHome, { recursive: true, force: true }); } catch { /* gone */ }
  const uses = [...new Set(real.seen)];
  if (uses.length) {
    throw new Error(`A test of this file used the account's own Timmy home (${real.roots.join(', ')}), which tests must never read or write; give it a TIMMY_HOME of its own. ${uses.length} use${uses.length === 1 ? '' : 's'}: ${uses.slice(0, 20).join('; ')}${uses.length > 20 ? ' …' : ''}`);
  }
  const settingsUses = [...new Set(settingsWatch.seen)];
  if (settingsUses.length) {
    throw new Error(`A test of this file used the account's own settings folder (${settingsWatch.roots.join(', ')}), which tests must never read or write; the settings store follows TIMMY_SETTINGS_DIR, which this setup gives every file. ${settingsUses.length} use${settingsUses.length === 1 ? '' : 's'}: ${settingsUses.slice(0, 20).join('; ')}${settingsUses.length > 20 ? ' …' : ''}`);
  }
});
