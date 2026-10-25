/**
 * R10 (H163): which build of Timmy this is, and where it runs. Every build of a release candidate said the same version
 * (2.0.0-rc.2), so the operator could not tell which revision he was running. buildInfo() is the one source for
 * `timmy --version` (timmy.ts, src/cli.ts) and the Workbench's About/Diagnostics view.
 *
 * - A packed build carries the git revision it was built from in dist/build-info.json, written by scripts/generate-version.ts
 *   when scripts/review/build-review.sh packs it (TIMMY_BUILD_REVISION names the checkout's HEAD, which is checked). A build
 *   with no stamp, or a stamp this module does not read, says its revision is unknown.
 * - A run from source (src/*.ts through tsx) asks git for the checkout it runs from, when git can say; else it is unknown.
 * - It never invents a revision. When the review launcher's TIMMY_REVIEW names another revision than the build's, both are
 *   said (mismatch).
 *
 * It uses node's own modules and three small rules of Timmy's (the Timmy home, the Studio port, the companion's port), so the
 * bin can load it for its version line alone. git is asked at most once per process and checkout, each call bounded.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askedCompanionPort } from './setup/companion-port.js';
import { timmyHome } from './setup/home.js';
import { studioPort } from './studio/config.js';
import { VERSION } from './version.js';

type Env = Record<string, string | undefined>;

/** What the build writes into dist/build-info.json (scripts/generate-version.ts). */
export interface BuildStamp {
  schema: 'timmy-build-info/1';
  version: string;
  /** the full 40-hex revision of the checkout that was packed */
  revision: string;
  branch: string | null;
  builtAt: string;
  /** tracked files differed from that revision when it was built */
  dirty: boolean;
}
export const STAMP_SCHEMA = 'timmy-build-info/1';
/** Where the stamp is, relative to the package's root. */
export const STAMP_PATH = 'dist/build-info.json';

export interface BuildInfo {
  /** the package's version (its package.json; else the version compiled in) */
  version: string;
  /** the git revision this build was made from (packed) or this checkout is at (from source); null when unknown */
  revision: { full: string; short: string } | null;
  /** where the revision was read, or why it is unknown, in words */
  revisionFrom: string;
  /** tracked files differed from that revision, when it was built (packed) or now (from source); null when unknown */
  dirty: boolean | null;
  branch: string | null;
  /** when it was built (packed); null from source, or when unknown */
  builtAt: string | null;
  /** packed: compiled JavaScript (an installed package, or a build); dev: TypeScript source run through tsx */
  source: 'packed' | 'dev';
  node: { version: string; path: string };
  timmyHome: string;
  /** the ports Timmy asks for here (TIMMY_STUDIO_PORT, TIMMY_LOGS_PORT, TIMMY_COMPANION_PORT, else their defaults) */
  ports: { studio: number; logs: number; companion: number };
  /** TIMMY_REVIEW, which the review launcher sets to its package's revision; null when not set */
  reviewPackage: string | null;
  /** when TIMMY_REVIEW names another revision than this build's: both, in words; else null */
  mismatch: string | null;
}

/** The log companion's port: src/utils/logserver.ts LOGS_PORT's rule, for a given environment (a test keeps the two together). */
export const logsPort = (env: Env): number => Number(env.TIMMY_LOGS_PORT ?? 4310);

const HEX40 = /^[0-9a-f]{40}$/;

/** A stamp as this module reads it, or why it is not one. */
export function parseStamp(text: string): { ok: true; stamp: BuildStamp } | { ok: false; why: string } {
  let s: Partial<BuildStamp>;
  try { s = JSON.parse(text) as Partial<BuildStamp>; } catch { return { ok: false, why: 'it is not JSON' }; }
  if (!s || typeof s !== 'object' || s.schema !== STAMP_SCHEMA) return { ok: false, why: `its schema is not ${STAMP_SCHEMA}` };
  if (typeof s.revision !== 'string' || !HEX40.test(s.revision)) return { ok: false, why: 'its revision is not a full 40-hex git revision' };
  if (typeof s.version !== 'string' || typeof s.builtAt !== 'string' || typeof s.dirty !== 'boolean' || (s.branch !== null && typeof s.branch !== 'string')) {
    return { ok: false, why: 'a field is missing or of another kind' };
  }
  return { ok: true, stamp: s as BuildStamp };
}

const gitAnswers = new Map<string, { full: string; branch: string | null; dirty: boolean } | { why: string }>();

