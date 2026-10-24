/**
 * R11 phase 2 (H167): the Tools & integrations screen (src/workbench/inventory-tab.ts): the honest inventory in three words
 * (available / configured / exercised) and no fourth, drawn from FAKE rows in the /tools ladder's shape (no program is run
 * to find them; the ladder's evidence is made up here and said so by the ids' FAKE-free names being fixtures of this test).
 * The frames at 122x37 and 80x24, the Inspector (Enter on a row), the state and next-step readings, and the swap to H170's
 * capability inventory shape (fromInventory) with a FAKE row of that shape.
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import type { InventoryRow } from '../src/capabilities/inventory.js';
import { findWorkspaces } from '../src/workbench/nav.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { pageOf } from '../src/workbench/hub.js';
import { fromCapabilities, fromInventory, GROUPS, inventoryInspector, inventoryNext, inventoryRow, matchingGroups, nextWords, STATES, stateOf, stateSeg, type ScreenRow } from '../src/workbench/inventory-tab.js';
import type { Data, Ui } from '../src/workbench/model.js';
import { frameOf } from '../src/workbench/screen.js';
import { plain } from '../src/workbench/text.js';

const g = glyphsFor(true);
const NOW = Date.parse('2026-10-22T23:40:00Z');
const L = () => ({ proposed: null, installed: null, reachable: null, exercised: null, qualified: null });
const clockOf = (iso: string): string => new Date(iso).toTimeString().slice(0, 8);

// FIXTURE rows in the /tools ladder's shape, one per state the screen can show (the evidence is this test's, not a machine's)
const ROWS = [
  { id: 'repl', kind: 'surface', name: 'REPL (timmy)', rung: 'installed', detail: 'chat: local fake-qwen3:8b · Ollama at 127.0.0.1:4463 (no model key needed)', ladder: { ...L(), installed: { found: 'the REPL is this Timmy', how: 'built into Timmy' } }, notReached: { reachable: 'no probe asks the REPL', exercised: 'not recorded: Timmy seals no run of this row on its own' } },
  { id: 'openrouter', kind: 'model', name: 'OpenRouter', rung: 'exercised', detail: 'key from providers.json; answered', ladder: { ...L(), installed: { found: 'a key', where: 'providers.json', how: 'a setting' }, reachable: { asked: 'GET /api/v1/key', at: '2026-10-22T23:30:00Z', answer: 'HTTP 200' }, exercised: { at: '2026-10-22T23:35:00Z', what: 'a chat turn, answered and sealed', receipt: 'd2d756db', hash: 'sha256:fixture', chain: 'verifyChain, this reading' } } },
  { id: 'workflows', kind: 'surface', name: 'Workflows (/workflows)', rung: 'exercised', detail: 'upmd on PATH', ladder: { ...L(), installed: { found: 'upmd', where: '~/bin/upmd', how: 'the PATH', version: '0.4.1', versionFrom: 'upmd --version in a sealed run' }, exercised: { at: '2026-10-22T22:10:00Z', what: 'build.md › build completed', receipt: 'f7a8f9c4', chain: 'verifyChain, this reading', record: '.timmy/operations/o1.json' } } },
  { id: 'receipts', kind: 'surface', name: 'Receipts (timmy receipts)', rung: 'installed', detail: '5 receipts, chain verified', ladder: { ...L(), installed: { found: '5 receipts', where: '.timmy/receipts/runs.jsonl', how: 'a folder scan' } } },
  { id: 'look', kind: 'tool', name: 'Image observations (/observe)', rung: 'installed', detail: 'OpenCV measurements (workers/look); OpenCV is checked when it runs', tools: ['observe_image'], ladder: { ...L(), installed: { found: 'python3', where: '/usr/bin/python3', how: 'the PATH' } }, notReached: { exercised: 'no sealed /observe here' } },
  { id: 'blender', kind: 'adapter', name: 'Blender', rung: 'needs setup', detail: 'blender is not on PATH', setup: 'brew install --cask blender', ladder: L(), notReached: { installed: 'blender is not on PATH' } },
  { id: 'trigger', kind: 'tool', name: 'Trigger.dev jobs', rung: 'needs setup', detail: 'no key', setup: 'set TRIGGER_SECRET_KEY', tools: ['trigger_background_workflow'], ladder: L() },
  { id: 'taskforge', kind: 'harness', name: 'TaskForge', rung: 'reachable', detail: 'its health check answered', ladder: { ...L(), installed: { found: 'an address', where: 'TASKFORGE_API_URL', how: 'a setting' }, reachable: { asked: 'GET /runtime/health', at: '2026-10-22T23:31:00Z', answer: 'HTTP 200' } } },
  { id: 'composio', kind: 'tool', name: 'Composio', rung: 'installed', detail: 'key set; not contacted', tools: ['manage_composio_integrations'], ladder: { ...L(), installed: { found: 'COMPOSIO_API_KEY set', where: 'COMPOSIO_API_KEY', how: 'a setting' } } },
  { id: 'claude-code', kind: 'harness', name: 'Claude Code', rung: 'needs setup', detail: 'claude is not on PATH', setup: 'brew install --cask claude-code', ladder: L() },
  { id: 'mcp-cli:sdk', kind: 'tool', name: 'MCP servers (/mcp, SDK route)', rung: 'installed', detail: 'the SDK route is built in', ladder: { ...L(), installed: { found: '@modelcontextprotocol/sdk', how: 'built into Timmy' } } },
  { id: 'spatial-review', kind: 'tool', name: 'Local spatial review', rung: 'needs setup', detail: 'needs a local Ollama model', setup: 'ollama serve, then ollama pull <model>', ladder: L() },
  { id: 'flag', kind: 'tool', name: 'Feature flags', rung: 'proposed', detail: 'built, but it reads a flag only through a Worker binding', ladder: { ...L(), proposed: { plan: 'docs/PLAN.md', section: 'flags', says: 'a Flagship binding' } } },
] as unknown as CapabilityRow[];

function data(o: Partial<Data> = {}): Data {
  return {
    project: { name: 'tray', root: '/p/tray', id: 'p1', shown: '~/timmy/projects/tray' },
    projects: [], files: { total: 3, truncated: false, groups: [] }, workflows: { docs: [], upmd: true },
    jobs: [], decisions: { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [] },
    route: { kind: 'local', words: 'chat: local fake-qwen3:8b · Ollama', ready: true },
    activity: { running: 0, waiting: 0, events: [] },
    chat: { session: null, total: 0, messages: [] }, turns: [],
    vox: [], native: {}, starters: [], boards: [], studio: { state: 'idle' }, overview: { state: 'idle' }, details: {}, readAt: NOW, away: [],
    caps: { state: 'ready', value: ROWS, at: NOW - 120_000 },
    ...o,
  } as unknown as Data;
}
function ui(o: Partial<Ui> = {}): Ui {
  return { page: pageOf('tools'), workspace: 'tools', focus: 'center', tab: 'inspector', navOpen: false, rightOpen: false, activityOpen: false, activityAll: false, overlay: null, input: { field: null, text: '' }, cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, activityFollow: true, toolsQuery: '', flash: null, mouse: false, related: false, saved: null, settings: { settings: { reducedMotion: false } }, companion: { serving: false, address: null, last: null }, studio: { serving: false, address: null, last: null }, mine: [], ...o } as unknown as Ui;
}
const can = { run: true, chat: true, detail: true };
const frame = (d: Data, u: Ui, columns = 122, rows = 37) => frameOf({ ui: u, data: d, g, columns, rows, now: NOW, can });
const text = (f: ReturnType<typeof frame>) => f.screen.map(plain);
const cols = (row: string, from: number, to: number) => [...row].slice(from, to + 1).join('').trimEnd();
/** the body's rows (inside the box's edges) */
const body = (t: string[], to = 120) => t.map((r) => cols(r, 2, to));
const CHIP = /^(available|configured|exercised)$/;

