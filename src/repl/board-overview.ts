/**
 * Round R4 (helper H78): God's Eye View on the board, the Overview section at the top of the snapshot (/board) and the
 * live board (/board live), drawn from the model src/overview builds from the same records as the board's other sections.
 *
 * One card per section, what needs you first: its counts (each saying what it counts), its most urgent item, and a few
 * items, each linked to the board section that already shows it (Control Room, Workflows, VoxVision, Results and review…)
 * or naming its typed command (a green command copies itself). Then one small map of the project (agents → workflows and
 * flows → the files they made), an SVG labelled "layout, not geometry": a position on it means nothing. Then the spatial
 * thumbnails, only highlights of real VoxVision records whose bytes their receipt names (on the live board loaded through
 * the token-protected /file route as blob: URLs, as VoxVision's own cards are), each labelled with the record it comes from
 * ("geometry from results/vox/<id>.json", or "image from …" for a picture's pixels). Advanced: the same model as JSON.
 *
 * Every string is escaped; no style attribute is written (the live page's Content-Security-Policy allows none) and the SVG
 * carries classes only, its colours in this module's stylesheet from Timmy Homebrew's tokens. Nothing here acts.
 *
 * R4 (H93): three more cards, Devices, Hosting and Costs. Each computer, remote job and order is a <details> the person
 * selects to open its detail in place: its record's words, its last probe or status read (with its time), and its commands
 * to copy (keyed with data-keep, so the live page keeps it open across redraws). Probing, stopping, reconciling and approving
 * contact a computer or the backend: they stay typed commands in this slice, and the detail says so. A link to an item
 * (from Needs you, or the map) goes to its detail, which the browser opens. The map's second band: remote jobs and orders,
 * and the computers and decisions they depend on. Times are absolute here: "how long ago" changes as the clock moves, so it
 * is in the terminal's views and the JSON only (overviewShape leaves `ago` out, as it leaves `as_of`).
 *
 * R4 (lead): a Fleets card after Costs, only in a project with a fleet plan (`timmy fleet`): each plan a <details> with its
 * backend (a simulation says so), workers and isolation in honest words, the counts kept apart, the workers to read first,
 * its results and record, and its commands to copy. Those commands and what waits on a person are drawn in the attention
 * colour (the next action), never green: a fleet's outcome is not a pass, and nothing it delivered is verified.
 */
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import { esc, stamp, type Kit } from './board-kit.js';
import {
  MAP_LABEL, OVERVIEW_SECTIONS,
  type BoardAnchor, type CostsSection, type DevicesSection, type FleetSection, type HostingSection, type Life, type Overview, type OverviewPartId,
  type OverviewSectionId, type OverviewSource, type SectionBase, type Tone,
} from '../overview/model.js';

/** The board section an anchor names, in words. */
const ANCHOR_WORDS: Readonly<Record<BoardAnchor, string>> = {
  room: 'Control Room', 'room-decisions': 'Waiting on you', 'room-running': 'Running now', 'room-tools': 'Tools and connections',
  workflows: 'Workflows', jobs: 'Jobs', flows: 'Flows', voxvision: 'VoxVision', review: 'Results and review', results: 'Results', memory: 'Memory', canvas: 'Canvas',
  'ov-devices': 'Devices', 'ov-hosting': 'Hosting', 'ov-costs': 'Costs', 'ov-fleet': 'Fleets',
};
/** Where each section's "see all" goes on the board (Devices, Hosting, Costs and Fleets hold their items themselves). */
const SECTION_ANCHOR: Readonly<Partial<Record<OverviewPartId, BoardAnchor>>> = {
  needs: 'room-decisions', agents: 'room', workflows: 'workflows', apps: 'review', spatial: 'voxvision', history: 'room', project: 'canvas',
};
/** R4 (H93): the cards as wide as the grid (their items open in place). R4 (lead): and Fleets. */
const WIDE: ReadonlySet<OverviewPartId> = new Set(['devices', 'hosting', 'fleet']);
const LIFE_WORD: Readonly<Record<Life, string>> = { running: 'running', left: 'left running', stale: 'stale', ended: 'ended', unknown: 'not proven' };
/** How many items a card lists on the board (the section commands list them all). */
const SHOWN = 4;

const go = (a: BoardAnchor | undefined): string => (a ? `<a class="ov-go" href="#${esc(a)}">${esc(ANCHOR_WORDS[a])}</a>` : '');
/** R4 (H93): the item details this board draws, so a link to one goes only where the page has it. */
let drawnDetails: ReadonlySet<string> = new Set();
/**
 * An item's way to its source: the board section that shows it (or, R4 H93, its own detail there when the board drew it),
 * and its command.
 */
const to = (s: OverviewSource, k: Kit): string => {
  const place = s.detail && s.board && drawnDetails.has(s.detail) ? `<a class="ov-go" href="#${esc(s.detail)}">${esc(ANCHOR_WORDS[s.board])}</a>` : go(s.board);
  return `<span class="ov-to">${place}${k.cmd(s.command)}</span>`;
};
const lifeWord = (l: Life, state: string): string => (l === 'ended' ? state : LIFE_WORD[l]);
const lifeClass = (l: Life): string => `ov-life-${l}`;
const toneClass = (t: Tone): string => `ov-tone-${t}`;

