/**
 * R6 (H142): the Tools & MCP panel's routes (src/companion/panels/tools.ts over src/mcp/inspector.ts), over real HTTP on
 * 127.0.0.1, with real calls through both MCP-to-CLI routes to a real stdio MCP server process.
 *
 * Real: the companion server and its token check, both routes (Timmy's SDK command line and MCPorter's CLI), the wire tap,
 * the record writer and the receipt chain (the project's own store), the MCP SDK's schema validator, MCPorter's own
 * `config add` (with --dry-run: it writes nothing). FAKE, labelled: the server itself (src/mcp/fake-fixture-server.ts, Timmy's
 * FAKE fixture: every answer made up), a typed command line's program (a FAKE script that would leave a marker file if it were
 * ever started), the project (a folder of this test's), MCPorter's home (an empty folder of this test's, so no config of this
 * computer's is read). No network but 127.0.0.1. Each refused call is checked to have reached nothing: no record folder
 * appears, and the fixture's own call log (TIMMY_FAKE_MCP_CALL_LOG puts it on the fixture's command line) gains no line.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { mcpRoutes } from '../src/connectors/mcp-cli.js';
import { fixtureServer, FROM_PAGE, TYPED_WHY } from '../src/mcp/inspector.js';
import { readChain, verifyReceiptIn } from '../src/utils/receipts.js';

const LONG = 120_000;
type Json = Record<string, any>;

describe('the Tools & MCP panel\'s routes: servers, tools, the schema check, calls through both routes, NEEDS YOU (R6 H142)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let root = '';
  let callLog = '';
  let companion: CompanionServer;
  let base = '';
  let token = '';
  let fixtureCommand: string[] = [];
  let env: Record<string, string> = {};

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r6-tools-api-'));
    root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    callLog = join(box, 'fixture-calls.log');
    writeFileSync(callLog, '');
    // the companion's environment names the fixture's call log, so its command line carries it (the routes hand a server a
    // small base environment only): the page names the fixture as { kind: 'fixture' }, never as a command line
    env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_MCP_HOME: join(box, 'mcp-home'), TIMMY_FAKE_MCP_CALL_LOG: callLog };
    const fx = fixtureServer(env);
    if (!fx.ok) throw new Error(fx.why);
    fixtureCommand = fx.command;
    expect(fixtureCommand.slice(-2)).toEqual(['--call-log', callLog]);
    // a configured server in the project's own MCPorter config: the same FAKE fixture, by name
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'mcporter.json'), JSON.stringify({ mcpServers: { 'fake-configured': { command: fx.command[0], args: fx.command.slice(1), description: 'FAKE: the fixture, configured' } } }, null, 2));
    mkdirSync(env.TIMMY_MCP_HOME, { recursive: true });
    process.env.TIMMY_HOME = env.TIMMY_HOME;
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env, shareMs: 0 } });
    base = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, LONG);
  // the calls of one test are read back in the next: the project's own store, not the per-test one (tests/isolation-setup.ts)
  beforeEach(() => { delete process.env.TIMMY_STORE; });
  afterAll(async () => {
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  const get = async (path: string, t: string | null = token): Promise<{ status: number; body: Json }> => {
    const r = await fetch(`${base}/api/panel/tools/${path}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    return { status: r.status, body: (await r.json().catch(async () => ({ text: await r.text() }))) as Json };
  };
  const post = async (path: string, body: unknown, t: string | null = token): Promise<{ status: number; body: Json }> => {
    const r = await fetch(`${base}/api/panel/tools/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
  };
  const records = (): string[] => (existsSync(join(root, '.timmy', 'mcp')) ? readdirSync(join(root, '.timmy', 'mcp')).filter((n) => /^m[0-9a-f]{8}$/.test(n)).sort() : []);
  const logged = (): string[] => readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  /** Timmy's FAKE fixture, as the page names it (its command line, with the call log, is the companion's) */
  const server = (): Json => ({ kind: 'fixture' });

  it('every route refuses a request without the companion\'s token, or with another, and reads or runs nothing', async () => {
    const before = records();
    for (const t of [null, 'f'.repeat(64)]) {
      for (const p of ['state', 'servers', 'calls', 'call/m00000000']) {
        const r = await get(p, t);
        expect(r.status, p).toBe(401);
        expect(JSON.stringify(r.body), p).toMatch(/token/);
      }
      for (const p of ['list', 'check', 'call']) {
        const r = await post(p, { server: server(), route: 'sdk', tool: 'fake_echo', args: { text: 'FAKE' } }, t);
        expect(r.status, p).toBe(401);
      }
    }
    expect(records()).toEqual(before);
    expect(logged()).toEqual([]);
  });

  it('state: both routes with their rungs, Timmy\'s FAKE fixture, the four ingest modes as they are here, the page\'s rule, no call yet', async () => {
    const r = await get('state');
    expect(r.status).toBe(200);
    const s = r.body;
    expect(s.routes.map((x: Json) => [x.id, x.rung])).toEqual([['sdk', 'installed'], ['mcporter', 'installed']]);
    expect(s.routes[0].details).toMatch(/@modelcontextprotocol\/sdk \d/);
    expect(s.routes[1].details).toMatch(/mcporter 0\.12\.4/);
    expect(s.fixture.ok).toBe(true);
    expect(s.fixture.label).toMatch(/^FAKE · timmy-fake-fixture/);
    expect(s.modes.map((m: Json) => [m.id, m.state])).toEqual([['stdio', 'works'], ['http', 'works'], ['apisnip', 'not in Timmy'], ['clyanything', 'not in Timmy']]);
    expect(s.modes[1].words).toMatch(/through the mcporter route/);
    expect(s.modes[1].words).toMatch(/SDK route runs stdio servers only/);
    expect(s.wire.find((w: Json) => w.id === 'wire-tap').state).toBe('works');
    expect(s.rule).toMatch(/read-only and closed-world/);
    expect(s.rule).toMatch(/This page starts only Timmy's FAKE fixture and the servers your own MCPorter config names.*A command line you typed runs only from Timmy's terminal\.$/);
    expect(s.calls).toEqual([]);
  });

  it('servers: the project\'s MCPorter config read from its file (nothing started)', async () => {
    const r = await get('servers');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const fake = r.body.servers.find((x: Json) => x.name === 'fake-configured');
    expect(fake).toMatchObject({ name: 'fake-configured', transport: 'stdio', origin: 'local', source: 'config/mcporter.json' });
    expect(r.body.note).toMatch(/no server was started or contacted/);
    expect(logged()).toEqual([]);
  }, LONG);

  it('list through the SDK route: a real tools/list, each tool with its schema, the server\'s own hints and the schema gate', async () => {
    const r = await post('list', { server: { kind: 'fixture' }, route: 'sdk' });
    expect(r.status).toBe(200);
    const l = r.body;
    expect(l.ok).toBe(true);
    expect(l.route).toBe('sdk');
    expect(l.server).toMatch(/^node fake-fixture-server\.(ts|js)$/);
    expect(l.tools.map((t: Json) => t.name)).toEqual(['fake_echo', 'fake_measure', 'fake_swatch', 'fake_fail', 'fake_write_note']);
    const echo = l.tools[0];
    expect(echo.inputSchema).toMatchObject({ type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 }, times: { type: 'integer', maximum: 3 } } });
    expect(echo.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(echo.hints).toBe('read-only, not destructive, idempotent, closed world');
    expect(l.tools[4].hints).toMatch(/^not read-only, destructive/);
    expect(l.gate).toEqual({ checked: 5, missing: 0, issues: [], collisions: [] });
    expect(l.started).toMatch(/the SDK route started node fake-fixture-server\.(ts|js) for the listing, and stopped it/);
    expect(l.hintsNote).toMatch(/its claim, not checked/);
    expect(logged()).toEqual([]); // a listing calls no tool
  }, LONG);

  it('list through the mcporter route: the same tools; the hints are said to be unknown there (MCPorter drops them)', async () => {
    const r = await post('list', { server: { kind: 'fixture' }, route: 'mcporter' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.tools.map((t: Json) => t.name)).toEqual(['fake_echo', 'fake_measure', 'fake_swatch', 'fake_fail', 'fake_write_note']);
    expect(r.body.tools[0].annotations).toBeNull();
    expect(r.body.tools[0].hints).toBe('not known on this route');
    expect(r.body.hintsNote).toMatch(/MCPorter 0\.12\.4 drops/);
    expect(r.body.tools[1].inputSchema.properties.unit.enum).toEqual(['mm', 'cm', 'in']);
  }, LONG);

  it('a server the user\'s own MCPorter config names still lists from the page, through mcporter (the SDK route takes command lines only)', async () => {
    const r = await post('list', { server: { kind: 'configured', name: 'fake-configured' }, route: 'mcporter' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, route: 'mcporter', server: 'fake-configured', transport: 'as configured' });
    expect(r.body.tools.map((t: Json) => t.name)).toEqual(['fake_echo', 'fake_measure', 'fake_swatch', 'fake_fail', 'fake_write_note']);
    expect(r.body.started).toBe('the mcporter route started the configured server fake-configured (or reached its address) for the listing, and stopped it');
    const sdk = await post('list', { server: { kind: 'configured', name: 'fake-configured' }, route: 'sdk' });
    expect(sdk.status).toBe(200);
    expect(sdk.body).toMatchObject({ ok: false, error: expect.stringMatching(/SDK route runs a server from its command line only/) });
    expect(logged()).toEqual([]);
  }, LONG);

  it('check: the arguments against the schema the listing gave, the exact request, the command lines for both routes', async () => {
    const listed = (await post('list', { server: server(), route: 'sdk' })).body;
    const echo = listed.tools.find((t: Json) => t.name === 'fake_echo');
    const bad = await post('check', { server: server(), route: 'sdk', tool: 'fake_echo', args: { text: '', times: 9, extra: true }, inputSchema: echo.inputSchema, annotations: echo.annotations });
    expect(bad.status).toBe(200);
    expect(bad.body.valid).toBe(false);
    expect(bad.body.errors).toEqual(expect.arrayContaining([
      { field: '(the arguments)', message: 'must NOT have additional properties: extra' },
      { field: 'text', message: 'must NOT have fewer than 1 characters' },
      { field: 'times', message: 'must be <= 3' },
    ]));
    const good = await post('check', { server: server(), route: 'sdk', tool: 'fake_echo', args: { text: 'hi there' }, inputSchema: echo.inputSchema, annotations: echo.annotations });
    expect(good.body.valid).toBe(true);
    expect(JSON.parse(good.body.request)).toEqual({ jsonrpc: '2.0', id: '(the route numbers it)', method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'hi there' } } });
    const cmd = fixtureCommand.join(' ');
    expect(good.body.cli.repl.sdk).toBe(`/mcp call --route sdk fake_echo {"text":"hi there"} -- ${cmd}`);
    expect(good.body.cli.repl.mcporter).toBe(`/mcp call --route mcporter fake_echo {"text":"hi there"} -- ${cmd}`);
    expect(good.body.cli.mcporter).toMatch(/^mcporter call --stdio node --stdio-arg .* --tool fake_echo --args '\{"text":"hi there"\}'$/);
    expect(good.body.cli.sdk).toMatch(/mcp-sdk-cli\.(ts|js) call fake_echo --args '\{"text":"hi there"\}' --json -- node /);
    expect(good.body.rule).toMatchObject({ runs: true });
    const note = listed.tools.find((t: Json) => t.name === 'fake_write_note');
    const asked = await post('check', { server: server(), route: 'mcporter', tool: 'fake_write_note', args: { note: 'FAKE' }, inputSchema: note.inputSchema, annotations: note.annotations });
    expect(asked.body.rule).toMatchObject({ runs: false, command: `/mcp call --route mcporter fake_write_note {"note":"FAKE"} -- ${cmd}` });
    expect(logged()).toEqual([]);
  }, LONG);

  it('a call through the SDK route: the answer, the exact request and response, the timing, the record and its receipt, verified', async () => {
    const before = records();
    const r = await post('call', { server: server(), route: 'sdk', tool: 'fake_echo', args: { text: 'FAKE hello', times: 2 } });
    expect(r.status).toBe(200);
    const c = r.body.call;
    expect(c).toMatchObject({ route: 'sdk', tool: 'fake_echo', outcome: 'answered', called: true, isError: false, args: { text: 'FAKE hello', times: 2 } });
    expect(c.server).toMatch(/^node fake-fixture-server\.(ts|js)$/);
    expect(c.answer.from).toBe('server');
    expect(c.answer.items).toEqual([{ type: 'text', text: 'FAKE echo: FAKE hello\nFAKE echo: FAKE hello' }]);
    // the request exactly as the SDK route's client sent it, through the wire tap (its id the route's own)
    expect(c.request.exact).toBe(true);
    expect(JSON.parse(c.request.text)).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'FAKE hello', times: 2 } } });
    expect(typeof JSON.parse(c.request.text).id).toBe('number');
    expect(JSON.parse(c.response).result.content[0].text).toMatch(/^FAKE echo: FAKE hello/);
    expect(c.ms).toBeGreaterThan(0);
    expect(c.wireView.spans.map((s: Json) => s.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
    for (const s of c.wireView.spans) expect(s.ms).toBeGreaterThanOrEqual(0);
    expect(c.printed).toMatch(/"ok":true/);
    expect(c.notes).toContain(FROM_PAGE);
    expect(c.fromPage).toBe(true);
    expect(c.outputCheck).toBe('matches');
    expect(c.wireCheck).toBe('matches');
    // the record, as /mcp call keeps it, with the wire trace beside it
    const after = records();
    expect(after.length).toBe(before.length + 1);
    expect(after).toContain(c.id);
    const rec = JSON.parse(readFileSync(join(root, '.timmy', 'mcp', c.id, 'call.json'), 'utf8'));
    expect(rec).toMatchObject({ schema: 'timmy.mcp-call/1', id: c.id, route: 'sdk', tool: 'fake_echo', outcome: 'answered', output_file: 'output.json', wire_file: 'wire.ndjson' });
    expect(existsSync(join(root, '.timmy', 'mcp', c.id, 'wire.ndjson'))).toBe(true);
    // its receipt: on the project's chain, verified there now by this test too
    expect(c.receipt).toMatchObject({ verified: true, sealsBytes: true });
    const chain = readChain('runs', root);
    const sealed = chain.find((x) => x.hash === c.receipt.hash)!;
    expect(sealed).toMatchObject({ kind: 'mcp.call', status: 'ok' });
    expect(sealed.outputs?.map((o) => o.path)).toEqual([`.timmy/mcp/${c.id}/call.json`, `.timmy/mcp/${c.id}/output.json`, `.timmy/mcp/${c.id}/wire.ndjson`]);
    expect(verifyReceiptIn(chain, c.receipt.hash).ok).toBe(true);
    expect(c.receipt.id).toBe(c.receipt.hash.slice(7, 15));
    expect(r.body.rule).toMatchObject({ runs: true });
    expect(logged()).toEqual(['fake_echo']);
  }, LONG);

  it('a call through the mcporter route: JSON drawn, MCPorter\'s own listing and its call both on the wire, its receipt verified', async () => {
    const r = await post('call', { server: server(), route: 'mcporter', tool: 'fake_measure', args: { width_mm: 120, height_mm: 80, unit: 'cm' } });
    expect(r.status).toBe(200);
    const c = r.body.call;
    expect(c).toMatchObject({ route: 'mcporter', tool: 'fake_measure', outcome: 'answered' });
    expect(c.answer.from).toBe('server');
    expect(c.answer.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'json', value: expect.objectContaining({ fake: true, unit: 'cm', area: 96, perimeter: 40 }) })]));
    // MCPorter checks the tool's exact name in its own tools/list before it calls: two sessions on the wire
    expect(c.wireView.sessions.length).toBe(2);
    expect(c.wireView.spans.map((s: Json) => s.method)).toEqual(['initialize', 'tools/list', 'initialize', 'tools/call']);
    expect(JSON.parse(c.request.text).params).toEqual({ name: 'fake_measure', arguments: { width_mm: 120, height_mm: 80, unit: 'cm' } });
    expect(c.receipt).toMatchObject({ verified: true });
    expect(verifyReceiptIn(readChain('runs', root), c.receipt.hash).ok).toBe(true);
    expect(logged()).toEqual(['fake_echo', 'fake_measure']);
  }, LONG);

  it('an image answer is carried to be drawn: a PNG from the server\'s own answer, with its size', async () => {
    const r = await post('call', { server: server(), route: 'sdk', tool: 'fake_swatch', args: { shade: 'amber', label: 'FAKE' } });
    expect(r.status).toBe(200);
    const img = r.body.call.answer.items.find((i: Json) => i.type === 'image');
    expect(img.mime).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(img.bytes).toBe(Buffer.from(img.data, 'base64').length);
    expect(logged()).toEqual(['fake_echo', 'fake_measure', 'fake_swatch']);
  }, LONG);

  it('a request that fails the tool\'s schema is refused before anything is sent: 422, no record, nothing reached the server', async () => {
    const before = records();
    const r = await post('call', { server: server(), route: 'sdk', tool: 'fake_measure', args: { width_mm: -1, unit: 'm' } });
    expect(r.status).toBe(422);
    expect(r.body.refused).toBe('schema');
    expect(r.body.words).toMatch(/^Not sent: .* nothing was called\.$/);
    expect(r.body.errors).toEqual(expect.arrayContaining([
      { field: '(the arguments)', message: "must have required property 'height_mm'" },
      { field: 'width_mm', message: 'must be > 0' },
      { field: 'unit', message: 'must be equal to one of the allowed values: "mm", "cm", "in"' },
    ]));
    expect(records()).toEqual(before);
    expect(logged()).toEqual(['fake_echo', 'fake_measure', 'fake_swatch']);
  }, LONG);

  it('a call that needs approval is refused without it: NEEDS YOU with the line to type in Timmy\'s terminal; nothing called, no record', async () => {
    const before = records();
    for (const route of ['sdk', 'mcporter']) {
      const r = await post('call', { server: server(), route, tool: 'fake_write_note', args: { note: 'FAKE note' } });
      expect(r.status, route).toBe(409);
      expect(r.body.refused).toBe('needs you');
      expect(r.body.rule.runs).toBe(false);
      expect(r.body.rule.why).toMatch(/does not list fake_write_note as read-only \(readOnlyHint: false, destructiveHint: true\)/);
      expect(r.body.rule.command).toBe(`/mcp call --route ${route} fake_write_note {"note":"FAKE note"} -- ${fixtureCommand.join(' ')}`);
      expect(r.body.words).toMatch(/^NEEDS YOU: .* Nothing was called\. In Timmy's terminal: \/mcp call --route /);
      expect(r.body.before).toBe("Its own list was read through the SDK route (the server started for that, and stopped); fake_write_note was not called, and no record was written.");
    }
    // a configured server: its hints are never known here (mcporter drops them), so even a read-only tool waits for you, and
    // nothing is started for it (not even its list)
    const conf = await post('call', { server: { kind: 'configured', name: 'fake-configured' }, route: 'mcporter', tool: 'fake_echo', args: { text: 'FAKE' } });
    expect(conf.status).toBe(409);
    expect(conf.body.rule.command).toBe('/mcp call fake-configured fake_echo {"text":"FAKE"}');
    expect(conf.body.rule.why).toMatch(/MCPorter 0\.12\.4 drops/);
    expect(conf.body.before).toBe('Nothing was started, and no record was written.');
    expect(conf.body.words).toMatch(/^NEEDS YOU: .* Nothing was started, and no record was written\. In Timmy's terminal: \/mcp call fake-configured fake_echo/);
    expect(records()).toEqual(before);
    expect(logged()).toEqual(['fake_echo', 'fake_measure', 'fake_swatch']);
  }, LONG);

  it('a command line typed on the page is never started from it: list, call and check answer with its lines for Timmy\'s terminal; nothing starts', async () => {
    const before = records();
    // a FAKE program that would leave a marker file the moment it started
    const marker = join(box, 'FAKE-typed-server-started.txt');
    const script = join(box, 'FAKE-typed-server.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'FAKE: started');\n`);
    const typed = `node ${script}`;
    for (const route of ['sdk', 'mcporter'] as const) {
      const l = await post('list', { server: { kind: 'stdio', command: typed }, route });
      expect(l.status, route).toBe(409);
      expect(l.body).toMatchObject({ ok: false, refused: 'needs you', route, server: 'node FAKE-typed-server.mjs', rule: { runs: false, why: TYPED_WHY } });
      expect(TYPED_WHY).toMatch(/^a command line you typed runs only from Timmy's terminal: /);
      // the exact line for Timmy's terminal (the REPL's /mcp tools), and the others
      expect(l.body.rule.command).toBe(`/mcp tools --route ${route} -- node ${script}`);
      expect(l.body.cli.repl).toEqual({ sdk: `/mcp tools --route sdk -- node ${script}`, mcporter: `/mcp tools --route mcporter -- node ${script}` });
      expect(l.body.cli.mcporter).toBe(`mcporter list --stdio node --stdio-arg ${script}`);
      expect(l.body.cli.sdk).toMatch(new RegExp(`mcp-sdk-cli\\.(ts|js) tools --json -- node ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      expect(l.body.cli.config).toBe(`mcporter config add fake-typed-server --command node -- ${script}`);
      expect(l.body.words).toBe(`NEEDS YOU: ${TYPED_WHY}. Nothing was started. In Timmy's terminal: /mcp tools --route ${route} -- node ${script}`);
      const c = await post('call', { server: { kind: 'stdio', command: typed }, route, tool: 'fake_echo', args: { text: 'FAKE' } });
      expect(c.status, route).toBe(409);
      expect(c.body).toMatchObject({ ok: false, refused: 'needs you', rule: { runs: false, why: TYPED_WHY, command: `/mcp call --route ${route} fake_echo {"text":"FAKE"} -- node ${script}` }, before: 'Nothing was started, and no record was written.' });
      // the form's check starts nothing either, and says the same rule
      const k = await post('check', { server: { kind: 'stdio', command: typed }, route, tool: 'fake_echo', args: { text: 'FAKE' }, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } });
      expect(k.status).toBe(200);
      expect(k.body).toMatchObject({ valid: true, rule: { runs: false, why: TYPED_WHY } });
    }
    // a malformed typed line is refused in words, as before (nothing to start either)
    expect((await post('list', { server: { kind: 'stdio', command: '--inspect' }, route: 'sdk' })).body.error).toMatch(/starts with the program/);
    // nothing started: a second for a started program to have written its marker
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(marker)).toBe(false);
    expect(records()).toEqual(before);
    expect(logged()).toEqual(['fake_echo', 'fake_measure', 'fake_swatch']);
    // the generated config line is MCPorter 0.12.4's own: run here with --dry-run (it writes nothing), it reads back the server
    const mcporter = mcpRoutes({ ...process.env, ...env }).find((x) => x.id === 'mcporter')!;
    const words = `mcporter config add fake-typed-server --command node -- ${script}`.split(' ');
    const dry = join(box, 'dry-run');
    mkdirSync(dry);
    const out = await promisify(execFile)(mcporter.argv![0], [...mcporter.argv!.slice(1), ...words.slice(1, 4), '--dry-run', ...words.slice(4)], { cwd: dry, env: { ...process.env, HOME: env.TIMMY_MCP_HOME }, timeout: 60_000 });
    expect(JSON.parse(out.stdout.slice(0, out.stdout.indexOf('(dry-run)')))).toEqual({ 'fake-typed-server': { command: 'node', args: [script] } });
    expect(out.stdout).toMatch(/\(dry-run\) No changes were written\./);
    expect(readdirSync(dry)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  }, LONG);

  it('a tool the server does not list is refused (404) with its own list; nothing called', async () => {
    const r = await post('call', { server: server(), route: 'sdk', tool: 'fake_nothing', args: {} });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no tool named "fake_nothing"/);
    expect(r.body.listed).toEqual(['fake_echo', 'fake_measure', 'fake_swatch', 'fake_fail', 'fake_write_note']);
    expect(logged()).toEqual(['fake_echo', 'fake_measure', 'fake_swatch']);
  }, LONG);

  it('the newest calls come back from the records, newest first, each viewable again with its receipt verified now', async () => {
    const r = await get('calls');
    expect(r.status).toBe(200);
    expect(r.body.calls.map((c: Json) => [c.tool, c.route, c.outcome, c.fromPage, c.wire, c.receipt?.verified])).toEqual([
      ['fake_swatch', 'sdk', 'answered', true, true, true],
      ['fake_measure', 'mcporter', 'answered', true, true, true],
      ['fake_echo', 'sdk', 'answered', true, true, true],
    ]);
    const again = await get(`call/${r.body.calls[2].id}`);
    expect(again.status).toBe(200);
    expect(again.body.call).toMatchObject({ id: r.body.calls[2].id, tool: 'fake_echo', receipt: { verified: true } });
    expect(again.body.call.answer.items[0].text).toMatch(/^FAKE echo: FAKE hello/);
    expect((await get('call/m00000000')).status).toBe(404);
    expect((await get('call/not-an-id')).status).toBe(404);
    const state = (await get('state')).body;
    expect(state.calls.length).toBe(3);
  });

  it('a malformed request is refused in words: no server, no route, no arguments object', async () => {
    expect((await post('list', { server: { kind: 'nothing' }, route: 'sdk' })).status).toBe(400);
    expect((await post('list', { server: { kind: 'fixture' }, route: 'pigeon' })).status).toBe(400);
    expect((await post('call', { server: { kind: 'fixture' }, route: 'sdk', tool: 'fake_echo', args: ['x'] })).status).toBe(400);
    expect((await post('call', { server: { kind: 'configured', name: 'fake-configured' }, route: 'sdk', tool: 'fake_echo', args: {} })).body.error).toMatch(/SDK route runs a server from its command line only/);
  });
});
