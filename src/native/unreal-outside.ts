/**
 * What an Unreal job wrote outside the project (round R4, helper H72). After every Unreal job, the first pass and the
 * readback, Timmy looks through Unreal's own user folders in the home of the account it runs as (os.userInfo().homedir,
 * never $HOME, which a sandboxed Timmy changes) for files created or modified since the job started: read-only, metadata
 * only (lstat), no file is opened, no link is followed. The verdict says what it found, by folder, with the folders
 * named relative to that home ("~/Library/…"), never as an absolute home path.
 *
 * Why: on the Mac run r21 (ledger row 163) Unreal Engine 5.8.2 ignored the sandbox's HOME and wrote 152 files into the
 * operator's ~/Library/Application Support/Epic (its derived-data cache, Zen's data and install, its user config) and 3
 * into ~/Library/Logs/Unreal Engine. Unreal on macOS finds those folders through CoreFoundation
 * (NSSearchPathForDirectoriesInDomains), which honours CFFIXED_USER_HOME and not HOME (H72 checked both on the Mac before
 * relying on it). src/native/unreal.ts (unrealPlace) now keeps them out; this check is what shows whether it did.
 *
 * The folders watched on macOS are the two r21 found written plus two H72's first Mac run found Unreal writing in a
 * sandbox home (UnrealBuildTool's own settings, "Unreal Engine/UnrealBuildTool", and the trace server's store,
 * ~/UnrealEngine, which it finds through HOME). Off macOS the check does not apply (Unreal keeps other folders there; none
 * is watched), unless a seam says what to watch, honoured on any platform: TIMMY_UNREAL_OUTSIDE_DIRS names the folders,
 * and TIMMY_UNREAL_ACCOUNT_HOME (the tests') names a folder standing in for the account's home, whose Unreal folders are
 * watched and named "~/…" as the real home's are, so a test's record carries no path of the machine it ran on.
 */
import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

type Env = Record<string, string | undefined>;

/** A seam: folders to watch instead of Unreal's own (absolute, separated as PATH is), on any platform. */
export const UNREAL_OUTSIDE_ENV = 'TIMMY_UNREAL_OUTSIDE_DIRS';
/**
 * The tests' seam: a folder standing in for the account's home (absolute). Its Unreal folders (the macOS list) are watched,
 * on any platform, and every folder watched under it is named relative to it ("~/…"), as the account's own home's are.
 */
export const UNREAL_ACCOUNT_HOME_ENV = 'TIMMY_UNREAL_ACCOUNT_HOME';

/** The outside check's environment for a job: this process's, with the job's own seams over it (a test passes them so). */
export function unrealOutsideEnv(jobEnv?: Env): Env {
  const seams: Env = {};
  for (const k of [UNREAL_OUTSIDE_ENV, UNREAL_ACCOUNT_HOME_ENV]) if (jobEnv?.[k]) seams[k] = jobEnv[k];
  return { ...process.env, ...seams };
}
/** Unreal's own user folders on macOS, relative to the account's home. */
export const UNREAL_MAC_USER_FOLDERS: readonly string[] = [
  'Library/Application Support/Epic', 'Library/Application Support/Unreal Engine', 'Library/Logs/Unreal Engine', 'UnrealEngine',
];
/** The most file names a record keeps (the counts by folder cover them all). */
export const UNREAL_OUTSIDE_NAMES = 20;
/** A file changed this long after the job's end still counts (Unreal's helpers finish writing as it exits). */
export const UNREAL_OUTSIDE_SLACK_MS = 5000;
/** How the check finds what it counts, said with it. */
export const UNREAL_OUTSIDE_METHOD = 'regular files created or modified (birth or modification time) at or after the job\'s start and before its end + 5 s, found by walking each folder without following links; metadata only, no file was opened';
/** A walk stops past this many entries or this long, and says so (an incomplete check is never "nothing"). */
const MAX_ENTRIES = 300_000;
const MAX_MS = 20_000;
/** Files are counted by the folder at most this many levels below a watched folder. */
const GROUP_DEPTH = 3;
/** Names gathered before the first UNREAL_OUTSIDE_NAMES (sorted) are kept. */
const NAMES_GATHERED = 2000;