function item(text: string, s: OverviewSource, k: Kit, o: { cls?: string; detail?: string } = {}): string {
  return `<li class="${o.cls ?? ''}"><span class="ov-text">${esc(text)}</span>${o.detail ? ` <span class="ov-detail">${esc(o.detail)}</span>` : ''} ${to(s, k)}</li>`;
}
const more = (n: number, words: string): string => (n > 0 ? `<li class="more">${esc(`and ${n} more ${words}`)}</li>` : '');

/** One section's card: its counts, its most urgent item, a few items, what could not be read. */
function sectionCard(sec: SectionBase, items: string, k: Kit, live: boolean, canvasLine: boolean): string {
  const state = sec.state === 'read' ? '' : `<p class="ov-unknown">${esc(`${sec.state === 'unknown' ? 'unknown' : 'partly read'}: ${sec.why ?? 'not read'}`)}</p>`;
  const counts = sec.counts.length ? `<p class="ov-counts">${esc(sec.counts.map((c) => `${c.n} ${c.of}`).join(' · '))}</p>` : '';
  const urgent = sec.urgent ? `<p class="ov-urgent ${toneClass(sec.urgent.tone)}"><span class="ov-label">first</span> <span class="ov-text">${esc(sec.urgent.text)}</span> ${to(sec.urgent.source, k)}</p>` : '';
  const unreadable = sec.unreadable.length ? `<ul class="ov-unreadable">${sec.unreadable.slice(0, SHOWN).map((u) => `<li>${esc(`unknown: ${u.record} could not be read: ${u.why}`)}</li>`).join('')}${more(sec.unreadable.length - SHOWN, 'records that could not be read')}</ul>` : '';
  const when = live ? '' : `<p class="meta">${esc(`as of ${stamp(sec.as_of)}`)}</p>`;
  const all = SECTION_ANCHOR[sec.id];
  return `<article class="card ov-sec ov-${esc(sec.id)} ov-state-${esc(sec.state)}${WIDE.has(sec.id) ? ' ov-wide' : ''}" data-ov="${esc(sec.id)}">`
    + `<h3 id="ov-${esc(sec.id)}">${esc(sec.title)} <span class="count">${esc(sec.summary)}</span></h3>${when}${state}${counts}${urgent}${items}${unreadable}`
    + `${all && (all !== 'canvas' || canvasLine) ? `<p class="ov-all">${go(all)}</p>` : ''}</article>`;
}

// ── R4 (H93): devices, hosting and costs, each item opening its detail in place ──

/** A selectable item: its line as the summary; its record's words, last read and commands inside, opened in place. */
function selectable(id: string, key: string, summary: string, body: string, cls = ''): string {
  return `<details class="ov-sel ${cls}" data-keep="${esc(key)}"><summary>${summary}</summary><div class="ov-body" id="${esc(id)}">${body}</div></details>`;
}
const row = (label: string, value: string, cls = ''): string => `<dt>${esc(label)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(value)}</dd>`;
const CONTACT_NOTE = 'Probing, reading a job\'s status, stopping and fetching contact the computer: in this slice they stay typed commands in Timmy (copy one, type it there); the board has no button for them.';
const BACKEND_NOTE = 'Approving, reconciling and resolving are the backend\'s operator routes, sent by a person in this slice (copy the route); Timmy\'s client only reads: timmy cloud status.';

