/**
 * Timmy Cloud's backend: the SIMULATED provider. Nothing real is bought, registered, set up, deployed or deleted, and no
 * network service is contacted: this is an HTTP server on 127.0.0.1 that keeps everything in memory.
 *
 * It models what the documentation of the operator's provider says (read as files only: its official MCP server 2.11.0's
 * README and its CLI's documentation), behind neutral paths of its own:
 *
 * - a purchase made with no payment method uses the account's default one; an answer of 202 means the payment is still
 *   being processed and the order completes later (a domain bought that way is not registered until its setup is
 *   completed after the payment); an order can end failed;
 * - a site setup runs in the background: the answer is a setup id, read until it is completed (then a site id) or failed;
 * - deploying an archive to a site overwrites its contents and cannot be undone; deleting a site is immediate (it goes
 *   to "deleting" at once and is gone after);
 * - a certificate setup is limited per domain (three per seven days; again within a minute is refused with 429);
 * - there is no operation that cancels a purchase or a setup, none that shares account access and none that makes a
 *   sub-account: those paths answer 404 like any path that does not exist;
 * - the API has a shared rate limit: 429 with Retry-After.
 *
 * By default it keeps no client reference for lookups, like the documented provider (a purchase takes items and a
 * payment method only), so a purchase whose answer was lost can be found by what it bought but never proven absent.
 * `provesAbsence: true` makes it a provider that keeps client references and finds by them.
 *
 * Tests script its behaviour (payments, setups, links, certificates, health) and its faults: an answer lost after the
 * operation was done, a connection reset before anything was done, a timeout, a delay, a 429, a 5xx, an error that
 * echoes the credential. Prices in its catalog are simulated and are no provider's real prices.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export type SimOp =
  | 'catalog' | 'purchase' | 'read_purchase' | 'find_purchase' | 'subscriptions'
  | 'read_domain' | 'complete_domain_registration'
  | 'start_site_setup' | 'read_site_setup' | 'find_site_setup' | 'read_site' | 'link_domain'
  | 'start_certificate' | 'read_certificate' | 'read_health' | 'delete_site' | 'deploy_archive'
  | 'start_vps_setup' | 'read_vps' | 'find_vps' | 'unknown';

/**
 * - reset_before: the connection is dropped before anything is done.
 * - lose_answer: the operation is done, then the connection is dropped with no answer.
 * - timeout: the operation is done and no answer ever comes (the caller's own time limit ends it).
 * - delay: the operation is done and the answer comes after delayMs.
 * - rate_limit: 429 with Retry-After: retryAfterS; nothing is done.
 * - server_error: the operation is done, then a 500 answer.
 * - echo_credential: a 422 whose error repeats the Authorization header it was sent; nothing is done.
 */
export type FaultMode = 'reset_before' | 'lose_answer' | 'timeout' | 'delay' | 'rate_limit' | 'server_error' | 'echo_credential';
export interface Fault { op: SimOp; mode: FaultMode; retryAfterS?: number; delayMs?: number }

export type PaymentScript = 'paid' | 'declined' | { processing: number; then: 'paid' | 'failed' };

export interface SimCatalogItem { id: string; category: 'DOMAIN' | 'VPS' | 'HOSTING'; name: string; price_cents: number; currency: string; period: string }

export const SIM_CATALOG: readonly SimCatalogItem[] = [
  { id: 'sim-domain-com-1y', category: 'DOMAIN', name: '.com domain, 1 year (simulated price)', price_cents: 1200, currency: 'USD', period: '1 year' },
  { id: 'sim-vps-small-1m', category: 'VPS', name: 'Small VPS, 1 month (simulated price)', price_cents: 700, currency: 'USD', period: '1 month' },
  { id: 'sim-vps-large-1m', category: 'VPS', name: 'Large VPS, 1 month (simulated price)', price_cents: 6000, currency: 'USD', period: '1 month' },
  { id: 'sim-agency-site', category: 'HOSTING', name: 'Website on the operator\'s agency plan (simulated; no purchase)', price_cents: 0, currency: 'USD', period: 'while the plan lasts' },
];

