/**
 * Round R4 (helper H59; found by helper H55, ledger row 156): a guard for test files that must keep to their own folders.
 *
 * Timmy writes under <home>/timmy when TIMMY_HOME is not set (the canvas's jobs.json and project tokens, profiles), and
 * some code under <home>/.timmy. A test that starts the studio server with `env: {}`, or the CLI with the caller's HOME,
 * wrote there on the test machine. Such tests now give themselves their own temporary HOME and TIMMY_HOME (ownHome), and
 * guardRealHome() lists the real home's timmy folders when a test file loads and compares the listing when it ends: any
 * entry added, removed or changed (its type, size or modification time; a folder's time changes when a file is made or
 * removed in it, so a file written and removed again is caught too) is named. It only reads (lstat and readdir; nothing
 * is followed, opened, written or deleted there), whatever it finds. Another process on the same machine writing there at
 * the same moment would be named too: the guard cannot tell who wrote, only what changed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The real home, as this process saw it when the guard was loaded (before any test gave itself another HOME). */
export const REAL_HOME = os.homedir();
/** The folders under a home that Timmy writes when TIMMY_HOME is not set. */
export const TIMMY_FOLDERS: readonly string[] = ['timmy', '.timmy'];
const MAX_ENTRIES = 20_000;

export interface HomeEntry { type: 'file' | 'dir' | 'link' | 'other'; size: number; mtimeMs: number }
/** Path from the home (with "/"), and what lstat said of it. */
export type HomeListing = Map<string, HomeEntry>;

/** Every entry under a home's timmy folders (lstat: links are not followed), at most MAX_ENTRIES of them. */
export function listTimmyFolders(home: string = REAL_HOME): HomeListing {
  const out: HomeListing = new Map();
  const walk = (abs: string, rel: string): void => {
    if (out.size >= MAX_ENTRIES) return;
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    const type: HomeEntry['type'] = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    out.set(rel, { type, size: type === 'dir' ? 0 : st.size, mtimeMs: st.mtimeMs });
    if (type !== 'dir') return;
    let names: string[] = [];
    try { names = fs.readdirSync(abs).sort(); } catch { return; }
    for (const n of names) walk(path.join(abs, n), `${rel}/${n}`);
  };
  for (const f of TIMMY_FOLDERS) walk(path.join(home, f), f);
  return out;
}

/** What changed between two listings, one line each: added, removed, or changed (and how). */
export function homeChanges(before: HomeListing, after: HomeListing): string[] {
  const out: string[] = [];
  for (const [rel, a] of after) {
    const b = before.get(rel);
    if (!b) { out.push(`added: ${rel} (${a.type})`); continue; }
    const how = [b.type !== a.type ? `type ${b.type} -> ${a.type}` : '', b.size !== a.size ? `size ${b.size} -> ${a.size}` : '', b.mtimeMs !== a.mtimeMs ? 'modified' : ''].filter(Boolean);
    if (how.length) out.push(`changed: ${rel} (${how.join(', ')})`);
  }
  for (const [rel, b] of before) if (!after.has(rel)) out.push(`removed: ${rel} (${b.type})`);
  return out.sort();
}

/** The real home's timmy folders listed now; check() names what changed since (an empty list when nothing did). */
export function guardRealHome(home: string = REAL_HOME): { home: string; check(): string[] } {
  const before = listTimmyFolders(home);
  return { home, check: () => homeChanges(before, listTimmyFolders(home)) };
}

/**
 * A temporary home of a test's own (under the test machine's temporary folder): HOME, and TIMMY_HOME inside it, for an
 * environment given to a server or a child process; remove() deletes that temporary folder only.
 */
export function ownHome(prefix = 'timmy-test-home-'): { HOME: string; TIMMY_HOME: string; env: { HOME: string; TIMMY_HOME: string }; remove(): void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const timmy = path.join(home, 'timmy');
  return { HOME: home, TIMMY_HOME: timmy, env: { HOME: home, TIMMY_HOME: timmy }, remove: () => { fs.rmSync(home, { recursive: true, force: true }); } };
}
