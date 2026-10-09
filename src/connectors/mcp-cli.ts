/**
 * MCP to CLI (R2): one place in Timmy to find MCP servers and operate their tools through command-line
 * routes. Two routes, each usable without the other:
 *
 *   mcporter  MCPorter's own CLI (Timmy's dependency `mcporter`): ad-hoc stdio servers, and the servers in
 *             its config (./config/mcporter.json, ~/.mcporter, editor imports), by name.
 *   sdk       Timmy's small CLI (./mcp-sdk-cli.ts) on @modelcontextprotocol/sdk's Client and
 *             StdioClientTransport: ad-hoc stdio servers only, no config, no MCPorter code.
 *
 * (@mcpc-tech/cmcp is not a route: it is a client-tool-execution layer, a server that forwards calls to
 * tools its clients register. It has no command line and cannot reach another server's tools by itself.)
 *
 * Independence, exactly: the two are separate programs (neither imports the other), so a missing or broken
 * MCPorter leaves the SDK route working. Underneath, both speak MCP through @modelcontextprotocol/sdk's
 * stdio client, and MCPorter resolves the same installed copy unless it carries its own; a defect in that
 * library would reach both. The route details say which.
 *
 * Honesty rules: a route is `available` only when its program actually resolves here; that says it is
 * installed, not that any server works. Every call runs as a child process in its own process group with a
 * time limit, and the whole group is stopped when the limit passes. Servers get a small base environment
 * plus the variables named in `passEnv`; values are never put on a command line or in an answer. Answers
 * are bounded: at most 32 KB of a tool's output comes back, and a cut answer says so.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CapabilityRow } from '../capabilities/index.js';

export type McpRouteId = 'mcporter' | 'sdk';
export const MCP_ROUTE_IDS: readonly McpRouteId[] = ['mcporter', 'sdk'];
/** The most of a tool's output an answer carries. */
export const MCP_OUTPUT_LIMIT = 32 * 1024;
/** The most of a route's output Timmy reads before it stops reading. */
const READ_LIMIT = 8 * 1024 * 1024;

type Env = Record<string, string | undefined>;

/** Stand-ins for the machine, so a test can take a route away. */
export interface McpRouteSeams {
  /** A package's folder; null when it is not installed; undefined to look it up as usual. */
  packageDir?: (name: string) => string | null | undefined;
  /** Whether a program is on PATH. */
  onPath?: (program: string, env: Env) => boolean;
}

export interface McpRoute {
  id: McpRouteId;
  /** Timmy-facing name. */
  label: string;
  /** The program resolves here. Installed, not proven: no server was contacted. */
  available: boolean;
  version?: string;
  /** The dependency, its version and how the route runs. */
  details: string;
  /** The step that makes it available, when it is not. */
  setup?: string;
  /** Whether the route reads a list of servers (MCPorter's config and editor imports). */
  hasConfig: boolean;
  /** The program and leading arguments that run the route, when available. */
  argv?: string[];
}

/** A configured server by name (MCPorter only), or any stdio server as a command line. */
export type McpServerRef = { name: string } | { command: string[]; cwd?: string };

export interface McpRunOptions {
  /** Time limit in milliseconds (calls 60 s, lists 30 s by default). */
  timeoutMs?: number;
  /** Folder the route runs in; MCPorter reads ./config/mcporter.json there. */
  cwd?: string;
  /** Where variable values come from (default: this process's environment). */
  env?: Env;
  /** Variables handed to the server beyond the base set, by name. */
  passEnv?: string[];
  seams?: McpRouteSeams;
}

export interface McpServerEntry {
  name: string;
  transport: string;
  /** Where the definition came from (local config, an editor import ...), never a path. */
  source?: string;
  description?: string;
  /** The program a stdio server runs (its name only; arguments are not shown). */
  program?: string;
  /** An HTTP server's address without credentials or query. */
  url?: string;
  envNames?: string[];
  headerNames?: string[];
}

export interface McpToolEntry {
  name: string;
  description?: string;
  required: string[];
  params: string[];
  inputSchema?: unknown;
}

