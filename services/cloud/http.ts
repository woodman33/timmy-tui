/**
 * Timmy Cloud's backend: the HTTP API (node:http, bound to 127.0.0.1 in this slice).
 *
 * Customer routes take a customer's token and see only that customer's orders and resources; another customer's id
 * answers exactly as a missing one does. Operator routes take the operator's token. Every answer is JSON, passes the
 * redactor (the agency credential never leaves), and an error is a sentence: never a path, never a stack.
 *
 *   GET  /v1/resources                          the customer's resources
 *   GET  /v1/orders                             the customer's orders
 *   POST /v1/orders            (Idempotency-Key) a new order: {kind, item_id, domain}
 *   GET  /v1/orders/:id                         one of the customer's orders
 *   POST /v1/orders/:id/cancel                  cancel (before submission) or ask to cancel (after)
 *
 *   GET  /v1/operator/overview                  counts by step and state, spend against limits, what needs a person
 *   GET  /v1/operator/orders/:id                any order
 *   POST /v1/operator/orders/:id/approve        approve an order waiting for the operator
 *   POST /v1/operator/orders/:id/reconcile      read the provider for one order now
 *   POST /v1/operator/orders/:id/resolve        a person's decision: happened, did_not_happen, continue, stop, retry
 *   POST /v1/operator/reconcile                 read the provider for everything unfinished
 *   POST /v1/operator/customers                 a new customer: {limits, subscription}; its token is shown once
 *   PUT  /v1/operator/customers/:id/limits      the customer's limits
 *   POST /v1/operator/billing-notices           billing says: {notice_id, customer_id, state}
 *   POST /v1/operator/provider-notices          the provider says something changed: {notice_id, reference}
 *   POST /v1/operator/retention/:id/decide      exported, transfer_to_customer, renew, let_lapse
 *   POST /v1/operator/deletions                 ask to delete a resource: {resource_id, reason}
 *   POST /v1/operator/deletions/:id/decide      approve (naming the resource again) or refuse
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CloudError, NO_SUCH_ORDER, type CloudEngine } from './engine.js';
import type { Redactor } from './redaction.js';

const BODY_LIMIT = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

type Who = { role: 'customer'; customer_id: string } | { role: 'operator' };
interface Reply { status: number; body: unknown; headers?: Record<string, string> }

export class CloudHttpServer {
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly engine: CloudEngine, private readonly redactor: Redactor) {}

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  start(port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
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
    if (!server) return Promise.resolve();
    return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private send(res: ServerResponse, reply: Reply): void {
    if (res.headersSent || res.destroyed) return;
    const text = this.redactor.redact(JSON.stringify(reply.body));
    res.statusCode = reply.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
    res.end(text);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.send(res, await this.route(req));
    } catch (e) {
      if (e instanceof CloudError) return this.send(res, { status: e.status, body: { error: e.message } });
      this.engine.logLine(`request failed inside the backend: ${(e as Error)?.message ?? String(e)}`);
      this.send(res, { status: 500, body: { error: 'The backend could not finish this request. Whatever it recorded before that is in the orders\' steps.' } });
    }
  }

  private async route(req: IncomingMessage): Promise<Reply> {
    // DNS rebinding: a page that resolved another name to 127.0.0.1 still sends its own Host.
    if (req.headers.host !== `127.0.0.1:${this.port}`) return { status: 403, body: { error: 'Refused: this backend answers only to 127.0.0.1 with its own port.' } };
    if (req.headers.origin !== undefined) return { status: 403, body: { error: 'Refused: a request from a web page. This API is for programs, not browsers.' } };
    const method = req.method ?? 'GET';
    const parts = (req.url ?? '/').split('?')[0].split('/').filter(Boolean);
    if (parts[0] !== 'v1') return notFound();
    const p = parts.slice(1);

    if (p[0] === 'operator') {
      const route = operatorRoute(method, p.slice(1));
      if (!route) return notFound();
      if (route === 'method') return { status: 405, body: { error: 'That method is not allowed here.' } };
      if (!this.who(req, 'operator')) return unauthorized('This route needs the operator\'s token.');
      const body = await readBody(req, route.body);
      return this.operator(route.name, route.id, body);
    }

    const route = customerRoute(method, p);
    if (!route) return notFound();
    if (route === 'method') return { status: 405, body: { error: 'That method is not allowed here.' } };
    const who = this.who(req, 'customer');
    if (!who || who.role !== 'customer') return unauthorized('This route needs a customer\'s token.');
    const body = await readBody(req, route.body);
    const c = who.customer_id;
    switch (route.name) {
      case 'resources': return ok({ resources: this.engine.listResources(c) });
      case 'orders': return ok({ orders: this.engine.listOrders(c) });
      case 'order': return ok({ order: this.engine.getOrder(c, route.id!) });
      case 'create': {
        const key = header(req, 'idempotency-key');
        const r = await this.engine.createOrder(c, key, body);
        return { status: r.created ? 201 : 200, body: r };
      }
      case 'cancel': return ok(await this.engine.cancelOrder(c, route.id!));
    }
    return notFound();
  }

  private async operator(name: string, id: string | null, body: unknown): Promise<Reply> {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    switch (name) {
      case 'overview': return ok(this.engine.overview());
      case 'order': return ok({ order: this.engine.operatorOrder(id!) });
      case 'approve': return ok(await this.engine.approve(id!));
      case 'reconcile-order': return ok({ order: await this.engine.reconcileOrder(id!) });
      case 'resolve': return ok({ order: await this.engine.resolve(id!, b) });
      case 'reconcile': return ok(await this.engine.reconcileAll());
      case 'customers': {
        const r = await this.engine.createCustomer(b);
        return { status: 201, body: { ...r, token_note: 'The token is shown this once: the backend keeps only its sha256.' } };
      }
      case 'limits': return ok({ customer: await this.engine.setLimits(id!, b.limits ?? b) });
      case 'billing': return ok(await this.engine.billingNotice(b));
      case 'provider': return ok(await this.engine.providerNotice(b));
      case 'retention': return ok(await this.engine.decideRetention(id!, b));
      case 'deletions': return { status: 201, body: await this.engine.requestDeletion(b) };
      case 'deletion-decide': return ok(await this.engine.decideDeletion(id!, b));
    }
    return notFound();
  }

  private who(req: IncomingMessage, want: 'customer' | 'operator'): Who | null {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? h.match(/^Bearer ([\x21-\x7E]{1,512})$/) : null;
    if (!m) return null;
    if (want === 'operator') return this.engine.isOperatorToken(m[1]) ? { role: 'operator' } : null;
    const customer = this.engine.customerForToken(m[1]);
    return customer ? { role: 'customer', customer_id: customer } : null;
  }
}

function ok(body: unknown): Reply { return { status: 200, body }; }
function notFound(): Reply { return { status: 404, body: { error: 'No such route.' } }; }
function unauthorized(words: string): Reply { return { status: 401, body: { error: words }, headers: { 'WWW-Authenticate': 'Bearer' } }; }

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' ? v : null;
}

/** Customer routes: a name, the order id in the path (an id that cannot exist reads as a missing order), whether a body is read. */
function customerRoute(method: string, p: string[]): { name: string; id: string | null; body: boolean } | 'method' | null {
  if (p.length === 1 && p[0] === 'resources') return method === 'GET' ? { name: 'resources', id: null, body: false } : 'method';
  if (p.length === 1 && p[0] === 'orders') {
    if (method === 'GET') return { name: 'orders', id: null, body: false };
    if (method === 'POST') return { name: 'create', id: null, body: true };
    return 'method';
  }
  if (p.length === 2 && p[0] === 'orders') {
    if (method !== 'GET') return 'method';
    return { name: 'order', id: orderId(p[1]), body: false };
  }
  if (p.length === 3 && p[0] === 'orders' && p[2] === 'cancel') {
    if (method !== 'POST') return 'method';
    return { name: 'cancel', id: orderId(p[1]), body: false };
  }
  return null;
}

