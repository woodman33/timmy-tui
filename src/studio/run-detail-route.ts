/**
 * R4 (H109): an operation's run detail on Timmy Canvas (Timmy Studio). The operator's direction (2026-10-11): "Use one shared Run
 * detail view, linkable from Chat, Studio nodes, Activity, Control Room, God's Eye View and result cards." The one run detail
 * is src/contracts/run-detail.ts's RunDetail, made only by src/ops/run-detail.ts (H102, `runDetail(operationId, { project })`);
 * Studio draws it, never computes its own: GET /api/project/run-detail?op=<o + 8 hex>[&project=<id>] asks that producer for one
 * operation of the project the canvas shows (or of a card's own project: a board pinned to it, or a card kept from a project the
 * canvas showed before), and the page shows its fields in the side panel (companion/studio-canvas/src/run-detail.js).
 *
 * Until H102's producer is in this revision, the route says so (501, with the typed command that shows the operation today:
 * /op <id>); the server's options may give it a producer (the tests give a FIXTURE). The producer is loaded by name when the
 * route is asked, until it is found (a module that is not there is not an error: it is "not built in this revision yet"; one
 * that is there and does not load says so).
 *
 * The same credentials as the project's cards (src/studio/project-link.ts): the server's token, or a page session that counts
 * for the project shown now (or reaches the card's own project: card-relay.ts reaches). What leaves the server: the detail with
 * the project's folder as "." (never a path it was given), every text through the cards' rule (the project's folder as ".", the home folder as
 * "~", any other absolute path as <path>), lists cut to a length a page can show; checked to be a RunDetail of this version, for
 * this operation and this project, else refused and said why.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type express from 'express';
import { RUN_DETAIL_VERSION, type RunDetail } from '../contracts/run-detail.js';
import { OPERATION_ID } from '../ops/context.js';
import type { CardRelay } from './card-relay.js';
import { cardText } from './project-cards.js';
import { CARDS_REFUSED, type NamedProject, type ProjectLink } from './project-link.js';

/** What makes the one run detail: src/ops/run-detail.ts's runDetail, as H102's brief names it. */
export type RunDetailProducer = (operation: string, o: { project: string }) => RunDetail | Promise<RunDetail>;

/** Where the producer is, beside this module: a name the type checker does not resolve (the module is H102's, not in every revision). */
export const PRODUCER_MODULE = ['..', 'ops', 'run-detail.js'].join('/');

/** The producer, or none: not in this revision (`why` null), or there and not usable (`why` says how). */
export type LoadedProducer = { producer: RunDetailProducer } | { producer: null; why: string | null };

/**
 * The producer when it is in this revision (src/ops/run-detail.ts exporting runDetail). A module that is not there is "not built
 * yet" (never an error); one that is there but does not load, or exports no runDetail, says so. `spec`: the module to load,
 * relative to this one (the tests load a FIXTURE module of their own, by its file URL).
 */
export async function loadRunDetail(spec: string = PRODUCER_MODULE): Promise<LoadedProducer> {
  const file = fileURLToPath(new URL(spec, import.meta.url));
  // the built module, or (run from the sources) its TypeScript
  if (![file, file.replace(/\.js$/, '.ts')].some((f) => existsSync(f))) return { producer: null, why: null };
  try {
    const m = await import(spec) as { runDetail?: unknown };
    return typeof m.runDetail === 'function' ? { producer: m.runDetail as RunDetailProducer } : { producer: null, why: `${basename(file)} exports no runDetail` };
  } catch (e) {
    return { producer: null, why: `${basename(file)} did not load: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** What the route says while the producer is not in this revision. */
export const NOT_BUILT = (op: string): string => `The run detail is not built in this revision yet (src/ops/run-detail.ts, round R4). In Timmy, /op ${op} shows the operation's card.`;

/** What a page is told for an operation of a project its session never counted for (read only: its session is kept as it is). */
export const OTHER_PROJECT = (op: string): string => `Refused: operation ${op} is of a project this canvas page was never opened for (nor followed to), so it does not read its run detail. In Timmy, in that project: /op ${op}.`;

/** What a page is told for an operation of a project this server does not know now. */
export const UNKNOWN_PROJECT = (op: string): string => `This canvas server does not know the project of operation ${op} now (it restarted since, or it has named many others since), so it does not read its run detail. In Timmy, in that project: /op ${op}.`;

const LIMITS = { files: 200, receipts: 200, exits: 50, checks: 100, unknown: 100, children: 50 } as const;

/** Every text of the detail through the cards' rule, its lists cut to what a page shows; the project's folder as ".". */
export function shownDetail(d: RunDetail, root: string): RunDetail {
  const scrub = (v: unknown, depth = 0): unknown => {
    if (typeof v === 'string') return cardText(v, root, 2000);
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v === null || typeof v === 'boolean') return v;
    if (depth > 6) return null;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrub(x, depth + 1));
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x, depth + 1)]));
    return null;
  };
  const out = scrub(d) as RunDetail;
  return {
    ...out,
    project: { name: out.project.name, root: '.', id: out.project.id },
    children: out.children.slice(0, LIMITS.children), exits: out.exits.slice(0, LIMITS.exits), checks: out.checks.slice(0, LIMITS.checks),
    files: out.files.slice(0, LIMITS.files), receipts: out.receipts.slice(0, LIMITS.receipts), unknown: out.unknown.slice(0, LIMITS.unknown),
  };
}

