/**
 * Round R4 (helper H114): two teardowns that timed out in full suites, and whether the wait was Timmy's own stop or only
 * the test's.
 *
 * tests/logs-pages-browser.test.ts (the suite at 86a10be): its afterAll, `browser.close()` then `logs.stop()`, timed out at
 * vitest's 10 s. logs.stop() is Timmy's (src/utils/logserver.ts): it closes the server and every connection it holds at once
 * (closeAllConnections), so it cannot wait on a client; this test pins that with event streams held open and a request
 * half sent. The other wait is Playwright's close of the test's own Chromium, which has no deadline of its own (Playwright
 * 1.60 waits for the browser's process to exit and its profile folder to be removed): only the test's.
 *
 * tests/frame-extractor-browser.test.ts (the same suite): its afterEach `x.stop()` timed out at 10 s, then a test failed
 * with "Cannot read properties of null (reading 'refused')". RiveFrameExtractor.stop() awaits that same close: measured here
 * (H114, a scratch run) 90 ms with Chromium free, and still waiting after 15 s with Chromium's process group held (SIGSTOP),
 * so it can wait for ever. Timmy's own code never awaits it (src/tui/hooks/useGraphicsPipeline.ts stops it without waiting;
 * Playwright ends the browser when the process exits), so the wait was the test's; and the second error was the test's
 * alone: the hook went on after vitest's limit and its `x = null` cleared the next test's extractor. The test now takes the
 * extractor off `x` before it waits, and gives Chromium's close 30 s.
 *
 * Everything here is real: the log server on 127.0.0.1, its HTTP event streams, a raw TCP client.
 */
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startManagedLogServer, type LogServerHandle } from '../src/utils/logserver.js';

const open: Array<{ destroy: () => void }> = [];
let server: LogServerHandle | null = null;
afterEach(async () => {
  for (const o of open.splice(0)) o.destroy();
  const was = server;
  server = null;
  await was?.stop();
});

/** An event stream of the server, held open by a client that reads it and never closes it: resolves once it is connected. */
function stream(port: number, token: string, path: string): Promise<{ res: IncomingMessage; ended: Promise<string> }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } }, (res) => {
      let said = '';
      const ended = new Promise<string>((end) => { res.on('close', () => end('closed')); res.on('error', () => end('closed')); });
      res.setEncoding('utf8').on('data', (c: string) => { said += c; if (said.includes(': connected')) done({ res, ended }); });
    });
    req.on('error', fail);
    open.push(req);
    req.end();
  });
}

describe('R4 (H114): Timmy\'s own stops in the teardowns that timed out', () => {
  it('the log server\'s stop ends at once while clients hold both its event streams open and one has sent half a request', async () => {
    const token = randomBytes(32).toString('hex');
    server = await startManagedLogServer({ port: 0, open: false, token });
    const { port } = server;
    const events = await stream(port, token, '/events');
    const chat = await stream(port, token, '/chat/events');
    expect(events.res.statusCode).toBe(200);
    expect(chat.res.statusCode).toBe(200);
    // a client that sent half a request and waits (a slow or stuck client)
    const half: Socket = connect(port, '127.0.0.1');
    open.push(half);
    await new Promise<void>((done) => half.once('connect', () => done()));
    half.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\n`);
    const halfClosed = new Promise<string>((end) => half.once('close', () => end('closed')));
    await new Promise((r) => { setTimeout(r, 100); });
    const t0 = Date.now();
    const was = server;
    server = null;
    await was.stop();
    const took = Date.now() - t0;
    // it waited for no client: every connection was closed by the server itself
    expect(took).toBeLessThan(2000);
    expect(await Promise.all([events.ended, chat.ended, halfClosed])).toEqual(['closed', 'closed', 'closed']);
  }, 30_000);
});
