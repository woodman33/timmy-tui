// R10 (H167; H168's pass 2a, F10 and F13): Home's Selected column gives its free rows to the selected item (a turn's answer,
// a run's steps and the files it wrote), the connections say how many are in each state under their heading and draw every
// row's state in one column, and the actions strip's second row says what the selected box does without its number and label
// again. Pure functions over hand-made Data: FAKE records, nothing run.
import { describe, expect, it } from 'vitest';
import { glyphsFor } from '../src/workbench/frame.js';
import { openTarget, type WorkItem as JourneyWorkItem } from '../src/journey/index.js';
import { connectionCounts, homeSideView, homeWorkView } from '../src/workbench/home-journey.js';
import { actionWords } from '../src/workbench/hub.js';
import type { Data, Ui } from '../src/workbench/model.js';
import type { JobRow } from '../src/workbench/state.js';
import { plain } from '../src/workbench/text.js';
import type { WorkspaceConnection } from '../src/contracts/workspace.js';

const g = glyphsFor(true);
const NOW = Date.parse('2026-10-22T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function data(o: Partial<Data> = {}): Data {
  return {
    project: { name: 'tray', root: '/p/tray', id: 'p1', shown: '~/timmy/projects/tray' },
    projects: [], files: { total: 3, truncated: false, groups: [] }, workflows: { docs: [], upmd: true },
    jobs: [], decisions: { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [] },
    route: { kind: 'local', words: 'chat: local qwen3:8b · Ollama', ready: true },
    activity: { running: 0, waiting: 0, events: [] }, chat: { session: null, total: 0, messages: [] }, vox: [], native: {}, starters: [], boards: [],
    studio: { state: 'idle' }, overview: { state: 'idle' }, caps: { state: 'idle' }, details: {}, readAt: NOW, away: [],
    ...o,
  } as unknown as Data;
}

function ui(o: Partial<Ui> = {}): Ui {
  return { page: 'home', workspace: 'connections', focus: 'center', tab: 'inspector', cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, input: { field: null, text: '' }, companion: { serving: false, address: null, last: null }, studio: { serving: false, address: null, last: null }, ...o } as unknown as Ui;
}

const ctx = (d: Data, u: Ui, width: number, height: number) => ({ ui: u, data: d, g, width, height, now: NOW, can: { chat: true } });
const rows = (v: { lines: Parameters<typeof plain>[0][] }) => v.lines.map(plain);

// FAKE: a turn of this project's conversation, its answer long (the conversation kept here holds it whole)
const QUESTION = 'Summarise the report run in one line.';
const ANSWER = Array.from({ length: 40 }, (_, i) => `FIXTURE sentence ${i + 1} of the answer.`).join(' ');
const turn = { kind: 'turn', id: 'd2d756db', title: QUESTION, when: iso(2), state: 'answered', receipt: { id: 'd2d756db', verified: true }, fake: false, operation: 'oc372c7b3', route: { provider: 'ollama', requested: 'qwen3:8b', answeredBy: 'qwen3:8b', where: 'this computer', fallback: false, fake: false, surface: 'workbench' }, open: openTarget({ kind: 'turn', id: 'd2d756db' }) } as unknown as JourneyWorkItem;
const withTurn = data({
  recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [turn] },
  chat: { session: 's1', total: 2, messages: [{ role: 'user', text: QUESTION }, { role: 'assistant', text: ANSWER }] } as unknown as Data['chat'],
});
/** the answer's rows as the column draws them: "Timmy  …", then the rows under it */
const answerRows = (lines: string[]): string[] => {
  const at = lines.findIndex((l) => l.startsWith('Timmy  '));
  const out: string[] = [];
  for (let i = at; i >= 0 && i < lines.length && (i === at || /^ {7}\S/.test(lines[i])); i += 1) out.push(lines[i]);
  return out;
};
/** the answer's words as the column draws them, its rows joined */
const answerShown = (lines: string[]): string => answerRows(lines).map((l) => l.slice(7).trim()).join(' ');

