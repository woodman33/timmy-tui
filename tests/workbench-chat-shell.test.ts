// R10 CHAT CHECKPOINT (H167): the Workbench's Chat screen as one shell (src/workbench/chat-shell.ts, screen.ts chatFrame): the
// permanent left rail, the 3-row header, the conversation with the next turn's line and the composer, the Models rail and this
// conversation's controls, at 122x37 (the operator's size), 100x30 and 160x45; and the Models rail's query (H169's contract's
// shape: sort Recently added by the catalog's added date, filters a sort never resets, unknown kept unknown). Pure functions
// over hand-made Data: FIXTURE records and a FAKE local model, nothing run, no request.
import { describe, expect, it } from 'vitest';
import { glyphsFor } from '../src/workbench/frame.js';
import { chatLayout } from '../src/workbench/layout.js';
import { frameOf } from '../src/workbench/screen.js';
import { ctxWords, ollamaRows, priceWords, queryRows, railCatalog, RAIL, RAIL_FOOT, type CatalogRow } from '../src/workbench/chat-shell.js';
import type { Data, Ui } from '../src/workbench/model.js';
import { plain } from '../src/workbench/text.js';

const g = glyphsFor(true);
const NOW = Date.parse('2026-10-22T23:40:00Z');
const at = (minAgo: number) => NOW - minAgo * 60_000;
const iso = (minAgo: number) => new Date(at(minAgo)).toISOString();

// FIXTURE: three models in the shape of OpenRouter's public /api/v1/models answer (made up here: ids, names, prices and dates)
const CATALOG = [
  { id: 'fixture-maker/older-model', name: 'FIXTURE: Older model', created: 1_700_000_000, description: 'A FIXTURE model added first.', context_length: 32_000, pricing: { prompt: '0.0000005', completion: '0.0000015' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } },
  { id: 'fixture-maker/newest-model:free', name: 'FIXTURE: Newest model (free)', created: 1_790_000_000, description: 'A FIXTURE model added last; free.', context_length: 262_144, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] } },
  { id: 'other-maker/middle-model', name: 'FIXTURE: Middle model', created: 1_750_000_000, context_length: 1_000_000 },
];

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
      ollama: { state: 'listed', where: 'Ollama at 127.0.0.1:4463', rows: ollamaRows([{ name: 'fake-qwen3:8b', facts: 'local weights · 8B · Q4_K_M · 5.2 GB' }]), at: iso(1) },
    },
    ...o,
  } as unknown as Data;
}

function ui(o: Partial<Ui> = {}): Ui {
  return { page: 'chat', workspace: 'chat', focus: 'center', tab: 'inspector', navOpen: false, rightOpen: false, activityOpen: false, activityAll: false, overlay: null, input: { field: null, text: '' }, cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, activityFollow: true, toolsQuery: '', flash: null, mouse: false, related: false, saved: null, companion: { serving: false, address: null, last: null }, studio: { serving: false, address: null, last: null }, mine: [], ...o } as unknown as Ui;
}

const can = { run: true, chat: true, detail: true };
const frame = (d: Data, u: Ui, columns = 122, rows = 37) => frameOf({ ui: u, data: d, g, columns, rows, now: NOW, can });
const text = (f: ReturnType<typeof frame>) => f.screen.map(plain);

