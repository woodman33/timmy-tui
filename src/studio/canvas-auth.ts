/**
 * Round R4 (H83): who may run code on Timmy Canvas, read and save its document, and join its bridge, and what a page session of
 * one project is given of another project's drawn cards. The owner's order (00:01 PT): "Require authorization on
 * /api/canvas/exec and /api/canvas/document, with tests for unauthorized callers and project/session boundaries."
 *
 * Two credentials, each in an Authorization header (`Bearer <64 hex>`), never in an address, a body or a log:
 * - the server's token (src/studio/project-link.ts ProjectLink): Timmy's REPL holds it (the server it started keeps it in
 *   memory; other REPLs of the same Timmy home read <canvas folder>/project-token-<port>, mode 0600);
 * - a page session that counts now (src/studio/card-relay.ts sessionFor): a canvas page opened by /canvas open traded its
 *   one-time grant for one; it counts only for the project named when the grant was made and the REPL holding it then, for
 *   12 hours from its making.
 *
 * What each allows here:
 * - POST /api/canvas/exec: the token only, from no page (no Origin), with no query string; while a project is named, only
 *   the REPL that holds it (its holder id, sent with the call: holderMayRun); and only while a page whose session counts now
 *   for that project and that REPL holds the bridge (src/studio/bridge.ts).
 * - GET /api/canvas/document: the token (the document as saved) or a session that counts now (every drawn card of another
 *   project with its kept detail withheld: withholdOthers).
 * - PUT /api/canvas/document: the token, or a session that counts now, which cannot change or erase another project's kept
 *   detail (keepOthers: the saved copy of each such card keeps its identity and kept detail; the page's other edits to it,
 *   its position say, stand; a card the page deletes stays deleted).
 * - The bridge: a page joins only with a session that counts now, sent as a WebSocket subprotocol (bridgeGate).
 */
import type { IncomingMessage } from 'node:http';
import type express from 'express';
import { CANVAS_PROTOCOL, SESSION_PROTOCOL, type BridgeGate, type PageCheck } from './bridge.js';
import { CardRelay, type SessionCheck } from './card-relay.js';
import type { NamedProject, ProjectLink } from './project-link.js';

/** The tldraw shape types of Timmy Canvas's drawn cards (companion/studio-canvas/src/cards.js CARD_SHAPES). */
export const DRAWN_CARD_TYPES: ReadonlySet<string> = new Set(['timmy-workflow', 'timmy-params', 'timmy-result']);
/**
 * A drawn card's identity and kept detail: what a page session of another project neither reads (data, readAt) nor changes
 * (all of them). `data` is the kept detail (each block's command, each parameter's value, a result's facts); the rest name the
 * card and say when its detail was read.
 */
export const KEPT_PROPS = ['card', 'kind', 'projectId', 'project', 'title', 'command', 'data', 'readAt', 'gone'] as const;

export const DOCUMENT_REFUSED = 'Refused: the canvas is loaded and saved only by a canvas page Timmy opened (it has a session) or by Timmy\'s REPL (with its token). A page opened by its address, a bookmark or a reload has no session. In Timmy: /canvas open.';
export const JOBS_REFUSED = 'Refused: the canvas jobs are read with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.';
/** R5 (H133): the shared workspace frame (the project, its tabs, actions and activity) is the project's content too. */
export const WORKSPACE_REFUSED = 'Refused: the workspace (this project, its tabs, actions and activity) is read with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.';
export const EXEC_REFUSED = 'Refused: code runs on Timmy Canvas only for Timmy\'s REPL, with the token this canvas server made, sent in an Authorization header (the agent\'s canvas tools send it). In Timmy: /canvas open, then ask again.';
export const TOKEN_IN_ADDRESS = 'Refused: the token goes in an Authorization header, never in an address; this route takes no query string.';
export const FROM_REPL = 'Refused: this route is for Timmy\'s REPL, never a page.';
export const LINK_REFUSED = 'Refused: a receipt is linked to a canvas job only by Timmy\'s REPL, with the token this canvas server made, sent in an Authorization header.';
export const NO_PAGE_SESSION = 'Refused: a canvas page joins Timmy\'s bridge only with a session from Timmy (a page opened by /canvas open has one). In Timmy: /canvas open.';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Who is asking: the REPL (the server's token), a page session that counts now, or neither (why, in words). */
export type Caller = { ok: true; by: 'token' | 'session' } | { ok: false; why: Exclude<SessionCheck, { ok: true }>['why']; words: string };

/** The caller of a request: the server's token, or a page session that counts now for the project named; `refused` is said without either. */
export function callerOf(header: unknown, link: ProjectLink, relay: CardRelay, refused: string): Caller {
  if (link.authorized(header)) return { ok: true, by: 'token' };
  const s = relay.sessionFor(header, link.project);
  if (s.ok) return { ok: true, by: 'session' };
  return { ok: false, why: s.why, words: s.why === 'none' ? refused : s.words };
}

/** Sends the refusal of a caller who is not one (401, with words and the session's state). */
export function refuse(res: express.Response, c: Exclude<Caller, { ok: true }>): void {
  res.status(401).set('WWW-Authenticate', 'Bearer').set('Cache-Control', 'no-store').json({ ok: false, error: c.words, session: c.why });
}

/**
 * The REPL's own routes (exec, the receipt link): never from a page (no Origin), with the server's token in an Authorization
 * header, and no query string (a token is never put in an address, and these routes take none). False when refused (sent).
 */
export function replOnly(req: express.Request, res: express.Response, link: ProjectLink, refused: string): boolean {
  res.set('Cache-Control', 'no-store');
  if (req.headers.origin !== undefined) { res.status(403).json({ ok: false, error: FROM_REPL }); return false; }
  if (req.originalUrl.includes('?')) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: TOKEN_IN_ADDRESS }); return false; }
  if (!link.authorized(req.headers.authorization)) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: refused }); return false; }
  return true;
}

