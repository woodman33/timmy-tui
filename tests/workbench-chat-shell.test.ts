// R10 CHAT CHECKPOINT (H167): the Workbench's Chat screen as one screen (src/workbench/chat-shell.ts chatScreen, screen.ts
// chatFrame) on the operator's terminal target's grid (2026-10-22, 16:52 PT, measured in cells): at 122x37 the rail columns
// 0-17, separators at 18 and 90, the center 19-89, Models 91-121, the header rows 0-2, the content rows 3-33, the bottom rows
// 34-36; at 80x24 the rail 0-13, a separator at 14, the center 15-79 and Models a drawer over it. No boxed panes: separators,
// rules, uppercase labels and ">" markers; the composer boxed only while it has the keyboard. And Models' query (H169's
// contract's shape: sort Recently added by the catalog's added date, filters a sort never resets, unknown kept unknown). Pure
// functions over hand-made Data: FIXTURE records and a FAKE local model, nothing run, no request.
import { describe, expect, it } from 'vitest';
import { glyphsFor } from '../src/workbench/frame.js';
import { chatLayout } from '../src/workbench/layout.js';
import { frameOf } from '../src/workbench/screen.js';
import { chatGrid, ctxWords, ollamaRows, priceWords, queryRows, railCatalog, RAIL, type CatalogRow } from '../src/workbench/chat-shell.js';
import type { Data, Ui } from '../src/workbench/model.js';
import { plain } from '../src/workbench/text.js';
import { UNANSWERED } from '../src/agent/core.js';

const g = glyphsFor(true);
const NOW = Date.parse('2026-10-22T23:40:00Z');
const at = (minAgo: number) => NOW - minAgo * 60_000;
const iso = (minAgo: number) => new Date(at(minAgo)).toISOString();

// FIXTURE: three models in the shape of OpenRouter's public /api/v1/models answer (made up here: ids, names, prices and dates)
const CATALOG = [
  { id: 'fixture-maker/older-model', name: 'FIXTURE: Older model', created: 1_700_000_000, description: 'A FIXTURE model added first.', context_length: 32_000, pricing: { prompt: '0.0000005', completion: '0.0000015' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } },
  { id: 'fixture-maker/newest-model:free', name: 'FIXTURE: Newest (free)', created: 1_790_000_000, description: 'A FIXTURE model added last; free.', context_length: 262_144, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] } },
  { id: 'other-maker/middle-model', name: 'FIXTURE: Middle model', created: 1_750_000_000, context_length: 1_000_000 },
];
const OPENROUTER = { route: { kind: 'openrouter', words: 'chat: fixture-maker/newest-model:free · OpenRouter · free-only', ready: true } } as Partial<Data>;

function data(o: Partial<Data> = {}): Data {
  return {
    project: { name: 'tray', root: '/p/tray', id: 'p1', shown: '~/timmy/projects/tray' },
    projects: [], files: { total: 3, truncated: false, groups: [] }, workflows: { docs: [], upmd: true },
    jobs: [], decisions: { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [] },
    route: { kind: 'local', words: 'chat: local fake-qwen3:8b · Ollama', ready: true },
    activity: { running: 0, waiting: 0, events: [] },
    chat: { session: 's1', total: 4, messages: [
      { role: 'user', text: 'Summarise the newest run in one line.', at: at(3) },
      { role: 'assistant', text: 'FAKE answer from a stand-in: the run wrote two files.', at: at(3) },
    ] },
    turns: [{ receipt: 'd2d756db', surface: 'workbench', state: 'answered', model: 'fake-qwen3:8b', at: iso(3), operation: 'oc372c7b3' }],
    vox: [], native: {}, starters: [], boards: [], studio: { state: 'idle' }, overview: { state: 'idle' }, caps: { state: 'idle' }, details: {}, readAt: NOW, away: [],
    models: {
      openrouter: { from: 'shipped', at: '2026-09-07', rows: railCatalog(CATALOG) },
      ollama: { state: 'listed', where: 'Ollama at 127.0.0.1:4463', rows: ollamaRows([{ name: 'fake-qwen3:8b', facts: 'local weights · 8B · Q4_K_M' }]), at: iso(1) },
    },
    ...o,
  } as unknown as Data;
}

