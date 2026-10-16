/**
 * R5 (H134): the body of tab 9, Tools & MCP (src/contracts/workspace.ts TABS: "every capability with its rung, both MCP-to-CLI
 * routes, REA, and public templates"), laid out as the operator's references 08 and 17 lay theirs out, in words:
 *
 *   the search   / searches the tools (the All tools search, its words and keys unchanged: src/workbench/controller.ts)
 *   TOOLS        every capability with its rung (src/capabilities, as /tools has them), by kind; one that needs setup with
 *                its step
 *   MCP TO CLI   the two routes, the SDK route and mcporter: each with its rung, and its last calls from the project's MCP
 *                call records (.timmy/mcp/<id>/call.json, src/connectors/mcp-records.ts readMcpCalls): server, tool, outcome,
 *                when, and its receipt, "✓ verified" only when verifyReceiptIn passes in this reading; "no call yet" with the
 *                exact command where there is none
 *   DETAIL       the selected tool or call: a call's arguments, outcome and receipt, where it was made, and the command that
 *                runs it again; a tool's rung and step; and what the companion draws that a terminal does not (c)
 *
 * R6 (H142): the calls are the same records the companion's Tools & MCP inspector makes and reads (src/mcp/inspector.ts): a
 * call made there says so ("from the companion"), and its wire trace (wire.ndjson, Timmy's wire tap: src/mcp/wire-tap.ts) is
 * drawn here as text, one bar per JSON-RPC request with its measured time; the schema form, the flame graph and images are
 * the companion's (c, then its tab 9).
 *
 * From 120 columns the three sit side by side under the search, as one body the screen scrolls (the list is long; the wheel
 * scrolls it, and the screen says which rows show), the selected tool's detail beside it; below that they stack. readTools
 * reads files only: no route runs, no server starts, nothing is asked over the network.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { CapabilityRow } from '../capabilities/index.js';
import type { McpRouteId } from '../connectors/mcp-cli.js';
import { answerLines, mcpWireRel, readMcpCalls, readRouteAnswer, type McpCallRead } from '../connectors/mcp-records.js';
import { FROM_PAGE, fixtureServer, isFixtureLabel, wireView, type WireSpan } from '../mcp/call-views.js';
import { humanBytes, projectId, resolveInside } from '../project/index.js';
import { scrubHomes } from '../utils/home-scrub.js';
import type { Receipt } from '../utils/receipts.js';
import type { Glyphs } from './frame.js';
import type { Lazy } from './model.js';
import { fieldRows, heading, limitRows, onBar, para, S, selectedIn, sideBySide, sideBySideAt, RULE_CELLS, widths, type TabCtx, type TabView } from './tab-columns.js';
import { capDetail, capItem, capRows, checkReceipt, inViewRows, lazyRows, verdictSegs, type CapItem, type ReceiptVerdict } from './tab-parts.js';
import { clock, count, fit, lineCells, pick, spread, type Line, type Role, type Seg } from './text.js';

type Env = Record<string, string | undefined>;

/** The Workbench list the tab's selection is kept in: All tools' own (its search resets it: src/workbench/controller.ts). */
export const TOOLS_LIST = 'center:tools';
/** How many of the project's newest MCP calls are read. */
export const CALLS_READ = 16;

/** The two routes, in the order the tab names them, with the capability row each is (src/connectors/mcp-cli.ts). */
export const MCP_ROUTES: ReadonlyArray<{ id: McpRouteId; cap: string; title: string; command: string }> = [
  { id: 'sdk', cap: 'mcp-cli:sdk', title: 'The SDK route', command: '/mcp call --route sdk <tool> {json} -- <server command>' },
  { id: 'mcporter', cap: 'mcp-cli:mcporter', title: 'The mcporter route', command: '/mcp call --route mcporter <tool> {json} -- <server command>' },
];

// ── the reading ────────────────────────────────────────────────────────────────

