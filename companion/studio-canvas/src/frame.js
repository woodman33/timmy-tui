// R5 (H133): the shared workspace frame on Timmy Studio. src/contracts/workspace.ts is the one frame the terminal Workbench,
// the browser companion and Studio draw around their own content; src/ops/workspace-frame.ts makes it from the records, and the
// canvas server serves it at GET /api/workspace to this page's session (./cards.js workspace). DESIGN.md §10 B10 "Layouts": a
// stable tab header with one amber active tab, a workflow-actions bar whose one primary next step is amber, and the activity.
//
// Drawn here as a compact strip above tldraw (index.html #frame; the canvas starts below it, so it never covers tldraw's menus
// or toolbar): TIMMY · the project; the ten tabs as labels, Studio active (this page cannot hold the companion's token, so the
// others say where they open, and none is a link); the Studio tab's actions, each with its command to copy, the one primary
// amber; and one line of activity: what runs, what waits on you, Stop current and the newest log line. No key is bound here
// (tldraw's keys stay tldraw's). Every text is set as text. Imports nothing.
//
// It redraws only when what it shows changed: the frame's revision also follows what the strip does not show (a connection's
// age, "12 s ago"), and a redraw takes a focused Copy button from under a person. A frame that is not read now stays drawn and
// says so at the line's end: why, and when it was last read.

/** The tab this page is. */
export const STUDIO_TAB = 'studio';
/** What a tab this page cannot open says, as its title. */
export const ELSEWHERE = 'c in the Workbench shows the companion';
/** How often the frame is read while the page is shown (and only then). */
export const FRAME_EVERY_MS = 4000;
/** The frame's schema this strip draws. */
export const FRAME_SCHEMA = 'timmy.workspace/1';

const one = (v) => (typeof v === 'string' ? v : '');
const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
const TONES = new Set(['neutral', 'attention', 'live', 'failure']);
/** A record's time as the strip shows it (the time of day, this computer's clock). */
const clock = (at) => {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 8) : '';
};

/**
 * What the strip shows for `frame` (pure; null for anything that is not a frame of this schema). It decides nothing: the tabs,
 * the actions and their one primary, the counts and the newest line are the frame's own. A second primary, which the frame
 * never sends, is drawn as an ordinary action, so the strip never shows two.
 */
