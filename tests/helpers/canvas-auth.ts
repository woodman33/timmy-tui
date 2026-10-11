/**
 * Round R4 (H83): the credentials of Timmy Canvas, as its real callers use them, for the tests: the REPL names its project with
 * the server's token (and its holder id), asks for a one-time grant, and the page trades it for a session (Host and Origin
 * exactly the server's own, as a browser sends them); a FAKE page joins the bridge with that session as a WebSocket subprotocol
 * (a `ws` client, labelled FAKE where a test uses it: the real page is exercised in a real Chromium elsewhere). Real HTTP on
 * 127.0.0.1 throughout; nothing here makes a credential of its own.
 */
import { request } from 'node:http';
import { WebSocket } from 'ws';

export interface Reply { status: number; body: string; json: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }

/** One HTTP request to 127.0.0.1:`port`, with exactly these headers (Host as given, else the server's own). */
export function call(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const headers = { Host: `127.0.0.1:${port}`, ...(o.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(o.body)) } : {}), ...o.headers };
    const req = request({ host: '127.0.0.1', port, method, path, headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(body) as Record<string, unknown>; } catch { /* not JSON */ }
        done({ status: res.statusCode ?? 0, body, json, headers: res.headers });
      });
    });
    req.on('error', fail);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/** Names a project to the canvas as the REPL does (POST /api/project/active with the server's token). */
export async function nameProject(port: number, token: string, p: { root: string; name: string; holder?: string | null; jobs?: string | null; receipts?: string | null }): Promise<Reply> {
  const r = await call(port, 'POST', '/api/project/active', { headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  if (r.status !== 200) throw new Error(`naming ${p.name} was refused: ${r.status} ${r.body}`);
  return r;
}

/** A one-time grant for the project named now and its holder, as /canvas open asks for one (the server's token). */
export async function grant(port: number, token: string): Promise<string> {
  const r = await call(port, 'POST', '/api/project/grant', { headers: bearer(token) });
  if (r.status !== 200 || typeof r.json.grant !== 'string') throw new Error(`no grant: ${r.status} ${r.body}`);
  return r.json.grant;
}

/** The page's trade of its grant for a session (Host and Origin exactly this server's, as the canvas page sends them). */
export async function session(port: number, code: string): Promise<string> {
  const r = await call(port, 'POST', '/api/project/session', { headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ grant: code }) });
  if (r.status !== 200 || typeof r.json.token !== 'string') throw new Error(`no session: ${r.status} ${r.body}`);
  return r.json.token;
}

/** A grant traded for a session at once: what a page /canvas open opened holds. */
export async function pageSession(port: number, token: string): Promise<string> {
  return session(port, await grant(port, token));
}

/** The subprotocols a canvas page joins the bridge with (companion/studio-canvas/src/cards.js bridgeProtocols). */
export const pageProtocols = (s: string): string[] => ['timmy-canvas', `timmy-session.${s}`];

/**
 * A FAKE canvas page on the bridge: a `ws` client with the page's Origin and, when given, its session as a subprotocol; it
 * answers each exec with `answer(message)` (nothing when that is undefined) and records what it was sent.
 */
export async function fakePage(port: number, o: { session?: string | null; protocols?: string[]; origin?: string; answer?: (m: { id: number; code: string; jobId: string }) => unknown } = {}): Promise<{ ws: WebSocket; seen: Array<{ id: number; code: string; jobId: string }> }> {
  const protocols = o.protocols ?? (o.session ? pageProtocols(o.session) : []);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, protocols, { origin: o.origin ?? `http://127.0.0.1:${port}` });
  const seen: Array<{ id: number; code: string; jobId: string }> = [];
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, r) => { let b = ''; r.on('data', (c: Buffer) => { b += String(c); }); r.on('end', () => reject(Object.assign(new Error(`HTTP ${r.statusCode}: ${b.trim()}`), { status: r.statusCode, body: b }))); });
  });
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as { type?: string; id: number; code: string; jobId: string };
    if (m.type !== 'exec') return;
    seen.push(m);
    const reply = o.answer?.(m);
    if (reply !== undefined) ws.send(JSON.stringify({ id: m.id, ...(reply as object) }));
  });
  return { ws, seen };
}

/** The REPL's call to run code on the canvas: the token in a header, the holder (if any) in the body. */
export function exec(port: number, token: string | null, body: Record<string, unknown>, headers: Record<string, string> = {}, path = '/api/canvas/exec'): Promise<Reply> {
  return call(port, 'POST', path, { headers: { 'Content-Type': 'application/json', ...(token ? bearer(token) : {}), ...headers }, body: JSON.stringify(body) });
}
