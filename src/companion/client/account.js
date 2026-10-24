// R11 round 4 (H173, contract C1): the ACCOUNT screen — "Create your Timmy account" / "Welcome back to Timmy" — drawn into
// the shell's #screen-account host (shell.js TimmyShell.mount('account', draw)). Real Clerk, verified by this server:
//
//   - GET /api/identity says whether the identity provider is configured (CLERK_PUBLISHABLE_KEY + CLERK_JWT_KEY or
//     CLERK_SECRET_KEY) and where Clerk's JS is served from (/vendor/clerk/clerk.headless.browser.js, by this companion:
//     the page loads nothing from any other site; the script talks only to the instance's frontend API, which the page's
//     Content-Security-Policy names in connect-src when configured). Not configured, or the script not installed: the
//     screen is drawn and reviewable, the dependency named with its exact environment names, and NOTHING signs in.
//   - The flows, with Clerk's headless client (window.Clerk): sign-up (username, email, password → signUp.create →
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
  const WORDS = {
    social: 'Social sign-in requires an auth service to be connected.',
    socialOff: 'Turn the provider on in the Clerk dashboard (User & authentication → Social connections: Google, GitHub) and add this page\'s address to the instance\'s allowed origins.',
    noScript: 'Clerk\'s script is not installed in this build, so the account screen cannot load the identity provider\'s code.',
    verifying: 'Verifying with this companion…',
    verified: (u) => `Verified by this companion: ${u.username ? u.username + ' · ' : ''}${u.id}`,
    foot: { needs: 'Nothing signs in until the identity provider is configured.', ok: 'Every request is verified by this companion.', right: 'Local first. Cloud optional.' },
  };

  // ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let view = 'signup';          // signup | signin | verify | code | recover | reset | signedin
  let clerk = null;             // window.Clerk once loaded and clerk.load() resolved
  let loadWords = '';           // why Clerk's script is not usable (absent, failed to load, failed to reach the instance)
  let loading = null;           // the load in progress
  let busy = false;             // a flow's request in flight
  let error = '';               // the last error, drawn in the card (role=alert)
  let pending = null;           // the sign-up or sign-in awaiting a code: { kind: 'signup'|'signin'|'reset', email }
  let verified = null;          // the user as GET /api/identity/me answered, or null
  let refreshTimer = 0;
  let hostEl = null;
  const draft = { username: '', email: '', password: '', code: '', newPassword: '' }; // the typed fields across redraws (never a token)

  const identity = () => (S() && S().identity()) || null;
  const configured = () => Boolean(identity() && identity().configured);
  const hostOf = () => { try { return new URL(identity().frontendApi).host; } catch (e) { return ''; } };

  // ── Clerk's script, from this companion ──────────────────────────────────────────────────────────────────────────────
  function loadClerk() {
    if (clerk) return Promise.resolve(clerk);
    if (loading) return loading;
    const id = identity();
    if (!id || !id.configured) { loadWords = id ? id.words : 'GET /api/identity has not answered.'; return Promise.reject(new Error(loadWords)); }
    if (!id.clerkScript) { loadWords = id.clerkWords || WORDS.noScript; return Promise.reject(new Error(loadWords)); }
    loading = new Promise((resolve, reject) => {
      const done = async () => {
        try {
          if (!window.Clerk) throw new Error('Clerk\'s script loaded but did not define window.Clerk.');
          await window.Clerk.load();
          clerk = window.Clerk;
          clerk.addListener((state) => { onClerkState(state); });
          resolve(clerk);
        } catch (e) { loadWords = `Clerk could not start from ${hostOf() || 'the instance'}: ${e && e.message ? e.message : e}`; reject(e); }
      };
      const existing = document.querySelector('script[data-clerk-publishable-key]');
      if (existing) { if (window.Clerk) done(); else existing.addEventListener('load', done, { once: true }); return; }
      const s = document.createElement('script');
      s.src = id.clerkScript;
      s.async = true;
      s.setAttribute('data-clerk-publishable-key', id.publishableKey || '');
      s.addEventListener('load', done, { once: true });
      s.addEventListener('error', () => { loadWords = `Clerk's script could not be loaded from ${id.clerkScript} (this companion serves it from node_modules/@clerk/clerk-js).`; reject(new Error(loadWords)); }, { once: true });
      document.head.append(s);
    }).finally(() => { loading = null; });
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

  /** Clerk's session became active (a sign-in here, a restored session, a sign-in in another tab) or ended. */
  async function onClerkState(state) {
    const session = state && state.session;
    if (session && session.status === 'active') {
      try {
        const t = await session.getToken();
        if (!t) return;
        await adopt(t, userView(state.user || clerk.user));
        keepFresh();
        view = 'signedin';
        error = '';
        redraw();
      } catch (e) { error = e && e.message ? e.message : String(e); redraw(); }
    } else if (!session && S().session.get()) {
      clearInterval(refreshTimer);
      S().session.clear();
      verified = null;
      view = 'signin';
      redraw();
    }
  }

  async function forget() {
    clearInterval(refreshTimer);
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
    if (first) return (first.longMessage || first.message || first.code || 'The identity provider refused.') + (/(not enabled|not supported|strategy|oauth)/i.test(first.code || '') ? ' ' + WORDS.socialOff : '');
    return e && e.message ? e.message : String(e);
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

  // ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const h = (...a) => S().h(...a);

  function field(k, name, type, placeholder, opts) {
    const o = opts || {};
    const input = h('input', { class: 'sh-input', type, name, id: `ac-${name}`, placeholder, autocomplete: o.autocomplete || 'off', required: true, value: draft[name] || '', inputmode: o.inputmode || null, minlength: o.minlength || null, 'aria-describedby': error ? 'ac-error' : null });
    input.addEventListener('input', () => { draft[name] = input.value; });
    return h('label', { class: 'sh-field', for: `ac-${name}` }, h('span', { class: 'sh-field-k' }, k), input);
  }

  function socialButtons() {
    const on = configured() && !loadWords;
    const b = (provider, label) => {
      const btn = h('button', { type: 'button', class: 'sh-btn ac-social', disabled: !on || busy, 'aria-describedby': on ? null : 'ac-social-note' }, h('span', { class: 'ac-social-k', 'aria-hidden': 'true' }, provider === 'google' ? 'G' : '⌘'), label);
      btn.addEventListener('click', () => run(() => flows.social(provider)));
      return btn;
    };
    return [
      h('div', { class: 'ac-social-row' }, b('google', 'Continue with Google'), b('github', 'Continue with GitHub')),
      h('p', { class: 'sh-note ac-center', id: 'ac-social-note' }, on ? 'Through Clerk\'s OAuth; the dashboard must have the provider on.' : `${WORDS.social}${configured() ? ' ' + loadWords : ' ' + needsWords()}`),
    ];
  }

  function needsWords() {
    const id = identity();
    if (!id) return 'GET /api/identity has not answered.';
    const needs = Array.isArray(id.needs) && id.needs.length ? ` Missing: ${id.needs.join(', ')}.` : '';
    return (id.words || 'Timmy\'s identity provider is not configured, so nothing signs in.') + (id.words && id.words.includes('Missing:') ? '' : needs);
  }

  function primary(label, onSubmit) {
    const on = configured() && !loadWords;
    const btn = h('button', { type: 'submit', class: 'sh-btn-primary is-wide', disabled: !on || busy, 'aria-describedby': 'ac-primary-note' }, busy ? 'Working…' : label, busy ? null : h('span', { 'aria-hidden': 'true' }, '→'));
    const note = h('p', { class: 'sh-note ac-center', id: 'ac-primary-note' }, on ? 'Your password goes to the identity provider only; this companion sees the signed session, never the password.' : (configured() ? loadWords : needsWords()));
    return { btn, note, onSubmit };
  }

  function form(children, p) {
    const f = h('form', { class: 'ac-form', novalidate: true }, ...children, p.btn, p.note);
    f.addEventListener('submit', (ev) => { ev.preventDefault(); if (!f.reportValidity()) return; run(p.onSubmit); });
    return f;
  }

  const errorLine = () => (error ? h('p', { class: 'sh-note sh-error ac-error', id: 'ac-error', role: 'alert' }, error) : null);
  const textButton = (label, fn) => { const b = h('button', { type: 'button', class: 'sh-btn-text' }, label); b.addEventListener('click', () => { error = ''; fn(); }); return b; };
  const goView = (v) => () => { view = v; redraw(); };

  function card() {
    if (view === 'signedin' || (S().session.get() && verified)) return cardSignedIn();
    if (view === 'verify' || view === 'code') return cardCode();
    if (view === 'recover') return cardRecover();
    if (view === 'reset') return cardReset();
    if (view === 'signin') return cardSignIn();
    return cardSignUp();
  }

  function cardSignUp() {
    const p = primary('Create account', flows.signUp);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Create your Timmy account'),
      h('p', { class: 'sh-sub' }, 'Your workspace starts with you.'),
      ...socialButtons(),
      h('div', { class: 'sh-divider' }, 'or create an account'),
      errorLine(),
      form([
        field('Username', 'username', 'text', 'Choose a username', { autocomplete: 'username', minlength: 3 }),
        field('Email address', 'email', 'email', 'you@example.com', { autocomplete: 'email' }),
        field('Password', 'password', 'password', 'Create a password', { autocomplete: 'new-password', minlength: 8 }),
      ], p),
      h('p', { class: 'sh-note ac-center ac-switch' }, 'Already have an account? ', textButton('Sign in', goView('signin'))));
  }

  function cardSignIn() {
    const p = primary('Sign in', flows.signIn);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Welcome back to Timmy'),
      h('p', { class: 'sh-sub' }, 'Sign in to continue your work.'),
      ...socialButtons(),
      h('div', { class: 'sh-divider' }, 'or use your email'),
      errorLine(),
      form([
        field('Email address', 'email', 'email', 'you@example.com', { autocomplete: 'email' }),
        field('Password', 'password', 'password', 'Enter your password', { autocomplete: 'current-password' }),
      ], p),
      h('div', { class: 'sh-actions ac-center-row' },
        textButton('Email me a code instead', () => run(flows.signInByCode)),
        textButton('Forgot your password?', goView('recover'))),
      h('p', { class: 'sh-note ac-center ac-switch' }, 'New to Timmy? ', textButton('Create an account', goView('signup'))));
  }

  function cardCode() {
    const signup = view === 'verify';
    const p = primary('Verify', signup ? flows.verifySignUp : flows.verifySignIn);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Check your email'),
      h('p', { class: 'sh-sub' }, `We sent a code to ${pending ? pending.email : 'your address'}.`),
      errorLine(),
      form([field('Verification code', 'code', 'text', '6-digit code', { autocomplete: 'one-time-code', inputmode: 'numeric' })], p),
      h('div', { class: 'sh-actions ac-center-row' },
        signup ? textButton('Resend code', () => run(flows.resendSignUp)) : null,
        textButton('Back', goView(signup ? 'signup' : 'signin'))));
  }

  function cardRecover() {
    const p = primary('Send code', flows.recover);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Reset your password'),
      h('p', { class: 'sh-sub' }, 'Enter your email address; we send a code.'),
      errorLine(),
      form([field('Email address', 'email', 'email', 'you@example.com', { autocomplete: 'email' })], p),
      h('div', { class: 'sh-actions ac-center-row' }, textButton('Back to sign in', goView('signin'))));
  }

  function cardReset() {
    const p = primary('Set new password', flows.reset);
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'Set a new password'),
      h('p', { class: 'sh-sub' }, `Enter the code we sent to ${pending ? pending.email : 'your address'} and a new password.`),
      errorLine(),
      form([
        field('Verification code', 'code', 'text', '6-digit code', { autocomplete: 'one-time-code', inputmode: 'numeric' }),
        field('New password', 'newPassword', 'password', 'Create a password', { autocomplete: 'new-password', minlength: 8 }),
      ], p),
      h('div', { class: 'sh-actions ac-center-row' }, textButton('Back to sign in', goView('signin'))));
  }

  function cardSignedIn() {
    const u = S().session.user() || {};
    const cont = h('button', { type: 'button', class: 'sh-btn-primary is-wide' }, 'Continue', h('span', { 'aria-hidden': 'true' }, '→'));
    cont.addEventListener('click', () => { S().land(); });
    const out = h('button', { type: 'button', class: 'sh-btn' }, 'Sign out');
    out.addEventListener('click', () => run(forget));
    return h('div', { class: 'sh-card ac-card' },
      h('h2', null, 'You\'re signed in'),
      h('p', { class: 'sh-sub' }, [u.username, u.email].filter(Boolean).join(' · ') || u.id || ''),
      // green only for the observed fact: this companion verified the session it holds (GET /api/identity/me)
      h('p', { class: `sh-state ac-state${verified ? ' is-live' : ''}`, 'aria-live': 'polite' }, verified ? WORDS.verified(verified) : WORDS.verifying),
      errorLine(),
      h('div', { class: 'sh-actions' }, cont, out));
  }

  function hero() {
    return h('div', { class: 'ac-hero' },
      h('p', { class: 'sh-label ac-kicker' }, 'Your ideas. Your tools. One workspace.'),
      h('h1', { class: 'ac-title' }, 'Make room', h('br'), 'for your', h('br'), h('span', { class: 'ac-title-dim' }, 'next idea.')),
      h('p', { class: 'ac-lede' }, 'Think in Chat. Build on Canvas. Put your tools to work, together.'),
      h('div', { class: 'ac-start' },
        h('span', { class: 'sh-mark is-big', 'aria-hidden': 'true' }, h('canvas', { 'data-timmy-mark': '' }), h('span', { class: 'sh-mark-text' }, 'T')),
        h('div', null, h('p', { class: 'ac-start-k' }, 'Start here. Make it yours.'), h('p', { class: 'sh-note' }, 'One workspace, from first thought to final result.'))));
  }

  function head() {
    const on = configured();
    return h('header', { class: 'sh-head' },
      h('div', { class: 'sh-head-brand' }, h('span', { class: 'sh-mark', 'aria-hidden': 'true' }, h('canvas', { 'data-timmy-mark': '' }), h('span', { class: 'sh-mark-text' }, 'T')), 'TIMMY'),
      h('nav', { class: 'sh-steps', 'aria-label': 'Steps' },
        h('span', { class: 'sh-step is-current', 'aria-current': 'step' }, h('b', null, '01'), 'Account'),
        h('span', { class: 'sh-step' }, h('b', null, '02'), 'Connections'),
        h('span', { class: 'sh-step' }, h('b', null, '03'), 'Workspace')),
      h('span', { class: 'sh-head-words' }, on ? `Identity · ${hostOf()}` : 'Identity · not configured'));
  }

  function foot() {
    return h('footer', { class: 'sh-foot' },
      h('span', null, configured() ? WORDS.foot.ok : WORDS.foot.needs),
      h('span', null, WORDS.foot.right));
  }

  function redraw() {
    if (!hostEl || !hostEl.isConnected || S().current() !== 'account') return;
    const focused = document.activeElement && document.activeElement.id;
    hostEl.replaceChildren(head(), h('main', { class: 'sh-main ac-main' }, hero(), card()), foot());
    if (focused) { const again = document.getElementById(focused); if (again) again.focus(); }
  }

  function draw(host) {
    hostEl = host;
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
    shell.mount('account', draw);
    shell.on('identity', () => { loadWords = ''; redraw(); });
    shell.on('session', ({ user }) => { if (!user && view === 'signedin') { view = 'signin'; verified = null; } redraw(); });
  };
  if (window.TimmyShell) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });

  /** The seam the tests and other scripts use: the same adopt/forget the Clerk flows call; the server verifies as always. */
  window.timmyAccount = {
    useSession: (token) => adopt(token, null).then((u) => { view = 'signedin'; keepFresh(); redraw(); return S().land().then(() => u); }),
    signOut: () => forget(),
    state: () => ({ view, configured: configured(), clerk: Boolean(clerk), words: loadWords, verified }),
  };
})();