/**
 * While a project is named, only the REPL that holds it runs code on the canvas: the holder id it named itself with (the call's
 * `holder`, or none) must be the project's. With no project named, the token is enough (and no page can be on the bridge then:
 * a grant is made only for a named project).
 */
export function holderMayRun(p: NamedProject | null, holder: string | null): { ok: true } | { ok: false; words: string } {
  if (!p || (holder ?? null) === p.holder) return { ok: true };
  return { ok: false, words: `Refused: the canvas is held by another Timmy REPL now (it shows ${p.name} for it), and only the REPL that holds the canvas runs code there. In this REPL: /canvas open names this REPL's project to the canvas and opens it; then ask again.` };
}

/** What the bridge says when the page on it cannot run code for the project named now (by why its session does not count). */
const PAGE_WORDS: Record<string, string> = {
  project: 'Refused: the canvas page open now was opened for another project than the one the canvas shows now, so it runs no code for it. In Timmy: /canvas open, from the REPL that holds the project.',
  holder: 'Refused: the canvas page open now was opened by another Timmy REPL than the one that holds the project now, so it runs no code for it. In Timmy: /canvas open, from the REPL that holds it.',
  expired: 'Refused: the canvas page\'s session has ended (a session lasts 12 hours), so it runs no code. In Timmy: /canvas open gives the page a new one.',
  unknown: 'Refused: the canvas page\'s session is not one this canvas server keeps now, so it runs no code. In Timmy: /canvas open.',
  none: 'Refused: the canvas page has no session from Timmy, so it runs no code. In Timmy: /canvas open.',
};

/**
 * The bridge's gate: a page joins with a session that counts now, sent as a subprotocol (`timmy-session.<64 hex>`) beside
 * `timmy-canvas`; it is sent code only while that session counts.
 */
export function bridgeGate(link: ProjectLink, relay: CardRelay): BridgeGate {
  return {
    admit(req: IncomingMessage) {
      const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const sessions = offered.map((s) => SESSION_PROTOCOL.exec(s)).filter((m): m is RegExpExecArray => m !== null);
      if (sessions.length === 0) return { ok: false, status: 401, words: NO_PAGE_SESSION };
      if (sessions.length > 1 || !offered.includes(CANVAS_PROTOCOL)) return { ok: false, status: 400, words: 'A canvas page offers timmy-canvas and one session.' };
      const key = CardRelay.keyOfToken(sessions[0][1]);
      const c = relay.countsByKey(key, link.project);
      return c.ok ? { ok: true, key } : { ok: false, status: 401, words: c.words };
    },
    counts(key: string): PageCheck {
      const c = relay.countsByKey(key, link.project);
      return c.ok ? { ok: true } : { ok: false, why: c.why, words: PAGE_WORDS[c.why] ?? PAGE_WORDS.none, ended: c.why === 'expired' || c.why === 'unknown' };
    },
  };
}

type Card = Record<string, unknown> & { props: Record<string, unknown> };

