/**
 * R5 (H134): tab 9, Tools & MCP (src/workbench/tools-tab.ts), over REAL MCP call records: each kept by the REPL's own
 * writer (src/connectors/mcp-records.ts writeMcpCall) and sealed by the real appendReceipt in the project's own store. The
 * calls' facts are FAKE (no MCP server was started and no route ran: each says so). The capability rows are the routes'
 * own builder (src/connectors/mcp-cli.ts mcpCapabilityRows: file checks only) and FAKE rows in /tools' shape (labelled).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { mcpCapabilityRows } from '../src/connectors/mcp-cli.js';
import { writeMcpCall, type McpCallFacts } from '../src/connectors/mcp-records.js';
import { appendReceipt, readChain, receiptsPath, type ReceiptInput } from '../src/utils/receipts.js';
import { glyphsFor, innerWidth } from '../src/workbench/frame.js';
import { bodyKind, layoutFor } from '../src/workbench/layout.js';
import type { Lazy } from '../src/workbench/model.js';
import { COLUMNS_FROM } from '../src/workbench/tab-columns.js';
import { lineCells, plain, type Line, type Role } from '../src/workbench/text.js';
import { MCP_ROUTES, mcpCallInspector, readTools, TOOLS_LIST, toolsView, type ToolsData, type ToolsItem, type ToolsSearch } from '../src/workbench/tools-tab.js';
import { FROM_PAGE } from '../src/mcp/call-views.js';

const boxes: string[] = [];
afterAll(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const g = glyphsFor(true);
const SIZES = [[160, 45], [120, 40], [100, 30]] as const;

/** The body's inner size at a terminal size, as the Workbench lays this tab out (src/workbench/layout.ts OWN_COLUMNS: the
 *  whole width at every size, Context the [i] drawer). */
function bodyAt(columns: number, rows: number): { width: number; height: number } {
  const l = layoutFor({ columns, rows, body: bodyKind(false, 'tools') });
  return { width: innerWidth(l.center!.w), height: l.center!.h - 2 };
}
const ctxAt = (columns: number, rows: number, cursor = 0) => ({ ui: { cursor: { [TOOLS_LIST]: cursor } }, g, ...bodyAt(columns, rows), now: Date.now(), columns });
const LIST: ToolsSearch = { typing: false, text: '', query: '', focused: true };
const text = (lines: readonly Line[]): string => lines.map(plain).join('\n');
function words(lines: readonly Line[]): string {
  const cols: string[][] = [];
  for (const l of lines) plain(l).split(' │ ').forEach((part, i) => { (cols[i] ??= []).push(part.trim()); });
  return cols.map((c) => c.filter(Boolean).join(' ').replace(/\s+/g, ' ')).join('\n');
}
const rolesOf = (lines: readonly Line[], re: RegExp): Role[] => lines.flat().filter((s) => re.test(s.text)).map((s) => s.role ?? 'text');
const greens = (lines: readonly Line[]): string[] => lines.flat().filter((s) => s.role === 'live').map((s) => s.text);
const env = (): NodeJS.ProcessEnv => { const e = { ...process.env }; delete e.TIMMY_STORE; return e; };

/** The routes' own rows (file checks only) and FAKE rows in /tools' shape: one with its command in its name, many more so
 *  the list is longer than any body here. */
function capsOf(): Lazy<CapabilityRow[]> {
  const rows: CapabilityRow[] = [
    ...(mcpCapabilityRows(env()) as CapabilityRow[]),
    { id: 'fake-quartz', kind: 'tool', name: 'FAKE quartz press', rung: 'installed', detail: 'FAKE: a row in /tools\' shape' },
    { id: 'fake-observe', kind: 'tool', name: 'FAKE observer (/observe)', rung: 'needs setup', detail: 'FAKE: python3 is not on PATH', setup: 'FAKE: install python3' },
    ...Array.from({ length: 40 }, (_, i): CapabilityRow => ({ id: `fake-${i}`, kind: 'adapter', name: `FAKE adapter ${String(i).padStart(2, '0')}`, rung: i % 3 ? 'installed' : 'needs setup', detail: 'FAKE', ...(i % 3 ? {} : { setup: 'FAKE: a step' }) })),
  ];
  return { state: 'ready', value: rows, at: Date.now() };
}

