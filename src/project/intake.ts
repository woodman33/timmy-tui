/**
 * References in (round R2, look): `/add <path…>` copies files into the active project's refs/ folder so
 * the agent can read them (read_project_file) and Look can observe them (/observe). A file is copied,
 * never moved; it keeps its name, and a clash gets -2, -3. Its kind comes from its first bytes where they
 * say, else from its name, and a name that disagrees with the bytes is said. Private names (keys, .env
 * files), a link to one, and folders are refused. What is recorded about a source is its base name only:
 * the folder it came from never reaches a receipt.
 */
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, constants, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { privatePath, resolveInside } from './index.js';

export type IntakeKind = 'image' | 'document' | 'video' | '3d' | 'other';
export interface KindAnswer { kind: IntakeKind; by: 'bytes' | 'name'; note?: string }
export interface IntakeFile { path: string; sha256: string; bytes: number; kind: IntakeKind; by: 'bytes' | 'name'; source_name: string; note?: string }
export interface IntakeResult { added: IntakeFile[]; refused: Array<{ name: string; reason: string }> }

/** The folder inside the project that /add copies into. */
export const REFS_DIR = 'refs';
/** A larger file is refused: /add copies in the foreground. */
export const MAX_INTAKE_BYTES = 2 * 1024 ** 3;

const BY_NAME: Record<string, IntakeKind> = {};
for (const e of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic']) BY_NAME[`.${e}`] = 'image';
for (const e of ['pdf', 'docx', 'md', 'txt']) BY_NAME[`.${e}`] = 'document';
for (const e of ['mp4', 'mov', 'webm']) BY_NAME[`.${e}`] = 'video';
// Scenes and models, including the native apps' own files (Blender, Cinema 4D, Houdini) and CAD exchange (STEP, 3MF).
for (const e of ['glb', 'gltf', 'obj', 'fbx', 'usd', 'usda', 'usdc', 'usdz', 'ply', 'stl', 'abc', 'blend', 'c4d', 'hip', 'hiplc', 'hipnc', 'step', 'stp', '3mf']) BY_NAME[`.${e}`] = '3d';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);
const VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'm4v ', 'qt  ', 'mp71', '3gp4', '3gp5']);

/** What the first bytes say, when they say anything (a zip says nothing: docx and usdz are both zips). */
function byBytes(head: Buffer): IntakeKind | undefined {
  const at = (s: string, offset = 0): boolean => head.length >= offset + s.length && head.subarray(offset, offset + s.length).toString('latin1') === s;
  if (at('\x89PNG\r\n\x1a\n') || (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) || at('GIF87a') || at('GIF89a') || (at('RIFF') && at('WEBP', 8))) return 'image';
  if (at('ftyp', 4)) {
    const brand = head.subarray(8, 12).toString('latin1').toLowerCase();
    if (HEIF_BRANDS.has(brand)) return 'image';
    if (VIDEO_BRANDS.has(brand)) return 'video';
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video';
  if (at('%PDF-')) return 'document';
  if (at('glTF') || at('ply\n') || at('ply\r\n') || at('Kaydara FBX Binary') || at('PXR-USDC') || at('#usda') || at('BLENDER') || at('ISO-10303-21;')) return '3d';
  return undefined;
}

/** A file's kind: its first bytes where they say, else its name. */
export function kindOf(name: string, head: Buffer): KindAnswer {
  const ext = extname(name).toLowerCase();
  const named = BY_NAME[ext] ?? 'other';
  const bytes = byBytes(head);
  if (!bytes) return { kind: named, by: 'name' };
  if (named !== 'other' && named !== bytes) return { kind: bytes, by: 'bytes', note: `the name says ${ext.slice(1)} (${named}); the bytes say ${bytes}` };
  return { kind: bytes, by: 'bytes' };
}

/** Splits a typed line into paths: 'single' and "double" quotes, and backslash escapes (a dragged-in path). */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; }
    else { cur += c; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}

function head(path: string, n = 64): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.alloc(n);
    return b.subarray(0, readSync(fd, b, 0, n, 0));
  } catch { return Buffer.alloc(0); } finally { if (fd !== undefined) closeSync(fd); }
}

/** sha256 of a file, read in pieces (a large reference is never held whole). */
export function hashFile(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest('hex');
}

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const numbered = (name: string, n: number): string => {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem}-${n}${ext && ext !== name ? ext : ''}`;
};

/**
 * Copies each source into <root>/refs/. Relative sources resolve against `cwd` (default: the project).
 * Nothing is moved, and nothing outside refs/ is written.
 */
export function intakeFiles(root: string, sources: string[], opts: { cwd?: string } = {}): IntakeResult {
  const result: IntakeResult = { added: [], refused: [] };
  const cwd = opts.cwd ?? root;
  for (const raw of sources) {
    const given = expandHome(raw);
    const src = isAbsolute(given) ? given : resolve(cwd, given);
    const name = basename(src);
    const refuse = (reason: string): void => { result.refused.push({ name: name || raw, reason }); };
    if (!name || name === '.' || name === '..') { refuse('name a file'); continue; }
    if (privatePath(src) || privatePath(name)) { refuse('a private file (keys, .env files, .git and .timmy/private stay out)'); continue; }
    let st;
    try { st = statSync(src); } catch { refuse('no such file'); continue; }
    if (st.isDirectory()) { refuse('a folder: /add takes files; name the files inside it'); continue; }
    if (!st.isFile()) { refuse('not a regular file'); continue; }
    let real: string;
    try { real = realpathSync(src); } catch { refuse('cannot be resolved'); continue; }
    if (privatePath(real)) { refuse('leads to a private file (keys, .env files, .git and .timmy/private stay out)'); continue; }
    if (name.startsWith('.')) { refuse('a hidden file: it would not show in /files'); continue; }
    if (st.size > MAX_INTAKE_BYTES) { refuse(`larger than ${MAX_INTAKE_BYTES / 1024 ** 3} GB`); continue; }
    // The refs folder must be inside the project, after links resolve.
    const dir = resolveInside(root, REFS_DIR);
    if ('error' in dir) { refuse(dir.error.replace(/^refs /, 'the refs folder ')); continue; }
    try { if (!lstatSync(dir.path).isDirectory()) { refuse('refs is not a folder'); continue; } } catch {
      try { mkdirSync(dir.path, { recursive: true }); } catch (err) { refuse(`refs/ cannot be made (${(err as NodeJS.ErrnoException).code ?? 'error'})`); continue; }
    }
    let copied: { rel: string; path: string } | undefined;
    for (let n = 1; n < 1000 && !copied; n++) {
      const rel = `${REFS_DIR}/${n === 1 ? name : numbered(name, n)}`;
      const at = resolveInside(root, rel);
      if ('error' in at) { refuse(at.error); break; }
      try {
        // COPYFILE_EXCL: never replaces what is there, a link included.
        copyFileSync(real, at.path, constants.COPYFILE_EXCL);
        copied = at;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        refuse(`could not be copied (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
        break;
      }
    }
    if (!copied) { if (!result.refused.some((r) => r.name === name)) refuse('no free name in refs/'); continue; }
    try {
      const bytes = statSync(copied.path).size;
      const sha256 = hashFile(copied.path);
      const k = kindOf(name, head(copied.path));
      result.added.push({ path: copied.rel, sha256, bytes, kind: k.kind, by: k.by, source_name: name, ...(k.note ? { note: k.note } : {}) });
    } catch (err) {
      try { unlinkSync(copied.path); } catch { /* gone */ }
      refuse(`could not be read after copying (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  return result;
}
