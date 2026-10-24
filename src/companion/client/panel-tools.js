// R6 (H142): the Tools & MCP panel (tab 9; the operator's references 08 and 17), drawn into data-panel-host="tools"
// (panels.js says how a panel registers and what it is given; its routes are src/companion/panels/tools.ts).
//
// Four panes, as the references lay theirs out, and the project's newest calls under them:
//   Ingest & tools     the ingest modes as Timmy has them, the two routes with their rungs, the servers (Timmy's FAKE fixture,
//                      MCPorter's config and editor imports) with their transport and what was observed of them, what a
//                      listing starts or contacts (said before it), a real tools/list through the route picked, each tool
//                      with its hints and schema. A command line typed here is checked and given as its exact lines for
//                      Timmy's terminal, never started from the page (NEEDS YOU: a command line you typed runs only there)
//   Request            a form made from the tool's input schema, checked against it (the MCP SDK's validator, on the
//                      companion) before anything is sent, the exact JSON-RPC request, the route to call through, the page's
//                      rule for this call, and the generated CLI: the exact /mcp call lines and each route's own command
//   Wire & schema gate the call's JSON-RPC traffic as Timmy's wire tap measured it (one bar per request, its time), and the
//                      schema gate's checks
//   Result & receipt   what the call came to: the server's answer (text, JSON, images drawn), its exact JSON-RPC answer, what
//                      the route printed, how long it took, the route, and the record and receipt Timmy keeps (verified now)
// A call that would need a person is refused before anything runs: NEEDS YOU, with the line to type in Timmy's terminal.
// The panel's one primary next step is amber; green only for an observed answer and a receipt verified now.
//
// R11 round 7 (H170; the operator's order of 2026-10-24: "Tools appear in real workflows and their proper pages; a global
// directory is secondary"; H175's SHELL CONTRACT v1): the page's words ("09 / FIND THE RIGHT TOOL · Find the right tool for
// the task."), then WHERE TOOLS WORK first — each inventory group with the pages that use it (a button opens the page) and
// its rows in the three words (available · configured · exercised, never a fourth), the MCP ↔ CLI routes named with their
// rungs where they exist — then the inspector (this page's own workflow: list → check → call → record) and, secondary, the
// DIRECTORY (every capability as a card, collapsible), the project's calls as the records. The page's section is the shell's
// scaffold (H175's commit 2): the panel registers the page (TimmyShell.page / state — the head is the shell's, the kicker's
// number the rail's) and puts its tools in the dock's tools.
(() => {
  if (!document.querySelector('link[href="/panel-tools.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/panel-tools.css'; document.head.append(l); }
  const PAGE_WORDS = Object.freeze({
    kicker: 'FIND THE RIGHT TOOL',
    title: 'Find the right tool for the task.',
    intro: 'Discover capabilities here, and use them in the workflow where they belong.',
    where: 'Where tools work',
    whereLead: 'Each capability in the page that uses it, in the three words of its state: available (the files or binaries are here) · configured (the key, setting or address is set) · exercised (a receipt of a real run exists).',
    directory: 'Directory · every capability, secondary',
  });
  /**
   * The pages that use each inventory group (the product's own structure: src/contracts/workspace.ts' destinations), as the
   * page names them; the page id is the shell's (TimmyShell.go) and the legacy tab id is what the old shell shows.
   */
  const WHERE = Object.freeze({
    Models: [{ page: 'chat', legacy: 'chat', name: 'Chat', how: 'the turn’s route and its model' }, { page: 'connections', legacy: 'connections', name: 'Models & accounts', how: 'connect, check, download' }],
    Tools: [{ page: 'voxvision', legacy: 'voxvision', name: 'VoxVision', how: '/detect, /measure, /inspect records' }],
    Integrations: [{ page: 'chat', legacy: 'chat', name: 'Chat', how: 'tool calls, gated at NEEDS YOU' }, { page: 'tools', legacy: 'tools', name: 'this page', how: 'the inspector: list, check, call' }],
    Lanes: [{ page: 'workflows', legacy: 'workflows', name: 'Workflows', how: 'a lane’s steps' }, { page: 'runs', legacy: 'logs', name: 'Runs & receipts', how: 'what each run did' }],
    Vision: [{ page: 'voxvision', legacy: 'voxvision', name: 'VoxVision', how: 'the vision bridge' }, { page: 'canvas', legacy: 'studio', name: 'Canvas', how: 'references on the board' }],
    Receipts: [{ page: 'runs', legacy: 'logs', name: 'Runs & receipts', how: 'every sealed turn, job and record' }],
  });
  /** The panel's state, kept across the page's redraws (a frame that moves must not wipe a form being filled). */
  const P = {
    host: null, project: null, ctx: null, built: false,
    state: null, stateError: null, servers: null, serversError: null,
    mode: 'stdio',
    /** the server picked: { kind: 'fixture' } | { kind: 'configured', name, transport } | { kind: 'stdio', command } */
    server: { kind: 'fixture' },
    typed: '',
    listRoute: 'sdk', callRoute: 'sdk',
    listing: null, listBusy: false,
    /** what was observed of each server, by its key: { ok, words, at, route } */
    observed: new Map(),
    tool: null, args: {}, raw: {}, check: null, checkBusy: false, checkTimer: 0, checkSeq: 0,
    callBusy: false, result: null,
    calls: [], more: 0, callsAt: 0, el: {},
    /** R11 Phase 2: the inventory (GET inventory), its read in flight, and why it could not be read */
    inventory: null, inventoryBusy: false, inventoryError: null,
  };

  const routeName = (id) => (id === 'sdk' ? 'the SDK route' : 'the mcporter route');
  const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'at an unknown time' : d.toLocaleTimeString('en-GB', { hour12: false }); };
  const msWords = (n) => (typeof n !== 'number' ? 'not measured' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`);
  const bytesWords = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
  const serverKey = (s) => (s.kind === 'fixture' ? 'fixture' : s.kind === 'configured' ? `configured:${s.name}` : `stdio:${s.command}`);
  const specOf = (s) => (s.kind === 'fixture' ? { kind: 'fixture' } : s.kind === 'configured' ? { kind: 'configured', name: s.name } : { kind: 'stdio', command: s.command });
  const isStdio = (s) => s.kind !== 'configured' || s.transport === 'stdio';
  const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return String(text); } };

  function h(tag, attrs, ...kids) { return P.ctx.h(tag, attrs, ...kids); }
  /** An element's children replaced; an absent child (null, undefined, false) is left out, never written as its name. */
  const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  const svg = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
    return el;
  };

  async function api(path, body) {
    const ctx = P.ctx;
    const init = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await ctx.fetch(ctx.api(path), init);
    let data = null;
    try { data = await r.json(); } catch (e) { data = { error: `the companion answered HTTP ${r.status} without JSON` }; }
    return { status: r.status, body: data || {} };
  }

  // ── building the panel once per project ──

  function box(cls, title, ...kids) {
    const body = h('div', { class: 'box-body' }, ...kids);
    return { box: h('section', { class: `box ${cls}`, 'aria-label': title }, h('h2', { class: 'box-title' }, title), body), body };
  }

  function build(host) {
    const e = P.el;
    e.steps = h('ol', { class: 'tools-steps', 'aria-label': 'The inspector\'s steps' });
    e.modes = h('div', { class: 'tools-modes', role: 'radiogroup', 'aria-label': 'Ingest mode' });
    e.routes = h('div', { class: 'tools-routes' });
    e.servers = h('div', { class: 'tools-servers' });
    e.listCtl = h('div', { class: 'tools-listctl' });
    e.tools = h('div', { class: 'tools-tools' });
    e.schema = h('div', { class: 'tools-schema' });
    // the listing's control first (the route, the one primary, what a listing starts or contacts), as the request pane puts
    // its call's control first; then the modes, the servers, the routes' rungs, the tools read and the picked tool's schema
    const ingest = box('tools-ingest', 'Ingest · servers and their tools', e.listCtl, e.modes, e.servers, e.routes, e.tools, e.schema);
    e.form = h('form', { class: 'tools-form', autocomplete: 'off', novalidate: true });
    e.form.addEventListener('submit', (ev) => { ev.preventDefault(); });
    e.formHead = h('div', { class: 'tools-formhead' });
    e.callCtl = h('div', { class: 'tools-callctl' });
    e.request = h('div', { class: 'tools-request-json' });
    e.cli = h('div', { class: 'tools-cli' });
    // the call's control first (its route, the page's rule, the one primary), then the form it sends, the request, the CLI
    const request = box('tools-request', 'Request · checked against its schema · generated CLI', e.formHead, e.callCtl, e.form, e.request, e.cli);
    e.graph = h('div', { class: 'tools-graph' });
    e.gate = h('div', { class: 'tools-gate' });
    const wire = box('tools-wire', 'JSON-RPC wire & schema gate', e.graph, e.gate);
    e.result = h('div', { class: 'tools-result', 'aria-live': 'polite' });
    const result = box('tools-resultbox', 'Result, record & receipt', e.result);
    e.calls = h('div', { class: 'tools-calls' });
    const calls = box('tools-callsbox', 'This project\'s newest calls · from their records', e.calls);
    // R11 Phase 2 (H171): the capabilities, one card each, in the three words every surface keeps apart. R11 round 7: the
    // directory is SECONDARY (a collapsible section after the inspector); WHERE TOOLS WORK comes first
    e.caps = h('div', { class: 'tools-caps', 'data-tools-caps': '' });
    e.where = h('div', { class: 'tools-where', 'data-tools-where': '' });
    const where = box('tools-wherebox', PAGE_WORDS.where, h('p', { class: 'tools-where-lead' }, PAGE_WORDS.whereLead), e.where);
    // (open: secondary by its place, after the pages that use the tools, never hidden from a reader who scrolls to it)
    e.directory = h('details', { class: 'tools-directory', 'data-tools-directory': '', open: true }, h('summary', { class: 'tools-directory-summary' }, PAGE_WORDS.directory), e.caps);
    const root = h('div', { class: 'tools-panel', 'data-tools-panel': '' },
      where.box,
      e.steps,
      h('div', { class: 'tools-grid' }, ingest.box, request.box, wire.box, result.box),
      e.directory,
      calls.box);
    put(host, root);
    P.built = true;
    registerPage();
  }

  // ── the page (R11 round 7): the shell's scaffold, or the panel's own head; where tools work ──
  const shellOf = () => (typeof TimmyShell !== 'undefined' && TimmyShell && typeof TimmyShell.page === 'function' ? TimmyShell : null);
  function scaffoldOf() {
    const section = P.host ? (P.host.closest('section.page') || P.host.closest('.ws-page')) : null;
    if (!section) return null;
    const dock = section.querySelector(':scope > .page-dock');
    let tools = dock ? dock.querySelector(':scope > .dock-tools') : null;
    if (dock && !tools) { tools = document.createElement('div'); tools.className = 'dock-tools'; dock.append(tools); }
    return { section, dock: tools, records: section.querySelector(':scope > .page-records') };
  }
  /** The rail's number for this page (the shell's), before the kicker's verb phrase. */
  const kickerOf = (sh) => { const p = sh && sh.PAGES && sh.PAGES.find ? sh.PAGES.find((x) => x.id === 'tools') : null; return `${p && p.n ? `${p.n} / ` : ''}${PAGE_WORDS.kicker}`; };
  /** The ONE primary next action: the inspector's next step (a real tools/list on the picked server, then the call). */
  function primaryOf() {
    const listed = Boolean(P.listing && P.listing.ok && P.listing.key === serverKey(P.server));
    if (!listed) return { label: 'List the tools', run: () => { const b = P.el.listCtl && P.el.listCtl.querySelector('[data-tools-action="list"]'); if (b && !b.disabled) b.click(); }, why: '' };
    if (!P.tool) return { label: 'Pick a tool', run: () => { const b = P.el.tools && P.el.tools.querySelector('button'); if (b) b.focus(); }, why: '' };
    return { label: `Call ${P.tool.name}`, run: () => { const b = P.el.callCtl && P.el.callCtl.querySelector('[data-tools-action]'); if (b && !b.disabled) b.click(); }, why: '' };
  }
  function registerPage() {
    const sh = shellOf();
    const word = P.stateError ? 'error' : (P.listBusy || P.callBusy) ? 'running' : 'content';
    if (sh) {
      const pr = primaryOf();
      try { sh.page('tools', { kicker: kickerOf(sh), title: PAGE_WORDS.title, intro: PAGE_WORDS.intro, primary: { label: pr.label, run: pr.run }, context: null, dock: 'TOOLS & INTEGRATIONS' }); } catch (e) { /* the shell says */ }
      if (typeof sh.state === 'function') { try { sh.state('tools', word, word === 'error' ? { words: `The inspector could not read its state: ${P.stateError}`, next: { label: 'Read again', run: () => void loadState() } } : undefined); } catch (e) { /* as above */ } }
    }
    drawDock();
  }
  /** The page's tools in the shell's dock: the inventory read again, the directory, the records (the calls). */
  function drawDock() {
    const sc = scaffoldOf();
    if (!sc || !sc.dock) return;
    for (const old of sc.dock.querySelectorAll('[data-tools-dock]')) old.remove();
    const mk = (key, label, onClick, title) => { const b = h('button', { type: 'button', class: 'dock-btn tools-dock-btn', 'data-tools-dock': key, title: title || null }, label); b.addEventListener('click', onClick); return b; };
    sc.dock.append(
      mk('check', '⟳ Check again', () => void loadInventory(true), 'Reads this computer again: files, settings and this project’s receipts; nothing runs'),
      mk('directory', '▦ Directory', () => { const d = P.el.directory; if (d) { d.open = !d.open; d.scrollIntoView({ block: 'nearest' }); } }),
      mk('records', '▤ Records', () => { const c = P.host && P.host.querySelector('.tools-callsbox'); if (c) c.scrollIntoView({ block: 'start' }); }));
  }
  /**
   * Where tools work: the inventory's groups, each with the pages that use it (the WHERE map) and its rows in their standing
   * word (the same rows the directory draws; never a fourth word); the MCP ↔ CLI routes named with their rungs where they exist.
   */
  function renderWhere() {
    const el = P.el.where;
    if (!el) return;
    const inv = P.inventory;
    if (!inv) { put(el, h('p', { class: 'empty' }, P.inventoryBusy ? 'Reading this computer: files, settings and this project’s receipts (no model runs)…' : P.inventoryError ? `The inventory could not be read: ${P.inventoryError}` : 'Not read yet.')); return; }
    const byId = new Map(inv.inventory.rows.map((r) => [r.id, r]));
    const standing = new Map(inv.cards.map((c) => [c.id, c.standing]));
    const routes = (P.state && P.state.routes) || [];
    const goTo = (w) => h('button', { type: 'button', class: 'tools-where-page', 'data-tools-go': w.page, 'data-dest': w.legacy, title: w.how }, `${w.name} →`);
    const groups = inv.inventory.groups.map((g) => {
      const rows = inv.cards.filter((c) => c.group === g && byId.has(c.id)).map((c) => byId.get(c.id));
      if (!rows.length) return null;
      const where = WHERE[g] || [];
      return h('section', { class: 'tools-where-group', 'data-tools-where-group': g },
        h('div', { class: 'tools-where-head' }, h('h3', { class: 'tools-where-k' }, g), h('div', { class: 'tools-where-pages' }, where.length ? where.map(goTo) : h('span', { class: 'tools-dim' }, 'no page uses this group yet'))),
        where.length ? h('p', { class: 'tools-where-how' }, where.map((w) => `${w.name}: ${w.how}`).join(' · ')) : null,
        h('ul', { class: 'tools-where-rows' }, ...rows.map((r) => { const s = standing.get(r.id) || 'none'; return h('li', { class: 'tools-where-row', 'data-tools-where-row': r.id, 'data-state': s },
          h('span', { class: 'tools-where-name' }, r.name), ' ',
          s === 'none' ? h('span', { class: 'tools-dim' }, 'none of the three') : h('span', { class: `tl-chip is-${s}${s === 'exercised' ? ' is-verified' : ''}`, 'data-tl-word': s }, `● ${s}`),
          r.next ? h('span', { class: 'tools-where-next' }, ` · next: ${r.next}`) : null); })),
        g === 'Integrations' && routes.length ? h('p', { class: 'tools-where-routes', 'data-tools-routes': '' }, 'MCP ↔ CLI routes: ', ...routes.map((r, i) => h('span', { 'data-tools-where-route': r.id }, `${i ? ' · ' : ''}${r.id === 'sdk' ? 'the SDK route' : 'the mcporter route'} — ${r.rung}${r.version ? ` ${r.version}` : ''}`))) : null);
    });
    put(el, ...groups);
  }

  // ── reading ──

  async function loadState() {
    const r = await api('state');
    if (r.status !== 200) { P.state = null; P.stateError = r.body.error || `HTTP ${r.status}`; }
    else { P.state = r.body; P.stateError = null; P.calls = r.body.calls || []; P.more = r.body.more || 0; P.callsAt = Date.now(); }
    renderAll();
  }

  /** R11 Phase 2: the inventory read (the companion keeps one reading for 30 s; Check again asks for a fresh one). */
  async function loadInventory(refresh) {
    if (P.inventoryBusy) return;
    P.inventoryBusy = true;
    P.inventoryError = null;
    renderInventory();
    const r = await api(refresh ? 'inventory?refresh=1' : 'inventory');
    P.inventoryBusy = false;
    if (r.status !== 200 || !r.body.ok) { P.inventoryError = r.body.error || `HTTP ${r.status}`; }
    else P.inventory = r.body;
    renderInventory();
  }


  /**
   * One capability as a card: its name, the chip, the row's own three sentences (available · configured · exercised, each
   * its own fact, in the words the terminal shows for the same row), and the one next step. A next step that names a key,
   * a token or an address is set in the terminal: the card says so and holds no field.
   */
  function capCard(r) {
    // the chip is the standing word (the terminal's: no chip when none holds, the found words say it; never a fourth word);
    // green (.is-verified) only for exercised: a verified sealed receipt; available and configured are in the text colour
    const chip = r.standing === 'none' ? null : h('span', { class: `tl-chip is-${r.standing}${r.standing === 'exercised' ? ' is-verified' : ''}`, 'data-tl-word': r.standing }, `● ${r.standing}`);
    const fact = (k, f) => h('li', { class: 'tl-fact', 'data-tl-fact': k, 'data-tl-ok': f.ok ? '1' : '0' },
      h('span', { class: `tl-mark ${f.ok ? (k === 'exercised' ? 'is-ok is-verified' : 'is-ok') : 'is-no'}`, 'aria-hidden': 'true' }, f.ok ? '✓' : '–'), h('span', { class: 'tl-fact-w' }, f.words));
    const facts = h('ul', { class: 'tl-facts' }, fact('available', r.available), fact('configured', r.configured), fact('exercised', r.exercised));
    // the next step in the terminal's words (H167's inventoryNext, sent as r.step: the step and where it is set, no command,
    // no address: the same words the terminal's row shows); the inventory's sentence whole beneath it as the detail
    const step = r.step && r.step.next ? `${r.step.next}${r.step.where ? `: ${r.step.where}` : ''}` : r.next;
    const next = r.next
      ? h('p', { class: 'tl-next', 'data-tl-next': r.nextIsCredential ? 'terminal' : 'step' }, h('span', { class: 'tl-next-k' }, 'Next'), ` ${step}`,
        step !== r.next ? h('span', { class: 'tl-next-detail' }, ` ${r.next}`) : null,
        r.nextIsCredential ? h('span', { class: 'tl-next-where' }, ' Set in Models & accounts, the environment or the .env file: nothing is set from this card.') : null)
      : h('p', { class: 'tl-next is-none', 'data-tl-next': 'none' }, h('span', { class: 'tl-next-k' }, 'Next'), ' nothing: it is exercised here.');
    // data-inventory-row and data-state: what H172's capability-words check reads (one element per row, its standing word)
    return h('article', { class: 'tl-card', 'data-inventory-row': r.id, 'data-state': r.standing },
      h('div', { class: 'tl-card-head' }, h('h4', { class: 'tl-name' }, r.name), chip), facts, next);
  }

  function renderInventory() {
    const el = P.el.caps;
    if (!el) return;
    const inv = P.inventory;
    const head = h('div', { class: 'tl-head' },
      h('p', { class: 'tl-words' }, P.inventoryBusy && !inv ? 'Reading this computer: files, settings and this project’s receipts (no model runs)…' : inv ? inv.words : P.inventoryError ? `The inventory could not be read: ${P.inventoryError}` : 'Not read yet.'),
      h('div', { class: 'tl-ctl' },
        h('button', { type: 'button', class: 'btn-action tiny', 'data-tl-refresh': '', disabled: P.inventoryBusy ? true : null }, P.inventoryBusy ? 'Reading…' : 'Check again'),
        inv ? h('span', { class: 'tl-at' }, `read ${clock(inv.inventory.readAt)}`) : null));
    const legend = inv ? h('p', { class: 'tl-legend' }, ...Object.entries(inv.inventory.means).flatMap(([w, m], i) => [i ? ' · ' : '', h('strong', null, w), `: ${m}`])) : null;
    // the rows verbatim (inv.inventory.rows, the capability inventory's shape) with the page's card facts beside each (inv.cards)
    const byId = inv ? new Map(inv.inventory.rows.map((r) => [r.id, r])) : new Map();
    const groups = inv ? inv.inventory.groups.map((g) => {
      const cards = inv.cards.filter((c) => c.group === g && byId.has(c.id));
      if (!cards.length) return null;
      return h('section', { class: 'tl-group', 'data-tl-group': g }, h('h3', { class: 'tl-group-k' }, g), h('div', { class: 'tl-cards' }, ...cards.map((c) => capCard({ ...byId.get(c.id), standing: c.standing, step: c.step, nextIsCredential: c.nextIsCredential }))));
    }) : [];
    put(el, head, legend, inv ? h('p', { class: 'tl-note' }, `Read: ${inv.read}. ${inv.note}`) : null, ...groups);
    renderWhere();
  }

  async function loadServers() {
    P.servers = null;
    P.serversError = null;
    renderServers();
    const r = await api('servers');
    if (r.status !== 200 || !r.body.ok) P.serversError = r.body.error || `HTTP ${r.status}`;
    P.servers = r.body.servers || [];
    renderServers();
  }

  async function refreshCalls() {
    if (Date.now() - P.callsAt < 1500) return;
    P.callsAt = Date.now();
    const r = await api('calls');
    if (r.status === 200) { P.calls = r.body.calls || []; P.more = r.body.more || 0; renderCalls(); renderRoutes(); }
  }

  // ── the steps ──

  /** The listing of the server on screen, when the page answered it NEEDS YOU (a typed command line: never started here). */
  const refusedListing = () => (P.listing && P.listing.refused && P.listing.key === serverKey(P.server) ? P.listing.refused : null);

  function stepState() {
    const listed = Boolean(P.listing && P.listing.ok && P.listing.key === serverKey(P.server));
    const refused = refusedListing();
    const valid = Boolean(P.tool && P.check && P.check.valid);
    const call = P.result && P.result.kind === 'call' ? P.result.call : null;
    const called = Boolean(call && call.tool === (P.tool && P.tool.name));
    // the receipt step follows the call step: the receipt of the call of the tool on screen
    const sealed = Boolean(called && call.receipt && call.receipt.verified);
    const steps = [
      { n: 1, label: 'Ingest', done: true, words: P.server.kind === 'fixture' ? 'FAKE fixture · stdio' : P.server.kind === 'configured' ? `${P.server.name} · ${P.server.transport || 'configured'}` : 'a typed command line · stdio' },
      { n: 2, label: 'tools/list', done: listed, words: listed ? `${P.listing.tools.length} tools via ${P.listing.route}` : refused ? 'NEEDS YOU: in Timmy\'s terminal' : `through ${routeName(P.listRoute)}` },
      { n: 3, label: 'Request · schema', done: valid, words: P.tool ? (valid ? `${P.tool.name}: matches its schema` : P.check ? `${P.tool.name}: ${P.check.errors ? P.check.errors.length : 0} to fix` : `${P.tool.name}: checking`) : 'pick a tool' },
      { n: 4, label: 'Call', done: called, words: called ? `${call.outcome} via ${call.route} · ${msWords(call.ms)}` : `through ${routeName(P.callRoute)}` },
      { n: 5, label: 'Record & receipt', done: sealed, words: sealed ? `sealed and verified · ${call.receipt.id}` : called ? (call.receipt ? 'not verified' : 'no receipt') : 'kept with each call' },
    ];
    const next = steps.find((s) => !s.done);
    return { steps, next: next ? next.n : 0 };
  }

  function renderSteps() {
    const { steps, next } = stepState();
    put(P.el.steps, ...steps.map((s) => h('li', {
      class: `tools-step${s.n === next ? ' is-next' : ''}${s.done ? ' is-done' : ''}${s.n === 5 && s.done ? ' is-verified' : ''}`,
      'data-step': String(s.n), 'aria-current': s.n === next ? 'step' : null,
    }, h('span', { class: 'tools-step-n' }, `${s.done ? (s.n === 5 ? '✓' : '✓') : s.n === next ? '▶' : '·'} ${s.n}. ${s.label}`), h('span', { class: 'tools-step-words' }, s.words))));
  }

  // ── Ingest & tools ──

  function renderModes() {
    const modes = (P.state && P.state.modes) || [];
    const picked = modes.find((m) => m.id === P.mode);
    put(P.el.modes, h('p', { class: 'tools-sub' }, 'INGEST MODE · STDIO / SSE / APISNIP / CLYANYTHING'),
      h('div', { class: 'tools-modegrid' }, ...modes.map((m) => {
        const works = m.state === 'works';
        const input = h('input', { type: 'radio', name: 'tools-mode', value: m.id, disabled: !works, checked: P.mode === m.id, 'aria-describedby': `tools-mode-${m.id}` });
        input.addEventListener('change', () => { if (input.checked) pickMode(m.id); });
        return h('label', { class: `tools-mode${works ? '' : ' is-off'}`, 'data-mode': m.id, title: m.words },
          input, h('span', { class: 'tools-mode-label' }, m.label), h('span', { class: `tools-mode-state${works ? '' : ' is-off'}`, id: `tools-mode-${m.id}` }, works ? `works · ${m.routes.map((r) => (r === 'sdk' ? 'SDK' : 'mcporter')).join(' + ')}` : 'not in Timmy'));
      })),
      picked ? h('p', { class: 'tools-small', 'data-mode-words': picked.id }, picked.words) : null,
      // what the two modes Timmy has no route for are, in words (never a control that pretends)
      ...modes.filter((m) => m.state !== 'works').map((m) => h('p', { class: 'tools-small', 'data-mode-off': m.id }, `${m.label.replace(/^\d+\.\s*/, '')}: ${m.words}.`)));
  }

  function pickMode(id) {
    P.mode = id;
    if (id === 'http') { P.listRoute = 'mcporter'; P.callRoute = 'mcporter'; }
    const pool = serverPool();
    if (!pool.some((s) => serverKey(s) === serverKey(P.server))) pickServer(pool[0] || null);
    else renderAll();
  }

  function renderRoutes() {
    const routes = (P.state && P.state.routes) || [];
    put(P.el.routes, h('p', { class: 'tools-sub' }, 'MCP TO CLI · BOTH ROUTES · RUNG, AND LAST CALL IN THIS PROJECT'), ...routes.map((r) => {
      // the last call through the route: the newest of the project's records, or the call this page just made (its result
      // carries the same facts and its receipt as the companion verified it) until the records are read back
      const recorded = (P.calls || []).find((c) => c.route === r.id);
      const own = P.result && P.result.kind === 'call' && P.result.call && P.result.call.route === r.id ? P.result.call : null;
      const last = own && (!recorded || String(own.startedAt) >= String(recorded.startedAt)) ? own : recorded;
      return h('div', { class: 'tools-route', 'data-route': r.id, title: `${r.details}. Reaches: ${r.reaches}.` },
        h('div', { class: 'row-between' }, h('strong', null, r.id === 'sdk' ? 'The SDK route' : 'The mcporter route'), h('span', { class: 'tools-rung', 'data-rung': r.rung }, `${r.rung}${r.version ? ` · ${r.version}` : ''}`)),
        last
          ? h('p', { class: 'tools-small' }, h('span', { class: last.outcome === 'answered' ? 'is-live' : 'tools-attn' }, last.outcome === 'answered' ? '● answered' : `✕ ${last.outcome}`), ` ${clock(last.startedAt)} · ${last.tool} · `, receiptWords(last.receipt))
          : h('p', { class: 'tools-small' }, 'no call through it in this project yet'),
        r.setup ? h('p', { class: 'tools-small' }, 'set up: ', h('button', { type: 'button', class: 'cmd', 'data-copy': r.setup }, r.setup)) : null);
    }));
  }

  const receiptWords = (rc) => (!rc ? h('span', { class: 'tools-dim' }, 'no receipt') : rc.verified
    ? h('span', { class: 'is-verified' }, `✓ receipt ${rc.id} verified`)
    : h('span', { class: 'tools-attn' }, `✕ receipt ${rc.id} not verified${rc.why ? `: ${rc.why}` : ''}`));

  /** The servers the mode lists: the fixture and stdio ones for stdio; the configured HTTP ones for SSE/HTTP. */
  function serverPool() {
    const out = [];
    const fx = P.state && P.state.fixture;
    const conf = (P.servers || []).map((s) => ({ kind: 'configured', name: s.name, transport: s.transport, entry: s }));
    if (P.mode === 'stdio') {
      if (fx && fx.ok) out.push({ kind: 'fixture' });
      out.push(...conf.filter((s) => s.transport === 'stdio'));
      if (P.server.kind === 'stdio') out.push(P.server);
    } else if (P.mode === 'http') out.push(...conf.filter((s) => s.transport !== 'stdio'));
    return out;
  }

  function observedWords(s) {
    const o = P.observed.get(serverKey(s));
    if (!o) return h('span', { class: 'tools-dim' }, s.kind === 'stdio' ? 'never started from this page' : 'not contacted from this page');
    if (o.refused) return h('span', null, `not started: a command line you typed runs only from Timmy's terminal (checked ${clock(o.at)})`);
    return o.ok
      ? h('span', null, h('span', { class: 'is-live' }, '● answered'), ` tools/list via ${o.route} ${clock(o.at)} · ${o.words}`)
      : h('span', { class: 'tools-attn' }, `✕ did not answer via ${o.route} ${clock(o.at)}: ${o.words}`);
  }

  function renderServers() {
    const e = P.el;
    const fx = P.state && P.state.fixture;
    const pool = serverPool();
    const rows = pool.map((s) => {
      const key = serverKey(s);
      const picked = key === serverKey(P.server);
      const label = s.kind === 'fixture' ? 'FAKE · timmy-fake-fixture' : s.kind === 'configured' ? s.name : `${s.command}`;
      const detail = s.kind === 'fixture' ? 'Timmy\'s own test server: its tools and answers are made up' : s.kind === 'configured'
        ? [s.entry.program, s.entry.url, s.entry.source ? `${s.entry.source}${s.entry.importKind ? ` (${s.entry.importKind})` : ''}` : null, s.entry.auth ? `sign-in ${s.entry.auth}` : null].filter(Boolean).join(' · ')
        : 'a command line typed on this page';
      const btn = h('button', { type: 'button', class: `tools-server${picked ? ' is-picked' : ''}`, 'aria-pressed': picked ? 'true' : 'false', 'data-server': key, title: s.kind === 'fixture' && fx && fx.ok ? fx.command.join(' ') : null },
        h('span', { class: 'row-between' }, h('strong', { class: 'tools-server-name' }, label), h('span', { class: 'tools-transport' }, s.kind === 'configured' ? s.transport : 'stdio')),
        h('span', { class: 'tools-small tools-break' }, detail, ' · ', observedWords(s)));
      btn.addEventListener('click', () => pickServer(s));
      return btn;
    });
    const typed = h('input', { type: 'text', class: 'tools-typed', placeholder: 'node ./server.js --mcp', 'aria-label': 'A stdio server\'s command line', value: P.typed, spellcheck: 'false' });
    typed.addEventListener('input', () => { P.typed = typed.value; });
    typed.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); useTyped.click(); } });
    // checks the line on the companion and gives its exact lines for Timmy's terminal (nothing is started)
    const useTyped = h('button', { type: 'button', class: 'btn-action', 'data-tools-action': 'check-typed' }, 'Check it');
    useTyped.addEventListener('click', () => { const c = P.typed.trim(); if (c) { pickServer({ kind: 'stdio', command: c }); list(); } });
    const reload = h('button', { type: 'button', class: 'btn-action tiny', title: 'Reads MCPorter\'s config files and the editors\' configs it imports again; nothing is started' }, 'read the config again');
    reload.addEventListener('click', () => loadServers());
    const head = h('p', { class: 'tools-sub row-between' }, h('span', null, P.mode === 'http' ? 'SSE / HTTP SERVERS · MCPORTER\'S CONFIG AND EDITOR IMPORTS' : 'STDIO SERVERS · TRANSPORT · WHAT WAS OBSERVED'), reload);
    put(e.servers, head, ...rows,
      P.servers === null ? h('p', { class: 'tools-small' }, 'Reading MCPorter\'s config and the editors\' configs it imports (files only; nothing started)…') : null,
      P.serversError ? h('p', { class: 'tools-small tools-attn' }, `MCPorter's config could not be read: ${P.serversError}`) : null,
      P.servers && !pool.some((s) => s.kind === 'configured') ? h('p', { class: 'tools-small' }, P.mode === 'http'
        ? 'No HTTP server in MCPorter\'s config or editor imports: mcporter config add <name> <https address> adds one to this project\'s config/mcporter.json (Timmy never starts a sign-in).'
        : 'MCPorter\'s config and editor imports name no stdio server.') : null,
      P.mode === 'stdio' ? h('details', { class: 'tools-details', open: P.server.kind === 'stdio' },
        h('summary', null, 'Another stdio server, by its command line'),
        h('div', { class: 'tools-typedrow' }, typed, useTyped),
        h('p', { class: 'tools-small', 'data-tools-typed-rule': '' }, 'This page starts no program typed here: a command line you typed runs only from Timmy\'s terminal. Checking it gives its exact lines: the REPL\'s /mcp tools for each route, MCPorter\'s own, and MCPorter\'s line that adds it to this project\'s config, after which this page lists it with the configured servers.')) : null);
  }

  function pickServer(s) {
    if (!s) { renderAll(); return; }
    P.server = s;
    if (s.kind === 'configured') { P.listRoute = 'mcporter'; P.callRoute = 'mcporter'; }
    P.tool = null; P.check = null;
    renderAll();
    // the server picked: its listing's control, and what a listing of it starts or contacts, at the top of the pane
    const body = P.el.listCtl.closest('.box-body');
    if (body) body.scrollTop = 0;
  }

  function routeSwitch(which, value, onPick) {
    const sdkOk = isStdio(P.server) && P.server.kind !== 'configured';
    return h('div', { class: 'tools-switch', role: 'radiogroup', 'aria-label': which === 'list' ? 'List through' : 'Call through' },
      ...['sdk', 'mcporter'].map((id) => {
        const off = id === 'sdk' && !sdkOk;
        const b = h('button', { type: 'button', class: `tools-switch-btn${value === id ? ' is-picked' : ''}`, role: 'radio', 'aria-checked': value === id ? 'true' : 'false', disabled: off, 'data-route-pick': `${which}:${id}`, title: off ? 'The SDK route runs a server from its command line only' : null }, id === 'sdk' ? 'SDK route' : 'mcporter route');
        b.addEventListener('click', () => onPick(id));
        return b;
      }));
  }

  /** What a listing of the server starts or contacts, said before it is asked for (nothing is started for a typed line). */
  function beforeWords(s) {
    if (s.kind === 'fixture') return 'Listing starts Timmy\'s FAKE fixture on this computer for the list, and the route stops it.';
    if (s.kind === 'stdio') return 'This page starts no program typed here: checking it gives the exact lines to list it from Timmy\'s terminal.';
    const e = s.entry || {};
    const from = e.source ? ` (${e.source}${e.importKind ? `, ${e.importKind}` : ''})` : '';
    if (e.url) return `Listing it contacts ${e.url}: MCPorter reaches that address for the list, as your config sets it up${from}, with any sign-in it already keeps; Timmy starts no new sign-in.`;
    return `Listing it starts ${e.program || 'the program'} as your MCPorter config names it${from}, and the route stops it after the list.`;
  }

  function renderListCtl() {
    const e = P.el;
    const { next } = stepState();
    // after a typed line's NEEDS YOU, its copy is the one primary (renderTools draws it)
    const primary = next === 2 && !refusedListing();
    const typed = P.server.kind === 'stdio';
    const label = P.server.kind === 'fixture' ? 'the FAKE fixture' : P.server.kind === 'configured' ? P.server.name : 'this command line';
    const btn = h('button', { type: 'button', class: `tools-go${primary ? ' is-primary' : ''}`, 'data-tools-action': 'list', disabled: P.listBusy || !serverPool().length },
      typed ? (P.listBusy ? 'Checking the command line…' : 'Check the line for Timmy\'s terminal') : P.listBusy ? `Listing ${label}'s tools…` : `List ${label}'s tools via ${routeName(P.listRoute)}`);
    btn.addEventListener('click', () => list());
    put(e.listCtl, h('div', { class: 'row-10' }, h('span', { class: 'tools-small' }, 'tools/list through'), routeSwitch('list', P.listRoute, (id) => { P.listRoute = id; renderAll(); }), btn),
      serverPool().length ? h('p', { class: 'tools-small tools-break', 'data-tools-before': P.server.kind }, beforeWords(P.server)) : null);
  }

  async function list() {
    if (P.listBusy) return;
    P.listBusy = true;
    renderListCtl();
    const key = serverKey(P.server);
    const r = await api('list', { server: specOf(P.server), route: P.listRoute });
    P.listBusy = false;
    if (r.status === 200) {
      P.listing = Object.assign({}, r.body, { key });
      P.observed.set(key, { ok: r.body.ok, route: r.body.route, at: r.body.at || new Date().toISOString(), words: r.body.ok ? `${r.body.tools.length} tools · ${msWords(r.body.ms)}` : (r.body.error || 'no answer') });
      if (r.body.ok && r.body.tools.length) pickTool(r.body.tools[0].name, false);
      else { P.tool = null; P.check = null; }
    } else if (r.status === 409 && r.body.refused === 'needs you') {
      // a typed command line: checked, never started; its lines for Timmy's terminal
      P.listing = { ok: false, key, route: P.listRoute, tools: [], refused: r.body };
      P.observed.set(key, { ok: false, refused: true, route: P.listRoute, at: new Date().toISOString(), words: 'not started' });
      P.tool = null; P.check = null;
    } else {
      P.listing = { ok: false, key, route: P.listRoute, tools: [], error: r.body.error || `HTTP ${r.status}` };
      P.observed.set(key, { ok: false, route: P.listRoute, at: new Date().toISOString(), words: r.body.error || `HTTP ${r.status}` });
    }
    renderAll();
    // the tools just read, at the top of their pane (only the pane scrolls; the tab stays where it is)
    const body = P.el.tools.closest('.box-body');
    if (body) body.scrollTop = Math.max(0, P.el.tools.offsetTop - body.offsetTop - 4);
  }

  function renderTools() {
    const e = P.el;
    const L = P.listing && P.listing.key === serverKey(P.server) ? P.listing : null;
    if (!L) { put(e.tools, h('p', { class: 'empty' }, P.server.kind === 'stdio' ? 'Not checked yet: "Check it" gives this command line\'s lines for Timmy\'s terminal (nothing is started).' : 'No tools/list read from this server on this page yet.')); return; }
    if (L.refused) { renderTypedNeeds(L.refused); return; }
    if (!L.ok) {
      put(e.tools, h('p', { class: 'tools-attn tools-break' }, P.server.kind === 'stdio' ? `✕ This command line was not taken: ${L.error || 'no answer'}` : `✕ tools/list via ${L.route}: ${L.error || 'no answer'}`),
        L.needsAuth && L.authCommand ? h('p', { class: 'tools-small' }, 'NEEDS YOU, in a terminal: ', h('button', { type: 'button', class: 'cmd', 'data-copy': L.authCommand }, L.authCommand)) : null);
      return;
    }
    put(e.tools,
      h('p', { class: 'tools-sub' }, `TOOLS · ${L.tools.length} · tools/list via ${L.route} · ${msWords(L.ms)} · ${clock(L.at)}`),
      L.started ? h('p', { class: 'tools-small' }, L.started) : null,
      h('p', { class: 'tools-small' }, `Hints: ${L.hintsNote}.`),
      h('ul', { class: 'tools-toollist' }, ...L.tools.map((t) => {
        const picked = P.tool && P.tool.name === t.name;
        const b = h('button', { type: 'button', class: `tools-tool${picked ? ' is-picked' : ''}`, 'aria-pressed': picked ? 'true' : 'false', 'data-tool': t.name, title: t.description || null },
          h('span', { class: 'row-between' },
            h('strong', null, t.name, h('span', { class: 'tools-small' }, `(${t.params.map((p) => (t.required.includes(p) ? p : `${p}?`)).join(', ')})`)),
            h('span', { class: 'tools-small' }, t.inputSchema ? (t.strict.length ? h('span', { class: 'tools-attn' }, `✕ ${t.strict.length} strict issue${t.strict.length === 1 ? '' : 's'}`) : h('span', { class: 'is-verified' }, '✓ strict rule')) : 'no schema')),
          h('span', { class: 'tools-small tools-oneline' }, `hints: ${t.hints}${t.annotations ? ' (its claim)' : ''}${t.description ? ` · ${t.description}` : ''}`));
        b.addEventListener('click', () => pickTool(t.name, true));
        return h('li', null, b);
      })));
  }

  /** A line to copy, with what it is (the generated CLI's rows). */
  const cliLine = (label, text, key) => (text ? h('div', { class: 'tools-cliline', 'data-cli': key },
    h('span', { class: 'tools-small' }, label), h('button', { type: 'button', class: 'cmd', 'data-copy': text, title: 'Copies it' }, text)) : null);

  /** A typed command line's listing, refused before anything started: NEEDS YOU, its line for Timmy's terminal, its other lines. */
  function renderTypedNeeds(a) {
    const { next } = stepState();
    const copy = h('button', { type: 'button', class: `tools-go${next === 2 ? ' is-primary' : ''}`, 'data-tools-action': 'copy-terminal' }, 'Copy the line for Timmy\'s terminal');
    copy.addEventListener('click', () => copyLine(a.rule.command, copy, renderTools));
    const other = a.route === 'sdk' ? 'mcporter' : 'sdk';
    const cli = a.cli || { repl: {} };
    const why = `${a.rule.why.charAt(0).toUpperCase()}${a.rule.why.slice(1)}`;
    // what and why first, then the one primary (copy the line) where the pane shows it, then the line itself and the others
    put(P.el.tools, h('div', { class: 'tools-needs', role: 'alert', 'data-tools-list-result': 'needs-you' },
      h('p', null, h('strong', null, 'NEEDS YOU'), ` · ${a.server} was not started, and its tools were not listed.`),
      h('p', null, `${why}.`),
      h('div', { class: 'row-10', 'data-needs-copy': '' }, copy, h('span', { class: 'tools-small' }, `(${routeName(a.route)}; a typed /mcp tools is your own command there)`)),
      h('button', { type: 'button', class: 'cmd', 'data-copy': a.rule.command, 'data-needs-line': '' }, a.rule.command),
      h('p', { class: 'tools-sub' }, 'GENERATED CLI · THE SAME LISTING, TO COPY'),
      cliLine(`In Timmy's REPL, ${routeName(other)}`, cli.repl && cli.repl[other], `repl-${other}`),
      cliLine('MCPorter\'s own command line', cli.mcporter, 'mcporter'),
      cliLine('Timmy\'s SDK command line', cli.sdk, 'sdk'),
      cliLine('MCPorter\'s line that adds it to this project\'s config (config/mcporter.json); this page then lists it with the configured servers', cli.config, 'config')));
  }

  // the schema, drawn: one row per field (its type, whether required, its rules, its words)
  const rulesOf = (s) => {
    if (!s || typeof s !== 'object') return '';
    const r = [];
    for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'pattern', 'format']) if (s[k] !== undefined) r.push(`${k} ${s[k]}`);
    if (Array.isArray(s.enum)) r.push(`one of ${s.enum.map((x) => JSON.stringify(x)).join(' | ')}`);
    if (s.default !== undefined) r.push(`default ${JSON.stringify(s.default)}`);
    return r.join(' · ');
  };
  const typeOf = (s) => (s && typeof s === 'object' ? (Array.isArray(s.type) ? s.type.join(' | ') : s.type || (s.enum ? 'enum' : s.anyOf ? 'any of' : 'any')) : 'any');

  function renderSchema() {
    const e = P.el;
    const t = P.tool;
    if (!t) { put(e.schema); return; }
    const s = t.inputSchema;
    const props = s && s.properties && typeof s.properties === 'object' ? Object.entries(s.properties) : [];
    put(e.schema,
      h('p', { class: 'tools-sub' }, `INPUT SCHEMA · ${t.name}`),
      !s ? h('p', { class: 'empty' }, 'The server listed this tool without an input schema, so a request to it cannot be checked.') : null,
      s ? h('table', { class: 'tools-schematable' },
        h('thead', null, h('tr', null, h('th', null, 'field'), h('th', null, 'type'), h('th', null, 'required'), h('th', null, 'rules'), h('th', null, 'what it is'))),
        h('tbody', null, ...(props.length ? props.map(([name, p]) => h('tr', { 'data-field': name },
          h('td', null, h('code', null, name)), h('td', null, typeOf(p)), h('td', null, (s.required || []).includes(name) ? 'required' : 'optional'),
          h('td', null, rulesOf(p)), h('td', null, p && p.description ? String(p.description) : ''))) : [h('tr', null, h('td', { colspan: '5' }, 'no fields: the tool takes an empty object'))]))) : null,
      s && s.additionalProperties === false ? h('p', { class: 'tools-small' }, 'No other fields are taken (additionalProperties: false).') : null,
      s ? h('details', { class: 'tools-details' }, h('summary', null, 'The schema as the server listed it'), h('pre', { class: 'tools-pre' }, JSON.stringify(s, null, 2))) : null);
  }

  // ── Request ──

  function pickTool(name, draw) {
    const L = P.listing;
    const t = L && L.tools ? L.tools.find((x) => x.name === name) : null;
    if (!t) return;
    P.tool = t;
    P.args = {};
    P.raw = {};
    // a field's default, as the schema gives it, fills it; nothing else is made up
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    for (const [k, p] of Object.entries(props)) if (p && p.default !== undefined && (typeof p.default !== 'object')) { P.args[k] = p.default; P.raw[k] = String(p.default); }
    P.check = null;
    renderForm();
    scheduleCheck(0);
    if (draw) {
      renderAll();
      // a tool picked by hand: its schema, drawn, at the top of its pane (only the pane scrolls)
      const body = P.el.schema.closest('.box-body');
      if (body) body.scrollTop = Math.max(0, P.el.schema.offsetTop - body.offsetTop - 4);
    }
  }

  function fieldInput(name, p, required) {
    const id = `tools-f-${name}`;
    const type = typeOf(p);
    let input;
    const set = (raw) => {
      P.raw[name] = raw;
      if (raw === '' || raw === undefined) delete P.args[name];
      else if (type === 'integer' || type === 'number') P.args[name] = Number(raw);
      else if (type === 'boolean') P.args[name] = raw === 'true';
      else if (type === 'object' || type === 'array' || type === 'any of' || type === 'any') { try { P.args[name] = JSON.parse(raw); } catch (e) { P.args[name] = raw; } }
      else P.args[name] = raw;
      scheduleCheck(250);
    };
    if (Array.isArray(p && p.enum)) {
      input = h('select', { id, name, 'data-field-input': name },
        required ? null : h('option', { value: '' }, '(not given)'),
        ...p.enum.map((v) => h('option', { value: String(v), selected: P.raw[name] === String(v) }, String(v))));
      if (required && P.raw[name] === undefined && p.enum.length) { /* a required enum starts unset: the check says so */ input.value = ''; }
      input.addEventListener('change', () => set(input.value));
    } else if (type === 'boolean') {
      input = h('select', { id, name, 'data-field-input': name }, h('option', { value: '' }, '(not given)'), h('option', { value: 'true', selected: P.raw[name] === 'true' }, 'true'), h('option', { value: 'false', selected: P.raw[name] === 'false' }, 'false'));
      input.addEventListener('change', () => set(input.value));
    } else if (type === 'integer' || type === 'number') {
      input = h('input', { id, name, type: 'number', step: type === 'integer' ? '1' : 'any', value: P.raw[name] ?? '', 'data-field-input': name });
      input.addEventListener('input', () => set(input.value));
    } else if (type === 'string') {
      input = h('input', { id, name, type: 'text', value: P.raw[name] ?? '', spellcheck: 'false', 'data-field-input': name });
      input.addEventListener('input', () => set(input.value));
    } else {
      input = h('textarea', { id, name, rows: '3', spellcheck: 'false', 'data-field-input': name, placeholder: 'JSON' }, P.raw[name] ?? '');
      input.addEventListener('input', () => set(input.value));
    }
    return h('div', { class: 'tools-field', 'data-field': name },
      h('label', { for: id }, h('code', null, name), h('span', { class: 'tools-small' }, ` ${type}${required ? ' · required' : ''}${rulesOf(p) ? ` · ${rulesOf(p)}` : ''}`)),
      input,
      p && p.description ? h('span', { class: 'tools-small' }, String(p.description)) : null,
      h('span', { class: 'tools-fielderr', 'data-field-error': name, role: 'status' }));
  }

  function renderForm() {
    const e = P.el;
    const t = P.tool;
    if (!t) {
      put(e.formHead, h('p', { class: 'empty' }, 'List a server\'s tools, then pick one: its request form is made from its input schema.'));
      put(e.form);
      return;
    }
    const s = t.inputSchema || {};
    const props = s.properties && typeof s.properties === 'object' ? Object.entries(s.properties) : [];
    put(e.formHead, h('p', { class: 'tools-sub' }, `REQUEST · tools/call ${t.name}`), t.description ? h('p', { class: 'tools-small' }, t.description) : null);
    put(e.form, ...(props.length ? props.map(([k, p]) => fieldInput(k, p, (s.required || []).includes(k))) : [h('p', { class: 'empty' }, 'This tool takes no fields: its arguments are {}.')]),
      h('p', { class: 'tools-fielderr', 'data-field-error': '(the arguments)', role: 'status' }));
  }

  function scheduleCheck(wait) {
    clearTimeout(P.checkTimer);
    P.checkTimer = setTimeout(() => { check(); }, wait);
  }

  async function check() {
    const t = P.tool;
    if (!t) return;
    const seq = ++P.checkSeq;
    P.checkBusy = true;
    const r = await api('check', { server: specOf(P.server), route: P.callRoute, tool: t.name, args: P.args, inputSchema: t.inputSchema, annotations: t.annotations });
    if (seq !== P.checkSeq) return; // a newer check is on its way
    P.checkBusy = false;
    P.check = r.status === 200 ? r.body : { valid: false, errors: [{ field: '(the arguments)', message: r.body.error || `HTTP ${r.status}` }], request: '', cli: { repl: {}, notes: [] }, rule: null, ruleFrom: '' };
    renderCheck();
    renderSteps();
    renderListCtl();
    renderGate();
  }

  function renderCheck() {
    const e = P.el;
    const c = P.check;
    for (const el of e.form.querySelectorAll('[data-field-error]')) el.textContent = '';
    for (const el of e.form.querySelectorAll('.tools-field')) el.classList.remove('is-invalid');
    if (c && c.errors) {
      for (const err of c.errors) {
        const slot = e.form.querySelector(`[data-field-error="${CSS.escape(err.field)}"]`) || e.form.querySelector('[data-field-error="(the arguments)"]');
        if (slot) slot.textContent = `${slot.textContent ? `${slot.textContent}; ` : ''}✕ ${err.field === '(the arguments)' ? '' : `${err.field} `}${err.message}`;
        const field = e.form.querySelector(`.tools-field[data-field="${CSS.escape(err.field)}"]`);
        if (field) field.classList.add('is-invalid');
      }
    }
    renderCallCtl();
    // no tool picked: no request and no lines yet (the form's head says what to do)
    if (!P.tool) { put(e.request); put(e.cli); return; }
    // the exact request this call sends (its id is the route's own: the wire shows the one sent)
    put(e.request,
      h('p', { class: 'tools-sub' }, 'JSON-RPC REQUEST · as the route sends it'),
      h('pre', { class: 'tools-pre', 'data-tools-request': '' }, c && c.request ? pretty(c.request) : 'Checking…'),
      h('p', { class: 'tools-small' }, 'Its id is the route\'s own; the call\'s wire trace shows the request exactly as it was sent.'));
    const cli = (c && c.cli) || { repl: {}, notes: [] };
    put(e.cli,
      h('p', { class: 'tools-sub' }, 'GENERATED CLI · THE SAME CALL, TO COPY'),
      cliLine('In Timmy\'s REPL, the SDK route', cli.repl && cli.repl.sdk, 'repl-sdk'),
      cliLine('In Timmy\'s REPL, the mcporter route', cli.repl && cli.repl.mcporter, 'repl-mcporter'),
      cliLine('MCPorter\'s own command line (what the mcporter route runs)', cli.mcporter, 'mcporter'),
      cliLine('Timmy\'s SDK command line (what the SDK route runs)', cli.sdk, 'sdk'),
      ...((cli.notes || []).map((n) => h('p', { class: 'tools-small' }, n))));
  }

  function renderCallCtl() {
    const e = P.el;
    const t = P.tool;
    const c = P.check;
    if (!t) { put(e.callCtl); return; }
    const { next } = stepState();
    const rule = c && c.rule;
    const waits = rule && rule.runs === false;
    const valid = Boolean(c && c.valid);
    const words = P.callBusy ? `Calling ${t.name} via ${routeName(P.callRoute)}…` : waits ? 'Copy the line for Timmy\'s terminal' : `Call ${t.name} via ${routeName(P.callRoute)}`;
    const primary = !P.callBusy && valid && next === 4;
    const btn = h('button', { type: 'button', class: `tools-go${primary ? ' is-primary' : ''}`, 'data-tools-action': waits ? 'copy-terminal' : 'call', disabled: P.callBusy || !valid, 'aria-describedby': 'tools-why' }, words);
    btn.addEventListener('click', () => (waits ? copyLine(rule.command, btn) : call()));
    put(e.callCtl,
      h('div', { class: 'row-10' }, h('span', { class: 'tools-small' }, 'tools/call through'), routeSwitch('call', P.callRoute, (id) => { P.callRoute = id; scheduleCheck(0); renderCallCtl(); })),
      h('p', { class: `tools-rule${waits && valid ? ' is-waiting' : ''}`, id: 'tools-why', 'data-tools-rule': !valid ? 'not-sendable' : rule ? (rule.runs ? 'runs' : 'needs-you') : 'later' },
        !c ? 'Checking the request…' : !valid ? `Not sendable yet: ${c.errors.length} ${c.errors.length === 1 ? 'thing' : 'things'} to fix above (checked with the MCP SDK's validator, on the companion).`
          : rule ? (rule.runs ? `Runs from this page: ${rule.why}.` : `NEEDS YOU: ${rule.why}. In Timmy's terminal: ${rule.command}`) : `The call reads the server's hints first: ${c.ruleFrom}.`),
      btn);
  }

  async function copyLine(text, btn, redraw) {
    try { if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard'); await navigator.clipboard.writeText(text); btn.textContent = 'Copied: run it in Timmy\'s terminal'; }
    catch (e) { btn.textContent = `Not copied (this browser would not): ${text}`; }
    setTimeout(() => (redraw || renderCallCtl)(), 4000);
  }

  async function call() {
    const t = P.tool;
    if (!t || P.callBusy) return;
    P.callBusy = true;
    renderCallCtl();
    const r = await api('call', { server: specOf(P.server), route: P.callRoute, tool: t.name, args: P.args });
    P.callBusy = false;
    if (r.status === 200) {
      P.result = { kind: 'call', call: r.body.call, rule: r.body.rule };
      P.observed.set(serverKey(P.server), { ok: true, route: r.body.call.route, at: r.body.call.endedAt, words: `tools/call ${r.body.call.tool} ${r.body.call.outcome}` });
      P.callsAt = 0;
      refreshCalls();
    } else if (r.status === 409) P.result = { kind: 'needs-you', answer: r.body, tool: t.name, route: P.callRoute };
    else if (r.status === 422) { P.result = { kind: 'schema', answer: r.body, tool: t.name }; P.check = Object.assign({}, P.check || {}, { valid: false, errors: r.body.errors }); renderCheck(); }
    else P.result = { kind: 'error', status: r.status, error: r.body.error || `HTTP ${r.status}`, listed: r.body.listed };
    renderAll();
  }

  // ── Wire & schema gate ──

  function renderWire() {
    const e = P.el;
    const call = P.result && P.result.kind === 'call' ? P.result.call : null;
    const W = call && call.wireView;
    if (!call) {
      put(e.graph, h('p', { class: 'tools-sub' }, 'JSON-RPC FLAME GRAPH · MEASURED BY TIMMY\'S WIRE TAP'), h('p', { class: 'empty' }, 'No call shown yet: a call made here, or one picked from the newest calls, draws its JSON-RPC requests here, each with its time.'));
      return;
    }
    if (!W || !W.spans.length) {
      put(e.graph, h('p', { class: 'tools-sub' }, 'JSON-RPC FLAME GRAPH'), h('p', { class: 'empty' }, `This call went through no wire tap (${call.transport === 'stdio' ? 'it was made outside this page, as /mcp call makes it' : 'the tap sits on stdio servers only'}), so no request of it was timed: the record keeps its total, ${msWords(call.ms)}.`));
      return;
    }
    const t0 = Date.parse(call.startedAt);
    const start = Number.isNaN(t0) ? W.t0 : Math.min(t0, W.t0);
    const end = Math.max(W.t1, ...W.spans.map((s) => s.end || s.start));
    const total = Math.max(1, end - start);
    const rowH = 18;
    // drawn at the pane's own width, so a unit is a pixel and the words keep their size (R7 H152: 11 px, B9; a floor of 360
    // drew a narrower pane's graph scaled down, its words under 11 px)
    const room = Math.max(240, Math.floor((e.graph.clientWidth || 640) - 4));
    const labelW = Math.min(230, Math.floor(room * 0.36));
    const width = room - labelW;
    const sessions = W.sessions.map((s) => s.session);
    const rows = [{ kind: 'call', label: `call via ${call.route} · ${msWords(call.ms)}`, from: start, to: start + call.ms }]
      .concat(...sessions.map((sid, i) => [
        { kind: 'session', label: `server ${i + 1}: ${sessions.length > 1 && i === 0 && call.route === 'mcporter' ? 'name check' : 'the call'}`, from: (W.sessions[i] && W.sessions[i].start) || start, to: (W.sessions[i] && W.sessions[i].end) || end },
        ...W.spans.filter((s) => s.session === sid).map((s) => ({ kind: s.method === 'tools/call' ? 'tools-call' : 'rpc', label: `${s.method}${s.ms === null ? ' · no answer' : ` · ${msWords(s.ms)}`}`, from: s.start, to: s.end || s.start, error: s.error })),
      ]));
    const g = svg('svg', { class: 'tools-flame', viewBox: `0 0 ${width + labelW} ${rows.length * rowH + 22}`, role: 'img', 'aria-label': `The call's JSON-RPC requests on one time line, ${msWords(total)} in all` });
    rows.forEach((r, i) => {
      const y = i * rowH + 2;
      const x = labelW + ((r.from - start) / total) * width;
      const w = Math.max(1.5, ((r.to - r.from) / total) * width);
      const text = svg('text', { x: 4, y: y + 12, class: `tools-flame-label is-${r.kind}` });
      text.textContent = r.label;
      g.append(text, svg('rect', { x: x.toFixed(2), y, width: w.toFixed(2), height: rowH - 5, rx: 2, class: `tools-flame-bar is-${r.kind}${r.error ? ' is-error' : ''}`, 'data-span': r.label }));
    });
    const axis = svg('text', { x: labelW, y: rows.length * rowH + 16, class: 'tools-flame-axis' });
    axis.textContent = `0 ms  ·  ${msWords(total)} from the call's start to its end, as measured`;
    g.append(axis);
    put(e.graph,
      h('p', { class: 'tools-sub' }, `JSON-RPC FLAME GRAPH · ${W.spans.length} REQUESTS · MEASURED BY TIMMY'S WIRE TAP`),
      g,
      h('ul', { class: 'tools-spans' }, ...W.spans.map((s) => h('li', { 'data-span-method': s.method }, `${s.method} (id ${s.id}) · ${s.ms === null ? 'no answer seen' : msWords(s.ms)} · ${bytesWords(s.bytesOut)} out, ${bytesWords(s.bytesIn)} back${s.error ? ' · a JSON-RPC error' : ''}`))),
      h('p', { class: 'tools-small' }, `Each bar runs from the request's line to the line that answers it, as they passed between ${routeName(call.route)} and the server. ${W.notifications.length ? `${W.notifications.length} notification${W.notifications.length === 1 ? '' : 's'} passed too (${[...new Set(W.notifications.map((n) => n.method))].join(', ')}).` : ''}${W.dropped ? ` ${W.dropped} frames past the tap's bound were not written.` : ''}`));
  }

  function renderGate() {
    const e = P.el;
    const L = P.listing && P.listing.key === serverKey(P.server) && P.listing.ok ? P.listing : null;
    const c = P.check;
    const ok = (text) => h('li', { class: 'is-verified' }, `✓ ${text}`);
    const bad = (text) => h('li', { class: 'tools-attn' }, `✕ ${text}`);
    const none = (text) => h('li', { class: 'tools-dim' }, `· ${text}`);
    const items = [];
    if (!L) items.push(none('the schema gate runs on a listing: list a server\'s tools'));
    else {
      const g = L.gate;
      const arrays = g.issues.filter((i) => /array without items/.test(i.issue)).length;
      const keywords = g.issues.filter((i) => /collides with a schema keyword/.test(i.issue)).length;
      const others = g.issues.length - arrays - keywords;
      items.push(g.checked ? ok(`${g.checked} tool schema${g.checked === 1 ? '' : 's'} read from the server's own list`) : bad('no tool schema was listed'));
      if (g.missing) items.push(bad(`${g.missing} tool${g.missing === 1 ? '' : 's'} listed without a schema (the list was cut to its bound)`));
      items.push(arrays ? bad(`${arrays} array${arrays === 1 ? '' : 's'} without items (a strict provider rejects them)`) : ok('0 arrays without items'));
      items.push(keywords ? bad(`${keywords} propert${keywords === 1 ? 'y' : 'ies'} named like a schema keyword`) : ok('0 properties named like a schema keyword'));
      items.push(others ? bad(`${others} other strict-schema issue${others === 1 ? '' : 's'} (oneOf, allOf, not, $ref, …)`) : ok('0 uses of oneOf, allOf, not, patternProperties or $ref'));
      items.push(g.collisions.length ? bad(`tool names listed twice: ${g.collisions.join(', ')}`) : ok('tool names: no collisions'));
    }
    if (P.tool) {
      if (!c) items.push(none(`${P.tool.name}'s request: checking`));
      else items.push(c.valid ? ok(`${P.tool.name}'s request matches its input schema (the MCP SDK's validator)`) : bad(`${P.tool.name}'s request does not match its input schema yet (${c.errors.length})`));
    }
    put(e.gate, h('p', { class: 'tools-sub' }, 'SCHEMA GATE · THE STRICT TOOL-SCHEMA RULE (lanes/schema/lane.mjs) AND THE REQUEST'), h('ul', { class: 'tools-checks' }, ...items));
  }

  // ── Result & receipt ──

  function itemView(it) {
    if (it.type === 'text') return h('pre', { class: 'tools-pre tools-text', 'data-item': 'text' }, it.text);
    if (it.type === 'json') return h('div', { 'data-item': 'json' }, it.label ? h('p', { class: 'tools-small' }, it.label) : null, h('pre', { class: 'tools-pre' }, JSON.stringify(it.value, null, 2)));
    if (it.type === 'image') {
      const img = h('img', { class: 'tools-img', alt: `An image from the server: ${it.mime}, ${bytesWords(it.bytes)}`, 'data-item': 'image' });
      img.setAttribute('src', `data:${it.mime};base64,${it.data}`);
      return h('figure', { class: 'tools-figure' }, img, h('figcaption', { class: 'tools-small' }, `${it.mime} · ${bytesWords(it.bytes)} · the server's own image, drawn as it sent it`));
    }
    return h('p', { class: 'tools-small', 'data-item': 'media' }, it.label);
  }

  function renderResult() {
    const e = P.el;
    const R = P.result;
    if (!R) { put(e.result, h('p', { class: 'empty' }, 'No call yet on this page. A call made here, or one picked from the newest calls below, shows here: its answer, its exact JSON-RPC answer, the route, its time, and the record and receipt Timmy keeps.')); return; }
    if (R.kind === 'needs-you') {
      const a = R.answer;
      put(e.result, h('div', { class: 'tools-needs', role: 'alert', 'data-tools-result': 'needs-you' },
        h('p', null, h('strong', null, 'NEEDS YOU'), ` · ${R.tool} via ${routeName(R.route)} was not called`),
        h('p', null, `${a.rule.why}. ${a.before || 'Nothing was called, and no record was written.'}`),
        h('p', { class: 'tools-small' }, 'In Timmy\'s terminal, where a typed /mcp call is your own command:'),
        h('button', { type: 'button', class: 'cmd', 'data-copy': a.rule.command }, a.rule.command)));
      return;
    }
    if (R.kind === 'schema') {
      put(e.result, h('div', { class: 'tools-refused', 'data-tools-result': 'schema' },
        h('p', null, h('strong', null, '✕ Not sent'), ` · ${R.answer.words}`),
        h('ul', { class: 'tools-checks' }, ...R.answer.errors.map((x) => h('li', { class: 'tools-attn' }, `✕ ${x.field}: ${x.message}`)))));
      return;
    }
    if (R.kind === 'error') {
      put(e.result, h('div', { class: 'tools-refused', 'data-tools-result': 'error' }, h('p', null, h('strong', null, '✕ Not called'), ` · ${R.error}`),
        R.listed ? h('p', { class: 'tools-small' }, `The server lists: ${R.listed.join(', ')}`) : null));
      return;
    }
    const c = R.call;
    const answered = c.outcome === 'answered';
    put(e.result,
      h('div', { class: 'tools-outcome', 'data-tools-result': 'call', 'data-call': c.id },
        h('p', { class: 'row-between' },
          h('span', null, answered ? h('span', { class: 'is-live' }, '● answered') : h('span', { class: 'tools-attn' }, `✕ ${c.outcome}${c.isError ? ' (the server said isError)' : ''}`), ` · ${c.tool} on ${c.server}`),
          h('span', { class: 'tools-small' }, `${clock(c.startedAt)} · ${msWords(c.ms)}`)),
        h('p', { class: 'tools-small', 'data-tools-route': c.route }, `route: ${routeName(c.route)}${c.fromPage ? ' · made from this page' : ' · made in Timmy\'s terminal or by its agent'}`),
        c.error ? h('pre', { class: 'tools-pre tools-attn' }, c.error) : null),
      // the record and its receipt, verified now (the reference's live verification), before the answer it keeps
      h('div', { class: 'tools-receipt', 'data-tools-receipt': c.receipt ? c.receipt.id : 'none', 'data-verified': c.receipt && c.receipt.verified ? 'yes' : 'no' },
        c.receipt
          ? (c.receipt.verified
            ? h('p', null, h('span', { class: 'is-verified' }, '✓ sealed and verified'), ` · receipt ${c.receipt.id} · #${c.receipt.seq} on the project's runs chain · ${clock(c.receipt.ts)}`)
            : h('p', { class: 'tools-attn' }, `✕ receipt ${c.receipt.id} does not verify: ${c.receipt.why || 'its check failed'}`))
          : h('p', { class: 'tools-attn' }, '✕ no mcp.call receipt of this project names this record'),
        h('p', { class: 'tools-small' }, `record ${c.record}${c.output ? ` · output ${c.output} (${c.outputCheck})` : ''}${c.wire ? ` · wire ${c.wire} (${c.wireCheck})` : ''}`),
        c.receipt && c.receipt.verified ? h('p', { class: 'tools-small' }, 'Checked now: its chain link and body hash, its signature, and that call.json is the bytes it sealed. A receipt proves what was kept, not that an answer is right.') : null),
      h('p', { class: 'tools-sub' }, c.answer.from === 'server' ? 'RESULT · THE SERVER\'S OWN ANSWER, AS THE WIRE TAP SAW IT' : c.answer.from === 'route' ? 'RESULT · AS THE ROUTE PRINTED IT' : 'RESULT'),
      ...(c.answer.items.length ? c.answer.items.map(itemView) : [h('p', { class: 'empty' }, 'No answer was read.')]),
      ...c.answer.notes.map((n) => h('p', { class: 'tools-small' }, n)),
      h('details', { class: 'tools-details', open: true }, h('summary', null, c.request.exact ? 'The JSON-RPC request, exactly as it was sent' : 'The JSON-RPC request (as the route sends it; no wire trace)'), h('pre', { class: 'tools-pre', 'data-sent-request': '' }, pretty(c.request.text))),
      c.response ? h('details', { class: 'tools-details' }, h('summary', null, 'The server\'s JSON-RPC answer, exactly as it came back'), h('pre', { class: 'tools-pre', 'data-raw-response': '' }, pretty(c.response))) : null,
      c.printed !== undefined ? h('details', { class: 'tools-details' }, h('summary', null, 'What the route printed (output.json)'), h('pre', { class: 'tools-pre' }, pretty(c.printed))) : null,
      c.notes.length ? h('details', { class: 'tools-details' }, h('summary', null, `The record's notes (${c.notes.length})`), h('ul', { class: 'tools-notes' }, ...c.notes.map((n) => h('li', null, n)))) : null);
  }

  // ── the newest calls ──

  function renderCalls() {
    const e = P.el;
    const rows = P.calls || [];
    if (!rows.length) { put(e.calls, h('p', { class: 'empty' }, 'No MCP call is kept in this project yet (.timmy/mcp/). A call made here, with /mcp call in the REPL, or by the agent\'s call_mcp_tool shows here.')); return; }
    const shown = P.result && P.result.kind === 'call' ? P.result.call.id : null;
    put(e.calls,
      h('table', { class: 'tools-callstable' },
        h('thead', null, h('tr', null, ...['when', 'tool', 'server', 'route', 'how it ended', 'time', 'receipt', 'made', ''].map((x) => h('th', null, x)))),
        h('tbody', null, ...rows.map((c) => {
          const open = h('button', { type: 'button', class: 'btn-action tiny', 'data-open-call': c.id, 'aria-pressed': shown === c.id ? 'true' : 'false' }, shown === c.id ? 'shown' : 'view');
          open.addEventListener('click', () => viewCall(c.id));
          return h('tr', { 'data-call-row': c.id, class: shown === c.id ? 'is-shown' : null },
            h('td', null, clock(c.startedAt)), h('td', null, h('code', null, c.tool)), h('td', { class: 'tools-break' }, c.server), h('td', null, c.route),
            h('td', null, c.outcome === 'answered' ? h('span', { class: 'is-live' }, '● answered') : h('span', { class: 'tools-attn' }, `✕ ${c.outcome}`)),
            h('td', null, msWords(c.ms)), h('td', null, receiptWords(c.receipt)), h('td', null, c.fromPage ? 'this page' : 'terminal'), h('td', null, open));
        }))),
      P.more ? h('p', { class: 'tools-small' }, `${P.more} older call${P.more === 1 ? '' : 's'} not listed here.`) : null);
  }

  async function viewCall(id) {
    const r = await api(`call/${encodeURIComponent(id)}`);
    if (r.status === 200) P.result = { kind: 'call', call: r.body.call };
    else P.result = { kind: 'error', status: r.status, error: r.body.error || `HTTP ${r.status}` };
    renderAll();
  }

  document.addEventListener('click', (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest('[data-tl-refresh]') : null;
    if (b && P.built && P.el.caps && P.el.caps.contains(b)) loadInventory(true);
  });

  function renderAll() {
    if (!P.built) return;
    if (P.stateError) { put(P.el.modes, h('p', { class: 'empty tools-attn' }, `The inspector could not read its state: ${P.stateError}`)); return; }
    renderSteps();
    renderModes();
    renderRoutes();
    renderServers();
    renderListCtl();
    renderTools();
    renderSchema();
    if (!P.tool) renderForm();
    renderCheck();
    renderWire();
    renderGate();
    renderResult();
    renderCalls();
    renderWhere();
    registerPage();
  }

  // a page named in "where tools work" opens through the shell (its page id), or the old shell's tab (the legacy id)
  document.addEventListener('click', (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest('[data-tools-go]') : null;
    if (!b) return;
    ev.preventDefault();
    const sh = typeof TimmyShell !== 'undefined' && TimmyShell && typeof TimmyShell.go === 'function' ? TimmyShell : null;
    const page = b.getAttribute('data-tools-go');
    const legacy = b.getAttribute('data-dest');
    if (sh) { try { sh.go(page, 'tools-where'); return; } catch (e) { /* the old shell knows the screens only */ } }
    const tab = document.querySelector(`#ws-tabs [data-ws-tab="${CSS.escape(legacy)}"]`);
    if (tab) tab.click();
  });

  TimmyPanels.register('tools', {
    draw(host, frame, ctx) {
      P.ctx = ctx;
      if (!ctx.own) {
        put(host, ctx.h('p', { class: 'empty' }, 'This page shows another project than the frame the companion gave, so the inspector waits for this project\'s own.'));
        P.built = false;
        return;
      }
      if (!P.built || P.host !== host || P.project !== ctx.project) {
        P.host = host;
        P.project = ctx.project;
        Object.assign(P, { listing: null, tool: null, check: null, result: null, observed: new Map(), server: { kind: 'fixture' }, mode: 'stdio', servers: null });
        build(host);
        renderAll();
        renderInventory();
        return Promise.all([loadState(), loadServers(), loadInventory(false)]);
      }
      return refreshCalls();
    },
  });
})();
