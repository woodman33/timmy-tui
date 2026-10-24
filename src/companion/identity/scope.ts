/**
 * R11 round 4 (H173, contract C1): a user's own corner of this computer, and nothing outside it.
 *
 * Every signed-in user has a Timmy home of their own under the companion's: <TIMMY_HOME>/users/<user.id>/ (made 0700 on first
 * use). Their env (userEnv) is the process's with TIMMY_HOME, TIMMY_SETTINGS_DIR, TIMMY_MCP_HOME and TIMMY_PRIVATE_DIR moved
 * under it, so that everything the existing modules keep in "the Timmy home" or "the settings" lands there and nowhere else:
 * providers.json (src/setup/provider-keys.ts saveKey(env)), connections.json, setup.json, state/active-project.json, the
 * settings store, the MCP home, models/ (a fetched catalog), logs. The operator's own keys in the process environment
 * (OPENROUTER_API_KEY, OLLAMA_API_KEY) are NOT a user's: they are unset in a user's env, so a user spends only what they
 * connected themselves. Every other owner takes the env and the project from here for a request with a user, never from
 * process.env.
 *
 * A user's projects (userProjects) are the folders under <userHome>/projects/ plus those their registry
 * (<userHome>/projects.json, the shape src/utils/init.ts keeps) names, when the named folder is under <userHome>/projects/
 * once links resolve; a registry entry leading anywhere else is ignored, so no user's project is ever another user's folder,
 * the operator's, or the computer's. With none, the default project is made: projects/untitled, registered as
 * "Untitled project". isOwnedRoot says whether a path (as a request names it) is one of the user's roots or inside one,
 * after links resolve: /, the companion's home, another user's home and a link pointing out are all refused.
 *
 * The user id must be Clerk's user_… shape (session.ts USER_ID): anything else is refused here too (a throw: it is a
 * programming error to reach this with an id the session did not verify), and never becomes a folder name.
 *
 * THE OPERATOR PRINCIPAL (session.ts operatorUser; the lead's ruling of 21:48): on a companion with no identity provider
 * configured, withUser gives every request the operator, and here the operator is the companion itself as it always was:
 * userEnv(operator, base) IS base (the operator's own Timmy home and keys; no folder made); the operator's projects are the
 * follower's (src/companion/project.ts): the fixed project (TIMMY_REPO), else the active one (<TIMMY_HOME>/state/
 * active-project.json), else the folder the companion runs in — plus every folder under <TIMMY_HOME>/projects/ and the
 * entries of <TIMMY_HOME>/projects.json that lead there; no default project is made for the operator. isOwnedRoot(operator,
 * root) is that rule. A companion that has shown further projects (pinned ones) passes its own projectFor to mountIdentity
 * (routes.ts IdentityDeps.operator), which the routes prefer for the operator.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { timmyHome, type Env } from '../../setup/home.js';
import { projectId } from '../../project/index.js';
import { isOperator, USER_ID, type SessionUser } from './session.js';

export type { Env };
export type UserRef = Pick<SessionUser, 'id'>;

/** The folder under the Timmy home that holds every user's home. */
export const USERS_DIR = 'users';
/** The default project's folder name and the name it is registered under (the preview's words). */
export const DEFAULT_PROJECT = Object.freeze({ folder: 'untitled', name: 'Untitled project' });

export interface UserProjects {
  /** The user's project registry: <userHome>/projects.json ({ projects: [{ name, path, created }] }). */
  registry: string;
  /** The real paths of the user's project folders, each under <userHome>/projects/, sorted; never empty (the default is made). */
  roots: string[];
  /** The project a request without one gets: the active one when it is a root, else the first root. */
  default: string;
}

const REFUSED_ID = 'Refused: a user id must be a Clerk user id (user_…); nothing is kept for any other.';

function checkId(user: UserRef): string {
  const id = user?.id;
  if (typeof id !== 'string' || !USER_ID.test(id)) throw new Error(REFUSED_ID);
  return id;
}

/** The companion's own Timmy home (the base): TIMMY_HOME, else ~/timmy (src/setup/home.ts). */
export const baseHome = (base: Env = process.env): string => resolve(timmyHome(base));

/** The user's home: <base home>/users/<user.id>; the operator's is the base home itself. The id is checked; nothing is made. */
export function userHome(user: UserRef, base: Env = process.env): string {
  if (isOperator(user)) return baseHome(base);
  return join(baseHome(base), USERS_DIR, checkId(user));
}

/** Makes a folder 0700 (and its parents as they are needed), and keeps it 0700 where an older one was wider. */
function ensure0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

/**
 * The user's env: the base env with the Timmy home, the settings folder, the MCP home and the private folder under the
 * user's home (made 0700 on first use), and the operator's provider keys unset. The keys a user connected live in their
 * own providers.json (saveKey(userEnv)); the environment's are the operator's.
 */