export interface McpCallRow {
  /** the record as readMcpCalls read it (its strings with the project as "." and home folders as "~"), and whether a
   *  `mcp.call` receipt of this project sealed exactly its call.json */
  read: McpCallRead;
  /** that receipt, by its place on the chain */
  seal?: { hash: string; seq: number; ts: string };
  /** R6 (H142): made from the browser companion's Tools & MCP tab (its record's own note) */
  fromPage?: true;
  /** R6 (H142): its JSON-RPC requests as the wire tap timed them (wire.ndjson), when it went through one; times only */
  wire?: { spans: WireSpan[]; sessions: number; check: 'matches' | 'differs' };
}

export interface ToolsData {
  /** when this reading was made (ISO) */
  at: string;
  root: string;
  /** the project's newest calls, newest first */
  calls: McpCallRow[];
  /** calls not read */
  more: number;
  receipts: readonly Receipt[];
  checks: Map<string, ReceiptVerdict>;
}

export interface ToolsReadInput { root: string; chain: readonly Receipt[]; env?: Env; now?: number }

function scrubDeep<T>(v: T, scrub: (t: string) => string): T {
  if (typeof v === 'string') return scrub(v) as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, scrub)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, scrub)])) as T;
  return v;
}

/** The tab's reading: the project's newest MCP calls, each with the receipt that sealed it. Files only. */
export function readTools(i: ToolsReadInput): ToolsData {
  const env = i.env ?? process.env;
  const root = i.root;
  const scrub = (t: string): string => scrubHomes(t.split(root).join('.'), env as NodeJS.ProcessEnv);
  const pid = projectId(root);
  const { list, more } = readMcpCalls(root, i.chain, CALLS_READ);
  const calls = list.map((read): McpCallRow => {
    let seal: McpCallRow['seal'];
    for (let k = i.chain.length - 1; k >= 0 && !seal; k--) {
      const r = i.chain[k];
      if (r.kind === 'mcp.call' && r.project_id === pid && r.outputs?.[0]?.path === read.call) seal = { hash: r.hash, seq: k + 1, ts: r.ts };
    }
    const rec = read.record;
    const wire = rec.wire_file === 'wire.ndjson' ? readWire(root, rec.id, rec.wire_sha256, rec.started_at, rec.ended_at) : undefined;
    return { read: scrubDeep(read, scrub), ...(seal ? { seal } : {}), ...((rec.notes ?? []).some((n) => n.startsWith(FROM_PAGE)) ? { fromPage: true as const } : {}), ...(wire ? { wire } : {}) };
  });
  return { at: new Date(i.now ?? Date.now()).toISOString(), root, calls, more, receipts: i.chain, checks: new Map() };
}

/** R6 (H142): a call's wire trace, read for its requests' times only (no frame's text reaches the terminal), checked against
 *  the sha256 its record names. */
function readWire(root: string, id: string, sha: string | undefined, startedAt: string, endedAt: string): McpCallRow['wire'] | undefined {
  const at = resolveInside(root, mcpWireRel(id));
  if ('error' in at) return undefined;
  try {
    if (statSync(at.path).size > 512 * 1024) return undefined;
    const bytes = readFileSync(at.path);
    const t0 = Date.parse(startedAt);
    const t1 = Date.parse(endedAt);
    const v = wireView(bytes.toString('utf8'), Number.isNaN(t0) ? 0 : t0, Number.isNaN(t1) ? 0 : t1);
    return { spans: v.spans, sessions: v.sessions.length, check: sha && createHash('sha256').update(bytes).digest('hex') === sha ? 'matches' : 'differs' };
  } catch { return undefined; }
}

export const callReceiptVerdict = (d: ToolsData, hash: string): ReceiptVerdict => checkReceipt(d.receipts, d.checks, hash);

// ── the items ──────────────────────────────────────────────────────────────────

/** The tab's selectable rows: a tool (first, as All tools lists them: its search keeps its place), then a call. */
export type ToolsItem = CapItem | { kind: 'mcp-call'; key: string; call: McpCallRow };

export const toolsItemName = (item: ToolsItem): string => (item.kind === 'mcp-call' ? `MCP call ${item.call.read.record.id} (${item.call.read.record.tool})` : item.row.name.trim());
export const toolsItemOperation = (item: ToolsItem): string | null => (item.kind === 'mcp-call' ? item.call.read.record.operation ?? null : null);

