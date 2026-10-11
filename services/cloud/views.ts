/**
 * Timmy Cloud's backend: what customers and the operator are shown, as pure functions of the state.
 *
 * An order is shown step by step, each with its own state, time and words, plus a sentence that names the steps that
 * matter now; never one word for the whole order. A cost is a number the provider or its catalog reported, null when a
 * purchase went out and no amount came back, or absent when no purchase went out.
 *
 * The operator's overview (GET /v1/operator/overview, which God's Eye View reads later) counts every step's states over
 * all orders, sets each customer's spending against their limits, and lists what needs a person, with why and what to do.
 */
import type { CloudState, Customer, DeletionRequest, Order, Resource, RetentionItem, Step, StepName } from './types.js';
import { STEP_NAMES, STEP_STATES } from './types.js';
import type { ProviderInfo } from './provider.js';
import type { UnreadableLine } from './event-log.js';

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
export const monthOf = (iso: string): string => iso.slice(0, 7);

/** Steps whose state means the provider is (or may be) still at work, or a call is out. */
const OPEN = new Set(['pending', 'in_flight', 'unknown']);

export interface OrderView {
  order_id: string;
  created_at: string;
  request: Order['request'];
  quote: Order['quote'];
  steps: Record<StepName, Step>;
  /** One sentence naming the steps that matter now. */
  summary: string;
  /** Something was provisioned and a later step failed. */
  partial: boolean;
  /** Why a person must act now; null when nobody needs to. */
  needs_person: string | null;
  next_action: string;
  cost: { quoted_cents: number | null; currency: string | null; charged_cents?: number | null };
  cancel: Order['cancel'];
  halted: Order['halted'];
  decisions: Order['decisions'];
  resources: ResourceView[];
}

export interface ResourceView {
  resource_id: string;
  kind: Resource['kind'];
  name: string;
  provider_ref: string;
  order_id: string;
  parent_id: string | null;
  state: Resource['state'];
  created_at: string;
  expires_at: string | null;
  retained: Resource['retained'];
  deleted: Resource['deleted'];
}

export function resourceView(r: Resource): ResourceView {
  return {
    resource_id: r.resource_id, kind: r.kind, name: r.name, provider_ref: r.provider_ref, order_id: r.order_id,
    parent_id: r.parent_id, state: r.state, created_at: r.created_at, expires_at: r.expires_at, retained: r.retained, deleted: r.deleted,
  };
}

export function orderView(state: CloudState, o: Order): OrderView {
  const d = describeOrder(state, o);
  const pay = o.steps.payment;
  const cost: OrderView['cost'] = { quoted_cents: o.quote?.total_cents ?? null, currency: o.quote?.currency ?? null };
  if ('charged_cents' in pay) cost.charged_cents = pay.charged_cents ?? null;
  return {
    order_id: o.order_id, created_at: o.created_at, request: o.request, quote: o.quote, steps: o.steps,
    summary: d.summary, partial: d.partial, needs_person: d.needs_person, next_action: d.next_action, cost,
    cancel: o.cancel, halted: o.halted, decisions: o.decisions,
    resources: o.resource_ids.map((id) => state.resources[id]).filter(Boolean).map(resourceView),
  };
}

interface Description { summary: string; partial: boolean; needs_person: string | null; next_action: string }

const RESOLVE = (o: Order): string => `POST /v1/operator/orders/${o.order_id}/resolve`;