/** A FAKE call's facts (no route ran: the record says what a route would have said). */
function facts(o: Partial<McpCallFacts> & Pick<McpCallFacts, 'route' | 'tool' | 'outcome'>): McpCallFacts {
  const body = Buffer.from(JSON.stringify({ content: [{ type: 'text', text: `FAKE ${o.tool}` }], isError: o.outcome !== 'answered' }));
  const at = new Date().toISOString();
  return {
    server: { name: 'node fake-server.js', transport: 'stdio' }, args: { text: 'FAKE' }, startedAt: at, endedAt: at, ms: 42, called: true, isError: o.outcome !== 'answered',
    output: { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), kept: body, truncated: false }, annotations: null, notes: ['FAKE: no MCP server ran; a test wrote this record'], ...o,
  };
}

/** A project with three calls: two on the SDK route (answered, failed) and one on mcporter (a configured remote server). */
function project(withCalls = true): { root: string; ids: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-tools-')));
  boxes.push(root);
  const seal = (input: ReceiptInput): string => appendReceipt('runs', input, root).hash;
  const ids: Record<string, string> = {};
  if (!withCalls) return { root, ids };
  const write = (name: string, f: McpCallFacts): void => {
    const w = writeMcpCall({ root, project: 'tray', seal }, f);
    if (!w.ok) throw new Error(w.error);
    ids[name] = w.id;
  };
  write('echo', facts({ route: 'sdk', tool: 'echo', outcome: 'answered' }));
  write('boom', facts({ route: 'sdk', tool: 'boom', outcome: 'failed', error: 'FAKE: the server said no' }));
  write('list', facts({ route: 'mcporter', tool: 'list', outcome: 'answered', server: { name: 'fake-remote', transport: 'http', url: 'https://example.invalid/mcp' }, args: {} }));
  return { root, ids };
}
const read = (root: string): ToolsData => readTools({ root, chain: readChain('runs', root), env: env() });
const callAt = (d: ToolsData, rows: number, id: string): number => rows + d.calls.findIndex((c) => c.read.record.id === id);
const toolRows = (): number => (capsOf() as Extract<Lazy<CapabilityRow[]>, { state: 'ready' }>).value.length;

describe('tab 9, Tools & MCP: the reading', () => {
  it('reads the project\'s calls newest first, each with the mcp.call receipt that sealed exactly its call.json', () => {
    const p = project();
    const d = read(p.root);
    expect(d.calls.map((c) => c.read.record.tool).sort()).toEqual(['boom', 'echo', 'list']);
    for (const c of d.calls) {
      expect(c.read.check.status).toBe('verified');
      expect(c.seal).toMatchObject({ seq: expect.any(Number), hash: expect.stringMatching(/^sha256_/) });
    }
  });
});

describe('tab 9: the search, as All tools has it', () => {
  it('says / searches the tools and how to reach the workspace finder; typed words keep the tools that match; the count and [r]', () => {
    const p = project();
    const d = read(p.root);
    const wide = text(toolsView(ctxAt(160, 45), capsOf(), d, LIST, Date.now() - 5000).lines);
    expect(wide).toContain('[/] Search the tools by name, kind or what they need  · a workspace: g, then /');
    expect(wide).toMatch(new RegExp(`${toolRows()} tools · checked \\d+ s ago · \\[r\\] checks again`));
    const typing = toolsView(ctxAt(160, 45), capsOf(), d, { typing: true, text: 'quartz', query: 'quartz', focused: true, finder: 'Esc, then g, then /' }, Date.now());
    expect(text(typing.lines)).toContain('find a workspace: Esc, then g, then /  · Esc clears the search  · Enter keeps the matches');
    expect(text(typing.lines)).toMatch(/1 tool match "quartz"/);
    expect(typing.items.filter((x) => x.item.kind === 'cap').map((x) => (x.item as Extract<ToolsItem, { kind: 'cap' }>).row.name)).toEqual(['FAKE quartz press']);
    expect(text(toolsView(ctxAt(160, 45), capsOf(), d, { ...LIST, query: 'quartz' }).lines)).toContain('Matching "quartz"  · a workspace: g, then /  · [/] change the search');
    expect(text(toolsView(ctxAt(160, 45), capsOf(), d, { ...LIST, focused: false }).lines)).toContain('Search the tools: Tab to this list, then /');
  });
});

