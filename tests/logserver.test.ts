import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { folderWords, isLocalIp, startManagedLogServer } from '../src/utils/logserver.js';
import { theme } from '../src/tui/theme.js';

describe('companion back-event authorization', () => {
  it('accepts loopback callers only', () => {
    expect(isLocalIp('127.0.0.1')).toBe(true);
    expect(isLocalIp('::1')).toBe(true);
    expect(isLocalIp('::ffff:127.0.0.1')).toBe(true);
  });
  it('rejects everything else (no tmux/shell over the network)', () => {
    expect(isLocalIp('10.0.0.4')).toBe(false);
    expect(isLocalIp('192.168.1.20')).toBe(false);
    expect(isLocalIp('::ffff:10.0.0.4')).toBe(false);
    expect(isLocalIp('')).toBe(false);
  });
});

// Execute the script actually served by the HTTP listener. Keeping `theme`
// absent from the browser global reproduces the reported event-row failure.
// R4 (H84): the page reads its token from its fragment (a FAKE one here) and its
// event stream with fetch, the token in a header (an EventSource cannot send one):
// the stream below is a FAKE body whose chunks each test sends.
class PageElement {
  className = '';
  innerHTML = '';
  textContent = '';
  scrollTop = 0;
  scrollHeight = 100;
  hidden = true;
  onclick?: () => void;
  children: PageElement[] = [];
  parentElement?: PageElement;
  get firstElementChild(): PageElement | undefined { return this.children[0]; }
  appendChild(child: PageElement): void { child.parentElement = this; this.children.push(child); }
  removeChild(child: PageElement): void { this.children.splice(this.children.indexOf(child), 1); }
}

const TOKEN = 'e5'.repeat(32);
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

async function pageScript(receipts: unknown = [], failRequests = false, token = TOKEN) {
  const server = await startManagedLogServer({ port: 0, host: '127.0.0.1' });
  let html: string;
  try { html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text(); }
  finally { await server.stop(); }
  // R4 (H95): the page's scripts carry the answer's nonce (its policy runs no other inline script)
  const script = html.match(/<script nonce="[A-Za-z0-9+/=]+">([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  const elements = new Map<string, PageElement>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new PageElement());
    return elements.get(id)!;
  };
  get('events').parentElement = new PageElement();
  // the event stream's reads, answered by the test (send / drop)
  const reads: Array<{ resolve: (v: { done: boolean; value?: Uint8Array }) => void; reject: (e: Error) => void }> = [];
  const asked: Array<{ url: string; auth: string }> = [];
  runInNewContext(script!, {
    document: { getElementById: get, createElement: () => new PageElement(), querySelectorAll: () => [] },
    location: { hash: token ? `#t=${token}` : '', pathname: '/', search: '' },
    history: { replaceState: () => undefined },
    TextDecoder,
    setTimeout: () => 0,
    fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
      asked.push({ url, auth: init?.headers?.Authorization ?? '' });
      if (failRequests) throw new Error('offline fixture');
      if (url === '/events') return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) }) } };
      return { ok: true, status: 200, json: async () => url.startsWith('/receipts') ? receipts : { folder: '~/isolated review', ok: true, count: 0 } };
    },
  });
  // Drain fetch -> json -> render promise callbacks in the executable page.
  await flush();
  const send = async (data: string): Promise<void> => { reads.shift()!.resolve({ done: false, value: new TextEncoder().encode(`data: ${data}\n\n`) }); await flush(); };
  const drop = async (): Promise<void> => { reads.shift()!.reject(new Error('dropped')); await flush(); };
  return { get, send, drop, asked, html };
}

