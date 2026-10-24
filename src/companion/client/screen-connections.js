// R11 round 4 (H170; contract C2): the Connections screen, page side — the four providers a person connects independently,
// drawn from GET /api/connections (src/companion/connections.ts) in H170's provider-state words, into the shell's host
// (H171's 19:37 contract): TimmyShell.mount('connections', draw); draw(host, shell) runs each time the screen is shown.
//   shell.fetch(url, init)   the launch token and the session in headers (never in an address)
//   shell.h                  the page's element helper h(tag, attrs, ...children)
//   shell.go(id) / land()    Back → 'account'; Explore without a model → 'chat'; Continue to the workspace → land() (the
//                            landing rule: chat when a route is ready, else this screen again with its words)
//   shell.toast(words, { live }) green only for an observed fact (a check that answered)
// Words: the server's (one source: SCREEN_WORDS and each card's provider state). A key pasted for Ollama Cloud goes in a JSON
// body only: never in the address, never kept in the page, never logged. A selection is never a connection: a card's state
// word is the provider's. Amber marks focus and the ONE primary step; green marks "checked" only; every glyph has its word.
// While a sign-in is pending (the browser is away on OpenRouter's page), the screen asks the server again every few seconds
// until the card's state changes: the callback lands on the companion, not on this tab.
// R11 round 6 (the operator's 06:32 order; H174's 06:37 contract): the native ProviderCard artboard in each card —
// TimmyRive.mountProviderCard(host, providerId, { size: 'wide', label }) into a host of the card's width above the state word,
// mounted ONCE per card for the screen's life (the host outlives a render; handle.unmount() when the screen is destroyed) — and
// the feed, one line per state change, TimmyRive.fromProviderState(id, state, 'GET /api/connections: ' + id), so the Rive label
// and the native State come from the backend's event, not from the card's drawing. The card's buttons stay these HTML buttons.
// Without the module or its mount API the host stays empty and takes no room: the HTML beside it says the state, as before.
// R11 round 7 (the operator's order of 2026-10-24 13:40, "Models and connections"; UI-OWNERSHIP.md; the rendered study):
// the page on the scaffold every destination shares — the kicker · title · one-line description · the PRIMARY NEXT ACTION
// at the right; the summary band (Account · Model · Records · one action); the work (the four cards, each in one of the
// situations the order names — an existing setup, no account, an unreachable service, no downloaded model — with a verb-led
// action); the context (Choose your model: the chosen provider's words, what a check sends, what it costs, the suitable-model
// download offer with its size, hardware and cost words — never installed silently); the task dock; the records, quiet and
// expandable (what this computer kept, the technical syntax behind Details). The shell (H175's SHELL CONTRACT v1, 14:23)
// gives the rail and the chrome. TWO WAYS THE REGIONS ARE PLACED, one code path for their content: when the host holds the
// shell's scaffold (section.page with .page-work / .page-context / .page-dock / .page-records), this screen registers the
// page (TimmyShell.page: the kicker "06 / CONNECT A PROVIDER", the title, the intro, the ONE primary next action; the band's
// Model and Records cells through TimmyShell.band; the state through TimmyShell.state) and fills the shell's regions; until
// the shell's scaffold lands (and on a page without it: a test's FAKE shell), it draws the regions itself with the
// contract's class names, in the contract's order. Nothing is drawn twice.
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
    const toast = (words, live) => { if (typeof sh.toast === 'function') sh.toast(words, live ? { live: true } : undefined); };
    const postJson = async (path, body) => {
      let r;
      try { r = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); } catch { return { status: 0, ok: false, body: { error: 'The companion did not answer.' } }; }
      let j = null; try { j = await r.json(); } catch { j = null; }
      return { status: r.status, ok: r.ok && !!j && j.ok !== false, body: j || {} };
    };

    // one screen state per draw: a draw after the shell shows the screen again starts afresh (the previous poll stops)
    if (host._cxScreen && typeof host._cxScreen.destroy === 'function') host._cxScreen.destroy();
    const live = { data: null, pull: null, pullBox: null, said: null, destroyed: false, poll: null, rive: {}, fed: {}, sel: '', recordsOpen: false };
    const rive = () => (window.TimmyRive && typeof window.TimmyRive === 'object' ? window.TimmyRive : null);
    // the shell's scaffold, when the host holds one (SHELL CONTRACT v1 §2.2); else this screen draws the regions itself
    const scaffold = (() => {
      const work = host.querySelector('.page-work');
      if (!work) return null;
      return { work, context: host.querySelector('.page-context'), dock: host.querySelector('.page-dock'), records: host.querySelector('.page-records') };
    })();
    const main = scaffold ? scaffold.work : h('div', { class: 'sh-main cn-main cn-page', 'data-page': 'connections' });
    if (!scaffold) { host.replaceChildren(); host.append(main); }
    const KICKER_NUMBER = '06';

    const cardOf = (id) => main.querySelector(`[data-provider="${id}"]`);
    const say = (card, words, kind) => {
      const el = card && card.querySelector('[data-cn-say]');
      if (!el) return;
      el.textContent = words || '';
      el.dataset.kind = kind || '';
    };
    const userWords = () => { const u = sh.session && typeof sh.session.user === 'function' ? sh.session.user() : null; return u && (u.username || u.email || u.id) ? String(u.username || u.email || u.id) : ''; };

    /**
     * The native ProviderCard's host in a card (R11 round 6): one host per provider for the screen's life, mounted once through
     * H174's TimmyRive.mountProviderCard(host, providerId, { size: 'wide', label }) — the card's width — and moved into each
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
          try { r.handle = tr.mountProviderCard(r.host, c.id, { size: 'wide', label: c.title, providerName: c.title, detail: c.situationWords || '' }) || null; } catch { r.handle = null; /* the words beside it say the state */ }
        }
      } else if (r.handle && typeof r.handle.setProvider === 'function' && r.detail !== (c.situationWords || '')) {
        try { r.handle.setProvider({ name: c.title, detail: c.situationWords || '' }); } catch { /* the HTML chip says it */ }
      }
      r.detail = c.situationWords || '';
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
        case 'no-model': return c.local && !c.local.installed ? () => { open(local.link); say(cardOf(c.id), `${local.install || 'Install Ollama'}; then ${local.start || 'start it'}. Then Check.`, 'step'); } : () => showPull(c);
        case 'unreachable': return c.id === 'ollama-local' ? () => check(c, 'ollama-local') : () => check(c, c.id);
        case 'refused': return c.id === 'openrouter' ? () => startOpenRouter(c) : () => focusKey(c);
        case 'no-account': return c.id === 'openrouter' ? () => startOpenRouter(c) : c.id === 'ollama-cloud' ? () => focusKey(c) : () => focusGateway(c);
        default: return c.id === 'cloudflare' ? () => focusGateway(c) : () => check(c, c.id);
      }
    }
    const focusKey = (c) => { const el = cardOf(c.id) && cardOf(c.id).querySelector('#cn-ollama-cloud-key'); if (el) { el.focus(); say(cardOf(c.id), 'Paste the key from ollama.com/settings/keys, then Save the key.', 'step'); } };
    const focusGateway = (c) => { const el = cardOf(c.id) && cardOf(c.id).querySelector('#cn-cloudflare-gateway'); if (el) el.focus(); };

    /** A verb that opens another page (a sign-in, an install page) carries the page's glyph for it. */
    const OPENS = new Set(['Connect with OpenRouter', 'Sign in again', 'Install Ollama']);
    const verbLabel = (c) => (OPENS.has(c.verb) ? `${c.verb} ↗` : c.verb);
    function cardEl(c, primaryId) {
      const mark = stateMark(c.state);
      const isPrimary = c.id === primaryId;
      const act = verbAction(c);
      const chosen = c.id === live.sel;
      return h('article', { class: `sh-card cn-card cn-card-${c.id}${chosen ? ' is-chosen' : ''}`, 'data-provider': c.id, 'data-state': c.state, 'data-situation': c.situation, 'aria-labelledby': `cn-card-${c.id}-title`, 'aria-current': chosen ? 'true' : null },
        h('header', { class: 'cn-card-head' },
          h('span', { class: 'cn-card-mark', 'aria-hidden': 'true' }, MARKS[c.id] || '·'),
          h('div', { class: 'cn-card-names' },
            h('h2', { id: `cn-card-${c.id}-title`, class: 'cn-card-title' }, c.title),
            h('p', { class: 'sh-sub cn-card-sub' }, c.subtitle)),
          h('span', { class: `cn-situation is-${c.situation}`, 'data-cn-situation': c.situation }, c.situationWords || '')),
        h('p', { class: 'cn-card-body' }, c.body),
        riveHost(c),
        h('div', { class: 'cn-card-state' },
          h('p', { class: `${mark.cls} cn-state` }, h('span', { class: 'cn-state-glyph', 'aria-hidden': 'true' }, mark.glyph), ' ', h('span', { class: 'cn-state-word' }, c.state)),
          h('p', { class: 'sh-note cn-words' }, c.words)),
        h('div', { class: 'cn-verb-row' },
          act ? h('button', { type: 'button', class: `${isPrimary ? 'sh-btn-primary' : 'sh-btn'} is-small cn-verb`, 'data-cn-verb': c.id, onClick: act }, verbLabel(c)) : h('span', { class: 'sh-note cn-verb-waiting', 'data-cn-verb': c.id }, c.verb),
          c.next ? h('span', { class: 'sh-note cn-next' }, h('span', { class: 'cn-next-label' }, 'Next '), c.next) : null),
        actions(c),
        h('footer', { class: 'cn-card-foot' },
          c.lines && c.lines.length ? h('ul', { class: 'sh-note cn-lines' }, ...c.lines.map((l) => h('li', null, l))) : null,
          h('p', { class: 'sh-note cn-say', 'data-cn-say': '', 'aria-live': 'polite' })));
    }

    /** The card's other controls. A control the verb-led action already is (the same words, the same step) is not drawn twice. */
    function actions(c) {
      const row = h('div', { class: 'sh-actions cn-actions' });
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
          btn('Install Ollama', () => { open(local.link); say(cardOf(c.id), `${local.install || 'Install Ollama'}; then ${local.start || 'start it'}. Then Check.`, 'step'); }),
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
          if (!key.trim()) { say(cardOf(c.id), 'Paste the key from ollama.com/settings/keys first.', 'failed'); return; }
          const r = await postJson('/api/connections/ollama-cloud/key', { key });
          if (r.ok) { toast(r.body.words, false); await refresh(); }
          say(cardOf(c.id), r.ok ? r.body.words : (r.body.error || 'The key was not saved.'), r.ok ? 'step' : 'failed');
        } },
          h('label', { for: 'cn-ollama-cloud-key', class: 'sh-note cn-label' }, 'Paste an Ollama API key (sent once, in the request body; never shown again)'),
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
          say(cardOf(c.id), r.ok ? r.body.words : (r.body.error || 'The settings were not saved.'), r.ok ? 'step' : 'failed');
        } },
          h('label', { for: 'cn-cloudflare-gateway', class: 'sh-note cn-label' }, 'AI Gateway / model routing (optional)'),
          h('div', { class: 'cn-form-row' }, url),
          h('label', { class: 'sh-note cn-check', for: 'cn-cloudflare-logs' }, logs, ' Cloud logs (optional). Local logs are already part of the design.'),
          h('div', { class: 'cn-form-row' }, h('button', { type: 'submit', class: 'sh-btn is-small' }, 'Save Cloudflare settings'), (cf.gatewayUrl || cf.cloudLogs) ? h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => forget(c) }, 'Remove the settings') : null));
        const setup = (c.links || [])[0];
        row.append(h('button', { type: 'button', class: 'sh-btn-text cn-link', onClick: () => open(setup && setup.url) }, `${c.action} ↗`), form);
      }
      return row;
    }

    async function startOpenRouter(c) {
      say(cardOf(c.id), 'Starting the sign-in…', 'step');
      const r = await postJson('/api/connections/openrouter/start', { callback: `${location.origin}/api/connections/openrouter/callback` });
      if (!r.ok) { say(cardOf(c.id), r.body.error || 'The sign-in could not start.', 'failed'); return; }
      open(r.body.url);
      live.said = { id: c.id, words: `${r.body.words} This card says when the key is saved.`, kind: 'step' };
      await refresh();
    }
    async function check(c, id) {
      const what = live.data && live.data.checks && live.data.checks[id];
      say(cardOf(c.id), what ? what.words : 'Checking…', 'step');
      const r = await postJson(`/api/connections/${id}/check`, {});
      if (!r.ok) { say(cardOf(c.id), r.body.error || 'The check did not run.', 'failed'); return; }
      await refresh();
      const s = r.body.state || {};
      say(cardOf(c.id), s.words || '', 'step');
      toast(s.words || '', s.state === 'checked');
    }
    async function forget(c) {
      let r; try { r = await api(`/api/connections/${c.id}`, { method: 'DELETE' }); } catch { r = null; }
      let j = null; try { j = r ? await r.json() : null; } catch { j = null; }
      await refresh();
      say(cardOf(c.id), (j && (j.words || j.error)) || 'Nothing was removed.', r && r.ok ? 'step' : 'failed');
    }

    // Ollama · local: the download, with its size, the person's confirmation, its progress and Cancel (SSE from the server)
    function showPull(c, model) {
      const card = cardOf(c.id);
      if (!card) return;
      let box = card.querySelector('.cn-pull');
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
      card.querySelector('.cn-actions').after(box);
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
            else if (ev[1] === 'done') { end(d.words); toast(d.words, false); await refresh(); return; }
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

    function pageHead(s, sum, cards, primaryId) {
      const ready = Boolean(sum.route && sum.route.ready);
      const primary = ready
        ? h('button', { type: 'button', class: 'sh-btn-primary cn-primary', 'data-cn-primary': 'continue', onClick: land }, `${s.continue || 'Continue to the workspace'} →`)
        : h('button', { type: 'button', class: 'sh-btn-primary cn-primary', 'data-cn-primary': 'set-up', onClick: () => { live.sel = primaryId; drawContext(); markChosen(); focusVerb(primaryId); } }, s.setUp || 'Set up a model');
      return h('header', { class: 'cn-head page-head' },
        h('div', { class: 'cn-head-words' },
          h('p', { class: 'sh-label cn-kicker page-kicker', 'data-kicker': '' }, `${KICKER_NUMBER} / ${s.kicker || ''}`),
          h('h1', { id: 'cn-title', class: 'cn-title page-title', tabindex: '-1' }, s.title || ''),
          h('p', { class: 'cn-lead page-intro' }, s.lead || '')),
        h('div', { class: 'cn-head-actions' },
          h('button', { type: 'button', class: 'sh-btn-text', onClick: goChat }, s.explore || 'Explore without a model'),
          primary));
    }

    function band(s, sum, cards, primaryId) {
      const r = sum.route || { ready: false, label: '', note: '' };
      const rec = sum.records || { words: 'Local by default', line: s.records || '' };
      const who = userWords();
      const next = cards.find((c) => c.id === primaryId);
      const action = r.ready
        ? h('button', { type: 'button', class: 'sh-btn is-small cn-band-action', 'data-cn-band-action': 'check', onClick: () => { const c = cards.find((x) => x.id === (r.kind === 'local' ? 'ollama-local' : 'openrouter')); if (c) check(c, c.id); } }, 'Check the route’s provider')
        : (next ? h('button', { type: 'button', class: 'sh-btn is-small cn-band-action', 'data-cn-band-action': next.id, onClick: () => { live.sel = next.id; drawContext(); markChosen(); focusVerb(next.id); } }, `${next.verb} · ${next.title}`) : null);
      const cell = (k, v, note) => h('div', { class: 'cn-cell' }, h('span', { class: 'sh-label cn-cell-k' }, k), h('strong', { class: 'cn-cell-v' }, v), note ? h('span', { class: 'sh-note cn-cell-n' }, note) : null);
      return h('div', { class: 'cn-band page-band', role: 'group', 'aria-label': 'Summary' },
        cell('Account', who ? `Signed in · ${who}` : 'Not signed in', who ? 'Connections are kept under your account, not a project.' : 'Nothing is kept until an account is signed in.'),
        cell('Model', r.ready ? (r.model || r.label) : 'Choose a provider', r.ready ? r.label : r.note),
        cell('Records', rec.words, rec.line),
        action ? h('div', { class: 'cn-cell cn-cell-action' }, action) : null);
    }

    function work(cards, primaryId) {
      return h('section', { class: 'cn-work', 'aria-label': 'Your providers', 'data-cn-work': '' },
        h('div', { class: 'cn-work-head' }, h('span', { class: 'sh-label' }, 'Your providers'), h('span', { class: 'sh-note', 'data-cn-read-at': '' }, live.data && live.data.readAt ? `read ${clock(live.data.readAt)} · files only, nothing asked of a provider` : '')),
        h('div', { class: 'cn-cards' }, ...cards.map((c) => cardEl(c, primaryId))));
    }

    function context(s, sum, cards) {
      const aside = h('aside', { class: 'cn-context page-context', 'aria-label': 'Choose your model' },
        h('div', { class: 'cn-context-head' }, h('h2', { class: 'cn-context-title' }, s.contextTitle || 'Choose your model'), h('p', { class: 'sh-note' }, s.contextLead || '')),
        h('div', { class: 'cn-picker', role: 'group', 'aria-label': 'Provider' }, ...cards.map((c) => h('button', { type: 'button', class: 'cn-pick', 'data-cn-pick': c.id, 'aria-pressed': c.id === live.sel ? 'true' : 'false', onClick: () => { live.sel = c.id; drawContext(); markChosen(); } }, c.title))),
        h('div', { class: 'cn-context-body', 'data-cn-context': '' }),
        h('div', { class: 'cn-together' }, h('span', { class: 'cn-note-mark', 'aria-hidden': 'true' }, '▤ '), h('span', { class: 'sh-note' }, s.together || '')));
      return aside;
    }
    function drawContext() {
      const body = host.querySelector('[data-cn-context]');
      if (!body || !live.data) return;
      const cards = live.data.cards || [];
      const c = cards.find((x) => x.id === live.sel) || cards[0];
      if (!c) { body.replaceChildren(); return; }
      for (const b of host.querySelectorAll('[data-cn-pick]')) b.setAttribute('aria-pressed', b.dataset.cnPick === c.id ? 'true' : 'false');
      const chk = live.data.checks && live.data.checks[c.id];
      const act = verbAction(c);
      const links = (c.links || []).map((l) => h('button', { type: 'button', class: 'sh-btn-text cn-link', onClick: () => open(l.url) }, `${l.label} ↗`));
      const offer = c.id === 'ollama-local' && c.local && c.local.offer ? h('div', { class: 'cn-offer', 'data-cn-offer': '' },
        h('p', { class: 'cn-offer-lead' }, c.local.offer.lead),
        h('ul', { class: 'cn-starters' }, ...(c.local.starters || []).map((m) => h('li', { class: 'cn-starter' },
          h('button', { type: 'button', class: 'sh-btn is-small cn-starter-pick', 'data-cn-starter': m.model, onClick: () => showPull(c, m.model) }, `Offer ${m.model}`),
          h('span', { class: 'cn-starter-words' }, h('strong', null, m.size), ` on disk · ${m.use}${m.default ? ' · the default' : ''}`)))),
        h('p', { class: 'sh-note' }, c.local.offer.hardware),
        h('p', { class: 'sh-note' }, `Sizes: ${c.local.sizeNote}.`)) : null;
      body.replaceChildren(
        h('div', { class: 'cn-context-card', 'data-cn-context-for': c.id },
          h('div', { class: 'cn-context-mark', 'aria-hidden': 'true' }, MARKS[c.id] || '·'),
          h('h3', { class: 'cn-context-name' }, c.title),
          h('p', { class: 'cn-context-sub' }, c.subtitle),
          h('p', { class: 'cn-context-words' }, c.body),
          h('p', { class: `sh-note cn-context-state` }, h('span', { class: `cn-situation is-${c.situation}` }, c.situationWords || ''), ' · ', c.words),
          act ? h('button', { type: 'button', class: 'sh-btn-primary cn-context-verb', 'data-cn-context-verb': c.id, onClick: act }, `${verbLabel(c)} →`) : null,
          h('dl', { class: 'cn-facts' },
            h('div', null, h('dt', null, 'Cost'), h('dd', null, c.cost || '')),
            chk ? h('div', null, h('dt', null, 'A check sends'), h('dd', null, chk.sends || '')) : null,
            chk ? h('div', null, h('dt', null, 'What it asks'), h('dd', null, chk.words || '')) : null,
            c.key ? h('div', null, h('dt', null, 'Key'), h('dd', null, `${c.key.fingerprint} (from ${c.key.from}; never shown)`)) : null),
          links.length ? h('div', { class: 'sh-actions cn-context-links' }, ...links) : null),
        offer);
    }
    function markChosen() {
      for (const el of main.querySelectorAll('.cn-card[data-provider]')) { const on = el.dataset.provider === live.sel; el.classList.toggle('is-chosen', on); if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current'); }
    }

    function dock(s, cards) {
      const local = cards.find((c) => c.id === 'ollama-local');
      const checkable = cards.filter((c) => c.model && c.situation === 'existing');
      return h('div', { class: 'cn-dock page-dock', role: 'toolbar', 'aria-label': 'Models & accounts tools' },
        h('span', { class: 'sh-label cn-dock-label' }, 'Models & accounts tools'),
        h('button', { type: 'button', class: 'sh-btn-text cn-dock-btn', 'data-cn-dock': 'check-all', disabled: checkable.length ? null : true, title: checkable.length ? `Checks ${checkable.map((c) => c.title).join(', ')}: each asks its provider once and runs no model` : 'Nothing to check yet: no provider holds a setup', onClick: async () => { for (const c of checkable) await check(c, c.id); } }, `⟳ Check ${checkable.length ? checkable.length : ''} configured`.replace('  ', ' ')),
        local ? h('button', { type: 'button', class: 'sh-btn-text cn-dock-btn', 'data-cn-dock': 'download', onClick: () => showPull(local) }, '⇩ Download a model') : null,
        h('button', { type: 'button', class: 'sh-btn-text cn-dock-btn', 'data-cn-dock': 'back', onClick: () => { if (typeof sh.go === 'function') sh.go('account'); } }, `← ${s.back || 'Back'}`),
        h('span', { class: 'cn-dock-spacer' }),
        h('button', { type: 'button', class: 'sh-btn-text cn-dock-btn', 'data-cn-dock': 'records', 'aria-expanded': live.recordsOpen ? 'true' : 'false', onClick: () => { const d = host.querySelector('.cn-records'); if (d) { d.open = !d.open; live.recordsOpen = d.open; } } }, '▤ Records'));
    }

    function records(s, data, cards) {
      const d = h('details', { class: 'cn-records records', open: live.recordsOpen ? true : null },
        h('summary', { class: 'cn-records-summary' }, h('span', { class: 'sh-label' }, 'Records'), h('span', { class: 'sh-note' }, ' what this computer kept of these connections · the syntax behind Details')),
        h('dl', { class: 'cn-records-list' },
          ...cards.map((c) => h('div', { class: 'cn-record', 'data-cn-record': c.id },
            h('dt', null, c.title),
            h('dd', null, c.at ? `last observed ${clock(c.at)} · ${c.state}` : `no observation kept · ${c.state}`, c.key ? ` · key ${c.key.fingerprint} from ${c.key.from}` : '', c.cloudflare && c.cloudflare.file ? ` · settings in ${c.cloudflare.file}` : ''))),
          h('div', { class: 'cn-record' }, h('dt', null, 'Files'), h('dd', null, 'providers.json (keys, 0600) · state/connections.json (observations) · state/cloudflare.json (optional settings), all in your Timmy home')),
          h('div', { class: 'cn-record' }, h('dt', null, 'Read'), h('dd', null, data.readAt ? `${clock(data.readAt)} · GET /api/connections: files only; a check is the one thing that asks a provider` : 'not read'))),
        h('p', { class: 'sh-note cn-records-foot' }, s.footerStrong || '', ' ', s.footer || ''));
      d.addEventListener('toggle', () => { live.recordsOpen = d.open; const b = host.querySelector('[data-cn-dock="records"]'); if (b) b.setAttribute('aria-expanded', d.open ? 'true' : 'false'); });
      return d;
    }

    /** The page's head, band and state through the shell (SHELL CONTRACT v1 §2.3), when the shell has them. */
    function register(s, sum, cards, primaryId) {
      if (typeof sh.page !== 'function') return;
      const ready = Boolean(sum.route && sum.route.ready);
      const who = userWords();
      try {
        sh.page('connections', {
          kicker: `${KICKER_NUMBER} / ${s.kicker || 'CONNECT A PROVIDER'}`,
          title: s.title || '',
          intro: s.lead || '',
          primary: ready
            ? { label: `${s.continue || 'Continue to the workspace'} →`, run: land }
            : { label: s.setUp || 'Set up a model', run: () => { live.sel = primaryId; drawContext(); markChosen(); focusVerb(primaryId); } },
          context: 'selection',
          band: [{ k: 'Account', v: who ? `Signed in · ${who}` : 'Not signed in' }],
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
      if (scaffold) {
        // the shell's regions: the head and the band are the shell's (register), the work, the context, the dock's own
        // buttons and the records are this screen's
        register(s, sum, cards, primaryId);
        main.replaceChildren(work(cards, primaryId), note);
        if (scaffold.context) scaffold.context.replaceChildren(...context(s, sum, cards).childNodes);
        if (scaffold.dock) { for (const old of scaffold.dock.querySelectorAll('[data-cn-dock]')) old.remove(); for (const b of dock(s, cards).querySelectorAll('[data-cn-dock]')) { b.classList.add('dock-btn'); scaffold.dock.append(b); } }
        if (scaffold.records) scaffold.records.replaceChildren(records(s, data, cards));
      } else {
        main.replaceChildren(
          pageHead(s, sum, cards, primaryId),
          band(s, sum, cards, primaryId),
          h('div', { class: 'cn-grid page-body' }, work(cards, primaryId), context(s, sum, cards)),
          dock(s, cards),
          records(s, data, cards),
          note);
      }
      drawContext();
      // every path that applies a provider's state ends here (the first draw, Check, a download, a key, a delete, the socket's
      // connections event through update()): the feed says each change once, with the backend's event as its source
      feedStates(cards);
      // the download box and a card's last status line outlive a render (a refresh after an action keeps what it said)
      if (live.pullBox) { const local = cardOf('ollama-local'); const at = local && local.querySelector('.cn-actions'); if (at) at.after(live.pullBox); }
      if (live.said) { say(cardOf(live.said.id), live.said.words, live.said.kind); live.said = null; }
      // a sign-in pending: ask again until the callback landed (the browser is away on OpenRouter's page)
      const pending = cards.some((c) => c.state === 'pending');
      if (pending && !live.poll) live.poll = setTimeout(() => { live.poll = null; void refresh(); }, 3000);
    }

    async function refresh() {
      if (live.destroyed) return;
      let r;
      try { r = await api('/api/connections'); } catch { r = null; }
      if (!r || !r.ok) {
        main.replaceChildren(h('p', { class: 'sh-note sh-error cn-failed', role: 'alert' }, r && r.status === 401 ? 'Sign in to Timmy first: the connections are kept under your account.' : 'The connections could not be read from the companion.'));
        return;
      }
      let data; try { data = await r.json(); } catch { data = null; }
      if (!data || !data.ok) { main.replaceChildren(h('p', { class: 'sh-note sh-error cn-failed', role: 'alert' }, 'The connections could not be read from the companion.')); return; }
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