export function frameView(frame) {
  const f = frame && typeof frame === 'object' ? frame : null;
  if (!f || f.schema !== FRAME_SCHEMA || !f.project || typeof f.project !== 'object' || !Array.isArray(f.tabs)) return null;
  const tabs = f.tabs.filter((t) => t && typeof t === 'object').map((t) => {
    const label = one(t.label);
    const active = t.id === STUDIO_TAB;
    return { id: one(t.id), key: one(t.key), label, waiting: count(t.waiting), active, title: active ? `${label}: this page` : `${label}: ${ELSEWHERE}` };
  });
  let primary = false;
  const asked = f.actions && typeof f.actions === 'object' && Array.isArray(f.actions[STUDIO_TAB]) ? f.actions[STUDIO_TAB] : [];
  const actions = asked.filter((a) => a && typeof a === 'object').map((a) => {
    const first = a.primary === true && !primary;
    if (first) primary = true;
    return { n: Number.isInteger(a.n) ? a.n : 0, label: one(a.label), command: one(a.command), primary: first, enabled: a.enabled !== false, why: one(a.why) };
  });
  const act = f.activity && typeof f.activity === 'object' ? f.activity : {};
  const stop = act.stopCurrent && typeof act.stopCurrent === 'object' ? act.stopCurrent : {};
  const top = Array.isArray(f.log) && f.log[0] && typeof f.log[0] === 'object' ? f.log[0] : null;
  const noLog = Array.isArray(f.unknown) ? f.unknown.find((u) => u && u.field === 'log') : null;
  return {
    revision: one(f.revision),
    project: { name: one(f.project.name), shown: one(f.project.shown) },
    tabs,
    actions,
    activity: {
      running: count(act.running),
      waiting: count(act.waitingOnYou),
      stop: { job: typeof stop.job === 'string' && stop.job ? stop.job : null, words: one(stop.words) },
      turn: act.chatTurn && typeof act.chatTurn === 'object' ? one(act.chatTurn.words) : '',
      newest: top ? { at: clock(top.at), words: one(top.words), tone: TONES.has(top.tone) ? top.tone : 'neutral' } : null,
      noLog: noLog ? one(noLog.why) : '',
    },
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
/** A command to type, and its Copy button (the strip's one click handler copies it). */
const commandOf = (command) => [el('code', 'fr-cmd', command), el('button', 'fr-copy', 'Copy', { type: 'button', 'data-copy': command, title: `Copy ${command}` })];

/** Draws `view` (frameView) into the strip's parts under `root` (index.html #frame). */
export function drawFrame(root, view) {
  const project = root.querySelector('#frame-project');
  project.textContent = view.project.name || 'a project';
  project.title = view.project.shown ? `The project's folder: ${view.project.shown}` : '';
  root.querySelector('#frame-tabs').replaceChildren(...view.tabs.map((t) => {
    const li = el('li', `fr-tab${t.active ? ' is-active' : ''}`, null, { 'data-tab': t.id, title: t.title });
    if (t.active) li.setAttribute('aria-current', 'page');
    li.append(el('span', 'fr-key', t.key), ` ${t.label}`);
    if (t.waiting) li.append(' ', el('span', 'fr-count', `${t.waiting} waiting`));
    return li;
  }));
  root.querySelector('#frame-acts').replaceChildren(...view.actions.map((a) => {
    const li = el('li', `fr-act${a.primary ? ' is-primary' : ''}${a.enabled ? '' : ' is-off'}`, null, { 'data-n': a.n });
    li.append(el('span', 'fr-n', a.n), el('span', 'fr-label', a.label), ...commandOf(a.command));
    if (!a.enabled && a.why) li.append(el('span', 'fr-why', a.why));
    if (a.primary) li.title = 'The next step';
    return li;
  }));
  const act = view.activity;
  const line = root.querySelector('#frame-activity');
  const running = el('span', 'fr-running', `${act.running} running`);
  if (act.turn) running.title = act.turn;
  const parts = [running, sep(), el('span', `fr-waiting${act.waiting ? ' is-waiting' : ''}`, `${act.waiting} waiting on you`), sep(), el('span', 'fr-stop', act.stop.words || 'Stop current: idle')];
  if (act.stop.job) parts.push(...commandOf('/stop'));
  parts.push(sep());
  if (act.newest) {
    const failed = act.newest.tone === 'failure';
    parts.push(el('span', `fr-log is-${act.newest.tone}`, `newest: ${act.newest.at} ${failed ? '✕ ' : ''}${act.newest.words}`.replace(/\s+/g, ' ').trim()));
  } else {
    parts.push(el('span', 'fr-log is-neutral', `newest: none yet${act.noLog ? ` (${act.noLog})` : ''}`));
  }
  parts.push(el('span', 'fr-note', '', { id: 'frame-note' }));
  line.replaceChildren(...parts);
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
 * the line's end why, and when it was last read.
 */
export function createFrameStrip({ root, read, copy = copyText, everyMs = FRAME_EVERY_MS }) {
  let drawn = '';
  let readAt = '';
  let busy = false;
  const note = (words) => {
    const n = root.querySelector('#frame-note');
    if (n) n.textContent = words ? ` · ${words}` : '';
    else if (words) root.querySelector('#frame-activity').textContent = words;
  };
  const stale = (why) => {
    root.dataset.stale = 'true';
    note(readAt ? `${why} Shown as last read at ${readAt}.` : why);
  };
  async function tick() {
    if (busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const r = await read();
      const view = r && r.ok && r.body && r.body.ok === true ? frameView(r.body.frame) : null;
      if (!view) { stale(`Workspace not read now: ${notRead(r)}`); return; }
      readAt = clock(new Date().toISOString());
      root.dataset.revision = view.revision;
      root.dataset.stale = 'false';
      const shows = JSON.stringify({ ...view, revision: '' });
      if (shows !== drawn) {
        drawFrame(root, view);
        drawn = shows;
      } else note('');
    } catch (e) {
      stale(`Workspace not read now: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  }
  root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button[data-copy]') : null;
    if (!b || !root.contains(b)) return;
    const command = b.dataset.copy;
    void copy(command).then((ok) => {
      b.textContent = ok ? 'Copied' : 'Not copied';
      setTimeout(() => { if (b.isConnected) b.textContent = 'Copy'; }, 1500);
    });
  });
  const timer = setInterval(() => { void tick(); }, everyMs);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void tick(); });
  void tick();
  return { tick, stop: () => clearInterval(timer), get revision() { return root.dataset.revision ?? ''; } };
}
