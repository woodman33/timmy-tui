/**
 * Round R4 (helper H78): `/overview`, Timmy God's Eye View in the terminal (the model: src/overview).
 *
 *   /overview             the first screen: one line per section with its counts and its most urgent item, what needs you
 *                         first; it fits 80 columns and about 25 lines
 *   /overview <section>   one section in full: needs, devices, hosting, agents, workflows, apps, spatial, history, costs,
 *                         project, or map
 *   /overview --all       every section in full
 *   /overview --json      the model itself, as JSON (`timmy act '/overview --json' --json` carries it in its "lines")
 *
 * R4 (H93): Devices (Timmy Connect, this computer's Timmy home), Hosting (Timmy Cloud's backend as last read) and Costs
 * (provider spend beside model spend), one line each on the first screen; "how long ago" comes from the model's `ago` fields.
 *
 * R4 (lead): Fleets (`timmy fleet`), one line after Costs only in a project that has a fleet plan; `/overview fleet` in full.
 * Its commands and what waits on a person are in the attention colour (the next action), never green: a fleet's outcome
 * is not a pass, and nothing it delivered is verified.
 *
 * Plain words, in Timmy Homebrew through the terminal theme's roles: commands amber (accent, DESIGN.md B10), labels secondary,
 * a wait or an unproven state in the attention colour (amber), a failure amber with its word, and every outcome word in the
 * text colour.
 * Everything printed comes from the model, which is already scrubbed of the project's and home folders.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Role, Segment } from '../term/theme.js';
import {
  FLEET_TITLE, MAP_LABEL, OVERVIEW_SECTIONS, SECTION_TITLE,
  type AgentsSection, type AppsSection, type CostsSection, type Count, type DevicesSection, type FleetSection, type HistorySection, type HostingSection,
  type Life, type NeedsSection, type Overview, type OverviewPartId, type OverviewSource, type ProjectSection, type SectionBase,
  type SpatialSection, type Tone, type WorkflowsSection,
} from '../overview/model.js';

type Line = Segment[];

export interface OverviewTextOptions {
  glyphs: GlyphSet;
  /** a project path as the terminal shows it (an OSC 8 link where it can); plain text by default */
  link?: (rel: string) => string;
  /** the columns the first screen fits (80 by default) */
  width?: number;
  /** R4 (H99, gap 4): the live board's address when one runs (no token): each view ends with its Overview section's address */
  board?: string;
}

/** An operation's id, which the first screen never cuts (R4 H99, gap 4: r24 found it cut off). */
const OPERATION_IN_TEXT = /\bo[0-9a-f]{8}\b/g;

/**
 * R4 (H99, gap 4): a text cut to `n` columns that keeps every operation id in it whole: the words around the ids are shortened
 * (each cut part ends with an ellipsis), never an id. When the ids alone do not fit, they are kept and the rest dropped.
 */
export function cutKeepingIds(text: string, n: number): string {
  const chars = Array.from(text);
  if (chars.length <= n) return text;
  const ids = [...text.matchAll(OPERATION_IN_TEXT)];
  if (!ids.length) return cut(text, n);
  // the text as parts: words, id, words, id, …, words
  const parts: Array<{ id: boolean; text: string }> = [];
  let at = 0;
  for (const m of ids) { parts.push({ id: false, text: text.slice(at, m.index) }, { id: true, text: m[0] }); at = m.index! + m[0].length; }
  parts.push({ id: false, text: text.slice(at) });
  let room = n - ids.reduce((k, m) => k + m[0].length, 0);
  if (room <= 0) return ids.map((m) => m[0]).join(' ');
  return parts.map((p, i) => {
    if (p.id) return p.text;
    const len = Array.from(p.text).length;
    if (len <= room) { room -= len; return p.text; }
    // R4 (H99, the review): words cut before an id end with the ellipsis and a space ("ope… o1a2b3c4d"), never glued to it
    const beforeId = i < parts.length - 1;
    const kept = beforeId ? (room >= 3 ? `${cut(p.text, room - 1)} ` : '') : room > 1 ? cut(p.text, room) : room === 1 ? '…' : '';
    room = Math.max(0, room - Array.from(kept).length);
    return kept;
  }).join('');
}

/**
 * R4 (H99, the review of the H99 work): a section's head and its most urgent item on one line of `n` columns, every operation
 * id in either whole. The item needs at least its separator and its ids; the head gives way for them (its own ids kept), and
 * the item has what is left. Each comes back alone, so neither starts inside the other (the review: a head of 57 to 66
 * columns made "…14 changes to reviewa2b3c4d", the item cut inside its id). Ids alone that do not fit are kept whole.
 */
export function fitHeadAndItem(head: string, item: string, sep: string, n: number): { head: string; item: string } {
  const width = (t: string): number => Array.from(t).length;
  if (width(head) + width(sep) + width(item) <= n) return { head, item: `${sep}${item}` };
  const ids = [...item.matchAll(OPERATION_IN_TEXT)].map((m) => m[0]);
  const least = ids.length ? width(sep) + width(ids.join(' ')) : 0;
  const headCut = cutKeepingIds(head, Math.max(1, n - least));
  const left = n - width(headCut) - width(sep);
  const itemCut = left > 0 ? cutKeepingIds(item, left) : ids.join(' ');
  return { head: headCut, item: itemCut && itemCut !== '…' ? `${sep}${itemCut}` : '' };
}

export const OVERVIEW_USAGE = '/overview [needs|devices|hosting|agents|workflows|apps|spatial|history|costs|fleet|project|map] [--all] [--json]';

