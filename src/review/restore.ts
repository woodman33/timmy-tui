/**
 * Round R4 (H65): `/restore <file> --from <kept previous version>`, and Restore on the live board (the same typed command,
 * through the board's token-checked actions). It writes a kept previous version back over a project file, exactly and only
 * when all of this holds now:
 *   - both are plain paths inside the project, neither is private (src/project/index.ts resolveInside and privatePath),
 *     the file is not one of Timmy's own (.timmy), and neither is reached through a symbolic link;
 *   - no flow runs in the project (the flow hold: a flow of this REPL, or another Timmy process's hold);
 *   - a record Timmy's writers keep names that copy as the previous version of that file (src/review/changes.ts
 *     findKeptChange: a flow's copy as read, an OpenHands before/ copy, a copy the board's saves or /restore kept), and
 *     the receipt that sealed that record verifies;
 *   - the copy's bytes are that previous version (their sha256 now is the one the record gives);
 *   - the file is exactly what the run left (its sha256 now is the one the record gives; a file the run deleted is still
 *     not there).
 * Then the file's current version is kept first under .timmy/restore-history/<file>/ (written once, read-only), the copy's
 * bytes are written beside the file and renamed over it (a deleted file is put back only where nothing is), read back, and
 * an edit receipt is sealed, human-gated as the board's saves are, naming the file's sha256 before and after, the version
 * kept and the copy restored. Anything else is refused with the reason, and nothing is written.
 */
import { closeSync, constants, copyFileSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { resolveInside } from '../project/index.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';
import { findKeptChange, parseRestoreArgs, RESTORE_HISTORY_DIR, short, type ReviewChange } from './changes.js';

/** The largest previous version a restore writes back (a larger one is restored by hand). */
export const RESTORE_MAX_BYTES = 64 * 1024 * 1024;

export interface RestoreContext {
  root: string;
  project: string;
  projectId: string;
  /** the runs chain as it is now */
  chain: () => readonly Receipt[];
  /** seals the edit's receipt on the runs chain; its short id back */
  seal?: (input: ReceiptInput) => string | undefined;
  /** the flow running (or being started) in this project, here or in another Timmy process (src/repl/iterate.ts runningIn) */
  flowIn?: () => { id?: string; step: string; elsewhere?: string } | undefined;
}

export type Restored =
  | { ok: true; file: string; from: string; sha256: string; bytes: number; previous: string | null; kept?: string; receipt?: string; change: ReviewChange; note?: string }
  | { ok: false; why: string; usage?: true; change?: ReviewChange };

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const no = (why: string, change?: ReviewChange): Restored => ({ ok: false, why, ...(change ? { change } : {}) });

type Walked = { ok: true; abs: string; exists: boolean; mode?: number } | { ok: false; why: string };

/**
 * `rel` under the project's real folder, part by part: no part is a symbolic link, every folder on the way is a folder, and
 * the last part, when it is there, is a regular file (its mode back). A part that is not there ends the walk: not there.
 */
function walk(realRoot: string, rel: string): Walked {
  const parts = rel.split('/');
  let at = realRoot;
  for (let i = 0; i < parts.length; i++) {
    at = path.join(at, parts[i]);
    const shown = parts.slice(0, i + 1).join('/');
    let st;
    try { st = lstatSync(at); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, abs: path.join(realRoot, ...parts), exists: false };
      return { ok: false, why: `${shown} cannot be looked at (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    if (st.isSymbolicLink()) return { ok: false, why: `${shown} is a symbolic link: a restore reads and writes only in place` };
    if (i < parts.length - 1 && !st.isDirectory()) return { ok: false, why: `${shown} is not a folder` };
    if (i === parts.length - 1) return st.isFile() ? { ok: true, abs: at, exists: true, mode: st.mode & 0o7777 } : { ok: false, why: `${rel} is not a regular file` };
  }
  return { ok: false, why: `${rel} is not a path in the project` };
}

/** The folders of `relDir` under the project's real folder, made where they are missing, never through a link. */
function folders(realRoot: string, relDir: string): { ok: true; abs: string } | { ok: false; why: string } {
  let at = realRoot;
  for (const part of relDir.split('/').filter(Boolean)) {
    at = path.join(at, part);
    try {
      const st = lstatSync(at);
      if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, why: `${path.relative(realRoot, at).split(path.sep).join('/')} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a folder'}` };
    } catch {
      try { mkdirSync(at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, why: `${(e as NodeJS.ErrnoException).code ?? 'error'} making ${path.relative(realRoot, at).split(path.sep).join('/')}` }; }
      try { if (lstatSync(at).isSymbolicLink() || !lstatSync(at).isDirectory()) return { ok: false, why: `${path.relative(realRoot, at).split(path.sep).join('/')} is not a folder` }; } catch { return { ok: false, why: 'a folder went away while it was made' }; }
    }
  }
  return { ok: true, abs: at };
}

/** The file's current bytes, kept once and read-only under .timmy/restore-history/<file>/ (never over another kept one). */
function keepCurrent(realRoot: string, file: string, bytes: Buffer, digest: string): { ok: true; rel: string } | { ok: false; why: string } {
  const when = new Date().toISOString().replace(/[:.]/g, '-');
  const dirRel = `${RESTORE_HISTORY_DIR}/${file}`;
  const dir = folders(realRoot, dirRel);
  if (!dir.ok) return { ok: false, why: `${dirRel} could not be made in place (${dir.why})` };
  for (let n = 1; n <= 20; n++) {
    const name = `${when}-${digest.slice(0, 12)}${n > 1 ? `-${n}` : ''}${path.posix.extname(file)}.bak`;
    const abs = path.join(dir.abs, name);
    let fd: number | undefined;
    try {
      fd = openSync(abs, 'wx', 0o444);
      writeFileSync(fd, bytes);
      closeSync(fd);
      fd = undefined;
    } catch (e) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, why: `${(e as NodeJS.ErrnoException).code ?? 'error'} writing ${dirRel}/${name}` };
    }
    if (sha(readFileSync(abs)) !== digest) return { ok: false, why: `${dirRel}/${name} reads back differently` };
    return { ok: true, rel: `${dirRel}/${name}` };
  }
  return { ok: false, why: `no free name in ${dirRel}` };
}

