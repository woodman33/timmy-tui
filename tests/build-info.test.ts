// R10 (H163): which build of Timmy this is. Every build of 2.0.0-rc.2 said the same version, so the operator could not tell
// which revision he was running. A packed build now carries the git revision it was built from (dist/build-info.json, written
// by scripts/generate-version.ts when scripts/review/build-review.sh packs it), a run from source asks git, and neither ever
// invents one. buildInfo() is the one source for `timmy --version` and the Workbench's About/Diagnostics (H167).
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInfo, versionLine, type BuildInfo } from '../src/build-info.js';
import { LOGS_PORT } from '../src/utils/logserver.js';
import { generateBuildFiles } from '../scripts/generate-version.js';

const ROOT = join(__dirname, '..');
const git = (args: string[], cwd = ROOT): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'build-info-')); dirs.push(d); return d; };
const FULL = 'abc1234def5678901234567890abcdef12345678';

/** An installed package's layout: package.json, dist/src/build-info.js (where `here` points), and the stamp when given. */
function packed(stamp?: unknown): { here: string; root: string } {
  const root = temp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'timmy-tui', version: '9.9.9-test.0' }));
  mkdirSync(join(root, 'dist', 'src'), { recursive: true });
  if (stamp !== undefined) writeFileSync(join(root, 'dist', 'build-info.json'), typeof stamp === 'string' ? stamp : JSON.stringify(stamp));
  return { here: join(root, 'dist', 'src', 'build-info.js'), root };
}
const STAMP = { schema: 'timmy-build-info/1', version: '9.9.9-test.0', revision: FULL, branch: 'r10/test-branch', builtAt: '2026-10-22T11:50:00.000Z', dirty: false };