export interface UnrealOutsideCheck {
  /** checked: every watched folder walked; incomplete: a walk stopped early (`why`); not applicable: nothing watched here (`why`) */
  state: 'checked' | 'incomplete' | 'not applicable';
  /** the folders watched, as shown: relative to the account's home ("~/…") */
  folders: string[];
  /** the window: from the job's start; to its end + slack, when its end is known */
  since: string;
  until?: string;
  /** files created or modified in the window */
  files: number;
  /** those files counted by folder (as shown), largest first */
  by_folder: Record<string, number>;
  /** at most UNREAL_OUTSIDE_NAMES of them, as shown, sorted */
  names: string[];
  /** folders that could not be read (skipped) */
  unreadable?: number;
  why?: string;
  method: string;
}

/** The account's home: the password database's, never $HOME (a sandboxed Timmy sets HOME to its own folder). */
export function accountHome(): string {
  try { return userInfo().homedir; } catch { return ''; }
}

/** A folder as the verdict names it: "~/…" inside the account's home, else as given (a test's folder). */
export function shownFolder(abs: string, home: string = accountHome()): string {
  if (home && home.length > 1) {
    if (abs === home) return '~';
    if (abs.startsWith(`${home}${path.sep}`)) return `~/${abs.slice(home.length + 1).split(path.sep).join('/')}`;
  }
  return abs.split(path.sep).join('/');
}

/**
 * The folders to watch, or why none is: Unreal's user folders on macOS in the account's home (or in the tests' stand-in
 * for it, on any platform), or the folders TIMMY_UNREAL_OUTSIDE_DIRS names; none off macOS without a seam.
 */
export function unrealOutsideFolders(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = accountHome()):
  { folders: Array<{ abs: string; shown: string }> } | { none: string } {
  const standIn = env[UNREAL_ACCOUNT_HOME_ENV]?.trim();
  const base = standIn && path.isAbsolute(standIn) ? standIn : home;
  const named = env[UNREAL_OUTSIDE_ENV]?.trim();
  if (named) {
    const folders = named.split(path.delimiter).map((f) => f.trim()).filter((f) => f && path.isAbsolute(f));
    return folders.length ? { folders: folders.map((abs) => ({ abs, shown: shownFolder(abs, base) })) } : { none: `${UNREAL_OUTSIDE_ENV} names no absolute folder` };
  }
  if (!standIn && platform !== 'darwin') return { none: `the check applies on macOS, where Unreal's user folders are known; this is ${platform}` };
  if (!base) return { none: 'this account\'s home is not known' };
  return { folders: UNREAL_MAC_USER_FOLDERS.map((rel) => { const abs = path.join(base, ...rel.split('/')); return { abs, shown: shownFolder(abs, base) }; }) };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Walks each watched folder for regular files born or modified in the window [sinceMs, untilMs] (no upper bound when
 * untilMs is undefined): metadata only. A folder that is not there holds nothing; one that cannot be read is counted as
 * unreadable. Past MAX_ENTRIES entries or MAX_MS the walk stops and the check says it is incomplete.
 */
export function checkUnrealOutside(o: { sinceMs: number; untilMs?: number; env?: Env; platform?: NodeJS.Platform; home?: string }): UnrealOutsideCheck {
  const home = o.home ?? accountHome();
  const where = unrealOutsideFolders(o.env ?? process.env, o.platform ?? process.platform, home);
  const window = { since: iso(o.sinceMs), ...(o.untilMs !== undefined ? { until: iso(o.untilMs) } : {}) };
  if ('none' in where) return { state: 'not applicable', folders: [], ...window, files: 0, by_folder: {}, names: [], why: where.none, method: UNREAL_OUTSIDE_METHOD };
  const started = Date.now();
  const counts = new Map<string, number>();
  const gathered: string[] = [];
  let files = 0;
  let entries = 0;
  let unreadable = 0;
  let stopped: string | undefined;
  const inWindow = (ms: number): boolean => ms >= o.sinceMs && (o.untilMs === undefined || ms <= o.untilMs);
  for (const f of where.folders) {
    const stack: string[][] = [[]];
    while (stack.length && !stopped) {
      const rel = stack.pop()!;
      let list: Dirent[];
      try { list = readdirSync(path.join(f.abs, ...rel), { withFileTypes: true }); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable++;
        continue;
      }
      list.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // popped in name order
      for (const e of list) {
        if (++entries > MAX_ENTRIES) { stopped = `the walk stopped after ${MAX_ENTRIES.toLocaleString('en-US')} entries`; break; }
        if ((entries & 1023) === 0 && Date.now() - started > MAX_MS) { stopped = `the walk stopped after ${MAX_MS / 1000} s`; break; }
        if (e.isDirectory()) { stack.push([...rel, e.name]); continue; }
        if (!e.isFile()) continue; // a link, a socket: never followed, never counted
        let born: number;
        let modified: number;
        try { const s = lstatSync(path.join(f.abs, ...rel, e.name)); born = s.birthtimeMs; modified = s.mtimeMs; } catch { continue; }
        if (!inWindow(modified) && !(born > 0 && inWindow(born))) continue;
        files++;
        const group = [f.shown, ...rel.slice(0, GROUP_DEPTH)].join('/');
        counts.set(group, (counts.get(group) ?? 0) + 1);
        if (gathered.length < NAMES_GATHERED) gathered.push([f.shown, ...rel, e.name].join('/'));
      }
    }
    if (stopped) break;
  }
  const by = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    state: stopped ? 'incomplete' : 'checked', folders: where.folders.map((f) => f.shown), ...window, files, by_folder: Object.fromEntries(by),
    names: gathered.sort().slice(0, UNREAL_OUTSIDE_NAMES), ...(unreadable ? { unreadable } : {}), ...(stopped ? { why: stopped } : {}), method: UNREAL_OUTSIDE_METHOD,
  };
}

