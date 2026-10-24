// R10 (H163; R9's REMAINING-DEFECTS item 17): a dispatch test run stopped before its afterAll left its own tmux server running
// (7 servers named timmy-test-dp-<pid>-<hex>, holding 19 sessions, stopped by hand by the R9 lead). tests/helpers/dispatch-tmux.ts
// now writes down each server it names (a file per server in <temporary folder>/timmy-test-dp-servers, with the run's pid), and
// the next run stops the servers its earlier runs left: only those it wrote down, by their own names, and only when the run
// that named one has ended. An exit hook stops a run's own server when its afterAll did not run.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordServer, sweepLeftServers } from './helpers/dispatch-tmux.js';

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
const dirs: string[] = [];
const servers: Array<{ label: string; tmp: string }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) spawnSync('tmux', ['-L', s.label, 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: s.tmp } });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'dp-sweep-')); dirs.push(d); return d; };
/** A pid no process has now: a child that has already ended. */
const endedPid = (): number => { const r = spawnSync('true'); return r.pid as number; };
const uid = process.getuid?.() ?? 0;

/** A tmux server of this test's own, with one session, under `tmp` (its TMUX_TMPDIR). */
function server(label: string, tmp: string): void {
  servers.push({ label, tmp });
  execFileSync('tmux', ['-L', label, '-f', '/dev/null', 'new-session', '-d', '-s', 'timmy-dp-test', 'sleep 300'], { env: { ...process.env, TMUX_TMPDIR: tmp } });
}
const runs = (label: string, tmp: string): boolean => spawnSync('tmux', ['-L', label, 'ls'], { env: { ...process.env, TMUX_TMPDIR: tmp }, encoding: 'utf8' }).status === 0;

describe('the dispatch tests\' own tmux servers, left by a run that stopped early (R10, H163)', () => {
  it.skipIf(!hasTmux)('the next run stops what its ended earlier runs wrote down, by name; never a server of a run still going, nor one it did not write down', () => {
    const reg = temp();
    const tmp = temp();
    const gone = endedPid();
    const left = `timmy-test-dp-${gone}-a1b2c3`;          // a run that ended before its afterAll: written down, still running
    const going = `timmy-test-dp-${process.pid}-d4e5f6`;   // this run's own, still going
    const stranger = `timmy-test-dp-${gone}-0f0f0f`;      // the same kind of name, never written down by this helper
    for (const l of [left, going, stranger]) server(l, tmp);
    recordServer(reg, { label: left, pid: gone, tmuxTmpdir: tmp });
    recordServer(reg, { label: going, pid: process.pid, tmuxTmpdir: tmp });
    expect(readdirSync(reg).sort()).toEqual([going, left].sort());

    const swept = sweepLeftServers(reg);
    expect(swept).toEqual([{ label: left, pid: gone, stopped: true, socket: 'removed' }]);
    expect(runs(left, tmp)).toBe(false);
    expect(existsSync(join(tmp, `tmux-${uid}`, left))).toBe(false);
    expect(readdirSync(reg)).toEqual([going]);
    // a run still going keeps its server and its record; a server never written down is never touched
    expect(runs(going, tmp)).toBe(true);
    expect(runs(stranger, tmp)).toBe(true);
    // a second sweep finds nothing more to do
    expect(sweepLeftServers(reg)).toEqual([]);
  });

  it.skipIf(!hasTmux)('a record of an ended run whose server is already gone: its record (and its socket file, when tmux left one) is removed', () => {
    const reg = temp();
    const tmp = temp();
    const gone = endedPid();
    const label = `timmy-test-dp-${gone}-c0ffee`;
    mkdirSync(join(tmp, `tmux-${uid}`), { recursive: true, mode: 0o700 });
    server(label, tmp);
    execFileSync('tmux', ['-L', label, 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmp } });
    recordServer(reg, { label, pid: gone, tmuxTmpdir: tmp });
    const swept = sweepLeftServers(reg);
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ label, pid: gone, stopped: false });
    expect(readdirSync(reg)).toEqual([]);
    expect(existsSync(join(tmp, `tmux-${uid}`, label))).toBe(false);
  });

  it('a record that is not one of the helper\'s (another name, a broken file) is left as it is', () => {
    const reg = temp();
    writeFileSync(join(reg, 'timmy-test-dp-1-zzzzzz'), '{not json');
    writeFileSync(join(reg, 'notes.txt'), 'kept');
    writeFileSync(join(reg, 'other-server'), JSON.stringify({ label: 'other-server', pid: endedPid(), tmuxTmpdir: tmpdir() }));
    expect(sweepLeftServers(reg)).toEqual([]);
    expect(readdirSync(reg).sort()).toEqual(['notes.txt', 'other-server', 'timmy-test-dp-1-zzzzzz']);
    expect(lstatSync(join(reg, 'notes.txt')).isFile()).toBe(true);
  });
});
