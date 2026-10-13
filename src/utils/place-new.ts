/**
 * A finished temporary file takes its final name, and nothing is ever replaced (round R4, the review's R4-7). This is
 * the fallback src/vision/kept.ts had, made one helper: kept.ts (an observation's kept files), src/repl/recover.ts (the
 * record of an interrupted flow) and src/recipes deliver (a recipe's copied exports) all go through it.
 *
 * link(2) gives the file its final name and fails on a name that is taken. Some disks make no hard links (exFAT and FAT
 * drives, some network shares): link then fails with one of NO_LINKS, and the file is placed by rename(2) instead, once
 * lstat finds nothing at its final name; a taken name is refused there too (EEXIST), as link refuses it. On such a disk
 * a file made in the moment between that check and the rename would be replaced: nothing closer is available there.
 */
import fs from 'node:fs';

/** link(2)'s errors that mean this disk or folder makes no hard links: the file is then renamed into place. */
export const NO_LINKS: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS']);

const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? '';

/**
 * Gives the file at `tmp` the name `dest` when nothing is there. 'linked': `tmp` is then a second name for the same
 * file, for the caller to remove; 'renamed': `tmp` is gone. Throws EEXIST when `dest` is taken, and any other error as it
 * came. `link` is the hard-link call: fs.linkSync, or a test seam that throws as a disk without hard links does.
 */
export function placeNew(tmp: string, dest: string, link: (existing: string, made: string) => void = (a, b) => fs.linkSync(a, b)): 'linked' | 'renamed' {
  try {
    link(tmp, dest);
    return 'linked';
  } catch (e) {
    if (!NO_LINKS.has(codeOf(e))) throw e;
    let taken = false;
    try { fs.lstatSync(dest); taken = true; } catch { /* free */ }
    if (taken) throw Object.assign(new Error('EEXIST: the name is taken; nothing was replaced'), { code: 'EEXIST' });
    fs.renameSync(tmp, dest);
    return 'renamed';
  }
}
