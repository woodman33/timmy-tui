/**
 * Round R4 (H72): the check of what an Unreal job wrote outside the project (src/native/unreal-outside.ts), on real files
 * and folders in a temporary folder standing in for the account's home: metadata only, never a link followed, files
 * counted by folder in the job's window, at most 20 names kept, folders named relative to that home ("~/…"); off macOS,
 * with no seam, it says the check does not apply; an incomplete check never says "nothing".
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkUnrealOutside, shownFolder, UNREAL_ACCOUNT_HOME_ENV, UNREAL_MAC_USER_FOLDERS, UNREAL_OUTSIDE_ENV, UNREAL_OUTSIDE_NAMES, unrealOutsideFolders,
  unrealOutsideWords, type UnrealOutsideCheck,
} from '../src/native/unreal-outside.js';

let tmp = '';
let home = '';
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-unreal-outside-')));
  home = path.join(tmp, 'home');
  mkdirSync(home);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const put = (rel: string, body = 'x'): string => {
  const at = path.join(home, ...rel.split('/'));
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, body);
  return at;
};
/** Sets a file's times well before now (its birth time stays: a file born in the window still counts). */
const old = (at: string): void => { const t = new Date(Date.now() - 3600_000); utimesSync(at, t, t); };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('which folders are watched', () => {
  it('on macOS, Unreal\'s four user folders in the account\'s home, named "~/…"; off macOS, none (the check does not apply)', () => {
    const mac = unrealOutsideFolders({}, 'darwin', home);
    expect('folders' in mac && mac.folders).toEqual(UNREAL_MAC_USER_FOLDERS.map((rel) => ({ abs: path.join(home, ...rel.split('/')), shown: `~/${rel}` })));
    expect(UNREAL_MAC_USER_FOLDERS).toEqual(['Library/Application Support/Epic', 'Library/Application Support/Unreal Engine', 'Library/Logs/Unreal Engine', 'UnrealEngine']);
    expect(unrealOutsideFolders({}, 'linux', home)).toEqual({ none: 'the check applies on macOS, where Unreal\'s user folders are known; this is linux' });
  });

  it('a stand-in home (the tests\' seam) is watched on any platform; TIMMY_UNREAL_OUTSIDE_DIRS names folders, shown relative to the home when inside it', () => {
    const stand = unrealOutsideFolders({ [UNREAL_ACCOUNT_HOME_ENV]: home }, 'linux', '/nowhere');
    expect('folders' in stand && stand.folders.map((f) => f.shown)).toEqual(UNREAL_MAC_USER_FOLDERS.map((rel) => `~/${rel}`));
    const named = unrealOutsideFolders({ [UNREAL_OUTSIDE_ENV]: [path.join(home, 'a'), 'relative/ignored', path.join(tmp, 'b')].join(path.delimiter) }, 'linux', home);
    expect('folders' in named && named.folders.map((f) => f.shown)).toEqual(['~/a', shownFolder(path.join(tmp, 'b'), home)]);
    expect(unrealOutsideFolders({ [UNREAL_OUTSIDE_ENV]: 'relative' }, 'darwin', home)).toEqual({ none: `${UNREAL_OUTSIDE_ENV} names no absolute folder` });
  });
});

