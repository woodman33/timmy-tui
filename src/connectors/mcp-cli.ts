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
 *
 * The operator's own servers (R3), as MCPorter 0.12.4 finds them: `mcporter config list --json` (and
 * `--source import`) reads the files only, starting nothing: the home config (~/.mcporter/mcporter.json[c],
 * or $XDG_CONFIG_HOME/mcporter/), then the project's ./config/mcporter.json (or only $MCPORTER_CONFIG when
 * set), and the editor configs it imports (cursor, claude-code, claude-desktop, codex, windsurf, opencode,
 * vscode). A server is reached by its exact configured name, never MCPorter's nearest match, and a call
 * names an exact tool the server lists: MCPorter's own call retries a "Tool x not found" with the closest
 * name, which would run a tool nobody asked for. Every list and call passes --no-oauth: a server that wants
 * a sign-in answers "needs authorization" with MCPorter's own step, and Timmy never opens a browser for it.
 *
 * Round R4 (H34): every call is kept as a record with a receipt (./mcp-records.ts: .timmy/mcp/<call-id>/), its answer
 * is shown as content items, an error answer shows the server's own words, /mcp call takes its JSON as the rest of
 * the line, and a server URL is only ever shown or kept in its safe form (safeServerUrl). Tool annotations (the
 * server's own hints, such as readOnlyHint) come through the SDK route only: MCPorter 0.12.4 drops them from its
 * list (its dist/runtime.js listTools keeps a tool's name, description and schemas), so on its route they are not
 * known, and Timmy says so instead of guessing.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CapabilityRow } from '../capabilities/index.js';
import {
  answerLines, boundedAnnotations, cleanText, fitLines, hintWords, parseRouteJson, readRouteAnswer, routeAnswerOf, serverSaid, writeMcpCall,
  type McpCallFacts, type McpOutcome, type McpRecordContext, type McpRecordWritten, type RouteAnswer,
} from './mcp-records.js';

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
  /** local: an mcporter.json (the project's config/mcporter.json or the home one); import: an editor's own config. */
  origin?: 'local' | 'import';
  /** The editor an import came from, in MCPorter's words (cursor, claude-code, claude-desktop, codex, windsurf, opencode, vscode). */
  importKind?: string;
  /** The file it came from: relative to the project, or ~/ under the home folder; never an absolute home path. */
  source?: string;
  /** The sign-in its config names (oauth, refreshable_bearer). Configured, not checked. */
  auth?: string;
  /** What MCPorter found when it contacted the server (ok, auth, offline, http, error); only after /mcp servers --check. */
  status?: string;
  description?: string;
  /** The program a stdio server runs (its name only; arguments are not shown). */
  program?: string;
  /** An HTTP server's address in its safe form (safeServerUrl): no credentials, query or fragment, no identifier in its path. */
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
  /** R4 (H34): the server's own hints for the tool (readOnlyHint, destructiveHint, …), as it lists them: its claim, never checked. SDK route only. */
  annotations?: Record<string, boolean | number | string>;
}

/** An HTTP server wants a sign-in: Timmy never starts one; the answer carries MCPorter's own step. */
interface NeedsAuth { needsAuth?: true; authCommand?: string }
export interface McpServersAnswer { ok: boolean; route: McpRouteId; servers: McpServerEntry[]; ms?: number; error?: string }
export interface McpToolsAnswer extends NeedsAuth {
  ok: boolean; route: McpRouteId; server: string; ms: number; tools: McpToolEntry[]; truncated?: boolean; error?: string; timedOut?: boolean;
  /** Every tool's name, when the list itself was cut to the bound. */
  allNames?: string[];
}
export interface McpCallAnswer extends NeedsAuth {
  ok: boolean;
  route: McpRouteId;
  server: string;
  tool: string;
  ms: number;
  /** The route's parsed answer; left out when it would pass the bound. */
  result?: unknown;
  /** The tool's text (or the answer as JSON), at most 32 KB; a cut text ends with a marker. */
  text?: string;
  /** R4 (H34): on an error answer (isError), "the server said: " and the server's own first lines. */
  error?: string;
  /** R4 (H34): the server answered with its own error (isError: true). The call is failed. */
  isError?: true;
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
  const tools = ['list_mcp_tools', 'list_mcp_command_tools', 'call_mcp_tool'];
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
  // Round R3: TIMMY_MCP_HOME is the home whose MCP configuration MCPorter reads (~/.mcporter and the editors'
  // configs it imports), for a Timmy that runs with a home of its own (a sandbox) while the servers the person
  // configured live in their real home. Only HOME (USERPROFILE on Windows) changes; nothing else is read from it.
  const mcpHome = source.TIMMY_MCP_HOME?.trim();
  if (mcpHome && isAbsolute(mcpHome)) {
    out.HOME = mcpHome;
    if (process.platform === 'win32' || 'USERPROFILE' in out) out.USERPROFILE = mcpHome;
  }
  // No keep-alive daemon: every server stays a child of this call, inside its time limit.
  out.MCPORTER_DISABLE_KEEPALIVE = '*';
  out.MCPORTER_NO_SPINNER = '1';
  out.NO_COLOR = '1';
  return out;
}

/** R4 (H34): `stdoutBuf`, the bytes read (at most READ_LIMIT); `stdoutSha256`, the sha256 of every byte printed, read or not. */
interface RunOutcome { code: number | null; stdout: string; stdoutBuf: Buffer; stdoutBytes: number; stdoutSha256: string; readCut: boolean; stderrTail: string; timedOut: boolean; ms: number; spawnError?: string; stderrHit?: string }

const EMPTY_SHA256 = createHash('sha256').digest('hex');

function runProcess(argv: string[], o: { cwd?: string; env: Record<string, string>; timeoutMs: number; input?: string; watch?: RegExp }): Promise<RunOutcome> {
  const started = performance.now();
  return new Promise((resolveRun) => {
    const group = process.platform !== 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: group, windowsHide: true });
    } catch (e) {
      resolveRun({ code: null, stdout: '', stdoutBuf: Buffer.alloc(0), stdoutBytes: 0, stdoutSha256: EMPTY_SHA256, readCut: false, stderrTail: '', timedOut: false, ms: performance.now() - started, spawnError: (e as Error).message });
      return;
    }
    if (o.input !== undefined) { child.stdin?.on('error', () => { /* the route left early; its exit says why */ }); child.stdin?.end(o.input); }
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let kept = 0;
    let bytes = 0;
    let stderrTail = '';
    // A line the caller watches for, wherever it falls in the stream (the tail alone could lose it).
    let watchBuf = '';
    let stderrHit: string | undefined;
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    const stop = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { if (group) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ }
    };
    child.stdout?.on('data', (d: Buffer) => {
      bytes += d.length;
      hash.update(d);
      if (kept < READ_LIMIT) { const take = d.subarray(0, READ_LIMIT - kept); chunks.push(take); kept += take.length; }
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stderrTail = (stderrTail + s).slice(-4000);
      if (o.watch && stderrHit === undefined) {
        watchBuf = (watchBuf + s).slice(-2000);
        const line = watchBuf.split('\n').find((l) => o.watch!.test(l));
        if (line) stderrHit = line.trim().slice(0, 300);
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 1500).unref();
    }, o.timeoutMs);
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      resolveRun({ code, stdout: buf.toString('utf8'), stdoutBuf: buf, stdoutBytes: bytes, stdoutSha256: hash.digest('hex'), readCut: bytes > kept, stderrTail, timedOut, ms: performance.now() - started, ...(spawnError ? { spawnError } : {}), ...(stderrHit ? { stderrHit } : {}) });
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

