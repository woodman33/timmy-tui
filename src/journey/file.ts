/**
 * R10 (H164): a project file as the companion's preview draws it (journey step 3, "open a project artifact in the companion
 * preview"). openTarget sends a reference, or a result no run's detail holds, to the companion's ?tab=home&file=<hex>; the
 * companion serves the file itself at GET /api/journey/file?project=<id>&path=<its path in the project> (./routes.ts), from here:
 *
 *   an image (png, jpg, jpeg, webp, gif) up to 4 MB   its bytes as a data URL, its type read from its own first bytes (the
 *                                                       extension only chooses image or text), its width and height from its
 *                                                       header
 *   a text file (TEXT_EXTENSIONS, ./open.ts)            its first 64 KB, cut at a line (or at a whole character when no line
 *                                                       ends in its second half), UTF-8 only, the home folder written as ~
 *   anything else                                       refused, in words: a path that is not one in the project ("..",
 *                                                       absolute, ".", a control character), a dot-folder or dotfile (.timmy,
 *                                                       .git, .env) or a key file, one reached through a link (any link on the
 *                                                       way, even one that stays inside), no such file, a folder, a pipe or a
 *                                                       device, another type, an image over 4 MB, a file whose bytes are not
 *                                                       what its name says
 *
 * The file is read through one descriptor opened without following a link and without waiting on a pipe, checked to be the
 * file that was looked at. Nothing is written. No answer carries a path of this computer: only the path in the project, and
 * a refused path that is not one in the project is not repeated.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { join, sep } from 'node:path';
import { humanBytes, privatePath } from '../project/index.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { IMAGE_EXTENSIONS, previewOf, projectPath, TEXT_EXTENSIONS } from './open.js';

/** The largest image the preview draws, and the most of a text file it reads. */
export const FILE_IMAGE_MAX = 4 * 1024 * 1024;
export const FILE_TEXT_MAX = 64 * 1024;

export type FileRefusal = 'path' | 'private' | 'missing' | 'link' | 'not-file' | 'type' | 'too-big' | 'not-image' | 'not-text' | 'unreadable';
export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ProjectFileImage { ok: true; path: string; kind: 'image'; mime: string; size: number; data: string; width: number; height: number; words: string }
export interface ProjectFileText { ok: true; path: string; kind: 'text'; mime: string; size: number; data: string; truncated: boolean; words: string }
/** A refusal: `path` is the path asked when it is one in the project, else null (a path of this computer is never repeated). */
export interface ProjectFileRefused { ok: false; path: string | null; refusal: FileRefusal; why: string }
export type ProjectFileAnswer = ProjectFileImage | ProjectFileText | ProjectFileRefused;

const IMAGE_MIME: Readonly<Record<ImageType, string>> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const IMAGE_WORD: Readonly<Record<ImageType, string>> = { png: 'PNG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP' };
const TEXT_MIME: Readonly<Record<string, string>> = {
  md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', jsonl: 'application/x-ndjson', csv: 'text/csv',
  tsv: 'text/tab-separated-values', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml', xml: 'application/xml',
  html: 'text/html', py: 'text/x-python', ts: 'text/typescript', js: 'text/javascript', mjs: 'text/javascript', sh: 'text/x-shellscript',
};

const extOf = (path: string): string => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
const shown = (path: string): string => (path.length > 120 ? `${path.slice(0, 119)}…` : path);
const refused = (path: string | null, refusal: FileRefusal, why: string): ProjectFileRefused => ({ ok: false, path, refusal, why });

/** An image's type and size in pixels from its own first bytes (PNG, JPEG, GIF, WebP); null when they are not one of these. */
export function imageHeader(buf: Buffer): { type: ImageType; mime: string; width: number; height: number } | null {
  const sized = (type: ImageType, width: number, height: number) => (width > 0 && height > 0 ? { type, mime: IMAGE_MIME[type], width, height } : null);
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('latin1', 12, 16) === 'IHDR') {
      return sized('png', buf.readUInt32BE(16), buf.readUInt32BE(20));
    }
    if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return sized('gif', buf.readUInt16LE(6), buf.readUInt16LE(8));
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      // a JPEG: its markers walked to the frame's (SOF0..SOF15, not DHT, JPG or DAC), which holds the height, then the width
      for (let i = 2; i + 3 < buf.length;) {
        if (buf[i] !== 0xff) return null;
        const m = buf[i + 1];
        if (m === 0xff) { i += 1; continue; }
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
        if (m === 0xd9 || m === 0xda) return null; // the image's end, or its scan, before any frame
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 8 < buf.length ? sized('jpeg', buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)) : null;
        i += 2 + len;
      }
      return null;
    }
    if (buf.length >= 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8X' && buf.length >= 30) return sized('webp', 1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
      if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) { const b = buf.readUInt32LE(21); return sized('webp', (b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1); }
      if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return sized('webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    }
  } catch { /* its header is cut short */ }
  return null;
}

/** UTF-8 text from `buf` (cut short when `cut`: at its last line end in its second half, else at a whole character); null when it is not text. */
function textOf(buf: Buffer, cut: boolean): string | null {
  if (buf.includes(0)) return null;
  let b = buf;
  if (cut) {
    const nl = b.lastIndexOf(0x0a);
    if (nl >= b.length / 2) b = b.subarray(0, nl + 1);
  }
  const decode = (x: Buffer): string | null => { try { return new TextDecoder('utf-8', { fatal: true }).decode(x); } catch { return null; } };
  const whole = decode(b);
  if (whole !== null || !cut) return whole;
  // cut inside a character: up to 3 of its bytes left out
  for (let k = 1; k <= 3 && k < b.length; k++) { const t = decode(b.subarray(0, b.length - k)); if (t !== null) return t; }
  return null;
}

