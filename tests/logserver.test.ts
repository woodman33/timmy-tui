import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { isLocalIp, startManagedLogServer } from '../src/utils/logserver.js';
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
class PageElement {
  className = '';
  innerHTML = '';
  textContent = '';
  scrollTop = 0;
  scrollHeight = 100;
  onclick?: () => void;
  children: PageElement[] = [];
  parentElement?: PageElement;
  get firstElementChild(): PageElement | undefined { return this.children[0]; }
  appendChild(child: PageElement): void { child.parentElement = this; this.children.push(child); }
  removeChild(child: PageElement): void { this.children.splice(this.children.indexOf(child), 1); }
}

async function pageScript(receipts: unknown = [], failRequests = false) {
  const server = await startManagedLogServer({ port: 0, host: '127.0.0.1' });
  let html: string;
  try { html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text(); }
  finally { await server.stop(); }
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  const elements = new Map<string, PageElement>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new PageElement());
    return elements.get(id)!;
  };
  get('events').parentElement = new PageElement();
  const streams: { onmessage?: (event: { data: string }) => void; onopen?: () => void; onerror?: () => void }[] = [];
  runInNewContext(script!, {
    document: { getElementById: get, createElement: () => new PageElement() },
    EventSource: class {
      constructor() { streams.push(this); }
    },
    fetch: async (url: string) => {
      if (failRequests) throw new Error('offline fixture');
      return { ok: true, json: async () => url.startsWith('/receipts') ? receipts : { cwd: 'isolated review', ok: true, count: 0 } };
    },
  });
  // Drain fetch -> json -> render promise callbacks in the executable page.
  await new Promise(resolve => setImmediate(resolve));
  return { get, stream: streams[0], html };
}

describe('live-log browser script', () => {
  it('renders incoming event kinds with the server palette and escapes payload text', async () => {
    const page = await pageScript();
    const cases = [
      ['receipt.sealed', theme.seal], ['job.failed', theme.danger],
      ['approval.gated', theme.warn], ['run.started', theme.accent],
      ['agent.observed', theme.textSecondary],
    ];
    for (const [kind, color] of cases) {
      expect(() => page.stream.onmessage!({ data: JSON.stringify({ ts: '2026-09-30T12:00:00Z', kind, payload: { text: '<script>unsafe</script>' } }) })).not.toThrow();
      expect(page.get('events').children.at(-1)?.innerHTML).toContain(`color:${color}`);
      expect(page.get('events').children.at(-1)?.innerHTML).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    }
    expect(page.get('events').children).toHaveLength(5);
    page.stream.onopen!();
    expect(page.get('conn').textContent).toBe('live');
    page.stream.onerror!();
    expect(page.get('conn').textContent).toBe('reconnecting…');
  });

  it('skips malformed events, resumes on the next valid event, and bounds retained rows', async () => {
    const page = await pageScript();
    for (const data of ['{', 'null', '{"kind":7}', '{"kind":"run.started","ts":8}']) {
      expect(() => page.stream.onmessage!({ data })).not.toThrow();
    }
    expect(page.get('events').children).toHaveLength(0);
    expect(page.get('event-note').textContent).toContain('unreadable');
    for (let i = 0; i < 205; i++) {
      page.stream.onmessage!({ data: JSON.stringify({ kind: 'run.progress', payload: { index: i } }) });
    }
    expect(page.get('events').children).toHaveLength(200);
    expect(page.get('events').children[0].innerHTML).toContain('"index":5');
    expect(page.get('event-note').textContent).toContain('older rows omitted');
    expect(page.get('events').parentElement?.scrollTop).toBe(100);
  });

  it('shows an honest empty receipt state and refuses malformed receipt responses', async () => {
    const empty = await pageScript();
    expect(empty.get('chain-note').textContent).toBe('No receipts in this store yet.');
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
});