// MCPorter prints its JSON as one block whose first line opens with "{" (after any stderr of the server's): read from there.
const parseJson = parseRouteJson;

// ── safe server URLs (R4, H34) ───────────────────────────────────────────────────

/** A path segment kept as it is: a plain word (letters, dots, dashes, underscores; no digits; at most 24), or a version (v1). */
const PLAIN_SEGMENT = /^[A-Za-z._-]{1,24}$/;
const VERSION_SEGMENT = /^v\d{1,4}$/;

/**
 * A server's URL as Timmy shows and keeps it: scheme://host[:port], then the path with every segment that is not a
 * plain word or a version replaced by "…" (a gateway key, an account id, a token in the path); never the userinfo,
 * the query or the fragment. https://gw.example.com/mcp/gateways/sk/usergw-0a1b…/mcp is shown as
 * https://gw.example.com/mcp/gateways/sk/…/mcp. Anything that is not a URL is "(not a valid address)".
 */
export function safeServerUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return '(not a valid address)'; }
  if (!u.host) return `${u.protocol}//…`;
  const path = u.pathname.split('/').map((seg, i) => (i === 0 || seg === '' || PLAIN_SEGMENT.test(seg) || VERSION_SEGMENT.test(seg) ? seg : '…')).join('/');
  return `${u.protocol}//${u.host}${path}`;
}

/** Every URL in a text (a route's error, a server's status) in its safe form. */
export const scrubUrls = (text: string): string => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()[\]{}`]+/gi, (m) => safeServerUrl(m));

/**
 * The private parts of a configured server's URL (userinfo, query values, path segments safeServerUrl hides), long
 * enough to look for in what a route prints: a server or MCPorter that echoes its own address would otherwise put a
 * gateway key into an answer, a record or the agent's context. Held in memory only, never written.
 */
export function urlSecrets(url: string): string[] {
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  const parts = new Set<string>();
  const add = (v: string, min: number): void => {
    for (const x of [v, (() => { try { return decodeURIComponent(v); } catch { return v; } })()]) if (x.length >= min) parts.add(x);
  };
  add(u.username, 6);
  add(u.password, 6);
  for (const [, v] of u.searchParams) add(v, 8);
  for (const seg of u.pathname.split('/')) if (seg && !PLAIN_SEGMENT.test(seg) && !VERSION_SEGMENT.test(seg)) add(seg, 8);
  // Longest first, so a part that holds another is replaced whole.
  return [...parts].sort((a, b) => b.length - a.length);
}

/** A text with every private part replaced by "…", and how many were. */
export function redactParts(text: string, parts: readonly string[]): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const p of parts) {
    const pieces = out.split(p);
    count += pieces.length - 1;
    out = pieces.join('…');
  }
  return { text: out, count };
}

/** A configured server's private URL parts, by its entry (a WeakMap: never serialized with the entry). */
const PRIVATE_PARTS = new WeakMap<McpServerEntry, string[]>();

const stderrLine = (tail: string): string => {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /\b\w*Error\b/.test(l)) ?? lines[lines.length - 1] ?? '').slice(0, 300);
};

function failure(run: RunOutcome, timeoutMs: number, fallback: string): { error: string; timedOut?: boolean } {
  if (run.timedOut) return { error: `no answer within ${Math.round(timeoutMs / 1000)} s; stopped the route and its server`, timedOut: true };
  if (run.spawnError) return { error: `could not start: ${run.spawnError}` };
  const said = scrubUrls(stderrLine(run.stderrTail));
  return { error: said ? `${fallback} (${said})` : fallback };
}

const noRoute = (route: McpRouteId, r: McpRoute | undefined): string => `${r?.label ?? route} is not available here${r?.setup ? `: ${r.setup}` : ''}`;
const sdkNeedsCommand = (ref: { name: string }): string => `the SDK route runs ad-hoc servers only, from a command line after --; "${ref.name}" is a name in MCPorter's config: use the mcporter route (the default for a name)`;

/** The answer for a server that wants a sign-in: MCPorter's own step, which only the operator runs. */
const needsAuthorization = (authCommand: string): string =>
  `needs authorization: MCPorter says run "${authCommand}" in a terminal, in this project's folder (it signs in through a browser; add --no-browser for a link instead). Timmy did not start a sign-in.`;

/** The home folder MCPorter's child sees (os.homedir() there reads HOME, or USERPROFILE on Windows). */
const homeOf = (env: Env): string => env.HOME || env.USERPROFILE || homedir();

/**
 * A config file's place, for the screen and the model: relative to the project when it is inside it, ~/ under the
 * home folder, else only its last two parts. Never an absolute home path. Both the given and the real folder are
 * tried, since MCPorter resolves the project through the real one (macOS: /var is /private/var).
 */
export function shownConfigPath(file: string, where: { cwd?: string; home?: string }): string {
  if (!file || !isAbsolute(file)) return file;
  const real = (p?: string): string[] => {
    if (!p) return [];
    try { const r = realpathSync(p); return r === p ? [p] : [p, r]; } catch { return [p]; }
  };
  const under = (bases: string[]): string | null => {
    for (const b of bases) {
      const rel = relative(b, file);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
    }
    return null;
  };
  const homes = real(where.home);
  const inHome = under(homes);
  const project = under(real(where.cwd));
  // A project inside the home folder shows its own files relative to itself; a project at or above the home
  // folder (a run from / or from home) would print the user's folder name, so ~/ wins there.
  const projectInsideHome = where.cwd ? homes.some((h) => { const rel = relative(h, where.cwd!); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); }) : false;
  if (project && (!inHome || projectInsideHome)) return project;
  if (inHome) return `~/${inHome}`;
  const parts = file.split(/[\\/]/).filter(Boolean);
  return `…/${parts.slice(-2).join('/')}`;
}

