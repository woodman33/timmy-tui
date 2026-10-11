/**
 * Timmy Cloud's backend: the engine.
 *
 * It owns the state (rebuilt from the event log at start) and is the only writer of the log. Its rules:
 *
 * - Write ahead. Before any provider call that changes something, the call is recorded (a `call.intent` event, fsynced);
 *   its answer is recorded after. A call whose answer is lost (a timeout, a reset, the backend stopped during the call)
 *   leaves its steps `unknown`: never failed, never sent again blindly.
 * - Reconcile. An unknown step is settled only by reading the provider (by the reference it returned, or by what the call
 *   asked for). Proven not to have happened: it may be sent again. Found: the step moves on. Neither: it waits for a
 *   person, with what is known. A purchase is never sent twice on a guess.
 * - Limits. Every order is quoted from the provider's catalog and checked against the customer's per-order and monthly
 *   limits; it is approved automatically only at or under the customer's automatic threshold (0 by default: never), and
 *   otherwise waits for the operator. No purchase is sent while the Pro subscription is not active.
 * - Cancellation says exactly what happened: before submission it is cancelled here; after it, the provider operation is
 *   not cancelled (there is no cancel operation), the order makes no new call and keeps being reconciled.
 * - Cancelling Pro retains everything (nothing deleted, no provider delete call) and opens work for the operator: export
 *   each site and VPS, decide each domain. A deletion is a separate request a person approves.
 * - The agency credential never enters an event, a response or a log line: everything written passes the redactor.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CallAnswer, CallOutcome, CloudProvider, Finding, ProviderCall,
} from './provider.js';
import type {
  CallRecord, CloudEvent, CloudEventBody, CloudState, Customer, DeletionRequest, Limits, Order, OrderKind, OrderRequest,
  Quote, Resource, RetentionDecision, RetentionItem, Step, StepChange, StepName, SubscriptionState,
} from './types.js';
import { ORDER_KINDS, RETENTION_DECISIONS, STEP_NAMES, SUBSCRIPTION_STATES } from './types.js';
import { applyEvent, rebuild } from './reducer.js';
import { DataFolderError, EventLog, type UnreadableLine } from './event-log.js';
import type { Failpoints } from './failpoints.js';
import { newToken, sha256Hex, tokenMatches, type Redactor } from './redaction.js';
import { approvedInMonth, buildOverview, monthOf, orderView, resourceView, usd, type Overview, type OrderView, type ResourceView } from './views.js';

/** A refusal or an error, in words, with an HTTP status. Never a path or a stack. */
export class CloudError extends Error {
  constructor(readonly status: number, words: string) { super(words); }
}

export const NO_SUCH_ORDER = 'No such order.';

export interface EngineOptions {
  dataDir: string;
  provider: CloudProvider;
  redactor: Redactor;
  operatorTokenSha256: string;
  /** Days a cancelled customer's resources are retained before anything may be deleted (by a person's approval). Default 30. */
  retentionDays?: number;
  clock?: () => Date;
  failpoints?: Failpoints | null;
  /** Also write log lines to stderr. */
  logToStderr?: boolean;
  /** The least time between two reads of the same thing in progress, when nobody asked for a reconcile. Default 10 s. */
  pollIntervalMs?: number;
}

const RETRY_NOT_SENT_MS = 5000;
const READ_BACKOFF_MS = 2000;
const MAX_STEPS_PER_ADVANCE = 16;

const TERMINAL = new Set(['quoted', 'approved', 'refused', 'paid', 'failed', 'accepted', 'completed', 'active', 'ok', 'failing', 'not_needed', 'cancelled', 'stopped']);

export class CloudEngine {
  readonly state: CloudState;
  readonly unreadable: UnreadableLine[];
  private readonly log: EventLog;
  private readonly clock: () => Date;
  private readonly retentionDays: number;
  private readonly logFd: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** The provider's shared rate limit: nothing is sent or read before this (ms since the epoch). */
  private pausedUntil = 0;
  /** Reads that failed recently, by order and step: not read again before this. */
  private readonly readBackoff = new Map<string, number>();
  /** When each thing in progress was last read, by order and step. */
  private readonly lastRead = new Map<string, number>();
  /** Orders whose domain's registration end was read (once per process). */
  private readonly endRead = new Set<string>();
  private ticker: NodeJS.Timeout | null = null;
  private tickRunning = false;

  private constructor(private readonly o: EngineOptions, log: EventLog, state: CloudState, unreadable: UnreadableLine[]) {
    this.log = log;
    this.state = state;
    this.unreadable = unreadable;
    this.clock = o.clock ?? (() => new Date());
    this.retentionDays = o.retentionDays ?? 30;
    this.logFd = openSync(join(o.dataDir, 'backend.log'), 'a', 0o600);
  }

