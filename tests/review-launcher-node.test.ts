// R5 lead (the Mac walk at aa247e5): the review launcher runs Timmy on the node ./review.sh install used, never just the first
// node on the caller's PATH. On the Mac a tmux pane's shell startup files put an older node first, and the Workbench ran on
// Node 22 while ./review.sh where, in the terminal that installed it, named Node 24. Here the launcher is copied into a
// temporary folder with a stand-in `timmy` (a script that reports the node it runs on and where two programs resolve); no
// package is installed and nothing outside the temporary folder is touched.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'scripts', 'review');
const OLD_NODE = ['/opt/node22/bin/node'].find((p) => existsSync(p) && Number(spawnSync(p, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).stdout.trim()) < 24);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A launcher folder: review.sh and fake-lanes/ as the package carries them, and a sandbox with a stand-in timmy. */
function launcher(): { dir: string; box: string } {
  const dir = mkdtempSync(join(tmpdir(), 'review-launcher-'));
  dirs.push(dir);
  copyFileSync(join(SRC, 'review.sh'), join(dir, 'review.sh'));
  chmodSync(join(dir, 'review.sh'), 0o755);
  cpSync(join(SRC, 'fake-lanes'), join(dir, 'fake-lanes'), { recursive: true });
  const box = join(dir, 'sandbox');
  const bin = join(box, 'prefix', 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(box, 'home', 'work'), { recursive: true });   // as ./review.sh install leaves it
  // the stand-in reports its node, and the first folder on its PATH holding a timmy and an opencode
  writeFileSync(join(bin, 'timmy'), `#!/usr/bin/env node
const { existsSync } = require('node:fs');
const first = (name) => (process.env.PATH || '').split(':').find((d) => existsSync(d + '/' + name)) || null;
console.log(JSON.stringify({ node: process.version, timmy: first('timmy'), opencode: first('opencode'), clef: process.env.TIMMY_CLEF ?? null, rerun: process.env.TIMMY_RERUN ?? null, logsOpen: process.env.TIMMY_LOGS_OPEN ?? null, args: process.argv.slice(2) }));
`);
  chmodSync(join(bin, 'timmy'), 0o755);
  return { dir, box };
}

const review = (dir: string, args: string[], path: string) =>
  spawnSync('bash', [join(dir, 'review.sh'), ...args], { cwd: dir, encoding: 'utf8', env: { PATH: path, HOME: dir, TIMMY_REVIEW_HOME: join(dir, 'sandbox') } });

