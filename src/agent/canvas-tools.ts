/**
 * Timmy Canvas as agent tools (plan F-4, slice 3). Each call goes to the studio server's bridge and
 * comes back read from the live canvas: the page's result or its own error, with the job ID and the
 * canvas revision. canvas_read and canvas_api send fixed code; the model's words reach the page
 * only as a JSON string literal.
 *
 * R4 (H83): each call carries the REPL's credential for the canvas: the server's token in an Authorization header (never in
 * the address or the body) and the REPL's holder id in the body, so the canvas runs it only for the REPL that holds the project
 * named to it (src/studio/canvas-auth.ts). Linking a receipt to a canvas job carries the token too.
 *
 * R5 (H133): what the agent writes on the board arrives as a draft by default (the operator's order of 2026-10-15: "Timmy can
 * propose and arrange board content ... users can review, accept or discard drafts"). canvas_exec sends `draft: true` unless the
 * model passes `draft: false` (the REPL's NEEDS YOU box still asks before every call either way), and canvas_place_project_card
 * places its note as a draft. A draft carries the canvas revision the model last read (`baseRevision`, from the last answer these
 * tools saw, or the model's own): the page refuses one made from a revision the canvas has left, and says so. What a draft draws
 * waits on the page, outlined and labelled, for a person's Accept or Discard (companion/studio-canvas/src/drafts.js); a draft only
 * adds (it never changes or removes what is on the board), and accepting it runs nothing.
 */
import { randomUUID } from 'node:crypto';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import { studioBaseUrl } from '../studio/config.js';

/** R4 (H83): what a canvas call is sent with: the canvas server's token, and the holder id this REPL named itself with (or none). */
export interface CanvasAuth { token: string | null; holder: string | null }

export interface CanvasToolOptions {
  /** The studio server; default TIMMY_STUDIO_URL, else http://127.0.0.1:4337. */
  baseUrl?: string;
  /** R5 (H133): whether agent writes are drafts unless the model says otherwise (default true). */
  drafts?: boolean;
  /** The REPL turn's canvas job: calls with no job ID of their own take its ID, and it keeps what they produced. */
  job?: CanvasTurnJob;
  /** R4 (H83): this REPL's credential for the canvas, asked at each call (src/repl/canvas-project.ts credentials) */
  auth?: () => CanvasAuth | null;
}

/** What a turn's canvas job left: the canvas revision and source revision (the sha256 of the saved canvas). */
export interface CanvasJobResult {
  job: string;
  revision: number;
  sourceRevision: string;
  /** Whether the job's last call succeeded (round R1); a failed call kept nothing on the canvas. */
  ok?: boolean;
  /** Whether any of its calls changed the canvas (round R1); a job of lookups only has nothing to inspect. */
  changed?: boolean;
}

const JOB_ID = /^[\w.:-]{1,100}$/;
const SOURCE_REVISION = /^[0-9a-f]{64}$/;

/**
 * The canvas jobs of one REPL turn (fourth order, step 5): calls with no job ID of their own share the
 * turn's, made on the first such call, and the turn keeps the revision and source revision the last
 * call of each job saved, so its receipt names the same jobs and the same saved canvas as the canvas
 * file and its ledger. A job the model names itself counts too (LIVE-01, ledger row 65: the model
 * named its job `draw-live-01` and the turn kept nothing, so the receipt named no job).
 */
export class CanvasTurnJob {
  private id: string | null = null;
  /** Each job the turn's calls saved under, in the order first seen. */
  private jobs = new Map<string, Omit<CanvasJobResult, 'job'>>();

  constructor(private readonly newId: () => string = () => `turn-${randomUUID().slice(0, 8)}`) {}

  /** This turn's job ID, made on first use. */
  current(): string {
    this.id ??= this.newId();
    return this.id;
  }

  /** A canvas answer: kept for its job when the page saved what it produced. */
  saw(answer: Record<string, unknown>): void {
    const { jobId, revision, sourceRevision, ok, changed } = answer;
    if (typeof jobId === 'string' && JOB_ID.test(jobId) && typeof revision === 'number' && typeof sourceRevision === 'string' && SOURCE_REVISION.test(sourceRevision)) {
      const before = this.jobs.get(jobId);
      const anyChange = before?.changed === true || changed === true ? true : typeof changed === 'boolean' || before?.changed === false ? false : undefined;
      this.jobs.set(jobId, { revision, sourceRevision, ...(typeof ok === 'boolean' ? { ok } : {}), ...(anyChange === undefined ? {} : { changed: anyChange }) });
    }
  }

  /** The turn ended: what each of its canvas jobs saved (none when it saved nothing), and fresh jobs next turn. */
  close(): CanvasJobResult[] {
    const result = [...this.jobs].map(([job, saved]) => ({ job, ...saved }));
    this.id = null;
    this.jobs = new Map();
    return result;
  }
}

/** The canvas server: the caller's, else the one address every Timmy surface uses (round R1). */
const studioUrl = (baseUrl?: string): string => (baseUrl ? baseUrl.replace(/\/+$/, '') : studioBaseUrl(process.env));