/** Whether a store record is one of Timmy's drawn cards (a tldraw shape of their types, with props). */
export function isDrawnCard(r: unknown): r is Card {
  return isObject(r) && r.typeName === 'shape' && typeof r.type === 'string' && DRAWN_CARD_TYPES.has(r.type) && isObject(r.props);
}

/**
 * What a withheld card holds in place of its kept detail: what it is, and the commands to read it (cards.js shows them).
 * R4 (H88; the Mac run r23): they said `/project <name>`, which in another REPL answered "no project named tray; /project new
 * tray makes one" (a bare name is a project under Timmy's home, or a folder where that REPL runs). They now name what works:
 * Timmy opened in that project's folder, and /canvas open there; or /project with the path of its folder (a path opens a
 * project by its folder). No path of the other project is on the card: the page has none to give.
 */
export function withheldDetail(project: string): Record<string, unknown> {
  return {
    type: 'withheld',
    project,
    words: `Withheld: this card's kept detail (its commands and values) belongs to ${project}, and this page's session is for another project. To read it, open Timmy in ${project}'s folder and type /canvas open there; in a Timmy REPL open elsewhere, /project followed by the path of ${project}'s folder opens it first.`,
    commands: ['/canvas open', `/project <the path of ${project}'s folder>`],
  };
}

/**
 * R4 (H109): the projects a page session may read the kept detail of: the one it counts for now, and (a Set) every project it
 * reaches (src/studio/card-relay.ts: given for it, or followed to it since). A plain id (or null) is that one project only.
 */
export type Allowed = string | null | ReadonlySet<string>;
const allows = (allowed: Allowed, projectId: unknown): boolean => (typeof allowed === 'string' || allowed === null ? projectId === allowed : typeof projectId === 'string' && allowed.has(projectId));

/**
 * The saved snapshot as a page session of project `projectId` is given it: every drawn card of another project with its kept
 * detail withheld (it says so, and gives the commands to read it) and no reading time; everything else as saved. R4 (H109):
 * `projectId` may be the set of projects the session reaches.
 */
export function withholdOthers(snapshot: unknown, projectId: Allowed): { snapshot: unknown; withheld: number } {
  if (!isObject(snapshot) || !isObject(snapshot.store)) return { snapshot, withheld: 0 };
  let withheld = 0;
  // (a store with no prototype: a record's id, whatever it is, stays a record of its own)
  const store: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [id, r] of Object.entries(snapshot.store)) {
    if (isDrawnCard(r) && !allows(projectId, r.props.projectId)) {
      withheld += 1;
      const name = typeof r.props.project === 'string' && r.props.project.trim() ? r.props.project : 'another project';
      store[id] = { ...r, props: { ...r.props, data: withheldDetail(name), readAt: '' } };
    } else store[id] = r;
  }
  return { snapshot: { ...snapshot, store }, withheld };
}

/**
 * The document a page session of project `projectId` saves: each drawn card of another project that the saved document holds
 * keeps its saved identity and kept detail (KEPT_PROPS and its type), whatever the page sent for them (a withheld copy
 * included), while the page's other edits to it stand; a drawn card of another project the saved document does not hold as one
 * is saved with no kept detail (a page of one project never writes another's). Cards of `projectId`, and every other record,
 * as the page sent them; a card the page deleted stays deleted. R4 (H109): `projectId` may be the set of projects the session
 * reaches (each counts as its own).
 */
export function keepOthers(incoming: unknown, stored: unknown, projectId: Allowed): { snapshot: unknown; kept: number } {
  if (!isObject(incoming) || !isObject(incoming.store)) return { snapshot: incoming, kept: 0 };
  const before = isObject(stored) && isObject(stored.store) ? stored.store : {};
  let kept = 0;
  const store: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [id, r] of Object.entries(incoming.store)) {
    const was = Object.prototype.hasOwnProperty.call(before, id) ? before[id] : undefined;
    if (isDrawnCard(was) && !allows(projectId, was.props.projectId)) {
      kept += 1;
      const sent = isObject(r) ? r : {};
      const props = isObject(sent.props) ? sent.props : {};
      const own = Object.fromEntries(KEPT_PROPS.filter((k) => Object.prototype.hasOwnProperty.call(was.props, k)).map((k) => [k, was.props[k]]));
      store[id] = { ...sent, id: was.id, typeName: was.typeName, type: was.type, props: { ...props, ...own } };
    } else if (isDrawnCard(r) && !allows(projectId, r.props.projectId)) {
      store[id] = { ...r, props: { ...r.props, data: null, readAt: '' } };
    } else store[id] = r;
  }
  return { snapshot: { ...incoming, store }, kept };
}
