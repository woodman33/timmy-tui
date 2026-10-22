// R5 (H133): the shared workspace frame on Timmy Studio. src/contracts/workspace.ts is the one frame the terminal Workbench,
// the browser companion and Studio draw around their own content; src/ops/workspace-frame.ts makes it from the records, and the
// canvas server serves it at GET /api/workspace to this page's session (./cards.js workspace). DESIGN.md §10 B10 "Layouts": a
// stable tab header with one amber active tab, a workflow-actions bar whose one primary next step is amber, and the activity.
//
// Drawn here as a compact strip above tldraw (index.html #frame; the canvas starts below it, so it never covers tldraw's menus
// or toolbar): TIMMY · the project; the ten tabs as labels, Studio active (this page cannot hold the companion's token, so the
// others say where they open, and none is a link); the Studio tab's actions, each with its command to copy, the one primary
// amber; and one line of activity: what runs, what waits on you, Stop current and the newest log line. No key of tldraw's is
// taken here: Escape closes the activity's entries only while the focus is in the strip. Every text is set as text. Imports
// only ./when.js (the one time format, which imports nothing) and (R10 H167) ./face.js (the face's words, which imports nothing).
//
// R5 (H137): the actions wrap onto more rows and are never cut or scrolled sideways: each keeps its number, label, command and
// Copy on screen (an action wider than the window wraps its label and shortens the command it shows, with an ellipsis; Copy
// copies the whole command, which is the command's title and in Copy's own name), the one primary first. The activity is a
// disclosure (#frame-activity-toggle, collapsed at first): open, it lists the frame's newest entries, at most LOG_MAX; the
// log and the project's sealed chat turns merged as the companion and the Workbench merge them (src/companion/client/
// companion.js eventsOf), and the collapsed line's newest is that merge's. A chat turn being answered now is named on the line,
// with since when (the frame's `since`, in the one time format of ./when.js), and Stop current is the frame's own words.
//
// It redraws only when what it shows changed: the frame's revision also follows what the strip does not show (a connection's
// age, "12 s ago"), and a redraw takes a focused Copy button from under a person. A frame that is not read now stays drawn and
// says so at the line's end: why, and when it was last read.

import { clockOf } from './when.js';
// R10 (H167): the line's newest in words, as the companion's activity stream says it (no id of a job, a receipt or an operation)
import { eventFace } from './face.js';

// R7 (H151; the operator's order of 2026-10-16, 22:08 PT: "Make Studio's primary action reflect the actual next step when a draft
// is waiting"): while the board holds a draft, the frame's one Studio primary is its Accept or Discard (src/ops/workspace-frame.ts
// actionsOf, the lead's 2ee969f). This page is where that is done: the strip draws that primary with "Go to the draft", which
// shows the draft on the board and puts the focus on its Accept (canvas.js goToDraft); the strip's primary and the draft's Accept
// are one step. What the page itself just did shows at once (`local`: a draft it accepted or discarded is no longer the step, and
// the waiting it counted is one less until the frame is read again, which is at once); and while something runs or a chat turn is
// being answered the frame is read every FRAME_FAST_MS, so a stop made on another surface shows within half a second. The tabs
// whose intended interactions do not all work yet (TabDef.unfinished, on the frame's tabs[]) carry a mark that is not colour
// alone, and the strip's own description says, in the frame's words, what works on each now and what does not yet.

/** The tab this page is. */
export const STUDIO_TAB = 'studio';
/** What a tab this page cannot open says, as its title. */
export const ELSEWHERE = 'c in the Workbench shows the companion';
/** How often the frame is read while the page is shown (and only then). */
export const FRAME_EVERY_MS = 4000;
/** R7 (H151): how often while the frame says something runs or a chat turn is being answered (a stop shows within ~0.5 s). */
export const FRAME_FAST_MS = 250;
/** The frame's schema this strip draws. */
export const FRAME_SCHEMA = 'timmy.workspace/1';
/** R5 (H137): how many of the frame's newest entries the open activity lists. */
export const LOG_MAX = 8;
/**
 * R7 (H151): the frame's draft step, by its command: "Accept or Discard on the draft, in Studio" (Studio observed), or "/studio,
 * then Accept or Discard on the draft" (src/ops/workspace-frame.ts actionsOf). The frame's words; none is made here.
 */
