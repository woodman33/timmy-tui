/**
 * Round R4 (helper H93): the operator's token for Timmy Cloud's backend, as the client may hold it: only in a file of the
 * operator's own, readable by its owner alone (0600 or 0400), named by its path. The client reads the file at each read of
 * the backend and keeps the token in memory for that read only: it never copies it into a file of its own, never prints it,
 * and takes it out of every word it prints or stores (redactToken). A looser file, a symbolic link, another account's file,
 * an empty or oversized one are refused, in words that name the file and never its contents.
 *
 * The backend's address: http:// only to a loopback address (127.0.0.1, ::1, localhost: the token never crosses a network
 * unencrypted), https:// anywhere; no user name or password, query or fragment in it.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { tildePath } from '../utils/home-scrub.js';

/** What a token must look like: one line of printable characters, no spaces (the backend reads `Bearer <token>` so). */
export const TOKEN_SHAPE = /^[\x21-\x7E]{16,512}$/;
const MAX_FILE = 4096;

export type TokenRead = { ok: true; token: string } | { ok: false; why: string };

/** The token in `file` (absolute), or why the file is refused. Nothing in `why` comes from the file's contents. */
export function readTokenFile(file: string): TokenRead {
  const shown = tildePath(file);
  let st;
  try { st = lstatSync(file); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, why: code === 'ENOENT' ? `the token file ${shown} does not exist` : `the token file ${shown} cannot be read (${code ?? 'error'})` };
  }
  if (st.isSymbolicLink()) return { ok: false, why: `the token file ${shown} is a symbolic link: name the file itself (the client reads a token only from a regular file of yours)` };
  if (!st.isFile()) return { ok: false, why: `the token file ${shown} is not a regular file` };
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, why: `the token file ${shown} belongs to another account: the client reads a token only from a file of yours` };
  if ((st.mode & 0o077) !== 0) {
    return { ok: false, why: `the token file ${shown} can be read or changed by others (mode ${(st.mode & 0o777).toString(8)}): the client reads the operator's token only from a file its owner alone can read (chmod 600 ${shown})` };
  }
  if (st.size === 0) return { ok: false, why: `the token file ${shown} is empty` };
  if (st.size > MAX_FILE) return { ok: false, why: `the token file ${shown} is larger than ${MAX_FILE} bytes: it is not a token file` };
  let text: string;
  let fd: number | undefined;
  try {
    // O_NOFOLLOW: a link put in its place since the check is not followed; the same file is checked again once open
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const again = fstatSync(fd);
    if (again.ino !== st.ino || again.dev !== st.dev || (again.mode & 0o077) !== 0) return { ok: false, why: `the token file ${shown} changed while it was read: not read` };
    text = readFileSync(fd, 'utf8');
  } catch (e) {
    return { ok: false, why: `the token file ${shown} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
  const token = text.replace(/^\s+|\s+$/g, '');
  if (!TOKEN_SHAPE.test(token)) return { ok: false, why: `the token file ${shown} does not hold a token (one line of 16 to 512 printable characters, no spaces)` };
  return { ok: true, token };
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** The backend's address as the client keeps it (origin and path, no trailing slash), or why it is refused. */
export function checkBackendUrl(raw: string): { url: string } | { why: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { why: `${JSON.stringify(raw)} is not an address (http://127.0.0.1:<port>, or https://<host>)` }; }
  if (u.username || u.password) return { why: 'the address holds a user name or password: give the address alone, and the token in its file' };
  if (u.search || u.hash) return { why: 'the address has a query or a fragment: give the backend\'s address alone' };
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) {
    return { why: `http:// sends the operator's token unencrypted: it is allowed only to this computer (127.0.0.1, ::1, localhost); use https:// for ${u.hostname}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { why: `${u.protocol} is not http: or https:` };
  const pathPart = u.pathname.replace(/\/+$/, '');
  return { url: `${u.protocol}//${u.host}${pathPart}` };
}

/** `text` with the token taken out in every form it could take (as is, JSON-escaped, URL-encoded, base64). */
export function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  let out = text;
  const forms = [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token), Buffer.from(token, 'utf8').toString('base64')];
  for (const f of [...new Set(forms)].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length)) out = out.split(f).join('[REDACTED_OPERATOR_TOKEN]');
  return out;
}