function ui(o: Partial<Ui> = {}): Ui {
  return { page: 'chat', workspace: 'chat', focus: 'center', tab: 'inspector', navOpen: false, rightOpen: false, activityOpen: false, activityAll: false, overlay: null, input: { field: null, text: '' }, cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, activityFollow: true, toolsQuery: '', flash: null, mouse: false, related: false, saved: null, settings: { settings: { reducedMotion: false } }, companion: { serving: false, address: null, last: null }, studio: { serving: false, address: null, last: null }, mine: [], ...o } as unknown as Ui;
}

const can = { run: true, chat: true, detail: true };
const frame = (d: Data, u: Ui, columns = 122, rows = 37) => frameOf({ ui: u, data: d, g, columns, rows, now: NOW, can });
const text = (f: ReturnType<typeof frame>) => f.screen.map(plain);
/** the cells from `from` to `to` (inclusive) of a row, trailing blanks dropped */
const cols = (row: string, from: number, to: number) => [...row].slice(from, to + 1).join('').trimEnd();
const center = (t: string[], to = 88) => t.map((r) => cols(r, 20, to));
const models = (t: string[]) => t.map((r) => cols(r, 92, 119));

describe('the Chat screen on the operator\'s grid at 122x37 (R10 CHAT H167; terminal-target captures/01-chat-122x37, 03-local-122x37)', () => {
  it('the cells: rail 0-17, separators at 18 and 90, center 19-89, Models 91-121; header 0-2, content 3-33, bottom 34-36; no box', () => {
    expect(chatGrid(122, 37)).toMatchObject({ railW: 18, centerX: 19, centerW: 71, cx: 20, cw: 69, sepR: 90, modelsX: 91, mx: 92, mw: 28, contentH: 31 });
    expect(chatLayout({ columns: 122, rows: 37 })).toMatchObject({ shell: 'chat', nav: { x: 0, y: 3, w: 18, h: 34 }, center: { x: 19, y: 3, w: 71, h: 31 }, right: { x: 91, y: 3, w: 31, h: 31 }, bottom: { x: 19, y: 34, w: 103, h: 3 } });
    const t = text(frame(data(), ui()));
    expect(t).toHaveLength(37);
    for (const r of t) expect([...r].length).toBe(122);
    for (let y = 3; y < 37; y++) expect([...t[y]][18], `row ${y}'s separator at 18`).toBe('│');
    for (let y = 3; y < 34; y++) expect([...t[y]][90], `row ${y}'s separator at 90`).toBe('│');
    expect(t[2]).toBe('─'.repeat(122));
    expect(cols(t[34], 20, 121)).toBe('─'.repeat(102));
    expect(t.join('\n')).not.toMatch(/[╭╮╰╯┏┓┗┛]/);
  });

  it('the header: TIMMY, the project / Chat and LOCAL RECORDS; NEXT / provider / model (FAKE named), or what is missing', () => {
    const t = text(frame(data(), ui()));
    expect(cols(t[0], 0, 6)).toBe('  TIMMY');
    expect(cols(t[0], 20, 30)).toBe('tray / Chat');
    expect(cols(t[0], 103, 121)).toBe('LOCAL RECORDS');
    expect(cols(t[1], 0, 121)).toBe(`${' '.repeat(20)}NEXT / Ollama local / FAKE fake-qwen3:8b`);
    const none = text(frame(data({ route: { kind: 'local', words: 'chat: local · no model chosen · /model', ready: false } as Data['route'] }), ui({ firstRunDone: true })));
    expect(cols(none[1], 20, 121)).toBe('NEXT / Connect a model to chat');
  });

  it('the rail: PROJECT, the project selector, + New project, the menu with "> Chat" amber, ? Help at its foot', () => {
    const f = frame(data(), ui());
    const rail = text(f).map((r) => cols(r, 0, 17));
    expect(rail.slice(4, 8)).toEqual(['  PROJECT', '  tray v', '', '  + New project']);
    expect(RAIL.map((r) => r.label)).toEqual(['Chat', 'Studio', 'Workflows', 'VoxVision', 'Motion', 'Control Room', 'Files', 'Logs & records', 'Connections']);
    expect(rail.slice(10, 19)).toEqual([' > Chat', ...RAIL.slice(1).map((r) => `   ${r.label}`)]);
    expect(rail[34]).toBe('  ? Help');
    expect(f.screen[10].find((s) => s.text.includes('Chat'))?.role).toBe('accent');
    expect(f.screen[11].find((s) => s.text.includes('Studio'))?.role).toBe('text');
  });

  it('the center: CHAT / project, YOU (grey) and TIMMY / the model that turn used (FAKE named), the rule, MESSAGE, [ Send ] and its keys', () => {
    const f = frame(data(), ui());
    const c = center(text(f));
    expect(c[4]).toBe('CHAT / tray');
    expect(c[7]).toMatch(/^YOU \/ \d\d:\d\d$/);
    expect(c[8]).toBe('Summarise the newest run in one line.');
    expect(c[10]).toMatch(/^TIMMY \/ FAKE fake-qwen3:8b \/ \d\d:\d\d$/);
    expect(c[11]).toBe('FAKE answer from a stand-in: the run wrote two files.');
    expect(c[27]).toBe('─'.repeat(69));
    expect(c.slice(28, 30)).toEqual(['MESSAGE', 'Enter writes a message']);
    expect(c[32]).toMatch(/^\[ Send \] +Enter writes \/ Tab moves on$/);
    expect(f.screen[7].find((s) => s.text.startsWith('YOU'))?.role).toBe('secondary');
    expect(f.screen[10].find((s) => s.text.startsWith('TIMMY'))?.bold).toBe(true);
  });

  it('the composer is boxed in amber only while it has the keyboard: Enter sends / Esc leaves with the draft kept; a draft left shows', () => {
    const typing = frame(data(), ui({ input: { field: 'composer', text: 'Plan the next step.' } }));
    const c = center(text(typing));
    expect(c[29]).toMatch(/^┏━{67}┓$/);
    expect(c[30]).toMatch(/^┃ Plan the next step\. +┃$/);
    expect(c[31]).toMatch(/^┗━{67}┛$/);
    expect(typing.screen[29].find((s) => s.text.startsWith('┏'))?.role).toBe('focus');
    expect(c[32]).toMatch(/^\[ Send \] +Enter sends \/ Esc leaves, the draft kept$/);
    expect(typing.screen[32].find((s) => s.text === '[ Send ]')?.role).toBe('accent');
    expect(center(text(frame(data(), ui({ draft: 'Plan the next step.' }))))[29]).toBe('draft: Plan the next step.');
  });

  it('Models for the local route: MODELS [ Details ] (amber with the keyboard), the four providers, INSTALLED, the list, SELECTED / the model', () => {
    const f = frame(data(), ui({ focus: 'right' }));
    const m = models(text(f));
    expect(m[4]).toBe('MODELS           [ Details ]');
    expect(f.screen[4].find((s) => s.text === 'MODELS')?.role).toBe('accent');
    expect(m.slice(6, 10)).toEqual(['  OpenRouter', '> Ollama local', '  Ollama cloud', '  Cloudflare (optional)']);
    expect(m[12]).toMatch(/^INSTALLED \/ read \d\d:\d\d$/);
    expect(m.slice(14, 16)).toEqual(['> FAKE fake-qwen3:8b', '  8B · Q4_K_M']);
    expect(m.slice(18, 21)).toEqual(['Runs on this computer. A', 'local model does not require', 'a cloud account.']);
    expect(m[27]).toBe('─'.repeat(28));
    // the name does not fit beside SELECTED / in 28 cells: it takes the next row
    expect(m.slice(28, 34)).toEqual(['SELECTED', 'FAKE fake-qwen3:8b', 'local weights · 8B · Q4_K_M', 'The next turn uses it.', 'no charge / this computer', expect.stringMatching(/^Listed by Ollama: \d\d:\d\d$/)]);
  });

  it('Models on OpenRouter: Search, the five label/value rows, the list (Cost Free only: what it lists), SELECTED with its prices and the catalog\'s date', () => {
    const m = models(text(frame(data(OPENROUTER), ui({ focus: 'right' }))));
    expect(m.slice(6, 10)).toEqual(['> OpenRouter', '  Ollama local', '  Ollama cloud', '  Cloudflare (optional)']);
    expect(m[11]).toBe('Search name or model id');
    expect(m.slice(13, 19)).toEqual(['Sort       recent', 'Maker      All', 'Capability All', 'Cost       Free only', 'Context    All', '─'.repeat(28)]);
    expect(m.slice(20, 23)).toEqual(['> FIXTURE: Newest (free)', '  262k context / Free', '']);
    expect(m.slice(28, 34)).toEqual(['SELECTED', 'FIXTURE: Newest (free)', 'A FIXTURE model added last…', 'The next turn uses it.', '$0 in / $0 out / 1M tokens', 'Catalog snapshot: Sep 7']);
    // Cost All: every model, Recently added (the catalog's added date) first; a priced one is not the free-only route's
    const all = models(text(frame(data(OPENROUTER), ui({ focus: 'right', modelsCost: 'all', cursor: { 'right:models': 2 } }))));
    expect(all[16]).toBe('Cost       All');
    expect(all.slice(20, 26)).toEqual(['  FIXTURE: Newest (free)', '  262k context / Free', '  FIXTURE: Middle model', '  1M context / price unknown', '> FIXTURE: Older model', '  32k context / $0.50/$1.50']);
    expect(all.slice(28, 34)).toEqual(['SELECTED', 'FIXTURE: Older model', 'A FIXTURE model added first.', 'Priced: not under free-only.', '$0.50 in / $1.50 out / 1M', 'Catalog snapshot: Sep 7']);
  });

  it('the bottom: the actions in the target\'s order and words; the status row: logs here, idle, cloud sync off, the spend, the size; no id, hash, port or path', () => {
    const t = text(frame(data(), ui()));
    expect(cols(t[35], 20, 121)).toBe('[Attach]  [Tools]  [Plan / Run]  [Permissions]  [Budget]  [Stop]  [Logs]  [Cloudflare]');
    expect(cols(t[36], 20, 121)).toMatch(/^Logs: this computer \/ idle +cloud sync off \/ spend no charge \/ 122 x 37$/);
    expect(t.join('\n')).not.toMatch(/d2d756db|oc372c7b3|127\.0\.0\.1|4463|\/p\/tray|~\/timmy/);
    // a control with no capability behind it says what it needs, where the bottom has the keyboard
    const attach = text(frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 0 } })));
    expect(cols(attach[36], 20, 121)).toMatch(/^Attach: needs the companion: the terminal attaches no files yet/);
  });
});