// ── the view ───────────────────────────────────────────────────────────────────

/** All tools' search as the Workbench holds it (src/workbench/views.ts passes it in). */
export interface ToolsSearch {
  /** the search field has the keyboard */
  typing: boolean;
  /** what is typed */
  text: string;
  /** the words searched: typed, or kept after Enter */
  query: string;
  /** the body's list has the keyboard */
  focused: boolean;
  /** the way to the workspace finder while / searches the tools (src/workbench/views.ts finderKeys) */
  finder?: string;
}

const KINDS = ['surface', 'model', 'tool', 'harness', 'adapter', 'vox'] as const;
const TITLES: Readonly<Record<string, string>> = { surface: 'Where you work', model: 'Models', tool: 'Agent tools', harness: 'Other agents', adapter: 'Native apps and adapters', vox: 'VoxVision' };

const ago = (t: number | undefined, now: number): string => {
  if (t === undefined || !Number.isFinite(t)) return 'at an unknown time';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const key = (k: string): Seg => S(`[${k}]`, 'action');

/** The search's rows, as All tools has said them (src/workbench/views.ts, R4 H112 and R5 H131): the words and keys unchanged. */
function searchRows(s: ToolsSearch, w: number, g: Glyphs): Line[] {
  if (s.typing) {
    return [
      [S('Search: ', 'secondary'), S(s.text, 'text'), S(' ', 'text', { inverse: true })],
      [S('  '), ...pick([[S(`find a workspace: ${s.finder ?? '/'}`, 'secondary')], [S('Esc', 'action'), S(' clears the search', 'secondary')], [S('Enter keeps the matches', 'secondary')]], Math.max(0, w - 2), S(`  ${g.sep} `, 'secondary'))],
    ];
  }
  if (!s.focused) return [[S(s.query ? `Matching "${s.query}"  ${g.sep} ` : '', 'secondary'), S('Search the tools: Tab to this list, then /', 'secondary')]];
  if (s.query) return [pick([[S('Matching ', 'secondary'), S(`"${s.query}"`, 'strong')], [S('a workspace: g, then /', 'secondary')], [key('/'), S(' change the search', 'secondary')]], w, S(`  ${g.sep} `, 'secondary'))];
  const long: Line = [key('/'), S(' Search the tools by name, kind or what they need', 'secondary'), S(`  ${g.sep} a workspace: g, then /`, 'secondary')];
  return [lineCells(long) <= w ? long : [key('/'), S(' Search the tools', 'secondary'), S(`  ${g.sep} a workspace: g, then /`, 'secondary')]];
}

/** The tools the search keeps (every word in a row's name, id, kind, rung, state or step), in All tools' order. */
export function matching(rows: readonly CapabilityRow[], query: string): CapabilityRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kept = words.length ? rows.filter((r) => words.every((w) => `${r.name} ${r.id} ${r.kind} ${r.rung} ${r.detail} ${r.setup ?? ''}`.toLowerCase().includes(w))) : [...rows];
  return KINDS.flatMap((k) => kept.filter((r) => r.kind === k));
}

const OUTCOME: Readonly<Record<string, { role: Role; glyph?: 'fail' | 'warn' }>> = {
  answered: { role: 'text' }, failed: { role: 'failure', glyph: 'fail' }, 'needs authorization': { role: 'attention', glyph: 'warn' }, stopped: { role: 'secondary' },
};
const outcomeSeg = (o: string, g: Glyphs, sel: { selected?: true } = {}): Seg => {
  const x = OUTCOME[o] ?? { role: 'secondary' as Role };
  return S(`${x.glyph === 'fail' ? `${g.fail} ` : x.glyph === 'warn' ? `${g.warn} ` : ''}${o}`, x.role, sel);
};

