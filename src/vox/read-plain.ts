/**
 * R6 (H143, after the lead's review of dcce794): a file inside a project read for a page through one descriptor, so the file
 * that was checked is the file that is read. The operator's rule (R5, 22:32): running as the same OS user does not by itself
 * make a project-scoped read safe.
 *
 * Checked first: every part of the path below the project is a real folder, not a link; the file itself is a regular file,
 * not a link, of at most `max` bytes. Then it is opened without following a link (O_NOFOLLOW) and without waiting on a FIFO
 * (O_NONBLOCK); the open file must be the very file checked (a regular file with the same device and inode), and is read whole
 * through that descriptor, its size and times unchanged by the end. Last, the path is walked again and must still lead, with
 * no link, to that same file. A file swapped between the checks and the read (for a link, for another file, for a FIFO, or a
 * folder above it for a link) is refused as "changed while it was read"; nothing is read through the swap.
 *
 * A hard link inside the project is that file inside the project (it is one inode with two names), so it is read.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';

export type PlainWhy = 'path' | 'missing' | 'link' | 'not-file' | 'too-large' | 'changed' | 'unreadable';
/** The bytes, or why not: `words` is the reason in a few words, without the path (callers say whose file it is). */
export type PlainRead = { ok: true; body: Buffer } | { ok: false; why: PlainWhy; words: string };
/** For tests only: runs after the checks, before the open (where a swap would be read through by a read by name). */
export interface PlainReadHooks { beforeOpen?: () => void }

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

const no = (why: PlainWhy, words: string): PlainRead => ({ ok: false, why, words });
const changed = (how: string): PlainRead => no('changed', `it changed while it was read (${how})`);

/** A path inside the project as records write it: '/'-separated, no "..", ".", empty part, leading '/', '\' or NUL. */
export const plainRel = (rel: string): boolean =>
  typeof rel === 'string' && !!rel && rel.length <= 1024 && !rel.includes('\0') && !rel.includes('\\') && !rel.startsWith('/') && !rel.split('/').some((s) => s === '..' || s === '.' || s === '');

/** The path's file as checked, walking from the project folder down without following any link. */
function walk(base: string, parts: readonly string[]): { st: BigIntStats } | PlainRead {
  let at = base;
  for (let k = 0; k < parts.length; k++) {
    at = join(at, parts[k]);
    let st: BigIntStats;
    try { st = lstatSync(at, { bigint: true }); } catch { return no('missing', 'it is not there'); }
    if (st.isSymbolicLink()) return no('link', 'it is reached through a link');
    if (k < parts.length - 1) { if (!st.isDirectory()) return no('missing', 'it is not there'); continue; }
    if (!st.isFile()) return no('not-file', 'it is not a regular file');
    return { st };
  }
  return no('path', 'it is not a path inside the project');
}

/** The bytes of `rel` inside `root` (at most `max`), read as the file comment above says, or why not. */
export function readPlainInside(root: string, rel: string, max: number, hooks: PlainReadHooks = {}): PlainRead {
  if (!plainRel(rel)) return no('path', 'it is not a path inside the project');
  let base: string;
  try { base = realpathSync(root); } catch { return no('missing', 'the project folder is gone'); }
  const parts = rel.split('/');
  const checked = walk(base, parts);
  if (!('st' in checked)) return checked;
  if (checked.st.size > BigInt(max)) return no('too-large', `it is larger than ${max / 1024 / 1024} MB`);
  hooks.beforeOpen?.();
  let fd: number;
  try { fd = openSync(join(base, ...parts), constants.O_RDONLY | NOFOLLOW | NONBLOCK); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // O_NOFOLLOW on a link: ELOOP (Linux, macOS), EMLINK (FreeBSD)
    if (code === 'ELOOP' || code === 'EMLINK') return changed('it is a link now');
    if (code === 'ENOENT') return changed('it is gone');
    return no('unreadable', `it cannot be read (${code ?? 'error'})`);
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== checked.st.dev || before.ino !== checked.st.ino) return changed('it is not the file that was checked');
    if (before.size > BigInt(max)) return no('too-large', `it is larger than ${max / 1024 / 1024} MB`);
    const size = Number(before.size);
    const buf = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buf.length) { const n = readSync(fd, buf, length, buf.length - length, null); if (!n) break; length += n; }
    const after = fstatSync(fd, { bigint: true });
    if (length !== size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return changed('its bytes changed during the read');
    const again = walk(base, parts);
    if (!('st' in again) || again.st.dev !== before.dev || again.st.ino !== before.ino) return changed('its path no longer leads to the file read');
    return { ok: true, body: buf.subarray(0, size) };
  } catch (e) {
    return no('unreadable', `it cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  } finally { closeSync(fd); }
}
