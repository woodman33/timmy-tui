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
import { pipelineLines } from '../src/workbench/hub.js';
import { centerView } from '../src/workbench/views.js';
import { evidenceSegs, spinnerFrame, toolRuns, turnCost, turnWhere } from '../src/workbench/chat-evidence.js';
import { chatGrid, ctxWords, ollamaRows, priceWords, queryRows, railCatalog, RAIL, RAIL_GROUPS, spendWords, type CatalogRow } from '../src/workbench/chat-shell.js';
import type { Data, Ui } from '../src/workbench/model.js';
import { clock, plain } from '../src/workbench/text.js';
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
    // (R11 step 2b: as readTurns reads a sealed turn now: how it went out, its seconds, its tools, verified in this reading)
    turns: [{ receipt: 'd2d756db', surface: 'workbench', state: 'answered', model: 'fake-qwen3:8b', at: iso(3), operation: 'oc372c7b3', ms: 2100, via: 'ollama', local: true, hash: 'sha256:fixture', verified: { ok: true }, tools: [{ name: 'Read', outcome: 'path=README.md · 12 lines' }] }],
    vox: [], native: {}, starters: [], boards: [], studio: { state: 'idle' }, overview: { state: 'idle' }, caps: { state: 'idle' }, details: {}, readAt: NOW, away: [],
    models: {
      openrouter: { from: 'shipped', at: '2026-09-07', rows: railCatalog(CATALOG) },
      // (R11: the probe's /api/show answer for it, as the real listing records it: a chat model)
      ollama: { state: 'listed', where: 'Ollama at 127.0.0.1:4463', rows: ollamaRows([{ name: 'fake-qwen3:8b', facts: 'local weights · 8B · Q4_K_M', chat: true }]), at: iso(1) },
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

  it('R11 step 3a: the rail in four groups: PROJECT, "> Chat" amber, WORK, CREATE, CONNECT (uppercase labels), "? Help  / find" at its foot; the plan\'s names kept for the finder and the companion', () => {
    const f = frame(data(), ui());
    const rail = text(f).map((r) => cols(r, 0, 17));
    expect(rail.slice(4, 8)).toEqual(['  PROJECT', '  tray v', '', '  + New project']);
    expect(RAIL.map((r) => r.label)).toEqual(['Chat', 'Files', 'Workflows', 'Runs & receipts', 'Canvas', 'Vision', 'Motion & 3D', 'Models & accounts', 'Tools & integrations', 'Control Room']);
    expect(RAIL_GROUPS.map((x) => [x.label, x.items.map((r) => r.id)])).toEqual([[null, ['chat']], ['WORK', ['files', 'workflows', 'logs', 'studio']], ['CREATE', ['voxvision', 'motion']], ['CONNECT', ['connections', 'tools', 'control']]]);
    expect(rail.slice(9, 25)).toEqual(['> Chat', '', '  WORK', '  Files', '  Workflows', '  Runs & receipts', '  Canvas', '', '  CREATE', '  Vision', '  Motion & 3D', '', '  CONNECT', '  Models & keys', '  Tools & MCP', '  Control Room']);
    expect(rail[34]).toBe('  ? Help  / find');
    expect(f.screen[9].find((s) => s.text.includes('Chat'))?.role).toBe('accent');
    expect(f.screen[11].find((s) => s.text === 'WORK')?.role).toBe('secondary');
    expect(f.screen[12].find((s) => s.text.includes('Files'))?.role).toBe('text');
    // the rail's items by row, Help and the finder each a cell of the footer row
    const items = f.regions.nav?.items ?? [];
    expect(items.map((x) => [x.item.kind === 'action' ? x.item.action : '', x.line])).toEqual([['project', 2], ['new', 4], ['chat', 6], ['files', 9], ['workflows', 10], ['logs', 11], ['studio', 12], ['voxvision', 15], ['motion', 16], ['connections', 19], ['tools', 20], ['control', 21], ['help', 31], ['find', 31]]);
    expect(items.slice(-2).map((x) => x.x)).toEqual([{ from: 2, to: 7 }, { from: 10, to: 15 }]);
    // (the rail is the Chat screen's: the other pages keep the tabbed frame, so only Chat is ever marked on it)
    expect(rail.filter((r) => r.startsWith('> '))).toEqual(['> Chat']);
  });

  it('the center: CHAT / project, YOU (grey) and TIMMY / the model that turn used (FAKE named), the rule, the composer (R11: › Message TIMMY…), [ Send ] with the chord hint and the model chip', () => {
    const f = frame(data(), ui());
    const c = center(text(f));
    expect(c[4]).toBe('CHAT / tray');
    expect(c[7]).toMatch(/^YOU \/ \d\d:\d\d$/);
    expect(c[8]).toBe('Summarise the newest run in one line.');
    expect(c[10]).toMatch(/^TIMMY \/ FAKE fake-qwen3:8b \/ \d\d:\d\d$/);
    expect(c[11]).toBe('FAKE answer from a stand-in: the run wrote two files.');
    // (R11 H167, step 2b: the evidence line under the answer, grey, two cells in; ✓ green: verified in this reading)
    expect(c[12]).toBe('  FAKE fake-qwen3:8b · this computer · 2.1 s · receipt d2d756db ✓');
    expect(c[13]).toBe('');
    expect(f.screen[12].find((s) => s.text.startsWith('FAKE fake-qwen3:8b'))?.role).toBe('secondary');
    expect(f.screen[12].find((s) => s.text === ' ✓')?.role).toBe('live');
    expect(c[27]).toBe('─'.repeat(69));
    // (R11 H167, step 1b/1c: two tinted rows with › and the placeholder; [ Send ] amber with the chord hint; the chip at the
    // right, green with the time Ollama's listing answered /api/show for the route's model)
    expect(c.slice(28, 30)).toEqual(['› Message TIMMY…', '']);
    // (the center's 69 cells hold the Send row's hint or the chip, not both: the chip on the row under it)
    // (R11 step 2; H168's pass 4a R29: while the conversation has the keyboard, the row says how the composer opens)
    expect(c[30]).toBe('[ Send ]  Enter or a letter opens the composer');
    expect(c[31]).toMatch(/^● FAKE fake-qwen3:8b · this computer · ready \d\d:\d\d$/);
    expect(c.slice(32, 34)).toEqual(['', '']);
    expect(f.screen[28].filter((s) => s.block).map((s) => s.text).join('')).toMatch(/^› Message TIMMY… +$/);
    expect(f.screen[29].filter((s) => s.block).map((s) => s.text).join('').length).toBeGreaterThanOrEqual(69);
    expect(f.screen[28].find((s) => s.text === '› ')?.role).toBe('text');
    expect(f.screen[30].find((s) => s.text === '[ Send ]')?.role).toBe('accent');
    expect(f.screen[31].find((s) => s.text === '●')?.role).toBe('live');
    expect(f.chip).toEqual({ x0: 20, x1: 20 + 50 - 1, y: 31 });
    expect(f.screen[7].find((s) => s.text.startsWith('YOU'))?.role).toBe('secondary');
    expect(f.screen[10].find((s) => s.text.startsWith('TIMMY'))?.bold).toBe(true);
  });

  it('R11 step 1b: the composer with the keyboard: › amber, the words and an inverse cursor on the tint; a newline (Ctrl+J) a second row; a long message its tail with …; a draft left shows in it', () => {
    const typing = frame(data(), ui({ input: { field: 'composer', text: 'Plan the next step.' } }));
    const c = center(text(typing));
    expect(c[28]).toBe('› Plan the next step.');
    expect(c[29]).toBe('');
    expect(typing.screen[28].find((s) => s.text === '› ')).toMatchObject({ role: 'accent', bold: true, block: true });
    const cursor = typing.screen[28].find((s) => s.inverse);
    expect(cursor).toMatchObject({ text: ' ', block: true });
    expect(typing.screen[28].indexOf(cursor!)).toBe(typing.screen[28].findIndex((s) => s.text === 'Plan the next step.') + 1);
    // (the lead's Mac run, R11 step 2: the way to Models from the composer, said beside Send)
    expect(c[30]).toBe('[ Send ]  Enter sends · Ctrl+J newline · Tab then Enter: Models');
    expect(c[31]).toMatch(/^● FAKE fake-qwen3:8b/);
    expect(typing.screen[30].find((s) => s.text === '[ Send ]')?.role).toBe('accent');
    // empty with the keyboard: the cursor, then the placeholder
    const empty = center(text(frame(data(), ui({ input: { field: 'composer', text: '' } }))));
    expect(empty[28]).toBe('›  Message TIMMY…');
    // a newline: the second row; three rows: the first shown row starts with …
    expect(center(text(frame(data(), ui({ input: { field: 'composer', text: 'first line\nsecond line' } })))).slice(28, 30)).toEqual(['› first line', '  second line']);
    expect(center(text(frame(data(), ui({ input: { field: 'composer', text: 'one\ntwo\nthree' } })))).slice(28, 30)).toEqual(['› …wo', '  three']);
    // a long row: cut into rows of the room (67 cells after the prompt)
    const long = 'x'.repeat(70);
    expect(center(text(frame(data(), ui({ input: { field: 'composer', text: long } })))).slice(28, 30)).toEqual([`› ${'x'.repeat(67)}`, `  ${'x'.repeat(3)}`]);
    // the draft left (Esc, Tab) shows in it, the › plain: nothing has the keyboard
    const left = frame(data(), ui({ draft: 'Plan the next step.' }));
    expect(center(text(left))[28]).toBe('› Plan the next step.');
    expect(left.screen[28].find((s) => s.text === '› ')?.role).toBe('text');
    expect(left.screen[28].some((s) => s.inverse)).toBe(false);
    // during this Workbench's own turn: [ Stop ] amber in the composer's row
    const turn = frame(data({ turn: { text: 'q', answer: '', state: 'sending', lines: [], sent: null, tools: [], at: NOW, operation: 'o1', route: 'r' } } as unknown as Partial<Data>), ui());
    expect(center(text(turn))[30]).toBe('[ Stop ]  Esc stops the turn being answered');
    expect(turn.screen[30].find((s) => s.text === '[ Stop ]')?.role).toBe('accent');
  });

  it('R11 step 1c: the model chip says the next turn\'s model, where it runs and its readiness, with its dot: checking amber, ready green after an answer (with the time), ✕ with the word on a failure, ○ with none; the name cut, never the state', () => {
    const chip = (d: Data, u: Ui, w = 122, h = 37) => text(frame(d, u, w, h)).map((r) => (w >= 110 ? cols(r, 20, 88) : cols(r, 16, 79))).find((r) => /^[●○✕] |^\[ Send \].* [●○✕] /.test(r))?.replace(/^\[ Send \].* (?=[●○✕] )/, '');
    const clockOf = (s: string) => clock(s).slice(0, 5);
    const NONE = { route: { kind: 'none', words: 'chat: none · no key, no model', ready: false }, chat: { session: null, total: 0, messages: [] }, turns: [] } as unknown as Partial<Data>;
    const local = data();
    // the choice's check first: checking, ready with its time, each failure's word
    expect(chip(local, ui({ modelCheck: { model: 'fake-qwen3:8b', state: 'checking', at: NOW, words: '' } }))).toBe('● FAKE fake-qwen3:8b · this computer · checking…');
    expect(chip(local, ui({ modelCheck: { model: 'fake-qwen3:8b', state: 'ready', at: Date.parse(iso(2)), words: '' } }))).toBe(`● FAKE fake-qwen3:8b · this computer · ready ${clockOf(iso(2))}`);
    expect(chip(local, ui({ modelCheck: { model: 'fake-qwen3:8b', state: 'unreachable', at: NOW, words: '' } }))).toBe('✕ FAKE fake-qwen3:8b · this computer · unreachable');
    expect(chip(local, ui({ modelCheck: { model: 'fake-qwen3:8b', state: 'not-installed', at: NOW, words: '' } }))).toBe('✕ FAKE fake-qwen3:8b · this computer · not installed');
    // another model's failed check does not speak for the route's: the listing's /api/show answer does (ready with its time);
    // another model being checked is the chip's while Ollama is asked (the choice under way)
    expect(chip(local, ui({ modelCheck: { model: 'other:latest', state: 'unreachable', at: NOW, words: '' } }))).toBe(`● FAKE fake-qwen3:8b · this computer · ready ${clockOf(iso(1))}`);
    expect(chip(local, ui({ modelCheck: { model: 'fake-other:1b', state: 'checking', at: NOW, words: '' } }))).toBe('● FAKE fake-other:1b · this computer · checking…');
    // the listing: not a chat model; not listed; Ollama did not answer; being read; not read yet
    const listed = (rows: ReturnType<typeof ollamaRows>, state: 'listed' | 'failed' | 'reading' = 'listed') => data({ models: { ollama: { state, where: 'Ollama', rows, at: iso(1) } } } as unknown as Partial<Data>);
    expect(chip(listed(ollamaRows([{ name: 'fake-qwen3:8b', facts: 'x', chat: false }])), ui())).toBe('✕ FAKE fake-qwen3:8b · this computer · not a chat model');
    expect(chip(listed(ollamaRows([{ name: 'fake-other:1b', facts: 'x', chat: true }])), ui())).toBe('✕ FAKE fake-qwen3:8b · this computer · not listed by Ollama');
    expect(chip(listed([], 'failed'), ui())).toBe('✕ FAKE fake-qwen3:8b · this computer · unreachable');
    expect(chip(listed([], 'reading'), ui())).toBe('● FAKE fake-qwen3:8b · this computer · checking…');
    expect(chip(data({ models: {} }), ui())).toBe('○ FAKE fake-qwen3:8b · this computer · not checked');
    // no model: choose one; a key and no model chosen: said so
    expect(chip(data(NONE), ui({ firstRunDone: true }))).toBe('○ no model · choose one (M)');
    expect(chip(data({ route: { kind: 'openrouter', words: 'chat: anthropic/claude-opus-4.7 · OpenRouter', ready: true, unchosen: 'anthropic/claude-opus-4.7' } } as unknown as Partial<Data>), ui())).toBe('○ no model chosen · choose one (M)');
    // OpenRouter: the catalog's price, and the key's check (H170's providerStates): saved not checked, checked with its time, refused
    const or = (state?: 'checked' | 'refused') => data({ ...OPENROUTER, models: { ...data().models, providers: state ? [{ id: 'openrouter', state, words: 'x', ...(state === 'checked' ? { at: iso(2) } : {}) }] : [] } } as unknown as Partial<Data>);
    // (a FIXTURE route is named FAKE, as every FAKE is; the id is cut by its characters to the room, the state kept whole)
    expect(chip(or(), ui())).toBe('○ FAKE fixture-maker/ne… · OpenRouter · free · key saved, not checked');
    expect(chip(or('checked'), ui())).toBe(`● FAKE fixture-maker/newest-… · OpenRouter · free · key checked ${clockOf(iso(2))}`);
    expect(chip(or('refused'), ui())).toBe('✕ FAKE fixture-maker/newest-model:… · OpenRouter · free · key refused');
    // a wide terminal shows the whole id
    expect(text(frame(or(), ui(), 160, 45)).map((r) => cols(r, 20, 126)).find((r) => /^○ /.test(r))).toBe('○ FAKE fixture-maker/newest-model:free · OpenRouter · free · key saved, not checked');
    // at 80x24 the chip has its own row under [ Send ]; the header's row 1 is blank there (the chip says the next turn's model)
    const narrow = text(frame(local, ui(), 80, 24));
    expect(cols(narrow[1], 16, 79)).toBe('');
    expect(narrow.map((r) => cols(r, 16, 79)).slice(16, 19)).toEqual(['› Message TIMMY…', '[ Send ]  Enter or a letter opens the composer', expect.stringMatching(/^● FAKE fake-qwen3:8b · this computer · ready \d\d:\d\d$/)]);
    expect(frame(local, ui(), 80, 24).chip).toEqual({ x0: 16, x1: 16 + 50 - 1, y: 18 });
    // a long name is cut to the room, the state kept whole
    const longName = data({ route: { kind: 'local', words: 'chat: local fake-qwen3-coder-30b-a3b-instruct-with-a-very-long-tag:latest · Ollama', ready: true }, models: { ollama: { state: 'listed', where: 'Ollama', rows: ollamaRows([{ name: 'fake-qwen3-coder-30b-a3b-instruct-with-a-very-long-tag:latest', facts: 'x', chat: true }]), at: iso(1) } } } as unknown as Partial<Data>);
    expect(chip(longName, ui(), 80, 24)).toMatch(/^● FAKE fake-qwen3-coder-30b-a3b… · this computer · ready \d\d:\d\d$/);
    // with the keyboard on it (Tab from the composer): amber
    const on = frame(local, ui({ chip: true }));
    expect(on.screen[31].find((s) => s.text.startsWith('FAKE fake-qwen3:8b'))).toMatchObject({ role: 'accent', bold: true });
  });

  it('Models for the local route: MODELS [ Details ] (amber with the keyboard), the four providers, INSTALLED, the list, SELECTED / the model', () => {
    const f = frame(data(), ui({ focus: 'right' }));
    const m = models(text(f));
    expect(m[4]).toBe('MODELS [M]       [ Details ]');
    expect(f.screen[4].find((s) => s.text === 'MODELS')?.role).toBe('accent');
    expect(m.slice(6, 10)).toEqual(['  OpenRouter', '> Ollama local', '  Ollama cloud', '  Cloudflare (optional)']);
    expect(m[12]).toMatch(/^INSTALLED \/ read \d\d:\d\d$/);
    expect(m.slice(14, 16)).toEqual(['> FAKE fake-qwen3:8b', '  8B · Q4_K_M']);
    expect(m.slice(18, 21)).toEqual(['Runs on this computer. A', 'local model does not require', 'a cloud account.']);
    expect(m[27]).toBe('─'.repeat(28));
    // the name does not fit beside SELECTED / in 28 cells: it takes the next row
    expect(m.slice(28, 34)).toEqual(['SELECTED', 'FAKE fake-qwen3:8b', 'local weights · 8B · Q4_K_M', 'The next turn uses it.', 'no charge / this computer', expect.stringMatching(/^Listed by Ollama: \d\d:\d\d$/)]);
  });

  it('Models on OpenRouter: Search, the five label/value rows, the list (Cost Free only: what it lists), SELECTED (the next turn\'s model) or MODEL (another under the cursor) with its prices and the catalog\'s date', () => {
    const m = models(text(frame(data(OPENROUTER), ui({ focus: 'right' }))));
    expect(m.slice(6, 10)).toEqual(['> OpenRouter', '  Ollama local', '  Ollama cloud', '  Cloudflare (optional)']);
    expect(m[11]).toBe('Search name or model id');
    // (H168's pass 3a, R3: Cost says whether its value is the person's or the route's: free-only here, so Free (route))
    expect(m.slice(13, 19)).toEqual(['Sort       recent', 'Maker      All', 'Capability All', 'Cost       Free (route)', 'Context    All', '─'.repeat(28)]);
    expect(m.slice(20, 23)).toEqual(['> FIXTURE: Newest (free)', '  262k context / Free', '']);
    expect(m.slice(28, 34)).toEqual(['SELECTED', 'FIXTURE: Newest (free)', 'A FIXTURE model added last…', 'The next turn uses it.', '$0 in / $0 out / 1M tokens', 'Catalog snapshot: Sep 7']);
    // Cost All: every model, Recently added (the catalog's added date) first; a priced one is not the free-only route's
    const all = models(text(frame(data(OPENROUTER), ui({ focus: 'right', modelsCost: 'all', cursor: { 'right:models': 2 } }))));
    expect(all[16]).toBe('Cost       All');
    expect(all.slice(20, 26)).toEqual(['  FIXTURE: Newest (free)', '  262k context / Free', '  FIXTURE: Middle model', '  1M context / price unknown', '> FIXTURE: Older model', '  32k context / $0.50/$1.50']);
    // (the lead's Mac check of 50237ef: only the next turn's model is SELECTED; another under the cursor is MODEL / <model>)
    expect(all.slice(28, 34)).toEqual(['MODEL / FIXTURE: Older model', 'A FIXTURE model added first.', '', 'Priced: not under free-only.', '$0.50 in / $1.50 out per 1M', 'Catalog snapshot: Sep 7']);
    // no row for the next turn's model (its list not read yet): the route's model, said so; with no route, MODEL / none
    const unread = models(text(frame(data({ models: { ...data().models, ollama: { state: 'reading', where: 'Ollama', rows: [] } } } as unknown as Partial<Data>), ui())));
    expect(unread.slice(28, 31)).toEqual(['SELECTED', 'FAKE fake-qwen3:8b', 'Not listed here yet.']);
    const none = models(text(frame(data({ route: { kind: 'none', words: 'chat: none', ready: false }, models: { ...data().models, ollama: { state: 'reading', where: 'Ollama', rows: [] } } } as unknown as Partial<Data>), ui({ modelsProvider: 'ollama-local' }))));
    expect(none[28]).toBe('MODEL / none');
    expect(none.join('\n')).not.toMatch(/SELECTED/);
  });

  it('the bottom: the actions in the target\'s order and words; the status row: logs here, idle, cloud sync off, the spend, the size; no id, hash, port or path', () => {
    const t = text(frame(data(), ui()));
    // (R11 step 3b: one compact row; the status row in sentences; R17c: the spend in a few words)
    expect(cols(t[35], 20, 121)).toBe('[Attach]  [Tools]  [Budget]  [Logs]');
    expect(cols(t[36], 20, 121)).toMatch(/^Logs stay on this computer +cloud sync off · spend no charge · 122 x 37$/);
    // what waits on you counts on Tools (Permissions is under it)
    expect(cols(text(frame(data({ decisions: { ...data().decisions, total: 2 } } as Partial<Data>), ui()))[35], 20, 121)).toBe('[Attach]  [Tools 2]  [Budget]  [Logs]');
    // a running turn is said after the logs; a paid OpenRouter route's spend in and out per 1M (R17c)
    const paid = data({ route: { kind: 'openrouter', words: 'chat: fixture-maker/older-model · OpenRouter', ready: true }, journeyRoute: { provider: 'openrouter', model: 'fixture-maker/older-model', where: 'cloud', fake: false, ready: true, words: 'chat: fixture-maker/older-model · OpenRouter', price: { state: 'declared', free: false, words: '$0.20 per million tokens in, $0.80 out (as OpenRouter lists it)' } } } as unknown as Partial<Data>);
    expect(cols(text(frame(paid, ui()))[36], 20, 121)).toMatch(/^Logs stay on this computer +cloud sync off · spend \$0\.20 in \/ \$0\.80 out per 1M · 122 x 37$/);
    expect(spendWords({ model: 'x', price: 'price as OpenRouter lists it (not read here)' })).toBe('as OpenRouter lists it');
    expect(spendWords({ model: 'x', price: 'cost unknown' })).toBe('unknown');
    expect(spendWords({ model: 'x', price: 'free' })).toBe('free');
    expect(spendWords({ model: null, price: 'unknown' })).toBe('none (no model)');
    const running = data({ turn: { text: 'Hello?', answer: '', state: 'sending', lines: [], sent: null, tools: [], at: NOW - 1000 } } as unknown as Partial<Data>);
    // (the spend gives way to the longer sentence: the size keeps the row's right end)
    expect(cols(text(frame(running, ui()))[36], 20, 121)).toMatch(/^Logs stay on this computer · 1 running \(the chat turn\) +cloud sync off · 122 x 37$/);
    expect(t.join('\n')).not.toMatch(/oc372c7b3|127\.0\.0\.1|4463|\/p\/tray|~\/timmy/);
    // (R11 step 2b: the receipt's short id is on the answer's evidence line, nowhere else)
    expect(t.filter((r) => /d2d756db/.test(r))).toHaveLength(1);
    // a control with no capability behind it says what it needs, where the bottom has the keyboard
    const attach = text(frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 0 } })));
    expect(cols(attach[36], 20, 121)).toMatch(/^Attach: needs the companion: the terminal attaches no files yet/);
  });
});

