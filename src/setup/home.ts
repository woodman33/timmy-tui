/**
 * Where Timmy's one guided setup reads and writes (round R4, H98). It uses node's own modules only: `timmy init` runs from
 * an installed package before anything else is resolved (tests/init-package-paths.test.ts runs it that way), and the
 * monitor's blank-slate guard reads it before any other module loads.
 *
 *   the Timmy home      TIMMY_HOME, else ~/timmy: identity.json, identity.seed (0600), providers.json (0600), setup.json
 *                       (0600: the answers, never a key), projects/<name>/
 *   the private folder  TIMMY_PRIVATE_DIR, else <workspace>/.timmy/private: config.json (merged), projects.json
 *   the workspace       TIMMY_REPO_ROOT, else the working folder (its .timmy/store-pin names the receipts store)
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Env = Record<string, string | undefined>;

/** The cockpit's workspace override, else the working folder. Installed modules are never where operator state goes. */
export const workspaceRoot = (env: Env = process.env): string => resolve(env.TIMMY_REPO_ROOT || process.cwd());
export const timmyHome = (env: Env = process.env): string => env.TIMMY_HOME || join(homedir(), 'timmy');
export const privateDir = (workspace: string = workspaceRoot(), env: Env = process.env): string =>
  resolve(env.TIMMY_PRIVATE_DIR || join(workspace, '.timmy', 'private'));
export const identityPath = (env: Env = process.env): string => join(timmyHome(env), 'identity.json');
/** The answers of the guided setup (never a key). */
export const setupPath = (env: Env = process.env): string => join(timmyHome(env), 'setup.json');
/** No identity yet: the monitor will not start before setup, and `timmy init` asks every question. */
export const isBlankSlate = (env: Env = process.env): boolean => !existsSync(identityPath(env));

/**
 * The monitor's settings file (conf's `timmy-tui` project, with the `nodejs` suffix env-paths gives it), read here without
 * building conf's store (building it writes the file). The same rule as src/utils/model-key.ts settingsFile, kept here so
 * this module needs nothing but node.
 */
export function settingsFile(env: Env = process.env, home: string = homedir(), platform: string = process.platform): string {
  const dir = platform === 'darwin' ? join(home, 'Library', 'Preferences', 'timmy-tui-nodejs')
    : platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'timmy-tui-nodejs', 'Config')
      : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'timmy-tui-nodejs');
  return join(dir, 'config.json');
}

/** A path as a person reads it: the home folder as ~, the workspace as <repo>. */
export function prettyPath(p: string, env: Env = process.env): string {
  const home = homedir();
  const ws = workspaceRoot(env);
  if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  if (p === ws || p.startsWith(`${ws}/`)) return `<repo>${p.slice(ws.length)}`;
  return p;
}
