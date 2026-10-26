// R10 (H163): the review candidate opens with ONE command, ./timmy-review, a name no one can take for the installed `timmy`.
// The operator typed `timmy` and got his protected global install (an older release candidate); his Mac's first node on PATH
// is Node 22, so ./review.sh install refused there. Here the launcher is filled as scripts/review/build-review.sh fills it and
// copied into a temporary package folder beside a stand-in review.sh, which notes each command it is given (and the node
// first on its PATH) instead of installing anything: no npm, no network, nothing outside the temporary folders.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SRC = join(__dirname, '..', 'scripts', 'review');
const OLD_NODE = ['/opt/node22/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p) && Number(spawnSync(p, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).stdout.trim()) < 24);
const REV = 'abc1234';
const REVFULL = 'abc1234def5678901234567890abcdef12345678';
const BRANCH = 'r10/test-branch';
const TGZ = 'timmy-tui-9.9.9-test.0.tgz';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (name: string): string => { const d = mkdtempSync(join(tmpdir(), name)); dirs.push(d); return d; };

/** The stand-in review.sh: notes each command and the node first on its PATH; install and demo leave what the real ones leave. */
const STUB = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd -P)
n=$(command -v node || echo none)
printf '%s node=%s\\n' "$*" "$n" >> "$here/calls.log"
case "$1" in
  install) mkdir -p "$here/sandbox/prefix/node_modules/.bin" && printf '#!/bin/sh\\necho stand-in\\n' > "$here/sandbox/prefix/node_modules/.bin/timmy" && chmod +x "$here/sandbox/prefix/node_modules/.bin/timmy" && printf '%s\\n' "$n" > "$here/sandbox/node.path" ;;
  demo) t="$here/sandbox/home"; t="$t/timmy"; mkdir -p "$t/state" "$t/projects/tray" && echo '{}' > "$t/identity.json" && printf '{"root": "%s"}\\n' "$t/projects/tray" > "$t/state/active-project.json" ;;
  workbench) echo "STAND-IN WORKBENCH OPENED" ;;
  timmy) echo "timmy-tui 9.9.9-test.0 (revision ${REV})" ;;
esac
`;

const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

/** A package folder as the build makes it: the filled launcher, the stand-in review.sh, the package file, SHA256SUMS. */
function pkg(): string {
  const dir = temp('timmy-review-one-');
  const filled = readFileSync(join(SRC, 'timmy-review'), 'utf8')
    .replaceAll('__REVFULL__', REVFULL).replaceAll('__REV__', REV).replaceAll('__TGZ__', TGZ).replaceAll('__BRANCH__', BRANCH);
  writeFileSync(join(dir, 'timmy-review'), filled, { mode: 0o755 });
  writeFileSync(join(dir, 'review.sh'), STUB, { mode: 0o755 });
  writeFileSync(join(dir, TGZ), 'a stand-in for the packed Timmy\n');
  writeFileSync(join(dir, 'SHA256SUMS'), ['review.sh', 'timmy-review', TGZ].map((f) => `${sha(join(dir, f))}  ${f}\n`).join(''));
  return dir;
}

/** A folder holding `node`: a link to this test's own node (Node 24 or later), or a stand-in that only says its version. */
function nodeDir(kind: 'real' | string): string {
  const d = join(temp('timmy-review-node-'), 'bin');
  mkdirSync(d, { recursive: true });
  if (kind === 'real') symlinkSync(process.execPath, join(d, 'node'));
  else writeFileSync(join(d, 'node'), `#!/bin/sh\n[ "$1" = --version ] && echo ${kind}\n`, { mode: 0o755 });
  return d;
}

const launch = (dir: string, args: string[], env: Record<string, string>) =>
  spawnSync(join(dir, 'timmy-review'), args, { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { HOME: temp('timmy-review-home-'), ...env } });
const calls = (dir: string): string[] => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n') : []);
const SYS = '/usr/bin:/bin';

