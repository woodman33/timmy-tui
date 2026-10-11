/**
 * Timmy Cloud's backend, slice 1: the model.
 *
 * Provider-neutral: a site, a domain, a VPS and a certificate, bought and run for a customer through a provider adapter
 * (provider.ts). Nothing here names a real provider; the simulated provider (simulated-provider.ts) models the
 * documented behaviour of the one the operator uses.
 *
 * Every order is a set of steps, each with its own state and time; the order never gets one word for the whole of it.
 * The state is rebuilt from an append-only event log by a pure reducer (reducer.ts).
 */
import type { ProviderCall } from './provider.js';

export type SubscriptionState = 'active' | 'past_due' | 'canceled';
export const SUBSCRIPTION_STATES: readonly SubscriptionState[] = ['active', 'past_due', 'canceled'];

/**
 * Spending limits, in cents of the quote's currency (USD in this slice). There is no "unlimited": both caps are finite
 * numbers the operator sets for each customer.
 */
export interface Limits {
  /** No single order whose quote is above this. */
  per_order_cents: number;
  /** No more than this approved in one calendar month (UTC), counted when an order is approved. */
  monthly_cents: number;
  /** Approved without the operator only when the quote is at most this. 0, the default, means every order waits for the operator. */
  auto_approve_up_to_cents: number;
}

export interface Customer {
  customer_id: string;
  /** sha256 of the customer's token (hex); the token itself is never stored. */
  token_sha256: string;
  created_at: string;
  /** The Timmy Pro subscription's state, as billing gave it (there is no payment processor here). */
  subscription: { state: SubscriptionState; since: string; source: string };
  limits: Limits;
}

export type OrderKind = 'site' | 'domain' | 'vps';
export const ORDER_KINDS: readonly OrderKind[] = ['site', 'domain', 'vps'];
export type ResourceKind = 'site' | 'domain' | 'vps' | 'certificate';

export interface OrderRequest {
  kind: OrderKind;
  /** The provider's catalog item. */
  item_id: string;
  /**
   * domain: the name to register. site: one of the customer's own registered domains to link to the new site, or null
   * for the provider's free subdomain. vps: null.
   */
  domain: string | null;
}

export interface QuoteItem { item_id: string; name: string; unit_cents: number; quantity: number; period: string }

export interface Quote {
  items: QuoteItem[];
  total_cents: number;
  currency: string;
  /** Where the prices came from, in words, e.g. "the simulated provider's catalog (simulated prices)". */
  source: string;
  quoted_at: string;
}

export type StepName = 'quote' | 'approval' | 'payment' | 'acceptance' | 'provisioning' | 'dns' | 'certificate' | 'health';
export const STEP_NAMES: readonly StepName[] = ['quote', 'approval', 'payment', 'acceptance', 'provisioning', 'dns', 'certificate', 'health'];

/**
 * The states each step can be in.
 *
 * - `in_flight`: a provider call for this step was written ahead and its answer has not come back yet.
 * - `unknown`: the call's answer was lost (a timeout, a reset connection, the backend stopped during the call): the
 *   provider may or may not have acted. Never `failed`, never sent again blindly; reconcile reads the provider.
 * - `cancelled`: cancelled here, before anything was sent to the provider.
 * - `stopped`: will not run, because an earlier step ended the order or a person stopped it; its words say which.
 * - `not_needed`: this kind of order has no such step (a bare domain has no certificate; a free site needs no payment).
 */
export const STEP_STATES = {
  quote: ['pending', 'quoted', 'failed'],
  approval: ['not_started', 'waiting', 'approved', 'refused', 'cancelled', 'stopped'],
  payment: ['not_started', 'in_flight', 'pending', 'paid', 'failed', 'unknown', 'not_needed', 'cancelled', 'stopped'],
  acceptance: ['not_started', 'in_flight', 'accepted', 'refused', 'unknown', 'cancelled', 'stopped'],
  provisioning: ['not_started', 'in_flight', 'pending', 'completed', 'failed', 'unknown', 'cancelled', 'stopped'],
  dns: ['not_started', 'in_flight', 'completed', 'failed', 'unknown', 'not_needed', 'cancelled', 'stopped'],
  certificate: ['not_started', 'in_flight', 'pending', 'active', 'failed', 'unknown', 'not_needed', 'cancelled', 'stopped'],
  health: ['not_started', 'ok', 'failing', 'not_needed', 'cancelled', 'stopped'],
} as const satisfies Record<StepName, readonly string[]>;