/** A call's receipt in a few words: its place and whether it verifies now; whether call.json is still the bytes it sealed. */
function receiptSegs(c: McpCallRow, d: ToolsData, g: Glyphs, short: boolean): Seg[] {
  if (!c.seal) return [S('not sealed', 'secondary')];
  const v = callReceiptVerdict(d, c.seal.hash);
  const bytes = c.read.check.status === 'verified' ? [] : [S(` ${g.sep} `, 'secondary'), S(`${g.fail} ${c.read.check.reason}`, 'failure')];
  return [S(`#${c.seal.seq} `, 'secondary'), ...(short ? [v.ok ? S(`${g.ok} verified`, 'live') : S(`${g.fail} does not verify`, 'failure')] : verdictSegs(v, g, true)), ...bytes];
}

/** One call as two rows: the server and tool with its outcome; when, how long, and its receipt. */
function callRows(c: McpCallRow, d: ToolsData, w: number, selected: boolean, g: Glyphs): Line[] {
  const r = c.read.record;
  const sel = selected ? { selected: true as const } : {};
  const mark = selected ? S(`${g.cursor} `, 'action', sel) : S('  ');
  const outcome = [outcomeSeg(r.outcome, g, sel)];
  const bar = (l: Line): Line => (selected ? onBar(l) : l);
  // the receipt's verdict first (a narrow column keeps it whole), then when and how long
  // R6 (H142): a call made from the companion says so after its receipt (before the time, which a narrow column cuts first)
  const when = fit([S('    '), ...receiptSegs(c, d, g, true), S(`${c.fromPage ? ` ${g.sep} companion` : ''} ${g.sep} ${clock(r.started_at)} ${g.sep} ${r.ms} ms`, 'secondary')], w, g.ellipsis);
  const one: Line = [mark, S(r.tool, 'strong', sel), S(` ${g.sep} ${r.server}`, 'secondary', sel)];
  if (lineCells(one) + 1 + lineCells(outcome) <= w) return [bar(spread(one, outcome, w, g.ellipsis)), when];
  // narrow: the tool and its outcome, the server under them (neither cut for the other)
  return [bar(spread([mark, S(r.tool, 'strong', sel)], outcome, w, g.ellipsis)), fit([S('    '), S(r.server, 'secondary')], w, g.ellipsis), when];
}

/** The routes and their calls: each route with its rung (its capability row), its newest `per` calls, or "no call yet" and
 *  the command that makes one. Returns the rows and where each call's block starts. */
function routeRows(caps: Lazy<CapabilityRow[]>, d: ToolsData, w: number, sel: McpCallRow | undefined, g: Glyphs, per: number): { lines: Line[]; at: Map<McpCallRow, { start: number; rows: number }> } {
  const lines: Line[] = [[S('MCP TO CLI', 'secondary', { bold: true }), S(` ${g.sep} two routes, each a command line`, 'secondary')]];
  const at = new Map<McpCallRow, { start: number; rows: number }>();
  for (const route of MCP_ROUTES) {
    const row = caps.state === 'ready' ? caps.value.find((x) => x.id === route.cap) : undefined;
    lines.push([]);
    // the route's title whole, its rung at the row's end, or under it where the two do not fit
    const title: Line = [S(route.title.toUpperCase(), 'secondary', { bold: true })];
    const rung: Line = [S(row ? row.rung : caps.state === 'ready' ? 'not listed' : 'checking', row && row.rung !== 'needs setup' ? 'text' : 'secondary')];
    if (lineCells(title) + 1 + lineCells(rung) <= w) lines.push(spread(title, rung, w, g.ellipsis));
    else lines.push(fit(title, w, g.ellipsis), spread([S('  ')], rung, w, g.ellipsis));
    if (row?.rung === 'needs setup' && row.setup) lines.push(fit([S('  do: ', 'secondary'), S(row.setup, 'text')], w, g.ellipsis));
    const calls = d.calls.filter((c) => c.read.record.route === route.id);
    if (!calls.length) {
      lines.push(fit([S('  no call yet', 'text')], w, g.ellipsis));
      lines.push(...para(route.command, w, 'strong', '  '));
      continue;
    }
    for (const c of calls.slice(0, per)) {
      const block = callRows(c, d, w, c === sel, g);
      at.set(c, { start: lines.length, rows: block.length });
      lines.push(...block);
    }
    if (calls.length > per) lines.push([S(`  and ${calls.length - per} more of the newest ${CALLS_READ}`, 'secondary')]);
  }
  if (d.more) lines.push([], ...para(`${d.more} older call${d.more === 1 ? '' : 's'} not read here (the newest ${CALLS_READ} are)`, w, 'secondary'));
  return { lines, at };
}

