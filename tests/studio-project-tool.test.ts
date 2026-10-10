/**
 * Round R4 (H55): the agent's canvas_place_project_card. Its request: fixed code sent through the real studio server's
 * bridge, the model's card id only as a JSON string literal in it. The page here is a FAKE one (a WebSocket that records
 * the code it gets and answers), as tests/studio-tools.test.ts does; the real page runs the same code in a real Chromium in
 * tests/studio-project-browser.test.ts. Also: its NEEDS YOU rule and its /tools row.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createCanvasTools, PLACE_PROJECT_CARD } from '../src/agent/canvas-tools.js';
import { capabilities, type ProbeDeps } from '../src/capabilities/index.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';

let server: StudioServer | undefined;
let home = '';
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = '';
});
const base = (): string => `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
/** FAKE page: records each code it is sent and answers with `answer(code)`. */
async function fakePage(answer: (code: string) => unknown): Promise<string[]> {
  const seen: string[] = [];
  const ws = new WebSocket(`${base().replace('http', 'ws')}/bridge`, { origin: base() });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as { id: number; code: string };
    seen.push(m.code);
    ws.send(JSON.stringify({ id: m.id, ok: true, result: answer(m.code), revision: 7 }));
  });
  return seen;
}
const tool = () => createCanvasTools({ baseUrl: base() }).find((t) => (t as { function: { name: string } }).function.name === 'canvas_place_project_card') as unknown as { function: { execute: (a: unknown) => Promise<Record<string, unknown>> } };

describe('canvas_place_project_card', () => {
  it('sends fixed code through the bridge: the card id arrives only as a JSON string, and the page answer comes back as it is', async () => {
    home = mkdtempSync(join(tmpdir(), 'studio-project-tool-'));
    server = await startStudioServer(0, { env: { TIMMY_HOME: home } });
    const seen = await fakePage(() => ({ placed: true, shape: 'shape:x' }));
    const hostile = '"); editor.deleteShapes(editor.getCurrentPageShapeIds()); ("';
    const r = await tool().function.execute({ card: hostile });
    expect(r).toMatchObject({ ok: true, result: { placed: true, shape: 'shape:x' }, revision: 7 });
    expect(seen).toEqual([PLACE_PROJECT_CARD(hostile)]);
    expect(seen[0]).toContain(`const card = ${JSON.stringify(hostile)};`);
    expect(seen[0].split(JSON.stringify(hostile)).join('')).not.toContain('deleteShapes');
    expect(seen[0]).toContain('return await canvas.placeProjectCard(card, editor);');
    // Without a card: the same fixed code with null, which only lists the cards.
    await tool().function.execute({});
    expect(seen[1]).toContain('const card = null;');
  });
  it('asks before it places (one note, saved with the canvas), naming the card, and has a /tools row with the other canvas tools', async () => {
    expect(approvalNeeded('canvas_place_project_card', { card: 'flow:f1a2b3c4d' })).toEqual({ reason: 'places a card of your project on Timmy Canvas (one note, saved with the canvas)', summary: 'flow:f1a2b3c4d' });
    // The same stand-ins as tests/capabilities.test.ts: nothing installed, nothing running, nothing contacted.
    const none: ProbeDeps = {
      env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
      ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'test/model', http: async () => null,
      lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
    };
    const rows = await capabilities(none);
    expect(rows.find((r) => r.id === 'canvas-tools')?.tools).toEqual(['canvas_exec', 'canvas_read', 'canvas_api', 'canvas_place_project_card']);
  });
});