/** The words for an order as it stands: what matters now, whether it is partial, and what a person must do. */
export function describeOrder(state: CloudState, o: Order): Description {
  const s = o.steps;
  const customer = state.customers[o.customer_id];
  const quote = o.quote ? `${usd(o.quote.total_cents)} ${o.quote.currency}` : 'not quoted';
  const nothingNext = 'Nothing: this order has ended.';

  if (o.cancel?.before_submission) return { summary: o.cancel.words, partial: false, needs_person: null, next_action: nothingNext };
  if (s.quote.state === 'failed') return { summary: `The quote failed: ${s.quote.words} Nothing was sent to the provider.`, partial: false, needs_person: null, next_action: nothingNext };
  if (s.quote.state === 'pending') return { summary: `Waiting for the quote: ${s.quote.words}`, partial: false, needs_person: null, next_action: 'The backend asks the provider\'s catalog again.' };
  if (s.approval.state === 'refused') return { summary: `Not approved: ${s.approval.words} Nothing was sent to the provider.`, partial: false, needs_person: null, next_action: nothingNext };
  if (s.approval.state === 'waiting') {
    return {
      summary: `Waits for the operator's approval (quote ${quote}).`, partial: false,
      needs_person: s.approval.words,
      next_action: `The operator approves (POST /v1/operator/orders/${o.order_id}/approve), or the customer cancels.`,
    };
  }

  const unknown = STEP_NAMES.filter((n) => s[n].state === 'unknown');
  if (unknown.length) {
    const first = s[unknown[0]];
    return {
      summary: `Unknown: ${unknown.join(' and ')}. ${first.words}`, partial: false,
      needs_person: first.needs_person ?? null,
      next_action: first.needs_person
        ? `A person checks the provider and says what happened: ${RESOLVE(o)} with action "happened" (and the provider's reference) or "did_not_happen".`
        : 'Reconcile reads the provider; nothing is sent again until it shows what happened.',
    };
  }

  if (s.acceptance.state === 'refused') return { summary: `The provider refused the order: ${s.acceptance.provider_words ?? s.acceptance.words}`, partial: false, needs_person: null, next_action: nothingNext };
  if (s.payment.state === 'failed') {
    return { summary: `The payment failed (the provider: "${s.payment.provider_words ?? s.payment.words}"). Nothing was provisioned.`, partial: false, needs_person: null, next_action: `${nothingNext} The customer may order again.` };
  }

  const made = s.provisioning.state === 'completed';
  const failedLater = (['dns', 'certificate'] as StepName[]).filter((n) => s[n].state === 'failed');
  const failingHealth = s.health.state === 'failing';
  const partial = made && (failedLater.length > 0 || failingHealth);

  const halted = o.halted;
  const pending = STEP_NAMES.filter((n) => OPEN.has(s[n].state));
  if (halted) {
    const why = o.cancel ? o.cancel.words : halted.words;
    if (pending.length) return { summary: `${why} In progress at the provider: ${pending.join(', ')}.`, partial, needs_person: null, next_action: 'Reconcile reads the provider until nothing is pending; then a person decides.' };
    const left = STEP_NAMES.filter((n) => s[n].state === 'not_started');
    if (left.length === 0) return { summary: `${why} Nothing is left to do.`, partial, needs_person: null, next_action: nothingNext };
    return {
      summary: `${why} Settled at the provider; not started: ${left.join(', ')}.`, partial,
      needs_person: o.cancel ? 'The customer asked to cancel after the order was submitted; what the provider did stays. Decide whether to go on or stop here.' : 'This order was stopped with steps not started.',
      next_action: `${RESOLVE(o)} with action "continue" or "stop" (stop keeps what exists; nothing is deleted).`,
    };
  }

  if (s.provisioning.state === 'failed') {
    return {
      summary: `Provisioning failed (the provider: "${s.provisioning.provider_words ?? s.provisioning.words}").`, partial: false,
      needs_person: 'Provisioning failed after the order was approved: retry it or stop the order.',
      next_action: `${RESOLVE(o)} with action "retry" and step "provisioning", or "stop".`,
    };
  }

  if (partial) {
    const parts = [`Partly provisioned: the ${o.request.kind} exists (${s.provisioning.reference ?? 'its reference is in the provisioning step'})`];
    for (const n of failedLater) parts.push(`${n === 'dns' ? 'the domain link' : 'the certificate'} failed (the provider: "${s[n].provider_words ?? s[n].words}")`);
    if (s.certificate.state === 'stopped' && s.dns.state === 'failed') parts.push('the certificate was not started (it needs the domain link)');
    if (failingHealth) parts.push(`the health check failed (${s.health.words})`);
    const step = failedLater[0] ?? 'health';
    const next = step === 'dns'
      ? `Make the domain point to the site, then retry the link: ${RESOLVE(o)} with action "retry" and step "dns".`
      : step === 'certificate'
        ? `Fix the cause, then retry the certificate: ${RESOLVE(o)} with action "retry" and step "certificate" (the provider allows three certificate setups per domain in seven days).`
        : `Look at the site, then check again: POST /v1/operator/orders/${o.order_id}/reconcile.`;
    return { summary: `${parts.join('; ')}.`, partial: true, needs_person: `A ${step === 'dns' ? 'domain link' : step === 'certificate' ? 'certificate' : 'health check'} failed after the ${o.request.kind} was made.`, next_action: next };
  }

  if (customer && customer.subscription.state !== 'active' && s.payment.state === 'not_started' && o.request.kind !== 'site') {
    return {
      summary: `Approved, not sent: the Timmy Pro subscription is ${customer.subscription.state.replace('_', ' ')}, and nothing is bought while it is.`, partial: false,
      needs_person: `Approved while the subscription was active; it is now ${customer.subscription.state.replace('_', ' ')}.`,
      next_action: 'Nothing is sent until billing says the subscription is active again; the customer may cancel.',
    };
  }
  if (customer && customer.subscription.state === 'canceled' && STEP_NAMES.some((n) => s[n].state === 'not_started') && pending.length === 0) {
    return {
      summary: 'Timmy Pro was cancelled during this order: nothing more is set up; what exists is retained.', partial: false,
      needs_person: 'Timmy Pro was cancelled with this order unfinished.',
      next_action: `${RESOLVE(o)} with action "stop" (what exists stays retained; nothing is deleted).`,
    };
  }

  const done = STEP_NAMES.every((n) => ['quoted', 'approved', 'paid', 'accepted', 'completed', 'active', 'ok', 'not_needed'].includes(s[n].state));
  if (done) return { summary: `Done: the ${o.request.kind} is ready; every step completed.`, partial: false, needs_person: null, next_action: nothingNext };

  const current = STEP_NAMES.find((n) => OPEN.has(s[n].state) || s[n].state === 'not_started');
  const cur = current ? s[current] : null;
  const wait = cur?.retry_at ? ` Not before ${cur.retry_at} (${cur.words})` : '';
  return {
    summary: current ? `In progress: ${current}, ${cur!.state.replace('_', ' ')}.${wait || ` ${cur!.words}`}` : 'In progress.',
    partial: false, needs_person: null,
    next_action: 'The backend goes on by itself; POST /v1/operator/orders/<id>/reconcile reads the provider now.'.replace('<id>', o.order_id),
  };
}