export interface McpServersAnswer { ok: boolean; route: McpRouteId; servers: McpServerEntry[]; ms?: number; error?: string }
export interface McpToolsAnswer { ok: boolean; route: McpRouteId; server: string; ms: number; tools: McpToolEntry[]; truncated?: boolean; error?: string; timedOut?: boolean }
export interface McpCallAnswer {
  ok: boolean;
  route: McpRouteId;
  server: string;
  tool: string;
  ms: number;
  /** The route's parsed answer; left out when it would pass the bound. */
  result?: unknown;
  /** The tool's text (or the answer as JSON), at most 32 KB; a cut text ends with a marker. */
  text?: string;
  error?: string;
  /** Bytes the route printed, in all. */
  outputBytes: number;
  truncated?: boolean;
  timedOut?: boolean;
}

// ---------------------------------------------------------------- finding the routes

const HERE = dirname(fileURLToPath(import.meta.url));

/** Timmy's own package folder (this file may be bundled elsewhere under dist/). */
function findTimmyRoot(): string | null {
  for (let d = HERE; ; d = dirname(d)) {
    try { if ((JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as { name?: string }).name === 'timmy-tui') return d; } catch { /* keep looking */ }
    if (dirname(d) === d) return null;
  }
}

function findPackageDir(name: string): string | null {
  for (let d = HERE; ; d = dirname(d)) {
    const pkg = join(d, 'node_modules', name, 'package.json');
    if (existsSync(pkg)) return dirname(pkg);
    if (dirname(d) === d) return null;
  }
}

function readPackage(dir: string): { version?: string; bin?: string | Record<string, string> } {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string; bin?: string | Record<string, string> }; } catch { return {}; }
}

function programOnPath(program: string, env: Env): boolean {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => exts.some((ext) => existsSync(join(dir, program + ext))));
}