function devicesHtml(s: DevicesSection, k: Kit): string {
  const devices = s.items.map((d) => {
    const jobs = s.jobs.filter((j) => j.device === d.id);
    const probe = d.probe ? d.probe.line : 'not probed yet';
    const summary = `<span class="ov-text">${esc(d.id)}</span> <span class="ov-detail">${esc(`${d.reach.address}:${d.reach.port}`)}</span> <span class="ov-state${d.probe && !d.probe.answered ? ' ov-warn' : ''}">${esc(probe)}</span>${d.host_key.state !== 'confirmed' ? ` <span class="ov-state ov-warn">${esc(`host key ${d.host_key.state}`)}</span>` : ''}`;
    const body = `<dl class="ov-dl">${row('record', `${d.source.home ?? 'connect/devices.json'} in this computer's Timmy home`)}${row('name', d.name)}${row('reached', d.reach.words)}`
      + `${row('last probe', d.probe ? `${d.probe.line}: ${d.probe.words}` : 'not probed yet')}${row('system', d.system.words)}${row('PATH', d.found_words)}`
      + `${row('host key', d.host_key.words, d.host_key.state === 'confirmed' ? '' : 'ov-warn')}${d.needs.map((n) => row('needs', n, 'ov-warn')).join('')}${row('Connect says', d.words)}`
      + `${jobs.length ? `<dt>remote jobs</dt><dd>${jobs.map((j) => `<a class="ov-go" href="#${esc(j.source.detail ?? '')}">${esc(`${j.id}: ${j.state}`)}</a>`).join(' ')}</dd>` : ''}</dl>`
      + `${k.cmds(d.commands)}<p class="ov-note">${esc(CONTACT_NOTE)}</p>`;
    return selectable(d.source.detail ?? `ov-dev-${d.id}`, `overview:dev:${d.id}`, summary, body, 'ov-dev');
  }).join('');
  const jobs = s.jobs.map((j) => {
    const summary = `<span class="ov-text">${esc(`${j.id} on ${j.device}`)}</span> <span class="ov-state${['unknown', 'stop asked'].includes(j.state) ? ' ov-warn' : ''}">${esc(j.state)}</span> <span class="ov-detail">${esc(j.label)}</span>`;
    const body = `<dl class="ov-dl">${row('record', `${j.source.home ?? ''} in this computer's Timmy home`)}${row('state', j.words, ['unknown', 'stop asked'].includes(j.state) ? 'ov-warn' : '')}`
      + `${row('status read', j.read_at ? `${stamp(j.read_at)} (running is only what its status file said then)` : 'never read on the computer')}${row('submitted', stamp(j.submitted_at))}`
      + `${row('last seen', j.last_seen ? stamp(j.last_seen) : 'never')}${j.stop ? row('stop', `asked ${stamp(j.stop.asked_at)}${j.stop.confirmed_at ? `, confirmed ${stamp(j.stop.confirmed_at)}` : ', not confirmed'}`) : ''}`
      + `${row('fetched', `${j.fetched} file${j.fetched === 1 ? '' : 's'}`)}${row('depends on', j.device_known ? `the computer ${j.device}` : `${j.device}, not among the computers any more`)}</dl>`
      + `${k.cmds(j.commands)}<p class="ov-note">${esc(CONTACT_NOTE)}</p>`;
    return selectable(j.source.detail ?? `ov-job-${j.id}`, `overview:job:${j.id}`, summary, body, 'ov-job');
  }).join('');
  const more = [s.more ? `<p class="more">${esc(`and ${s.more} more computers: /connect devices lists them`)}</p>` : '', s.jobs_more ? `<p class="more">${esc(`and ${s.jobs_more} more remote jobs: /connect jobs lists them`)}</p>` : ''].join('');
  if (!devices && !jobs) return s.state === 'unknown' ? `<p class="ov-note">${esc(s.scope)}</p>` : `<p class="empty">${esc('No computers yet: /connect add <id> <user>@<address> --key <file>')}</p><p class="ov-note">${esc(s.scope)}</p>`;
  return `<p class="ov-note">${esc(s.scope)}</p>${devices ? `<div class="ov-list">${devices}</div>` : ''}${jobs ? `<p class="ov-sub">${esc('Remote jobs, as each was last read')}</p><div class="ov-list">${jobs}</div>` : ''}${more}`;
}

function hostingHtml(s: HostingSection, k: Kit): string {
  const head = `<p class="ov-line"><span class="ov-label">backend</span> ${esc(s.backend.words)}${s.backend.set_up ? '' : ` ${k.cmd(s.backend.command)}`}</p>`
    + (s.backend.set_up ? `<p class="ov-line${s.read.old || s.read.failed || !s.read.at ? ' ov-warn' : ''}"><span class="ov-label">read</span> ${esc(s.read.words)} ${k.cmd(s.read.command)}</p>` : '')
    + (s.provider ? `<p class="ov-line"><span class="ov-label">provider</span> ${esc(s.provider.words)}</p>` : '');
  const orders = s.items.map((o) => {
    const summary = `<span class="ov-text">${esc(o.name)}</span> <span class="ov-state${o.needs_person ? ' ov-warn' : ''}">${esc(o.summary)}</span>${o.simulated ? ' <span class="ov-tag">simulated</span>' : ''}`;
    const steps = `<ol class="ov-steps">${o.steps.map((st) => `<li class="ov-step ov-step-${esc(st.state)}"><b>${esc(st.label)}</b> <span class="ov-st">${esc(st.state.replace(/_/g, ' '))}</span> <span class="ov-detail">${esc(`${stamp(st.at)} · ${st.words}${st.provider_words ? ` (the provider: "${st.provider_words}")` : ''}`)}</span></li>`).join('')}</ol>`;
    const body = `${steps}<dl class="ov-dl">${row('order', `${o.order}${o.customer ? ` of ${o.customer}` : ''}${o.simulated ? ' (simulated provider)' : ''}`)}${o.needs_person ? row('needs', o.needs_person, 'ov-warn') : ''}`
      + `${o.cancel ? row('cancel', o.cancel.words) : ''}${row('next', o.next_action)}${row('cost', o.cost.words, o.cost.charged_cents === null ? 'ov-warn' : '')}`
      + `${o.resources.map((r) => row('made', `${r.kind} ${r.name}: ${r.state}${r.expires_at ? ` · registration ends ${stamp(r.expires_at)}` : ''}${r.retained_until ? ` · retained until ${stamp(r.retained_until)}` : ''}`)).join('')}`
      + `${row('record', `${o.source.home ?? 'cloud/overview.json'} in this computer's Timmy home, as the backend answered it`)}</dl>${k.cmds(o.commands)}<p class="ov-note">${esc(BACKEND_NOTE)}</p>`;
    return selectable(o.source.detail ?? `ov-order-${o.order}`, `overview:order:${o.order}`, summary, body, 'ov-order');
  }).join('');
  const more = s.more ? `<p class="more">${esc(`and ${s.more} more orders: timmy cloud status --json lists them`)}</p>` : '';
  return `${head}${orders ? `<div class="ov-list">${orders}</div>` : ''}${more}${s.backend.set_up ? `<p class="ov-note">${esc(BACKEND_NOTE)}</p>` : ''}`;
}