/** The words each section answers to: its id and a few plain names. */
const ALIASES: Readonly<Record<string, OverviewPartId | 'map'>> = {
  // R4 (lead)
  fleet: 'fleet', fleets: 'fleet', workers: 'fleet', vms: 'fleet',
  needs: 'needs', 'needs-you': 'needs', you: 'needs', decisions: 'needs', waiting: 'needs',
  // R4 (H93)
  devices: 'devices', device: 'devices', computers: 'devices', connect: 'devices', remote: 'devices',
  hosting: 'hosting', cloud: 'hosting', sites: 'hosting', domains: 'hosting', vps: 'hosting', orders: 'hosting',
  costs: 'costs', cost: 'costs', spend: 'costs',
  agents: 'agents', agent: 'agents', runs: 'agents', crew: 'agents',
  workflows: 'workflows', workflow: 'workflows', jobs: 'workflows',
  apps: 'apps', app: 'apps', artifacts: 'apps', results: 'apps', files: 'apps',
  spatial: 'spatial', vox: 'spatial', voxvision: 'spatial',
  history: 'history', receipts: 'history',
  project: 'project', canvas: 'project',
  map: 'map', layout: 'map',
};

export type OverviewView = { view: 'first' } | { view: 'all' } | { view: 'json' } | { view: 'section'; id: OverviewPartId | 'map' };

/** What `/overview` was asked: the first screen, --all, --json, or one section; else the usage. */
export function parseOverviewArgs(args: string): OverviewView | { error: string } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { view: 'first' };
  if (words.length === 1 && words[0] === '--json') return { view: 'json' };
  if (words.length === 1 && words[0] === '--all') return { view: 'all' };
  if (words.length === 1 && Object.hasOwn(ALIASES, words[0].toLowerCase())) return { view: 'section', id: ALIASES[words[0].toLowerCase()] };
  return { error: `Usage: ${OVERVIEW_USAGE}` };
}

const ROLE: Readonly<Record<Tone, Role | undefined>> = { failed: 'failure', attention: 'estimate', running: undefined, ok: undefined, neutral: undefined };
const LIFE_ROLE: Readonly<Record<Life, Role | undefined>> = { running: undefined, ended: undefined, left: 'estimate', stale: 'estimate', unknown: 'estimate' };
/** A life in a word: running only when proven. */
const LIFE_WORD: Readonly<Record<Life, string>> = { running: 'running', left: 'left running', stale: 'stale', ended: 'ended', unknown: 'not proven' };
const stamp = (iso: string | null | undefined): string => {
  const d = iso ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
};
/** A text cut to `n` columns (one character, one column), with an ellipsis. */
export function cut(text: string, n: number): string {
  const chars = Array.from(text);
  return chars.length > n ? `${chars.slice(0, Math.max(0, n - 1)).join('')}…` : text;
}
const countsText = (c: Count[], sep: string): string => c.map((x) => `${x.n} ${x.of}`).join(sep);

// ── the first screen ─────────────────────────────────────────────────────────

/** The first screen: one line per section (what needs you first), within `width` columns. */
export function overviewFirstLines(o: Overview, t: OverviewTextOptions): Line[] {
  const g = t.glyphs;
  const width = t.width ?? 80;
  const sep = ` ${g.sep} `;
  const label = (s: string): Segment => ({ text: `  ${s.padEnd(11)} `, role: 'secondary' });
  const room = width - 14;
  const lines: Line[] = [[{ text: cut(`  God's Eye View  ${o.project.name}${sep}as of ${stamp(o.as_of)}`, width), role: 'strong' }]];
  const sectionLine = (sec: SectionBase): Line => {
    const head = sec.state === 'unknown' ? `unknown: ${sec.why ?? 'not read'}` : `${sec.state === 'partial' ? 'partly read; ' : ''}${sec.summary}`;
    const headRole = sec.state === 'unknown' ? { role: 'estimate' as Role } : {};
    if (!sec.urgent) return [label(sec.title), { text: cutKeepingIds(head, room), ...headRole }];
    // R4 (H93): how long ago, when the urgent item has a time (a probe, the backend's answer)
    const item = `${sec.urgent.text}${sec.urgent.ago ? ` (${sec.urgent.ago})` : ''}`;
    // R4 (H99, gap 4 and the review): an operation id is never cut off, in the head or the item; the words around it give way
    const fit = fitHeadAndItem(head, item, sep, room);
    return [label(sec.title), { text: fit.head, ...headRole }, ...(fit.item ? [{ text: fit.item, ...(ROLE[sec.urgent.tone] ? { role: ROLE[sec.urgent.tone] } : {}) }] : [])];
  };
  const command = (src: OverviewSource | undefined): Line | undefined => (src ? [{ text: '              ' }, { text: cut(src.command, room), role: 'accent' }] : undefined);
  for (const id of OVERVIEW_SECTIONS) {
    if (id === 'project') continue;
    const sec = o[id];
    lines.push(sectionLine(sec));
    // What needs you also says what to type for its first item.
    if (id === 'needs' && sec.urgent) lines.push(command(sec.urgent.source)!);
  }
  // R4 (lead): the project's fleets, only when it has a fleet plan
  if (o.fleet) lines.push(sectionLine(o.fleet));
  lines.push([label('Project'), { text: cut(o.project.summary, room) }]);
  const cols = o.map.columns;
  const n = (i: number): number => (cols[i] ? cols[i].nodes.length + cols[i].more : 0);
  lines.push([label('Map'), { text: cut(`${n(0)} agents ${g.arrow} ${n(1)} workflows/flows ${g.arrow} ${n(2)} files (${MAP_LABEL}): /board`, room) }]);
  // R4 (H99, gap 4): the newest request (running first), its operation id whole, and its card's command
  const op = o.agents.operations?.[0];
  if (op) lines.push([label('Request'), { text: cutKeepingIds(`${op.id} ${op.life === 'ended' ? op.state : LIFE_WORD[op.life]}${sep}${op.request}`, room - `${sep}/op ${op.id}`.length) }, { text: `${sep}/op ${op.id}`, role: 'accent' }]);
  lines.push([label('In full'), { text: cut(`/overview <section>${sep}/overview --all${sep}/overview --json`, room), role: 'accent' }]);
  // R4 (H99, gap 4): the live board's Overview section when one runs, else what starts it
  lines.push(t.board ? [label('Board'), { text: cut(`${t.board}#overview`, room), role: 'accent' }] : [label('Board'), { text: '/board live', role: 'accent' }, { text: ' shows it in your browser', role: 'secondary' }]);
  return lines;
}

