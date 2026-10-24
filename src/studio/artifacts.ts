/**
 * R6 (H145): the shown project's own artifacts, for Timmy Studio's board (reference 06; the operator's order of 2026-10-16,
 * priority 3: "Implement the missing connected visual UI. Reuse existing project artifacts, adapters and viewers … Studio
 * reference images, custom nodes and project-linked artifacts"). Studio lists them in its side panel (Artifacts), a person
 * places one on the board as a card that SHOWS the artifact and OPENS its preview (companion/studio-canvas/src/artifacts.js).
 *
 * Nothing here computes an artifact of its own: each is read by the reader that already reads it, for the project the canvas
 * shows (each project has its own board: src/studio/boards.ts), and nothing is written.
 *
 *   kind     read by                                                       its card shows                     its preview
 *   vox      src/vox/preview.ts (H143): listVoxRecords, voxPreview, voxFile  the observed image, what was        Studio's VoxVision preview (side
 *            (the record and the files it names, each through one          measured over it, its receipt       panel); the companion's tab 5 has
 *            descriptor: src/vox/read-plain.ts)                                                                 the record in full (said where)
 *   run      src/ops/operations.ts listOperationRecords (the records), and  the operation's outputs and         Studio's run detail (side panel)
 *            the one run detail (GET /api/project/run-detail, its route)    receipts
 *   receipt  the runs chain the REPL named (its receipts store), each       its kind, subject, status, and     Studio's receipt page
 *            verified now (verifyReceiptIn): green only when it verifies   whether it verifies now            (/receipts/<id>)
 *
 * What each route requires (as GET /api/project, src/studio/project-link.ts): the server's token, or a canvas page's session that
 * counts for the project shown now (src/studio/card-relay.ts sessionFor); a paused session (another project or REPL holds the
 * canvas) is told why with a plain 200 and nothing of any project (src/studio/session-pause.ts), as the page's other readings
 * are; no credential, a forged one or an ended session: 401. A request that names a project (?project=<16 hex>) other than the
 * one shown now is refused (409, `notShown`, with the project shown): an artifact is served only for the board on screen, so
 * no page reads another project's artifact through it, not even one it was opened for before.
 *
 *   GET /api/project/artifacts                      the list (timmy.studio-artifacts/1), newest first within each kind
 *   GET /api/project/artifact/vox?id=v<8 hex>       one VoxVision record's preview (timmy.vox-preview/1, H143's), whole
 *   GET /api/project/artifact/vox-file?id=…&path=…  an image that record names (H143's voxFile: a regular file inside the
 *                                                   project, reached with no link, an image by its bytes), never anything else
 */
import type express from 'express';
import { JOB_CANCELLED } from '../contracts/stop-words.js';
import { listOperationRecords, type OperationRecord } from '../ops/operations.js';
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import { listVoxRecords, voxFile, voxPreview, type PreviewInput } from '../vox/preview.js';
import type { CardRelay } from './card-relay.js';
import { cardText, readRunsChain } from './project-cards.js';
import type { NamedProject, ProjectLink } from './project-link.js';
import { pausedRefusal } from './session-pause.js';

type Env = Record<string, string | undefined>;

export const ARTIFACTS_SCHEMA = 'timmy.studio-artifacts/1';
export const ARTIFACT_ROUTES = {
  list: '/api/project/artifacts',
  vox: '/api/project/artifact/vox',
  voxFile: '/api/project/artifact/vox-file',
} as const;
/** How many of each kind the list carries (the newest). */
export const ARTIFACTS_PER_KIND = 12;
/** What an image answer carries beside its bytes: no caching, and a policy under which an image runs nothing (H143's). */
const FILE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const PROJECT_ID = /^[0-9a-f]{16}$/;
const VOX_ID = /^v[0-9a-f]{8}$/;

export type ArtifactKind = 'vox' | 'run' | 'receipt';

/** One artifact as the list gives it, and as a placed card names it (`id`). */
export interface ArtifactRow {
  /** `vox:v1a2b3c4d`, `run:o1a2b3c4d`, `receipt:1a2b3c4d`: stable while its record is there */
  id: string;
  kind: ArtifactKind;
  title: string;
  /** its state in words, as its record says */
  state: string;
  /** when its record says it was made (ISO), or null */
  at: string | null;
  /** the record behind it, project-relative, or null (a receipt is on the chain, not in the project) */
  record: string | null;
  /** its receipt now: green only when `verified` (it verifies where it stands, for this project, now) */
  receipt: { short: string; verified: boolean; words: string } | null;
  /** made by a test double, or saying FAKE: said on its card */
  fake: boolean;
  /** what opening its preview opens: Studio's VoxVision preview, its run detail, or its receipt page */
  preview: { kind: 'vox'; id: string } | { kind: 'run'; op: string } | { kind: 'receipt'; href: string };
  /** a VoxVision record: how many images and overlays it has (its card draws the first image with its overlays) */
  counts?: { images: number; overlays: number; values: number };
}