describe('buildInfo: a packed build says the revision it was built from (R10, H163)', () => {
  it('reads the stamp the build wrote: version, revision full and short, branch, when it was built', () => {
    const { here } = packed(STAMP);
    const b = buildInfo({ here, env: {} });
    expect(b).toMatchObject<Partial<BuildInfo>>({
      version: '9.9.9-test.0', source: 'packed', revision: { full: FULL, short: 'abc1234' }, branch: 'r10/test-branch',
      builtAt: '2026-10-22T11:50:00.000Z', dirty: false, reviewPackage: null, mismatch: null,
    });
    expect(b.revisionFrom).toBe('the build\'s own stamp (dist/build-info.json), written when it was packed');
    expect(versionLine(b)).toBe('timmy-tui v9.9.9-test.0 (revision abc1234)');
  });

  it('a build with no stamp, or a stamp it cannot read, says its revision is unknown; it never invents one', () => {
    const none = buildInfo({ here: packed().here, env: {} });
    expect(none).toMatchObject({ source: 'packed', revision: null, branch: null, builtAt: null, dirty: null });
    expect(none.revisionFrom).toMatch(/^unknown: this build carries no stamp \(dist\/build-info\.json\)/);
    expect(versionLine(none)).toBe('timmy-tui v9.9.9-test.0 (revision unknown)');
    for (const bad of ['{not json', JSON.stringify({ ...STAMP, revision: 'abc1234' }), JSON.stringify({ ...STAMP, schema: 'other' })]) {
      const b = buildInfo({ here: packed(bad).here, env: {} });
      expect(b.revision).toBeNull();
      expect(b.revisionFrom).toMatch(/^unknown: the build's stamp \(dist\/build-info\.json\) is not one this Timmy reads/);
    }
  });

  it('says both when the review package (TIMMY_REVIEW) and the build disagree, and nothing more when they agree', () => {
    const { here } = packed(STAMP);
    expect(buildInfo({ here, env: { TIMMY_REVIEW: 'abc1234' } })).toMatchObject({ reviewPackage: 'abc1234', mismatch: null });
    const off = buildInfo({ here, env: { TIMMY_REVIEW: '1234567' } });
    expect(off).toMatchObject({ reviewPackage: '1234567', mismatch: 'the review package says 1234567; this build says abc1234' });
    expect(versionLine(off)).toBe('timmy-tui v9.9.9-test.0 (revision abc1234; the review package says 1234567)');
    // a dev review box names its revision dev-<7 hex>
    expect(buildInfo({ here, env: { TIMMY_REVIEW: 'dev-abc1234' } }).mismatch).toBeNull();
    // with no revision, nothing to compare: the review package's word is kept, no mismatch is claimed
    expect(buildInfo({ here: packed().here, env: { TIMMY_REVIEW: '1234567' } })).toMatchObject({ reviewPackage: '1234567', mismatch: null });
  });

  it('a stamp made from a checkout with uncommitted changes says so', () => {
    const b = buildInfo({ here: packed({ ...STAMP, dirty: true }).here, env: {} });
    expect(b.dirty).toBe(true);
    expect(versionLine(b)).toBe('timmy-tui v9.9.9-test.0 (revision abc1234, built with uncommitted changes)');
  });
});

describe('buildInfo: a run from source asks git (R10, H163)', () => {
  it('names this checkout\'s revision and branch, and whether tracked files changed', () => {
    const b = buildInfo({ env: {} });
    const head = git(['rev-parse', 'HEAD']);
    expect(b.source).toBe('dev');
    expect(b.revision).toEqual({ full: head, short: head.slice(0, 7) });
    expect(b.branch).toBe(git(['branch', '--show-current']) || null);
    expect(b.dirty).toBe(git(['status', '--porcelain', '--untracked-files=no']) !== '');
    expect(b.builtAt).toBeNull();
    expect(b.revisionFrom).toBe('git, read from the checkout this runs from');
    expect(versionLine(b)).toBe(`timmy-tui v${b.version} (revision ${head.slice(0, 7)}${b.dirty ? ' and uncommitted changes' : ''}, from source)`);
  });

  it('outside a git checkout its revision is unknown, said so', () => {
    const root = temp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'timmy-tui', version: '9.9.9-test.0' }));
    mkdirSync(join(root, 'src'));
    const b = buildInfo({ here: join(root, 'src', 'build-info.ts'), env: { GIT_CEILING_DIRECTORIES: tmpdir() } });
    expect(b).toMatchObject({ source: 'dev', revision: null, branch: null, dirty: null, version: '9.9.9-test.0' });
    expect(b.revisionFrom).toMatch(/^unknown: git could not read the checkout this runs from/);
    expect(versionLine(b)).toBe('timmy-tui v9.9.9-test.0 (revision unknown, from source)');
  });
});

describe('buildInfo: where it runs (R10, H163)', () => {
  it('names the node, the Timmy home and the ports asked for, from the same rules Timmy uses', () => {
    const b = buildInfo({ env: { TIMMY_HOME: '/srv/review/timmy', TIMMY_STUDIO_PORT: '4470', TIMMY_LOGS_PORT: '4471', TIMMY_COMPANION_PORT: '4472' } });
    expect(b.node).toEqual({ version: process.version, path: process.execPath });
    expect(b.timmyHome).toBe('/srv/review/timmy');
    expect(b.ports).toEqual({ studio: 4470, logs: 4471, companion: 4472 });
    expect(buildInfo({ env: {} }).ports).toEqual({ studio: 4337, logs: 4310, companion: 3001 });
  });
  it('the logs port is the one the log companion takes (src/utils/logserver.ts LOGS_PORT), with and without TIMMY_LOGS_PORT', () => {
    const was = process.env.TIMMY_LOGS_PORT;
    try {
      for (const v of [undefined, '4471']) {
        if (v === undefined) delete process.env.TIMMY_LOGS_PORT; else process.env.TIMMY_LOGS_PORT = v;
        expect(buildInfo({ env: process.env }).ports.logs).toBe(LOGS_PORT());
      }
    } finally { if (was === undefined) delete process.env.TIMMY_LOGS_PORT; else process.env.TIMMY_LOGS_PORT = was; }
  });
});