/**
 * The bytes written beside `abs` (a new file, created exclusively) and then put in its place: renamed over the file when it
 * is there (`replace`); when it is not, linked into place, which fails rather than replace anything that has appeared there.
 */
function place(abs: string, bytes: Buffer, mode: number, replace: boolean): { ok: true } | { ok: false; why: string } {
  const dir = path.dirname(abs);
  let tmp = '';
  let fd: number | undefined;
  for (let i = 0; i < 8 && fd === undefined; i++) {
    tmp = path.join(dir, `.${path.basename(abs).slice(0, 80)}.timmy-restore-${randomBytes(6).toString('hex')}.tmp`);
    try { fd = openSync(tmp, 'wx', mode); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, why: `its new version could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'})` }; }
  }
  if (fd === undefined) return { ok: false, why: 'no free temporary name beside it' };
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, mode);
    closeSync(fd);
    fd = undefined;
    if (replace) { renameSync(tmp, abs); return { ok: true }; }
    try { linkSync(tmp, abs); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return { ok: false, why: 'something is at its place now; nothing was replaced' };
      // A file system without hard links: copied into place, still never over anything (COPYFILE_EXCL).
      copyFileSync(tmp, abs, constants.COPYFILE_EXCL);
    }
    try { unlinkSync(tmp); } catch { /* gone */ }
    return { ok: true };
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
    try { unlinkSync(tmp); } catch { /* gone */ }
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, why: code === 'EEXIST' ? 'something is at its place now; nothing was replaced' : `it could not be put in place (${code ?? 'error'})` };
  }
}

