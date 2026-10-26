/**
 * R13 (found classifying the 030d0942 full suite's REPL failure): the keys typed while a chat turn runs. The turn's Ctrl+C
 * watcher (src/repl/main.ts watchCtrlC) keeps them, Ctrl+C aside, and hands them back to stdin for the next prompt; they
 * were dropped before. A key read by an approval box during the turn (src/repl/approvals.ts readDecision) is that box's
 * answer, so an approval discards what was kept: nothing meant for a question is ever typed into the next prompt.
 */
const kept = new WeakMap<object, Buffer[]>();

/** The turn's watcher starts keeping this stdin's keys; the array it returns fills as they arrive. */
export function keepTurnKeys(stdin: object): Buffer[] {
  const list: Buffer[] = [];
  kept.set(stdin, list);
  return list;
}

/** An approval answered: what the turn kept so far is not a message. */
export function discardTurnKeys(stdin: object): void {
  const list = kept.get(stdin);
  if (list) list.length = 0;
}

/** The watcher stops: its keys, emptied. */
export function endTurnKeys(stdin: object): Buffer | null {
  const list = kept.get(stdin);
  kept.delete(stdin);
  return list && list.length ? Buffer.concat(list) : null;
}