/** The command that runs a call again: a configured server by its name (mcporter), else the route with the server's command
 *  line, which the record does not keep (only its name). */
function againWords(c: McpCallRow): { command: string; note?: string } {
  const r = c.read.record;
  const args = JSON.stringify(r.arguments ?? {});
  if (r.route === 'mcporter' && r.transport !== 'stdio') return { command: `/mcp call ${r.server} ${r.tool} ${args}` };
  // R6 (H142): Timmy's own FAKE fixture: the companion's tab 9 gives its whole command line to copy
  if (isFixtureLabel(r.server) && fixtureServer().ok) {
    return { command: `/mcp call --route ${r.route} ${r.tool} ${args} -- <server command>`, note: 'the server is Timmy\'s FAKE fixture (every answer made up): the companion\'s tab 9 copies the whole line, its command line included' };
  }
  return {
    command: `/mcp call --route ${r.route} ${r.tool} ${args} -- <server command>`,
    note: `the record names the server "${r.server}", not its whole command line${r.route === 'mcporter' ? `; a configured one: /mcp call ${r.server} ${r.tool} ${args}` : ''}`,
  };
}

const msText = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`);

/**
 * R6 (H142): a call's JSON-RPC requests as the wire tap timed them, as text: one row per request, its bar as long as its time
 * against the longest, and its time; MCPorter's two server starts (its name check, then the call) said as such. The
 * companion draws the same as a flame graph on one time line.
 */
export function wireRows(c: McpCallRow, w: number, g: Glyphs): Line[] {
  if (!c.wire || !c.wire.spans.length) return [];
  const spans = c.wire.spans;
  const out: Line[] = [[S('WIRE', 'secondary', { bold: true })], ...para('each JSON-RPC request, as the wire tap timed it', w, 'secondary', '  ')];
  if (c.wire.check !== 'matches') out.push(...para(`${g.fail} wire.ndjson is not the bytes its record names`, w, 'failure', '  '));
  const longest = Math.max(1, ...spans.map((s) => s.ms ?? 0));
  const labelW = Math.min(14, Math.max(...spans.map((s) => s.method.length)) + 1);
  const room = Math.max(4, w - 2 - labelW - 12);
  let session: number | null = null;
  let n = 0;
  for (const s of spans) {
    if (c.wire.sessions > 1 && s.session !== session) {
      session = s.session;
      n += 1;
      out.push(...para(`server start ${n} ${n === 1 && c.read.record.route === 'mcporter' ? "(MCPorter checks the tool's name)" : '(the call)'}`, w, 'secondary', '  '));
    }
    const len = s.ms === null ? 0 : Math.max(1, Math.round((s.ms / longest) * room));
    out.push(fit([S(`  ${s.method.padEnd(labelW)}`, 'text'), S((g.unicode ? '▬' : '=').repeat(len), 'secondary'), S(` ${s.ms === null ? 'no answer seen' : msText(s.ms)}`, s.error ? 'failure' : 'text')], w, g.ellipsis));
  }
  return out;
}

/** A selected call's detail: its server and route, where it was made, its arguments, its outcome and output, its receipt
 *  (verified now or not), its wire trace as text (R6 H142), the command that runs it again, and what the companion draws. */
export function callDetail(c: McpCallRow, d: ToolsData, w: number, g: Glyphs, full = false, o: { limit?: boolean } = {}): Line[] {
  const r = c.read.record;
  const route = MCP_ROUTES.find((x) => x.id === r.route);
  const out: Line[] = [[S('CALL ', 'secondary', { bold: true }), S(r.id, 'strong')]];
  out.push(fit([outcomeSeg(r.outcome, g), S(` ${g.sep} ${clock(r.started_at)} ${g.sep} ${r.ms} ms`, 'secondary')], w, g.ellipsis));
  const f = (label: string, value: string, role: Role = 'text'): void => { out.push(...fieldRows(label, value, w, role, 8)); };
  f('Server', `${r.server} ${g.sep} ${r.transport}${r.url ? ` ${g.sep} ${r.url}` : ''}`);
  f('Tool', r.tool, 'strong');
  f('Route', route ? route.title.toLowerCase() : r.route, 'secondary');
  // R6 (H142): where it was made, as its record says
  f('Made', c.fromPage ? 'in the companion (tab 9, Tools & MCP), through its wire tap' : 'in Timmy\'s terminal (/mcp call) or by its agent (call_mcp_tool)', 'secondary');
  // the arguments as JSON, broken into rows of the column's width (a JSON string has no spaces to wrap at), never cut short
  // of 400 characters (the Inspector: whole)
  const args = JSON.stringify(r.arguments ?? {});
  const shown = full || args.length <= 400 ? args : `${args.slice(0, 399)}…`;
  const room = Math.max(8, w - 9);
  const chunks = Array.from({ length: Math.ceil(shown.length / room) || 1 }, (_, i) => shown.slice(i * room, (i + 1) * room));
  out.push([S('Args'.padEnd(8), 'secondary'), S(' '), S(chunks[0], 'text')], ...chunks.slice(1).map((x): Line => [S(' '.repeat(9)), S(x, 'text')]));
  f('Outcome', `${r.outcome}${r.isError === true ? ' (the server said isError)' : r.isError === false ? '' : ' (no answer read)'}`, OUTCOME[r.outcome]?.role ?? 'text');
  if (r.error) f('Error', r.error, 'failure');
  f('Output', r.output_file ? `${humanBytes(r.output_bytes)}${r.truncated ? ', the first part kept' : ''} ${g.sep} output.json ${c.read.outputCheck ?? 'not read'}` : 'none kept', c.read.outputCheck === 'differs' || c.read.outputCheck === 'missing' ? 'failure' : 'secondary');
  if (r.operation) f('Operation', r.operation, 'secondary');
  out.push([S('RECEIPT', 'secondary', { bold: true })]);
  if (!c.seal) out.push(...para(c.read.check.status === 'unverified' ? `not sealed: ${c.read.check.reason}` : 'not sealed', w, 'secondary', '  '));
  else {
    out.push(fit([S(`  #${c.seal.seq} `, 'secondary'), ...verdictSegs(callReceiptVerdict(d, c.seal.hash), g, w < 60)], w, g.ellipsis));
    out.push(...para(c.read.check.status === 'verified' ? 'call.json is the bytes it sealed' : `${g.fail} ${c.read.check.reason}`, w, c.read.check.status === 'verified' ? 'secondary' : 'failure', '  '));
  }
  out.push(...wireRows(c, w, g));
  const again = againWords(c);
  out.push([S('AGAIN', 'secondary', { bold: true })], ...para(again.command, w, 'strong', '  '));
  if (again.note) out.push(...para(again.note, w, 'secondary', '  '));
  if (o.limit !== false) out.push(...notDrawn(w, g));
  return out;
}