  /** Opens the data folder, rebuilds the state from its log, and settles calls the last process left out. */
  static open(o: EngineOptions): CloudEngine {
    const { log, contents } = EventLog.open(o.dataDir, o.failpoints ?? null);
    const engine = new CloudEngine(o, log, rebuild(contents.events), contents.unreadable);
    engine.restorePause();
    engine.logLine(`started: ${contents.events.length} events read, ${contents.unreadable.length} unreadable lines; provider: ${o.provider.info.name}${o.provider.info.simulated ? ' (simulated)' : ''}`);
    engine.interruptLeftCalls();
    engine.retainLate();
    return engine;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Plumbing: events, the one-at-a-time queue, the clock, the log, the ticker
  // ---------------------------------------------------------------------------------------------------------------

  private nowIso(): string { return this.clock().toISOString(); }

  /** Writes one event (redacted, then fsynced) and applies it. An event that could not be written is not applied. */
  private emit(body: CloudEventBody, id?: string): CloudEvent {
    const event = this.o.redactor.redactDeep({ v: 1, id: id ?? randomUUID(), at: this.nowIso(), ...body } as CloudEvent);
    try {
      this.log.append(event);
    } catch (e) {
      if (e instanceof DataFolderError) {
        this.logLine(`the event log: ${e.message}`);
        throw new CloudError(503, `${e.message} This change was not recorded; what was recorded before it stands.`);
      }
      throw e;
    }
    applyEvent(this.state, event);
    return event;
  }

  /** Every change runs alone, in arrival order. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  logLine(text: string): void {
    const line = `${this.nowIso()} ${this.o.redactor.redact(text)}\n`;
    try { writeSync(this.logFd, line); } catch { /* the log line is lost, the state is not */ }
    if (this.o.logToStderr) process.stderr.write(line);
  }

  /** Runs the backend by itself every `ms` (0: never; tests drive it through reconcile). */
  startTicker(ms: number): void {
    if (ms <= 0 || this.ticker) return;
    this.ticker = setInterval(() => {
      if (this.tickRunning) return;
      this.tickRunning = true;
      void this.exclusive(() => this.advanceAll(false)).catch((e: unknown) => this.logLine(`tick: ${(e as Error).message}`)).finally(() => { this.tickRunning = false; });
    }, ms);
    this.ticker.unref();
  }

  close(): void {
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    this.log.close();
    try { fsyncSync(this.logFd); closeSync(this.logFd); } catch { /* already closed */ }
  }

  /** Waits until every change queued so far has finished. */
  idle(): Promise<void> { return this.queue.then(() => undefined); }

  // ---------------------------------------------------------------------------------------------------------------
  // The shared rate limit
  // ---------------------------------------------------------------------------------------------------------------

  private paused(): boolean { return Date.now() < this.pausedUntil; }

  private pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    this.logLine(`the provider's rate limit: nothing sent or read before ${new Date(this.pausedUntil).toISOString()}`);
  }

  /** After a restart, the latest Retry-After recorded on any step still holds. */
  private restorePause(): void {
    const steps: Step[] = [];
    for (const o of Object.values(this.state.orders)) for (const n of STEP_NAMES) steps.push(o.steps[n]);
    for (const d of Object.values(this.state.deletions)) steps.push(d.step);
    for (const s of steps) {
      if (s.retry_at && s.words.startsWith('The provider\'s rate limit')) this.pausedUntil = Math.max(this.pausedUntil, Date.parse(s.retry_at));
    }
  }

  get pausedUntilIso(): string | null { return this.paused() ? new Date(this.pausedUntil).toISOString() : null; }

  // ---------------------------------------------------------------------------------------------------------------
  // Authentication: tokens are compared by their sha256 only
  // ---------------------------------------------------------------------------------------------------------------

  customerForToken(token: string): string | null {
    let found: string | null = null;
    for (const c of Object.values(this.state.customers)) if (tokenMatches(token, c.token_sha256)) found = c.customer_id;
    return found;
  }

  isOperatorToken(token: string): boolean { return tokenMatches(token, this.o.operatorTokenSha256); }

  // ---------------------------------------------------------------------------------------------------------------
  // Customers and billing
  // ---------------------------------------------------------------------------------------------------------------

  createCustomer(input: { limits?: unknown; subscription?: unknown }): Promise<{ customer_id: string; token: string; customer: Omit<Customer, 'token_sha256'> }> {
    return this.exclusive(async () => {
      const limits = parseLimits(input.limits);
      const subscription = parseSubscription(input.subscription);
      const token = newToken();
      const at = this.nowIso();
      const customer: Customer = {
        customer_id: `cus_${randomUUID()}`, token_sha256: sha256Hex(token), created_at: at,
        subscription: { state: subscription, since: at, source: 'given by billing when the operator created the customer' }, limits,
      };
      this.emit({ type: 'customer.created', customer });
      this.logLine(`customer ${customer.customer_id} created (subscription ${subscription})`);
      const { token_sha256: _hash, ...shown } = customer;
      return { customer_id: customer.customer_id, token, customer: shown };
    });
  }

  setLimits(customerId: string, input: unknown): Promise<Omit<Customer, 'token_sha256'>> {
    return this.exclusive(async () => {
      const c = this.state.customers[customerId];
      if (!c) throw new CloudError(404, 'No such customer.');
      const limits = parseLimits(input);
      this.emit({ type: 'customer.limits', customer_id: customerId, limits });
      const { token_sha256: _hash, ...shown } = this.state.customers[customerId];
      return shown;
    });
  }

  /**
   * A notice from billing: the customer's Pro subscription is active, past_due or canceled. The same notice id twice
   * changes nothing. Cancelled: every resource is retained (nothing deleted, no provider call) and the operator gets an
   * item for each: export each site and VPS, decide each domain. Active again: retention ends.
   */
  billingNotice(input: { notice_id?: unknown; customer_id?: unknown; state?: unknown }): Promise<{ duplicate: boolean; subscription: Customer['subscription']; retained: ResourceView[]; opened: RetentionItem[] }> {
    return this.exclusive(async () => {
      const noticeId = idText(input.notice_id, 'notice_id');
      const customerId = idText(input.customer_id, 'customer_id');
      const state = parseSubscription(input.state);
      const c = this.state.customers[customerId];
      if (!c) throw new CloudError(404, 'No such customer.');
      const key = `billing:${noticeId}`;
      if (this.state.notices[key]) return { duplicate: true, subscription: c.subscription, retained: [], opened: [] };
      const at = this.nowIso();
      const resources: Resource[] = [];
      const retention: RetentionItem[] = [];
      const closed: Array<{ item_id: string; words: string }> = [];
      const own = Object.values(this.state.resources).filter((r) => r.customer_id === customerId);
      if (state === 'canceled' && c.subscription.state !== 'canceled') {
        const until = new Date(this.clock().getTime() + this.retentionDays * 86_400_000).toISOString();
        for (const r of own.filter((x) => x.state === 'active')) {
          resources.push({ ...r, state: 'retained', retained: { since: at, until, words: `Retained: Timmy Pro was cancelled. Nothing is deleted, not on ${until} either, without a deletion a person approves.` } });
          if (r.kind === 'site' || r.kind === 'vps') retention.push(this.item(r, 'export', at, until));
          if (r.kind === 'domain') retention.push(this.item(r, 'domain_decision', at, until));
        }
      }
      if (state === 'active' && c.subscription.state === 'canceled') {
        for (const r of own.filter((x) => x.state === 'retained')) resources.push({ ...r, state: 'active', retained: null });
        for (const item of Object.values(this.state.retention)) {
          if (item.customer_id === customerId && !item.closed) closed.push({ item_id: item.item_id, words: 'Timmy Pro is active again: nothing needs exporting or deciding.' });
        }
      }
      this.emit({ type: 'billing.notice', notice_id: key, customer_id: customerId, state, resources, retention, closed_items: closed }, `billing.notice:${noticeId}`);
      this.logLine(`billing notice ${noticeId}: customer ${customerId} is ${state}; ${resources.length} resources changed, ${retention.length} items opened`);
      return { duplicate: false, subscription: this.state.customers[customerId].subscription, retained: resources.filter((r) => r.state === 'retained').map(resourceView), opened: retention };
    });
  }

  private item(r: Resource, kind: RetentionItem['kind'], at: string, until: string): RetentionItem {
    return { item_id: `ret_${randomUUID()}`, customer_id: r.customer_id, resource_id: r.resource_id, kind, opened_at: at, until, expires_at: r.expires_at, decision: null, closed: null };
  }

  /**
   * A resource that appeared after its customer's Pro was cancelled (a purchase already submitted cannot be cancelled
   * and settles later) is retained like the others, with its item for the operator. Run after every change and at start,
   * so a crash between the resource's event and this one is settled at the next start.
   */
  private retainLate(): void {
    for (const c of Object.values(this.state.customers)) {
      if (c.subscription.state !== 'canceled') continue;
      const late = Object.values(this.state.resources).filter((r) => r.customer_id === c.customer_id && r.state === 'active');
      if (!late.length) continue;
      const at = this.nowIso();
      const until = new Date(this.clock().getTime() + this.retentionDays * 86_400_000).toISOString();
      const resources = late.map((r) => ({ ...r, state: 'retained' as const, retained: { since: at, until, words: `Retained: it appeared after Timmy Pro was cancelled (a submitted operation cannot be cancelled). Nothing is deleted without a deletion a person approves.` } }));
      const retention = late.filter((r) => r.kind !== 'certificate').map((r) => this.item(r, r.kind === 'domain' ? 'domain_decision' : 'export', at, until));
      this.emit({ type: 'retention.opened', customer_id: c.customer_id, resources, retention });
      this.logLine(`customer ${c.customer_id}: ${late.length} resource(s) made after cancellation retained`);
    }
  }

  /**
   * A notice from the provider (a webhook relayed by the operator's side): it is recorded and the orders that hold its
   * reference are reconciled by reading the provider; the notice's own words move nothing. The same id twice changes nothing.
   */
  providerNotice(input: { notice_id?: unknown; reference?: unknown }): Promise<{ duplicate: boolean; reconciled: string[] }> {
    return this.exclusive(async () => {
      const noticeId = idText(input.notice_id, 'notice_id');
      const reference = idText(input.reference, 'reference');
      const key = `provider:${noticeId}`;
      if (this.state.notices[key]) return { duplicate: true, reconciled: [] };
      this.emit({ type: 'provider.notice', notice_id: key, reference }, `provider.notice:${noticeId}`);
      const touched = Object.values(this.state.orders).filter((o) => STEP_NAMES.some((n) => o.steps[n].reference === reference)).map((o) => o.order_id);
      for (const id of touched) await this.advance(id, true);
      return { duplicate: false, reconciled: touched };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Customer routes: every one is scoped to the customer; another customer's id reads exactly as a missing one
  // ---------------------------------------------------------------------------------------------------------------

  private ownOrder(customerId: string, orderId: string): Order {
    const o = this.state.orders[orderId];
    if (!o || o.customer_id !== customerId) throw new CloudError(404, NO_SUCH_ORDER);
    return o;
  }

  listOrders(customerId: string): OrderView[] {
    return Object.values(this.state.orders).filter((o) => o.customer_id === customerId).map((o) => orderView(this.state, o));
  }

  getOrder(customerId: string, orderId: string): OrderView {
    return orderView(this.state, this.ownOrder(customerId, orderId));
  }

  listResources(customerId: string): ResourceView[] {
    return Object.values(this.state.resources).filter((r) => r.customer_id === customerId).map(resourceView);
  }

  /** One order per (customer, Idempotency-Key): the same request again returns the same order. */
  createOrder(customerId: string, idempotencyKey: string | null, body: unknown): Promise<{ order: OrderView; created: boolean }> {
    return this.exclusive(async () => {
      const c = this.state.customers[customerId];
      if (!c) throw new CloudError(404, 'No such customer.');
      if (!idempotencyKey || !/^[\x21-\x7E]{1,200}$/.test(idempotencyKey)) {
        throw new CloudError(400, 'An order needs an Idempotency-Key header (1 to 200 printable characters, no spaces): sending the same request with the same key returns the same order. Nothing was created.');
      }
      const request = parseOrderRequest(body);
      const keySha = sha256Hex(idempotencyKey);
      const requestSha = sha256Hex(JSON.stringify([request.kind, request.item_id, request.domain]));
      const existing = this.state.idempotency[`${customerId}:${keySha}`];
      if (existing) {
        const o = this.state.orders[existing];
        if (o.request_sha256 !== requestSha) throw new CloudError(409, 'This Idempotency-Key was already used for a different request: nothing new was created. Use a new key for a new order.');
        return { order: orderView(this.state, o), created: false };
      }
      if (c.subscription.state !== 'active') {
        throw new CloudError(403, `No new purchases: the Timmy Pro subscription is ${c.subscription.state.replace('_', ' ')}. Nothing was created.`);
      }
      if (request.kind === 'site' && request.domain) {
        const owned = Object.values(this.state.resources).some((r) => r.customer_id === customerId && r.kind === 'domain' && r.provider_ref === request.domain && r.state === 'active');
        if (!owned) throw new CloudError(422, 'No such domain among your resources: a site links only a domain registered for you through Timmy Cloud. Nothing was created.');
      }
      const at = this.nowIso();
      const order = newOrder(customerId, request, requestSha, keySha, at);
      this.emit({ type: 'order.created', order }, `order.created:${sha256Hex(`${customerId}:${keySha}`)}`);
      this.logLine(`order ${order.order_id} created for ${customerId}: ${request.kind} ${request.item_id}${request.domain ? ` ${request.domain}` : ''}`);
      await this.advance(order.order_id, false);
      return { order: orderView(this.state, this.state.orders[order.order_id]), created: true };
    });
  }

  /** Before submission: cancelled here. After: "cancel asked", the provider operation not cancelled, reconcile goes on. */
  cancelOrder(customerId: string, orderId: string): Promise<{ order: OrderView; cancelled_here: boolean; words: string }> {
    return this.exclusive(async () => {
      const o = this.ownOrder(customerId, orderId);
      if (o.cancel) return { order: orderView(this.state, o), cancelled_here: o.cancel.before_submission, words: `Already asked: ${o.cancel.words}` };
      if (STEP_NAMES.every((n) => TERMINAL.has(o.steps[n].state)) && !STEP_NAMES.some((n) => o.steps[n].state === 'not_started')) {
        throw new CloudError(409, 'Nothing to cancel: this order has ended. Removing what it made is a separate deletion, which a person approves.');
      }
      if (!o.submitted_at) {
        const words = 'Cancelled here, before anything was sent to the provider: nothing was bought or set up.';
        // What has not happened is cancelled; what has (a quote, an approval) stays as it was.
        const steps = STEP_NAMES.filter((n) => ['not_started', 'waiting'].includes(o.steps[n].state) || (n === 'quote' && o.steps.quote.state === 'pending'))
          .map((n) => change(o, n, { state: 'cancelled', at: this.nowIso(), words }));
        this.emit({ type: 'order.cancel', order_id: o.order_id, before_submission: true, words, steps });
        this.logLine(`order ${o.order_id} cancelled before submission`);
        return { order: orderView(this.state, this.state.orders[o.order_id]), cancelled_here: true, words };
      }
      const words = 'Cancel asked. The provider has no operation that cancels a purchase or a setup, so the provider operation was NOT cancelled: what it does still happens and may still be charged. Nothing new is sent for this order; it is still reconciled, and a person decides what to do with what the provider did.';
      this.emit({ type: 'order.cancel', order_id: o.order_id, before_submission: false, words, steps: [] });
      this.logLine(`order ${o.order_id}: cancel asked after submission`);
      await this.advance(o.order_id, true);
      return { order: orderView(this.state, this.state.orders[o.order_id]), cancelled_here: false, words };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Operator routes
  // ---------------------------------------------------------------------------------------------------------------

  private anyOrder(orderId: string): Order {
    const o = this.state.orders[orderId];
    if (!o) throw new CloudError(404, NO_SUCH_ORDER);
    return o;
  }

  operatorOrder(orderId: string): OrderView { return orderView(this.state, this.anyOrder(orderId)); }

  approve(orderId: string): Promise<{ order: OrderView; words: string }> {
    return this.exclusive(async () => {
      const o = this.anyOrder(orderId);
      if (o.steps.approval.state === 'approved') return { order: orderView(this.state, o), words: 'Already approved: nothing changed.' };
      if (o.steps.approval.state !== 'waiting') throw new CloudError(409, `Nothing to approve: the approval step is ${o.steps.approval.state.replace('_', ' ')}.`);
      const c = this.state.customers[o.customer_id];
      const problem = this.limitProblem(c, o);
      if (problem) throw new CloudError(409, `Not approved: ${problem} The order still waits; raise the customer's limits, or the customer cancels.`);
      const at = this.nowIso();
      this.emit({
        type: 'order.approval', order_id: o.order_id, approved_month: monthOf(at),
        steps: [change(o, 'approval', { state: 'approved', at, words: `Approved by the operator (quote ${usd(o.quote!.total_cents)}).` })],
      });
      this.logLine(`order ${o.order_id} approved by the operator`);
      await this.advance(o.order_id, false);
      return { order: orderView(this.state, this.state.orders[o.order_id]), words: 'Approved.' };
    });
  }

  reconcileOrder(orderId: string): Promise<OrderView> {
    return this.exclusive(async () => {
      this.anyOrder(orderId);
      await this.advance(orderId, true);
      return orderView(this.state, this.state.orders[orderId]);
    });
  }

  /** Reconciles every order and deletion that is not finished. */
  reconcileAll(): Promise<{ orders: number; deletions: number }> {
    return this.exclusive(() => this.advanceAll(true));
  }

  /**
   * A person's decision about an order:
   * - "happened" / "did_not_happen": what a person found at the provider for a step whose outcome is unknown;
   * - "continue" / "stop": for an order halted (cancel asked after submission, or stopped); stop keeps what exists;
   * - "retry": a step the provider failed (a site's provisioning, its domain link or certificate, a health check).
   */
  resolve(orderId: string, input: { action?: unknown; step?: unknown; reference?: unknown; note?: unknown }): Promise<OrderView> {
    return this.exclusive(async () => {
      const o = this.anyOrder(orderId);
      const action = String(input.action ?? '');
      const note = noteText(input.note);
      const at = this.nowIso();
      const stepName = input.step === undefined ? null : parseStep(input.step);
      if (action === 'happened' || action === 'did_not_happen') {
        if (!stepName || o.steps[stepName].state !== 'unknown') throw new CloudError(409, 'Name a step whose outcome is unknown (step).');
        const call = this.state.calls[o.steps[stepName].call_id ?? ''];
        if (!call) throw new CloudError(409, 'This step has no recorded call.');
        let steps: StepChange[];
        if (action === 'did_not_happen') {
          steps = call.steps.map((n) => change(o, n, { state: 'not_started', at, words: `A person checked the provider: the call did not take effect (${note}). It may be sent again.` }));
        } else {
          const reference = typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim() : null;
          steps = this.happened(o, call, reference, note, at);
        }
        this.emit({ type: 'person.decided', order_id: o.order_id, action, step: stepName, note, halt: null, steps });
        await this.advance(o.order_id, true);
        return orderView(this.state, this.state.orders[o.order_id]);
      }
      if (action === 'continue') {
        if (!o.halted) throw new CloudError(409, 'This order is not halted: there is nothing to continue.');
        this.emit({ type: 'person.decided', order_id: o.order_id, action, step: null, note, halt: 'clear', steps: [] });
        await this.advance(o.order_id, true);
        return orderView(this.state, this.state.orders[o.order_id]);
      }
      if (action === 'stop') {
        const words = `Stopped by a person (${note}): not started, and never will be. What exists stays; nothing is deleted.`;
        const steps = STEP_NAMES.filter((n) => o.steps[n].state === 'not_started').map((n) => change(o, n, { state: 'stopped', at, words }));
        this.emit({ type: 'person.decided', order_id: o.order_id, action, step: null, note, halt: 'set', steps });
        return orderView(this.state, this.state.orders[o.order_id]);
      }
      if (action === 'retry') {
        const retryable: StepName[] = ['provisioning', 'dns', 'certificate', 'health'];
        if (!stepName || !retryable.includes(stepName)) throw new CloudError(422, 'Retry names one of these steps: provisioning, dns, certificate, health.');
        const s = o.steps[stepName];
        if (s.state !== 'failed' && s.state !== 'failing') throw new CloudError(409, `Only a failed step is retried; ${stepName} is ${s.state.replace('_', ' ')}. An unknown step is settled by reconcile or by "happened" / "did_not_happen".`);
        if (stepName === 'provisioning' && o.request.kind !== 'site') throw new CloudError(422, 'Retrying provisioning is for a site; a domain or VPS order that failed provisioning is a matter for the provider\'s support.');
        const steps: StepChange[] = [];
        const again = (n: StepName): void => { steps.push(change(o, n, { state: 'not_started', at, words: `A person asked for a retry (${note}).` })); };
        if (stepName === 'provisioning') { again('acceptance'); again('provisioning'); for (const n of ['dns', 'certificate', 'health'] as StepName[]) if (o.steps[n].state === 'stopped') again(n); }
        if (stepName === 'dns') { again('dns'); if (o.steps.certificate.state === 'stopped') again('certificate'); if (o.steps.health.state !== 'not_needed') again('health'); }
        if (stepName === 'certificate') { again('certificate'); if (o.steps.health.state !== 'not_needed') again('health'); }
        if (stepName === 'health') again('health');
        this.emit({ type: 'person.decided', order_id: o.order_id, action, step: stepName, note, halt: null, steps });
        await this.advance(o.order_id, true);
        return orderView(this.state, this.state.orders[o.order_id]);
      }
      throw new CloudError(422, 'The action is one of: happened, did_not_happen, continue, stop, retry.');
    });
  }

  /** What a person found: the call took effect, with the provider's reference where the next step needs one. */
  private happened(o: Order, call: CallRecord, reference: string | null, note: string, at: string): StepChange[] {
    const words = `A person checked the provider: the call took effect (${note}).`;
    const need = (what: string): string => { if (!reference) throw new CloudError(422, `Give the provider's reference (${what}) in "reference".`); return reference; };
    const c = call.call;
    switch (c.op) {
      case 'purchase': {
        const ref = need('its order id');
        return [
          change(o, 'acceptance', { state: 'accepted', at, words, reference: ref }),
          change(o, 'payment', { state: 'pending', at, words: `${words} Its payment is read from the provider next.`, reference: ref, charged_cents: null }),
        ];
      }
      case 'start_site_setup': {
        const ref = need('the setup id');
        return [change(o, 'acceptance', { state: 'accepted', at, words, reference: ref }), change(o, 'provisioning', { state: 'pending', at, words, reference: ref })];
      }
      case 'complete_domain_registration':
        return [change(o, 'provisioning', { state: 'pending', at, words, reference: c.domain })];
      case 'start_vps_setup':
        return [change(o, 'provisioning', { state: 'pending', at, words, reference: need('the VPS id') })];
      case 'link_domain':
        return [change(o, 'dns', { state: 'completed', at, words, reference: c.domain })];
      case 'start_certificate':
        return [change(o, 'certificate', { state: 'pending', at, words, reference: c.domain })];
      default:
        throw new CloudError(409, 'This call is not an order step.');
    }
  }

  decideRetention(itemId: string, input: { decision?: unknown; note?: unknown }): Promise<{ item: RetentionItem; words: string }> {
    return this.exclusive(async () => {
      const item = this.state.retention[itemId];
      if (!item) throw new CloudError(404, 'No such retention item.');
      if (item.closed) throw new CloudError(409, `Already closed: ${item.closed.words}`);
      const decision = String(input.decision ?? '') as RetentionDecision;
      if (!RETENTION_DECISIONS.includes(decision)) throw new CloudError(422, `The decision is one of: ${RETENTION_DECISIONS.join(', ')}.`);
      if (item.kind === 'export' && decision !== 'exported') throw new CloudError(422, 'An export item is closed with decision "exported", once the export is done.');
      if (item.kind === 'domain_decision' && decision === 'exported') throw new CloudError(422, 'A domain is decided: transfer_to_customer, renew or let_lapse.');
      const note = noteText(input.note);
      this.emit({ type: 'retention.decided', item_id: itemId, decision, note });
      const r = this.state.resources[item.resource_id];
      const words = decision === 'exported'
        ? 'Recorded: the export was done by a person. Nothing was deleted.'
        : decision === 'let_lapse'
          ? `Recorded: a person decided to let ${r?.name ?? 'the domain'} lapse${item.expires_at ? ` on ${item.expires_at}` : ''}. Nothing was done at the provider.`
          : `Recorded: a person decided to ${decision === 'renew' ? 'renew' : 'transfer to the customer'} ${r?.name ?? 'the domain'}. Nothing was done at the provider: that is a live step the operator carries out (see TIMMY-CLOUD.md).`;
      return { item: this.state.retention[itemId], words };
    });
  }

  requestDeletion(input: { resource_id?: unknown; reason?: unknown }): Promise<{ deletion: DeletionRequest; words: string }> {
    return this.exclusive(async () => {
      const resourceId = idText(input.resource_id, 'resource_id');
      const r = this.state.resources[resourceId];
      if (!r) throw new CloudError(404, 'No such resource.');
      if (r.state === 'deleted' || r.state === 'deleting') throw new CloudError(409, `This ${r.kind} is already ${r.state}.`);
      if (r.kind !== 'site') throw new CloudError(422, `This slice deletes only a site: the provider adapter has no delete operation for a ${r.kind}. Nothing was requested.`);
      const open = Object.values(this.state.deletions).find((d) => d.resource_id === resourceId && (!d.decision || (d.decision.decision === 'approved' && d.step.state !== 'completed')));
      if (open) return { deletion: open, words: 'A deletion of this resource is already asked for.' };
      const reason = noteText(input.reason);
      const deletion: DeletionRequest = {
        deletion_id: `del_${randomUUID()}`, resource_id: resourceId, customer_id: r.customer_id, reason, requested_at: this.nowIso(), decision: null,
        step: { state: 'not_started', at: this.nowIso(), words: 'Waits for a person to approve: a deletion is immediate at the provider and cannot be undone.' },
      };
      this.emit({ type: 'deletion.requested', deletion });
      return { deletion, words: 'Asked. Nothing is deleted until a person approves this request.' };
    });
  }

  decideDeletion(deletionId: string, input: { decision?: unknown; confirm_resource_id?: unknown; note?: unknown }): Promise<{ deletion: DeletionRequest; words: string }> {
    return this.exclusive(async () => {
      const d = this.state.deletions[deletionId];
      if (!d) throw new CloudError(404, 'No such deletion request.');
      if (d.decision) throw new CloudError(409, `Already decided: ${d.decision.decision}.`);
      const decision = String(input.decision ?? '');
      const note = noteText(input.note);
      const at = this.nowIso();
      if (decision === 'refuse') {
        this.emit({ type: 'deletion.decided', deletion_id: deletionId, decision: 'refused', note, steps: [{ deletion_id: deletionId, to: { state: 'not_needed', at, words: `Refused by a person (${note}): nothing was deleted.` } }] });
        return { deletion: this.state.deletions[deletionId], words: 'Refused: nothing was deleted.' };
      }
      if (decision !== 'approve') throw new CloudError(422, 'The decision is "approve" or "refuse".');
      if (input.confirm_resource_id !== d.resource_id) throw new CloudError(422, 'Name the resource being deleted again, exactly, in confirm_resource_id: nothing was deleted.');
      const openExport = Object.values(this.state.retention).find((i) => i.resource_id === d.resource_id && i.kind === 'export' && !i.closed);
      if (openExport) throw new CloudError(409, `Not approved: the customer's export of this site is still open (${openExport.item_id}). Record the export first; nothing was deleted.`);
      this.emit({ type: 'deletion.decided', deletion_id: deletionId, decision: 'approved', note, steps: [{ deletion_id: deletionId, to: { state: 'not_started', at, words: `Approved by a person (${note}); the provider is asked next.` } }] });
      await this.advanceDeletion(deletionId, true);
      return { deletion: this.state.deletions[deletionId], words: this.state.deletions[deletionId].step.words };
    });
  }

  overview(): Overview {
    return buildOverview(this.state, { now: this.clock(), provider: this.o.provider.info, paused_until: this.pausedUntilIso, unreadable: this.unreadable });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Driving orders: one provider interaction at a time, as far as it can go now
  // ---------------------------------------------------------------------------------------------------------------

  private async advanceAll(explicit: boolean): Promise<{ orders: number; deletions: number }> {
    let orders = 0;
    for (const id of Object.keys(this.state.orders)) { await this.advance(id, explicit); orders += 1; }
    let deletions = 0;
    for (const id of Object.keys(this.state.deletions)) { await this.advanceDeletion(id, explicit); deletions += 1; }
    return { orders, deletions };
  }

  private async advance(orderId: string, explicit: boolean): Promise<void> {
    for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i += 1) {
      const progressed = await this.stepOnce(orderId, explicit);
      explicit = false; // what an explicit reconcile re-reads, it re-reads once
      if (!progressed) break;
    }
    this.retainLate();
  }

  /** Does at most one provider interaction for the order; true when it recorded progress that may allow the next at once. */
  private async stepOnce(orderId: string, explicit: boolean): Promise<boolean> {
    const o = this.state.orders[orderId];
    if (!o || o.cancel?.before_submission) return false;
    if (this.paused()) return false;
    const s = o.steps;
    const c = this.state.customers[o.customer_id];

    const unknown = STEP_NAMES.find((n) => s[n].state === 'unknown');
    if (unknown) return this.reconcileUnknown(o, unknown, explicit);
    if (STEP_NAMES.some((n) => s[n].state === 'in_flight')) return false;

    if (s.quote.state === 'pending') return this.quote(o, explicit);
    if (s.quote.state !== 'quoted') return false;
    if (s.approval.state === 'not_started') return this.decideApproval(o);
    if (s.approval.state !== 'approved') return false;

    // Reads of what is in progress at the provider go on even for a halted order.
    if (s.payment.state === 'pending') return this.readPayment(o, explicit);
    if (s.provisioning.state === 'pending') return this.readProvisioning(o, explicit);
    if (s.certificate.state === 'pending') return this.readCertificate(o, explicit);
    if (explicit && s.health.state === 'failing') return this.readHealth(o, true);

    // New calls that change something: never for a halted order, never after Pro was cancelled.
    if (o.halted || c.subscription.state === 'canceled') return false;
    const kind = o.request.kind;
    if (kind === 'domain' || kind === 'vps') {
      if (s.payment.state === 'not_started') {
        if (c.subscription.state !== 'active') return false; // no purchase while past_due
        if (this.waiting(s.payment)) return false;
        return this.callPurchase(o);
      }
      if (s.payment.state !== 'paid') return false;
    }
    if (kind === 'domain') {
      if (s.provisioning.state === 'not_started' && !this.waiting(s.provisioning)) return this.callCompleteRegistration(o);
      if (s.provisioning.state === 'completed') return this.readDomainEnd(o);
      return false;
    }
    if (kind === 'vps') {
      if (s.provisioning.state === 'not_started' && !this.waiting(s.provisioning)) return this.callVpsSetup(o);
      if (s.provisioning.state === 'completed' && s.health.state === 'not_started') return this.readHealth(o, true);
      return false;
    }
    if (s.acceptance.state === 'not_started' && !this.waiting(s.acceptance)) return this.callSiteSetup(o);
    if (s.provisioning.state !== 'completed') return false;
    if (s.dns.state === 'not_started' && !this.waiting(s.dns)) return this.callLinkDomain(o);
    if (s.dns.state === 'completed' && s.certificate.state === 'not_started' && !this.waiting(s.certificate)) return this.callCertificate(o);
    const dnsSettled = ['completed', 'not_needed', 'failed'].includes(s.dns.state);
    const certSettled = ['active', 'not_needed', 'failed', 'stopped'].includes(s.certificate.state);
    if (dnsSettled && certSettled && s.health.state === 'not_started') return this.readHealth(o, true);
    return false;
  }

  /** A step that must wait for its retry time (a Retry-After, or a refused connection). */
  private waiting(step: Step): boolean {
    return !!step.retry_at && Date.parse(step.retry_at) > Date.now();
  }

  private backedOff(key: string): boolean { return (this.readBackoff.get(key) ?? 0) > Date.now(); }
  private backOff(key: string): void { this.readBackoff.set(key, Date.now() + READ_BACKOFF_MS); }

  private async quote(o: Order, explicit: boolean): Promise<boolean> {
    const key = `${o.order_id}:quote`;
    if (this.backedOff(key) && !explicit) return false;
    const r = await this.o.provider.read({ read: 'catalog' });
    if (r.kind === 'rate_limited') { this.pauseFor(r.retry_after_ms); return false; }
    if (r.kind === 'failed') { this.backOff(key); this.logLine(`order ${o.order_id}: the catalog did not answer (${r.words})`); return false; }
    const at = this.nowIso();
    const item = r.value.items.find((i) => i.item_id === o.request.item_id && i.kind === o.request.kind);
    const fail = (words: string): boolean => {
      const steps = [change(o, 'quote', { state: 'failed', at, words }), ...this.stopNotStarted(o, at, 'Not started: the order could not be quoted.', ['quote'])];
      this.emit({ type: 'order.quoted', order_id: o.order_id, quote: null, steps });
      return false;
    };
    if (!item) return fail(`The provider's catalog has no ${o.request.kind} item "${o.request.item_id}".`);
    if (o.request.kind === 'site' && item.price_cents !== 0) return fail('This provider prices a website; this backend sets sites up only on the operator\'s agency plan, with no purchase.');
    const quote: Quote = {
      items: [{ item_id: item.item_id, name: item.name, unit_cents: item.price_cents, quantity: 1, period: item.period }],
      total_cents: item.price_cents, currency: item.currency, source: r.value.source, quoted_at: at,
    };
    const steps: StepChange[] = [change(o, 'quote', { state: 'quoted', at, words: `${usd(quote.total_cents)} ${quote.currency} for ${item.name}, from ${quote.source}.` })];
    if (o.request.kind === 'site') steps.push(change(o, 'payment', { state: 'not_needed', at, words: 'Nothing to pay: a website on the operator\'s agency plan is set up, not bought.' }));
    this.emit({ type: 'order.quoted', order_id: o.order_id, quote, steps });
    return true;
  }

  /** Why an order may not be approved now (subscription, currency, per-order limit, monthly limit), or null. */
  private limitProblem(c: Customer, o: Order): string | null {
    if (!o.quote) return 'it has no quote.';
    if (c.subscription.state !== 'active') return `the Timmy Pro subscription is ${c.subscription.state.replace('_', ' ')}: no new purchases.`;
    if (o.quote.currency !== 'USD') return `the quote is in ${o.quote.currency} and the limits are in USD.`;
    const total = o.quote.total_cents;
    if (total > c.limits.per_order_cents) return `the quote (${usd(total)}) is over the per-order limit (${usd(c.limits.per_order_cents)}).`;
    const month = monthOf(this.nowIso());
    const used = approvedInMonth(this.state, c.customer_id, month);
    if (used + total > c.limits.monthly_cents) return `with ${usd(used)} already approved in ${month}, the quote (${usd(total)}) would pass the monthly limit (${usd(c.limits.monthly_cents)}).`;
    return null;
  }

  private decideApproval(o: Order): boolean {
    const c = this.state.customers[o.customer_id];
    const at = this.nowIso();
    const problem = this.limitProblem(c, o);
    if (problem) {
      const words = `Refused by the customer's limits: ${problem}`;
      this.emit({ type: 'order.approval', order_id: o.order_id, approved_month: null, steps: [change(o, 'approval', { state: 'refused', at, words }), ...this.stopNotStarted(o, at, 'Not started: the order was not approved.', ['approval'])] });
      this.logLine(`order ${o.order_id}: refused by limits`);
      return false;
    }
    const total = o.quote!.total_cents;
    const threshold = c.limits.auto_approve_up_to_cents;
    if (threshold > 0 && total <= threshold) {
      this.emit({ type: 'order.approval', order_id: o.order_id, approved_month: monthOf(at), steps: [change(o, 'approval', { state: 'approved', at, words: `Approved automatically: the quote (${usd(total)}) is within the automatic limit (${usd(threshold)}) and the customer's limits.` })] });
      return true;
    }
    const why = threshold === 0
      ? `Waits for the operator: this customer has no automatic approval (its limit is ${usd(0)}), so every order waits.`
      : `Waits for the operator: the quote (${usd(total)}) is above the automatic limit (${usd(threshold)}).`;
    this.emit({ type: 'order.approval', order_id: o.order_id, approved_month: null, steps: [change(o, 'approval', { state: 'waiting', at, words: why })] });
    return false;
  }

  /** Every step still not started becomes stopped, with words (a failed payment, a failed quote, a refusal). */
  private stopNotStarted(o: Order, at: string, words: string, except: StepName[] = []): StepChange[] {
    return STEP_NAMES.filter((n) => !except.includes(n) && o.steps[n].state === 'not_started').map((n) => change(o, n, { state: 'stopped', at, words }));
  }

  // ---- write ahead, call, record

  /**
   * One provider call that changes something: written ahead, made, then its answer recorded with all of its effects in
   * one event. `steps` are the steps the call writes; `interpret` turns an answered call into step changes and resources.
   */
  private async writeAheadCall(
    target: { order: Order } | { deletion: DeletionRequest },
    steps: StepName[],
    call: ProviderCall,
    interpret: (answer: CallAnswer, at: string) => { steps: StepChange[]; resources: Resource[] },
    refused: (words: string, at: string) => StepChange[],
  ): Promise<boolean> {
    const at = this.nowIso();
    const order = 'order' in target ? target.order : null;
    const deletion = 'deletion' in target ? target.deletion : null;
    const record: CallRecord = {
      call_id: call.client_reference, order_id: order?.order_id ?? null, deletion_id: deletion?.deletion_id ?? null,
      steps, call, intent_at: at, answered_at: null, outcome: null,
    };
    const inflight: Step = { state: 'in_flight', at, words: `Sent to the provider (${call.op.replace(/_/g, ' ')}); waiting for its answer.`, call_id: call.client_reference };
    const toAll = (step: Step): StepChange[] => order ? steps.map((n) => change(order, n, step)) : [{ deletion_id: deletion!.deletion_id, to: step }];
    this.emit({ type: 'call.intent', call: record, steps: toAll(inflight) });
    this.o.failpoints?.crashIfReached('call:after-intent');
    const outcome: CallOutcome = await this.o.provider.call(call);
    this.o.failpoints?.crashIfReached('call:after-answer');
    const done = this.nowIso();
    let changes: StepChange[] = [];
    let resources: Resource[] = [];
    const wait = (ms: number, words: string, reason: string): Step => ({ state: 'not_started', at: done, words: `${reason} ${words}`.trim(), retry_at: new Date(Date.now() + ms).toISOString(), call_id: call.client_reference });
    switch (outcome.kind) {
      case 'answered': ({ steps: changes, resources } = interpret(outcome.answer, done)); break;
      case 'refused': changes = refused(outcome.words, done); break;
      case 'rate_limited':
        this.pauseFor(outcome.retry_after_ms);
        changes = toAll(wait(outcome.retry_after_ms, `(${outcome.words})`, `The provider's rate limit answered 429: nothing was done; nothing is sent to it again before its Retry-After.`));
        break;
      case 'busy':
        changes = toAll(wait(outcome.retry_after_ms, `(${outcome.words})`, 'The provider is busy with the same thing (409): nothing new was done; sent again after its Retry-After.'));
        break;
      case 'not_sent':
        changes = toAll(wait(RETRY_NOT_SENT_MS, outcome.words, 'Not sent:'));
        break;
      case 'unknown': {
        const words = `Unknown: ${outcome.words} The provider may have acted. Nothing is sent again until reconcile reads the provider.`;
        changes = toAll({ state: 'unknown', at: done, words, call_id: call.client_reference });
        if (order && steps.includes('payment')) changes = changes.map((ch) => ('step' in ch && ch.step === 'payment' ? { ...ch, to: { ...ch.to, charged_cents: null } } : ch));
        break;
      }
    }
    this.emit({
      type: 'call.answer', call_id: call.client_reference, outcome: outcome.kind,
      http_status: 'http_status' in outcome ? outcome.http_status : null,
      provider_words: outcome.kind === 'answered' ? null : outcome.words,
      steps: changes, resources,
    });
    this.logLine(`call ${call.op} for ${order ? `order ${order.order_id}` : `deletion ${deletion!.deletion_id}`}: ${outcome.kind}`);
    // An answer or a refusal moved the order and the next step may follow at once. A lost answer waits for the next
    // reconcile (the provider is read, not hurried); a rate limit, a busy provider or a refused connection waits its time.
    return outcome.kind === 'answered' || outcome.kind === 'refused';
  }

  private newCallId(): string { return `call_${randomUUID()}`; }

  private callPurchase(o: Order): Promise<boolean> {
    const kind = o.request.kind as 'domain' | 'vps';
    const call: ProviderCall = { op: 'purchase', client_reference: this.newCallId(), kind, item_id: o.request.item_id, domain: o.request.domain };
    return this.writeAheadCall({ order: o }, ['payment', 'acceptance'], call,
      (a, at) => this.onAnswer(o, call, a, at, ''),
      (words, at) => [
        change(o, 'acceptance', { state: 'refused', at, words: 'The provider refused the order: nothing was bought.', provider_words: words, call_id: call.client_reference }),
        change(o, 'payment', { state: 'stopped', at, words: 'No payment: the provider refused the order before taking one.', call_id: call.client_reference }),
        ...this.stopNotStarted(o, at, 'Not started: the provider refused the order.', ['payment', 'acceptance']),
      ]);
  }

  private callCompleteRegistration(o: Order): Promise<boolean> {
    const call: ProviderCall = { op: 'complete_domain_registration', client_reference: this.newCallId(), domain: o.request.domain! };
    return this.writeAheadCall({ order: o }, ['provisioning'], call, (a, at) => this.onAnswer(o, call, a, at, ''),
      (words, at) => [change(o, 'provisioning', { state: 'failed', at, words: 'The provider refused to register the domain.', provider_words: words, call_id: call.client_reference })]);
  }

  private callVpsSetup(o: Order): Promise<boolean> {
    const call: ProviderCall = { op: 'start_vps_setup', client_reference: this.newCallId(), purchase_reference: o.steps.payment.reference! };
    return this.writeAheadCall({ order: o }, ['provisioning'], call, (a, at) => this.onAnswer(o, call, a, at, ''),
      (words, at) => [change(o, 'provisioning', { state: 'failed', at, words: 'The provider refused to set up the VPS.', provider_words: words, call_id: call.client_reference }), ...this.stopNotStarted(o, at, 'Not started: the VPS was not set up.', ['provisioning'])]);
  }

  private callSiteSetup(o: Order): Promise<boolean> {
    const call: ProviderCall = { op: 'start_site_setup', client_reference: this.newCallId() };
    return this.writeAheadCall({ order: o }, ['acceptance', 'provisioning'], call, (a, at) => this.onAnswer(o, call, a, at, ''),
      (words, at) => [
        change(o, 'acceptance', { state: 'refused', at, words: 'The provider refused to set up the site.', provider_words: words, call_id: call.client_reference }),
        change(o, 'provisioning', { state: 'stopped', at, words: 'Not started: the provider refused the setup.' }),
        ...this.stopNotStarted(o, at, 'Not started: the provider refused the setup.', ['acceptance', 'provisioning']),
      ]);
  }

  private callLinkDomain(o: Order): Promise<boolean> {
    const call: ProviderCall = { op: 'link_domain', client_reference: this.newCallId(), site_id: o.steps.provisioning.reference!, domain: o.request.domain! };
    return this.writeAheadCall({ order: o }, ['dns'], call, (a, at) => this.onAnswer(o, call, a, at, ''),
      (words, at) => [
        change(o, 'dns', { state: 'failed', at, words: `The provider refused to link ${o.request.domain} to the site.`, provider_words: words, call_id: call.client_reference }),
        change(o, 'certificate', { state: 'stopped', at, words: 'Not started: the certificate needs the domain linked first.' }),
      ]);
  }

  private callCertificate(o: Order): Promise<boolean> {
    const call: ProviderCall = { op: 'start_certificate', client_reference: this.newCallId(), site_id: o.steps.provisioning.reference!, domain: o.request.domain! };
    return this.writeAheadCall({ order: o }, ['certificate'], call, (a, at) => this.onAnswer(o, call, a, at, ''),
      (words, at) => [change(o, 'certificate', { state: 'failed', at, words: `The provider refused to start a certificate for ${o.request.domain}.`, provider_words: words, call_id: call.client_reference })]);
  }

  /**
   * What an answer (or a reconcile finding, `prefix` saying so) means for the order. One function for both, so a call
   * found by reconcile moves the order exactly as its answer would have.
   */
  private onAnswer(o: Order, call: ProviderCall, a: CallAnswer, at: string, prefix: string): { steps: StepChange[]; resources: Resource[] } {
    const id = call.client_reference;
    const w = (words: string): string => `${prefix}${words}`;
    switch (a.op) {
      case 'purchase': {
        const p = a.purchase;
        const steps: StepChange[] = [change(o, 'acceptance', { state: 'accepted', at, words: w(`The provider accepted the order (${p.reference}).`), reference: p.reference, call_id: id })];
        if (p.payment === 'failed') {
          steps.push(change(o, 'payment', { state: 'failed', at, words: w('The provider reports the payment failed.'), provider_words: p.words ?? 'failed', reference: p.reference, call_id: id, charged_cents: p.charged_cents }));
          steps.push(...this.stopNotStarted(o, at, 'Not started: the payment failed; nothing is provisioned.', ['payment', 'acceptance']));
          return { steps, resources: [] };
        }
        if (p.payment === 'processing') {
          steps.push(change(o, 'payment', { state: 'pending', at, words: w('The provider is still processing the payment (it answered 202); its outcome is read from the provider.'), provider_words: p.words ?? undefined, reference: p.reference, call_id: id, charged_cents: null }));
          return { steps, resources: [] };
        }
        steps.push(change(o, 'payment', { state: 'paid', at, words: w(p.charged_cents === null ? 'Paid; the provider reported no amount.' : `Paid: ${usd(p.charged_cents)} ${p.currency ?? ''}.`.trim()), reference: p.reference, call_id: id, charged_cents: p.charged_cents }));
        if (o.request.kind === 'domain' && p.registered) {
          const r = this.resource(o, 'domain', o.request.domain!, o.request.domain!, at, null, null);
          steps.push(change(o, 'provisioning', { state: 'completed', at, words: w(`Registered ${o.request.domain}.`), reference: o.request.domain!, call_id: id }));
          return { steps, resources: [r] };
        }
        return { steps, resources: [] };
      }
      case 'complete_domain_registration': {
        const d = a.domain;
        if (d.state === 'registered') {
          return { steps: [change(o, 'provisioning', { state: 'completed', at, words: w(`Registered ${d.domain}.`), reference: d.domain, call_id: id })], resources: [this.resource(o, 'domain', d.domain, d.domain, at, d.expires_at, null)] };
        }
        return { steps: [change(o, 'provisioning', { state: 'pending', at, words: w(`The provider is registering ${d.domain}; read until it is registered.`), reference: d.domain, call_id: id })], resources: [] };
      }
      case 'start_site_setup': {
        const su = a.setup;
        const steps = [change(o, 'acceptance', { state: 'accepted', at, words: w(`The provider accepted the setup (${su.setup_id}).`), reference: su.setup_id, call_id: id })];
        if (su.status === 'completed' && su.site_id) {
          steps.push(change(o, 'provisioning', { state: 'completed', at, words: w(`The site is set up (${su.site_id}).`), reference: su.site_id, call_id: id }));
          return { steps, resources: [this.resource(o, 'site', su.site_id, su.site_id, at, null, null)] };
        }
        steps.push(change(o, 'provisioning', { state: 'pending', at, words: w('The setup runs at the provider in the background; read until it completes.'), reference: su.setup_id, call_id: id }));
        return { steps, resources: [] };
      }
      case 'link_domain':
        return { steps: [change(o, 'dns', { state: 'completed', at, words: w(`${o.request.domain} is linked to the site.`), reference: o.request.domain!, call_id: id })], resources: [] };
      case 'start_certificate': {
        const cert = a.certificate;
        if (cert.status === 'active') {
          const site = o.resource_ids.map((rid) => this.state.resources[rid]).find((r) => r?.kind === 'site');
          return { steps: [change(o, 'certificate', { state: 'active', at, words: w(`A certificate covers ${o.request.domain}.`), reference: o.request.domain!, call_id: id })], resources: [this.resource(o, 'certificate', o.request.domain!, `certificate for ${o.request.domain}`, at, null, site?.resource_id ?? null)] };
        }
        return { steps: [change(o, 'certificate', { state: 'pending', at, words: w(`The certificate for ${o.request.domain} is ${cert.status}; read until it is active.`), reference: o.request.domain!, call_id: id })], resources: [] };
      }
      case 'start_vps_setup': {
        const v = a.vps;
        if (v.state === 'running') return { steps: [change(o, 'provisioning', { state: 'completed', at, words: w(`The VPS is running (${v.vps_id}).`), reference: v.vps_id, call_id: id })], resources: [this.resource(o, 'vps', v.vps_id, v.vps_id, at, null, null)] };
        return { steps: [change(o, 'provisioning', { state: 'pending', at, words: w(`The VPS is ${v.state} (${v.vps_id}); read until it runs.`), reference: v.vps_id, call_id: id })], resources: [] };
      }
      default:
        return { steps: [], resources: [] };
    }
  }

  /** A resource made by an order. Its id is derived from the provider's reference, so finding it twice makes one resource. */
  private resource(o: Order, kind: Resource['kind'], ref: string, name: string, at: string, expires: string | null, parent: string | null): Resource {
    const resourceId = `res_${sha256Hex(`${o.order_id}:${kind}:${ref}`).slice(0, 24)}`;
    const existing = this.state.resources[resourceId];
    if (existing) return { ...existing, expires_at: expires ?? existing.expires_at };
    return {
      resource_id: resourceId, customer_id: o.customer_id, kind, provider_ref: ref, name, order_id: o.order_id, parent_id: parent,
      created_at: at, state: 'active', expires_at: expires, retained: null, deleted: null,
    };
  }

  // ---- reads of what is in progress

  private async readOnce<T>(o: Order, step: StepName, explicit: boolean, fn: () => Promise<{ kind: 'answered'; value: T } | { kind: 'rate_limited'; retry_after_ms: number; words: string } | { kind: 'failed'; words: string }>): Promise<T | null> {
    const key = `${o.order_id}:${step}`;
    if (this.backedOff(key) && !explicit) return null;
    const last = this.lastRead.get(key);
    if (!explicit && last !== undefined && Date.now() - last < (this.o.pollIntervalMs ?? 10_000)) return null;
    this.lastRead.set(key, Date.now());
    const r = await fn();
    if (r.kind === 'rate_limited') { this.pauseFor(r.retry_after_ms); return null; }
    if (r.kind === 'failed') { this.backOff(key); this.logLine(`order ${o.order_id}: reading ${step} failed (${r.words})`); return null; }
    return r.value;
  }

  private async readPayment(o: Order, explicit: boolean): Promise<boolean> {
    const ref = o.steps.payment.reference!;
    const v = await this.readOnce(o, 'payment', explicit, () => this.o.provider.read({ read: 'purchase', reference: ref }));
    if (!v) return false;
    const p = v.purchase;
    const at = this.nowIso();
    if (!p) {
      this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: o.steps.payment.call_id ?? null, read: 'purchase', finding: 'missing', steps: [change(o, 'payment', { ...o.steps.payment, at, needs_person: `The provider has no order ${ref} any more: a person checks.`, words: `The provider no longer shows order ${ref}.` })], resources: [] });
      return false;
    }
    if (p.payment === 'processing') return false;
    const call = this.state.calls[o.steps.payment.call_id ?? ''];
    const effects = this.onAnswer(o, call?.call ?? { op: 'purchase', client_reference: 'none', kind: 'domain', item_id: o.request.item_id, domain: o.request.domain }, { op: 'purchase', purchase: p }, at, 'Read from the provider: ');
    this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: call?.call_id ?? null, read: 'purchase', finding: p.payment, ...effects });
    return true;
  }

  private async readProvisioning(o: Order, explicit: boolean): Promise<boolean> {
    const ref = o.steps.provisioning.reference!;
    const at = this.nowIso();
    const id = o.steps.provisioning.call_id;
    if (o.request.kind === 'domain') {
      const v = await this.readOnce(o, 'provisioning', explicit, () => this.o.provider.read({ read: 'domain', domain: ref }));
      if (!v || !v.domain || v.domain.state === 'registering') return false;
      const d = v.domain;
      if (d.state === 'registered') {
        this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: id ?? null, read: 'domain', finding: 'registered', steps: [change(o, 'provisioning', { state: 'completed', at, words: `Registered ${d.domain}.`, reference: d.domain, call_id: id })], resources: [this.resource(o, 'domain', d.domain, d.domain, at, d.expires_at, null)] });
        return true;
      }
      this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: id ?? null, read: 'domain', finding: d.state, steps: [change(o, 'provisioning', { state: 'failed', at, words: `The provider reports the domain is ${d.state.replace(/_/g, ' ')}.`, provider_words: d.words ?? undefined, reference: d.domain, call_id: id })], resources: [] });
      return false;
    }
    if (o.request.kind === 'vps') {
      const v = await this.readOnce(o, 'provisioning', explicit, () => this.o.provider.read({ read: 'vps', vps_id: ref }));
      if (!v || !v.vps || v.vps.state === 'installing') return false;
      const vps = v.vps;
      if (vps.state === 'running') {
        this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: id ?? null, read: 'vps', finding: 'running', steps: [change(o, 'provisioning', { state: 'completed', at, words: `The VPS is running (${vps.vps_id}).`, reference: vps.vps_id, call_id: id })], resources: [this.resource(o, 'vps', vps.vps_id, vps.vps_id, at, null, null)] });
        return true;
      }
      this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: id ?? null, read: 'vps', finding: vps.state, steps: [change(o, 'provisioning', { state: 'failed', at, words: `The provider reports the VPS is ${vps.state}.`, provider_words: vps.words ?? undefined, reference: vps.vps_id, call_id: id }), ...this.stopNotStarted(o, at, 'Not started: the VPS was not set up.', ['provisioning'])], resources: [] });
      return false;
    }
    const v = await this.readOnce(o, 'provisioning', explicit, () => this.o.provider.read({ read: 'site_setup', setup_id: ref }));
    if (!v || !v.setup || v.setup.status === 'running') return false;
    const su = v.setup;
    if (su.status === 'completed' && su.site_id) {
      this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: id ?? null, read: 'site_setup', finding: 'completed', steps: [change(o, 'provisioning', { state: 'completed', at, words: `The site is set up (${su.site_id}).`, reference: su.site_id, call_id: id })], resources: [this.resource(o, 'site', su.site_id, su.site_id, at, null, null)] });
      return true;
    }
    this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: id ?? null, read: 'site_setup', finding: 'failed', steps: [change(o, 'provisioning', { state: 'failed', at, words: 'The provider reports the setup failed.', provider_words: su.words ?? undefined, reference: su.setup_id, call_id: id }), ...this.stopNotStarted(o, at, 'Not started: the site was not set up.', ['provisioning'])], resources: [] });
    return false;
  }

  private async readCertificate(o: Order, explicit: boolean): Promise<boolean> {
    const site = o.steps.provisioning.reference!;
    const domain = o.request.domain!;
    const v = await this.readOnce(o, 'certificate', explicit, () => this.o.provider.read({ read: 'certificate', site_id: site, domain }));
    if (!v || v.certificate.status === 'installing') return false;
    const at = this.nowIso();
    const id = o.steps.certificate.call_id;
    if (v.certificate.status === 'active') {
      const siteRes = o.resource_ids.map((rid) => this.state.resources[rid]).find((r) => r?.kind === 'site');
      this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: id ?? null, read: 'certificate', finding: 'active', steps: [change(o, 'certificate', { state: 'active', at, words: `A certificate covers ${domain}.`, reference: domain, call_id: id })], resources: [this.resource(o, 'certificate', domain, `certificate for ${domain}`, at, null, siteRes?.resource_id ?? null)] });
      return true;
    }
    this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: id ?? null, read: 'certificate', finding: v.certificate.status, steps: [change(o, 'certificate', { state: 'failed', at, words: `The provider reports the certificate is ${v.certificate.status.replace('_', ' ')}.`, provider_words: v.certificate.words ?? undefined, reference: domain, call_id: id })], resources: [] });
    return true;
  }

  private async readHealth(o: Order, explicit: boolean): Promise<boolean> {
    const at = this.nowIso();
    if (o.request.kind === 'vps') {
      const v = await this.readOnce(o, 'health', explicit, () => this.o.provider.read({ read: 'vps', vps_id: o.steps.provisioning.reference! }));
      if (!v) return false;
      const ok = v.vps?.state === 'running';
      this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: null, read: 'vps', finding: ok ? 'ok' : 'failing', steps: [change(o, 'health', { state: ok ? 'ok' : 'failing', at, words: ok ? 'The provider reports the VPS running.' : `The provider reports the VPS ${v.vps?.state ?? 'missing'}.` })], resources: [] });
      return false;
    }
    const v = await this.readOnce(o, 'health', explicit, () => this.o.provider.read({ read: 'health', site_id: o.steps.provisioning.reference! }));
    if (!v) return false;
    const h = v.health;
    this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: null, read: 'health', finding: h.answers ? 'ok' : 'failing', steps: [change(o, 'health', { state: h.answers ? 'ok' : 'failing', at, words: h.answers ? `The site answers (${h.words})` : `The site does not answer as it should (${h.words})` })], resources: [] });
    return false;
  }

  /** A domain registered at once (the purchase's answer) has no registration end yet: read it once from the provider. */
  private async readDomainEnd(o: Order): Promise<boolean> {
    const r = o.resource_ids.map((id) => this.state.resources[id]).find((x) => x?.kind === 'domain');
    if (!r || r.expires_at || this.endRead.has(o.order_id)) return false;
    this.endRead.add(o.order_id);
    const v = await this.readOnce(o, 'provisioning', true, () => this.o.provider.read({ read: 'domain', domain: r.provider_ref }));
    if (!v?.domain?.expires_at) return false;
    this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: null, read: 'domain', finding: 'registration end', steps: [], resources: [{ ...r, expires_at: v.domain.expires_at }] });
    return false;
  }

  // ---- reconcile what is unknown

  /**
   * An unknown step: read the provider by what its call asked for. Found: the order moves on as if the answer had come.
   * Proven not to have happened: the steps may be sent again. Neither: it waits for a person, with what is known; it is
   * read again only when asked (an explicit reconcile).
   */
  private async reconcileUnknown(o: Order, stepName: StepName, explicit: boolean): Promise<boolean> {
    const step = o.steps[stepName];
    if (step.needs_person && !explicit) return false;
    const call = this.state.calls[step.call_id ?? ''];
    if (!call) return false;
    const key = `${o.order_id}:${stepName}`;
    if (this.backedOff(key) && !explicit) return false;
    const r = await this.o.provider.findEffect(call.call, call.intent_at);
    if (r.kind === 'rate_limited') { this.pauseFor(r.retry_after_ms); return false; }
    if (r.kind === 'failed') { this.backOff(key); this.logLine(`order ${o.order_id}: reconcile could not read the provider (${r.words})`); return false; }
    const f: Finding = r.value;
    const at = this.nowIso();
    if (f.found) {
      const effects = this.onAnswer(o, call.call, f.answer, at, `Reconcile found it (${f.how}): `);
      this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: call.call_id, read: call.call.op, finding: 'found', ...effects });
      this.logLine(`order ${o.order_id}: reconcile found the ${call.call.op}`);
      return true;
    }
    if (f.proven) {
      const words = `Reconcile proved the call did not take effect (${f.how}); it may be sent again.`;
      this.emit({ type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: call.call_id, read: call.call.op, finding: 'proven_absent', steps: call.steps.map((n) => change(o, n, { state: 'not_started', at, words })), resources: [] });
      this.logLine(`order ${o.order_id}: reconcile proved the ${call.call.op} did not happen`);
      return true;
    }
    const needs = `Reconcile could not prove the ${call.call.op.replace(/_/g, ' ')} did not happen (${f.how}). It is not sent again: a person checks the provider and says what happened.`;
    if (step.needs_person === needs) return false;
    this.emit({
      type: 'reconcile.read', order_id: o.order_id, deletion_id: null, call_id: call.call_id, read: call.call.op, finding: 'not_proven',
      steps: call.steps.map((n) => change(o, n, { ...o.steps[n], at, needs_person: needs })), resources: [],
    });
    this.logLine(`order ${o.order_id}: reconcile could not settle the ${call.call.op}; waits for a person`);
    return false;
  }

  // ---- deletions

  private async advanceDeletion(deletionId: string, explicit: boolean): Promise<void> {
    const d = this.state.deletions[deletionId];
    if (!d || d.decision?.decision !== 'approved' || this.paused()) return;
    const r = this.state.resources[d.resource_id];
    if (d.step.state === 'unknown') {
      if (d.step.needs_person && !explicit) return;
      const call = this.state.calls[d.step.call_id ?? ''];
      if (!call) return;
      const found = await this.o.provider.findEffect(call.call, call.intent_at);
      if (found.kind === 'rate_limited') { this.pauseFor(found.retry_after_ms); return; }
      if (found.kind === 'failed') return;
      const at = this.nowIso();
      const f = found.value;
      if (f.found) {
        this.emit({ type: 'reconcile.read', order_id: null, deletion_id: deletionId, call_id: call.call_id, read: 'site', finding: 'found', steps: [{ deletion_id: deletionId, to: { state: 'completed', at, words: `Reconcile found the deletion (${f.how}).`, call_id: call.call_id } }], resources: r ? [{ ...r, state: 'deleted', deleted: { at, deletion_id: deletionId } }] : [] });
      } else if (f.proven) {
        this.emit({ type: 'reconcile.read', order_id: null, deletion_id: deletionId, call_id: call.call_id, read: 'site', finding: 'proven_absent', steps: [{ deletion_id: deletionId, to: { state: 'not_started', at, words: `Reconcile proved the deletion did not take effect (${f.how}); the approval stands and it is sent again.` } }], resources: [] });
        await this.advanceDeletion(deletionId, false);
      } else if (!d.step.needs_person) {
        this.emit({ type: 'reconcile.read', order_id: null, deletion_id: deletionId, call_id: call.call_id, read: 'site', finding: 'not_proven', steps: [{ deletion_id: deletionId, to: { ...d.step, at, needs_person: `Reconcile could not tell whether the deletion happened (${f.how}).` } }], resources: [] });
      }
      return;
    }
    if (d.step.state !== 'not_started' || this.waiting(d.step) || !r) return;
    const call: ProviderCall = { op: 'delete_site', client_reference: this.newCallId(), site_id: r.provider_ref };
    await this.writeAheadCall({ deletion: d }, [], call,
      (_a, at) => ({ steps: [{ deletion_id: deletionId, to: { state: 'completed', at, words: 'Deleted at the provider, as a person approved: immediate and irreversible.', call_id: call.client_reference } }], resources: [{ ...r, state: 'deleted', deleted: { at, deletion_id: deletionId } }] }),
      (words, at) => [{ deletion_id: deletionId, to: { state: 'failed', at, words: 'The provider refused the deletion: nothing was deleted.', provider_words: words, call_id: call.client_reference } }]);
  }

  // ---- after a restart

  /** Calls the last process left out (written ahead, never answered): their steps become unknown, and say why. */
  private interruptLeftCalls(): void {
    for (const call of Object.values(this.state.calls)) {
      if (call.outcome !== null) continue;
      const at = this.nowIso();
      const words = 'Unknown: the backend stopped while this call was out (a crash or a local stop). Stopping the backend cancels nothing at the provider: it may have acted. Nothing is sent again until reconcile reads the provider.';
      const step: Step = { state: 'unknown', at, words, call_id: call.call_id };
      const o = call.order_id ? this.state.orders[call.order_id] : null;
      let steps: StepChange[] = [];
      if (o) steps = call.steps.map((n) => change(o, n, n === 'payment' ? { ...step, charged_cents: null } : step));
      else if (call.deletion_id) steps = [{ deletion_id: call.deletion_id, to: step }];
      this.emit({ type: 'call.interrupted', call_id: call.call_id, words, steps });
      this.logLine(`call ${call.call.op} (${call.call_id}) was out when the backend stopped: unknown until reconciled`);
    }
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------------------------

function change(o: Order, step: StepName, to: Step): StepChange { return { order_id: o.order_id, step, to }; }

function newOrder(customerId: string, request: OrderRequest, requestSha: string, keySha: string, at: string): Order {
  const step = (state: string, words: string): Step => ({ state, at, words });
  const linked = request.kind === 'site' && !!request.domain;
  return {
    order_id: `ord_${randomUUID()}`, customer_id: customerId, created_at: at, request, request_sha256: requestSha, idempotency_key_sha256: keySha,
    quote: null,
    steps: {
      quote: step('pending', 'Asking the provider\'s catalog for the price.'),
      approval: step('not_started', 'Waits for the quote.'),
      payment: step('not_started', 'Nothing has been sent to the provider.'),
      acceptance: step('not_started', 'Nothing has been sent to the provider.'),
      provisioning: step('not_started', 'Nothing has been set up.'),
      dns: linked ? step('not_started', `Links ${request.domain} to the site once it is set up.`) : step('not_needed', request.kind === 'site' ? 'The site uses the provider\'s free subdomain.' : 'This order links no domain.'),
      certificate: linked ? step('not_started', `A certificate for ${request.domain}, once it is linked.`) : step('not_needed', 'No domain of the customer\'s own to cover.'),
      health: request.kind === 'domain' ? step('not_needed', 'A domain on its own has no health check.') : step('not_started', 'Checked once it is set up.'),
    },
    submitted_at: null, cancel: null, halted: null, approved_month: null, resource_ids: [], decisions: [],
  };
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function parseOrderRequest(body: unknown): OrderRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CloudError(400, 'The order is a JSON object: {"kind": "site" | "domain" | "vps", "item_id": "…", "domain": "…"}. Nothing was created.');
  const b = body as Record<string, unknown>;
  const kind = String(b.kind ?? '') as OrderKind;
  if (!ORDER_KINDS.includes(kind)) throw new CloudError(422, 'The kind is one of: site, domain, vps. Nothing was created.');
  const item = typeof b.item_id === 'string' ? b.item_id : '';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(item)) throw new CloudError(422, 'Name the provider\'s catalog item in item_id. Nothing was created.');
  const raw = b.domain === undefined || b.domain === null ? null : String(b.domain).trim().toLowerCase();
  if (kind === 'domain' && !raw) throw new CloudError(422, 'A domain order names the domain. Nothing was created.');
  if (kind === 'vps' && raw) throw new CloudError(422, 'A VPS order names no domain. Nothing was created.');
  if (raw && !DOMAIN.test(raw)) throw new CloudError(422, 'That is not a domain name. Nothing was created.');
  return { kind, item_id: item, domain: raw };
}

