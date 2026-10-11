/**
 * Round R4 (helper H78): `/overview`, Timmy God's Eye View in the terminal (the model: src/overview).
 *
 *   /overview             the first screen: one line per section with its counts and its most urgent item, what needs you
 *                         first; it fits 80 columns and about 25 lines
 *   /overview <section>   one section in full: needs, agents, workflows, apps, spatial, history, project, or map
 *   /overview --all       every section in full
 *   /overview --json      the model itself, as JSON (`timmy act '/overview --json' --json` carries it in its "lines")
 *
 * Plain words, in Timmy Homebrew through the terminal theme's roles: commands green (accent), labels secondary, a wait or
 * an unproven state in the attention colour, a failure in the failure colour, and every outcome word in the text colour.
 * Everything printed comes from the model, which is already scrubbed of the project's and home folders.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Role, Segment } from '../term/theme.js';
import {
  MAP_LABEL, OVERVIEW_SECTIONS, SECTION_TITLE,
  type AgentsSection, type AppsSection, type Count, type HistorySection, type Life, type NeedsSection, type Overview,
  type OverviewSectionId, type OverviewSource, type ProjectSection, type SectionBase, type SpatialSection, type Tone, type WorkflowsSection,
} from '../overview/model.js';

type Line = Segment[];

export interface OverviewTextOptions {
  glyphs: GlyphSet;
  /** a project path as the terminal shows it (an OSC 8 link where it can); plain text by default */
  link?: (rel: string) => string;
  /** the columns the first screen fits (80 by default) */
  width?: number;
}

export const OVERVIEW_USAGE = '/overview [needs|agents|workflows|apps|spatial|history|project|map] [--all] [--json]';

/** The words each section answers to: its id and a few plain names. */
const ALIASES: Readonly<Record<string, OverviewSectionId | 'map'>> = {
  needs: 'needs', 'needs-you': 'needs', you: 'needs', decisions: 'needs', waiting: 'needs',
  agents: 'agents', agent: 'agents', runs: 'agents', crew: 'agents',
  workflows: 'workflows', workflow: 'workflows', jobs: 'workflows',
  apps: 'apps', app: 'apps', artifacts: 'apps', results: 'apps', files: 'apps',
  spatial: 'spatial', vox: 'spatial', voxvision: 'spatial',
  history: 'history', receipts: 'history', costs: 'history', cost: 'history',
  project: 'project', canvas: 'project',
  map: 'map', layout: 'map',
};

export type OverviewView = { view: 'first' } | { view: 'all' } | { view: 'json' } | { view: 'section'; id: OverviewSectionId | 'map' };

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
    const urgent = sec.urgent ? `${sep}${sec.urgent.text}` : '';
    const whole = cut(`${head}${urgent}`, room);
    const headPart = cut(head, room);
    if (!sec.urgent || whole.length <= headPart.length) return [label(sec.title), { text: whole, ...(sec.state === 'unknown' ? { role: 'estimate' as Role } : {}) }];
    return [label(sec.title), { text: headPart, ...(sec.state === 'unknown' ? { role: 'estimate' as Role } : {}) }, { text: whole.slice(headPart.length), ...(ROLE[sec.urgent.tone] ? { role: ROLE[sec.urgent.tone] } : {}) }];
  };
  const command = (src: OverviewSource | undefined): Line | undefined => (src ? [{ text: '              ' }, { text: cut(src.command, room), role: 'accent' }] : undefined);
  for (const id of OVERVIEW_SECTIONS) {
    if (id === 'project') continue;
    const sec = o[id];
    lines.push(sectionLine(sec));
    // What needs you also says what to type for its first item.
    if (id === 'needs' && sec.urgent) lines.push(command(sec.urgent.source)!);
  }
  lines.push([label('Project'), { text: cut(o.project.summary, room) }]);
  const cols = o.map.columns;
  const n = (i: number): number => (cols[i] ? cols[i].nodes.length + cols[i].more : 0);
  lines.push([label('Map'), { text: cut(`${n(0)} agents ${g.arrow} ${n(1)} workflows/flows ${g.arrow} ${n(2)} files (${MAP_LABEL}): /board`, room) }]);
  lines.push([label('In full'), { text: cut(`/overview <section>${sep}/overview --all${sep}/overview --json`, room), role: 'accent' }]);
  return lines;
}

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
  lines.push([{ text: '    Operations  ', role: 'secondary' }, { text: `${sec.operations.recorded} recorded${c.sep}${sec.operations.running} running (proven)${c.sep}${sec.operations.left} left by a Timmy that ended` }]);
  const lessons = Object.entries(sec.lessons);
  lines.push([{ text: '    Lessons     ', role: 'secondary' }, { text: lessons.length ? lessons.map(([w, n]) => `${n} ${w}`).join(c.sep) : 'none' }]);
  if (sec.receipts.recent.length) lines.push([{ text: '    Newest receipts of this project', role: 'strong' }]);
  for (const r of sec.receipts.recent) lines.push([{ text: `      ${r.id}  `, role: 'strong' }, { text: `${r.kind}${r.status ? ` ${r.status}` : ''}${c.sep}${stamp(r.ts)}${r.operation ? `${c.sep}operation ${r.operation}` : ''}`, role: 'secondary' }, { text: `  ${r.source.command}`, role: 'accent' }]);
  return [...lines, ...tailLines(sec, c, [[sec.receipts.recent_more, 'receipts of this project: /receipts']])];
}

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
    for (const n of col.nodes) lines.push([{ text: `      ${n.label}` }, { text: `  ${n.kind}${n.life && n.life !== 'ended' ? `, ${LIFE_WORD[n.life]}` : ''}`, role: 'secondary' }]);
    if (col.more) lines.push([{ text: `      and ${col.more} more`, role: 'secondary' }]);
  }
  lines.push([{ text: '    Links', role: 'strong' }]);
  if (!o.map.edges.length) lines.push([{ text: '      none a record names yet', role: 'secondary' }]);
  for (const e of o.map.edges) lines.push([{ text: `      ${e.from} ${c.g.arrow} ${e.to}  ` }, { text: e.why, role: 'secondary' }]);
  return lines;
}

/** One section in full. */
export function overviewSectionLines(o: Overview, id: OverviewSectionId | 'map', t: OverviewTextOptions): Line[] {
  const c: Ctx = { g: t.glyphs, sep: ` ${t.glyphs.sep} `, link: t.link ?? ((rel: string) => rel) };
  switch (id) {
    case 'needs': return needsLines(o.needs, c);
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
  const ids: Array<OverviewSectionId | 'map'> = v.view === 'all' ? [...OVERVIEW_SECTIONS, 'map'] : [v.id];
  const lines: Line[] = [[{ text: `  God's Eye View  ${o.project.name}${` ${t.glyphs.sep} `}as of ${stamp(o.as_of)}`, role: 'strong' }]];
  for (const id of ids) lines.push(...overviewSectionLines(o, id, t));
  lines.push([{ text: `  ${SECTION_TITLE.needs} first: /overview${` ${t.glyphs.sep} `}the board's Overview: /board live`, role: 'secondary' }]);
  return lines;
}
