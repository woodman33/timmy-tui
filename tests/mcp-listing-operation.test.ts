/**
 * Round R4 (H99, r24 gap 14): the operation of `/mcp tools`. On the Mac (r24) `/mcp tools -- <command>` started that server
 * command for its listing, and its operation said "it started nothing: the request was answered". Here the operation says
 * a server command was started for a listing and how it ended (src/ops/listing.ts, src/ops/operations.ts decideState), in
 * its record, in `timmy act`'s end line and exit code, and on its /op card; a listing that started nothing still says so.
 *
 * Real pieces: `timmy act` as a child process (the real CLI through tsx, tests/helpers/ops-sandbox.ts), Timmy's SDK route
 * (Timmy's own MCP SDK command), and the MCP server test double tests/fixtures/mcp-echo-server.mjs (a TEST DOUBLE: a stdio
 * server with a few tools, no network); a FAKE server command that exits at once (written by the test). The answers in the
 * words test are FAKE (built by hand in the shape src/connectors/mcp-cli.ts returns).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { McpToolsAnswer } from '../src/connectors/mcp-cli.js';
import { listingProcess } from '../src/ops/listing.js';
import { decideState, readOperationRecord } from '../src/ops/operations.js';
import { act, FIXTURES, opsKit, replOf, sandbox, text } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);
const ECHO = path.join(FIXTURES, 'mcp-echo-server.mjs');
const NODE = process.execPath;
const lastJson = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;

describe('the words of a listing in its operation (FAKE answers)', () => {
  const ref = { command: [NODE, ECHO] };
  const answer = (a: Partial<McpToolsAnswer>): McpToolsAnswer => ({ ok: true, route: 'sdk', server: 'node mcp-echo-server.mjs', ms: 840, tools: [], ...a });
  const tools = [{ name: 'echo', required: [], params: [] }, { name: 'add', required: [], params: [] }];

  it('a listing that ran says what it started and how it ended; one that started nothing is not said', () => {
    expect(listingProcess({ route: 'sdk', ref, answer: answer({ tools, routeRan: true }) })).toEqual({
      what: "a server command was started for a listing (/mcp tools -- node mcp-echo-server.mjs, through Timmy's SDK route)",
      ended: "it listed 2 tools in 840 ms; as the listing ended, Timmy signalled the route's process group to stop (the server it started with it)",
      failed: false,
    });
    expect(listingProcess({ route: 'sdk', ref, answer: answer({ ok: false, error: 'no tool list came back (exit 1) (Error: Connection closed)', routeRan: true }) })).toMatchObject({
      ended: "it ended without a tool list: no tool list came back (exit 1) (Error: Connection closed); as the listing ended, Timmy signalled the route's process group to stop (the server it started with it)",
      failed: true,
    });
    expect(listingProcess({ route: 'sdk', ref, answer: answer({ ok: false, timedOut: true, error: 'no answer within 30 s; stopped the route and its server', routeRan: true }) })).toMatchObject({ ended: 'it ended without a tool list: no answer within 30 s; stopped the route and its server', failed: true });
    expect(listingProcess({ route: 'mcporter', ref: { name: 'notion' }, answer: answer({ route: 'mcporter', ok: false, needsAuth: true, error: 'needs authorization: MCPorter says run "mcporter auth notion" in a terminal', routeRan: true }) })).toMatchObject({
      what: 'MCPorter was run to list the tools of the configured server notion (it starts a stdio server, and reaches an HTTP one)',
      failed: false,
    });
    // nothing started (no route, a spawn that failed, an unknown name): no words of a start
    expect(listingProcess({ route: 'sdk', ref, answer: answer({ ok: false, error: 'could not start: spawn ENOENT' }) })).toBeUndefined();
  });

  it('an operation with no run of its own says what its request started, and fails with it; "it started nothing" only when nothing did', () => {
    const p = { what: 'a server command was started for a listing (/mcp tools -- node s.mjs, through Timmy\'s SDK route)', ended: 'it listed 2 tools in 840 ms', failed: false };
    expect(decideState([], 'answered', [p])).toEqual({ state: 'answered', why: `${p.what}: ${p.ended}` });
    expect(decideState([], 'answered', [{ ...p, ended: 'it ended without a tool list: the route failed', failed: true }])).toEqual({ state: 'failed', why: `${p.what}: it ended without a tool list: the route failed` });
    expect(decideState([])).toEqual({ state: 'answered', why: 'it started nothing: the request was answered' });
    // beside a run, its words follow the run's, and a failed one counts as a failure
    const run = { run: { kind: 'job' as const, id: 'j0a0b0c', at: '' }, out: { state: 'succeeded' as const, words: 'completed' } };
    expect(decideState([run], 'answered', [p])).toEqual({ state: 'succeeded', why: `job j0a0b0c completed; ${p.what}: ${p.ended}` });
    expect(decideState([run], 'answered', [{ ...p, failed: true }]).state).toBe('failed');
  });
});

describe('/mcp tools through `timmy act` and the REPL (real SDK route, the MCP server TEST DOUBLE)', () => {
  it('its operation says a server command was started for a listing and how it ended: in its record, act\'s end line and exit, and /op', async () => {
    const s = sandbox(kit, 'mcp-listing-');
    // 1. A listing that answered: answered (exit 0), with the server command it started and how it ended
    const ok = await act(kit, s, [`/mcp tools --route sdk -- ${NODE} ${ECHO}`, '--json']).done;
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    const j = lastJson(ok.stdout);
    expect(j).toMatchObject({ outcome: 'answered', exit_code: 0 });
    expect(String(j.why)).toMatch(/^a server command was started for a listing \(\/mcp tools -- node mcp-echo-server\.mjs, through Timmy's SDK route\): it listed \d+ tools in \d+ ms; as the listing ended, Timmy signalled the route's process group to stop \(the server it started with it\)$/);
    expect(String(j.why)).not.toContain('started nothing');
    const rec = readOperationRecord(s.root, String(j.operation));
    expect(rec).toMatchObject({ ok: true, record: { state: 'answered', runs: [], processes: [{ what: expect.stringContaining('a server command was started for a listing'), failed: false }] } });

    // 2. A server command that exits at once: the route started it, no tool list came back: failed (exit 1), in its words
    fs.writeFileSync(path.join(s.root, 'gone-server.mjs'), '// a FAKE MCP server: it exits at once, answering nothing\nprocess.exit(3);\n');
    const bad = await act(kit, s, [`/mcp tools --route sdk -- ${NODE} gone-server.mjs`]).done;
    expect(bad.code, bad.stdout + bad.stderr).toBe(1);
    expect(bad.stdout).toMatch(/✖ operation o[0-9a-f]{8} failed: a server command was started for a listing \(\/mcp tools -- node gone-server\.mjs, through Timmy's SDK route\): it ended without a tool list: /);

    // 3. A listing that started nothing (no server given): still "it started nothing"
    const none = await act(kit, s, ['/mcp tools', '--json']).done;
    expect(lastJson(none.stdout)).toMatchObject({ outcome: 'answered', why: 'it started nothing: the request was answered' });

    // 4. In the REPL: the listing's operation is recorded (it started something), and /op says how it ended
    const { ws } = replOf(kit, s);
    const out = text(await ws.operate(`/mcp tools --route sdk -- ${NODE} ${ECHO}`, 'repl', () => ws.mcp(`tools --route sdk -- ${NODE} ${ECHO}`)));
    expect(out).toMatch(/node mcp-echo-server\.mjs via sdk · \d+ tools/);
    const h = ws.ops.latest!;
    await ws.ops.done(h);
    expect(h.ended).toMatchObject({ state: 'answered', why: expect.stringContaining('a server command was started for a listing') });
    expect(readOperationRecord(s.root, h.id)).toMatchObject({ ok: true, record: { state: 'answered' } });
    const card = text(ws.op(h.id));
    expect(card).toContain('a server command was started for a listing (/mcp tools -- node mcp-echo-server.mjs');
    expect(card).not.toContain('started nothing');
  }, 180_000);
});

describe('a server\'s own words in the operation record (R4 H99, the review: they were kept scrubbed for addresses only)', () => {
  it('its stderr line is kept as Timmy keeps any text from outside: no escapes, no key or token, no home folder, addresses in their safe form', async () => {
    const s = sandbox(kit, 'mcp-listing-leak-');
    // a FAKE MCP server: it says an error with secrets in it on stderr (FAKE values, none real) and exits, answering nothing
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const key = `sk-${'q9W8e7R6t5'.repeat(3)}`;
    fs.writeFileSync(path.join(s.root, 'leaky-server.mjs'), [
      '// a FAKE MCP server (a TEST DOUBLE): one error line on stderr, then it exits; nothing it says is a real secret',
      `process.stderr.write('\\u001b[31mError: login failed for token ${token} with key ${key}; see ${s.home}/.config/leaky/config.json and https://auth.example.invalid/start?session=abcdef1234567890\\u001b[0m\\n');`,
      'process.exit(3);',
    ].join('\n'));
    const run = await act(kit, s, [`/mcp tools --route sdk -- ${NODE} leaky-server.mjs`, '--json']).done;
    expect(run.code, run.stdout + run.stderr).toBe(1);
    const j = lastJson(run.stdout);
    const rec = readOperationRecord(s.root, String(j.operation));
    expect(rec.ok).toBe(true);
    const kept = JSON.stringify(rec.ok ? rec.record : {});
    const ended = String((rec.ok ? rec.record.processes : [])[0]?.ended ?? '');
    // the server's own line is there, as its words
    expect(ended).toContain('Error: login failed for token');
    // and none of what must not be kept: the token, the key, the home folder, the escape sequences, the address's secret
    for (const secret of [token, key, s.home, '\u001b', 'abcdef1234567890']) expect(kept, secret).not.toContain(secret);
    expect(ended).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(ended).toContain('[REDACTED_API_KEY]');
    expect(ended).toContain('~/.config/leaky/config.json');
    expect(ended).toContain('https://auth.example.invalid/start');
    // `timmy act`'s own words for it, and the lines it shows, say the same
    for (const secret of [token, key, '\u001b', 'abcdef1234567890']) expect(JSON.stringify(j), secret).not.toContain(secret);
    expect(JSON.stringify(j.lines)).toContain('Error: login failed for token [REDACTED_GITHUB_TOKEN] with key [REDACTED_API_KEY]');
    expect(ended).not.toContain('[0m');
  }, 120_000);
});
