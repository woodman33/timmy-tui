import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { startStudioServer } from '../src/studio/server.js';

// F-4, slice 3: the canvas as agent tools. canvas_exec runs Editor API code; canvas_read and
// canvas_api send fixed code (the model's words only ever arrive as a JSON string literal).
let server: Server | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});
const base = (): string => `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
async function page(answer: (code: string) => unknown): Promise<string[]> {
  const seen: string[] = [];
  const ws = new WebSocket(`${base().replace('http', 'ws')}/bridge`, { origin: base() });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    seen.push(m.code);
    ws.send(JSON.stringify({ id: m.id, ok: true, result: answer(m.code), revision: 4 }));
  });
  return seen;
}
const run = (tools: ReturnType<typeof createCanvasTools>, name: string, args: Record<string, unknown>) =>
  (tools.find((t) => t.function.name === name)!.function.execute as (a: unknown, c?: unknown) => Promise<Record<string, unknown>>)(args, undefined);

describe('the canvas tools', () => {
  it('canvas_exec runs the code on the open canvas and returns the readback with its job ID and revision', async () => {
    server = await startStudioServer(0, { env: {} });
    const seen = await page(() => 2);
    const r = await run(createCanvasTools({ baseUrl: base() }), 'canvas_exec', { code: 'return editor.getCurrentPageShapes().length', jobId: 'job-7' });
    expect(seen).toEqual(['return editor.getCurrentPageShapes().length']);
    expect(r).toEqual({ ok: true, result: 2, jobId: 'job-7', revision: 4 });
  });
  it('canvas_read sends fixed read-only code and returns the page summary', async () => {
    server = await startStudioServer(0, { env: {} });
    const seen = await page(() => ({ page: { name: 'Page 1' }, shapes: [] }));
    const r = await run(createCanvasTools({ baseUrl: base() }), 'canvas_read', {});
    expect(seen[0]).toContain('editor.getCurrentPageShapes()');
    expect(seen[0]).not.toMatch(/createShape|updateShape|deleteShape/);
    expect(r).toMatchObject({ ok: true, result: { page: { name: 'Page 1' } } });
  });
  it('canvas_api searches the live Editor API; the query reaches the page only as a JSON string', async () => {
    server = await startStudioServer(0, { env: {} });
    const seen = await page(() => ({ total: 0, members: [] }));
    const hostile = '"); editor.deleteShapes(editor.getCurrentPageShapeIds()); ("';
    await run(createCanvasTools({ baseUrl: base() }), 'canvas_api', { query: hostile });
    expect(seen[0]).toContain(`const query = ${JSON.stringify(hostile.toLowerCase())};`);
    expect(seen[0].split(JSON.stringify(hostile.toLowerCase())).join('')).not.toContain('deleteShapes');
  });
  it('says how to start the canvas when Timmy Canvas is not running', async () => {
    const r = await run(createCanvasTools({ baseUrl: 'http://127.0.0.1:9' }), 'canvas_exec', { code: 'return 1' });
    expect(r).toEqual({ ok: false, error: 'Timmy Canvas is not running. Open it with /web studio in the REPL, or run `timmy studio`.' });
  });
  it('passes the server\'s own refusal through (no canvas open)', async () => {
    server = await startStudioServer(0, { env: {} });
    const r = await run(createCanvasTools({ baseUrl: base() }), 'canvas_read', {});
    expect(r).toMatchObject({ ok: false, error: 'No canvas is open. Open it with /web studio, then try again.' });
  });
});

describe('the canvas tools under NEEDS YOU', () => {
  it('reading the canvas and searching its API never ask', () => {
    expect(approvalNeeded('canvas_read', {})).toBeNull();
    expect(approvalNeeded('canvas_api', { query: 'shape' })).toBeNull();
  });
  it('running code on the canvas asks (the page can reach the network), showing the code', () => {
    expect(approvalNeeded('canvas_exec', { code: 'editor.createShape({ type: "geo" })' })).toEqual({
      reason: 'runs code in the canvas page, which can reach the network',
      summary: 'editor.createShape({ type: "geo" })',
    });
  });
});
