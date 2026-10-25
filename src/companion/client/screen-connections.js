// R11 round 4 (H170; contract C2): the Connections screen, page side — the four providers a person connects independently,
// drawn from GET /api/connections (src/companion/connections.ts) in H170's provider-state words, into the shell's host
// (H171's 19:37 contract): TimmyShell.mount('connections', draw); draw(host, shell) runs each time the screen is shown.
//   shell.fetch(url, init)   the launch token and the session in headers (never in an address)
//   shell.h                  the page's element helper h(tag, attrs, ...children)
//   shell.go(id) / land()    Back → 'account'; Explore without a model → 'chat'; Continue to the workspace → land() (the
//                            landing rule: chat when a route is ready, else this screen again with its words)
//   (no shell.toast from this screen since round 7's D15; since the operator's 19:18 order, item 5, a card carries ONE status line —
//   the observed word and one plain sentence — and ONE verb: what an action says goes to the context's live line for that card,
//   the probe's full words with the address to the context's Details and the records)
// Words: the server's (one source: SCREEN_WORDS and each card's provider state). A key pasted for Ollama Cloud goes in a JSON
// body only: never in the address, never kept in the page, never logged. A selection is never a connection: a card's state
// word is the provider's. Amber marks focus and the ONE primary step; green marks "checked" only; every glyph has its word.
// While a sign-in is pending (the browser is away on OpenRouter's page), the screen asks the server again every few seconds
// until the card's state changes: the callback lands on the companion, not on this tab.
// R11 round 6 (the operator's 06:32 order; H174's 06:37 contract): the native ProviderCard artboard in each card —
// TimmyRive.mountProviderCard(host, providerId, { size: 'wide', label }) into a host BESIDE the card's words (≤ 160 px tall, D15),
// mounted ONCE per card for the screen's life (the host outlives a render; handle.unmount() when the screen is destroyed) — and
// the feed, one line per state change, TimmyRive.fromProviderState(id, state, 'GET /api/connections: ' + id), so the Rive label
// and the native State come from the backend's event, not from the card's drawing. The controls stay HTML buttons (the card's one verb; the rest in the context).
// Without the module or its mount API the host stays empty and takes no room: the HTML beside it says the state, as before.
// R11 round 7 (the operator's order of 2026-10-24 13:40, "Models and connections"; UI-OWNERSHIP.md; the rendered study):
// the page on the scaffold every destination shares — the kicker · title · one-line description · the PRIMARY NEXT ACTION
// at the right; the summary band (Account · Model · Records · one action); the work (the four cards, each in one of the
// situations the order names — an existing setup, no account, an unreachable service, no downloaded model — with a verb-led
// action); the context (Choose your model: the chosen provider's words, what a check sends, what it costs, the suitable-model
// download offer with its size, hardware and cost words — never installed silently); the task dock; the records, quiet and
// expandable (what this computer kept, the technical syntax behind Details). The shell (H175's SHELL CONTRACT v1 and his
// commit 2, 15:06) gives the rail, the chrome and the scaffold: this screen's draw host is the page's .page-mount inside
// .page-work; the head, the band and the dock's frame are the shell's, drawn from what this screen REGISTERS (TimmyShell.page:
// the kicker "<the rail's number> / CONNECT A PROVIDER", the title, the intro, the ONE primary next action, the Account cell;
// TimmyShell.band: the Model and Records cells; TimmyShell.state: running while a download runs). The screen fills the work
// (the host), the context (.page-context), its own buttons in the dock (.dock-tools) and the records (.page-records).
(function () {
  'use strict';
  const PROVIDERS = ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'];
  const MARKS = { openrouter: '↗', 'ollama-local': '◉', 'ollama-cloud': '☁', cloudflare: '⌁' };
  const fallbackH = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  /** The glyph beside a state word: green ● for an observed fact only ("checked"); amber ◐ while pending; ✕ refused or unreachable; ○ otherwise. */
  const stateMark = (state) => (state === 'checked' ? { glyph: '●', cls: 'sh-state is-live' } : state === 'pending' ? { glyph: '◐', cls: 'sh-state is-attn' } : state === 'refused' || state === 'unreachable' ? { glyph: '✕', cls: 'sh-state is-attn' } : { glyph: '○', cls: 'sh-state' });
  const bytesWords = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
  const clock = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { hour: '2-digit', minute: '2-digit', hour12: false, month: 'short', day: 'numeric' }) : 'when not recorded'; };

  function draw(host, shell) {
    const sh = shell || {};
    const H = typeof sh.h === 'function' ? sh.h : fallbackH;
    // the shell's h sets attributes only: listeners are added here, so both helpers draw the same
    const h = (tag, attrs, ...children) => {
      const on = {};
      const rest = {};
      for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on') && typeof v === 'function') on[k.slice(2).toLowerCase()] = v; else rest[k] = v; }
      const el = H(tag, Object.keys(rest).length ? rest : null, ...children);
      for (const [ev, fn] of Object.entries(on)) el.addEventListener(ev, fn);
      return el;
    };
    const api = (path, init) => (typeof sh.fetch === 'function' ? sh.fetch(path, init) : fetch(path, init));
    const open = (url) => { if (url) window.open(url, '_blank', 'noopener'); };
    const postJson = async (path, body) => {
      let r;
      try { r = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); } catch { return { status: 0, ok: false, body: { error: 'The companion did not answer.' } }; }
      let j = null; try { j = await r.json(); } catch { j = null; }
      return { status: r.status, ok: r.ok && !!j && j.ok !== false, body: j || {} };
    };

    // the shell's scaffold around the host (SHELL CONTRACT v1 §2.2 as shell.js draws it: the host is the page's .page-mount
    // inside .page-work); the regions this screen fills besides the host
    const section = host.closest('section.page') || host.closest('.page');
    const region = (cls) => (section ? section.querySelector(`:scope > .${cls}, :scope > .page-body > .${cls}`) : null);
    // a caller that hands the section itself (the shell hands the mount): the work goes into the mount, never over the scaffold
    if (section === host) { const work = region('page-work'); if (work) { host = work.querySelector(':scope > .page-mount') || work.appendChild(h('div', { class: 'page-mount' })); } }
    // one screen state per draw: a draw after the shell shows the screen again starts afresh (the previous poll stops)
    if (host._cxScreen && typeof host._cxScreen.destroy === 'function') host._cxScreen.destroy();
    const live = { data: null, pull: null, pullBox: null, saidFor: {}, destroyed: false, poll: null, rive: {}, fed: {}, sel: '', recordsOpen: false };
    const rive = () => (window.TimmyRive && typeof window.TimmyRive === 'object' ? window.TimmyRive : null);
    const regions = { context: region('page-context'), dock: region('page-dock'), records: region('page-records') };
    /** Where this screen's elements are looked up: the page's section (the context, the dock and the records live outside the host). */
    const scope = section || host;
    const main = host;
    main.classList.add('cn-page');
    main.dataset.page = 'connections';
    /** The rail's number for this page (the shell's), before the kicker's verb phrase. */
    const kickerNumber = () => { const p = sh.PAGES && sh.PAGES.find ? sh.PAGES.find((x) => x.id === 'connections') : null; return p && p.n ? String(p.n) : ''; };

    const cardOf = (id) => main.querySelector(`[data-provider="${id}"]`);
    /**
     * What an action just said, for the card it concerns (the operator's 19:18 order, item 5: the card carries ONE status line and
     * ONE verb; the rest — these words among them — is the context column's, for the SELECTED card): written into the context's
     * live line for that card when the context shows it, and remembered so a redraw of the context shows it again; render()
     * forgets it once the card's state changes (the status line then says the new state itself). Plain words only: no address, no
     * path, no endpoint, no command — those are the Details' and the records'.
     */
    const say = (id, words, kind) => {
      if (words) live.saidFor[id] = { words, kind: kind || '' }; else delete live.saidFor[id];
      const el = scope.querySelector(`[data-cn-say="${id}"]`);
      if (!el) return;
      el.textContent = words || '';
      el.dataset.kind = kind || '';
    };
    /** The session's user, when the shell has one. */
    const userOf = () => (sh.session && typeof sh.session.user === 'function' ? sh.session.user() : null) || null;
    /** Whether this page is signed in to a Timmy account: the shell holds a session (its user object, or at least its token). */
    const signedIn = () => { const u = userOf(); if (u && (u.id || u.username || u.email)) return true; try { return Boolean(sh.session && typeof sh.session.get === 'function' && sh.session.get()); } catch { return false; } };
    /** The band's words for the person: a name, never a raw id or an address (R95: ids stay behind the records' Details). */
    const userWords = () => { const u = userOf(); return u ? String(u.username || u.name || '').trim() : ''; };
    /**
     * The band's Account cell says the TIMMY account's truth (H168's R103: it read "Not signed in" on a signed-in page because it
     * looked for a username the session did not carry): "Signed in · <name>" with the name the session carries, "Signed in" with
     * none (the id stays in the records), "This computer's operator" when no identity provider is configured (the rail's words),
     * else "Not signed in". The provider accounts are the cards', never this cell's.
     */
    const accountWords = () => {
      if (signedIn()) { const who = userWords(); return who ? `Signed in · ${who}` : 'Signed in'; }
      try { const i = typeof sh.identity === 'function' ? sh.identity() : null; if (i && i.configured === false) return 'This computer’s operator'; } catch { /* the words below */ }
      return 'Not signed in';
    };

    /**
     * The native ProviderCard's host in a card (R11 round 6): one host per provider for the screen's life, mounted once through
     * H174's TimmyRive.mountProviderCard(host, providerId, { size: 'wide', label }) — the host's width, ≤ 160 px tall (D15) — and moved into each
     * redrawn card (a refresh after an action keeps the same runtime instance; its State follows the feed below). No module or no
     * mount API: the host stays empty (hidden by the sheet) and the HTML state word beside it stands alone.
     */
    function riveHost(c) {
      let r = live.rive[c.id];
      if (!r) {
        r = { host: h('div', { class: 'cn-rive', 'data-rive-host': c.id }), handle: null };
        live.rive[c.id] = r;
        const tr = rive();
        if (tr && typeof tr.mountProviderCard === 'function') {
          // RIVE CONTRACT v2 (H174, 14:42): providerName / detail fill the card's ProviderName and ProviderDetail runs (optional; v1 ignores them)
          // (D15: the face's detail run is the provider's subtitle — a fact; the one state word is the card's, and H174's label follows it)
          // Item 4 (H174's 22:05, the lead's D18): a production face draws the state word alone, its aria-label "<word> · <providerName>";
          // `words: 'spoken'` lets the module take its own HTML status off the screen (never display:none, the live region stays) ONLY
          // while the face is drawn and the word legible — otherwise the module shows that word beside the face, so a state is never unsaid
          try { r.handle = tr.mountProviderCard(r.host, c.id, { size: 'wide', label: c.title, providerName: c.title, detail: c.subtitle || '', words: 'spoken' }) || null; } catch { r.handle = null; /* the words beside it say the state */ }
        }
      } else if (r.handle && typeof r.handle.setProvider === 'function' && r.detail !== (c.subtitle || '')) {
        try { r.handle.setProvider({ name: c.title, detail: c.subtitle || '' }); } catch { /* the HTML words say it */ }
      }
      r.detail = c.subtitle || '';
      return r.host;
    }
    /** The feed (R11 round 6): one line per state change, the backend's own event as the source — never the card's drawing. */
    function feedStates(cards) {
      for (const c of cards) {
        if (!c || typeof c.id !== 'string' || live.fed[c.id] === c.state) continue;
        live.fed[c.id] = c.state;
        const tr = rive();
        if (tr && typeof tr.fromProviderState === 'function') { try { tr.fromProviderState(c.id, c.state, 'GET /api/connections: ' + c.id); } catch { /* the HTML says the state */ } }
      }
    }

    // ── the cards (the work) ──
    /** The card the page recommends as the next step toward a usable model: the route's, else an existing setup, else local. */
    function recommended(cards, sum) {
      const route = sum && sum.route;
      if (route && route.ready) { const id = route.kind === 'local' ? 'ollama-local' : 'openrouter'; if (cards.some((c) => c.id === id)) return id; }
      const existing = cards.find((c) => c.model && c.situation === 'existing');
      if (existing) return existing.id;
      const local = cards.find((c) => c.id === 'ollama-local');
      if (local && local.local && local.local.installed) return 'ollama-local';
      const pending = cards.find((c) => c.situation === 'pending');
      if (pending) return pending.id;
      return cards.some((c) => c.id === 'ollama-local') ? 'ollama-local' : (cards[0] ? cards[0].id : '');
    }

    /** The card's verb-led action: what the primary control of the card does (the verb is the server's). */
    function verbAction(c) {
      const local = c.local || {};
      switch (c.situation) {
        case 'pending': return c.id === 'ollama-local' ? () => { if (live.pull && live.pull.ui) live.pull.ui.cancelBtn.click(); else showPull(c); } : null;
        // (the install and start commands for this computer are the Details' "On this computer" row; the line here is plain)
        case 'no-model': return c.local && !c.local.installed ? () => { open(local.link); say(c.id, INSTALL_WORDS, 'step'); } : () => showPull(c);
        case 'unreachable': return c.id === 'ollama-local' ? () => check(c, 'ollama-local') : () => check(c, c.id);
        case 'refused': return c.id === 'openrouter' ? () => startOpenRouter(c) : () => focusKey(c);
        case 'no-account': return c.id === 'openrouter' ? () => startOpenRouter(c) : c.id === 'ollama-cloud' ? () => focusKey(c) : () => focusGateway(c);
        default: return c.id === 'cloudflare' ? () => focusGateway(c) : () => check(c, c.id);
      }
    }
    const focusKey = (c) => { selectCard(c.id); openContext(); const el = scope.querySelector('#cn-ollama-cloud-key'); if (el) { el.focus(); say(c.id, 'Paste the key from your Ollama account’s keys page, then Save the key.', 'step'); } };
    const focusGateway = (c) => { selectCard(c.id); openContext(); const fold = scope.querySelector('[data-cn-fold="cloudflare"]'); if (fold) fold.open = true; const el = scope.querySelector('#cn-cloudflare-gateway'); if (el) el.focus(); };
    /** The plain line after "Install Ollama" (the commands for this computer stand in the Details' "On this computer" row). */
    const INSTALL_WORDS = 'Install Ollama from its download page and start it; then Check.';

    /** A verb that opens another page (a sign-in, an install page) carries the page's glyph for it. */
    const OPENS = new Set(['Connect with OpenRouter', 'Sign in again', 'Install Ollama']);
    const verbLabel = (c) => (OPENS.has(c.verb) ? `${c.verb} ↗` : c.verb);
    /** The first sentence of the probe's words (a fallback for a server without `status`); the whole stands in the records' row. */
    const firstSentence = (words) => { const m = /^(.*?[.!?])(?=\s+[A-Z(“"]|\s*$)/.exec(String(words || '').trim()); return m ? m[1] : String(words || ''); };
    /** A card is selected by a press anywhere on it (a selection, never a connection): the context shows that card's facts and tools. */
    const selectCard = (id) => { if (live.sel !== id) { live.sel = id; drawContext(); markChosen(); } };
    /** On a phone the context is the shell's sheet: an action that continues there opens it (SHELL CONTRACT v1 sheet()). */
    const openContext = () => { try { if (typeof sh.sheet === 'function' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches) sh.sheet('context', true); } catch { /* the column stands */ } };
    /**
     * A card (R11 round 7, the lead's D15 and the operator's 19:18 order, item 5): a compact cell — the title, the native face
     * (≤ 160 px) BESIDE it, ONE status line (the observed word + one plain sentence: no address, no path, no endpoint — those are the
     * context's Details and the records; once the face is drawn its headline IS the word and the line is the sentence), ONE verb (the
     * primary for its situation: Connect / Check / Download / Set up). Everything else — the other controls, the forms, the facts and
     * the mechanics — is the context column's, for the SELECTED card.
     */
    function cardEl(c, primaryId) {
      const mark = stateMark(c.state);
      const isPrimary = c.id === primaryId;
      const act = verbAction(c);
      const chosen = c.id === live.sel;
      return h('article', { class: `sh-card cn-card cn-card-${c.id}${chosen ? ' is-chosen' : ''}`, 'data-provider': c.id, 'data-state': c.state, 'data-situation': c.situation, 'aria-labelledby': `cn-card-${c.id}-title`, 'aria-current': chosen ? 'true' : null, onClick: () => selectCard(c.id) },
        h('header', { class: 'cn-card-head' },
          h('h2', { id: `cn-card-${c.id}-title`, class: 'cn-card-title' }, c.title),
          h('p', { class: 'sh-sub cn-card-sub' }, c.subtitle)),
        h('p', { class: 'cn-status', 'data-cn-status': c.id },
          h('span', { class: `${mark.cls} cn-state-word` }, c.state), h('span', { class: 'cn-status-sep', 'aria-hidden': 'true' }, ' · '), h('span', { class: 'cn-status-words' }, c.status || firstSentence(c.words))),
        riveHost(c),
        h('div', { class: 'cn-verb-row' },
          // (D24, the lead's 00:47: the recommended card's verb and the head's "Set up a model" are one action — the head selects this
          // card and focuses this verb — so the verb draws the .sh-btn look with the accent RING, never a second fill: D15's "amber on
          // the recommended card only" is the ring now)
          act ? h('button', { type: 'button', class: `sh-btn is-small cn-verb${isPrimary ? ' is-recommended' : ''}`, 'data-cn-verb': c.id, onClick: act }, verbLabel(c)) : h('span', { class: 'sh-note cn-verb-waiting', 'data-cn-verb': c.id }, c.verb)));
      // (no footer: what an action says goes to the context's live line for the selected card — say())
    }

    /** The card's other controls — drawn in the context column for the SELECTED card. A control the verb-led action already is (the same words, the same step) is not drawn twice. */
    function actions(c) {
      const row = h('div', { class: 'sh-actions cn-actions cn-context-tools', 'data-cn-tools': c.id });
      const dup = (label) => label === c.verb || (c.verb === 'Download a model' && label === 'Download a local model') || (c.verb === 'Check again' && label === 'Check');
      const btn = (label, onClick, cls) => (dup(label) ? null : h('button', { type: 'button', class: cls || 'sh-btn is-small', onClick }, label));
      const rowAppend = row.append.bind(row);
      row.append = (...kids) => rowAppend(...kids.filter((k) => k !== null && k !== undefined && k !== false));
      if (c.id === 'openrouter') {
        if (c.verb !== c.action && c.verb !== 'Sign in again') row.append(h('button', { type: 'button', class: 'sh-btn-text cn-link', onClick: () => startOpenRouter(c) }, `${c.action} ↗`));
        if (c.key) row.append(btn('Check the key', () => check(c, 'openrouter')), btn('Forget the key', () => forget(c)));
      } else if (c.id === 'ollama-local') {
        const local = c.local || {};
        row.append(
          btn('Install Ollama', () => { open(local.link); say(c.id, INSTALL_WORDS, 'step'); }),
          btn('Download a local model', () => showPull(c)),
          btn('Check', () => check(c, 'ollama-local')),
          h('button', { type: 'button', class: 'sh-btn-text cn-link', onClick: () => open(local.link) }, `${c.action} ↗`));
      } else if (c.id === 'ollama-cloud') {
        const page = (c.links || []).find((l) => /keys/.test(l.url));
        const input = h('input', { type: 'password', class: 'sh-input', id: 'cn-ollama-cloud-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'Ollama API key', 'aria-label': 'Ollama API key' });
        const form = h('form', { class: 'cn-form', onSubmit: async (e) => {
          e.preventDefault();
          const key = input.value;
          input.value = '';
          if (!key.trim()) { say(c.id, 'Paste the key from your Ollama account’s keys page first.', 'failed'); return; }
          const r = await postJson('/api/connections/ollama-cloud/key', { key });
          if (r.ok) await refresh();
          // (the server's words name the file and the fingerprint: those are the records'; the line here is plain)
          say(c.id, r.ok ? 'The key is saved, not checked yet. Check the key asks Ollama Cloud whether it takes it; no model is run.' : (r.body.error || 'The key was not saved.'), r.ok ? 'step' : 'failed');
        } },
          h('label', { for: 'cn-ollama-cloud-key', class: 'sh-note cn-label' }, 'Key: sent once, in the request body; never shown again.'),
          h('div', { class: 'cn-form-row' }, input, h('button', { type: 'submit', class: 'sh-btn is-small' }, 'Save the key')));
        row.append(h('button', { type: 'button', class: 'sh-btn-text cn-link', onClick: () => open(page && page.url) }, `${c.action} ↗`), form);
        if (c.key) row.append(btn('Check the key', () => check(c, 'ollama-cloud')), btn('Forget the key', () => forget(c)));
      } else if (c.id === 'cloudflare') {
        const cf = c.cloudflare || { gatewayUrl: null, cloudLogs: false };
        const url = h('input', { type: 'url', class: 'sh-input', id: 'cn-cloudflare-gateway', autocomplete: 'off', placeholder: 'gateway.ai.cloudflare.com/<account>/<gateway>', value: cf.gatewayUrl || '', 'aria-label': 'AI Gateway address (optional)' });
        const logs = h('input', { type: 'checkbox', id: 'cn-cloudflare-logs', checked: cf.cloudLogs === true });
        const form = h('form', { class: 'cn-form', onSubmit: async (e) => {
          e.preventDefault();
          const r = await postJson('/api/connections/cloudflare', { gatewayUrl: url.value.trim() || null, cloudLogs: logs.checked });
          if (r.ok) await refresh();
          // (the server's words name the settings file: the records say where; the line here is plain)
          say(c.id, r.ok ? 'The settings are saved. Nothing is sent to Cloudflare to check them; local logs stay as they are.' : (r.body.error || 'The settings were not saved.'), r.ok ? 'step' : 'failed');
        } },
          h('label', { for: 'cn-cloudflare-gateway', class: 'sh-note cn-label' }, 'AI Gateway / model routing (optional)'),
          h('div', { class: 'cn-form-row' }, url),
          h('label', { class: 'sh-note cn-check', for: 'cn-cloudflare-logs' }, logs, ' Cloud logs (optional). Local logs are already part of the design.'),
          h('div', { class: 'cn-form-row' }, h('button', { type: 'submit', class: 'sh-btn is-small' }, 'Save Cloudflare settings'), (cf.gatewayUrl || cf.cloudLogs) ? h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => forget(c) }, 'Remove the settings') : null));
        const setup = (c.links || [])[0];
        // (D15: the optional settings folded behind one line; the card's verb "Set up Cloudflare" opens it and focuses the address)
        const fold = h('details', { class: 'cn-fold', 'data-cn-fold': 'cloudflare', open: (cf.gatewayUrl || cf.cloudLogs) ? true : null }, h('summary', { class: 'sh-note cn-fold-summary' }, 'Gateway address and cloud logs (optional)'), form);
        row.append(h('button', { type: 'button', class: 'sh-btn-text cn-link', onClick: () => open(setup && setup.url) }, `${c.action} ↗`), fold);
      }
      return row;
    }

    async function startOpenRouter(c) {
      say(c.id, 'Starting the sign-in…', 'step');
      const r = await postJson('/api/connections/openrouter/start', { callback: `${location.origin}/api/connections/openrouter/callback` });
      if (!r.ok) { say(c.id, r.body.error || 'The sign-in could not start.', 'failed'); return; }
      open(r.body.url);
      await refresh(); // (the state is pending now: the line said before is forgotten with the change, and this one follows it)
      say(c.id, `${r.body.words} The card’s status line says when the key is saved.`, 'step');
    }
    /** The state word a card shows now (after a refresh), or none. */
    const stateOf = (id) => { const x = live.data && (live.data.cards || []).find((k) => k.id === id); return x ? x.state : null; };
    async function check(c, id) {
      const what = live.data && live.data.checks && live.data.checks[id];
      const before = c.state;
      // (what a check asks, in plain words — describeCheck's `words`; the endpoints it sends to are the Details' "A check sends")
      say(c.id, what ? what.words : 'Checking…', 'step');
      const r = await postJson(`/api/connections/${id}/check`, {});
      if (!r.ok) { say(c.id, r.body.error || 'The check did not run.', 'failed'); return; }
      await refresh();
      // the card's ONE status line says what the check found (the operator's 19:18 order, item 5; the probe's full words, with the
      // address, are the Details' "Observed" row and the records): the line here is cleared when the state changed, else says so
      say(c.id, stateOf(id) === before ? 'Checked again; the state is as it was.' : '', 'step');
    }
    async function forget(c) {
      let r; try { r = await api(`/api/connections/${c.id}`, { method: 'DELETE' }); } catch { r = null; }
      let j = null; try { j = r ? await r.json() : null; } catch { j = null; }
      await refresh();
      // (the server's words name the file: the records say where; the line here is plain)
      say(c.id, r && r.ok ? (j && j.removed === false ? 'Nothing was kept for this provider.' : 'Forgotten.') : ((j && j.error) || 'Nothing was removed.'), r && r.ok ? 'step' : 'failed');
    }

    // Ollama · local: the download, with its size, the person's confirmation, its progress and Cancel (SSE from the server)
    function showPull(c, model) {
      selectCard(c.id); openContext();
      const tools = scope.querySelector(`[data-cn-tools="${c.id}"]`);
      if (!tools) return;
      let box = scope.querySelector('.cn-pull');
      if (box && !model) { box.remove(); live.pullBox = null; return; }
      if (box) { const sel = box.querySelector('#cn-pull-model'); if (sel) { sel.value = model; sel.focus(); } return; }
      const local = c.local || { starters: [] };
      const select = h('select', { class: 'sh-select', id: 'cn-pull-model', 'aria-label': 'Model to download' }, ...(local.starters || []).map((m) => h('option', { value: m.model, selected: model ? m.model === model : m.default }, `${m.model} · ${m.size} · ${m.use}`)));
      const other = h('input', { type: 'text', class: 'sh-input', id: 'cn-pull-other', placeholder: 'or another model name from the Ollama library', 'aria-label': 'Another model name', autocomplete: 'off' });
      const status = h('p', { class: 'sh-note cn-pull-status', 'aria-live': 'polite' }, local.sizeNote ? `Sizes: ${local.sizeNote}.` : '');
      const bar = h('progress', { class: 'cn-progress', max: '100', value: '0', hidden: true });
      const confirmBtn = h('button', { type: 'button', class: 'sh-btn-primary is-small', hidden: true }, 'Confirm the download');
      const cancelBtn = h('button', { type: 'button', class: 'sh-btn is-small', hidden: true }, 'Cancel');
      const startBtn = h('button', { type: 'button', class: 'sh-btn is-small' }, 'Show the size');
      box = h('div', { class: 'cn-pull' },
        h('label', { for: 'cn-pull-model', class: 'sh-note cn-label' }, 'Download a local model into the Ollama on this computer: its size first; it starts only when you confirm.'),
        local.offer ? h('p', { class: 'sh-note cn-offer-words' }, `${local.offer.hardware} ${local.offer.cost}`) : null,
        h('div', { class: 'cn-form-row' }, select, other),
        h('div', { class: 'cn-form-row' }, startBtn, confirmBtn, cancelBtn),
        bar, status);
      tools.after(box);
      live.pullBox = box;
      startBtn.addEventListener('click', () => startPull((other.value.trim() || select.value), { status, bar, confirmBtn, cancelBtn, startBtn }));
      select.focus();
    }
    async function startPull(model, ui) {
      if (live.pull) { ui.status.textContent = 'A download is under way already.'; return; }
      ui.startBtn.hidden = true; ui.confirmBtn.hidden = true; ui.cancelBtn.hidden = true;
      ui.status.textContent = `Asking the size of ${model}…`;
      let res;
      try { res = await api('/api/connections/ollama-local/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }); } catch { res = null; }
      if (!res || !res.ok || !res.body) {
        let j = null; try { j = res ? await res.json() : null; } catch { j = null; }
        ui.status.textContent = (j && j.error) || 'The download could not be prepared.';
        ui.startBtn.hidden = false;
        return;
      }
      const pull = { id: null, model, reader: res.body.getReader(), ui };
      live.pull = pull;
      ui.confirmBtn.onclick = async () => {
        if (!pull.id) return;
        ui.confirmBtn.hidden = true;
        const r = await postJson('/api/connections/ollama-local/pull/confirm', { id: pull.id });
        if (!r.ok) ui.status.textContent = r.body.error || 'Not confirmed.';
      };
      ui.cancelBtn.onclick = async () => { if (pull.id) await postJson('/api/connections/ollama-local/pull/cancel', { id: pull.id }); };
      void readEvents(pull);
    }
    async function readEvents(pull) {
      const ui = pull.ui;
      const decoder = new TextDecoder();
      let buf = '';
      const end = (words) => { live.pull = null; ui.status.textContent = words; ui.bar.hidden = true; ui.confirmBtn.hidden = true; ui.cancelBtn.hidden = true; ui.startBtn.hidden = false; };
      try {
        for (;;) {
          const { done, value } = await pull.reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, sep); buf = buf.slice(sep + 2);
            const ev = /^event: (.+)$/m.exec(block); const dat = /^data: (.+)$/m.exec(block);
            if (!ev || !dat) continue;
            let d = {}; try { d = JSON.parse(dat[1]); } catch { d = {}; }
            if (ev[1] === 'size') { pull.id = d.id; ui.status.textContent = d.words; ui.confirmBtn.hidden = false; ui.cancelBtn.hidden = false; }
            else if (ev[1] === 'confirmed') { ui.status.textContent = `${d.words} Downloading…`; ui.bar.hidden = false; }
            else if (ev[1] === 'progress') { ui.status.textContent = d.words; if (d.total) { ui.bar.hidden = false; ui.bar.value = String(Math.min(100, Math.round((d.done / d.total) * 100))); ui.status.textContent = `${d.words} (${Math.min(100, Math.round((d.done / d.total) * 100))}%)`; } }
            else if (ev[1] === 'done') { end(d.words); await refresh(); return; }
            else if (ev[1] === 'cancelled' || ev[1] === 'error') { end(d.words); return; }
          }
        }
        end('The download’s stream ended.');
      } catch { end('The download’s stream was lost: Ollama keeps what it downloaded; pulling again resumes.'); }
    }

    // ── the page's regions (R11 round 7: the scaffold) ──
    const goChat = () => { if (typeof sh.go === 'function') sh.go('chat'); };
    const land = () => { if (typeof sh.land === 'function') sh.land(); else goChat(); };
    const focusVerb = (id) => { const b = main.querySelector(`[data-cn-verb="${id}"]`); if (b && typeof b.focus === 'function') { b.focus(); b.scrollIntoView({ block: 'center' }); } };

    function work(cards, primaryId) {
      return h('section', { class: 'cn-work', 'aria-label': 'Your providers', 'data-cn-work': '' },
        h('div', { class: 'cn-work-head' }, h('span', { class: 'sh-label' }, 'Your providers'), h('span', { class: 'sh-note', 'data-cn-read-at': '' }, live.data && live.data.readAt ? `read ${clock(live.data.readAt)} · files only, nothing asked of a provider` : '')),
        h('div', { class: 'cn-cards' }, ...cards.map((c) => cardEl(c, primaryId))));
    }

    function context(s, sum, cards) {
      const aside = h('aside', { class: 'cn-context page-context', 'aria-label': 'Choose your model' },
        h('div', { class: 'cn-context-head' }, h('h2', { class: 'cn-context-title' }, s.contextTitle || 'Choose your model'), h('p', { class: 'sh-note' }, s.contextLead || '')),
        // the segmented control: one row at 1440 (the shell's 320 px column), 2 × 2 at a phone; the short name on the button, the full one as its title
        h('div', { class: 'cn-picker', role: 'group', 'aria-label': 'Provider' }, ...cards.map((c) => h('button', { type: 'button', class: 'cn-pick', 'data-cn-pick': c.id, title: c.title, 'aria-pressed': c.id === live.sel ? 'true' : 'false', onClick: () => { live.sel = c.id; drawContext(); markChosen(); } }, c.title.replace(' · ', ' ')))),
        h('div', { class: 'cn-context-body', 'data-cn-context': '' }),
        h('div', { class: 'cn-together' }, h('span', { class: 'cn-note-mark', 'aria-hidden': 'true' }, '▤ '), h('span', { class: 'sh-note' }, s.together || '')));
      return aside;
    }
    /**
     * The context column (R11 round 7, the lead's D15 on H168's R87; the operator's 19:18 order, item 5): the SELECTED card's facts
     * and tools — what it is, what it costs, its other controls and forms, and behind Details the mechanics (what a check sends and
     * asks, the time, the commands, what was observed in full, the detail lines) — never the card again (its one status line and its
     * one verb are on the card). Ollama · local adds the download offer: each starter as "Download <model> (<size>)", nothing
     * downloaded until the confirmation.
     */
    function drawContext() {
      const body = scope.querySelector('[data-cn-context]');
      if (!body || !live.data) return;
      const cards = live.data.cards || [];
      const c = cards.find((x) => x.id === live.sel) || cards[0];
      if (!c) { body.replaceChildren(); return; }
      for (const b of scope.querySelectorAll('[data-cn-pick]')) b.setAttribute('aria-pressed', b.dataset.cnPick === c.id ? 'true' : 'false');
      const chk = live.data.checks && live.data.checks[c.id];
      const links = (c.links || []).map((l) => h('button', { type: 'button', class: 'sh-btn-text cn-link', onClick: () => open(l.url) }, `${l.label} ↗`));
      const fact = (k, v) => (v ? h('div', null, h('dt', null, k), h('dd', null, v)) : null);
      const offer = c.id === 'ollama-local' && c.local && c.local.offer ? h('div', { class: 'cn-offer', 'data-cn-offer': '' },
        h('p', { class: 'cn-offer-lead' }, c.local.offer.lead),
        h('ul', { class: 'cn-starters' }, ...(c.local.starters || []).map((m) => h('li', { class: 'cn-starter' },
          h('button', { type: 'button', class: 'sh-btn is-small cn-starter-pick', 'data-cn-starter': m.model, onClick: () => showPull(c, m.model) }, `Download ${m.model} (${typeof m.bytes === 'number' && m.bytes > 0 ? bytesWords(m.bytes) : m.size})`),
          h('span', { class: 'cn-starter-words' }, `${typeof m.bytes === 'number' && m.bytes > 0 && m.size !== bytesWords(m.bytes) ? `${m.size} on disk · ` : ''}${m.use}${m.default ? ' · the default' : ''}`)))),
        h('p', { class: 'sh-note' }, c.local.offer.hardware),
        h('p', { class: 'sh-note' }, `Sizes: ${c.local.sizeNote}.`)) : null;
      // the provider's detail lines: the local card's is what the check FOUND (the models this computer's Ollama holds — a fact the
      // person chooses by, in view); Cloudflare's are its configured parts (hosts, variables: technical syntax, behind Details)
      const lines = c.lines && c.lines.length ? h('ul', { class: 'cn-context-lines', 'data-cn-lines': c.id }, ...c.lines.map((l) => h('li', null, l))) : null;
      const found = c.id === 'ollama-local' && lines ? h('div', { class: 'cn-found', 'data-cn-found': c.id }, h('p', { class: 'sh-label cn-found-label' }, 'What the check found'), lines) : null;
      // the mechanics behind Details (the operator's 19:18 order, item 5): what a check sends and asks, the time, the commands,
      // what was observed in full (the address among its words)
      const details = h('details', { class: 'cn-context-details', 'data-cn-details': c.id },
        h('summary', { class: 'sh-note cn-details-summary' }, 'Details · what a check sends, what was observed'),
        h('dl', { class: 'cn-facts cn-facts-details' },
          fact('Next step', c.next || ''),
          chk ? fact('A check sends', chk.sends || '') : null,
          chk ? fact('What it asks', chk.words || '') : null,
          fact('Last observed', c.at ? clock(c.at) : 'not yet — nothing has been asked of this provider'),
          fact('Observed', c.words || ''),
          c.local && c.local.installed === false ? fact('On this computer', `${c.local.install || 'Install Ollama'}; then ${c.local.start || 'start it'}`) : null),
        found ? null : lines);
      // the live line for what an action on this card said (say): the remembered words, when any
      const said = live.saidFor[c.id] || { words: '', kind: '' };
      // (H168's R102: replaceChildren writes a null argument as the text "null" — the offer is null for every card but the local
      // one, and the word stood under the context sheet; only nodes go in)
      const kids = [
        h('div', { class: 'cn-context-card', 'data-cn-context-for': c.id },
          h('p', { class: 'cn-context-for' }, h('span', { class: 'cn-context-mark', 'aria-hidden': 'true' }, MARKS[c.id] || '·'), ' ', h('strong', { class: 'cn-context-name' }, c.title), h('span', { class: 'cn-context-sub' }, ` · ${c.subtitle}`)),
          h('p', { class: 'cn-context-about' }, c.body),
          h('dl', { class: 'cn-facts' },
            fact('Cost', c.cost || ''),
            c.key ? fact('Key', `saved from ${c.key.from}; never shown (its fingerprint is in the records)`) : null),
          found,
          actions(c),
          h('p', { class: 'sh-note cn-say', 'data-cn-say': c.id, 'data-kind': said.kind, 'aria-live': 'polite' }, said.words),
          details,
          links.length ? h('div', { class: 'sh-actions cn-context-links' }, ...links) : null),
        offer,
      ];
      body.replaceChildren(...kids.filter((k) => k instanceof Node));
      // the download box outlives a redraw of the context (its progress goes on): back under the local card's tools
      if (live.pullBox && c.id === 'ollama-local') { const tools = body.querySelector('[data-cn-tools="ollama-local"]'); if (tools) tools.after(live.pullBox); }
    }
    function markChosen() {
      for (const el of main.querySelectorAll('.cn-card[data-provider]')) { const on = el.dataset.provider === live.sel; el.classList.toggle('is-chosen', on); if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current'); }
    }

    /** This screen's buttons for the shell's task dock (D8: plain words — the page's one arrow is the shell's primary). */
    function dock(s, cards) {
      const local = cards.find((c) => c.id === 'ollama-local');
      const checkable = cards.filter((c) => c.model && c.situation === 'existing');
      return [
        h('button', { type: 'button', class: 'dock-btn cn-dock-btn', 'data-cn-dock': 'check-all', disabled: checkable.length ? null : true, title: checkable.length ? `Checks ${checkable.map((c) => c.title).join(', ')}: each asks its provider once and runs no model` : 'Nothing to check yet: no provider holds a setup', onClick: async () => { for (const c of checkable) await check(c, c.id); } }, `Check ${checkable.length ? checkable.length : ''} configured`.replace('  ', ' ')),
        local ? h('button', { type: 'button', class: 'dock-btn cn-dock-btn', 'data-cn-dock': 'download', onClick: () => showPull(local) }, 'Download a model') : null,
        h('button', { type: 'button', class: 'dock-btn cn-dock-btn', 'data-cn-dock': 'explore', onClick: goChat }, s.explore || 'Explore without a model'),
        h('button', { type: 'button', class: 'dock-btn cn-dock-btn', 'data-cn-dock': 'back', onClick: () => { if (typeof sh.go === 'function') sh.go('account'); } }, s.back || 'Back'),
        h('button', { type: 'button', class: 'dock-btn cn-dock-btn', 'data-cn-dock': 'records', 'aria-expanded': live.recordsOpen ? 'true' : 'false', onClick: () => { const d = scope.querySelector('.cn-records'); if (d) { d.open = !d.open; live.recordsOpen = d.open; } } }, 'Records'),
      ].filter(Boolean);
    }

    function records(s, data, cards) {
      const d = h('details', { class: 'cn-records records', open: live.recordsOpen ? true : null },
        h('summary', { class: 'cn-records-summary' }, h('span', { class: 'sh-label' }, 'Records'), h('span', { class: 'sh-note' }, ' what this computer kept of these connections · the syntax behind Details')),
        h('dl', { class: 'cn-records-list' },
          ...cards.map((c) => h('div', { class: 'cn-record', 'data-cn-record': c.id },
            h('dt', null, c.title),
            h('dd', null, c.at ? `last observed ${clock(c.at)} · ${c.state}` : `no observation kept · ${c.state}`, c.key ? ` · key ${c.key.fingerprint} from ${c.key.from}` : '', c.cloudflare && c.cloudflare.file ? ` · settings in ${c.cloudflare.file}` : '', c.words ? ` · ${c.words}` : ''))),
          h('div', { class: 'cn-record' }, h('dt', null, 'Account'), h('dd', null, (() => { const u = userOf(); return u && (u.id || u.username) ? `signed in · id ${u.id || 'not given'}${u.username ? ` · ${u.username}` : ''}` : signedIn() ? 'signed in · the session carries no user record on this page' : 'no session on this page'; })())),
          h('div', { class: 'cn-record' }, h('dt', null, 'Files'), h('dd', null, 'providers.json (keys, 0600) · state/connections.json (observations) · state/cloudflare.json (optional settings), all in your Timmy home')),
          h('div', { class: 'cn-record' }, h('dt', null, 'Read'), h('dd', null, data.readAt ? `${clock(data.readAt)} · GET /api/connections: files only; a check is the one thing that asks a provider` : 'not read'))),
        h('p', { class: 'sh-note cn-records-foot' }, s.footerStrong || '', ' ', s.footer || ''));
      d.addEventListener('toggle', () => { live.recordsOpen = d.open; const b = scope.querySelector('[data-cn-dock="records"]'); if (b) b.setAttribute('aria-expanded', d.open ? 'true' : 'false'); });
      return d;
    }

    /** The page's head, band and state through the shell (SHELL CONTRACT v1 §2.3), when the shell has them. */
    function register(s, sum, cards, primaryId) {
      if (typeof sh.page !== 'function') return;
      const ready = Boolean(sum.route && sum.route.ready);
      try {
        sh.page('connections', {
          kicker: `${kickerNumber() ? `${kickerNumber()} / ` : ''}${s.kicker || 'CONNECT A PROVIDER'}`,
          title: s.title || '',
          intro: s.lead || '',
          // (D8: the label carries no arrow — the shell's primary button draws the one →, the band's action its ↗)
          primary: ready
            ? { label: s.continue || 'Continue to the workspace', run: land }
            : { label: s.setUp || 'Set up a model', run: () => { live.sel = primaryId; drawContext(); markChosen(); focusVerb(primaryId); } },
          context: 'selection',
          band: [{ k: 'Account', v: accountWords() }],
          dock: 'MODELS & ACCOUNTS TOOLS',
        });
      } catch { /* the shell says what it could not take */ }
      const r = sum.route || { ready: false };
      const rec = sum.records || { words: 'Local by default' };
      if (typeof sh.band === 'function') { try { sh.band('connections', { model: r.ready ? (r.model || r.label) : 'Choose a provider', records: rec.words }); } catch { /* as above */ } }
      if (typeof sh.state === 'function') { try { sh.state('connections', cards.some((c) => c.state === 'pending') ? 'running' : 'content'); } catch { /* as above */ } }
    }

    function render(data) {
      live.data = data;
      const s = data.screen || {};
      const sum = data.summary || {};
      const cards = PROVIDERS.map((id) => (data.cards || []).find((x) => x.id === id)).filter(Boolean);
      const primaryId = recommended(cards, sum);
      if (!live.sel || !cards.some((c) => c.id === live.sel)) live.sel = primaryId;
      const note = h('p', { class: 'sh-note cn-note' }, h('span', { class: 'cn-note-mark', 'aria-hidden': 'true' }, '↳ '), s.note || '');
      // the head and the band are the shell's, from the registration; the work (this host), the context, this screen's
      // buttons in the dock and the records are drawn here — each into the shell's region when the page has it
      main.replaceChildren(work(cards, primaryId), note);
      if (regions.context) regions.context.replaceChildren(...context(s, sum, cards).childNodes);
      if (regions.dock) {
        let tools = regions.dock.querySelector(':scope > .dock-tools');
        if (!tools) { tools = h('div', { class: 'dock-tools' }); regions.dock.append(tools); }
        for (const old of tools.querySelectorAll('[data-cn-dock]')) old.remove();
        tools.append(...dock(s, cards));
      }
      if (regions.records) regions.records.replaceChildren(records(s, data, cards));
      register(s, sum, cards, primaryId);
      // a card whose state changed says the new state on its status line itself: the line an action said before it is forgotten
      // (an action that says more after its refresh — a check, a key saved — says it after this render)
      for (const c of cards) if (live.fed[c.id] !== undefined && live.fed[c.id] !== c.state) delete live.saidFor[c.id];
      drawContext();
      // every path that applies a provider's state ends here (the first draw, Check, a download, a key, a delete, the socket's
      // connections event through update()): the feed says each change once, with the backend's event as its source
      feedStates(cards);
      // a sign-in pending: ask again until the callback landed (the browser is away on OpenRouter's page)
      const pending = cards.some((c) => c.state === 'pending');
      if (pending && !live.poll) live.poll = setTimeout(() => { live.poll = null; void refresh(); }, 3000);
    }

    async function refresh() {
      if (live.destroyed) return;
      let r;
      try { r = await api('/api/connections'); } catch { r = null; }
      const failed = (words) => {
        main.replaceChildren(h('p', { class: 'sh-note sh-error cn-failed', role: 'alert' }, words));
        if (typeof sh.state === 'function') { try { sh.state('connections', 'error', { words, next: { label: 'Read again', run: () => void refresh() } }); } catch { /* the words above stand */ } }
      };
      if (!r || !r.ok) { failed(r && r.status === 401 ? 'Sign in to Timmy first: the connections are kept under your account.' : 'The connections could not be read from the companion.'); return; }
      let data; try { data = await r.json(); } catch { data = null; }
      if (!data || !data.ok) { failed('The connections could not be read from the companion.'); return; }
      if (live.destroyed) return;
      render(data);
    }

    const screen = {
      update(event) { if (event && event.type === 'connections') void refresh(); },
      refresh,
      destroy() {
        live.destroyed = true;
        if (live.poll) { clearTimeout(live.poll); live.poll = null; }
        if (live.pull) { try { live.pull.reader.cancel(); } catch { /* closed */ } live.pull = null; }
        // the four native cards let their runtime instances go (H174's handle.unmount); the next draw mounts afresh
        for (const r of Object.values(live.rive)) { if (r.handle && typeof r.handle.unmount === 'function') { try { r.handle.unmount(); } catch { /* gone */ } } r.handle = null; }
        live.rive = {};
      },
    };
    host._cxScreen = screen;
    void refresh();
    return screen;
  }

  const TimmyConnectionsScreen = { draw };
  window.TimmyConnectionsScreen = TimmyConnectionsScreen;
  // mounted into the shell whatever the scripts' order: now when the shell loaded first, else once the page has loaded
  const mount = () => {
    if (window.TimmyShell && typeof window.TimmyShell.mount === 'function') {
      try { window.TimmyShell.mount('connections', draw); } catch { /* the shell says what is missing */ }
    }
  };
  if (window.TimmyShell) mount();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