export interface Received {
  at: number;
  op: SimOp;
  method: string;
  path: string;
  client_reference: string | null;
  /** The JSON body it was sent (never a header: the credential travels only in Authorization). */
  body: Record<string, unknown> | null;
  /** What the simulator did: done (state changed or a read answered), refused, rate_limited, reset, unauthorized. */
  result: 'done' | 'refused' | 'rate_limited' | 'reset' | 'unauthorized' | 'no_such_operation';
  status: number | null;
}

interface SimPurchase {
  id: string; client_reference: string | null; item: SimCatalogItem; domain: string | null;
  status: 'payment_initiated' | 'completed' | 'failed'; message: string | null;
  processing_reads: number; then: 'paid' | 'failed'; created_at: string;
}
interface SimDomain { domain: string; state: 'awaiting_payment' | 'awaiting_setup' | 'registering' | 'registered' | 'failed'; purchase_id: string; expires_at: string | null; reads_left: number }
interface SimSetup { id: string; client_reference: string | null; status: 'running' | 'completed' | 'failed'; reads_left: number; outcome: 'complete' | 'fail'; site_id: string | null; message: string | null; created_at: string }
interface SimSite { id: string; state: 'active' | 'deleting' | 'deleted'; hostname: string; domains: string[]; contents: string; reads_after_delete: number }
interface SimCert { status: 'installing' | 'active' | 'failed'; reads_left: number; outcome: 'active' | 'fail' }
interface SimVps { id: string; purchase_id: string; state: 'installing' | 'running' | 'error'; reads_left: number; client_reference: string | null }

export interface SimOptions {
  /** The agency credential it accepts as `Authorization: Bearer <credential>`. */
  credential: string;
  /** Keep client references and find purchases and setups by them (the documented provider does not). */
  provesAbsence?: boolean;
  /** The shared rate limit: at most `max` requests per `windowMs`; beyond it, 429 with Retry-After. Off by default. */
  rateLimit?: { max: number; windowMs: number } | null;
  /** Reads of a running setup, a registering domain, an installing certificate or VPS before it settles. Default 1. */
  settleAfterReads?: number;
  /** A certificate setup for the same domain again within this is refused with 429 (documented: a minute). Default 60000. */
  certificateCooldownMs?: number;
}

export class SimulatedProvider {
  readonly faults: Fault[] = [];
  readonly payments: PaymentScript[] = [];
  readonly setupOutcomes: Array<'complete' | 'fail'> = [];
  readonly linkOutcomes: Array<'ok' | 'fail'> = [];
  readonly certificateOutcomes: Array<'active' | 'fail'> = [];
  readonly healthOutcomes: Array<'answers' | 'fails'> = [];
  readonly received: Received[] = [];

  readonly purchases = new Map<string, SimPurchase>();
  readonly domains = new Map<string, SimDomain>();
  readonly setups = new Map<string, SimSetup>();
  readonly sites = new Map<string, SimSite>();
  readonly certificates = new Map<string, SimCert>();
  readonly vps = new Map<string, SimVps>();
  /** Certificate setups by domain (ms since epoch), for the three-per-seven-days rule. */
  private readonly certSetups = new Map<string, number[]>();
  private readonly sockets = new Set<Socket>();
  private readonly waiters: Array<{ op: SimOp; resolve: (r: Received) => void }> = [];
  private windowStart = 0;
  private windowCount = 0;
  private nextOrder = 1001;
  private server: Server | null = null;
  private port = 0;

