// R10 (H167; the round's rule, "technical diagnostics (hashes, bus details, raw commands, ports, paths, ids) in a secondary
// inspector or details control"; H168's F3): what Studio's face says of a record. Its words lose an id, a hash and a place (a
// path): a receipt, a job, a flow and an operation are named by kind, a file by its name. What the face leaves out is in the
// Details (or the tip) beside it, so nothing the face says is new, and nothing is made up. The browser companion's run view
// says them alike (src/companion/client/panel-run.js rvFace).
//
// Imports nothing, so it runs in Node's tests too.

/** An id or a hash: an operation (o + 8 hex), a job (j + 6 hex, or a turn's turn-<hex>), a flow, a hex of 7 to 64 digits. */
export const FACE_ID = /\b(?:o[0-9a-f]{8}|f[0-9a-f]{8}|j[0-9a-f]{6}|turn-[0-9a-f]{6,}|(?:sha256_)?(?=[0-9]*[a-f])[0-9a-f]{7,64})\b/;

/** A file's name: the last part of its path (the folders are its Details). */
export function fileName(p) {
  const s = String(p ?? '').trim().replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** A place in words: a project-relative or home path (two parts or more, joined by "/"). */
const PLACE = /(^|[\s(])((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)+\/?)(?=$|[\s),;:])/g;

/**
 * Words for the face: a part in brackets that names an id or a hash, taken out; a receipt, a job, a flow and an operation
 * named by kind ("its receipt", "the job", "the operation"); a sha256 taken out; a place said by its file's name (a folder,
 * or a place whose last part is an id, taken out).
 */
export function faceWords(w) {
  const kind = (k, word) => (k[0] === k[0].toUpperCase() ? `${word[0].toUpperCase()}${word.slice(1)}` : word);
  return String(w ?? '')
    .replace(/\s*\([^()]*\)/g, (m) => (FACE_ID.test(m) ? '' : m))
    .replace(/\b(prediction |block |edit |flow |run )?(receipt) [0-9a-f]{8}\b/gi, (m, k, r) => kind(k || r, `its ${(k || '').toLowerCase()}receipt`))
    .replace(/\b(job) (?:j[0-9a-f]{6}|turn-[0-9a-f]{6,})\b/gi, (m, k) => kind(k, 'the job'))
    .replace(/\b(flow) f[0-9a-f]{8}\b/gi, (m, k) => kind(k, 'the flow'))
    .replace(/\b(operation) o[0-9a-f]{8}\b/gi, (m, k) => kind(k, 'the operation'))
    .replace(/\bsha256[: ](?:sha256_)?[0-9a-f]{7,}…?,?/g, '')
    // an id said on its own, between the record's separators ("the REPL · o1a2b3c4d", "tray · f1a2b3c4d: wider"): left out
    .replace(/\s*·\s*(?:o[0-9a-f]{8}|f[0-9a-f]{8}|j[0-9a-f]{6}|turn-[0-9a-f]{6,}|(?=[0-9]*[a-f])[0-9a-f]{8})(?=\s*(?:·|:|$))/g, '')
    .replace(PLACE, (m, pre, place) => { const name = fileName(place); return /\/$/.test(place) || !name || FACE_ID.test(name) ? pre : `${pre}${name}`; })
    .replace(/\(\s*\)/g, '')
    .replace(/ {2,}/g, ' ').replace(/\s+([,;:.])(?=\s|$)/g, '$1').replace(/[,;:·]\s*$/, '').trim();
}

/**
 * A record's title for the face: its operation's id before its request taken out ("operation o…: the request"), and a
 * command it starts with said as its word ("/iterate tray" as "iterate tray"; the command itself is the card's, under its
 * Details), then faceWords.
 */
export function faceTitle(t) {
  return faceWords(String(t ?? '').replace(/^\s*operation o[0-9a-f]{8}:\s*/i, '').replace(/^\s*\/([a-z][\w-]*)\b/, '$1'));
}

/**
 * R10 (H167): an event's words on the strip's line, as the companion's activity stream says them (src/companion/client/
 * companion.js eventWords): a job by what it ran (its id dropped), a receipt as sealed, an operation's id left out. The open
 * activity (the strip's Activity) keeps every entry whole.
 */
export function eventFace(w) {
  return String(w ?? '')
    .replace(/\bj[0-9a-f]{6}\b:? ?/g, '')
    .replace(/\breceipt [0-9a-f]{8}\b/g, 'receipt sealed')
    .replace(/\s*\(?\bo[0-9a-f]{8}\b\)?/g, '')
    .replace(/ {2,}/g, ' ').trim();
}
