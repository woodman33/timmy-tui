// R11 round 4 (H171): the page's SHELL — the three screens of the account → connections → chat journey and what every
// screen shares. Loaded after companion.js (the launch token, kept in this page's memory only) and before the screens'
// own scripts (H173's account.js, H170's screen-connections.js, this page's chat-shell.js), which draw against it.
//
// THE CONTRACT (posted in the handoff; a change is posted there first):
//   window.TimmyShell = {
//     SCREENS: ['account', 'connections', 'chat'],
//     mount(screenId, drawFn),      // drawFn(host, shell) draws the screen into its host each time it is shown
//     go(screenId, why?),           // shows the screen (the others hidden), remembers it (localStorage: the screen id only)
//     current(),                    // the screen shown now
//     fetch(url, init),             // the launch token (Authorization: Bearer) + the session (X-Timmy-Session) on every
//                                   // request; credentials omitted, no cache; a 401 whose JSON says { needs: 'session' }
//                                   // → the account screen (and the session forgotten); any other 401 → the token's refusal
//     socketHello(),                // { session } to spread into the WebSocket hello (companion.js helloMessage)
//     session: { set(token, user), clear(), get(), user() },   // H173's account.js keeps it fresh; memory only
//     identity(),                   // the last GET /api/identity answer ({ configured, needs, words, … }) or null
//     land(),                       // the landing rule, run again (after a sign-in, a connection or a sign-out)
//     toast(words, { live? }),      // one line at the bottom, role=status; green only with { live: true } (an observed fact)
//     h(tag, attrs, ...children),   // the page's element helper
//     tokens: { … },                // the CSS classes and variables the screens use (see TOKENS below)
//     on(event, fn)                 // 'screen' { id }, 'session' { user | null }, 'identity' { … }
//   }
// THE LANDING RULE: 'account' when GET /api/identity says not configured, or there is no session; 'connections' when
// signed in with no chat route (GET /api/chat/route not ready); 'chat' otherwise. A remembered screen is restored only when
// signed in. Nothing here signs anyone in; the page keeps no token and no key in any storage (the screen id and the draft only).
(() => {
  'use strict';
  const SCREENS = ['account', 'connections', 'chat'];
  const SCREEN_KEY = 'timmy.shell.screen';
  const draws = Object.create(null);
  const listeners = Object.create(null);
  let shown = '';
  let identityAnswer = null;
  let sessionToken = '';
  let sessionUser = null;
  let landing = null;

  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : String(v)); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };

  const emit = (event, detail) => { for (const fn of listeners[event] || []) { try { fn(detail); } catch (e) { /* a listener's own */ } } };

  const host = (id) => document.getElementById(`screen-${id}`);

  /** The launch token: companion.js keeps it (a classic script's top-level const is shared here); none → the page says so already. */
  const launchToken = () => (typeof companion !== 'undefined' && companion && companion.token) || '';

  const TOKENS = Object.freeze({
    // the theme's variables (/timmy-theme.css, src/theme/tokens.ts): black ground, structure greys, amber, earned green
    vars: ['--timmy-ground', '--timmy-surface', '--timmy-raised', '--timmy-line', '--timmy-line-strong', '--timmy-text', '--timmy-text-secondary', '--timmy-accent', '--timmy-accent-ink', '--timmy-accent-soft', '--timmy-silver', '--timmy-live', '--timmy-font-mono'],
    // the shell's classes (companion.css, "R11 round 4: the shell's shared classes")
    screen: 'sh-screen',          // a screen's host: <section class="sh-screen" id="screen-<id>" data-screen="<id>">
    head: 'sh-head',              // the onboarding header: the mark, the three steps (sh-steps: sh-step, is-current), the right words
    foot: 'sh-foot',              // the onboarding footer: two lines of words
    card: 'sh-card',              // a bordered well (the account panel, a provider card); is-chosen draws the amber border
    field: 'sh-field',            // <label class="sh-field"><span class="sh-field-k">Email address</span><input class="sh-input"></label>
    input: 'sh-input',
    btnPrimary: 'sh-btn-primary', // the ONE primary next step: amber fill (and .is-wide for a full-width one)
    btn: 'sh-btn',                // a secondary button: structure border, text colour
    btnText: 'sh-btn-text',       // a text button (underlined): Sign in · Back
    label: 'sh-label',            // the tiny uppercase label (WORKSPACE, NEXT TURN, CONNECT YOUR MODELS & TOOLS)
    state: 'sh-state',            // a state word: plain; .is-live only for an observed live fact (green); .is-attn amber
    note: 'sh-note',              // the fine print under a control
    divider: 'sh-divider',        // "— or create an account —"
    toast: 'sh-toast',            // the shell's toast (TimmyShell.toast draws it)
    mark: 'sh-mark',              // the T mark: <span class="sh-mark"><canvas data-timmy-mark></canvas><span class="sh-mark-text">T</span></span>
  });

  function show(id) {
    for (const s of SCREENS) {
      const el = host(s);
      if (!el) continue;
      el.hidden = s !== id;
      el.setAttribute('aria-hidden', s === id ? 'false' : 'true');
    }
    document.body.dataset.screen = id;
    shown = id;
  }

  function draw(id) {
    const el = host(id);
    const fn = draws[id];
    if (!el) return;
    if (fn) { try { fn(el, shell); } catch (e) { el.replaceChildren(h('p', { class: 'sh-note sh-error', role: 'alert' }, `This screen could not be drawn: ${e && e.message ? e.message : e}`)); } }
    else if (!el.childElementCount) el.replaceChildren(fallback(id));
  }

  /** What a screen shows until its owner's script mounts it: the dependency named, nothing pretended. */
  function fallback(id) {
    if (id === 'account') {
      const i = identityAnswer;
      const needs = i && Array.isArray(i.needs) && i.needs.length ? i.needs.join(', ') : '';
      return h('div', { class: 'sh-card sh-fallback' },
        h('h2', null, 'Create your Timmy account'),
        h('p', { class: 'sh-note' }, i ? (i.words || (i.configured ? 'An identity provider is configured; this screen’s sign-in has not loaded.' : 'No identity provider is configured, so nothing signs in here.')) : 'GET /api/identity has not answered: this companion does not have the account screen’s server side yet.'),
        needs ? h('p', { class: 'sh-note' }, h('span', { class: 'sh-label' }, 'Needs '), needs) : null,
        h('p', { class: 'sh-note' }, 'This is the shell’s placeholder: the account screen (account.js) draws here when it is mounted.'),
        h('div', { class: 'sh-actions' }, h('button', { type: 'button', class: 'sh-btn', 'data-shell-go': 'connections' }, 'Review the workspace without an account →')),
        h('p', { class: 'sh-note' }, 'Nothing is signed in: the page reads and writes as this companion’s own process, as it did before accounts.'));
    }
    if (id === 'connections') {
      return h('div', { class: 'sh-card sh-fallback' },
        h('h2', null, 'Choose how you want to run.'),
        h('p', { class: 'sh-note' }, 'This is the shell’s placeholder: the connections screen (screen-connections.js) draws here when it is mounted; its words are the provider states of GET /api/connections.'),
        h('div', { class: 'sh-actions' }, h('button', { type: 'button', class: 'sh-btn-text', 'data-shell-go': 'account' }, 'Back'), h('button', { type: 'button', class: 'sh-btn', 'data-shell-go': 'chat' }, 'Explore without a model')));
    }
    return h('p', { class: 'sh-note' }, 'The chat screen draws here.');
  }

  function remember(id) { try { localStorage.setItem(SCREEN_KEY, id); } catch (e) { /* no storage here */ } }
  function remembered() { try { return localStorage.getItem(SCREEN_KEY) || ''; } catch (e) { return ''; } }

  const shell = {
    SCREENS,
    tokens: TOKENS,
    h,
    mount(id, drawFn) {
      if (!SCREENS.includes(id) || typeof drawFn !== 'function') throw new Error(`TimmyShell.mount: unknown screen or draw: ${id}`);
      draws[id] = drawFn;
      if (shown === id) draw(id);
    },
    go(id, why) {
      if (!SCREENS.includes(id)) throw new Error(`TimmyShell.go: unknown screen: ${id}`);
      show(id);
      draw(id);
      remember(id);
      emit('screen', { id, why: why || '' });
      // focus the screen's first heading, so the change is announced and the keyboard is on the screen
      const el = host(id);
      const heading = el && el.querySelector('h1, h2');
      if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: false }); }
      try { window.scrollTo(0, 0); } catch (e) { /* no window scroll */ }
    },
    current: () => shown,
    identity: () => identityAnswer,
    session: {
      set(token, user) {
        sessionToken = typeof token === 'string' ? token : '';
        sessionUser = user && typeof user === 'object' ? user : null;
        emit('session', { user: sessionUser });
      },
      clear() { sessionToken = ''; sessionUser = null; emit('session', { user: null }); },
      get: () => sessionToken,
      user: () => sessionUser,
    },
    fetch(url, init) {
      const o = Object.assign({}, init || {});
      const headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + launchToken() });
      if (sessionToken) headers['X-Timmy-Session'] = sessionToken;
      o.headers = headers;
      o.credentials = 'omit';
      o.cache = 'no-store';
      return fetch(url, o).then(async (r) => {
        if (r.status !== 401) return r;
        let body = null;
        try { body = await r.clone().json(); } catch (e) { body = null; }
        if (body && body.needs === 'session') {
          shell.session.clear();
          shell.toast(body.words || body.error || 'Sign in to continue.');
          shell.go('account', 'session');
        } else if (typeof companion !== 'undefined' && companion && typeof companion.refuse === 'function') companion.refuse();
        return r;
      });
    },
    socketHello: () => (sessionToken ? { session: sessionToken } : {}),
    toast(words, opts) {
      const old = document.querySelector('.sh-toast');
      if (old) old.remove();
      const t = h('div', { class: `sh-toast${opts && opts.live ? ' is-live' : ''}`, role: 'status' }, words);
      document.body.append(t);
      setTimeout(() => { if (t.isConnected) t.remove(); }, 6000);
      return t;
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); }; },
    /** The landing rule. Returns the screen it chose. */
    async land() {
      if (landing) return landing;
      landing = (async () => {
        let configured = false;
        // no launch token (or not this companion's): the page's own note says how to open it from Timmy; nothing else is read
        if (!launchToken() || (typeof companion !== 'undefined' && companion && companion.refused)) { shell.go('chat', 'no-token'); return 'chat'; }
        try {
          const r = await shell.fetch('/api/identity');
          if (r.status === 200) { identityAnswer = await r.json(); configured = Boolean(identityAnswer && identityAnswer.configured); }
          else if (r.status === 404) identityAnswer = { configured: false, needs: [], words: 'This companion has no GET /api/identity yet (the account screen’s server side), so no account can be made or restored here.' };
          else identityAnswer = { configured: false, needs: [], words: `GET /api/identity answered HTTP ${r.status}.` };
        } catch (e) { identityAnswer = { configured: false, needs: [], words: 'GET /api/identity could not be read.' }; }
        emit('identity', identityAnswer);
        let id = 'account';
        if (configured && sessionToken) {
          let ready = false;
          // (GET /api/chat/route answers the PageRoute itself: { kind, ready, … })
          try { const r = await shell.fetch('/api/chat/route'); if (r.status === 200) { const b = await r.json(); ready = Boolean(b && b.ready); } } catch (e) { ready = false; }
          const kept = remembered();
          id = ready ? (SCREENS.includes(kept) ? kept : 'chat') : 'connections';
        }
        shell.go(id, 'landing');
        return id;
      })();
      try { return await landing; } finally { landing = null; }
    },
  };

  document.addEventListener('click', (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest('[data-shell-go]') : null;
    if (b) { ev.preventDefault(); shell.go(b.getAttribute('data-shell-go'), 'click'); }
  });

  window.TimmyShell = shell;
  // the first screen: nothing until the landing rule answers; the screens' scripts mount meanwhile
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { shell.land(); });
  else shell.land();
})();