describe('the Chat screen at 80x24 (R10 CHAT H167; terminal-target captures/04-chat-80x24, 06-models-drawer-80x24)', () => {
  it('the rail 0-13, the separator at 14, the center 15-79; [ Models ] on the title row; [Tools] [Budget] [Logs] [More]', () => {
    expect(chatGrid(80, 24)).toMatchObject({ railW: 14, centerX: 15, centerW: 65, cx: 16, cw: 62, sepR: null, contentH: 18 });
    const t = text(frame(data(), ui(), 80, 24));
    expect(t).toHaveLength(24);
    for (const r of t) expect([...r].length).toBe(80);
    for (let y = 3; y < 24; y++) expect([...t[y]][14]).toBe('│');
    expect(cols(t[0], 16, 26)).toBe('tray / Chat');
    expect(cols(t[0], 64, 79)).toBe('LOCAL RECORDS');
    expect(cols(t[4], 16, 79)).toMatch(/^CHAT \/ tray +\[ Models \]$/);
    const rail = t.map((r) => cols(r, 0, 13));
    expect(rail.slice(4, 8)).toEqual(['  PROJECT', '  tray', '', '  + New']);
    expect(rail.slice(10, 19)).toEqual([' > Chat', '   Studio', '   Workflows', '   VoxVision', '   Motion', '   Control', '   Files', '   Logs', '   Connections']);
    expect(rail[21]).toBe('  ? Help');
    const c = t.map((r) => cols(r, 16, 79));
    expect(c[7]).toMatch(/^YOU \/ \d\d:\d\d$/);
    expect(c[15]).toBe('─'.repeat(62));
    expect(c[16]).toBe('MESSAGE');
    expect(c[20]).toMatch(/^\[ Send \] +Enter writes \/ Tab moves on$/);
    expect(c[22]).toBe('[Tools]  [Budget]  [Logs]  [More]');
    expect(c[23]).toMatch(/^Logs: this computer \/ idle +cloud sync off \/ 80 x 24$/);
  });

  it('Models a drawer over the center only ([ Close ], the providers on one row), the composer\'s action row in sight; the rail and the draft as they were', () => {
    const t = text(frame(data(), ui({ modelsOpen: true, focus: 'right', draft: 'kept words' }), 80, 24));
    const c = t.map((r) => cols(r, 16, 79));
    expect(c[4]).toMatch(/^MODELS +\[ Close \]$/);
    expect(c[5]).toBe('─'.repeat(62));
    expect(c[6]).toBe('  OpenRouter   > Local     Cloud     Cloudflare');
    expect(c[8]).toMatch(/^INSTALLED \/ read \d\d:\d\d$/);
    expect(c[10]).toBe('> FAKE fake-qwen3:8b / 8B · Q4_K_M');
    expect(c[20]).toMatch(/^\[ Send \]/);
    expect(t.map((r) => cols(r, 0, 13))[10]).toBe(' > Chat');
    expect(cols(text(frame(data(), ui({ draft: 'kept words' }), 80, 24))[17], 16, 79)).toBe('draft: kept words');
    const or = text(frame(data(OPENROUTER), ui({ modelsOpen: true, focus: 'right', modelsCost: 'all' }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(or[6]).toBe('> OpenRouter     Local     Cloud     Cloudflare');
    expect(or[7]).toBe('Search name or model id');
    expect(or.slice(9, 13)).toEqual([expect.stringMatching(/^Sort: recent +Maker: All$/), expect.stringMatching(/^Capability: All +Cost: All$/), 'Context: All', '─'.repeat(62)]);
    expect(or.slice(14, 17)).toEqual(['> FIXTURE: Newest (free) / 262k context / Free', '  FIXTURE: Middle model / 1M context / price unknown', '  FIXTURE: Older model / 32k context / $0.50 / $1.50']);
  });

  it('100x30 and 160x45 keep the grid: the compact rail and the drawer at 100, the wide grid with a taller conversation at 160', () => {
    const m = text(frame(data(), ui(), 100, 30));
    for (const r of m) expect([...r].length).toBe(100);
    expect([...m[10]][14]).toBe('│');
    expect(cols(m[4], 16, 99)).toMatch(/^CHAT \/ tray +\[ Models \]$/);
    const w = text(frame(data(), ui(), 160, 45));
    for (const r of w) expect([...r].length).toBe(160);
    expect([...w[10]][18]).toBe('│');
    expect([...w[10]][128]).toBe('│');
    expect(cols(w[35], 20, 126)).toBe('─'.repeat(107));
    expect(cols(w[44], 20, 159)).toMatch(/ 160 x 45$/);
  });
});

describe('Models\' query (H169\'s queryCatalog shape, drawn here until the switch to it)', () => {
  const rows: CatalogRow[] = railCatalog(CATALOG);
  it('reads OpenRouter\'s catalog: per-million prices, free only where both are 0, a capability only where the catalog says it', () => {
    const [older, newest, middle] = rows;
    expect(older).toMatchObject({ maker: 'fixture-maker', contextLength: 32_000, price: { free: false }, caps: { tools: true, reasoning: false, vision: false } });
    expect(older.price.inPerM).toBeCloseTo(0.5);
    expect(newest).toMatchObject({ price: { inPerM: 0, outPerM: 0, free: true }, caps: { tools: true, reasoning: true, vision: true } });
    expect(middle).toMatchObject({ price: { free: 'unknown' }, caps: {} });
    expect([priceWords(middle.price), priceWords(newest.price), priceWords(older.price)]).toEqual(['price unknown', 'Free', '$0.50 / $1.50']);
    expect([ctxWords(undefined), ctxWords(262_144), ctxWords(1_000_000), ctxWords(32_000)]).toEqual(['context unknown', '262k context', '1M context', '32k context']);
  });

  it('Recently added sorts by the catalog\'s added date; search, maker, capability, cost and context filter; a sort never resets the filters', () => {
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'other-maker/middle-model', 'fixture-maker/older-model']);
    const q = { source: 'openrouter' as const, sort: 'recent' as const, maker: 'fixture-maker' };
    expect(queryRows(rows, q).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'fixture-maker/older-model']);
    expect(queryRows(rows, { ...q, sort: 'name' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'fixture-maker/older-model']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', capability: 'vision' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', cost: 'free' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free']);
    // an unknown price is neither free nor paid
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', cost: 'paid' }).rows.map((r) => r.id)).toEqual(['fixture-maker/older-model']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', minContext: 200_000 }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'other-maker/middle-model']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', search: 'MIDDLE' }).rows.map((r) => r.id)).toEqual(['other-maker/middle-model']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent' })).toMatchObject({ total: 3, makers: ['fixture-maker', 'other-maker'] });
  });
});

