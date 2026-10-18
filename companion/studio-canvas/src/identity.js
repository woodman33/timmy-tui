// R6 (H139): which project the board on screen belongs to, and the switch from one project's board to another's. The operator's
// words (2026-10-16, priority 1 of the round): "Project identity, board, drafts, jobs, artifact links and save/action targets must
// change together. Block edits while switching." Each project has its own board on disk (src/studio/boards.ts); this module is the
// page's one record of whose board is on screen, so everything that reads, saves or acts names that project, and anything that
// comes back for another project (or for this one, from before a switch) is told apart and kept away from the board on screen.
//
// One identity per page (canvas.js makes it), in four states:
//   none       nothing is loaded yet (the page is starting, or loads no canvas)
//   shown      project P's board is on screen: reading, saving, drafts, jobs, cards and actions are P's
//   switching  the canvas shows project Q now and Q's board is on its way: editing, Accept and Discard are blocked, and nothing of P
//              is shown under Q's name (the board is covered, the drafts and jobs lists cleared, the header says "switching to Q…")
//   paused     the canvas shows a project this page cannot show (another Timmy REPL holds it): no board is shown, nothing acts
// Every switch, pause or load starts a new generation: a request records the generation and the project it was made for
// (`ticket`), and its answer is taken only while both are still the board on screen (`current`); any other is dropped, or kept
// for its own project, and the page says so in its "Kept apart" log (`note`).
//
// H145 (reference images, custom nodes, project-linked artifacts) builds on this: an artifact names its project with `projectOf`,
// and is drawn only when `belongs` says it is the board on screen's.
//
// Imports nothing, so these rules run in Node's tests too (tests/studio-identity-model.test.ts).

/** How long a switch waits for what the board on screen still has on its way (its last save, a decision's record) (ms). */
export const SWITCH_WAIT_MS = 4000;
/**
 * How long a switch waits first for a call of Timmy's already running on the board on screen to end on it (ms): as long as the
 * canvas server waits for a call's answer (src/studio/bridge.ts), after which nothing waits for that call any more.
 */
export const CALL_WAIT_MS = 30_000;
/** How many lines the "Kept apart" log keeps (the newest first). */
export const KEPT_MAX = 12;
/** A project's id, as the canvas server and the receipts name it. */
export const PROJECT_ID = /^[0-9a-f]{16}$/;

const one = (v) => (typeof v === 'string' ? v : '');

/** A project as the server names it ({ id, name }), checked field by field; null for anything else. */
export function projectOf(v) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !PROJECT_ID.test(v.id)) return null;
  const name = one(v.name).replace(/\s+/g, ' ').trim().slice(0, 120);
  return { id: v.id, name: name || v.id };
}

/** Whether two projects are the same one (by id). */
export const sameProject = (a, b) => !!a && !!b && a.id === b.id;

/**
 * The page's identity. `now()` gives the time (ms); `log(words)` is told each line the "Kept apart" log gets (canvas.js writes it to
 * the console and the side panel).
 */
