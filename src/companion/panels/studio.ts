/**
 * R6 (H145): the Studio panel's routes (tab 4; reference 06), under /api/panel/studio/…, each behind the companion's token and
 * answering for the project the page shows (?project=<id>, else the one followed): what is on that project's own board, as
 * Studio last saved it, each item with what it links to and its thumbnail. Read only: nothing here opens the board for use,
 * moves a file or writes (src/studio/document.ts peek and storedSnapshot; a board that cannot be read is said to be so, and left
 * where it is for Studio to keep aside).
 *
 *   route                                    answers
 *   GET /api/panel/studio/board              the board's items (timmy.studio-board/1, src/studio/board-items.ts): its artifact
 *                                            cards, reference images, cards and words, each with its page, its draft mark, what
 *                                            it links to (a VoxVision record, an operation's run, a receipt) and its thumbnail's
 *                                            address; another project's card on it is named as kept apart, nothing of it read;
 *                                            R11 round 7 (H176): and the Houdini starters New board offers (id, title, steps)
 *   GET /api/panel/studio/ref?file=<sha256>.<ext>
 *                                            a reference image's copy on this board (refs/<sha256>.<ext>), only when its bytes
 *                                            are what its name says (src/studio/references.ts readBoardRef)
 *
 * A VoxVision item's thumbnail is the record's own image, served by the VoxVision panel's file route (src/companion/panels/vox.ts),
 * chosen as the artifact card on the board chooses it (companion/studio-canvas/src/artifacts.js cardImage: the observed input with
 * what was measured over it, else an image with overlays, else the first the route serves).
 * A request without the token is refused (401) before anything is read; a project the companion does not know is 404.
 */
import { createHash } from 'node:crypto';
import type express from 'express';
import type { PanelContext } from '../panels.js';
import { projectId } from '../../project/index.js';
import { boardItems, type BoardItem } from '../../studio/board-items.js';
import { boardDir, boardOfFolder, oldLayoutWords } from '../../studio/boards.js';
import { studioBaseUrl } from '../../studio/config.js';
import { canvasDir } from '../../studio/document.js';
import { readBoardRef, REF_FILE, REF_HEADERS } from '../../studio/references.js';
import { starterTemplates } from '../../studio/templates.js';
import { readChain, type Receipt } from '../../utils/receipts.js';
import { voxPreview, type PreviewInput, type VoxPreview } from '../../vox/preview.js';
import { VOX_PANEL } from './vox.js';

export const STUDIO_PANEL = {
  board: '/api/panel/studio/board',
  ref: '/api/panel/studio/ref',
} as const;

/** How many VoxVision records' thumbnails one answer names (each is a preview read). */
export const THUMBS_MAX = 24;
const FAILED = 'The Studio panel could not read this project\'s board, so it answers with nothing. The companion is still running.';

/** A board item as tab 4 draws it: with its thumbnail's address (the page adds ?project=) and what it shows. */
export type PanelItem = BoardItem & { thumb?: { src: string; path: string } };