/** R4 (H99, gap 4): the last line of every /overview view: the live board's Overview section, or what starts one. */
const overviewBoardLine = (board: string | undefined): Line => (board
  ? [{ text: '  On the board  ', role: 'secondary' }, { text: `${board}#overview`, role: 'accent' }, { text: '  (the live board this REPL runs)', role: 'secondary' }]
  : [{ text: '  On the board  ', role: 'secondary' }, { text: '/board live', role: 'accent' }, { text: ' shows it in your browser', role: 'secondary' }]);

// ── one section in full ──────────────────────────────────────────────────────

interface Ctx { g: GlyphSet; sep: string; link: (rel: string) => string }

const src = (c: Ctx, s: OverviewSource, indent = '      '): Line => [
  { text: indent }, ...(s.record ? [{ text: c.link(s.record) }, { text: c.sep, role: 'secondary' as Role }] : []),
  { text: s.command, role: 'accent' }, ...(s.receipt ? [{ text: `${c.sep}receipt ${s.receipt}`, role: 'secondary' as Role }] : []),
];

function headLines(sec: SectionBase, c: Ctx): Line[] {
  const lines: Line[] = [[{ text: `  ${sec.title.toUpperCase()}`, role: 'strong' }, { text: `  as of ${stamp(sec.as_of)}${sec.state !== 'read' ? `${c.sep}${sec.state}` : ''}`, role: 'secondary' }]];
  if (sec.state !== 'read' && sec.why) lines.push([{ text: `    ${sec.state === 'unknown' ? 'unknown' : 'partly read'}: ${sec.why}`, role: 'estimate' }]);
  if (sec.counts.length) lines.push([{ text: `    ${countsText(sec.counts, c.sep)}`, role: 'secondary' }]);
  return lines;
}
function tailLines(sec: SectionBase, c: Ctx, more: Array<[number, string]>): Line[] {
  const lines: Line[] = [];
  for (const [n, what] of more) if (n > 0) lines.push([{ text: `    and ${n} more ${what}`, role: 'secondary' }]);
  for (const u of sec.unreadable) lines.push([{ text: '    unknown: ', role: 'estimate' }, { text: c.link(u.record) }, { text: ` could not be read: ${u.why}`, role: 'estimate' }]);
  for (const n of sec.notes) lines.push([{ text: `    ${n}`, role: 'secondary' }]);
  return lines;
}

function needsLines(sec: NeedsSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  if (sec.state !== 'unknown' && !sec.items.length) lines.push([{ text: '    Nothing waits on you.', role: 'secondary' }]);
  for (const i of sec.items) {
    lines.push([{ text: '    ! ', role: 'estimate' }, { text: i.title, role: 'strong' }, { text: i.blocks ? '  blocks a request' : '', role: 'estimate' }]);
    lines.push([{ text: '      needed  ', role: 'secondary' }, { text: i.needed }]);
    lines.push([{ text: '      why     ', role: 'secondary' }, { text: i.why, role: 'secondary' }]);
    if (i.keys?.length) lines.push([{ text: '      keys    ', role: 'secondary' }, { text: i.keys.join(c.sep) }]);
    for (const st of i.steps ?? []) lines.push([{ text: '      step    ', role: 'secondary' }, { text: st }]);
    if (i.commands.length) lines.push([{ text: '      type    ', role: 'secondary' }, { text: i.commands.join(c.sep), role: 'accent' }]);
    if (i.source.record) lines.push([{ text: '      record  ', role: 'secondary' }, { text: c.link(i.source.record) }, { text: i.source.receipt ? `${c.sep}receipt ${i.source.receipt}` : '', role: 'secondary' }]);
    // R4 (H93): what comes from this computer's Timmy home, not the project: where, and since when
    if (i.from) lines.push([{ text: '      from    ', role: 'secondary' }, { text: i.from === 'connect' ? 'Timmy Connect, this computer\'s Timmy home' : 'Timmy Cloud\'s backend, as last read' }, { text: i.source.home ? ` (${i.source.home} there)` : '', role: 'secondary' }]);
    if (i.since) lines.push([{ text: '      since   ', role: 'secondary' }, { text: `${stamp(i.since)}${i.ago ? ` (${i.ago})` : ''}` }]);
  }
  if (sec.tools.note) lines.push([{ text: `    Setup: ${sec.tools.note}`, role: 'secondary' }]);
  else if (sec.tools.checked_at) lines.push([{ text: `    The tools were checked at ${stamp(sec.tools.checked_at)} (/tools checks them again).`, role: 'secondary' }]);
  return [...lines, ...tailLines(sec, c, [[sec.more, 'waiting: /decisions lists them']])];
}

const costWords = (cst: { cost?: { words: string }; cost_none?: string }): string => cst.cost?.words ?? `none recorded: ${cst.cost_none ?? 'no request went out'}`;