/** The routes, from what resolves here. Quick and quiet: nothing runs, nothing is contacted. */
export function mcpRoutes(env: Env = process.env, seams: McpRouteSeams = {}): McpRoute[] {
  const pkgDir = (name: string): string | null => {
    const seen = seams.packageDir?.(name);
    return seen === undefined ? findPackageDir(name) : seen;
  };
  const onPath = seams.onPath ?? programOnPath;

  // Route 1: MCPorter's CLI, Timmy's own copy first, then one on PATH.
  let mcporter: McpRoute;
  const mDir = pkgDir('mcporter');
  const mPkg = mDir ? readPackage(mDir) : {};
  const mBin = typeof mPkg.bin === 'string' ? mPkg.bin : mPkg.bin?.mcporter ?? 'dist/cli.js';
  if (mDir && existsSync(join(mDir, mBin))) {
    const ownSdk = existsSync(join(mDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'));
    mcporter = { id: 'mcporter', label: 'MCP to CLI · MCPorter', available: true, ...(mPkg.version ? { version: mPkg.version } : {}), hasConfig: true,
      details: `mcporter ${mPkg.version ?? '(version unknown)'}, Timmy's dependency; runs its CLI (list, call), ad-hoc stdio servers and its config; MCP client: ${ownSdk ? 'its own @modelcontextprotocol/sdk copy' : 'the shared @modelcontextprotocol/sdk'}`,
      argv: [process.execPath, join(mDir, mBin)] };
  } else if (onPath('mcporter', env)) {
    mcporter = { id: 'mcporter', label: 'MCP to CLI · MCPorter', available: true, hasConfig: true,
      details: 'mcporter on PATH (version not read); runs its CLI (list, call), ad-hoc stdio servers and its config', argv: ['mcporter'] };
  } else {
    mcporter = { id: 'mcporter', label: 'MCP to CLI · MCPorter', available: false, hasConfig: true,
      details: 'mcporter is not installed here', setup: "npm install mcporter (in Timmy's folder), or npm install --global mcporter" };
  }

  // Route 2: Timmy's own CLI on the MCP SDK; built (.js) or run from source through tsx.
  let sdk: McpRoute;
  const sDir = pkgDir('@modelcontextprotocol/sdk');
  const sVersion = sDir ? readPackage(sDir).version : undefined;
  // Beside this file when compiled; in Timmy's tsc output when this file was bundled; else from source.
  const root = findTimmyRoot();
  const built = [join(HERE, 'mcp-sdk-cli.js'), ...(root ? [join(root, 'dist', 'src', 'connectors', 'mcp-sdk-cli.js')] : [])].find((p) => existsSync(p));
  const source = [join(HERE, 'mcp-sdk-cli.ts'), ...(root ? [join(root, 'src', 'connectors', 'mcp-sdk-cli.ts')] : [])].find((p) => existsSync(p));
  const tsxDir = built ? null : pkgDir('tsx');
  const tsxLoader = tsxDir ? join(tsxDir, 'dist', 'loader.mjs') : null;
  const argv = built
    ? [process.execPath, built]
    : source && tsxLoader && existsSync(tsxLoader) ? [process.execPath, '--import', pathToFileURL(tsxLoader).href, source] : null;
  if (sDir && argv) {
    sdk = { id: 'sdk', label: 'MCP to CLI · SDK', available: true, ...(sVersion ? { version: sVersion } : {}), hasConfig: false,
      details: `@modelcontextprotocol/sdk ${sVersion ?? '(version unknown)'}; Timmy's own mcp-sdk-cli (Client + StdioClientTransport), ad-hoc stdio servers, no MCPorter`, argv };
  } else if (!sDir) {
    sdk = { id: 'sdk', label: 'MCP to CLI · SDK', available: false, hasConfig: false,
      details: '@modelcontextprotocol/sdk is not installed here', setup: "npm install @modelcontextprotocol/sdk (in Timmy's folder)" };
  } else {
    sdk = { id: 'sdk', label: 'MCP to CLI · SDK', available: false, hasConfig: false,
      details: `@modelcontextprotocol/sdk ${sVersion ?? ''} is here, but Timmy's mcp-sdk-cli is not built and tsx is missing`.replace('  ', ' '), setup: 'npm run build (or npm install, so tsx can run it from source)' };
  }
  return [mcporter, sdk];
}

/** Rows for the capability list (/tools). Installed at most: nothing here contacts a server. */
export function mcpCapabilityRows(env: Env = process.env, seams: McpRouteSeams = {}): Array<Omit<CapabilityRow, 'exercised'>> {
  const routes = mcpRoutes(env, seams);
  const ready = routes.filter((r) => r.available);
  const tools = ['list_mcp_tools', 'call_mcp_tool'];
  const summary: Omit<CapabilityRow, 'exercised'> = ready.length
    ? { id: 'mcp-cli', kind: 'tool', name: 'MCP servers (/mcp)', rung: 'installed', detail: `${ready.length} of ${routes.length} command-line routes installed; no server contacted`, tools }
    : { id: 'mcp-cli', kind: 'tool', name: 'MCP servers (/mcp)', rung: 'needs setup', detail: 'no command-line route installed', setup: routes.map((r) => r.setup).filter(Boolean).join('; '), tools };
  return [summary, ...routes.map((r): Omit<CapabilityRow, 'exercised'> => (r.available
    ? { id: `mcp-cli:${r.id}`, kind: 'tool', name: `  ${r.label}`, rung: 'installed', detail: r.details }
    : { id: `mcp-cli:${r.id}`, kind: 'tool', name: `  ${r.label}`, rung: 'needs setup', detail: r.details, setup: r.setup ?? 'see /mcp' }))];
}

// ---------------------------------------------------------------- running a route

const BASE_ENV = ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'];

/** The environment a route and its server get: the base set, MCPorter's own settings, and the names asked for. */
function childEnv(source: Env, passEnv: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...BASE_ENV, ...Object.keys(source).filter((k) => k.startsWith('MCPORTER_')), ...passEnv]) {
    const v = source[name];
    if (typeof v === 'string') out[name] = v;
  }
  // No keep-alive daemon: every server stays a child of this call, inside its time limit.
  out.MCPORTER_DISABLE_KEEPALIVE = '*';
  out.MCPORTER_NO_SPINNER = '1';
  out.NO_COLOR = '1';
  return out;
}

