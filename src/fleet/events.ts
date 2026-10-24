/**
 * Round R4 (lead): a worker's events, kept twice — as the runtime sent them (redacted) and in Timmy's own words — with a
 * cursor written after every batch so a dropped stream resumes where it stopped and never repeats or loses an event.
 *
 * Redaction runs before anything is written: credential-shaped strings (src/utils/redact.ts), values under key-, token-,
 * secret-, password- and auth-named fields, and home folders (src/utils/home-scrub.ts). A credential never reaches a
 * stored event, a receipt or a page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactString } from '../utils/redact.js';
import { scrubHomes, scrubStrings } from '../utils/home-scrub.js';
import type { NativeEvent } from './backend.js';
import { appendFlushed, readJsonl, writeWhole } from './ledger.js';

export type EventKind = 'session.started' | 'message' | 'tool' | 'child' | 'status' | 'delivered' | 'failed' | 'interrupted' | 'expired' | 'closed' | 'other';

export interface StoredEvent {
  /** Timmy's own order for this worker (1, 2, ...). */
  n: number;
  kind: EventKind;
  at: string;
  text: string;
  /** The runtime's event, redacted, kept as it came. */
  native: NativeEvent;
}

const SENSITIVE_KEY = /key|token|secret|password|auth|credential|cookie/i;

/** A native event with every credential-shaped value and home folder removed. */
export function redactEvent(e: NativeEvent): NativeEvent {
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') return SENSITIVE_KEY.test(key) ? '[REDACTED]' : scrubHomes(redactString(v));
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { ...e, type: redactString(e.type), data: walk(e.data) as Record<string, unknown> };
}

/** Timmy's words for a native event. Upstream "completed" is delivery, never a passed acceptance test. */
export function normalize(e: NativeEvent): { kind: EventKind; text: string } {
  const d = e.data as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === 'string' ? x : x === undefined ? '' : JSON.stringify(x));
  switch (e.type) {
    case 'session.started': return { kind: 'session.started', text: `session started (${s(d.harness)}, ${s(d.model)})` };
    case 'message': return { kind: 'message', text: s(d.text) };
    case 'tool': return { kind: 'tool', text: `${s(d.name)}: ${s(d.output)}`.slice(0, 2000) };
    case 'child.spawned': return { kind: 'child', text: d.sharedWithParent ? `child session ${s(d.child)} started IN THE PARENT'S SANDBOX` : `child session ${s(d.child)} started` };
    case 'session.completed': return { kind: 'delivered', text: `delivered (the runtime said completed; not verified): ${s(d.summary)}` };
    case 'session.failed': return { kind: 'failed', text: `failed: ${s(d.reason)}` };
    case 'session.interrupted': return { kind: 'interrupted', text: 'interrupted' };
    case 'compute.expired': return { kind: 'expired', text: `compute expired (${s(d.computeId)})` };
    case 'session.closed': return { kind: 'closed', text: 'session closed' };
    // R4 (lead, H121's note): the Cloudroom runtime's own kinds, in words (its record is kept beside them, as every event's)
    case 'child.refused': {
      const a = (d.answer ?? {}) as Record<string, unknown>;
      return { kind: 'child', text: `a child request ${s(d.child)} was refused: ${s(a.words)}` };
    }
    case 'receipt': case 'state': case 'child': {
      const core = (d.data ?? {}) as Record<string, unknown>;
      const words = e.type === 'receipt' ? `receipt: ${s(core.command)} ${s(core.state)}` : e.type === 'state' ? `state: ${s(core.state)}` : `child ${s(core.id)}: ${s(core.state)}`;
      return { kind: 'status', text: words.trim() };
    }
    default: return { kind: 'other', text: `${e.type}` };
  }
}

export class WorkerEvents {
  private readonly eventsFile: string;
  private readonly cursorFile: string;
  private n: number;
  private cursorSeq: number;

  constructor(readonly dir: string) {
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.cursorFile = path.join(dir, 'cursor.json');
    const stored = readJsonl<StoredEvent>(this.eventsFile);
    this.n = stored.length ? stored[stored.length - 1].n : 0;
    this.cursorSeq = this.readCursor();
  }

  private readCursor(): number {
    try { return Number((JSON.parse(fs.readFileSync(this.cursorFile, 'utf8')) as { afterSeq: number }).afterSeq) || 0; } catch { return 0; }
  }

  /** The last native event already stored: a reconnect asks for events after this one. */
  get afterSeq(): number { return this.cursorSeq; }

  get count(): number { return this.n; }

  /** Stores one event unless it was stored already (a resent or replayed one); returns it, or undefined for a repeat. */
  add(e: NativeEvent): StoredEvent | undefined {
    if (e.seq <= this.cursorSeq) return undefined;
    const native = redactEvent(e);
    const { kind, text } = normalize(native);
    const stored: StoredEvent = { n: ++this.n, kind, at: native.at, text: scrubStrings(text, (t) => scrubHomes(redactString(t))), native };
    appendFlushed(this.eventsFile, JSON.stringify(stored));
    this.cursorSeq = e.seq;
    writeWhole(this.cursorFile, `${JSON.stringify({ afterSeq: this.cursorSeq, at: new Date().toISOString() })}\n`);
    return stored;
  }

  all(): StoredEvent[] {
    return readJsonl<StoredEvent>(this.eventsFile);
  }
}