export function createIdentity({ now = () => Date.now(), log = () => {} } = {}) {
  let shown = null;
  let target = null;
  let pausedWords = null;
  let gen = 0;
  const kept = [];
  const api = {
    /** The project whose board is on screen, or null. */
    get project() { return shown; },
    /** The project whose board is on its way, while switching; else null. */
    get switching() { return target; },
    /** Why no board is shown, while paused; else null. */
    get paused() { return pausedWords; },
    get gen() { return gen; },
    get state() { return pausedWords ? 'paused' : target ? 'switching' : shown ? 'shown' : 'none'; },
    /** Project `p`'s board is on screen now (the page loaded it). Its generation. */
    show(p) {
      shown = projectOf(p);
      target = null;
      pausedWords = null;
      gen += 1;
      return gen;
    },
    /** A switch to project `p` begins (its board is on its way). Its generation. */
    begin(p) {
      target = projectOf(p);
      pausedWords = null;
      gen += 1;
      return gen;
    },
    /** The switch of generation `g` ended with project `p`'s board on screen; false when another began since (nothing changes). */
    finish(g, p) {
      if (g !== gen || !target) return false;
      shown = projectOf(p);
      target = null;
      return true;
    },
    /** The canvas shows a project this page cannot show: no board is shown (`words`: why). Its generation. */
    pause(words) {
      pausedWords = one(words) || 'The canvas shows a project this page cannot show.';
      target = null;
      gen += 1;
      return gen;
    },
    /** Whether editing, Accept and Discard are blocked now (switching, paused, or nothing shown yet). */
    blocked() { return target !== null || pausedWords !== null || shown === null; },
    /** What a request records: the generation and the project it is made for (the board on screen's). */
    ticket() { return { gen, project: shown ? shown.id : null }; },
    /** Whether a request made with `t` (ticket) still belongs to the board on screen: same generation, same project, not switching. */
    current(t) { return !!t && t.gen === gen && !!shown && t.project === shown.id && target === null && pausedWords === null; },
    /** Whether something of project `id` belongs to the board on screen now. */
    belongs(id) { return !!shown && id === shown.id && target === null && pausedWords === null; },
    /** A line for the "Kept apart" log (the newest first). */
    note(words) {
      const line = { at: new Date(now()).toISOString(), words: one(words) };
      kept.unshift(line);
      if (kept.length > KEPT_MAX) kept.length = KEPT_MAX;
      try { log(line.words); } catch { /* the log is a courtesy */ }
      return line;
    },
    /** The "Kept apart" log, the newest first. */
    get kept() { return kept.map((l) => ({ ...l })); },
  };
  return api;
}

// ── the words ─────────────────────────────────────────────────────────────────

/** The header's and the cover's words while switching to `to`. */
export const switchingTo = (to) => `switching to ${to ? to.name : 'another project'}…`;

/** Why editing, Accept and Discard are off now, in words (null when they are not). */
export function blockedWords(identity) {
  if (identity.paused) return `${identity.paused} Nothing on this page edits, accepts or discards until the canvas shows a project it can show.`;
  if (identity.switching) return `Studio is switching to ${identity.switching.name}: editing, Accept and Discard wait until ${identity.switching.name}'s board is loaded.`;
  if (!identity.project) return 'No board is loaded yet.';
  return null;
}

/** What the cover over the canvas says while switching from `from` to `to`. */
export function coverWords(from, to) {
  const was = from ? ` ${from.name}'s board, drafts and canvas jobs are saved and put away, as they are.` : '';
  return `Switching to ${to ? to.name : 'another project'}…${was} Nothing of ${from ? from.name : 'the project before'} is shown here under ${to ? `${to.name}'s` : 'its'} name.`;
}

/** What the band says once the switch from `from` to `to` ended. */
export function switchedWords(from, to, via = null) {
  const how = via === 'active' ? ', the active project of this Timmy home' : '';
  const before = from && from.id !== to.id ? ` ${from.name}'s board, drafts and canvas jobs are kept as they were, in ${from.name}.` : '';
  return `Studio shows ${to.name}${how} now: its own board, drafts and canvas jobs.${before}`;
}

/**
 * The "Kept apart" log's words for something of project `of` that came back after the board on screen became another's (`now`): a
 * canvas call (`call`: not run here), a reading (`reading`: the jobs, the drafts, the workspace or the cards of `of`, dropped), a
 * save acknowledgement (`save`: it landed on `of`'s own board), a decision's record (`decision`: recorded in `of`'s drafts record);
 * or a call for the project whose board Studio is still loading (`early`: not run).
 */
export function keptWords(kind, of, now, detail = '') {
  const o = of ? of.name : 'another project';
  const n = now ? now.name : 'no project';
  const d = detail ? ` (${detail})` : '';
  if (kind === 'call') return `A canvas call for ${o}${d} reached this page after Studio left ${o}'s board for ${n}'s: it did not run here, and nothing was drawn on either board.`;
  if (kind === 'early') return `A canvas call for ${o}${d} reached this page while Studio was still loading ${o}'s board: it did not run, and nothing was drawn on either board. Asked again, it runs on ${o}'s board.`;
  if (kind === 'save') return `${o}'s save${d} landed after Studio switched to ${n}: it is kept on ${o}'s own board, and nothing of it is shown here.`;
  if (kind === 'decision') return `The record of a decision on ${o}'s draft${d} was written to ${o}'s own drafts record, after Studio switched to ${n}.`;
  return `A reading of ${o}${d} came back after Studio switched to ${n}: it was dropped, and nothing of it is shown here.`;
}