function costsHtml(s: CostsSection, k: Kit): string {
  const model = `<p class="ov-line"><span class="ov-label">model</span> ${esc(s.model.words || 'not known')} <span class="ov-detail">${esc(`(${s.model.scope})`)}</span> ${to({ record: null, command: '/room', board: 'room' }, k)}</p>`;
  const p = s.provider;
  const provider = `<p class="ov-line${p.known ? '' : ' ov-warn'}"><span class="ov-label">provider</span> ${esc(p.words)}${p.known && p.read_at ? ` <span class="ov-detail">${esc(`read ${stamp(p.read_at)}${p.old ? ', old' : ''}`)}</span>` : ''}</p>`;
  const customers = p.customers.map((c) => `<li${c.unknown_cost_orders ? ' class="ov-warn"' : ''}><span class="ov-text">${esc(`${c.customer} (${c.subscription})`)}</span> <span class="ov-detail">${esc(`${c.words} · limits: ${c.limits_words}`)}</span></li>`).join('');
  return `${model}${provider}${customers ? `<ul class="ov-items">${customers}${p.more ? `<li class="more">${esc(`and ${p.more} more customers: timmy cloud status lists them`)}</li>` : ''}</ul>` : ''}`;
}

const FLEET_NOTE = 'Running, stopping, reconciling and collecting are typed commands in Timmy (copy one, type it in a terminal in this project); the board has no button for them. Delivered is the runtime\'s word: nothing a fleet run delivers is verified by the run.';

/** R4 (lead): the project's fleet plans, each opening its detail in place; commands in the attention colour, never green. */
function fleetHtml(s: FleetSection, k: Kit): string {
  const plans = s.items.map((f) => {
    const summary = `<span class="ov-text">${esc(f.plan)}</span> <span class="ov-state${f.tone === 'attention' ? ' ov-warn' : f.tone === 'failed' ? ' ov-fail' : ''}">${esc(f.words.slice(f.plan.length + 1))}</span>${f.simulation ? ' <span class="ov-tag">simulation</span>' : ''}`;
    const workers = f.worker_lines.length
      ? `<dt>workers</dt><dd><ul class="ov-workers">${f.worker_lines.map((w) => `<li class="ov-w-${esc(w.phase)}">${esc(w.words)}</li>`).join('')}${f.workers_more ? `<li class="more">${esc(`and ${f.workers_more} more: timmy fleet status ${f.plan} lists them`)}</li>` : ''}</ul></dd>`
      : '';
    const body = `<dl class="ov-dl">${row('backend', `${f.backend} (${f.provider})${f.simulation ? ' · a simulation: no compute, no harness, no model' : ''}`)}`
      + `${row('workers', `${f.workers}, at most ${f.concurrency} at once · ${f.isolation_words}`)}${row('runs', `${f.harness} · ${f.model}`)}`
      + `${row('counts', f.counts_line)}${row('revision', `${f.revision} (the revision it was planned at)`)}${row('spend', f.spend_words)}${workers}`
      + `${f.results ? row('results', f.results) : ''}${f.needs.map((n) => row('needs', n, 'ov-warn')).join('')}`
      + `${row('record', `${f.source.record ?? ''} · operation ${f.operation} · planned ${stamp(f.created_at)}, read ${stamp(f.updated_at)}`)}</dl>`
      + `<div class="cmds ov-next">${f.commands.map((c) => k.cmd(c)).join('')}</div><p class="ov-note">${esc(FLEET_NOTE)}</p>`;
    return selectable(f.source.detail ?? `ov-fleet-${f.plan}`, `overview:fleet:${f.plan}`, summary, body, 'ov-fleet-plan');
  }).join('');
  const more = s.more ? `<p class="more">${esc(`and ${s.more} more plans: timmy fleet status lists them`)}</p>` : '';
  const notes = s.notes.map((n) => `<p class="ov-note">${esc(n)}</p>`).join('');
  return `${plans ? `<div class="ov-list">${plans}</div>` : ''}${more}${notes}`;
}