interface RunOutcome { code: number | null; stdout: string; stdoutBytes: number; readCut: boolean; stderrTail: string; timedOut: boolean; ms: number; spawnError?: string }

function runProcess(argv: string[], o: { cwd?: string; env: Record<string, string>; timeoutMs: number; input?: string }): Promise<RunOutcome> {
  const started = performance.now();
  return new Promise((resolveRun) => {
    const group = process.platform !== 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: group, windowsHide: true });
    } catch (e) {
      resolveRun({ code: null, stdout: '', stdoutBytes: 0, readCut: false, stderrTail: '', timedOut: false, ms: performance.now() - started, spawnError: (e as Error).message });
      return;
    }
    if (o.input !== undefined) { child.stdin?.on('error', () => { /* the route left early; its exit says why */ }); child.stdin?.end(o.input); }
    const chunks: Buffer[] = [];
    let kept = 0;
    let bytes = 0;
    let stderrTail = '';
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    const stop = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { if (group) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ }
    };
    child.stdout?.on('data', (d: Buffer) => {
      bytes += d.length;
      if (kept < READ_LIMIT) { const take = d.subarray(0, READ_LIMIT - kept); chunks.push(take); kept += take.length; }
    });
    child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-4000); });
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 1500).unref();
    }, o.timeoutMs);
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout: Buffer.concat(chunks).toString('utf8'), stdoutBytes: bytes, readCut: bytes > kept, stderrTail, timedOut, ms: performance.now() - started, ...(spawnError ? { spawnError } : {}) });
    };
    child.on('error', (e) => { spawnError = e.message; finish(null); });
    // The route is done: anything it left in its group (a server it did not close) goes with it.
    child.on('exit', () => { stop('SIGTERM'); setTimeout(() => stop('SIGKILL'), 1500).unref(); });
    child.on('close', (code) => finish(code));
  });
}

const routeFor = (id: McpRouteId, seams?: McpRouteSeams, env?: Env): McpRoute | undefined => mcpRoutes(env ?? process.env, seams).find((r) => r.id === id);

/** A short name for a server: its configured name, or its program and script names (no other arguments). */
export function serverLabel(ref: McpServerRef): string {
  if ('name' in ref) return ref.name;
  const [program, ...rest] = ref.command;
  // The script it runs: the last argument that looks like one, else the first that is not a flag.
  let script: string | undefined;
  for (let i = rest.length - 1; i >= 0 && !script; i--) if (/\.(m?[jt]s|cjs|py)$/i.test(rest[i]) && !rest[i].includes('://')) script = rest[i];
  script ??= rest.find((a) => !a.startsWith('-') && !a.includes('://'));
  return [basename(program ?? ''), script ? basename(script) : ''].filter(Boolean).join(' ');
}

const slug = (ref: McpServerRef): string => serverLabel(ref).split(' ').pop()!.replace(/\.[a-z]+$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'adhoc';

function mcporterServerArgs(ref: McpServerRef): string[] {
  if ('name' in ref) return [];
  return ['--stdio', ref.command[0], ...ref.command.slice(1).flatMap((a) => ['--stdio-arg', a]), '--name', slug(ref), ...(ref.cwd ? ['--cwd', ref.cwd] : [])];
}

const parseJson = (s: string): { ok: true; value: unknown } | { ok: false } => {
  const t = s.trim();
  if (!t) return { ok: false };
  try { return { ok: true, value: JSON.parse(t) }; } catch { return { ok: false }; }
};

const stderrLine = (tail: string): string => {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /\b\w*Error\b/.test(l)) ?? lines[lines.length - 1] ?? '').slice(0, 300);
};

