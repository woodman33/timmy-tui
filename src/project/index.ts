/**
 * The active project (R1 workspace direction, 2026-10-08): one folder that every REPL surface works in —
 * Files, the agent's file tools, Workflows, jobs, Preview and Results. Projects made with `/project new`
 * (the same folder `timmy project new` uses) live in <TIMMY_HOME>/projects/<name>; any other folder can be
 * chosen by path. The choice is kept in <TIMMY_HOME>/state/active-project.json, never inside the project,
 * so choosing an existing project writes nothing into it.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { timmyHome } from '../utils/init.js';

export interface ActiveProject { name: string; root: string; chosen: boolean }

export const projectsHome = (): string => join(timmyHome(), 'projects');
export const activeProjectPath = (): string => join(timmyHome(), 'state', 'active-project.json');

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** A folder as a project: its name is the folder's name. */
export const folderProject = (root: string): ActiveProject => ({ name: basename(root) || root, root, chosen: false });

/** The project other surfaces open in: the last one chosen with /project while its folder exists, else `cwd`. */
export function readActiveProject(cwd: string = process.cwd()): ActiveProject {
  try {
    const saved = JSON.parse(readFileSync(activeProjectPath(), 'utf8')) as { name?: unknown; root?: unknown };
    if (typeof saved.root === 'string' && isDir(saved.root)) {
      return { name: typeof saved.name === 'string' && saved.name ? saved.name : basename(saved.root), root: saved.root, chosen: true };
    }
  } catch { /* nothing chosen yet */ }
  return folderProject(cwd);
}

/** `/project <name|path>`: a path (it has a slash, or starts with . or ~) is that folder; a bare name is a project under the Timmy home, else a folder here. */
export function chooseProject(arg: string, cwd: string = process.cwd()): ActiveProject | { error: string } {
  const a = arg.trim();
  if (!a) return { error: 'name a project or a folder' };
  const asPath = resolve(cwd, expandHome(a));
  if (/[\\/]/.test(a) || a.startsWith('.') || a.startsWith('~')) {
    return isDir(asPath) ? { name: basename(asPath), root: asPath, chosen: true } : { error: `no folder at ${a}` };
  }
  const named = join(projectsHome(), a);
  if (isDir(named)) return { name: a, root: named, chosen: true };
  if (isDir(asPath)) return { name: basename(asPath), root: asPath, chosen: true };
  return { error: `no project named ${a}; /project new ${a} makes one` };
}

/** `/project new <name>`: an empty project folder under the Timmy home. Never replaces an existing one. */
export function createProject(name: string): ActiveProject | { error: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return { error: 'a project name uses letters, digits, dots, dashes or underscores' };
  const root = join(projectsHome(), name);
  if (existsSync(root)) return { error: `${name} already exists; /project ${name} opens it` };
  mkdirSync(root, { recursive: true });
  return { name, root, chosen: true };
}

