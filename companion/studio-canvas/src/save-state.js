// R5 (H133): what the page says about saving, in words and a glyph (the operator's order of 2026-10-15: "Show saving, saved and
// failed-to-save states honestly"; "use revision checks and an explicit conflict/recovery path for stale clients and concurrent
// edits; do not silently overwrite newer project or board state").
//
// One state at a time, the first that holds:
//   conflict  ⇄  a save was refused because another window (or Timmy's other page) saved a newer revision first: this page
//                stops saving; Reload takes the newer version (keeping this page's version as a copy first), Keep a copy keeps it
//   stale     ⇄  the canvas on disk is newer than this page's last save (seen before this page tried to save over it): the same
//   refused   ✕  Timmy refused this page's save (its session does not count now): its words say what to do
//   failed    ✕  the last save did not happen (Timmy unreachable, too large, an error): Retry, or the next change, tries again
//   saving    ◔  a save is on its way
//   unsaved   ○  changes not saved yet (saved within a moment)
//   saved     ■  what this page shows is what the file holds, at that revision
// Every state that needs the person (conflict, stale, refused, failed) is amber; none is green: a save is not a verification.
// Imports nothing, so it runs in Node's tests too.

export const SAVE_GLYPH = Object.freeze({ conflict: '⇄', stale: '⇄', refused: '✕', failed: '✕', saving: '◔', unsaved: '○', saved: '■' });

const clock = (iso) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

/**
 * The save state of `c`: { revision, savedRevision, savedAt, saving, conflict ({ words, revision } | null), stale ({ revision } |
 * null), refused (words | null), failed (words | null), kept (where this page's version was kept, or null) }.
 * Returns { state, glyph, words, needsYou }.
 */
export function saveState(c) {
  const unsaved = c.revision - c.savedRevision;
  const changes = unsaved > 0 ? `This page's ${unsaved === 1 ? 'change' : `${unsaved} changes`} since revision ${c.savedRevision} ${unsaved === 1 ? 'is' : 'are'} not saved.` : 'This page has no unsaved changes.';
  const kept = c.kept ? ` This page's version was kept as ${c.kept}.` : '';
  if (c.conflict) {
    const at = Number.isInteger(c.conflict.revision) ? ` (revision ${c.conflict.revision})` : '';
    return { state: 'conflict', glyph: SAVE_GLYPH.conflict, needsYou: true, words: `Not saved: a newer version of this canvas is on disk${at}, saved after this page opened it. ${changes} Nothing was overwritten.${kept}` };
  }
  if (c.stale) {
    return { state: 'stale', glyph: SAVE_GLYPH.stale, needsYou: true, words: `A newer version of this canvas is on disk (revision ${c.stale.revision}), saved after this page's last save (revision ${c.savedRevision}). ${changes} This page will not save over it.${kept}` };
  }
  if (c.refused) return { state: 'refused', glyph: SAVE_GLYPH.refused, needsYou: true, words: `Not saved: ${c.refused}` };
  if (c.failed) return { state: 'failed', glyph: SAVE_GLYPH.failed, needsYou: true, words: `Failed to save revision ${c.revision}: ${c.failed} The next change tries again; Retry tries now.` };
  if (c.saving) return { state: 'saving', glyph: SAVE_GLYPH.saving, needsYou: false, words: `Saving revision ${c.revision}…` };
  if (unsaved > 0) return { state: 'unsaved', glyph: SAVE_GLYPH.unsaved, needsYou: false, words: `Not saved yet: revision ${c.revision} (saving in a moment).` };
  const when = c.savedAt ? clock(c.savedAt) : null;
  return { state: 'saved', glyph: SAVE_GLYPH.saved, needsYou: false, words: c.savedRevision === 0 && !c.savedAt ? 'Saved: nothing drawn yet (revision 0).' : `Saved: revision ${c.savedRevision}${when ? `, at ${when}` : ''}.` };
}