/** Approved spending in the calendar month `month` (YYYY-MM): orders approved then, minus those that bought nothing. */
export function approvedInMonth(state: CloudState, customerId: string, month: string): number {
  let sum = 0;
  for (const o of Object.values(state.orders)) {
    if (o.customer_id !== customerId || o.approved_month !== month || !o.quote) continue;
    const s = o.steps;
    if (s.approval.state !== 'approved') continue;
    if (['failed', 'cancelled', 'stopped'].includes(s.payment.state) || s.acceptance.state === 'refused') continue;
    sum += o.quote.total_cents;
  }
  return sum;
}

export interface NeedsPerson {
  kind: 'approval' | 'unknown_outcome' | 'cancel_asked' | 'stopped_mid_order' | 'purchase_blocked' | 'subscription_canceled' | 'failed_step'
    | 'export' | 'domain_decision' | 'deletion_approval' | 'deletion_unknown' | 'event_log';
  customer_id: string | null;
  order_id?: string;
  resource_id?: string;
  item_id?: string;
  deletion_id?: string;
  since: string;
  reason: string;
  next_action: string;
}

export interface OverviewContext {
  now: Date;
  provider: ProviderInfo;
  paused_until: string | null;
  unreadable: UnreadableLine[];
}

export interface Overview {
  generated_at: string;
  service: string;
  provider: ProviderInfo & { paused_until: string | null };
  /** For each step, how many orders are in each state (every state the step has, zeros included). */
  counts: Record<StepName, Record<string, number>>;
  orders: number;
  deletions: Record<string, number>;
  customers: Array<{
    customer_id: string;
    subscription: Customer['subscription'];
    limits: Customer['limits'];
    month: string;
    approved_this_month_cents: number;
    paid_this_month_cents: number;
    /** Orders whose purchase went out and no amount came back: their cost is unknown. */
    orders_with_unknown_cost: number;
    orders: number;
    resources: Record<string, number>;
  }>;
  needs_person: NeedsPerson[];
  event_log: { events_applied: number; duplicates_skipped: number; unreadable_lines: UnreadableLine[] };
}

