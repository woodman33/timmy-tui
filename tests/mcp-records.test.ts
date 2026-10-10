// Round R4 (H34): MCP calls kept as records with receipts, answers made readable, the server's own words for an error
// answer, JSON arguments that work as typed in the REPL, safe server URLs, and the server's own hints (annotations).
// Every server here is a test double: the fixture server (tests/fixtures/mcp-echo-server.mjs) started as a child
// process, or a stand-in config; the only HTTP server is a local 127.0.0.1 stand-in that answers 401. Hosts, keys and
// account names below are made up. Nothing reaches the network.
import { createServer, request, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { callAndRecord, callTool, listServers, listTools, mcpView, parseCallLine, redactParts, safeServerUrl, scrubUrls, urlSecrets } from '../src/connectors/mcp-cli.js';
import { answerLines, cleanText, fitLines, hintWords, MCP_CALL_ID, MCP_CALL_SCHEMA, readMcpCalls, readRouteAnswer, writeMcpCall, type McpCallFacts } from '../src/connectors/mcp-records.js';
import { createMcpTools } from '../src/agent/mcp-tools.js';
import { folderProject, projectId } from '../src/project/index.js';
import { kit } from '../src/repl/board-kit.js';
import { mcpResults, renderResultCards } from '../src/repl/board-cards.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, readChain, verifyChain, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const NODE = process.execPath;
const SERVER = { command: [NODE, FIXTURE] };
const AT = `-- ${NODE} ${FIXTURE}`;
/** The fixture's own error text (tests/fixtures/mcp-echo-server.mjs FIXTURE_ERROR). */
const FIXTURE_ERROR = 'No editor is connected. Open the document in the editor, enable the bridge, then retry.';
const LONG = 120_000;

const dirs: string[] = [];
const spaces: Workspace[] = [];
const scratch = (p = 'mcprec-'): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const w of spaces.splice(0)) await w.close();
});
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const json = (root: string, rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, unknown>;
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const mode = (p: string): number => statSync(p).mode & 0o777;

/** A project whose config/mcporter.json names the fixture, and a home of its own (no editor's config to import). */
function configured(extra: Record<string, unknown> = {}): { root: string; home: string; env: Record<string, string | undefined> } {
  const root = scratch('mcprec-proj-');
  const home = scratch('mcprec-home-');
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config', 'mcporter.json'), JSON.stringify({ mcpServers: { 'echo-fixture': { command: NODE, args: [FIXTURE] }, ...extra } }));
  return { root, home, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home } };
}

/** A seal that keeps what it seals, and the chain it makes: each receipt's hash is its own body's (as appendReceipt makes it). */
function sealer() {
  const sealed: ReceiptInput[] = [];
  const chain = (): Receipt[] => sealed.map((r, i) => {
    const body = { v: 1, id: `rc_${i}`, stream: 'runs', ts: '2026-10-09T09:00:01.000Z', ...r, prev_hash: 'genesis' };
    return { ...body, hash: hashOf({ ...body, hash: '' }) } as unknown as Receipt;
  });
  const seal = (input: ReceiptInput): string => { sealed.push(input); return chain()[sealed.length - 1].hash.slice(7, 15); };
  return { sealed, chain, seal };
}

