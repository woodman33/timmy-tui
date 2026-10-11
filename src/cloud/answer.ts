/**
 * Round R4 (helper H93): the backend's two answers as Timmy's client reads them: GET /v1/operator/overview and GET
 * /v1/operator/orders (services/cloud/views.ts writes them; the client does not import the backend, which never ships).
 * Read defensively: a field that is not there or not of its kind is left out and counted as a problem, never filled in.
 * A cost stays as the backend said it: a number it reported, null when a purchase went out and no amount came back, absent
 * when no purchase went out; never an invented 0.
 */

/** The steps of an order, in the backend's order; the words each step is shown with. */
export const STEP_ORDER = ['quote', 'approval', 'payment', 'acceptance', 'provisioning', 'dns', 'certificate', 'health'] as const;
export const STEP_LABEL: Readonly<Record<string, string>> = {
  quote: 'quote', approval: 'approval', payment: 'payment', acceptance: 'acceptance', provisioning: 'provisioning', dns: 'DNS', certificate: 'certificate', health: 'health',
};

export interface BackendStep {
  name: string;
  state: string;
  at: string;
  words: string;
  needs_person?: string;
  retry_at?: string;
  reference?: string;
  provider_words?: string;
  /** payment only: a reported amount, null when unknown; absent when no purchase went out */
  charged_cents?: number | null;
}
export interface BackendResource {
  resource_id: string; customer_id: string | null; kind: string; name: string; state: string; order_id: string;
  created_at: string; expires_at: string | null; retained_until: string | null;
}
export interface BackendOrder {
  order_id: string; customer_id: string | null; created_at: string;
  kind: string; item_id: string; domain: string | null;
  quote: { total_cents: number; currency: string; source: string } | null;
  steps: BackendStep[];
  summary: string; partial: boolean; needs_person: string | null; next_action: string;
  cost: { quoted_cents: number | null; currency: string | null; charged_cents?: number | null };
  cancel: { asked_at: string; before_submission: boolean; words: string } | null;
  halted: { at: string; words: string } | null;
  resources: BackendResource[];
}
export interface BackendNeed {
  kind: string; customer_id: string | null; order_id?: string; resource_id?: string; item_id?: string; deletion_id?: string;
  since: string; reason: string; next_action: string;
}
export interface BackendLimits { per_order_cents: number; monthly_cents: number; auto_approve_up_to_cents: number }
export interface BackendCustomer {
  customer_id: string; subscription: string; month: string; limits: BackendLimits | null;
  approved_this_month_cents: number | null; paid_this_month_cents: number | null; orders_with_unknown_cost: number | null; orders: number | null;
}
export interface BackendOverview {
  generated_at: string | null; service: string | null;
  provider: { name: string; simulated: boolean | null; purchase_absence_proof: string | null; paused_until: string | null } | null;
  orders: number | null;
  customers: BackendCustomer[];
  needs_person: BackendNeed[];
  unreadable_log_lines: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export type Parsed<T> = { ok: true; value: T; problems: string[] } | { ok: false; why: string };

export function parseOverview(json: unknown): Parsed<BackendOverview> {
  const j = obj(json);
  if (!j) return { ok: false, why: 'the overview is not a JSON object' };
  const problems: string[] = [];
  const p = obj(j.provider);
  if (!p) problems.push('it names no provider');
  const customers: BackendCustomer[] = [];
  for (const raw of arr(j.customers)) {
    const c = obj(raw);
    const id = str(c?.customer_id);
    if (!c || !id) { problems.push('a customer without an id was left out'); continue; }
    const l = obj(c.limits);
    const limits = l && num(l.per_order_cents) !== undefined && num(l.monthly_cents) !== undefined && num(l.auto_approve_up_to_cents) !== undefined
      ? { per_order_cents: num(l.per_order_cents)!, monthly_cents: num(l.monthly_cents)!, auto_approve_up_to_cents: num(l.auto_approve_up_to_cents)! } : null;
    if (!limits) problems.push(`customer ${id}'s limits are not readable`);
    customers.push({
      customer_id: id, subscription: str(obj(c.subscription)?.state) ?? 'not known', month: str(c.month) ?? '', limits,
      approved_this_month_cents: num(c.approved_this_month_cents) ?? null, paid_this_month_cents: num(c.paid_this_month_cents) ?? null,
      orders_with_unknown_cost: num(c.orders_with_unknown_cost) ?? null, orders: num(c.orders) ?? null,
    });
  }
  const needs: BackendNeed[] = [];
  for (const raw of arr(j.needs_person)) {
    const n = obj(raw);
    const kind = str(n?.kind);
    const reason = str(n?.reason);
    if (!n || !kind || !reason) { problems.push('an item that needs a person had no kind or reason and was left out'); continue; }
    needs.push({
      kind, customer_id: str(n.customer_id) ?? null, ...(str(n.order_id) ? { order_id: str(n.order_id)! } : {}), ...(str(n.resource_id) ? { resource_id: str(n.resource_id)! } : {}),
      ...(str(n.item_id) ? { item_id: str(n.item_id)! } : {}), ...(str(n.deletion_id) ? { deletion_id: str(n.deletion_id)! } : {}),
      since: str(n.since) ?? '', reason, next_action: str(n.next_action) ?? '',
    });
  }
  const log = obj(j.event_log);
  return {
    ok: true, problems,
    value: {
      generated_at: str(j.generated_at) ?? null, service: str(j.service) ?? null,
      provider: p ? { name: str(p.name) ?? 'not named', simulated: typeof p.simulated === 'boolean' ? p.simulated : null, purchase_absence_proof: str(p.purchase_absence_proof) ?? null, paused_until: str(p.paused_until) ?? null } : null,
      orders: num(j.orders) ?? null, customers, needs_person: needs, unreadable_log_lines: arr(log?.unreadable_lines).length,
    },
  };
}

function stepOf(name: string, raw: unknown): BackendStep | undefined {
  const s = obj(raw);
  const state = str(s?.state);
  if (!s || !state) return undefined;
  return {
    name, state, at: str(s.at) ?? '', words: str(s.words) ?? '',
    ...(str(s.needs_person) ? { needs_person: str(s.needs_person)! } : {}), ...(str(s.retry_at) ? { retry_at: str(s.retry_at)! } : {}),
    ...(str(s.reference) ? { reference: str(s.reference)! } : {}), ...(str(s.provider_words) ? { provider_words: str(s.provider_words)! } : {}),
    ...('charged_cents' in s ? { charged_cents: num(s.charged_cents) ?? null } : {}),
  };
}

function resourceOf(raw: unknown, customer: string | null): BackendResource | undefined {
  const r = obj(raw);
  const id = str(r?.resource_id);
  if (!r || !id) return undefined;
  return {
    resource_id: id, customer_id: str(r.customer_id) ?? customer, kind: str(r.kind) ?? 'resource', name: str(r.name) ?? '', state: str(r.state) ?? 'not known',
    order_id: str(r.order_id) ?? '', created_at: str(r.created_at) ?? '', expires_at: str(r.expires_at) ?? null, retained_until: str(obj(r.retained)?.until) ?? null,
  };
}

export function parseOrders(json: unknown): Parsed<{ orders: BackendOrder[]; resources: BackendResource[] }> {
  const j = obj(json);
  if (!j || !Array.isArray(j.orders)) return { ok: false, why: 'the orders answer has no list of orders' };
  const problems: string[] = [];
  const orders: BackendOrder[] = [];
  for (const raw of j.orders) {
    const o = obj(raw);
    const id = str(o?.order_id);
    const steps = obj(o?.steps);
    if (!o || !id || !steps) { problems.push('an order without an id or steps was left out'); continue; }
    const names = [...STEP_ORDER.filter((n) => n in steps), ...Object.keys(steps).filter((n) => !(STEP_ORDER as readonly string[]).includes(n))];
    const list = names.flatMap((n) => { const s = stepOf(n, steps[n]); return s ? [s] : []; });
    const req = obj(o.request);
    const q = obj(o.quote);
    const cost = obj(o.cost);
    const cancel = obj(o.cancel);
    const halted = obj(o.halted);
    const customer = str(o.customer_id) ?? null;
    orders.push({
      order_id: id, customer_id: customer, created_at: str(o.created_at) ?? '',
      kind: str(req?.kind) ?? 'order', item_id: str(req?.item_id) ?? '', domain: str(req?.domain) ?? null,
      quote: q && num(q.total_cents) !== undefined ? { total_cents: num(q.total_cents)!, currency: str(q.currency) ?? '', source: str(q.source) ?? '' } : null,
      steps: list, summary: str(o.summary) ?? '', partial: o.partial === true, needs_person: str(o.needs_person) ?? null, next_action: str(o.next_action) ?? '',
      cost: { quoted_cents: num(cost?.quoted_cents) ?? null, currency: str(cost?.currency) ?? null, ...(cost && 'charged_cents' in cost ? { charged_cents: num(cost.charged_cents) ?? null } : {}) },
      cancel: cancel && str(cancel.words) ? { asked_at: str(cancel.asked_at) ?? '', before_submission: cancel.before_submission === true, words: str(cancel.words)! } : null,
      halted: halted && str(halted.words) ? { at: str(halted.at) ?? '', words: str(halted.words)! } : null,
      resources: arr(o.resources).flatMap((r) => { const x = resourceOf(r, customer); return x ? [x] : []; }),
    });
  }
  const resources = arr(j.resources).flatMap((r) => { const x = resourceOf(r, null); return x ? [x] : []; });
  return { ok: true, value: { orders, resources }, problems };
}

/** Cents of a currency, as the backend reports them: "$12.00" for USD, else "12.00 EUR". */
export function money(cents: number, currency = 'USD'): string {
  return currency === 'USD' ? `$${(cents / 100).toFixed(2)}` : `${(cents / 100).toFixed(2)} ${currency}`;
}

/** A customer's limits in words; a threshold of 0 means every purchase waits for the operator. */
export function limitsWords(l: BackendLimits): string {
  const auto = l.auto_approve_up_to_cents > 0
    ? `approved without the operator up to ${money(l.auto_approve_up_to_cents)} (and inside both limits)`
    : 'no automatic approval (a threshold of 0: every purchase waits for the operator)';
  return `at most ${money(l.per_order_cents)} an order and ${money(l.monthly_cents)} a month; ${auto}`;
}

/** The first operator route a backend sentence names ("POST /v1/operator/orders/<id>/approve"), or undefined. */
export function routeIn(words: string): string | undefined {
  return /\b(GET|POST|PUT) (\/v1\/[A-Za-z0-9_/<>-]+)/.exec(words)?.slice(1, 3).join(' ');
}

/** What an order is for, in a few words: the domain it registers, the site and its domain, the VPS item. */
export function orderName(o: Pick<BackendOrder, 'kind' | 'item_id' | 'domain' | 'resources'>): string {
  if (o.kind === 'domain') return `domain ${o.domain ?? o.resources.find((r) => r.kind === 'domain')?.name ?? o.item_id}`;
  if (o.kind === 'site') return `site${o.domain ? ` for ${o.domain}` : ' (the provider\'s own subdomain)'}`;
  if (o.kind === 'vps') return `VPS ${o.item_id}`;
  return `${o.kind} ${o.item_id}`;
}