/** Up to `max` bytes of the file `fd` from its start. */
function readStart(fd: number, max: number): Buffer {
  const buf = Buffer.alloc(max);
  let n = 0;
  while (n < max) {
    const got = readSync(fd, buf, n, max - n, n);
    if (got === 0) break;
    n += got;
  }
  return buf.subarray(0, n);
}

/**
 * The file at `rel` in `project` (its folder `root`) as the preview draws it, or why not. `env`: whose home folder is written
 * as ~ in a text (this process's when not given).
 */
export function projectFile(project: { name: string; root: string }, rel: unknown, env?: NodeJS.ProcessEnv): ProjectFileAnswer {
  if (typeof rel !== 'string' || rel === '') return refused(null, 'path', 'Name the file to preview as ?path=<its path in the project>.');
  const parts = rel.split(/[\\/]/);
  if (!projectPath(rel) || parts.includes('.')) {
    return refused(null, 'path', 'The path asked is not a path in the project: the preview names a file by its path in the project\'s folder (relative, with no "." or "..").');
  }
  if (parts.some((p) => p.startsWith('.')) || privatePath(rel)) {
    return refused(rel, 'private', `${shown(rel)} is in a dot-folder, is a dotfile or is a key file (.timmy, .git, .env, a key): the preview never reads one.`);
  }
  let realRoot: string;
  try { realRoot = realpathSync(project.root); } catch { return refused(rel, 'unreadable', `The project ${project.name}'s folder could not be read here, so nothing is previewed.`); }
  // the path as named in the project's real folder; its real path is the same path when no link is on the way
  const named = join(realRoot, rel);
  let real: string;
  try { real = realpathSync(named); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? refused(rel, 'missing', `${shown(rel)} is not a file of this project, so nothing is previewed.`)
      : refused(rel, 'unreadable', `${shown(rel)} could not be read here, so nothing is previewed.`);
  }
  if (real !== named || !real.startsWith(`${realRoot}${sep}`)) {
    return refused(rel, 'link', `${shown(rel)} is reached through a link: the preview reads only a file in the project's own folder, with no link on the way.`);
  }
  let st: Stats;
  try { st = lstatSync(named); } catch { return refused(rel, 'unreadable', `${shown(rel)} could not be read here, so nothing is previewed.`); }
  if (st.isDirectory()) return refused(rel, 'not-file', `${shown(rel)} is a folder, not a file, so nothing is previewed.`);
  if (!st.isFile()) return refused(rel, 'not-file', `${shown(rel)} is not a regular file (a pipe, a device or a socket), so nothing is previewed.`);
  const kind = previewOf(rel);
  if (kind !== 'image' && kind !== 'text') {
    const ext = extOf(rel);
    return refused(rel, 'type', `${shown(rel)} is ${ext ? `a .${ext} file` : 'a file with no extension'}: the preview draws ${IMAGE_EXTENSIONS.slice(0, -1).join(', ')} and ${IMAGE_EXTENSIONS.at(-1)} images, and text files (${TEXT_EXTENSIONS.map((e) => `.${e}`).join(' ')}).`);
  }
  if (kind === 'image' && st.size > FILE_IMAGE_MAX) return refused(rel, 'too-big', `${shown(rel)} is ${humanBytes(st.size)}: the preview draws an image up to ${FILE_IMAGE_MAX / 1024 / 1024} MB.`);

  // one descriptor: no link followed, no wait on a pipe put there since, and the file it opens is the one looked at above
  let fd: number;
  try { fd = openSync(named, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch {
    return refused(rel, 'unreadable', `${shown(rel)} could not be read here, so nothing is previewed.`);
  }
  try {
    const now = fstatSync(fd);
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return refused(rel, 'unreadable', `${shown(rel)} changed while it was read, so nothing is previewed.`);
    if (kind === 'image') {
      if (now.size > FILE_IMAGE_MAX) return refused(rel, 'too-big', `${shown(rel)} is ${humanBytes(now.size)}: the preview draws an image up to ${FILE_IMAGE_MAX / 1024 / 1024} MB.`);
      const bytes = readStart(fd, Math.min(now.size, FILE_IMAGE_MAX));
      const head = imageHeader(bytes);
      if (!head) return refused(rel, 'not-image', `${shown(rel)} does not read as a PNG, JPEG, GIF or WebP image (its first bytes are not one), so it is not drawn.`);
      return {
        ok: true, path: rel, kind: 'image', mime: head.mime, size: bytes.length, data: `data:${head.mime};base64,${bytes.toString('base64')}`,
        width: head.width, height: head.height,
        words: `${shown(rel)}: a ${IMAGE_WORD[head.type]} image, ${head.width} × ${head.height} pixels, ${humanBytes(bytes.length)}, in ${project.name}.`,
      };
    }
    const cut = now.size > FILE_TEXT_MAX;
    const text = textOf(readStart(fd, Math.min(now.size, FILE_TEXT_MAX)), cut);
    if (text === null) return refused(rel, 'not-text', `${shown(rel)} is not UTF-8 text (it holds a NUL byte, or bytes that are not UTF-8), so it is not shown.`);
    return {
      ok: true, path: rel, kind: 'text', mime: TEXT_MIME[extOf(rel)] ?? 'text/plain', size: now.size, data: scrubHomes(text, env), truncated: cut,
      words: `${shown(rel)}: text, ${humanBytes(now.size)}, ${cut ? `its first ${FILE_TEXT_MAX / 1024} KB shown` : 'shown whole'}, in ${project.name}.`,
    };
  } catch {
    return refused(rel, 'unreadable', `${shown(rel)} could not be read here, so nothing is previewed.`);
  } finally { closeSync(fd); }
}