describe('./timmy-review: the candidate in one command (R10, H163)', () => {
  it('says first, in one line, what it is; on its first run checks SHA256SUMS, installs, seeds the demo, then opens the Workbench', () => {
    const dir = pkg();
    const n24 = nodeDir('real');
    const r = launch(dir, [], { PATH: [...(OLD_NODE ? [dirname(OLD_NODE)] : []), n24, SYS].join(':') });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe(`Timmy review candidate ${REV} (${BRANCH}), in its own sandbox; your installed timmy is not used or changed`);
    // the node: the first Node 24 or later on PATH, though an older one comes first (as on the operator's Mac)
    expect(r.stdout).toContain(`Node: ${join(n24, 'node')} (${process.version}), the first Node 24 or later on your PATH`);
    if (OLD_NODE) expect(r.stdout).toMatch(new RegExp(`your PATH's first node, ${dirname(OLD_NODE).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/node, is v2[0-3]\\.[0-9.]+ and is not used`));
    expect(r.stdout).toMatch(/SHA256SUMS: the 3 files it lists match/);
    expect(r.stdout).toContain('STAND-IN WORKBENCH OPENED');
    expect(r.stdout).toMatch(/Opening the Workbench on tray/);
    // install ran with that node first on its PATH; then the demo; then the Workbench
    expect(calls(dir)).toEqual([`install node=${join(n24, 'node')}`, `demo node=${join(n24, 'node')}`, `workbench node=${join(n24, 'node')}`]);
  });

  // R12: ./timmy-app (and its double-click twin, Timmy App.command) make the same first run, then open the app, not the Workbench
  it('./timmy-app and Timmy App.command: the same first run, then the Timmy app (./review.sh app) instead of the Workbench', () => {
    const dir = pkg();
    for (const f of ['timmy-app', 'Timmy App.command']) writeFileSync(join(dir, f), readFileSync(join(SRC, f), 'utf8'), { mode: 0o755 });
    const n24 = nodeDir('real');
    const r = spawnSync(join(dir, 'Timmy App.command'), [], { cwd: temp('timmy-app-cwd-'), encoding: 'utf8', timeout: 30_000, env: { HOME: temp('timmy-review-home-'), PATH: `${n24}:${SYS}` } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')[0]).toMatch(/^Timmy review candidate abc1234 /);
    expect(r.stdout).toMatch(/Opening the Timmy app on tray in your browser/);
    expect(r.stdout).not.toContain('STAND-IN WORKBENCH OPENED');
    expect(calls(dir)).toEqual([`install node=${join(n24, 'node')}`, `demo node=${join(n24, 'node')}`, `app node=${join(n24, 'node')}`]);
    const again = spawnSync(join(dir, 'timmy-app'), ['--version'], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { HOME: temp('timmy-review-home-'), PATH: `${n24}:${SYS}` } });
    expect(again.stdout.trim()).toBe(`Timmy review candidate ${REV} (${BRANCH}): timmy-tui 9.9.9-test.0, revision ${REVFULL}`);
  });

  it('later runs skip the install and the demo, say so in one line, and open the Workbench on the node the first run used', () => {
    const dir = pkg();
    const n24 = nodeDir('real');
    expect(launch(dir, [], { PATH: `${n24}:${SYS}` }).status).toBe(0);
    const again = launch(dir, [], { PATH: `${n24}:${SYS}` });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout.split('\n')[0]).toMatch(/^Timmy review candidate abc1234 /);
    expect(again.stdout.match(/^.*skips the install and the demo.*$/gm)).toHaveLength(1);
    expect(again.stdout).toContain(`Node: ${join(n24, 'node')} (${process.version}), the one the first run installed with`);
    expect(again.stdout).not.toMatch(/SHA256SUMS/);
    expect(calls(dir).slice(3)).toEqual([`workbench node=${join(n24, 'node')}`]);
  });

  it('names the installed timmy on PATH, from its path and its package.json, and never runs it', () => {
    const dir = pkg();
    const g = temp('timmy-review-global-');
    const pkgDir = join(g, 'lib', 'node_modules', 'timmy-tui');
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'timmy-tui', version: '2.0.0-rc.1', bin: { timmy: 'dist/timmy.js' } }, null, 2));
    writeFileSync(join(pkgDir, 'dist', 'timmy.js'), `#!/bin/sh\ntouch ${JSON.stringify(join(g, 'RAN'))}\n`, { mode: 0o755 });
    mkdirSync(join(g, 'bin'));
    symlinkSync('../lib/node_modules/timmy-tui/dist/timmy.js', join(g, 'bin', 'timmy'));
    const r = launch(dir, [], { PATH: `${join(g, 'bin')}:${nodeDir('real')}:${SYS}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')[1]).toBe(`Your installed timmy: ${join(g, 'bin', 'timmy')} (timmy-tui 2.0.0-rc.1, read from its package.json; not run)`);
    expect(existsSync(join(g, 'RAN'))).toBe(false);
    // and the Workbench opened is the candidate's (the stand-in review.sh), not the installed one
    expect(calls(dir).at(-1)).toMatch(/^workbench /);
  });

  it('TIMMY_NODE wins when it is Node 24 or later; when it is older, one clear line refuses and nothing is installed', () => {
    const dir = pkg();
    const n24 = nodeDir('real');
    const r = launch(dir, [], { PATH: SYS, TIMMY_NODE: join(n24, 'node') });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Node: ${join(n24, 'node')} (${process.version}), named by TIMMY_NODE`);
    const dir2 = pkg();
    const old = nodeDir('v22.9.0');
    const refused = launch(dir2, [], { PATH: `${n24}:${SYS}`, TIMMY_NODE: join(old, 'node') });
    expect(refused.status).toBe(3);
    expect(refused.stderr.trim().split('\n')).toHaveLength(1);
    expect(refused.stderr).toContain(`TIMMY_NODE is ${join(old, 'node')}, which is Node 22.9.0: the candidate needs Node 24 or later`);
    expect(calls(dir2)).toEqual([]);
  });

  it('finds the newest Node 24 or later under ~/.nvm when no node on PATH is one', () => {
    const dir = pkg();
    const home = temp('timmy-review-nvm-');
    for (const [v, kind] of [['v22.9.0', 'v22.9.0'], ['v24.1.0', 'real'], ['v26.0.0', 'v26.0.0']]) {
      const bin = join(home, '.nvm', 'versions', 'node', v, 'bin');
      mkdirSync(bin, { recursive: true });
      if (kind === 'real') symlinkSync(process.execPath, join(bin, 'node'));
      else writeFileSync(join(bin, 'node'), `#!/bin/sh\n[ "$1" = --version ] && echo ${kind}\n`, { mode: 0o755 });
    }
    const r = launch(dir, [], { PATH: SYS, HOME: home });
    expect(r.status, r.stderr).toBe(0);
    const n26 = join(home, '.nvm', 'versions', 'node', 'v26.0.0', 'bin', 'node');
    expect(r.stdout).toContain(`Node: ${n26} (v26.0.0), the newest Node 24 or later under ~/.nvm/versions/node`);
    expect(calls(dir)[0]).toBe(`install node=${n26}`);
  });

  it('refuses with one clear line when there is no Node 24 or later anywhere it looks', () => {
    const dir = pkg();
    const r = launch(dir, [], { PATH: [...(OLD_NODE ? [dirname(OLD_NODE)] : []), SYS].join(':') });
    expect(r.status).toBe(3);
    const err = r.stderr.trim().split('\n');
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^timmy-review: no Node 24 or later found \(it looked at TIMMY_NODE, every node on your PATH, \/opt\/homebrew\/bin\/node, \/usr\/local\/bin\/node and ~\/\.nvm\/versions\/node\b.*\): install Node 24 or later, or set TIMMY_NODE to one$/);
    if (OLD_NODE) expect(err[0]).toContain(`${OLD_NODE} is v22`);
    expect(r.stdout.split('\n')[0]).toMatch(/^Timmy review candidate abc1234 /);
    expect(calls(dir)).toEqual([]);
  });

  it('refuses before installing when a file does not match SHA256SUMS, and names it', () => {
    const dir = pkg();
    writeFileSync(join(dir, 'review.sh'), `${STUB}# changed after the build\n`, { mode: 0o755 });
    const r = launch(dir, [], { PATH: `${nodeDir('real')}:${SYS}` });
    expect(r.status).toBe(4);
    expect(r.stderr.trim()).toMatch(/^timmy-review: SHA256SUMS: 1 of its 3 files does not match \(review\.sh\): this package is not as it was built; get it again$/);
    expect(calls(dir)).toEqual([]);
    expect(existsSync(join(dir, 'sandbox'))).toBe(false);
  });

  it('--version and about print the candidate\'s version and revision and open nothing', () => {
    const dir = pkg();
    const v = launch(dir, ['--version'], { PATH: SYS });
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout).toBe(`Timmy review candidate ${REV} (${BRANCH}): timmy-tui 9.9.9-test.0, revision ${REVFULL}\n`);
    const a = launch(dir, ['about'], { PATH: SYS });
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout.split('\n')[0]).toBe(`Timmy review candidate ${REV} (${BRANCH}): timmy-tui 9.9.9-test.0, revision ${REVFULL}`);
    expect(a.stdout).toMatch(/^ {2}installed in .*sandbox: not yet \(\.\/timmy-review installs it on its first run\)$/m);
    expect(calls(dir)).toEqual([]);
    expect(existsSync(join(dir, 'sandbox'))).toBe(false);
    // once installed, about also says what the installed build says of itself (its own timmy --version)
    expect(launch(dir, [], { PATH: `${nodeDir('real')}:${SYS}` }).status).toBe(0);
    const after = launch(dir, ['about'], { PATH: SYS });
    expect(after.stdout).toMatch(/^ {2}the installed build says: timmy-tui 9\.9\.9-test\.0 \(revision abc1234\)$/m);
    expect(calls(dir).at(-1)).toMatch(/^timmy --version /);
  });

  it('refuses an argument it does not take, naming where the other commands are', () => {
    const r = launch(pkg(), ['demo'], { PATH: SYS });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe('timmy-review: it takes no "demo": ./timmy-review opens the Workbench (--version, about, --help); the other commands are ./review.sh help');
  });
});

describe('the package carries the launcher and says it first (R10, H163)', () => {
  const build = readFileSync(join(SRC, 'build-review.sh'), 'utf8');
  const readme = readFileSync(join(SRC, 'README.md'), 'utf8');
  it('the build fills ./timmy-review and makes it executable, before SHA256SUMS is made', () => {
    expect(build).toMatch(/fill scripts\/review\/timmy-review "\$pkg\/timmy-review"/);
    expect(build).toMatch(/chmod \+x "\$pkg\/review\.sh" "\$pkg\/timmy-review"/);
    expect(build.indexOf('fill scripts/review/timmy-review')).toBeLessThan(build.indexOf('SHA256SUMS.$rev.tmp'));
    expect(build).toMatch(/-e "s\/__REVFULL__\/\$revfull\/g"/);
  });
  it('the README\'s first words are the one command, and that `timmy` alone is the installed one', () => {
    const body = readme.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(body[0]).toMatch(/^\*\*One command:\*\* `\.\/timmy-review`/);
    expect(readme.replace(/\n\s*/g, ' ')).toMatch(/`timmy` alone is your installed timmy, not this candidate/);
  });
});
