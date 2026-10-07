import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenRouter } from '@openrouter/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent/core.js';

// Cancel against the REAL OpenRouter SDK (review finding: a stub agent hid this). A local fake server
// answers 200 text/event-stream and then stalls; Ctrl+C aborts the turn. The SDK runs a background
// execution promise that must not be left to reject unhandled (the REPL would exit 1).
const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
const stallingServer = () => new Promise<string>((resolve) => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': ping\n\n');
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('agent.send cancel with the real SDK', () => {
  it('rejects with AbortError and leaves no unhandled rejection, no error event, a free agent', async () => {
    const serverURL = await stallingServer();
    const agent = createAgent({ apiKey: 'x', model: 'm', instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
    (agent as unknown as { client: OpenRouter }).client = new OpenRouter({ apiKey: 'x', serverURL });
    const unhandled: string[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(String((e as Error)?.message ?? e));
    process.on('unhandledRejection', onUnhandled);
    const errors: string[] = [];
    agent.on('error', (e) => errors.push(e.message));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    try {
      await expect(agent.send('hi', { signal: controller.signal, retry: true })).rejects.toMatchObject({ name: 'AbortError' });
      await sleep(800);
      expect({ unhandled, errors, running: agent.isRunning() }).toEqual({ unhandled: [], errors: [], running: false });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