function failure(run: RunOutcome, timeoutMs: number, fallback: string): { error: string; timedOut?: boolean } {
  if (run.timedOut) return { error: `no answer within ${Math.round(timeoutMs / 1000)} s; stopped the route and its server`, timedOut: true };
  if (run.spawnError) return { error: `could not start: ${run.spawnError}` };
  const said = stderrLine(run.stderrTail);
  return { error: said ? `${fallback} (${said})` : fallback };
}

const noRoute = (route: McpRouteId, r: McpRoute | undefined): string => `${r?.label ?? route} is not available here${r?.setup ? `: ${r.setup}` : ''}`;
const sdkNeedsCommand = (ref: { name: string }): string => `the SDK route runs a server from its command line; "${ref.name}" is a name in MCPorter's config (use the mcporter route, or give the command)`;

/** The servers a route knows by name. Only MCPorter keeps such a list. Names, never secrets. */
export async function listServers(route: McpRouteId, o: McpRunOptions = {}): Promise<McpServersAnswer> {
  const r = routeFor(route, o.seams, o.env);
  if (!r?.hasConfig) return { ok: false, route, servers: [], error: 'the SDK route keeps no list of servers: give a server as a command line' };
  if (!r.available || !r.argv) return { ok: false, route, servers: [], error: noRoute(route, r) };
  const timeoutMs = o.timeoutMs ?? 30_000;
  const run = await runProcess([...r.argv, 'config', 'list', '--json'], { cwd: o.cwd, env: childEnv(o.env ?? process.env, o.passEnv), timeoutMs });
  const ms = Math.max(1, Math.round(run.ms));
  const parsed = parseJson(run.stdout);
  if (run.timedOut || run.code !== 0 || !parsed.ok) return { ok: false, route, servers: [], ms, ...failure(run, timeoutMs, `mcporter config list failed (exit ${run.code})`) };
  const raw = ((parsed.value as { servers?: unknown[] }).servers ?? []) as Array<Record<string, unknown>>;
  const servers = raw.map((s): McpServerEntry => {
    const e: McpServerEntry = { name: String(s.name ?? ''), transport: String(s.transport ?? (s.command ? 'stdio' : 'http')) };
    const src = s.source as { kind?: string; importKind?: string } | undefined;
    if (src?.kind) e.source = src.importKind ? `${src.kind}:${src.importKind}` : src.kind;
    if (typeof s.description === 'string') e.description = s.description.slice(0, 200);
    if (typeof s.command === 'string') e.program = basename(s.command);
    const url = typeof s.baseUrl === 'string' ? s.baseUrl : typeof s.url === 'string' ? s.url : undefined;
    if (url) { try { const u = new URL(url); e.url = `${u.protocol}//${u.host}${u.pathname}`; } catch { e.url = '(not a valid address)'; } }
    const envNames = s.env && typeof s.env === 'object' ? Object.keys(s.env) : [];
    if (envNames.length) e.envNames = envNames;
    const headerNames = s.headers && typeof s.headers === 'object' ? Object.keys(s.headers).filter((h) => h.toLowerCase() !== 'accept') : [];
    if (headerNames.length) e.headerNames = headerNames;
    return e;
  });
  return { ok: true, route, servers, ms };
}

function toolEntries(raw: unknown[]): McpToolEntry[] {
  return raw.map((t) => {
    const tool = t as { name?: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } };
    const e: McpToolEntry = { name: String(tool.name ?? ''), required: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema!.required!.map(String) : [], params: Object.keys(tool.inputSchema?.properties ?? {}) };
    if (tool.description) e.description = tool.description.slice(0, 500);
    if (tool.inputSchema) e.inputSchema = tool.inputSchema;
    return e;
  });
}