export interface ArtifactList {
  schema: typeof ARTIFACTS_SCHEMA;
  ok: true;
  project: { id: string; name: string };
  madeAt: string;
  artifacts: ArtifactRow[];
  /** what was left out or could not be read, in words */
  notes: string[];
}

export interface ArtifactRoutes {
  link: ProjectLink;
  relay: CardRelay;
  /** the environment the readers read with (PATH, the home folders written as "~") */
  env: Env;
}

/** What a page asking while no project is named is told: each project has its own board, so there are no artifacts to show. */
export const NO_PROJECT = 'No project is named to this canvas, so it shows no artifacts: each project has its own board. In Timmy: /canvas open.';
export const ARTIFACTS_REFUSED = 'Refused: the project\'s artifacts are read with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.';
const FAILED = 'Timmy could not read what this artifact needs, so it answers with nothing. The canvas server is still running.';

const short = (hash: string): string => hash.slice(7, 15);
const plain = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The project's receipts on the chain the REPL named, newest first, each verified now. */
export function receiptRows(chain: readonly Receipt[], p: Pick<NamedProject, 'id' | 'root'>, max = ARTIFACTS_PER_KIND): ArtifactRow[] {
  const mine = chain.filter((r) => r.project_id === p.id && typeof r.hash === 'string' && r.hash.length > 15);
  return mine.slice(-max).reverse().map((r): ArtifactRow => {
    const v = verifyReceiptIn(chain, r.hash);
    const id = short(r.hash);
    const subject = cardText(plain(r.subject) || plain(r.kind), p.root, 200);
    const kind = plain(r.kind) || 'receipt';
    return {
      // its subject names its kind already when it starts with it ("vox · detect …"): not said twice
      id: `receipt:${id}`, kind: 'receipt', title: cardText(subject.startsWith(`${kind} `) ? subject : `${kind} · ${subject}`, p.root, 160),
      state: cardText(plain(r.status) || 'no status recorded', p.root, 120), at: typeof r.ts === 'string' ? r.ts : null, record: null,
      receipt: { short: id, verified: v.ok, words: v.ok ? `sealed and verified now: receipt ${id}'s chain link, body and signature verify` : `receipt ${id} does not verify now: ${v.reason}` },
      fake: /\bFAKE\b/.test(`${plain(r.subject)} ${JSON.stringify(r.sources ?? '')}`), preview: { kind: 'receipt', href: `/receipts/${id}` },
    };
  });
}

/**
 * R7 (H151; H148's R6 finding N5): an operation's state and why, in the shared words (src/contracts/stop-words.ts): a stop that
 * ended a run Timmy started (a job, a flow, a native or agent run: any run on the record) is that job's cancel, "cancelled"
 * (JOB_CANCELLED), and its runs' words say so ("job j… cancelled"); an operation that ran nothing but a chat turn keeps the
 * turn's "stopped". The lead's rule for the run detail (src/ops/run-detail.ts stopKind: a turn's operation was stopped, anything
 * else cancelled), read from the operation's record. Other states are as recorded.
 */
export function runStateWords(r: Pick<OperationRecord, 'state' | 'why' | 'runs'>): string {
  const job = r.state === 'stopped' && r.runs.length > 0;
  const word = job ? JOB_CANCELLED : r.state;
  const why = typeof r.why === 'string' && r.why ? r.why : '';
  const said = job ? why.replace(/^stopped(?=:|$)/, JOB_CANCELLED).replace(/\b((?:job|flow|native|agent|mcp|vox|fleet) [0-9a-z]+) stopped\b/g, `$1 ${JOB_CANCELLED}`) : why;
  return `${word}${said ? ` · ${said}` : ''}`;
}

/** The project's operations (their records), newest first: each a run artifact whose run detail is its preview. */
export function runRows(p: Pick<NamedProject, 'root'>, max = ARTIFACTS_PER_KIND): { rows: ArtifactRow[]; notes: string[] } {
  const listed = listOperationRecords(p.root, max);
  const notes = listed.unreadable.map((u) => cardText(`${u.rel} could not be read as an operation record: ${u.error}`, p.root, 300));
  if (listed.more) notes.push(`${listed.more} older operations are not listed (the newest ${max} are).`);
  const rows = listed.list.map(({ record: r, rel }): ArtifactRow => ({
    id: `run:${r.id}`, kind: 'run', title: cardText(`operation ${r.id}: ${r.request}`, p.root, 160),
    // R7 (H151; N5): in the shared job and turn words
    state: cardText(`${runStateWords(r)}${r.runs.length ? ` · ${r.runs.length} run${r.runs.length === 1 ? '' : 's'}` : ''}`, p.root, 240),
    at: r.started, record: rel, receipt: null, fake: /\bFAKE\b/.test(r.request), preview: { kind: 'run', op: r.id },
  }));
  return { rows, notes };
}