export function userEnv(user: UserRef, base: Env = process.env): Env {
  if (isOperator(user)) return base; // the operator principal: the companion's own env, as it always was; nothing made
  const home = userHome(user, base);
  const env: Env = { ...base };
  env.TIMMY_HOME = home;
  env.TIMMY_SETTINGS_DIR = join(home, 'settings');
  env.TIMMY_MCP_HOME = join(home, 'mcp');
  env.TIMMY_PRIVATE_DIR = join(home, 'private');
  // the operator's keys are not the user's; a user's own are in their providers.json. Everything else of the base env
  // passes through (TIMMY_REPO_ROOT and the store pin included: the receipts' rules are the workspace's, not a user's)
  delete env.OPENROUTER_API_KEY;
  delete env.OLLAMA_API_KEY;
  ensure0700(join(baseHome(base), USERS_DIR));
  for (const d of [home, env.TIMMY_SETTINGS_DIR, env.TIMMY_MCP_HOME, env.TIMMY_PRIVATE_DIR, join(home, 'projects'), join(home, 'state')]) ensure0700(d);
  return env;
}

/** The user's projects folder, <userHome>/projects, from the BASE env (the companion's; not a user's env, which already names the user's home). */
export const userProjectsDir = (user: UserRef, base: Env = process.env): string => join(userHome(user, base), 'projects');

/** The user's home as a USER's env names it (userEnv's TIMMY_HOME), checked to be one: never nested under itself again. */
function homeOfUserEnv(user: UserRef, env: Env): string {
  if (isOperator(user)) return baseHome(env); // the operator's env is the base: its home is the Timmy home
  const id = checkId(user);
  const home = resolve(timmyHome(env));
  if (basename(home) !== id || basename(dirname(home)) !== USERS_DIR) throw new Error('Refused: this takes the user\'s own env (userEnv), whose TIMMY_HOME is the user\'s home.');
  return home;
}

const realOrNull = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + sep);

interface RegistryEntry { name?: unknown; path?: unknown; created?: unknown }

function readRegistry(file: string): RegistryEntry[] {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown };
    return Array.isArray(o?.projects) ? o.projects.filter((p): p is RegistryEntry => Boolean(p) && typeof p === 'object') : [];
  } catch { return []; }
}

