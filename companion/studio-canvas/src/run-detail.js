// R4 (H109): an operation's run detail in Timmy Canvas's side panel. The one run detail (src/contracts/run-detail.ts RunDetail) is
// made by Timmy (src/ops/run-detail.ts) and read here through GET /api/project/run-detail (src/studio/run-detail-route.ts), with
// this page's session (./cards.js runDetail): this page never computes one of its own. It shows the same fields the terminal
// Workbench and the companion show, each with the record it came from, and keeps apart what the operator asked to keep apart:
// the workflow stage, each process's own exit, Timmy's verdict, the artifact's freshness and a person's acceptance. Nothing is a
// percentage; a cost is the reported number, or unknown with why (never an invented 0). Every text is set as text.
//
// "Run detail" is offered on an operation's group in the Project panel (./project.js) and on every drawn card that names its
// operation (./cards.js). Until Timmy has the producer, the panel says so and gives the typed command (/op <id>).

/** One row: a label, its value in words, the record it came from (or null), and a command to type in Timmy (or null). */
const row = (label, value, from = null, command = null) => ({ label: String(label), value: String(value ?? ''), from: typeof from === 'string' && from ? from : null, command: typeof command === 'string' && command ? command : null });

/** A time in milliseconds, in words (never a percentage of anything). */
export function durationWords(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'not recorded';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

const list = (v) => (Array.isArray(v) ? v : []);

/**
 * A run detail as the side panel shows it: its sections, each a title and rows, the empty ones left out. `d` is a RunDetail as
 * Timmy sent it (its project's folder written as ".").
 */
export function runDetailSections(d) {
  const o = d && typeof d === 'object' ? d : {};
  const stage = o.stage || {};
  const verdict = o.verdict || {};
  const fresh = o.freshness || {};
  const acc = o.acceptance || {};
  const worker = o.worker || {};
  const time = o.time || {};
  const cost = o.cost || {};
  const total = typeof stage.total === 'number' ? `${stage.total}` : 'an unknown number of';
  const sections = [
    { title: 'Operation', rows: [
      row('operation', o.operation),
      row('project', o.project ? o.project.name : 'not named'),
      row('request', o.objective ? o.objective.value : 'not recorded', o.objective ? o.objective.from : null),
      row('source revision', o.sourceRevision ? o.sourceRevision.value : 'not recorded', o.sourceRevision ? o.sourceRevision.from : null),
      ...(o.parent ? [row('parent operation', o.parent)] : []),
      ...(list(o.children).length ? [row('child operations', list(o.children).join(', '))] : []),
    ] },
    // kept apart, as the operator asked: the verdict, the stage, each exit, the freshness and a person's acceptance
    { title: 'State, each kept apart', rows: [
      row('Timmy\'s verdict', `${verdict.state ?? 'unknown'}: ${verdict.words ?? ''}`.replace(/: $/, ''), verdict.from),
      row('workflow stage', `${stage.current ? `${stage.current} · ` : ''}${stage.done ?? 0} of ${total} steps done`, stage.from),
      ...list(o.exits).map((x) => row(`exit of ${x.who}`, `${x.code === null || x.code === undefined ? 'no exit code' : `exit ${x.code}`}${x.state ? ` (${x.state})` : ''}`, x.from)),
      row('artifact freshness', `${fresh.state ?? 'unknown'}${fresh.why ? `: ${fresh.why}` : ''}`, fresh.from),
      row('a person\'s acceptance', `${acc.state ?? 'not reviewed'}${acc.by ? ` by ${acc.by}` : ''}${acc.at ? ` at ${acc.at}` : ''}`, acc.from),
    ] },
    { title: 'Worker and time', rows: [
      ...['model', 'harness', 'environment'].map((k) => (worker[k] ? row(k, worker[k].value, worker[k].from) : row(k, 'not recorded'))),
      row('started', time.startedAt ?? 'not recorded'),
      row('ended', time.endedAt ?? (time.startedAt ? 'not ended' : 'not recorded')),
      row('time', durationWords(time.elapsedMs)),
    ] },
    { title: 'Prediction and checks', rows: [
      o.prediction ? row('prediction, frozen before the result', o.prediction.words, `receipt ${o.prediction.receipt}${o.prediction.frozenAt ? `, frozen at ${o.prediction.frozenAt}` : ''}`) : row('prediction', 'none recorded'),
      ...list(o.checks).map((c) => row(c.name, `${c.predicted !== null && c.predicted !== undefined ? `predicted ${c.predicted}; ` : ''}actual ${c.actual}${c.differs === true ? ' (differs)' : c.differs === false ? ' (as predicted)' : ''}`, c.from)),
    ] },
    { title: 'Files and receipts', rows: [
      ...list(o.files).map((f) => row(f.role, `${f.path}${f.sha256 ? ` · sha256 ${String(f.sha256).slice(0, 12)}` : ''}`, f.from)),
      ...list(o.receipts).map((r) => row('receipt', `${r.id} (${r.kind})${r.subject ? ` ${r.subject}` : ''}`)),
      row('summary', o.summary && o.summary.path ? o.summary.path : 'no summary saved beside the records'),
    ] },
    // a reported number, or unknown with why: never an invented 0
    { title: 'Cost', rows: [cost.measured === true && typeof cost.usd === 'number' ? row('cost', `$${cost.usd}`, cost.from) : row('cost', `unknown${cost.why ? `: ${cost.why}` : ''}`)] },
    { title: 'Next', rows: [o.next ? row('next', o.next.words, null, o.next.command ?? null) : row('next', 'none named')] },
    { title: 'Not known', rows: list(o.unknown).map((u) => row(u.field, u.why)) },
  ];
  return sections.filter((s) => s.rows.length > 0);
}

// ── the panel (the browser only) ─────────────────────────────────────────────

const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), text === undefined ? {} : { textContent: text }, props);