describe('live-log browser script', () => {
  it('renders incoming event kinds with the server palette and escapes payload text', async () => {
    const page = await pageScript();
    const cases = [
      ['receipt.sealed', theme.seal], ['job.failed', theme.danger],
      ['approval.gated', theme.warn], ['run.started', theme.accent],
      ['agent.observed', theme.textSecondary],
    ];
    // the stream answered: the page says live
    expect(page.get('conn').textContent).toBe('live');
    for (const [kind, color] of cases) {
      await page.send(JSON.stringify({ ts: '2026-09-30T12:00:00Z', kind, payload: { text: '<script>unsafe</script>' } }));
      expect(page.get('events').children.at(-1)?.innerHTML).toContain(`color:${color}`);
      expect(page.get('events').children.at(-1)?.innerHTML).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    }
    expect(page.get('events').children).toHaveLength(5);
    await page.drop();
    expect(page.get('conn').textContent).toBe('reconnecting…');
  });

  it('skips malformed events, resumes on the next valid event, and bounds retained rows', async () => {
    const page = await pageScript();
    for (const data of ['{', 'null', '{"kind":7}', '{"kind":"run.started","ts":8}']) {
      await page.send(data);
    }
    expect(page.get('events').children).toHaveLength(0);
    expect(page.get('event-note').textContent).toContain('unreadable');
    for (let i = 0; i < 205; i++) {
      await page.send(JSON.stringify({ kind: 'run.progress', payload: { index: i } }));
    }
    expect(page.get('events').children).toHaveLength(200);
    expect(page.get('events').children[0].innerHTML).toContain('"index":5');
    expect(page.get('event-note').textContent).toContain('older rows omitted');
    expect(page.get('events').parentElement?.scrollTop).toBe(100);
  });

  it('shows an honest empty receipt state and refuses malformed receipt responses', async () => {
    const empty = await pageScript();
    expect(empty.get('chain-note').textContent).toBe('No receipts in this store yet.');
    // R4 (H92): its folder as /health words it (from ~, or by name), never a path of its own making
    expect(empty.get('cwd').textContent).toBe('~/isolated review');
    const invalid = await pageScript({ error: 'unavailable' });
    expect(invalid.get('chain-note').textContent).toBe('Receipt history unavailable · retrying when a receipt arrives.');
  });

  it('keeps network and verification failures visible without claiming a verified chain', async () => {
    const page = await pageScript([], true);
    expect(page.get('chain-note').textContent).toContain('unavailable');
    expect(page.get('cwd').textContent).toBe('workspace unavailable');
    page.get('verify').onclick!();
    await new Promise(resolve => setImmediate(resolve));
    expect(page.get('verify-out').textContent).toBe('Chain verification unavailable · try again.');
    expect(page.get('verify-out').textContent).not.toContain('chain intact');
  });

  // R4 (H84): every request the page makes carries its token in a header, the event stream too; without one it asks nothing
  it('sends its token in a header on every request, and without a token asks nothing and says how to open it', async () => {
    const page = await pageScript();
    expect(page.asked.map((a) => a.url).sort()).toEqual(['/events', '/health', '/receipts?stream=runs']);
    for (const a of page.asked) expect(a.auth).toBe(`Bearer ${TOKEN}`);
    for (const a of page.asked) expect(a.url).not.toContain(TOKEN);
    const none = await pageScript([], false, '');
    expect(none.asked).toEqual([]);
    expect(none.get('timmy-token-note').hidden).toBe(false);
    expect(none.get('timmy-token-note').textContent).toMatch(/timmy logs/);
    expect(none.get('conn').textContent).toBe('needs its token');
  });
});

// R4 (H92; r23c, row 173: the page showed its working folder as an absolute path): the words /health gives the page.
describe('the folder `timmy logs` shows (R4 H92)', () => {
  it('from ~ under a home folder, else by its name; never the whole path', () => {
    const home = mkdtempSync(join(tmpdir(), 'h92-logs-home-'));
    try {
      const env = { HOME: home };
      expect(folderWords(home, env)).toBe('~');
      expect(folderWords(join(home, 'code', 'proj'), env)).toBe('~/code/proj');
      expect(folderWords(join(home, 'code', 'proj') + '/', env)).toBe('~/code/proj/');
      // a folder that only starts like the home folder is not under it
      expect(folderWords(`${home}x/proj`, env)).toBe('proj');
      expect(folderWords('/srv/work/proj', env)).toBe('proj');
      expect(folderWords('/srv/work/proj/', env)).toBe('proj');
      expect(folderWords('/', env)).toBe('/');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
