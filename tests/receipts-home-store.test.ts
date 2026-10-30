/**
 * R13 (found on the Mac qualifying 7bf70af): a package.json in a home folder is never the receipts store of the projects
 * below it. On the Mac a stray ~/package.json made the review package's demo projects (no store pin, under a sandbox HOME
 * below the real home) seal their receipts into the home folder's .timmy/receipts. Here HOME is a temporary folder with a
 * package.json, the project below it has no pin: its store is its own; a real project's package.json below the home still
 * wins, as before; a pin wins over both.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { homeFolders, receiptsDir, rootStoreDir } from '../src/utils/receipts.js';

const kept = process.env.HOME;
const boxes: string[] = [];
afterEach(() => { if (kept === undefined) delete process.env.HOME; else process.env.HOME = kept; for (const b of boxes.splice(0)) rmSync(b, { recursive: true, force: true }); });

describe('the receipts store never climbs to a home folder\'s package.json (R13)', () => {
  it('a project with no pin under a home holding package.json keeps its own store; a project\'s own package.json and a pin still win', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-store-'));
    boxes.push(home);
    writeFileSync(join(home, 'package.json'), '{"name":"not-a-project"}');
    process.env.HOME = home;
    const tray = join(home, 'timmy', 'projects', 'tray');
    mkdirSync(join(tray, '.timmy', 'receipts'), { recursive: true });
    expect(rootStoreDir(tray)).toBeUndefined();
    expect(receiptsDir(tray)).toBe(join(tray, '.timmy', 'receipts'));
    // a real project (its own package.json) below the home: its store, as before
    const app = join(home, 'code', 'app');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"app"}');
    expect(receiptsDir(join(app, 'src'))).toBe(join(app, '.timmy', 'receipts'));
    // a pin wins over both
    mkdirSync(join(tray, '.timmy'), { recursive: true });
    writeFileSync(join(tray, '.timmy', 'store-pin'), join(home, 'pinned'));
    expect(receiptsDir(tray)).toBe(join(home, 'pinned'));
  });

  it('the home folders are HOME\'s and the account\'s own, which a sandbox HOME does not hide', () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'sandbox-home-'));
    boxes.push(process.env.HOME);
    const h = homeFolders();
    expect(h.has(resolve(homedir()))).toBe(true);
    expect(h.has(resolve(userInfo().homedir))).toBe(true);
  });
});
