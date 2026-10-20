// The folders beside the current one that hold a .timmy folder: the LIBRARY › BOARDS pane's PROJECTS line.
//
// R9 lead (item B, found by R9's qualification of 1fa4020: tests/keyboard-contract.pty.test.ts failed 2 of 2, each with a
// blank screen for 8 s and the fixture's render() never returning). ShellV2's first render used to read this list
// itself, synchronously: readdirSync of the folder above the current one, then existsSync(<entry>/.timmy) for every entry,
// with no bound. The keyboard fixture runs in /tmp/timmy-kb-…, and this machine's /tmp held 33,553 entries, so the first
// frame waited on tens of thousands of synchronous stats; anyone starting Timmy in a folder whose parent is that full (a
// home folder, /tmp) waited the same way. Now the list is read here, asynchronously, after the first frame, and at most
// SIBLING_LIMIT entries are looked at; `more` says that entries were left unread, so the line can say so.
import { opendir, access } from 'node:fs/promises';
import { join } from 'node:path';

export const SIBLING_LIMIT = 2000;

export interface SiblingProjects {
  /** The entries, among those looked at, that hold a .timmy (sorted). */
  names: string[];
  /** How many of the folder's entries were looked at. */
  looked: number;
  /** True when the folder has entries beyond those looked at. */
  more: boolean;
}

/**
 * The entries of `parent` that hold a `.timmy`, looking at no more than `limit` entries, in the order the directory gives
 * them. Never synchronous. A folder that cannot be read gives no names (it is not an error here: the line says "—").
 */
export async function siblingProjects(parent: string, o: { limit?: number } = {}): Promise<SiblingProjects> {
  const limit = Math.max(0, o.limit ?? SIBLING_LIMIT);
  const names: string[] = [];
  let looked = 0;
  let more = false;
  let dir;
  try { dir = await opendir(parent); } catch { return { names, looked, more }; }
  // for await closes the directory when the loop ends, breaks or throws
  try {
    for await (const e of dir) {
      if (looked >= limit) { more = true; break; }
      looked += 1;
      // a regular file cannot hold a .timmy; anything else is asked (a link may point at a folder that does)
      if (e.isFile()) continue;
      try { await access(join(parent, e.name, '.timmy')); names.push(e.name); } catch { /* none here */ }
    }
  } catch { /* the folder changed or went away while read: what was read stands */ }
  return { names: names.sort((a, b) => a.localeCompare(b)), looked, more };
}

/** The PROJECTS line's words (before the pane's own 70-column bound). */
export function siblingProjectsWords(s: SiblingProjects | null): string {
  if (!s) return 'PROJECTS  being read';
  const list = s.names.length ? `${s.names.slice(0, 2).join(' · ')}${s.names.length > 2 ? ` +${s.names.length - 2}` : ''}` : '—';
  return `PROJECTS  ${list}${s.more ? ` · the first ${s.looked} entries read` : ''}`;
}
