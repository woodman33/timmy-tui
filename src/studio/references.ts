/**
 * R6 (H145): reference images on a project's board, from the project's own files only (reference 06; the operator's order of
 * 2026-10-16: "Studio reference images, custom nodes and project-linked artifacts"). A person picks one of the project's images in
 * Studio's side panel (Reference images); the canvas server copies its bytes into the board's own folder and the page puts it on
 * the board as a tldraw image (its asset's meta: { path, sha256, bytes, from }) with a caption naming the file and where it came
 * from (companion/studio-canvas/src/references.js).
 *
 *   <TIMMY_HOME>/canvas/projects/<project id>/refs/<sha256>.<png|jpg|gif|webp>    the copy (0600), named by its own bytes
 *
 * Nothing is ever written into the project's folder. The file is read through one descriptor (src/vox/read-plain.ts
 * readPlainInside: walked from the project folder with no link followed, opened with O_NOFOLLOW, its fstat the very file checked,
 * read whole through that descriptor), so a file outside the project, a path with "..", or a link (even one leading back into
 * the project) is refused in words. Raster only, by its bytes: PNG, JPEG, WebP or GIF, at most REF_MAX; an SVG is refused, as it
 * can carry script.
 *
 * What each route requires (as the board's own routes, src/studio/server.ts): the server's token, or a canvas page's session that
 * counts for the project shown now; a request for another project than the one shown is refused (409, `notShown`), so no page
 * copies into, or reads from, another project's board; no credential, a forged one or an ended session: 401.
 *
 *   GET  /api/project/reference-files            the project's images (raster, by name), each with its size: what can be added
 *   POST /api/project/reference                  {"project": "<id>", "path": "<path in the project>"}: the copy, and what it is
 *   GET  /api/canvas/ref/<project id>/<sha256>.<ext>   a copy, for that board only (its name must be its bytes' sha256)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import express from 'express';
import { listProjectFiles } from '../project/index.js';
import { plainRel, readPlainInside, type PlainReadHooks } from '../vox/read-plain.js';
import { boardDir, PROJECT_ID } from './boards.js';
import type { CardRelay } from './card-relay.js';
import { cardText } from './project-cards.js';
import type { NamedProject, ProjectLink } from './project-link.js';
import { pausedRefusal } from './session-pause.js';

/** The largest reference image copied or served (bytes). */
export const REF_MAX = 16 * 1024 * 1024;
/** How many of the project's images the list names. */
export const REF_LIST_MAX = 200;
export const REF_ROUTES = { files: '/api/project/reference-files', copy: '/api/project/reference', serve: '/api/canvas/ref' } as const;
/** The image types a reference may be, by their bytes, and the name each copy ends with. */
export const RASTER = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;
export type RasterExt = keyof typeof RASTER;
/** A copy's name in the board's refs folder: its bytes' sha256 and its type. */
export const REF_FILE = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
const NAMED_IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export const REFS_REFUSED = 'Refused: a reference image is read and added with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.';
const NO_PROJECT = 'No project is named to this canvas, so it has no board to add a reference image to. In Timmy: /canvas open.';
const RASTER_ONLY = 'a reference image is a PNG, JPEG, WebP or GIF';

/** The image type of `b` by its first bytes (PNG, JPEG, GIF, WebP), or null. */
export function sniffRaster(b: Buffer): RasterExt | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** The project's images that can be added (raster by name, outside links, dotfolders and dependencies), with their sizes. */
export function referenceFiles(root: string): { files: Array<{ path: string; bytes: number; name: string }>; more: number } {
  let listed: ReturnType<typeof listProjectFiles>;
  try { listed = listProjectFiles(root, { max: 4000 }); } catch { return { files: [], more: 0 }; }
  const images = listed.files.filter((f) => NAMED_IMAGE.test(f.rel)).sort((a, b) => a.rel.localeCompare(b.rel));
  return { files: images.slice(0, REF_LIST_MAX).map((f) => ({ path: f.rel, bytes: f.bytes, name: basename(f.rel) })), more: Math.max(0, images.length - REF_LIST_MAX) };
}

/** What a copy of a reference image is, as the page puts it in its asset's meta (and its caption). */
export interface ReferenceCopy {
  /** the file, project-relative, as the person picked it */
  path: string;
  name: string;
  sha256: string;
  bytes: number;
  ext: RasterExt;
  mime: string;
  /** where it came from, in words */
  from: string;
  /** the address the board shows it from (this server's, for this board only) */
  src: string;
}

export type CopyAnswer = { ok: true; ref: ReferenceCopy; copied: boolean } | { ok: false; status: number; error: string };