describe('what is counted', () => {
  it('files born or modified in the window, by folder (up to three levels down), names sorted; nothing before it, nothing after it', async () => {
    const before = put('Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache/old.udd');
    await wait(30);
    const sinceMs = Date.now();
    await wait(30);
    put('Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache/Buckets/a/1.udd');
    put('Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache/Buckets/b/2.udd');
    put('Library/Application Support/Epic/UnrealEngine/5.8/Saved/Config/MacEditor/EditorSettings.ini');
    put('Library/Logs/Unreal Engine/TimmyStarterEditor/AutoSDKInfo.json');
    put('UnrealEngine/UnrealTrace/Server_1.log');
    await wait(30);
    const untilMs = Date.now();
    await wait(30);
    put('Library/Logs/Unreal Engine/Later/after.log');
    const c = checkUnrealOutside({ sinceMs, untilMs, env: { [UNREAL_ACCOUNT_HOME_ENV]: home }, platform: 'linux' });
    expect(c).toMatchObject({
      state: 'checked', files: 5,
      by_folder: {
        '~/Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache': 2, '~/Library/Application Support/Epic/UnrealEngine/5.8/Saved': 1,
        '~/Library/Logs/Unreal Engine/TimmyStarterEditor': 1, '~/UnrealEngine/UnrealTrace': 1,
      },
      names: [
        '~/Library/Application Support/Epic/UnrealEngine/5.8/Saved/Config/MacEditor/EditorSettings.ini',
        '~/Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache/Buckets/a/1.udd',
        '~/Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache/Buckets/b/2.udd',
        '~/Library/Logs/Unreal Engine/TimmyStarterEditor/AutoSDKInfo.json',
        '~/UnrealEngine/UnrealTrace/Server_1.log',
      ],
    });
    expect(Object.keys(c.by_folder)[0]).toBe('~/Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache');
    expect(c.names.join('\n')).not.toContain(path.basename(before));
    expect(JSON.stringify(c)).not.toContain(tmp);
    expect(unrealOutsideWords(c, { nativeHome: true })).toBe('Unreal wrote 5 files outside the project: ~/Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache (2), ~/Library/Application Support/Epic/UnrealEngine/5.8/Saved (1), ~/Library/Logs/Unreal Engine/TimmyStarterEditor (1), ~/UnrealEngine/UnrealTrace (1)');
  });

  it('a file modified in the window counts even when born long before; a file whose times were set back counts only if it was born in the window', async () => {
    const kept = put('Library/Application Support/Epic/UnrealEngine/5.8/Saved/Config/MacEditor/Manifest.ini');
    old(kept);
    await wait(30);
    const sinceMs = Date.now();
    await wait(30);
    writeFileSync(kept, 'changed');
    const quiet = checkUnrealOutside({ sinceMs, env: { [UNREAL_ACCOUNT_HOME_ENV]: home }, platform: 'linux' });
    expect(quiet.files).toBe(1);
    const copied = put('Library/Application Support/Epic/UnrealEngine/Common/Zen/Install/zenserver');
    old(copied);
    const again = checkUnrealOutside({ sinceMs, env: { [UNREAL_ACCOUNT_HOME_ENV]: home }, platform: 'linux' });
    // APFS keeps a birth time; a file system with none reports 0 (or the status-change time) there, and Node says so: the
    // copy with its times set back counts exactly when the birth time it reports falls in the window
    expect(again.files).toBe(statSync(copied).birthtimeMs >= sinceMs ? 2 : 1);
  });

  it('never follows a link, and counts nothing behind one; a folder that is not there holds nothing', async () => {
    const sinceMs = Date.now() - 1000;
    const outside = path.join(tmp, 'elsewhere');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'x');
    mkdirSync(path.join(home, 'Library', 'Application Support', 'Epic'), { recursive: true });
    symlinkSync(outside, path.join(home, 'Library', 'Application Support', 'Epic', 'link'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(home, 'Library', 'Application Support', 'Epic', 'file-link'));
    const c = checkUnrealOutside({ sinceMs, env: { [UNREAL_ACCOUNT_HOME_ENV]: home }, platform: 'linux' });
    expect(c).toMatchObject({ state: 'checked', files: 0, names: [] });
    expect(c.unreadable).toBeUndefined();
    expect(unrealOutsideWords(c, { nativeHome: true })).toBe('Unreal wrote nothing outside the project and Timmy\'s native home');
    expect(unrealOutsideWords(c, { nativeHome: false })).toBe('Unreal wrote nothing outside the project');
  });

  it('keeps at most 20 names, all counted', () => {
    const sinceMs = Date.now() - 1000;
    for (let i = 0; i < 25; i++) put(`Library/Logs/Unreal Engine/Many/f${String(i).padStart(2, '0')}.log`);
    const c = checkUnrealOutside({ sinceMs, env: { [UNREAL_ACCOUNT_HOME_ENV]: home }, platform: 'linux' });
    expect(c.files).toBe(25);
    expect(c.names).toHaveLength(UNREAL_OUTSIDE_NAMES);
    expect(c.names[0]).toBe('~/Library/Logs/Unreal Engine/Many/f00.log');
    expect(c.by_folder).toEqual({ '~/Library/Logs/Unreal Engine/Many': 25 });
  });
});

describe('in words', () => {
  const base: UnrealOutsideCheck = { state: 'checked', folders: ['~/Library/Application Support/Epic'], since: '', files: 0, by_folder: {}, names: [], method: '' };
  it('off macOS: not checked, and why; an incomplete walk never says nothing', () => {
    expect(unrealOutsideWords(checkUnrealOutside({ sinceMs: 0, env: {}, platform: 'linux', home }), { nativeHome: true }))
      .toBe('Unreal\'s writes outside the project were not checked: the check applies on macOS, where Unreal\'s user folders are known; this is linux');
    expect(unrealOutsideWords({ ...base, state: 'incomplete', why: 'the walk stopped after 20 s' }, { nativeHome: true }))
      .toBe('Unreal\'s writes outside the project are not known (an incomplete check: the walk stopped after 20 s)');
    expect(unrealOutsideWords({ ...base, state: 'incomplete', why: 'the walk stopped after 20 s', files: 3, by_folder: { '~/x': 3 } }, { nativeHome: true }))
      .toBe('Unreal wrote 3 files outside the project: ~/x (3) (an incomplete check: the walk stopped after 20 s)');
    expect(unrealOutsideWords({ ...base, unreadable: 2 }, { nativeHome: true })).toBe('Unreal wrote nothing outside the project and Timmy\'s native home; 2 folders could not be read');
  });
});