/** The runs chain the VoxVision panel reads: TIMMY_STORE, else the project's own store. */
function chainOf(root: string): readonly Receipt[] {
  try { return process.env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

/** The image a VoxVision record's card shows (the rule of artifacts.js cardImage), or null. */
export function voxThumb(preview: VoxPreview): { path: string } | null {
  const images = preview.images.filter((i) => i.servable);
  const drawn = (key: string): boolean => preview.overlays.some((o) => o.image === key);
  const im = images.find((i) => i.role === 'input' && drawn(i.key)) ?? images.find((i) => drawn(i.key)) ?? images[0];
  return im ? { path: im.path } : null;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The board of `root` as last saved, read so that its snapshot is the revision it names: the snapshot's own sha256 must be the
 * source revision read beside it (a save between the two reads is read again, at most three times).
 */
function savedBoard(root: string, env: Record<string, string | undefined>): { revision: number | null; savedAt: string | null; unreadable: boolean; snapshot: unknown } {
  const docs = boardOfFolder(root, env);
  for (let i = 0; i < 3; i += 1) {
    const peek = docs.peek();
    if (peek.unreadable) return { revision: null, savedAt: null, unreadable: true, snapshot: null };
    const snapshot = docs.storedSnapshot();
    const same = snapshot === null ? peek.sourceRevision === null : sha256(JSON.stringify(snapshot)) === peek.sourceRevision;
    if (same) return { revision: peek.revision, savedAt: peek.savedAt, unreadable: false, snapshot };
  }
  return { revision: null, savedAt: null, unreadable: true, snapshot: null };
}

export function mountStudioPanel(app: express.Express, ctx: PanelContext): void {
  app.get(STUDIO_PANEL.board, ctx.withToken, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      const id = projectId(project.root);
      const board = savedBoard(project.root, ctx.env);
      const read = boardItems(board.snapshot, id);
      // each VoxVision record's thumbnail, read once (the first THUMBS_MAX records); a reference's, its board copy
      const input: PreviewInput | null = read.items.some((it) => it.target?.vox) ? { root: project.root, chain: chainOf(project.root), env: { ...ctx.env } as NodeJS.ProcessEnv } : null;
      const thumbs = new Map<string, { path: string } | null>();
      const items: PanelItem[] = read.items.map((it) => {
        if (it.ref) return { ...it, thumb: { src: `${STUDIO_PANEL.ref}?file=${encodeURIComponent(it.ref.file)}`, path: it.ref.path } };
        const vox = it.target?.vox;
        if (!vox || !input || it.kind === 'other-project') return it;
        if (!thumbs.has(vox)) {
          if (thumbs.size >= THUMBS_MAX) return it;
          let t: { path: string } | null = null;
          try { const p = voxPreview(input, vox); t = p.ok ? voxThumb(p.preview) : null; } catch { t = null; }
          thumbs.set(vox, t);
        }
        const t = thumbs.get(vox);
        return t ? { ...it, thumb: { src: `${VOX_PANEL.file}?id=${encodeURIComponent(vox)}&path=${encodeURIComponent(t.path)}`, path: t.path } } : it;
      });
      res.json({
        ok: true, ...read, items,
        project: { id, name: project.name },
        board: { revision: board.revision, savedAt: board.savedAt, unreadable: board.unreadable },
        // where Studio answers (its receipt pages too): a page on this computer links it, a page elsewhere says it
        studio: studioBaseUrl(ctx.env),
        oldLayout: oldLayoutWords(canvasDir(ctx.env), id),
        // R11 round 7 (H176): the guided blank public starters Studio's New board offers (src/studio/templates.ts), named here so the
        // page can say where a board starts from; opening one is Studio's (a page of this project's board)
        starters: starterTemplates().map((t) => ({ id: t.id, title: t.title, intro: t.intro, steps: t.steps.map((st) => `${st.n} ${st.verb}`) })),
      });
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });

  app.get(STUDIO_PANEL.ref, ctx.withToken, (req, res) => {
    const file = typeof req.query.file === 'string' ? req.query.file : '';
    if (!REF_FILE.test(file)) { res.status(400).set('Cache-Control', 'no-store').json({ ok: false, error: 'Name one reference image of the board: ?file=<sha256>.<png|jpg|gif|webp>.' }); return; }
    const project = ctx.projectFor(req);
    if (!project) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: ctx.projectUnknown }); return; }
    try {
      const ref = readBoardRef(boardDir(canvasDir(ctx.env), projectId(project.root)), file, project.name);
      if (!ref.ok) { res.status(ref.status).set('Cache-Control', 'no-store').json({ ok: false, error: ref.error }); return; }
      res.set(REF_HEADERS).type(ref.mime).send(ref.body);
    } catch { res.status(500).set('Cache-Control', 'no-store').json({ ok: false, error: FAILED }); }
  });
}