function serverEntry(s: Record<string, unknown>, where: { cwd?: string; home?: string }): McpServerEntry {
  const e: McpServerEntry = { name: String(s.name ?? ''), transport: String(s.transport ?? (s.command ? 'stdio' : 'http')) };
  const src = s.source as { kind?: string; path?: string; importKind?: string } | undefined;
  e.origin = src?.kind === 'import' ? 'import' : 'local';
  if (typeof src?.importKind === 'string') e.importKind = src.importKind;
  if (typeof src?.path === 'string' && src.path) e.source = shownConfigPath(src.path, where);
  if (typeof s.auth === 'string' && s.auth) e.auth = s.auth;
  if (typeof s.description === 'string') e.description = scrubUrls(s.description).slice(0, 200);
  if (typeof s.command === 'string') e.program = basename(s.command);
  const url = typeof s.baseUrl === 'string' ? s.baseUrl : typeof s.url === 'string' ? s.url : undefined;
  // R4 (H34): a gateway key or an account name can sit in the path itself: only the safe form is ever kept.
  if (url) { e.url = safeServerUrl(url); PRIVATE_PARTS.set(e, urlSecrets(url)); }
  // Names only: an editor's config often holds the values themselves (keys, bearer tokens).
  const envNames = s.env && typeof s.env === 'object' ? Object.keys(s.env) : [];
  if (envNames.length) e.envNames = envNames;
  const headerNames = s.headers && typeof s.headers === 'object' ? Object.keys(s.headers).filter((h) => h.toLowerCase() !== 'accept') : [];
  if (headerNames.length) e.headerNames = headerNames;
  return e;
}

/**
 * The servers a route knows by name. Only MCPorter keeps such a list: its config files and the editor configs it
 * imports, read from the files (`config list` starts no server and contacts none). Names, never secrets.
 */
export async function listServers(route: McpRouteId, o: McpRunOptions = {}): Promise<McpServersAnswer> {
  const r = routeFor(route, o.seams, o.env);
  if (!r?.hasConfig) return { ok: false, route, servers: [], error: 'the SDK route keeps no list of servers: give a server as a command line' };
  if (!r.available || !r.argv) return { ok: false, route, servers: [], error: noRoute(route, r) };
  const timeoutMs = o.timeoutMs ?? 30_000;
  const source = o.env ?? process.env;
  const env = childEnv(source, o.passEnv);
  const where = { cwd: o.cwd ?? process.cwd(), home: homeOf(env) };
  // `config list --json` shows MCPorter's own (local) entries only; `--source import` shows the editors'.
  const runs = await Promise.all([[], ['--source', 'import']].map((more) => runProcess([...r.argv!, 'config', 'list', '--json', ...more], { cwd: o.cwd, env, timeoutMs })));
  const ms = Math.max(1, Math.round(Math.max(...runs.map((x) => x.ms))));
  const servers: McpServerEntry[] = [];
  const seen = new Set<string>();
  for (const [i, run] of runs.entries()) {
    const parsed = parseJson(run.stdout);
    if (run.timedOut || run.code !== 0 || !parsed.ok) return { ok: false, route, servers: [], ms, ...failure(run, timeoutMs, `mcporter config list${i ? ' --source import' : ''} failed (exit ${run.code})`) };
    for (const s of ((parsed.value as { servers?: unknown[] }).servers ?? []) as Array<Record<string, unknown>>) {
      const e = serverEntry(s, where);
      // MCPorter's merge already gives each name one winner; a repeat would only be a second listing of it.
      if (e.name && !seen.has(e.name)) { seen.add(e.name); servers.push(e); }
    }
  }
  return { ok: true, route, servers, ms };
}

/**
 * A configured server by its exact name, or why not. MCPorter itself would take a near miss ("echo-locl") as the
 * closest name and start that server; Timmy starts only the one asked for.
 */
async function configuredServer(name: string, o: McpRunOptions): Promise<{ entry: McpServerEntry } | { error: string }> {
  const s = await listServers('mcporter', { ...o, timeoutMs: Math.min(o.timeoutMs ?? 30_000, 30_000) });
  if (!s.ok) return { error: `could not read MCPorter's config: ${s.error}` };
  const entry = s.servers.find((e) => e.name === name);
  if (entry) return { entry };
  const names = s.servers.map((e) => e.name);
  return { error: `no server named "${name}" in MCPorter's config or editor imports (${names.length ? `configured: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}` : 'none configured'}); nothing was started` };
}

function toolEntries(raw: unknown[]): McpToolEntry[] {
  return raw.map((t) => {
    const tool = t as { name?: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] }; annotations?: unknown };
    const e: McpToolEntry = { name: String(tool.name ?? ''), required: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema!.required!.map(String) : [], params: Object.keys(tool.inputSchema?.properties ?? {}) };
    if (tool.description) e.description = tool.description.slice(0, 500);
    if (tool.inputSchema) e.inputSchema = tool.inputSchema;
    // R4 (H34): the server's own hints, when the route passes them on (the SDK route does; MCPorter 0.12.4's list drops them).
    const hints = boundedAnnotations(tool.annotations);
    if (hints && Object.keys(hints).length) e.annotations = hints;
    return e;
  });
}

/** Why a tool's annotations are not known on MCPorter's route, said where they would be. */
export const MCPORTER_DROPS_HINTS = "not known on this route: MCPorter 0.12.4 drops the server's tool annotations from its list (it keeps a tool's name, description and schemas)";

/** A server's tools, through one route. A name must be one MCPorter's config holds exactly. */
export async function listTools(route: McpRouteId, server: McpServerRef, o: McpRunOptions = {}): Promise<McpToolsAnswer> {
  return (await listToolsWith(route, server, o)).answer;
}

/** listTools, and the configured server's entry (its transport and safe URL) when a name was given and found. */
async function listToolsWith(route: McpRouteId, server: McpServerRef, o: McpRunOptions): Promise<{ answer: McpToolsAnswer; entry?: McpServerEntry }> {
  const label = serverLabel(server);
  const r = routeFor(route, o.seams, o.env);
  if (!r?.available || !r.argv) return { answer: { ok: false, route, server: label, ms: 0, tools: [], error: noRoute(route, r) } };
  if (route === 'sdk' && 'name' in server) return { answer: { ok: false, route, server: label, ms: 0, tools: [], error: sdkNeedsCommand(server) } };
  if ('command' in server && !server.command.length) return { answer: { ok: false, route, server: label, ms: 0, tools: [], error: 'the command line is empty' } };
  const started = performance.now();
  let entry: McpServerEntry | undefined;
  if ('name' in server) {
    const found = await configuredServer(server.name, o);
    if ('error' in found) return { answer: { ok: false, route, server: label, ms: Math.max(1, Math.round(performance.now() - started)), tools: [], error: found.error } };
    entry = found.entry;
  }
  const answer = await listedTools(route, server, label, r.argv, o, started);
  // R4 (H34): a configured server's own address, echoed in an error, keeps no private part of it.
  const parts = entry ? PRIVATE_PARTS.get(entry) ?? [] : [];
  if (parts.length && answer.error) answer.error = redactParts(answer.error, parts).text;
  return { answer, ...(entry ? { entry } : {}) };
}