describe('the state in three words, from the ladder\'s evidence (never inferred, never a fourth)', () => {
  it('exercised only while the rung stands and the receipt is named; configured from a probe or a setting; available from the files; nothing for what is not here', () => {
    const by = Object.fromEntries(ROWS.map((r) => [r.id, stateOf(r)]));
    expect(by.openrouter).toEqual({ state: 'exercised', receipt: 'd2d756db', at: '2026-10-22T23:35:00Z' });
    expect(by.workflows).toEqual({ state: 'exercised', receipt: 'f7a8f9c4', at: '2026-10-22T22:10:00Z' });
    expect(by.taskforge).toEqual({ state: 'configured' });
    expect(by.composio).toEqual({ state: 'configured' });
    // (the REPL with a model and an Ollama address set is configured; its address never reaches the row)
    expect(by.repl).toEqual({ state: 'configured' });
    expect(by.receipts).toEqual({ state: 'available' });
    expect(by.look).toEqual({ state: 'available' });
    expect(by['mcp-cli:sdk']).toEqual({ state: 'available' });
    for (const id of ['blender', 'trigger', 'claude-code', 'spatial-review', 'flag']) expect(by[id], id).toEqual({ state: null });
    // a past run never raises a missing tool: exercised evidence on a row whose rung is "needs setup" is not the chip
    const gone = { ...ROWS[2], rung: 'needs setup', setup: 'brew install upmd' } as CapabilityRow;
    expect(stateOf(gone)).toEqual({ state: null });
    expect(STATES).toEqual(['available', 'configured', 'exercised']);
    // the chip's colour: exercised green only with a receipt; configured plain; available dim; none: blank cells
    expect(stateSeg('exercised', 'd2d756db')).toMatchObject({ text: 'exercised ', role: 'live' });
    expect(stateSeg('exercised', undefined)).toMatchObject({ role: 'text' });
    expect(stateSeg('configured', undefined)).toMatchObject({ text: 'configured', role: 'text' });
    expect(stateSeg('available', undefined)).toMatchObject({ text: 'available ', role: 'secondary' });
    expect(stateSeg(null, undefined).text).toBe(' '.repeat(10));
  });

  it('the next step in the product\'s words: a key or an address says where it is set; a command stays in the details; nothing once set', () => {
    expect(nextWords({ id: 'trigger', rung: 'needs setup', setup: 'set TRIGGER_SECRET_KEY', detail: 'no key' })).toEqual({ next: 'a key is needed (TRIGGER_SECRET_KEY)', short: 'a key (TRIGGER_SECRET_KEY)', where: 'the .env file' });
    expect(nextWords({ id: 'listing', rung: 'needs setup', setup: 'set BREAK_MODE_API_BASE_URL and TIMMY_USERNAME', detail: 'no listing service' })).toEqual({ next: 'an address is needed (BREAK_MODE_API_BASE_URL, TIMMY_USERNAME)', short: 'an address (BREAK_MODE_API_BASE_URL, TIMMY_USERNAME)', where: 'the .env file' });
    expect(nextWords({ id: 'taskforge', rung: 'needs setup', setup: 'set TASKFORGE_API_URL to its API', detail: 'no API address' })).toEqual({ next: 'an address is needed (TASKFORGE_API_URL)', short: 'an address (TASKFORGE_API_URL)', where: 'the .env file' });
    // (src/recipes' row: "export NAME=<value>" is a setting too, named, never the shell line)
    expect(nextWords({ id: 'recipe-tray', rung: 'needs setup', setup: 'export TIMMY_CADQUERY_PYTHON=<Python with CadQuery and Open3D>', detail: 'TIMMY_CADQUERY_PYTHON is not set' })).toEqual({ next: 'a setting is needed (TIMMY_CADQUERY_PYTHON)', short: 'a setting (TIMMY_CADQUERY_PYTHON)', where: 'the .env file' });
    expect(nextWords({ id: 'repl', rung: 'needs setup', setup: 'timmy init, or export OPENROUTER_API_KEY', detail: 'no model key' })).toEqual({ next: 'choose the chat\'s model and its key', short: 'a model and its key', where: 'Models & accounts' });
    expect(nextWords({ id: 'spatial-review', rung: 'needs setup', setup: 'ollama serve, then ollama pull <model>', detail: '' })).toEqual({ next: 'start Ollama and pull a model', short: 'Ollama and a model', where: 'Models & accounts' });
    expect(nextWords({ id: 'blender', rung: 'needs setup', setup: 'brew install --cask blender', detail: '' })).toEqual({ next: 'install it on this computer; the command is in its details', short: 'install it; the command is in its details' });
    expect(nextWords({ id: 'canvas-tools', rung: 'needs setup', setup: '/canvas open', detail: '' })).toEqual({ next: 'open the canvas', where: 'Canvas' });
    expect(nextWords({ id: 'flag', rung: 'proposed', detail: '' })).toEqual({ next: 'planned; no code here runs it yet' });
    expect(nextWords({ id: 'composio', rung: 'installed', detail: 'key set; not contacted' })).toEqual({ next: '' });
    // never a command on the row: the words of every fixture's next step hold no brew, npm, set X or timmy init
    for (const r of ROWS) expect(nextWords(r).next).not.toMatch(/\bbrew\b|\bnpm\b|\bset [A-Z]|\bexport [A-Z]|timmy init|ollama pull/);
  });

  it('the groups are the rail\'s, in its order (each group\'s rows in All tools\' order of kinds), and the finder reaches the screen by its names', () => {
    expect(GROUPS.map((x) => x.label)).toEqual(['CHAT', 'WORK', 'CREATE', 'CONNECT']);
    expect(fromCapabilities(ROWS).map((x) => [x.label, x.rows.map((r) => r.id)])).toEqual([
      ['CHAT', ['repl', 'openrouter', 'spatial-review']], ['WORK', ['workflows', 'receipts']], ['CREATE', ['look', 'blender']], ['CONNECT', ['trigger', 'composio', 'mcp-cli:sdk', 'flag', 'taskforge', 'claude-code']],
    ]);
    for (const q of ['integrations', 'Tools & MCP', 'tools']) expect(findWorkspaces(q)[0]?.id, q).toBe('tools');
  });
});

