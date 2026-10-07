import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startStudioServer } from '../src/studio/server.js';

// F-4, slice 2: the agent bridge. The canvas page keeps one WebSocket to the studio server; the
// agent's canvas tools POST Editor API code to /api/canvas/exec, the page runs it against the live
// editor and answers with the result, the job ID and the canvas revision (readback, not a promise).
let server: Server | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});
const port = (): number => (server!.address() as AddressInfo).port;

/** A stand-in for the canvas page: answers each exec with `answer(message)`. */
async function page(answer: (m: { id: number; code: string; jobId: string }) => unknown, origin = `http://127.0.0.1:${port()}`): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port()}/bridge`, { origin });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); ws.once('unexpected-response', (_q, r) => reject(new Error(`HTTP ${r.statusCode}`))); });
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.type !== 'exec') return;
    const reply = answer(m);
    if (reply !== undefined) ws.send(JSON.stringify({ id: m.id, ...(reply as object) }));
  });
  return ws;
}
const exec = (body: unknown, contentType = 'application/json') =>
  fetch(`http://127.0.0.1:${port()}/api/canvas/exec`, { method: 'POST', headers: { 'Content-Type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));

describe('the canvas bridge', () => {
  it('runs code on the open canvas and returns its result, the job ID and the revision', async () => {
    server = await startStudioServer(0, { env: {} });
    let seen: { code: string; jobId: string } | undefined;
    await page((m) => { seen = m; return { ok: true, result: { shapes: 2 }, revision: 7 }; });
    const r = await exec({ code: 'return editor.getCurrentPageShapes().length', jobId: 'job-42' });
    expect(seen).toMatchObject({ code: 'return editor.getCurrentPageShapes().length', jobId: 'job-42' });
    expect(r).toEqual({ status: 200, body: { ok: true, result: { shapes: 2 }, jobId: 'job-42', revision: 7 } });
  });
  it('gives every call a job ID when the caller has none', async () => {
    server = await startStudioServer(0, { env: {} });
    await page(() => ({ ok: true, result: null, revision: 1 }));
    const r = await exec({ code: 'return 1' });
    expect(r.body.jobId).toMatch(/^canvas-[0-9a-f-]{8,}/);
  });
  it('says plainly when no canvas is open (503), instead of waiting', async () => {
    server = await startStudioServer(0, { env: {} });
    const r = await exec({ code: 'return 1' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, error: 'No canvas is open. Open it with /web studio, then try again.' });
  });
  it('passes the page\'s own error back as a failed call', async () => {
    server = await startStudioServer(0, { env: {} });
    await page(() => ({ ok: false, error: 'TypeError: editor.nope is not a function', revision: 3 }));
    const r = await exec({ code: 'editor.nope()', jobId: 'j1' });
    expect(r).toEqual({ status: 200, body: { ok: false, error: 'TypeError: editor.nope is not a function', jobId: 'j1', revision: 3 } });
  });
  it('gives up on a page that never answers (504)', async () => {
    server = await startStudioServer(0, { env: {}, execTimeoutMs: 150 });
    await page(() => undefined);
    const r = await exec({ code: 'while (true) {}' });
    expect(r.status).toBe(504);
    expect(r.body.error).toBe('The canvas did not answer within 0.15 s.');
  });
  it('sends work to the newest open canvas', async () => {
    server = await startStudioServer(0, { env: {} });
    await page(() => ({ ok: true, result: 'old', revision: 1 }));
    await page(() => ({ ok: true, result: 'new', revision: 1 }));
    expect((await exec({ code: 'return 1' })).body.result).toBe('new');
  });
  it('stops promptly while a canvas is still connected (the page is told nothing more)', async () => {
    server = await startStudioServer(0, { env: {} });
    await page(() => ({ ok: true, revision: 1 }));
    const started = Date.now();
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('refuses a page from another origin, and requests that are not JSON or carry no code', async () => {
    server = await startStudioServer(0, { env: {} });
    await expect(page(() => ({ ok: true }), 'https://evil.example')).rejects.toThrow(/403/);
    expect((await exec('code=return 1', 'text/plain')).status).toBe(415);
    expect((await exec({ jobId: 'x' })).status).toBe(400);
    expect((await exec({ code: 'x'.repeat(40_000) })).status).toBe(413);
  });
  // Fourth order, step 5: the page answers a call only after saving the canvas, with the source
  // revision of what it saved (the sha256 of the saved document), or with why the save failed.
  it("passes the page's source revision on, and a save that failed; a malformed one is dropped", async () => {
    server = await startStudioServer(0, { env: {} });
    const answers = [
      { ok: true, result: 1, revision: 4, sourceRevision: 'ab'.repeat(32) },
      { ok: true, result: 1, revision: 4, sourceRevision: 'not-a-hash', saveError: 'Another window saved this canvas at revision 5 after this one opened it.' },
    ];
    await page(() => answers.shift());
    expect((await exec({ code: 'return 1', jobId: 'j1' })).body).toEqual({ ok: true, result: 1, jobId: 'j1', revision: 4, sourceRevision: 'ab'.repeat(32) });
    expect((await exec({ code: 'return 1', jobId: 'j1' })).body).toEqual({ ok: true, result: 1, jobId: 'j1', revision: 4, saveError: 'Another window saved this canvas at revision 5 after this one opened it.' });
  });
  it('records each call the page answered with a source revision in the canvas jobs ledger, in Timmy\'s home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'timmy-canvas-home-'));
    try {
      server = await startStudioServer(0, { env: { TIMMY_HOME: home } });
      const answers = [{ ok: true, result: 1, revision: 4, sourceRevision: 'ab'.repeat(32) }, { ok: true, result: 2, revision: 4 }];
      await page(() => answers.shift());
      await exec({ code: 'return 1', jobId: 'turn-9' });
      await exec({ code: 'return 2', jobId: 'turn-10' }); // no source revision: nothing was saved, so no job is recorded
      const jobs = await fetch(`http://127.0.0.1:${port()}/api/canvas/jobs`).then((r) => r.json());
      expect(jobs).toEqual([{ id: 'turn-9', ok: true, calls: 1, revision: 4, sourceRevision: 'ab'.repeat(32), at: expect.any(String) }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
