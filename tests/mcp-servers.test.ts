// R3 (MCP servers the operator configured): Timmy reaches the servers MCPorter already knows, by name:
// its own config (the project's config/mcporter.json, ~/.mcporter/mcporter.json) and editor imports
// (here a project .cursor/mcp.json and a home ~/.cursor/mcp.json). Everything runs in a temporary HOME
// and a temporary project; the only HTTP server is a local stand-in on 127.0.0.1 that answers 401.
// Nothing reaches the network, and no sign-in is ever started.
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, listServers, listTools, mcpView, shownConfigPath } from '../src/connectors/mcp-cli.js';
import { createMcpTools } from '../src/agent/mcp-tools.js';
import { appendReceipt, type ReceiptInput } from '../src/utils/receipts.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { convertZodToJsonSchema, validateToolInput } from '@openrouter/sdk/lib/tool-executor.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const LONG = 60_000;

const dirs: string[] = [];
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'mcpsrv-')); dirs.push(d); return d; };

const home = scratch();
const project = scratch();
const watchPid = join(scratch(), 'watch-me.pid');
const SECRETS = ['sk-cursor-secret', 'sk-home-secret', 'SOME_SECRET_VALUE', 'tok-in-query'];
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
const opts = { cwd: project, env, timeoutMs: 30_000 };

// The stand-in for a hosted server that wants a sign-in: every request gets 401, and every path is kept.
const requests: string[] = [];
let http401: Server;
let port = 0;

beforeAll(async () => {
  http401 = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="fixture"', 'content-type': 'application/json' });
    res.end('{"error":"unauthorized"}');
  });
  await new Promise<void>((r) => http401.listen(0, '127.0.0.1', () => r()));
  port = (http401.address() as { port: number }).port;

  mkdirSync(join(project, 'config'));
  writeFileSync(join(project, 'config', 'mcporter.json'), JSON.stringify({
    mcpServers: {
      'echo-local': { command: process.execPath, args: [FIXTURE], env: { FIXTURE_TOKEN: '${SOME_SECRET_VALUE}' } },
      'watch-me': { command: process.execPath, args: [FIXTURE], env: { ECHO_FIXTURE_PID_FILE: watchPid } },
      'remote-oauth': { url: `http://127.0.0.1:${port}/mcp?key=tok-in-query`, auth: 'oauth' },
      'remote-plain': { url: `http://127.0.0.1:${port}/plain` },
    },
  }));
  mkdirSync(join(project, '.cursor'));
  writeFileSync(join(project, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { 'cursor-echo': { command: process.execPath, args: [FIXTURE], env: { API_KEY: 'sk-cursor-secret' } } },
  }));
  mkdirSync(join(home, '.cursor'));
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { 'home-remote': { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer sk-home-secret' } } },
  }));
  mkdirSync(join(home, '.mcporter'));
  writeFileSync(join(home, '.mcporter', 'mcporter.json'), JSON.stringify({
    mcpServers: { 'home-echo': { command: process.execPath, args: [FIXTURE] } },
  }));
});

