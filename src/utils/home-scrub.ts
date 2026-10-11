/**
 * Round R4 (helper H88; the Mac run r23): the home folders a path shown to a person is written from "~": $HOME (what
 * os.homedir() reads) and the account's own home (os.userInfo().homedir, from the system's account record). In r23's
 * sandbox HOME was not the operator's own home, so a tool found on PATH under the account's real home kept its absolute path
 * in the live board's closed tools folds: only $HOME was scrubbed. Every place the board and /tools scrub a path asks here.
 */
import { homedir, userInfo } from 'node:os';

/** The account's own home, or undefined when the system cannot say (no account record). */
function accountHome(): string | undefined {
  try { return userInfo().homedir || undefined; } catch { return undefined; }
}

/** The home folders, longest first, each without a trailing slash; none that is "/" or empty. */
export function homeFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const all = [env.HOME, homedir(), accountHome()].map((h) => (h ?? '').replace(/\/+$/, '')).filter((h) => h.length > 1);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** `text` with every path under a home folder written from "~" (at a folder boundary only: a home "<h>" never matches "<h>c"). */
export function scrubHomes(text: string, env?: NodeJS.ProcessEnv): string {
  let out = text;
  for (const home of homeFolders(env)) {
    let at = out.indexOf(home);
    while (at >= 0) {
      const after = out[at + home.length];
      if (after === undefined || after === '/' || !/[A-Za-z0-9._-]/.test(after)) {
        out = `${out.slice(0, at)}~${out.slice(at + home.length)}`;
        at = out.indexOf(home, at + 1);
      } else at = out.indexOf(home, at + 1);
    }
  }
  return out;
}

/** One path from "~" when it is a home folder or under one; else as it is. */
export function tildePath(p: string, env?: NodeJS.ProcessEnv): string {
  for (const home of homeFolders(env)) if (p === home || p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}
