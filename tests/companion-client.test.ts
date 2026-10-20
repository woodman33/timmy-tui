import { describe, it, expect, vi } from 'vitest';
import { turnEndWords } from '../src/contracts/stop-words.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the connection and mirror code that the served page actually runs.
// Synthetic messages exercise transport/display only; no provider is contacted.
// R4 (H92): the page's script is a file of its own (the page runs under script-src 'self'); its mirror part is marked.
const html = readFileSync(new URL('../src/companion/client/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/companion/client/companion.js', import.meta.url), 'utf8');
const code = script.slice(script.indexOf('// ── The chat mirror'), script.indexOf('// ── end of the chat mirror ──'));
// R4 (H84): the page's token (a FAKE one here), as the page's own script reads it from its fragment.
const TOKEN = 'c0'.repeat(32);

function client(protocol = 'http:', token = TOKEN) {
  const statusEl = { textContent: '' };
  const dot = { style: {} as Record<string, string>, dataset: {} as Record<string, string> };
  const consoleLogs = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
  const savedList = { innerHTML: '' };
  const storage = new Map<string, string>();
  const sockets: any[] = [];
  const context: any = {
    statusEl, consoleLogs, logsList: { innerHTML: '', scrollTop: 0, scrollHeight: 0 }, location: { protocol, host: '127.0.0.1:3001' },
    document: { querySelector: () => dot, getElementById: (id: string) => id === 'saved-chats-list' ? savedList : consoleLogs },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    WebSocket: class {
      url: string;
      protocols: string[];
      send = vi.fn();
      close = vi.fn();
      constructor(url: string, protocols: string[] = []) { this.url = url; this.protocols = protocols; sockets.push(this); }
    },
    companion: { token, refused: false, protocols: () => ['timmy-companion', `timmy-token.${token}`], check: vi.fn(() => Promise.resolve(true)) },
    wsConnection: null, activeChatHistory: [], isViewingSaved: false,
    // R4 (H104): declared beside activeChatHistory, outside the mirror's part (the page's restore at load sets it)
    mirrorRestored: false,
    updateMirrorStatus: vi.fn(),
    exitSavedChatViewer: vi.fn(), setTimeout: vi.fn(), console: { error: vi.fn() },
    pHash: { textContent: '' }, pRunId: { textContent: '' }, pPath: { textContent: '' },
  };
  runInNewContext(code + '\nconnect();', context);
  const socket = sockets[0];
  const receive = (msg: unknown) => socket.onmessage({ data: JSON.stringify(msg) });
  return { context, socket, statusEl, dot, consoleLogs, savedList, storage, receive };
}