function agentsLines(sec: AgentsSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  if (sec.state !== 'unknown' && !sec.items.length) lines.push([{ text: '    No agent, flow or chat run is recorded in this project yet.', role: 'secondary' }]);
  for (const a of sec.items) {
    lines.push([{ text: `    ${a.life === 'running' ? c.g.bullet : ' '} ` }, { text: `${a.owner} ${a.id}`, role: 'strong' }, { text: `  ${a.life === 'ended' ? a.state : LIFE_WORD[a.life]}`, ...(LIFE_ROLE[a.life] ? { role: LIFE_ROLE[a.life] } : {}) }]);
    if (a.life !== 'ended' && a.life !== 'running' && a.life_why) lines.push([{ text: `      ${a.life_why}`, role: 'estimate' }]);
    else if (a.life === 'running' && a.state !== 'running') lines.push([{ text: `      ${a.state}`, role: 'secondary' }]);
    lines.push([{ text: '      asked   ', role: 'secondary' }, { text: a.assignment ? a.assignment.text : 'not recorded in a record of it' }, { text: a.assignment ? `  (${a.assignment.from})` : '', role: 'secondary' }]);
    lines.push([{ text: '      route   ', role: 'secondary' }, { text: [a.harness, a.model, a.route].filter(Boolean).join(c.sep) }]);
    const where = [a.step, a.progress, a.elapsed].filter(Boolean).join(c.sep);
    if (where) lines.push([{ text: '      where   ', role: 'secondary' }, { text: where }]);
    for (const h of a.handoffs.slice(0, 6)) lines.push([{ text: `      ${c.g.arrow} ${h.to}  `, role: 'secondary' }, { text: h.state }, ...(h.source ? [{ text: `  ${h.source.command}`, role: 'accent' as Role }] : [])]);
    if (a.handoffs.length > 6) lines.push([{ text: `      and ${a.handoffs.length - 6} more handoffs: ${a.source.command}`, role: 'secondary' }]);
    lines.push([{ text: '      cost    ', role: 'secondary' }, { text: costWords(a), ...(a.cost?.kind === 'unknown' ? { role: 'estimate' as Role } : {}) }]);
    lines.push(src(c, a.source));
  }
  if (sec.operations.length) {
    lines.push([{ text: '    Requests (operations), running first', role: 'strong' }]);
    for (const op of sec.operations) {
      lines.push([{ text: `      ${op.id}  `, role: 'strong' }, { text: `${op.life === 'ended' ? op.state : LIFE_WORD[op.life]}  `, ...(LIFE_ROLE[op.life] ? { role: LIFE_ROLE[op.life] } : {}) }, { text: op.request }, { text: `${c.sep}${op.runs} run${op.runs === 1 ? '' : 's'}${op.waiting.length ? `${c.sep}waiting on you: ${op.waiting.join('; ')}` : ''}`, role: 'secondary' }]);
      if (op.life_why && op.life !== 'ended') lines.push([{ text: `        ${op.life_why}`, role: 'estimate' }]);
    }
  }
  return [...lines, ...tailLines(sec, c, [[sec.more, 'runs: /room lists them'], [sec.operations_more, 'requests: /ops lists them']])];
}

function workflowsLines(sec: WorkflowsSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  if (sec.state !== 'unknown' && !sec.items.length) lines.push([{ text: '    No workflow document yet: Markdown with a named block (```bash [name:build]), then /workflows.', role: 'secondary' }]);
  for (const w of sec.items) {
    lines.push([{ text: `    ${w.doc}`, role: 'strong' }, { text: w.title ? `  ${w.title}` : '', role: 'secondary' }, { text: w.readable ? '' : `  not readable: ${w.why ?? 'unknown'}`, role: 'estimate' }]);
    lines.push([{ text: '      blocks  ', role: 'secondary' }, { text: w.blocks.map((b) => `${b.name}${b.needs.length ? ` (needs ${b.needs.join(', ')})` : ''}: ${b.word}`).join(c.sep) || 'none named' }]);
    const r = w.last_run;
    if (r) {
      lines.push([{ text: '      last run', role: 'secondary' }, { text: ` ${r.job} › ${r.target}: ` }, { text: r.life === 'ended' ? r.word : LIFE_WORD[r.life], ...(LIFE_ROLE[r.life] ? { role: LIFE_ROLE[r.life] } : {}) }, { text: `${r.met === false ? `${c.sep}its prediction not met` : r.met ? `${c.sep}its prediction met` : ''}${r.receipt ? `${c.sep}receipt ${r.receipt}` : ''}`, role: 'secondary' }]);
      lines.push([{ text: '      in order', role: 'secondary' }, { text: ` ${r.blocks.map((b) => `${b.name} ${b.word}${b.detail ? ` (${b.detail})` : ''}`).join(` ${c.g.arrow} `)}` }, { text: `  (order from ${r.order_from})`, role: 'secondary' }]);
      if (r.life_why && r.life !== 'ended') lines.push([{ text: `      ${r.life_why}`, role: 'estimate' }]);
    } else lines.push([{ text: '      last run  none yet', role: 'secondary' }]);
    for (const b of w.blockers) lines.push([{ text: '      blocker ', role: 'failure' }, { text: `${b.block}: ${b.why}` }, { text: `  ${b.source.command}`, role: 'accent' }]);
    lines.push(src(c, w.source));
  }
  if (sec.jobs.length) {
    lines.push([{ text: '    Jobs that say they run', role: 'strong' }]);
    for (const j of sec.jobs) {
      lines.push([{ text: `      ${j.id}  `, role: 'strong' }, { text: LIFE_WORD[j.life], ...(LIFE_ROLE[j.life] ? { role: LIFE_ROLE[j.life] } : {}) }, { text: `  ${j.label}${c.sep}${j.kind}`, role: 'secondary' }, { text: `  ${j.source.command}`, role: 'accent' }]);
      if (j.life_why) lines.push([{ text: `        ${j.life_why}`, role: 'estimate' }]);
    }
  }
  return [...lines, ...tailLines(sec, c, [[sec.more, 'documents: /workflows lists them'], [sec.jobs_more, 'jobs: /jobs lists them']])];
}