describe('the screen at 122x37 and 80x24: the header, the honesty row, the groups, one row a capability, the chip never cut', () => {
  it('122x37: TOOLS & INTEGRATIONS · what this installation has; nothing here was run to make this list; the rows with their chips, what was found and the next step', () => {
    const t = body(text(frame(data(), ui())));
    expect(t[9]).toBe('TOOLS & INTEGRATIONS · what this installation has');
    expect(t[10]).toBe('nothing here was run to make this list · 13 tools · checked 2 min ago · [r] checks again');
    expect(t[11]).toBe('available the files are here  · configured a key or an address is set  · exercised a receipt of a real run (green)');
    expect(t[13]).toBe('CHAT · 3 capabilities');
    // (the address of the REPL's Ollama is never on the row: inWords)
    expect(t[14]).toBe('▸ REPL (timmy)                configured  local fake-qwen3:8b · Ollama on this computer (no model key needed)');
    expect(t[15]).toBe(`  OpenRouter                  exercised   receipt d2d756db · key from providers.json; answered · last run ${clockOf('2026-10-22T23:35:00Z')}`);
    // (the next step's column holds its short form with where it is set; the whole is the details')
    expect(t[16]).toBe('  Local spatial review                    needs a local Ollama model         Ollama and a model: Models & accounts');
    expect(t[18]).toBe('WORK · 2 capabilities');
    expect(t[19]).toBe(`  Workflows (/workflows)      exercised   receipt f7a8f9c4 · upmd on PATH · last run ${clockOf('2026-10-22T22:10:00Z')}`);
    expect(t[20]).toBe('  Receipts (timmy receipts)   available   5 receipts, chain verified');
    expect(t[22]).toBe('CREATE · 2 capabilities');
    expect(t[24]).toBe('  Blender                                 blender is not on PATH             install it; the command is in its details');
    expect(t[26]).toBe('CONNECT · 6 capabilities');
    expect(t[27]).toBe('  Trigger.dev jobs                        no key                             a key (TRIGGER_SECRET_KEY): the .env file');
    expect(t[28]).toBe('  Composio                    configured  key set; not contacted');
    // the chip column (cells 30-39 of the body) holds one of the three words or nothing, on every capability's row
    const f = frame(data(), ui());
    const region = f.regions.center!;
    // (the search's row is pinned at the window's top: the rest's lines are counted below it)
    const screenRow = (line: number): number => region.rect.y + 1 + region.fixed + (line - region.scroll);
    let seen = 0;
    for (const it of region.items) {
      const y = screenRow(it.line);
      if (y <= region.rect.y + region.fixed || y >= region.rect.y + region.rect.h - 1) continue;
      seen += 1;
      const chip = cols(plain(f.screen[y]), 32, 41).trim();
      expect(chip === '' || CHIP.test(chip), `row ${y}: "${chip}"`).toBe(true);
    }
    // (the rows in view: the body's 21 rows (R11 round 7, H177: the page head's description row above) hold the header,
    // three whole groups and CONNECT's first two)
    expect(seen).toBe(9);
    // green only on the exercised rows' chips; nothing else green
    const greens = f.screen.flatMap((l) => l.filter((s) => s.role === 'live').map((s) => s.text.trim()));
    expect(greens).toEqual(['exercised', 'exercised']);
    // no address, no command on the screen
    // (a setting's name on its row says where it is set; the command that sets it is not drawn)
    expect(t.join('\n')).not.toMatch(/127\.0\.0\.1|brew install|\bset TRIGGER_SECRET_KEY|\bexport [A-Z]|ollama pull/);
    // the finder's and the search's rows are the tab's own
    expect(t[8]).toBe('[/] Search the tools by name, kind or what they need  · a workspace: g, then /');
  });

  it('80x24: the list scrolls to the selection; the chip whole on every row; the next step beside what was found where the row has one', () => {
    const f = frame(data(), ui({ cursor: { 'center:tools': 5 } }), 80, 24);
    const t = text(f).map((r) => cols(r, 2, 77));
    // (the search's row stays at the top while the list scrolls; the range counts the rows below it)
    // (R11 round 7, H177: the body's crumb is "project / Tools & integrations"; the page head above carries the title)
    expect(t[7]).toMatch(/^ ◆ tray \/ Tools & integrations ━+ 6–15 of 28$/);
    expect(t[8]).toBe('[/] Search the tools  · a workspace: g, then /');
    expect(t[9]).toBe('  REPL (timmy)          configured  local fake-qwen3:8b · Ollama on this…');
    expect(t[10]).toBe('  OpenRouter            exercised   receipt d2d756db · key from…');
    // (80 columns: where the step is set, alone, where its forms do not fit)
    expect(t[11]).toBe('  Local spatial review              needs a local…        Models & accounts');
    expect(t[14]).toBe('  Workflows…            exercised   receipt f7a8f9c4 · upmd on PATH · last…');
    expect(t[18]).toBe('▸ Image observations…   available   OpenCV measurements (workers/look)…');
    const region = f.regions.center!;
    let seen = 0;
    for (const it of region.items) {
      const y = region.rect.y + 1 + region.fixed + (it.line - region.scroll);
      if (y <= region.rect.y + region.fixed || y >= region.rect.y + region.rect.h - 1) continue;
      seen += 1;
      const chip = cols(plain(f.screen[y]), 26, 35).trim();
      expect(chip === '' || CHIP.test(chip), `row ${y}: "${chip}"`).toBe(true);
    }
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(text(f).every((r) => [...r].length <= 80)).toBe(true);
  });

  it('Enter on a row: its details in the right pane (the Inspector): the state and its meaning, what was found, the next step and where it is set, the receipt, then each rung\'s own evidence', () => {
    const open = (i: number) => text(frame(data(), ui({ rightOpen: true, focus: 'right', tab: 'inspector', cursor: { 'center:tools': i } }))).map((r) => cols(r, 84, 119));
    const or = open(1);
    expect(or[10]).toBe('CAPABILITY');
    expect(or[11]).toBe('OpenRouter');
    expect(or[12]).toBe('State      exercised');
    expect(or.slice(13, 16)).toEqual(['           a receipt of a real run', '           exists, on a chain that', '           verified']);
    expect(or[16]).toBe('Found      key from providers.json;');
    expect(or.slice(19, 21)).toEqual([`Receipt    d2d756db · ${clockOf('2026-10-22T23:35:00Z')}`, '']);
    // (R11 round 7, H177: the drawer is a row shorter under the page head; its last rows, the receipt among them, are below
    // the fold it names: "1–19 of 22")
    expect(or.join(' ').replace(/\s+/g, ' ')).toMatch(/Rung exercised Found a key at providers\.json \(a setting\) Answered HTTP 200 \(asked: GET \/api\/v1\/key, \d\d:\d\d:\d\d\) Exercised a chat turn, answered and sealed; \d\d:\d\d:\d\d;/);
    expect(or.join(' ')).toMatch(/1–19 of 22/);
    const bl = open(6);
    expect(bl[11]).toBe('Blender');
    expect(bl[12]).toBe('State      –');
    expect(bl[13]).toBe('           nothing of it is here');
    expect(bl[14]).toBe('Found      blender is not on PATH');
    expect(bl.slice(15, 18)).toEqual(['Next       install it on this', '           computer; the command is', '           in its details']);
    expect(bl.join(' ').replace(/\s+/g, ' ')).toMatch(/Rung needs setup Not found blender is not on PATH Command brew install --cask blender/);
    // a key's place is said, not set: the step names where
    const tr = open(7);
    expect(tr.join(' ').replace(/\s+/g, ' ')).toMatch(/Next a key is needed \(TRIGGER_SECRET_KEY\): the \.env file \(nothing is set from here\)/);
  });
});