describe('Home\'s Selected column gives its free rows to the selected item (R10 H167; H168\'s F10 at pass 2a)', () => {
  it('a turn: its answer\'s next lines fill the column to its last row, never past it; in order, from its start', () => {
    for (const height of [22, 29, 40]) {
      const v = rows(homeSideView(ctx(withTurn, ui(), 50, height)));
      expect(v.length, `the Selected column's rows at height ${height}`).toBe(height);
      expect(ANSWER.startsWith(answerShown(v)), `the answer drawn from its start, in order, at height ${height}`).toBe(true);
    }
    // a taller column draws more of the answer
    const at22 = answerShown(rows(homeSideView(ctx(withTurn, ui(), 50, 22))));
    const at40 = answerShown(rows(homeSideView(ctx(withTurn, ui(), 50, 40))));
    expect(at40.length).toBeGreaterThan(at22.length);
    expect(at40.startsWith(at22)).toBe(true);
  });

  it('a column with no free row keeps the answer\'s first three lines, as before; an answer shorter than the room is drawn whole once', () => {
    expect(answerRows(rows(homeSideView(ctx(withTurn, ui(), 50, 8))))).toHaveLength(3);
    const brief = data({ ...withTurn, chat: { session: 's1', total: 2, messages: [{ role: 'user', text: QUESTION }, { role: 'assistant', text: 'FIXTURE: one line.' }] } as unknown as Data['chat'] });
    const v = rows(homeSideView(ctx(brief, ui(), 50, 40)));
    expect(v.filter((l) => l.includes('FIXTURE: one line.'))).toHaveLength(1);
    expect(v.length).toBeLessThan(40);
  });

  it('a run: each of its steps a row (its name and how it ended), then every file it wrote, as the column has room; no id or path', () => {
    const run = { kind: 'run', id: 'o92079bb4', title: 'Workflow run: report in REPORT.md', when: iso(9), state: 'failed', receipt: { id: 'f7a8f9c4', verified: true }, fake: false, operation: 'o92079bb4', results: ['out/report.md', 'out/preview.png', 'out/a.txt', 'out/b.txt', 'out/c.txt'], open: openTarget({ kind: 'run', id: 'o92079bb4' }) } as unknown as JourneyWorkItem;
    const job = {
      id: 'j5c4706', label: 'REPORT.md › report', project: 'tray', root: '/p/tray', kind: 'workflow', state: 'failed', mark: 'fail', word: 'failed', why: '', operation: 'o92079bb4', receipt: 'f7a8f9c4',
      outcome: { state: 'failed', words: 'failed' }, live: false, stale: false, startedAt: iso(10), endedAt: iso(9), elapsedMs: 900, elapsed: '0.9 s', owner: 'repl', ownerWords: 'the REPL',
      steps: [{ name: 'build', state: 'completed', code: 0 }, { name: 'report', state: 'completed', code: 0 }, { name: 'tidy', state: 'failed', code: 1 }],
    } as unknown as JobRow;
    const d = data({ recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [run] }, jobs: [job] });
    const tall = homeSideView(ctx(d, ui(), 50, 30));
    const t = rows(tall);
    expect(t.length).toBeLessThanOrEqual(30);
    expect(t.join('\n')).toMatch(/Progress +failed · 2 of 3 steps · 0\.9 s\n +build · completed\n +report · completed\n +tidy · failed\n/);
    expect(tall.lines.find((l) => plain(l).includes('tidy'))?.find((s) => s.text === 'failed')?.role).toBe('failure');
    expect(t.join(' ').replace(/\s+/g, ' ')).toMatch(/Wrote report\.md, preview\.png, a\.txt, b\.txt, c\.txt/);
    expect(t.join('\n')).not.toMatch(/o92079bb4|f7a8f9c4|j5c4706|out\//);
    // with no room: the progress and the first files, as before
    const low = rows(homeSideView(ctx(d, ui(), 50, 10))).join('\n');
    expect(low).not.toMatch(/build · completed/);
    expect(low.replace(/\s+/g, ' ')).toMatch(/Wrote report\.md, preview\.png, a\.txt, 2 more/);
  });
});