  constructor(readonly opts: SimOptions) {}

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  start(port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port }, () => {
        server.off('error', reject);
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        resolve(this.url);
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  /** Requests of `op` that the simulator carried out (its state changed, or a read answered). */
  done(op: SimOp): Received[] { return this.received.filter((r) => r.op === op && r.result === 'done'); }

  /** Resolves at the next request of `op` the simulator receives (after it has acted on it). */
  nextRequest(op: SimOp): Promise<Received> {
    return new Promise((resolve) => this.waiters.push({ op, resolve }));
  }

  private note(entry: Omit<Received, 'at'>): Received {
    const r: Received = { at: Date.now(), ...entry };
    this.received.push(r);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      if (this.waiters[i].op === r.op) { this.waiters[i].resolve(r); this.waiters.splice(i, 1); }
    }
    return r;
  }

  private takeFault(op: SimOp): Fault | null {
    const i = this.faults.findIndex((f) => f.op === op);
    if (i < 0) return null;
    return this.faults.splice(i, 1)[0];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const body = await readJson(req);
    const route = matchRoute(method, url.pathname);
    const clientReference = typeof body?.client_reference === 'string' ? body.client_reference : (url.searchParams.get('client_reference') ?? null);
    const base = { op: route.op, method, path: url.pathname, client_reference: clientReference, body };

    const auth = req.headers.authorization ?? '';
    const fault = route.op === 'unknown' ? null : this.takeFault(route.op);
    if (fault?.mode === 'echo_credential') {
      this.note({ ...base, result: 'refused', status: 422 });
      return send(res, 422, { error: `Request rejected for credentials "${auth}" (simulated provider echoing what it was sent)` });
    }
    if (auth !== `Bearer ${this.opts.credential}`) {
      this.note({ ...base, result: 'unauthorized', status: 401 });
      return send(res, 401, { error: 'Unauthenticated.' });
    }
    if (route.op === 'unknown' || (!this.opts.provesAbsence && (route.op === 'find_purchase' || route.op === 'find_site_setup'))) {
      this.note({ ...base, op: 'unknown', result: 'no_such_operation', status: 404 });
      return send(res, 404, { error: 'No such operation.' });
    }
    if (fault?.mode === 'rate_limit') {
      this.note({ ...base, result: 'rate_limited', status: 429 });
      return send(res, 429, { error: 'Too many requests.' }, { 'Retry-After': String(fault.retryAfterS ?? 1) });
    }
    const limited = this.sharedLimit();
    if (limited !== null) {
      this.note({ ...base, result: 'rate_limited', status: 429 });
      return send(res, 429, { error: 'Too many requests.' }, { 'Retry-After': String(limited) });
    }
    if (fault?.mode === 'reset_before') {
      this.note({ ...base, result: 'reset', status: null });
      req.socket.destroy();
      return;
    }

    const answer = this.perform(route, body, url);
    this.note({ ...base, result: answer.status < 400 ? 'done' : 'refused', status: answer.status });

    if (fault?.mode === 'lose_answer') { req.socket.destroy(); return; }
    if (fault?.mode === 'timeout') return; // the socket stays open, unanswered, until the caller gives up or close()
    if (fault?.mode === 'server_error') return send(res, 500, { error: 'Internal error (simulated).' });
    if (fault?.mode === 'delay') await new Promise((r) => setTimeout(r, fault.delayMs ?? 1000));
    if (res.destroyed || res.socket?.destroyed) return;
    send(res, answer.status, answer.body, answer.headers);
  }

  /** The shared rate limit, if set: null when this request is inside it, else the seconds to wait. */
  private sharedLimit(): number | null {
    const limit = this.opts.rateLimit;
    if (!limit) return null;
    const now = Date.now();
    if (now - this.windowStart >= limit.windowMs) { this.windowStart = now; this.windowCount = 0; }
    this.windowCount += 1;
    if (this.windowCount <= limit.max) return null;
    return Math.max(1, Math.ceil((this.windowStart + limit.windowMs - now) / 1000));
  }

  private settle(): number { return this.opts.settleAfterReads ?? 1; }

