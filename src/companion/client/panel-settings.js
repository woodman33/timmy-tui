// R11 round 7 (H173): the SETTINGS page — "Make Timmy run your way." Only what exists today, each from its own source:
//
//   START-UP   the two settings of the workspace frame (surfaces.companion / studio .openAtStart; src/companion/workspace.ts):
//              saved by POST /api/workspace/prefs with the frame's revision (409 stale → tried once more when the frame shows
//              the same two settings, else "changed elsewhere: Reload"; nothing the person did not see is written over) —
//              the same rule companion.js keeps for Home's boxes; the file is the Workbench's settings file (the terminal
//              reads the same one).
//   APPEARANCE the theme family, Amber or Glacier (SHELL CONTRACT v1 §3.2: html[data-theme], localStorage "timmy.theme" per
//              viewer, try/catch; the topbar's toggle and this page set the same). Status colours stay the same in both.
//   RECORDS    local first: the records' home (GET /api/files → where.home, the Timmy home of the signed-in user or the
//              operator); cloud sync as the Cloudflare card of GET /api/connections says it (cloudLogs on/off, the gateway;
//              H170's words) — changed in Models & accounts, not here.
//   ACCOUNT    who this is (GET /api/identity/me: the user, or this computer's operator with its words), whether an identity
//              provider is configured (TimmyShell.identity()); Open account / Sign out (window.timmyAccount.signOut). Timmy
//              identity (who you are) is said apart from provider authorization (what you connect).
//   THE SCAFFOLD (SHELL CONTRACT v1 §2): section#ws-settings[data-page="settings"]; TimmyPanels.register('settings', …) draws
//   into [data-panel-host="settings"]; TimmyShell.page('settings', …) carries the head (kicker "SETTINGS / SET HOW TIMMY RUNS",
//   the ONE primary "Done →" back to Chat), context null (no right column), the dock "SETTINGS TOOLS" (Reload), the records
//   ("Where settings are kept"). Where the shell lacks page() the head is drawn here (an older shell, a test's FAKE).
(() => {
  'use strict';
  const PAGE = 'settings';
  const THEME_KEY = 'timmy.theme';
  const THEMES = ['amber', 'glacier'];
  const S = () => window.TimmyShell;
  const h = (...a) => S().h(...a);
  const WORDS = {
    kicker: 'SETTINGS / SET HOW TIMMY RUNS',
    title: 'Make Timmy run your way.',
    intro: 'What opens when the workspace starts, how this page looks, where your records stay, and who you are here. Nothing on this page reaches a provider.',
    primary: 'Done',
    dock: 'SETTINGS TOOLS',
    startup: { title: 'Start-up', intro: 'When the workspace starts in Timmy’s terminal, these surfaces open with it.', companion: 'Open the browser companion', studio: 'Open Studio', kept: 'Kept in the Workbench’s settings file: the terminal reads the same one.', notRead: 'The workspace frame has not been read yet, so these are not shown.', saving: 'Saving…', conflict: 'Changed elsewhere: Reload to see the newer setting, then choose again.' },
    appearance: { title: 'Appearance', intro: 'Amber or Glacier: the same page, another material. Status colours mean the same in both (focus amber, an observed live state green).', note: 'Per viewer, in this browser.' },
    records: { title: 'Records', intro: 'Your conversations, receipts and settings are written on this computer first. Cloud sync is optional and never the record.', local: 'Local records: on this computer', change: 'Change cloud sync in Models & accounts', notRead: 'Cloud sync: not read yet.' },
    account: { title: 'Account', intro: 'Your Timmy account is who you are. The providers you connect (OpenRouter, Ollama, Cloudflare) are what you authorize for models — a separate thing, kept in Models & accounts.', open: 'Open account', signOut: 'Sign out', notSigned: 'Not signed in.', operator: 'This computer’s operator.', notConfigured: 'No identity provider is configured, so there is nothing to sign into: this companion runs as this computer’s operator.' },
    recordsDetails: 'Where settings are kept',
  };

  // ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let section = null;
  let regions = null;
  let frame = null;             // the workspace frame drawn (its revision guards a save)
  let frameWords = '';          // why there is none
  let prefs = { state: 'idle', words: WORDS.startup.kept, busy: false };
  let me = null;                // GET /api/identity/me's answer ({ user, words? }) or null
  let meWords = '';
  let cloud = null;             // the Cloudflare card of GET /api/connections, or null
  let cloudWords = '';
  let home = '';                // the records' home (from ~)
  let project = '';
  let reading = 0;

  const shownProject = () => { const el = document.getElementById('project'); return (el && el.dataset && el.dataset.project) || ''; };
  const withProject = (p) => `${p}${project ? `${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}` : ''}`;
  const phone = () => { try { return window.matchMedia('(max-width: 720px)').matches; } catch (e) { return false; } };

  function region(root, cls, tag) { let el = root.querySelector(`.${cls}`); if (!el) { el = h(tag || 'div', { class: cls }); root.append(el); } return el; }
  function findRegions(host) {
    section = host.closest('section.page') || host.closest('[data-page]') || host;
    const work = host.matches('[data-panel-host]') ? host : (section.querySelector('[data-panel-host="settings"]') || region(section, 'page-work'));
    regions = { head: region(section, 'page-head', 'header'), band: region(section, 'page-band'), work, dock: region(section, 'page-dock'), records: region(section, 'page-records') };
  }
  const shellHasPages = () => Boolean(S() && typeof S().page === 'function');

  // ── the theme (the shell's rule, §3.2) ───────────────────────────────────────────────────────────────────────────────
  const themeNow = () => { const t = document.documentElement.getAttribute('data-theme'); return THEMES.includes(t) ? t : 'amber'; };
  function setTheme(t) {
    if (!THEMES.includes(t)) return;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* no storage here */ }
    // the topbar's toggle, when the shell draws one, follows the attribute
    for (const b of document.querySelectorAll('.theme-switch [data-theme]')) b.setAttribute('aria-pressed', b.getAttribute('data-theme') === t ? 'true' : 'false');
    try { if (typeof S().theme === 'function') S().theme(t); } catch (e) { /* the shell's own */ }
    redraw();
  }

  // ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const json = async (r) => { try { return await r.json(); } catch (e) { return null; } };
  async function load() {
    const seq = ++reading;
    const s = S();
    const [fr, m, c, f] = await Promise.all([
      frame ? Promise.resolve(null) : s.fetch(withProject('/api/workspace')).then(async (r) => ({ status: r.status, body: await json(r) }), (e) => ({ status: 0, body: null, error: e })),
      s.fetch('/api/identity/me').then(async (r) => ({ status: r.status, body: await json(r) }), (e) => ({ status: 0, body: null, error: e })),
      s.fetch('/api/connections').then(async (r) => ({ status: r.status, body: await json(r) }), (e) => ({ status: 0, body: null, error: e })),
      s.fetch(withProject('/api/files?path=')).then(async (r) => ({ status: r.status, body: await json(r) }), (e) => ({ status: 0, body: null, error: e })),
    ]);
    if (seq !== reading) return;
    if (fr) {
      if (fr.status === 200 && fr.body && fr.body.revision) { frame = fr.body; frameWords = ''; }
      else { frame = null; frameWords = (fr.body && (fr.body.words || fr.body.error)) || (fr.status === 404 ? 'This companion has no workspace frame for this project.' : fr.status === 401 ? 'Not read: sign in first.' : `The workspace frame could not be read (HTTP ${fr.status}).`); }
    }
    if (m.status === 200 && m.body && m.body.user) { me = m.body; meWords = ''; }
    else { me = null; meWords = (m.body && (m.body.words || m.body.error)) || (m.status ? `HTTP ${m.status}` : 'not read'); }
    if (c.status === 200 && c.body && Array.isArray(c.body.cards)) { cloud = c.body.cards.find((x) => x && x.id === 'cloudflare') || null; cloudWords = cloud ? '' : 'The Cloudflare card is not in this companion’s connections.'; }
    else { cloud = null; cloudWords = (c.body && (c.body.words || c.body.error)) || (c.status === 404 ? 'This companion has no connections route (Models & accounts says more).' : c.status === 401 ? 'Not read: sign in first.' : WORDS.records.notRead); }
    home = f.status === 200 && f.body && f.body.where ? String(f.body.where.home || '') : '';
    redraw();
  }

  // ── the start-up settings (the same save rule as companion.js's: one at a time, the revision checked) ───────────────
  const PREF_SURFACE = { openCompanionAtStart: 'companion', openStudioAtStart: 'studio' };
  const prefsOf = (f) => JSON.stringify(Object.values(PREF_SURFACE).map((k) => Boolean(f && f.surfaces && f.surfaces[k] && f.surfaces[k].openAtStart === true)));
  const hourMinute = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? String(iso || '') : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
  async function postPref(key, want, revision) {
    const r = await S().fetch(withProject('/api/workspace/prefs'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: want, if_revision: revision }) });
    return { status: r.status, body: await json(r) };
  }
  async function savePref(key, want) {
    const drawn = frame;
    if (!drawn || prefs.busy || prefs.state === 'conflict' || !Object.prototype.hasOwnProperty.call(PREF_SURFACE, key)) { redraw(); return; }
    prefs = { state: 'saving', words: WORDS.startup.saving, busy: true }; redraw();
    try {
      let { status, body } = await postPref(key, want, drawn.revision);
      const stale = () => status === 409 && body && body.error === 'stale';
      if (stale() && body.frame && prefsOf(body.frame) === prefsOf(drawn)) ({ status, body } = await postPref(key, want, body.frame.revision));
      if (status === 200 && body && typeof body.saved_at === 'string') {
        if (body.frame) frame = body.frame;
        prefs = { state: 'saved', words: `Saved at ${hourMinute(body.saved_at)}. ${WORDS.startup.kept}`, busy: false };
      } else if (stale()) {
        prefs = { state: 'conflict', words: WORDS.startup.conflict, busy: false };
      } else {
        prefs = { state: 'failed', words: `Not saved: ${(body && typeof body.error === 'string' && body.error) || `the companion answered HTTP ${status}`}`, busy: false };
      }
    } catch (err) { prefs = { state: 'failed', words: `Not saved: the companion could not be reached (${err && err.message ? err.message : String(err)})`, busy: false }; }
    redraw();
  }

  function reload() { frame = null; prefs = { state: 'idle', words: WORDS.startup.kept, busy: false }; load(); }
  function done() { try { S().go('chat', 'settings-done'); } catch (e) { /* no chat page */ } }
  async function signOut() {
    try { if (window.timmyAccount && typeof window.timmyAccount.signOut === 'function') await window.timmyAccount.signOut(); else if (S().session) S().session.clear(); } catch (e) { /* the account screen's own words */ }
    me = null; load();
  }

  // ── the registration ─────────────────────────────────────────────────────────────────────────────────────────────────
  function pageMeta() { return { kicker: WORDS.kicker, title: WORDS.title, intro: WORDS.intro, primary: { label: WORDS.primary, run: done, disabled: false }, context: null, dock: WORDS.dock }; }
  function register() {
    if (!shellHasPages()) return;
    try { S().page(PAGE, pageMeta()); } catch (e) { /* the shell's own */ }
    try { if (typeof S().state === 'function') S().state(PAGE, 'content'); } catch (e) { /* the shell's own */ }
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  function head() {
    const btn = h('button', { type: 'button', class: 'ui-primary sh-btn-primary', 'data-st': 'primary' }, WORDS.primary, h('span', { 'aria-hidden': 'true' }, ' →'));
    btn.addEventListener('click', done);
    return [h('div', { class: 'page-head-words' }, h('p', { class: 'page-kicker' }, WORDS.kicker), h('h1', { class: 'page-title', tabindex: '-1' }, WORDS.title), h('p', { class: 'page-intro' }, WORDS.intro)), h('div', { class: 'page-primary' }, btn)];
  }
  function band() {
    const name = (frame && frame.project && frame.project.name) || 'this project';
    return [h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, 'Workspace'), h('strong', { class: 'band-v' }, name)), h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, 'Model'), h('strong', { class: 'band-v' }, 'as chosen in Chat')), h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, 'Records'), h('strong', { class: 'band-v' }, 'Local'))];
  }

  function card(id, title, intro, ...children) {
    return h('section', { class: 'st-card', 'aria-labelledby': `st-${id}-title`, 'data-st-card': id },
      h('h2', { class: 'st-card-title', id: `st-${id}-title` }, title),
      h('p', { class: 'st-note st-card-intro' }, intro),
      ...children);
  }

  function startup() {
    const rows = [];
    for (const [key, surface] of Object.entries(PREF_SURFACE)) {
      const on = Boolean(frame && frame.surfaces && frame.surfaces[surface] && frame.surfaces[surface].openAtStart === true);
      const box = h('input', { type: 'checkbox', id: `st-pref-${surface}`, class: 'st-switch', 'data-pref': key, disabled: !frame || prefs.busy || prefs.state === 'conflict' });
      box.checked = on;
      box.addEventListener('change', () => savePref(key, box.checked));
      const running = frame && frame.surfaces && frame.surfaces[surface] ? frame.surfaces[surface].state : 'unknown';
      rows.push(h('div', { class: 'st-row' }, h('label', { class: 'st-switch-label', for: `st-pref-${surface}` }, box, h('span', { class: 'st-switch-track', 'aria-hidden': 'true' }), h('span', { class: 'st-switch-words' }, WORDS.startup[surface], h('small', { class: 'st-note' }, `now: ${running === 'running' ? 'running' : running === 'not running' ? 'not running' : 'unknown'}`)))));
    }
    const stateLine = h('p', { class: `st-state${prefs.state === 'failed' || prefs.state === 'conflict' ? ' is-attn' : ''}`, role: 'status', 'data-st': 'prefs-state', 'data-state': prefs.state }, frame ? prefs.words : (frameWords || WORDS.startup.notRead));
    return card('startup', WORDS.startup.title, WORDS.startup.intro, ...rows, stateLine);
  }

  function appearance() {
    const now = themeNow();
    const group = h('div', { class: 'st-theme', role: 'group', 'aria-label': 'Theme' },
      ...THEMES.map((t) => { const b = h('button', { type: 'button', class: `st-theme-btn${t === now ? ' is-current' : ''}`, 'data-theme-pick': t, 'aria-pressed': t === now ? 'true' : 'false' }, h('i', { class: `st-swatch st-swatch-${t}`, 'aria-hidden': 'true' }), t === 'amber' ? 'Amber' : 'Glacier'); b.addEventListener('click', () => setTheme(t)); return b; }));
    return card('appearance', WORDS.appearance.title, WORDS.appearance.intro, group, h('p', { class: 'st-note' }, `${WORDS.appearance.note} Now: ${now === 'amber' ? 'Amber' : 'Glacier'}.`));
  }

  function records() {
    const lines = [h('p', { class: 'st-line' }, h('span', { class: 'st-dot', 'aria-hidden': 'true' }), WORDS.records.local)];
    if (cloud) {
      const s = cloud.cloudflare || { gatewayUrl: null, cloudLogs: false };
      lines.push(h('p', { class: 'st-line' }, s.cloudLogs ? 'Cloud sync (Cloudflare logs): on — a copy of the run events is to be synced; the local records stay the record.' : 'Cloud sync (Cloudflare logs): off — local records are the design; nothing is sent.'));
      lines.push(h('p', { class: 'st-note' }, `Cloudflare: ${cloud.words || cloud.state}${s.gatewayUrl ? ' · AI Gateway set' : ''}`));
    } else lines.push(h('p', { class: 'st-note' }, cloudWords || WORDS.records.notRead));
    const change = h('button', { type: 'button', class: 'sh-btn', 'data-st': 'connections' }, WORDS.records.change, h('span', { 'aria-hidden': 'true' }, ' →'));
    change.addEventListener('click', () => { try { S().go('connections', 'settings'); } catch (e) { /* no page */ } });
    return card('records', WORDS.records.title, WORDS.records.intro, ...lines, h('div', { class: 'st-actions' }, change));
  }

  function account() {
    const id = S() && typeof S().identity === 'function' ? S().identity() : null;
    const configured = Boolean(id && id.configured);
    const user = me && me.user;
    let who; let sub;
    if (user && user.operator) { who = WORDS.account.operator; sub = me.words || WORDS.account.notConfigured; }
    else if (user) { who = `Signed in as ${user.username || user.email || user.id}.`; sub = `Verified by this companion: ${user.id}.`; }
    else { who = WORDS.account.notSigned; sub = configured ? (meWords ? `${meWords}` : 'Sign in to keep your own projects and records.') : WORDS.account.notConfigured; }
    // the names to set are said once: in the operator's own words above when that is who this is, else here
    const provider = configured ? `Identity provider: configured (${(() => { try { return new URL(id.frontendApi).host; } catch (e) { return 'Clerk'; } })()}).` : `Identity provider: not configured${!(user && user.operator) && id && id.needs && id.needs.length ? ` — missing ${id.needs.join(', ')}` : ''}.`;
    const openBtn = h('button', { type: 'button', class: 'sh-btn', 'data-st': 'account' }, WORDS.account.open, h('span', { 'aria-hidden': 'true' }, ' →'));
    openBtn.addEventListener('click', () => { try { S().go('account', 'settings'); } catch (e) { /* no page */ } });
    const out = h('button', { type: 'button', class: 'sh-btn', 'data-st': 'signout', hidden: !(user && !user.operator) }, WORDS.account.signOut);
    out.addEventListener('click', signOut);
    return card('account', WORDS.account.title, WORDS.account.intro,
      h('p', { class: 'st-line st-who', 'data-st': 'who' }, who), h('p', { class: 'st-note' }, sub), h('p', { class: 'st-note', 'data-st': 'provider' }, provider),
      h('div', { class: 'st-actions' }, openBtn, out));
  }

  function dock() {
    let group = regions.dock.querySelector('[data-dock-owner="settings"]');
    if (!group) { group = h('span', { class: 'dock-group', 'data-dock-owner': 'settings' }); regions.dock.append(group); }
    if (!shellHasPages() && !regions.dock.querySelector('.dock-label')) regions.dock.prepend(h('span', { class: 'dock-label' }, WORDS.dock));
    const reloadBtn = h('button', { type: 'button', class: 'dock-btn sh-btn', 'data-st': 'reload' }, 'Reload');
    reloadBtn.addEventListener('click', reload);
    group.replaceChildren(reloadBtn);
  }
  function recordsRegion() {
    let det = regions.records.querySelector('details[data-records-owner="settings"]');
    if (!det) { det = h('details', { class: 'records st-records', 'data-records-owner': 'settings' }); regions.records.append(det); }
    const wasOpen = det.open;
    det.replaceChildren(h('summary', null, WORDS.recordsDetails), h('dl', { class: 'st-dl' },
      h('dt', null, 'Your Timmy home (records, settings, keys you connected)'), h('dd', { class: 'st-mono' }, home || 'not read yet'),
      h('dt', null, 'Start-up settings'), h('dd', null, 'the Workbench’s settings file in that home (the terminal reads the same one)'),
      h('dt', null, 'Theme'), h('dd', null, 'this browser only (localStorage "timmy.theme"); never a token or a key')));
    det.open = wasOpen;
  }

  function redraw() {
    if (!regions || !regions.work.isConnected) return;
    const active = document.activeElement;
    const focused = active && section.contains(active) ? (active.getAttribute('data-st') || active.getAttribute('data-theme-pick') || active.id) : null;
    if (shellHasPages()) register(); else { regions.head.replaceChildren(...head()); regions.band.replaceChildren(...band()); }
    regions.work.replaceChildren(h('div', { class: 'st-grid' }, startup(), appearance(), records(), account()));
    dock();
    recordsRegion();
    section.dataset.state = 'content';
    if (focused) { const again = section.querySelector(`[data-st="${CSS.escape(focused)}"], [data-theme-pick="${CSS.escape(focused)}"], #${CSS.escape(focused)}`); if (again && !again.disabled) again.focus({ preventScroll: true }); }
  }

  function show(host, fr, ctx) {
    if (!host) return;
    findRegions(host);
    const now = (ctx && ctx.project) || shownProject();
    if (now !== project) { project = now; frame = null; }
    if (fr && fr.revision && (!frame || frame.revision !== fr.revision) && prefs.state !== 'conflict' && !prefs.busy) frame = fr;
    redraw();
    load();
  }
  const hostNow = () => document.querySelector('[data-panel-host="settings"]') || document.querySelector('section.page[data-page="settings"]') || document.getElementById('screen-settings');

  function mount() {
    const s = S();
    if (!s) return;
    if (window.TimmyPanels && typeof window.TimmyPanels.register === 'function') window.TimmyPanels.register(PAGE, { draw(host, fr, ctx) { show(host, fr, ctx); } });
    register();
    if (typeof s.on === 'function') {
      s.on('page', (d) => { if (d && d.id === PAGE && !(window.TimmyPanels && window.TimmyPanels.has && window.TimmyPanels.has(PAGE))) { const host = hostNow(); if (host) show(host, null, null); } });
      s.on('session', () => { if (regions && regions.work.isConnected && typeof s.current === 'function' && s.current() === PAGE) load(); });
    }
    const host = hostNow();
    if (host && !(window.TimmyPanels && window.TimmyPanels.has && window.TimmyPanels.has(PAGE)) && typeof s.current === 'function' && s.current() === PAGE) show(host, null, null);
  }
  if (window.TimmyShell) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });

  /** The seam for tests: show into a host now; the state as the page holds it (never a token or a key). */
  window.timmySettings = {
    mount: (host, fr, ctx) => show(host, fr || null, ctx || null),
    state: () => ({ frame: Boolean(frame), revision: frame ? frame.revision : null, prefs: { state: prefs.state, words: prefs.words }, theme: themeNow(), me: me ? (me.user.operator ? 'operator' : me.user.id) : null, cloud: cloud ? { state: cloud.state, cloudLogs: Boolean(cloud.cloudflare && cloud.cloudflare.cloudLogs) } : null, home }),
    setTheme,
    reload,
  };
})();
