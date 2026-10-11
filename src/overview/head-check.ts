/**
 * Round R4 (helper H82; the review of 6fb765a..4338fdb, finding 1): the chain head's check, once per head. verifyReceiptIn
 * hashes every receipt of the head's epoch up to it (and checks its signature), and the live board builds God's Eye View on
 * every poll (every 2 s for each open page), so it ran over the whole chain every 2 s. The head is checked on the first
 * build that sees it and again whenever the chain's head changes (another hash, or another length); between those the
 * same check is shown, with the time it ran ("verified at 14:02:11 UTC"), never as a check made now. `timmy verify` checks
 * the whole chain whenever it is run. Nothing here writes or seals anything.
 */
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';

export interface HeadCheck {
  ok: boolean;
  /** why it does not verify */
  reason?: string;
  /** when this check ran (ISO) */
  at: string;
}

const checks = new Map<string, HeadCheck>();
/** How many heads' checks are kept (one per chain this process shows, and the heads before). */
const KEPT = 32;

/** The head's check: run now when this head (by its hash and the chain's length) was not checked yet, else the earlier one. */
export function headCheck(chain: readonly Receipt[], head: Receipt, now: () => Date = () => new Date()): HeadCheck {
  const key = `${chain.length}\0${String(head.hash)}`;
  const had = checks.get(key);
  if (had) return had;
  const v = verifyReceiptIn(chain, String(head.hash));
  const c: HeadCheck = { ok: v.ok, ...(v.ok ? {} : { reason: v.reason }), at: now().toISOString() };
  if (checks.size >= KEPT) checks.delete(checks.keys().next().value as string);
  checks.set(key, c);
  return c;
}

/** When a check ran, as its words say it: "2026-10-10 14:02:11 UTC". */
export const checkedAt = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;
