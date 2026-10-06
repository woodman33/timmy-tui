// Timmy Pro billing Worker. All logic lives in src/pro/service.ts; this file
// rate-limits the routes that cost Stripe calls, then hands every request to
// one Durable Object whose SQLite storage holds the subscription ledger. The
// service serializes read-modify-write per subscription (see withLock there);
// the Durable Object alone does not, because it interleaves requests while one
// awaits Stripe.

import { RATE_LIMITED_PATHS, handleProRequest, type ProEnv } from '../../../src/pro/service.js';
import { SqlLicenseStore, type SqlExec } from '../../../src/pro/store.js';
import { stripeClient } from '../../../src/pro/stripe-api.js';

interface DurableObjectStub { fetch(request: Request): Promise<Response> }
interface DurableObjectNamespace { idFromName(name: string): unknown; get(id: unknown): DurableObjectStub }
interface DurableObjectState { storage: { sql: SqlExec } }
interface RateLimit { limit(options: { key: string }): Promise<{ success: boolean }> }

export interface Env extends ProEnv {
  LEDGER: DurableObjectNamespace;
  /** Per-IP limit on RATE_LIMITED_PATHS (wrangler.jsonc "ratelimits"); optional so local tests run without it. */
  PRO_LIMITER?: RateLimit;
}

export class ProLedger {
  private readonly store: SqlLicenseStore;

  constructor(state: DurableObjectState, private readonly env: Env) {
    this.store = new SqlLicenseStore(state.storage.sql);
  }

  fetch(request: Request): Promise<Response> {
    return handleProRequest(request, {
      env: this.env,
      store: this.store,
      stripe: stripeClient(this.env.STRIPE_SECRET_KEY ?? ''),
      now: () => Math.floor(Date.now() / 1000),
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (env.PRO_LIMITER && RATE_LIMITED_PATHS.has(pathname)) {
      const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.PRO_LIMITER.limit({ key: `${client}:${pathname}` });
      if (!success) {
        return new Response(JSON.stringify({ error: 'too many requests', code: 'rate_limited' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        });
      }
    }
    return env.LEDGER.get(env.LEDGER.idFromName('ledger')).fetch(request);
  },
};