/** The checkout at `root`: its HEAD, branch and whether tracked files changed; or why git could not say. Asked once per root. */
function gitAt(root: string, env: Env): { full: string; branch: string | null; dirty: boolean } | { why: string } {
  const known = gitAnswers.get(root);
  if (known) return known;
  const ask = (args: string[]): string => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'], env: env as NodeJS.ProcessEnv,
  }).trim();
  let answer: { full: string; branch: string | null; dirty: boolean } | { why: string };
  try {
    const full = ask(['rev-parse', 'HEAD']);
    if (!HEX40.test(full)) throw new Error(`git rev-parse said ${JSON.stringify(full.slice(0, 60))}`);
    let branch: string | null = null;
    try { branch = ask(['branch', '--show-current']) || null; } catch { branch = null; }
    let dirty = false;
    try { dirty = ask(['status', '--porcelain', '--untracked-files=no']) !== ''; } catch { dirty = false; }
    answer = { full, branch, dirty };
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: string };
    const why = err.code === 'ENOENT' ? 'git is not on PATH' : String(err.stderr || err.message || e).trim().split('\n')[0].slice(0, 160);
    answer = { why };
  }
  gitAnswers.set(root, answer);
  return answer;
}

/** The package's version from its package.json at `root` (a timmy-tui one), else the version compiled in. */
function packageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (pkg.name === 'timmy-tui' && typeof pkg.version === 'string') return pkg.version;
  } catch { /* none here */ }
  return VERSION;
}

/**
 * Which build this is and where it runs. `here` is this module's own file (a test names another layout); `env` the
 * environment whose Timmy home, ports and TIMMY_REVIEW are read.
 */
export function buildInfo(o: { here?: string; env?: Env } = {}): BuildInfo {
  const env = o.env ?? process.env;
  const here = o.here ?? fileURLToPath(import.meta.url);
  const source: BuildInfo['source'] = here.endsWith('.ts') ? 'dev' : 'packed';
  // the package's root: src/.. from source; dist/src/../.. in a build
  const root = source === 'dev' ? join(dirname(here), '..') : join(dirname(here), '..', '..');
  const version = packageVersion(root);

  let revision: BuildInfo['revision'] = null;
  let revisionFrom: string;
  let dirty: boolean | null = null;
  let branch: string | null = null;
  let builtAt: string | null = null;
  if (source === 'packed') {
    let text: string | null = null;
    try { text = readFileSync(join(root, STAMP_PATH), 'utf8'); } catch { text = null; }
    if (text === null) {
      revisionFrom = `unknown: this build carries no stamp (${STAMP_PATH}); only a build packed by scripts/review/build-review.sh carries one`;
    } else {
      const p = parseStamp(text);
      if (p.ok) {
        revision = { full: p.stamp.revision, short: p.stamp.revision.slice(0, 7) };
        dirty = p.stamp.dirty;
        branch = p.stamp.branch;
        builtAt = p.stamp.builtAt;
        revisionFrom = `the build's own stamp (${STAMP_PATH}), written when it was packed`;
      } else {
        revisionFrom = `unknown: the build's stamp (${STAMP_PATH}) is not one this Timmy reads (${p.why})`;
      }
    }
  } else {
    const g = gitAt(root, env);
    if ('full' in g) {
      revision = { full: g.full, short: g.full.slice(0, 7) };
      dirty = g.dirty;
      branch = g.branch;
      revisionFrom = 'git, read from the checkout this runs from';
    } else {
      revisionFrom = `unknown: git could not read the checkout this runs from (${g.why})`;
    }
  }

  const reviewPackage = env.TIMMY_REVIEW?.trim() || null;
  let mismatch: string | null = null;
  if (reviewPackage && revision) {
    const said = /^(?:dev-)?([0-9a-f]{7,40})$/.exec(reviewPackage)?.[1];
    if (!said || !revision.full.startsWith(said)) mismatch = `the review package says ${reviewPackage}; this build says ${revision.short}`;
  }

  return {
    version, revision, revisionFrom, dirty, branch, builtAt, source,
    node: { version: process.version, path: process.execPath },
    timmyHome: timmyHome(env),
    ports: { studio: studioPort(env), logs: logsPort(env), companion: askedCompanionPort([], env) },
    reviewPackage, mismatch,
  };
}

/**
 * `timmy --version`'s line: "timmy-tui v<version> (revision <7 hex>)" for a packed build, with what else is true of it:
 * "built with uncommitted changes", "from source" (and "and uncommitted changes"), "revision unknown", and the review
 * package's revision when it differs.
 */
export function versionLine(b: BuildInfo): string {
  const parts: string[] = [];
  if (!b.revision) parts.push('revision unknown');
  else if (b.source === 'dev') parts.push(`revision ${b.revision.short}${b.dirty ? ' and uncommitted changes' : ''}`);
  else parts.push(`revision ${b.revision.short}${b.dirty ? ', built with uncommitted changes' : ''}`);
  if (b.source === 'dev') parts.push('from source');
  const tail = b.mismatch ? `; ${b.mismatch.replace(/; this build says [0-9a-f]+$/, '')}` : '';
  return `timmy-tui v${b.version} (${parts.join(', ')}${tail})`;
}
