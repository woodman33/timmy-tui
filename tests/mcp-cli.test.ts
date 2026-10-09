// R2 (MCP to CLI): one place in Timmy to discover and operate MCP servers through command-line routes.
// Two routes, each exercised end to end here against a real MCP server process over stdio:
//   mcporter  MCPorter's own CLI (node_modules/mcporter), ad-hoc stdio servers and its config
//   sdk       Timmy's small CLI on @modelcontextprotocol/sdk's Client + StdioClientTransport
// Nothing here reaches the network; every server is a child process this test starts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { callTool, listServers, listTools, mcpCapabilityRows, mcpRoutes, mcpView, MCP_OUTPUT_LIMIT, serverLabel, splitCommandLine } from '../src/connectors/mcp-cli.js';
import { createMcpTools } from '../src/agent/mcp-tools.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const SERVER = { command: [process.execPath, FIXTURE] };
const ROUTES = ['mcporter', 'sdk'] as const;
const LONG = 60_000;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'mcpcli-')); dirs.push(d); return d; };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return ok();
};

describe('the routes', () => {
  it('both resolve here, each with its dependency and version', () => {
    const routes = mcpRoutes();
    expect(routes.map((r) => r.id)).toEqual(['mcporter', 'sdk']);
    for (const r of routes) {
      expect(r.available).toBe(true);
      expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(r.label).toMatch(/^MCP to CLI · /);
    }
    expect(routes[0].details).toContain('mcporter');
    expect(routes[0].details).toMatch(/MCP client: (the shared|its own) @modelcontextprotocol\/sdk/);
    expect(routes[1].details).toContain('@modelcontextprotocol/sdk');
  });

  it('the SDK route\'s program imports no MCPorter code', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/connectors/mcp-sdk-cli.ts', import.meta.url)), 'utf8');
    const imports = source.split('\n').filter((l) => /^import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l).not.toMatch(/mcporter|mcp-cli/);
  });

  it('a missing route is not available and says why', () => {
    const routes = mcpRoutes(process.env, { packageDir: () => null, onPath: () => false });
    expect(routes.every((r) => !r.available)).toBe(true);
    expect(routes.every((r) => r.version === undefined)).toBe(true);
  });
});