/**
 * Copies `rel` of the project in `root` into board folder `board` (refs/<sha256>.<ext>), read through one descriptor. Refused, in
 * words: a path that is not inside the project, an SVG or another type, a link, a file too large, a file that changed while it
 * was read. `project`: the board's project (the copy's address names its id; the words, its name).
 */
export function copyReference(root: string, board: string, project: { id: string; name: string }, rel: string, hooks: PlainReadHooks = {}): CopyAnswer {
  const shown = cardText(rel, root, 200);
  if (typeof rel !== 'string' || !plainRel(rel)) return { ok: false, status: 400, error: `Refused: ${shown || 'that'} is not a path inside ${project.name} (no "..", no leading "/"): ${RASTER_ONLY} from the project's own files only.` };
  if (/\.svgz?$/i.test(rel)) return { ok: false, status: 415, error: `Refused: ${shown} is an SVG, which can carry script; ${RASTER_ONLY}.` };
  if (!NAMED_IMAGE.test(rel)) return { ok: false, status: 415, error: `Refused: ${shown} is not named as an image; ${RASTER_ONLY}.` };
  const read = readPlainInside(root, rel, REF_MAX, hooks);
  if (!read.ok) {
    const status = read.why === 'missing' || read.why === 'path' ? 404 : read.why === 'too-large' ? 413 : read.why === 'changed' ? 409 : 403;
    const why = read.why === 'link' ? 'it is reached through a link (which may lead out of the project), and a link is never followed' : read.words;
    return { ok: false, status, error: `Refused: ${shown} is not added: ${why}. Nothing was copied.` };
  }
  const ext = sniffRaster(read.body);
  if (!ext) return { ok: false, status: 415, error: `Refused: ${shown} is not a PNG, JPEG, WebP or GIF by its bytes; ${RASTER_ONLY}. Nothing was copied.` };
  const sha256 = createHash('sha256').update(read.body).digest('hex');
  const file = `${sha256}.${ext}`;
  let copied = true;
  try {
    mkdirSync(join(board, 'refs'), { recursive: true, mode: 0o700 });
    writeFileSync(join(board, 'refs', file), read.body, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') copied = false;
    else return { ok: false, status: 500, error: `${shown} could not be copied into ${project.name}'s board (${(e as NodeJS.ErrnoException).code ?? 'error'}).` };
  }
  return {
    ok: true, copied,
    ref: { path: rel, name: basename(rel), sha256, bytes: read.body.length, ext, mime: RASTER[ext], from: `${project.name}'s own file ${rel}, copied into ${project.name}'s board`, src: `${REF_ROUTES.serve}/${project.id}/${file}` },
  };
}

/** What a board's copy `file` (refs/<sha256>.<ext>) answers: its bytes and type, or why it is not shown (with the status to send). */
export type BoardRefAnswer = { ok: true; body: Buffer; ext: RasterExt; mime: string } | { ok: false; status: number; error: string };

/**
 * A copy in board folder `board` (refs/<sha256>.<ext>), read through one descriptor and shown only when it is what its name
 * says: its bytes' sha256, and the type it was copied as. `name`: the board's project, for the words. Studio's board route and the
 * browser companion's tab 4 (src/companion/panels/studio.ts) both read a copy here.
 */
export function readBoardRef(board: string, file: string, name: string): BoardRefAnswer {
  const m = REF_FILE.exec(file);
  if (!m) return { ok: false, status: 400, error: 'A reference image is named by its bytes\' sha256 and its type: <sha256>.<png|jpg|gif|webp>.' };
  const read = readPlainInside(board, `refs/${file}`, REF_MAX);
  if (!read.ok) return { ok: false, status: read.why === 'missing' ? 404 : 403, error: `No reference image ${file.slice(0, 12)}… on ${name}'s board (${read.words}).` };
  const ext = m[2] as RasterExt;
  if (createHash('sha256').update(read.body).digest('hex') !== m[1] || sniffRaster(read.body) !== ext) return { ok: false, status: 409, error: `The copy ${file.slice(0, 12)}… on ${name}'s board is not the bytes its name says, so it is not shown.` };
  return { ok: true, body: read.body, ext, mime: RASTER[ext] };
}

/** The headers a copy is sent with: no caching, nothing run, never sniffed as another type, no referrer, this origin only. */
export const REF_HEADERS = { 'Cache-Control': 'no-store', 'Content-Security-Policy': POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' } as const;

export interface ReferenceRoutes {
  link: ProjectLink;
  relay: CardRelay;
  /** the canvas folder (each project's board is in it) */
  canvasRoot: string;
}

/** The three routes; each reads (or writes) only the board of the project named now. */
export function mountReferenceRoutes(app: express.Express, o: ReferenceRoutes): void {
  /** The project named now, when the caller may act on it and asked for no other (else the refusal is sent and null returned). */
  const projectOf = (req: express.Request, res: express.Response, asked: unknown): NamedProject | null => {
    res.set('Cache-Control', 'no-store');
    if (asked !== undefined && asked !== null && (typeof asked !== 'string' || !PROJECT_ID.test(asked))) { res.status(400).json({ ok: false, error: 'project is a project\'s id: 16 hex characters.' }); return null; }
    const named = o.link.project;
    if (!o.link.authorized(req.headers.authorization)) {
      const s = o.relay.sessionFor(req.headers.authorization, named);
      if (!s.ok) {
        if (pausedRefusal(s.why) && req.method === 'GET' && !req.path.startsWith(REF_ROUTES.serve)) res.status(200).json({ ok: false, error: s.words, session: s.why });
        else res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: s.why === 'none' ? REFS_REFUSED : s.words, session: s.why });
        return null;
      }
    }
    if (!named) { res.status(409).json({ ok: false, error: NO_PROJECT }); return null; }
    if (typeof asked === 'string' && asked !== named.id) {
      res.status(409).json({ ok: false, notShown: true, asked, shows: { id: named.id, name: named.name }, error: `The canvas shows ${named.name} now, not the project this was asked for: a reference image is added to, and shown from, its own project's board only.` });
      return null;
    }
    return named;
  };

  app.get(REF_ROUTES.files, (req, res) => {
    const p = projectOf(req, res, req.query.project);
    if (!p) return;
    const listed = referenceFiles(p.root);
    res.json({ ok: true, project: { id: p.id, name: p.name }, files: listed.files, more: listed.more, max: REF_MAX });
  });

  app.post(REF_ROUTES.copy, (req, res, next) => {
    if (req.is('application/json')) { next(); return; }
    res.status(415).set('Cache-Control', 'no-store').json({ ok: false, error: 'Send JSON: {"project": "<id>", "path": "<path in the project>"}.' });
  }, (req, res, next) => {
    // the credential before the body is read (as every write of this server)
    if (o.link.authorized(req.headers.authorization) || o.relay.sessionFor(req.headers.authorization, o.link.project).ok) { next(); return; }
    projectOf(req, res, undefined);
  }, (req, res, next) => {
    // a project id and a path: at most 2 KB, refused in words otherwise
    json(req, res, (err?: unknown) => {
      if (!err) { next(); return; }
      const tooLarge = (err as { type?: string }).type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).set('Cache-Control', 'no-store').json({ ok: false, error: tooLarge ? 'At most 2 KB: a project id and a path.' : 'Send valid JSON.' });
    });
  }, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body).filter((k) => k !== 'project' && k !== 'path') : ['(not an object)'];
    if (extra.length) { res.set('Cache-Control', 'no-store').status(400).json({ ok: false, error: 'Send {"project": "<id>", "path": "<path in the project>"}, nothing else.' }); return; }
    const p = projectOf(req, res, body.project ?? null);
    if (!p) return;
    if (typeof body.project !== 'string') { res.status(400).json({ ok: false, error: 'project is the id of the project whose board the image is added to (16 hex).' }); return; }
    const done = copyReference(p.root, boardDir(o.canvasRoot, p.id), { id: p.id, name: p.name }, String(body.path ?? ''));
    if (!done.ok) { res.status(done.status).json({ ok: false, error: done.error }); return; }
    res.json({ ok: true, project: { id: p.id, name: p.name }, ref: done.ref, copied: done.copied });
  });

  app.get(`${REF_ROUTES.serve}/:project/:file`, (req, res) => {
    const id = String(req.params.project);
    const file = String(req.params.file);
    if (!PROJECT_ID.test(id) || !REF_FILE.test(file)) { res.status(400).set('Cache-Control', 'no-store').json({ ok: false, error: 'A reference image is asked for as /api/canvas/ref/<project id>/<sha256>.<png|jpg|gif|webp>.' }); return; }
    const p = projectOf(req, res, id);
    if (!p) return;
    // the copy is what its name says: its bytes' sha256, and the type it was copied as
    const ref = readBoardRef(boardDir(o.canvasRoot, p.id), file, p.name);
    if (!ref.ok) { res.status(ref.status).json({ ok: false, error: ref.error }); return; }
    res.set(REF_HEADERS).type(ref.mime).send(ref.body);
  });
}

/** JSON bodies of at most 2 KB (a project id and a path). */
const json = express.json({ limit: '2kb' });