async function listedTools(route: McpRouteId, server: McpServerRef, label: string, routeArgv: string[], o: McpRunOptions, started: number): Promise<McpToolsAnswer> {
  const r = { argv: routeArgv };
  const timeoutMs = o.timeoutMs ?? 30_000;
  const inner = String(timeoutMs + 2000);
  // --no-oauth: cached sign-ins only; a server that wants a new one says so instead of opening a browser.
  const argv = route === 'mcporter'
    ? [...r.argv, 'list', ...('name' in server ? [server.name] : mcporterServerArgs(server)), '--json', '--no-oauth', '--timeout', inner]
    : [...r.argv, 'tools', '--json', '--timeout', inner, '--', ...(server as { command: string[] }).command];
  const cwd = 'command' in server && server.cwd && route === 'sdk' ? server.cwd : o.cwd;
  const run = await runProcess(argv, { cwd, env: childEnv(o.env ?? process.env, o.passEnv), timeoutMs });
  const ms = Math.max(1, Math.round(performance.now() - started));
  const parsed = parseJson(run.stdout);
  if (run.timedOut || !parsed.ok) return { ok: false, route, server: label, ms, tools: [], ...failure(run, timeoutMs, `no tool list came back (exit ${run.code})`) };
  const v = parsed.value as { ok?: boolean; name?: string; status?: string; tools?: unknown[]; error?: string; authCommand?: string; issue?: { kind?: string; rawMessage?: string } };
  if (route === 'mcporter' && (v.status === 'auth' || v.issue?.kind === 'auth')) {
    const authCommand = typeof v.authCommand === 'string' && v.authCommand ? v.authCommand : `mcporter auth ${label}`;
    return { ok: false, route, server: label, ms, tools: [], needsAuth: true, authCommand, error: needsAuthorization(authCommand) };
  }
  const failed = route === 'mcporter' ? v.status !== 'ok' : v.ok !== true;
  if (failed) return { ok: false, route, server: label, ms, tools: [], error: scrubUrls(String(v.error ?? v.issue?.rawMessage ?? (v.status ? `the server is ${v.status}` : 'the route failed'))) };
  // The list must be the named server's own: MCPorter answers with the name it resolved.
  if ('name' in server && typeof v.name === 'string' && v.name !== server.name) return { ok: false, route, server: label, ms, tools: [], error: `MCPorter answered for "${v.name}", not "${server.name}"` };
  let tools = toolEntries(v.tools ?? []);
  const allNames = tools.map((t) => t.name);
  let truncated = false;
  // Over the bound: first the schemas go, then long descriptions are shortened, and only then tools.
  if (JSON.stringify(tools).length > MCP_OUTPUT_LIMIT) {
    truncated = true;
    tools = tools.map(({ inputSchema: _schema, ...rest }) => rest);
    if (JSON.stringify(tools).length > MCP_OUTPUT_LIMIT) tools = tools.map((t) => (t.description && t.description.length > 120 ? { ...t, description: `${t.description.slice(0, 119)}…` } : t));
    while (tools.length && JSON.stringify(tools).length > MCP_OUTPUT_LIMIT) tools.pop();
  }
  return { ok: true, route, server: label, ms, tools, ...(truncated ? { truncated, ...(tools.length < allNames.length ? { allNames } : {}) } : {}) };
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
  return b.length <= limit ? s : b.subarray(0, limit).toString('utf8').replace(/\uFFFD+$/, '');
}

/** MCPorter's line when its call has swapped the asked-for tool for the closest name. */
const AUTO_CORRECTED = /Auto-corrected tool call to/i;

/** A route's run with a server URL's private parts replaced in what it printed (its byte count and sha256 stay the raw ones). */
function withoutParts(run: RunOutcome, parts: readonly string[]): RunOutcome & { redacted: number } {
  if (!parts.length) return { ...run, redacted: 0 };
  const out = redactParts(run.stdout, parts);
  const err = redactParts(run.stderrTail, parts);
  if (!out.count && !err.count) return { ...run, redacted: 0 };
  return { ...run, stdout: out.text, stdoutBuf: Buffer.from(out.text, 'utf8'), stderrTail: err.text, ...(run.stderrHit ? { stderrHit: redactParts(run.stderrHit, parts).text } : {}), redacted: out.count };
}

/** R4 (H34): what one call ran to: the bounded answer, the facts its record keeps, and the route's whole output to show. */
export interface McpCallRun {
  answer: McpCallAnswer;
  facts: McpCallFacts;
  /** what the route printed for the call (at most what Timmy reads); absent when no answer may be shown */
  stdout?: string;
}

/**
 * Call one tool on a server, through one route, with a time limit and a bounded answer. On the MCPorter route the
 * server's own list must hold the tool by its exact name before the call runs (one more start of the server, within
 * the same time limit): MCPorter's call would otherwise answer a misspelling by calling the closest tool.
 */
export async function callTool(route: McpRouteId, server: McpServerRef, tool: string, args: Record<string, unknown> = {}, o: McpRunOptions = {}): Promise<McpCallAnswer> {
  return (await runToolCall(route, server, tool, args, o)).answer;
}

/**
 * R4 (H34): one call, and its record (.timmy/mcp/<call-id>/) with its `mcp.call` receipt when `record` says where.
 * The REPL's /mcp call and the agent's call_mcp_tool both come here, so both keep the same record.
 */
export async function callAndRecord(route: McpRouteId, server: McpServerRef, tool: string, args: Record<string, unknown>, o: McpRunOptions, record?: McpRecordContext): Promise<{ run: McpCallRun; record?: McpRecordWritten }> {
  const run = await runToolCall(route, server, tool, args, o);
  return { run, ...(record ? { record: writeMcpCall(record, run.facts) } : {}) };
}

/** The server's own first lines of an error answer, for the answer's error: "the server said: …", bounded. */
const saidError = (answer: RouteAnswer, route: McpRouteId): string | undefined => {
  const lines = serverSaid(answer, route).filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1));
  if (!lines.length) return undefined;
  return `the server said: ${lines.slice(0, 12).join('\n')}${lines.length > 12 ? `\n… ${lines.length - 12} more lines` : ''}`;
};