/** A server's tools, through one route. */
export async function listTools(route: McpRouteId, server: McpServerRef, o: McpRunOptions = {}): Promise<McpToolsAnswer> {
  const label = serverLabel(server);
  const r = routeFor(route, o.seams, o.env);
  if (!r?.available || !r.argv) return { ok: false, route, server: label, ms: 0, tools: [], error: noRoute(route, r) };
  if (route === 'sdk' && 'name' in server) return { ok: false, route, server: label, ms: 0, tools: [], error: sdkNeedsCommand(server) };
  if ('command' in server && !server.command.length) return { ok: false, route, server: label, ms: 0, tools: [], error: 'the command line is empty' };
  const timeoutMs = o.timeoutMs ?? 30_000;
  const inner = String(timeoutMs + 2000);
  const argv = route === 'mcporter'
    ? [...r.argv, 'list', ...('name' in server ? [server.name] : mcporterServerArgs(server)), '--json', '--timeout', inner]
    : [...r.argv, 'tools', '--json', '--timeout', inner, '--', ...(server as { command: string[] }).command];
  const cwd = 'command' in server && server.cwd && route === 'sdk' ? server.cwd : o.cwd;
  const run = await runProcess(argv, { cwd, env: childEnv(o.env ?? process.env, o.passEnv), timeoutMs });
  const ms = Math.max(1, Math.round(run.ms));
  const parsed = parseJson(run.stdout);
  if (run.timedOut || !parsed.ok) return { ok: false, route, server: label, ms, tools: [], ...failure(run, timeoutMs, `no tool list came back (exit ${run.code})`) };
  const v = parsed.value as { ok?: boolean; status?: string; tools?: unknown[]; error?: string; issue?: { rawMessage?: string } };
  const failed = route === 'mcporter' ? v.status !== 'ok' : v.ok !== true;
  if (failed) return { ok: false, route, server: label, ms, tools: [], error: v.error ?? v.issue?.rawMessage ?? (v.status ? `the server is ${v.status}` : 'the route failed') };
  let tools = toolEntries(v.tools ?? []);
  let truncated = false;
  // Over the bound: first the schemas go, then long descriptions are shortened, and only then tools.
  if (JSON.stringify(tools).length > MCP_OUTPUT_LIMIT) {
    truncated = true;
    tools = tools.map(({ inputSchema: _schema, ...rest }) => rest);
    if (JSON.stringify(tools).length > MCP_OUTPUT_LIMIT) tools = tools.map((t) => (t.description && t.description.length > 120 ? { ...t, description: `${t.description.slice(0, 119)}…` } : t));
    while (tools.length && JSON.stringify(tools).length > MCP_OUTPUT_LIMIT) tools.pop();
  }
  return { ok: true, route, server: label, ms, tools, ...(truncated ? { truncated } : {}) };
}

const textOf = (result: unknown): string => {
  if (typeof result === 'string') return result;
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  if (Array.isArray(content)) {
    const texts = content.filter((c) => c?.type === 'text').map((c) => c.text ?? '');
    if (texts.length) return texts.join('\n');
  }
  return JSON.stringify(result);
};

function cutUtf8(s: string, limit: number): string {
  const b = Buffer.from(s, 'utf8');
  return b.length <= limit ? s : b.subarray(0, limit).toString('utf8').replace(/�+$/, '');
}

