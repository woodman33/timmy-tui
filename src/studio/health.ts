/**
 * Round R1: is Timmy Canvas running at an address, and is a canvas page open in it? Asked of the
 * server's health route, which runs nothing in the page and writes nothing. Free and quick: one local
 * request with a short timeout.
 */
import { TLDRAW_VERSION } from './config.js';

export interface CanvasJobSummary {
  id: string;
  ok: boolean;
  revision: number;
  at: string;
  receipt?: string;
}

export type StudioHealth =
  | {
      state: 'running';
      /** Whether a canvas page holds the bridge; null when an older Timmy Canvas cannot say. */
      pageConnected: boolean | null;
      /** Whether the page's bundle is built (the page needs it). */
      built: boolean | null;
      /** The saved canvas's revision; null when the saved file is unreadable or the server cannot say. */
      revision: number | null;
      jobs: number;
      latestJob: CanvasJobSummary | null;
      tldrawVersion: string | null;
    }
  | { state: 'not-running' }
  | { state: 'other'; detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function jobOf(v: unknown): CanvasJobSummary | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null;
  return {
    id: v.id,
    ok: v.ok === true,
    revision: typeof v.revision === 'number' ? v.revision : 0,
    at: typeof v.at === 'string' ? v.at : '',
    ...(typeof v.receipt === 'string' ? { receipt: v.receipt } : {}),
  };
}

/** What answers at `baseUrl`: Timmy Canvas (and its state), nothing, or another program. */
export async function studioHealth(baseUrl: string, timeoutMs = 1000): Promise<StudioHealth> {
  const get = (path: string): Promise<Response> => fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  let res: Response;
  try {
    res = await get('/api/canvas/health');
  } catch (error) {
    const err = error as { name?: string; cause?: { code?: string; errors?: Array<{ code?: string }> } };
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { state: 'other', detail: `something holds the port but did not answer within ${timeoutMs} ms` };
    // Only a refused connection means nothing listens. A program that answers and hangs up, or speaks
    // something other than HTTP, holds the port all the same (round R1 review).
    const codes = [err?.cause?.code, ...(err?.cause?.errors ?? []).map((e) => e?.code)].filter((c): c is string => typeof c === 'string');
    if (codes.length && codes.every((c) => c === 'ECONNREFUSED')) return { state: 'not-running' };
    if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) return { state: 'other', detail: 'the address does not resolve' };
    return { state: 'other', detail: `something holds the port but is not Timmy Canvas (${codes[0] ?? 'no HTTP answer'})` };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: not Timmy's health route
  }
  if (res.ok && isRecord(body) && body.app === 'timmy-canvas') {
    return {
      state: 'running',
      pageConnected: typeof body.pageConnected === 'boolean' ? body.pageConnected : null,
      built: typeof body.built === 'boolean' ? body.built : null,
      revision: typeof body.revision === 'number' ? body.revision : null,
      jobs: typeof body.jobs === 'number' ? body.jobs : 0,
      latestJob: jobOf(body.latestJob),
      tldrawVersion: typeof body.tldrawVersion === 'string' ? body.tldrawVersion : null,
    };
  }
  // A Timmy Canvas from before this route: its jobs route answers with a list.
  if (res.status === 404) {
    try {
      const jobs = (await (await get('/api/canvas/jobs')).json()) as unknown;
      if (Array.isArray(jobs)) {
        return { state: 'running', pageConnected: null, built: null, revision: null, jobs: jobs.length, latestJob: jobOf(jobs[0]), tldrawVersion: null };
      }
    } catch {
      // not Timmy either
    }
  }
  return { state: 'other', detail: `HTTP ${res.status}, not Timmy Canvas` };
}

export { TLDRAW_VERSION };