function appsLines(sec: AppsSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  lines.push([{ text: '    App runs', role: 'strong' }]);
  if (!sec.runs.length) lines.push([{ text: '      none recorded in this project yet', role: 'secondary' }]);
  for (const r of sec.runs) {
    lines.push([{ text: `      ${r.app} ${r.id}  `, role: 'strong' }, { text: r.life === 'ended' ? r.state : `${LIFE_WORD[r.life]}${r.life === 'running' ? `: ${r.state}` : ''}`, ...(r.life === 'ended' ? (ROLE[r.tone] ? { role: ROLE[r.tone] } : {}) : LIFE_ROLE[r.life] ? { role: LIFE_ROLE[r.life] } : {}) }, { text: `${r.harness ? `${c.sep}${r.harness}` : ''}${r.outputs ? `${c.sep}${r.outputs} files` : ''}`, role: 'secondary' }]);
    if (r.life_why && r.life !== 'ended') lines.push([{ text: `        ${r.life_why}`, role: 'estimate' }]);
    lines.push(src(c, r.source, '        '));
  }
  lines.push([{ text: '    Files they made (editable first)', role: 'strong' }]);
  if (!sec.artifacts.length) lines.push([{ text: '      none listed', role: 'secondary' }]);
  for (const a of sec.artifacts) {
    lines.push([{ text: '      ' }, { text: c.link(a.path) }, { text: `  ${a.kind}${a.editor ? `, ${a.editor}` : ''}${c.sep}${a.role}${c.sep}by ${a.by}`, role: 'secondary' }, { text: `  ${a.source.command}`, role: 'accent' }]);
  }
  lines.push([{ text: '    Results to review', role: 'strong' }]);
  if (!sec.results.length) lines.push([{ text: '      no recent operation changed a file Timmy records', role: 'secondary' }]);
  for (const r of sec.results) {
    lines.push([{ text: `      ${r.operation}  `, role: 'strong' }, { text: `${r.changes} changed${r.first ? `: ${r.first.path} ${r.first.how}, ${r.first.now} now` : ''}` }, { text: `${c.sep}${r.request}`, role: 'secondary' }, { text: `  ${r.source.command}`, role: 'accent' }]);
  }
  return [...lines, ...tailLines(sec, c, [[sec.runs_more, 'app runs: /room lists them'], [sec.artifacts_more, 'files: /results lists them'], [sec.results_more, 'operations with changes: /review']])];
}

function spatialLines(sec: SpatialSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  if (sec.state !== 'unknown' && !sec.items.length) lines.push([{ text: '    No VoxVision record yet: /inspect, /measure, /detect or /compare makes one.', role: 'secondary' }]);
  for (const v of sec.items) {
    lines.push([{ text: `    ${v.id}  `, role: 'strong' }, { text: `${v.action} ${v.inputs.map((i) => i.path).join(' and ')}` }, { text: `  ${v.check}`, ...(v.check === 'verified' ? {} : { role: 'estimate' as Role }) }, { text: `${c.sep}${v.status}`, role: 'secondary' }]);
    for (const why of v.check_why.slice(0, 2)) lines.push([{ text: `      ${why}`, role: 'estimate' }]);
    for (const m of v.metrics) lines.push([{ text: `      ${m.of ? `${m.of === 'delta' ? 'Δ' : m.of} ` : ''}${m.title}  `, role: 'secondary' }, { text: m.value }, { text: `  ${m.word}`, ...(m.word === 'measured' || m.word === 'CAD checked' ? {} : { role: 'estimate' as Role }) }, { text: `${m.note && m.word !== 'measured' ? `: ${m.note}` : ''}${m.recorded ? ` (recorded as ${m.recorded})` : ''}`, role: 'secondary' }]);
    if (v.metrics_more) lines.push([{ text: `      and ${v.metrics_more} more values: /open ${v.file}`, role: 'secondary' }]);
    for (const h of v.highlights) lines.push([{ text: `      ${h.shown ? 'highlight' : 'not shown'}  `, role: 'secondary' }, { text: c.link(h.path) }, { text: `  ${h.label}${h.word ? `${c.sep}${h.word}` : ''}${h.shown ? '' : `: ${h.why ?? 'not checked'}`}`, role: 'secondary' }]);
    lines.push(src(c, v.source));
    lines.push([{ text: '      advanced: ', role: 'secondary' }, { text: v.viewer, role: 'accent' }, { text: " opens Rerun's own viewer, a window on your computer (type it yourself)", role: 'secondary' }]);
  }
  return [...lines, ...tailLines(sec, c, [[sec.more, 'records: /board shows the newest']])];
}