/** Call one tool on a server, through one route, with a time limit and a bounded answer. */
export async function callTool(route: McpRouteId, server: McpServerRef, tool: string, args: Record<string, unknown> = {}, o: McpRunOptions = {}): Promise<McpCallAnswer> {
  const label = serverLabel(server);
  const base = { route, server: label, tool };
  const r = routeFor(route, o.seams, o.env);
  if (!r?.available || !r.argv) return { ok: false, ...base, ms: 0, outputBytes: 0, error: noRoute(route, r) };
  if (route === 'sdk' && 'name' in server) return { ok: false, ...base, ms: 0, outputBytes: 0, error: sdkNeedsCommand(server) };
  if ('command' in server && !server.command.length) return { ok: false, ...base, ms: 0, outputBytes: 0, error: 'the command line is empty' };
  if (!tool) return { ok: false, ...base, ms: 0, outputBytes: 0, error: 'no tool named' };
  const timeoutMs = o.timeoutMs ?? 60_000;
  const inner = String(timeoutMs + 2000);
  // The arguments travel on stdin (`--args -`, which both routes read), never on the process list.
  const payload = JSON.stringify(args ?? {});
  const argv = route === 'mcporter'
    ? [...r.argv, 'call', ...('name' in server ? ['--server', server.name] : mcporterServerArgs(server)), '--tool', tool, '--args', '-', '--output', 'json', '--timeout', inner]
    : [...r.argv, 'call', tool, '--args', '-', '--json', '--timeout', inner, '--', ...(server as { command: string[] }).command];
  const cwd = 'command' in server && server.cwd && route === 'sdk' ? server.cwd : o.cwd;
  const run = await runProcess(argv, { cwd, env: childEnv(o.env ?? process.env, o.passEnv), timeoutMs, input: payload });
  const ms = Math.max(1, Math.round(run.ms));
  const outputBytes = run.stdoutBytes;
  if (run.timedOut || run.spawnError) return { ok: false, ...base, ms, outputBytes, ...failure(run, timeoutMs, 'the route failed') };
  const parsed = run.readCut ? { ok: false as const } : parseJson(run.stdout);
  let ok: boolean;
  let result: unknown;
  let error: string | undefined;
  if (parsed.ok) {
    const v = parsed.value as Record<string, unknown> | null;
    if (route === 'sdk') {
      ok = v?.ok === true;
      result = v?.result;
      if (!ok) error = String(v?.error ?? 'the call failed');
    } else if (run.code !== 0) {
      ok = false;
      error = String(v?.error ?? (v?.issue as { rawMessage?: string } | undefined)?.rawMessage ?? `mcporter exited ${run.code}`);
    } else {
      result = v;
      ok = !(v && typeof v === 'object' && (v as { isError?: boolean }).isError === true);
      if (!ok) error = textOf(v);
    }
  } else if (run.code === 0 && run.stdout.trim()) {
    // Plain text, or more than Timmy reads: the text is the answer.
    ok = true;
    result = undefined;
  } else {
    return { ok: false, ...base, ms, outputBytes, ...failure(run, timeoutMs, `the route failed (exit ${run.code})`) };
  }
  let text = parsed.ok ? (result === undefined ? undefined : textOf(result)) : run.stdout;
  let truncated = run.readCut;
  if (result !== undefined && JSON.stringify(result).length > MCP_OUTPUT_LIMIT) { result = undefined; truncated = true; }
  if (text !== undefined && Buffer.byteLength(text, 'utf8') > MCP_OUTPUT_LIMIT) { text = cutUtf8(text, MCP_OUTPUT_LIMIT); truncated = true; }
  if (truncated && text !== undefined) text = `${text}\n[cut: ${outputBytes.toLocaleString('en-US')} bytes in all, the first 32 KB shown]`;
  if (error) error = cutUtf8(error, 2000);
  return { ok, ...base, ms, outputBytes, ...(result !== undefined ? { result } : {}), ...(text !== undefined ? { text } : {}), ...(error ? { error } : {}), ...(truncated ? { truncated } : {}) };
}

// ---------------------------------------------------------------- /mcp