describe('Home\'s connections: how many in each state, every state in one column (R10 H167; H168\'s F13 at pass 2a)', () => {
  const conn = (id: string, label: string, state: string, observedAt: string | null = null): WorkspaceConnection => ({ id, label, state, words: 'FAKE words', observedAt, setup: null }) as unknown as WorkspaceConnection;
  const conns = [
    conn('ollama', 'Ollama (local models)', 'live', iso(3)),
    conn('openrouter', 'OpenRouter (cloud chat)', 'not set up'),
    conn('cloudflare', 'Cloudflare (tunnels)', 'not set up'),
    conn('clef', 'Clef (music)', 'unknown'),
    conn('cloudroom', 'Cloud room render machine of the studio (FAKE)', 'not set up'),
    conn('companion', 'Timmy Companion', 'configured'),
    conn('studio', 'Timmy Studio', 'unreachable', iso(5)),
    conn('mcp-sdk', 'MCP SDK', 'refused', iso(6)),
    conn('mcporter', 'mcporter', 'not set up'),
  ];
  const d = data({ frame: { project: { id: 'p1' }, activity: { chatTurn: null }, log: [], tabs: [], connections: conns } as unknown as Data['frame'] });

  it('the counts in the marks\' order (a state none is in is not said)', () => {
    expect(connectionCounts(conns)).toEqual(['1 live', '1 configured', '1 unreachable', '1 refused', '4 not set up', '1 unknown']);
    expect(connectionCounts(conns.slice(0, 2))).toEqual(['1 live', '1 not set up']);
    expect(connectionCounts([])).toEqual([]);
  });

  it('under the heading, one row of counts (what live means beside it where it fits); each row\'s state starts in one column; a long name shortened', () => {
    for (const width of [70, 130]) {
      const t = rows(homeWorkView(ctx(d, ui(), width, 30)));
      const at = t.findIndex((l) => l.startsWith('CONNECTIONS'));
      expect(t[at]).toBe('CONNECTIONS  · as last observed');
      // the counts' rows: from under the heading to the first connection's row
      const first = t.findIndex((l) => /^(?:▸ | {2})Ollama /.test(l));
      const counts = t.slice(at + 1, first).join(' ').replace(/\s+/g, ' ').trim();
      expect(counts.startsWith('1 live · 1 configured · 1 unreachable · 1 refused · 4 not set up · 1 unknown')).toBe(true);
      if (width === 130) expect(t[at + 1]).toMatch(/1 unknown {2}· live: an answer seen in the last 30 minutes$/);
      else expect(counts).not.toMatch(/an answer seen/);
      const connRows = t.slice(first);
      expect(connRows).toHaveLength(9);
      const cols = connRows.map((l) => l.search(/[●○·✕?] (?:live|configured|not set up|unreachable|refused|unknown)/));
      expect(new Set(cols).size, `one state column at width ${width}: ${cols.join(', ')}`).toBe(1);
      expect(t.join('\n')).toMatch(/Cloud room render machine… +· not set up/);
      for (const l of t) expect(l.length, `a row wider than ${width}: ${l}`).toBeLessThanOrEqual(width);
    }
  });
});

describe('the actions strip\'s second row (R10 H167; H168\'s F13 at pass 2a)', () => {
  it('says what the selected box does, without its number and label again (the box is right above it)', () => {
    const a = { n: 1, label: 'Send a message', command: 'type in Chat, then Enter', primary: true, enabled: true, effect: 'spend' } as unknown as Parameters<typeof actionWords>[0];
    const row = plain(actionWords(a, g, 120));
    expect(row).toBe('Enter opens the composer in 2 Chat: type, then Enter sends');
    expect(row).not.toMatch(/^1 Send a message/);
    const off = { ...a, enabled: false, why: 'no model is ready' } as unknown as Parameters<typeof actionWords>[0];
    expect(plain(actionWords(off, g, 120))).toBe('not now: no model is ready');
    const check = { n: 2, label: 'Check connections', command: 'timmy workspace check', primary: false, enabled: true, effect: 'network' } as unknown as Parameters<typeof actionWords>[0];
    expect(plain(actionWords(check, g, 120))).toBe('Enter checks the connections from here: free requests only, no model called · asks over the network');
    expect(plain(actionWords(check, g, 40))).toBe('Enter checks the connections (free requests, no model called)');
  });
});

describe('Home\'s Selected for the conversation row that carries the turn count (R10 CHAT H167; H168\'s R1 at pass 2c)', () => {
  it('finds the turn by its own words, not by the row\'s title with the count: You says the message, Timmy its answer', () => {
    const merged = { ...turn, title: `${QUESTION} · 13 turns in this conversation`, turns: 13 } as unknown as JourneyWorkItem;
    const v = rows(homeSideView(ctx(data({ ...withTurn, recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [merged] } }), ui(), 50, 22)));
    expect(v.find((l) => l.startsWith('You    '))).toBe(`You    ${QUESTION}`);
    expect(v.join('\n')).not.toMatch(/its answer is not in the conversation|turns in this conversation/);
    expect(ANSWER.startsWith(answerShown(v))).toBe(true);
  });

  it('a title cut to make the count room: the message found by its start and said whole; a row with no such message says so', () => {
    const long = `${'FIXTURE: a long question about the tray project, '.repeat(3)}its end.`;
    const cutTitle = `${long.slice(0, 50)}… · at least 7 turns in this conversation`;
    const item = { ...turn, title: cutTitle, turns: 7 } as unknown as JourneyWorkItem;
    const found = data({ recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [item] }, chat: { session: 's1', total: 2, messages: [{ role: 'user', text: long }, { role: 'assistant', text: 'FIXTURE: its answer.' }] } as unknown as Data['chat'] });
    const v = rows(homeSideView(ctx(found, ui(), 50, 22)));
    expect(v.join(' ')).toContain('FIXTURE: its answer.');
    expect(v.join('\n')).not.toMatch(/its answer is not in the conversation|turns in this conversation/);
    const none = data({ recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [item] }, chat: { session: 's1', total: 1, messages: [{ role: 'user', text: 'FIXTURE: another question.' }] } as unknown as Data['chat'] });
    expect(rows(homeSideView(ctx(none, ui(), 50, 22))).join('\n')).toMatch(/its answer is not in the conversation kept here/);
  });
});