export const DRAFT_STEP = /\bAccept or Discard on the draft\b/;
/** R7 (H151): whether a frame's action is the draft step (its Accept or Discard, done on the draft on this page). */
export const isDraftStep = (a) => !!a && typeof a.command === 'string' && DRAFT_STEP.test(a.command);
/** R7 (H151): the mark an unfinished tab carries beside its label (its words are in the strip's description, #frame-unf). */
export const UNFINISHED_MARK = '◌';

const one = (v) => (typeof v === 'string' ? v : '');
const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
/** R7 (H151): a tab's `unfinished` as the frame carries it (both words, as strings), else null: never made up. */
const unfinishedOf = (u) => (u && typeof u === 'object' && typeof u.works === 'string' && u.works.trim() && typeof u.missing === 'string' && u.missing.trim()
  ? { works: u.works.replace(/\s+/g, ' ').trim(), missing: u.missing.replace(/\s+/g, ' ').trim() } : null);
/** R7 (H151): when the strip reads the frame next after drawing `view`: soon while something runs, else at its usual pace. */
export const nextReadMs = (view) => (view && view.activity && (view.activity.running > 0 || view.activity.turn) ? FRAME_FAST_MS : FRAME_EVERY_MS);
const TONES = new Set(['neutral', 'attention', 'live', 'failure']);
/** A record's time as the strip shows it (the time of day, this computer's clock), in the one format (./when.js). */
const clock = (at) => clockOf(at);

/**
 * R5 (H137; the lead's merge of 2026-10-15): the frame's log and its sealed chat turns as one list, the newest first, as the
 * companion merges them (src/companion/client/companion.js eventsOf) and the Workbench lists them: a turn is an entry tagged
 * chat, its receipt the entry's source, in the failure tone when it failed. Each entry as the strip shows it.
 */