describe('companion connection and chat mirror', () => {
  it('reports only the observed socket connection, without a persistence claim', () => {
    const c = client();
    c.socket.onopen();
    expect(c.statusEl.textContent).toBe('COMPANION SOCKET · CONNECTED');
    // R4 (H92): the dot's look follows its state (a class of the page's style sheet; the page allows no style attribute)
    expect(c.dot.dataset.state).toBe('connected');
    expect(c.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'hello' }));
    expect(html).toContain('COMPANION SOCKET · CONNECTING');
    expect(html).not.toMatch(/DO ACTIVE|DO SYNCED|Saved to Cloudflare Durable Object/);
  });

  it('uses secure WebSockets when served over HTTPS', () => {
    expect(client('https:').socket.url).toBe('wss://127.0.0.1:3001');
    expect(client().socket.url).toBe('ws://127.0.0.1:3001');
  });

  // R4 (H84): the socket carries the token as a subprotocol (never in its address), and without a token none is opened.
  it('offers the token as a subprotocol beside timmy-companion, and opens no socket without a token', () => {
    const c = client();
    expect(c.socket.protocols).toEqual(['timmy-companion', `timmy-token.${TOKEN}`]);
    expect(c.socket.url).not.toContain(TOKEN);
    expect(client('http:', '').socket).toBeUndefined();
  });

  it('renders the live server data envelope and the reconnect history envelope', () => {
    const c = client();
    const history = [{ role: 'user', content: 'SYNTHETIC local preview', timestamp: 1 }];
    c.receive({ type: 'sync', data: history });
    expect(c.consoleLogs.innerHTML).toContain('SYNTHETIC local preview');
    expect(c.context.updateMirrorStatus).toHaveBeenLastCalledWith('LIVE');
    c.receive({ type: 'sync', history: [{ role: 'assistant', content: 'SYNTHETIC reconnect', timestamp: 2 }] });
    expect(c.consoleLogs.innerHTML).toContain('SYNTHETIC reconnect');
    expect(c.consoleLogs.innerHTML).not.toContain('Saved to Cloudflare');
  });

  it('keeps the last good mirror on malformed sync and shows connection loss', () => {
    const c = client();
    c.receive({ type: 'sync', data: [{ role: 'user', content: 'SYNTHETIC retained' }] });
    const before = c.consoleLogs.innerHTML;
    c.receive({ type: 'sync', data: 'invalid history' });
    expect(c.consoleLogs.innerHTML).toBe(before);
    c.receive({ type: 'sync', data: [{ role: 'assistant', content: null }] });
    expect(c.consoleLogs.innerHTML).toBe(before);
    expect(c.context.activeChatHistory[0].content).toBe('SYNTHETIC retained');
    expect(c.context.console.error).toHaveBeenCalled();
    c.socket.onclose();
    expect(c.statusEl.textContent).toBe('COMPANION SOCKET · RECONNECTING');
    expect(c.dot.dataset.state).toBe('lost');
    expect(c.context.updateMirrorStatus).toHaveBeenLastCalledWith('RECONNECTING');
    expect(c.context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 2000);
    // R4 (H84): a closed socket asks the companion whether it still takes the token (a refusal stops the retries)
    expect(c.context.companion.check).toHaveBeenCalled();
  });

  it('displays tool arguments and event labels as text, without executing markup', () => {
    const c = client();
    const attack = '<img src=x onerror=alert(1)>';
    c.receive({ type: 'agent:tool', data: { name: attack, args: { value: attack } } });
    c.receive({ type: 'sync', data: [{ role: 'system', isTool: true, content: `Swarm Orchestrator Tool Call: ${attack} with arguments: ${JSON.stringify({ value: attack })}` }] });
    expect(c.consoleLogs.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(c.consoleLogs.innerHTML).not.toContain('<img');
    c.receive({ type: attack });
    expect(c.context.logsList.innerHTML).not.toContain('<img');
  });

  it('retains one canonical tool row through sync, save and reconnect, and obeys clear/replacement', () => {
    const c = client();
    const tool = { role: 'system', isTool: true, content: 'Swarm Orchestrator Tool Call: synthetic_tool with arguments: {"offline":true}', timestamp: 2 };
    const transcript = [{ role: 'user', content: 'SYNTHETIC request', timestamp: 1 }, tool, { role: 'assistant', content: 'SYNTHETIC reply', timestamp: 3 }];
    c.receive({ type: 'sync', data: transcript.slice(0, 1) });
    c.receive({ type: 'agent:tool', data: { name: 'synthetic_tool', args: { offline: true } } });
    expect(c.context.activeChatHistory).toHaveLength(1);
    c.receive({ type: 'sync', data: transcript });
    c.receive({ type: 'sync', data: transcript });
    expect(c.context.activeChatHistory).toHaveLength(3);
    expect(c.context.activeChatHistory.filter((m: any) => m.isTool)).toHaveLength(1);
    expect(c.consoleLogs.innerHTML).toContain('synthetic_tool');
    c.context.saveCurrentChat();
    expect(JSON.parse(c.storage.get('timmy.chat.sessions')!)[0].messages).toEqual(transcript);
    c.receive({ type: 'sync', history: transcript });
    expect(JSON.parse(c.storage.get('timmy.chat.active')!)).toEqual(transcript);
    c.receive({ type: 'sync', data: [] });
    expect(c.context.activeChatHistory).toEqual([]);
    c.receive({ type: 'sync', data: [{ role: 'user', content: 'SYNTHETIC different agent' }] });
    expect(c.consoleLogs.innerHTML).not.toContain('synthetic_tool');
    expect(JSON.parse(c.storage.get('timmy.chat.sessions')!)[0].messages).toEqual(transcript);
  });

  it('renders tool arguments containing the display delimiter without truncating JSON', () => {
    const c = client();
    c.receive({ type: 'sync', data: [{ role: 'system', isTool: true,
      content: `Swarm Orchestrator Tool Call: synthetic_tool with arguments: ${JSON.stringify({ instruction: 'with arguments: keep literal text' })}` }] });
    expect(c.consoleLogs.innerHTML).toContain('Calling tool');
    expect(c.consoleLogs.innerHTML).toContain('with arguments: keep literal text');
    expect(c.consoleLogs.innerHTML).toContain('log-msg system');
  });

  it('preserves HTML-bearing prompt text through actual save and restored-card rendering', () => {
    const c = client();
    const prompt = '<img src=x onerror=alert(1)>';
    c.receive({ type: 'sync', data: [{ role: 'user', content: prompt }] });
    c.context.saveCurrentChat();
    expect(JSON.parse(c.storage.get('timmy.chat.sessions')!)[0].messages[0].content).toBe(prompt);
    expect(c.savedList.innerHTML).not.toContain('<img');
    expect(c.savedList.innerHTML).toContain('&lt;img');
    c.savedList.innerHTML = '';
    c.context.renderSavedChatsList();
    expect(c.savedList.innerHTML).toContain('&lt;img');
    // R4 (H92): what the page writes carries no inline handler or style (its policy runs neither); its buttons say what
    // they do in data attributes, the saved chat's id encoded
    expect(c.savedList.innerHTML).not.toMatch(/<[^>]*\s(?:on[a-z]+|style)=/);
    expect(c.savedList.innerHTML).toMatch(/data-action="load-saved" data-chat="chat_\d+"/);
  });

  it('writes no inline handler or style into the mirror, the log or the saved list (R4 H92: the page\'s policy runs neither)', () => {
    const c = client();
    c.socket.onopen();
    c.receive({ type: 'sync', data: [
      { role: 'user', content: 'SYNTHETIC `code` and ```block```', timestamp: 1 },
      { role: 'system', isTool: true, content: 'Swarm Orchestrator Tool Call: synthetic_tool with arguments: {"a":1}', timestamp: 2 },
      { role: 'assistant', content: '⚙️ **[SYSTEM]** SYNTHETIC', timestamp: 3 },
    ] });
    c.context.saveCurrentChat();
    c.socket.onclose();
    for (const out of [c.consoleLogs.innerHTML, c.context.logsList.innerHTML, c.savedList.innerHTML]) {
      expect(out.length).toBeGreaterThan(0);
      // inside a tag (text is escaped, so every < starts a tag the page wrote)
      expect(out).not.toMatch(/<[^>]*\s(?:on[a-z]+|style)=|<script/);
    }
    expect(c.context.logsList.innerHTML).toContain('class="log-level error"');
  });

  // ---------- R4 (H104): r24 found the mirror empty, with nothing saying why ----------

  /** SYNTHETIC: the bus event Timmy publishes when the REPL seals a turn (src/utils/receipts.ts, src/repl/seal.ts). */
  const turn = (at: number, subject: string, payload: Record<string, unknown> = {}) => ({
    v: 1, ts: new Date(at).toISOString(), kind: 'receipt.sealed',
    payload: { stream: 'runs', id: 'SYNTHETIC-turn', hash: `sha256_${randomBytes(32).toString('hex')}`, kind: 'turn', subject, epoch: 1, ...payload },
  });
  const rows = (html: string): number => (html.match(/data-mirror="repl-turn"/g) ?? []).length;

  it('says where chat happens when none of this session has come; before the companion answers, or without the token, that it cannot know yet', () => {
    const c = client();
    c.context.renderConsoleLogs([]);
    expect(c.consoleLogs.innerHTML).toContain('Not connected to the companion yet, so whether chat happened in this session is not known yet.');
    c.receive({ type: 'welcome', state: 'idle', since: new Date().toISOString() });
    const words = c.consoleLogs.innerHTML.replace(/\s+/g, ' ');
    expect(words).toMatch(/No chat in this session yet: none has reached this page since this companion started at \S/);
    expect(words).toContain('Chat happens in Timmy\'s terminal, not on this page:');
    expect(words).toContain('In this monitor (<span class="mirror-code">timmy watch</span>), type in its chat line');
    expect(words).toContain('In the REPL (<span class="mirror-code">timmy</span>), each turn appears here when it ends, as the receipt Timmy sealed for it.');
    expect(words).toContain('its ✨ sample is labelled SAMPLE there and is never shown here.');
    expect(words).not.toContain('Waiting for session chat streams');
    expect(words).toContain('data-mirror="empty"');
    const none = client('http:', '');
    none.context.renderConsoleLogs([]);
    expect(none.consoleLogs.innerHTML).toContain('Nothing reaches this page without the companion\'s token (see the note above), so whether chat happened in this session is not known here.');
  });

  // R7 (H152; the R5 visual review's 13: mirror rows did not say who stopped a turn): one set of words per kind, the shared
  // table's (src/contracts/stop-words.ts): a stopped turn says who asked, on the bus row at once (stopped_by), never "cancelled"
  it('says who stopped a turn in its row, in the stop-words table\'s own words; never "cancelled" for a chat turn', () => {
    const c = client();
    // the page's words for every surface and asker are the table's
    const surfaces = ['repl', 'workbench', 'monitor', 'companion'];
    for (const surface of surfaces) {
      for (const by of ['', ...surfaces, 'unknown']) {
        expect(c.context.turnEndSaid('stopped', surface, by), `${surface} stopped by ${by || 'itself'}`).toBe(turnEndWords({ state: 'stopped', surface, ...(by ? { stoppedBy: by } : {}) }));
      }
      for (const state of ['answered', 'failed'] as const) expect(c.context.turnEndSaid(state, surface, '')).toBe(turnEndWords({ state, surface }));
    }
    const since = Date.now();
    c.receive({ type: 'welcome', state: 'idle', since: new Date(since).toISOString() });
    // a REPL turn the companion's Stop stopped (its receipt's stopped_by, on the bus beside it), and a Workbench turn stopped there
    c.receive({ type: 'bus', event: turn(since + 1_000, 'repl · cancelled · 1 step', { stopped_by: 'companion' }) });
    c.receive({ type: 'bus', event: turn(since + 2_000, 'chat.turn · workbench · cancelled · 0 steps · SYNTHETIC-model', { kind: 'chat' }) });
    const html = c.consoleLogs.innerHTML.replace(/\s+/g, ' ');
    expect(html).toContain('⌨ REPL turn · stopped (asked from the companion)');
    expect(html).toContain('A chat turn in the REPL (<span class="mirror-code">timmy</span>) stopped (asked from the companion; 1 step); Timmy sealed it');
    expect(html).toContain('▣ Workbench turn · stopped (asked from the Workbench)');
    expect(html).toContain('stopped (asked from the Workbench; 0 steps); Timmy sealed it');
    expect(html).not.toMatch(/cancelled|Cancelled/);
    // a stopped_by that is not a surface is not believed: the row says the surface that sent it
    c.receive({ type: 'bus', event: turn(since + 3_000, 'repl · cancelled · 2 steps', { stopped_by: '<b>x</b>' }) });
    expect(c.consoleLogs.innerHTML).toContain('stopped (asked from the REPL; 2 steps);');
    expect(c.consoleLogs.innerHTML).not.toContain('<b>x</b>');
  });

  it('shows this session\'s REPL turns from the bus by their receipt and steps, never words: only those sealed since the companion started, each once; no other sealed receipt or event is one', () => {
    const c = client();
    const since = Date.now();
    c.receive({ type: 'welcome', state: 'idle', since: new Date(since).toISOString() });
    const first = turn(since + 1_000, 'repl · 2 steps');
    c.receive({ type: 'bus.tail', events: [
      turn(since - 60_000, 'repl · 1 step'), // sealed before this companion started: not of this session
      first,
      turn(since + 1_500, 'chat.turn · SYNTHETIC-model', { kind: 'chat' }), // a monitor's chat receipt: its words came with sync
      turn(since + 1_600, 'repl · 3 steps', { hash: 'sha256_not-a-hash' }),
      turn(since + 1_700, 'repl · 3 steps', { stream: 'other' }),
      { v: 1, ts: new Date(since + 1_800).toISOString(), kind: 'approval.required', payload: { command: 'SYNTHETIC' } },
    ] });
    expect(rows(c.consoleLogs.innerHTML)).toBe(1);
    expect(c.consoleLogs.innerHTML.replace(/\s+/g, ' ')).toContain(`A chat turn in the REPL (<span class="mirror-code">timmy</span>) ended (2 steps); Timmy sealed it as receipt <span class="mirror-code">${first.payload.hash.slice(7, 15)}</span>. Its words are in the REPL`);
    expect(c.context.updateMirrorStatus).toHaveBeenLastCalledWith('LIVE');
    // live: a cancelled turn; then the first again (a reconnect's tail): still one row each
    c.receive({ type: 'bus', event: turn(since + 2_000, 'repl · cancelled · 1 step') });
    c.receive({ type: 'bus.tail', events: [first] });
    expect(rows(c.consoleLogs.innerHTML)).toBe(2);
    // R5 lead: said stopped, the word the Workbench and the shared frame use for a turn its person stopped; R7 (H152): with
    // who asked (here no other surface did, so the REPL that sent it)
    expect(c.consoleLogs.innerHTML).toContain('⌨ REPL turn · stopped (asked from the REPL)');
    expect(c.consoleLogs.innerHTML).toContain('stopped (asked from the REPL; 1 step);');
    // a subject that is not the REPL's: the row says only that a turn ended, and nothing of it is markup
    c.receive({ type: 'bus', event: turn(since + 3_000, '<img src=x onerror=alert(1)>') });
    expect(rows(c.consoleLogs.innerHTML)).toBe(3);
    expect(c.consoleLogs.innerHTML).not.toMatch(/<img|onerror/);
    expect(c.consoleLogs.innerHTML).toContain('(<span class="mirror-code">timmy</span>) ended; Timmy sealed it');
    // none in a saved chat's view
    c.context.isViewingSaved = true;
    c.context.renderConsoleLogs([{ role: 'user', content: 'SYNTHETIC saved', timestamp: 1 }]);
    expect(rows(c.consoleLogs.innerHTML)).toBe(0);
  });

  it('puts this monitor\'s chat and the REPL\'s turns in time order; marks a copy restored from before; this session\'s own history or a live answer ends that copy', () => {
    const c = client();
    c.context.mirrorRestored = true;
    c.context.activeChatHistory = [{ role: 'user', content: 'SYNTHETIC restored copy', timestamp: 1 }];
    c.context.renderConsoleLogs(c.context.activeChatHistory);
    expect(c.consoleLogs.innerHTML).toContain('data-mirror="restored"');
    expect(c.consoleLogs.innerHTML).toContain('RESTORED · shown below: this browser\'s own copy of chat it mirrored before this page was opened');
    const t0 = Date.now();
    c.receive({ type: 'welcome', state: 'idle', since: new Date(t0).toISOString() });
    c.receive({ type: 'sync', data: [{ role: 'user', content: 'SYNTHETIC asked', timestamp: t0 + 1_000 }, { role: 'assistant', content: 'SYNTHETIC answered', timestamp: t0 + 3_000 }] });
    expect(c.consoleLogs.innerHTML).not.toContain('data-mirror="restored"');
    expect(c.context.mirrorRestored).toBe(false);
    c.receive({ type: 'bus', event: turn(t0 + 2_000, 'repl · 1 step') });
    const html = c.consoleLogs.innerHTML;
    expect(html.indexOf('SYNTHETIC asked')).toBeLessThan(html.indexOf('REPL turn · ended'));
    expect(html.indexOf('REPL turn · ended')).toBeLessThan(html.indexOf('SYNTHETIC answered'));
    // a live answer over a restored copy starts this session's chat: the copy is not continued
    const d = client();
    d.context.mirrorRestored = true;
    d.context.activeChatHistory = [{ role: 'user', content: 'SYNTHETIC restored copy', timestamp: 1 }];
    d.receive({ type: 'agent:delta', data: { delta: 'SYNTHETIC live', fullText: 'SYNTHETIC live' } });
    expect(d.context.activeChatHistory.map((m: { content: string }) => m.content)).toEqual(['SYNTHETIC live']);
    expect(d.consoleLogs.innerHTML).not.toContain('SYNTHETIC restored copy');
    expect(d.consoleLogs.innerHTML).not.toContain('data-mirror="restored"');
  });
});