/** The REPL's workspace on a project, with the stand-in seal (src/repl/main.ts gives appendReceipt's). */
function workspace(root: string) {
  const s = sealer();
  const ws = new Workspace({
    glyphs: glyphSet(true), env: {}, onPath: () => null, notify: () => {}, openWeb: (url) => `Open ${url}`, link: (t) => t,
    seal: s.seal, jobsDir: join(scratch('mcprec-jobs-'), 'jobs'), chdir: () => {}, receipts: s.chain, recoverAtStart: false,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, ...s };
}

/** The call ids in a project, in the order the calls started. */
const calls = (root: string): string[] => {
  let ids: string[];
  try { ids = readdirSync(join(root, '.timmy', 'mcp')).filter((n) => MCP_CALL_ID.test(n)); } catch { return []; }
  const started = (id: string): number => Date.parse(String(json(root, `.timmy/mcp/${id}/call.json`).started_at));
  return ids.sort((a, b) => started(a) - started(b));
};
const recordLine = (out: string): string => /record (\.timmy\/mcp\/m[0-9a-f]{8}\/call\.json)/.exec(out)?.[1] ?? '';

describe('/mcp call reads its JSON as typed', () => {
  it('JSON with spaces and double quotes, single-quoted JSON, an apostrophe inside it, and JSON before -- <command>', () => {
    expect(parseCallLine('cloudflare-docs search_cloudflare_documentation {"query":"Workers KV eventual consistency"}'))
      .toEqual({ ok: true, server: 'cloudflare-docs', tool: 'search_cloudflare_documentation', args: { query: 'Workers KV eventual consistency' } });
    expect(parseCallLine('docs search { "query" : "a \\"quoted\\" word",  "limit": 3 }')).toEqual({ ok: true, server: 'docs', tool: 'search', args: { query: 'a "quoted" word', limit: 3 } });
    expect(parseCallLine("Spline 3d_load_skill '{\"name\":\"index\"}'")).toEqual({ ok: true, server: 'Spline', tool: '3d_load_skill', args: { name: 'index' } });
    expect(parseCallLine("docs echo '{\"text\":\"it's here\"}'")).toEqual({ ok: true, server: 'docs', tool: 'echo', args: { text: "it's here" } });
    expect(parseCallLine('docs echo {"text":"a } and { inside"}')).toEqual({ ok: true, server: 'docs', tool: 'echo', args: { text: 'a } and { inside' } });
    expect(parseCallLine('--route sdk echo {"text":"a -- b"} -- node "my server.mjs" --flag')).toEqual({ ok: true, route: 'sdk', command: ['node', 'my server.mjs', '--flag'], tool: 'echo', args: { text: 'a -- b' } });
    expect(parseCallLine('docs list_all')).toEqual({ ok: true, server: 'docs', tool: 'list_all', args: {} });
    expect(parseCallLine('add -- node x.mjs')).toEqual({ ok: true, command: ['node', 'x.mjs'], tool: 'add', args: {} });
  });

  it('a JSON error names the problem and shows an example that works; the example itself parses', () => {
    const bad = parseCallLine('docs search {"query":"Workers KV"');
    expect(bad.ok).toBe(false);
    const error = (bad as { error: string }).error;
    expect(error).toMatch(/^the arguments are not valid JSON: .*(JSON|position|end)/);
    expect(error).toContain('e.g. /mcp call docs search {"text":"hi there"}');
    const example = /e\.g\. \/mcp call (.*)$/.exec(error)![1];
    expect(parseCallLine(example)).toEqual({ ok: true, server: 'docs', tool: 'search', args: { text: 'hi there' } });
    const unquoted = parseCallLine('docs search {query:"x"}');
    expect((unquoted as { error: string }).error).toMatch(/^the arguments are not valid JSON: .*property name/i);
    const array = parseCallLine('docs search [1,2]');
    expect((array as { error: string }).error).toMatch(/^the arguments must be one JSON object after the tool, not "\[1,2\]"/);
    const after = parseCallLine('docs search {"a":1} trailing words');
    expect((after as { error: string }).error).toMatch(/^only "-- <command>" may follow the JSON arguments, not "trailing words"/);
    expect((parseCallLine('docs search text=hi') as { error: string }).error).toMatch(/one JSON object after the tool, not "text=hi"/);
    expect((parseCallLine("docs search '{\"a\":1}") as { error: string }).error).toMatch(/single quote before the arguments is not closed/);
    expect((parseCallLine('--route mcp docs search') as { error: string }).error).toBe('no route named mcp: mcporter or sdk');
    expect((parseCallLine('docs search {"a":1} -- node x.mjs') as { error: string }).error).toMatch(/with -- <command>, name only the tool/);
    for (const r of [bad, unquoted, array, after]) expect((r as { error: string }).error).toMatch(/Give one JSON object after the tool, as it is or in single quotes, e\.g\. /);
  });

  it('the help shows a call whose JSON works as typed', async () => {
    const help = (await mcpView('', { cwd: scratch(), env: { PATH: process.env.PATH, HOME: scratch() } })).join('\n');
    const line = /e\.g\. \/mcp call (docs search \{[^}]*\})/.exec(help);
    expect(line).not.toBeNull();
    expect(parseCallLine(line![1])).toEqual({ ok: true, server: 'docs', tool: 'search', args: { query: 'Workers KV eventual consistency' } });
    expect(help).toContain('the JSON object is the rest of the line');
    expect(help).toContain('.timmy/mcp/<call-id>/');
  }, LONG);

  it('through the REPL (the command registry, then Workspace.mcp): a configured server gets its JSON arguments whole', async () => {
    const { root, home } = configured();
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const { ws, sealed } = workspace(root);
    const printed: string[] = [];
    const ctx = { print: (s: { text: string }[]) => printed.push(s.map((x) => x.text).join('')), glyphs: glyphSet(true), workspace: ws } as unknown as ReplContext;
    expect(await runSlash('/mcp call echo-fixture echo {"text": "Workers KV \\"eventual\\" consistency"}', ctx)).toBe('handled');
    let out = printed.join('\n');
    expect(out).toMatch(/echo on echo-fixture via mcporter · answered · \d+ ms · \d+ bytes/);
    expect(out).toContain('echo: Workers KV "eventual" consistency');
    expect(out).not.toMatch(/arguments must be one JSON object/);
    const first = recordLine(out);
    expect(first).toMatch(/^\.timmy\/mcp\/m[0-9a-f]{8}\/call\.json$/);
    expect(json(root, first).arguments).toEqual({ text: 'Workers KV "eventual" consistency' });
    // Single quotes around the JSON still work, an apostrophe inside it included.
    printed.length = 0;
    await runSlash("/mcp call echo-fixture echo '{\"text\":\"it's single-quoted\"}'", ctx);
    out = printed.join('\n');
    expect(out).toContain("echo: it's single-quoted");
    expect(json(root, recordLine(out)).arguments).toEqual({ text: "it's single-quoted" });
    expect(sealed.map((r) => r.kind)).toEqual(['mcp.call', 'mcp.call']);
  }, LONG);

  it('a command line through the SDK route: JSON before -- <command>, and a bad JSON is refused before anything starts', async () => {
    const root = scratch();
    const { ws } = workspace(root);
    const out = text(await ws.mcp(`call --route sdk echo {"text": "a -- b", "n": 1} ${AT}`));
    expect(out).toMatch(/echo on \S+ mcp-echo-server\.mjs via sdk · answered/);
    expect(out).toContain('echo: a -- b');
    const refused = text(await ws.mcp(`call --route sdk echo {"text": "x" ${AT}`));
    expect(refused).toMatch(/the arguments are not valid JSON: /);
    expect(refused).toContain('e.g. /mcp call echo {"text":"hi there"} -- <command>');
    expect(calls(root)).toHaveLength(1);
  }, LONG);
});

