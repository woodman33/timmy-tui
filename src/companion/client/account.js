// R11 round 4 (H173, contract C1): the ACCOUNT screen — "Create your Timmy account" / "Welcome back to Timmy" — drawn into
// the shell's #screen-account host (shell.js TimmyShell.mount('account', draw)). Real Clerk, verified by this server:
//
//   - GET /api/identity says whether the identity provider is configured (CLERK_PUBLISHABLE_KEY + CLERK_JWT_KEY or
//     CLERK_SECRET_KEY) and where Clerk's JS is served from (clerkScript: /vendor/clerk/clerk.no-rhc.mjs, by this
//     companion from node_modules/@clerk/clerk-js/dist/). That file is Clerk's "no remote hosted code" ES module: it loads
//     no chunk and injects no script of another site's (the captcha loader of clerk.browser.js is not in it), so the page
//     loads nothing from anywhere but this companion; this classic script imports it (import(), same origin, within the
//     page's script-src 'self') and the module talks only to the instance's frontend API, which the page's
//     Content-Security-Policy names in connect-src when configured. Not configured, or the module not installed, or Clerk
//     not starting within LOAD_MS: the screen is drawn and reviewable, the dependency or the failure named in words
//     beside the disabled buttons, and NOTHING signs in.
//   - The flows, with Clerk's client (the Clerk instance; also window.Clerk, for the console): sign-up (username, email, password → signUp.create →
//     prepareEmailAddressVerification → the code → attemptEmailAddressVerification → setActive); sign-in (email + password,
//     or a code by email); Continue with Google / GitHub (authenticateWithRedirect; the OAuth callback lands on this page's
//     own /account/callback); recovery (a code by email, then a new password); session restoration (clerk.load() on reopen:
//     clerk.session present → the session adopted); sign-out (clerk.signOut(); the page forgets the token).
//   - THE SESSION: clerk.session.getToken() (a short-lived RS256 JWT the instance signs), kept fresh (every 30 s, and on
//     Clerk's own session events) in TimmyShell.session (memory only), which the shell's fetch sends as X-Timmy-Session on
//     every request and in the WebSocket hello. The server verifies it on every request (src/companion/identity); the page
//     calls GET /api/identity/me after adopting a token, so what it shows as "signed in" is what THIS SERVER verified.
//   - window.timmyAccount.useSession(token) / signOut(): the same adopt/forget the Clerk flows call (the server verifies as
//     always: a token the instance did not sign is refused with words). Nothing here simulates a sign-in.
//   - The one departure from "the launch token is in memory only": before Continue with Google/GitHub, the launch token is
//     put in sessionStorage (this origin, this tab) for the OAuth round trip, and account-callback.js (loaded before
//     companion.js) puts it back into the address fragment on /account/callback and deletes it; see that file.
(() => {
  'use strict';
  const S = () => window.TimmyShell;
  const REFRESH_MS = 30000;
  const LOAD_MS = 20000;        // Clerk.load() must have reached the instance (its environment and client) within this
  const WORDS = {
    social: 'Social sign-in requires an auth service to be connected.',
    socialOff: 'Turn the provider on in the Clerk dashboard (User & authentication → Social connections: Google, GitHub) and add this page\'s address to the instance\'s allowed origins.',
    noScript: 'Clerk\'s script is not installed in this build, so the account screen cannot load the identity provider\'s code.',
    captcha: 'The instance asks for a captcha, which this page does not load (no script from another site): turn off bot sign-up protection in the Clerk dashboard (Configure → Attack protection), or sign in another way.',
    verifying: 'Verifying with this companion…',
    verified: (u) => `Verified by this companion: ${u.username ? u.username + ' · ' : ''}${u.id}`,
    foot: { needs: 'Nothing signs in until the identity provider is configured.', ok: 'Every request is verified by this companion.', right: 'Local first. Cloud optional.' },
  };

  // ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let view = 'signup';          // signup | signin | verify | code | recover | reset | signedin
  let clerk = null;             // the Clerk instance once clerk.load() resolved (reached the instance)
  let clerkModule = null;       // Clerk's module as imported from /vendor/clerk/ (its Clerk class), before load()
  let loadWords = '';           // why Clerk's script is not usable (absent, failed to load, failed to reach the instance)
  let loading = null;           // the load in progress
  let busy = false;             // a flow's request in flight
  let error = '';               // the last error, drawn in the card (role=alert)
  let pending = null;           // the sign-up or sign-in awaiting a code: { kind: 'signup'|'signin'|'reset', email }
  let verified = null;          // the user as GET /api/identity/me answered, or null
  let clerkSession = '';        // the id of the session CLERK ITSELF gave this page (adopted from its state), '' when none
  let refreshTimer = 0;
  let hostEl = null;
  const draft = { username: '', email: '', password: '', code: '', newPassword: '' }; // the typed fields across redraws (never a token)

  const identity = () => (S() && S().identity()) || null;
  const configured = () => Boolean(identity() && identity().configured);
  const hostOf = () => { try { return new URL(identity().frontendApi).host; } catch (e) { return ''; } };

  // ── Clerk's module, from this companion ──────────────────────────────────────────────────────────────────────────────
  const words = (e) => (e && e.message ? e.message : String(e));
  const within = (ms, what) => new Promise((_, reject) => { setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s.`)), ms); });
  /** Whether a loaded Clerk reached the instance: it issued a client, or its environment names the application. */
  const reached = (c) => {
    const dc = c && c.environment && c.environment.displayConfig;
    return Boolean((c && c.client && typeof c.client.id === 'string' && c.client.id) || (dc && (dc.applicationName || dc.id)));
  };

  /** The module imported (once), a Clerk made for the instance and loaded. Resolves the loaded Clerk; rejects with the words in loadWords. */
  function loadClerk() {
    if (clerk) return Promise.resolve(clerk);
    if (loading) return loading;
    const id = identity();
    if (!id || !id.configured) { loadWords = id ? id.words : 'GET /api/identity has not answered.'; return Promise.reject(new Error(loadWords)); }
    if (!id.clerkScript) { loadWords = id.clerkWords || WORDS.noScript; return Promise.reject(new Error(loadWords)); }
    loading = (async () => {
      if (!clerkModule) {
        let mod;
        try { mod = await import(id.clerkScript); } // same origin: /vendor/clerk/clerk.no-rhc.mjs, within script-src 'self'
        catch (e) { loadWords = `Clerk's module could not be loaded from ${id.clerkScript} (this companion serves it from node_modules/@clerk/clerk-js/dist): ${words(e)}`; throw new Error(loadWords); }
        if (!mod || typeof mod.Clerk !== 'function') { loadWords = `${id.clerkScript} loaded but exports no Clerk class.`; throw new Error(loadWords); }
        clerkModule = mod;
      }
      let c;
      try {
        c = new clerkModule.Clerk(id.publishableKey || '');
        // telemetry off: the module would otherwise report to clerk-telemetry.com (the page's connect-src names only the instance)
        await Promise.race([c.load({ telemetry: { disabled: true } }), within(LOAD_MS, `Clerk's start against ${hostOf() || 'the instance'}`)]);
        // load() resolves even when the instance could not be fetched (observed with 6.40.1, the host unresolvable: status
        // "ready", loaded true, a default environment and a client with no id). The instance was REACHED when it issued a
        // client (client.id) or its environment named the application; otherwise this page says so and signs nothing in.
        if (!c.loaded) throw new Error(`its status is "${c.status || 'unknown'}".`);
        if (!reached(c)) throw new Error(`its environment and client did not load (no network to it, or the key names an instance that does not exist); Clerk reports status "${c.status || 'unknown'}".`);
      } catch (e) { loadWords = `Clerk could not start from ${hostOf() || 'the instance'}: ${words(e)}`; throw new Error(loadWords); }
      clerk = c;
      if (!window.Clerk) window.Clerk = c; // the same global Clerk's own script tag defines, for the console; nothing reads it here
      c.addListener((state) => { onClerkState(state); });
      return c;
    })().finally(() => { loading = null; });
    return loading;
  }

  // ── the session: Clerk's token into the shell, verified by this server ────────────────────────────────────────────────
  function userView(u) {
    if (!u) return null;
    const email = (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || (u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress) || '';
    return { id: u.id, username: u.username || '', email, name: u.fullName || u.firstName || '' };
  }

  /** The token adopted: into the shell, then GET /api/identity/me (this server's verdict). Resolves the verified user. */
  async function adopt(token, user) {
    const shell = S();
    shell.session.set(token, user || null);
    verified = null;
    redraw();
    const r = await shell.fetch('/api/identity/me');
    if (r.status !== 200) {
      // the shell's fetch already cleared the session on a { needs: 'session' } 401 and went to the account screen
      let body = null; try { body = await r.json(); } catch (e) { body = null; }
      const why = (body && (body.words || body.error)) || `GET /api/identity/me answered HTTP ${r.status}.`;
      shell.session.clear();
      throw new Error(why);
    }
    const body = await r.json();
    verified = body.user;
    shell.session.set(token, Object.assign({}, user || {}, { id: body.user.id, username: (user && user.username) || body.user.username || '', email: (user && user.email) || body.user.email || '' }));
    return body.user;
  }

  async function refreshToken() {
    if (!clerk || !clerk.session) return;
    try {
      const t = await clerk.session.getToken();
      if (t) S().session.set(t, userView(clerk.user));
    } catch (e) { /* the next tick, or Clerk's own listener, tries again */ }
  }

  function keepFresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshToken, REFRESH_MS);
  }

  /**
   * Clerk's session became active (a sign-in here, a restored session, a sign-in in another tab) or ended. The page's
   * session is cleared ONLY on Clerk's OWN active → none transition (a session Clerk itself gave this page — clerkSession —
   * now gone: a sign-out or an expiry), never because Clerk's state has no session while the page holds one this companion
   * verified (GET /api/identity/me 200): a token adopted through useSession, or a reopen while the instance is unreachable
   * (H172's gate 2, the lead's 22:31 ruling).
   */
  async function onClerkState(state) {
    const session = state && state.session;
    if (session && session.status === 'active') {
      try {
        const t = await session.getToken();
        if (!t) return;
        await adopt(t, userView(state.user || clerk.user));
        clerkSession = session.id || 'clerk';
        keepFresh();
        view = 'signedin';
        error = '';
        redraw();
        // a sign-in made on this page (a flow ran, or the OAuth callback): on to where the person was going; a restored
        // session on a reopen stays where the landing rule put the page
        if (busy || location.pathname.replace(/\/$/, '') === '/account/callback') await continueOn();
      } catch (e) { error = e && e.message ? e.message : String(e); redraw(); }
    } else if (!session && clerkSession) {
      // the session Clerk held is gone: the page forgets the token it got from it
      clerkSession = '';
      clearInterval(refreshTimer);
      S().session.clear();
      verified = null;
      view = 'signin';
      redraw();
    }
  }

  async function forget() {
    clearInterval(refreshTimer);
    clerkSession = '';
    try { if (clerk) await clerk.signOut(); } catch (e) { /* the instance could not be reached: the page forgets anyway */ }
    S().session.clear();
    verified = null;
    pending = null;
    view = 'signin';
    error = '';
    redraw();
    try { await S().land(); } catch (e) { /* the shell's own */ }
  }

  // ── the flows ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const clerkWords = (e) => {
    const first = e && e.errors && e.errors[0];
    if (first) {
      const code = first.code || '';
      const base = first.longMessage || first.message || code || 'The identity provider refused.';
      if (/captcha/i.test(code)) return `${base} ${WORDS.captcha}`;
      return base + (/(not enabled|not supported|strategy|oauth)/i.test(code) ? ' ' + WORDS.socialOff : '');
    }
    if (e && /captcha/i.test(String(e.code || e.captchaError || ''))) return WORDS.captcha;
    return words(e);
  };

  async function run(fn) {
    if (busy) return;
    busy = true; error = ''; redraw();
    try { await fn(); } catch (e) { error = clerkWords(e); }
    busy = false; redraw();
  }

  const emailFactor = (signIn, strategy) => (signIn.supportedFirstFactors || []).find((f) => f.strategy === strategy);

  const flows = {
    async signUp() {
      const c = await loadClerk();
      const signUp = await c.client.signUp.create({ username: draft.username.trim(), emailAddress: draft.email.trim(), password: draft.password });
      if (signUp.status === 'complete') { await c.setActive({ session: signUp.createdSessionId }); return; }
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      pending = { kind: 'signup', email: draft.email.trim() };
      view = 'verify';
    },
    async verifySignUp() {
      const c = await loadClerk();
      const r = await c.client.signUp.attemptEmailAddressVerification({ code: draft.code.trim() });
      if (r.status === 'complete') { draft.code = ''; pending = null; await c.setActive({ session: r.createdSessionId }); return; }
      throw new Error(`The code was taken but the sign-up is ${r.status}; what it still needs: ${(r.missingFields || []).join(', ') || 'nothing it names'}.`);
    },
    async resendSignUp() {
      const c = await loadClerk();
      await c.client.signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      S().toast('A new code was sent.');
    },
    async signIn() {
      const c = await loadClerk();
      const signIn = await c.client.signIn.create({ identifier: draft.email.trim(), password: draft.password });
      if (signIn.status === 'complete') { await c.setActive({ session: signIn.createdSessionId }); return; }
      throw new Error(`The sign-in is ${signIn.status}: this page handles a password or an email code; the instance asks for something else (a second factor?).`);
    },
    async signInByCode() {
      const c = await loadClerk();
      const signIn = await c.client.signIn.create({ identifier: draft.email.trim() });
      const f = emailFactor(signIn, 'email_code');
      if (!f) throw new Error('The instance does not offer a code by email for this account.');
      await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: f.emailAddressId });
      pending = { kind: 'signin', email: draft.email.trim() };
      view = 'code';
    },
    async verifySignIn() {
      const c = await loadClerk();
      const r = await c.client.signIn.attemptFirstFactor({ strategy: 'email_code', code: draft.code.trim() });
      if (r.status === 'complete') { draft.code = ''; pending = null; await c.setActive({ session: r.createdSessionId }); return; }
      throw new Error(`The code was taken but the sign-in is ${r.status}.`);
    },
    async recover() {
      const c = await loadClerk();
      const signIn = await c.client.signIn.create({ identifier: draft.email.trim() });
      const f = emailFactor(signIn, 'reset_password_email_code');
      if (!f) throw new Error('The instance does not offer a password reset by email for this account.');
      await signIn.prepareFirstFactor({ strategy: 'reset_password_email_code', emailAddressId: f.emailAddressId });
      pending = { kind: 'reset', email: draft.email.trim() };
      view = 'reset';
    },
    async reset() {
      const c = await loadClerk();
      const r = await c.client.signIn.attemptFirstFactor({ strategy: 'reset_password_email_code', code: draft.code.trim() });
      if (r.status === 'needs_new_password') {
        const done = await c.client.signIn.resetPassword({ password: draft.newPassword });
        if (done.status === 'complete') { draft.code = ''; draft.newPassword = ''; pending = null; await c.setActive({ session: done.createdSessionId }); return; }
        throw new Error(`The new password was taken but the sign-in is ${done.status}.`);
      }
      if (r.status === 'complete') { await c.setActive({ session: r.createdSessionId }); return; }
      throw new Error(`The code was taken but the reset is ${r.status}.`);
    },
    async social(provider) {
      const c = await loadClerk();
      // the launch token survives the OAuth round trip in this tab's sessionStorage (account-callback.js puts it back)
      try { if (typeof companion !== 'undefined' && companion && companion.token) sessionStorage.setItem('timmy.account.launch', companion.token); } catch (e) { /* no storage: the callback page will ask to be opened from Timmy */ }
      const o = { strategy: `oauth_${provider}`, redirectUrl: `${location.origin}/account/callback`, redirectUrlComplete: `${location.origin}/` };
      if (view === 'signup') await c.client.signUp.authenticateWithRedirect(o);
      else await c.client.signIn.authenticateWithRedirect(o);
    },
    async callback() {
      const c = await loadClerk();
      // Clerk completes the OAuth here; its navigation is ours (the shell shows the screens: no page load)
      await c.handleRedirectCallback({}, async () => { /* stay: the session listener adopts the token */ });
      try { history.replaceState(null, '', '/'); } catch (e) { /* no history here */ }
    },
  };

  // ── drawing (SHELL CONTRACT v1 §2: the shell draws the head and the band from TimmyShell.page('account', …); this page
  //    draws the work, the context, the dock and the records of #screen-account; an older shell gets the whole section) ──
  const h = (...a) => S().h(...a);
  const PAGE = 'account';
  const RETURN_KEY = 'timmy.account.return';   // the page to go back to after a sign-in (a page id only; this tab; the OAuth round trip)
  let regions = null;
  let returnTo = '';

  const shellHasPages = () => Boolean(S() && typeof S().page === 'function');
  function region(root, cls, tag) { let el = root.querySelector(`.${cls}`); if (!el) { el = h(tag || 'div', { class: cls }); root.append(el); } return el; }
  function findRegions(host) {
    const scaffold = Boolean(host.querySelector('.page-work')) || shellHasPages();
    if (!scaffold) { regions = { legacy: true, head: null, band: null, work: host, context: null, dock: null, records: null }; return; }
    regions = { legacy: false, head: region(host, 'page-head', 'header'), band: region(host, 'page-band'), work: region(host, 'page-work'), context: region(host, 'page-context', 'aside'), dock: region(host, 'page-dock'), records: region(host, 'page-records') };
    if (!regions.context.getAttribute('aria-label')) regions.context.setAttribute('aria-label', 'About your account');
  }

  // the return path: where the person was going before the account page (kept per tab across the OAuth round trip)
  function rememberReturn(id) { if (!id || id === PAGE) return; returnTo = id; try { sessionStorage.setItem(RETURN_KEY, id); } catch (e) { /* no storage */ } }
  function takeReturn() { let id = returnTo; try { id = id || sessionStorage.getItem(RETURN_KEY) || ''; sessionStorage.removeItem(RETURN_KEY); } catch (e) { /* no storage */ } returnTo = ''; return id && id !== PAGE ? id : ''; }
  async function continueOn() {
    const back = takeReturn();
    try { if (back) S().go(back, 'continue'); else await S().land(); } catch (e) { try { await S().land(); } catch (e2) { /* the shell's own */ } }
  }

  function field(k, name, type, placeholder, opts) {
    const o = opts || {};
    const input = h('input', { class: 'sh-input ac-input', type, name, id: `ac-${name}`, placeholder, autocomplete: o.autocomplete || 'off', required: true, value: draft[name] || '', inputmode: o.inputmode || null, minlength: o.minlength || null, 'aria-describedby': error ? 'ac-error' : null });
    input.addEventListener('input', () => { draft[name] = input.value; });
    return h('label', { class: 'sh-field ac-field', for: `ac-${name}` }, h('span', { class: 'sh-field-k ac-field-k' }, k), input);
  }

  /** The social choices: only the providers the operator declared on (GET /api/identity social: CLERK_SOCIAL); none → nothing drawn. */
  function socialButtons() {
    const id = identity();
    const declared = id && Array.isArray(id.social) ? id.social : [];
    if (!declared.length) return [];
    const on = configured() && !loadWords;
    const enabledAt = (provider) => { try { const soc = clerk && clerk.environment && clerk.environment.userSettings && clerk.environment.userSettings.social; const e = soc && soc[`oauth_${provider}`]; return e ? e.enabled !== false : true; } catch (e) { return true; } };
    const b = (provider) => {
      const label = provider === 'google' ? 'Continue with Google' : 'Continue with GitHub';
      const enabled = enabledAt(provider);
      const btn = h('button', { type: 'button', class: 'sh-btn ac-social', 'data-social': provider, disabled: !on || busy || !enabled, title: enabled ? null : `${label}: the dashboard says this provider is off.` }, h('span', { class: 'ac-social-k', 'aria-hidden': 'true' }, provider === 'google' ? 'G' : '⌘'), label);
      btn.addEventListener('click', () => run(() => flows.social(provider)));
      return btn;
    };
    return [
      h('div', { class: 'ac-social-row' }, ...declared.map(b)),
      h('p', { class: 'ac-note ac-center', id: 'ac-social-note' }, on ? 'Through Clerk’s OAuth, back to this page.' : loadWords || needsWords()),
      h('div', { class: 'sh-divider ac-divider' }, view === 'signup' ? 'or create an account' : 'or use your email'),
    ];
  }

  function needsWords() {
    const id = identity();
    if (!id) return 'GET /api/identity has not answered.';
    const needs = Array.isArray(id.needs) && id.needs.length ? ` Missing: ${id.needs.join(', ')}.` : '';
    return (id.words || 'Timmy’s identity provider is not configured, so nothing signs in.') + (id.words && id.words.includes('Missing:') ? '' : needs);
  }

  /** The form's submit: a secondary here when the shell draws the page's ONE primary in the head (the same action); the primary itself on an older shell. */
  let currentForm = null;
  function submitButton(label, onSubmit) {
    const on = configured() && !loadWords;
    const btn = h('button', { type: 'submit', class: `${regions && !regions.legacy ? 'sh-btn' : 'sh-btn-primary'} is-wide ac-submit`, disabled: !on || busy, 'aria-describedby': 'ac-primary-note' }, busy ? 'Working…' : label, busy ? null : h('span', { 'aria-hidden': 'true' }, ' →'));
    const note = h('p', { class: 'ac-note ac-center', id: 'ac-primary-note' }, on ? 'Your password goes to the identity provider only; this companion sees the signed session, never the password.' : (configured() ? loadWords : needsWords()));
    return { btn, note, onSubmit, label };
  }
  function form(children, p) {
    const f = h('form', { class: 'ac-form', novalidate: true }, ...children, p.btn, p.note);
    f.addEventListener('submit', (ev) => { ev.preventDefault(); if (!f.reportValidity()) return; run(p.onSubmit); });
    currentForm = { el: f, label: p.label };
    return f;
  }
  const errorLine = () => (error ? h('p', { class: 'ac-note ac-error', id: 'ac-error', role: 'alert' }, error) : null);
  const textButton = (label, fn, attrs) => { const b = h('button', Object.assign({ type: 'button', class: 'sh-btn-text ac-text' }, attrs || {}), label); b.addEventListener('click', () => { error = ''; fn(); }); return b; };
  const goView = (v) => () => { view = v; redraw(); };
  const signedIn = () => view === 'signedin' || Boolean(S().session.get() && verified);

  function card() {
    currentForm = null;
    if (!configured()) return cardBlocker();
    if (signedIn()) return cardSignedIn();
    if (view === 'verify' || view === 'code') return cardCode();
    if (view === 'recover') return cardRecover();
    if (view === 'reset') return cardReset();
    if (view === 'signin') return cardSignIn();
    return cardSignUp();
  }

  /** UNCONFIGURED: an explicit blocker — what to set, where it comes from, what happens next. No form, nothing signs in. */
  function cardBlocker() {
    const id = identity();
    const steps = id && Array.isArray(id.setup) && id.setup.length ? id.setup : [];
    const needs = id && Array.isArray(id.needs) ? id.needs : [];
    const cont = h('button', { type: 'button', class: 'sh-btn', 'data-ac': 'operator' }, 'Continue as this computer’s operator', h('span', { 'aria-hidden': 'true' }, ' →'));
    cont.addEventListener('click', () => continueOn());
    const settings = h('button', { type: 'button', class: 'sh-btn-text ac-text', 'data-ac': 'settings' }, 'Open Settings');
    settings.addEventListener('click', () => { try { S().go('settings', 'account'); } catch (e) { /* no page */ } });
    return h('div', { class: 'sh-card ac-card ac-blocker', role: 'region', 'aria-labelledby': 'ac-blocker-title' },
      h('p', { class: 'ac-state is-attn', 'data-ac': 'blocker-state' }, 'Sign-in is not set up on this companion'),
      h('h2', { id: 'ac-blocker-title' }, 'No identity provider is configured.'),
      h('p', { class: 'ac-sub' }, id ? (steps.length ? `Set ${needs.length ? needs.join(' and ') : 'the names below'} where Timmy’s terminal starts the companion, then start Timmy again: this page then shows the sign-up.` : needsWords()) : 'GET /api/identity has not answered.'),
      steps.length ? h('ol', { class: 'ac-steps' }, ...steps.map((st) => h('li', { class: `ac-step${st.missing ? ' is-missing' : ''}${st.optional ? ' is-optional' : ''}` },
        h('code', { class: 'ac-code' }, st.name), st.optional ? h('span', { class: 'ac-tag' }, 'optional') : (st.missing ? h('span', { class: 'ac-tag is-attn' }, 'missing') : h('span', { class: 'ac-tag' }, 'set')),
        h('p', { class: 'ac-note' }, st.what), h('p', { class: 'ac-note ac-where' }, st.where)))) : null,
      h('p', { class: 'ac-note' }, 'Until then this companion runs as this computer’s operator: your own Timmy home, keys and projects, as before accounts. Nothing is signed in and no account is pretended.'),
      h('div', { class: 'ac-actions' }, cont, settings));
  }

  function cardSignUp() {
    const p = submitButton('Create account', flows.signUp);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Create your Timmy account'),
      h('p', { class: 'ac-sub' }, 'Your workspace starts with you.'),
      ...socialButtons(),
      errorLine(),
      form([
        field('Username', 'username', 'text', 'Choose a username', { autocomplete: 'username', minlength: 3 }),
        field('Email address', 'email', 'email', 'you@example.com', { autocomplete: 'email' }),
        field('Password', 'password', 'password', 'Create a password', { autocomplete: 'new-password', minlength: 8 }),
      ], p),
      h('p', { class: 'ac-note ac-center ac-switch' }, 'Already have an account? ', textButton('Sign in', goView('signin'), { 'data-ac': 'to-signin' })));
  }

  function cardSignIn() {
    const p = submitButton('Sign in', flows.signIn);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Welcome back to Timmy'),
      h('p', { class: 'ac-sub' }, 'Sign in to continue your work.'),
      ...socialButtons(),
      errorLine(),
      form([
        field('Email address', 'email', 'email', 'you@example.com', { autocomplete: 'email' }),
        field('Password', 'password', 'password', 'Enter your password', { autocomplete: 'current-password' }),
      ], p),
      h('div', { class: 'ac-actions ac-center-row' },
        textButton('Email me a code instead', () => run(flows.signInByCode), { 'data-ac': 'by-code' }),
        textButton('Forgot your password?', goView('recover'), { 'data-ac': 'recover' })),
      h('p', { class: 'ac-note ac-center ac-switch' }, 'New to Timmy? ', textButton('Create an account', goView('signup'), { 'data-ac': 'to-signup' })));
  }

  function cardCode() {
    const signup = view === 'verify';
    const p = submitButton('Verify', signup ? flows.verifySignUp : flows.verifySignIn);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Check your email'),
      h('p', { class: 'ac-sub' }, `We sent a code to ${pending ? pending.email : 'your address'}.`),
      errorLine(),
      form([field('Verification code', 'code', 'text', '6-digit code', { autocomplete: 'one-time-code', inputmode: 'numeric' })], p),
      h('div', { class: 'ac-actions ac-center-row' },
        signup ? textButton('Resend code', () => run(flows.resendSignUp)) : null,
        textButton('Back', goView(signup ? 'signup' : 'signin'))));
  }

  function cardRecover() {
    const p = submitButton('Send code', flows.recover);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Reset your password'),
      h('p', { class: 'ac-sub' }, 'Enter your email address; we send a code.'),
      errorLine(),
      form([field('Email address', 'email', 'email', 'you@example.com', { autocomplete: 'email' })], p),
      h('div', { class: 'ac-actions ac-center-row' }, textButton('Back to sign in', goView('signin'))));
  }

  function cardReset() {
    const p = submitButton('Set new password', flows.reset);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Set a new password'),
      h('p', { class: 'ac-sub' }, `Enter the code we sent to ${pending ? pending.email : 'your address'} and a new password.`),
      errorLine(),
      form([
        field('Verification code', 'code', 'text', '6-digit code', { autocomplete: 'one-time-code', inputmode: 'numeric' }),
        field('New password', 'newPassword', 'password', 'Create a password', { autocomplete: 'new-password', minlength: 8 }),
      ], p),
      h('div', { class: 'ac-actions ac-center-row' }, textButton('Back to sign in', goView('signin'))));
  }

  function cardSignedIn() {
    const u = S().session.user() || {};
    const cont = h('button', { type: 'button', class: `${regions && !regions.legacy ? 'sh-btn' : 'sh-btn-primary'} is-wide`, 'data-ac': 'continue' }, 'Continue', h('span', { 'aria-hidden': 'true' }, ' →'));
    cont.addEventListener('click', () => continueOn());
    const out = h('button', { type: 'button', class: 'sh-btn', 'data-ac': 'signout' }, 'Sign out');
    out.addEventListener('click', () => run(forget));
    const settings = h('button', { type: 'button', class: 'sh-btn-text ac-text', 'data-ac': 'settings' }, 'Open Settings');
    settings.addEventListener('click', () => { try { S().go('settings', 'account'); } catch (e) { /* no page */ } });
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'You’re signed in'),
      h('p', { class: 'ac-sub' }, [u.username, u.email].filter(Boolean).join(' · ') || u.id || ''),
      // green only for the observed fact: this companion verified the session it holds (GET /api/identity/me)
      h('p', { class: `sh-state ac-state${verified ? ' is-live' : ''}`, 'aria-live': 'polite' }, verified ? WORDS.verified(verified) : WORDS.verifying),
      errorLine(),
      h('div', { class: 'ac-actions' }, cont, out, settings));
  }

  /** The right column: Timmy identity apart from provider authorization; how the session is verified. */
  function context() {
    const id = identity();
    const host = hostOf();
    const models = h('button', { type: 'button', class: 'sh-btn', 'data-ac': 'connections' }, 'Models & accounts', h('span', { 'aria-hidden': 'true' }, ' →'));
    models.addEventListener('click', () => { try { S().go('connections', 'account'); } catch (e) { /* no page */ } });
    return [
      h('h2', { class: 'ac-ctx-title' }, 'Two different things'),
      h('dl', { class: 'ac-ctx-dl' },
        h('dt', null, 'Your Timmy account'), h('dd', null, 'Who you are here. It keeps your projects, conversations and records apart in your own Timmy home.'),
        h('dt', null, 'Provider authorization'), h('dd', null, 'What you connect for models — OpenRouter, Ollama, Cloudflare. Kept in Models & accounts, never tied to the account.')),
      h('p', { class: 'ac-note' }, configured() ? `Sign-in is handled by the identity provider at ${host}; this companion verifies each session itself and never sees a password.` : 'With no identity provider configured there is no account here: the companion runs as this computer’s operator.'),
      h('div', { class: 'ac-ctx-actions' }, models),
      !id ? null : h('details', { class: 'ui-details ac-details' }, h('summary', null, 'Details'), h('dl', { class: 'ac-ctx-dl' },
        h('dt', null, 'Identity provider'), h('dd', { class: 'ac-mono' }, configured() ? host : 'not configured'),
        h('dt', null, 'Session'), h('dd', null, configured() ? 'a short-lived token the instance signs (RS256), sent in the X-Timmy-Session header, verified by this companion on every request' : 'none (the launch token is the operator’s)'),
        h('dt', null, 'Environment names'), h('dd', { class: 'ac-mono' }, (Array.isArray(id.setup) ? id.setup.map((s) => s.name) : []).join(', ') || '—'))),
    ];
  }

  function dockButtons() {
    const out = [];
    if (configured() && !signedIn()) {
      const sw = h('button', { type: 'button', class: 'dock-btn sh-btn', 'data-ac': 'dock-switch' }, view === 'signup' ? 'Sign in instead' : 'Create an account instead');
      sw.addEventListener('click', () => { error = ''; view = view === 'signup' ? 'signin' : 'signup'; redraw(); });
      out.push(sw);
    }
    const settings = h('button', { type: 'button', class: 'dock-btn sh-btn', 'data-ac': 'dock-settings' }, 'Settings');
    settings.addEventListener('click', () => { try { S().go('settings', 'account'); } catch (e) { /* no page */ } });
    out.push(settings);
    return out;
  }
  function records() {
    let det = regions.records.querySelector('details[data-records-owner="account"]');
    if (!det) { det = h('details', { class: 'records ac-records', 'data-records-owner': 'account' }); regions.records.append(det); }
    const wasOpen = det.open;
    const id = identity();
    det.replaceChildren(h('summary', null, 'How sign-in is verified here'), h('dl', { class: 'ac-ctx-dl' },
      h('dt', null, 'Identity provider'), h('dd', null, configured() ? `Clerk at ${hostOf()}${id && id.words && /development instance/.test(id.words) ? ' (a development instance)' : ''}` : 'not configured'),
      h('dt', null, 'What this companion verifies'), h('dd', null, configured() ? (id && id.words ? id.words.replace(/^Timmy's identity provider is configured: /, '') : 'the session token on every request') : 'nothing: every request is the operator’s, under the launch token'),
      h('dt', null, 'Clerk’s code'), h('dd', { class: 'ac-mono' }, id && id.clerkScript ? `${id.clerkScript} (served by this companion; nothing from another site)` : (id && id.clerkWords) || 'not installed')));
    det.open = wasOpen;
  }

  // ── the registration: the head's words per state, the ONE primary ────────────────────────────────────────────────────
  function pageMeta() {
    if (!configured()) {
      return { kicker: 'ACCOUNT / SET UP SIGN-IN', title: 'Sign-in is not set up on this companion.', intro: 'No identity provider is configured, so there is no account to make or restore here. This companion runs as this computer’s operator; nothing is pretended.', primary: { label: 'Continue as the operator', run: continueOn }, context: 'selection', dock: 'ACCOUNT TOOLS' };
    }
    if (signedIn()) {
      const u = S().session.user() || {};
      return { kicker: 'ACCOUNT / YOU ARE SIGNED IN', title: `Welcome${u.username ? `, ${u.username}` : ''}.`, intro: verified ? `${WORDS.verified(verified)}. Your projects and records are your own.` : WORDS.verifying, primary: { label: 'Continue', run: continueOn }, context: 'selection', dock: 'ACCOUNT TOOLS' };
    }
    const submit = () => { if (currentForm && currentForm.el.isConnected) currentForm.el.requestSubmit(); };
    const on = !loadWords;
    const base = { context: 'selection', dock: 'ACCOUNT TOOLS' };
    if (view === 'signin') return { ...base, kicker: 'ACCOUNT / SIGN IN TO TIMMY', title: 'Welcome back to Timmy.', intro: 'Sign in to continue your work. Your account is who you are here; the providers you connect are a separate thing.', primary: { label: 'Sign in', run: submit, disabled: !on, why: on ? '' : loadWords } };
    if (view === 'verify' || view === 'code') return { ...base, kicker: 'ACCOUNT / CHECK YOUR EMAIL', title: 'One code away.', intro: `We sent a code to ${pending ? pending.email : 'your address'}. Enter it below.`, primary: { label: 'Verify', run: submit, disabled: !on, why: on ? '' : loadWords } };
    if (view === 'recover') return { ...base, kicker: 'ACCOUNT / RESET YOUR PASSWORD', title: 'Reset your password.', intro: 'Enter your email address; we send a code.', primary: { label: 'Send code', run: submit, disabled: !on, why: on ? '' : loadWords } };
    if (view === 'reset') return { ...base, kicker: 'ACCOUNT / RESET YOUR PASSWORD', title: 'Set a new password.', intro: `Enter the code we sent to ${pending ? pending.email : 'your address'} and a new password.`, primary: { label: 'Set new password', run: submit, disabled: !on, why: on ? '' : loadWords } };
    return { ...base, kicker: 'ACCOUNT / CREATE YOUR ACCOUNT', title: 'Make room for your next idea.', intro: 'Create your Timmy account: your workspace starts with you. The providers you connect for models are separate.', primary: { label: 'Create account', run: submit, disabled: !on, why: on ? '' : loadWords } };
  }
  function register() {
    if (!shellHasPages()) return;
    try { S().page(PAGE, pageMeta()); } catch (e) { /* the shell's own */ }
    try { if (typeof S().state === 'function') S().state(PAGE, !configured() ? 'error' : 'content', !configured() ? { words: 'No identity provider is configured; nothing signs in.', next: { label: 'Continue as the operator', run: continueOn } } : undefined); } catch (e) { /* the shell's own */ }
  }

  // an older shell (no page registration): the head, the band and the foot drawn by this page, as round 4 did
  function legacyHead() {
    const on = configured();
    return h('header', { class: 'sh-head' },
      h('div', { class: 'sh-head-brand' }, h('span', { class: 'sh-mark', 'aria-hidden': 'true' }, h('canvas', { 'data-timmy-mark': '' }), h('span', { class: 'sh-mark-text' }, 'T')), 'TIMMY'),
      h('nav', { class: 'sh-steps', 'aria-label': 'Steps' }, h('span', { class: 'sh-step is-current', 'aria-current': 'step' }, h('b', null, '01'), 'Account'), h('span', { class: 'sh-step' }, h('b', null, '02'), 'Connections'), h('span', { class: 'sh-step' }, h('b', null, '03'), 'Workspace')),
      h('span', { class: 'sh-head-words' }, on ? `Identity · ${hostOf()}` : 'Identity · not configured'));
  }
  function legacyFoot() { return h('footer', { class: 'sh-foot' }, h('span', null, configured() ? WORDS.foot.ok : WORDS.foot.needs), h('span', null, WORDS.foot.right)); }
  function legacyHero() {
    const m = pageMeta();
    return h('div', { class: 'ac-hero' }, h('p', { class: 'sh-label ac-kicker' }, m.kicker), h('h1', { class: 'ac-title' }, m.title), h('p', { class: 'ac-lede' }, m.intro));
  }

  function redraw() {
    if (!hostEl || !hostEl.isConnected || !regions) return;
    if (S().current && S().current() !== PAGE && typeof S().page === 'function') return; // another page is shown: drawn again when this one is
    const focused = document.activeElement && hostEl.contains(document.activeElement) ? (document.activeElement.id || document.activeElement.getAttribute('data-ac')) : null;
    if (regions.legacy) {
      hostEl.replaceChildren(legacyHead(), h('main', { class: 'sh-main ac-main' }, legacyHero(), card()), legacyFoot());
    } else {
      register();
      regions.work.replaceChildren(h('div', { class: 'ac-work' }, card()));
      regions.context.replaceChildren(...context());
      let group = regions.dock.querySelector('[data-dock-owner="account"]');
      if (!group) { group = h('span', { class: 'dock-group', 'data-dock-owner': 'account' }); regions.dock.append(group); }
      group.replaceChildren(...dockButtons());
      records();
      hostEl.dataset.state = configured() ? 'content' : 'error';
      hostEl.dataset.accountView = configured() ? (signedIn() ? 'signedin' : view) : 'blocker';
    }
    if (focused) { const again = hostEl.querySelector(`#${CSS.escape(focused)}, [data-ac="${CSS.escape(focused)}"]`); if (again && !again.disabled) again.focus({ preventScroll: true }); }
  }

  function draw(host) {
    hostEl = host;
    findRegions(host);
    // a reopened page: Clerk restores the session (clerk.load() reads its own client state), the listener adopts the token
    if (configured() && !clerk && !loadWords && !S().session.get()) {
      loadClerk().then(() => {
        if (location.pathname.replace(/\/$/, '') === '/account/callback') run(flows.callback);
        else if (clerk.session && clerk.session.status === 'active' && !S().session.get()) onClerkState({ session: clerk.session, user: clerk.user });
        redraw();
      }, () => { redraw(); });
    }
    redraw();
  }

  // ── wiring ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  const mount = () => {
    const shell = S();
    if (!shell) return;
    shell.mount(PAGE, draw);
    register();
    // the page the person came from, for the return path after a sign-in
    if (typeof shell.on === 'function') {
      let last = '';
      const seen = (d) => { const id = d && d.id; if (!id) return; if (id === PAGE) { if (last && last !== PAGE) rememberReturn(last); } last = id; };
      shell.on('page', seen);
      shell.on('screen', seen);
    }
    shell.on('identity', () => { loadWords = ''; if (hostEl && hostEl.isConnected && S().current() === PAGE) draw(hostEl); else redraw(); });
    shell.on('session', ({ user }) => { if (!user && view === 'signedin') { view = 'signin'; verified = null; } redraw(); });
  };
  if (window.TimmyShell) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });

  /** The seam the tests and other scripts use: the same adopt/forget the Clerk flows call; the server verifies as always. */
  window.timmyAccount = {
    useSession: (token) => adopt(token, null).then((u) => { view = 'signedin'; keepFresh(); redraw(); return continueOn().then(() => u); }),
    signOut: () => forget(),
    // Clerk's state as its listener gets it (a test's seam for the active → none rule; what Clerk itself calls)
    clerkState: (state) => onClerkState(state),
    // module: Clerk's module imported from /vendor/clerk/ (its code ran here); clerk: load() reached the instance;
    // clerkSession: the page holds a session CLERK gave it (only that one is let go when Clerk's goes)
    state: () => ({ view: configured() ? (signedIn() ? 'signedin' : view) : 'blocker', configured: configured(), module: Boolean(clerkModule), clerk: Boolean(clerk), loading: Boolean(loading), words: loadWords, verified, clerkSession: Boolean(clerkSession), social: (identity() && identity().social) || [], returnTo: returnTo || '' }),
    meta: pageMeta,
    forgetReturn: () => { returnTo = ''; try { sessionStorage.removeItem(RETURN_KEY); } catch (e) { /* no storage */ } },
  };
})();
