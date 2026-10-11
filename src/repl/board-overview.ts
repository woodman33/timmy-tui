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
 */
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import { esc, stamp, type Kit } from './board-kit.js';
import {
  MAP_LABEL, OVERVIEW_SECTIONS,
  type BoardAnchor, type Life, type Overview, type OverviewSectionId, type OverviewSource, type SectionBase, type Tone,
} from '../overview/model.js';

/** The board section an anchor names, in words. */
const ANCHOR_WORDS: Readonly<Record<BoardAnchor, string>> = {
  room: 'Control Room', 'room-decisions': 'Waiting on you', 'room-running': 'Running now', 'room-tools': 'Tools and connections',
  workflows: 'Workflows', jobs: 'Jobs', flows: 'Flows', voxvision: 'VoxVision', review: 'Results and review', results: 'Results', memory: 'Memory', canvas: 'Canvas',
};
/** Where each section's "see all" goes on the board. */
const SECTION_ANCHOR: Readonly<Record<OverviewSectionId, BoardAnchor>> = {
  needs: 'room-decisions', agents: 'room', workflows: 'workflows', apps: 'review', spatial: 'voxvision', history: 'room', project: 'canvas',
};
const LIFE_WORD: Readonly<Record<Life, string>> = { running: 'running', left: 'left running', stale: 'stale', ended: 'ended', unknown: 'not proven' };
/** How many items a card lists on the board (the section commands list them all). */
const SHOWN = 4;

const go = (a: BoardAnchor | undefined): string => (a ? `<a class="ov-go" href="#${esc(a)}">${esc(ANCHOR_WORDS[a])}</a>` : '');
/** An item's way to its source: the board section that shows it, and its command. */
const to = (s: OverviewSource, k: Kit): string => `<span class="ov-to">${go(s.board)}${k.cmd(s.command)}</span>`;
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
  return `<article class="card ov-sec ov-${esc(sec.id)} ov-state-${esc(sec.state)}" data-ov="${esc(sec.id)}">`
    + `<h3 id="ov-${esc(sec.id)}">${esc(sec.title)} <span class="count">${esc(sec.summary)}</span></h3>${when}${state}${counts}${urgent}${items}${unreadable}`
    + `${SECTION_ANCHOR[sec.id] !== 'canvas' || canvasLine ? `<p class="ov-all">${go(SECTION_ANCHOR[sec.id])}</p>` : ''}</article>`;
}

function itemsOf(o: Overview, id: OverviewSectionId, k: Kit, canvasLine: boolean): string {
  switch (id) {
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

/** The abstract map as SVG: classes only (the stylesheet colours it), every text escaped, labelled "layout, not geometry". */
export function mapSvg(o: Overview): string {
  const cols = o.map.columns;
  const rows = Math.max(1, ...cols.map((c) => c.nodes.length + (c.more ? 1 : 0)));
  const h = MAP.top + rows * (MAP.nodeH + MAP.gap) + 4;
  const at = new Map<string, { x: number; y: number }>();
  const parts: string[] = [];
  cols.forEach((c, i) => {
    const x = MAP.colX[i] ?? 8;
    parts.push(`<text class="ov-col" x="${x}" y="20">${esc(c.title)}</text>`);
    c.nodes.forEach((n, j) => {
      const y = MAP.top + j * (MAP.nodeH + MAP.gap);
      at.set(n.id, { x, y });
      parts.push(`<g class="ov-node ov-k-${esc(n.kind.replace(/[^a-z]+/gi, '-'))}${n.life ? ` ${lifeClass(n.life)}` : ''}"><title>${esc(`${n.label} (${n.kind}${n.life && n.life !== 'ended' ? `, ${LIFE_WORD[n.life]}` : ''}): ${n.source.command}`)}</title>`
        + `<rect x="${x}" y="${y}" width="${MAP.nodeW}" height="${MAP.nodeH}" rx="6"></rect><text x="${x + 8}" y="${y + 18}">${esc(cutLabel(n.label))}</text></g>`);
    });
    if (c.more) parts.push(`<text class="ov-more" x="${x + 8}" y="${MAP.top + c.nodes.length * (MAP.nodeH + MAP.gap) + 16}">${esc(`and ${c.more} more`)}</text>`);
  });
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
  const cards = OVERVIEW_SECTIONS.map((id) => sectionCard(o[id], itemsOf(o, id, k, canvasLine), k, k.live, canvasLine)).join('');
  const map = `<figure class="ov-map"><figcaption><strong>${esc(MAP_LABEL)}</strong> ${esc(o.map.words)}</figcaption>${o.map.columns.length ? mapSvg(o) : `<p class="ov-unknown">${esc(o.map.words)}</p>`}</figure>`;
  const when = k.live ? 'read with this board\'s state (the line above says when)' : `as of ${stamp(o.as_of)}`;
  return {
    toc: `<a href="#overview">Overview <b>${esc(waiting ? `${waiting} waiting on you` : 'nothing waits')}</b></a>`,
    html: [
      `<h2 id="overview">God's Eye View <span class="count">${esc(waiting ? `${waiting} waiting on you` : 'nothing waits on you')}</span></h2>`,
      '<section class="overview">',
      `<p class="ov-lead">${esc('The project at a glance, from the same records as the Control Room, Workflows, VoxVision, Results and Memory below. Each line links to the section that shows it, or names its command; nothing here acts.')}</p>`,
      `<p class="meta">${esc(when)}</p>`,
      `<div class="ov-grid">${cards}</div>`,
      map,
      thumbsHtml(o, k, base),
      `<details class="ov-adv" data-keep="overview:advanced"><summary>${esc('advanced: the same model as JSON')}</summary><p class="meta">${esc('In Timmy: /overview --json (timmy act \'/overview --json\' --json carries it in its "lines"). On this live board: GET /overview with the board\'s token, as /state. Notes: ')}${esc(o.notes.join(' '))}</p></details>`,
      '</section>',
    ].join(''),
  };
}

/** The model without its times, for the live board's shape: the page redraws only when something but the time changed. */
export function overviewShape(o: Overview): unknown {
  return JSON.parse(JSON.stringify(o, (key, value) => (key === 'as_of' ? undefined : value)));
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
`;
