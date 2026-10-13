/**
 * How Timmy's local servers answer when they cannot (R4 H87): words, and nothing else.
 *
 * Found in the installed package (r23): the browser companion's GET / answered 404 with "ENOENT … dist/src/companion/client/
 * index.html", the absolute install path included (express's default error page, a stack in development mode), and `timmy logs`
 * died on GET /chat (an uncaught ENOENT on its page file). Now a failure is an answer of its own: the status, plain words that
 * say what happened and that nothing was changed, no path of this computer, no stack, and nothing written to a log (a request's
 * address or headers could carry a token). The server keeps answering.
 */
import type { ServerResponse } from 'node:http';

/** A 4xx or 5xx status. */
export type FailureStatus = number;

/** Ends `res` with `words`: JSON ({ ok: false, error }) for the routes a page calls, plain text for a page itself. */
export function failRequest(res: ServerResponse, status: FailureStatus, words: string, as: 'json' | 'text' = 'json'): void {
  if (res.headersSent) { res.destroy(); return; }
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (as === 'text') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`${words}\n`);
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: words }));
}

/** Runs `fn`; a throw becomes `failRequest(res, 500, words)` (an answer already under way is ended). Never rethrows. */
export function answering(res: ServerResponse, words: string, fn: () => void, as: 'json' | 'text' = 'json'): void {
  try { fn(); } catch { failRequest(res, 500, words, as); }
}