/** callTool, with what its record keeps. Never throws for a server's or a route's failure: the answer says it. */
export async function runToolCall(route: McpRouteId, server: McpServerRef, tool: string, args: Record<string, unknown> = {}, o: McpRunOptions = {}): Promise<McpCallRun> {
  const label = serverLabel(server);
  const base = { route, server: label, tool };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const spent = (): number => Math.max(1, Math.round(performance.now() - started));
  const source = o.env ?? process.env;
  // Kept in the record with the home folder as ~ (a route's error can name a server's script by its path).
  const homes = [...new Set([homeOf(childEnv(source)), homedir()])].filter((h) => h && h !== '/' && h.length > 1);
  const tilde = (s: string): string => homes.reduce((t, h) => t.split(h).join('~'), s);
  let shown: McpCallFacts['server'] = { name: label, transport: 'command' in server ? 'stdio' : 'unknown' };
  let secrets: string[] = [];
  let redacted = 0;
  let annotations: McpCallFacts['annotations'] = null;
  let annotationsNote: string | undefined = route === 'mcporter' ? MCPORTER_DROPS_HINTS : 'not read: no tool list came back in this call';
  const notes: string[] = [];
  const finish = (answer: McpCallAnswer, more: { called?: boolean; isError?: boolean | null; run?: RunOutcome; show?: boolean } = {}): McpCallRun => {
    const outcome: McpOutcome = answer.ok ? 'answered' : answer.needsAuth ? 'needs authorization' : answer.timedOut ? 'stopped' : 'failed';
    const run = more.run;
    // bytes and sha256: what the route printed; kept: output.json's bytes (any private URL part already replaced).
    const output = run && !run.spawnError
      ? { bytes: run.stdoutBytes, sha256: run.stdoutSha256, kept: Buffer.from(run.stdoutBuf.subarray(0, MCP_OUTPUT_LIMIT)), truncated: run.stdoutBuf.length > MCP_OUTPUT_LIMIT || run.readCut, ...(redacted ? { redacted } : {}) }
      : undefined;
    if (secrets.length && answer.error) answer.error = redactParts(answer.error, secrets).text;
    const passEnv = (o.passEnv ?? []).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
    return {
      answer,
      ...(run && more.show !== false ? { stdout: run.stdout } : {}),
      facts: {
        route, server: shown, tool, args, ...(passEnv.length ? { passEnv } : {}), startedAt, endedAt: new Date().toISOString(), ms: answer.ms, outcome,
        called: more.called ?? false, isError: more.isError ?? null, ...(answer.error ? { error: tilde(answer.error) } : {}), ...(output ? { output } : {}),
        annotations, ...(annotationsNote ? { annotationsNote } : {}), notes,
      },
    };
  };
  const r = routeFor(route, o.seams, o.env);
  if (!r?.available || !r.argv) return finish({ ok: false, ...base, ms: 0, outputBytes: 0, error: noRoute(route, r) });
  if (route === 'sdk' && 'name' in server) return finish({ ok: false, ...base, ms: 0, outputBytes: 0, error: sdkNeedsCommand(server) });
  if ('command' in server && !server.command.length) return finish({ ok: false, ...base, ms: 0, outputBytes: 0, error: 'the command line is empty' });
  if (!tool) return finish({ ok: false, ...base, ms: 0, outputBytes: 0, error: 'no tool named' });
  const timeoutMs = o.timeoutMs ?? 60_000;
  let callMs = timeoutMs;
  if (route === 'mcporter') {
    // The name check happens inside listTools; nothing starts for a name the config does not hold exactly.
    const listed = await listToolsWith('mcporter', server, { ...o, timeoutMs: Math.min(timeoutMs, 30_000) });
    if (listed.entry) {
      shown = { name: label, transport: listed.entry.transport, ...(listed.entry.url ? { url: listed.entry.url } : {}) };
      secrets = PRIVATE_PARTS.get(listed.entry) ?? [];
    }
    const l = listed.answer;
    if (!l.ok) {
      const why = l.timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s while reading its tools; stopped the route and its server` : l.error ?? 'its tools could not be read';
      const error = l.needsAuth || /nothing was (started|called)/.test(why) ? why : `${why}; nothing was called`;
      return finish({ ok: false, ...base, ms: spent(), outputBytes: 0, error, ...(l.timedOut ? { timedOut: true } : {}), ...(l.needsAuth ? { needsAuth: true, authCommand: l.authCommand } : {}) });
    }
    const names = l.allNames ?? l.tools.map((t) => t.name);
    if (!names.includes(tool)) {
      return finish({ ok: false, ...base, ms: spent(), outputBytes: 0, error: `no tool named "${tool}" on ${label} (${names.length ? `its tools: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', …' : ''}` : 'it lists none'}); nothing was called` });
    }
    callMs = Math.max(1000, timeoutMs - spent());
  }
  const inner = String(callMs + 2000);
  // The arguments travel on stdin (`--args -`, which both routes read), never on the process list.
  const payload = JSON.stringify(args ?? {});
  const argv = route === 'mcporter'
    ? [...r.argv, 'call', ...('name' in server ? ['--server', server.name] : mcporterServerArgs(server)), '--tool', tool, '--args', '-', '--output', 'json', '--no-oauth', '--timeout', inner]
    : [...r.argv, 'call', tool, '--args', '-', '--json', '--timeout', inner, '--', ...(server as { command: string[] }).command];
  const cwd = 'command' in server && server.cwd && route === 'sdk' ? server.cwd : o.cwd;
  const printed = await runProcess(argv, { cwd, env: childEnv(source, o.passEnv), timeoutMs: callMs, input: payload, ...(route === 'mcporter' ? { watch: AUTO_CORRECTED } : {}) });
  const run = withoutParts(printed, secrets);
  redacted = run.redacted;
  if (redacted) notes.push(`${redacted} private part${redacted === 1 ? '' : 's'} of the server's URL in what the route printed ${redacted === 1 ? 'was' : 'were'} replaced by "…" (output_sha256 is of the bytes as printed)`);
  const ms = spent();
  const outputBytes = run.stdoutBytes;
  const called = !run.spawnError;
  if (run.timedOut || run.spawnError) return finish({ ok: false, ...base, ms, outputBytes, ...failure(run, timeoutMs, 'the route failed') }, { called, run });
  // Should the server's list have changed between the check and the call, MCPorter's correction still shows here.
  if (run.stderrHit) {
    notes.push('MCPorter called a different tool than the one asked for; its answer is kept in output.json and not shown');
    return finish({ ok: false, ...base, ms, outputBytes, error: `MCPorter called a different tool than "${tool}" (${run.stderrHit}); its answer is not shown` }, { called, run, show: false });
  }
  const parsed = run.readCut ? { ok: false as const } : parseJson(run.stdout);
  let ok: boolean;
  let result: unknown;
  let error: string | undefined;
  let isError: boolean | null = null;
  // What the answer is, read once: for the server's own words, and for what MCPorter's JSON output holds.
  const shape: RouteAnswer = parsed.ok ? routeAnswerOf(parsed.value, route) : { kind: 'none' };
  if (parsed.ok) {
    const v = parsed.value as Record<string, unknown> | null;
    if (route === 'sdk') {
      ok = v?.ok === true;
      result = v?.result;
      const res = v?.result as { isError?: unknown } | undefined;
      isError = res && typeof res === 'object' ? res.isError === true : ok ? false : null;
      if (!ok) error = (isError ? saidError(shape, route) : undefined) ?? scrubUrls(String(v?.error ?? 'the call failed'));
      // The server's own entry for the tool, read by Timmy's SDK command in the same session before the call.
      const listedTool = v?.tool;
      if (listedTool && typeof listedTool === 'object') {
        annotations = boundedAnnotations((listedTool as { annotations?: unknown }).annotations) ?? {};
        annotationsNote = Object.keys(annotations).length ? undefined : 'the server lists this tool without annotations';
      } else if (listedTool === null) annotationsNote = "the tool is not on the server's own list";
      else if (typeof v?.tool_list_error === 'string') annotationsNote = `the server's tool list could not be read: ${scrubUrls(v.tool_list_error).slice(0, 200)}`;
    } else if (run.code !== 0) {
      const issue = v?.issue as { kind?: string; rawMessage?: string } | undefined;
      if (issue?.kind === 'auth') {
        // MCPorter's call names its step on stderr ("Run 'mcporter auth <server>'"); the server's name is the fallback.
        const authCommand = /Run '([^']+)'/.exec(run.stderrTail)?.[1] ?? `mcporter auth ${label}`;
        return finish({ ok: false, ...base, ms, outputBytes, needsAuth: true, authCommand, error: needsAuthorization(authCommand) }, { called, run });
      }
      ok = false;
      if (shape.kind === 'issue' || shape.kind === 'none') {
        // MCPorter's own failure ({ server, tool, error, issue }): the route's words, not the server's answer.
        error = scrubUrls(String(v?.error ?? issue?.rawMessage ?? `mcporter exited ${run.code}`));
      } else {
        // MCPorter exits 1 after printing a tool's error answer (isError): that answer is the server's own words.
        isError = true;
        result = v;
        error = saidError(shape, route) ?? `mcporter exited ${run.code}`;
        if (shape.kind === 'json') notes.push("isError is told by MCPorter's exit 1: its JSON output holds the answer's JSON, not the result's own isError field");
      }
    } else {
      result = v;
      ok = !(v && typeof v === 'object' && (v as { isError?: boolean }).isError === true);
      isError = !ok;
      if (!ok) error = saidError(shape, route) ?? textOf(v);
    }
  } else if (run.code === 0 && run.stdout.trim()) {
    // Plain text, or more than Timmy reads: the text is the answer.
    ok = true;
    result = undefined;
    notes.push(run.readCut ? `the route printed more than Timmy reads (${READ_LIMIT / 1024 / 1024} MB); the answer was not read as JSON` : 'the route printed text, not JSON');
  } else {
    return finish({ ok: false, ...base, ms, outputBytes, ...failure(run, timeoutMs, `the route failed (exit ${run.code})`) }, { called, run });
  }
  if (route === 'mcporter' && shape.kind === 'json') {
    notes.push("MCPorter's JSON output holds the answer's structuredContent, or its text read as JSON, not the result itself");
  }
  let text = parsed.ok ? (result === undefined ? undefined : textOf(result)) : run.stdout;
  let truncated = run.readCut;
  if (result !== undefined && JSON.stringify(result).length > MCP_OUTPUT_LIMIT) { result = undefined; truncated = true; }
  if (text !== undefined && Buffer.byteLength(text, 'utf8') > MCP_OUTPUT_LIMIT) { text = cutUtf8(text, MCP_OUTPUT_LIMIT); truncated = true; }
  if (truncated && text !== undefined) text = `${text}\n[cut: ${outputBytes.toLocaleString('en-US')} bytes in all, the first 32 KB shown]`;
  if (error) error = cutUtf8(error, 2000);
  const answer: McpCallAnswer = { ok, ...base, ms, outputBytes, ...(result !== undefined ? { result } : {}), ...(text !== undefined ? { text } : {}), ...(error ? { error } : {}), ...(isError ? { isError: true as const } : {}), ...(truncated ? { truncated } : {}) };
  return finish(answer, { called, isError, run });
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

// R4 (H34): /mcp call takes its JSON as the rest of the line, as typed: splitCommandLine would strip its double quotes.

/** A /mcp call line, read: the route asked for, the server (a name, or a command line after --), the tool, its arguments. */
export type McpCallLine =
  | { ok: true; route?: McpRouteId; server?: string; command?: string[]; tool: string; args: Record<string, unknown> }
  | { ok: false; error: string };

const CALL_USAGE = '/mcp call <server> <tool> [json], or /mcp call [--route sdk] <tool> [json] -- <command>';
const exampleCall = (o: { server?: string; tool?: string; command?: boolean }): string => (o.command
  ? `/mcp call ${o.tool ?? '<tool>'} {"text":"hi there"} -- <command>`
  : `/mcp call ${o.server ?? '<server>'} ${o.tool ?? '<tool>'} {"text":"hi there"}`);
const argsHint = (o: { server?: string; tool?: string; command?: boolean }): string =>
  `Give one JSON object after the tool, as it is or in single quotes, e.g. ${exampleCall(o)}`;

/** One word from s at i, quotes as a shell reads them; where it ends. */
function wordAt(s: string, i: number): { word: string; end: number } {
  let cur = '';
  let quote: '"' | "'" | null = null;
  let j = i;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) break;
    cur += ch;
  }
  return { word: cur, end: j };
}