function parseLimits(input: unknown): Limits {
  const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const cents = (v: unknown, name: string, required: boolean): number => {
    if (v === undefined && !required) return 0;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new CloudError(422, `limits.${name} is a whole number of cents, 0 or more (there is no unlimited).`);
    return v;
  };
  return {
    per_order_cents: cents(b.per_order_cents, 'per_order_cents', true),
    monthly_cents: cents(b.monthly_cents, 'monthly_cents', true),
    auto_approve_up_to_cents: cents(b.auto_approve_up_to_cents, 'auto_approve_up_to_cents', false),
  };
}

function parseSubscription(v: unknown): SubscriptionState {
  const s = String(v ?? '') as SubscriptionState;
  if (!SUBSCRIPTION_STATES.includes(s)) throw new CloudError(422, 'The subscription state, as billing gives it, is one of: active, past_due, canceled.');
  return s;
}

function parseStep(v: unknown): StepName {
  const s = String(v) as StepName;
  if (!STEP_NAMES.includes(s)) throw new CloudError(422, `The step is one of: ${STEP_NAMES.join(', ')}.`);
  return s;
}

function idText(v: unknown, name: string): string {
  if (typeof v !== 'string' || !/^[\x21-\x7E]{1,200}$/.test(v)) throw new CloudError(422, `${name} is 1 to 200 printable characters with no spaces.`);
  return v;
}

function noteText(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 1000) throw new CloudError(422, 'A person\'s decision carries a note in words (1 to 1000 characters): what was checked or why.');
  return v.trim();
}
