/**
 * Round R4 (helper H59): the home guard's own checks (tests/fixtures/home-guard.ts), on temporary folders only, never the
 * real home: it names a file added, one written and removed again, one changed, one removed and a new .timmy folder, it
 * lists nothing outside the timmy folders, and it changes nothing itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardRealHome, listTimmyFolders, ownHome, REAL_HOME } from './fixtures/home-guard.js';

const homes: Array<ReturnType<typeof ownHome>> = [];
afterEach(() => { for (const h of homes.splice(0)) h.remove(); });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the home guard (negative controls on a temporary home)', () => {
  it('names what a run added, removed, changed, or wrote and removed again under a home\'s timmy folders, and nothing outside them', async () => {
    const h = ownHome('home-guard-');
    homes.push(h);
    const canvas = path.join(h.HOME, 'timmy', 'canvas');
    fs.mkdirSync(canvas, { recursive: true });
    fs.writeFileSync(path.join(canvas, 'jobs.json'), '[]\n');
    fs.writeFileSync(path.join(h.HOME, 'timmy', 'keep.txt'), 'kept');
    fs.mkdirSync(path.join(h.HOME, 'not-timmy'));
    const g = guardRealHome(h.HOME);
    expect(g.home).toBe(h.HOME);
    expect([...listTimmyFolders(h.HOME).keys()]).toEqual(['timmy', 'timmy/canvas', 'timmy/canvas/jobs.json', 'timmy/keep.txt']);
    expect(g.check()).toEqual([]);
    // File times are coarse: the changes come a moment later.
    await sleep(30);
    fs.writeFileSync(path.join(h.HOME, 'not-timmy', 'ignored.txt'), 'not a timmy folder');
    expect(g.check()).toEqual([]);
    // A token written and removed again (as `timmy studio` did): its folder's time names it.
    fs.writeFileSync(path.join(canvas, 'project-token-4337'), 'FAKE token');
    fs.unlinkSync(path.join(canvas, 'project-token-4337'));
    expect(g.check()).toEqual(['changed: timmy/canvas (modified)']);
    fs.writeFileSync(path.join(canvas, 'new.json'), '{}\n');
    fs.writeFileSync(path.join(h.HOME, 'timmy', 'keep.txt'), 'changed');
    fs.unlinkSync(path.join(canvas, 'jobs.json'));
    fs.mkdirSync(path.join(h.HOME, '.timmy'));
    fs.writeFileSync(path.join(h.HOME, '.timmy', 'x'), 'x');
    expect(g.check()).toEqual([
      'added: .timmy (dir)',
      'added: .timmy/x (file)',
      'added: timmy/canvas/new.json (file)',
      'changed: timmy/canvas (modified)',
      'changed: timmy/keep.txt (size 4 -> 7, modified)',
      'removed: timmy/canvas/jobs.json (file)',
    ]);
    // The guard itself wrote, changed and deleted nothing: the files are as the test left them.
    expect(fs.readFileSync(path.join(h.HOME, 'timmy', 'keep.txt'), 'utf8')).toBe('changed');
    expect(fs.existsSync(path.join(canvas, 'new.json'))).toBe(true);
  });

  it('a home with no timmy folders lists nothing; the real home is the one this process had when the guard loaded', () => {
    const h = ownHome('home-guard-empty-');
    homes.push(h);
    expect(listTimmyFolders(h.HOME).size).toBe(0);
    expect(guardRealHome(h.HOME).check()).toEqual([]);
    expect(REAL_HOME).toBe(os.homedir());
    expect(h.TIMMY_HOME).toBe(path.join(h.HOME, 'timmy'));
    expect(h.env).toEqual({ HOME: h.HOME, TIMMY_HOME: h.TIMMY_HOME });
  });
});