/** Just past the JSON value that opens at s[i] ('{' or '['), strings and escapes respected; -1 when it never closes. */
function jsonEnd(s: string, i: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

/** The JSON text that starts at s[i]: as it is, or inside single quotes (an apostrophe inside its strings allowed). */
function takeJson(s: string, i: number): { text: string; end: number } | { error: string } {
  if (s[i] === "'") {
    const open = s.indexOf('{', i);
    const close = open < 0 ? -1 : jsonEnd(s, open);
    const after = close < 0 ? null : /^\s*'/.exec(s.slice(close));
    if (after) return { text: s.slice(open, close), end: close + after[0].length };
    const q = s.indexOf("'", i + 1);
    if (q < 0) return { error: 'the single quote before the arguments is not closed' };
    return { text: s.slice(i + 1, q), end: q + 1 };
  }
  const close = jsonEnd(s, i);
  if (close > 0) return { text: s.slice(i, close), end: close };
  // It never closes: everything up to a command (" -- ") or the end is what was meant; the JSON reader names the problem.
  const sepAt = s.slice(i).search(/\s--(\s|$)/);
  return sepAt < 0 ? { text: s.slice(i), end: s.length } : { text: s.slice(i, i + sepAt), end: i + sepAt };
}

/** Arguments from their JSON text: one object, or why not, with an example that works. */
function argsFromJson(text: string, ctx: { server?: string; tool?: string; command?: boolean }): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 240);
    return { ok: false, error: `the arguments are not valid JSON: ${why}. ${argsHint(ctx)}` };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: `the arguments must be one JSON object, not ${Array.isArray(v) ? 'an array' : v === null ? 'null' : `a ${typeof v}`}. ${argsHint(ctx)}` };
  }
  return { ok: true, args: v as Record<string, unknown> };
}

/**
 * The words after `/mcp call`, as typed: `[--route <id>] <server> <tool> [json]` or `[--route <id>] <tool> [json] --
 * <command>`. The JSON is read as it was typed, so it may hold spaces and double quotes; single quotes around it are
 * read as a shell would. After the JSON only `-- <command>` may follow.
 */