function itemsOf(o: Overview, id: OverviewSectionId, k: Kit, canvasLine: boolean): string {
  switch (id) {
    // R4 (H93)
    case 'devices': return devicesHtml(o.devices, k);
    case 'hosting': return hostingHtml(o.hosting, k);
    case 'costs': return costsHtml(o.costs, k);
    case 'needs': {
      const s = o.needs;
      if (!s.items.length) return s.state === 'unknown' ? '' : '<p class="empty">Nothing waits on you.</p>';
      return `<ul class="ov-items">${s.items.slice(0, SHOWN).map((i) => item(i.title, i.source, k, { cls: i.blocks ? 'ov-blocks' : '', detail: i.needed })).join('')}${more(s.items.length - SHOWN + s.more, 'waiting')}</ul>`;
    }
    case 'agents': {
      const s = o.agents;
      if (!s.items.length) return s.state === 'unknown' ? '' : '<p class="empty">No agent, flow or chat run recorded here yet.</p>';
      return `<ul class="ov-items">${s.items.slice(0, SHOWN).map((a) => item(`${a.owner} ${a.id}: ${lifeWord(a.life, a.state)}`, a.source, k, {
        cls: lifeClass(a.life),
        detail: [a.assignment ? `asked: ${a.assignment.text}` : 'asked: not recorded', a.model ? `model ${a.model}` : '', a.cost ? a.cost.words : a.cost_none ? `no cost recorded: ${a.cost_none}` : '', a.life_why && a.life !== 'ended' && a.life !== 'running' ? a.life_why : ''].filter(Boolean).join(' · '),
      })).join('')}${more(s.items.length - SHOWN + s.more, 'runs')}</ul>`;
    }
    case 'workflows': {
      const s = o.workflows;
      const docs = s.items.slice(0, SHOWN).map((w) => item(`${w.doc}${w.title ? ` (${w.title})` : ''}: ${w.last_run ? `${w.last_run.target} ${lifeWord(w.last_run.life, w.last_run.word)}` : 'not run yet'}`, w.source, k, {
        cls: w.blockers.length ? 'ov-blocked' : '',
        detail: [w.last_run ? w.last_run.blocks.map((b) => `${b.name} ${b.word}`).join(' → ') : w.blocks.map((b) => b.name).join(', '), ...w.blockers.map((b) => `blocker ${b.block}: ${b.why}`)].filter(Boolean).join(' · '),
      })).join('');
      const jobs = s.jobs.filter((j) => j.life !== 'ended').slice(0, 2).map((j) => item(`job ${j.id}: ${LIFE_WORD[j.life]}`, j.source, k, { cls: lifeClass(j.life), detail: [j.label, j.life_why ?? ''].filter(Boolean).join(' · ') })).join('');
      if (!docs && !jobs) return s.state === 'unknown' ? '' : '<p class="empty">No workflow document yet.</p>';
      return `<ul class="ov-items">${docs}${jobs}${more(s.items.length - SHOWN + s.more, 'documents')}</ul>`;
    }
    case 'apps': {
      const s = o.apps;
      const runs = s.runs.slice(0, 2).map((r) => item(`${r.app}: ${lifeWord(r.life, r.state)}`, r.source, k, { cls: `${lifeClass(r.life)} ${toneClass(r.tone)}` })).join('');
      const files = s.artifacts.slice(0, 3).map((a) => item(a.path, a.source, k, { cls: `ov-art-${a.kind}`, detail: `${a.kind}${a.editor ? `, ${a.editor}` : ''} · by ${a.by}` })).join('');
      const results = s.results.slice(0, 2).map((r) => item(`${r.operation}: ${r.changes} changed`, r.source, k, { detail: r.request })).join('');
      if (!runs && !files && !results) return s.state === 'unknown' ? '' : '<p class="empty">No app run, file or result recorded here yet.</p>';
      return `<ul class="ov-items">${runs}${files}${results}${more(s.runs.length - 2 + s.runs_more, 'app runs')}${more(s.artifacts.length - 3 + s.artifacts_more, 'files')}${more(s.results.length - 2 + s.results_more, 'operations with changes')}</ul>`;
    }
    case 'spatial': {
      const s = o.spatial;
      if (!s.items.length) return s.state === 'unknown' ? '' : '<p class="empty">No VoxVision record yet.</p>';
      return `<ul class="ov-items">${s.items.slice(0, SHOWN).map((v) => item(`${v.action} ${v.inputs.map((i) => i.path).join(' and ')}: ${v.check}`, v.source, k, {
        cls: `ov-check-${v.check}`,
        detail: v.metrics.slice(0, 3).map((m) => `${m.title} ${m.value} (${m.word})`).join(' · '),
      })).join('')}${more(s.items.length - SHOWN + s.more, 'records')}</ul>`;
    }
    case 'history': {
      const s = o.history;
      const head = s.head ? item(`chain head ${s.head.id}: ${s.head.verified ? 'verified' : 'not verified'}`, s.head.source, k, { cls: s.head.verified ? '' : 'ov-tone-failed', detail: s.head.words })
        : s.receipts.known ? '<li class="empty">no receipts yet: nothing to verify</li>' : `<li class="ov-life-unknown"><span class="ov-text">${esc(`receipts: unknown: ${s.receipts.why ?? 'not read'}`)}</span></li>`;
      const costs = `<li><span class="ov-text">costs</span> <span class="ov-detail">${esc(s.costs.words || 'not known')}</span> ${to({ record: null, command: '/room', board: 'room' }, k)}</li>`;
      const recent = s.receipts.recent.slice(0, 2).map((r) => item(`receipt ${r.id} (${r.kind}${r.status ? `, ${r.status}` : ''})`, r.source, k, { detail: stamp(r.ts) })).join('');
      return `<ul class="ov-items">${head}${costs}${recent}${more(s.receipts.project - s.receipts.recent.slice(0, 2).length, 'receipts of this project')}</ul>`;
    }
    case 'project': {
      const s = o.project;
      // The canvas's words are the card's first line when it does not show this project; else its own line here.
      return `<ul class="ov-items"><li><span class="ov-text">${esc(`changed ${stamp(s.changed.at ?? undefined)}`)}</span> <span class="ov-detail">${esc(s.changed.basis)}</span></li>`
        + `${s.urgent ? '' : `<li><span class="ov-text">${esc(`Timmy Canvas: ${s.canvas.state}`)}</span> <span class="ov-detail">${esc(s.canvas.words)}</span>${s.canvas.command ? ` ${to({ record: null, command: s.canvas.command, ...(canvasLine ? { board: 'canvas' as const } : {}) }, k)}` : ''}</li>`}</ul>`;
    }
  }
}