describe('the Chat screen at 80x24 (R10 CHAT H167; terminal-target captures/04-chat-80x24, 06-models-drawer-80x24)', () => {
  it('the rail 0-13, the separator at 14, the center 15-79; [M] Models on the title row (its key; H168\'s pass 3a R7); [Tools] [Budget] [Logs] [More]', () => {
    expect(chatGrid(80, 24)).toMatchObject({ railW: 14, centerX: 15, centerW: 65, cx: 16, cw: 62, sepR: null, contentH: 18 });
    const t = text(frame(data(), ui(), 80, 24));
    expect(t).toHaveLength(24);
    for (const r of t) expect([...r].length).toBe(80);
    for (let y = 3; y < 24; y++) expect([...t[y]][14]).toBe('│');
    expect(cols(t[0], 16, 26)).toBe('tray / Chat');
    expect(cols(t[0], 64, 79)).toBe('LOCAL RECORDS');
    expect(cols(t[4], 16, 79)).toMatch(/^CHAT \/ tray +\[M\] Models$/);
    const rail = t.map((r) => cols(r, 0, 13));
    // (R11 step 3a: the groups packed, + New under the project, the short names, the footer "? Help  /")
    expect(rail.slice(4, 8)).toEqual(['  PROJECT', '  tray', '  + New', '']);
    expect(rail.slice(6, 22)).toEqual(['  + New', '', '> Chat', '  WORK', '  Files', '  Workflows', '  Runs', '  Canvas', '  CREATE', '  Vision', '  Motion & 3D', '  CONNECT', '  Models', '  Tools', '  Control', '  ? Help  /']);
    const c = t.map((r) => cols(r, 16, 79));
    expect(c[7]).toMatch(/^YOU \/ \d\d:\d\d$/);
    expect(c[15]).toBe('─'.repeat(62));
    // (R11 H167, step 1b/1c: one tinted row, [ Send ] with the chord hint, the chip on its own row; the header's row 1 blank)
    expect(cols(t[1], 16, 79)).toBe('');
    expect(c[16]).toBe('› Message TIMMY…');
    expect(c[17]).toBe('[ Send ]  Enter or a letter opens the composer');
    expect(c[18]).toMatch(/^● FAKE fake-qwen3:8b · this computer · ready \d\d:\d\d$/);
    expect(c[22]).toBe('[Tools]  [Budget]  [More]');
    expect(c[23]).toMatch(/^Logs stay on this computer +cloud sync off · 80 x 24$/);
  });

  it('Models a drawer over the center only ([ Close ], the providers on one row), the composer\'s action row in sight; the rail and the draft as they were', () => {
    const t = text(frame(data(), ui({ modelsOpen: true, focus: 'right', draft: 'kept words' }), 80, 24));
    const c = t.map((r) => cols(r, 16, 79));
    expect(c[4]).toMatch(/^MODELS +\[ Close \]$/);
    expect(c[5]).toBe('─'.repeat(62));
    expect(c[6]).toBe('  OpenRouter   > Local     Cloud     Cloudflare');
    expect(c[8]).toMatch(/^INSTALLED \/ read \d\d:\d\d$/);
    expect(c[10]).toBe('> FAKE fake-qwen3:8b / 8B · Q4_K_M');
    // (R11 H167: the drawer stops above the Send row: it and the chip stay in sight under it, the chip a click's target)
    expect(c[17]).toBe('[ Send ]  Enter or a letter opens the composer');
    expect(c[18]).toMatch(/^● FAKE fake-qwen3:8b · this computer · ready \d\d:\d\d$/);
    expect(frame(data(), ui({ modelsOpen: true, focus: 'right', draft: 'kept words' }), 80, 24).chip).toEqual({ x0: 16, x1: 65, y: 18 });
    expect(t.map((r) => cols(r, 0, 13))[8]).toBe('> Chat');
    expect(cols(text(frame(data(), ui({ draft: 'kept words' }), 80, 24))[16], 16, 79)).toBe('› kept words');
    const or = text(frame(data(OPENROUTER), ui({ modelsOpen: true, focus: 'right', modelsCost: 'all' }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(or[6]).toBe('> OpenRouter     Local     Cloud     Cloudflare');
    expect(or[7]).toBe('Search name or model id');
    expect(or.slice(9, 13)).toEqual([expect.stringMatching(/^Sort: recent +Maker: All$/), expect.stringMatching(/^Capability: All +Cost: All$/), 'Context: All', '─'.repeat(62)]);
    // (R11: two rows of the list under the controls, then the keys' row (step 3, H168's R34: the drawer's last row says what
    // Enter does); the Send row and the chip below the drawer)
    expect(or.slice(14, 17)).toEqual(['> FIXTURE: Newest (free) / 262k context / Free', '  FIXTURE: Middle model / 1M context / price unknown', 'Enter chooses · Esc closes']);
    expect(or[17]).toBe('[ Send ]  Enter or a letter opens the composer');
  });

  it('100x30 and 160x45 keep the grid: the compact rail and the drawer at 100, the wide grid with a taller conversation at 160', () => {
    const m = text(frame(data(), ui(), 100, 30));
    for (const r of m) expect([...r].length).toBe(100);
    expect([...m[10]][14]).toBe('│');
    expect(cols(m[4], 16, 99)).toMatch(/^CHAT \/ tray +\[M\] Models$/);
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
    // (the source's makers as H169's query gives them, for the Maker control: H168's pass 3a, R3)
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent' })).toMatchObject({ total: 3, makers: [{ id: 'fixture-maker', count: 2 }, { id: 'other-maker', count: 1 }] });
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
      '> [ OpenRouter / cloud ]', '  Sign in with OpenRouter in your browser, or paste a key.', '',
      '  [ Ollama / this computer ]', '  Use installed models; no cloud account needed.', '',
      '  [ Ollama / cloud ]', '  Remote models; no local weights required.', '',
      '  [ Continue without a model ]', '  Explore files, setup and local records.',
    ]);
    expect(c.slice(22, 29)).toEqual(['  [ Advanced: Cloudflare (optional) ]', '  A gateway in front of a provider; Timmy sends it nothing to check.', '', '  [ Show the Timmy guide ]', '', 'Local logs are included; cloud sync is optional and off.', '']);
    expect(f.screen[10].find((s) => s.text === '[ OpenRouter / cloud ]')?.role).toBe('accent');
    expect(t.join('\n')).not.toMatch(/Message TIMMY|\[ Send \]/);
    // the rail, Models and the bottom as on every Chat screen
    expect(cols(t[9], 0, 17)).toBe('> Chat');
    // (the time is the product's own clock() of the listing's instant: CI runs in UTC, the dev box in PT; R11 lead)
    // (R11 step 2; H168's pass 4a R30: before a choice the right pane lists the four providers' states only: no catalog rows,
    // no cursor on a priced model, no [ Details ]; the local Ollama's state is its own answer to the listing)
    expect(models(t)[4]).toBe('MODELS [M]');
    expect(models(t).slice(6, 14)).toEqual(['  OpenRouter', '    not set up', '  Ollama local', `    Ollama answered ${clock(iso(1)).slice(0, 5)}`, '  Ollama cloud', '    not set up', '  Cloudflare (optional)', '    not set up']);
    expect(models(t).slice(15, 20).join(' ').replace(/\s+/g, ' ').trim()).toBe('Choose how chat runs: the question in the center (Enter on a choice) reads that provider\'s models here.');
    expect(f.screen[9].find((s) => s.text.startsWith('Ollama answered'))?.role).toBe('live');
    expect(f.regions.right?.items).toEqual([]);
    expect(t.join('\n')).not.toMatch(/FIXTURE: Newest|\$0\.50|> FAKE fake-qwen3:8b/);
    // (a provider chosen in the center: its list, as before)
    const chosen = models(text(frame(data(NONE), ui({ modelsProvider: 'ollama-local', firstRunDone: true }))));
    expect(chosen[4]).toBe('MODELS [M]       [ Details ]');
    // (the drawer at 80x24, M on the first run: the states on their rows)
    const d = text(frame(data(NONE), ui({ modelsOpen: true, focus: 'right' }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(d.slice(6, 10)).toEqual(['  OpenRouter  not set up', `  Ollama local  Ollama answered ${clock(iso(1)).slice(0, 5)}`, '  Ollama cloud  not set up', '  Cloudflare (optional)  not set up']);
    expect(cols(t[35], 20, 121)).toMatch(/^\[Attach\]  \[Tools\]/);
    // the guide shown: its text after its row (the rows between the choices go to make it room), deterministic: the official
    // pages, what is set up here
    const g2 = center(text(frame(data(NONE), ui({ guide: true, cursor: { 'center:first': 5 } }))));
    expect(g2.slice(10, 13)).toEqual(['  [ OpenRouter / cloud ]', '  Sign in with OpenRouter in your browser, or paste a key.', '  [ Ollama / this computer ]']);
    expect(g2[20]).toBe('> [ Hide the Timmy guide ]');
    expect(g2.join('\n')).toMatch(/TIMMY GUIDE[\s\S]*https:\/\/openrouter\.ai\/keys[\s\S]*https:\/\/ollama\.com\/download[\s\S]*\[x\] Logs and records on this computer[\s\S]*\[ \] A model for the next turn/);
  });

  it('at 80x24 the choices without the rows between them, as the target; the advanced choice and the guide below them', () => {
    const t = text(frame(data(NONE), ui(), 80, 24));
    const c = t.map((r) => cols(r, 16, 79));
    expect(c[4]).toMatch(/^WELCOME TO TIMMY +\[M\] Models$/);
    expect(c.slice(7, 9)).toEqual(['How would you like to run chat?', 'Choose one. You can add the others later.']);
    expect(c.slice(10, 20)).toEqual([
      '> [ OpenRouter / cloud ]', '  Sign in with OpenRouter in your browser, or paste a key.',
      '  [ Ollama / this computer ]', '  Use installed models; no cloud account needed.',
      '  [ Ollama / cloud ]', '  Remote models; no local weights required.',
      '  [ Continue without a model ]', '  Explore files, setup and local records.',
      '  [ Advanced: Cloudflare (optional) ]', '  [ Show the Timmy guide ]',
    ]);
    expect(c[22]).toBe('[Tools]  [Budget]  [More]');
  });

  it('answered with Continue without a model: Chat says a model is optional until an answer is needed, Choose a model and Review setup choices; the composer keeps a draft', () => {
    const t = text(frame(data(NONE), ui({ firstRunDone: true, draft: 'a draft' })));
    expect(cols(t[1], 20, 121)).toBe('NEXT / Connect a model to chat');
    const c = center(t);
    expect(c[4]).toBe('CHAT / tray');
    expect(c[7]).toBe('A model is optional until you need an answer.');
    expect(c.slice(8, 10)).toEqual(['Project files, logs and records work without one; what you write is', 'kept as a draft until a model is chosen.']);
    expect(c.slice(11, 14)).toEqual(['> [ Choose a model ]', '  [ Review setup choices ]', '  [ Write a draft ]']);
    // (R11 H167: the draft in the composer; Send dim with the reason; the chip says no model)
    // (a chip short enough sits at the Send row's right)
    expect(c.slice(28, 30)).toEqual(['› a draft', '']);
    expect(c[30]).toMatch(/^\[ Send \]  no model: M chooses one +○ no model · choose one \(M\)$/);
    expect(c[31]).toBe('');
    // with a conversation kept, the conversation (the header and the composer say what is missing)
    const kept = center(text(frame(data({ ...NONE, chat: data().chat }), ui({ firstRunDone: true }))));
    // (H168's pass 3a, R4: in the Chat screen's words, Models chooses the model)
    expect(kept[7]).toBe('Not ready  no model for the next turn: Models (M) chooses one');
    expect(kept[9]).toMatch(/^YOU \/ \d\d:\d\d$/);
    expect(kept[28]).toBe('› Message TIMMY…');
    expect(kept[30]).toMatch(/^\[ Send \]  no model: M chooses one +○ no model · choose one \(M\)$/);
  });
});

describe('the bottom\'s drawers (R10 CHAT H167; the target\'s check: the Logs drawer keeps the draft and gives the keyboard back to its opener)', () => {
  it('Logs: over the conversation, where logs are kept, the recent turns (no receipt id), Open Logs & records; the composer and its draft in sight', () => {
    const f = frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 3 }, shellDrawer: 'logs', draft: 'kept words' }));
    const t = text(f);
    const c = center(t);
    expect(c[4]).toMatch(/^LOGS \/ this computer +\[ Close \]$/);
    expect(c[5]).toBe('─'.repeat(69));
    expect(c[7]).toMatch(/^Logs and records stay on this computer; cloud sync is off\./);
    expect(c[10]).toBe('RECENT TURNS');
    expect(c[11]).toMatch(/^\d\d:\d\d  answered  FAKE fake-qwen3:8b  here$/);
    expect(c[25]).toBe('> [ Open Logs & records ]  every receipt, run and log');
    expect(c.slice(28, 30)).toEqual(['› kept words', '']);
    expect(f.screen[35].find((s) => s.text === '[Logs]')?.role).toBe('accent');
    expect(t.join('\n')).not.toMatch(/d2d756db|oc372c7b3/);
  });

  it('Budget: the next turn\'s model and price, free-only and local-only and where each really switches, Open settings; More at 80x24: the controls the row leaves out, each as its button acts or what it needs', () => {
    const b = center(text(frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 2 }, shellDrawer: 'budget' }))));
    expect(b[4]).toMatch(/^BUDGET \/ the next turn +\[ Close \]$/);
    expect(b[7]).toMatch(/^Next turn  FAKE fake-qwen3:8b \/ /);
    expect(b[8]).toBe('Free-only  off');
    expect(b[9]).toBe('Local-only off');
    // (the lead's 20:06 note: the REPL's commands and the environment switch them; Settings here does not)
    expect(b.join(' ')).toMatch(/Free-only and local-only switch in the REPL \(timmy\): \/model free-only on\|off and \/model local-only on\|off; TIMMY_CHAT_FREE_ONLY=1 or TIMMY_CHAT_LOCAL_ONLY=1 sets one for what runs with it\. Settings here does not switch them\./);
    expect(b.join(' ')).not.toMatch(/Settings turns free-only/);
    // the policy as read with the route: on, said so
    const on = center(text(frame(data({ route: { ...data().route, policy: { freeOnly: true, localOnly: true } } } as unknown as Partial<Data>), ui({ focus: 'bottom', cursor: { shellBottom: 2 }, shellDrawer: 'budget' }))));
    expect(on.slice(8, 10)).toEqual(['Free-only  on: a model the catalog does not price at 0 is not used', 'Local-only on: no cloud route, fallback or tool model call']);
    expect(b[25]).toBe('> [ Open settings ]');
    // (R11 step 3b: More holds what the compact row leaves out, Attach and Logs)
    const m = text(frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 2, shellDrawer: 1 }, shellDrawer: 'more' }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(m[4]).toMatch(/^THIS CONVERSATION +\[ Close \]$/);
    expect(m[7]).toMatch(/^  \[ Attach \]  needs the companion/);
    expect(m[8]).toBe('> [ Logs ]');
    expect(m[17]).toMatch(/^\[ Send \]/);
  });

  it('R11 step 3b: Tools opens a drawer: Open Tools & integrations, then MORE CONTROLS (Plan / Run, Permissions with its count, Cloudflare); Stop lives in the composer', () => {
    const t = center(text(frame(data({ decisions: { ...data().decisions, total: 2 } } as Partial<Data>), ui({ focus: 'bottom', cursor: { shellBottom: 1 }, shellDrawer: 'tools' }))));
    expect(t[4]).toMatch(/^TOOLS +\[ Close \]$/);
    expect(t[7]).toBe('> [ Open Tools & integrations ]  every tool and MCP server, its rung…');
    expect(t[9]).toBe('MORE CONTROLS');
    expect(t.slice(10, 13)).toEqual(['  [ Plan / Run ]  Workflows: the blocks, Enter runs one after it asks', '  [ Permissions 2 ]  the Control Room: what waits on you', '  [ Cloudflare ]  Models on Cloudflare (optional)']);
    expect(t[14]).toBe('Stop lives in the composer: [ Stop ] during the turn, or Esc there.');
    expect(t.join('\n')).not.toMatch(/\[ Stop \]  needs/);
    const second = center(text(frame(data(), ui({ focus: 'bottom', cursor: { shellBottom: 1, shellDrawer: 2 }, shellDrawer: 'tools' }))));
    expect(second[11]).toBe('> [ Permissions ]  the Control Room: what waits on you');
  });

  it('R11 step 3a: the finder (/ and the rail\'s "/ find") is a box over the conversation: the workspaces the words name, the plan\'s names too, the first marked', () => {
    const f = center(text(frame(data(), ui({ overlay: { kind: 'find' }, input: { field: 'search', text: 'runs' } }))));
    expect(f[7]).toMatch(/^Find a workspace  type its name/);
    expect(f[9]).toBe('/ runs');
    expect(f[11]).toMatch(/^> Logs & Receipts  Runs & receipts · Logs & records  · Logs and/);
    const canvas = center(text(frame(data(), ui({ overlay: { kind: 'find' }, input: { field: 'search', text: 'canv' } }))));
    expect(canvas[11]).toBe('> Studio  Canvas  · Studio outline');
    const acc = center(text(frame(data(), ui({ overlay: { kind: 'find' }, input: { field: 'search', text: 'accounts' } }))));
    expect(acc[11]).toBe('> Connections  Models & accounts · Models & keys  · Connections');
    const none = center(text(frame(data(), ui({ overlay: { kind: 'find' }, input: { field: 'search', text: 'zzz' } }))));
    expect(none[11]).toBe('No workspace is named "zzz". Enter searches All tools for it.');
    const all = center(text(frame(data(), ui({ overlay: { kind: 'find' }, input: { field: 'search', text: '' } }))));
    expect(all[11]).toBe('> Chat  · Conversation');
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
  it('the shown provider\'s state on the row under MODELS, green only for an answer seen or a passed check (with its time); words, never colour alone', () => {
    // the local Ollama answered Models' own listing a minute ago: that is said first (H170's word is the program's install)
    const f = frame(withStates(), ui({ focus: 'right' }));
    // (H168's pass 3b, R21: who answered, said, so it is not read as a turn's time)
    expect(models(text(f))[5]).toMatch(/^Ollama answered \d\d:\d\d$/);
    expect(f.screen[5].find((s) => s.text.startsWith('Ollama answered'))?.role).toBe('live');
    const failed = frame(withStates({ models: { ...data().models, ollama: { state: 'failed', where: 'Ollama', rows: [], at: iso(1), why: 'FIXTURE: refused' } } } as unknown as Partial<Data>), ui({ focus: 'right' }));
    expect(models(text(failed))[5]).toMatch(/^Ollama did not answer \d\d:\d\d$/);
    // not listed yet: H170's word for it, green only for its passed check
    const checked = frame(withStates({ models: { ...data().models, ollama: undefined } } as unknown as Partial<Data>), ui({ focus: 'right' }));
    expect(models(text(checked))[5]).toMatch(/^Ollama checked \d\d:\d\d$/);
    expect(checked.screen[5].find((s) => s.text.startsWith('Ollama checked'))?.role).toBe('live');
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

describe('the local list as the probe checks it; no SELECTED claim without a route (R10 CHAT H167; the lead\'s Mac check of 50237ef)', () => {
  // FAKE: what a local Ollama lists, each with the probe's /api/show check (two do not establish a chat model)
  const LOCAL = ollamaRows([
    { name: 'clef-flash:latest', facts: 'local weights · mxfp8 · 12.4 GB', chat: false },
    { name: 'embeddinggemma-2:latest', facts: 'local weights · nvfp4 · 1.3 GB', chat: false },
    { name: 'hf.co/fixture-maker/a-very-long-model-name-GGUF:Q4_K_M', facts: 'local weights · 27.3B · Q4_K_M · 18.5 GB', chat: true },
    { name: 'fake-qwen3:8b', facts: 'local weights · 8B · Q4_K_M', chat: true },
  ]);
  const local = (o: Partial<Data> = {}) => data({ models: { ...data().models, ollama: { state: 'listed', where: 'Ollama', rows: LOCAL, at: iso(1) } }, ...o } as Partial<Data>);
  const NONE = { route: { kind: 'local', words: 'chat: local · no model chosen · /model', ready: false }, chat: { session: null, total: 0, messages: [] }, turns: [] } as unknown as Partial<Data>;

  it('a model the check does not establish says "not a chat model" in its facts\' place; a long name is cut where the row ends, never dropped', () => {
    // (the local list by name: the cursor on the long one)
    const m = models(text(frame(local(), ui({ focus: 'right', cursor: { 'right:models': 3 } }))));
    expect(m.slice(14, 22)).toEqual(['  clef-flash:latest', '  not a chat model', '  embeddinggemma-2:latest', '  not a chat model', '  FAKE fake-qwen3:8b', '  8B · Q4_K_M', '> hf.co/fixture-maker/a-ver…', '  27.3B · Q4_K_M · 18.5 GB']);
    // where it runs, under them, whole (three rows here) or not at all
    expect(m.slice(22, 26)).toEqual(['', 'Runs on this computer. A', 'local model does not require', 'a cloud account.']);
  });

  it('with no route chosen (the first run, Ollama / this computer chosen) the cursor\'s model is MODEL, never SELECTED, and nothing says the next turn uses it; a non-chat one says so', () => {
    // (R11 step 2, R30: before a choice the first run's pane lists the providers' states; the list is read for the choice)
    expect(models(text(frame(local(NONE), ui()))).slice(6, 10)).toEqual(['  OpenRouter', '    not set up', '  Ollama local', `    Ollama answered ${clock(iso(1)).slice(0, 5)}`]);
    const first = models(text(frame(local(NONE), ui({ modelsProvider: 'ollama-local', firstRunDone: true }))));
    expect(first[28]).toBe('MODEL / clef-flash:latest');
    expect(first.join('\n')).not.toMatch(/SELECTED|next turn uses it/);
    expect(first[31]).toBe('Not a chat model (checked).');
    // the next turn's model, once chosen, is SELECTED; another under the cursor is MODEL
    const chosen = models(text(frame(local(), ui({ focus: 'right', cursor: { 'right:models': 2 } }))));
    expect(chosen.slice(28, 30)).toEqual(['SELECTED', 'FAKE fake-qwen3:8b']);
    const other = models(text(frame(local(), ui({ focus: 'right', cursor: { 'right:models': 3 } }))));
    expect(other[28]).toBe('MODEL');
    expect(other[29]).toBe('hf.co/fixture-maker/a-very-…');
    // a route that names a model the check does not establish: it is not SELECTED either, and says why
    const named = models(text(frame(local({ route: { kind: 'local', words: 'chat: local clef-flash:latest · Ollama', ready: true } } as unknown as Partial<Data>), ui())));
    expect(named[28]).toBe('MODEL / clef-flash:latest');
    expect(named.join('\n')).not.toMatch(/SELECTED|next turn uses it/);
    expect(named[31]).toBe('Not a chat model (checked).');
  });

  it('a long list scrolls by whole models: the cursor\'s name and facts both in view, no facts without their name', () => {
    const many = ollamaRows(Array.from({ length: 12 }, (_, i) => ({ name: `fixture-model-${String(i + 1).padStart(2, '0')}:latest`, facts: `local weights · ${i + 1}B`, chat: true })));
    const d = data({ models: { ...data().models, ollama: { state: 'listed', where: 'Ollama', rows: many, at: iso(1) } } } as Partial<Data>);
    for (const at of [0, 5, 6, 11]) {
      const m = models(text(frame(d, ui({ focus: 'right', cursor: { 'right:models': at } }))));
      const list = m.slice(14, 26);
      expect(list[0], `the first row at cursor ${at}`).toMatch(/^[> ] fixture-model-\d+:latest$/);
      const mine = list.indexOf(`> fixture-model-${String(at + 1).padStart(2, '0')}:latest`);
      expect(mine, `the cursor's name at ${at}`).toBeGreaterThanOrEqual(0);
      expect(list[mine + 1], `its facts at ${at}`).toBe(`  ${at + 1}B`);
      // no facts row without its name: every name row is followed by its facts within the list's rows
      expect(list.filter((r) => /fixture-model/.test(r)).length * 2).toBe(list.filter((r) => r !== '').length);
    }
  });

  it('in the drawer (80x24) a long name is cut so that its facts fit beside it on its row, never one without the other', () => {
    const t = text(frame(local(), ui({ modelsOpen: true, focus: 'right' }), 80, 24));
    expect(t.find((r) => r.includes('hf.co/'))).toContain('  hf.co/fixture-maker/a-very-long-… / 27.3B · Q4_K_M · 18.5 GB');
    expect(t.some((r) => r.includes('  clef-flash:latest / not a chat model'))).toBe(true);
  });

  it('a relaunch after an answered turn shows the conversation even with no model chosen (not the first run\'s question)', () => {
    const kept = center(text(frame(data({ route: { kind: 'local', words: 'chat: local · no model chosen · /model', ready: false } } as Partial<Data>), ui())));
    expect(kept[4]).toBe('CHAT / tray');
    expect(kept.join('\n')).toMatch(/YOU \/ \d\d:\d\d/);
    expect(kept.join('\n')).not.toMatch(/WELCOME TO TIMMY|How would you like to run chat/);
  });
});

describe('Connect OpenRouter\'s box (R10 CHAT H167; the lead\'s Mac check of 50237ef, item 3)', () => {
  const NONE = { route: { kind: 'none', words: 'chat: none', ready: false }, chat: { session: null, total: 0, messages: [] }, turns: [] } as unknown as Partial<Data>;
  const box = (o: Record<string, unknown>) => ({ kind: 'connect', provider: 'openrouter', ...o }) as unknown as Ui['overlay'];
  // FIXTURE: a string of a key's shape (not a key)
  const KEY = 'FIXTURE-not-a-real-key-0123456789';

  it('the first run says OpenRouter is signed in or pasted here, not typed in a shell', () => {
    const c = center(text(frame(data(NONE), ui())));
    expect(c).toContain('  Sign in with OpenRouter in your browser, or paste a key.');
    expect(c.join('\n')).not.toMatch(/typed in a shell/);
  });

  it('its choices first: sign in, paste a key, cancel; nothing sent before one', () => {
    const c = center(text(frame(data(NONE), ui({ overlay: box({ step: 'choose' }) }))));
    expect(c).toContain('Connect OpenRouter');
    expect(c).toContain('> [ Sign in with OpenRouter ]');
    expect(c).toContain('  [ Paste a key ]');
    expect(c).toContain('  [ Cancel ]');
    expect(c.join(' ')).toMatch(/Nothing is sent until you choose; no account, purchase or credit is made here\./);
  });

  it('the hidden field says how many characters were typed, never which, at every width', () => {
    for (const [w, h] of [[122, 37], [80, 24]] as const) {
      const f = text(frame(data(NONE), ui({ overlay: box({ step: 'paste' }), input: { field: 'secret', text: KEY } }), w, h));
      expect(f.join('\n'), `${w}x${h}`).toContain(`› ${KEY.length} characters typed (hidden)`);
      expect(f.join('\n'), `${w}x${h}`).not.toContain(KEY);
      expect(f.join('\n'), `${w}x${h}`).not.toContain(KEY.slice(0, 12));
    }
    const empty = text(frame(data(NONE), ui({ overlay: box({ step: 'code' }), input: { field: 'secret', text: '' } })));
    expect(empty.join('\n')).toContain('› nothing typed yet (hidden)');
    expect(empty.join('\n')).toMatch(/If the browser is on another computer/);
  });

  it('the sign-in\'s address is shown whole across its rows, with Open, the code\'s field and Cancel; R11 step 3e (H168\'s R22): its rows read on without a break, and c copies it where the terminal takes OSC 52', () => {
    const url = 'https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A9%2Fopenrouter%2Fcallback%2FFIXTURE-path&code_challenge=FIXTURE-challenge-FIXTURE-challenge-FIXTURE&code_challenge_method=S256';
    const c = center(text(frame(data(NONE), ui({ overlay: box({ step: 'signin', url }) }))));
    // (no indent, each row the center's whole 69 cells but the last: a selection of the rows reads on)
    const at = c.findIndex((r) => r.startsWith('https://'));
    const rows: string[] = [];
    for (let k = at; k >= 0 && /^\S+$/.test(c[k] ?? ''); k++) rows.push(c[k]);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(0, -1).every((r) => [...r].length === 69)).toBe(true);
    expect(rows.join('')).toBe(url);
    expect(c[at - 1]).toBe('secret); its rows read on without a break:');
    // the copy row: what is known of the terminal (nothing asked of it): unknown, known to take it, known not to
    expect(c.slice(at + rows.length, at + rows.length + 3)).toEqual(['c sends it to the clipboard (OSC 52; the paste shows whether this', 'terminal took it). m gives the mouse back to the terminal to select', 'it.']);
    const yes = center(text(frame(data(NONE), ui({ overlay: box({ step: 'signin', url }), clipboard: 'yes' }))));
    expect(yes.slice(at + rows.length, at + rows.length + 2)).toEqual(['c copies it to the clipboard (OSC 52, which this terminal takes by', 'default).']);
    const no = center(text(frame(data(NONE), ui({ overlay: box({ step: 'signin', url }), clipboard: 'no' }))));
    expect(no.slice(at + rows.length, at + rows.length + 2)).toEqual(['Terminal.app takes no clipboard escape (OSC 52): m gives the mouse', 'back to the terminal to select it, or Open it in the browser.']);
    expect(no.join(' ')).not.toMatch(/\bc (?:sends|copies)/);
    expect(c).toContain('> [ Open it in the browser ]');
    expect(c).toContain('  [ Type the code from the browser ]');
    expect(c.join(' ')).toMatch(/Esc cancels the sign-in; nothing is saved then\./);
  });

  it('what came of it, in words: the key saved (its fingerprint, not the key) and the route as read; or nothing saved', () => {
    const ok = center(text(frame(data(NONE), ui({ overlay: box({ step: 'done', ok: true, words: 'Saved, not checked: the OpenRouter key (key 0123456789ab) is in providers.json in the Timmy home (0600).', route: 'The route as read now: FIXTURE route words.' }) }))));
    expect(ok).toContain('OpenRouter: the key is saved');
    expect(ok.join(' ')).toMatch(/Saved, not checked: the OpenRouter key \(key 0123456789ab\)/);
    // (H168's pass 3b, R17: the check comes first: it runs no model)
    expect(ok).toContain('> [ Check the key ]');
    expect(ok.join(' ').replace(/\s+/g, ' ')).toMatch(/Asks OpenRouter's key endpoint whether it takes the key: no model is called, nothing is charged\. \(GET https:\/\/openrouter\.ai\/api\/v1\/key\)/);
    expect(ok).toContain('  [ Choose an OpenRouter model ]');
    const no = center(text(frame(data(NONE), ui({ overlay: box({ step: 'done', ok: false, words: 'The sign-in timed out after 300 s with no answer from the browser: nothing was saved.' }) }))));
    expect(no).toContain('OpenRouter: nothing was saved');
    expect(no).toContain('> [ Sign in again ]');
    expect(no).toContain('  [ Paste a key ]');
  });
});

describe('H168\'s pass 3b on the Chat screen\'s frames (R10 CHAT H167): R17, R5b', () => {
  // FIXTURE: a key saved in a home with no chat answer, the settings' shipped default nobody chose (state.ts readRoute's unchosen)
  const UNCHOSEN = { route: { kind: 'openrouter', words: 'chat: anthropic/claude-opus-4.7 · OpenRouter', ready: true, unchosen: 'anthropic/claude-opus-4.7' } } as unknown as Partial<Data>;
  const EMPTY = { chat: { session: null, total: 0, messages: [] }, turns: [] } as unknown as Partial<Data>;
  const START = { modelsProvider: 'openrouter', modelsCost: 'free', modelsCostStart: true } as Partial<Ui>;

  it('R17: a key and no model chosen: no next-turn model in the header, Models (MODEL / none, Cost Free (start)) or the no-model view (Choose a model); not the first run', () => {
    const t = text(frame(data({ ...UNCHOSEN, ...EMPTY }), ui(START)));
    expect(cols(t[1], 20, 121)).toBe('NEXT / OpenRouter / no model chosen: Models (M)');
    const c = center(t);
    expect(c[4]).toBe('CHAT / tray');
    expect(c[7]).toBe('A model is optional until you need an answer.');
    expect(c.join(' ')).toMatch(/OpenRouter's key is saved, and no model is chosen for the next turn: Choose a model opens Models on OpenRouter, Cost Free only to start with\./);
    expect(c).toContain('> [ Choose a model ]');
    const m = models(t);
    expect(m[16]).toBe('Cost       Free (start)');
    expect(m.slice(20, 22)).toEqual(['> FIXTURE: Newest (free)', '  262k context / Free']);
    expect(m[28]).toBe('MODEL / none');
    expect(m.slice(29, 32).join(' ')).toBe('No model is chosen for the next turn: M, then Enter on one.');
    expect(t.join('\n')).not.toMatch(/SELECTED|The next turn uses it|claude-opus/);
    // Models with the keyboard: the cursor's row is the one Enter would choose, said so (never SELECTED)
    const f = models(text(frame(data({ ...UNCHOSEN, ...EMPTY }), ui({ ...START, focus: 'right' }))));
    expect(f[20]).toBe('> FIXTURE: Newest (free)');
    expect(f.slice(28, 30)).toEqual(['MODEL', 'FIXTURE: Newest (free)']);
    expect(f[31]).toBe('None chosen: Enter picks it.');
    // a kept conversation: Not ready, and the composer says where a model is chosen
    const k = center(text(frame(data(UNCHOSEN), ui())));
    expect(k[7]).toBe('Not ready  no model for the next turn: Models (M) chooses one');
    expect(k[28]).toBe('› Message TIMMY…');
    expect(k.slice(30, 32)).toEqual(['[ Send ]  no model chosen: M chooses one', '○ no model chosen · choose one (M)']);
  });

  it('R5b: in the 80x24 drawer a long FAKE name after its short word is cut by its characters, never to "FAKE…"', () => {
    const rows = ollamaRows([{ name: 'fake-qwen3-coder-30b-a3b-instruct:latest', facts: 'local weights · 30.5B · Q4_K_M · 18.6 GB', chat: true }]);
    const d = data({ models: { ...data().models, ollama: { state: 'listed', where: 'Ollama', rows, at: iso(1) } } } as Partial<Data>);
    const row = text(frame(d, ui({ modelsOpen: true, focus: 'right' }), 80, 24)).find((r) => r.includes('30.5B')) ?? '';
    expect(row).toMatch(/> FAKE fake-qwen3-coder-30b-a3b-in… \/ 30\.5B · Q4_K_M · 18\.6 GB/);
    expect(row).not.toMatch(/FAKE… /);
  });

  it('R17b and R23: with no OpenRouter model chosen Models starts on the free ones at every launch (no Cost set); Search filters OpenRouter\'s list only', () => {
    // a relaunch: the key kept, no model chosen, no Cost set by anyone
    const relaunch = models(text(frame(data({ ...UNCHOSEN, ...EMPTY }), ui({ modelsProvider: 'openrouter' }))));
    expect(relaunch[16]).toBe('Cost       Free (start)');
    expect(relaunch[20]).toBe('> FIXTURE: Newest (free)');
    // once a model is chosen, All is the default again
    expect(models(text(frame(data(OPENROUTER), ui({ modelsProvider: 'openrouter', modelsCost: undefined }))))[16]).toBe('Cost       Free (route)');
    expect(models(text(frame(data(), ui({ modelsProvider: 'openrouter' }))))[16]).toBe('Cost       All (default)');
    // a search typed on OpenRouter's list does not empty the local one (it draws no Search row)
    const local = models(text(frame(data(), ui({ focus: 'right', modelsProvider: 'ollama-local', modelsSearch: 'flash' }))));
    expect(local).toContain('> FAKE fake-qwen3:8b');
    expect(local).not.toContain('Ollama lists no model.');
  });

  it('R17: a priced model the next turn uses says so, with its price per 1M tokens, before the first send; a free one as before', () => {
    const priced = models(text(frame(data({ route: { kind: 'openrouter', words: 'chat: fixture-maker/older-model · OpenRouter', ready: true } } as unknown as Partial<Data>), ui({ focus: 'right', modelsProvider: 'openrouter', modelsCost: 'all' }))));
    expect(priced.slice(28, 34)).toEqual(['SELECTED', 'FIXTURE: Older model', 'A FIXTURE model added first.', 'The next turn uses it, paid:', '$0.50 in / $1.50 out per 1M', 'Catalog snapshot: Sep 7']);
    const free = models(text(frame(data(OPENROUTER), ui({ focus: 'right' }))));
    expect(free.slice(28, 34)).toEqual(['SELECTED', 'FIXTURE: Newest (free)', 'A FIXTURE model added last…', 'The next turn uses it.', '$0 in / $0 out / 1M tokens', 'Catalog snapshot: Sep 7']);
  });
});

describe('H168\'s pass 3a on the Chat screen\'s frames (R10 CHAT H167): R1, R3, R4, R7, R10', () => {
  it('R3: the control the keyboard is on says so, its value between < >; Cost says whether its value is the person\'s, the default or the route\'s; the query keeps what the filters say', () => {
    const cost = models(text(frame(data(OPENROUTER), ui({ focus: 'right', modelsControl: 4 }))));
    expect(cost[16]).toBe('Cost       < Free (route) >');
    expect(models(text(frame(data(), ui({ focus: 'right', modelsProvider: 'openrouter' }))))[16]).toBe('Cost       All (default)');
    expect(models(text(frame(data(), ui({ focus: 'right', modelsProvider: 'openrouter', modelsCost: 'all' }))))[16]).toBe('Cost       All');
    // Maker and Context set (H169's query: maker, minContext): only what both keep
    const maker = models(text(frame(data(OPENROUTER), ui({ focus: 'right', modelsControl: 2, modelsMaker: 'other-maker', modelsContext: 128_000, modelsCost: 'all' }))));
    // (both FIXTURE makers' labels are "FIXTURE": the id says which, never the same word for two makers)
    expect(maker[14]).toBe('Maker      < other-maker >');
    expect(maker[17]).toBe('Context    128k or more');
    expect(maker.slice(20, 23)).toEqual(['> FIXTURE: Middle model', '  1M context / price unknown', '']);
    // Search typed into: each key filters
    const search = models(text(frame(data(OPENROUTER), ui({ focus: 'right', modelsControl: 0, modelsCost: 'all', modelsSearch: 'older', input: { field: 'msearch', text: 'older' } }))));
    expect(search[11]).toBe('Search older');
    expect(search.slice(20, 23)).toEqual(['> FIXTURE: Older model', '  32k context / $0.50/$1.50', '']);
    // the drawer at 80x24: the pair under the keyboard
    const d = text(frame(data(OPENROUTER), ui({ modelsOpen: true, focus: 'right', modelsControl: 4 }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(d[10]).toMatch(/^Capability: All +Cost: < Free \(route\) >$/);
  });

  it('R1: a failed listing is dated, and the footer says the route\'s model is not listed because Ollama did not answer', () => {
    const f = models(text(frame(data({ models: { ...data().models, ollama: { state: 'failed', where: 'Ollama', rows: [], at: iso(2), why: 'FIXTURE: refused' } } } as unknown as Partial<Data>), ui())));
    expect(f[12]).toMatch(/^NO ANSWER \/ asked \d\d:\d\d$/);
    // (R11 step 2; H168's pass 4a R33: the failure's words, then the next step)
    expect(f[13]).toBe('FIXTURE: refused');
    expect(f.slice(14, 16).join(' ')).toBe('Start Ollama (ollama serve), then r asks again.');
    expect(f.slice(28, 31)).toEqual(['SELECTED', 'FAKE fake-qwen3:8b', 'Not listed: no answer.']);
  });

  it('R4: a kept conversation with no model says so in the Chat screen\'s words, with no garbled cause', () => {
    const refusal = ['Error: no model key, and the chat is not set to the local model, so this message was not sent.', 'Cause: no OPENROUTER_API_KEY, and the setup stored no key; its chat answer is OpenRouter, or none yet.', 'Try: timmy init --chat openrouter (it asks for the key, hidden)'];
    const t = center(text(frame(data({ route: { kind: 'none', words: 'chat: no model key · /setup', ready: false, refusal } } as unknown as Partial<Data>), ui())));
    expect(t.join('\n')).toMatch(/Not ready +no model for the next turn: Models \(M\) chooses one/);
    expect(t.join('\n')).not.toMatch(/Cause|a setting \(\[i\]\)/);
  });

  it('R7: Models\' key on the screen: [M] beside MODELS, [M] Models on the compact title row', () => {
    expect(models(text(frame(data(), ui())))[4]).toMatch(/^MODELS \[M\] +\[ Details \]$/);
    expect(cols(text(frame(data(), ui(), 80, 24))[4], 16, 79)).toMatch(/^CHAT \/ tray +\[M\] Models$/);
  });

  it('R10: Help (?) on the Chat screen lists its own keys (the pane order, M, /, i, the drawers), not the tabbed layout\'s', () => {
    const h = center(text(frame(data(), ui({ overlay: { kind: 'help' } } as Partial<Ui>))));
    const all = h.join('\n');
    // (R11 step 3c: CHAT's keys on the first page, MODELS' after; Tab under MOVING AROUND, on a later page: `whole` below)
    expect(all).toMatch(/Enter +in the conversation, opens the composer/);
    expect(all).toMatch(/M +Models: beside the conversation, or a drawer below/);
    expect(all).not.toMatch(/row 1|row 2|◆|the ten tabs/);
    // (R11 step 3c: grouped by task, a group's name on its own row; the later groups on the next pages)
    expect(h.filter((r) => /^(CHAT|MODELS|MOVING AROUND|RUNS)$/.test(r))).toEqual(['CHAT', 'MODELS']);
    expect(all).toMatch(/a letter +in the conversation, opens the composer with it\n +typed \(after the draft\)/);
    const whole = centerView({ ui: ui({ overlay: { kind: 'help' } } as Partial<Ui>), data: data(), g, width: 69, height: 20, now: NOW, can, columns: 122, inChat: true }).lines.map(plain);
    expect(whole.filter((r) => /^(CHAT|MODELS|MOVING AROUND|RUNS)$/.test(r))).toEqual(['CHAT', 'MODELS', 'MOVING AROUND', 'RUNS']);
    expect(whole[whole.indexOf('MODELS') - 1]).toBe('');
    expect(whole.join('\n')).toMatch(/Tab +the next pane: the left menu, the conversation,/);
    // the title row says which of its rows show (the Keys' first line says it does)
    expect(h[4]).toMatch(/^CHAT \/ tray +Keys 1–\d+ of \d+$/);
  });
});

describe('R11 step 2a: the welcome of an empty conversation with a model on the route (the plan\'s section 2; the handoff\'s 10:20 PT words)', () => {
  // FIXTURE: the local route set up (the fixture's FAKE model), nothing said in this project yet
  const EMPTY = { chat: { session: null, total: 0, messages: [] }, turns: [] } as unknown as Partial<Data>;

  it('122x37: the three lines, START WITH and the four starter actions with their lines, the cursor on no choice; the composer and the chip below', () => {
    const f = frame(data(EMPTY), ui());
    const t = text(f);
    expect(cols(t[1], 20, 121)).toBe('NEXT / Ollama local / FAKE fake-qwen3:8b');
    const c = center(t);
    expect(c[4]).toBe('CHAT / tray');
    expect(c.slice(7, 13)).toEqual([
      'TIMMY runs tools and workflows on your machine and keeps a receipt',
      'for every step.',
      'Write below and press Enter: the model on the chip answers.',
      'Logs and receipts stay on this computer, in this project\'s .timmy',
      'folder: Logs & records lists them.',
      '',
    ]);
    expect(c[13]).toBe('START WITH');
    // (each choice's line whole, on two rows; the blank rows between the choices give way to them at 31 content rows)
    expect(c.slice(14, 27)).toEqual([
      '  [ Ask about this project ]', '  A question typed as a draft: what the project does and what ran', '  here last.',
      '  [ Inspect an image ]', '  VoxVision: what Timmy measured on this project\'s images; /inspect', '  in the REPL inspects a new one.',
      '  [ Run a workflow ]', '  Workflows: this project\'s WORKFLOW.md blocks; Enter runs one after', '  it asks.',
      '  [ Open the canvas ]', '  Studio in your browser (s): this project\'s runs and drafts as', '  cards.', '',
    ]);
    expect(f.screen[7].find((s) => s.text.startsWith('TIMMY runs'))).toMatchObject({ role: 'strong', bold: true });
    expect(f.screen[10].find((s) => s.text.startsWith('Logs and receipts'))?.role).toBe('secondary');
    expect(f.screen[14].find((s) => s.text === '[ Ask about this project ]')?.role).toBe('strong');
    // the choices are the center's items (list center:first), one of two rows each; no "No conversation here yet"
    expect(f.regions.center).toMatchObject({ list: 'center:first' });
    expect(f.regions.center?.items.map((x) => [x.item.kind === 'action' ? x.item.action : '', x.line, x.rows])).toEqual([['ask', 7, 3], ['inspect', 10, 3], ['run', 13, 3], ['canvas', 16, 3]]);
    expect(t.join('\n')).not.toMatch(/No conversation here yet/);
    expect(c.slice(28, 30)).toEqual(['› Message TIMMY…', '']);
    expect(c[30]).toBe('[ Send ]  Enter or a letter opens the composer');
    expect(c[31]).toMatch(/^● FAKE fake-qwen3:8b · this computer · ready \d\d:\d\d$/);
  });

  it('the cursor on a choice: "> [ … ]" amber while the center has the keyboard, plain while the composer has it', () => {
    const on = frame(data(EMPTY), ui({ cursor: { 'center:first': 1 } }));
    const c = center(text(on));
    expect(c[14]).toBe('  [ Ask about this project ]');
    expect(c[17]).toBe('> [ Inspect an image ]');
    expect(on.screen[17].find((s) => s.text === '[ Inspect an image ]')).toMatchObject({ role: 'accent', bold: true, selected: true });
    const typing = center(text(frame(data(EMPTY), ui({ cursor: { 'center:first': 1 }, input: { field: 'composer', text: 'a draft' } }))));
    expect(typing[17]).toBe('  [ Inspect an image ]');
    expect(typing[28]).toBe('› a draft');
  });

  it('80x24: the three lines wrapped, START WITH, the choices two to a row (each its own cell for a click); the composer under them', () => {
    const f = frame(data(EMPTY), ui({ cursor: { 'center:first': 3 } }), 80, 24);
    const t = text(f);
    const c = t.map((r) => cols(r, 16, 79));
    expect(c.slice(7, 15)).toEqual([
      'TIMMY runs tools and workflows on your machine and keeps a',
      'receipt for every step.',
      'Write below and press Enter: the model on the chip answers.',
      'Logs and receipts stay on this computer, in this project\'s',
      '.timmy folder: Logs & records lists them.',
      'START WITH',
      '  [ Ask about this project ]   [ Inspect an image ]',
      '  [ Run a workflow ] > [ Open the canvas ]',
    ]);
    expect(c[15]).toBe('─'.repeat(62));
    expect(c[16]).toBe('› Message TIMMY…');
    const items = f.regions.center?.items ?? [];
    expect(items.map((x) => [x.item.kind === 'action' ? x.item.action : '', x.line, x.x?.from, x.x?.to])).toEqual([['ask', 6, 1, 28], ['inspect', 6, 30, 51], ['run', 7, 1, 20], ['canvas', 7, 22, 42]]);
    expect(f.screen[14].find((s) => s.text === '[ Open the canvas ]')).toMatchObject({ role: 'accent', selected: true });
  });

  it('not the welcome: the first run (no model, not answered), Chat with no model, a conversation kept, a turn being answered', () => {
    const none = { route: { kind: 'none', words: 'chat: none · no key, no model', ready: false } } as unknown as Partial<Data>;
    expect(center(text(frame(data({ ...EMPTY, ...none }), ui())))[7]).toBe('How would you like to run chat?');
    expect(center(text(frame(data({ ...EMPTY, ...none }), ui({ firstRunDone: true }))))[7]).toBe('A model is optional until you need an answer.');
    expect(center(text(frame(data(), ui())))[7]).toMatch(/^YOU \/ \d\d:\d\d$/);
    const sending = center(text(frame(data({ ...EMPTY, turn: { text: 'Hello?', answer: '', state: 'sending', lines: [], sent: null, tools: [], at: NOW - 1000 } } as unknown as Partial<Data>), ui())));
    expect(sending.join('\n')).not.toMatch(/START WITH/);
    expect(sending.join('\n')).toMatch(/BEING ANSWERED NOW/i);
  });
});

describe('R11 step 2b: the evidence line under each answer, and its activity (src/workbench/chat-evidence.ts)', () => {
  const turn = (o: Partial<Data['turns'][number]> = {}): Data['turns'][number] => ({ ...data().turns[0], ...o });
  const convo = (turns: Data['turns'], o: Partial<Data> = {}): Data => data({ turns, ...o });
  const lineUnder = (d: Data, u: Ui = ui(), columns = 122, rows = 37) => {
    const f = frame(d, u, columns, rows);
    const c = columns === 122 ? center(text(f)) : text(f).map((r) => cols(r, 16, 79));
    const i = c.findIndex((r) => /^TIMMY \//.test(r));
    return { f, c, i, line: c[i + 2], segs: f.screen[i + 2] };
  };

  it('"<model> · <where> · <seconds> · receipt <id8> ✓": ✓ green only when verified in this reading; no mark otherwise; not verified says nothing on the line', () => {
    expect(lineUnder(convo([turn()])).line).toBe('  FAKE fake-qwen3:8b · this computer · 2.1 s · receipt d2d756db ✓');
    const not = lineUnder(convo([turn({ verified: undefined })]));
    expect(not.line).toBe('  FAKE fake-qwen3:8b · this computer · 2.1 s · receipt d2d756db');
    expect(not.segs.some((s) => s.role === 'live')).toBe(false);
    expect(lineUnder(convo([turn({ verified: { ok: false, reason: 'its body hash differs' } })])).line).toBe('  FAKE fake-qwen3:8b · this computer · 2.1 s · receipt d2d756db');
  });

  it('where: this computer, another computer, OpenRouter with its cost as sealed (measured, reported, unknown: never zero when unknown); not recorded said so', () => {
    const words = (t: Data['turns'][number]) => plain(evidenceSegs(t));
    expect(lineUnder(convo([turn({ local: false })])).line).toBe('  FAKE fake-qwen3:8b · another computer · 2.1 s · receipt d2d756db ✓');
    expect(words(turn({ via: 'openrouter', local: undefined, model: 'fixture-maker/newest-model:free', cost: { usd: 0, measured: true } }))).toBe('fixture-maker/newest-model:free · OpenRouter · $0 · 2.1 s · receipt d2d756db ✓');
    expect(words(turn({ via: 'openrouter', local: undefined, model: 'fixture-maker/older-model', cost: { usd: 0.0012, measured: false } }))).toBe('fixture-maker/older-model · OpenRouter · $0.0012 (reported) · 2.1 s · receipt d2d756db ✓');
    expect(words(turn({ via: 'openrouter', local: undefined, model: 'fixture-maker/older-model', cost: { usd: null, measured: false } }))).toBe('fixture-maker/older-model · OpenRouter · cost unknown · 2.1 s · receipt d2d756db ✓');
    expect(words(turn({ via: undefined, local: undefined, ms: undefined, model: null }))).toBe('model not recorded · where not recorded · time not recorded · receipt d2d756db ✓');
    // where the center's 69 cells do not hold them whole: the model's name cut first (whole on the row above), then the
    // cost gives way (the opened facts say it); the receipt's id never
    expect(lineUnder(convo([turn({ via: 'openrouter', local: undefined, model: 'fixture-maker/newest-model:free', cost: { usd: 0, measured: true } })])).line).toBe('  fixture-maker/newes… · OpenRouter · $0 · 2.1 s · receipt d2d756db ✓');
    expect(lineUnder(convo([turn({ via: 'openrouter', local: undefined, model: 'fixture-maker/older-model', cost: { usd: 0.0012, measured: false } })])).line).toBe('  fixture-maker/older-model · OpenRouter · 2.1 s · receipt d2d756db ✓');
    expect(lineUnder(convo([turn({ via: 'openrouter', local: undefined, model: 'fixture-maker/older-model', cost: { usd: null, measured: false } })])).line).toBe('  fixture-m… · OpenRouter · cost unknown · 2.1 s · receipt d2d756db ✓');
  });

  it('"no receipt" (amber) where none is sealed near the answer; a stopped or failed turn says so first', () => {
    const none = lineUnder(convo([]));
    expect(none.line).toBe('  no receipt');
    expect(none.segs.find((s) => s.text === 'no receipt')?.role).toBe('attention');
    // (a receipt sealed an hour before the answer is not its)
    expect(lineUnder(convo([turn({ at: iso(63) })])).line).toBe('  no receipt');
    expect(lineUnder(convo([turn({ state: 'failed' })])).line).toBe('  failed · FAKE fake-qw… · this computer · 2.1 s · receipt d2d756db ✓');
    expect(plain(evidenceSegs(turn({ state: 'stopped' })))).toBe('stopped · FAKE fake-qwen3:8b · this computer · 2.1 s · receipt d2d756db ✓');
    expect(lineUnder(convo([turn({ state: 'failed' })])).segs.find((s) => s.text === 'failed')?.role).toBe('failure');
  });

  it('at 80x24 (62 cells) the model\'s name is cut to what the row leaves it; the where, the seconds, the receipt and the ✓ stay whole', () => {
    expect(lineUnder(convo([turn()]), ui(), 80, 24).line).toBe('  FAKE fake-qwen… · this computer · 2.1 s · receipt d2d756db ✓');
    const long = lineUnder(convo([turn({ model: 'fake-qwen3-coder-30b-a3b-instruct-q4_K_M:latest' })]), ui(), 80, 24);
    expect(long.line).toBe('  FAKE fake-qwen… · this computer · 2.1 s · receipt d2d756db ✓');
    expect([...long.line].length).toBeLessThanOrEqual(62);
  });

  it('opened (Ui.evidenceOpen by the answer\'s key): the tools the turn ran as grouped rows, then the receipt\'s facts; the selected answer\'s rows on the selection\'s ground', () => {
    const d = convo([turn()]);
    const key = `at:${d.chat.messages[1].at}`;
    const open = lineUnder(d, ui({ evidenceOpen: { [key]: true } }));
    expect(open.c.slice(open.i + 2, open.i + 7)).toEqual([
      '  FAKE fake-qwen3:8b · this computer · 2.1 s · receipt d2d756db ✓',
      '  ● Read',
      '    └ path=README.md · 12 lines',
      `  sealed ${clock(iso(3))} · operation oc372c7b3 · answered · no charge`,
      '  verified ✓',
    ]);
    expect(open.f.screen[open.i + 6].find((s) => s.text === 'verified ')?.role).toBe('live');
    // no tool, not verified, not checked, no receipt: each said
    const bare = lineUnder(convo([turn({ tools: undefined, verified: { ok: false, reason: 'its body hash differs' } })]), ui({ evidenceOpen: { [key]: true } }));
    expect(bare.c.slice(bare.i + 3, bare.i + 6)).toEqual(['  no tool ran', `  sealed ${clock(iso(3))} · operation oc372c7b3 · answered · no charge`, '  not verified: its body hash differs']);
    expect(bare.f.screen[bare.i + 5].find((s) => s.text.startsWith('not verified'))?.role).toBe('failure');
    // (with its one tool's two rows above the facts: the fixture's turn ran Read)
    expect(lineUnder(convo([turn({ verified: undefined })]), ui({ evidenceOpen: { [key]: true } })).c[bare.i + 6]).toBe('  receipt not checked');
    const none = lineUnder(convo([]), ui({ evidenceOpen: { [key]: true } }));
    expect(none.c.slice(none.i + 2, none.i + 5)).toEqual(['  no receipt', '  no tool ran', '  no receipt for this answer: none sealed, or another project\'s']);
    // selected (↑ ↓ or a click): the answer's rows, the line and its activity on the selection's ground
    const sel = lineUnder(d, ui({ evidenceOpen: { [key]: true }, chosen: { 'center:chat': true }, cursor: { 'center:chat': 1 }, sel: { 'center:chat': 'msg:1' } }));
    for (const y of [sel.i, sel.i + 1, sel.i + 2, sel.i + 3, sel.i + 5, sel.i + 6]) expect(sel.f.screen[y].some((s) => s.selected), `row ${y} selected`).toBe(true);
    expect(sel.f.regions.center?.items[1]).toMatchObject({ item: { kind: 'message', evidence: key }, rows: 7 });
  });

  it('this Workbench\'s own turn being answered: its tools as grouped rows, the one still running with the spinner (silence looks like a hang)', () => {
    const d = data({ turn: { text: 'Which files?', answer: 'Reading', state: 'sending', lines: [], sent: true, tools: [{ name: 'Read', phase: 'start' }, { name: 'Read', phase: 'end', outcome: 'path=a.md · 3 lines' }, { name: 'Bash', phase: 'start' }], at: NOW - 1500 } } as unknown as Partial<Data>);
    const c = center(text(frame(d, ui())));
    const i = c.findIndex((r) => /^BEING ANSWERED NOW/i.test(r));
    expect(i).toBeGreaterThan(0);
    expect(c.slice(i + 1, i + 6)).toEqual(['You: Which files?', 'Timmy: Reading', '  ● Read', '    └ path=a.md · 3 lines', `  ${spinnerFrame(NOW, g)} Running Bash`]);
    expect(c[i + 6]).toBe('  being answered · Esc in the composer, or x, stops it');
    // the spinner's frame turns with the time (80 ms a frame, ten frames); plain marks without Unicode (four, 160 ms each)
    expect('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏').toContain(spinnerFrame(NOW, g));
    expect(spinnerFrame(NOW + 80, g)).not.toBe(spinnerFrame(NOW, g));
    expect(spinnerFrame(NOW + 800, g)).toBe(spinnerFrame(NOW, g));
    const later = center(text(frameOf({ ui: ui(), data: d, g, columns: 122, rows: 37, now: NOW + 80, can })));
    expect(later[i + 5]).toBe(`  ${spinnerFrame(NOW + 80, g)} Running Bash`);
    const ascii = frameOf({ ui: ui(), data: d, g: glyphsFor(false), columns: 122, rows: 37, now: NOW, can }).screen.map(plain).map((r) => cols(r, 20, 88));
    expect(ascii[i + 5]).toBe(`  ${spinnerFrame(NOW, glyphsFor(false))} Running Bash`);
    expect(['|', '/', '-', '\\']).toContain(spinnerFrame(NOW, glyphsFor(false)));
    expect(ascii[i + 3]).toBe('  * Read');
    // the live turn's events as runs: a start without its end is running; an end closes the latest open one of its name
    expect(toolRuns([{ name: 'Read', phase: 'start' }, { name: 'Read', phase: 'start' }, { name: 'Read', phase: 'end', outcome: 'b' }, { name: 'Grep', phase: 'end', outcome: 'c' }])).toEqual([{ name: 'Read', running: true }, { name: 'Read', running: false, outcome: 'b' }, { name: 'Grep', outcome: 'c' }]);
    // a turn's cost in words: Ollama's no charge; OpenRouter's measured, reported, or unknown (never zero)
    expect(turnCost({ via: 'ollama' })).toBe('no charge');
    expect(turnCost({ via: 'openrouter', cost: { usd: 0.25, measured: true } })).toBe('$0.25');
    expect(turnCost({ via: 'openrouter', cost: { usd: 0.0012, measured: true } })).toBe('$0.0012');
    expect(turnCost({ via: 'openrouter', cost: { usd: 0.0012, measured: false } })).toBe('$0.0012 (reported)');
    expect(turnCost({ via: 'openrouter' })).toBe('cost unknown');
    expect(turnWhere({ via: 'ollama', local: true })).toBe('this computer');
    expect(turnWhere({ via: 'ollama', local: false })).toBe('another computer');
    expect(turnWhere({ via: 'openrouter' })).toBe('OpenRouter');
    expect(turnWhere({})).toBe('where not recorded');
  });
});

describe('R11 step 2: H168\'s pass 4a R32: rows above the view are said on the conversation\'s first row', () => {
  const long = (): Data => data({ chat: { session: 's1', total: 2, messages: [{ role: 'user', text: 'Summarise the newest run in one line.', at: at(3) }, { role: 'assistant', text: 'FAKE answer from a stand-in: the run wrote two files, read three, and the report block ended with its receipt sealed; the second line of the answer goes on about the files it read.', at: at(3) }] } } as unknown as Partial<Data>);
  it('80x24, the conversation following its newest rows: "↑ 1 earlier message · ↑ moves to it" on the first row; 122x37 holds it whole, no cue', () => {
    const c = text(frame(long(), ui(), 80, 24)).map((r) => cols(r, 16, 79));
    expect(c[7]).toBe('↑ 1 earlier message · ↑ moves to it');
    expect(c.slice(8, 15).join('\n')).toMatch(/TIMMY \/ FAKE fake-qwen3:8b \/ \d\d:\d\d[\s\S]*receipt d2d756db ✓/);
    expect(c.slice(7, 15).join('\n')).not.toMatch(/YOU \//);
    const wide = center(text(frame(long(), ui())));
    expect(wide[7]).toMatch(/^YOU \/ \d\d:\d\d$/);
    expect(wide.join('\n')).not.toMatch(/earlier message/);
    // the person moved to the earlier message (↑): its YOU row is the first row, whole, no cue over it
    const up = text(frame(long(), ui({ chosen: { 'center:chat': true }, cursor: { 'center:chat': 0 }, sel: { 'center:chat': 'msg:0' } }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(up[7]).toMatch(/^YOU \/ \d\d:\d\d$/);
    // without Unicode a caret says it
    const ascii = frameOf({ ui: ui(), data: long(), g: glyphsFor(false), columns: 80, rows: 24, now: NOW, can }).screen.map(plain).map((r) => cols(r, 16, 79));
    expect(ascii[7]).toBe('^ 1 earlier message - ^ moves to it');
  });
});

describe('R11 step 3d: the classic Chat tab\'s pipeline row says run, never sandbox (none ran); its wording chosen for the row, not cut', () => {
  type Stage = { state: 'done' | 'none' | 'not run yet' | 'running' | 'failed' | 'unknown'; words: string; verified?: boolean };
  const st = (state: Stage['state'], words: string, verified?: boolean): Stage => ({ state, words, ...(verified ? { verified } : {}) });
  const job = { operation: 'o1a2b3c4d', label: 'build.md › build', kind: 'job', intent: st('done', '/run build.md build'), predict: st('done', 'sealed before it ran (rc_x)'), sandbox: st('done', 'upmd ran it on this computer; no sandbox · completed'), receipt: st('done', 'sealed rc_y · verified here', true) };
  const live = { operation: 'o1a2b3c4d', label: 'chat turn in the Workbench', kind: 'chat', live: true, intent: st('done', 'What does this project do?'), predict: st('none', 'none recorded for this turn'), sandbox: st('running', 'a chat turn in the Workbench, on this computer; no sandbox · being answered'), receipt: st('running', 'not sealed yet: it is being answered') };
  const failed = { operation: 'o1a2b3c4d', label: 'chat turn in the REPL', kind: 'chat', intent: st('done', 'Hello'), predict: st('none', 'none recorded for this turn'), sandbox: st('failed', 'a chat turn in the REPL, on this computer; no sandbox · failed'), receipt: st('failed', 'sealed rc_z · does not verify: bad link') };
  const rows = (pipeline: unknown, width: number): string[] => pipelineLines({ g: glyphsFor(true), width, data: { pipeline, jobs: [] }, ui: {}, now: NOW } as never, width).map(plain);

  it('wide (156 cells): the plan\'s whole words on the chip, "ran on this computer; no sandbox"; running and failed say so too', () => {
    expect(rows(job, 156)[0]).toBe('[intent · recorded] → [predict · sealed before it ran] → [run · ran on this computer; no sandbox] → [✓ receipt · sealed · verified here]');
    expect(rows(job, 156)[1]).toBe('newest run build.md › build  · [i] its records');
    expect(rows(live, 156)[0]).toBe('[intent · recorded] → [predict · none sealed] → [run · running on this computer; no sandbox] → [receipt · not sealed yet]');
    expect(rows(failed, 156)[0]).toBe('[intent · recorded] → [predict · none sealed] → [✕ run · failed on this computer; no sandbox] → [✕ receipt · does not verify]');
  });

  it('122x37 (118 cells): the chip takes the wording the row holds whole beside the others, never a cut; where it is only "this computer", the row under says the whole', () => {
    expect(rows(job, 118)[0]).toBe('[intent · recorded] → [predict · sealed before it ran] → [run · this computer] → [✓ receipt · sealed · verified here]');
    expect(rows(job, 118)[1]).toBe('newest run build.md › build · ran on this computer; no sandbox  · [i] its records');
    expect(rows(live, 118)[0]).toBe('[intent · recorded] → [predict · none sealed] → [run · running; no sandbox] → [receipt · not sealed yet]');
    expect(rows(live, 118)[1]).toBe('newest turn in the Workbench · being answered now · asked: What does this project do?  · [i] its records');
    expect(rows(failed, 118)[0]).toBe('[intent · recorded] → [predict · none sealed] → [✕ run · failed; no sandbox] → [✕ receipt · does not verify]');
    for (const w of [156, 118, 96, 76]) for (const p of [job, live, failed]) {
      const [chips, under] = rows(p, w);
      expect(chips).toMatch(/\[(?:✕ )?run · /);
      expect(chips).not.toMatch(/\[sandbox/);
      // the word sandbox only ever says that none ran
      for (const m of `${chips}\n${under}`.matchAll(/sandbox/g)) expect(`${chips}\n${under}`.slice(Math.max(0, m.index - 3), m.index)).toBe('no ');
    }
  });

  it('nothing run yet: every chip says not run yet, the third named run', () => {
    expect(rows(null, 118)[0]).toBe('[intent · not run yet] → [predict · not run yet] → [run · not run yet] → [receipt · not run yet]');
  });
});

describe('R11 step 3: H168\'s pass 4a Low findings on the Chat screen\'s frames: R27, R34, R38, R39', () => {
  it('R27: Models\' state row says "asking Ollama…" while Ollama is asked, not the install\'s state from the files', () => {
    const reading = data({ models: { openrouter: { from: 'shipped', at: '2026-09-07', rows: [] }, ollama: { state: 'reading', where: 'Ollama', rows: [] } } } as unknown as Partial<Data>);
    const m = models(text(frame(reading, ui({ modelsProvider: 'ollama-local', firstRunDone: true }))));
    expect(m[5]).toBe('asking Ollama…');
    expect(frame(reading, ui({ modelsProvider: 'ollama-local', firstRunDone: true })).screen[5].find((s) => s.text === 'asking Ollama…')?.role).toBe('attention');
    expect(m[12]).toBe('ASKING THE LOCAL OLLAMA');
    expect(m.join('\n')).not.toMatch(/not installed/);
  });

  it('R34 (80x24): the Models drawer says what the keys do on its last row, and a refused check\'s whole words under the list (the MODEL block is 122x37\'s)', () => {
    const check = { model: 'fake-qwen3:8b', state: 'not-installed', at: NOW, words: 'Ollama at 127.0.0.1:4463 does not have fake-qwen3:8b: ollama pull fake-qwen3:8b downloads it (its size is as Ollama lists it).' } as Ui['modelCheck'];
    const t = text(frame(data(), ui({ modelsOpen: true, focus: 'right', modelsProvider: 'ollama-local', modelCheck: check }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(t.slice(10, 17)).toEqual([
      '> FAKE fake-qwen3:8b / ✕ not installed',
      '',
      'Ollama at 127.0.0.1:4463 does not have fake-qwen3:8b: ollama',
      'pull fake-qwen3:8b downloads it (its size is as Ollama lists…',
      'Runs on this computer. A local model does not require a cloud',
      'account.',
      'Enter chooses · r asks Ollama again · Esc closes',
    ]);
    expect(frame(data(), ui({ modelsOpen: true, focus: 'right', modelsProvider: 'ollama-local', modelCheck: check }), 80, 24).screen[12].find((s) => s.text.startsWith('Ollama at'))?.role).toBe('failure');
    // no refusal: the keys' row alone under the list's sentence; OpenRouter's drawer says its keys too
    const plain = text(frame(data(), ui({ modelsOpen: true, focus: 'right', modelsProvider: 'ollama-local' }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(plain.slice(10, 17)).toEqual(['> FAKE fake-qwen3:8b / 8B · Q4_K_M', '', '', 'Runs on this computer. A local model does not require a cloud', 'account.', '', 'Enter chooses · r asks Ollama again · Esc closes']);
    const or = text(frame(data(OPENROUTER), ui({ modelsOpen: true, focus: 'right', modelsCost: 'all' }), 80, 24)).map((r) => cols(r, 16, 79));
    expect(or[16]).toBe('Enter chooses · Esc closes');
    expect(or.slice(14, 16)).toEqual(['> FIXTURE: Newest (free) / 262k context / Free', '  FIXTURE: Middle model / 1M context / price unknown']);
  });

  it('R38: a message is drawn selected only while the conversation has the keyboard and one was chosen; not under the composer, not with Models, not for the cursor alone', () => {
    const selRows = (u: Ui): number[] => frame(data(), u).screen.map((l, y) => (l.some((s) => s.selected) ? y : -1)).filter((y) => y >= 0);
    expect(selRows(ui({ cursor: { 'center:chat': 1 }, chosen: { 'center:chat': true } }))).toEqual([10, 11, 12]);
    expect(selRows(ui({ input: { field: 'composer', text: '' }, cursor: { 'center:chat': 1 }, chosen: { 'center:chat': true } }))).toEqual([]);
    expect(selRows(ui({ cursor: { 'center:chat': 1 } }))).toEqual([]);
    // (Models with the keyboard: its own cursor's rows, none of the conversation's)
    expect(selRows(ui({ focus: 'right', cursor: { 'center:chat': 1 }, chosen: { 'center:chat': true } })).every((y) => y >= 14)).toBe(true);
  });

  it('R39: a notice from before the turn being answered began gives way to "1 running (the chat turn)"; one said during the turn stays; at 80x24 the state keeps its words whole', () => {
    const sending = data({ turn: { text: 'Hello', answer: '', state: 'sending', lines: [], sent: true, tools: [], at: NOW - 1500 } } as unknown as Partial<Data>);
    const older = { text: 'Next turn: fake-qwen3:8b on this computer.', role: 'text', at: NOW - 3000 } as Ui['flash'];
    expect(cols(text(frame(sending, ui({ flash: older })))[36], 20, 121)).toMatch(/^Logs stay on this computer · 1 running \(the chat turn\) +cloud sync off · 122 x 37$/);
    expect(cols(text(frame(sending, ui({ flash: { text: 'Said during the turn.', role: 'text', at: NOW - 1000 } })))[36], 20, 121)).toMatch(/^Said during the turn\. +cloud sync off · spend no charge · 122 x 37$/);
    expect(cols(text(frame(sending, ui({ flash: older }), 80, 24))[23], 16, 79)).toMatch(/^Logs stay on this computer · 1 running +80 x 24$/);
    // (no turn: the notice stands its six seconds)
    expect(cols(text(frame(data(), ui({ flash: older })))[36], 20, 121)).toMatch(/^Next turn: fake-qwen3:8b on this computer\. +cloud sync off · spend no charge · 122 x 37$/);
  });
});