/** Whether a producer's answer is a RunDetail of this version, for this operation and this project; why not, in words. */
export function notThisDetail(d: unknown, op: string, p: Pick<NamedProject, 'id' | 'name'>): string | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'it answered with no run detail';
  const x = d as Partial<RunDetail>;
  if (x.version !== RUN_DETAIL_VERSION) return `it answered a run detail of version ${String(x.version)}, not ${RUN_DETAIL_VERSION}`;
  if (x.operation !== op) return `it answered for operation ${typeof x.operation === 'string' ? x.operation.slice(0, 20) : 'none'}, not ${op}`;
  if (!x.project || typeof x.project !== 'object' || x.project.id !== p.id) return `it answered for another project than ${p.name}`;
  for (const k of ['children', 'exits', 'checks', 'files', 'receipts', 'unknown'] as const) if (!Array.isArray(x[k])) return `its ${k} is not a list`;
  if (!x.verdict || !x.stage || !x.freshness || !x.acceptance || !x.worker || !x.time || !x.cost || !x.summary) return 'it left out a field every run detail has';
  return null;
}

export interface RunDetailRoutes {
  link: ProjectLink;
  relay: CardRelay;
  /** a producer given by the server's options (a test's FIXTURE); absent: src/ops/run-detail.ts when it is there */
  producer?: RunDetailProducer;
}

/**
 * GET /api/project/run-detail?op=<id>[&project=<id>]. `project`: the card's own project when it is not the one the canvas shows
 * (a board pinned to it, or a card kept from a project the canvas showed before); read only, and only while the page's session
 * reaches it. A refusal for such a project says so (`other: true`), and never pauses the page's session for the project shown.
 */
export function mountRunDetailRoute(app: express.Express, o: RunDetailRoutes): void {
  // the producer once found (looked for again while it is not: a build may add it while the server runs)
  let found: RunDetailProducer | null = o.producer ?? null;
  app.get('/api/project/run-detail', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const op = typeof req.query.op === 'string' ? req.query.op : '';
    if (!OPERATION_ID.test(op)) { res.status(400).json({ ok: false, error: 'op is an operation\'s id: o and 8 hex digits.' }); return; }
    const asked = typeof req.query.project === 'string' ? req.query.project : null;
    if (asked !== null && !/^[0-9a-f]{16}$/.test(asked)) { res.status(400).json({ ok: false, error: 'project is a project\'s id: 16 hex characters.' }); return; }
    const named = o.link.project;
    const other = asked !== null && asked !== (named?.id ?? null);
    // the project's content: the server's token, or a page session that counts for the project shown (or reaches the card's own)
    if (!o.link.authorized(req.headers.authorization)) {
      const s = other ? o.relay.reaches(req.headers.authorization, asked!) : o.relay.sessionFor(req.headers.authorization, named);
      if (!s.ok) {
        const error = s.why === 'none' ? CARDS_REFUSED : other && s.why === 'project' ? OTHER_PROJECT(op) : s.words;
        res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error, session: s.why, ...(other ? { other: true } : {}) });
        return;
      }
    }
    const p = other ? o.link.knownProject(asked!) : named;
    if (!p && other) { res.status(404).json({ ok: false, error: UNKNOWN_PROJECT(op), other: true, command: `/op ${op}` }); return; }
    if (!p) { res.status(409).json({ ok: false, error: 'No project is named to this canvas: in Timmy, /canvas open.' }); return; }
    if (!found) {
      const l = await loadRunDetail();
      if (!l.producer) {
        if (l.why === null) res.status(501).json({ ok: false, built: false, error: NOT_BUILT(op), command: `/op ${op}` });
        else res.status(500).json({ ok: false, error: cardText(`The run detail of ${op} could not be made: ${l.why}`, p.root, 600), command: `/op ${op}` });
        return;
      }
      found = l.producer;
    }
    let d: RunDetail;
    try {
      d = await found(op, { project: p.root });
    } catch (e) {
      res.status(500).json({ ok: false, error: cardText(`The run detail of ${op} could not be made: ${e instanceof Error ? e.message : String(e)}`, p.root, 600), command: `/op ${op}` });
      return;
    }
    const wrong = notThisDetail(d, op, p);
    if (wrong) { res.status(502).json({ ok: false, error: cardText(`The run detail of ${op} is not shown: ${wrong}.`, p.root, 600), command: `/op ${op}` }); return; }
    res.json({ ok: true, detail: shownDetail(d, p.root) });
  });
}