describe('H170\'s capability inventory (src/capabilities/inventory.ts): the same screen rows from its rows', () => {
  const fact = (ok: boolean, found: string): InventoryRow['available'] => ({ ok, found, source: 'FAKE fact', words: `FAKE words: ${found}` });
  const FAKE: InventoryRow[] = [
    { id: 'model:ollama-local', name: 'Ollama (this computer)', group: 'Models', available: fact(true, 'Ollama is installed (the ollama command on PATH)'), configured: fact(true, 'the chat is set to local fake-qwen3:8b from the setup; Ollama at 127.0.0.1:4461'), exercised: { ok: true, receipt: 'ab12cd34', hash: 'sha256:fixture', when: '2026-10-22T23:00:00Z', what: 'a chat turn answered and sealed', source: 'FAKE chain', words: 'FAKE words' } },
    { id: 'model:openrouter', name: 'OpenRouter', group: 'Models', available: fact(true, 'built in: Timmy\'s OpenRouter client (@openrouter/sdk); no install needed'), configured: fact(false, 'no key is set; the chat is set to local, and no model is chosen'), exercised: { ok: false, found: 'no sealed chat turn through OpenRouter yet', source: 'FAKE chain', words: 'FAKE words' }, next: 'Sign in with OpenRouter, or paste a key from openrouter.ai/keys' },
    { id: 'model:cloudflare', name: 'Cloudflare (optional)', group: 'Models', available: fact(true, 'built in'), configured: fact(false, 'nothing is set'), exercised: { ok: false, found: 'never: Timmy sends Cloudflare no request to check it', source: 'FAKE', words: '' }, next: 'Optional: set TIMMY_EDGE_HOST (or the private overlay\'s edge host) for the Worker; the local app needs no Cloudflare account' },
    { id: 'lane:hermes', name: 'Hermes', group: 'Lanes', available: fact(false, 'hermes is not on PATH'), configured: fact(false, 'nothing set'), exercised: { ok: false, found: 'no run', source: 'FAKE', words: '' }, next: 'pip install hermes-agent' },
    { id: 'receipts:chain', name: 'Receipts (timmy receipts)', group: 'Receipts', available: fact(true, '5 receipts, the chain verifies'), configured: fact(false, 'nothing to set'), exercised: { ok: false, found: 'a chain is not run', source: 'FAKE', words: '' }, next: 'any sealed run (a chat turn, /observe, /mcp call) appends a signed receipt' },
    { id: 'vox:look', name: 'Image observations (OpenCV)', group: 'Tools', available: fact(true, 'built in: python3 on PATH'), configured: fact(false, 'nothing to set'), exercised: { ok: false, found: 'no sealed run', source: 'FAKE', words: '' }, next: 'Run it once: /vox look <image> (its record and receipt seal the run)' },
  ];
  it('the chip is the standing word (H170\'s); what was found is that fact\'s own words through inWords (no address); the next step in the product\'s words with where it is set; the groups fold into the rail\'s', () => {
    const groups = fromInventory(FAKE);
    expect(groups.map((x) => [x.label, x.rows.map((r) => `${r.id}:${r.state ?? '-'}`)])).toEqual([
      ['CHAT', ['model:ollama-local:exercised', 'model:openrouter:available', 'model:cloudflare:available']], ['WORK', ['receipts:chain:available']], ['CREATE', ['vox:look:available']], ['CONNECT', ['lane:hermes:-']],
    ]);
    const rows = Object.fromEntries(groups.flatMap((x) => x.rows).map((r) => [r.id, r])) as Record<string, ScreenRow>;
    expect(rows['model:ollama-local']).toMatchObject({ state: 'exercised', receipt: 'ab12cd34', at: '2026-10-22T23:00:00Z', found: `a chat turn answered and sealed · last run ${clockOf('2026-10-22T23:00:00Z')}`, under: 'Models', next: '' });
    expect(rows['model:openrouter']).toMatchObject({ state: 'available', next: 'sign in with OpenRouter, or paste a key', short: 'sign in or paste a key', where: 'Models & accounts' });
    expect(rows['model:openrouter'].found).toMatch(/^built in: Timmy's OpenRouter client/);
    expect(rows['model:cloudflare']).toMatchObject({ next: 'optional: an address is needed (TIMMY_EDGE_HOST)', short: 'optional: an address (TIMMY_EDGE_HOST)', where: 'the .env file' });
    expect(rows['lane:hermes']).toMatchObject({ state: null, found: 'hermes is not on PATH', next: 'install it on this computer; the command is in its details' });
    expect(rows['receipts:chain']).toMatchObject({ state: 'available', next: 'run it once (it asks first); its receipt seals the run' });
    expect(rows['vox:look']).toMatchObject({ group: 'create', under: 'Tools', next: 'run it once (it asks first); its receipt seals the run' });
    // the facts whole (the address and the command are the details'), and the inventory's step sentence whole
    expect(rows['model:ollama-local'].facts).toEqual([
      ['Available', 'yes: Ollama is installed (the ollama command on PATH) (FAKE fact)'], ['Configured', 'yes: the chat is set to local fake-qwen3:8b from the setup; Ollama at 127.0.0.1:4461 (FAKE fact)'], ['Exercised', `a chat turn answered and sealed; ${clockOf('2026-10-22T23:00:00Z')}; receipt ab12cd34 (FAKE chain)`],
    ]);
    expect(rows['model:openrouter'].facts[3]).toEqual(['Step', 'Sign in with OpenRouter, or paste a key from openrouter.ai/keys']);
    // a configured row: the fact's words through inWords: the address becomes "this computer"
    const configured = fromInventory([{ ...FAKE[0], exercised: { ok: false, found: 'no sealed chat turn yet', source: 'FAKE', words: '' }, next: 'Send a message in the chat (each answered turn seals a receipt)' }]).flatMap((x) => x.rows)[0];
    expect(configured).toMatchObject({ state: 'configured', found: 'local FAKE fake-qwen3:8b; Ollama on this computer', next: 'send a message in the chat; each answered turn seals a receipt', short: 'send a message in the chat' });
    expect(configured.where).toBeUndefined();
    // H170's rule (2c29de3d): the standing word never contradicts the present: the files gone, no word, whatever a key or an
    // earlier receipt says; the facts stay in the details, the step is the install
    const gone = fromInventory([{ ...FAKE[0], available: fact(false, 'Ollama is not installed here (no ollama on PATH)'), next: 'Install it: brew install --cask ollama; then open -a Ollama' }]).flatMap((x) => x.rows)[0];
    expect(gone).toMatchObject({ state: null, found: 'Ollama is not installed here (no ollama on PATH)', next: 'install Ollama, then start it', where: 'Models & accounts' });
    expect(gone.receipt).toBeUndefined();
    expect(gone.facts[2][1]).toMatch(/^a chat turn answered and sealed; .*receipt ab12cd34/);
    // a FAKE model is named FAKE wherever its name stands in the fact shown (an exercised run's words too)
    const ran = fromInventory([{ ...FAKE[0], exercised: { ok: true, receipt: 'ab12cd34', hash: 'sha256:fixture', when: '2026-10-22T23:00:00Z', what: 'a sealed chat turn answered by fake-qwen3:8b through the Ollama on this computer', source: 'FAKE chain', words: '' } }]).flatMap((x) => x.rows)[0];
    expect(ran.found).toBe(`a sealed chat turn answered by FAKE fake-qwen3:8b through the Ollama on this computer · last run ${clockOf('2026-10-22T23:00:00Z')}`);
    // drawn with the same row: the receipt first, the chip green
    const line = inventoryRow(rows['model:ollama-local'], 118, false, g);
    expect(plain(line).trimEnd()).toBe(`  Ollama (this computer)      exercised   receipt ab12cd34 · a chat turn answered and sealed · last run ${clockOf('2026-10-22T23:00:00Z')}`);
    expect(line.find((s) => s.text.trim() === 'exercised')?.role).toBe('live');
    const insp = inventoryInspector(rows['model:openrouter'], 60, g).map(plain);
    expect(insp[0]).toBe('CAPABILITY · Models');
    expect(insp.join(' ').replace(/\s+/g, ' ')).toMatch(/Next sign in with OpenRouter, or paste a key: Models & accounts \(nothing is set from here\) Available yes: built in: Timmy's OpenRouter client \(@openrouter\/sdk\); no install needed \(FAKE fact\) Configured no: no key is set; the chat is set to local, and no model is chosen \(FAKE fact\) Exercised no: no sealed chat turn through OpenRouter yet \(FAKE chain\) Step Sign in with OpenRouter, or paste a key from openrouter\.ai\/keys/);
    // the search keeps the rows that hold every word of it (the name, the group, the state, what was found, the step)
    expect(matchingGroups(groups, 'models key').flatMap((x) => x.rows.map((r) => r.id))).toEqual(['model:openrouter']);
    expect(matchingGroups(groups, 'models').flatMap((x) => x.rows.map((r) => r.id))).toEqual(['model:ollama-local', 'model:openrouter', 'model:cloudflare']);
    expect(matchingGroups(groups, 'exercised').flatMap((x) => x.rows.map((r) => r.id))).toEqual(['model:ollama-local']);
    expect(matchingGroups(groups, '').flatMap((x) => x.rows).length).toBe(6);
  });

  it('the inventory\'s own step sentences (commands, addresses) as the row\'s words: where a key or an address is set, said; a run that would exercise it; an install kept in the details', () => {
    expect(inventoryNext('Choose a local model: timmy init --chat local --model <name>, or /model in the REPL')).toEqual({ next: 'choose a local model', where: 'Models & accounts' });
    expect(inventoryNext('Set the chat to OpenRouter (timmy init --chat openrouter, or /setup chat in the REPL), then send a message')).toEqual({ next: 'set the chat to OpenRouter', where: 'Models & accounts' });
    expect(inventoryNext('Install Ollama, then start it')).toEqual({ next: 'install Ollama, then start it', short: 'install Ollama', where: 'Models & accounts' });
    expect(inventoryNext('Install it: brew install --cask ollama; then open -a Ollama')).toEqual({ next: 'install Ollama, then start it', short: 'install Ollama', where: 'Models & accounts' });
    expect(inventoryNext('Download a model: ollama pull qwen3:8b (no charge)')).toEqual({ next: 'download a model into Ollama', short: 'download a model', where: 'Models & accounts' });
    expect(inventoryNext('Paste an Ollama API key from ollama.com/settings/keys')).toEqual({ next: 'paste an Ollama API key', where: 'Models & accounts' });
    expect(inventoryNext('Choose a cloud-backed model (/model lists them as cloud-backed), then send a message: the chat then leaves this computer')).toEqual({ next: 'choose a cloud-backed model', short: 'a cloud-backed model', where: 'Models & accounts' });
    expect(inventoryNext('set ROBOFLOW_API_KEY')).toEqual({ next: 'a key is needed (ROBOFLOW_API_KEY)', short: 'a key (ROBOFLOW_API_KEY)', where: 'the .env file' });
    expect(inventoryNext('export TIMMY_BLENDER=<path to blender>')).toEqual({ next: 'a setting is needed (TIMMY_BLENDER)', short: 'a setting (TIMMY_BLENDER)', where: 'the .env file' });
    expect(inventoryNext('set TIMMY_AGENT_MODEL to a model from ollama list')).toEqual({ next: 'a setting is needed (TIMMY_AGENT_MODEL)', short: 'a setting (TIMMY_AGENT_MODEL)', where: 'the .env file' });
    expect(inventoryNext('Name a server in ~/.mcporter/mcporter.json (or config/mcporter.json in the project)')).toEqual({ next: 'name the server in MCPorter\'s config', short: 'name the server', where: 'MCPorter\'s config (mcporter.json)' });
    expect(inventoryNext('/mcp call <server>.<tool> (its mcp.call receipt seals the answer)')).toEqual({ next: 'run it once (it asks first); its receipt seals the run', short: 'run it once; its receipt seals the run' });
    expect(inventoryNext('/lanes dispatch hermes (it asks before it starts; the launch seals a receipt)')).toEqual({ next: 'run it once (it asks first); its receipt seals the run', short: 'run it once; its receipt seals the run' });
    expect(inventoryNext('timmy vision run <image> (a real authorized run; until one succeeds, Roboflow inference stays unverified)')).toEqual({ next: 'run it once (it asks first); its receipt seals the run', short: 'run it once; its receipt seals the run' });
    expect(inventoryNext('timmy init (it makes the store and its pin)')).toEqual({ next: 'run the setup once: it makes the store and its pin', short: 'run the setup once' });
    expect(inventoryNext('install Docker (brew install --cask docker), then start it')).toEqual({ next: 'install it on this computer; the command is in its details', short: 'install it; the command is in its details' });
    expect(inventoryNext('npm run build (the worker ships with the build)')).toEqual({ next: 'install it on this computer; the command is in its details', short: 'install it; the command is in its details' });
    expect(inventoryNext('reinstall Timmy, or run it from a checkout of its repository')).toEqual({ next: 'reinstall Timmy, or run it from a checkout of its repository', short: 'reinstall, or run from a checkout' });
    expect(inventoryNext('uv tool install openhands --python 3.12')).toEqual({ next: 'install it on this computer; the command is in its details', short: 'install it; the command is in its details' });
    expect(inventoryNext('github.com/NousResearch/hermes-agent')).toEqual({ next: 'install it on this computer; its address is in its details', short: 'install it; its address is in its details' });
    expect(inventoryNext('https://defold.com/download/')).toEqual({ next: 'install it on this computer; its address is in its details', short: 'install it; its address is in its details' });
    expect(inventoryNext('see /vox')).toEqual({ next: 'its own page says the step; it is in its details', short: 'the step is in its details' });
    expect(inventoryNext(undefined)).toEqual({ next: '' });
    // never a command, an address or a key's name as a command on the row
    for (const t of ['Choose a local model: timmy init --chat local --model <name>, or /model in the REPL', 'set ROBOFLOW_API_KEY', 'brew install --cask blender', '/mcp call x.y', 'Paste an Ollama API key from ollama.com/settings/keys']) {
      expect(inventoryNext(t).next).not.toMatch(/timmy init|\bset [A-Z]|brew install|^\/mcp|ollama\.com/);
    }
  });
});
