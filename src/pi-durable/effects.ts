/**
 * Pi Durable, slice S1 (R4 H118): the effect ledger, <project>/.timmy/pi/effects.jsonl (plan e.3.1). Append-only; the
 * worker is its single writer (it holds the store's lock, so there is one worker per project). One line per state:
 * `started` is written BEFORE the effect, `ended` after it with a readback of what is actually there, and `unknown` when
 * a reconciliation could not tell. The key is the tool plus its TARGET (a canonical project path) plus the run, not the
 * raw arguments, so a call whose arguments changed slightly still meets the earlier record (risk k.16).
 *
 * Pi's own words ("interrupted", "aborted") are not evidence of what happened (spike D2: Pi said aborted, the work had
 * finished); this ledger and its readbacks are what Timmy reports.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256Hex } from './owner.js';

export type EffectState = 'started' | 'ended' | 'unknown';

export interface EffectRecord {
  readonly key: string;
  readonly run: string;
  readonly tool: string;
  readonly target: string;
  readonly call_id?: string;
  readonly task?: number;
  readonly args_sha256?: string;
  readonly state: EffectState;
  /** for a compare-and-set write: the bytes it expects to replace, and the bytes it writes ('absent': no file) */
  readonly expected_sha256?: string;
  readonly new_sha256?: string;
  readonly outcome?: string;
  readonly readback?: { readonly sha256: string };
  readonly by: 'tool' | 'reconcile';
  readonly pid: number;
  readonly at: string;
}

export const effectKey = (tool: string, target: string, run: string): string => `${tool}:${target}:${run}`;

/** Canonical JSON (keys sorted) and its sha256, for args_sha256. */
export function argsSha256(args: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    : Array.isArray(v) ? v.map(canon) : v);
  return sha256Hex(JSON.stringify(canon(args)));
}

export class EffectLedger {
  constructor(readonly path: string) {}

  append(r: Omit<EffectRecord, 'pid' | 'at'>): EffectRecord {
    const rec: EffectRecord = { ...r, pid: process.pid, at: new Date().toISOString() };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, { mode: 0o600 }); // one write(2) with O_APPEND
    return rec;
  }

  all(): EffectRecord[] {
    let text = '';
    try { text = readFileSync(this.path, 'utf8'); } catch { return []; }
    const out: EffectRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as EffectRecord); } catch { /* a line cut by a kill mid-write is not a record */ }
    }
    return out;
  }

  /** The newest record of each key. */
  latest(): Map<string, EffectRecord> {
    const m = new Map<string, EffectRecord>();
    for (const r of this.all()) m.set(r.key, r);
    return m;
  }

  /** The newest state of one key ('none' when it has no record). */
  stateOf(key: string): EffectState | 'none' {
    return this.latest().get(key)?.state ?? 'none';
  }

  /** Whether a key's effect is unreconciled: started and never ended, or reconciled to unknown. */
  unreconciled(key: string): EffectRecord | undefined {
    const r = this.latest().get(key);
    return r && (r.state === 'started' || r.state === 'unknown') ? r : undefined;
  }

  /** Every key whose newest record is `started` (an effect whose end was never written: a kill, a crash). */
  open(): EffectRecord[] {
    return [...this.latest().values()].filter((r) => r.state === 'started');
  }

  forRun(run: string): EffectRecord[] {
    return this.all().filter((r) => r.run === run);
  }
}