/** An id that is not even well formed is answered as a missing order, like any other unknown id. */
function orderId(raw: string): string {
  let id: string;
  try { id = decodeURIComponent(raw); } catch { throw new CloudError(404, NO_SUCH_ORDER); }
  if (!ID.test(id)) throw new CloudError(404, NO_SUCH_ORDER);
  return id;
}

function operatorRoute(method: string, p: string[]): { name: string; id: string | null; body: boolean } | 'method' | null {
  const is = (m: string, name: string, id: string | null = null, body = true): { name: string; id: string | null; body: boolean } | 'method' => (method === m ? { name, id, body } : 'method');
  const id = (raw: string): string => { if (!ID.test(raw)) throw new CloudError(404, 'No such item.'); return raw; };
  if (p.length === 1 && p[0] === 'overview') return is('GET', 'overview', null, false);
  if (p.length === 1 && p[0] === 'reconcile') return is('POST', 'reconcile', null, false);
  if (p.length === 1 && p[0] === 'customers') return is('POST', 'customers');
  if (p.length === 1 && p[0] === 'billing-notices') return is('POST', 'billing');
  if (p.length === 1 && p[0] === 'provider-notices') return is('POST', 'provider');
  if (p.length === 1 && p[0] === 'deletions') return is('POST', 'deletions');
  if (p.length === 2 && p[0] === 'orders') return is('GET', 'order', orderId(p[1]), false);
  if (p.length === 3 && p[0] === 'orders' && p[2] === 'approve') return is('POST', 'approve', orderId(p[1]), false);
  if (p.length === 3 && p[0] === 'orders' && p[2] === 'reconcile') return is('POST', 'reconcile-order', orderId(p[1]), false);
  if (p.length === 3 && p[0] === 'orders' && p[2] === 'resolve') return is('POST', 'resolve', orderId(p[1]));
  if (p.length === 3 && p[0] === 'customers' && p[2] === 'limits') return is('PUT', 'limits', id(p[1]));
  if (p.length === 3 && p[0] === 'retention' && p[2] === 'decide') return is('POST', 'retention', id(p[1]));
  if (p.length === 3 && p[0] === 'deletions' && p[2] === 'decide') return is('POST', 'deletion-decide', id(p[1]));
  return null;
}

/** Reads a JSON body (at most 64 KB) when the route takes one; an empty body is {}. */
function readBody(req: IncomingMessage, wanted: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT && !refused) { refused = true; reject(new CloudError(413, `Refused: a request body is at most ${BODY_LIMIT} bytes.`)); }
      if (!refused) chunks.push(c);
    });
    req.on('end', () => {
      if (refused) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!wanted || text.trim() === '') return resolve({});
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') return reject(new CloudError(415, 'Refused: send the body as application/json.'));
      try { resolve(JSON.parse(text)); } catch { reject(new CloudError(400, 'Refused: the body is not valid JSON.')); }
    });
    req.on('error', () => { if (!refused) reject(new CloudError(400, 'Refused: the request body could not be read.')); });
  });
}