  private perform(route: Route, body: Record<string, unknown> | null, url: URL): SimAnswer {
    const now = new Date().toISOString();
    switch (route.op) {
      case 'catalog':
        return ok({ items: SIM_CATALOG });
      case 'purchase': {
        const items = Array.isArray(body?.items) ? body.items as Array<{ item_id?: unknown }> : [];
        const item = SIM_CATALOG.find((c) => c.id === items[0]?.item_id);
        if (items.length !== 1 || !item) return refuse(422, 'The order must name exactly one catalog item that exists.');
        if (item.category === 'HOSTING') return refuse(422, 'A website on the agency plan is set up, not bought.');
        const domain = typeof body?.domain === 'string' ? body.domain : null;
        if (item.category === 'DOMAIN') {
          if (!domain) return refuse(422, 'A domain purchase names the domain.');
          if (this.domains.has(domain)) return refuse(422, `The domain ${domain} is not available.`);
        }
        const script = this.payments.shift() ?? 'paid';
        const id = `sim-order-${this.nextOrder++}`;
        const p: SimPurchase = {
          id, client_reference: this.opts.provesAbsence ? (typeof body?.client_reference === 'string' ? body.client_reference : null) : null,
          item, domain, status: 'completed', message: null, processing_reads: 0, then: 'paid', created_at: now,
        };
        if (script === 'declined') { p.status = 'failed'; p.message = 'The payment was declined by the payment method on file (simulated).'; }
        else if (typeof script === 'object') { p.status = 'payment_initiated'; p.processing_reads = script.processing; p.then = script.then; p.message = 'Payment is being processed. The order will complete automatically once payment is confirmed.'; }
        this.purchases.set(id, p);
        if (item.category === 'DOMAIN' && domain && p.status !== 'failed') {
          this.domains.set(domain, {
            domain, purchase_id: id, reads_left: this.settle(),
            state: p.status === 'completed' ? 'registered' : 'awaiting_payment',
            expires_at: p.status === 'completed' ? oneYearFrom(now) : null,
          });
        }
        return { status: p.status === 'payment_initiated' ? 202 : 200, body: this.purchaseBody(p) };
      }
      case 'read_purchase': {
        const p = this.purchases.get(route.params.id);
        if (!p) return refuse(404, 'No such order.');
        if (p.status === 'payment_initiated') {
          if (p.processing_reads > 0) p.processing_reads -= 1;
          if (p.processing_reads === 0) this.settlePayment(p);
        }
        return ok(this.purchaseBody(p));
      }
      case 'find_purchase': {
        const ref = url.searchParams.get('client_reference');
        return ok({ purchases: [...this.purchases.values()].filter((p) => ref && p.client_reference === ref).map((p) => this.purchaseBody(p)) });
      }
      case 'subscriptions':
        return ok({ subscriptions: [...this.purchases.values()].filter((p) => p.status === 'completed').map((p) => ({ name: p.item.name, created_at: p.created_at, status: 'active' })) });
      case 'read_domain': {
        const d = this.domains.get(route.params.domain);
        if (!d) return refuse(404, 'This domain is not in the account.');
        if (d.state === 'registering') {
          d.reads_left -= 1;
          if (d.reads_left <= 0) { d.state = 'registered'; d.expires_at = oneYearFrom(now); }
        }
        return ok(domainBody(d));
      }
      case 'complete_domain_registration': {
        const d = this.domains.get(route.params.domain);
        if (!d) return refuse(422, 'This domain is not in the account: if its order has not completed yet, wait until it appears.');
        if (d.state === 'awaiting_payment') return refuse(422, 'The order for this domain has not completed yet.');
        if (d.state !== 'awaiting_setup') return refuse(422, `This domain is ${d.state.replace(/_/g, ' ')}: there is nothing to set up.`);
        d.state = 'registering';
        d.reads_left = this.settle();
        return { status: 202, body: domainBody(d) };
      }
      case 'start_site_setup': {
        const id = randomUUID();
        const s: SimSetup = {
          id, client_reference: this.opts.provesAbsence ? (typeof body?.client_reference === 'string' ? body.client_reference : null) : null,
          status: 'running', reads_left: this.settle(), outcome: this.setupOutcomes.shift() ?? 'complete', site_id: null, message: null, created_at: now,
        };
        this.setups.set(id, s);
        return { status: 202, body: setupBody(s) };
      }
      case 'read_site_setup': {
        const s = this.setups.get(route.params.id);
        if (!s) return refuse(404, 'No such setup.');
        if (s.status === 'running') {
          s.reads_left -= 1;
          if (s.reads_left <= 0) {
            if (s.outcome === 'fail') { s.status = 'failed'; s.message = 'The website could not be set up: the datacenter had no capacity (simulated).'; }
            else {
              const site: SimSite = { id: `site-${s.id.slice(0, 8)}`, state: 'active', hostname: `${s.id.slice(0, 8)}.sim-hosting.invalid`, domains: [], contents: 'empty', reads_after_delete: 1 };
              this.sites.set(site.id, site);
              s.status = 'completed';
              s.site_id = site.id;
            }
          }
        }
        return ok(setupBody(s));
      }
      case 'find_site_setup': {
        const ref = url.searchParams.get('client_reference');
        return ok({ setups: [...this.setups.values()].filter((s) => ref && s.client_reference === ref).map(setupBody) });
      }
      case 'read_site': {
        const site = this.sites.get(route.params.id);
        if (!site) return refuse(404, 'No such website.');
        if (site.state === 'deleting') {
          site.reads_after_delete -= 1;
          if (site.reads_after_delete < 0) site.state = 'deleted';
        }
        return ok(siteBody(site));
      }
      case 'link_domain': {
        const site = this.sites.get(route.params.id);
        if (!site || site.state !== 'active') return refuse(404, 'No such website.');
        const domain = typeof body?.domain === 'string' ? body.domain : '';
        if (!domain) return refuse(422, 'Name the domain to link.');
        if (site.domains.includes(domain)) return ok(siteBody(site));
        if ((this.linkOutcomes.shift() ?? 'ok') === 'fail') return refuse(422, `The domain ${domain} does not point to this hosting yet: set its nameservers first (simulated).`);
        site.domains.push(domain);
        return ok(siteBody(site));
      }
      case 'start_certificate': {
        const site = this.sites.get(route.params.id);
        const domain = route.params.domain;
        if (!site || site.state !== 'active' || !site.domains.includes(domain)) return refuse(404, 'No such website or domain.');
        const key = `${site.id}|${domain}`;
        const times = (this.certSetups.get(domain) ?? []).filter((t) => Date.now() - t < 7 * 24 * 3600 * 1000);
        const last = times[times.length - 1];
        const cooldown = this.opts.certificateCooldownMs ?? 60_000;
        if (last !== undefined && Date.now() - last < cooldown) return { status: 429, body: { error: 'The same domain was requested less than a minute ago.' }, headers: { 'Retry-After': String(Math.ceil(cooldown / 1000)) } };
        const current = this.certificates.get(key);
        if (current && current.status !== 'failed') return refuse(422, 'A certificate process is already recorded for this domain.');
        if (times.length >= 3) return refuse(422, 'This domain has had three certificate setups in the last seven days.');
        times.push(Date.now());
        this.certSetups.set(domain, times);
        this.certificates.set(key, { status: 'installing', reads_left: this.settle(), outcome: this.certificateOutcomes.shift() ?? 'active' });
        return { status: 202, body: { status: 'installing' } };
      }
      case 'read_certificate': {
        const c = this.certificates.get(`${route.params.id}|${route.params.domain}`);
        if (!c) return ok({ status: 'not_installed' });
        if (c.status === 'installing') {
          c.reads_left -= 1;
          if (c.reads_left <= 0) c.status = c.outcome === 'fail' ? 'failed' : 'active';
        }
        return ok({ status: c.status, ...(c.status === 'failed' ? { message: 'The certificate authority could not validate the domain (simulated).' } : {}) });
      }
      case 'read_health': {
        const site = this.sites.get(route.params.id);
        if (!site || site.state !== 'active') return ok({ answers: false, http_status: null, message: 'No such website is serving.' });
        const fails = (this.healthOutcomes.shift() ?? 'answers') === 'fails';
        return ok(fails ? { answers: false, http_status: 503, message: 'The site answered 503 (simulated).' } : { answers: true, http_status: 200, message: 'The site answered 200 (simulated).' });
      }
      case 'delete_site': {
        const site = this.sites.get(route.params.id);
        if (!site || site.state === 'deleted') return refuse(404, 'No such website.');
        // Immediate: the site goes to deleting now; its resources are removed in the background.
        site.state = 'deleting';
        site.domains = [];
        for (const key of [...this.certificates.keys()]) if (key.startsWith(`${site.id}|`)) this.certificates.delete(key);
        return { status: 202, body: siteBody(site) };
      }
      case 'deploy_archive': {
        const site = this.sites.get(route.params.id);
        if (!site || site.state !== 'active') return refuse(404, 'No such website.');
        const archive = typeof body?.archive_sha256 === 'string' ? body.archive_sha256 : '';
        if (!/^[0-9a-f]{64}$/.test(archive)) return refuse(422, 'Name the archive by its sha256.');
        // Overwrites: the previous contents are gone, and there is no operation that brings them back.
        site.contents = archive;
        return ok({ site_id: site.id, archive_sha256: archive, message: 'The website\'s previous contents were overwritten by the archive; this cannot be undone.' });
      }
      case 'start_vps_setup': {
        const ref = typeof body?.purchase_reference === 'string' ? body.purchase_reference : '';
        const p = this.purchases.get(ref);
        if (!p || p.item.category !== 'VPS') return refuse(422, 'No VPS order with this reference.');
        if (p.status !== 'completed') return refuse(422, 'The order has not completed yet.');
        if ([...this.vps.values()].some((v) => v.purchase_id === ref)) return refuse(422, 'This order already has a VPS.');
        const v: SimVps = { id: `vps-${randomUUID().slice(0, 8)}`, purchase_id: ref, state: 'installing', reads_left: this.settle(), client_reference: typeof body?.client_reference === 'string' ? body.client_reference : null };
        this.vps.set(v.id, v);
        return { status: 202, body: vpsBody(v) };
      }
      case 'read_vps': {
        const v = this.vps.get(route.params.id);
        if (!v) return refuse(404, 'No such VPS.');
        if (v.state === 'installing') { v.reads_left -= 1; if (v.reads_left <= 0) v.state = 'running'; }
        return ok(vpsBody(v));
      }
      case 'find_vps': {
        const ref = url.searchParams.get('purchase_reference');
        return ok({ vps: [...this.vps.values()].filter((v) => ref && v.purchase_id === ref).map(vpsBody) });
      }
      default:
        return refuse(404, 'No such operation.');
    }
  }