describe('the review launcher runs Timmy on the node install used (R5 lead, the Mac walk at aa247e5)', () => {
  it('runs it on that node though an older one is first on the caller\'s PATH; a timmy or a lane program in the node\'s folder never wins', () => {
    const { dir, box } = launcher();
    // the node install used, in a folder that also holds another timmy and a real-looking lane program
    const nodeHome = join(dir, 'node24', 'bin');
    mkdirSync(nodeHome, { recursive: true });
    symlinkSync(process.execPath, join(nodeHome, 'node'));
    for (const name of ['timmy', 'opencode']) { writeFileSync(join(nodeHome, name), '#!/bin/sh\necho NOT-THE-REVIEW\n'); chmodSync(join(nodeHome, name), 0o755); }
    writeFileSync(join(box, 'node.path'), `${join(nodeHome, 'node')}\n`);
    // the caller's PATH: an older node first when this computer has one (as the Mac's pane had), else only the system's
    const callerPath = [...(OLD_NODE ? [join(OLD_NODE, '..')] : []), '/usr/bin', '/bin'].join(':');
    const r = review(dir, ['timmy', '--version'], callerPath);
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout.trim().split('\n').pop() as string) as { node: string; timmy: string; opencode: string };
    expect(seen.node).toBe(process.version);
    expect(seen.timmy).toBe(join(box, 'prefix', 'node_modules', '.bin'));
    expect(seen.opencode).toBe(join(dir, 'fake-lanes'));
    // where names it, and the shell's own node beside it
    const w = review(dir, ['where'], callerPath);
    expect(w.status).toBe(0);
    expect(w.stdout).toMatch(new RegExp(`^node {10}${join(nodeHome, 'node').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${process.version.replace('.', '\\.')}.*Timmy runs on it`, 'm'));
    expect(w.stdout).toMatch(/^shell's node {2}/m);
  });

  it('refuses, saying what to do, when install recorded no node, or one older than Node 24', () => {
    const { dir, box } = launcher();
    const none = review(dir, ['timmy', '--version'], `${join(process.execPath, '..')}:/usr/bin:/bin`);
    expect(none.status).toBe(3);
    expect(none.stderr).toMatch(/the node \.\/review\.sh install used is not recorded.*run \.\/review\.sh install again, with Node 24 or later first on PATH/);
    expect(none.stdout).toBe('');
    if (!OLD_NODE) return;   // no older node on this computer: the second half needs one
    writeFileSync(join(box, 'node.path'), `${OLD_NODE}\n`);
    const old = review(dir, ['workbench'], `${join(process.execPath, '..')}:/usr/bin:/bin`);
    expect(old.status).toBe(3);
    expect(old.stderr).toMatch(/is Node 2[0-3]\.[0-9.]+, older than the package asks \(Node 24 or later\)/);
    expect(old.stdout).toBe('');
  });

  // R9 lead, after the R9 independent review (its F3): the two settings Timmy's own help names for one process,
  // TIMMY_CLEF (decision-model routing) and TIMMY_RERUN (the Rerun CLI), reach Timmy through the launcher's env -i;
  // before, the launcher dropped both, and the reviewer had to set them inside ./review.sh shell
  it('passes TIMMY_CLEF and TIMMY_RERUN through when the caller sets them, and nothing when it does not', () => {
    const { dir, box } = launcher();
    writeFileSync(join(box, 'node.path'), `${process.execPath}\n`);
    const path = `${join(process.execPath, '..')}:/usr/bin:/bin`;
    const run = (extra: Record<string, string>) => spawnSync('bash', [join(dir, 'review.sh'), 'timmy', '--version'], { cwd: dir, encoding: 'utf8', env: { PATH: path, HOME: dir, TIMMY_REVIEW_HOME: join(dir, 'sandbox'), ...extra } });
    const seen = (r: ReturnType<typeof run>) => { expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout.trim().split('\n').pop() as string) as { clef: string | null; rerun: string | null }; };
    expect(seen(run({ TIMMY_CLEF: '1', TIMMY_RERUN: '/opt/FAKE/rerun' }))).toMatchObject({ clef: '1', rerun: '/opt/FAKE/rerun' });
    expect(seen(run({}))).toMatchObject({ clef: null, rerun: null });
  });

  // R13 (the operator's 15:31 order, item 6): ./timmy-app is the review's entry point, so its app case may open the browser;
  // the launcher set TIMMY_LOGS_OPEN=0 for every command, and `timmy app` then opened nothing while saying it had
  it('the app case lets Timmy open the browser (TIMMY_LOGS_OPEN=1); every other command keeps it off, whatever the caller set', () => {
    const { dir, box } = launcher();
    writeFileSync(join(box, 'node.path'), `${process.execPath}\n`);
    const path = `${join(process.execPath, '..')}:/usr/bin:/bin`;
    const run = (args: string[], extra: Record<string, string> = {}) => spawnSync('bash', [join(dir, 'review.sh'), ...args], { cwd: dir, encoding: 'utf8', env: { PATH: path, HOME: dir, TIMMY_REVIEW_HOME: join(dir, 'sandbox'), ...extra } });
    const seen = (r: ReturnType<typeof run>) => { expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout.trim().split('\n').pop() as string) as { logsOpen: string | null; args: string[] }; };
    expect(seen(run(['app']))).toMatchObject({ logsOpen: '1', args: ['app'] });
    expect(seen(run(['timmy', '--version']))).toMatchObject({ logsOpen: '0' });
    expect(seen(run(['timmy', '--version'], { REVIEW_OPENS_BROWSER: '1' }))).toMatchObject({ logsOpen: '0' });
  });
});