/** A time of day, as the panel says when it read the detail. */
const clock = (d) => { try { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return d.toISOString(); } };

/**
 * The side panel's Run detail (index.html #run-detail). `deps.read(op, projectId)` reads it through this page's session
 * (./cards.js runDetail): { status, ok, body }. It is read when asked (Run detail, Read again), and says when: it does not
 * change by itself.
 */
export function createRunDetailPanel(deps) {
  const root = document.getElementById('run-detail');
  const title = document.getElementById('run-detail-title');
  const readAt = document.getElementById('run-detail-read');
  const body = document.getElementById('run-detail-body');
  const close = document.getElementById('run-detail-close');
  const again = document.getElementById('run-detail-again');
  let asked = 0;
  let last = null;

  function render(d) {
    const parts = runDetailSections(d).map((s) => {
      const section = el('section', undefined, { className: 'rd-section' });
      const dl = el('dl', undefined, { className: 'rd-dl' });
      for (const r of s.rows) {
        const dd = el('dd');
        dd.append(el('span', r.value, { className: 'rd-value' }));
        if (r.command) dd.append(' ', el('code', r.command, { className: 'rd-cmd', title: 'Type this in Timmy' }));
        if (r.from) dd.append(el('span', `from ${r.from}`, { className: 'rd-from' }));
        dl.append(el('dt', r.label), dd);
      }
      section.append(el('h3', s.title), dl);
      return section;
    });
    body.replaceChildren(...parts);
  }

  /**
   * Shows operation `op`'s run detail, of project `projectId` when given (the card's own project: a board pinned to it, or a
   * card kept from a project the canvas showed before); else of the project the canvas shows.
   */
  async function show(op, projectId = null) {
    const n = ++asked;
    last = { op: String(op), projectId };
    root.hidden = false;
    root.dataset.op = String(op);
    root.dataset.state = 'reading';
    title.textContent = `Run detail · operation ${op}`;
    if (readAt) readAt.textContent = '';
    body.replaceChildren(el('p', 'Reading it from Timmy…', { className: 'rd-note' }));
    try { root.scrollIntoView({ block: 'nearest' }); } catch { /* shown either way */ }
    let r;
    try { r = await deps.read(String(op), projectId); } catch (e) { r = { status: 0, ok: false, body: { ok: false, error: `The run detail did not reach this page: ${e instanceof Error ? e.message : String(e)}` } }; }
    if (n !== asked) return;
    const b = (r && r.body) || {};
    const at = clock(new Date());
    if (r && r.ok && b.ok === true && b.detail) {
      root.dataset.state = 'shown';
      if (readAt) readAt.textContent = `Read from Timmy's records at ${at}. It does not change by itself: Read again reads it again.`;
      render(b.detail);
      return;
    }
    if (readAt) readAt.textContent = `Asked at ${at}.`;
    // not built yet (501: said plainly), refused or not read (in amber): Timmy's words, and the typed command that shows the
    // operation today
    const notBuilt = !!r && r.status === 501;
    root.dataset.state = notBuilt ? 'not-built' : 'refused';
    const said = el('p', String(b.error || `Timmy answered ${r ? r.status : 0} for the run detail.`), { className: notBuilt ? 'rd-note rd-said' : 'rd-note rd-said rd-refused' });
    body.replaceChildren(said, ...(typeof b.command === 'string' ? [el('p', undefined, { className: 'rd-note' })] : []));
    if (typeof b.command === 'string') body.lastChild.append('In Timmy: ', el('code', b.command, { className: 'rd-cmd', title: 'Type this in Timmy' }));
  }

  const hide = () => { root.hidden = true; asked += 1; };
  if (close) close.addEventListener('click', hide);
  if (again) again.addEventListener('click', () => { if (last) void show(last.op, last.projectId); });
  return { show, close: hide };
}