/** Remembers the choice for the other surfaces (monitor, canvas) — in the Timmy home, not the project. */
export function saveActiveProject(p: ActiveProject): void {
  const file = activeProjectPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function listProjects(): { name: string; root: string }[] {
  try {
    return readdirSync(projectsHome(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, root: join(projectsHome(), d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// ── files and their roles ─────────────────────────────────────────────────────

export type FileRole = 'source' | 'reference' | 'script' | 'workflow' | 'output' | 'history' | 'other';
export const ROLE_ORDER: readonly FileRole[] = ['source', 'reference', 'script', 'workflow', 'output', 'history', 'other'];
export const ROLE_LABEL: Readonly<Record<FileRole, string>> = {
  source: 'Source', reference: 'References', script: 'Scripts', workflow: 'Workflows', output: 'Outputs', history: 'History', other: 'Other',
};

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.turbo', '.next']);
const HISTORY_TOP = new Set(['.sessions', '.timmy', 'history', 'receipts']);
const OUTPUT_TOP = new Set(['dist', 'build', 'out', 'outputs', 'output', 'renders', 'exports']);
const WORKFLOW_TOP = new Set(['workflows', 'recipes']);
const SCRIPT_TOP = new Set(['scripts', 'bin', 'tools']);
const REFERENCE_TOP = new Set(['refs', 'ref', 'references', 'reference', 'assets', 'inputs', 'docs', 'uploads', 'media']);
const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat']);
const SCRIPT_NAMES = new Set(['Makefile', 'makefile', 'justfile', 'Justfile', 'Dockerfile', 'Taskfile.yml', 'Procfile']);
const REFERENCE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.tif', '.tiff', '.bmp', '.heic', '.exr', '.hdr', '.psd',
  '.pdf', '.doc', '.docx', '.txt', '.rtf', '.csv', '.xlsx', '.pptx', '.key', '.fountain', '.fdx',
  '.mp4', '.mov', '.webm', '.wav', '.mp3', '.aif',
  '.glb', '.gltf', '.obj', '.stl', '.fbx', '.ply', '.usd', '.usda', '.usdc', '.usdz', '.abc', '.blend', '.c4d', '.hip', '.hiplc', '.uasset', '.umap', '.step', '.stp', '.3mf', '.las', '.laz', '.e57', '.pcd', '.aep',
]);
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.lua',
  '.html', '.htm', '.css', '.scss', '.sass', '.vue', '.svelte', '.json', '.toml', '.yaml', '.yml', '.sql', '.glsl', '.wgsl', '.hlsl', '.vex', '.scad', '.qml',
]);
const WORKFLOW_BLOCK = /^(?:```|~~~)[\w+-]*[ \t]*\[[^\]\n]*\bname:/m;

/** True when Markdown holds a block upmd can run by name (```bash [name:build]). */
export const looksLikeWorkflow = (markdown: string): boolean => WORKFLOW_BLOCK.test(markdown);

/** The role a file plays in the project, from where it sits and what it is. `peek` reads a Markdown file's start. */
export function classify(rel: string, peek?: () => string): FileRole {
  const parts = rel.split(/[\\/]/);
  const top = parts.length > 1 ? parts[0] : '';
  const name = parts[parts.length - 1] ?? '';
  const ext = extname(name).toLowerCase();
  if (HISTORY_TOP.has(top)) return 'history';
  if (OUTPUT_TOP.has(top)) return 'output';
  if (ext === '.intent' || WORKFLOW_TOP.has(top)) return 'workflow';
  if (ext === '.md' || ext === '.markdown') return peek && looksLikeWorkflow(peek()) ? 'workflow' : 'reference';
  if (SCRIPT_TOP.has(top) || SCRIPT_EXT.has(ext) || SCRIPT_NAMES.has(name)) return 'script';
  if (REFERENCE_TOP.has(top) || REFERENCE_EXT.has(ext)) return 'reference';
  if (SOURCE_EXT.has(ext)) return 'source';
  return 'other';
}

const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|p12|pfx)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;

/** Keys, .env files, git internals and .timmy/private never reach a listing, a read or a write. */
export function privatePath(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.includes('.git')) return true;
  for (let i = 0; i + 1 < parts.length; i++) if (parts[i] === '.timmy' && parts[i + 1] === 'private') return true;
  return SECRET_NAME.test(parts[parts.length - 1] ?? '');
}

function peekText(path: string, bytes = 16384): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

export interface ProjectFile { rel: string; role: FileRole; bytes: number; mtimeMs: number }