export function buildOverview(state: CloudState, ctx: OverviewContext): Overview {
  const nowIso = ctx.now.toISOString();
  const month = monthOf(nowIso);
  const counts = {} as Record<StepName, Record<string, number>>;
  for (const n of STEP_NAMES) counts[n] = Object.fromEntries(STEP_STATES[n].map((st) => [st, 0]));
  const orders = Object.values(state.orders);
  for (const o of orders) for (const n of STEP_NAMES) counts[n][o.steps[n].state] = (counts[n][o.steps[n].state] ?? 0) + 1;

  const deletions: Record<string, number> = {};
  for (const d of Object.values(state.deletions)) deletions[d.step.state] = (deletions[d.step.state] ?? 0) + 1;

  const customers = Object.values(state.customers).map((c) => {
    const own = orders.filter((o) => o.customer_id === c.customer_id);
    let paid = 0;
    let unknownCost = 0;
    for (const o of own) {
      const p = o.steps.payment;
      if (p.state === 'paid' && typeof p.charged_cents === 'number' && monthOf(p.at) === month) paid += p.charged_cents;
      if ('charged_cents' in p && p.charged_cents === null) unknownCost += 1;
    }
    const resources: Record<string, number> = {};
    for (const r of Object.values(state.resources)) if (r.customer_id === c.customer_id) resources[r.state] = (resources[r.state] ?? 0) + 1;
    return {
      customer_id: c.customer_id, subscription: c.subscription, limits: c.limits, month,
      approved_this_month_cents: approvedInMonth(state, c.customer_id, month), paid_this_month_cents: paid,
      orders_with_unknown_cost: unknownCost, orders: own.length, resources,
    };
  });

  return {
    generated_at: nowIso,
    service: 'Timmy Cloud backend (slice 1)',
    provider: { ...ctx.provider, paused_until: ctx.paused_until },
    counts, orders: orders.length, deletions, customers,
    needs_person: needsPerson(state, ctx),
    event_log: { events_applied: state.applied, duplicates_skipped: state.duplicates, unreadable_lines: ctx.unreadable },
  };
}