afterAll(async () => {
  await new Promise<void>((r) => http401.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** No secret value, no absolute path of the temporary home or project, no server arguments. */
const expectClean = (text: string): void => {
  for (const s of [...SECRETS, home, project, FIXTURE, watchPid]) expect(text).not.toContain(s);
};

describe('the servers MCPorter knows: its config and editor imports', () => {
  it('lists config and imported servers, each with where it came from as ~/ or a project path', async () => {
    const r = await listServers('mcporter', opts);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.servers.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(['cursor-echo', 'echo-local', 'home-echo', 'home-remote', 'remote-oauth', 'remote-plain', 'watch-me']);
    expect(by['echo-local']).toMatchObject({ transport: 'stdio', origin: 'local', source: 'config/mcporter.json', envNames: ['FIXTURE_TOKEN'] });
    expect(by['home-echo']).toMatchObject({ transport: 'stdio', origin: 'local', source: '~/.mcporter/mcporter.json' });
    expect(by['cursor-echo']).toMatchObject({ transport: 'stdio', origin: 'import', importKind: 'cursor', source: '.cursor/mcp.json', envNames: ['API_KEY'] });
    expect(by['home-remote']).toMatchObject({ transport: 'http', origin: 'import', importKind: 'cursor', source: '~/.cursor/mcp.json', url: 'https://example.invalid/mcp', headerNames: ['Authorization'] });
    expect(by['remote-oauth']).toMatchObject({ transport: 'http', auth: 'oauth', url: `http://127.0.0.1:${port}/mcp` });
    // Read from the files alone: MCPorter reports no status without contacting a server.
    for (const s of r.servers) expect(s.status).toBeUndefined();
    expectClean(JSON.stringify(r));
  }, LONG);

  it('/mcp servers shows them, and /mcp says how many are configured', async () => {
    const servers = (await mcpView(['servers'], opts)).join('\n');
    for (const name of ['echo-local', 'home-echo', 'cursor-echo', 'home-remote', 'remote-oauth']) expect(servers).toContain(name);
    expect(servers).toContain('~/.cursor/mcp.json');
    expect(servers).toContain('.cursor/mcp.json (cursor)');
    expect(servers).toContain('~/.mcporter/mcporter.json');
    expect(servers).toMatch(/remote-oauth .*sign-in oauth/);
    expect(servers).toMatch(/not contacted/);
    expectClean(servers);
    const routes = (await mcpView([], opts)).join('\n');
    expect(routes).toContain('MCP to CLI · MCPorter');
    expect(routes).toMatch(/7 servers configured \(5 in MCPorter's config, 2 from editors\)/);
    expectClean(routes);
  }, LONG);

  it('TIMMY_MCP_HOME: a Timmy with a home of its own reads the servers configured in another home, shown under ~/', async () => {
    const own = scratch();   // the sandbox's own, empty home
    const r = await listServers('mcporter', { cwd: project, env: { PATH: process.env.PATH, HOME: own, USERPROFILE: own, TIMMY_MCP_HOME: home }, timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.servers.map((s) => [s.name, s]));
    expect(by['home-echo']).toMatchObject({ origin: 'local', source: '~/.mcporter/mcporter.json' });
    expect(by['home-remote']).toMatchObject({ origin: 'import', source: '~/.cursor/mcp.json' });
    for (const s of r.servers) expect(s.status).toBeUndefined();
    expectClean(JSON.stringify(r));
    // without it, the sandbox's own home holds none of them; a relative TIMMY_MCP_HOME is ignored
    for (const extra of [{}, { TIMMY_MCP_HOME: 'relative/home' }]) {
      const mine = await listServers('mcporter', { cwd: project, env: { PATH: process.env.PATH, HOME: own, USERPROFILE: own, ...extra }, timeoutMs: 30_000 });
      expect(mine.servers.map((s) => s.name)).not.toContain('home-echo');
    }
  }, LONG);

  it('a config file is shown inside the project, under ~/, or by its last two parts; never by an absolute home path', () => {
    const h = '/home/user';
    expect(shownConfigPath('/home/user/code/app/config/mcporter.json', { cwd: '/home/user/code/app', home: h })).toBe('config/mcporter.json');
    expect(shownConfigPath('/home/user/code/app/.cursor/mcp.json', { cwd: '/home/user/code/app', home: h })).toBe('.cursor/mcp.json');
    expect(shownConfigPath('/home/user/.cursor/mcp.json', { cwd: '/home/user/code/app', home: h })).toBe('~/.cursor/mcp.json');
    // Run from the home folder itself, or from /: still ~/, never the folder's own name.
    expect(shownConfigPath('/home/user/.claude.json', { cwd: h, home: h })).toBe('~/.claude.json');
    expect(shownConfigPath('/home/user/.claude.json', { cwd: '/', home: h })).toBe('~/.claude.json');
    expect(shownConfigPath('/etc/mcp/shared/mcporter.json', { cwd: '/srv/app', home: h })).toBe('…/shared/mcporter.json');
  });

  it('/mcp servers --check contacts each server once: ok, or needs authorization; still no sign-in', async () => {
    const p = scratch();
    mkdirSync(join(p, 'config'));
    writeFileSync(join(p, 'config', 'mcporter.json'), JSON.stringify({ mcpServers: {
      'echo-ok': { command: process.execPath, args: [FIXTURE] },
      'remote-401': { url: `http://127.0.0.1:${port}/checked`, auth: 'oauth' },
    } }));
    const before = requests.length;
    const out = (await mcpView(['servers', '--check'], { cwd: p, env: { PATH: process.env.PATH, HOME: scratch() }, timeoutMs: 30_000 })).join('\n');
    expect(out).toMatch(/each contacted once/);
    expect(out).toMatch(/echo-ok .*status ok/);
    expect(out).toMatch(/remote-401 .*status auth/);
    expect(out).toMatch(/remote-401: needs authorization: .*mcporter auth remote-401/);
    const seen = requests.slice(before);
    expect(seen.some((r) => r.includes('/checked'))).toBe(true);
    for (const r of seen) expect(r).not.toMatch(/well-known|oauth|register|authorize|token/i);
  }, LONG);
});

describe('a configured server by its name', () => {
  it('lists the tools of an imported editor server', async () => {
    const r = await listTools('mcporter', { name: 'cursor-echo' }, opts);
    expect(r.error).toBeUndefined();
    expect(r.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['echo', 'add']));
  }, LONG);

  it('calls a tool on a server from the home config', async () => {
    const r = await callTool('mcporter', { name: 'home-echo' }, 'echo', { text: 'from home' }, opts);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, server: 'home-echo', text: 'echo: from home' });
  }, LONG);

  it('a name not in the config is refused before anything starts (no near-miss correction)', async () => {
    const log = join(scratch(), 'calls.log');
    const e = { ...env, ECHO_FIXTURE_CALL_LOG: log };
    const tools = await listTools('mcporter', { name: 'echo-locl' }, { ...opts, env: e, passEnv: ['ECHO_FIXTURE_CALL_LOG'] });
    expect(tools.ok).toBe(false);
    expect(tools.error).toMatch(/no server named "echo-locl"/);
    const call = await callTool('mcporter', { name: 'echo-locl' }, 'echo', { text: 'x' }, { ...opts, env: e, passEnv: ['ECHO_FIXTURE_CALL_LOG'] });
    expect(call.ok).toBe(false);
    expect(call.error).toMatch(/no server named "echo-locl"/);
    expect(existsSync(log)).toBe(false);
  }, LONG);

  it('a tool name that is not the server\'s is refused, never corrected to a different tool', async () => {
    // MCPorter's call retries a "Tool x not found" with the closest name; Timmy must not let it.
    const log = join(scratch(), 'calls.log');
    const e = { ...env, ECHO_FIXTURE_SDK_ERRORS: '1', ECHO_FIXTURE_CALL_LOG: log };
    const passEnv = ['ECHO_FIXTURE_SDK_ERRORS', 'ECHO_FIXTURE_CALL_LOG'];
    for (const server of [{ name: 'echo-local' }, { command: [process.execPath, FIXTURE] }]) {
      const r = await callTool('mcporter', server, 'ech', { text: 'meant for ech only' }, { ...opts, env: e, passEnv });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/no tool named "ech"/);
      expect(r.text).toBeUndefined();
    }
    const ran = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(ran).not.toContain('echo');
  }, LONG);

  it('the SDK route takes no names, and says so', async () => {
    const r = await listTools('sdk', { name: 'echo-local' }, opts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SDK route .*command line/);
    const view = (await mcpView(['tools', '--route', 'sdk', 'echo-local'], opts)).join('\n');
    expect(view).toMatch(/SDK route .*command line/);
  }, LONG);
});

describe('an HTTP server that needs a sign-in', () => {
  it('answers "needs authorization" with MCPorter\'s own step, and never starts a sign-in', async () => {
    for (const name of ['remote-oauth', 'remote-plain']) {
      const tools = await listTools('mcporter', { name }, opts);
      expect(tools.ok).toBe(false);
      expect(tools.needsAuth).toBe(true);
      expect(tools.authCommand).toBe(`mcporter auth ${name}`);
      expect(tools.error).toMatch(/^needs authorization: /);
      expect(tools.error).toContain(`mcporter auth ${name}`);
      const call = await callTool('mcporter', { name }, 'anything', {}, opts);
      expect(call.ok).toBe(false);
      expect(call.needsAuth).toBe(true);
      expect(call.error).toMatch(/^needs authorization: .*mcporter auth /);
      expectClean(JSON.stringify([tools, call]));
    }
    const view = (await mcpView(['call', 'remote-oauth', 'anything', '{}'], opts)).join('\n');
    expect(view).toMatch(/needs authorization: .*mcporter auth remote-oauth/);
    // The server saw MCP requests only: no OAuth discovery, client registration, authorization or token request.
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r).not.toMatch(/well-known|oauth|register|authorize|token/i);
  }, LONG);
});

type Exec = (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
// R4 (H34): call_mcp_tool seals a receipt for its record: into a chain in the scratch project, never this checkout.
const projectSeal = (input: ReceiptInput): string => appendReceipt('runs', input, project).hash.slice(7, 15);
const agentTool = (name: string): Exec => {
  const t = createMcpTools({ cwd: () => project, env: () => env, seal: projectSeal }).find((x) => x.function.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (t.function as unknown as { execute: Exec }).execute;
};

describe('the agent tools and the approval line', () => {
  it('list_mcp_tools reads the config only: it lists every server and never starts one', async () => {
    const r = await agentTool('list_mcp_tools')({});
    expect(r.ok).toBe(true);
    expect((r.servers as Array<{ name: string }>).map((s) => s.name)).toEqual(expect.arrayContaining(['watch-me', 'cursor-echo', 'home-remote']));
    const refused = await agentTool('list_mcp_tools')({ server: 'watch-me' });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/list_mcp_command_tools/);
    expect(existsSync(watchPid)).toBe(false);
    expectClean(JSON.stringify([r, refused]));
    // The asking tool does start it: the control that the pid file would have shown a start.
    const tools = await agentTool('list_mcp_command_tools')({ server: 'watch-me' });
    expect(tools.error).toBeUndefined();
    expect((tools.tools as Array<{ name: string }>).map((t) => t.name)).toContain('echo');
    expect(existsSync(watchPid)).toBe(true);
  }, LONG);

  it('list_mcp_tools answers a server name with the asking tool\'s name, through the SDK\'s own input check too', async () => {
    const t = createMcpTools({ cwd: () => project, env: () => env }).find((x) => x.function.name === 'list_mcp_tools')!;
    const fn = t.function as unknown as { inputSchema: unknown; execute: Exec };
    // A live turn parses the model's arguments against the schema before execute sees them.
    const parsed = validateToolInput(fn.inputSchema as Parameters<typeof validateToolInput>[0], { server: 'watch-me' }) as Record<string, unknown>;
    const r = await fn.execute(parsed);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/list_mcp_command_tools/);
    // The advertised schema invites no argument.
    expect(Object.keys((convertZodToJsonSchema(fn.inputSchema as Parameters<typeof convertZodToJsonSchema>[0]) as { properties?: object }).properties ?? {})).toEqual([]);
  }, LONG);

  it('call_mcp_tool calls an imported server by name', async () => {
    const r = await agentTool('call_mcp_tool')({ server: 'cursor-echo', tool: 'echo', args: { text: 'agent' } });
    expect(r).toMatchObject({ ok: true, route: 'mcporter', text: 'echo: agent' });
  }, LONG);

  it('approvals: listing the config never asks; starting or calling a configured server asks every time', () => {
    expect(approvalNeeded('list_mcp_tools', {})).toBeNull();
    for (const [tool, args] of [['list_mcp_command_tools', { server: 'watch-me' }], ['call_mcp_tool', { server: 'cursor-echo', tool: 'echo' }]] as const) {
      const need = approvalNeeded(tool, args as Record<string, unknown>);
      expect(need).not.toBeNull();
      expect(need?.session).toBe(false);
    }
  });
});
