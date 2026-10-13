/**
 * Timmy Cloud's backend: the adapter for the SIMULATED provider (simulated-provider.ts), over real HTTP.
 *
 * It implements the provider-neutral `CloudProvider` interface, as a private adapter for a real provider would. It sends
 * the agency credential only in the Authorization header, never echoes it, and passes the provider's own words through
 * the backend's redactor before they leave this module. It classifies every answer:
 *
 * - a connection refused before a byte was written: not sent (the provider did nothing);
 * - no answer (a timeout, a reset connection), an answer that cannot be read, or a 5xx: unknown (it may have acted);
 * - 429: a rate limit, with its Retry-After (5 s when none comes); a 409 with Retry-After: busy with the same thing; another
 *   4xx: refused.
 *
 * Reconcile (`findEffect`) reads by what a call asked for. What that can prove is stated per operation: with no client
 * references (the documented provider's purchases take none), a purchase can be found by its domain but never proven
 * absent, and a VPS purchase cannot even be found with certainty, so both wait for a person; a link, a certificate, a
 * domain's registration, a VPS setup and a deletion are read directly and can be proven either way.
 */
import { request } from 'node:http';
import type {
  CallAnswer, CallOutcome, CatalogItem, CertificateView, CloudProvider, DomainView, Finding, HealthView, ProviderCall,
  ProviderInfo, ProviderRead, PurchaseView, ReadAnswer, ReadOutcome, SiteSetupView, SiteView, VpsView,
} from './provider.js';
import type { Redactor } from './redaction.js';

type HttpResult =
  | { kind: 'response'; status: number; retryAfterMs: number | null; json: Record<string, unknown> | null; text: string }
  | { kind: 'not_sent'; words: string }
  | { kind: 'lost'; words: string };

export interface SimulatedAdapterOptions {
  baseUrl: string;
  credential: string;
  /** The simulated provider was started with provesAbsence (it keeps client references). */
  provesAbsence: boolean;
  timeoutMs: number;
  redactor: Redactor;
  /**
   * How far the provider's clock may be behind this backend's when a purchase found by its domain is matched to a call:
   * placed earlier than the call was written ahead, by more than this, it is not that call's. Default 2000 ms.
   */
  clockMarginMs?: number;
}

const DEFAULT_RETRY_AFTER_MS = 5000;

export class SimulatedAdapter implements CloudProvider {
  readonly info: ProviderInfo;

  constructor(private readonly o: SimulatedAdapterOptions) {
    this.info = { name: 'simulated provider', simulated: true, purchase_absence_proof: o.provesAbsence ? 'client_reference' : 'none' };
  }

  async call(c: ProviderCall): Promise<CallOutcome> {
    const route = callRoute(c);
    const r = await this.http(route.method, route.path, route.body);
    if (r.kind === 'not_sent') return { kind: 'not_sent', words: r.words };
    if (r.kind === 'lost') return { kind: 'unknown', http_status: null, words: r.words };
    if (r.status === 429) return { kind: 'rate_limited', http_status: 429, retry_after_ms: r.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, words: this.words(r) };
    if (r.status === 409 && r.retryAfterMs !== null) return { kind: 'busy', http_status: 409, retry_after_ms: r.retryAfterMs, words: this.words(r) };
    if (r.status >= 400 && r.status < 500) return { kind: 'refused', http_status: r.status, words: this.words(r) };
    if (r.status >= 500 || r.status < 200 || r.status >= 300) {
      return { kind: 'unknown', http_status: r.status, words: `The provider answered ${r.status}: it may have acted. ${this.words(r)}`.trim() };
    }
    const answer = r.json ? parseCallAnswer(c, r.json) : null;
    if (!answer) return { kind: 'unknown', http_status: r.status, words: 'The provider answered, but its answer could not be read: it may have acted.' };
    return { kind: 'answered', http_status: r.status, answer };
  }