/** What a terminal does not draw for this tab, and where it is drawn: R6 (H142) the companion's Tools & MCP inspector (c, then
 *  its key 9). R5 (H131) said no surface drew a schema view or a call graph; the companion draws both now. */
export const TOOLS_NOT_HERE = 'A terminal draws no schema form, flame graph or image.';
export const TOOLS_IN_COMPANION = 'its tab 9, Tools & MCP, lists a server\'s tools with their schemas, checks a request before sending it, calls through either route, and draws each call\'s requests, answer and receipt';
function notDrawn(w: number, g: Glyphs): Line[] {
  return limitRows(TOOLS_NOT_HERE, { c: TOOLS_IN_COMPANION }, w, g);
}

/** A tool's detail for the body: its capability detail, the command its row names (its own words: "(/observe)"), and the
 *  command that shows it in full. */
function toolDetail(r: CapabilityRow, w: number, g: Glyphs, titled = true): Line[] {
  const own = /\((\/[a-z][^)]*)\)/.exec(r.name)?.[1];
  return [...capDetail(r, w, g, titled), ...(own ? fieldRows('Run it', own, w, 'strong', 8) : []), ...fieldRows('In full', `/tools ${r.name.trim().replace(/\s*\(.*$/, '')}`, w, 'secondary', 8), ...notDrawn(w, g)];
}