describe("an error answer shows the server's own words", () => {
  it.each(['mcporter', 'sdk'] as const)('%s: isError is failed, with "the server said:" and its text, never only an exit code', async (route) => {
    const root = scratch();
    const s = sealer();
    const out = (await mcpView(`call --route ${route} fail {} ${AT}`, { cwd: root, record: { root, seal: s.seal } })).join('\n');
    expect(out).toMatch(new RegExp(`^fail on \\S+ mcp-echo-server\\.mjs via ${route} · failed · \\d+ ms`));
    expect(out).toContain('  the server said:');
    expect(out).toContain(FIXTURE_ERROR.slice(0, 40));
    expect(out).not.toMatch(/exited 1/);
    const r = await callTool(route, SERVER, 'fail', {}, { timeoutMs: 30_000 });
    expect(r).toMatchObject({ ok: false, isError: true });
    expect(r.error).toBe(`the server said: ${FIXTURE_ERROR}`);
    const rec = json(root, recordLine(out));
    expect(rec).toMatchObject({ outcome: 'failed', isError: true, called: true, error: `the server said: ${FIXTURE_ERROR}` });
    expect(s.sealed[0]).toMatchObject({ kind: 'mcp.call', status: 'failed' });
    // The receipt binds the server's words through call.json's sha256; it never holds them.
    expect(JSON.stringify(s.sealed[0])).not.toContain('No editor is connected');
  }, LONG);

  it("mcporter: an error answer whose text is JSON is still the server's own (MCPorter prints the JSON and exits 1)", async () => {
    const root = scratch();
    const out = (await mcpView(`call --route mcporter fail '{"json":true}' ${AT}`, { cwd: root, record: { root } })).join('\n');
    expect(out).toContain('the server said:');
    expect(out).toContain('"error": "no editor"');
    const rec = json(root, recordLine(out));
    expect(rec.isError).toBe(true);
    expect((rec.notes as string[]).join(' ')).toMatch(/isError is told by MCPorter's exit 1/);
  }, LONG);
});

describe('a readable answer', () => {
  it('text: the first 20 lines, wrapped, then how many more and where the whole answer is kept', async () => {
    const root = scratch();
    const out = await mcpView(`call --route sdk lines {"count": 60} ${AT}`, { cwd: root, record: { root }, columns: 80 });
    expect(out.filter((l) => /^ {2}line \d+ of 60$/.test(l))).toHaveLength(20);
    expect(out).toContain('  line 20 of 60');
    expect(out).not.toContain('  line 21 of 60');
    const id = calls(root)[0];
    expect(out).toContain(`  … 40 more lines: the whole answer is in .timmy/mcp/${id}/output.json`);
    // A long line wraps to the width, never cut off.
    const wrapped = fitLines([`  ${'word '.repeat(40).trim()}`], 30, 20);
    expect(wrapped.shown.length).toBeGreaterThan(5);
    for (const l of wrapped.shown) expect(l.length).toBeLessThanOrEqual(30);
    expect(wrapped.shown.join(' ').replace(/\s+/g, ' ').trim()).toBe('word '.repeat(40).trim());
    expect(wrapped.shown.every((l) => l.startsWith('  '))).toBe(true);
    expect(fitLines(['a'.repeat(100), 'b', 'c'], 20, 3)).toEqual({ shown: ['a'.repeat(20), 'a'.repeat(20), 'a'.repeat(20)], left: 'the rest of that line and 2 more lines' });
  }, LONG);

  it('JSON text is pretty-printed; on MCPorter its JSON output is said to be its own extraction', async () => {
    const root = scratch();
    const sdk = await mcpView(`call --route sdk json {"query":"kv"} ${AT}`, { cwd: root });
    expect(sdk).toContain('    "query": "kv",');
    expect(sdk).toContain('        "title": "First result",');
    const mcporter = await mcpView(`call --route mcporter json {"query":"kv"} ${AT}`, { cwd: root });
    expect(mcporter).toContain('    "query": "kv",');
    expect(mcporter.join('\n')).toMatch(/\(MCPorter's JSON output: the answer's structuredContent, or its text read as JSON/);
  }, LONG);

  it('images and resources are named by type and size, never dumped; structuredContent is noted', async () => {
    const out = (await mcpView(`call --route sdk mixed ${AT}`, { cwd: scratch() })).join('\n');
    expect(out).toContain('  two more items follow');
    expect(out).toContain('  [image · image/png · 300 B]');
    expect(out).toMatch(/\[resource · file:\/\/\/fixture\/notes\.txt · text\/plain · text, 28 B\]/);
    expect(out).toContain('(it also carries structuredContent (an object with 2 keys); output.json keeps it)');
    expect(out).not.toContain('BwcHBwcH');
    expect(out).not.toContain('the resource body, not shown');
    const via = (await mcpView(`call --route mcporter mixed ${AT}`, { cwd: scratch() })).join('\n');
    expect(via).toContain('"count": 2');
    expect(via).toMatch(/MCPorter does not print the content items then/);
  }, LONG);

  it("a server's text loses terminal escapes and control characters; every content type is named", () => {
    expect(cleanText('\x1b[31mred\x1b[0m\x07 and\ttab\r\nnext')).toBe('red and  tab\nnext');
    const a = readRouteAnswer(JSON.stringify({ content: [
      { type: 'text', text: '\x1b]8;;https://x.example/\x1b\\link\x1b]8;;\x1b\\ text' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'file:///a.txt', name: 'a' },
      { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAAAAAA' } },
      { type: 'something_new' },
    ] }), 'mcporter');
    expect(answerLines(a, 'mcporter').lines).toEqual(['link text', '[audio · audio/wav · 3 B]', '[resource link · file:///a.txt · a]', '[resource · file:///b.bin · binary, 6 B]', '[something_new item]']);
  });
});

describe('the record and its receipt', () => {
  it('call.json (timmy.mcp-call/1) and output.json, mode 0600, and an mcp.call receipt binding both sha256s', async () => {
    const root = scratch();
    const s = sealer();
    const { run, record } = await callAndRecord('sdk', SERVER, 'echo', { text: 'kept' }, { cwd: root, timeoutMs: 30_000 }, { root, project: 'demo', seal: s.seal });
    expect(run.answer).toMatchObject({ ok: true, text: 'echo: kept' });
    expect(record?.ok).toBe(true);
    if (!record?.ok) return;
    const id = record.id;
    expect(id).toMatch(MCP_CALL_ID);
    expect(record.call).toBe(`.timmy/mcp/${id}/call.json`);
    expect(record.output).toBe(`.timmy/mcp/${id}/output.json`);
    const callBytes = readFileSync(join(root, record.call));
    const outBytes = readFileSync(join(root, record.output!));
    const rec = JSON.parse(callBytes.toString('utf8')) as Record<string, unknown>;
    expect(rec).toMatchObject({
      schema: MCP_CALL_SCHEMA, id, server: `${NODE.split(/[\\/]/).pop()} mcp-echo-server.mjs`, route: 'sdk', transport: 'stdio', tool: 'echo', arguments: { text: 'kept' },
      outcome: 'answered', called: true, isError: false, output_file: 'output.json', output_bytes: outBytes.length, truncated: false,
      output_sha256: sha256(outBytes), kept_bytes: outBytes.length, kept_sha256: sha256(outBytes),
      annotations: { readOnlyHint: true, openWorldHint: false }, project: 'demo', project_id: projectId(root),
    });
    expect(rec.url).toBeUndefined();
    expect(Date.parse(String(rec.ended_at))).toBeGreaterThanOrEqual(Date.parse(String(rec.started_at)));
    expect(rec.ms).toBeGreaterThan(0);
    // output.json is what the route printed, byte for byte: Timmy's SDK command's JSON line.
    expect(JSON.parse(outBytes.toString('utf8'))).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'echo: kept' }] } });
    expect(mode(join(root, record.output!))).toBe(0o600);
    expect(mode(join(root, record.call))).toBe(0o600);
    // The receipt: call.json's sha256 and the output's, never the arguments or the answer.
    expect(s.sealed).toHaveLength(1);
    const r = s.sealed[0];
    expect(r).toMatchObject({ kind: 'mcp.call', status: 'ok', policy: 'human-gated', project: 'demo', project_id: projectId(root), output_sha256: sha256(outBytes) });
    expect(r.outputs).toEqual([{ path: record.call, sha256: sha256(callBytes), bytes: callBytes.length }, { path: record.output, sha256: sha256(outBytes), bytes: outBytes.length }]);
    expect(record.receipt).toBe(s.chain()[0].hash.slice(7, 15));
    expect(JSON.stringify(r)).not.toMatch(/echo: kept|"text"/);
  }, LONG);

  it('an output over the cap: output.json keeps its first 32 KB, truncated says so, output_sha256 is of every byte printed', async () => {
    const root = scratch();
    const { record } = await callAndRecord('sdk', SERVER, 'big', { size: 100_000 }, { cwd: root, timeoutMs: 30_000 }, { root });
    expect(record?.ok).toBe(true);
    if (!record?.ok) return;
    const rec = json(root, record.call);
    // What Timmy's SDK command prints for this call, rebuilt independently (src/connectors/mcp-sdk-cli.ts `say`).
    const printed = `${JSON.stringify({ ok: true, server: { name: 'echo-fixture', version: '1.0.0' }, result: { content: [{ type: 'text', text: 'x'.repeat(100_000) }] }, tool: { name: 'big' } })}\n`;
    const kept = readFileSync(join(root, record.output!));
    expect(kept.length).toBe(32 * 1024);
    expect(kept.equals(Buffer.from(printed).subarray(0, 32 * 1024))).toBe(true);
    expect(rec).toMatchObject({ truncated: true, output_bytes: Buffer.byteLength(printed), output_sha256: sha256(printed), kept_bytes: 32 * 1024, kept_sha256: sha256(kept) });
  }, LONG);

  it('a record that cannot be written is said, and its receipt is still sealed with why', () => {
    const root = scratch();
    mkdirSync(join(root, '.timmy'));
    writeFileSync(join(root, '.timmy', 'mcp'), 'a file in the way');
    const s = sealer();
    const facts: McpCallFacts = {
      route: 'sdk', server: { name: 'node server.mjs', transport: 'stdio' }, tool: 'echo', args: { text: 'x' }, startedAt: '2026-10-09T09:00:00.000Z', endedAt: '2026-10-09T09:00:01.000Z',
      ms: 1000, outcome: 'answered', called: true, isError: false, output: { bytes: 2, sha256: sha256('{}'), kept: Buffer.from('{}'), truncated: false }, annotations: null, notes: [],
    };
    const w = writeMcpCall({ root, seal: s.seal }, facts);
    expect(w.ok).toBe(false);
    expect((w as { error: string }).error).toMatch(/^(ENOTDIR|EEXIST) in \.timmy\/mcp$/);
    expect(w.receipt).toBeTruthy();
    expect(s.sealed[0].discrepancies?.[0]).toMatch(/^the record could not be written: /);
    expect(s.sealed[0].output_sha256).toBe(sha256('{}'));
    expect(JSON.stringify(s.sealed[0])).not.toContain(root);
  });
});