  async read<R extends ProviderRead>(rd: R): Promise<ReadOutcome<Extract<ReadAnswer, { read: R['read'] }>>> {
    const out = await this.readAny(rd);
    return out as ReadOutcome<Extract<ReadAnswer, { read: R['read'] }>>;
  }

  private async readAny(rd: ProviderRead): Promise<ReadOutcome<ReadAnswer>> {
    const path = readPath(rd);
    const r = await this.http('GET', path, null);
    if (r.kind !== 'response') return { kind: 'failed', words: r.words };
    if (r.status === 429) return { kind: 'rate_limited', retry_after_ms: r.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, words: this.words(r) };
    const nullable = rd.read !== 'catalog' && rd.read !== 'certificate' && rd.read !== 'health';
    if (r.status === 404 && nullable) return { kind: 'answered', value: emptyRead(rd) };
    if (r.status !== 200 || !r.json) return { kind: 'failed', words: `The provider answered ${r.status}. ${this.words(r)}`.trim() };
    const value = parseRead(rd, r.json);
    if (!value) return { kind: 'failed', words: 'The provider\'s answer could not be read.' };
    return { kind: 'answered', value };
  }

  async findEffect(c: ProviderCall, since: string): Promise<ReadOutcome<Finding>> {
    switch (c.op) {
      case 'purchase': {
        if (this.o.provesAbsence) {
          const l = await this.listRead(`/sim/v1/purchases?client_reference=${encodeURIComponent(c.client_reference)}`, 'purchases');
          if (l.kind !== 'answered') return l;
          const list = l.value;
          const view = list.length === 1 ? parsePurchase(list[0]) : null;
          if (view) return answered({ found: true, answer: { op: 'purchase', purchase: view }, how: `the provider found the purchase by its client reference (order ${view.reference})` });
          if (list.length === 0) return answered({ found: false, proven: true, how: 'the provider keeps the client reference of every purchase it receives, and none has this one' });
          return answered({ found: false, proven: false, how: `the provider has ${list.length} purchases with this client reference: a person checks` });
        }
        if (c.kind === 'domain' && c.domain) {
          const d = await this.readAny({ read: 'domain', domain: c.domain });
          if (d.kind !== 'answered') return d;
          const domain = (d.value as Extract<ReadAnswer, { read: 'domain' }>).domain;
          if (!domain || !domain.purchase_reference) {
            return answered({ found: false, proven: false, how: `the domain ${c.domain} is not in the account; that does not prove no purchase was placed (the provider takes no client reference on a purchase, and an order whose payment is still processing may not show yet)` });
          }
          const p = await this.readAny({ read: 'purchase', reference: domain.purchase_reference });
          if (p.kind !== 'answered') return p;
          const purchase = (p.value as Extract<ReadAnswer, { read: 'purchase' }>).purchase;
          if (!purchase) return answered({ found: false, proven: false, how: `the domain ${c.domain} is in the account, but its order ${domain.purchase_reference} could not be read: a person checks` });
          // A purchase placed before this call was written ahead is not this call's (review H1): someone else's, or older.
          const placed = purchase.created_at ? Date.parse(purchase.created_at) : NaN;
          if (!Number.isFinite(placed)) return answered({ found: false, proven: false, how: `the domain ${c.domain} is in the account, but when its purchase was placed is not known, so it may not be this call's` });
          if (placed < Date.parse(since) - (this.o.clockMarginMs ?? 2000)) return answered({ found: false, proven: false, how: `the domain ${c.domain} is in the account, but its purchase was placed before this call was sent, so it is not this call's` });
          return answered({ found: true, answer: { op: 'purchase', purchase }, how: `the domain ${c.domain} is in the account, bought by order ${purchase.reference}` });
        }
        const l = await this.listRead('/sim/v1/subscriptions', 'subscriptions');
        if (l.kind !== 'answered') return l;
        const subs = l.value;
        const since_ms = Date.parse(since);
        const recent = subs.filter((x) => typeof x.created_at === 'string' && Date.parse(x.created_at) >= since_ms - 1000);
        const hint = recent.length
          ? `${recent.length} subscription(s) created since the request was sent (${recent.map((x) => String(x.name)).join('; ')}) may be this purchase; the provider takes no client reference, so which one is not known`
          : 'no subscription was created since the request was sent, which does not prove no purchase was placed (a payment may still be processing)';
        return answered({ found: false, proven: false, how: hint });
      }
      case 'complete_domain_registration': {
        const d = await this.readAny({ read: 'domain', domain: c.domain });
        if (d.kind !== 'answered') return d;
        const domain = (d.value as Extract<ReadAnswer, { read: 'domain' }>).domain;
        if (domain && (domain.state === 'registering' || domain.state === 'registered')) return answered({ found: true, answer: { op: 'complete_domain_registration', domain }, how: `the domain is ${domain.state}` });
        if (domain && domain.state === 'awaiting_setup') return answered({ found: false, proven: true, how: 'the domain still awaits its setup: the request did not take effect' });
        return answered({ found: false, proven: false, how: `the domain is ${domain ? domain.state.replace(/_/g, ' ') : 'not in the account'}: a person checks` });
      }
      case 'start_site_setup': {
        if (!this.o.provesAbsence) return answered({ found: false, proven: false, how: 'a site setup on a free subdomain cannot be found by what it asked for, and the provider keeps no client reference for it: a person checks the account\'s websites' });
        const l = await this.listRead(`/sim/v1/sites/setups?client_reference=${encodeURIComponent(c.client_reference)}`, 'setups');
        if (l.kind !== 'answered') return l;
        const list = l.value;
        const view = list.length === 1 ? parseSetup(list[0]) : null;
        if (view) return answered({ found: true, answer: { op: 'start_site_setup', setup: view }, how: `the provider found the setup by its client reference (${view.setup_id})` });
        if (list.length === 0) return answered({ found: false, proven: true, how: 'the provider keeps the client reference of every setup, and none has this one' });
        return answered({ found: false, proven: false, how: 'more than one setup has this client reference: a person checks' });
      }
      case 'link_domain':
      case 'delete_site': {
        const r = await this.readAny({ read: 'site', site_id: c.site_id });
        if (r.kind !== 'answered') return r;
        const site = (r.value as Extract<ReadAnswer, { read: 'site' }>).site;
        if (c.op === 'link_domain') {
          if (!site) return answered({ found: false, proven: false, how: 'the website could not be found: a person checks' });
          if (site.domains.includes(c.domain)) return answered({ found: true, answer: { op: 'link_domain', site }, how: `the website lists ${c.domain}` });
          return answered({ found: false, proven: true, how: `the website does not list ${c.domain}: the link did not take effect` });
        }
        if (!site || site.state === 'deleting' || site.state === 'deleted') {
          return answered({ found: true, answer: { op: 'delete_site', site: site ?? { site_id: c.site_id, state: 'deleted', hostname: null, domains: [] } }, how: site ? `the website is ${site.state}` : 'the website is gone' });
        }
        return answered({ found: false, proven: true, how: 'the website is still active: the deletion did not take effect' });
      }
      case 'start_certificate': {
        const r = await this.readAny({ read: 'certificate', site_id: c.site_id, domain: c.domain });
        if (r.kind !== 'answered') return r;
        const cert = (r.value as Extract<ReadAnswer, { read: 'certificate' }>).certificate;
        if (cert.status === 'not_installed') return answered({ found: false, proven: true, how: 'the domain has no certificate and no setup: the request did not take effect' });
        return answered({ found: true, answer: { op: 'start_certificate', certificate: cert }, how: `the certificate is ${cert.status}` });
      }
      case 'start_vps_setup': {
        const l = await this.listRead(`/sim/v1/vps?purchase_reference=${encodeURIComponent(c.purchase_reference)}`, 'vps');
        if (l.kind !== 'answered') return l;
        const list = l.value;
        const view = list.length === 1 ? parseVps(list[0]) : null;
        if (view) return answered({ found: true, answer: { op: 'start_vps_setup', vps: view }, how: `the order has VPS ${view.vps_id}` });
        if (list.length === 0) return answered({ found: false, proven: true, how: 'the provider lists one VPS per order, and this order has none: the setup did not take effect' });
        return answered({ found: false, proven: false, how: 'the order lists more than one VPS: a person checks' });
      }
      case 'deploy_archive':
        return answered({ found: false, proven: false, how: 'a deployment cannot be read back from the provider: a person checks the website' });
    }
  }