export function eventsOf(f) {
  const entry = (e) => ({
    at: one(e.at), clock: clock(e.at), tag: one(e.tag) || 'event', words: one(e.words).replace(/\s+/g, ' ').trim(),
    tone: TONES.has(e.tone) ? e.tone : 'neutral', operation: one(e.operation), source: one(e.source),
  });
  const log = Array.isArray(f.log) ? f.log.filter((e) => e && typeof e === 'object').map(entry) : [];
  const turns = f.chat && typeof f.chat === 'object' && Array.isArray(f.chat.turns) ? f.chat.turns.filter((t) => t && typeof t === 'object').map((t) => entry({
    at: t.at, tag: 'chat', words: t.words, tone: t.state === 'failed' ? 'failure' : 'neutral', operation: t.operation, source: `receipt ${one(t.receipt)}`,
  })) : [];
  return [...log, ...turns].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/**
 * What the strip shows for `frame` (pure; null for anything that is not a frame of this schema). It decides nothing: the tabs,
 * the actions and their one primary, the counts and the newest line are the frame's own. A second primary, which the frame
 * never sends, is drawn as an ordinary action, so the strip never shows two.
 *
 * R7 (H151): `local`, optional: what this page knows of its own board now ({ drafts }: its pending drafts, on every page of the
 * board; null when it shows none, or is switching). A frame made before the page's own Accept or Discard still names the draft
 * step: with no draft left on the board, that step is drawn as decided (no primary: the frame read next, at once, names the next
 * one) and the waiting it counted (the drafts count once, src/ops/waiting.ts) is one less. Nothing else of the frame is changed.
 */
export function frameView(frame, local = null) {
  const f = frame && typeof frame === 'object' ? frame : null;
  if (!f || f.schema !== FRAME_SCHEMA || !f.project || typeof f.project !== 'object' || !Array.isArray(f.tabs)) return null;
  const tabs = f.tabs.filter((t) => t && typeof t === 'object').map((t) => {
    const label = one(t.label);
    const active = t.id === STUDIO_TAB;
    const unfinished = unfinishedOf(t.unfinished);
    // R7 (H151): an unfinished tab's title says so in the frame's words (the strip's description, #frame-unf, says it on the page)
    const where = active ? 'this page' : ELSEWHERE;
    const title = unfinished ? `${label}: unfinished. Works now: ${unfinished.works}. Not yet: ${unfinished.missing}. Where it opens: ${where}` : `${label}: ${where}`;
    return { id: one(t.id), key: one(t.key), label, waiting: count(t.waiting), active, unfinished, title };
  });
  let primary = false;
  const asked = f.actions && typeof f.actions === 'object' && Array.isArray(f.actions[STUDIO_TAB]) ? f.actions[STUDIO_TAB] : [];
  const actions = asked.filter((a) => a && typeof a === 'object').map((a) => {
    const first = a.primary === true && !primary;
    if (first) primary = true;
    return { n: Number.isInteger(a.n) ? a.n : 0, label: one(a.label), command: one(a.command), primary: first, enabled: a.enabled !== false, why: one(a.why), draft: isDraftStep(a), decided: false };
  });
  // R5 (H137): the one primary first in reading order (the frame sends it first; the strip makes sure), the rest in the frame's
  // order, each with the number the frame gave it
  actions.sort((a, b) => Number(b.primary) - Number(a.primary));
  const act = f.activity && typeof f.activity === 'object' ? f.activity : {};
  const stop = act.stopCurrent && typeof act.stopCurrent === 'object' ? act.stopCurrent : {};
  // R5 (H137): the log and the sealed chat turns, merged; the line's newest is the merge's newest
  const events = eventsOf(f);
  const top = events[0] ?? null;
  const noLog = Array.isArray(f.unknown) ? f.unknown.find((u) => u && u.field === 'log') : null;
  let waiting = count(act.waitingOnYou);
  // R7 (H151): the page's own decision, shown at once (see above)
  const decided = !!local && local.drafts === 0 && actions.some((a) => a.draft && a.primary);
  if (decided) {
    for (const a of actions) if (a.draft) { a.primary = false; a.decided = true; }
    waiting = Math.max(0, waiting - 1);
    for (const t of tabs) if (t.waiting > 0) t.waiting -= 1;
  }
  return {
    revision: one(f.revision),
    project: { name: one(f.project.name), shown: one(f.project.shown) },
    tabs,
    actions,
    decided,
    activity: {
      running: count(act.running),
      waiting,
      stop: { job: typeof stop.job === 'string' && stop.job ? stop.job : null, words: one(stop.words) },
      turn: act.chatTurn && typeof act.chatTurn === 'object' ? one(act.chatTurn.words) : '',
      // R5 (H137, after the lead's 0f9f8cb: the frame's words carry no clock time, each surface shows `since` in its one format)
      turnSince: act.chatTurn && typeof act.chatTurn === 'object' ? clock(act.chatTurn.since) : '',
      newest: top ? { at: top.clock, words: top.words, tone: top.tone, tag: top.tag } : null,
      noLog: noLog ? one(noLog.why) : '',
    },
    log: events.slice(0, LOG_MAX),
  };
}

function el(tag, cls, text, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
const sep = () => el('span', 'fr-sep', ' · ', { 'aria-hidden': 'true' });
/** R10 (H167): what a step's Copy says (it copies the step's command for Timmy's terminal). */
export const COPY_LABEL = 'Copy command';
/**
 * A command to type, and its Copy button (the strip's one click handler copies it). R5 (H137): kept together, the command
 * shortened with an ellipsis where the row is narrower than it; its title is the whole command, and Copy's name says it whole.
 * R10 (H167; the round's rule: raw commands in a secondary inspector): the command itself is shown only while the strip's
 * Commands is open (#frame[data-commands="shown"]); Copy stays, its name and its tip saying the command whole.
 */
const commandOf = (command) => {
  const does = el('span', 'fr-do');
  does.append(el('code', 'fr-cmd', command, { title: command }), el('button', 'fr-copy', COPY_LABEL, { type: 'button', 'data-copy': command, 'data-label': COPY_LABEL, title: `Copy ${command}`, 'aria-label': `Copy ${command}` }));
  return does;
};

/** R5 (H137): one entry of the open activity: its time, its tag, its words, and its operation when it names one. */
function logItem(e) {
  const li = el('li', `fr-entry is-${e.tone}`, null, { 'data-tag': e.tag });
  if (e.source) li.title = `From ${e.source}`;
  const failed = e.tone === 'failure';
  li.append(el('time', 'fr-time', e.clock, { datetime: e.at }), ' ', el('span', `fr-tag is-${e.tone}`, `${failed ? '✕ ' : ''}[${e.tag}]`), ' ', el('span', 'fr-words', e.words));
  if (e.operation) li.append(' ', el('span', 'fr-op', e.operation));
  return li;
}

/** R7 (H151): the words of the draft step's control on this page, and what it does (its title adds the frame's own command). */
export const GO_TO_DRAFT = 'Go to the draft';
const GO_DOES = 'shows the draft on the board and puts the focus on its Accept';
/** R7 (H151): what a draft step the page itself just decided says, until the frame read next (at once) names the next step. */
export const DECIDED_WORDS = 'decided on this page: reading Studio\'s next step…';

/** R7 (H151): the id of an unfinished tab's entry in the strip's description (#frame-unf), for its aria-describedby. */
const unfId = (t) => `fr-unf-${t.id || t.key}`;

/** Draws `view` (frameView) into the strip's parts under `root` (index.html #frame). */
export function drawFrame(root, view) {
  const project = root.querySelector('#frame-project');
  project.textContent = view.project.name || 'a project';
  project.title = view.project.shown ? `The project's folder: ${view.project.shown}` : '';
  root.querySelector('#frame-tabs').replaceChildren(...view.tabs.map((t) => {
    const li = el('li', `fr-tab${t.active ? ' is-active' : ''}${t.unfinished ? ' is-unfinished' : ''}`, null, { 'data-tab': t.id, title: t.title });
    if (t.active) li.setAttribute('aria-current', 'page');
    li.append(el('span', 'fr-key', t.key), ` ${t.label}`);
    // R7 (H151): an unfinished tab's mark is a glyph, never colour alone; its words are the strip's description entry it names
    if (t.unfinished) {
      li.append(' ', el('span', 'fr-unf-mark', UNFINISHED_MARK, { 'aria-hidden': 'true' }));
      li.setAttribute('aria-describedby', unfId(t));
    }
    if (t.waiting) li.append(' ', el('span', 'fr-count', `${t.waiting} waiting`));
    return li;
  }));
  // R7 (H151): the strip's own description of the unfinished tabs, in the frame's words (TabDef.unfinished), where it is read:
  // under the tabs, opened by its button (#frame-unf-toggle, which says how many); every word is the frame's
  const unfinished = view.tabs.filter((t) => t.unfinished);
  const unfList = root.querySelector('#frame-unf');
  const unfToggle = root.querySelector('#frame-unf-toggle');
  if (unfList) {
    unfList.replaceChildren(...unfinished.map((t) => {
      const li = el('li', 'fr-unf-entry', null, { id: unfId(t), 'data-tab': t.id });
      li.append(el('strong', 'fr-unf-tab', `${UNFINISHED_MARK} ${t.key} ${t.label}`), ' ', el('span', 'fr-unf-word', 'unfinished.'), ' ',
        el('span', 'fr-unf-k', 'Works now:'), ' ', el('span', 'fr-unf-works', t.unfinished.works), el('span', 'fr-unf-sep', '. '),
        el('span', 'fr-unf-k', 'Not yet:'), ' ', el('span', 'fr-unf-missing', t.unfinished.missing), '.');
      return li;
    }));
  }
  if (unfToggle) {
    unfToggle.hidden = unfinished.length === 0;
    unfToggle.dataset.count = String(unfinished.length);
    const open = unfToggle.getAttribute('aria-expanded') === 'true';
    unfToggle.textContent = `${open ? '▾' : '▸'} ${UNFINISHED_MARK} ${unfinished.length} unfinished`;
    if (!unfinished.length && unfList) unfList.hidden = true;
  }
  root.querySelector('#frame-acts').replaceChildren(...view.actions.map((a) => {
    const li = el('li', `fr-act${a.primary ? ' is-primary' : ''}${a.enabled ? '' : ' is-off'}${a.draft ? ' is-draft' : ''}${a.decided ? ' is-done' : ''}`, null, { 'data-n': a.n });
    // R5 (H137): the number stays with its label (the label wraps under itself on a narrow window), the command with Copy
    const head = el('span', 'fr-head');
    head.append(el('span', 'fr-n', a.n), ' ', el('span', 'fr-label', a.label));
    if (a.decided) {
      // R7 (H151): the page's own Accept or Discard: no longer the step, said so, until the next frame names the next one
      li.append(head, ' ', el('span', 'fr-why fr-decided', `✓ ${DECIDED_WORDS}`));
      return li;
    }
    if (a.draft) {
      // R7 (H151): the draft step is done here, on the draft: its control takes you there (the frame's command is its title)
      li.append(head, ' ', el('button', 'fr-go', GO_TO_DRAFT, { type: 'button', 'data-go': 'draft', title: `${a.command}: ${GO_DOES}`, 'aria-label': `${GO_TO_DRAFT}: ${GO_DOES}` }));
    } else {
      li.append(head, ' ', commandOf(a.command));
    }
    if (!a.enabled && a.why) li.append(' ', el('span', 'fr-why', a.why));
    if (a.primary) li.title = 'The next step';
    return li;
  }));
  const act = view.activity;
  const line = root.querySelector('#frame-activity');
  const running = el('span', 'fr-running', `${act.running} running`);
  const parts = [running];
  // R7 (H151): a part the line may shorten (with an ellipsis, on a narrow window) says itself whole in its title
  const whole = (cls, words) => el('span', cls, words, { title: words });
  // R5 (H137; the lead's ask): a chat turn being answered now is named on the line, as the companion's mirror names it
  if (act.turn) parts.push(sep(), whole('fr-turn', `▶ ${act.turn}${act.turnSince ? ` (since ${act.turnSince})` : ''}`));
  parts.push(sep(), el('span', `fr-waiting${act.waiting ? ' is-waiting' : ''}`, `${act.waiting} waiting on you`));
  // R5 (H137; QA defect 9): Stop current in the frame's own words, as each frame gives them (none made here: a frame without
  // them shows none), with /stop to copy while it names a job
  if (act.stop.words) {
    parts.push(sep(), whole('fr-stop', act.stop.words));
    if (act.stop.job) parts.push(commandOf('/stop'));
  }
  parts.push(sep());
  if (act.newest) {
    const failed = act.newest.tone === 'failure';
    // R10 (H167): in words (eventFace: no id of a job, a receipt or an operation); the open activity lists each entry whole
    parts.push(whole(`fr-log is-${act.newest.tone}`, `newest: ${act.newest.at} ${failed ? '✕ ' : ''}${eventFace(act.newest.words)}`.replace(/\s+/g, ' ').trim()));
  } else {
    parts.push(whole('fr-log is-neutral', `newest: none yet${act.noLog ? ` (${act.noLog})` : ''}`));
  }
  parts.push(el('span', 'fr-note', '', { id: 'frame-note' }));
  line.replaceChildren(...parts);
  // R5 (H137): the open activity's entries (drawn whether it is open or not, so opening it shows them at once)
  const list = root.querySelector('#frame-log');
  if (list) {
    list.replaceChildren(...(view.log.length ? view.log.map(logItem) : [el('li', 'fr-entry is-neutral fr-empty', `Nothing in the log yet${act.noLog ? `: ${act.noLog}` : ''}.`)]));
  }
}

/** Copies `text`: the clipboard when the page may write it, else a selection; true when it was copied. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* the selection below */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Why a reading of the frame did not draw, in words (a refusal's own words come from the server, or from the page's session). */
function notRead(r) {
  if (r && r.ok && r.body && r.body.ok === true) return `the frame Timmy sent is not one this page draws (it draws ${FRAME_SCHEMA}).`;
  const said = r && r.body && typeof r.body === 'object' ? one(r.body.error) : '';
  return said || `Timmy answered ${r ? r.status : 'nothing'} for the workspace.`;
}

/**
 * The strip: reads the frame now and every FRAME_EVERY_MS while the page is shown, one reading at a time, and redraws it only when
 * what it shows changed (`data-revision` is the frame last read). `read` gives { status, ok, body } (./cards.js workspace; one not
 * asked now says why in body.error). A reading that does not count keeps the last frame drawn, marks it (`data-stale`) and says at
 * the line's end why, and when it was last read. R5 (H137): `open(true|false)` opens or closes the activity's entries, as the
 * button does.
 *
 * R6 (H139; Studio project isolation): `accept(frame, reading)`, optional: whether a frame is of the board on screen's project, and
 * was read since the last switch (canvas.js: `reading` is what `read` gave, with what canvas.js recorded in it); one that is not is
 * never drawn, and `other(frame, reading)` is told of it (the canvas may show another project now). `held()`, optional: the
 * words the header shows instead of a frame while Studio switches boards (null when it does not): nothing of the frame before (its
 * actions, its activity, its log) stays on screen then. `hold(words)` and `release(name)`: Studio began, and ended, a switch
 * (`name`: the project whose board is on screen now, shown until its frame is read).
 */
export function createFrameStrip({ root, read, copy = copyText, everyMs = FRAME_EVERY_MS, fastMs = FRAME_FAST_MS, accept = null, held = null, other = null, local = null, go = null }) {
  let drawn = '';
  let readAt = '';
  let busy = false;
  /** R7 (H151): a reading asked while one is on its way (`soon`): made as soon as that one ends */
  let again = false;
  /** R7 (H151): the frame last drawn, so the page's own state can be drawn over it at once (`redraw`) */
  let last = null;
  let timer = null;
  let stopped = false;
  /** R7 (H151): what the page knows of its own board now (./frame.js frameView `local`); null when it is not known */
  const localNow = () => { try { return local ? local() : null; } catch { return null; } };
  /** R7 (H151): the next reading, `ms` from now: soon while something runs, else at the usual pace (one timer, never two) */
  const schedule = (ms) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => { void tick(); }, ms);
  };
  /** Draws `view` when what it shows changed (a focused Copy button stays where it is otherwise). */
  const draw = (view) => {
    const shows = JSON.stringify({ ...view, revision: '' });
    if (shows !== drawn) {
      drawFrame(root, view);
      drawn = shows;
      return true;
    }
    return false;
  };
  /** R6 (H139): the header while Studio switches boards: nothing of the frame before, only where it goes */
  const holdNow = (words) => {
    if (!words) return false;
    root.dataset.switching = 'true';
    root.dataset.stale = 'false';
    root.querySelector('#frame-project').textContent = words;
    root.querySelector('#frame-project').title = '';
    for (const t of root.querySelectorAll('#frame-tabs .fr-count')) t.remove();
    root.querySelector('#frame-acts').replaceChildren();
    const line = root.querySelector('#frame-activity');
    line.replaceChildren(el('span', 'fr-log is-neutral', `${words} The workspace of the project Studio shows next is read once its board is loaded.`), el('span', 'fr-note', '', { id: 'frame-note' }));
    const list = root.querySelector('#frame-log');
    if (list) list.replaceChildren();
    drawn = '';
    return true;
  };
  const note = (words) => {
    const n = root.querySelector('#frame-note');
    if (n) n.textContent = words ? ` · ${words}` : '';
    else if (words) root.querySelector('#frame-activity').textContent = words;
  };
  const stale = (why) => {
    root.dataset.stale = 'true';
    note(readAt ? `${why} Shown as last read at ${readAt}.` : why);
  };
  /** R7 (H151): how soon the next reading comes after one: the frame last drawn says (something runs: soon) */
  let pace = everyMs;
  async function tick() {
    if (stopped) return;
    // R7 (H151): a reading asked while one is on its way is made right after it, never dropped (`soon`)
    if (busy) { again = true; return; }
    if (document.visibilityState !== 'visible') { schedule(everyMs); return; }
    if (held && holdNow(held())) { schedule(everyMs); return; }
    busy = true;
    try {
      const r = await read();
      // R6 (H139): a frame of another project than the board on screen's is never drawn (the canvas shows another now)
      if (held && holdNow(held())) return;
      const frame = r && r.ok && r.body && r.body.ok === true ? r.body.frame : null;
      if (frame && accept && !accept(frame, r)) {
        stale('Workspace not read now: the frame Timmy sent is of another project than the board on screen (Studio follows the canvas to it).');
        try { other?.(frame, r); } catch { /* the next reading follows */ }
        return;
      }
      if (r && r.status === 409 && r.body && r.body.notShown) {
        stale(`Workspace not read now: ${notRead(r)}`);
        try { other?.(r.body.shows ? { project: r.body.shows } : null, r); } catch { /* the next reading follows */ }
        return;
      }
      const view = frame ? frameView(frame, localNow()) : null;
      if (!view) { stale(`Workspace not read now: ${notRead(r)}`); return; }
      last = frame;
      pace = nextReadMs(view) === FRAME_FAST_MS ? fastMs : everyMs;
      readAt = clock(new Date().toISOString());
      root.dataset.revision = view.revision;
      root.dataset.stale = 'false';
      root.dataset.switching = 'false';
      if (!draw(view)) note('');
    } catch (e) {
      stale(`Workspace not read now: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      if (again) { again = false; void tick(); } else schedule(pace);
    }
  }
  root.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    // R7 (H151): the draft step's control takes you to the draft (canvas.js goToDraft); a person's press only, as Accept is
    const goes = target ? target.closest('button[data-go]') : null;
    if (goes && root.contains(goes)) {
      if (e.isTrusted === true) { try { go?.(goes.dataset.go); } catch { /* the page says why, in its band */ } }
      return;
    }
    // R7 (H151): the unfinished tabs' description opens and closes under the tabs
    const unf = target ? target.closest('#frame-unf-toggle') : null;
    if (unf && root.contains(unf)) { setUnfinished(unf.getAttribute('aria-expanded') !== 'true'); return; }
    // R10 (H167): the steps' commands, shown or not (the strip's inspector of them)
    const cmds = target ? target.closest('#frame-cmds-toggle') : null;
    if (cmds && root.contains(cmds)) { setCommands(cmds.getAttribute('aria-expanded') !== 'true'); return; }
    const b = target ? target.closest('button[data-copy]') : null;
    if (!b || !root.contains(b)) return;
    const command = b.dataset.copy;
    void copy(command).then((ok) => {
      b.textContent = ok ? 'Copied' : 'Not copied';
      setTimeout(() => { if (b.isConnected) b.textContent = b.dataset.label || 'Copy'; }, 1500);
    });
  });
  /**
   * R10 (H167): the steps' commands for Timmy's terminal (each step's code.fr-cmd, and Stop current's), shown or not by the
   * strip's Commands (#frame-cmds-toggle): hidden at first, so the strip says each step in words; Copy copies either way.
   */
  const setCommands = (open) => {
    const t = root.querySelector('#frame-cmds-toggle');
    root.dataset.commands = open ? 'shown' : 'hidden';
    if (!t) return;
    t.setAttribute('aria-expanded', String(open));
    t.textContent = `${open ? '▾' : '▸'} Commands`;
    t.title = open ? "Hides the steps' commands (Copy still copies each)" : "Shows each step's command for Timmy's terminal beside its Copy";
  };
  /** R7 (H151): the unfinished tabs' description (#frame-unf), opened or closed by its button (#frame-unf-toggle) */
  const setUnfinished = (open) => {
    const t = root.querySelector('#frame-unf-toggle');
    const list = root.querySelector('#frame-unf');
    if (!t || !list) return;
    t.setAttribute('aria-expanded', String(open));
    const n = Number(t.dataset.count) || list.children.length;
    t.textContent = `${open ? '▾' : '▸'} ${UNFINISHED_MARK} ${n} unfinished`;
    t.title = open ? 'Hides what works on the unfinished tabs and what does not yet' : 'Shows what works on each unfinished tab now and what does not yet, in the frame\'s words';
    list.hidden = !open;
  };
  // R5 (H137): the activity's disclosure: collapsed at first; its button opens and closes the newest entries, and Escape closes
  // them while the focus is in the strip (tldraw's own Escape, on the canvas, is left alone), the focus then on the button
  const toggle = root.querySelector('#frame-activity-toggle');
  const entries = root.querySelector('#frame-log');
  const setOpen = (open) => {
    if (!toggle || !entries) return;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '▾ Activity' : '▸ Activity';
    toggle.title = open ? 'Hides the frame\'s newest entries' : `Shows the frame's newest entries (at most ${LOG_MAX})`;
    entries.hidden = !open;
  };
  const isOpen = () => toggle?.getAttribute('aria-expanded') === 'true';
  toggle?.addEventListener('click', () => setOpen(!isOpen()));
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // R7 (H151): Escape in the strip closes what is open there: the activity's entries first, else the unfinished tabs' words
    const unf = root.querySelector('#frame-unf-toggle');
    const cmds = root.querySelector('#frame-cmds-toggle');
    if (isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      toggle.focus();
    } else if (unf && unf.getAttribute('aria-expanded') === 'true') {
      e.preventDefault();
      e.stopPropagation();
      setUnfinished(false);
      unf.focus();
    } else if (cmds && cmds.getAttribute('aria-expanded') === 'true') {
      e.preventDefault();
      e.stopPropagation();
      setCommands(false);
      cmds.focus();
    }
  });
  setOpen(false);
  setUnfinished(false);
  setCommands(false);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void tick(); });
  void tick();
  /** R6 (H139): Studio began a switch: the header says so at once, and reads no frame until it ends. */
  const hold = (words) => { holdNow(words || 'switching…'); };
  /** R6 (H139): Studio ended a switch: the header names the project on screen until its own frame is read (at once). */
  const release = (name) => {
    drawn = '';
    last = null;
    root.dataset.switching = 'false';
    root.querySelector('#frame-project').textContent = name || 'a project';
    const line = root.querySelector('#frame-activity');
    line.replaceChildren(el('span', 'fr-log is-neutral', `reading the workspace of ${name || 'the project'}…`), el('span', 'fr-note', '', { id: 'frame-note' }));
    void tick();
  };
  /**
   * R7 (H151): what the page knows of its own board changed (a draft accepted, discarded or arrived): the frame last read is drawn
   * again at once with it (frameView `local`), without a reading. Nothing while Studio switches (the header says so then).
   */
  const redraw = () => {
    if (!last || (held && held())) return;
    const view = frameView(last, localNow());
    if (view) draw(view);
  };
  /** R7 (H151): read the frame now (after the reading on its way, if one is), not at the next turn of the timer. */
  const soon = () => { void tick(); };
  const stop = () => { stopped = true; clearTimeout(timer); };
  return { tick, soon, redraw, hold, release, stop, open: setOpen, openUnfinished: setUnfinished, showCommands: setCommands, get revision() { return root.dataset.revision ?? ''; } };
}
