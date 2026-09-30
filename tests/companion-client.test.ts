import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the connection and mirror code that the served page actually runs.
// Synthetic messages exercise transport/display only; no provider is contacted.
const html = readFileSync(new URL('../src/companion/client/index.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('    function saveActiveChat()'), html.indexOf('    // GSAP Tab Deck Controller'));

function client(protocol = 'http:') {
  const statusEl = { textContent: '' };
  const dot = { style: {} as Record<string, string> };
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
      send = vi.fn();
      close = vi.fn();
      constructor(url: string) { this.url = url; sockets.push(this); }
    },
    wsConnection: null, activeChatHistory: [], isViewingSaved: false,
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
    expect(c.dot.style.background).toBe('var(--text-main)');
    expect(c.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'hello' }));
    expect(html).toContain('COMPANION SOCKET · CONNECTING');
    expect(html).not.toMatch(/DO ACTIVE|DO SYNCED|Saved to Cloudflare Durable Object/);
  });

  it('uses secure WebSockets when served over HTTPS', () => {
    expect(client('https:').socket.url).toBe('wss://127.0.0.1:3001');
    expect(client().socket.url).toBe('ws://127.0.0.1:3001');
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
    expect(c.context.updateMirrorStatus).toHaveBeenLastCalledWith('RECONNECTING');
    expect(c.context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 2000);
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

  it('keeps a live streaming reply visible when a tool sync arrives', () => {
    const c = client();
    const user = { role: 'user', content: 'SYNTHETIC request', timestamp: 1 };
    const tool = { role: 'system', isTool: true, content: 'Swarm Orchestrator Tool Call: synthetic_tool with arguments: {"offline":true}', timestamp: 2 };
    c.receive({ type: 'sync', data: [user] });
    c.receive({ type: 'agent:delta', data: { delta: 'SYNTHETIC partial', fullText: 'SYNTHETIC partial' } });
    c.receive({ type: 'sync', data: [user, tool] });
    expect(c.context.activeChatHistory.map((m: any) => m.content)).toEqual([
      'SYNTHETIC request',
      tool.content,
      'SYNTHETIC partial',
    ]);
    expect(JSON.parse(c.storage.get('timmy.chat.active')!).map((m: any) => m.content)).toContain('SYNTHETIC partial');
    c.receive({ type: 'sync', data: [user, tool, { role: 'assistant', content: 'SYNTHETIC partial final', timestamp: 3 }] });
    expect(c.context.activeChatHistory.map((m: any) => m.content)).toEqual([
      'SYNTHETIC request',
      tool.content,
      'SYNTHETIC partial final',
    ]);
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
  });
});