  private settlePayment(p: SimPurchase): void {
    if (p.then === 'failed') { p.status = 'failed'; p.message = 'The payment could not be completed: the payment method was declined (simulated).'; return; }
    p.status = 'completed';
    p.message = null;
    if (p.item.category === 'DOMAIN' && p.domain) {
      const d = this.domains.get(p.domain);
      // Paid, and not registered: the domain waits for its setup to be completed.
      if (d && d.state === 'awaiting_payment') d.state = 'awaiting_setup';
    }
  }

  private purchaseBody(p: SimPurchase): Record<string, unknown> {
    return {
      id: p.id, status: p.status, currency: p.item.currency,
      ...(p.status === 'completed' ? { total_cents: p.item.price_cents } : {}),
      ...(p.message ? { message: p.message } : {}),
      ...(p.item.category === 'DOMAIN' ? { domain: p.domain, registered: this.domains.get(p.domain ?? '')?.state === 'registered' } : {}),
    };
  }
}

interface Route { op: SimOp; params: Record<string, string> }
interface SimAnswer { status: number; body: Record<string, unknown>; headers?: Record<string, string> }

function matchRoute(method: string, path: string): Route {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'sim' || parts[1] !== 'v1') return { op: 'unknown', params: {} };
  const p = parts.slice(2);
  const is = (m: string, ...shape: string[]): boolean => method === m && p.length === shape.length && shape.every((s, i) => s.startsWith(':') || s === p[i]);
  const params = (...shape: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    shape.forEach((s, i) => { if (s.startsWith(':')) out[s.slice(1)] = p[i]; });
    return out;
  };
  if (is('GET', 'catalog')) return { op: 'catalog', params: {} };
  if (is('POST', 'purchases')) return { op: 'purchase', params: {} };
  if (is('GET', 'purchases')) return { op: 'find_purchase', params: {} };
  if (is('GET', 'purchases', ':id')) return { op: 'read_purchase', params: params('purchases', ':id') };
  if (is('GET', 'subscriptions')) return { op: 'subscriptions', params: {} };
  if (is('GET', 'domains', ':domain')) return { op: 'read_domain', params: params('domains', ':domain') };
  if (is('POST', 'domains', ':domain', 'setup')) return { op: 'complete_domain_registration', params: params('domains', ':domain', 'setup') };
  if (is('POST', 'sites', 'setups')) return { op: 'start_site_setup', params: {} };
  if (is('GET', 'sites', 'setups')) return { op: 'find_site_setup', params: {} };
  if (is('GET', 'sites', 'setups', ':id')) return { op: 'read_site_setup', params: params('sites', 'setups', ':id') };
  if (is('GET', 'sites', ':id')) return { op: 'read_site', params: params('sites', ':id') };
  if (is('DELETE', 'sites', ':id')) return { op: 'delete_site', params: params('sites', ':id') };
  if (is('POST', 'sites', ':id', 'deploy')) return { op: 'deploy_archive', params: params('sites', ':id', 'deploy') };
  if (is('GET', 'sites', ':id', 'health')) return { op: 'read_health', params: params('sites', ':id', 'health') };
  if (is('POST', 'sites', ':id', 'domains')) return { op: 'link_domain', params: params('sites', ':id', 'domains') };
  if (is('POST', 'sites', ':id', 'domains', ':domain', 'certificate')) return { op: 'start_certificate', params: params('sites', ':id', 'domains', ':domain', 'certificate') };
  if (is('GET', 'sites', ':id', 'domains', ':domain', 'certificate')) return { op: 'read_certificate', params: params('sites', ':id', 'domains', ':domain', 'certificate') };
  if (is('POST', 'vps', 'setups')) return { op: 'start_vps_setup', params: {} };
  if (is('GET', 'vps')) return { op: 'find_vps', params: {} };
  if (is('GET', 'vps', ':id')) return { op: 'read_vps', params: params('vps', ':id') };
  return { op: 'unknown', params: {} };
}

function ok(body: Record<string, unknown>): SimAnswer { return { status: 200, body }; }
function refuse(status: number, error: string): SimAnswer { return { status, body: { error } }; }

function domainBody(d: SimDomain): Record<string, unknown> {
  return { domain: d.domain, state: d.state, expires_at: d.expires_at, purchase_reference: d.purchase_id };
}
function setupBody(s: SimSetup): Record<string, unknown> {
  return { setup_uuid: s.id, status: s.status, website_uid: s.site_id, ...(s.message ? { message: s.message } : {}) };
}
function siteBody(s: SimSite): Record<string, unknown> {
  return { website_uid: s.id, state: s.state, hostname: s.hostname, domains: [...s.domains] };
}
function vpsBody(v: SimVps): Record<string, unknown> {
  return { vps_id: v.id, state: v.state, purchase_reference: v.purchase_id };
}
function oneYearFrom(iso: string): string {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
      } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