function historyLines(sec: HistorySection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  const h = sec.head;
  lines.push([{ text: '    Chain head  ', role: 'secondary' }, ...(h ? [{ text: `${h.id} (${h.kind}, ${stamp(h.ts)}) ` }, { text: h.words, ...(h.verified ? {} : { role: 'failure' as Role }) }, { text: `  ${h.source.command}`, role: 'accent' as Role }]
    : sec.receipts.known ? [{ text: 'no receipts yet: nothing to verify', role: 'secondary' as Role }] : [{ text: `unknown: ${sec.receipts.why ?? 'not read'}`, role: 'estimate' as Role }])]);
  lines.push([{ text: '    Costs       ', role: 'secondary' }, { text: sec.costs.words || 'not known' }]);
  lines.push([{ text: '    Operations  ', role: 'secondary' }, { text: `${sec.operations.recorded} recorded${c.sep}${sec.operations.running} running (proven)${c.sep}${sec.operations.left} left by a Timmy that ended` },
    // R4 (H82): only the newest records that say they run are checked; the rest are counted
    ...(sec.operations.unchecked ? [{ text: `${c.sep}and ${sec.operations.unchecked} older said running, not checked here`, role: 'estimate' as Role }] : [])]);
  const lessons = Object.entries(sec.lessons);
  lines.push([{ text: '    Lessons     ', role: 'secondary' }, { text: lessons.length ? lessons.map(([w, n]) => `${n} ${w}`).join(c.sep) : 'none' }]);
  if (sec.receipts.recent.length) lines.push([{ text: '    Newest receipts of this project', role: 'strong' }]);
  for (const r of sec.receipts.recent) lines.push([{ text: `      ${r.id}  `, role: 'strong' }, { text: `${r.kind}${r.status ? ` ${r.status}` : ''}${c.sep}${stamp(r.ts)}${r.operation ? `${c.sep}operation ${r.operation}` : ''}`, role: 'secondary' }, { text: `  ${r.source.command}`, role: 'accent' }]);
  return [...lines, ...tailLines(sec, c, [[sec.receipts.recent_more, 'receipts of this project: /receipts']])];
}

// ── R4 (H93): devices, hosting and costs ─────────────────────────────────────

const JOB_ROLE: Readonly<Record<string, Role | undefined>> = { unknown: 'estimate', 'stop asked': 'estimate', submitted: 'estimate' };

function devicesLines(sec: DevicesSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  lines.push([{ text: `    ${sec.scope}`, role: 'secondary' }]);
  if (sec.state !== 'unknown' && !sec.items.length) lines.push([{ text: '    No computers yet: ', role: 'secondary' }, { text: '/connect add <id> <user>@<address> --key <file>', role: 'accent' }]);
  for (const d of sec.items) {
    const answered = d.probe?.answered;
    lines.push([{ text: `    ${d.id}`, role: 'strong' }, { text: d.name !== d.id ? `  ${d.name}` : '', role: 'secondary' }]);
    lines.push([{ text: '      reached   ', role: 'secondary' }, { text: d.reach.words }]);
    lines.push([{ text: '      probe     ', role: 'secondary' }, d.probe ? { text: `${d.probe.line} (${d.probe.ago})`, ...(answered ? {} : { role: 'estimate' as Role }) } : { text: 'not probed yet', role: 'estimate' }]);
    if (d.probe && !answered) lines.push([{ text: `        ${d.probe.words}`, role: 'secondary' }]);
    lines.push([{ text: '      system    ', role: 'secondary' }, { text: d.system.words }]);
    lines.push([{ text: '      PATH      ', role: 'secondary' }, { text: d.found_words }]);
    lines.push([{ text: '      host key  ', role: 'secondary' }, { text: d.host_key.words, ...(d.host_key.state === 'changed' ? { role: 'failure' as Role } : d.host_key.state === 'confirmed' ? {} : { role: 'estimate' as Role }) }]);
    for (const n of d.needs) lines.push([{ text: '      ! ', role: 'estimate' }, { text: n }]);
    const jobs = Object.entries(d.jobs);
    if (jobs.length) lines.push([{ text: '      jobs      ', role: 'secondary' }, { text: jobs.map(([st, n]) => `${n} ${st}`).join(c.sep) }]);
    lines.push([{ text: '      type      ', role: 'secondary' }, { text: d.commands.join(c.sep), role: 'accent' }]);
  }
  if (sec.jobs.length) {
    lines.push([{ text: '    Remote jobs, as each was last read (running only as its status file said, when read)', role: 'strong' }]);
    for (const j of sec.jobs) {
      lines.push([{ text: `      ${j.id}  `, role: 'strong' }, { text: j.state, ...(JOB_ROLE[j.state] ? { role: JOB_ROLE[j.state] } : {}) }, { text: `  on ${j.device}${j.device_known ? '' : ' (not among the computers any more)'}${c.sep}${j.label}`, role: 'secondary' }]);
      lines.push([{ text: `        ${j.words}` }]);
      lines.push([{ text: '        type  ', role: 'secondary' }, { text: j.commands.join(c.sep), role: 'accent' }]);
    }
  }
  return [...lines, ...tailLines({ ...sec, notes: sec.notes.filter((n) => n !== sec.scope) }, c, [[sec.more, 'computers: /connect devices lists them'], [sec.jobs_more, 'remote jobs: /connect jobs lists them']])];
}

