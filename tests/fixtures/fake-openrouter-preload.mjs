// A FAKE OpenRouter for a child process (R4 H103), loaded with `node --import`: every request the process makes through fetch
// is appended to the file TIMMY_TEST_FETCH_LOG names (one JSON line: method, address and the JSON body it would send). A POST
// to OpenRouter's chat completions gets a FAKE answer here (no model behind it, a cost of 0); any other request is refused
// before it leaves the process, as a connection that was never made. Nothing reaches the network.
import { appendFileSync } from 'node:fs';

const log = process.env.TIMMY_TEST_FETCH_LOG;

globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  let body = null;
  try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = { unreadable: true }; }
  if (log) appendFileSync(log, `${JSON.stringify({ method, url: href, body })}\n`);
  const url = new URL(href);
  if (method === 'POST' && url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/chat/completions') {
    // the simulator asks for JSON (response_format); an actor for a line of plain text
    const content = body?.response_format ? '{"narration":"FAKE: nothing changes."}' : 'FAKE: I wait and say nothing.';
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0, prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const cause = Object.assign(new Error('refused by the test\'s FAKE fetch: nothing left this process'), { code: 'ECONNREFUSED' });
  throw new TypeError('fetch failed', { cause });
};