/** The args of `/restore`, checked, and the restore done; or why not, with nothing written. */
export function restore(args: string, c: RestoreContext): Restored {
  const parsed = parseRestoreArgs(args);
  if (!parsed.ok) return { ok: false, why: parsed.error, usage: true };
  // Inside the project, not private, not Timmy's own.
  const fileAt = resolveInside(c.root, parsed.file);
  if ('error' in fileAt) return no(`${parsed.file}: ${fileAt.error}`);
  const fromAt = resolveInside(c.root, parsed.from);
  if ('error' in fromAt) return no(`${parsed.from}: ${fromAt.error}`);
  const file = fileAt.rel;
  const from = fromAt.rel;
  if (file.split('/').includes('.timmy')) return no(`${file} is one of Timmy's own records: a restore writes only the project's files`);
  // Not while a flow runs in the project: its agent may be changing this very file.
  const flow = c.flowIn?.();
  if (flow) {
    const who = flow.id ? `flow ${flow.id} is running` : 'a flow is being started';
    return no(flow.elsewhere ? `${who} in this project ${flow.elsewhere}: restore after it ends` : `${who} in this project: restore after it ends, or /stop it`);
  }
  // The record that names the copy as this file's previous version, every check of /review made again now.
  const found = findKeptChange({ root: c.root, projectId: c.projectId, chain: c.chain() }, file, from);
  if (!found.ok) return no(found.why);
  const change = found.change;
  // What the review decided from its record stands (added, a link, nothing kept, a record no receipt seals). Whether the copy
  // is the previous version and the file is what the run left is decided below from the bytes read now, never from a hash
  // the review keeps between redraws.
  const bytesDecide = (change.how === 'changed' || change.how === 'deleted') && !change.link && change.check.status === 'verified'
    && (change.kept?.state === 'ok' || change.kept?.state === 'differs');
  if (!change.restore.offered && !bytesDecide) return no(change.restore.why, change);
  let realRoot: string;
  try { realRoot = realpathSync(c.root); } catch { return no('the project folder is gone', change); }
  // The copy: in place, a regular file, its bytes the previous version.
  const keptAt = walk(realRoot, from);
  if (!keptAt.ok) return no(keptAt.why, change);
  if (!keptAt.exists) return no(`the kept copy at ${from} is gone`, change);
  let kept: Buffer;
  try {
    if (lstatSync(keptAt.abs).size > RESTORE_MAX_BYTES) return no(`the kept copy is larger than ${RESTORE_MAX_BYTES / 1024 / 1024} MB: copy it back by hand if you mean to`, change);
    kept = readFileSync(keptAt.abs);
  } catch (e) { return no(`the kept copy could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`, change); }
  const keptSha = sha(kept);
  if (keptSha !== change.before) return no(`the copy at ${from} is not the previous version any more: sha256 ${short(keptSha)}, its record says ${short(change.before)}`, change);
  // The file: in place, and exactly what the run left (a file the run deleted: still not there).
  const fileNow = walk(realRoot, file);
  if (!fileNow.ok) return no(fileNow.why, change);
  let current: Buffer | undefined;
  if (change.how === 'deleted') {
    if (fileNow.exists) return no(`${file} is there again since the run: a restore writes only where the run left nothing`, change);
  } else {
    if (!fileNow.exists) return no(`${file} is gone since the run: a restore writes only over the file exactly as the run left it`, change);
    try { current = readFileSync(fileNow.abs); } catch (e) { return no(`${file} could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`, change); }
    const nowSha = sha(current);
    if (nowSha !== change.after) return no(`${file} changed since the run (sha256 ${short(nowSha)} now; the run left ${short(change.after)}): restoring would replace a later version`, change);
    if (nowSha === keptSha) return no(`${file} already holds that version (sha256 ${short(keptSha)}); nothing was written`, change);
  }
  const currentSha = current ? sha(current) : null;
  // The current version first, kept where /review finds it (the edit receipt below names it as the previous version).
  let keptRel: string | undefined;
  if (current) {
    const k = keepCurrent(realRoot, file, current, currentSha!);
    if (!k.ok) return no(`nothing was written: the current version of ${file} could not be kept first (${k.why})`, change);
    keptRel = k.rel;
  }
  // Right before it is replaced, the file must still be the bytes that were kept (or still not there).
  const again = walk(realRoot, file);
  if (!again.ok) return no(`${again.why}; nothing was written${keptRel ? ` (its version is kept at ${keptRel})` : ''}`, change);
  if (current) {
    let nowBytes: Buffer;
    try { nowBytes = readFileSync(again.abs); } catch { return no(`${file} went away while it was being restored; nothing was written (its version is kept at ${keptRel})`, change); }
    if (!again.exists || sha(nowBytes) !== currentSha) return no(`${file} changed while it was being restored; nothing was written over it (the version it had is kept at ${keptRel})`, change);
  } else if (again.exists) return no(`${file} appeared while it was being restored; nothing was written`, change);
  let note: string | undefined;
  if (!current) {
    const dir = folders(realRoot, path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file));
    if (!dir.ok) return no(`its folder could not be made in place (${dir.why}); nothing was written`, change);
    note = 'it was not there: put back with mode 644 (its mode before the run is not recorded)';
  }
  const placed = place(again.abs, kept, current ? fileNow.mode ?? 0o644 : 0o644, !!current);
  if (!placed.ok) return no(`${file} was not restored: ${placed.why}${keptRel ? `; its version is kept at ${keptRel}` : ''}`, change);
  let written: string;
  try { written = sha(readFileSync(again.abs)); } catch { written = ''; }
  if (written !== keptSha) return no(`${file} reads back differently after the restore (sha256 ${short(written) || 'unreadable'}); its version before is kept${keptRel ? ` at ${keptRel}` : ''}`, change);
  let receipt: string | undefined;
  try {
    receipt = c.seal?.({
      kind: 'edit', subject: `edit · ${file} · restored from ${from} (/restore)`, policy: 'human-gated', status: 'ok', project: c.project, project_id: c.projectId,
      files: [{ path: file, sha256: keptSha, ...(currentSha ? { previous_sha256: currentSha } : {}), created: !current, bytes: kept.length }],
      sources: [
        { path: from, sha256: keptSha, role: 'restored from' },
        ...(keptRel ? [{ path: keptRel, sha256: currentSha, role: 'previous version' }] : []),
        { role: 'the record naming it as the previous version', ...(change.record ? { path: change.record } : {}), ...(change.receipt ? { receipt: change.receipt } : {}), by: change.by },
      ],
    });
  } catch { receipt = undefined; }
  return { ok: true, file, from, sha256: keptSha, bytes: kept.length, previous: currentSha, ...(keptRel ? { kept: keptRel } : {}), ...(receipt ? { receipt } : {}), change, ...(note ? { note } : {}) };
}