/**
 * Tab 9's body: the search, then the tools, the two routes with their calls, and the selected row's detail: side by side from
 * 120 columns as one body the screen scrolls (the tools' rows are the clickable ones; the calls are reached with the keys,
 * their detail at the column's top), stacked below with the detail under the selected row. The items are the tools the
 * search keeps, then the calls, in that order at every size.
 */
export function toolsView(c: TabCtx, caps: Lazy<CapabilityRow[]>, d: ToolsData | undefined, s: ToolsSearch, checkedAt?: number): TabView<ToolsItem> {
  const { g, width: W, height: H } = c;
  const lines: Line[] = searchRows(s, W, g);
  const wait = lazyRows(caps, 'Timmy\'s tools', W, c.now);
  if (wait) return { lines: [...lines, ...wait], items: [] };
  const rows = matching((caps as Extract<typeof caps, { state: 'ready' }>).value, s.query);
  const calls = d?.calls ?? [];
  const all: ToolsItem[] = [...rows.map(capItem), ...calls.map((call): ToolsItem => ({ kind: 'mcp-call', key: `mcp:${call.read.record.id}`, call }))];
  const sel = selectedIn(c.ui, TOOLS_LIST, all.length);
  const picked = sel >= 0 ? all[sel] : undefined;
  const selCall = picked?.kind === 'mcp-call' ? picked.call : undefined;
  const items: TabView<ToolsItem>['items'] = all.map((item) => ({ line: -1, item }));
  const q = s.query.trim();
  lines.push([S(`${count(rows.length, 'tool')}${q ? ` match "${q}"` : ''} ${g.sep} checked ${ago(checkedAt, c.now)} ${g.sep} [r] checks again`, 'secondary')]);
  // the tools by kind, as All tools lists them; `at`: where each tool's block starts in the column
  const toolColumn = (w: number, detailBeside: boolean): { lines: Line[]; at: number[] } => {
    const out: Line[] = [];
    const at: number[] = [];
    let i = 0;
    for (const k of KINDS) {
      const inKind = rows.filter((r) => r.kind === k);
      if (!inKind.length) continue;
      if (out.length || !detailBeside) out.push([]);
      out.push([heading(`${TITLES[k]} (${inKind.length})`)]);
      for (const r of inKind) {
        at[i] = out.length;
        out.push(...capRows(r, w, i === sel, g));
        // stacked: the selected tool's detail under it
        if (!detailBeside && i === sel) out.push(...toolDetail(r, w - 4, g, false).map((l) => [S('    '), ...l]));
        i += 1;
      }
    }
    if (!rows.length) out.push([], ...para(q ? `No tool matches "${q}": Esc clears the search.` : 'No tool is registered here.', w));
    return { lines: out, at };
  };

  if (sideBySideAt(c)) {
    const top = lines.length;
    const [wl, wc, wr] = widths(W - 2 * RULE_CELLS, [36, 32, 32], 14);
    const left = toolColumn(wl, true);
    const centre = routeRows(caps, d ?? { at: '', root: '', calls: [], more: 0, receipts: [], checks: new Map() }, wc, selCall, g, 4);
    // the detail: beside the selected tool (the screen keeps the tool and its detail in view), or at the top for a call
    const detail = picked ? (picked.kind === 'mcp-call' ? callDetail(picked.call, d!, wr, g) : toolDetail(picked.row, wr, g)) : [];
    const from = picked?.kind === 'cap' ? left.at[sel] ?? 0 : 0;
    const right: Line[] = [...Array.from({ length: from }, (): Line => []), ...detail];
    const height = Math.max(H - top, left.lines.length, centre.lines.length, right.length);
    lines.push(...sideBySide([{ w: wl, lines: left.lines }, { w: wc, lines: centre.lines }, { w: wr, lines: right }], height, g));
    rows.forEach((_, i) => {
      // a tool's rows; the selected one with its detail beside it, so the screen scrolls to show both (on the first page, the
      // body stays at its top: the search's rows above the list)
      const own = (left.at[i + 1] ?? left.lines.length) - left.at[i];
      items[i] = { line: top + left.at[i], item: all[i], rows: i === sel ? inViewRows(top + left.at[i], Math.max(own, detail.length), H) : own };
    });
    return { lines, items };
  }

  // stacked: the tools (the selected one's detail under it), then the routes and their calls (the selected call's under it);
  // the body scrolls to the selection, and opens at its top (the search's rows) while the selection starts on the first page
  const left = toolColumn(W, false);
  const start = lines.length;
  lines.push(...left.lines);
  rows.forEach((_, i) => {
    const own = (left.at[i + 1] ?? left.lines.length) - left.at[i];
    items[i] = { line: start + left.at[i], item: all[i], rows: i === sel ? inViewRows(start + left.at[i], own, H) : own };
  });
  lines.push([]);
  const centre = routeRows(caps, d ?? { at: '', root: '', calls: [], more: 0, receipts: [], checks: new Map() }, W, selCall, g, 8);
  for (let k = 0; k < centre.lines.length; k++) {
    const call = [...centre.at.entries()].find(([, b]) => b.start === k);
    if (!call) { lines.push(centre.lines[k]); continue; }
    // a call's block, then (the selected one) its detail under it
    const [c, b] = call;
    const idx = rows.length + calls.indexOf(c);
    const more = c === selCall ? callDetail(c, d!, W - 4, g).map((l) => [S('    '), ...l]) : [];
    items[idx] = { line: lines.length, item: all[idx], rows: idx === sel ? inViewRows(lines.length, b.rows + more.length, H) : b.rows };
    lines.push(...centre.lines.slice(k, k + b.rows), ...more);
    k += b.rows - 1;
  }
  return { lines: lines.map((l) => (lineCells(l) > W ? fit(l, W, g.ellipsis) : l)), items };
}