/** A job's check, once: the first pass is judged twice when it ends (its lines and its receipt), and a walk can take seconds. */
const done = new Map<string, UnrealOutsideCheck>();
export function checkUnrealOutsideOnce(key: string, o: Parameters<typeof checkUnrealOutside>[0]): UnrealOutsideCheck {
  const had = done.get(key);
  if (had) return had;
  const c = checkUnrealOutside(o);
  done.set(key, c);
  if (done.size > 50) done.delete(done.keys().next().value as string);
  return c;
}

/**
 * The check in words, for a verdict: "Unreal wrote nothing outside the project and Timmy's native home", or "Unreal wrote
 * 3 files outside the project: ~/Library/Application Support/Epic/UnrealEngine/5.8 (2), …". `nativeHome`: Unreal's user
 * folders were sent to Timmy's own native home (TIMMY_NATIVE_HOME); without one they are this account's own. A walk that
 * stopped early or a folder it could not read never gives "nothing", and makes its count "at least".
 */
export function unrealOutsideWords(c: UnrealOutsideCheck, o: { nativeHome: boolean }): string {
  if (c.state === 'not applicable') return `Unreal's writes outside the project were not checked: ${c.why ?? 'nothing is watched here'}`;
  const partial = c.state === 'incomplete' ? ` (an incomplete check: ${c.why ?? 'the walk stopped early'})` : '';
  const unread = c.unreadable ? `; ${c.unreadable} folder${c.unreadable === 1 ? '' : 's'} could not be read` : '';
  if (!c.files) {
    if (c.state === 'incomplete') return `Unreal's writes outside the project are not known${partial}${unread}`;
    if (c.unreadable) return `Unreal's writes outside the project are known only in part: nothing in the folders read${unread}, so what it wrote there is not known`;
    return `Unreal wrote nothing outside the project${o.nativeHome ? ' and Timmy\'s native home' : ''}`;
  }
  const groups = Object.entries(c.by_folder);
  const named = groups.slice(0, 6).map(([f, n]) => `${f} (${n})`).join(', ');
  const atLeast = c.state === 'incomplete' || c.unreadable ? 'at least ' : '';
  return `Unreal wrote ${atLeast}${c.files} file${c.files === 1 ? '' : 's'} outside the project: ${named}${groups.length > 6 ? ` and ${groups.length - 6} more folders` : ''}${partial}${unread}`;
}

/** What was watched, in a few words (said beside the verdict). */
export function unrealOutsideScope(c: UnrealOutsideCheck): string {
  return c.state === 'not applicable' ? '' : `checked ${c.folders.join(', ')} for files changed since the job started (metadata only)`;
}
