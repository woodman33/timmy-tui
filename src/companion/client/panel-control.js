// R8 (H155): the Control Room's panes (tab 7; references 07 and 14), drawn into data-panel-host="control" (panels.js says how
// a panel registers and what it is given). Its route is src/companion/panels/control.ts; which runs get a pane and what each
// pane says are src/ops/panes.ts's, the one source the Workbench's tab 7 draws from too.
//
// Read-only. A 2×2 grid (one column on a narrow screen): what runs first (the project's running jobs, then a chat turn being
// answered), then the newest ended runs in the slots they leave; more than four running are said ("N more running"). Each
// pane: its mark and word and its run name; its id, who started it and its time; its log's last lines (the newest kept where
// the pane is short); a running one's "log read every 2 s", an ended one's exit and receipt (green only when the companion's
// server verified it in this reading; one that does not verify is amber with ✕ and its words); how it is stopped, in the
// workspace frame's words; and whether it opens a run detail. A pane with an operation opens its run detail (/run/<op>, the
// Workflows tab's) on a click or Enter; nothing on a pane starts, stops or changes anything, and the panel holds no button.
// The panes are read again every `every` ms (the server's word, bounded here) while the tab is shown, and not while it is not.
(() => {
  'use strict';
  if (typeof TimmyPanels === 'undefined') return;

  const EVERY_MIN_MS = 1000;
  const EVERY_MAX_MS = 10000;
  const S = { project: null, root: null, ctx: null, timer: 0, asking: null, sig: '', every: 2000, at: 0 };

  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? String(iso || '') : `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`; };
  const seconds = (ms) => `${Number((ms / 1000).toFixed(1))} s`;
  const put = (el, ...kids) => { if (el) el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
  const q = (name) => (S.root ? S.root.querySelector(`[data-control="${name}"]`) : null);
  /** the tab's page is on screen (its host, and no hidden page around it) and the page is seen */
  const shown = () => Boolean(S.root && document.contains(S.root) && !S.root.closest('[hidden]') && !document.hidden);

  function skeleton(h) {
    const root = h('section', { class: 'box control-panes-box', 'data-control-box': 'panes', 'aria-labelledby': 'control-panes-title' },
      h('h2', { class: 'box-title', id: 'control-panes-title', 'data-control': 'title' }, 'Panes'),
      h('div', { class: 'box-body control-panes-body' },
        h('ol', { class: 'control-grid', 'data-control': 'grid', 'aria-label': 'The panes: what runs, then the newest ended' }, h('li', { class: 'empty' }, 'Reading this project\'s panes…')),
        h('div', { class: 'control-panes-foot', 'data-control': 'foot' })));
    root.addEventListener('keydown', onKey);
    return root;
  }

  // ── reading ──
  function schedule() {
    clearTimeout(S.timer);
    S.timer = 0;
    // read again only while the tab is shown; once it is not, nothing is read until it is drawn again
    if (!shown()) return;
    S.timer = setTimeout(() => { S.timer = 0; if (shown()) void read(); }, S.every);
  }

  async function read() {
    const ctx = S.ctx;
    if (!ctx || S.asking) return S.asking;
    clearTimeout(S.timer);
    S.timer = 0;
    S.at = Date.now();
    S.asking = (async () => {
      let body = null;
      let status = 0;
      try {
        const r = await ctx.fetch(ctx.api('panes'));
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (e) { body = null; }
      if (S.project !== ctx.project || !S.root) return; // the page switched project while this was asked
      if (!body || body.ok !== true || body.schema !== 'timmy.control-panes/1') {
        S.sig = '';
        put(q('grid'), ctx.h('li', { class: 'empty tone-failed', 'data-control-error': 'panes' }, `✕ The panes could not be read: ${(body && body.error) || (status ? `the companion answered HTTP ${status}` : 'the companion did not answer')}. They are read again in a moment.`));
        return;
      }
      const every = Number(body.every);
      S.every = Number.isFinite(every) ? Math.min(EVERY_MAX_MS, Math.max(EVERY_MIN_MS, every)) : 2000;
      const sig = JSON.stringify([body.panes, body.running, body.more, body.notes]);
      if (sig === S.sig) return;
      S.sig = sig;
      draw(body);
    })().finally(() => { S.asking = null; schedule(); });
    return S.asking;
  }

  // ── drawing ──
  function draw(body) {
    const h = S.ctx.h;
    const quiet = body.panes.filter((p) => p.quiet).length;
    put(q('title'), `Panes (${body.panes.length}) · ${body.running ? `${body.running} running` : 'nothing runs'}${quiet ? ` · ${quiet} newest ended` : ''}`);
    // the keyboard's place is kept across a redraw: the pane drawn in its place takes it back
    const had = document.activeElement && S.root.contains(document.activeElement) ? document.activeElement.closest('.control-pane') : null;
    const keep = had ? had.dataset.pane : null;
    put(q('grid'), body.panes.length
      ? body.panes.map((p) => pane(h, p))
      : h('li', { class: 'empty', 'data-control-empty': 'panes' }, 'No job has run in this project yet, and no chat turn is being answered: a run is drawn here as a pane once it starts.'));
    if (keep) { const back = S.root.querySelector(`.control-pane[data-pane="${CSS.escape(keep)}"]`); if (back) back.focus({ preventScroll: true }); }
    put(q('foot'),
      body.more > 0 ? h('p', { class: 'control-more', 'data-control': 'more' }, `${body.more} more running, not drawn here (four panes at most); the Workbench’s tab 7 (timmy workbench, key 7) shows every running pane`) : null,
      (body.notes || []).map((n) => h('p', { class: 'control-note tone-failed' }, `✕ ${n}`)),
      h('p', { class: 'control-note', 'data-control': 'read-only' }, 'Read-only: nothing here starts, stops or changes a run; a pane with a run opens its run detail.'));
    // R10 (H167, with the lead's CI reading at 0394cd6: a read between a redraw and the next frame counted lines not fitted
    // yet): the logs fitted now, as drawn, so no state of the page has a log's lines unfitted (getBoundingClientRect lays the
    // page out first); again in the next frame and whenever a log's box changes size (a font that loads, the window resized)
    fitLogs();
    requestAnimationFrame(fitLogs);
    watchLogs();
  }

  function pane(h, p) {
    const failed = Boolean(p.state && p.state.failed);
    const opens = typeof p.operation === 'string' && /^o[0-9a-f]{8}$/.test(p.operation) ? p.operation : '';
    const when = p.kind === 'turn' ? `since ${clock(p.since)}` : p.endedAt ? `ran ${p.took || 'an unknown time'} · ended ${clock(p.endedAt)}` : `${p.took || ''} · since ${clock(p.since)}`;
    // one row each where the pane is narrow (the whole words in its title): who started it and when; its blocks too
    const who = p.kind === 'turn' ? `from ${p.from || 'an unknown surface'} · ${p.who} · ${when}` : [p.id, p.who, p.blocks, when].filter(Boolean).join(' · ');
    const detail = opens ? `opens run ${opens}` : `no run detail: ${p.noDetail || 'none named'}`;
    const tail = p.tail || { why: 'not read' };
    const lines = Array.isArray(tail.lines) ? tail.lines : null;
    const attrs = {
      class: `control-pane${p.quiet ? ' is-quiet' : ' is-running'}`, 'data-pane': p.id, 'data-pane-kind': p.kind, 'data-pane-quiet': p.quiet ? 'true' : 'false',
      'data-pane-state': p.state ? p.state.word : '',
    };
    if (opens) Object.assign(attrs, { 'data-open-run': opens, tabindex: '0', role: 'link', 'aria-label': `${p.name}: ${p.state ? p.state.word : ''}; opens run ${opens}`, title: `Opens run ${opens} (its run detail, in Workflows)` });
    return h('li', attrs,
      h('p', { class: 'control-pane-head' },
        h('span', { class: `control-pane-state${failed ? ' tone-failed' : ''}`, 'data-pane-part': 'state' }, `${p.state ? p.state.glyph : '?'} ${p.state ? p.state.word : 'unknown'}`),
        h('span', { class: 'control-pane-name', 'data-pane-part': 'name', title: p.name }, p.name)),
      // (R10 H167: how often its log is read, at the end of this row, so the pane's log keeps room with 13 px text)
      h('p', { class: 'control-pane-who is-one', 'data-pane-part': 'who', title: p.every ? `${who} · log read every ${seconds(p.every)}` : who }, who,
        p.every ? [' · ', h('span', { 'data-pane-part': 'every' }, `log read every ${seconds(p.every)}`)] : null),
      p.recovery ? h('p', { class: 'control-pane-who', 'data-pane-part': 'recovery' }, p.recovery) : null,
      p.proof ? h('p', { class: 'control-pane-who' }, p.proof) : null,
      lines && lines.length
        ? h('div', { class: 'control-log', 'data-pane-part': 'log' }, lines.map((l) => h('span', { class: 'control-line', title: l }, l)))
        : h('div', { class: 'control-log', 'data-pane-part': 'log' }, h('span', { class: 'control-log-why', 'data-pane-part': 'log-why' }, lines ? (p.quiet ? 'it printed nothing' : 'nothing printed yet') : tail.why)),
      p.quiet ? h('p', { class: 'control-pane-foot is-one', title: `${p.exit || 'exit not recorded'} · ${p.receipt ? p.receipt.words : 'no receipt'}` },
        h('span', { 'data-pane-part': 'exit' }, p.exit || 'exit not recorded'), ' · ',
        receipt(h, p.receipt)) : null,
      // (R10 H167: one row each, the whole words in its tip, so a pane's log keeps room for its newest lines with 13 px text)
      p.stop ? h('p', { class: 'control-pane-stop is-one', 'data-pane-part': 'stop', title: p.stop.command ? `${p.stop.words} · in Timmy’s terminal: ${p.stop.command}` : p.stop.words }, p.stop.command ? `${p.stop.words} · in Timmy’s terminal: ${p.stop.command}` : p.stop.words) : null,
      h('p', { class: `control-pane-open is-one${opens ? ' is-link' : ''}`, 'data-pane-part': 'open', title: detail }, detail));
  }

  /** A pane's log keeps its newest lines in sight: a line cut at the log's top edge (the pane is short) is left out whole. */
  function fitLogs() {
    if (!S.root) return;
    for (const log of S.root.querySelectorAll('.control-log')) {
      const lines = [...log.querySelectorAll('.control-line')];
      for (const l of lines) l.hidden = false;
      const top = log.getBoundingClientRect().top + parseFloat(getComputedStyle(log).paddingTop || '0') - 0.5;
      // the newest line always shows, even in a pane too short for one
      for (const l of lines.slice(0, -1)) if (l.getBoundingClientRect().top < top) l.hidden = true;
    }
  }
  let fitting = 0;
  const refit = () => { if (!fitting) fitting = requestAnimationFrame(() => { fitting = 0; fitLogs(); }); };
  window.addEventListener('resize', refit);
  // R10 (H167): a pane's log is fitted again whenever its box changes size, not only when the window does: the page's other
  // boxes settle after a draw, and a web font that loads after it changes how its words wrap, so the box can be shorter
  // than when its lines were first fitted (a line would be cut at its top edge)
  // (its callback runs after layout and before paint, so the lines are fitted in the same frame the box changed in)
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitLogs()) : null;
  /** Each pane's log, watched for its size (the logs drawn now; the ones drawn before are let go). */
  function watchLogs() {
    if (!sized || !S.root) return;
    sized.disconnect();
    for (const log of S.root.querySelectorAll('.control-log')) sized.observe(log);
  }

  /** a receipt: green only when the server verified it in this reading; amber with ✕ when it does not verify; else quiet */
  function receipt(h, r) {
    if (!r) return h('span', { class: 'control-receipt', 'data-pane-part': 'receipt' }, 'no receipt');
    const cls = r.state === 'verified' ? ' is-verified' : r.state === 'failed' ? ' tone-failed' : '';
    return h('span', { class: `control-receipt${cls}`, 'data-pane-part': 'receipt', 'data-receipt-state': r.state }, r.words);
  }

  // Enter or Space on a pane that opens a run: as a click on it (the page's click handler opens data-open-run)
  function onKey(event) {
    const p = event.target && event.target.closest ? event.target.closest('.control-pane[data-open-run]') : null;
    if (!p || p !== event.target || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    p.click();
  }

  document.addEventListener('visibilitychange', () => { if (shown() && !S.timer && !S.asking) void read(); });

  TimmyPanels.register('control', {
    draw(host, frame, ctx) {
      S.ctx = ctx;
      if (!ctx.own) {
        clearTimeout(S.timer);
        S.timer = 0;
        S.root = null;
        put(host, ctx.h('p', { class: 'empty' }, 'Not shown: the frame is another project\'s, so its panes are not read here.'));
        return undefined;
      }
      if (S.project !== ctx.project || !S.root || !host.contains(S.root)) {
        S.project = ctx.project;
        S.sig = '';
        S.root = skeleton(ctx.h);
        put(host, S.root);
      }
      // the tab is on screen again: its logs' lines are fitted to the panes as they are drawn now
      requestAnimationFrame(fitLogs);
      // drawn when the tab is shown and when the frame moves: read now, unless a read is under way or the next one is already
      // due within the interval (a frame that moves every few seconds does not add reads to it)
      if (S.asking) return S.asking;
      if (S.timer && Date.now() - S.at < S.every) return undefined;
      return read();
    },
  });
})();

// ── R11 round 7 (H169): the Control Room page on the shell's scaffold (SHELL CONTRACT v1) ──
//
// The panes above are the page's work. Around them, from GET /api/panel/control/room (src/companion/panels/control.ts, the
// frame's activity + the capability inventory + the receipts chain, read on the server):
//   the head      what runs now and what it may cost; ONE primary: Stop the turn (a chat turn being answered: POST
//                 /api/chat/stop { turn }), else the job's stop command to copy, else Answer in Chat (something waits on you),
//                 else Open Runs & receipts
//   the states    approval while anything waits on you (NEEDS YOU first), running while anything runs, else content
//   the band      Fleet (exercised · configured · available) and Budget (measured dollars from the receipts, the flags in effect)
//   the context   the fleet, each lane and integration in the three words (available / configured / exercised; never a fourth),
//                 and Fleet & Clef's connections (cloudroom, clef, cloudflare) with their observed state — folded in here (D3)
//   the dock      Stop in .dock-stop while a turn runs; Read again; the Runs & receipts shortcut
//   the records   the budget's facts (no cap in this revision, said), where the logs are, what could not be read
// Green is drawn only for an observed exercised state; "none" is a word, not a colour.
(() => {
  'use strict';
  if (typeof TimmyPanels === 'undefined' || typeof TimmyPanels.get !== 'function') return;
  const panes = TimmyPanels.get('control');
  const shell = () => (typeof TimmyShell !== 'undefined' && TimmyShell ? TimmyShell : null);
  const page = (reg) => { const s = shell(); if (s && typeof s.page === 'function') { try { s.page('control', reg); } catch (e) { /* the shell said why */ } } };
  const setState = (st, extra) => { const s = shell(); if (s && typeof s.state === 'function') { try { s.state('control', st, extra || {}); } catch (e) { /* the shell said why */ } } };
  const goTo = (legacy) => { const s = shell(); if (s && typeof s.go === 'function') s.go(legacy, 'h169'); else if (typeof showWorkspaceTab === 'function') showWorkspaceTab(legacy); };
  const SECTION = 'ws-control';
  /** The kicker's number is the rail's order (SHELL CONTRACT v1 §2.3): the shell's own (TimmyShell.PAGES[].n) when it says, else the contract's. */
  const kickerN = (fallback) => { const s = shell(); const p = s && Array.isArray(s.PAGES) ? s.PAGES.find((x) => x && x.id === 'control') : null; return (p && p.n) || fallback; };
  const R = { project: null, host: null, ctx: null, room: null, timer: 0, asking: null, stopping: false, at: 0 };
  const SOON_MS = 1500; // a draw-triggered read is skipped within this of the last (the frame moves often while a run runs)
  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? String(iso || '') : `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`; };
  const put = (el, ...kids) => { if (el) el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
  const region = (cls) => { const s = document.getElementById(SECTION); return s ? s.querySelector(`.${cls}`) : null; };
  const shown = () => Boolean(R.host && document.contains(R.host) && !R.host.closest('[hidden]') && !document.hidden);
  /** dollars as the receipts measured them: cents when there are any, four places under a cent, unknown when not a number */
  const usd = (n) => (typeof n === 'number' && Number.isFinite(n) ? (n === 0 || n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`) : 'unknown');

  /** The "now" strip: before the panes' host, inside the page's work (the section when the scaffold is not there yet). */
  function nowBox() {
    let box = document.querySelector(`#${SECTION} [data-room="now"]`);
    if (box) return box;
    const section = document.getElementById(SECTION);
    if (!section) return null;
    box = document.createElement('section');
    box.className = 'room-now';
    box.dataset.room = 'now';
    box.setAttribute('aria-label', 'What runs now');
    const work = section.querySelector('.page-work') || section;
    const slot = work.querySelector(':scope > .page-state'); // the shell's state words stay first
    if (slot) slot.after(box); else work.prepend(box);
    return box;
  }
  function ownBox(regionCls, attr, key, make) {
    const reg = region(regionCls);
    if (!reg) return null;
    let box = reg.querySelector(`[${attr}="${key}"]`);
    if (!box) { box = make(); box.setAttribute(attr, key); reg.append(box); }
    return box;
  }
  async function copyWords(text, saidTo) {
    try {
      if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard here');
      await navigator.clipboard.writeText(text);
      if (saidTo) saidTo.textContent = `Copied ${text}: paste it in Timmy's terminal. Nothing ran from this page.`;
    } catch (e) { if (saidTo) saidTo.textContent = `Could not copy (${e && e.message ? e.message : e}); the command is ${text}.`; }
  }

  /** Stop the chat turn being answered: POST /api/chat/stop { turn } (the process answering it stops it; its receipt says so). */
  async function stopTurn(id) {
    const said = document.querySelector(`#${SECTION} [data-room="said"]`);
    if (!id || R.stopping || !R.ctx) return;
    R.stopping = true;
    for (const b of document.querySelectorAll(`#${SECTION} [data-room-stop-turn]`)) { b.disabled = true; b.setAttribute('aria-busy', 'true'); }
    try {
      const r = await R.ctx.fetch(`/api/chat/stop${R.ctx.project ? `?project=${encodeURIComponent(R.ctx.project)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn: id }) });
      const body = await r.json().catch(() => null);
      if (said) said.textContent = body && typeof (body.words || body.error) === 'string' ? (body.words || body.error) : `The companion answered HTTP ${r.status}.`;
    } catch (e) {
      if (said) said.textContent = `Not stopped: the companion could not be reached (${e && e.message ? e.message : e}).`;
    } finally {
      R.stopping = false;
      for (const b of document.querySelectorAll(`#${SECTION} [data-room-stop-turn]`)) { b.disabled = false; b.removeAttribute('aria-busy'); }
      void read();
    }
  }

  function primaryOf(room) {
    const a = room && room.activity;
    if (a && a.chatTurn && a.chatTurn.id) return { label: 'Stop the turn', run: () => stopTurn(a.chatTurn.id) };
    if (a && a.stop && a.stop.command) return { label: 'Copy the stop command', run: () => copyWords(a.stop.command, document.querySelector(`#${SECTION} [data-room="said"]`)) };
    if (a && a.waitingOnYou > 0) return { label: 'Answer in Chat', run: () => goTo('chat') };
    return { label: 'Open Runs & receipts', run: () => goTo('logs') };
  }

  function register(room) {
    const f = room ? room.fleet : [];
    const count = (w) => f.filter((x) => x.word === w).length;
    const b = room && room.budget;
    const flags = b ? [b.localOnly ? 'local only' : null, b.freeOnly ? 'free only' : null].filter(Boolean).join(' · ') : '';
    page({
      kicker: `${kickerN('10')} / KEEP WATCH`, title: 'What runs now, and what it costs.',
      intro: 'Every run under way in this project, the fleet that can take one, and the budget in effect. A run is stopped from here; nothing else is changed.',
      primary: primaryOf(room), context: room ? 'selection' : null, dock: 'CONTROL TOOLS', // the column holds the fleet once the room is read
      band: room ? [
        { k: 'Fleet', v: f.length ? `${count('exercised')} exercised · ${count('configured')} configured · ${count('available')} available` : 'none listed' },
        { k: 'Budget', v: b ? `${usd(b.measuredUsd)} measured · ${b.receipts} receipt${b.receipts === 1 ? '' : 's'}${flags ? ` · ${flags}` : ''}` : 'unknown' },
      ] : [],
    });
    if (!room) return;
    const a = room.activity;
    if (a.waitingOnYou > 0) setState('approval', { words: `${a.waitingOnYou} waiting on you.`, next: { label: 'Answer in Chat', run: () => goTo('chat') } });
    else if (a.running > 0) setState('running', { words: `${a.running} running.` });
    else setState('content');
  }

  function draw(room) {
    const h = R.ctx.h;
    const a = room.activity;
    // the now strip
    const now = nowBox();
    if (now) {
      // what the last action said stays through a redraw (a read follows a Stop; the frame moves): until the next action
      const saidBefore = (now.querySelector('[data-room="said"]') || {}).textContent || '';
      put(now,
        h('p', { class: 'room-counts' },
          h('span', { class: `room-count${a.running ? ' is-running' : ''}`, 'data-room-count': 'running' }, `${a.running} running`), ' · ',
          h('span', { class: `room-count${a.waitingOnYou ? ' needs-you' : ''}`, 'data-room-count': 'waiting' }, a.waitingOnYou ? `NEEDS YOU · ${a.waitingOnYou} waiting on you` : '0 waiting on you')),
        a.chatTurn ? h('p', { class: 'room-turn', 'data-room': 'chat-turn' }, `▶ ${a.chatTurn.words || 'a chat turn is being answered'}${a.chatTurn.since ? ` · since ${clock(a.chatTurn.since)}` : ''} `,
          a.chatTurn.id ? h('button', { type: 'button', class: 'dock-btn room-stop', 'data-room-stop-turn': a.chatTurn.id, title: 'Asks the process answering this turn to stop it; its receipt says it was stopped from this page' }, 'Stop the turn') : null) : null,
        a.stop ? h('p', { class: 'room-stop-words', 'data-room': 'job-stop' }, `${a.stop.words} `, a.stop.command ? h('button', { type: 'button', class: 'dock-btn', 'data-room-copy': a.stop.command, title: `Copies ${a.stop.command} for Timmy's terminal` }, 'Copy the stop command') : null) : null,
        !a.chatTurn && !a.stop ? h('p', { class: 'room-quiet' }, a.running ? `${a.running} running; the frame names no stop for it here.` : 'Nothing runs now. A run shows here the moment it starts, with how it is stopped.') : null,
        h('p', { class: 'room-said', 'data-room': 'said', 'aria-live': 'polite' }, saidBefore));
    }
    // the dock: Stop in its slot while a turn runs; the page's tools after the frame's
    const dock = region('page-dock');
    if (dock) {
      const slot = dock.querySelector('.dock-stop');
      if (slot) put(slot, a.chatTurn && a.chatTurn.id ? h('button', { type: 'button', class: 'dock-btn is-stop', 'data-room-stop-turn': a.chatTurn.id }, 'Stop the turn') : a.stop && a.stop.command ? h('button', { type: 'button', class: 'dock-btn', 'data-room-copy': a.stop.command, title: a.stop.words }, 'Copy the stop command') : null);
      const tools = dock.querySelector(':scope > .dock-tools') || dock; // the shell's tools container when it made one
      let own = tools.querySelector('[data-dock-owner="control"]');
      if (!own) { own = document.createElement('span'); own.className = 'dock-group'; own.dataset.dockOwner = 'control'; tools.append(own); }
      put(own, h('button', { type: 'button', class: 'dock-btn', 'data-room-refresh': '1' }, 'Read again'), h('button', { type: 'button', class: 'dock-btn', 'data-room-go': 'logs' }, 'Runs & receipts'));
    }
    // the context: the fleet in the three words, then Fleet & Clef's connections
    const ctxEl = region('page-context');
    if (ctxEl) {
      const section = document.getElementById(SECTION);
      const gridEl = section ? section.querySelector('.conn-grid[data-conns-for="fleet"]') : null;
      const grid = gridEl ? { el: gridEl, box: gridEl.closest('section.box') || gridEl } : null;
      const box = ownBox('page-context', 'data-context-owner', 'control', () => { const s = document.createElement('section'); s.className = 'ctx-box room-fleet'; return s; });
      const means = 'available: on this computer or reachable · configured: set up for this account · exercised: a receipt of a real run';
      put(box,
        h('h3', { class: 'ctx-title' }, 'The fleet'),
        h('p', { class: 'ctx-words', title: means }, 'Each lane in the three words; a word is drawn only from what was observed.'),
        room.fleet.length ? h('ul', { class: 'fleet-list', 'aria-label': 'Lanes and integrations' }, ...room.fleet.map((r) => h('li', { class: `fleet-row is-${r.word}`, 'data-fleet': r.id, 'data-word': r.word },
          h('span', { class: 'fleet-name' }, r.name, h('span', { class: 'fleet-group' }, ` ${r.group}`)),
          h('span', { class: `fleet-word is-${r.word}` }, r.word),
          h('details', { class: 'ui-details' }, h('summary', null, 'Details'),
            h('dl', { class: 'ctx-facts' },
              h('dt', null, 'Available'), h('dd', null, r.available),
              h('dt', null, 'Configured'), h('dd', null, r.configured),
              h('dt', null, 'Exercised'), h('dd', null, r.exercised),
              r.next ? [h('dt', null, 'Next'), h('dd', null, r.next)] : null))))) : h('p', { class: 'ctx-words' }, 'No lane or integration is listed by the inventory.'),
        // Fleet & Clef's connections (cloudroom, clef, cloudflare): the page's own grid, drawn by companion.js from the frame
        // (index.html folds it into this section, D3), MOVED into this column; where the section has none, the room's words
        grid && grid.box ? null : [h('h3', { class: 'ctx-title' }, 'Fleet & Clef'),
          room.connections.length ? h('ul', { class: 'fleet-list', 'aria-label': 'Fleet backend, decisions and the edge' }, ...room.connections.map((c) => h('li', { class: `fleet-row is-conn is-${c.state}`, 'data-conn': c.id, 'data-state': c.state },
            h('span', { class: 'fleet-name' }, c.label),
            h('span', { class: `fleet-word is-${c.state === 'live' ? 'live' : 'none'}` }, c.state),
            h('p', { class: 'fleet-words' }, c.words || ''),
            c.setup || c.observedAt ? h('details', { class: 'ui-details' }, h('summary', null, 'Details'),
              h('dl', { class: 'ctx-facts' },
                c.observedAt ? [h('dt', null, 'Observed'), h('dd', null, clock(c.observedAt))] : null,
                c.setup ? [h('dt', null, 'Setup'), h('dd', null, h('code', null, c.setup))] : null)) : null))) : h('p', { class: 'ctx-words' }, 'The frame lists none of the fleet\'s connections.')]);
      if (grid && grid.box && !ctxEl.contains(grid.box)) ctxEl.append(grid.box);
    }
    // the records: the budget, where the logs are, what could not be read
    const rec = region('page-records');
    if (rec) {
      const box = ownBox('page-records', 'data-records-owner', 'control', () => { const d = document.createElement('details'); d.className = 'records'; const s = document.createElement('summary'); s.textContent = 'Records · the budget, the logs, how this was read'; d.append(s, document.createElement('div')); return d; });
      const b = room.budget;
      put(box.lastElementChild,
        h('dl', { class: 'ctx-facts budget-facts' },
          h('dt', null, 'Measured'), h('dd', null, `${usd(b.measuredUsd)} across ${b.receipts} receipt${b.receipts === 1 ? '' : 's'}${b.unmeasured ? ` · ${b.unmeasured} unmeasured (no cost on the receipt)` : ''}`),
          h('dt', null, 'Free only'), h('dd', null, `${b.freeOnly ? 'on' : 'off'} · from ${b.from.freeOnly}`),
          h('dt', null, 'Local only'), h('dd', null, `${b.localOnly ? 'on' : 'off'} · from ${b.from.localOnly}`),
          h('dt', null, 'Cap'), h('dd', null, b.cap)),
        h('p', null, 'Logs: each pane above keeps its run\'s newest lines; the socket log and the structured events are Runs & receipts\' records; the Workbench\'s tab 7 shows every running pane.'),
        h('p', null, `Read ${clock(room.at)} from the workspace frame, the capability inventory and the receipts chain.`),
        room.notes.length ? h('ul', null, ...room.notes.map((n) => h('li', { class: 'tone-failed' }, n))) : null);
    }
  }

  async function read() {
    const ctx = R.ctx;
    if (!ctx || R.asking) return R.asking;
    clearTimeout(R.timer); R.timer = 0;
    R.at = Date.now();
    R.asking = (async () => {
      let body = null; let status = 0;
      try { const r = await ctx.fetch(ctx.api('room')); status = r.status; body = await r.json().catch(() => null); } catch (e) { body = null; }
      if (R.ctx !== ctx || R.project !== ctx.project) return;
      if (!body || body.ok !== true) {
        const now = nowBox();
        if (now) put(now, ctx.h('p', { class: 'room-quiet tone-failed' }, `✕ The room could not be read: ${(body && body.error) || (status ? `the companion answered HTTP ${status}` : 'the companion did not answer')}.`));
        setState('error', { words: 'The room could not be read from the companion.', next: { label: 'Read again', run: () => read() } });
        return;
      }
      R.room = body;
      register(body);
      draw(body);
    })().finally(() => {
      R.asking = null;
      if (R.room && R.room.activity && (R.room.activity.running > 0 || R.room.activity.waitingOnYou > 0) && shown()) R.timer = setTimeout(() => { R.timer = 0; if (shown()) void read(); }, 5000);
    });
    return R.asking;
  }

  function bind() {
    const section = document.getElementById(SECTION);
    if (!section || section.dataset.roomBound) return;
    section.dataset.roomBound = '1';
    section.addEventListener('click', (event) => {
      const t = event.target instanceof Element ? event.target : null;
      if (!t) return;
      const stop = t.closest('[data-room-stop-turn]');
      if (stop) { void stopTurn(stop.dataset.roomStopTurn); return; }
      const copy = t.closest('[data-room-copy]');
      if (copy) { void copyWords(copy.dataset.roomCopy, document.querySelector(`#${SECTION} [data-room="said"]`)); return; }
      if (t.closest('[data-room-refresh]')) { void read(); return; }
      const g = t.closest('[data-room-go]');
      if (g) goTo(g.dataset.roomGo);
    });
  }

  TimmyPanels.register('control', {
    draw(host, frame, ctx) {
      const out = panes ? panes.draw(host, frame, ctx) : undefined;
      R.host = host; R.ctx = ctx;
      bind();
      if (!ctx.own) { const now = nowBox(); if (now) put(now, ctx.h('p', { class: 'room-quiet' }, 'Not shown: the frame is another project\'s.')); return out; }
      if (R.project !== ctx.project) { R.project = ctx.project; R.room = null; }
      register(R.room);
      const mine = R.room && Date.now() - R.at < SOON_MS && !R.asking ? Promise.resolve() : read();
      return out && typeof out.then === 'function' ? Promise.all([out, mine]) : mine;
    },
  });
  // (the page's sheet, /panel-control.css, is index.html's link)
  const ready = () => { nowBox(); register(null); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
