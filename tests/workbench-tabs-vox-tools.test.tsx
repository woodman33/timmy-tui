// R5 (H134): tab 5 (VoxVision) and tab 9 (Tools & MCP) wired into the terminal Workbench. Their keys open their bodies
// (src/workbench/voxvision-tab.ts, src/workbench/tools-tab.ts) across the whole width (src/workbench/layout.ts OWN_COLUMNS),
// Context the [i] drawer with the selected row in full; 9 again its next workspaces (REA, then Templates); each tab is read
// only while it is shown. Over a real Timmy home in a temporary folder and a project made by the starter code: a real
// VoxVision record (the REPL's /inspect of an STL: Timmy's own reader, in process) and an MCP call record kept by the REPL's
// own writer with FAKE facts (no MCP server ran, and the record says so), each sealed by the real appendReceipt in this
// test's own store. The capability rows are the real builders' (file checks only, nothing on the PATH). Nothing is asked
// over the network; no server is started.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { mcpCapabilityRows } from '../src/connectors/mcp-cli.js';
import { writeMcpCall, type McpCallFacts } from '../src/connectors/mcp-records.js';
import { createProject, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain, type ReceiptInput } from '../src/utils/receipts.js';
import { voxCapabilityRows } from '../src/vox/tools.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import type { Frame } from '../src/workbench/screen.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { cubeStl, put, settled } from './helpers/vox-fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Array<{ c: Controller; ws: Workspace }> = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-tabs-5-9-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const o of opened.splice(0)) { o.c.dispose(); await o.ws.close(); }
  vi.unstubAllEnvs();
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  return made;
}

/** The REPL's seal, made real: a receipt on this test's own chain (TIMMY_STORE, tests/isolation-setup.ts). */
const seal = (input: ReceiptInput): string => appendReceipt('runs', input).hash;

function workbench(project: { name: string; root: string; chosen: boolean }): { c: Controller; ws: Workspace } {
  const ws = new Workspace({
    glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t,
    seal, receipts: () => readChain('runs'), jobsDir, recoverAtStart: false, chdir: () => undefined,
  }, project);
  // the rows /tools makes here: VoxVision's and the two MCP routes' (file checks only; nothing is on the PATH)
  const rows = (): CapabilityRow[] => [
    ...(voxCapabilityRows({ env: {}, onPath: () => null, root: project.root }) as CapabilityRow[]),
    ...(mcpCapabilityRows(process.env) as CapabilityRow[]),
  ];
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId: () => 'FAKE', jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => rows(), tickMs: 100, slowMs: 400,
  });
  opened.push({ c, ws });
  return { c, ws };
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

/** The project's VoxVision record (an STL inspected) and an MCP call (the SDK route), both sealed. */
async function records(p: { name: string; root: string }, ws: Workspace): Promise<{ vox: string; call: string }> {
  put(p.root, 'parts/cube.stl', cubeStl(10));
  await ws.inspect('parts/cube.stl');
  await settled(ws);
  const [vox] = readdirSync(join(p.root, 'results', 'vox')).filter((n) => /^v[0-9a-f]{8}\.json$/.test(n)).map((n) => n.slice(0, -5));
  const w = writeMcpCall({ root: p.root, project: p.name, seal }, facts({ route: 'sdk', tool: 'echo', outcome: 'answered' }));
  if (!w.ok) throw new Error(w.error);
  return { vox, call: w.id };
}

