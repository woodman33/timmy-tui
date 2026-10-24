/**
 * R11 round 4 (H173, contract C1): the express middleware that gives a request its user, and the WebSocket hello's check.
 *
 * `withUser(cfg)` runs AFTER the launch token's `withToken` (the companion's own token first, as every content route): it
 * reads X-Timmy-Session, verifies it (session.ts verifySession: RS256 against the instance's key, exp/nbf/sub/sid/azp) and
 * sets `req.user` (SessionUser, typed below on express's Request) — or answers 401 with words ({ ok: false, needs: 'session',
 * error, words }: refuseSession) and
 * nothing else happens: no body is read, nothing is written. It NEVER reads a user id from a body, a query string, a cookie
 * or a default: `clerk_user_id` and the like are not looked at, so a request that names one changes nothing.
 *
 * NO IDENTITY PROVIDER CONFIGURED (the lead's ruling of 21:48): the launch token's holder IS this computer's operator, so
 * withUser sets req.user = operatorUser() ({ id: 'operator', operator: true }) and never answers 401 needs:'session'; the
 * session header, if any, is not looked at (nothing could verify it). The launch token is the companion's existing trust
 * boundary, not a caller-supplied id. With a provider configured there is NO operator fallback.
 *
 * The WebSocket hello carries the same token in its `session` field; `verifyHello(msg, cfg, host)` verifies it the same way
 * (H171 wires the socket: a hello without a verified user is told why and gets no user data); not configured, it answers the
 * operator too, as withUser does.
 *
 * `userOf(req)` is for a route mounted after withUser that wants the user without an `as` cast; it throws when withUser
 * did not run (a mount order error, never a request's doing).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IdentityConfig } from './config.js';
import { operatorUser, originsOf, sessionTokenOf, SESSION_WORDS, verifySession, type SessionResult, type SessionUser, type VerifyOptions } from './session.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** R11 round 4 (H173): the verified user of this request (withUser); absent on routes without it. */
      user?: SessionUser;
    }
  }
}

export interface WithUserOptions {
  /** The companion's LAN addresses when it listens with --lan (the page's origins there, for azp). None when absent. */
  lan?: readonly string[];
  /** The page's origins for a request, when the default (its Host, originsOf) is not right (a test's). */
  origins?: (req: Request) => readonly string[];
  /** A test's FAKE JWKS address on 127.0.0.1 (session.ts VerifyOptions.jwks). */
  jwks?: string;
  /** The moment to check exp and nbf against (a test's). */
  now?: () => Date;
}

/**
 * The middleware. `cfg` may be a function, read at each request, so a test (or a later reload) can change it without
 * remounting; identityConfig(env) once at start is the usual.
 */
export function withUser(cfg: IdentityConfig | (() => IdentityConfig), options: WithUserOptions = {}): RequestHandler {
  const config = (): IdentityConfig => (typeof cfg === 'function' ? cfg() : cfg);
  // named, so a test can find the routes behind it in express's router by this handler's name (H172's isolation test)
  const withUser = (req: Request, res: Response, next: NextFunction): void => {
    const c = config();
    if (!c.configured) { req.user = operatorUser(); next(); return; } // the operator principal: the launch token's holder
    const token = sessionTokenOf(req.headers);
    const verify: VerifyOptions = {
      origins: options.origins ? options.origins(req) : originsOf(req.headers.host, options.lan),
      ...(options.jwks ? { jwks: options.jwks } : {}),
      ...(options.now ? { now: options.now() } : {}),
    };
    verifySession(token, c, verify).then((r) => {
      if (!r.ok) { refuseSession(res, r.why); return; }
      req.user = r.user;
      next();
    }, () => { refuseSession(res, SESSION_WORDS.signature); });
  };
  return withUser;
}

/**
 * The 401 a missing or refused session answers: { ok: false, needs: 'session', error, words } with no store and
 * WWW-Authenticate, as the launch token's refusal (src/utils/local-request.ts refuseRequest) but marked `needs: 'session'`,
 * so the page's shell tells it from the launch token's 401 (which still refuses the page): it clears its session and shows
 * the account screen (H171's shell contract).
 */
export function refuseSession(res: Response, why: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.status(401);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.end(JSON.stringify({ ok: false, needs: 'session', error: why, words: why }));
}

/** The verified user of a request behind withUser; throws when withUser did not run before this route (a mount order error). */
export function userOf(req: Request): SessionUser {
  if (!req.user) throw new Error('userOf: this route is not behind withUser (mount it after the identity middleware).');
  return req.user;
}

/**
 * The WebSocket hello's `session` field verified the same way: the user, or why not. `host` is the upgrade request's Host
 * (the page's origin for azp), `lan` the companion's LAN addresses with --lan.
 */
export function verifyHello(msg: unknown, cfg: IdentityConfig, host: string | undefined, options: Pick<WithUserOptions, 'lan' | 'jwks' | 'now'> = {}): Promise<SessionResult> {
  if (!cfg.configured) return Promise.resolve({ ok: true, user: operatorUser() });
  const session = msg && typeof msg === 'object' ? (msg as { session?: unknown }).session : undefined;
  return verifySession(session, cfg, {
    origins: originsOf(host, options.lan),
    ...(options.jwks ? { jwks: options.jwks } : {}),
    ...(options.now ? { now: options.now() } : {}),
  });
}