function hostingLines(sec: HostingSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  lines.push([{ text: '    backend   ', role: 'secondary' }, { text: sec.backend.words }, ...(sec.backend.set_up ? [] : [{ text: `  ${sec.backend.command}`, role: 'accent' as Role }])]);
  if (sec.backend.set_up) {
    lines.push([{ text: '    read      ', role: 'secondary' }, { text: `${sec.read.words}${sec.read.ago ? ` (${sec.read.ago})` : ''}`, ...(sec.read.old || sec.read.failed || !sec.read.at ? { role: 'estimate' as Role } : {}) }, { text: `  ${sec.read.command}`, role: 'accent' }]);
  }
  if (sec.provider) lines.push([{ text: '    provider  ', role: 'secondary' }, { text: sec.provider.words }]);
  for (const o of sec.items) {
    lines.push([{ text: `    ${o.name}`, role: 'strong' }, { text: `  order ${o.order}${o.customer ? `${c.sep}${o.customer}` : ''}${o.simulated ? `${c.sep}simulated` : ''}`, role: 'secondary' }]);
    lines.push([{ text: '      steps   ', role: 'secondary' }, { text: o.steps_line }]);
    for (const st of o.steps.filter((x) => x.needs_person || ['unknown', 'failed', 'waiting', 'pending', 'in_flight', 'refused'].includes(x.state))) {
      lines.push([{ text: `        ${st.label} ${st.state.replace(/_/g, ' ')}  `, role: st.state === 'failed' || st.state === 'refused' ? 'failure' : 'estimate' }, { text: `${st.words}${st.provider_words ? ` (the provider: "${st.provider_words}")` : ''}`, role: 'secondary' }]);
    }
    lines.push([{ text: '      now     ', role: 'secondary' }, { text: `${o.summary}${o.simulated ? ' (simulated)' : ''}` }]);
    if (o.needs_person) lines.push([{ text: '      needs   ', role: 'estimate' }, { text: o.needs_person }]);
    if (o.cancel) lines.push([{ text: '      cancel  ', role: 'secondary' }, { text: o.cancel.words }]);
    lines.push([{ text: '      next    ', role: 'secondary' }, { text: o.next_action, role: 'secondary' }]);
    lines.push([{ text: '      cost    ', role: 'secondary' }, { text: o.cost.words, ...(o.cost.charged_cents === null ? { role: 'estimate' as Role } : {}) }]);
    for (const r of o.resources) lines.push([{ text: '      made    ', role: 'secondary' }, { text: `${r.kind} ${r.name}: ${r.state}${r.expires_at ? `${c.sep}registration ends ${stamp(r.expires_at)}` : ''}${r.retained_until ? `${c.sep}retained until ${stamp(r.retained_until)}` : ''}` }]);
    lines.push([{ text: '      type    ', role: 'secondary' }, { text: o.commands.join(c.sep), role: 'accent' }]);
  }
  return [...lines, ...tailLines(sec, c, [[sec.more, 'orders: timmy cloud status --json lists them']])];
}

function costsLines(sec: CostsSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  lines.push([{ text: `    Model spend  (${sec.model.scope})`, role: 'strong' }]);
  lines.push([{ text: `      ${sec.model.words || 'not known'}` }, { text: '  /room', role: 'accent' }]);
  const p = sec.provider;
  lines.push([{ text: '    Provider spend  (Timmy Cloud\'s backend, as last read)', role: 'strong' }]);
  if (!p.known) lines.push([{ text: `      ${p.words}`, role: 'estimate' }]);
  else {
    lines.push([{ text: `      ${p.words}` }, { text: `  read ${stamp(p.read_at)}${p.ago ? ` (${p.ago})` : ''}${p.old ? ', old' : ''}`, role: p.old ? 'estimate' : 'secondary' }]);
    for (const x of p.customers) {
      lines.push([{ text: `      ${x.customer}  `, role: 'strong' }, { text: `${x.subscription}: ${x.words}`, ...(x.unknown_cost_orders ? { role: 'estimate' as Role } : {}) }]);
      lines.push([{ text: '        limits  ', role: 'secondary' }, { text: x.limits_words, role: 'secondary' }]);
    }
  }
  return [...lines, ...tailLines(sec, c, [[p.more, 'customers: timmy cloud status lists them']])];
}

/**
 * R4 (lead): the project's fleet plans in full: each plan's state, backend (a simulation says so), workers and isolation in
 * honest words, the counts kept apart, the revision, spend, the workers to read first, its results, what waits on a person,
 * its record, and its commands in the attention colour (the next action; never green).
 */
function fleetLines(sec: FleetSection, c: Ctx): Line[] {
  const lines = headLines(sec, c);
  const next: Role = 'estimate';
  for (const f of sec.items) {
    lines.push([{ text: `    ${f.plan}`, role: 'strong' }, { text: `  ${f.words.slice(f.plan.length + 1)}`, ...(ROLE[f.tone] ? { role: ROLE[f.tone] } : {}) }]);
    lines.push([{ text: '      backend   ', role: 'secondary' }, { text: `${f.backend} (${f.provider})${f.simulation ? `${c.sep}a simulation: no compute, no harness, no model` : ''}` }]);
    lines.push([{ text: '      workers   ', role: 'secondary' }, { text: `${f.workers}, at most ${f.concurrency} at once${c.sep}${f.isolation_words}` }]);
    lines.push([{ text: '      runs      ', role: 'secondary' }, { text: `${f.harness}${c.sep}${f.model}` }]);
    lines.push([{ text: '      counts    ', role: 'secondary' }, { text: f.counts_line, role: 'secondary' }]);
    lines.push([{ text: '      revision  ', role: 'secondary' }, { text: `${f.revision} (the revision it was planned at)` }]);
    lines.push([{ text: '      spend     ', role: 'secondary' }, { text: f.spend_words }]);
    for (const w of f.worker_lines) lines.push([{ text: '      worker    ', role: 'secondary' }, { text: w.words, ...(['unknown', 'failed', 'expired', 'interrupted', 'refused'].includes(w.phase) ? { role: (w.phase === 'unknown' ? 'estimate' : 'failure') as Role } : {}) }]);
    if (f.workers_more) lines.push([{ text: `      and ${f.workers_more} more workers: timmy fleet status ${f.plan} lists them`, role: 'secondary' }]);
    if (f.results) lines.push([{ text: '      results   ', role: 'secondary' }, { text: f.results }]);
    if (f.route) lines.push([{ text: '      route     ', role: 'secondary' }, { text: f.route.words.replace(/^route: /, ''), role: next }, { text: `${c.sep}decision ${f.route.decision}`, role: 'secondary' }]);
    for (const n of f.needs) lines.push([{ text: '      needs     ', role: next }, { text: n, role: next }]);
    lines.push([{ text: '      record    ', role: 'secondary' }, { text: c.link(f.source.record ?? '') }, { text: `${c.sep}operation ${f.operation}`, role: 'secondary' }]);
    lines.push([{ text: '      type      ', role: 'secondary' }, { text: f.commands.join(c.sep), role: next }]);
  }
  return [...lines, ...tailLines(sec, c, [[sec.more, 'plans: timmy fleet status lists them']])];
}
/** `/overview fleet` in a project without a fleet plan. */
const noFleetLines = (): Line[] => [
  [{ text: `  ${FLEET_TITLE.toUpperCase()}`, role: 'strong' }],
  [{ text: '    No fleet plan in this project. ', role: 'secondary' }, { text: 'timmy fleet plan --workers <n>', role: 'estimate' }, { text: ' makes one (timmy fleet help; only the FAKE backend, a simulation, is implemented).', role: 'secondary' }],
];

