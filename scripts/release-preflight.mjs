#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A negative any-character lookahead anchors the absolute end: JavaScript's
// `$` also matches immediately before a final newline.
const prereleaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)(?![\s\S])/;
const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Identity only: no Git, network, publication, or receipt effects. */
export function validateReleaseIdentity({ tag, version, lockVersion, lockRootVersion, channel = 'next' }) {
  if (typeof tag !== 'string' || !prereleaseTag.test(tag)) {
    throw new Error('Release tag must be exactly vX.Y.Z-rc.N with no leading zeroes.');
  }
  if (channel !== 'next') throw new Error('Only the next prerelease channel is authorized.');
  const expected = tag.slice(1);
  if (version !== expected || lockVersion !== expected || lockRootVersion !== expected) {
    throw new Error('Tag, package version, and both lockfile root versions must match exactly.');
  }
  return { version: expected, tag, channel: 'next' };
}

function gitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  // Resolve this checkout, not a different repository selected by inherited
  // plumbing overrides. Do not alter the caller's process environment.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete env[name];
  return env;
}

/** Read-only point-in-time gate. Workflow checkout/fetch owns remote freshness. */
export function releasePreflight({ cwd = process.cwd(), tag, channel = 'next', expectedCommit } = {}) {
  // Validate the ref spelling before it can become a Git argument.
  if (typeof tag !== 'string' || !prereleaseTag.test(tag)) {
    throw new Error('Release tag must be exactly vX.Y.Z-rc.N with no leading zeroes.');
  }
  if (channel !== 'next') throw new Error('Only the next prerelease channel is authorized.');
  if (expectedCommit !== undefined && (typeof expectedCommit !== 'string' || !commitId.test(expectedCommit))) {
    throw new Error('Expected commit must be a complete Git object ID.');
  }
  const root = realpathSync(cwd);
  const env = gitEnvironment();
  const git = (args, label, bytes = false) => {
    try {
      return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
        env, encoding: bytes ? undefined : 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Git diagnostics may contain private paths or configuration; do not
      // expose them as release metadata.
      throw new Error(`Release Git check failed: ${label}.`);
    }
  };
  const rootOutput = git(['rev-parse', '--show-toplevel'], 'repository root');
  if (realpathSync(rootOutput.endsWith('\n') ? rootOutput.slice(0, -1) : rootOutput) !== root) {
    throw new Error('Run release preflight from the repository root.');
  }
  const clean = () => {
    if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], 'clean checkout')) {
      throw new Error('Release checkout has tracked or nonignored untracked changes.');
    }
  };
  const revision = ref => {
    const value = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], 'resolve commit').trim();
    if (!commitId.test(value)) throw new Error('Git returned an invalid commit identity.');
    return value;
  };
  clean();
  const commit = revision('HEAD');
  git(['ls-files', '--error-unmatch', '--', 'package.json', 'package-lock.json'], 'tracked manifests');
  const manifest = name => {
    const path = resolve(root, name);
    if (!lstatSync(path).isFile()) throw new Error('Release manifests must be regular files.');
    const actual = readFileSync(path);
    const committed = git(['show', `${commit}:${name}`], 'committed manifest', true);
    if (!actual.equals(committed)) {
      throw new Error('Release manifest bytes differ from the checked-out commit.');
    }
    try { return JSON.parse(actual.toString('utf8')); }
    catch { throw new Error('Release manifest is not valid JSON.'); }
  };
  const pkg = manifest('package.json');
  const lock = manifest('package-lock.json');
  const identity = validateReleaseIdentity({ tag, channel, version: pkg?.version,
    lockVersion: lock?.version, lockRootVersion: lock?.packages?.['']?.version });
  const tagRef = `refs/tags/${tag}`;
  if (revision(tagRef) !== commit) throw new Error('Release tag does not identify the checked-out commit.');
  if (expectedCommit !== undefined && expectedCommit !== commit) {
    throw new Error('Release commit does not match the triggering event.');
  }
  const main = revision('refs/remotes/origin/main');
  git(['merge-base', '--is-ancestor', commit, main], 'release commit merged into origin/main');
  // Refuse a concurrent change during this gate. This is not a replacement
  // for protected tags or a fresh fetch in the publishing workflow.
  clean();
  if (revision('HEAD') !== commit || revision(tagRef) !== commit || revision('refs/remotes/origin/main') !== main) {
    throw new Error('Release references changed during preflight.');
  }
  return { version: identity.version, tag: identity.tag, commit, channel: identity.channel };
}

function cliOptions(argv, env) {
  const options = {};
  const names = new Map([['--tag', 'tag'], ['--channel', 'channel'], ['--expected-commit', 'expectedCommit']]);
  for (let i = 0; i < argv.length; i++) {
    const key = names.get(argv[i]);
    if (!key || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Expected --tag <tag>, --channel next, or --expected-commit <sha>; no duplicate options.');
    }
    options[key] = argv[++i];
  }
  if (!Object.hasOwn(options, 'tag')) {
    if (!env.GITHUB_REF?.startsWith('refs/tags/')) throw new Error('A tag ref or explicit --tag is required.');
    options.tag = env.GITHUB_REF.slice('refs/tags/'.length);
  }
  if (env.GITHUB_REF !== undefined && env.GITHUB_REF !== `refs/tags/${options.tag}`) {
    throw new Error('Explicit release tag must match the triggering tag ref.');
  }
  if (env.GITHUB_SHA && options.expectedCommit !== undefined && options.expectedCommit !== env.GITHUB_SHA) {
    throw new Error('Expected commit must match the triggering event.');
  }
  if (!Object.hasOwn(options, 'expectedCommit') && env.GITHUB_SHA) options.expectedCommit = env.GITHUB_SHA;
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(releasePreflight(cliOptions(process.argv.slice(2), process.env)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Release preflight refused.' })}\n`);
    process.exitCode = 1;
  }
}