export function parseCallLine(rest: string): McpCallLine {
  const s = rest;
  const isSep = (j: number): boolean => s.startsWith('--', j) && (j + 2 >= s.length || /\s/.test(s[j + 2]));
  const words: string[] = [];
  let route: string | undefined;
  let jsonText: string | undefined;
  let command: string[] | undefined;
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (isSep(i)) { command = splitCommandLine(s.slice(i + 2)); break; }
    if (s[i] === '{' || (s[i] === "'" && /^'\s*\{/.test(s.slice(i)))) {
      if (jsonText !== undefined) return { ok: false, error: `give the arguments once, as one JSON object. ${argsHint({ server: words[0], tool: words[1] })}` };
      const t = takeJson(s, i);
      if ('error' in t) return { ok: false, error: `${t.error}. ${argsHint({ server: words[0], tool: words[1] })}` };
      jsonText = t.text;
      i = t.end;
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j < s.length && !isSep(j)) {
        const extra = s.slice(j, j + 24);
        return { ok: false, error: `only "-- <command>" may follow the JSON arguments, not "${extra}${s.length > j + 24 ? '…' : ''}". ${argsHint({ server: words[0], tool: words[1] })}` };
      }
      continue;
    }
    const w = wordAt(s, i);
    i = w.end;
    if (w.word === '--route') {
      while (i < s.length && /\s/.test(s[i])) i++;
      const id = wordAt(s, i);
      i = id.end;
      route = id.word;
      continue;
    }
    words.push(w.word);
  }
  if (route !== undefined && route !== 'mcporter' && route !== 'sdk') return { ok: false, error: `no route named ${route || '(none)'}: mcporter or sdk` };
  return callLineFrom(words, command, route as McpRouteId | undefined, jsonText);
}

/** The call from its words: a name and a tool (or a tool and a command line), and the JSON text when there is one. */
function callLineFrom(words: string[], command: string[] | undefined, route: McpRouteId | undefined, jsonText: string | undefined): McpCallLine {
  if (command !== undefined) {
    if (!command.length) return { ok: false, error: `give the server as a command line after --: ${CALL_USAGE}` };
    if (!words.length) return { ok: false, error: `which tool? ${CALL_USAGE}` };
    if (words.length > 1) return { ok: false, error: `with -- <command>, name only the tool before the JSON, not "${words.join(' ')}". ${argsHint({ tool: words[words.length - 1], command: true })}` };
    const a = jsonText === undefined ? { ok: true as const, args: {} } : argsFromJson(jsonText, { tool: words[0], command: true });
    return a.ok ? { ok: true, ...(route ? { route } : {}), command, tool: words[0], args: a.args } : a;
  }
  if (words.length < 2) return { ok: false, error: CALL_USAGE };
  if (words.length > 2) return { ok: false, error: `the arguments must be one JSON object after the tool, not "${words.slice(2).join(' ').slice(0, 40)}". ${argsHint({ server: words[0], tool: words[1] })}` };
  const a = jsonText === undefined ? { ok: true as const, args: {} } : argsFromJson(jsonText, { server: words[0], tool: words[1] });
  return a.ok ? { ok: true, ...(route ? { route } : {}), server: words[0], tool: words[1], args: a.args } : a;
}

const MCP_HELP = [
  '/mcp                                   the routes, and how many servers are configured',
  '/mcp servers [--check]                 the configured servers (--check contacts each one)',
  '/mcp tools <server>                    a configured server\'s tools (MCPorter)',
  '/mcp tools [--route sdk] -- <command>  any stdio server\'s tools, from its command line, with the server\'s own hints',
  '/mcp call <server> <tool> [json]       call a tool on a configured server; the JSON object is the rest of the line',
  '/mcp call [--route sdk] <tool> [json] -- <command>',
  '  e.g. /mcp call docs search {"query":"Workers KV eventual consistency"}   (single quotes around the JSON work too)',
  '  each call is kept in .timmy/mcp/<call-id>/ (call.json and the raw output.json) with an mcp.call receipt',
];

/**
 * Every configured server contacted once, through MCPorter's own health check (`list --json --no-oauth`): stdio
 * servers start, HTTP servers are reached, nobody signs in. Only on request (/mcp servers --check).
 */
async function checkServers(o: McpRunOptions): Promise<{ ok: true; status: Map<string, { status: string; authCommand?: string; error?: string }> } | { ok: false; error: string }> {
  const r = routeFor('mcporter', o.seams, o.env);
  if (!r?.available || !r.argv) return { ok: false, error: noRoute('mcporter', r) };
  const perServer = Math.min(o.timeoutMs ?? 30_000, 30_000);
  const run = await runProcess([...r.argv, 'list', '--json', '--no-oauth', '--timeout', String(perServer)], { cwd: o.cwd, env: childEnv(o.env ?? process.env, o.passEnv), timeoutMs: perServer + 15_000 });
  const parsed = parseJson(run.stdout);
  if (run.timedOut || !parsed.ok) return { ok: false, ...failure(run, perServer + 15_000, `mcporter list failed (exit ${run.code})`) };
  const status = new Map<string, { status: string; authCommand?: string; error?: string }>();
  for (const s of ((parsed.value as { servers?: unknown[] }).servers ?? []) as Array<Record<string, unknown>>) {
    if (typeof s.name !== 'string') continue;
    // R4 (H34): MCPorter's own words for a failed contact can carry the server's whole URL: only its safe form is shown.
    status.set(s.name, { status: String(s.status ?? 'error'), ...(typeof s.authCommand === 'string' ? { authCommand: scrubUrls(s.authCommand) } : {}), ...(typeof s.error === 'string' ? { error: scrubUrls(s.error) } : {}) });
  }
  return { ok: true, status };
}

const serverRow = (e: McpServerEntry): string => [
  `  ${e.name.padEnd(24)} ${e.transport}`,
  e.program, e.url,
  e.source ? `${e.source}${e.importKind ? ` (${e.importKind})` : ''}` : undefined,
  e.auth ? `sign-in ${e.auth}` : undefined,
  e.envNames?.length ? `env ${e.envNames.join(', ')}` : undefined,
  e.headerNames?.length ? `headers ${e.headerNames.join(', ')}` : undefined,
  e.status ? `status ${e.status}` : undefined,
].filter(Boolean).join(' · ');

/** What /mcp is given besides the routes' own options (R4, H34). */
export interface McpViewOptions extends McpRunOptions {
  /** The width the view's lines may take (the terminal's, less any prefix the caller adds); answers wrap to it. */
  columns?: number;
  /** Where /mcp call keeps its record and how it seals its receipt; without it no record is written. */
  record?: McpRecordContext;
}

/** How many display lines of an answer /mcp call shows, and of an error answer's own words. */
const ANSWER_LINES = 20;
const SAID_LINES = 12;

/**
 * Plain text lines for /mcp. `args` is what follows /mcp as typed (a string: R4, H34), or its words. As a string,
 * /mcp call keeps its JSON exactly as typed; every other verb is split into words as a shell would.
 * Answers what was actually run: routes come from what resolves here; servers and tools from a live run.
 */