// ── the map ───────────────────────────────────────────────────────────────────

const MAP = { w: 660, colX: [8, 236, 464], nodeW: 188, nodeH: 28, gap: 10, top: 34 } as const;
const cutLabel = (s: string, n = 27): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join('')}…` : s);

/**
 * The abstract map as SVG: classes only (the stylesheet colours it), every text escaped, labelled "layout, not geometry".
 * R4 (H93): the columns after the first three (remote jobs and orders, what they depend on) are a second band below.
 */
export function mapSvg(o: Overview): string {
  const cols = o.map.columns;
  const bands = [cols.slice(0, 3), cols.slice(3)].filter((band, b) => b === 0 || band.some((c) => c.nodes.length));
  const at = new Map<string, { x: number; y: number }>();
  const parts: string[] = [];
  let off = 0;
  bands.forEach((band, b) => {
    const rows = Math.max(1, ...band.map((c) => c.nodes.length + (c.more ? 1 : 0)));
    if (b > 0) parts.push(`<line class="ov-band" x1="8" y1="${off - 6}" x2="${MAP.w - 8}" y2="${off - 6}"></line>`);
    band.forEach((c, i) => {
      const x = MAP.colX[i] ?? 8;
      parts.push(`<text class="ov-col" x="${x}" y="${off + 20}">${esc(c.title)}</text>`);
      c.nodes.forEach((n, j) => {
        const y = off + MAP.top + j * (MAP.nodeH + MAP.gap);
        at.set(n.id, { x, y });
        const said = `${n.kind}${n.life && n.life !== 'ended' ? `, ${LIFE_WORD[n.life]}` : ''}${n.state ? `, ${n.state}` : ''}`;
        parts.push(`<g class="ov-node ov-k-${esc(n.kind.replace(/[^a-z]+/gi, '-'))}${n.life ? ` ${lifeClass(n.life)}` : ''}"><title>${esc(`${n.label} (${said}): ${n.source.command}`)}</title>`
          + `<rect x="${x}" y="${y}" width="${MAP.nodeW}" height="${MAP.nodeH}" rx="6"></rect><text x="${x + 8}" y="${y + 18}">${esc(cutLabel(n.label))}</text></g>`);
      });
      if (c.more) parts.push(`<text class="ov-more" x="${x + 8}" y="${off + MAP.top + c.nodes.length * (MAP.nodeH + MAP.gap) + 16}">${esc(`and ${c.more} more`)}</text>`);
    });
    off += MAP.top + rows * (MAP.nodeH + MAP.gap) + 4 + (b < bands.length - 1 ? 16 : 0);
  });
  const h = off;
  const lines = o.map.edges.flatMap((e) => {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) return [];
    return [`<line class="ov-edge" x1="${a.x + MAP.nodeW}" y1="${a.y + MAP.nodeH / 2}" x2="${b.x}" y2="${b.y + MAP.nodeH / 2}"><title>${esc(e.why)}</title></line>`];
  });
  return `<svg class="ov-map-svg" viewBox="0 0 ${MAP.w} ${h}" width="${MAP.w}" height="${h}" role="img" aria-label="${esc(`${MAP_LABEL}: ${o.map.words}`)}">`
    + `<title>${esc(`${MAP_LABEL}: ${o.map.words}`)}</title>${lines.join('')}${parts.join('')}</svg>`;
}

/** Spatial thumbnails: shown highlights of real VoxVision records only, each labelled with its record. */
function thumbsHtml(o: Overview, k: Kit, base: string): string {
  const shown = o.spatial.items.flatMap((v) => v.highlights.filter((h) => h.shown && /\.(png|svg)$/i.test(h.path)).map((h) => ({ v, h }))).slice(0, 4);
  if (!shown.length) return '';
  const href = (rel: string): string => esc((/^(?:\.\.\/)*$/.test(base) ? base : '') + rel.split('/').map(encodeURIComponent).join('/'));
  const figs = shown.map(({ v, h }) => {
    const alt = `${h.type ?? 'highlight'}: ${h.label}`;
    const img = k.live ? `<img data-vox-src="${esc(h.path)}" alt="${esc(alt)}">` : `<a href="${href(h.path)}"><img src="${href(h.path)}" alt="${esc(alt)}" loading="lazy"></a>`;
    return `<figure class="ov-thumb ov-from-${h.from}">${img}<figcaption><strong>${esc(h.label)}</strong> ${esc([h.type ?? 'highlight', h.word ?? '', v.check].filter(Boolean).join(' · '))}</figcaption></figure>`;
  }).join('');
  return `<div class="ov-thumbs" aria-label="${esc('spatial thumbnails from VoxVision records')}">${figs}</div>`;
}

/** The Overview section: its table-of-contents link and its HTML. */
export function overviewSection(o: Overview, k: Kit, base = '', opts: { canvasLine?: boolean } = {}): { toc: string; html: string } {
  const waiting = o.needs.total;
  const canvasLine = opts.canvasLine === true; // the board's line about Timmy Canvas (#canvas), drawn only when the REPL checked it
  // R4 (H93): the details this board draws (each computer, remote job and order the cards list), for the links to them
  drawnDetails = new Set([...o.devices.items, ...o.devices.jobs, ...o.hosting.items, ...(o.fleet?.items ?? [])].flatMap((i) => (i.source.detail ? [i.source.detail] : [])));
  // R4 (H99, r24 gap 11): the Needs card's list starts with its most urgent item, so its "first" line would say it twice
  const needsOnce = (): SectionBase => { const { urgent: _first, ...rest } = o.needs; return rest; };
  const card = (id: OverviewSectionId): string => sectionCard(id === 'needs' && o.needs.items.length && o.needs.urgent?.text === o.needs.items[0].title ? needsOnce() : o[id], itemsOf(o, id, k, canvasLine), k, k.live, canvasLine);
  // R4 (lead): the Fleets card after Costs, only when the project has a fleet plan
  const cards = OVERVIEW_SECTIONS.map((id) => `${id === 'project' && o.fleet ? sectionCard(o.fleet, fleetHtml(o.fleet, k), k, k.live, canvasLine) : ''}${card(id)}`).join('');
  const map = `<figure class="ov-map"><figcaption><strong>${esc(MAP_LABEL)}</strong> ${esc(o.map.words)}</figcaption>${o.map.columns.length ? mapSvg(o) : `<p class="ov-unknown">${esc(o.map.words)}</p>`}</figure>`;
  const when = k.live ? 'read with this board\'s state (the line above says when)' : `as of ${stamp(o.as_of)}`;
  return {
    // R4 (H107; r25 D8): the contents name the section as its heading does (they said "Overview")
    toc: `<a href="#overview">God's Eye View <b>${esc(waiting ? `${waiting} waiting on you` : 'nothing waits')}</b></a>`,
    html: [
      `<h2 id="overview">God's Eye View <span class="count">${esc(waiting ? `${waiting} waiting on you` : 'nothing waits on you')}</span></h2>`,
      '<section class="overview">',
      `<p class="ov-lead">${esc('The project at a glance, from the same records as the Control Room, Workflows, VoxVision, Results and Memory below, and this computer\'s own computers (Timmy Connect) and hosting (Timmy Cloud\'s backend, as last read). Each line links to the section that shows it, or names its command; a computer, a remote job or an order opens its detail when selected; nothing here acts.')}</p>`,
      `<p class="meta">${esc(when)}</p>`,
      `<div class="ov-grid">${cards}</div>`,
      map,
      thumbsHtml(o, k, base),
      `<details class="ov-adv" data-keep="overview:advanced"><summary>${esc('advanced: the same model as JSON')}</summary><p class="meta">${esc('In Timmy: /overview --json (timmy act \'/overview --json\' --json carries it in its "lines"). On this live board: GET /overview with the board\'s token, as /state. Notes: ')}${esc(o.notes.join(' '))}</p></details>`,
      '</section>',
    ].join(''),
  };
}

