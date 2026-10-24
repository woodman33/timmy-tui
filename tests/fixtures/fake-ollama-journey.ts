/**
 * R11 round 4 (H172): a FAKE Ollama for the account → connections → chat journey: a real HTTP server on 127.0.0.1 with no
 * model behind it, answering as Ollama's API does (docs/api.md): GET /api/tags (the models it is given, with their sizes),
 * POST /api/show (a chat model with tools), POST /api/pull (a download as JSON lines: the manifest, then progress with
 * `total` and `completed`, slowly, until done — and stopped the moment the request is aborted, which it records), and
 * POST /api/chat (streamed JSON lines: a first request answered with ONE tool call, a request that carries the tool's result
 * answered with text; a `slow` message answered a word at a time, so a Stop can end it, which it records). Every request is
 * recorded with its body, so a test sees what Timmy sent and when the stream was cut. It stands in for the person's
 * Ollama, labelled FAKE wherever it answers for a model.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface JourneyModel { name: string; size: number; family?: string; parameterSize?: string; quantization?: string }

export interface JourneyRequest { method: string; path: string; body: any; at: number; aborted?: boolean; ended?: number }

export interface FakeOllamaJourney {
  /** http://127.0.0.1:<port> */
  url: string;
  host: string;
  requests: JourneyRequest[];
  chats(): JourneyRequest[];
  pulls(): JourneyRequest[];
  close(): Promise<void>;
}

export interface JourneyOptions {
  models: JourneyModel[];
  /** the name of the model a pull downloads (its size in bytes, said first) */
  pull?: { name: string; size: number; stepMs?: number; steps?: number };
  /** the tool the FAKE model calls on a first request, with its arguments */
  tool: { name: string; arguments: Record<string, unknown> };
  /** the text the FAKE model answers with once the tool's result is in the conversation */
  answer: string;
  /** a message that gets a slow answer (one word every `slowMs`), for a Stop */
  slow?: { when: RegExp; words: string[]; slowMs: number };
  /** R11 round 6: a message that gets a GATED tool call instead (e.g. write_project_file → the NEEDS YOU gate), then `answer` */
  asks?: { when: RegExp; tool: { name: string; arguments: Record<string, unknown> }; answer: string };
  /** R11 round 6 (the operator's 07:06 bar): a message whose answer is a DENSE stream — `words.length` chunks, one every `everyMs` */
  dense?: { when: RegExp; words: string[]; everyMs: number };
}

