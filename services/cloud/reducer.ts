/**
 * Timmy Cloud's backend: the state, rebuilt from the event log by a pure reducer.
 *
 * `reduce(state, event)` returns a new state and never changes its input; `rebuild(events)` folds a whole log. Neither
 * reads a clock, a file or the network: the same events always give the same state. An event whose id was already
 * applied changes nothing (a notice delivered twice, a line written twice).
 *
 * Each event is one line of the log and carries all of its consequences (the steps it moves, the resources it creates),
 * so a crash between two writes leaves a state that was true at some moment, never half of one event.
 */
import type { CloudEvent, CloudState, Resource, StepChange } from './types.js';
import { EVENT_TYPES, STEP_NAMES } from './types.js';

export function emptyState(): CloudState {
  return {
    customers: {}, orders: {}, idempotency: {}, resources: {}, calls: {}, retention: {}, deletions: {}, notices: {},
    seen: new Set<string>(), applied: 0, duplicates: 0,
  };
}

/** A deep copy of a state (the reducer's input is never changed). */
export function cloneState(state: CloudState): CloudState {
  return structuredClone(state);
}

/** Pure: the state after one event. A duplicate (an id already applied) returns an equal state. */
export function reduce(state: CloudState, event: CloudEvent): CloudState {
  const next = cloneState(state);
  applyEvent(next, event);
  return next;
}

/** Pure: the state a log describes. */
export function rebuild(events: Iterable<CloudEvent>): CloudState {
  const state = emptyState();
  for (const e of events) applyEvent(state, e);
  return state;
}

/**
 * Applies one event to `state` in place. Used by `reduce` and `rebuild` on their own copies, and by the engine on the
 * state it owns. Returns false for a duplicate (nothing changed).
 */
export function applyEvent(state: CloudState, e: CloudEvent): boolean {
  if (state.seen.has(e.id)) { state.duplicates += 1; return false; }
  state.seen.add(e.id);
  state.applied += 1;
  switch (e.type) {
    case 'customer.created': {
      state.customers[e.customer.customer_id] = structuredClone(e.customer);
      break;
    }
    case 'customer.limits': {
      const c = state.customers[e.customer_id];
      if (c) c.limits = { ...e.limits };
      break;
    }
    case 'billing.notice': {
      state.notices[e.notice_id] = e.at;
      const c = state.customers[e.customer_id];
      if (c) c.subscription = { state: e.state, since: e.at, source: `billing notice ${e.notice_id}` };
      for (const r of e.resources) state.resources[r.resource_id] = structuredClone(r);
      for (const item of e.retention) state.retention[item.item_id] = structuredClone(item);
      for (const closed of e.closed_items) {
        const item = state.retention[closed.item_id];
        if (item && !item.closed) item.closed = { at: e.at, words: closed.words };
      }
      break;
    }
    case 'provider.notice': {
      state.notices[e.notice_id] = e.at;
      break;
    }
    case 'order.created': {
      const o = structuredClone(e.order);
      state.orders[o.order_id] = o;
      state.idempotency[`${o.customer_id}:${o.idempotency_key_sha256}`] = o.order_id;
      break;
    }
    case 'order.quoted': {
      const o = state.orders[e.order_id];
      if (o && e.quote) o.quote = structuredClone(e.quote);
      applySteps(state, e.steps);
      break;
    }
    case 'order.approval': {
      const o = state.orders[e.order_id];
      if (o && e.approved_month) o.approved_month = e.approved_month;
      applySteps(state, e.steps);
      break;
    }
    case 'order.cancel': {
      const o = state.orders[e.order_id];
      if (o) {
        o.cancel = { asked_at: e.at, before_submission: e.before_submission, words: e.words };
        // After submission the provider operation goes on (there is no cancel operation): the order makes no new call
        // that changes anything, and keeps being reconciled.
        if (!e.before_submission && !o.halted) o.halted = { at: e.at, words: e.words };
      }
      applySteps(state, e.steps);
      break;
    }
    case 'call.intent': {
      state.calls[e.call.call_id] = structuredClone(e.call);
      const o = e.call.order_id ? state.orders[e.call.order_id] : undefined;
      if (o && !o.submitted_at) o.submitted_at = e.at;
      applySteps(state, e.steps);
      break;
    }
    case 'call.answer': {
      const call = state.calls[e.call_id];
      if (call) { call.answered_at = e.at; call.outcome = e.outcome; }
      applySteps(state, e.steps);
      applyResources(state, e.resources);
      break;
    }
    case 'call.interrupted': {
      const call = state.calls[e.call_id];
      if (call) { call.answered_at = e.at; call.outcome = 'interrupted'; }
      applySteps(state, e.steps);
      break;
    }
    case 'reconcile.read': {
      applySteps(state, e.steps);
      applyResources(state, e.resources);
      break;
    }
    case 'person.decided': {
      const o = state.orders[e.order_id];
      if (o) {
        o.decisions.push({ at: e.at, action: e.action, step: e.step, note: e.note });
        if (e.halt === 'set' && !o.halted) o.halted = { at: e.at, words: `A person stopped this order: ${e.note}` };
        if (e.halt === 'clear') o.halted = null;
      }
      applySteps(state, e.steps);
      break;
    }
    case 'retention.opened': {
      applyResources(state, e.resources);
      for (const item of e.retention) state.retention[item.item_id] = structuredClone(item);
      break;
    }
    case 'retention.decided': {
      const item = state.retention[e.item_id];
      if (item && !item.decision) {
        item.decision = { decision: e.decision, at: e.at, note: e.note };
        item.closed = { at: e.at, words: `A person decided: ${e.decision.replace(/_/g, ' ')}.` };
      }
      break;
    }
    case 'deletion.requested': {
      state.deletions[e.deletion.deletion_id] = structuredClone(e.deletion);
      break;
    }
    case 'deletion.decided': {
      const d = state.deletions[e.deletion_id];
      if (d && !d.decision) d.decision = { decision: e.decision, at: e.at, note: e.note };
      applySteps(state, e.steps);
      break;
    }
  }
  return true;
}

function applySteps(state: CloudState, changes: StepChange[]): void {
  for (const c of changes) {
    if ('deletion_id' in c) {
      const d = state.deletions[c.deletion_id];
      if (d) d.step = structuredClone(c.to);
      continue;
    }
    const o = state.orders[c.order_id];
    if (o) o.steps[c.step] = structuredClone(c.to);
  }
}

function applyResources(state: CloudState, resources: Resource[]): void {
  for (const r of resources) {
    state.resources[r.resource_id] = structuredClone(r);
    const o = state.orders[r.order_id];
    if (o && !o.resource_ids.includes(r.resource_id)) o.resource_ids.push(r.resource_id);
  }
}

/** A line of the log that parses is an event only if it has the envelope and a known type. */
export function isCloudEvent(x: unknown): x is CloudEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return e.v === 1 && typeof e.id === 'string' && e.id.length > 0 && typeof e.at === 'string'
    && typeof e.type === 'string' && (EVENT_TYPES as readonly string[]).includes(e.type);
}

/** The step names, in order (re-exported for readers of the state). */
export { STEP_NAMES };
