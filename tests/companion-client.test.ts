import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the connection and mirror code that the served page actually runs.
// Synthetic messages exercise transport/display only; no provider is contacted.
const html = readFileSync(new URL('../src/companion/client/index.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('    function escapeMirrorText('), html.indexOf('    // GSAP Tab Deck Controller'));

function client(protocol = 'http:') {
  const statusEl = { textContent: '' };
  const dot = { style: {} as Record<string, string> };
  const consoleLogs = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
  const sockets: any[] = [];
  const context: any = {
    statusEl, consoleLogs, logsList: { innerHTML: '', scrollTop: 0, scrollHeight: 0 }, location: { protocol, host: '127.0.0.1:3001' },
    document: { querySelector: () => dot },
    WebSocket: class {
      url: string;
      send = vi.fn();
      close = vi.fn();
      constructor(url: string) { this.url = url; sockets.push(this); }
    },
    wsConnection: null, activeChatHistory: [], isViewingSaved: false,
    saveActiveChat: vi.fn(), updateMirrorStatus: vi.fn(),
    exitSavedChatViewer: vi.fn(), setTimeout: vi.fn(), console: { error: vi.fn() },
    pHash: { textContent: '' }, pRunId: { textContent: '' }, pPath: { textContent: '' },
  };
  runInNewContext(code + '\nconnect();', context);
  const socket = sockets[0];
  const receive = (msg: unknown) => socket.onmessage({ data: JSON.stringify(msg) });
  return { context, socket, statusEl, dot, consoleLogs, receive };
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
    expect(c.consoleLogs.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(c.consoleLogs.innerHTML).not.toContain('<img');
    c.receive({ type: attack });
    expect(c.context.logsList.innerHTML).not.toContain('<img');
  });
});