/**
 * Tell the canvas server which receipt sealed a canvas job; false when it is not running, knows no such job, or (R4 H83) the
 * REPL holds no token for it (the link is a write: the server's token, in an Authorization header).
 */
export async function linkCanvasReceipt(job: string, receipt: string, baseUrl?: string, token?: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${studioUrl(baseUrl)}/api/canvas/jobs/${encodeURIComponent(job)}/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ receipt }),
      signal: AbortSignal.timeout(2000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

const NOT_RUNNING = 'Timmy Canvas is not running. In Timmy: /canvas open starts it and opens the page.';

/** A page summary: pages, the current page and its shapes (bounds and plain text), capped at 200. */
const READ = `
const plain = (rich) => {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node.text === 'string') out.push(node.text);
    for (const child of node.content ?? []) walk(child);
    if (node.type === 'paragraph') out.push('\\n');
  };
  walk(rich);
  return out.join('').trim();
};
const all = editor.getCurrentPageShapes();
const shapes = all.slice(0, 200).map((s) => {
  const b = editor.getShapePageBounds(s.id);
  const text = s.props && s.props.richText ? plain(s.props.richText) : '';
  return { id: s.id, type: s.type, x: Math.round(b ? b.x : s.x), y: Math.round(b ? b.y : s.y), w: Math.round(b ? b.w : 0), h: Math.round(b ? b.h : 0), ...(text ? { text } : {}) };
});
return {
  page: { id: editor.getCurrentPageId(), name: editor.getCurrentPage().name },
  pages: editor.getPages().map((p) => p.name),
  shapeCount: all.length,
  shapes,
  ...(all.length > shapes.length ? { truncated: all.length - shapes.length } : {}),
  selected: editor.getSelectedShapeIds(),
};`;

/** Editor members whose names contain the query: methods with their parameter count, and getters. */
const API = (query: string): string => `
const query = ${JSON.stringify(query.toLowerCase())};
const proto = Object.getPrototypeOf(editor);
const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && !n.startsWith('_') && n.toLowerCase().includes(query)).sort();
const members = names.slice(0, 80).map((name) => {
  const d = Object.getOwnPropertyDescriptor(proto, name);
  return d && typeof d.value === 'function' ? { name, kind: 'method', params: d.value.length } : { name, kind: 'getter' };
});
return { query, total: names.length, members, docs: 'https://tldraw.dev/reference/editor/Editor' };`;

/**
 * Round R4 (H55): places one card of the active project (GET /api/project) through the page's own Project panel, or, with
 * no card, lists the cards and changes nothing. Fixed code: the model's card id reaches the page only as a JSON string.
 */
export const PLACE_PROJECT_CARD = (card: string | undefined): string => `
const card = ${JSON.stringify(card ?? null)};
const canvas = window.timmyCanvas;
if (!canvas || typeof canvas.placeProjectCard !== 'function') throw new Error('This canvas page has no Project panel: rebuild it (npm run build:canvas) and reload the page.');
return await canvas.placeProjectCard(card, editor);`;

type Answer = Record<string, unknown>;

/**
 * Round R1 (the Mac run): Haiku 4.5 spent six calls on props.text, a label prop and tldraw 1's arrow
 * terminals before it gave up. The tool now shows a drawing that works in this tldraw, and a test runs
 * this exact code in a real browser against the bundled tldraw (tests/studio-canvas-browser.test.ts).
 */
export const CANVAS_EXAMPLE = [
  "const { createShapeId, toRichText } = helpers;",
  "const box = (x, label) => ({ id: createShapeId(), type: 'geo', x, y: 0, props: { w: 160, h: 80, richText: toRichText(label) } });",
  "const a = box(0, 'Prompt'), b = box(260, 'Agent');",
  "editor.createShapes([a, b, { id: createShapeId(), type: 'text', x: 0, y: -60, props: { richText: toRichText('Title') } }]);",
  "const arrow = createShapeId();",
  "editor.createShape({ id: arrow, type: 'arrow', x: 0, y: 0, props: { start: { x: 160, y: 40 }, end: { x: 260, y: 40 } } });",
  "editor.createBindings([{ type: 'arrow', fromId: arrow, toId: a.id, props: { terminal: 'start' } }, { type: 'arrow', fromId: arrow, toId: b.id, props: { terminal: 'end' } }]);",
  "return [a.id, b.id, arrow];",
].join(' ');

export function createCanvasTools(options: CanvasToolOptions = {}) {
  const baseUrl = studioUrl(options.baseUrl);
  const draftsByDefault = options.drafts !== false;
  /** R5 (H133): the canvas revision the last answer these tools saw named (what the model last read), or null before any. */
  let lastRevision: number | null = null;
  const exec = async (code: string, ownJobId?: string, draft?: { baseRevision?: number }): Promise<Answer> => {
    const jobId = ownJobId ?? options.job?.current();
    const answer = await send(code, jobId, draft ? { baseRevision: draft.baseRevision ?? lastRevision } : null);
    if (typeof answer.revision === 'number' && Number.isInteger(answer.revision)) lastRevision = answer.revision;
    options.job?.saw(answer);
    return answer;
  };
  const send = async (code: string, jobId?: string, draft: { baseRevision: number | null } | null = null): Promise<Answer> => {
    // R4 (H83): the token in a header, the holder id in the body; without a token the canvas says why (401) and runs nothing.
    const auth = options.auth?.() ?? null;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/canvas/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({
          code, ...(jobId ? { jobId } : {}), ...(auth?.holder ? { holder: auth.holder } : {}),
          // R5 (H133): a draft, made from the revision the model last read (none known: the page takes its revision now)
          ...(draft ? { draft: true, ...(draft.baseRevision !== null ? { baseRevision: draft.baseRevision } : {}) } : {}),
        }),
      });
    } catch {
      return { ok: false, error: NOT_RUNNING };
    }
    try {
      return (await res.json()) as Answer;
    } catch {
      return { ok: false, error: `Timmy Canvas answered HTTP ${res.status} without a result.` };
    }
  };
  const answer = z.object({ ok: z.boolean() }).passthrough();
  return [
    tool({
      name: 'canvas_exec',
      description:
        'Run JavaScript on Timmy Canvas, the live tldraw canvas (full Editor API). The code is the body of an async ' +
        'function of `editor` (the tldraw Editor) and `helpers` (createShapeId, toRichText, createBindingId, Box, Vec); ' +
        'return a JSON-serializable value to read results back. Text goes in props.richText via helpers.toRichText. ' +
        'Answers carry the result or the error, the job ID and the canvas revision (document changes so far). ' +
        'A call that fails keeps nothing: the canvas goes back to how it was before the call (rolledBack), so retry the whole drawing. ' +
        'Shapes take text only as props.richText (never props.text or props.label); an arrow is joined to shapes by bindings. ' +
        'What a call draws arrives as a DRAFT by default: it waits on the board, outlined and labelled, until the person accepts or discards it ' +
        '(the answer\'s draft says its id and how many shapes it holds). A draft only adds shapes (and bindings and assets): a call that changes ' +
        'or removes what is already on the board keeps nothing and says why. A draft made from an older revision than the canvas has now is ' +
        'refused before it runs (stale): read the canvas again (canvas_read), then propose again. Pass draft: false only to change the board\'s ' +
        'own shapes directly, when the person asked for exactly that. ' +
        `A drawing that works in this tldraw: ${CANVAS_EXAMPLE}`,
      inputSchema: z.object({
        code: z.string().min(1).max(30_000).describe('Body of an async function of (editor, helpers)'),
        jobId: z.string().regex(/^[\w.:-]{1,100}$/).optional().describe('The job this call belongs to'),
        draft: z.boolean().optional().describe('Whether what this call draws waits for the person to accept or discard it (default true)'),
        baseRevision: z.number().int().min(0).optional().describe('The canvas revision this call was made from (default: the revision the last canvas answer named)'),
      }),
      outputSchema: answer,
      execute: async ({ code, jobId, draft, baseRevision }: { code: string; jobId?: string; draft?: boolean; baseRevision?: number }) =>
        exec(code, jobId, (draft ?? draftsByDefault) ? { ...(baseRevision !== undefined ? { baseRevision } : {}) } : undefined),
    } as any),
    tool({
      name: 'canvas_read',
      description: 'Read Timmy Canvas: its pages, the current page, and up to 200 shapes with bounds and plain text, plus the selection.',
      inputSchema: z.object({}),
      outputSchema: answer,
      execute: async () => exec(READ),
    } as any),
    tool({
      name: 'canvas_api',
      description: 'Search the live tldraw Editor API on Timmy Canvas by name (for example "shape", "binding", "camera", "export"): methods with their parameter count, and getters.',
      inputSchema: z.object({ query: z.string().min(1).max(60).describe('Part of a member name') }),
      outputSchema: answer,
      execute: async ({ query }: { query: string }) => exec(API(query)),
    } as any),
    // Round R4 (H55): the active project's cards on the canvas, through the page's Project panel (fixed code).
    tool({
      name: 'canvas_place_project_card',
      description:
        "Place one card of the active project on Timmy Canvas: a note holding the card's title, its state in words and the typed command that acts on it, " +
        "with the record and receipt behind it kept in the note's meta. The cards are the project's workflow documents, parameter files, /iterate flows, " +
        'VoxVision records and Control Room runs, read from their records by the board\'s own readers once the REPL has named the project to the canvas (/canvas open). ' +
        'Call it without a card to list the cards (nothing is placed); then with one card\'s id as listed, for example flow:f1a2b3c4d. ' +
        'R5: a placed card arrives as a draft the person accepts or discards on the board.',
      inputSchema: z.object({ card: z.string().min(1).max(400).optional().describe('A card id as the list gives it; leave it out to list the cards') }),
      outputSchema: answer,
      // R5 (H133): placing a card is a write, so a draft; listing the cards draws nothing
      execute: async ({ card }: { card?: string }) => exec(PLACE_PROJECT_CARD(card), undefined, card && draftsByDefault ? {} : undefined),
    } as any),
  ];
}