/** A region's rows as text, inside its border. */
function regionRows(f: Frame, region: 'center' | 'right'): string[] {
  const rect = f.regions[region]?.rect;
  if (!rect) return [];
  const rows = screenText(f.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of rows[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out;
}

const text = (f: Frame, region: 'center' | 'right'): string => regionRows(f, region).join('\n');
/** A region's words, each of its columns' rows joined (a phrase wrapped in a narrow column reads whole): the rows split at the
 *  columns' rules; a stacked body or a drawer is one column. */
function flat(f: Frame, region: 'center' | 'right'): string {
  const cols: string[][] = [];
  for (const row of regionRows(f, region)) row.split(' │ ').forEach((part, i) => { (cols[i] ??= []).push(part.trim()); });
  return cols.map((col) => col.filter(Boolean).join(' ').replace(/\s+/g, ' ')).join('\n');
}

describe('tabs 5 and 9 in the terminal Workbench (R5 H134)', () => {
  it('5 opens VoxVision and 9 Tools & MCP across the whole width, each read only while shown; [i] has the selected row in full; 9 again: REA, then Templates', async () => {
    sandbox();
    const p = trayProject('tabs-5-9');
    const { c, ws } = workbench(p);
    const r = await records(p, ws);
    c.frame(160, 45);
    // Home reads neither tab
    expect(c.data.voxTab).toBeUndefined();
    expect(c.data.toolsTab).toBeUndefined();

    c.key('5', {});
    expect([c.ui.page, c.ui.workspace]).toEqual(['voxvision', 'voxvision']);
    expect(c.data.voxTab?.rows.map((x) => x.card.id)).toEqual([r.vox]);
    expect(c.data.toolsTab).toBeUndefined();
    await sleep(20);
    let f = c.frame(160, 45);
    // the whole width (src/workbench/layout.ts OWN_COLUMNS): no Context column beside it
    expect(f.regions.right).toBeFalsy();
    const vox = text(f, 'center');
    expect(vox).toMatch(/PIPELINE \.intent → Timmy's STL reader → [^\n]*\.receipt/);
    expect(vox).toMatch(/TOOLS +\d+ of \d+ here │ RECORDS · results\/vox +1 │ RECORD v[0-9a-f]{8}/);
    expect(vox).toContain(`▸ ${r.vox} inspect`);
    expect(vox).toMatch(/RECEIPT #\d+ · vox/);
    expect(vox).toMatch(/✓ verified \(verifyReceiptIn, now\)/);
    expect(flat(f, 'center')).toMatch(/Verdict not recorded: a VoxVision record \(timmy\.vox\/1\)/);
    // R5 (H131; the QA of e7f853e, defect 2): no Timmy surface draws it; Rerun's own viewer does; the companion has the actions
    expect(flat(f, 'center')).toContain(`No Timmy surface draws images, depth, voxels or 3D yet; Rerun's own viewer does, where it is installed (/vox view ${r.vox}).`);
    expect(flat(f, 'center')).toContain('its records do not reach the companion yet');
    // [i]: Context as a drawer, its Inspector with the record in full; [i] again closes it
    c.key('i', {});
    f = c.frame(160, 45);
    expect(text(f, 'right')).toContain(`RECORD ${r.vox}`);
    expect(flat(f, 'right')).toMatch(/TOOLS · 1 stl: timmy-stl-readback\/\d+ · in Timmy's process/);
    c.key('i', {});
    expect(c.frame(160, 45).regions.right).toBeFalsy();
    // VoxVision has one workspace (src/contracts/workspace.ts TABS): 5 again keeps it
    c.key('5', {});
    expect(c.ui.workspace).toBe('voxvision');

    c.key('9', {});
    expect([c.ui.page, c.ui.workspace]).toEqual(['tools', 'tools']);
    expect(c.data.toolsTab?.calls.map((x) => x.read.record.id)).toEqual([r.call]);
    f = c.frame(160, 45);
    expect(f.regions.right).toBeFalsy();
    const tools = text(f, 'center');
    expect(tools).toMatch(/^ \[\/\] Search the tools by name, kind or what they need {2}· a workspace: g, then \//);
    expect(tools).toMatch(/AGENT TOOLS \(3\) +│ MCP TO CLI · two routes, each a command line/);
    expect(tools).toMatch(/THE SDK ROUTE +installed │/);
    expect(tools).toMatch(/echo · node fake-server\.js +answered/);
    expect(tools).toMatch(/#\d+ ✓ verified · \d/);
    expect(tools).toMatch(/THE MCPORTER ROUTE +installed │/);
    expect(flat(f, 'center')).toContain('no call yet /mcp call --route mcporter <tool> {json} -- <server command>');
    // the keyboard on the list, End: the last row, the call, its detail at the column's top
    for (let i = 0; i < 6 && c.ui.focus !== 'center'; i++) c.key('', { tab: true });
    expect(c.ui.focus).toBe('center');
    c.key('', { end: true });
    f = c.frame(160, 45);
    const call = flat(f, 'center');
    expect(call).toContain(`CALL ${r.call}`);
    expect(call).toContain('Args {"text":"FAKE"}');
    expect(call).toMatch(/#\d+ ✓ verified \(verifyReceiptIn, now\) call\.json is the bytes it sealed/);
    expect(call).toContain('AGAIN /mcp call --route sdk echo {"text":"FAKE"} -- <server command>');
    // R6 (H142): what a terminal does not draw, and the companion's tab 9 that does (R5 said no surface did)
    expect(call).toMatch(/A terminal draws no schema form, flame graph or image\. \[c\] Companion( · Show)?: press 9 there: its Tools & MCP inspector lists a server's tools with their schemas/);
    // [i]: the Inspector has the call
    c.key('i', {});
    f = c.frame(160, 45);
    expect(text(f, 'right')).toContain(`CALL ${r.call}`);
    expect(flat(f, 'right')).toContain('Record .timmy/mcp/');
    c.key('i', {});
    // / searches the tools from their list (the All tools search: its words and keys); Enter keeps the matches
    c.key('/', {});
    expect(c.ui.input.field).toBe('tools');
    c.key('stl', {});
    expect(text(c.frame(160, 45), 'center')).toMatch(/^ Search: stl/);
    c.key('', { return: true });
    await sleep(20);
    expect(c.ui.toolsQuery).toBe('stl');
    f = c.frame(160, 45);
    expect(text(f, 'center')).toMatch(/^ Matching "stl" {2}· a workspace: g, then \/ {2}· \[\/\] change the search/);
    expect(text(f, 'center')).toMatch(/\d+ tools? match "stl"/);
    expect(text(f, 'center')).toContain('Timmy\'s STL reader');
    expect(text(f, 'center')).not.toContain('MCP servers (/mcp)');
    // the same key again: REA, then Templates, then back
    c.key('9', {});
    expect([c.ui.page, c.ui.workspace]).toEqual(['tools', 'rea']);
    c.key('9', {});
    expect(c.ui.workspace).toBe('templates');
    c.key('9', {});
    expect(c.ui.workspace).toBe('tools');

    // each is read with the slow reading only while it is shown: away from tab 5, its reading is not made again
    const vBefore = c.data.voxTab?.at;
    const tBefore = c.data.toolsTab?.at;
    await sleep(20);
    c.readAll();
    expect(c.data.voxTab?.at).toBe(vBefore);
    expect(c.data.toolsTab?.at).not.toBe(tBefore);
  }, 60_000);

  it('at 160x45, 120x40, 100x30 and 80x24 each body fills the frame exactly; side by side from 120, stacked below, opening at its top', async () => {
    sandbox();
    const p = trayProject('tabs-5-9-sizes');
    const { c, ws } = workbench(p);
    await records(p, ws);
    for (const key of ['5', '9']) {
      c.frame(160, 45);
      c.key(key, {});
      await sleep(20);
      for (const [w, h] of [[160, 45], [120, 40], [100, 30], [80, 24]] as const) {
        const f = c.frame(w, h);
        const rows = screenText(f.screen);
        expect(rows, `${key} at ${w}x${h}`).toHaveLength(h);
        for (const row of rows) expect(visibleWidth(row), `${key} at ${w}x${h}`).toBeLessThanOrEqual(w);
        expect(f.regions.right, `${key} at ${w}x${h}`).toBeFalsy();
        const body = text(f, 'center');
        // the columns side by side from 120 (the terminal's width decides, not the body's), stacked below
        if (key === '5') expect(/TOOLS[^\n]*│ RECORDS[^\n]*│ RECORD /.test(body), `${key} at ${w}x${h}`).toBe(w >= 120);
        else expect(/AGENT TOOLS[^\n]*│ MCP TO CLI/.test(body), `${key} at ${w}x${h}`).toBe(w >= 120);
        // the first row selected, the body opens at its top: the pipeline, or the search and its way to the finder
        // (the keyboard is on the workflow actions: / searches the tools from their list, and the row says so)
        expect(body.split('\n')[0], `${key} at ${w}x${h}`).toMatch(key === '5' ? /^ PIPELINE \.intent/ : /^ Search the tools: Tab to this list, then \//);
      }
    }
  }, 60_000);
});