describe('tab 9: the two routes and their calls', () => {
  it('each route with its rung and its last calls (server, tool, outcome, receipt, when); a receipt "✓ verified" only as verifyReceiptIn confirms it now', () => {
    const p = project();
    const d = read(p.root);
    for (const [c, r] of SIZES) {
      const v = toolsView(ctxAt(c, r), capsOf(), d, LIST);
      const said = words(v.lines);
      expect(said).toMatch(/MCP TO CLI/);
      expect(said).toMatch(/THE SDK ROUTE (installed|needs setup)/);
      expect(said).toMatch(/THE MCPORTER ROUTE (installed|needs setup)/);
      // each call's tool, its server and its outcome's word (the server under the tool where the column is narrow)
      expect(said).toMatch(/echo( · node fake[^\n]*?)? answered( node fake-server\.js)?/);
      expect(said).toMatch(/node fake/);
      expect(said).toMatch(/list( · fake-remo[^\n]*?)? answered( fake-remote)?/);
      expect(rolesOf(v.lines, /^✕ failed$/)).toEqual(['failure']);
      // each receipt's place and verdict first (the time after it, cut where the column is narrow)
      expect(said).toMatch(/#\d+ ✓ verified/);
      for (const s of greens(v.lines)) expect(s).toBe('✓ verified');
      expect(greens(v.lines).length).toBe(3);
    }
  });

  it('a route with no call yet says so, with the exact command that makes one', () => {
    const p = project(false);
    const d = read(p.root);
    for (const [c, r] of SIZES) {
      const v = toolsView(ctxAt(c, r), capsOf(), d, LIST);
      const said = words(v.lines);
      for (const route of MCP_ROUTES) expect(said).toContain(`no call yet ${route.command}`);
      expect(rolesOf(v.lines, /^\/mcp call --route (sdk|mcporter)/).every((x) => x === 'strong')).toBe(true);
      expect(greens(v.lines)).toEqual([]);
    }
  });
});

describe('tab 9: the selected call or tool', () => {
  it('a call: its arguments, outcome and receipt, where it was made, the command that runs it again, and what the companion draws (c)', () => {
    const p = project();
    const d = read(p.root);
    const n = toolRows();
    for (const [c, r] of SIZES) {
      const v = toolsView(ctxAt(c, r, callAt(d, n, p.ids.echo)), capsOf(), d, LIST);
      const said = words(v.lines);
      expect(said).toMatch(new RegExp(`CALL ${p.ids.echo}`));
      // the arguments whole, in rows of the column's width
      expect(said.replace(/\s+/g, '')).toContain('Args{"text":"FAKE"}');
      expect(said).toMatch(/Outcome answered/);
      expect(said).toMatch(/RECEIPT #\d+ ✓ verified/);
      expect(said).toMatch(/call\.json is the bytes it sealed/);
      expect(said).toMatch(/AGAIN \/mcp call --route sdk echo \{"text":"FAKE"\} -- <server command>/);
      expect(said).toMatch(/the record names the server "node fake-server\.js", not its whole command line/);
      // R6 (H142): where it was made, as its record says (this one: not from the companion)
      expect(said).toMatch(/Made in Timmy's terminal \(\/mcp call\) or by its agent \(call_mcp_tool\)/);
      // R6 (H142): the companion's Tools & MCP inspector draws the schema form, the flame graph and images (R5 said no surface did)
      expect(said).toMatch(/A terminal draws no schema form, flame graph or image\./);
      expect(said.replace(/\s+/g, ' ')).toMatch(/\[c\] Companion( · Show)?: its tab 9, Tools & MCP, lists a server's tools with their schemas, checks a request before sending it, calls through either route, and draws each call's requests, answer and receipt\./);
      expect(said).not.toMatch(/No Timmy surface draws/);
      expect(rolesOf(v.lines, /^\[c\]$/)).toEqual(['action']);
      // a configured server: by its name
      const w = words(toolsView(ctxAt(c, r, callAt(d, n, p.ids.list)), capsOf(), d, LIST).lines);
      expect(w).toMatch(/AGAIN \/mcp call fake-remote list \{\}/);
      // a failed call: its error, amber
      const x = toolsView(ctxAt(c, r, callAt(d, n, p.ids.boom)), capsOf(), d, LIST);
      expect(words(x.lines)).toMatch(/Error FAKE: the server said no/);
      expect(rolesOf(x.lines, /^FAKE: the/)).toContain('failure');
    }
  });

  it('R6 (H142): a call made from the companion says so, and its wire trace is drawn as text: one bar per JSON-RPC request with its time', () => {
    const p = project(false);
    // FAKE: a wire trace in the tap's own lines (src/mcp/wire-tap.ts), as a call through the mcporter route leaves one:
    // MCPorter's name check (server start 1), then the call (server start 2); no server ran, the times are made up here
    const t = Date.now() - 2000;
    const trace = [
      { session: 11, seq: 0, t, kind: 'start', program: 'node' },
      { session: 11, seq: 1, t: t + 1, dir: 'to-server', bytes: 160, kind: 'request', id: 0, method: 'initialize' },
      { session: 11, seq: 2, t: t + 501, dir: 'to-client', bytes: 220, kind: 'result', id: 0, method: 'initialize' },
      { session: 11, seq: 3, t: t + 502, dir: 'to-server', bytes: 40, kind: 'request', id: 1, method: 'tools/list' },
      { session: 11, seq: 4, t: t + 505, dir: 'to-client', bytes: 3000, kind: 'result', id: 1, method: 'tools/list' },
      { session: 11, seq: 5, t: t + 520, kind: 'end', exit: { code: 0, signal: null } },
      { session: 12, seq: 0, t: t + 600, kind: 'start', program: 'node' },
      { session: 12, seq: 1, t: t + 601, dir: 'to-server', bytes: 160, kind: 'request', id: 0, method: 'initialize' },
      { session: 12, seq: 2, t: t + 1101, dir: 'to-client', bytes: 220, kind: 'result', id: 0, method: 'initialize' },
      { session: 12, seq: 3, t: t + 1102, dir: 'to-server', bytes: 120, kind: 'request', id: 1, method: 'tools/call' },
      { session: 12, seq: 4, t: t + 1112, dir: 'to-client', bytes: 90, kind: 'result', id: 1, method: 'tools/call' },
      { session: 12, seq: 5, t: t + 1130, kind: 'end', exit: { code: 0, signal: null } },
    ].map((l) => JSON.stringify({ v: 1, ...l })).join('\n');
    const w = writeMcpCall({ root: p.root, project: 'tray', seal: (input: ReceiptInput): string => appendReceipt('runs', input, p.root).hash }, {
      ...facts({ route: 'mcporter', tool: 'fake_measure', outcome: 'answered', server: { name: 'node fake-fixture-server.js', transport: 'stdio' }, args: { width_mm: 120, height_mm: 80 } }),
      notes: [FROM_PAGE, 'FAKE: no MCP server ran; a test wrote this record'],
      wire: { kept: Buffer.from(`${trace}\n`), frames: 8, sessions: 2 },
    });
    if (!w.ok) throw new Error(w.error);
    const d = read(p.root);
    expect(d.calls.length).toBe(1);
    expect(d.calls[0].fromPage).toBe(true);
    expect(d.calls[0].wire).toMatchObject({ sessions: 2, check: 'matches' });
    expect(d.calls[0].wire!.spans.map((s) => [s.method, s.ms])).toEqual([['initialize', 500], ['tools/list', 3], ['initialize', 500], ['tools/call', 10]]);
    const n = toolRows();
    for (const [c, r] of SIZES) {
      // the call's row says it was made in the companion, after its receipt; a narrow column cuts the time first
      expect(words(toolsView(ctxAt(c, r), capsOf(), d, LIST).lines)).toMatch(/#\d+ ✓ verified · companion( · \d\d:\d\d(:\d\d)?|…)/);
      if (c >= 160) expect(words(toolsView(ctxAt(c, r), capsOf(), d, LIST).lines)).toMatch(/#\d+ ✓ verified · companion · \d\d:\d\d(:\d\d)?/);
      const v = toolsView(ctxAt(c, r, callAt(d, n, w.id)), capsOf(), d, LIST);
      const said = words(v.lines);
      expect(said).toMatch(/Made in the companion \(tab 9, Tools & MCP\), through its wire tap/);
      expect(said).toMatch(/WIRE each JSON-RPC request, as the wire tap timed it/);
      expect(said).toMatch(/server start 1 \(MCPorter checks the tool's name\) initialize ▬+ 500 ms tools\/list ▬+ 3\.0 ms server start 2 \(the call\) initialize ▬+ 500 ms tools\/call ▬+ 10 ms/);
      expect(said).toMatch(/the server is Timmy's FAKE fixture \(every answer made up\): the companion's tab 9 copies the whole line, its command line included/);
      // the longest request's bar is the longest; the bars are structure, never green
      const bars = v.lines.flat().filter((s) => /^▬+$/.test(s.text));
      expect(bars.map((s) => s.role)).toEqual(['secondary', 'secondary', 'secondary', 'secondary']);
      expect(bars[0].text.length).toBeGreaterThan(bars[1].text.length);
      expect(bars[1].text.length).toBeLessThanOrEqual(bars[3].text.length);
      for (const s of greens(v.lines)) expect(s).toBe('✓ verified');
    }
  });

  it('a tool: its rung with what it means, its step, the command its row names, and how to see it in full', () => {
    const p = project();
    const d = read(p.root);
    const caps = capsOf();
    const k = (caps as Extract<typeof caps, { state: 'ready' }>).value.filter((x) => x.kind === 'tool').findIndex((x) => x.id === 'fake-observe');
    for (const [c, r] of SIZES) {
      const said = words(toolsView(ctxAt(c, r, k), caps, d, LIST).lines);
      // beside the list the detail says what the tool is; stacked, it is under the tool's own row (its name and rung)
      expect(said).toMatch(c >= COLUMNS_FROM ? /TOOL · an agent tool FAKE observer \(\/observe\)/ : /▸ FAKE observer \(\/observe\) needs setup do: FAKE: install python3 Rung needs setup/);
      expect(said).toMatch(/Rung needs setup: Timmy has the code; do the step/);
      expect(said).toMatch(/Step FAKE: install python3/);
      expect(said).toMatch(/Run it \/observe/);
      expect(said).toMatch(/In full \/tools FAKE observer/);
    }
  });

  it('a call.json changed after its receipt, and a receipt changed in the store: each said, amber; nothing green that does not verify', () => {
    const p = project();
    const call = join(p.root, '.timmy', 'mcp', p.ids.echo, 'call.json');
    writeFileSync(call, readFileSync(call, 'utf8').replace('"echo"', '"echo2"'));
    const d = read(p.root);
    const n = toolRows();
    const v = toolsView(ctxAt(160, 45, callAt(d, n, p.ids.echo)), capsOf(), d, LIST);
    expect(words(v.lines)).toMatch(/✕ call\.json changed after its receipt sealed it/);
    expect(rolesOf(v.lines, /✕ call\.json changed/)).toContain('failure');
    const store = receiptsPath('runs', p.root);
    const lines = readFileSync(store, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.includes('"kind":"mcp.call"') && l.includes(p.ids.boom));
    lines[at] = lines[at].replace(p.ids.boom, p.ids.boom.replace(/.$/, (x) => (x === '0' ? '1' : '0')));
    writeFileSync(store, lines.join('\n'));
    const e = read(p.root);
    const w = toolsView(ctxAt(160, 45, callAt(e, n, p.ids.boom)), capsOf(), e, LIST);
    expect(rolesOf(w.lines, /^✕ does not verify$/).length).toBeGreaterThan(0);
    expect(rolesOf(w.lines, /^✕ does not verify$/).every((x) => x === 'failure')).toBe(true);
  });
});

describe('tab 9: the layout, the items and the Inspector', () => {
  it('three columns under the search from 120 columns, one body the screen scrolls; stacked below; the items tools then calls', () => {
    const p = project();
    const d = read(p.root);
    const n = toolRows();
    for (const [c, r] of SIZES) {
      const { width, height } = bodyAt(c, r);
      for (const k of [0, 1, 12, n - 1, n, n + 2]) {
        const v = toolsView(ctxAt(c, r, k), capsOf(), d, LIST);
        for (const l of v.lines) expect(lineCells(l)).toBeLessThanOrEqual(width);
        expect(v.items).toHaveLength(n + d.calls.length);
        // the list is longer than the body: the screen scrolls it (the wheel too), and says which rows show
        expect(v.lines.length).toBeGreaterThan(height);
        expect(v.lines.flat().filter((s) => s.selected && s.text.trim()).every((s) => s.role !== 'secondary' && s.role !== 'border')).toBe(true);
        const tools = v.items.slice(0, n);
        // a tool is clicked by its row, at every size
        for (const x of tools) expect(x.line).toBeGreaterThanOrEqual(0);
        if (k < n) expect(plain(v.lines[v.items[k].line])).toContain('▸ ');
        if (c >= COLUMNS_FROM) {
          expect(plain(v.lines[3])).toMatch(/│/);
          // a call is reached with the keys there (a click on its row would land on the tool beside it)
          expect(v.items.slice(n).every((x) => x.line === -1)).toBe(true);
          // the selected tool and its detail beside it are one span the screen keeps in view
          if (k < n) expect(v.items[k].rows ?? 1).toBeGreaterThan(1);
        } else {
          expect(v.items.slice(n).every((x) => x.line >= 0)).toBe(true);
          if (k >= n) expect(plain(v.lines[v.items[k].line])).toContain('▸ ');
        }
      }
    }
  });

  it('a call\'s Inspector detail: every field, its arguments whole, its receipt verified now, and the output as printed', () => {
    const p = project();
    const d = read(p.root);
    const n = toolRows();
    const v = toolsView(ctxAt(160, 45, callAt(d, n, p.ids.echo)), capsOf(), d, LIST);
    const item = v.items[callAt(d, n, p.ids.echo)].item as Extract<ToolsItem, { kind: 'mcp-call' }>;
    const t = text(mcpCallInspector(item, d, 50, g)).replace(/\s+/g, ' ');
    expect(t).toMatch(new RegExp(`Record \\.timmy/mcp/${p.ids.echo}/call\\.json`));
    expect(t).toMatch(/✓ verified/);
    expect(t).toMatch(/OUTPUT · as the route printed it/);
    expect(t).toMatch(/FAKE echo/);
    expect(t).toMatch(/FAKE: no MCP server ran; a test wrote this record/);
  });

  it('reads only and asks no network: no file changes, no fetch, while reading and drawing', () => {
    const p = project();
    const files = (dir: string): string => readdirSync(dir, { recursive: true }).map((x) => { const f = join(dir, String(x)); const s = statSync(f); return `${f} ${s.size} ${s.mtimeMs}`; }).sort().join('\n');
    const before = files(p.root);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = read(p.root);
    for (const [c, r] of SIZES) for (const k of [0, 3, toolRows(), toolRows() + 1]) toolsView(ctxAt(c, r, k), capsOf(), d, LIST);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(files(p.root)).toBe(before);
  });
});