describe('the first run and Chat with no model (R10 CHAT H167; terminal-target captures/02-first-run-122x37, 05-first-run-80x24)', () => {
  const NONE = { route: { kind: 'none', words: 'chat: none · no key, no model', ready: false }, chat: { session: null, total: 0, messages: [] }, turns: [] } as unknown as Partial<Data>;

  it('no model and the question not answered: WELCOME TO TIMMY, FIRST RUN in the header, the four choices (Cloudflare only as the advanced one), the guide, the note; no composer', () => {
    const f = frame(data(NONE), ui());
    const t = text(f);
    expect(cols(t[1], 20, 121)).toBe('FIRST RUN / choose how chat runs');
    const c = center(t);
    expect(c[4]).toBe('WELCOME TO TIMMY');
    expect(c.slice(7, 10)).toEqual(['How would you like to run chat?', 'Choose one. You can add the others later.', '']);
    expect(c.slice(10, 21)).toEqual([
      '> [ OpenRouter / cloud ]', '  Use an API key from OpenRouter (typed in a shell, hidden).', '',
      '  [ Ollama / this computer ]', '  Use installed models; no cloud account needed.', '',
      '  [ Ollama / cloud ]', '  Remote models; no local weights required.', '',
      '  [ Continue without a model ]', '  Explore files, setup and local records.',
    ]);
    expect(c.slice(22, 29)).toEqual(['  [ Advanced: Cloudflare (optional) ]', '  A gateway in front of a provider; Timmy sends it nothing to check.', '', '  [ Show the Timmy guide ]', '', 'Local logs are included; cloud sync is optional and off.', '']);
    expect(f.screen[10].find((s) => s.text === '[ OpenRouter / cloud ]')?.role).toBe('accent');
    expect(t.join('\n')).not.toMatch(/MESSAGE|\[ Send \]/);
    // the rail, Models and the bottom as on every Chat screen
    expect(cols(t[10], 0, 17)).toBe(' > Chat');
    expect(models(t)[4]).toBe('MODELS           [ Details ]');
    expect(cols(t[35], 20, 121)).toMatch(/^\[Attach\]  \[Tools\]/);
    // the guide shown: its text after its row (the rows between the choices go to make it room), deterministic: the official
    // pages, what is set up here
    const g2 = center(text(frame(data(NONE), ui({ guide: true, cursor: { 'center:first': 5 } }))));
    expect(g2.slice(10, 13)).toEqual(['  [ OpenRouter / cloud ]', '  Use an API key from OpenRouter (typed in a shell, hidden).', '  [ Ollama / this computer ]']);
    expect(g2[20]).toBe('> [ Hide the Timmy guide ]');
    expect(g2.join('\n')).toMatch(/TIMMY GUIDE[\s\S]*https:\/\/openrouter\.ai\/settings\/keys[\s\S]*https:\/\/ollama\.com\/download[\s\S]*\[x\] Logs and records on this computer[\s\S]*\[ \] A model for the next turn/);
  });

  it('at 80x24 the choices without the rows between them, as the target; the advanced choice and the guide below them', () => {
    const t = text(frame(data(NONE), ui(), 80, 24));
    const c = t.map((r) => cols(r, 16, 79));
    expect(c[4]).toMatch(/^WELCOME TO TIMMY +\[ Models \]$/);
    expect(c.slice(7, 9)).toEqual(['How would you like to run chat?', 'Choose one. You can add the others later.']);
    expect(c.slice(10, 20)).toEqual([
      '> [ OpenRouter / cloud ]', '  Use an API key from OpenRouter (typed in a shell, hidden).',
      '  [ Ollama / this computer ]', '  Use installed models; no cloud account needed.',
      '  [ Ollama / cloud ]', '  Remote models; no local weights required.',
      '  [ Continue without a model ]', '  Explore files, setup and local records.',
      '  [ Advanced: Cloudflare (optional) ]', '  [ Show the Timmy guide ]',
    ]);
    expect(c[22]).toBe('[Tools]  [Budget]  [Logs]  [More]');
  });

  it('answered with Continue without a model: Chat says a model is optional until an answer is needed, Choose a model and Review setup choices; the composer keeps a draft', () => {
    const t = text(frame(data(NONE), ui({ firstRunDone: true, draft: 'a draft' })));
    expect(cols(t[1], 20, 121)).toBe('NEXT / Connect a model to chat');
    const c = center(t);
    expect(c[4]).toBe('CHAT / tray');
    expect(c[7]).toBe('A model is optional until you need an answer.');
    expect(c.slice(8, 10)).toEqual(['Project files, logs and records work without one; what you write is', 'kept as a draft until a model is chosen.']);
    expect(c.slice(11, 14)).toEqual(['> [ Choose a model ]', '  [ Review setup choices ]', '  [ Write a draft ]']);
    expect(c.slice(28, 30)).toEqual(['MESSAGE', 'draft: a draft']);
    // with a conversation kept, the conversation (the header and the composer say what is missing)
    const kept = center(text(frame(data({ ...NONE, chat: data().chat }), ui({ firstRunDone: true }))));
    expect(kept[7]).toBe('Not ready  timmy init (in a shell) sets up a route');
    expect(kept[9]).toMatch(/^YOU \/ \d\d:\d\d$/);
    expect(kept[29]).toBe('Connect a model to chat (a draft is kept)');
  });
});

