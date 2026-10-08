/**
 * Timmy Canvas as agent tools (plan F-4, slice 3). Each call goes to the studio server's bridge and
 * comes back read from the live canvas: the page's result or its own error, with the job ID and the
 * canvas revision. canvas_read and canvas_api send fixed code; the model's words reach the page
 * only as a JSON string literal.
 */
import { randomUUID } from 'node:crypto';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import { studioBaseUrl } from '../studio/config.js';

export interface CanvasToolOptions {
  /** The studio server; default TIMMY_STUDIO_URL, else http://127.0.0.1:4337. */
  baseUrl?: string;
  /** The REPL turn's canvas job: calls with no job ID of their own take its ID, and it keeps what they produced. */
  job?: CanvasTurnJob;
}

/** What a turn's canvas job left: the canvas revision and source revision (the sha256 of the saved canvas). */
export interface CanvasJobResult {
  job: string;
  revision: number;
  sourceRevision: string;
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
    const { jobId, revision, sourceRevision } = answer;
    if (typeof jobId === 'string' && JOB_ID.test(jobId) && typeof revision === 'number' && typeof sourceRevision === 'string' && SOURCE_REVISION.test(sourceRevision)) {
      this.jobs.set(jobId, { revision, sourceRevision });
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

/** Tell the canvas server which receipt sealed a canvas job; false when it is not running or knows no such job. */
export async function linkCanvasReceipt(job: string, receipt: string, baseUrl?: string): Promise<boolean> {
  try {
    const res = await fetch(`${studioUrl(baseUrl)}/api/canvas/jobs/${encodeURIComponent(job)}/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const NOT_RUNNING = 'Timmy Canvas is not running. Open it with /web studio in the REPL, or run `timmy studio`.';

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

type Answer = Record<string, unknown>;

export function createCanvasTools(options: CanvasToolOptions = {}) {
  const baseUrl = studioUrl(options.baseUrl);
  const exec = async (code: string, ownJobId?: string): Promise<Answer> => {
    const jobId = ownJobId ?? options.job?.current();
    const answer = await send(code, jobId);
    options.job?.saw(answer);
    return answer;
  };
  const send = async (code: string, jobId?: string): Promise<Answer> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/canvas/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobId ? { code, jobId } : { code }),
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
        'Answers carry the result or the error, the job ID and the canvas revision (document changes so far).',
      inputSchema: z.object({
        code: z.string().min(1).max(30_000).describe('Body of an async function of (editor, helpers)'),
        jobId: z.string().regex(/^[\w.:-]{1,100}$/).optional().describe('The job this call belongs to'),
      }),
      outputSchema: answer,
      execute: async ({ code, jobId }: { code: string; jobId?: string }) => exec(code, jobId),
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
  ];
}
