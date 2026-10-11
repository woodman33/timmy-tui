/**
 * Round R4 (H84): one rule for the web servers Timmy runs on this computer, and the token that the browser companion
 * (src/companion/server.ts, `timmy watch`) and the log companion (src/utils/logserver.ts, `timmy logs`) need.
 *
 * The rule (Timmy Canvas's, R4 H83: src/studio/server.ts imports it from here): a request is answered only when its Host is
 * 127.0.0.1, localhost or [::1] (any port), so a page elsewhere cannot rebind a name of its own to this computer and read
 * it (DNS rebinding), and its Origin, when a browser sends one, is a page of this computer. A server started for the local
 * network (`timmy watch --lan`) also answers this computer's own network addresses, written as the address it gives (a
 * literal IPv4 address of one of its networks, never a name).
 *
 * The token: 32 random bytes, hex, made when a server starts. The address Timmy gives carries it in its fragment
 * (`#t=<token>`), which a browser never sends to a server; the page takes it out of the address at once, keeps it in
 * memory only, and sends it in an Authorization header (`Bearer <token>`) on each request and as a WebSocket subprotocol
 * (`timmy-token.<token>`, beside the server's own, which is the one the server selects, so the token is never sent back).
 * Compared in constant time. A request that carries it in its address is refused: an address ends up in histories and logs.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';

/** Host headers a local server answers: a page elsewhere cannot rebind its DNS name to 127.0.0.1 and read it. */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
/** Origins allowed to call it: this computer's own pages (a browser always sends Origin on a WebSocket). */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** `host` is one of `own` (a literal address), with or without a port. */
function ownAddress(host: string, own: readonly string[]): boolean {
  return own.some((a) => IPV4.test(a) && (host === a || (host.startsWith(`${a}:`) && /^\d{1,5}$/.test(host.slice(a.length + 1)))));
}

/**
 * Addressed to this computer, and (when a browser says where it comes from) sent by this computer's pages. `lan`: this
 * computer's own network addresses a server started for the network answers too (lanAddresses()); none by default.
 */
export function isLocalRequest(req: IncomingMessage, lan: readonly string[] = []): boolean {
  const host = req.headers.host ?? '';
  if (!LOCAL_HOST.test(host) && !ownAddress(host, lan)) return false;
  const origin = req.headers.origin;
  if (origin === undefined || LOCAL_ORIGIN.test(origin)) return true;
  const page = /^http:\/\/([^/]+)$/.exec(origin);
  return !!page && ownAddress(page[1], lan);
}

/** This computer's IPv4 addresses on its networks (not loopback): what a server started with --lan answers and gives. */
export function lanAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (v4 && !a.internal && IPV4.test(a.address) && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

// ── the token ─────────────────────────────────────────────────────────────────

export const TOKEN_HEX = /^[0-9a-f]{64}$/;
/** The subprotocol a page sends the token in, beside the server's own. */
export const TOKEN_PROTOCOL = /^timmy-token\.([0-9a-f]{64})$/;
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export class LocalToken {
  readonly value: string;

  /** `given`: a test's or a lane's own (64 hex); made at random when absent or not in that shape. */
  constructor(given?: string) {
    this.value = given && TOKEN_HEX.test(given) ? given : randomBytes(32).toString('hex');
  }

  /** Whether `given` is this token (constant time; anything else compares an empty string). */
  is(given: string): boolean {
    const g = TOKEN_HEX.test(given) ? given : '';
    return timingSafeEqual(sha(g), sha(this.value)) && g.length === this.value.length;
  }

  /** Whether an Authorization header carries it (`Bearer <64 hex>`). */
  bearer(header: unknown): boolean {
    const m = typeof header === 'string' ? /^Bearer ([0-9a-f]{64})$/.exec(header) : null;
    return this.is(m ? m[1] : '');
  }

  /** What a WebSocket upgrade offers: `app` and exactly one token subprotocol, which is this token ('ok'); else why not. */
  offered(header: unknown, app: string): 'ok' | 'none' | 'wrong' {
    const offered = String(header ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const tokens = offered.map((s) => TOKEN_PROTOCOL.exec(s)).filter((m): m is RegExpExecArray => m !== null);
    if (tokens.length === 0) return 'none';
    if (tokens.length > 1 || !offered.includes(app)) return 'wrong';
    return this.is(tokens[0][1]) ? 'ok' : 'wrong';
  }

  /** Whether a request's address (its path and query, as sent or decoded) carries this token. */
  inAddress(url: string | undefined): boolean {
    if (typeof url !== 'string') return false;
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch { /* as sent */ }
    return url.toLowerCase().includes(this.value) || decoded.toLowerCase().includes(this.value);
  }

  /** `base` with this token in its fragment: the address Timmy gives to open. */
  open(base: string): string {
    return `${base}#t=${this.value}`;
  }
}

export const TOKEN_IN_ADDRESS = 'Refused: the token goes in an Authorization header, never in an address (an address is kept in histories and logs). Open the page from Timmy: it carries the token after #, which a browser never sends.';

// ── refusals ─────────────────────────────────────────────────────────────────

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** A refused request, answered as JSON ({ok: false, error}); a 401 also says which credential (Bearer). */
export function refuseRequest(res: ServerResponse, status: 401 | 403, words: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(NO_STORE)) res.setHeader(k, v);
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  res.end(JSON.stringify({ ok: false, error: words }));
}

/** A refused WebSocket upgrade: an HTTP answer with the words, then the connection is closed (nothing is upgraded). */
export function refuseUpgrade(socket: Duplex, status: 400 | 401 | 403, words: string): void {
  const reason = status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Forbidden';
  const body = `${words}\n`;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

// ── the log companion's token, kept for this user's other programs ────────────

/**
 * Where `timmy logs` keeps its token for this user's other programs on this computer (the browser companion's controller
 * calls, and ensureLogCompanion, which opens the page): <TIMMY_HOME>/state/logs-token-<port>, mode 0600, with the pid of the
 * server that wrote it, as Timmy Canvas keeps its own (src/studio/project-link.ts). Never a log.
 */
export const logsTokenFile = (port: number, env: Record<string, string | undefined> = process.env): string =>
  join(env.TIMMY_HOME || join(homedir(), 'timmy'), 'state', `logs-token-${port}`);

/** Writes the token with this process's pid (mode 0600, written whole); false when it cannot be written. */
export function writeTokenFile(file: string, token: string, pid = process.pid): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ token, pid })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** The token a server left in `file`: only a regular file, in its shape, whose process still runs; else null. */
export function readTokenFile(file: string): string | null {
  try {
    if (!lstatSync(file).isFile()) return null;
    const o = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown; pid?: unknown };
    if (typeof o.token !== 'string' || !TOKEN_HEX.test(o.token) || !Number.isInteger(o.pid) || (o.pid as number) <= 0) return null;
    return alive(o.pid as number) ? o.token : null;
  } catch { return null; }
}

/** Removes the file when it still holds this token (another server may have written its own since). */
export function dropTokenFile(file: string, token: string): void {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
    if (o.token === token) unlinkSync(file);
  } catch { /* gone, or not ours */ }
}