describe.each(ROUTES)('route %s, end to end against a real stdio MCP server', (route) => {
  it('lists the server\'s tools', async () => {
    const r = await listTools(route, SERVER, { timeoutMs: 30_000 });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.route).toBe(route);
    expect(r.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['echo', 'add']));
    expect(r.tools.find((t) => t.name === 'add')?.required).toEqual(['a', 'b']);
  }, LONG);

  it('calls echo and add, and says how long and how much', async () => {
    const echo = await callTool(route, SERVER, 'echo', { text: 'hi there' }, { timeoutMs: 30_000 });
    expect(echo.error).toBeUndefined();
    expect(echo).toMatchObject({ ok: true, route, tool: 'echo', text: 'echo: hi there' });
    expect(echo.outputBytes).toBeGreaterThan(0);
    expect(echo.ms).toBeGreaterThan(0);
    const add = await callTool(route, SERVER, 'add', { a: 2, b: 3 }, { timeoutMs: 30_000 });
    expect(add).toMatchObject({ ok: true, tool: 'add', text: '5' });
  }, LONG);

  it('an unknown tool fails with the server\'s own error', async () => {
    const r = await callTool(route, SERVER, 'no_such_tool', {}, { timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('echo-fixture has no tool named no_such_tool');
  }, LONG);

  it('a time limit stops a hanging server, the server process included', async () => {
    const pidFile = join(scratch(), 'server.pid');
    const r = await callTool(route, SERVER, 'hang', {}, { timeoutMs: 3_000, env: { ...process.env, ECHO_FIXTURE_PID_FILE: pidFile }, passEnv: ['ECHO_FIXTURE_PID_FILE'] });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/no answer within 3 s/);
    expect(r.ms).toBeLessThan(15_000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(await until(() => !alive(pid), 5_000)).toBe(true);
  }, LONG);

  it('output over the bound is cut, with a marker that says so', async () => {
    const r = await callTool(route, SERVER, 'big', { size: 100_000 }, { timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.outputBytes).toBeGreaterThan(100_000);
    expect(Buffer.byteLength(r.text ?? '')).toBeLessThanOrEqual(MCP_OUTPUT_LIMIT + 200);
    expect(r.text).toMatch(/\[cut: \d[\d,]* bytes in all, the first 32 KB shown\]$/);
    expect(r.result).toBeUndefined();
  }, LONG);

  it('a server that cannot start fails plainly, without hanging', async () => {
    const r = await callTool(route, { command: [process.execPath, join(scratch(), 'missing-server.mjs')] }, 'echo', { text: 'x' }, { timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBeFalsy();
    expect(r.error).toBeTruthy();
  }, LONG);
});

describe('Timmy\'s own MCP server (src/mcp/server.ts) as a second target', () => {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const TSX = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const TIMMY = { command: [process.execPath, '--import', TSX, join(ROOT, 'src', 'mcp', 'server.ts')] };
  it.each(ROUTES)('%s lists its tools', async (route) => {
    const r = await listTools(route, TIMMY, { cwd: ROOT, timeoutMs: 60_000 });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['timmy_receipt_verify', 'timmy_events_tail', 'timmy_env_lock']));
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(MCP_OUTPUT_LIMIT + 1024);
  }, LONG);
});

describe('MCPorter\'s config: servers by name, never a secret', () => {
  const project = scratch();
  const home = scratch();
  mkdirSync(join(project, 'config'));
  writeFileSync(join(project, 'config', 'mcporter.json'), JSON.stringify({
    mcpServers: {
      'echo-fixture': { command: process.execPath, args: [FIXTURE], env: { FIXTURE_TOKEN: '${SOME_SECRET_VALUE}' } },
      remote: { url: 'https://example.invalid/mcp?token=abc123', headers: { Authorization: 'Bearer sk-not-a-real-key' } },
    },
  }));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };

  it('lists configured servers with env and header names only', async () => {
    const r = await listServers('mcporter', { cwd: project, env, timeoutMs: 30_000 });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const echo = r.servers.find((s) => s.name === 'echo-fixture');
    expect(echo).toMatchObject({ transport: 'stdio', envNames: ['FIXTURE_TOKEN'] });
    const remote = r.servers.find((s) => s.name === 'remote');
    expect(remote).toMatchObject({ transport: 'http', url: 'https://example.invalid/mcp', headerNames: ['Authorization'] });
    const text = JSON.stringify(r);
    for (const secret of ['abc123', 'sk-not-a-real-key', 'SOME_SECRET_VALUE', FIXTURE]) expect(text).not.toContain(secret);
  }, LONG);

  it('lists a configured server\'s tools by its name', async () => {
    const r = await listTools('mcporter', { name: 'echo-fixture' }, { cwd: project, env, timeoutMs: 30_000 });
    expect(r.error).toBeUndefined();
    expect(r.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['echo', 'add']));
  }, LONG);

  it('calls a configured server by its name', async () => {
    const r = await callTool('mcporter', { name: 'echo-fixture' }, 'echo', { text: 'by name' }, { cwd: project, env, timeoutMs: 30_000 });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, server: 'echo-fixture', text: 'echo: by name' });
  }, LONG);

  it('the SDK route keeps no list, and says so', async () => {
    const r = await listServers('sdk');
    expect(r.ok).toBe(false);
    expect(r.servers).toEqual([]);
    expect(r.error).toMatch(/command line/);
  });
});

describe('names and command lines', () => {
  it('a server is shown by its program and script, never its other arguments', () => {
    expect(serverLabel({ command: [process.execPath, FIXTURE] })).toBe(`${process.execPath.split(/[\\/]/).pop()} mcp-echo-server.mjs`);
    expect(serverLabel({ command: ['node', '--import', 'file:///x/loader.mjs', '/x/src/mcp/server.ts', '--token', 'abc'] })).toBe('node server.ts');
    expect(serverLabel({ command: ['npx', '-y', 'some-mcp-server'] })).toBe('npx some-mcp-server');
    expect(serverLabel({ name: 'linear' })).toBe('linear');
  });

  it('/mcp splits a command line like a shell, quotes included', () => {
    expect(splitCommandLine('tools -- node "my server.mjs" \'a b\' c')).toEqual(['tools', '--', 'node', 'my server.mjs', 'a b', 'c']);
    expect(splitCommandLine('call echo \'{"text":"hi there"}\'')).toEqual(['call', 'echo', '{"text":"hi there"}']);
  });
});