export async function startFakeOllamaJourney(o: JourneyOptions): Promise<FakeOllamaJourney> {
  const requests: JourneyRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8').on('data', (c: string) => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const path = (req.url ?? '').split('?')[0];
      const rec: JourneyRequest = { method: req.method ?? '', path, body, at: Date.now() };
      requests.push(rec);
      res.on('close', () => { rec.ended = Date.now(); if (!res.writableFinished) rec.aborted = true; });
      const json = (status: number, value: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      const line = (v: unknown): string => `${JSON.stringify(v)}\n`;
      if (req.method === 'GET' && path === '/api/tags') {
        return json(200, { models: o.models.map((m) => ({ name: m.name, model: m.name, size: m.size, digest: 'fake', modified_at: '2026-10-23T00:00:00Z', details: { format: 'gguf', family: m.family ?? 'fake', parameter_size: m.parameterSize ?? '8B', quantization_level: m.quantization ?? 'Q4_K_M' } })) });
      }
      if (req.method === 'GET' && path === '/api/version') return json(200, { version: '0.0.0-FAKE' });
      if (req.method === 'POST' && path === '/api/show') {
        const m = o.models.find((x) => x.name === body?.model);
        if (!m) return json(404, { error: `model '${String(body?.model)}' not found` });
        return json(200, { details: { format: 'gguf', family: m.family ?? 'fake', parameter_size: m.parameterSize ?? '8B', quantization_level: m.quantization ?? 'Q4_K_M' }, model_info: { 'fake.context_length': 8192 }, capabilities: ['completion', 'tools'] });
      }
      if (req.method === 'POST' && path === '/api/pull') {
        const p = o.pull;
        if (!p || body?.model !== p.name && body?.name !== p.name) return json(404, { error: `pull model manifest: file does not exist (FAKE: only ${p?.name ?? 'nothing'} is here)` });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(line({ status: 'pulling manifest' }));
        const steps = p.steps ?? 10;
        const stepMs = p.stepMs ?? 150;
        let i = 0;
        const tick = (): void => {
          if (res.destroyed || rec.aborted) return;
          i += 1;
          const completed = Math.min(p.size, Math.round((p.size * i) / steps));
          res.write(line({ status: `pulling ${'fakefakefake'}`, digest: 'sha256:fake', total: p.size, completed }));
          if (i >= steps) {
            res.write(line({ status: 'verifying sha256 digest' }));
            res.write(line({ status: 'writing manifest' }));
            res.write(line({ status: 'success' }));
            o.models.push({ name: p.name, size: p.size });
            res.end();
            return;
          }
          setTimeout(tick, stepMs);
        };
        setTimeout(tick, stepMs);
        return;
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const model = String(body?.model ?? '');
        if (!o.models.some((m) => m.name === model)) return json(404, { error: `model '${model}' not found` });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const chunk = (message: Record<string, unknown>, done: boolean, more: Record<string, unknown> = {}): string => line({ model, created_at: new Date().toISOString(), message, done, ...more });
        const messages: Array<{ role?: string; content?: string }> = Array.isArray(body?.messages) ? body.messages : [];
        const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        // the tool's result for THIS turn: a tool message after the last user message (the project's conversation carries the
        // earlier turns' tool messages too, which must not make a later turn skip its own tool call)
        const lastUserAt = messages.map((m) => m.role).lastIndexOf('user');
        const toolAnswered = messages.slice(lastUserAt + 1).some((m) => m.role === 'tool');
        if (o.slow && o.slow.when.test(String(last)) && !toolAnswered) {
          let k = 0;
          const next = (): void => {
            if (res.destroyed || rec.aborted) return;
            if (k >= o.slow!.words.length) { res.end(chunk({ role: 'assistant', content: '' }, true, { done_reason: 'stop', total_duration: 1, prompt_eval_count: 1, eval_count: k })); return; }
            res.write(chunk({ role: 'assistant', content: `${k ? ' ' : ''}${o.slow!.words[k++]}` }, false));
            setTimeout(next, o.slow!.slowMs);
          };
          next();
          return;
        }
        const asks = o.asks && o.asks.when.test(String(last)) ? o.asks : null;
        if (!toolAnswered) {
          const tool = asks ? asks.tool : o.tool;
          res.write(chunk({ role: 'assistant', content: '', tool_calls: [{ function: { name: tool.name, arguments: tool.arguments } }] }, false));
          res.end(chunk({ role: 'assistant', content: '' }, true, { done_reason: 'stop', total_duration: 1, prompt_eval_count: 1, eval_count: 1 }));
          return;
        }
        if (o.dense && o.dense.when.test(String(last))) {
          // the dense stream: one chunk every `everyMs` (many per second), ended by the usual done line; cut when the request is
          let k = 0;
          const next = (): void => {
            if (res.destroyed || rec.aborted) return;
            if (k >= o.dense!.words.length) { res.end(chunk({ role: 'assistant', content: '' }, true, { done_reason: 'stop', total_duration: 1, prompt_eval_count: 1, eval_count: k })); return; }
            res.write(chunk({ role: 'assistant', content: `${k ? ' ' : ''}${o.dense!.words[k++]}` }, false));
            setTimeout(next, o.dense!.everyMs);
          };
          next();
          return;
        }
        for (const piece of (asks ? asks.answer : o.answer).split(' ')) res.write(chunk({ role: 'assistant', content: `${piece} ` }, false));
        res.end(chunk({ role: 'assistant', content: '' }, true, { done_reason: 'stop', total_duration: 1, prompt_eval_count: 1, eval_count: 1 }));
        return;
      }
      json(404, { error: 'FAKE Ollama (journey): only /api/tags, /api/version, /api/show, /api/pull and /api/chat are answered here' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, requests,
    chats: () => requests.filter((r) => r.path === '/api/chat'),
    pulls: () => requests.filter((r) => r.path === '/api/pull'),
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
