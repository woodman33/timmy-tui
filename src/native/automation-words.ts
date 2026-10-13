/**
 * macOS's Automation permission in the words both Adobe harnesses use (src/native/illustrator.ts, src/native/ae-author.ts).
 *
 * R4 (r21, ledger row 163): macOS asks about the app Timmy's processes belong to, which is not always a terminal: in r21
 * the question named the app the run was started from. So the words name "the app Timmy runs in" and say that macOS's
 * own question names it, instead of saying "your terminal".
 */

/** Where the operator allows it, word for word. */
export const AUTOMATION_PLACE = 'System Settings › Privacy & Security › Automation';

/** The app macOS asks about: the one Timmy's processes belong to. */
export const HOST_APP = 'the app Timmy runs in (your terminal, or whichever app started Timmy)';