describe('the capability list rows', () => {
  it('installed when the route resolves, with its dependency and version', () => {
    const rows = mcpCapabilityRows(process.env);
    const summary = rows.find((r) => r.id === 'mcp-cli');
    expect(summary).toMatchObject({ kind: 'tool', rung: 'installed', tools: ['list_mcp_tools', 'list_mcp_command_tools', 'call_mcp_tool'] });
    expect(summary?.tools).toEqual(createMcpTools().map((t) => t.function.name));
    const mcporter = rows.find((r) => r.id === 'mcp-cli:mcporter');
    expect(mcporter?.rung).toBe('installed');
    expect(mcporter?.detail).toMatch(/mcporter \d+\.\d+\.\d+/);
    const sdk = rows.find((r) => r.id === 'mcp-cli:sdk');
    expect(sdk?.rung).toBe('installed');
    expect(sdk?.detail).toMatch(/@modelcontextprotocol\/sdk \d+\.\d+\.\d+/);
    for (const r of rows) expect(r.rung).not.toBe('reachable');
  });

  it('needs setup, with the exact step, when a route is missing', () => {
    const rows = mcpCapabilityRows(process.env, { packageDir: (name) => (name === 'mcporter' ? null : undefined), onPath: () => false });
    const mcporter = rows.find((r) => r.id === 'mcp-cli:mcporter');
    expect(mcporter).toMatchObject({ rung: 'needs setup' });
    expect(mcporter?.setup).toMatch(/npm install/);
    expect(rows.find((r) => r.id === 'mcp-cli:sdk')?.rung).toBe('installed');
    const none = mcpCapabilityRows(process.env, { packageDir: () => null, onPath: () => false });
    expect(none.find((r) => r.id === 'mcp-cli')?.rung).toBe('needs setup');
  });
});

type Exec = (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
const exec = (name: string) => {
  const t = createMcpTools().find((x) => x.function.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (t.function as unknown as { execute: Exec }).execute;
};

describe('the agent tools', () => {
  it('three tools; only list_mcp_tools is read-only, and it never starts a program from a command line', async () => {
    expect(createMcpTools().map((t) => t.function.name)).toEqual(['list_mcp_tools', 'list_mcp_command_tools', 'call_mcp_tool']);
    const r = await exec('list_mcp_tools')({ command: [process.execPath, FIXTURE] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/list_mcp_command_tools/);
    expect(r.tools).toBeUndefined();
  });

  it('list_mcp_tools: the routes and the configured servers', async () => {
    const routes = await exec('list_mcp_tools')({});
    expect((routes.routes as Array<{ id: string; available: boolean }>).map((r) => r.id)).toEqual(['mcporter', 'sdk']);
    expect(Array.isArray(routes.servers) || typeof routes.servers_error === 'string').toBe(true);
  }, LONG);

  it('list_mcp_tools: a configured server\'s tools, by name', async () => {
    const project = scratch();
    mkdirSync(join(project, 'config'));
    writeFileSync(join(project, 'config', 'mcporter.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [FIXTURE] } } }));
    const t = createMcpTools({ cwd: () => project, env: () => ({ PATH: process.env.PATH, HOME: scratch() }) }).find((x) => x.function.name === 'list_mcp_tools')!;
    const r = await (t.function as unknown as { execute: Exec }).execute({ server: 'fixture' });
    expect(r.error).toBeUndefined();
    expect((r.tools as Array<{ name: string }>).map((x) => x.name)).toEqual(expect.arrayContaining(['echo', 'add']));
  }, LONG);

  it('list_mcp_command_tools: a command line\'s tools, through either route', async () => {
    for (const route of ROUTES) {
      const tools = await exec('list_mcp_command_tools')({ route, command: [process.execPath, FIXTURE] });
      expect(tools.ok).toBe(true);
      expect((tools.tools as Array<{ name: string }>).map((t) => t.name)).toContain('echo');
    }
  }, LONG);

  it('call_mcp_tool: calls through either route', async () => {
    for (const route of ROUTES) {
      const r = await exec('call_mcp_tool')({ route, command: [process.execPath, FIXTURE], tool: 'add', args: { a: 40, b: 2 } });
      expect(r).toMatchObject({ ok: true, route, text: '42' });
    }
  }, LONG);

  it('call_mcp_tool: needs a server', async () => {
    const r = await exec('call_mcp_tool')({ route: 'sdk', tool: 'echo', args: {} });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/server/);
  });
});

describe('/mcp', () => {
  it('shows the routes, then a server\'s tools', async () => {
    const top = (await mcpView([])).join('\n');
    expect(top).toContain('MCP to CLI · MCPorter');
    expect(top).toContain('MCP to CLI · SDK');
    expect(top).toContain('installed');
    const tools = (await mcpView(['tools', '--route', 'sdk', '--', process.execPath, FIXTURE])).join('\n');
    expect(tools).toContain('echo');
    expect(tools).toContain('add');
  }, LONG);

  it('calls a tool and shows its answer', async () => {
    const out = (await mcpView(['call', '--route', 'mcporter', 'echo', '{"text":"from the REPL"}', '--', process.execPath, FIXTURE])).join('\n');
    expect(out).toContain('echo: from the REPL');
  }, LONG);
});