/**
 * The model without its times, for the live board's shape: the page redraws only when something but the time changed.
 * R4 (H93): `ago` ("12 min ago") too, which changes as the clock moves; the board shows absolute times only.
 */
export function overviewShape(o: Overview): unknown {
  return JSON.parse(JSON.stringify(o, (key, value) => (key === 'as_of' || key === 'ago' ? undefined : value)));
}

export const OVERVIEW_CSS = `
.overview { margin: 0 0 18px; }
.overview .ov-lead { margin: 0 0 4px; }
.ov-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin: 10px 0 12px; }
.card.ov-sec { gap: 6px; border-left: 3px solid ${HOMEBREW.lineStrong}; align-self: start; }
.card.ov-sec h3 { margin: 0; font-size: ${TYPE.size.h2}px; }
.card.ov-sec h3 .count { font-weight: ${TYPE.weight.body}; color: ${HOMEBREW.textSecondary}; }
.card.ov-needs { border-left-color: ${HOMEBREW.attention}; }
.ov-state-unknown, .ov-state-partial { border-left-style: dashed; }
.ov-unknown { margin: 0; color: ${HOMEBREW.attention}; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.ov-counts { margin: 0; color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.ov-urgent { margin: 0; overflow-wrap: anywhere; color: ${HOMEBREW.text}; }
.ov-urgent .ov-label { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; color: ${HOMEBREW.textSecondary}; margin-right: 4px; }
.ov-tone-attention .ov-text, li.ov-life-left .ov-text, li.ov-life-stale .ov-text, li.ov-life-unknown .ov-text, li.ov-check-stale .ov-text, li.ov-check-unverified .ov-text { color: ${HOMEBREW.attention}; }
.ov-tone-failed .ov-text, li.ov-blocked .ov-text, li.ov-blocks .ov-text { color: ${HOMEBREW.failure}; }
.ov-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; font-size: ${TYPE.size.small}px; }
.ov-items li { overflow-wrap: anywhere; }
.ov-items .ov-detail { color: ${HOMEBREW.textSecondary}; }
.ov-items li.more, .ov-items li.empty { color: ${HOMEBREW.textSecondary}; }
.ov-to { display: inline-flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; margin-left: 4px; }
a.ov-go { color: ${HOMEBREW.link}; }
.ov-all { margin: 2px 0 0; font-size: ${TYPE.size.small}px; }
.ov-unreadable { margin: 0; padding-left: 18px; color: ${HOMEBREW.attention}; font-size: ${TYPE.size.small}px; }
.ov-map { margin: 6px 0 12px; background: ${HOMEBREW.surface}; border: 1px dashed ${HOMEBREW.lineStrong}; border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.ov-map figcaption { font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; margin: 0 0 6px; }
.ov-map figcaption strong { text-transform: uppercase; letter-spacing: .06em; color: ${HOMEBREW.attention}; margin-right: 6px; }
.ov-map-svg { display: block; max-width: 100%; height: auto; font-family: ${TYPE.stack}; font-size: 11px; }
.ov-map-svg .ov-col { fill: ${HOMEBREW.textSecondary}; text-transform: uppercase; letter-spacing: .06em; }
.ov-map-svg .ov-node rect { fill: ${HOMEBREW.raised}; stroke: ${HOMEBREW.lineStrong}; stroke-width: 1; }
.ov-map-svg .ov-node text { fill: ${HOMEBREW.text}; }
.ov-map-svg .ov-life-running rect, .ov-map-svg .ov-life-left rect, .ov-map-svg .ov-life-stale rect, .ov-map-svg .ov-life-unknown rect { stroke: ${HOMEBREW.attention}; }
.ov-map-svg .ov-more { fill: ${HOMEBREW.textSecondary}; }
.ov-map-svg .ov-edge { stroke: ${HOMEBREW.line}; stroke-width: 1.5; }
.ov-thumbs { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 12px; }
.ov-thumb { margin: 0; max-width: 220px; }
.ov-thumb img { display: block; max-width: 220px; max-height: 160px; background: ${HOMEBREW.surface}; border: 1px solid ${HOMEBREW.line}; border-radius: 6px; }
.ov-thumb figcaption { font-size: 11.5px; color: ${HOMEBREW.textSecondary}; overflow-wrap: anywhere; }
.ov-thumb figcaption strong { color: ${HOMEBREW.text}; font-weight: ${TYPE.weight.strong}; }
.ov-adv summary { cursor: pointer; color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; }
.card.ov-sec.ov-wide { grid-column: 1 / -1; }
.ov-list { display: flex; flex-direction: column; font-size: ${TYPE.size.small}px; }
.ov-sel { border-top: 1px solid ${HOMEBREW.line}; padding: 4px 0; }
.ov-sel > summary { cursor: pointer; overflow-wrap: anywhere; }
.ov-sel > summary:focus-visible { outline: 2px solid ${HOMEBREW.accent}; outline-offset: 2px; }
.ov-sel > summary .ov-text { color: ${HOMEBREW.text}; }
.ov-sel[open] > summary .ov-text { font-weight: ${TYPE.weight.strong}; }
.ov-sel .ov-detail, .ov-line .ov-detail { color: ${HOMEBREW.textSecondary}; }
.ov-state { color: ${HOMEBREW.text}; }
.ov-warn, .ov-state.ov-warn, dd.ov-warn, li.ov-warn .ov-text { color: ${HOMEBREW.attention}; }
.ov-body { margin: 4px 0 6px 18px; }
.ov-dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 4px 0; }
.ov-dl dt { color: ${HOMEBREW.textSecondary}; }
.ov-dl dd { margin: 0; overflow-wrap: anywhere; }
.ov-steps { list-style: none; margin: 4px 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ov-step b { display: inline-block; min-width: 96px; font-weight: ${TYPE.weight.body}; color: ${HOMEBREW.textSecondary}; }
.ov-step .ov-st { color: ${HOMEBREW.text}; }
.ov-step-waiting .ov-st, .ov-step-unknown .ov-st, .ov-step-pending .ov-st, .ov-step-in_flight .ov-st { color: ${HOMEBREW.attention}; }
.ov-step-failed .ov-st, .ov-step-refused .ov-st { color: ${HOMEBREW.failure}; }
.ov-tag { border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 4px; padding: 0 4px; font-size: 11px; color: ${HOMEBREW.text}; }
.ov-note { margin: 4px 0 0; color: ${HOMEBREW.textSecondary}; font-size: 11.5px; overflow-wrap: anywhere; }
.ov-sub { margin: 6px 0 0; color: ${HOMEBREW.textSecondary}; font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; }
.ov-line { margin: 0; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.ov-line .ov-label { display: inline-block; min-width: 72px; color: ${HOMEBREW.textSecondary}; }
.ov-map-svg .ov-band { stroke: ${HOMEBREW.line}; stroke-width: 1; stroke-dasharray: 4 4; }
.ov-map-svg .ov-k-device rect, .ov-map-svg .ov-k-decision rect { stroke-dasharray: 3 2; }
.card.ov-fleet .cmd, .card.ov-fleet .ov-next .cmd { color: ${HOMEBREW.attention}; }
.card.ov-fleet .cmd:hover, .card.ov-fleet .cmd:focus-visible { border-color: ${HOMEBREW.attention}; }
.card.ov-fleet .ov-sel > summary:focus-visible { outline-color: ${HOMEBREW.attention}; }
.ov-fail, .ov-state.ov-fail { color: ${HOMEBREW.failure}; }
.ov-workers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ov-workers li.ov-w-unknown { color: ${HOMEBREW.attention}; }
.ov-workers li.ov-w-failed, .ov-workers li.ov-w-expired, .ov-workers li.ov-w-interrupted, .ov-workers li.ov-w-refused { color: ${HOMEBREW.failure}; }
.ov-workers li.more { color: ${HOMEBREW.textSecondary}; }
`;