function writeRegistry(file: string, projects: RegistryEntry[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * The user's project registry and roots (see the module's words). `env` is the user's (userEnv): its TIMMY_HOME is the
 * user's home, and the registry and the projects folder are read under it. The default project is made and registered when
 * the user has none, so a signed-in user always has a project to open ({ make: false } reads only: roots then may be empty).
 */
export function userProjects(user: UserRef, env: Env, o: { make?: boolean } = {}): UserProjects {
  if (isOperator(user)) return operatorProjects(env);
  const home = homeOfUserEnv(user, env);
  const projectsDir = join(home, 'projects');
  ensure0700(projectsDir);
  const realProjects = realOrNull(projectsDir) ?? projectsDir;
  const registry = join(home, 'projects.json');
  const roots = new Set<string>();
  // the folders under projects/ (no links: a link is not a project of this user's)
  try {
    for (const d of readdirSync(projectsDir, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) roots.add(join(realProjects, d.name));
    }
  } catch { /* none yet */ }
  // the registry's entries, kept only when they lead under projects/ once links resolve
  let entries = readRegistry(registry);
  for (const e of entries) {
    if (typeof e.path !== 'string' || !isAbsolute(e.path)) continue;
    const real = realOrNull(e.path);
    if (real && real !== realProjects && under(real, realProjects) && isDir(real)) roots.add(real);
  }
  if (roots.size === 0 && o.make === false) return { registry, roots: [], default: '' };
  if (roots.size === 0) {
    const root = join(projectsDir, DEFAULT_PROJECT.folder);
    ensure0700(root);
    roots.add(realOrNull(root) ?? root);
    entries = [...entries, { name: DEFAULT_PROJECT.name, path: root, created: new Date().toISOString() }];
    writeRegistry(registry, entries);
  } else if (!existsSync(registry)) {
    // folders made by hand: registered, so the registry names every root
    writeRegistry(registry, [...roots].sort().map((root) => ({ name: nameOf(root, entries), path: root })));
  }
  const sorted = [...roots].sort();
  // the active project (state/active-project.json, src/project/index.ts's record) when it is one of the roots
  let active: string | null = null;
  try {
    const saved = JSON.parse(readFileSync(join(home, 'state', 'active-project.json'), 'utf8')) as { root?: unknown };
    const real = typeof saved.root === 'string' ? realOrNull(saved.root) : null;
    if (real && sorted.includes(real)) active = real;
  } catch { /* none chosen */ }
  return { registry, roots: sorted, default: active ?? sorted[0] };
}

/**
 * The operator's projects: the follower's rule (src/companion/project.ts ProjectFollower, src/project/index.ts): the fixed
 * project (TIMMY_REPO) when set, else the active project (<home>/state/active-project.json), else the folder the companion
 * runs in; plus every folder under <home>/projects/ and the registry's entries that lead there. Nothing is made.
 */
function operatorProjects(env: Env): UserProjects {
  const home = baseHome(env);
  const projectsDir = join(home, 'projects');
  const realProjects = realOrNull(projectsDir) ?? projectsDir;
  const registry = join(home, 'projects.json');
  const roots = new Set<string>();
  const realDir = (p: unknown): string | null => { if (typeof p !== 'string' || !isAbsolute(p)) return null; const r = realOrNull(p); return r && isDir(r) ? r : null; };
  const fixed = realDir(env.TIMMY_REPO);
  let active: string | null = null;
  try { active = realDir((JSON.parse(readFileSync(join(home, 'state', 'active-project.json'), 'utf8')) as { root?: unknown }).root); } catch { /* nothing chosen */ }
  const followed = fixed ?? active ?? realDir(process.cwd());
  if (followed) roots.add(followed);
  try {
    for (const d of readdirSync(projectsDir, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.')) roots.add(join(realProjects, d.name));
  } catch { /* none */ }
  for (const e of readRegistry(registry)) {
    const real = realDir(e.path);
    if (real && real !== realProjects && under(real, realProjects)) roots.add(real);
  }
  const sorted = [...roots].sort();
  return { registry, roots: sorted, default: followed ?? sorted[0] ?? '' };
}

function nameOf(root: string, entries: RegistryEntry[]): string {
  const e = entries.find((x) => typeof x.path === 'string' && realOrNull(x.path) === root);
  return typeof e?.name === 'string' && e.name ? e.name : basename(root);
}

/** The name a root is registered under (the default's "Untitled project"), else its folder's name. */
export function projectName(user: UserRef, root: string, env: Env): string {
  const { registry } = userProjects(user, env);
  return nameOf(realOrNull(root) ?? root, readRegistry(registry));
}

/** A user's project as the other routes carry one (src/project/index.ts ActiveProject's shape): its id is projectId(root). */
export interface UserProject { id: string; name: string; root: string; chosen: true }

/**
 * The project a user's request is about: `asked` is the page's ?project=<id> (projectId(root), the 16-hex id the other
 * routes use) or a root the user owns; absent, the user's default project. null when it is not one of the user's (another
 * user's id, the operator's, a path outside): the route answers with words then, and reads nothing.
 */
export function userProjectFor(user: UserRef, env: Env, asked?: unknown): UserProject | null {
  let own: UserProjects;
  try { own = userProjects(user, env); } catch { return null; }
  const entries = readRegistry(own.registry);
  const view = (root: string): UserProject => ({ id: projectId(root), name: nameOf(root, entries), root, chosen: true });
  if (asked === undefined || asked === null || asked === '') return own.default ? view(own.default) : null;
  if (typeof asked !== 'string') return null;
  const byId = own.roots.find((r) => projectId(r) === asked);
  if (byId) return view(byId);
  if (isAbsolute(asked) && isOwnedRoot(user, asked, env)) {
    const real = realOrNull(asked);
    const root = real ? own.roots.find((r) => under(real, r)) : undefined;
    if (root) return view(root);
  }
  return null;
}

/** The name a user gives a new project: letters, digits, spaces, dots, dashes and underscores, 1 to 64; its folder name is the slug. */
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * Makes a project of the user's: a new folder under <userHome>/projects/ (0700), registered under the name given. Never
 * replaces one: a name whose folder exists is an answer in words.
 */
export function createUserProject(user: UserRef, env: Env, name: unknown): UserProject | { error: string } {
  const own = userProjects(user, env);
  if (typeof name !== 'string' || !PROJECT_NAME.test(name.trim())) return { error: 'a project name uses letters, digits, spaces, dots, dashes or underscores (1 to 64)' };
  const clean = name.trim();
  const folder = clean.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const root = join(homeOfUserEnv(user, env), 'projects', folder);
  if (existsSync(root)) return { error: `${clean} already exists; open it instead` };
  ensure0700(root);
  writeRegistry(own.registry, [...readRegistry(own.registry), { name: clean, path: root, created: new Date().toISOString() }]);
  const real = realOrNull(root) ?? root;
  return { id: projectId(real), name: clean, root: real, chosen: true };
}

/**
 * Whether `root` (as a request names it) is one of the user's project roots or inside one, after links resolve. A path
 * that does not exist, a relative path, /, the companion's home, another user's home, and a link inside the user's projects
 * that points out are all false. Nothing is made.
 */
export function isOwnedRoot(user: UserRef, root: unknown, env: Env): boolean {
  if (!isOperator(user)) { try { checkId(user); } catch { return false; } }
  if (typeof root !== 'string' || !root.trim() || root.includes('\0') || !isAbsolute(root)) return false;
  let own: UserProjects;
  try { own = userProjects(user, env, { make: false }); } catch { return false; }
  // the path as named: a link anywhere in it is resolved by realpath; a path that does not exist is nobody's
  let st;
  try { st = lstatSync(root); } catch { return false; }
  const real = realOrNull(root);
  if (!real || !st) return false;
  if (!isDir(real)) return false;
  return own.roots.some((r) => under(real, r));
}