describe('the build writes the stamp only for the revision it packs (scripts/generate-version.ts)', () => {
  /** a checkout of its own: package.json committed, src/ for version.ts */
  function checkout(): { root: string; head: string } {
    const root = temp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'timmy-tui', version: '9.9.9-test.0' }));
    mkdirSync(join(root, 'src'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'fake@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'fake@example.com' };
    for (const a of [['init', '-q', '-b', 'stamp-test'], ['add', 'package.json'], ['commit', '-q', '-m', 'one']]) execFileSync('git', a, { cwd: root, env });
    return { root, head: git(['rev-parse', 'HEAD'], root) };
  }

  it('TIMMY_BUILD_REVISION naming HEAD: dist/build-info.json with that revision, its branch, when, and a clean tree', () => {
    const { root, head } = checkout();
    const r = generateBuildFiles({ root, env: { TIMMY_BUILD_REVISION: head }, now: () => new Date('2026-10-22T11:55:00Z') });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, 'src', 'version.ts'), 'utf8')).toBe("// This file is generated automatically. Do not edit.\nexport const VERSION = '9.9.9-test.0';\n");
    expect(JSON.parse(readFileSync(join(root, 'dist', 'build-info.json'), 'utf8'))).toEqual({
      schema: 'timmy-build-info/1', version: '9.9.9-test.0', revision: head, branch: 'stamp-test', builtAt: '2026-10-22T11:55:00.000Z', dirty: false,
    });
    // and a packed layout reading it says that revision
    expect(buildInfo({ here: join(root, 'dist', 'src', 'build-info.js'), env: {} }).revision).toEqual({ full: head, short: head.slice(0, 7) });
  });

  it('without it (npm test, a plain build): version.ts only, and a stamp an earlier build left is removed', () => {
    const { root, head } = checkout();
    expect(generateBuildFiles({ root, env: { TIMMY_BUILD_REVISION: head } }).ok).toBe(true);
    const r = generateBuildFiles({ root, env: {} });
    expect(r).toMatchObject({ ok: true, stamp: 'removed' });
    expect(existsSync(join(root, 'dist', 'build-info.json'))).toBe(false);
    expect(existsSync(join(root, 'src', 'version.ts'))).toBe(true);
  });

  it('refuses (and writes no stamp) when TIMMY_BUILD_REVISION is not the checkout\'s HEAD', () => {
    const { root } = checkout();
    const r = generateBuildFiles({ root, env: { TIMMY_BUILD_REVISION: FULL } });
    expect(r.ok).toBe(false);
    expect(r.words).toMatch(/TIMMY_BUILD_REVISION is abc1234def5678901234567890abcdef12345678, but the checkout's HEAD is [0-9a-f]{40}: no stamp written/);
    expect(existsSync(join(root, 'dist', 'build-info.json'))).toBe(false);
  });

  it('build-review.sh packs with TIMMY_BUILD_REVISION set to HEAD, checks the tarball\'s stamp, and leaves no stamp in the checkout', () => {
    const build = readFileSync(join(ROOT, 'scripts', 'review', 'build-review.sh'), 'utf8');
    expect(build).toMatch(/TIMMY_BUILD_REVISION="\$revfull" npm pack/);
    expect(build).toMatch(/tar -xzOf "\$pkg\/\$tgz" package\/dist\/build-info\.json/);
    expect(build).toMatch(/rm -f "\$root\/dist\/build-info\.json"/);
  });
});

describe('timmy --version prints the version and the revision (R10, H163)', () => {
  const tsx = createRequire(import.meta.url).resolve('tsx');
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['--import', tsx, join(ROOT, 'timmy.ts'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, TIMMY_BIN_DRY_RUN: '', ...env } });
  it('from source: this checkout\'s revision, said to be from source; TIMMY_REVIEW that differs is named beside it', () => {
    const head = git(['rev-parse', '--short=7', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';
    const r = run(['--version']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^timmy-tui v\\S+ \\(revision ${head}${dirty ? ' and uncommitted changes' : ''}, from source\\)\\n$`));
    const off = run(['version'], { TIMMY_REVIEW: head === '0000000' ? '1111111' : '0000000' });
    expect(off.stdout).toMatch(/; the review package says (0000000|1111111)\)\n$/);
  }, 60_000);
});