describe('the Chat screen\'s shell at 122x37 (R10 CHAT H167; IMPLEMENTATION_SPEC.md\'s geometry)', () => {
  it('the rail 18 columns the whole height, the header 3 rows, Models 30 columns beside the conversation, this conversation\'s controls at the foot', () => {
    const l = chatLayout({ columns: 122, rows: 37 })!;
    expect(l.shell).toBe('chat');
    expect(l.nav).toEqual({ x: 0, y: 0, w: 18, h: 37 });
    expect(l.tabs).toEqual({ x: 18, y: 0, w: 104, h: 3 });
    expect(l.right).toEqual({ x: 92, y: 3, w: 30, h: 29 });
    expect(l.center).toEqual({ x: 18, y: 3, w: 74, h: 29 });
    expect(l.bottom).toEqual({ x: 18, y: 32, w: 104, h: 5 });
    const f = frame(data(), ui());
    expect(f.screen).toHaveLength(37);
    for (const r of text(f)) expect([...r].length).toBe(122);
  });

  it('the rail: TIMMY, the project selector and New project, then the menu, Chat first and selected (amber), and at its foot where the work stays', () => {
    const t = text(frame(data(), ui()));
    const rail = t.map((r) => [...r].slice(0, 17).join('').trimEnd());
    expect(rail[0]).toBe(' TIMMY');
    expect(rail).toContain(' PROJECT');
    expect(rail.some((r) => /^ {2}tray ▾$/.test(r))).toBe(true);
    expect(rail).toContain('  + New project');
    const menu = RAIL.map((r) => rail.findIndex((x) => x === `  ${r.label}`));
    expect(menu.every((i) => i > 0), `the menu in the rail: ${RAIL.map((r) => r.label).join(', ')}`).toBe(true);
    expect([...menu].sort((a, b) => a - b)).toEqual(menu);
    expect(RAIL[0].label).toBe('Chat');
    const f = frame(data(), ui());
    const chat = f.screen[menu[0]].find((s) => s.text.includes('Chat'));
    expect(chat?.role).toBe('accent');
    expect(f.screen[menu[1]].find((s) => s.text.includes('Studio'))?.role).toBe('text');
    expect(rail.slice(-6).join(' ').replace(/\s+/g, ' ')).toContain('Local workspace Logs stay on this computer Cloud sync off');
    expect(RAIL_FOOT).toBe('Local workspace · logs stay on this computer · cloud sync off');
  });

  it('the header: the project / Chat, the next turn\'s route in words (FAKE named), Models [M] and Keys [?]; then saved locally and the conversation\'s facts', () => {
    const t = text(frame(data(), ui()));
    expect(t[0]).toMatch(/│ tray \/ Chat · next turn FAKE fake-qwen3:8b · this computer · no charge · local +Models \[M\] · Keys \[\?\] ?$/);
    expect(t[1]).toMatch(/│ Saved locally · 4 messages kept in this project · last turn answered \d\d:\d\d · its receipt sealed/);
    const none = text(frame(data({ chat: { session: null, total: 0, messages: [] } as unknown as Data['chat'], turns: [] }), ui()));
    expect(none[1]).toMatch(/Not saved yet: no conversation is kept in this project/);
  });

  it('the conversation: YOU, TIMMY with the model the turn used (FAKE named), the words under each; the next turn\'s line and the composer at its foot', () => {
    const t = text(frame(data(), ui()));
    const body = t.slice(3, 32).map((r) => [...r].slice(18, 92).join(''));
    expect(body[0]).toMatch(/Conversation/);
    expect(body.some((r) => /YOU · \d\d:\d\d/.test(r))).toBe(true);
    expect(body.some((r) => /TIMMY · FAKE fake-qwen3:8b · \d\d:\d\d/.test(r))).toBe(true);
    expect(body.some((r) => r.includes('FAKE answer from a stand-in: the run wrote two files.'))).toBe(true);
    const next = body.findIndex((r) => /Next turn FAKE fake-qwen3:8b · Ollama · this computer +Change model \[M\]/.test(r));
    expect(next).toBeGreaterThan(0);
    expect(body[next + 1]).toMatch(/Message/);
    expect(body[next + 2]).toMatch(/\[Enter\] Type a message/);
  });

  it('Models: Ollama Local for the local route, its installed model the next turn\'s (✓), the selected model\'s detail with unknown kept unknown', () => {
    const t = text(frame(data(), ui({ focus: 'right' })));
    const rail = t.slice(3, 32).map((r) => [...r].slice(92).join(''));
    expect(rail[0]).toMatch(/Models · 1/);
    const all = rail.join('\n');
    expect(all).toMatch(/OpenRouter \[Ollama\]/);
    expect(all).toMatch(/Cloudflare +optional/);
    expect(all).toMatch(/\[Local\] · Cloud/);
    expect(all).toMatch(/INSTALLED · read \d\d:\d\d/);
    expect(all).toMatch(/▸ FAKE fake-qwen3:8b ✓/);
    expect(all).toMatch(/SELECTED · the next turn's/);
    expect(all).toMatch(/id fake-qwen3:8b/);
    expect(all).toMatch(/context unknown/);
    expect(all).toMatch(/no charge · local/);
    expect(all).toMatch(/tools unknown/);
    expect(all).toMatch(/vision unknown/);
    expect(all).toMatch(/reasoning unknown/);
  });

  it('Models on OpenRouter: Recently added (the catalog\'s added date), each row its context and price, the detail its description, id, prices and what the catalog says it can do', () => {
    const t = text(frame(data({ route: { kind: 'openrouter', words: 'chat: fixture-maker/newest-model:free · OpenRouter · free-only', ready: true } as Data['route'] }), ui({ focus: 'right', modelsProvider: 'openrouter' })));
    const all = t.slice(3, 32).map((r) => [...r].slice(92).join('')).join('\n');
    expect(all).toMatch(/\[OpenRouter\]/);
    expect(all).toMatch(/Sort Recently added/);
    expect(all).toMatch(/SNAPSHOT 2026-09-07/);
    const order = ['Newest model', 'Middle model', 'Older model'].map((n) => all.indexOf(n));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(all).toMatch(/262K ctx · free/);
    expect(all).toMatch(/1M ctx · price unknown/);
    expect(all).toMatch(/32K ctx · \$0\.50\/\$1\.50 \/M/);
    // the description, its rows read whole
    const words = all.split('\n').map((r) => r.replace(/^[┃│] ?/, '').replace(/ *[┃│]$/, '').trim()).join(' ');
    expect(words).toMatch(/A FIXTURE model added last; free\./);
    // the exact id whole, over two rows in a rail of 26 cells
    expect(all.replace(/ +┃\n┃ {4}/g, '')).toMatch(/id fixture-maker\/newest-model:free/);
    expect(all).toMatch(/free \(input and output\)/);
    expect(all).toMatch(/tools yes/);
    expect(all).toMatch(/vision yes/);
    expect(all).toMatch(/reasoning yes/);
  });

  it('this conversation\'s controls and the status line: inference, logs, cloud sync off, spend; no id, hash, port or path anywhere on the face', () => {
    const t = text(frame(data(), ui()));
    const foot = t.slice(32).map((r) => [...r].slice(18).join(''));
    expect(foot[0]).toMatch(/This conversation/);
    expect(foot[1]).toMatch(/Tools +Attachments +Plan & Run +Budget +Approvals 0 +Stop +Cloudflare optional +Logs local/);
    expect(foot[2]).toMatch(/inference Ollama · this computer +\| +logs this computer +\| +cloud sync off +\| +spend no charge/);
    const face = t.join('\n');
    expect(face).not.toMatch(/d2d756db|oc372c7b3|127\.0\.0\.1|4463|\/p\/tray|~\/timmy/);
  });
});

describe('the shell at the other sizes (R10 CHAT H167)', () => {
  it('100x30: a shorter rail and Models a drawer (M opens it, the conversation narrows to make its room)', () => {
    const l = chatLayout({ columns: 100, rows: 30 })!;
    expect(l.nav?.w).toBe(16);
    expect(l.right).toBeNull();
    expect(l.center?.w).toBe(84);
    const open = chatLayout({ columns: 100, rows: 30, modelsOpen: true })!;
    expect(open.modelsDrawer).toBe(true);
    expect(open.right?.w).toBe(30);
    expect(open.center?.w).toBe(54);
    for (const r of text(frame(data(), ui(), 100, 30))) expect([...r].length).toBe(100);
  });

  it('160x45: the rail and Models beside a wider conversation', () => {
    const l = chatLayout({ columns: 160, rows: 45 })!;
    expect(l.nav?.w).toBe(18);
    expect(l.right?.w).toBe(30);
    expect(l.center?.w).toBe(112);
    for (const r of text(frame(data(), ui(), 160, 45))) expect([...r].length).toBe(160);
  });
});

describe('the Models rail\'s query (H169\'s queryCatalog shape, drawn here until it lands)', () => {
  const rows: CatalogRow[] = railCatalog(CATALOG);
  it('reads OpenRouter\'s catalog: per-million prices, free only where both are 0, a capability only where the catalog says it', () => {
    const [older, newest, middle] = rows;
    expect(older).toMatchObject({ maker: 'fixture-maker', contextLength: 32_000, price: { free: false }, caps: { tools: true, reasoning: false, vision: false } });
    expect(older.price.inPerM).toBeCloseTo(0.5);
    expect(newest).toMatchObject({ price: { inPerM: 0, outPerM: 0, free: true }, caps: { tools: true, reasoning: true, vision: true } });
    expect(middle).toMatchObject({ price: { free: 'unknown' }, caps: {} });
    expect(priceWords(middle.price)).toBe('price unknown');
    expect([ctxWords(undefined), ctxWords(262_144), ctxWords(1_000_000), ctxWords(1_048_576)]).toEqual(['context unknown', '262K ctx', '1M ctx', '1M ctx']);
  });

  it('Recently added sorts by the catalog\'s added date; search, maker, capability, cost and context filter; a sort never resets the filters', () => {
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'other-maker/middle-model', 'fixture-maker/older-model']);
    const q = { source: 'openrouter' as const, sort: 'recent' as const, maker: 'fixture-maker' };
    expect(queryRows(rows, q).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'fixture-maker/older-model']);
    expect(queryRows(rows, { ...q, sort: 'name' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'fixture-maker/older-model']);
    expect(queryRows(rows, { ...q, sort: 'context' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'fixture-maker/older-model']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', capability: 'vision' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', cost: 'free' }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free']);
    // an unknown price is neither free nor paid
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', cost: 'paid' }).rows.map((r) => r.id)).toEqual(['fixture-maker/older-model']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', minContext: 200_000 }).rows.map((r) => r.id)).toEqual(['fixture-maker/newest-model:free', 'other-maker/middle-model']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', search: 'MIDDLE' }).rows.map((r) => r.id)).toEqual(['other-maker/middle-model']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent' })).toMatchObject({ total: 3, makers: ['fixture-maker', 'other-maker'] });
  });
});
