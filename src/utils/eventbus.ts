import { existsSync, readFileSync } from 'fs';
import { notify } from './notify.js';
import { publish as busPublish, busPath, type BusEvent } from '../bus/index.js';
import { appendReceipt } from './receipts.js';

// ONE BUS (ORDER onebus-m5f2): runs.jsonl (src/bus) is the single event stream.
// This module is now a SHIM: appendEvent forwards any straggler write to the
// bus and logs a bus.legacy-write receipt so missed producers are findable;
// it never writes the legacy timmy-events.jsonl. readEvents reads the bus.
export interface TimmyEvent {
  v: 1;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

export function eventsPath(dir: string = process.cwd()): string {
  // legacy path retained for reference only; no writes go here anymore
  return busPath(dir);
}

export function appendEvent(kind: string, payload: Record<string, unknown>, dir?: string): TimmyEvent {
  const ev = busPublish(kind, payload, dir); // forward straggler to the one bus
  try { appendReceipt('runs', { kind: 'run', subject: `bus.legacy-write ${kind}`, policy: 'auto', status: 'ok', spans: [], artifacts: [] }, dir); } catch { /* best effort */ }
  if (kind === 'receipt.sealed') notify('seal', 'TIMMY receipt sealed', `${payload.stream ?? ''} · ${String(payload.hash ?? '').slice(0, 16)}`);
  if (kind === 'approval.required') notify('approval', 'TIMMY approval waiting', String(payload.command ?? '').slice(0, 80));
  return ev;
}

export function readEvents(tail = 0, dir?: string): TimmyEvent[] {
  const p = busPath(dir);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const slice = tail > 0 ? lines.slice(-tail) : lines;
    return slice
      .map(l => { try { return JSON.parse(l) as BusEvent & { hash?: string }; } catch { return null; } })
      .filter((e): e is TimmyEvent => Boolean(e && typeof e.kind === 'string' && typeof e.hash !== 'string')) // bus events only (receipts carry hash)
      .map(e => ({ v: 1, ts: e.ts, kind: e.kind, payload: e.payload }));
  } catch {
    return [];
  }
}