/** The project's files with their roles: no dependencies, git, dotfiles, links or private files; at most `max`. */
export function listProjectFiles(root: string, opts: { max?: number } = {}): { files: ProjectFile[]; truncated: boolean } {
  const max = opts.max ?? 2000;
  const files: ProjectFile[] = [];
  let truncated = false;
  const walk = (dirRel: string, depth: number): void => {
    if (truncated || depth > 12) return;
    let entries: Dirent[];
    try { entries = readdirSync(join(root, dirRel), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || privatePath(rel)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && !HISTORY_TOP.has(e.name))) continue;
        walk(rel, depth + 1);
        continue;
      }
      if (!e.isFile() || e.name.startsWith('.')) continue;
      if (files.length >= max) { truncated = true; return; }
      let st;
      try { st = statSync(join(root, rel)); } catch { continue; }
      files.push({ rel, role: classify(rel, () => peekText(join(root, rel))), bytes: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk('', 0);
  return { files, truncated };
}

export function groupFiles(files: ProjectFile[]): { role: FileRole; label: string; files: ProjectFile[] }[] {
  return ROLE_ORDER.map((role) => ({ role, label: ROLE_LABEL[role], files: files.filter((f) => f.role === role) })).filter((g) => g.files.length > 0);
}

export const humanBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/** A path inside the project, after links resolve; private files refused. */
export function resolveInside(root: string, rel: string): { path: string; rel: string } | { error: string } {
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) return { error: 'name a file inside the project' };
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return { error: 'the project folder is gone' }; }
  const inside = (p: string): boolean => p === realRoot || p.startsWith(realRoot + sep);
  const target = resolve(realRoot, rel.trim());
  if (!inside(target)) return { error: `${rel} is outside the project` };
  let probe = target;
  for (;;) {
    let exists = false;
    try { lstatSync(probe); exists = true; } catch { /* keep climbing */ }
    if (exists || probe === realRoot) break;
    probe = dirname(probe);
  }
  let real: string;
  try { real = realpathSync(probe); } catch { return { error: `${rel} cannot be resolved (a broken link?)` }; }
  if (!inside(real)) return { error: `${rel} leads outside the project` };
  const relOut = relative(realRoot, target).split(sep).join('/');
  if (privatePath(relOut)) return { error: `${relOut} is private: keys, .env files and .timmy/private stay out of reach` };
  return { path: target, rel: relOut };
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const HASH_LIMIT = 16 * 1024 * 1024;

export type ReadResult =
  | { ok: true; rel: string; bytes: number; sha256?: string; text?: string; binary?: true; truncated?: true }
  | { ok: false; error: string };

/** Reads a project file for the agent or a preview: text up to maxBytes, binary files named but not read. */
export function readProjectFile(root: string, rel: string, maxBytes = 64 * 1024): ReadResult {
  const at = resolveInside(root, rel);
  if ('error' in at) return { ok: false, error: at.error };
  let size: number;
  try {
    const st = statSync(at.path);
    if (!st.isFile()) return { ok: false, error: `${at.rel} is not a file` };
    size = st.size;
  } catch { return { ok: false, error: `${at.rel} does not exist` }; }
  const head = Buffer.from(peekText(at.path, Math.min(maxBytes + 1, Math.max(size, 1))), 'utf8');
  const whole = size <= HASH_LIMIT ? readFileSync(at.path) : null;
  const hash = whole ? sha256(whole) : undefined;
  const sniff = (whole ?? head).subarray(0, 8192);
  if (sniff.includes(0)) return { ok: true, rel: at.rel, bytes: size, ...(hash ? { sha256: hash } : {}), binary: true };
  const body = (whole ?? head).subarray(0, maxBytes).toString('utf8');
  return { ok: true, rel: at.rel, bytes: size, ...(hash ? { sha256: hash } : {}), text: body, ...(size > maxBytes ? { truncated: true as const } : {}) };
}

export type WriteResult =
  | { ok: true; rel: string; bytes: number; sha256: string; created: boolean; previousSha256?: string }
  | { ok: false; error: string };

/** Writes a project file (new or replaced) atomically and reports the hashes before and after. */
export function writeProjectFile(root: string, rel: string, content: string): WriteResult {
  const at = resolveInside(root, rel);
  if ('error' in at) return { ok: false, error: at.error };
  let previousSha256: string | undefined;
  try {
    const st = lstatSync(at.path);
    if (st.isDirectory()) return { ok: false, error: `${at.rel} is a folder` };
    previousSha256 = sha256(readFileSync(at.path));
  } catch { /* a new file */ }
  mkdirSync(dirname(at.path), { recursive: true });
  const tmp = `${at.path}.timmy-${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, at.path);
  return { ok: true, rel: at.rel, bytes: Buffer.byteLength(content), sha256: sha256(content), created: previousSha256 === undefined, ...(previousSha256 ? { previousSha256 } : {}) };
}
