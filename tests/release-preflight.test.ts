import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The release guard is executable directly by Node without a build/TS loader.
// @ts-expect-error plain Node ESM intentionally has no declaration companion
import { releasePreflight, validateReleaseIdentity } from '../scripts/release-preflight.mjs';

const tag = 'v1.2.3-rc.1';
const version = '1.2.3-rc.1';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo() {
  // Metacharacters and spaces must remain literal path bytes, never shell code.
  const root = mkdtempSync(join(tmpdir(), 'release $(literal) `path` '));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Release Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Release Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'release-fixture', version }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'release-fixture', version, lockfileVersion: 3, packages: { '': { name: 'release-fixture', version } } }));
  writeFileSync(join(root, '.gitignore'), 'ignored-output/\n');
  git('add', '--', 'package.json', 'package-lock.json', '.gitignore');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'release fixture');
  const commit = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', commit);
  git('tag', tag);
  return { root, git, commit, check: (extra = {}) => releasePreflight({ cwd: root, tag, ...extra }) };
}

describe('release identity', () => {
  const valid = { tag, version, lockVersion: version, lockRootVersion: version };
  it('allows only matching release-candidate identities on next', () => {
    expect(validateReleaseIdentity(valid)).toEqual({ tag, version, channel: 'next' });
  });
  it.each(['v1.2.3', '1.2.3-rc.1', 'v01.2.3-rc.1', 'v1.2.3-rc.01', 'v1.2.3-beta.1', 'v1.2.3-rc.1+build', 'v1.2.3-rc.1\n', '--help', '$(touch marker)'])('refuses noncanonical tag %j', bad => {
    expect(() => validateReleaseIdentity({ ...valid, tag: bad })).toThrow();
  });
  it.each(['version', 'lockVersion', 'lockRootVersion'])('requires exact %s', field => {
    expect(() => validateReleaseIdentity({ ...valid, [field]: '1.2.2-rc.1' })).toThrow(/match exactly/);
  });
  it.each(['latest', 'stable', '', null])('refuses unauthorized channel %j', channel => {
    expect(() => validateReleaseIdentity({ ...valid, channel })).toThrow(/next/);
  });
});

describe('release Git preflight', () => {
  it('passes a clean merged tag, preserving files and arbitrary path characters', () => {
    const fixture = repo();
    const before = readFileSync(join(fixture.root, 'package.json'));
    expect(fixture.check({ expectedCommit: fixture.commit })).toEqual({ version, tag, commit: fixture.commit, channel: 'next' });
    expect(readFileSync(join(fixture.root, 'package.json'))).toEqual(before);
    expect(fixture.git('status', '--porcelain')).toBe('');
  });

  it('accepts an annotated tag by its commit identity', () => {
    const fixture = repo();
    fixture.git('tag', '-d', tag);
    fixture.git('tag', '-a', tag, '-m', 'release candidate');
    expect(fixture.check().commit).toBe(fixture.commit);
  });

  it('allows ignored local outputs without treating them as publication inputs', () => {
    const fixture = repo();
    mkdirSync(join(fixture.root, 'ignored-output'));
    writeFileSync(join(fixture.root, 'ignored-output', 'diagnostic.txt'), 'ignored fixture');
    expect(fixture.check().commit).toBe(fixture.commit);
  });

  it('refuses an unmerged release even when its version and tag match', () => {
    const fixture = repo();
    fixture.git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'unmerged');
    fixture.git('tag', '-f', tag);
    expect(() => fixture.check()).toThrow(/merged into origin\/main/);
  });

  it('refuses a tag moved to a different head and a stale triggering event', () => {
    const fixture = repo();
    fixture.git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'second head');
    const second = fixture.git('rev-parse', 'HEAD');
    fixture.git('update-ref', 'refs/remotes/origin/main', second);
    expect(() => fixture.check()).toThrow(/tag does not identify/);
    fixture.git('tag', '-f', tag);
    expect(() => fixture.check({ expectedCommit: fixture.commit })).toThrow(/triggering event/);
    fixture.git('checkout', '--detach', fixture.commit);
    expect(() => fixture.check()).toThrow(/tag does not identify/);
  });

  it.each(['tracked', 'staged', 'untracked'])('refuses a %s change', state => {
    const fixture = repo();
    if (state === 'untracked') writeFileSync(join(fixture.root, 'not-ignored.txt'), 'untracked');
    else {
      writeFileSync(join(fixture.root, '.gitignore'), 'changed\n');
      if (state === 'staged') fixture.git('add', '--', '.gitignore');
    }
    expect(() => fixture.check()).toThrow(/changes/);
  });

  it('refuses absent tags or absent origin/main', () => {
    const fixture = repo();
    expect(() => fixture.check({ tag: 'v1.2.3-rc.2' })).toThrow(/match exactly/);
    fixture.git('tag', '-d', tag);
    expect(() => fixture.check()).toThrow(/resolve commit/);
    fixture.git('tag', tag);
    fixture.git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(() => fixture.check()).toThrow(/resolve commit/);
  });

  it('refuses committed manifest disagreement', () => {
    const fixture = repo();
    writeFileSync(join(fixture.root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version: '1.2.3-rc.2' } } }));
    fixture.git('add', '--', 'package-lock.json');
    fixture.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'mismatching manifest');
    fixture.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    fixture.git('tag', '-f', tag);
    expect(() => fixture.check()).toThrow(/match exactly/);
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('refuses manifest bytes hidden by %s', flag => {
    const fixture = repo();
    fixture.git('update-index', flag, '--', 'package.json', 'package-lock.json');
    const changed = '1.2.3-rc.2';
    writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({ name: 'release-fixture', version: changed }));
    writeFileSync(join(fixture.root, 'package-lock.json'), JSON.stringify({ version: changed, packages: { '': { version: changed } } }));
    fixture.git('tag', `v${changed}`);
    expect(fixture.git('status', '--porcelain')).toBe('');
    expect(() => fixture.check({ tag: `v${changed}` })).toThrow(/manifest bytes differ/);
  });

  it('emits only the approved machine identity on CLI success and refuses branch events', () => {
    const fixture = repo();
    const script = fileURLToPath(new URL('../scripts/release-preflight.mjs', import.meta.url));
    const env = { ...process.env, GITHUB_REF: `refs/tags/${tag}`, GITHUB_SHA: fixture.commit };
    const passed = spawnSync(process.execPath, [script], { cwd: fixture.root, env, encoding: 'utf8' });
    expect(passed.status, passed.stderr).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual({ version, tag, commit: fixture.commit, channel: 'next' });
    expect(passed.stderr).toBe('');
    const refused = spawnSync(process.execPath, [script], { cwd: fixture.root, env: { ...env, GITHUB_REF: 'refs/heads/main' }, encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    expect(JSON.parse(refused.stderr)).toMatchObject({ ok: false });
    const mismatch = spawnSync(process.execPath, [script, '--tag', tag], {
      cwd: fixture.root, env: { ...env, GITHUB_REF: 'refs/tags/v9.9.9-rc.1' }, encoding: 'utf8',
    });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toBe('');
    expect(JSON.parse(mismatch.stderr).error).toContain('triggering tag ref');
    for (const args of [['constructor', 'ignored'], ['--channel', 'latest'], ['--tag', tag, '--tag', tag]]) {
      const invalid = spawnSync(process.execPath, [script, ...args], { cwd: fixture.root, env, encoding: 'utf8' });
      expect(invalid.status, invalid.stderr).toBe(1);
      expect(invalid.stdout).toBe('');
    }
  });
});
