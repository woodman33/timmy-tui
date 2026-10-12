// Timmy's inventory (round R4, helper H106): shared helpers. Everything here reads; nothing writes or runs anything
// but read-only git commands (rev-parse, ls-files, log, status, cat-file, merge-base, show).
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

/** POSIX form of a path relative to the root (the only form a path may take in the output). */
export const rel = (root, abs) => relative(root, abs).split(sep).join('/');

export function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

export function readJson(path) {
  const t = readText(path);
  if (t === null) return { ok: false, why: 'not found' };
  try { return { ok: true, value: JSON.parse(t) }; } catch (e) { return { ok: false, why: `not valid JSON (${e instanceof Error ? e.message.split('\n')[0] : String(e)})` }; }
}

export function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** A read-only git command in the root; null when git is absent, the root is not a work tree, or the command fails. */
export function git(root, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
  } catch {
    return null;
  }
}

/** The generator's own outputs: a change to them is not a change to what it reads. */
export const OUTPUTS = ['docs/ui-cockpit/INVENTORY.md', 'docs/ui-cockpit/inventory/sbom.json', 'docs/ui-cockpit/inventory/features.json', 'docs/ui-cockpit/CAPABILITY-MATRIX.md', 'docs/ui-cockpit/inventory/capabilities.json'];

/** The work tree's own facts, or null when the root is not the top of a git work tree. */
export function gitFacts(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top === null) return null;
  let same = false;
  try { same = realpathSync(top.trim()) === realpathSync(root); } catch { same = false; }
  if (!same) return null;
  const head = git(root, ['rev-parse', '--short=7', 'HEAD'])?.trim() ?? null;
  const headDate = git(root, ['show', '-s', '--format=%cs', 'HEAD'])?.trim() ?? null;
  const shallow = git(root, ['rev-parse', '--is-shallow-repository'])?.trim() === 'true';
  const status = git(root, ['status', '--porcelain', '--untracked-files=no']);
  const changed = status === null ? null : status.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter((p) => !OUTPUTS.includes(p)).length;
  return { head, headDate, shallow, changed };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.timmy', '__pycache__', '.venv', '.wrangler', '.vercel']);

/**
 * The files the inventory reads: the tracked files when the root is a git work tree (present on disk), else a walk that
 * never follows a link and skips installed and generated folders. Sorted, POSIX, relative to the root.
 */
export function listFiles(root, facts) {
  if (facts) {
    const out = git(root, ['ls-files', '-z']);
    if (out !== null) {
      return { how: 'tracked by git', files: out.split('\0').filter(Boolean).filter((f) => isFile(join(root, f)) && !isLink(join(root, f))).sort() };
    }
  }
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); continue; }
      if (e.isFile()) files.push(rel(root, abs));
    }
  };
  walk(root);
  return { how: 'a walk of the folder (no git work tree; links, node_modules, .git, dist and .timmy not entered)', files: files.sort() };
}

export const uniq = (xs) => [...new Set(xs)];
export const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const sortStrings = (xs) => [...xs].sort(byString);