export async function mcpView(args: string[] | string, o: McpViewOptions = {}): Promise<string[]> {
  if (typeof args === 'string') {
    const line = args.trim();
    const call = /^call(?:\s+|$)/.exec(line);
    if (call) return callView(parseCallLine(line.slice(call[0].length)), o);
    return mcpView(splitCommandLine(line), o);
  }
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
    if (!m?.available) {
      if (verb === 'servers') lines.push(`SERVERS  ${noRoute('mcporter', m)}`);
    } else {
      const s = await listServers('mcporter', o);
      const where = 'MCPorter reads ./config/mcporter.json, ~/.mcporter/mcporter.json and the editors\' MCP configs';
      if (verb === 'routes') {
        const imported = s.servers.filter((e) => e.origin === 'import').length;
        const n = s.servers.length;
        lines.push(!s.ok ? `SERVERS  could not read them: ${s.error}`
          : n ? `SERVERS  ${n} ${n === 1 ? 'server' : 'servers'} configured (${n - imported} in MCPorter's config, ${imported} from editors): /mcp servers lists them`
            : `SERVERS  none configured (${where})`);
        lines.push('');
      } else {
        const check = head.includes('--check');
        let checked: Awaited<ReturnType<typeof checkServers>> | null = null;
        if (s.ok && check) {
          checked = await checkServers(o);
          if (checked.ok) for (const e of s.servers) { const c = checked.status.get(e.name); if (c) e.status = c.status; }
        }
        lines.push(`SERVERS MCPORTER KNOWS · ${s.servers.length} · ${checked?.ok ? 'each contacted once (stdio started, HTTP reached, no sign-in)' : 'read from their files, not contacted'}`);
        if (!s.ok) lines.push(`  could not read them: ${s.error}`);
        else if (!s.servers.length) lines.push(`  none configured (${where})`);
        else for (const e of s.servers) lines.push(serverRow(e));
        if (checked && !checked.ok) lines.push(`  not checked: ${checked.error}`);
        if (checked?.ok) {
          const home = homeOf(childEnv(o.env ?? process.env));
          for (const e of s.servers) {
            const c = checked.status.get(e.name);
            if (!c || c.status === 'ok') continue;
            const said = c.status === 'auth' ? needsAuthorization(c.authCommand ?? `mcporter auth ${e.name}`) : (c.error ?? c.status).split(home).join('~').slice(0, 200);
            lines.push(`    ${e.name}: ${said}`);
          }
        }
        lines.push('');
      }
    }
    return verb === 'routes' ? [...lines, ...MCP_HELP] : lines;
  }

  if (verb === 'tools') {
    const ref: McpServerRef | null = command.length ? { command } : head[0] ? { name: head[0] } : null;
    if (!ref) return ['which server? /mcp tools <server>, or /mcp tools -- <command>'];
    const id = pick('name' in ref);
    const r = await listTools(id, ref, o);
    if (!r.ok) return [`${serverLabel(ref)} via ${id}: ${r.error}`];
    // R4 (H34): the server's own hints, labelled as its claim; before the description, which is what a narrow terminal cuts.
    return [`${r.server} via ${id} · ${r.tools.length} tools · ${r.ms} ms${r.truncated ? ' · list cut' : ''}`,
      ...r.tools.map((t) => {
        const hints = hintWords(t.annotations);
        return `  ${t.name}(${t.params.map((p) => (t.required.includes(p) ? p : `${p}?`)).join(', ')})${hints ? `  [${hints}, per the server]` : ''}${t.description ? `  ${t.description.split('\n')[0].slice(0, 100)}` : ''}`;
      }),
      ...(id === 'mcporter' && r.tools.length ? ["  the server's own hints (read-only, destructive, …) are not shown: MCPorter 0.12.4 drops them from its list; --route sdk -- <command> shows them for a stdio server"] : [])];
  }

  if (verb === 'call') {
    // The words' form (a caller that split the line already): the JSON is one word.
    const named = !command.length;
    const json = named ? head[2] : head[1];
    const words = (named ? head.slice(0, 2) : head.slice(0, 1)).filter(Boolean);
    const extra = named ? head.slice(3) : head.slice(2);
    if (extra.length) return [`the arguments must be one JSON object after the tool, not "${extra.join(' ').slice(0, 40)}". ${argsHint({ server: words[0], tool: words[1], command: !named })}`];
    return callView(callLineFrom(words, named ? undefined : command, route, json), o);
  }

  return [`unknown: /mcp ${verb}`, ...MCP_HELP];
}

/** /mcp call: the call, its record and receipt, and its answer to read (R4, H34). */
async function callView(c: McpCallLine, o: McpViewOptions): Promise<string[]> {
  if (!c.ok) return [c.error];
  const routes = mcpRoutes(o.env ?? process.env, o.seams);
  const ref: McpServerRef = c.command ? { command: c.command } : { name: c.server! };
  const id = c.route ?? ('name' in ref ? 'mcporter' : (routes.find((r) => r.available)?.id ?? 'mcporter'));
  const { run, record } = await callAndRecord(id, ref, c.tool, c.args, o, o.record);
  const r = run.answer;
  const width = Math.max(24, (o.columns ?? 100) - 2);
  const lines = [`${r.tool} on ${r.server} via ${id} · ${run.facts.outcome} · ${r.ms} ms · ${r.outputBytes} bytes`];
  const answer = run.stdout !== undefined ? readRouteAnswer(run.stdout, id) : ({ kind: 'none' } as const);
  const kept = record?.ok && record.output
    ? (run.facts.output?.truncated ? `output.json keeps the first 32 KB of it: ${record.output}` : `the whole answer is in ${record.output}`)
    : 'no record keeps it';
  let left: string | undefined;
  if (r.isError) {
    lines.push('  the server said:');
    const said = serverSaid(answer, id);
    const fit = fitLines(said.length ? said : cleanText((r.error ?? 'nothing').replace(/^the server said: /, '')).split('\n'), width - 2, SAID_LINES);
    lines.push(...fit.shown.map((l) => `    ${l}`));
    left = fit.left;
  } else if (r.ok) {
    const { lines: body, notes } = answerLines(answer, id);
    const fit = fitLines(body.length ? body : ['(an empty answer)'], width, ANSWER_LINES);
    lines.push(...fit.shown.map((l) => `  ${l}`));
    left = fit.left;
    for (const n of notes) lines.push(`  (${n})`);
  } else {
    // The route's or Timmy's own words (a time limit, a sign-in, a server that would not start), as many lines as they take.
    const fit = fitLines(cleanText(r.error ?? 'failed').split('\n'), width, SAID_LINES);
    lines.push(...fit.shown.map((l) => `  ${l}`));
    if (fit.left) lines.push(`  … ${fit.left}: ${record?.ok ? `the whole error is in ${record.call}` : 'no record keeps it'}`);
  }
  if (left) lines.push(`  … ${left}: ${kept}`);
  if (record) {
    lines.push(record.ok
      ? `  record ${record.call}${record.receipt ? ` · receipt ${record.receipt}` : ' · no receipt was sealed'}`
      : `  no record: ${record.error}${record.receipt ? ` · receipt ${record.receipt}` : ' · no receipt was sealed'}`);
  }
  return lines;
}