/** Split a command line the way a shell would for plain words and quotes (no variables, no globs). */
export function splitCommandLine(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const MCP_HELP = [
  '/mcp                                   the routes, then MCPorter\'s servers',
  '/mcp tools <server>                    a configured server\'s tools (MCPorter)',
  '/mcp tools [--route sdk] -- <command>  any stdio server\'s tools, from its command line',
  '/mcp call <server> <tool> [json]       call a tool on a configured server',
  '/mcp call [--route sdk] <tool> [json] -- <command>',
];

/**
 * Plain text lines for /mcp. args are the words after /mcp (a REPL can pass splitCommandLine(rest)).
 * Answers what was actually run: routes come from what resolves here; servers and tools from a live run.
 */
export async function mcpView(args: string[], o: McpRunOptions = {}): Promise<string[]> {
  const routes = mcpRoutes(o.env ?? process.env, o.seams);
  const words = [...args];
  const verb = words[0] && !words[0].startsWith('-') ? words.shift()! : 'routes';
  let route: McpRouteId | undefined;
  const ri = words.indexOf('--route');
  if (ri >= 0 && ri < (words.indexOf('--') < 0 ? words.length : words.indexOf('--'))) {
    const id = words[ri + 1];
    if (id !== 'mcporter' && id !== 'sdk') return [`no route named ${id ?? '(none)'}: mcporter or sdk`];
    route = id;
    words.splice(ri, 2);
  }
  const split = words.indexOf('--');
  const command = split >= 0 ? words.slice(split + 1) : [];
  const head = split >= 0 ? words.slice(0, split) : words;
  const pick = (named: boolean): McpRouteId => route ?? (named ? 'mcporter' : (routes.find((r) => r.available)?.id ?? 'mcporter'));

  if (verb === 'routes' || verb === 'servers') {
    const lines: string[] = [];
    if (verb === 'routes') {
      lines.push('MCP TO CLI');
      for (const r of routes) lines.push(`  ${r.label.padEnd(24)} ${r.available ? 'installed' : 'needs setup'}  ${r.available ? r.details : `${r.details}; ${r.setup ?? ''}`}`);
      lines.push('');
    }
    const m = routes.find((r) => r.id === 'mcporter');
    if (m?.available) {
      const s = await listServers('mcporter', o);
      lines.push('SERVERS IN MCPORTER\'S CONFIG');
      if (!s.ok) lines.push(`  could not read them: ${s.error}`);
      else if (!s.servers.length) lines.push('  none configured');
      else for (const e of s.servers) lines.push(`  ${e.name.padEnd(24)} ${e.transport}${e.program ? ` · ${e.program}` : ''}${e.url ? ` · ${e.url}` : ''}${e.envNames?.length ? ` · env ${e.envNames.join(', ')}` : ''}${e.source ? ` · ${e.source}` : ''}`);
      lines.push('');
    }
    return verb === 'routes' ? [...lines, ...MCP_HELP] : lines;
  }

  if (verb === 'tools') {
    const ref: McpServerRef | null = command.length ? { command } : head[0] ? { name: head[0] } : null;
    if (!ref) return ['which server? /mcp tools <server>, or /mcp tools -- <command>'];
    const id = pick('name' in ref);
    const r = await listTools(id, ref, o);
    if (!r.ok) return [`${serverLabel(ref)} via ${id}: ${r.error}`];
    return [`${r.server} via ${id} · ${r.tools.length} tools · ${r.ms} ms${r.truncated ? ' · list cut' : ''}`,
      ...r.tools.map((t) => `  ${t.name}(${t.params.map((p) => (t.required.includes(p) ? p : `${p}?`)).join(', ')})${t.description ? `  ${t.description.split('\n')[0].slice(0, 100)}` : ''}`)];
  }

  if (verb === 'call') {
    const named = !command.length;
    const [first, second, third] = head;
    const ref: McpServerRef | null = named ? (first ? { name: first } : null) : { command };
    const tool = named ? second : first;
    const json = named ? third : second;
    if (!ref || !tool) return ['/mcp call <server> <tool> [json], or /mcp call <tool> [json] -- <command>'];
    let callArgs: Record<string, unknown> = {};
    if (json) {
      try { callArgs = JSON.parse(json) as Record<string, unknown>; } catch { return ['the arguments must be one JSON object, e.g. {"text":"hi"}']; }
      if (!callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs)) return ['the arguments must be one JSON object, e.g. {"text":"hi"}'];
    }
    const id = pick(named);
    const r = await callTool(id, ref, tool, callArgs, o);
    const head1 = `${r.server}.${r.tool} via ${id} · ${r.ok ? 'answered' : r.timedOut ? 'stopped' : 'failed'} · ${r.ms} ms · ${r.outputBytes} bytes${r.truncated ? ' · cut' : ''}`;
    return [head1, ...(r.ok ? (r.text ?? '').split('\n') : [`  ${r.error ?? 'failed'}`])];
  }

  return [`unknown: /mcp ${verb}`, ...MCP_HELP];
}