describe('the board: MCP calls as result cards', () => {
  it('the snapshot and the live board show each call, its outcome, ms, record and raw output, its first lines, all escaped', async () => {
    const root = scratch();
    const { ws } = workspace(root);
    const said = '<script>alert(1)</script> & "quoted"';
    const out = text(await ws.mcp(`call --route sdk echo ${JSON.stringify({ text: said })} ${AT}`));
    expect(out).toContain(`echo: ${said}`);
    const failed = text(await ws.mcp(`call --route sdk fail {} ${AT}`));
    expect(failed).toContain('the server said:');
    const [first, second] = calls(root);
    const lines = text(ws.board(''));
    expect(lines).toContain('.timmy/board/index.html');
    const html = readFileSync(join(root, '.timmy', 'board', 'index.html'), 'utf8');
    expect(html).toContain('class="card result result-mcp"');
    expect(html).toMatch(/echo on \S+ mcp-echo-server\.mjs/);
    expect(html).toContain('<strong>answered</strong>');
    expect(html).toMatch(/via sdk · stdio · \d+ ms · \d+ bytes/);
    expect(html).toContain(`href="../../.timmy/mcp/${first}/call.json"`);
    expect(html).toContain(`href="../../.timmy/mcp/${first}/output.json"`);
    expect(html).toContain('the answer begins:');
    expect(html).toContain('echo: &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toMatch(/its record was sealed by receipt [0-9a-f]{8}/);
    expect(html).toContain('the server&#39;s hints: read-only, closed world (its claim)');
    // The error answer's card: failed, the server's words.
    expect(html).toContain('<strong>failed</strong> the server answered with its own error (isError)');
    expect(html).toContain(`href="../../.timmy/mcp/${second}/call.json"`);
    expect(html).toContain(FIXTURE_ERROR.replace(/'/g, '&#39;'));
    // The live board: the same cards, files as text (it serves no files).
    await ws.boardLive('live');
    const lb = ws.liveBoard!;
    const token = lb.url.split('#t=')[1];
    const state = await new Promise<string>((ok, bad) => {
      const req = request({ host: '127.0.0.1', port: lb.port, path: '/state', headers: { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${lb.port}` }, setHost: false, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', bad);
      req.end();
    });
    const liveHtml = (JSON.parse(state) as { html: string }).html;
    expect(liveHtml).toContain('result-mcp');
    expect(liveHtml).toContain(`<span class="file">.timmy/mcp/${first}/output.json</span>`);
    expect(liveHtml).toContain('echo: &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(liveHtml).not.toContain('<script>alert(1)');
  }, LONG);

  it('a record changed after its receipt is not verified; an output.json changed after it is said', () => {
    const root = scratch();
    const s = sealer();
    const facts: McpCallFacts = {
      route: 'mcporter', server: { name: 'docs', transport: 'http', url: 'https://docs.example.invalid/mcp' }, tool: 'search', args: { query: 'kv' }, startedAt: '2026-10-09T09:00:00.000Z',
      endedAt: '2026-10-09T09:00:01.000Z', ms: 950, outcome: 'needs authorization', called: false, isError: null, error: 'needs authorization: MCPorter says run "mcporter auth docs"',
      annotations: null, notes: [],
    };
    const w = writeMcpCall({ root, seal: s.seal }, facts);
    expect(w.ok).toBe(true);
    let cards = mcpResults(root, s.chain(), (t) => t);
    expect(cards[0]).toMatchObject({ kind: 'mcp', title: 'search on docs', status: { word: 'needs authorization', tone: 'attention' } });
    expect(cards[0].status.detail).toMatch(/needs authorization: MCPorter says run "mcporter auth docs"; its record was sealed by receipt/);
    expect(cards[0].lines?.[0]).toBe('via mcporter · http https://docs.example.invalid/mcp · 950 ms · 0 bytes');
    expect(cards[0].files).toEqual([{ rel: (w as { call: string }).call, note: 'the record' }]);
    writeFileSync(join(root, (w as { call: string }).call), readFileSync(join(root, (w as { call: string }).call), 'utf8').replace('"ms": 950', '"ms": 951'));
    cards = mcpResults(root, s.chain(), (t) => t);
    expect(cards[0].status.detail).toMatch(/its record is not verified: call\.json changed after its receipt sealed it/);
    expect(cards[0].receipts).toBeUndefined();
    const html = renderResultCards(cards, kit({ live: false, base: '../../' }));
    expect(html).toContain('needs authorization: MCPorter says run &quot;mcporter auth docs&quot;');
    expect(readMcpCalls(root, s.chain()).list).toHaveLength(1);
  });

  it("a JSON answer keeps its indent on the card (non-breaking spaces), and the record's notes are shown", () => {
    const root = scratch();
    const printed = `${JSON.stringify({ ok: true, server: { name: 'x', version: '1' }, result: { content: [{ type: 'text', text: JSON.stringify({ query: 'kv', results: [1, 2] }) }] } })}\n`;
    const facts: McpCallFacts = {
      route: 'sdk', server: { name: 'node server.mjs', transport: 'stdio' }, tool: 'json', args: { query: 'kv' }, startedAt: '2026-10-09T09:00:00.000Z', endedAt: '2026-10-09T09:00:01.000Z',
      ms: 10, outcome: 'answered', called: true, isError: false, output: { bytes: Buffer.byteLength(printed), sha256: sha256(printed), kept: Buffer.from(printed), truncated: false },
      annotations: {}, annotationsNote: 'the server lists this tool without annotations', notes: ['a note from the route'],
    };
    expect(writeMcpCall({ root }, facts).ok).toBe(true);
    const [card] = mcpResults(root, [], (t) => t);
    expect(card.lines).toEqual(expect.arrayContaining(['the answer begins:', '{', '  "query": "kv",', '  "results": [', 'note: a note from the route']));
    expect(card.status.detail).toBe('its record is not verified: no mcp.call receipt of this project names this record');
    expect(card.files?.map((f) => f.note)).toEqual(['the record', 'the raw output']);
  });
});

/** A made-up URL with a user name and a password set on it (written out, user:password@host reads as an address). */
const withUserinfo = (url: string): string => { const u = new URL(url); u.username = 'someone'; u.password = 'hunter22'; return u.href; };

describe('safe server URLs', () => {
  it('scheme://host[:port] and plain or vN path segments are kept; ids, keys, userinfo, query and fragment never', () => {
    expect(safeServerUrl('https://gateway.example.com/mcp/gateways/sk/usergw-0a1b2c3d4e5f60718293a4b5c6d7e8f9/mcp')).toBe('https://gateway.example.com/mcp/gateways/sk/…/mcp');
    expect(safeServerUrl('https://mcp.example.org/accounts/acct42/mcp')).toBe('https://mcp.example.org/accounts/…/mcp');
    expect(safeServerUrl('https://mcp.example.org/u/aVeryLongAccountNameOverTheLimit/mcp')).toBe('https://mcp.example.org/u/…/mcp');
    expect(new URL(withUserinfo('https://mcp.example.net:8443/v1/sse')).password).toBe('hunter22');
    expect(safeServerUrl(withUserinfo('https://mcp.example.net:8443/v1/sse?token=abc123#frag'))).toBe('https://mcp.example.net:8443/v1/sse');
    expect(safeServerUrl('https://docs.example.invalid/mcp')).toBe('https://docs.example.invalid/mcp');
    expect(safeServerUrl('https://docs.example.invalid/mcp/')).toBe('https://docs.example.invalid/mcp/');
    expect(safeServerUrl('https://docs.example.invalid')).toBe('https://docs.example.invalid/');
    expect(safeServerUrl('http://127.0.0.1:3000/mcp')).toBe('http://127.0.0.1:3000/mcp');
    expect(safeServerUrl('https://x.example.invalid/v2/tools.list/server_one')).toBe('https://x.example.invalid/v2/tools.list/server_one');
    expect(safeServerUrl('https://x.example.invalid/v2beta/a%20b/1234')).toBe('https://x.example.invalid/…/…/…');
    expect(safeServerUrl('wss://x.example.invalid/socket')).toBe('wss://x.example.invalid/socket');
    expect(safeServerUrl('not a url')).toBe('(not a valid address)');
    expect(scrubUrls('HTTP 401 from https://gw.example.invalid/mcp/gateways/sk/usergw-0a1b2c3d/mcp?key=s3cr3t, retry')).toBe('HTTP 401 from https://gw.example.invalid/mcp/gateways/sk/…/mcp retry');
  });

  it("a configured URL's private parts are found, and replaced wherever a route echoes them", () => {
    const parts = urlSecrets(withUserinfo('https://gw.example.invalid/mcp/gateways/sk/usergw-0a1b2c3d4e5f6071/acct42/mcp?key=s3cr3tvalue&n=1'));
    expect(parts).toEqual(expect.arrayContaining(['usergw-0a1b2c3d4e5f6071', 's3cr3tvalue', 'hunter22', 'someone']));
    expect(parts).not.toContain('acct42'); // shorter than 8: hidden in a shown URL, too common to look for in an answer
    expect(parts).not.toContain('gateways');
    expect(redactParts('error at /mcp/gateways/sk/usergw-0a1b2c3d4e5f6071/mcp (key s3cr3tvalue)', parts)).toEqual({ text: 'error at /mcp/gateways/sk/…/mcp (key …)', count: 2 });
  });

  it('/mcp servers shows a gateway key or an account in a URL path only in its safe form', async () => {
    const KEY = 'usergw-0a1b2c3d4e5f60718293a4b5c6d7e8f9';
    const { root, env } = configured({
      gateway: { url: `https://gateway.example.invalid/mcp/gateways/sk/${KEY}/mcp`, headers: { Authorization: 'Bearer sk-not-a-real-key' } },
      account: { url: 'https://mcp.example.invalid/users/someone42/sse?token=t0k3nvalue' },
    });
    const r = await listServers('mcporter', { cwd: root, env, timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.servers.map((s) => [s.name, s]));
    expect(by.gateway.url).toBe('https://gateway.example.invalid/mcp/gateways/sk/…/mcp');
    expect(by.account.url).toBe('https://mcp.example.invalid/users/…/sse');
    const view = (await mcpView('servers', { cwd: root, env, timeoutMs: 30_000 })).join('\n');
    expect(view).toContain('https://gateway.example.invalid/mcp/gateways/sk/…/mcp');
    for (const secret of [KEY, 'someone42', 't0k3nvalue', 'sk-not-a-real-key']) {
      expect(view).not.toContain(secret);
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  }, LONG);

  describe('a named HTTP server that wants a sign-in, its URL holding a gateway key', () => {
    let http401: Server;
    let port = 0;
    beforeAll(async () => {
      http401 = createServer((req, res) => { req.resume(); res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="fixture"', 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); });
      await new Promise<void>((r) => http401.listen(0, '127.0.0.1', () => r()));
      port = (http401.address() as { port: number }).port;
    });
    afterAll(async () => { await new Promise<void>((r) => http401.close(() => r())); });

    it('its record keeps the safe URL only; nothing written or printed holds the key', async () => {
      const KEY = 'usergw-feedfacecafe0123456789abcdef';
      const { root, home } = configured({ gw: { url: `http://127.0.0.1:${port}/mcp/gateways/sk/${KEY}/mcp`, auth: 'oauth' } });
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      const { ws, sealed } = workspace(root);
      const out = text(await ws.mcp('call gw search {"query":"kv"}'));
      expect(out).toMatch(/search on gw via mcporter · needs authorization/);
      const rel = recordLine(out);
      const rec = json(root, rel);
      expect(rec).toMatchObject({ server: 'gw', transport: 'http', url: `http://127.0.0.1:${port}/mcp/gateways/sk/…/mcp`, outcome: 'needs authorization', called: false, output_file: null });
      const dir = join(root, '.timmy', 'mcp');
      const written = readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).map((f) => readFileSync(join(dir, d, f), 'utf8'))).join('\n');
      for (const t of [written, out, JSON.stringify(sealed)]) expect(t).not.toContain(KEY);
    }, LONG);
  });
});

describe("the server's own hints (annotations)", () => {
  it('/mcp tools through the SDK route shows them, labelled as the server\'s claim; a tool with none shows none', async () => {
    const out = await mcpView(`tools --route sdk ${AT}`, { cwd: scratch() });
    expect(out.find((l) => l.startsWith('  echo('))).toBe('  echo(text)  [read-only, closed world, per the server]  Say the text back');
    expect(out.find((l) => l.startsWith('  add('))).toBe('  add(a, b)  [read-only, idempotent, closed world, per the server]  Add two numbers');
    expect(out.find((l) => l.startsWith('  fail('))).toContain('[not read-only, destructive, not idempotent, open world, per the server]');
    expect(out.find((l) => l.startsWith('  big('))).toBe('  big(size)  Answer with a long text');
    expect(hintWords({ readOnlyHint: true, title: 'x' })).toBe('read-only');
    expect(hintWords(undefined)).toBe('');
  }, LONG);

  it('MCPorter 0.12.4 drops them from its list: none are shown there, and that is said', async () => {
    const sdk = await listTools('sdk', SERVER, { timeoutMs: 30_000 });
    expect(sdk.tools.find((t) => t.name === 'echo')?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(sdk.tools.find((t) => t.name === 'big')?.annotations).toBeUndefined();
    // The same fixture, listed through MCPorter: it sent the annotations, and they do not come through.
    const mcporter = await listTools('mcporter', SERVER, { timeoutMs: 30_000 });
    expect(mcporter.ok).toBe(true);
    for (const t of mcporter.tools) expect(t.annotations).toBeUndefined();
    const out = (await mcpView(`tools --route mcporter ${AT}`, { cwd: scratch() })).join('\n');
    expect(out).not.toContain('per the server]');
    expect(out).toContain("the server's own hints (read-only, destructive, …) are not shown: MCPorter 0.12.4 drops them from its list");
  }, LONG);
});

describe('the agent tool keeps the same record', () => {
  it("call_mcp_tool writes call.json and output.json in the project and seals an mcp.call receipt on the runs chain", async () => {
    const { root, env } = configured();
    const agent = createMcpTools({ cwd: () => root, env: () => env, project: () => 'demo' }).find((t) => t.function.name === 'call_mcp_tool')!;
    const call = (agent.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
    // The default seal is the REPL's own (appendReceipt with no folder): its key and caches go under the process's
    // folder, so this test runs from a scratch one (the chain itself is this test's TIMMY_STORE).
    const was = process.cwd();
    process.chdir(scratch('mcprec-cwd-'));
    let r: Record<string, unknown>;
    try { r = await call({ server: 'echo-fixture', tool: 'echo', args: { text: 'from the agent' } }); } finally { process.chdir(was); }
    expect(r).toMatchObject({ ok: true, route: 'mcporter', text: 'echo: from the agent' });
    expect(String(r.record)).toMatch(/^\.timmy\/mcp\/m[0-9a-f]{8}\/call\.json$/);
    expect(String(r.output)).toBe(String(r.record).replace('call.json', 'output.json'));
    const rec = json(root, String(r.record));
    expect(rec).toMatchObject({ schema: MCP_CALL_SCHEMA, server: 'echo-fixture', route: 'mcporter', transport: 'stdio', tool: 'echo', arguments: { text: 'from the agent' }, outcome: 'answered', isError: false, annotations: null, project: 'demo' });
    expect(String(rec.annotations_note)).toMatch(/MCPorter 0\.12\.4 drops the server's tool annotations/);
    // Sealed through appendReceipt (the REPL's own seal) on this test's runs chain, binding call.json's bytes.
    const chain = readChain('runs');
    const sealed = chain.find((x) => x.kind === 'mcp.call');
    expect(sealed?.outputs?.[0]).toEqual({ path: r.record, sha256: sha256(readFileSync(join(root, String(r.record)))), bytes: statSync(join(root, String(r.record))).size });
    expect(sealed?.hash.slice(7, 15)).toBe(r.receipt);
    expect(verifyChain('runs').ok).toBe(true);
    // The REPL's /mcp call keeps a record of the same shape.
    const view = await mcpView('call echo-fixture echo {"text":"from the REPL"}', { cwd: root, env, record: { root, project: 'demo' } });
    const repl = json(root, recordLine(view.join('\n')));
    expect(Object.keys(repl).sort()).toEqual(Object.keys(rec).sort());
    // An error answer through the agent: failed, isError, the server's words (sealed here by a seal of the test's own).
    const own = sealer();
    const fails = createMcpTools({ cwd: () => root, env: () => env, seal: own.seal }).find((t) => t.function.name === 'call_mcp_tool')!;
    const failed = await (fails.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute({ server: 'echo-fixture', tool: 'fail', args: {} });
    expect(failed).toMatchObject({ ok: false, isError: true, error: `the server said: ${FIXTURE_ERROR}` });
    expect(json(root, String(failed.record))).toMatchObject({ outcome: 'failed', isError: true });
    expect(existsSync(join(root, String(failed.output)))).toBe(true);
    expect(own.sealed.map((x) => [x.kind, x.status])).toEqual([['mcp.call', 'failed']]);
  }, LONG);
});