function projectLines(sec: ProjectSection, c: Ctx): Line[] {
  return [
    ...headLines(sec, c),
    [{ text: '    Name      ', role: 'secondary' }, { text: sec.name, role: 'strong' }, { text: `${c.sep}id ${sec.project_id} (a hash of its folder, as its receipts name it)`, role: 'secondary' }],
    [{ text: '    Changed   ', role: 'secondary' }, { text: stamp(sec.changed.at) }, { text: `  ${sec.changed.basis}`, role: 'secondary' }],
    [{ text: '    Canvas    ', role: 'secondary' }, { text: sec.canvas.words }, ...(sec.canvas.command ? [{ text: `  ${sec.canvas.command}`, role: 'accent' as Role }] : [])],
    ...tailLines(sec, c, []),
  ];
}

function mapLines(o: Overview, c: Ctx): Line[] {
  const lines: Line[] = [[{ text: '  MAP', role: 'strong' }, { text: `  ${MAP_LABEL}`, role: 'estimate' }], [{ text: `    ${o.map.words}`, role: 'secondary' }]];
  for (const col of o.map.columns) {
    lines.push([{ text: `    ${col.title}`, role: 'strong' }]);
    if (!col.nodes.length) lines.push([{ text: '      none', role: 'secondary' }]);
    for (const n of col.nodes) lines.push([{ text: `      ${n.label}` }, { text: `  ${n.kind}${n.life && n.life !== 'ended' ? `, ${LIFE_WORD[n.life]}` : ''}${n.state ? `, ${n.state}` : ''}`, role: 'secondary' }]);
    if (col.more) lines.push([{ text: `      and ${col.more} more`, role: 'secondary' }]);
  }
  lines.push([{ text: '    Links', role: 'strong' }]);
  if (!o.map.edges.length) lines.push([{ text: '      none a record names yet', role: 'secondary' }]);
  for (const e of o.map.edges) lines.push([{ text: `      ${e.from} ${c.g.arrow} ${e.to}  ` }, { text: e.why, role: 'secondary' }]);
  return lines;
}

/** One section in full. */
export function overviewSectionLines(o: Overview, id: OverviewPartId | 'map', t: OverviewTextOptions): Line[] {
  const c: Ctx = { g: t.glyphs, sep: ` ${t.glyphs.sep} `, link: t.link ?? ((rel: string) => rel) };
  switch (id) {
    case 'fleet': return o.fleet ? fleetLines(o.fleet, c) : noFleetLines(); // R4 (lead)
    case 'needs': return needsLines(o.needs, c);
    case 'devices': return devicesLines(o.devices, c);
    case 'hosting': return hostingLines(o.hosting, c);
    case 'costs': return costsLines(o.costs, c);
    case 'agents': return agentsLines(o.agents, c);
    case 'workflows': return workflowsLines(o.workflows, c);
    case 'apps': return appsLines(o.apps, c);
    case 'spatial': return spatialLines(o.spatial, c);
    case 'history': return historyLines(o.history, c);
    case 'project': return projectLines(o.project, c);
    case 'map': return mapLines(o, c);
  }
}

/** `/overview [args]` from a model (the REPL builds it: src/repl/workspace.ts). */
export function overviewLines(o: Overview, args: string, t: OverviewTextOptions): Line[] {
  const v = parseOverviewArgs(args);
  if ('error' in v) return [[{ text: `  ${v.error}`, role: 'secondary' }]];
  if (v.view === 'json') return JSON.stringify(o, null, 2).split('\n').map((l) => [{ text: l }]);
  if (v.view === 'first') return overviewFirstLines(o, t);
  // R4 (lead): --all shows the Fleets part after Costs when the project has a fleet plan
  const ids: Array<OverviewPartId | 'map'> = v.view === 'all' ? [...OVERVIEW_SECTIONS.flatMap((id): OverviewPartId[] => (id === 'project' && o.fleet ? ['fleet', id] : [id])), 'map'] : [v.id];
  const lines: Line[] = [[{ text: `  God's Eye View  ${o.project.name}${` ${t.glyphs.sep} `}as of ${stamp(o.as_of)}`, role: 'strong' }]];
  for (const id of ids) lines.push(...overviewSectionLines(o, id, t));
  lines.push([{ text: `  ${SECTION_TITLE.needs} first: /overview`, role: 'secondary' }]);
  lines.push(overviewBoardLine(t.board)); // R4 (H99, gap 4)
  return lines;
}