/** The project's VoxVision records (H143's list), newest first: each with its receipt as the list verified it now. */
export function voxRows(i: PreviewInput, max = ARTIFACTS_PER_KIND): { rows: ArtifactRow[]; notes: string[] } {
  const list = listVoxRecords(i, max);
  const notes = list.unreadable.map((u) => cardText(`${u.file} is not shown: ${u.why}`, i.root, 300));
  if (list.more) notes.push(`${list.more} older VoxVision records are not listed (the newest ${max} are).`);
  const rows = list.records.map((r): ArtifactRow => ({
    id: `vox:${r.id}`, kind: 'vox', title: cardText(`${r.action} ${r.inputs.map((x) => x.path).join(' and ') || '(no input named)'}`, i.root, 160),
    state: cardText(`${r.status} · ${r.check.status}${r.check.reasons.length ? `: ${r.check.reasons[0]}` : ''}`, i.root, 240),
    at: r.madeAt ?? null, record: r.file,
    receipt: r.receipt.short ? { short: r.receipt.short, verified: r.receipt.verified === true, words: cardText(r.receipt.words, i.root, 300) } : { short: '', verified: false, words: cardText(r.receipt.words, i.root, 300) },
    fake: r.fake, preview: { kind: 'vox', id: r.id }, counts: { images: r.counts.images, overlays: r.counts.overlays, values: r.counts.values },
  }));
  return { rows, notes };
}

/**
 * GET /api/project/artifacts and the VoxVision record's routes. Read only; each request reads the project named now, and is
 * refused (409) when it names another.
 */
export function mountArtifactRoutes(app: express.Express, o: ArtifactRoutes): void {
  /**
   * The project a request may read now (sent the refusal and null when it may not): the server's token, or a page session that
   * counts for the project named now; the project it names, when it names one, must be the one named now.
   */
  const projectOf = (req: express.Request, res: express.Response): NamedProject | null => {
    res.set('Cache-Control', 'no-store');
    const asked = req.query.project;
    if (asked !== undefined && (typeof asked !== 'string' || !PROJECT_ID.test(asked))) { res.status(400).json({ ok: false, error: 'project is a project\'s id: 16 hex characters.' }); return null; }
    const named = o.link.project;
    if (!o.link.authorized(req.headers.authorization)) {
      const s = o.relay.sessionFor(req.headers.authorization, named);
      if (!s.ok) {
        // a paused session (another project or REPL holds the canvas): a plain 200 that says why, with nothing of any project
        if (pausedRefusal(s.why)) res.status(200).json({ ok: false, error: s.words, session: s.why });
        else res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: s.why === 'none' ? ARTIFACTS_REFUSED : s.words, session: s.why });
        return null;
      }
    }
    if (!named) { res.status(409).json({ ok: false, error: NO_PROJECT, project: null }); return null; }
    if (typeof asked === 'string' && asked !== named.id) {
      res.status(409).json({ ok: false, notShown: true, asked, shows: { id: named.id, name: named.name }, error: `The canvas shows ${named.name} now, not the project this page asked for: its artifacts are shown on its own board only.` });
      return null;
    }
    return named;
  };
  const inputOf = (p: NamedProject): PreviewInput => ({ root: p.root, chain: readRunsChain(p.receipts), env: { ...o.env } as NodeJS.ProcessEnv });

  app.get(ARTIFACT_ROUTES.list, (req, res) => {
    const p = projectOf(req, res);
    if (!p) return;
    try {
      const i = inputOf(p);
      const vox = voxRows(i);
      const runs = runRows(p);
      const list: ArtifactList = {
        schema: ARTIFACTS_SCHEMA, ok: true, project: { id: p.id, name: p.name }, madeAt: new Date().toISOString(),
        artifacts: [...vox.rows, ...runs.rows, ...receiptRows(i.chain, p)], notes: [...vox.notes, ...runs.notes],
      };
      res.json(list);
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });

  app.get(ARTIFACT_ROUTES.vox, (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const p = projectOf(req, res);
    if (!p) return;
    if (!VOX_ID.test(id)) { res.status(400).json({ ok: false, error: 'Name one VoxVision record: ?id=v<8 hex digits>.' }); return; }
    try {
      const v = voxPreview(inputOf(p), id);
      if (!v.ok) { res.status(v.status).json({ ok: false, error: cardText(v.error, p.root, 400) }); return; }
      res.json({ ok: true, project: { id: p.id, name: p.name }, preview: v.preview });
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });

  app.get(ARTIFACT_ROUTES.voxFile, (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    const p = projectOf(req, res);
    if (!p) return;
    if (!VOX_ID.test(id) || !path) { res.status(400).json({ ok: false, error: 'Name one record and one of its images: ?id=v<8 hex digits>&path=<path in the project>.' }); return; }
    try {
      const f = voxFile(inputOf(p), id, path);
      if (!f.ok) { res.status(f.status).json({ ok: false, error: cardText(f.error, p.root, 400) }); return; }
      res.set({ 'Content-Security-Policy': FILE_POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' }).type(f.type).send(f.body);
    } catch { res.status(500).json({ ok: false, error: FAILED }); }
  });
}