describe('the bottom\'s drawers (R10 CHAT H167; the target\'s check: the Logs drawer keeps the draft and gives the keyboard back to its opener)', () => {
  it('Logs: over the conversation, where logs are kept, the recent turns (no receipt id), Open Logs & records; the composer and its draft in sight', () => {
    const f = frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 6 }, shellDrawer: 'logs', draft: 'kept words' }));
    const t = text(f);
    const c = center(t);
    expect(c[4]).toMatch(/^LOGS \/ this computer +\[ Close \]$/);
    expect(c[5]).toBe('─'.repeat(69));
    expect(c[7]).toMatch(/^Logs and records stay on this computer; cloud sync is off\./);
    expect(c[10]).toBe('RECENT TURNS');
    expect(c[11]).toMatch(/^\d\d:\d\d  answered  FAKE fake-qwen3:8b  here$/);
    expect(c[25]).toBe('> [ Open Logs & records ]  every receipt, run and log');
    expect(c.slice(28, 30)).toEqual(['MESSAGE', 'draft: kept words']);
    expect(f.screen[35].find((s) => s.text === '[Logs]')?.role).toBe('accent');
    expect(t.join('\n')).not.toMatch(/d2d756db|oc372c7b3/);
  });

  it('Budget: the next turn\'s model and price, free-only, Open settings; More at 80x24: the controls the row leaves out, each as its button acts or what it needs', () => {
    const b = center(text(frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 4 }, shellDrawer: 'budget' }))));
    expect(b[4]).toMatch(/^BUDGET \/ the next turn +\[ Close \]$/);
    expect(b[7]).toMatch(/^Next turn  FAKE fake-qwen3:8b \/ /);
    expect(b[8]).toBe('Free-only  off');
    expect(b[25]).toBe('> [ Open settings ]');
    const m = text(frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 3, shellDrawer: 1 }, shellDrawer: 'more' }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(m[4]).toMatch(/^THIS CONVERSATION +\[ Close \]$/);
    expect(m[7]).toMatch(/^  \[ Attach \]  needs the companion/);
    expect(m.slice(8, 12)).toEqual(['> [ Plan / Run ]', '  [ Permissions ]', '  [ Stop ]  needs a turn being answered here', '  [ Cloudflare ]']);
    expect(m[20]).toMatch(/^\[ Send \]/);
  });
});