  /** A read that answers a list under `key`. */
  private async listRead(path: string, key: string): Promise<ReadOutcome<Array<Record<string, unknown>>>> {
    const r = await this.http('GET', path, null);
    if (r.kind !== 'response') return { kind: 'failed', words: r.words };
    if (r.status === 429) return { kind: 'rate_limited', retry_after_ms: r.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, words: this.words(r) };
    if (r.status !== 200 || !r.json) return { kind: 'failed', words: `The provider answered ${r.status}. ${this.words(r)}`.trim() };
    const list = r.json[key];
    return { kind: 'answered', value: Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : [] };
  }

  /** The provider's own words, redacted, short. */
  private words(r: Extract<HttpResult, { kind: 'response' }>): string {
    const raw = typeof r.json?.error === 'string' ? r.json.error : typeof r.json?.message === 'string' ? r.json.message : r.text;
    return this.o.redactor.redact(String(raw ?? '')).slice(0, 500);
  }

  private http(method: string, path: string, body: Record<string, unknown> | null): Promise<HttpResult> {
    const url = new URL(path, this.o.baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve) => {
      let settled = false;
      let connected = false;
      const finish = (r: HttpResult): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const req = request({
        host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, agent: false,
        headers: {
          Authorization: `Bearer ${this.o.credential}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null = null;
          try { const v = JSON.parse(text) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Record<string, unknown>; } catch { /* not JSON */ }
          finish({ kind: 'response', status: res.statusCode ?? 0, retryAfterMs: retryAfter(res.headers['retry-after']), json, text: text.slice(0, 2000) });
        });
        res.on('error', () => finish({ kind: 'lost', words: 'The provider\'s answer was cut off before it ended.' }));
      });
      req.on('socket', (s) => { s.once('connect', () => { connected = true; }); });
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (!connected) return finish({ kind: 'not_sent', words: `The request was not sent: the connection to the provider could not be made (${err.code ?? 'error'}).` });
        finish({ kind: 'lost', words: `The provider's answer was lost: the connection ended with no answer (${err.code ?? 'error'}).` });
      });
      const timer = setTimeout(() => {
        const words = connected
          ? `The provider's answer was lost: no answer within ${this.o.timeoutMs} ms.`
          : `The request was not sent: the provider could not be reached within ${this.o.timeoutMs} ms.`;
        finish(connected ? { kind: 'lost', words } : { kind: 'not_sent', words });
        req.destroy();
      }, this.o.timeoutMs);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

function answered(f: Finding): ReadOutcome<Finding> { return { kind: 'answered', value: f }; }

function retryAfter(h: string | string[] | undefined): number | null {
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function callRoute(c: ProviderCall): { method: string; path: string; body: Record<string, unknown> | null } {
  const e = encodeURIComponent;
  switch (c.op) {
    case 'purchase':
      // No payment method is named: the provider uses the account's default one.
      return { method: 'POST', path: '/sim/v1/purchases', body: { items: [{ item_id: c.item_id, quantity: 1 }], ...(c.domain ? { domain: c.domain } : {}), client_reference: c.client_reference } };
    case 'complete_domain_registration':
      return { method: 'POST', path: `/sim/v1/domains/${e(c.domain)}/setup`, body: { client_reference: c.client_reference } };
    case 'start_site_setup':
      return { method: 'POST', path: '/sim/v1/sites/setups', body: { client_reference: c.client_reference } };
    case 'link_domain':
      return { method: 'POST', path: `/sim/v1/sites/${e(c.site_id)}/domains`, body: { domain: c.domain, client_reference: c.client_reference } };
    case 'start_certificate':
      return { method: 'POST', path: `/sim/v1/sites/${e(c.site_id)}/domains/${e(c.domain)}/certificate`, body: { client_reference: c.client_reference } };
    case 'start_vps_setup':
      return { method: 'POST', path: '/sim/v1/vps/setups', body: { purchase_reference: c.purchase_reference, client_reference: c.client_reference } };
    case 'delete_site':
      return { method: 'DELETE', path: `/sim/v1/sites/${e(c.site_id)}`, body: null };
    case 'deploy_archive':
      return { method: 'POST', path: `/sim/v1/sites/${e(c.site_id)}/deploy`, body: { archive_sha256: c.archive_sha256, client_reference: c.client_reference } };
  }
}

function readPath(rd: ProviderRead): string {
  const e = encodeURIComponent;
  switch (rd.read) {
    case 'catalog': return '/sim/v1/catalog';
    case 'purchase': return `/sim/v1/purchases/${e(rd.reference)}`;
    case 'domain': return `/sim/v1/domains/${e(rd.domain)}`;
    case 'site_setup': return `/sim/v1/sites/setups/${e(rd.setup_id)}`;
    case 'site': return `/sim/v1/sites/${e(rd.site_id)}`;
    case 'certificate': return `/sim/v1/sites/${e(rd.site_id)}/domains/${e(rd.domain)}/certificate`;
    case 'health': return `/sim/v1/sites/${e(rd.site_id)}/health`;
    case 'vps': return `/sim/v1/vps/${e(rd.vps_id)}`;
  }
}

function emptyRead(rd: ProviderRead): ReadAnswer {
  switch (rd.read) {
    case 'purchase': return { read: 'purchase', purchase: null };
    case 'domain': return { read: 'domain', domain: null };
    case 'site_setup': return { read: 'site_setup', setup: null };
    case 'site': return { read: 'site', site: null };
    case 'vps': return { read: 'vps', vps: null };
    default: throw new Error('not a nullable read');
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function parsePurchase(j: Record<string, unknown>): PurchaseView | null {
  const reference = str(j.id);
  const payment = j.status === 'completed' ? 'paid' : j.status === 'payment_initiated' ? 'processing' : j.status === 'failed' ? 'failed' : null;
  if (!reference || !payment) return null;
  return {
    reference, payment,
    charged_cents: typeof j.total_cents === 'number' ? j.total_cents : null,
    currency: str(j.currency), words: str(j.message),
    registered: typeof j.registered === 'boolean' ? j.registered : null,
    created_at: str(j.created_at),
  };
}

function parseDomain(j: Record<string, unknown>): DomainView | null {
  const domain = str(j.domain);
  const states = ['awaiting_payment', 'awaiting_setup', 'registering', 'registered', 'failed'] as const;
  const state = states.find((s) => s === j.state);
  if (!domain || !state) return null;
  return { domain, state, expires_at: str(j.expires_at), purchase_reference: str(j.purchase_reference), words: str(j.message) };
}

function parseSetup(j: Record<string, unknown>): SiteSetupView | null {
  const setup_id = str(j.setup_uuid);
  const status = j.status === 'running' || j.status === 'completed' || j.status === 'failed' ? j.status : null;
  if (!setup_id || !status) return null;
  return { setup_id, status, site_id: str(j.website_uid), words: str(j.message) };
}

function parseSite(j: Record<string, unknown>): SiteView | null {
  const site_id = str(j.website_uid);
  const state = j.state === 'active' || j.state === 'deleting' || j.state === 'deleted' ? j.state : null;
  if (!site_id || !state) return null;
  return { site_id, state, hostname: str(j.hostname), domains: Array.isArray(j.domains) ? j.domains.filter((d): d is string => typeof d === 'string') : [] };
}

function parseCertificate(j: Record<string, unknown>): CertificateView | null {
  const states = ['not_installed', 'installing', 'active', 'failed', 'expired'] as const;
  const status = states.find((s) => s === j.status);
  return status ? { status, words: str(j.message) } : null;
}

function parseVps(j: Record<string, unknown>): VpsView | null {
  const vps_id = str(j.vps_id);
  const purchase_reference = str(j.purchase_reference);
  const states = ['installing', 'running', 'stopped', 'error'] as const;
  const state = states.find((s) => s === j.state);
  if (!vps_id || !purchase_reference || !state) return null;
  return { vps_id, state, purchase_reference, words: str(j.message) };
}

function parseHealth(j: Record<string, unknown>): HealthView | null {
  if (typeof j.answers !== 'boolean') return null;
  return { answers: j.answers, http_status: typeof j.http_status === 'number' ? j.http_status : null, words: str(j.message) ?? '' };
}

function parseCatalog(j: Record<string, unknown>): CatalogItem[] | null {
  if (!Array.isArray(j.items)) return null;
  const kinds: Record<string, CatalogItem['kind']> = { DOMAIN: 'domain', VPS: 'vps', HOSTING: 'site' };
  const out: CatalogItem[] = [];
  for (const raw of j.items as Array<Record<string, unknown>>) {
    const kind = kinds[String(raw.category)];
    if (!kind || typeof raw.id !== 'string' || typeof raw.price_cents !== 'number') continue;
    out.push({ item_id: raw.id, kind, name: String(raw.name ?? raw.id), price_cents: raw.price_cents, currency: String(raw.currency ?? 'USD'), period: String(raw.period ?? '') });
  }
  return out;
}

function parseCallAnswer(c: ProviderCall, j: Record<string, unknown>): CallAnswer | null {
  switch (c.op) {
    case 'purchase': { const v = parsePurchase(j); return v ? { op: 'purchase', purchase: v } : null; }
    case 'complete_domain_registration': { const v = parseDomain(j); return v ? { op: 'complete_domain_registration', domain: v } : null; }
    case 'start_site_setup': { const v = parseSetup(j); return v ? { op: 'start_site_setup', setup: v } : null; }
    case 'link_domain': { const v = parseSite(j); return v ? { op: 'link_domain', site: v } : null; }
    case 'start_certificate': { const v = parseCertificate(j); return v ? { op: 'start_certificate', certificate: v } : null; }
    case 'start_vps_setup': { const v = parseVps(j); return v ? { op: 'start_vps_setup', vps: v } : null; }
    case 'delete_site': { const v = parseSite(j); return v ? { op: 'delete_site', site: v } : null; }
    case 'deploy_archive': {
      const site_id = str(j.site_id); const archive = str(j.archive_sha256);
      return site_id && archive ? { op: 'deploy_archive', site_id, archive_sha256: archive, words: str(j.message) ?? '' } : null;
    }
  }
}

function parseRead(rd: ProviderRead, j: Record<string, unknown>): ReadAnswer | null {
  switch (rd.read) {
    case 'catalog': { const items = parseCatalog(j); return items ? { read: 'catalog', items, source: 'the simulated provider\'s catalog (simulated prices, no real provider\'s)' } : null; }
    case 'purchase': { const v = parsePurchase(j); return v ? { read: 'purchase', purchase: v } : null; }
    case 'domain': { const v = parseDomain(j); return v ? { read: 'domain', domain: v } : null; }
    case 'site_setup': { const v = parseSetup(j); return v ? { read: 'site_setup', setup: v } : null; }
    case 'site': { const v = parseSite(j); return v ? { read: 'site', site: v } : null; }
    case 'certificate': { const v = parseCertificate(j); return v ? { read: 'certificate', certificate: v } : null; }
    case 'health': { const v = parseHealth(j); return v ? { read: 'health', health: v } : null; }
    case 'vps': { const v = parseVps(j); return v ? { read: 'vps', vps: v } : null; }
  }
}
