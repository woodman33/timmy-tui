/**
 * FAKE Ollama for the chat's local route (R4 H103): a real HTTP server on 127.0.0.1 with no model behind it. It answers as
 * Ollama's API does (the shapes in Ollama's docs/api.md): GET /api/tags with the models it is given; POST /api/show with a
 * model's capabilities (404 and Ollama's error words for a model it does not list); POST /api/chat with a scripted stream of
 * JSON lines, one script per request, in order. Every request is recorded (method, path, parsed body), so a test sees exactly
 * what Timmy sent. It is a stand-in for the operator's Ollama, labelled FAKE wherever it answers for a model.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeModel {
  name: string;
  /** what /api/show lists; null: no capabilities field at all (an older Ollama) */
  capabilities?: string[] | null;
  /** a cloud-backed model: Ollama names a remote host for it */
  remote_host?: string;
  size?: number;
  details?: Record<string, unknown>;
}

/** One /api/chat answer: an HTTP error with Ollama's words, or JSON lines (each written after `delayMs`), or no answer at all. */
export interface ChatReply { status?: number; error?: string; chunks?: Array<Record<string, unknown>>; delayMs?: number; hang?: boolean }
export type ChatScript = (request: Record<string, any>) => ChatReply;

export interface FakeOllama {
  /** http://127.0.0.1:<port> */
  url: string;
  host: string;
  requests: Array<{ method: string; path: string; body: any }>;
  /** the /api/chat request bodies, in order */
  chats(): any[];
  close(): Promise<void>;
}

const LOCAL_SHOW = { details: { format: 'gguf', family: 'fake', parameter_size: '8B', quantization_level: 'Q4_K_M' }, model_info: { 'fake.context_length': 8192 } };

/** The JSON lines of a streamed answer: `pieces` of text, then the final line (done, done_reason). */
export function textChunks(model: string, pieces: string[], doneReason = 'stop'): Array<Record<string, unknown>> {
  return [
    ...pieces.map((content) => ({ model, created_at: '2026-10-11T00:00:00Z', message: { role: 'assistant', content }, done: false })),
    { model, created_at: '2026-10-11T00:00:01Z', message: { role: 'assistant', content: '' }, done: true, done_reason: doneReason, total_duration: 1, eval_count: pieces.length },
  ];
}

/** The JSON lines of an answer that asks for tool calls (as Ollama streams them: the calls in a chunk, then done). */
export function toolCallChunks(model: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>, text = ''): Array<Record<string, unknown>> {
  return [
    ...(text ? [{ model, message: { role: 'assistant', content: text }, done: false }] : []),
    { model, message: { role: 'assistant', content: '', tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }, done: false },
    { model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
  ];
}

export async function startFakeOllama(o: { models: FakeModel[]; chat?: ChatScript[] }): Promise<FakeOllama> {
  const requests: FakeOllama['requests'] = [];
  const scripts = [...(o.chat ?? [])];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8').on('data', (c: string) => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const path = (req.url ?? '').split('?')[0];
      requests.push({ method: req.method ?? '', path, body });
      const json = (status: number, value: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'GET' && path === '/api/tags') {
        return json(200, { models: o.models.map((m) => ({ name: m.name, model: m.name, size: m.size ?? 5_200_000_000, digest: 'fake', details: m.details ?? { format: 'gguf', parameter_size: '8B', quantization_level: 'Q4_K_M' }, ...(m.remote_host ? { remote_host: m.remote_host, remote_model: m.name.replace(/[:-]cloud$/, '') } : {}) })) });
      }
      if (req.method === 'POST' && path === '/api/show') {
        const m = o.models.find((x) => x.name === body?.model);
        if (!m) return json(404, { error: `model '${String(body?.model)}' not found` });
        const caps = m.capabilities === undefined ? ['completion', 'tools'] : m.capabilities;
        return json(200, { ...LOCAL_SHOW, ...(caps === null ? {} : { capabilities: caps }), ...(m.remote_host ? { remote_host: m.remote_host, remote_model: m.name } : {}) });
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const script = scripts.shift();
        if (!script) return json(500, { error: 'FAKE Ollama: no answer was scripted for this request' });
        const reply = script(body ?? {});
        if (reply.hang) return; // never answers: the turn waits until it is cancelled
        if (reply.status && reply.status !== 200) return json(reply.status, { error: reply.error ?? 'FAKE error' });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const lines = reply.chunks ?? [];
        let i = 0;
        const next = (): void => {
          if (res.destroyed) return;
          if (i >= lines.length) { res.end(); return; }
          res.write(`${JSON.stringify(lines[i++])}\n`);
          if (reply.delayMs) setTimeout(next, reply.delayMs); else next();
        };
        next();
        return;
      }
      json(404, { error: 'FAKE Ollama: not here' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, requests,
    chats: () => requests.filter((r) => r.path === '/api/chat').map((r) => r.body),
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A port on 127.0.0.1 where nothing listens (it was open a moment ago, then closed). */
export async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
