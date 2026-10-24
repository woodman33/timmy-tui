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
    const live = { data: null, pull: null, destroyed: false, poll: null };
    host.replaceChildren();
    const main = h('div', { class: 'sh-main cx-main' });
    const head = h('header', { class: 'sh-head' },
      h('span', { class: 'sh-head-brand' }, h('span', { class: 'sh-mark', 'aria-hidden': 'true' }, h('span', { class: 'sh-mark-text' }, 'T')), 'TIMMY'),
      h('nav', { class: 'sh-steps', 'aria-label': 'Setup steps' },
        h('span', { class: 'sh-step' }, h('b', null, '01'), 'Account'),
        h('span', { class: 'sh-step is-current', 'aria-current': 'step' }, h('b', null, '02'), 'Connections'),
        h('span', { class: 'sh-step' }, h('b', null, '03'), 'Workspace')),
      h('span', { class: 'sh-head-words' }, (() => { const u = sh.session && typeof sh.session.user === 'function' ? sh.session.user() : null; return u && (u.username || u.email || u.id) ? `Signed in · ${u.username || u.email || u.id}` : 'No account signed in'; })()));
    const foot = h('footer', { class: 'sh-foot cx-foot-shell' });
    host.append(head, main, foot);

    const cardOf = (id) => main.querySelector(`[data-provider="${id}"]`);
    const say = (card, words, kind) => {
      const el = card && card.querySelector('[data-cx-say]');
      if (!el) return;
      el.textContent = words || '';
      el.dataset.kind = kind || '';
    };

    function cardEl(c) {
      const mark = stateMark(c.state);
      return h('article', { class: `sh-card cx-card cx-card-${c.id}`, 'data-provider': c.id, 'data-state': c.state, 'aria-labelledby': `cx-card-${c.id}-title` },
        h('header', { class: 'cx-card-head' },
          h('span', { class: 'cx-card-mark', 'aria-hidden': 'true' }, MARKS[c.id] || '·'),
          h('div', { class: 'cx-card-names' },
            h('h2', { id: `cx-card-${c.id}-title`, class: 'cx-card-title' }, c.title),
            h('p', { class: 'sh-sub cx-card-sub' }, c.subtitle))),
        h('p', { class: 'cx-card-body' }, c.body),
        actions(c),
        h('footer', { class: 'cx-card-foot' },
          h('p', { class: `${mark.cls} cx-state` }, h('span', { class: 'cx-state-glyph', 'aria-hidden': 'true' }, mark.glyph), ' ', h('span', { class: 'cx-state-word' }, c.state)),
          h('p', { class: 'sh-note cx-words' }, c.words),
          c.next ? h('p', { class: 'sh-note cx-next' }, h('span', { class: 'cx-next-label' }, 'Next '), c.next) : null,
          c.lines && c.lines.length ? h('ul', { class: 'sh-note cx-lines' }, ...c.lines.map((l) => h('li', null, l))) : null,
          h('p', { class: 'sh-note cx-say', 'data-cx-say': '', 'aria-live': 'polite' })));
    }

    function actions(c) {
      const row = h('div', { class: 'sh-actions cx-actions' });
      if (c.id === 'openrouter') {
        row.append(h('button', { type: 'button', class: 'sh-btn-text cx-link', onClick: () => startOpenRouter(c) }, `${c.action} ↗`));
        if (c.key) row.append(h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => check(c, 'openrouter') }, 'Check the key'), h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => forget(c) }, 'Forget the key'));
      } else if (c.id === 'ollama-local') {
        const local = c.local || {};
        row.append(
          h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => { open(local.link); say(cardOf(c.id), `${local.install || 'Install Ollama'}; then ${local.start || 'start it'}. Then Check.`, 'step'); } }, 'Install Ollama'),
          h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => showPull(c) }, 'Download a local model'),
          h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => check(c, 'ollama-local') }, 'Check'),
          h('button', { type: 'button', class: 'sh-btn-text cx-link', onClick: () => open(local.link) }, `${c.action} ↗`));
      } else if (c.id === 'ollama-cloud') {
        const page = (c.links || []).find((l) => /keys/.test(l.url));
        const input = h('input', { type: 'password', class: 'sh-input', id: 'cx-ollama-cloud-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'Ollama API key', 'aria-label': 'Ollama API key' });
        const form = h('form', { class: 'cx-form', onSubmit: async (e) => {
          e.preventDefault();
          const key = input.value;
          input.value = '';
          if (!key.trim()) { say(cardOf(c.id), 'Paste the key from ollama.com/settings/keys first.', 'failed'); return; }
          const r = await postJson('/api/connections/ollama-cloud/key', { key });
          say(cardOf(c.id), r.ok ? r.body.words : (r.body.error || 'The key was not saved.'), r.ok ? 'step' : 'failed');
          if (r.ok) { toast(r.body.words, false); await refresh(); }
        } },
          h('label', { for: 'cx-ollama-cloud-key', class: 'sh-note cx-label' }, 'Paste an Ollama API key (sent once, in the request body; never shown again)'),
          h('div', { class: 'cx-form-row' }, input, h('button', { type: 'submit', class: 'sh-btn is-small' }, 'Save the key')));
        row.append(h('button', { type: 'button', class: 'sh-btn-text cx-link', onClick: () => open(page && page.url) }, `${c.action} ↗`), form);
        if (c.key) row.append(h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => check(c, 'ollama-cloud') }, 'Check the key'), h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => forget(c) }, 'Forget the key'));
      } else if (c.id === 'cloudflare') {
        const cf = c.cloudflare || { gatewayUrl: null, cloudLogs: false };
        const url = h('input', { type: 'url', class: 'sh-input', id: 'cx-cloudflare-gateway', autocomplete: 'off', placeholder: 'https://gateway.ai.cloudflare.com/…', value: cf.gatewayUrl || '', 'aria-label': 'AI Gateway address (optional)' });
        const logs = h('input', { type: 'checkbox', id: 'cx-cloudflare-logs', checked: cf.cloudLogs === true });
        const form = h('form', { class: 'cx-form', onSubmit: async (e) => {
          e.preventDefault();
          const r = await postJson('/api/connections/cloudflare', { gatewayUrl: url.value.trim() || null, cloudLogs: logs.checked });
          say(cardOf(c.id), r.ok ? r.body.words : (r.body.error || 'The settings were not saved.'), r.ok ? 'step' : 'failed');
          if (r.ok) await refresh();
        } },
          h('label', { for: 'cx-cloudflare-gateway', class: 'sh-note cx-label' }, 'AI Gateway / model routing (optional)'),
          h('div', { class: 'cx-form-row' }, url),
          h('label', { class: 'sh-note cx-check', for: 'cx-cloudflare-logs' }, logs, ' Cloud logs (optional). Local logs are already part of the design.'),
          h('div', { class: 'cx-form-row' }, h('button', { type: 'submit', class: 'sh-btn is-small' }, 'Save Cloudflare settings'), (cf.gatewayUrl || cf.cloudLogs) ? h('button', { type: 'button', class: 'sh-btn is-small', onClick: () => forget(c) }, 'Remove the settings') : null));
        const setup = (c.links || [])[0];
        row.append(h('button', { type: 'button', class: 'sh-btn-text cx-link', onClick: () => open(setup && setup.url) }, `${c.action} ↗`), form);
      }
      return row;
    }

    async function startOpenRouter(c) {
      say(cardOf(c.id), 'Starting the sign-in…', 'step');
      const r = await postJson('/api/connections/openrouter/start', { callback: `${location.origin}/api/connections/openrouter/callback` });
      if (!r.ok) { say(cardOf(c.id), r.body.error || 'The sign-in could not start.', 'failed'); return; }
      open(r.body.url);
      await refresh();
      say(cardOf(c.id), `${r.body.words} This card says when the key is saved.`, 'step');
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
      say(cardOf(c.id), (j && (j.words || j.error)) || 'Nothing was removed.', r && r.ok ? 'step' : 'failed');
      await refresh();
    }

    // Ollama · local: the download, with its size, the person's confirmation, its progress and Cancel (SSE from the server)
    function showPull(c) {
      const card = cardOf(c.id);
      let box = card.querySelector('.cx-pull');
      if (box) { box.remove(); return; }
      const local = c.local || { starters: [] };
      const select = h('select', { class: 'sh-select', id: 'cx-pull-model', 'aria-label': 'Model to download' }, ...(local.starters || []).map((m) => h('option', { value: m.model, selected: m.default }, `${m.model} · ${m.size} · ${m.use}`)));
      const other = h('input', { type: 'text', class: 'sh-input', id: 'cx-pull-other', placeholder: 'or another model name from the Ollama library', 'aria-label': 'Another model name', autocomplete: 'off' });
      const status = h('p', { class: 'sh-note cx-pull-status', 'aria-live': 'polite' }, local.sizeNote ? `Sizes: ${local.sizeNote}.` : '');
      const bar = h('progress', { class: 'cx-progress', max: '100', value: '0', hidden: true });
      const confirmBtn = h('button', { type: 'button', class: 'sh-btn-primary is-small', hidden: true }, 'Confirm the download');
      const cancelBtn = h('button', { type: 'button', class: 'sh-btn is-small', hidden: true }, 'Cancel');
      const startBtn = h('button', { type: 'button', class: 'sh-btn is-small' }, 'Show the size');
      box = h('div', { class: 'cx-pull' },
        h('label', { for: 'cx-pull-model', class: 'sh-note cx-label' }, 'Download a local model into the Ollama on this computer: its size first; it starts only when you confirm.'),
        h('div', { class: 'cx-form-row' }, select, other),
        h('div', { class: 'cx-form-row' }, startBtn, confirmBtn, cancelBtn),
        bar, status);
      card.querySelector('.cx-actions').after(box);
      startBtn.addEventListener('click', () => startPull((other.value.trim() || select.value), { status, bar, confirmBtn, cancelBtn, startBtn }));
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

    function render(data) {
      live.data = data;
      const s = data.screen || {};
      main.replaceChildren(
        h('div', { class: 'cx-head' },
          h('p', { class: 'sh-label cx-kicker' }, s.kicker || ''),
          h('h1', { id: 'cx-title', class: 'cx-title', tabindex: '-1' }, s.title || ''),
          h('p', { class: 'cx-lead' }, s.lead || '')),
        h('div', { class: 'cx-cards' }, ...PROVIDERS.map((id) => { const c = (data.cards || []).find((x) => x.id === id); return c ? cardEl(c) : null; })),
        h('div', { class: 'cx-foot' },
          h('div', { class: 'cx-foot-words' }, h('p', { class: 'cx-strong' }, s.footerStrong || ''), h('p', { class: 'sh-note' }, s.footer || '')),
          h('div', { class: 'sh-actions cx-foot-actions' },
            h('button', { type: 'button', class: 'sh-btn-text', onClick: () => { if (typeof sh.go === 'function') sh.go('account'); } }, s.back || 'Back'),
            h('button', { type: 'button', class: 'sh-btn', onClick: () => { if (typeof sh.go === 'function') sh.go('chat'); } }, s.explore || 'Explore without a model'),
            h('button', { type: 'button', class: 'sh-btn-primary', onClick: () => { if (typeof sh.land === 'function') sh.land(); else if (typeof sh.go === 'function') sh.go('chat'); } }, `${s.continue || 'Continue to the workspace'} →`))),
        h('p', { class: 'sh-note cx-note' }, h('span', { class: 'cx-note-mark', 'aria-hidden': 'true' }, '↳ '), s.note || ''));
      foot.replaceChildren(h('span', null, s.footerStrong || ''), h('span', null, s.footer || ''));
      // a sign-in pending: ask again until the callback landed (the browser is away on OpenRouter's page)
      const pending = (data.cards || []).some((c) => c.state === 'pending');
      if (pending && !live.poll) live.poll = setTimeout(() => { live.poll = null; void refresh(); }, 3000);
    }

    async function refresh() {
      if (live.destroyed) return;
      let r;
      try { r = await api('/api/connections'); } catch { r = null; }
      if (!r || !r.ok) {
        main.replaceChildren(h('p', { class: 'sh-note sh-error cx-failed', role: 'alert' }, r && r.status === 401 ? 'Sign in to Timmy first: the connections are kept under your account.' : 'The connections could not be read from the companion.'));
        return;
      }
      let data; try { data = await r.json(); } catch { data = null; }
      if (!data || !data.ok) { main.replaceChildren(h('p', { class: 'sh-note sh-error cx-failed', role: 'alert' }, 'The connections could not be read from the companion.')); return; }
      if (live.destroyed) return;
      render(data);
    }

    const screen = {
      update(event) { if (event && event.type === 'connections') void refresh(); },
      refresh,
      destroy() { live.destroyed = true; if (live.poll) { clearTimeout(live.poll); live.poll = null; } if (live.pull) { try { live.pull.reader.cancel(); } catch { /* closed */ } live.pull = null; } },
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
