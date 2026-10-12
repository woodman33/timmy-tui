// A recording fetch for a child process (R4 H103, D1), FAKE network, loaded with `node --import`: every request the process
// makes through fetch is appended to the file TIMMY_TEST_FETCH_LOG names (one JSON line: method and address). One to a port
// on 127.0.0.1 listed in TIMMY_TEST_FETCH_ALLOW (comma-separated) goes through; any other is refused here, before it leaves
// the process, as a connection that was never made (ECONNREFUSED). The OpenRouter SDK calls the global fetch at each request,
// so its requests are recorded too: a test reads the file to see whether anything tried to reach a model.
import { appendFileSync } from 'node:fs';

const log = process.env.TIMMY_TEST_FETCH_LOG;
const allow = new Set((process.env.TIMMY_TEST_FETCH_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const original = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (typeof input === 'object' && input !== null && 'method' in input ? input.method : 'GET');
  if (log) appendFileSync(log, `${JSON.stringify({ method, url: href })}\n`);
  const url = new URL(href);
  if (url.hostname === '127.0.0.1' && allow.has(url.port)) return original(input, init);
  const cause = Object.assign(new Error('refused by the test\'s recording fetch: nothing left this process'), { code: 'ECONNREFUSED' });
  throw new TypeError('fetch failed', { cause });
};
