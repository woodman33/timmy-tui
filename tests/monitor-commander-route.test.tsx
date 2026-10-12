// R4 (H98, journey-2, item 8): the monitor's top line names the chat route in effect, the commander's included. With the
// commander's socket connected and an operator token present, the monitor's chat sends a turn there (ShellV2 chat-send),
// so the top line says "chat: <its model> · commander"; before, it named the local route ("no model key · /setup", with no
// key) while the turn went to the commander. Without a token the turn stays local, and so do the words.
// The commander here is a local WebSocket server on 127.0.0.1 (the ws package): a FAKE that records what it is sent and
// answers nothing. The token is made at run time. The real ShellV2, rendered by Ink; no model is asked.
import React from 'react';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ShellV2 } from '../src/tui/components/ShellV2.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 15_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f) || Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}
const top = (f: string): string => f.split('\n')[0] ?? '';
const CONFIG = { apiKey: '', model: 'test/model', instructions: '', maxSteps: 1, maxCost: 1 } as never;

const VARS = ['TIMMY_COMMANDER_WS', 'TIMMY_COMMANDER_MODEL', 'TIMMY_EDGE_TOKEN', 'TIMMY_PRIVATE_DIR'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let server: WebSocketServer;
let seen: Array<Record<string, unknown>> = [];
let connections = 0;
let box = '';
let cwd = '';

beforeEach(async () => {
  seen = [];
  connections = 0;
  // no private overlay and no workers/ai-proxy/.dev.vars in reach: the commander's address and token are this test's
  box = mkdtempSync(join(tmpdir(), 'commander-route-'));
  mkdirSync(join(box, 'private'));
  cwd = process.cwd();
  process.chdir(box);
  process.env.TIMMY_PRIVATE_DIR = join(box, 'private');
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', () => r()));
  server.on('connection', (socket) => {
    connections++;
    socket.on('message', (m) => { try { seen.push(JSON.parse(String(m)) as Record<string, unknown>); } catch { /* not JSON */ } });
  });
  process.env.TIMMY_COMMANDER_WS = `ws://127.0.0.1:${(server.address() as { port: number }).port}/commander/test/ws`;
  process.env.TIMMY_COMMANDER_MODEL = 'test/commander-model';
});
afterEach(async () => {
  for (const c of server.clients) c.terminate();
  await new Promise<void>((r) => server.close(() => r()));
  process.chdir(cwd);
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});

describe('the monitor\'s top line and the commander (R4 H98, journey-2)', () => {
  it('connected, with a token: the top line names the commander, and that is where the chat goes', async () => {
    const token = randomBytes(16).toString('hex');
    process.env.TIMMY_EDGE_TOKEN = token;
    const view = render(<ShellV2 width={200} config={CONFIG} />);
    try {
      const f = await until(view, (x) => top(x).includes('· commander'));
      expect(top(f)).toContain('chat: commander-model · commander');
      expect(top(f)).not.toContain('/setup');
      view.stdin.write('c');
      await until(view, (x) => x.includes('SOVEREIGN CHAT'));
      view.stdin.write('hello there');
      await sleep(100);
      view.stdin.write('\r');
      const t0 = Date.now();
      while (!seen.some((m) => m.cmd === 'think') && Date.now() - t0 < 10_000) await sleep(50);
      expect(seen.find((m) => m.cmd === 'think')).toMatchObject({ cmd: 'think', token, body: { task: 'hello there' } });
    } finally {
      view.unmount();
    }
  }, 40_000);

  it('connected, without a token: the chat stays local, and the top line says the local route (no key: /setup)', async () => {
    delete process.env.TIMMY_EDGE_TOKEN;
    const view = render(<ShellV2 width={200} config={CONFIG} />);
    try {
      const t0 = Date.now();
      while (connections < 1 && Date.now() - t0 < 10_000) await sleep(50);
      expect(connections).toBe(1);
      // the monitor reads whether its commander is connected every 2 s
      await sleep(2600);
      expect(top(view.lastFrame() ?? '')).toContain('chat: no model key · /setup');
    } finally {
      view.unmount();
    }
  }, 40_000);
});
