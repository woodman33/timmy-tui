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