export type StepState<S extends StepName = StepName> = (typeof STEP_STATES)[S][number];

export interface Step {
  state: string;
  /** When this state was recorded. */
  at: string;
  /** What happened, in plain words. */
  words: string;
  /** The provider's own words, when it gave any (with the agency credential redacted). */
  provider_words?: string;
  /** The provider's reference for this step: its order id, a setup id, a site id, a VPS id. */
  reference?: string;
  /** The write-ahead record of the call this state came from. */
  call_id?: string;
  /** The provider asked us to wait until then (its Retry-After), or a refused connection is tried again then. */
  retry_at?: string;
  /** Why a person must act on this step now; absent when nobody needs to. */
  needs_person?: string;
  /**
   * Payment only: the amount the provider reported, in cents. null when a purchase went out and no amount came back
   * (unknown); absent when no purchase went out. Never an invented 0.
   */
  charged_cents?: number | null;
}

export interface OrderDecision { at: string; action: string; step: StepName | null; note: string }

export interface Order {
  order_id: string;
  customer_id: string;
  created_at: string;
  request: OrderRequest;
  /** sha256 of the request as it was first made, to tell a replay from a different request under the same key. */
  request_sha256: string;
  /** sha256 of the customer's Idempotency-Key. */
  idempotency_key_sha256: string;
  quote: Quote | null;
  steps: Record<StepName, Step>;
  /** When the first provider call that changes something was written ahead: from then on the order cannot be cancelled here. */
  submitted_at: string | null;
  cancel: { asked_at: string; before_submission: boolean; words: string } | null;
  /** The order makes no new provider call that changes anything; reads go on until nothing is pending. */
  halted: { at: string; words: string } | null;
  /** The calendar month (UTC, YYYY-MM) its approval counted against. */
  approved_month: string | null;
  resource_ids: string[];
  /** What a person decided for this order, in order. */
  decisions: OrderDecision[];
}

export type ResourceState = 'active' | 'retained' | 'deleting' | 'deleted';

export interface Resource {
  resource_id: string;
  customer_id: string;
  kind: ResourceKind;
  /** The provider's own identifier: a site id, a domain name, a VPS id; for a certificate, the domain it covers. */
  provider_ref: string;
  name: string;
  order_id: string;
  /** A certificate's site. */
  parent_id: string | null;
  created_at: string;
  state: ResourceState;
  /** A domain's registration end, as the provider reported it. */
  expires_at: string | null;
  retained: { since: string; until: string; words: string } | null;
  deleted: { at: string; deletion_id: string } | null;
}

export type RetentionDecision = 'exported' | 'transfer_to_customer' | 'renew' | 'let_lapse';
export const RETENTION_DECISIONS: readonly RetentionDecision[] = ['exported', 'transfer_to_customer', 'renew', 'let_lapse'];

/** Work for the operator when a customer's Pro is cancelled: export each site and VPS, decide each domain. */
export interface RetentionItem {
  item_id: string;
  customer_id: string;
  resource_id: string;
  kind: 'export' | 'domain_decision';
  opened_at: string;
  /** The retention date: nothing is deleted before it, and nothing after it either without a deletion a person approves. */
  until: string;
  /** A domain's registration end: a person decides before then; the backend never lets a domain lapse silently. */
  expires_at: string | null;
  decision: { decision: RetentionDecision; at: string; note: string } | null;
  closed: { at: string; words: string } | null;
}

export interface DeletionRequest {
  deletion_id: string;
  resource_id: string;
  customer_id: string;
  reason: string;
  requested_at: string;
  decision: { decision: 'approved' | 'refused'; at: string; note: string } | null;
  /** The provider's delete call, as a step: not_started, in_flight, completed, failed, unknown, not_needed (refused). */
  step: Step;
}