describe('an unanswered message after a relaunch (R10 CHAT H167; H168\'s R3 at pass 2c)', () => {
  const asked = { role: 'user', text: 'Say one line about the tray project.', at: at(9) };
  const record = { role: 'assistant', text: UNANSWERED, at: at(4) };
  const said = (d: Partial<Data>) => center(text(frame(data(d), ui()))).join(' ').replace(/\s+/g, ' ');
  it('is said from its turn\'s record when one was sealed (failed, at its receipt\'s time); with none, the general words; never the stop\'s mark', () => {
    const failed = said({ chat: { session: 's1', total: 2, messages: [asked, record] }, turns: [{ receipt: 'aaaa1111', surface: 'workbench', state: 'failed', model: 'fake-qwen3:8b', at: new Date(at(9) + 3000).toISOString(), operation: null }] } as unknown as Partial<Data>);
    expect(failed).toMatch(/✕ failed: the turn ended without an answer · \d\d:\d\d:\d\d \(its receipt: Logs & records\)/);
    expect(failed).not.toMatch(/■|interrupted before Timmy could/);
    const none = said({ chat: { session: 's1', total: 2, messages: [asked, record] }, turns: [] } as unknown as Partial<Data>);
    expect(none).toMatch(/not answered: it was interrupted before Timmy could \(the program ended, or the request failed\)/);
    expect(none).not.toMatch(/■/);
  });
});