function needsPerson(state: CloudState, ctx: OverviewContext): NeedsPerson[] {
  const out: NeedsPerson[] = [];
  for (const o of Object.values(state.orders)) {
    const d = describeOrder(state, o);
    if (!d.needs_person) continue;
    const s = o.steps;
    const kind: NeedsPerson['kind'] = s.approval.state === 'waiting' ? 'approval'
      : STEP_NAMES.some((n) => s[n].state === 'unknown') ? 'unknown_outcome'
        : o.halted && o.cancel ? 'cancel_asked'
          : o.halted ? 'stopped_mid_order'
            : d.summary.startsWith('Approved, not sent') ? 'purchase_blocked'
              : d.summary.startsWith('Timmy Pro was cancelled') ? 'subscription_canceled'
                : 'failed_step';
    out.push({ kind, customer_id: o.customer_id, order_id: o.order_id, since: latestAt(o), reason: d.needs_person, next_action: d.next_action });
  }
  for (const item of Object.values(state.retention)) {
    if (item.closed) continue;
    out.push(retentionNeed(state, item, ctx.now));
  }
  for (const del of Object.values(state.deletions)) {
    if (!del.decision) {
      out.push({
        kind: 'deletion_approval', customer_id: del.customer_id, deletion_id: del.deletion_id, resource_id: del.resource_id, since: del.requested_at,
        reason: `A deletion was asked for (${del.reason}); it is irreversible and waits for a person.`,
        next_action: `POST /v1/operator/deletions/${del.deletion_id}/decide with decision "approve" (naming the resource again) or "refuse".`,
      });
    } else if (del.step.state === 'unknown' && del.step.needs_person) {
      out.push({ kind: 'deletion_unknown', customer_id: del.customer_id, deletion_id: del.deletion_id, resource_id: del.resource_id, since: del.step.at, reason: del.step.needs_person, next_action: 'A person checks the provider.' });
    }
  }
  if (ctx.unreadable.length) {
    out.push({
      kind: 'event_log', customer_id: null, since: ctx.now.toISOString(),
      reason: `${ctx.unreadable.length} line(s) of the event log could not be read (${ctx.unreadable.map((u) => `line ${u.line}: ${u.why}`).join('; ')}).`,
      next_action: 'Nothing was applied from them. Look at those lines; the backend never rewrites the log.',
    });
  }
  return out;
}

function retentionNeed(state: CloudState, item: RetentionItem, now: Date): NeedsPerson {
  const r = state.resources[item.resource_id];
  const name = r ? `${r.kind} ${r.name}` : item.resource_id;
  if (item.kind === 'export') {
    return {
      kind: 'export', customer_id: item.customer_id, item_id: item.item_id, resource_id: item.resource_id, since: item.opened_at,
      reason: `Timmy Pro was cancelled: export ${name} for the customer. It is retained until ${item.until}; nothing is deleted without a deletion a person approves.`,
      next_action: `Export it, then POST /v1/operator/retention/${item.item_id}/decide with decision "exported".`,
    };
  }
  const expires = item.expires_at ? Date.parse(item.expires_at) : NaN;
  const days = Number.isFinite(expires) ? Math.floor((expires - now.getTime()) / 86_400_000) : null;
  const when = item.expires_at
    ? (days !== null && days < 0 ? `its registration ended on ${item.expires_at} with no decision` : `its registration ends on ${item.expires_at} (${days} days)`)
    : 'its registration end is not known';
  return {
    kind: 'domain_decision', customer_id: item.customer_id, item_id: item.item_id, resource_id: item.resource_id, since: item.opened_at,
    reason: `Timmy Pro was cancelled: decide ${name}: transfer it to the customer, renew it, or let it lapse; ${when}. The backend never lets a domain lapse without a person's decision.`,
    next_action: `POST /v1/operator/retention/${item.item_id}/decide with decision "transfer_to_customer", "renew" or "let_lapse".`,
  };
}

function latestAt(o: Order): string {
  return STEP_NAMES.map((n) => o.steps[n].at).sort().pop() ?? o.created_at;
}

/**
 * R4 (H93): GET /v1/operator/orders, read only: every customer's orders and resources, newest first, as the same views the
 * customer routes answer (orderView, resourceView), each with its customer. Timmy's client keeps it beside the overview, so
 * God's Eye View can show each site, domain and VPS with its own steps.
 */
export interface OperatorOrders {
  generated_at: string;
  orders: Array<{ customer_id: string } & OrderView>;
  resources: Array<{ customer_id: string } & ResourceView>;
}

export function operatorOrdersView(state: CloudState, now: Date): OperatorOrders {
  const newest = <T extends { created_at: string }>(a: T, b: T): number => b.created_at.localeCompare(a.created_at);
  return {
    generated_at: now.toISOString(),
    orders: Object.values(state.orders).sort(newest).map((o) => ({ customer_id: o.customer_id, ...orderView(state, o) })),
    resources: Object.values(state.resources).sort(newest).map((r) => ({ customer_id: r.customer_id, ...resourceView(r) })),
  };
}

export function deletionView(d: DeletionRequest): DeletionRequest { return d; }