/** The write-ahead record of one provider call that changes something. */
export interface CallRecord {
  call_id: string;
  order_id: string | null;
  deletion_id: string | null;
  /** The order's steps this call writes. */
  steps: StepName[];
  /** What was asked of the provider. It carries the call id as its client reference, and never a credential. */
  call: ProviderCall;
  intent_at: string;
  answered_at: string | null;
  /** answered, refused, rate_limited, busy, not_sent, lost, unknown (a 5xx), interrupted; null while it is out. */
  outcome: string | null;
}

export type StepChange =
  | { order_id: string; step: StepName; to: Step }
  | { deletion_id: string; to: Step };

export interface EventBase { v: 1; id: string; at: string }

export type CloudEvent = EventBase & (
  | { type: 'customer.created'; customer: Customer }
  | { type: 'customer.limits'; customer_id: string; limits: Limits }
  | { type: 'billing.notice'; notice_id: string; customer_id: string; state: SubscriptionState; resources: Resource[]; retention: RetentionItem[]; closed_items: Array<{ item_id: string; words: string }> }
  | { type: 'provider.notice'; notice_id: string; reference: string }
  | { type: 'order.created'; order: Order }
  | { type: 'order.quoted'; order_id: string; quote: Quote | null; steps: StepChange[] }
  | { type: 'order.approval'; order_id: string; approved_month: string | null; steps: StepChange[] }
  | { type: 'order.cancel'; order_id: string; before_submission: boolean; words: string; steps: StepChange[] }
  | { type: 'call.intent'; call: CallRecord; steps: StepChange[] }
  | { type: 'call.answer'; call_id: string; outcome: string; http_status: number | null; provider_words: string | null; steps: StepChange[]; resources: Resource[] }
  | { type: 'call.interrupted'; call_id: string; words: string; steps: StepChange[] }
  | { type: 'reconcile.read'; order_id: string | null; deletion_id: string | null; call_id: string | null; read: string; finding: string; steps: StepChange[]; resources: Resource[] }
  | { type: 'person.decided'; order_id: string; action: string; step: StepName | null; note: string; halt: 'set' | 'clear' | null; steps: StepChange[] }
  | { type: 'retention.opened'; customer_id: string; resources: Resource[]; retention: RetentionItem[] }
  | { type: 'retention.decided'; item_id: string; decision: RetentionDecision; note: string }
  | { type: 'deletion.requested'; deletion: DeletionRequest }
  | { type: 'deletion.decided'; deletion_id: string; decision: 'approved' | 'refused'; note: string; steps: StepChange[] }
);

export type CloudEventType = CloudEvent['type'];
export const EVENT_TYPES: readonly CloudEventType[] = [
  'customer.created', 'customer.limits', 'billing.notice', 'provider.notice', 'order.created', 'order.quoted',
  'order.approval', 'order.cancel', 'call.intent', 'call.answer', 'call.interrupted', 'reconcile.read',
  'person.decided', 'retention.opened', 'retention.decided', 'deletion.requested', 'deletion.decided',
];

/** Distributes Omit over a union, so each event kind keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the log gives it its envelope (v, id, at). */
export type CloudEventBody = DistributiveOmit<CloudEvent, keyof EventBase>;

export interface CloudState {
  customers: Record<string, Customer>;
  orders: Record<string, Order>;
  /** `${customer_id}:${idempotency_key_sha256}` → order id. */
  idempotency: Record<string, string>;
  resources: Record<string, Resource>;
  calls: Record<string, CallRecord>;
  retention: Record<string, RetentionItem>;
  deletions: Record<string, DeletionRequest>;
  /** Notice ids already applied (billing and provider), with when. */
  notices: Record<string, string>;
  /** Event ids already applied: a duplicate changes nothing. */
  seen: Set<string>;
  /** Events applied (duplicates not counted). */
  applied: number;
  /** Events skipped as duplicates. */
  duplicates: number;
}