/** Package URLs (purl spec): the npm scope's "@" percent-encoded; a version only when one is known exactly. */
export function purlNpm(name, version) {
  const enc = name.startsWith('@') ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}` : encodeURIComponent(name);
  return `pkg:npm/${enc}${version ? `@${encodeURIComponent(version)}` : ''}`;
}
export const purlPypi = (name, version) => `pkg:pypi/${encodeURIComponent(name.toLowerCase().replace(/[_.]+/g, '-'))}${version ? `@${encodeURIComponent(version)}` : ''}`;
export const purlConda = (name, version, channel, subdir) => `pkg:conda/${encodeURIComponent(name)}${version ? `@${encodeURIComponent(version)}` : ''}${channel || subdir ? `?${[channel ? `channel=${encodeURIComponent(channel)}` : '', subdir ? `subdir=${encodeURIComponent(subdir)}` : ''].filter(Boolean).join('&')}` : ''}`;
export const purlDocker = (name, version) => `pkg:docker/${name.split('/').map(encodeURIComponent).join('/')}${version ? `@${encodeURIComponent(version)}` : ''}`;
export const purlGeneric = (name, version) => `pkg:generic/${encodeURIComponent(name)}${version ? `@${encodeURIComponent(version)}` : ''}`;

/**
 * The code area a file belongs to: the "feature" a dependency is used by, by path (first match). Area-level on
 * purpose: a package used by the board is used by "Board", not by one checklist row.
 */
const AREAS = [
  ['src/repl/board', 'Board (/board, /board live)'],
  ['src/repl/canvas', 'Timmy Canvas (Studio)'],
  ['src/repl/iterate', '/iterate flows'],
  ['src/repl/vox', 'VoxVision'],
  ['src/repl/workflow', 'Workflows (upmd)'],
  ['src/repl/recipe', 'CadQuery recipe'],
  ['src/repl/openhands', 'Code agents (/agent)'],
  ['src/repl/unreal', 'Native apps'],
  ['src/repl/freecad', 'Native apps'],
  ['src/repl/web', 'Web views (/web, carbonyl)'],
  ['src/repl/', 'REPL (timmy)'],
  ['src/studio/', 'Timmy Canvas (Studio)'],
  ['companion/studio-canvas/', 'Timmy Canvas (Studio) page'],
  ['src/companion/', 'Browser companion (timmy watch, timmy logs)'],
  ['src/tui-opentui/', 'OpenTUI shell (src/tui-opentui)'],
  ['src/tui/', 'Monitor and terminal UI (timmy watch)'],
  ['src/vox/', 'VoxVision'],
  ['src/vision/', 'Vision (/observe, Look, adapters)'],
  ['src/native/', 'Native apps'],
  ['src/flows/', '/iterate flows'],
  ['src/recipes/', 'CadQuery recipe'],
  ['lanes/recipes/', 'CadQuery recipe'],
  ['src/code-agents/', 'Code agents (/agent)'],
  ['src/connectors/', 'MCP (/mcp)'],
  ['src/mcp/', "Timmy's own MCP servers"],
  ['src/agent/', 'Chat agent and its tools'],
  ['src/capabilities/', 'Capabilities (/tools)'],
  ['src/connect/', 'Timmy Connect'],
  ['src/cloud/', 'Timmy Cloud client'],
  ['services/cloud/', 'Timmy Cloud backend'],
  ['src/overview/', "God's Eye View"],
  ['src/room/', 'Control Room'],
  ['src/memory/', 'Timmy Memory'],
  ['src/ops/', 'Operations (timmy act)'],
  ['src/workflows/', 'Workflows (upmd)'],
  ['src/jobs/', 'Jobs'],
  ['src/review/', 'Results and review'],
  ['src/setup/', 'Guided setup'],
  ['src/theme/', 'Theme (Timmy Homebrew)'],
  ['src/term/', 'Theme (Timmy Homebrew)'],
  ['src/project/', 'Projects and files'],
  ['src/drop/', 'timmy drop'],
  ['src/preview/', 'Previews (/preview)'],
  ['src/forge/', 'Forge pipeline'],
  ['src/graphics/', 'Graphics (Rive)'],
  ['src/harness/', 'Harness and war room'],
  ['src/hermes/', 'Hermes lane'],
  ['src/cloudflare/', 'Cloudflare edge'],
  ['src/utils/', 'Shared utilities'],
  ['src/', 'Core (other src/)'],
  ['cli.tsx', 'Monitor and terminal UI (timmy watch)'],
  ['headless.ts', 'Core (other src/)'],
  ['timmy.ts', 'Core (other src/)'],
  ['workers/ai-proxy/', 'AI proxy Worker (Cloudflare)'],
  ['workers/', 'Workers (Python and Node helpers)'],
  ['r2-worker/', 'R2 Worker (Cloudflare)'],
  ['vault-custody/', 'Vault Custody (a separate project)'],
  ['companion/slate3d/', 'Slate 3D (companion sub-app)'],
  ['companion/', 'Companion boards and sub-apps'],
  ['packages/opencode-witness/', 'OpenCode witness plugin'],
  ['founder-terminal/', 'Founder Terminal (Python, separate)'],
  ['templates/', 'Starter templates (content)'],
  ['scripts/', 'Build and maintenance scripts'],
  ['tests/', 'Tests only'],
  ['studio/', 'Studio content (renders, promos, studies)'],
  ['tools/', 'Tools (spatial and vision studies)'],
  ['my-react-app/', 'Demo app (excluded)'],
  ['.agents/', 'Agent skill material (excluded)'],
  ['vite.config.ts', 'Browser companion (timmy watch, timmy logs)'],
  ['vitest.config.ts', 'Tests only'],
];

export function areaOf(path) {
  for (const [prefix, area] of AREAS) if (path === prefix || path.startsWith(prefix)) return area;
  const lane = /^lanes\/([^/]+)\//.exec(path);
  if (lane) return `Lane: ${lane[1]}`;
  const top = path.split('/')[0];
  return path.includes('/') ? `Other (${top}/)` : 'Other (repository root)';
}

/**
 * Paths in text that came from the repository (a registry's setup words, a Dockerfile) are kept relative; an absolute
 * one is replaced by <path>, so nothing of any computer's folders reaches the output.
 */
export function scrubText(s) {
  return String(s)
    .replace(/(^|[\s"'(=,;`])(?:\/(?:[\w.@+~-]+\/)+[\w.@+~-]*|\/(?:Users|home|root|tmp|private|var|opt|Applications|Library|usr|etc|mnt|Volumes)\b[\w.@+~/-]*)/g, '$1<path>')
    .replace(/(^|[\s"'(=,;`])[A-Za-z]:\\[^\s"'`,;)]*/g, '$1<path>')
    .replace(/\$HOME\/[\w./-]*/g, '<home path>');
}

/**
 * Whether a text names a local path: a path of one segment (a system folder such as /tmp or /root, the temporary folder or
 * home folder on some computers) only as the start of a longer path ("/tmp/…"); the words "a write under /tmp" name no
 * computer's own folder. A longer path anywhere.
 */
export function namesLocalPath(text, p) {
  return /^\/[^/]+$/.test(p) ? text.includes(`${p}/`) : text.includes(p);
}

/**
 * The output's last guard: no absolute local path of this computer and no home-style path anywhere. Returns the problems
 * found (empty when clean); the caller writes nothing when there are any.
 */
export function absolutePathProblems(text, root, extra = []) {
  const literal = new Set();
  const add = (p) => { if (p && p.length > 1) literal.add(p); };
  add(root);
  try { add(realpathSync(root)); } catch { /* gone */ }
  add(homedir());
  add(tmpdir());
  try { add(realpathSync(tmpdir())); } catch { /* gone */ }
  for (const p of extra) add(p);
  const problems = [];
  for (const p of literal) if (namesLocalPath(text, p)) problems.push(`contains the local path ${p.length} characters long (one of: the root, the home folder, the temporary folder, an installed tree)`);
  const patterns = [/\/Users\/[A-Za-z0-9._-]+/, /\/home\/[A-Za-z0-9._-]+/, /\/root\//, /[A-Za-z]:\\Users\\/, /\/private\/var\/folders\//];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) problems.push(`contains a home-style path (${re.source}) at character ${m.index}`);
  }
  return problems;
}

/** A short, stable id from words: lower case, ASCII letters and digits joined by "-", at most `max` characters. */
export function slug(text, max = 48) {
  const s = String(text).toLowerCase().replace(/`[^`]*`/g, (m) => m.slice(1, -1)).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length <= max ? s : s.slice(0, max).replace(/-+[^-]*$/, '') || s.slice(0, max);
}
