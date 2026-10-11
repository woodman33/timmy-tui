/**
 * Round R4 (helper H93): the client's two reads of Timmy Cloud's backend, with the operator's token: GET
 * /v1/operator/overview and GET /v1/operator/orders. GET only: the client changes nothing on the backend (approving,
 * reconciling, resolving and deciding are the backend's operator routes, sent by a person in this slice). No connection is
 * kept, no redirect is followed, an answer is at most CACHE_MAX_BYTES and comes whole within the time limit (15 s unless
 * said), and every word of a failure has the token taken out.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { CACHE_MAX_BYTES } from './store.js';
import { redactToken } from './token.js';

export type GetJson = { ok: true; json: unknown } | { ok: false; status: number | null; why: string };

const NET_WORDS: Record<string, string> = {
  ECONNREFUSED: 'nothing answered (connection refused): is the backend running there?',
  ECONNRESET: 'the connection was reset before the answer came',
  EHOSTUNREACH: 'the host cannot be reached',
  ENETUNREACH: 'the network cannot be reached',
  ENOTFOUND: 'the name does not resolve',
  EAI_AGAIN: 'the name could not be resolved now',
};

/** One GET of `route` under the backend's address, with the operator's token; its JSON, or why not, in words. */
export function getJson(base: string, route: string, token: string, o: { timeoutMs?: number } = {}): Promise<GetJson> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const url = new URL(`${base}${route}`);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const scrub = (s: string): string => redactToken(s, token);
  return new Promise((resolve) => {
    let done = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (r: GetJson): void => { if (!done) { done = true; if (deadline) clearTimeout(deadline); resolve(r.ok ? r : { ...r, why: scrub(r.why) }); } };
    const req = request(url, {
      method: 'GET', agent: false,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'timmy-cloud-client' },
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > CACHE_MAX_BYTES) { finish({ ok: false, status, why: `GET ${route} answered more than ${CACHE_MAX_BYTES / 1024 / 1024} MB: not kept` }); req.destroy(); return; }
        chunks.push(c);
      });
      res.on('error', () => finish({ ok: false, status, why: `GET ${route}: the answer was cut off` }));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = undefined;
        try { json = JSON.parse(text); } catch { /* said below */ }
        const said = json && typeof json === 'object' && typeof (json as Record<string, unknown>).error === 'string' ? (json as Record<string, string>).error : undefined;
        if (status === 401) return finish({ ok: false, status, why: `GET ${route}: the backend refused the operator's token (401${said ? `: ${said}` : ''}); check the token file named by timmy cloud use` });
        if (status >= 300 && status < 400) return finish({ ok: false, status, why: `GET ${route} answered ${status} (a redirect, which the client does not follow)` });
        if (status !== 200) return finish({ ok: false, status, why: `GET ${route} answered ${status}${said ? `: ${said}` : ''}` });
        if (json === undefined) return finish({ ok: false, status, why: `GET ${route} answered 200 without JSON` });
        return finish({ ok: true, json });
      });
    });
    // the limit is for the whole answer, not for each silence: a backend that sends a byte now and then is not waited on longer
    deadline = setTimeout(() => { finish({ ok: false, status: null, why: `GET ${route}: no complete answer within ${Math.round(timeoutMs / 1000)} s` }); req.destroy(); }, timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, status: null, why: `GET ${route}: ${NET_WORDS[e.code ?? ''] ?? `the request failed (${e.code ?? e.message})`}` }));
    req.end();
  });
}