// ── the Inspector ──────────────────────────────────────────────────────────────

/** The Inspector's rows for a selected call: every field, its arguments whole, its receipt verified now (a tool's rows are the
 *  Inspector's own `cap` case). */
export function mcpCallInspector(item: Extract<ToolsItem, { kind: 'mcp-call' }>, d: ToolsData | undefined, w: number, g: Glyphs): Line[] {
  if (!d) return [[heading('MCP call')], [S('Reading…', 'secondary')]];
  const c = item.call;
  // R6 (H142): the record's own rows first; what the companion draws closes the drawer
  const out = callDetail(c, d, w, g, true, { limit: false });
  const r = c.read.record;
  out.push(...fieldRows('Record', c.read.call, w, 'secondary'));
  if (r.annotations) out.push(...fieldRows('Hints', Object.entries(r.annotations).map(([k, v]) => `${k}: ${String(v)}`).join(', '), w, 'secondary'));
  else if (r.annotations_note) out.push(...fieldRows('Hints', r.annotations_note, w, 'secondary'));
  for (const n of (r.notes ?? []).slice(0, 4)) out.push(...para(n, w, 'secondary', '  '));
  if (c.read.outputText) {
    // the answer as the REPL reads it (src/connectors/mcp-records.ts): text items as text, JSON pretty-printed, media named
    const a = answerLines(readRouteAnswer(c.read.outputText, r.route), r.route);
    out.push([], [heading('Output'), S(` ${g.sep} as the route printed it`, 'secondary')]);
    for (const l of a.lines.slice(0, 16)) out.push(fit([S(`  ${l}`, 'text')], w, g.ellipsis));
    if (a.lines.length > 16) out.push([S(`  and ${a.lines.length - 16} more lines: ${c.read.output ?? 'output.json'}`, 'secondary')]);
    for (const n of a.notes) out.push(...para(n, w, 'secondary', '  '));
  }
  out.push([], ...notDrawn(w, g));
  return out;
}