describe('Models with the providers\' states (R10 CHAT H167, step 5; H170\'s providerStates, FIXTURE states here)', () => {
  const STATES = [
    { id: 'openrouter', state: 'not set up', words: 'No OpenRouter key is set up.', next: 'Sign in with OpenRouter (a browser page; Timmy never asks for your password), or paste a key from openrouter.ai/keys' },
    { id: 'ollama-local', state: 'checked', at: iso(2), words: 'Checked 2 min ago: Ollama answered at 127.0.0.1:4463 with local models (no account, no charge).' },
    { id: 'ollama-cloud', state: 'not set up', words: 'No Ollama Cloud key is set up.', next: 'Paste an Ollama API key from ollama.com/settings/keys (no local install or download is needed for Ollama Cloud)' },
    { id: 'cloudflare', state: 'not set up', words: 'Optional, and read only here: Timmy never sends Cloudflare a request to check it (a request to an AI Gateway can create one and bill).', lines: ['Worker: not set up (no edge host in the private overlay or TIMMY_EDGE_HOST)'] },
  ];
  const withStates = (o: Partial<Data> = {}) => { const d = data(o); return { ...d, models: { ...d.models, providers: STATES } } as unknown as Data; };
  it('the shown provider\'s state on the row under MODELS, green only for a passed check (with its time); words, never colour alone', () => {
    const f = frame(withStates(), ui({ focus: 'right' }));
    expect(models(text(f))[5]).toMatch(/^checked \d\d:\d\d$/);
    expect(f.screen[5].find((s) => s.text.startsWith('checked'))?.role).toBe('live');
    const or = frame(withStates(OPENROUTER), ui({ focus: 'right' }));
    expect(models(text(or))[5]).toBe('not set up');
    expect(or.screen[5].find((s) => s.text === 'not set up')?.role).toBe('secondary');
  });

  it('Ollama cloud and Cloudflare: their own words, what is set up and the next step, wrapped to the rail', () => {
    const cloud = models(text(frame(withStates(), ui({ focus: 'right', modelsProvider: 'ollama-cloud' })))).join(' ').replace(/\s+/g, ' ');
    expect(cloud).toContain('OLLAMA CLOUD');
    expect(cloud).toContain('No Ollama Cloud key is set up.');
    expect(cloud).toMatch(/Next: Paste an Ollama API key from ollama\.com\/settings\/keys/);
    const cf = models(text(frame(withStates(), ui({ focus: 'right', modelsProvider: 'cloudflare' })))).join(' ').replace(/\s+/g, ' ');
    expect(cf).toContain('CLOUDFLARE (optional)');
    expect(cf).toMatch(/Timmy never sends Cloudflare a request to check it/);
    expect(cf).toMatch(/Worker: not set up/);
  });
});
