// R6 lead (PR #100; CI at 8d17ec0, attempt 2 of run 38982594785): how a terminal test tells that THIS turn ended.
//
// The REPL ends each chat turn with its own receipt line, "RECEIPT 1a2b3c4d signed and verified", which names the receipt
// by the first 8 hex digits of its hash. A turn's end is therefore known by identity: a receipt the terminal did not show
// before this turn's Enter. Where a receipt sits on screen does not decide it. The previous turn's receipt can stay on
// screen above this turn's prompt (or show before that prompt reaches the screen at all), and it is never this turn's end.
// The check that failed on CI looked for any receipt line after this turn's prompt, and on the whole screen while the
// prompt was not on it yet; a read made before the prompt reached the screen took the previous turn's receipt for this
// turn's end, so no screen of the answer streaming was counted.

/** One receipt line as the REPL draws it; the capture is its 8 hex digits. */
export const RECEIPT_LINE = /RECEIPT ([0-9a-f]{8}) signed and verified/g;

/** The receipts a screen or a scrollback names, by their 8 hex digits. */
export function receiptsOn(text: string): Set<string> {
  return new Set([...text.matchAll(RECEIPT_LINE)].map((m) => m[1]));
}

/**
 * This turn's receipt, if the screen shows it: the first receipt it names that `before` (the receipts on screen and in the
 * scrollback just before this turn was sent) does not. Null while only earlier turns' receipts are on screen, wherever
 * they are, and whether or not this turn's prompt is on screen yet.
 */
export function newReceipt(screen: string, before: ReadonlySet<string>): string | null {
  for (const m of screen.matchAll(RECEIPT_LINE)) if (!before.has(m[1])) return m[1];
  return null;
}
