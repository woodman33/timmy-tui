// R5 lead (the Mac walk at aa247e5): a local turn stops at the next line of its answer once its signal is aborted, even
// when the fetch itself never sees the abort. On the Mac, Esc set the Workbench turn's signal ("Esc: stopping the chat
// turn being answered") and the answer read on to its end (300 numbers, about 1.5 min) before the turn ended as stopped.
// FAKE here, labelled: the fetch is a stand-in (vi.stubGlobal) that answers /api/show for a chat model and streams one
// /api/chat line every 20 ms until its body is cancelled, ignoring the request's signal on purpose (the case the Mac
// showed); no Ollama and no network are used.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLocalTurn, type LocalTurnHooks } from '../src/agent/local-chat.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timers: NodeJS.Timeout[] = [];
afterEach(() => { for (const t of timers.splice(0)) clearInterval(t); vi.unstubAllGlobals(); });

/** The FAKE fetch: /api/show for a chat model; /api/chat as an endless stream of lines, stopped only by a cancel. */
function fakeOllama() {
  const seen = { chats: 0, linesSent: 0, cancelled: false, signalSeen: false };
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (init?.signal) seen.signalSeen = true;
    if (u.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/api/chat')) {
      seen.chats++;
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          const t = setInterval(() => {
            seen.linesSent++;
            ctrl.enqueue(enc.encode(`${JSON.stringify({ model: 'fake-local:1b', message: { role: 'assistant', content: `${seen.linesSent}\n` }, done: false })}\n`));
          }, 20);
          timers.push(t);
        },
        cancel() { seen.cancelled = true; for (const t of timers) clearInterval(t); },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    return new Response('not here', { status: 404 });
  };
  return { fetch, seen };
}

const hooksInto = (texts: string[]): LocalTurnHooks => ({
  emit: () => undefined,
  call: () => undefined,
  output: () => undefined,
  text: (full: string) => { texts.push(full); },
});

describe('a local turn stopped while its answer streams (R5 lead, the Mac walk at aa247e5)', () => {
  it('ends at the next line once its signal is aborted, though the fetch never sees the abort, and closes the answer\'s stream', async () => {
    const { fetch, seen } = fakeOllama();
    vi.stubGlobal('fetch', fetch);
    const ac = new AbortController();
    const texts: string[] = [];
    const turn = runLocalTurn({ route: { host: '127.0.0.1:11434', model: 'fake-local:1b' }, history: [{ role: 'user', content: 'Count from 1 to 300.' }], tools: [], maxSteps: 4, signal: ac.signal, hooks: hooksInto(texts) });
    const settled = turn.then(() => 'answered', (e: unknown) => (e as { name?: string }).name ?? 'error');
    for (const end = Date.now() + 5000; texts.length < 5 && Date.now() < end;) await sleep(5);
    expect(texts.length).toBeGreaterThanOrEqual(5);
    const atAbort = texts.length;
    const t0 = Date.now();
    ac.abort();
    const how = await Promise.race([settled, sleep(2000).then(() => 'NOT STOPPED in 2 s')]);
    expect(how).toBe('AbortError');
    expect(Date.now() - t0).toBeLessThan(500);
    // at most the line already on its way when the abort came
    expect(texts.length).toBeLessThanOrEqual(atAbort + 1);
    // the answer's stream was cancelled, so the server is told to stop making it
    for (const end = Date.now() + 1000; !seen.cancelled && Date.now() < end;) await sleep(5);
    expect(seen.cancelled).toBe(true);
    expect(seen.chats).toBe(1);
    expect(seen.signalSeen).toBe(true);
  });

  it('ends at once when stopped before Ollama answers, though the fetch never sees the abort; an answer that comes later is closed unread', async () => {
    let answer: ((r: Response) => void) | undefined;
    let lateCancelled = false;
    vi.stubGlobal('fetch', async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
      // the chat request is answered only when the test says, whatever its signal does (a model still loading)
      return new Promise<Response>((resolve) => { answer = resolve; });
    });
    const ac = new AbortController();
    const turn = runLocalTurn({ route: { host: '127.0.0.1:11434', model: 'fake-local:1b' }, history: [{ role: 'user', content: 'Count.' }], tools: [], maxSteps: 4, signal: ac.signal, hooks: hooksInto([]) });
    const settled = turn.then(() => 'answered', (e: unknown) => (e as { name?: string }).name ?? 'error');
    for (const end = Date.now() + 5000; !answer && Date.now() < end;) await sleep(5);
    expect(answer, 'the chat request went to the stand-in').toBeDefined();
    const t0 = Date.now();
    ac.abort();
    expect(await Promise.race([settled, sleep(2000).then(() => 'NOT STOPPED in 2 s')])).toBe('AbortError');
    expect(Date.now() - t0).toBeLessThan(500);
    answer?.(new Response(new ReadableStream<Uint8Array>({ cancel() { lateCancelled = true; } }), { status: 200 }));
    for (const end = Date.now() + 1000; !lateCancelled && Date.now() < end;) await sleep(5);
    expect(lateCancelled, 'the answer that came after the stop was closed unread').toBe(true);
  });

  it('a turn not stopped reads its answer as before (the stand-in ends after 30 lines with done)', async () => {
    const enc = new TextEncoder();
    vi.stubGlobal('fetch', async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
      const lines = Array.from({ length: 30 }, (_, i) => `${JSON.stringify({ model: 'fake-local:1b', message: { role: 'assistant', content: `${i + 1}\n` }, done: i === 29, ...(i === 29 ? { done_reason: 'stop' } : {}) })}\n`);
      return new Response(new ReadableStream<Uint8Array>({ start(ctrl) { for (const l of lines) ctrl.enqueue(enc.encode(l)); ctrl.close(); } }), { status: 200 });
    });
    const texts: string[] = [];
    const r = await runLocalTurn({ route: { host: '127.0.0.1:11434', model: 'fake-local:1b' }, history: [{ role: 'user', content: 'Count.' }], tools: [], maxSteps: 4, signal: new AbortController().signal, hooks: hooksInto(texts) });
    expect(r.fullText.trim().split('\n')).toHaveLength(30);
    expect(r.actualModel).toBe('fake-local:1b');
  });
});
