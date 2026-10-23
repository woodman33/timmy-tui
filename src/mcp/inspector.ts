/**
 * R6 (H142): the Tools & MCP inspector, the companion's tab 9 (the operator's references 08 and 17), server side: what its
 * routes (src/companion/panels/tools.ts) answer with. It reuses what Timmy has: the two MCP-to-CLI routes and their record of
 * a call (src/connectors/mcp-cli.ts, mcp-records.ts: the REPL's /mcp call and the agent's call_mcp_tool keep the same), the
 * MCP SDK's own JSON Schema validator, the strict tool-schema rule of lanes/schema/lane.mjs, and two small programs of its
 * own here: a FAKE stdio server to try it with (fake-fixture-server.ts) and a wire tap that times each JSON-RPC frame of a
 * call (wire-tap.ts).
 *
 * What it does, and what it never does:
 *   - Servers: Timmy's FAKE fixture (labelled FAKE everywhere) and the servers MCPorter's config and editor imports name (read
 *     from their files: nothing started). These are the only servers the page starts. A stdio command line typed on the page
 *     is built and checked, and its exact lines are given (the REPL's /mcp forms, MCPorter's own, and MCPorter's line that
 *     adds it to the project's config), but it is never started from the page: a listing or call of it answers NEEDS YOU
 *     (409) before anything starts, because a command line you typed runs only from Timmy's terminal (the lead's review of
 *     R6: a page script error, or a script that got the token, must not be able to run any program on this computer).
 *   - Listing (tools/list) of the fixture or a configured server, through the route the person picks, needs no approval (the
 *     lead's rule for R6): it starts the server for the listing (or reaches its address: the page says so first), and the
 *     route stops it.
 *   - A call is checked against the tool's input schema with the SDK's validator before anything is sent; a request that
 *     fails it is refused, and nothing starts.
 *   - The page's rule for a call (pageRule): a page cannot show the REPL's NEEDS YOU box, so, as the live board's Run does
 *     with a risky workflow (src/repl/workflow-gate.ts), a call that would need a person is refused before anything runs,
 *     with the exact line to type in Timmy's terminal, where a typed /mcp call is the operator's own command. A call runs
 *     from the page only when the server's own list, read fresh through the SDK route in the same request, says the tool is
 *     read-only (readOnlyHint: true) and closed-world (openWorldHint: false): the chat agent's rule that read-only tools never
 *     ask and anything that may reach outside always asks (src/repl/approvals.ts), on the server's own claim, which is said
 *     as its claim and never checked. Anything else (a tool that is not read-only, destructive, open-world, or whose hints
 *     are not known) waits for you. MCPorter 0.12.4 drops the hints, so a configured server's are never known here: its call
 *     waits for you before anything starts.
 *   - A call that runs keeps the same record and receipt /mcp call keeps (.timmy/mcp/<call-id>/, an mcp.call receipt on the
 *     project's runs chain), plus wire.ndjson when it went through the wire tap (stdio servers), and notes that it was made
 *     from the companion.
 * Nothing here contacts the network by itself; a server it starts does what that server does.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  listServers, listTools, mcpRoutes, runToolCall, serverLabel, splitCommandLine, MCPORTER_DROPS_HINTS,
  type McpRouteId, type McpServerEntry, type McpServerRef, type McpToolEntry,
} from '../connectors/mcp-cli.js';
import {
  answerLines, hintWords, mcpCallRel, mcpOutputRel, mcpWireRel, readMcpCalls, readRouteAnswer, routeAnswerOf, writeMcpCall, MCP_CALL_ID, MCP_CALL_SCHEMA,
  type McpCallRecord, type RouteAnswer,
} from '../connectors/mcp-records.js';
import { projectId, resolveInside } from '../project/index.js';
import { appendReceipt, readChain, verifyReceiptIn, type Receipt, type ReceiptInput } from '../utils/receipts.js';
import { ownScript } from './own-scripts.js';
import { FAKE_FIXTURE_NAME, FROM_PAGE, fixtureServer, wireView, type FixtureInfo, type TapLine, type WireView } from './call-views.js';

// the light parts every surface reads (the Workbench imports them from call-views.ts directly, without the validator)
export { FAKE_FIXTURE_NAME, FROM_PAGE, fixtureServer, isFixtureLabel, wireView, type FixtureInfo, type WireSpan, type WireView } from './call-views.js';

type Env = Record<string, string | undefined>;

/** How long a listing and a call may take, as /mcp's own defaults (lists 30 s, calls 60 s). */
export const LIST_TIMEOUT_MS = 30_000;
export const CALL_TIMEOUT_MS = 60_000;
/** The most of a route's printed output a call view carries (the record keeps the same, mcp-records.ts MCP_OUTPUT_LIMIT). */
const PRINTED_LIMIT = 32 * 1024;
/** The largest image a view carries to be drawn. */
const IMAGE_LIMIT = 512 * 1024;
/** The most of a wire trace a record keeps. */
const WIRE_KEPT_LIMIT = 512 * 1024;
/** The page's rule, in words (the module comment says why). */
export const PAGE_RULE = 'A call runs from this page only when the server\'s own list, read fresh through the SDK route, says the tool is read-only and closed-world (its claim, not checked). Anything else waits for you: Timmy gives the line to type in its terminal, where a typed /mcp call is your own command. This page starts only Timmy\'s FAKE fixture and the servers your own MCPorter config names: listing their tools needs no approval (it starts the server, or reaches its address, for the listing, and the route stops it). A command line you typed runs only from Timmy\'s terminal.';
/** Why the page starts no command line typed on it (the lead's review of R6). */
export const TYPED_WHY = 'a command line you typed runs only from Timmy\'s terminal: this page starts only Timmy\'s FAKE fixture and the servers your own MCPorter config names';
const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// ── the routes and the servers ─────────────────────────────────────────────────────────

export interface RouteRung {
  id: McpRouteId;
  label: string;
  /** installed: its program resolves here (no server contacted); needs setup: it does not */
  rung: 'installed' | 'needs setup';
  version?: string;
  details: string;
  setup?: string;
  /** what the route can reach: stdio command lines, and (mcporter) configured servers and HTTP addresses */
  reaches: string;
}

export function routeRungs(env: Env): RouteRung[] {
  // the order the tab names them in: the SDK route, then mcporter (src/workbench/tools-tab.ts MCP_ROUTES)
  const routes = mcpRoutes(env);
  return (['sdk', 'mcporter'] as const).map((id) => {
    const r = routes.find((x) => x.id === id)!;
    return {
      id, label: r.label, rung: r.available ? 'installed' : 'needs setup', ...(r.version ? { version: r.version } : {}), details: r.details, ...(r.setup ? { setup: r.setup } : {}),
      reaches: id === 'sdk' ? 'stdio servers from a command line; passes the server\'s tool hints on' : 'stdio command lines, servers in MCPorter\'s config and editor imports, HTTP (SSE as its fallback); drops the tool hints',
    };
  });
}

/** Whether a program is on PATH (nothing is run). */
function onPath(program: string, env: Env): boolean {
  return (env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => existsSync(join(dir, program)));
}

export interface IngestMode {
  id: 'stdio' | 'http' | 'apisnip' | 'clyanything';
  label: string;
  /** works: Timmy reaches servers this way; not in Timmy: no route of Timmy's does it (on PATH or not, said as it is) */
  state: 'works' | 'not in Timmy';
  routes: McpRouteId[];
  words: string;
}

/** The reference's four ingest modes, as Timmy has them (reference 17: stdio, SSE, apisnip, clyanything). */
export function ingestModes(env: Env): IngestMode[] {
  const routes = routeRungs(env);
  const has = (id: McpRouteId): boolean => routes.some((r) => r.id === id && r.rung === 'installed');
  const both = (['sdk', 'mcporter'] as const).filter(has);
  return [
    { id: 'stdio', label: '1. Stdio MCP', state: both.length ? 'works' : 'not in Timmy', routes: [...both], words: both.length ? `a server Timmy starts from its command line, through ${both.length === 2 ? 'either route' : `the ${both[0] === 'sdk' ? 'SDK' : 'mcporter'} route`}; or one MCPorter's config names` : 'neither MCP-to-CLI route is installed here' },
    { id: 'http', label: '2. SSE / HTTP remote', state: has('mcporter') ? 'works' : 'not in Timmy', routes: has('mcporter') ? ['mcporter'] : [], words: has('mcporter') ? 'a server MCPorter\'s config or an editor import names with an address: through the mcporter route (streamable HTTP, with SSE as MCPorter\'s fallback); the SDK route runs stdio servers only; Timmy never starts a sign-in' : 'the mcporter route is not installed here' },
    { id: 'apisnip', label: '3. apisnip OpenAPI', state: 'not in Timmy', routes: [], words: onPath('apisnip', env) ? 'apisnip is on PATH, but no Timmy route runs it: it is an interactive OpenAPI picker with no headless mode (lanes/wire found that on 2026-09-07)' : 'apisnip is not installed here, and no Timmy route runs it' },
    { id: 'clyanything', label: '4. clyanything web', state: 'not in Timmy', routes: [], words: onPath('clyanything', env) ? 'clyanything is on PATH, but no Timmy route runs it' : 'clyanything is not installed here, and no Timmy route runs it' },
  ];
}

export interface WireTool { id: string; label: string; state: 'works' | 'on PATH, not wired' | 'not installed'; words: string }

/** What can see a call's JSON-RPC traffic here: Timmy's own wire tap, and the external inspectors lanes/wire used. */
export function wireTools(env: Env): WireTool[] {
  const tap = ownScript('wire-tap');
  return [
    { id: 'wire-tap', label: "Timmy's wire tap", state: tap.ok ? 'works' : 'not installed', words: tap.ok ? 'times each JSON-RPC frame of a call between the route and a stdio server (src/mcp/wire-tap.ts); kept with the call\'s record' : tap.why },
    ...(['mcpsnoop', 'mcp-probe'] as const).map((id): WireTool => (onPath(id, env)
      ? { id, label: id, state: 'on PATH, not wired', words: `${id} is on PATH; this page does not run it (timmy mcp ${id === 'mcpsnoop' ? 'inspect' : 'probe'} does, in a terminal)` }
      : { id, label: id, state: 'not installed', words: `${id} is not installed here` })),
  ];
}

/** The servers MCPorter's config and editor imports name, read from their files (nothing started, nothing contacted). */
export async function configuredServers(root: string, env: Env): Promise<{ ok: boolean; servers: McpServerEntry[]; error?: string; ms?: number }> {
  if (!routeRungs(env).some((r) => r.id === 'mcporter' && r.rung === 'installed')) return { ok: false, servers: [], error: 'the mcporter route is not installed here, and only it reads a list of servers' };
  const s = await listServers('mcporter', { cwd: root, env, timeoutMs: LIST_TIMEOUT_MS });
  return { ok: s.ok, servers: s.servers, ...(s.error ? { error: s.error } : {}), ...(s.ms ? { ms: s.ms } : {}) };
}

// ── a server, as the page names it ────────────────────────────────────────────────────────

export type ServerSpec =
  | { kind: 'fixture' }
  | { kind: 'configured'; name: string }
  | { kind: 'stdio'; command: string[] };

const NAME = /^[A-Za-z0-9_@][A-Za-z0-9_.@:-]{0,79}$/;

/** A server the page names: { kind: 'fixture' }, { kind: 'configured', name }, or { kind: 'stdio', command: string | string[] }. */
export function parseServerSpec(v: unknown): { ok: true; spec: ServerSpec } | { ok: false; error: string } {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o) return { ok: false, error: 'name the server: {kind: "fixture"}, {kind: "configured", name}, or {kind: "stdio", command}' };
  if (o.kind === 'fixture') return { ok: true, spec: { kind: 'fixture' } };
  if (o.kind === 'configured') {
    if (typeof o.name !== 'string' || !NAME.test(o.name)) return { ok: false, error: 'a configured server is named as MCPorter\'s config names it (letters, digits, - _ . @ :, at most 80)' };
    return { ok: true, spec: { kind: 'configured', name: o.name } };
  }
  if (o.kind === 'stdio') {
    const words = typeof o.command === 'string' ? splitCommandLine(o.command) : Array.isArray(o.command) && o.command.every((w) => typeof w === 'string') ? (o.command as string[]) : null;
    if (!words || !words.length || !words[0]) return { ok: false, error: 'give the stdio server as a command line, e.g. node ./server.js --mcp' };
    if (words.length > 64 || words.some((w) => w.length > 4096)) return { ok: false, error: 'that command line is longer than this page takes (64 words, 4 KB each)' };
    if (words[0].startsWith('-')) return { ok: false, error: 'a command line starts with the program, not a flag' };
    return { ok: true, spec: { kind: 'stdio', command: words } };
  }
  return { ok: false, error: `no kind of server named ${JSON.stringify(o.kind ?? null)}: fixture, configured or stdio` };
}

/** The servers the page may start: Timmy's FAKE fixture and the ones the user's own MCPorter config names. */
export type StartableSpec = Exclude<ServerSpec, { kind: 'stdio' }>;

/** The server's command line or name for the routes, or why there is none (the fixture's as `env` gives it: fixtureServer). */
export function refOf(spec: ServerSpec, env: Env = {}): { ok: true; ref: McpServerRef; command?: string[] } | { ok: false; error: string } {
  if (spec.kind === 'configured') return { ok: true, ref: { name: spec.name } };
  if (spec.kind === 'stdio') return { ok: true, ref: { command: spec.command }, command: spec.command };
  const fx = fixtureServer(env);
  return fx.ok ? { ok: true, ref: { command: fx.command }, command: fx.command } : { ok: false, error: fx.why };
}

const labelOf = (spec: ServerSpec, env: Env): string => (spec.kind === 'configured' ? spec.name : spec.kind === 'fixture' ? (() => { const fx = fixtureServer(env); return fx.ok ? serverLabel({ command: fx.command }) : FAKE_FIXTURE_NAME; })() : serverLabel({ command: spec.command }));

// ── the schema gate ──────────────────────────────────────────────────────────────────────

/**
 * The strict tool-schema rule of lanes/schema/lane.mjs (strictIssues; tests/mcp-inspector.test.ts keeps the two the same):
 * what a strict provider's validator (Gemini class) rejects in a tool's parameters: an array without items, oneOf, allOf,
 * not, patternProperties, $ref or $defs, and a property named like a schema keyword; anyOf branches recurse.
 */
export function strictIssues(s: unknown, path = ''): string[] {
  const out: string[] = [];
  if (!s || typeof s !== 'object') return out;
  const o = s as Record<string, unknown>;
  if (o.type === 'array' && !('items' in o)) out.push(`${path || '(root)'}: array without items`);
  if (o.type === 'object' && o.properties && typeof o.properties === 'object') for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) out.push(...strictIssues(v, `${path}.${k}`));
  if (o.items) out.push(...strictIssues(o.items, `${path}[]`));
  for (const kw of ['oneOf', 'allOf', 'not', 'patternProperties', '$ref', '$defs']) if (kw in o) out.push(`${path}: uses ${kw} (strict providers reject)`);
  if (Array.isArray(o.anyOf)) for (const [i, v] of o.anyOf.entries()) out.push(...strictIssues(v, `${path}|anyOf[${i}]`));
  if (o.properties && typeof o.properties === 'object') for (const k of Object.keys(o.properties as object)) if (['type', 'items', 'properties', 'required', 'enum'].includes(k)) out.push(`${path}.${k}: property name collides with a schema keyword`);
  return out;
}

export interface SchemaGate {
  /** tools whose schema was read */
  checked: number;
  /** tools listed without a schema (a list cut to its bound drops schemas first) */
  missing: number;
  /** every strict-schema issue, by tool */
  issues: Array<{ tool: string; issue: string }>;
  /** names listed more than once */
  collisions: string[];
}

export function schemaGate(tools: readonly McpToolEntry[]): SchemaGate {
  const seen = new Map<string, number>();
  for (const t of tools) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
  const withSchema = tools.filter((t) => t.inputSchema && typeof t.inputSchema === 'object');
  return {
    checked: withSchema.length,
    missing: tools.length - withSchema.length,
    issues: withSchema.flatMap((t) => strictIssues(t.inputSchema).map((issue) => ({ tool: t.name, issue }))),
    collisions: [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k),
  };
}

// ── a request, checked against its schema ──────────────────────────────────────────────

/** the SDK's validator, made at the first check (not when this module loads) */
let validator: AjvJsonSchemaValidator | null = null;

export interface ArgError { field: string; message: string }

const at = (schema: unknown, path: string[]): Record<string, unknown> | null => {
  let s = schema as Record<string, unknown> | null;
  for (const p of path) {
    if (!s || typeof s !== 'object') return null;
    const props = s.properties as Record<string, unknown> | undefined;
    s = (props && typeof props === 'object' ? (props[p] as Record<string, unknown>) : null) ?? (Array.isArray(s.items) ? null : (s.items as Record<string, unknown> | null) ?? null);
  }
  return s && typeof s === 'object' ? s : null;
};
const valueAt = (v: unknown, path: string[]): unknown => path.reduce<unknown>((x, p) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[p] : undefined), v);

/** The arguments checked against the tool's input schema, with the MCP SDK's own validator (AJV, all errors, formats). */
export function checkArgs(schema: unknown, args: unknown): { valid: boolean; errors: ArgError[] } {
  if (!schema || typeof schema !== 'object') return { valid: false, errors: [{ field: '(the arguments)', message: 'the server gave no input schema for this tool in its list, so they cannot be checked' }] };
  let r: { valid: boolean; errorMessage?: string };
  try { validator ??= new AjvJsonSchemaValidator(); r = validator.getValidator(schema as never)(args); } catch (e) {
    return { valid: false, errors: [{ field: '(the schema)', message: `the server's schema could not be read by the validator: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  if (r.valid) return { valid: true, errors: [] };
  const errors = String(r.errorMessage ?? 'they do not match the schema').split(/, (?=data(?:\/|\s|$))/).map((part): ArgError => {
    const m = /^data((?:\/[^\s]*)?)\s+(.*)$/.exec(part.trim());
    const path = m && m[1] ? m[1].slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    let message = m ? m[2] : part;
    const s = at(schema, path);
    // the validator's words, with the two things they leave out: which keys are extra, and which values are allowed
    if (/additional properties/.test(message) && s && s.properties && typeof s.properties === 'object') {
      const v = valueAt(args, path);
      const extra = v && typeof v === 'object' ? Object.keys(v as object).filter((k) => !(k in (s.properties as object))) : [];
      if (extra.length) message = `${message}: ${extra.join(', ')}`;
    }
    if (/allowed values/.test(message) && s && Array.isArray(s.enum)) message = `${message}: ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`;
    return { field: path.length ? path.join('.') : '(the arguments)', message };
  });
  return { valid: false, errors };
}

/** The tools/call request a route sends for this call; its id is the route's own (the call's wire trace shows the one sent). */
export function jsonRpcRequest(tool: string, args: Record<string, unknown>): { jsonrpc: '2.0'; id: string; method: 'tools/call'; params: { name: string; arguments: Record<string, unknown> } } {
  return { jsonrpc: '2.0', id: '(the route numbers it)', method: 'tools/call', params: { name: tool, arguments: args } };
}

// ── the generated CLI: the exact lines for each route ───────────────────────────────────

/** A word for a POSIX shell: as it is when it is plain, else in single quotes. */
export const shellWord = (w: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
/** A word for the REPL's command line (src/connectors/mcp-cli.ts splitCommandLine: quotes, no escapes). */
const replWord = (w: string): string => (/^[^\s"']+$/.test(w) ? w : w.includes('"') ? `'${w}'` : `"${w}"`);

export interface CliLines {
  /** the REPL's /mcp call, for each route that can reach the server */
  repl: Partial<Record<McpRouteId, string>>;
  /** MCPorter's own command line for the same call (the route runs these words) */
  mcporter?: string;
  /** Timmy's SDK command line for the same call (the SDK route's own program) */
  sdk?: string;
  /** why a route has no line here */
  notes: string[];
}

/** The SDK route's own program as a person types it (`node` for the Node running Timmy), or nothing when it is not installed. */
function sdkProgram(env: Env): string[] | null {
  const r = mcpRoutes(env).find((x) => x.id === 'sdk');
  if (!r?.available || !r.argv) return null;
  return r.argv[0] === process.execPath ? ['node', ...r.argv.slice(1)] : r.argv;
}

export function cliLines(spec: ServerSpec, tool: string, args: Record<string, unknown>, env: Env): CliLines {
  const json = JSON.stringify(args ?? {});
  const notes: string[] = [];
  const r = refOf(spec, env);
  if (!r.ok) return { repl: {}, notes: [r.error] };
  if ('name' in r.ref) {
    notes.push('the SDK route runs a server from its command line only; a configured server is reached through mcporter');
    return { repl: { mcporter: `/mcp call ${r.ref.name} ${tool} ${json}` }, mcporter: `mcporter call ${shellWord(`${r.ref.name}.${tool}`)} --args ${shellWord(json)}`, notes };
  }
  const command = r.ref.command;
  const replCmd = command.map(replWord).join(' ');
  const sdk = sdkProgram(env);
  return {
    repl: { sdk: `/mcp call --route sdk ${tool} ${json} -- ${replCmd}`, mcporter: `/mcp call --route mcporter ${tool} ${json} -- ${replCmd}` },
    mcporter: ['mcporter', 'call', '--stdio', command[0], ...command.slice(1).flatMap((a) => ['--stdio-arg', a]), '--tool', tool, '--args', json].map(shellWord).join(' '),
    ...(sdk ? { sdk: [...sdk, 'call', tool, '--args', json, '--json', '--', ...command].map(shellWord).join(' ') } : {}),
    notes,
  };
}

// ── a command line typed on the page: built, checked and given as lines; never started from the page ──

export interface TypedLines extends CliLines {
  /** MCPorter's own line that adds the server to the project's config (config/mcporter.json): the page then lists it */
  config: string;
}

/** A name for a typed server in MCPorter's config: its script's name (as the mcporter route names an ad-hoc server). */
export function typedName(command: readonly string[]): string {
  return serverLabel({ command: [...command] }).split(' ').pop()!.replace(/\.[a-z]+$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'my-server';
}

/** The lines for a typed command line: its listing (`/mcp tools`), or a call of one of its tools (`/mcp call`), and the config line. */
export function typedLines(command: readonly string[], env: Env, call?: { tool: string; args: Record<string, unknown> }): TypedLines {
  const words = [...command];
  // MCPorter 0.12.4's `config add <name> --command <program> -- <args…>` (its `--` forwards every later word as an argument)
  const config = ['mcporter', 'config', 'add', typedName(words), '--command', words[0], ...(words.length > 1 ? ['--', ...words.slice(1)] : [])].map(shellWord).join(' ');
  if (call) return { ...cliLines({ kind: 'stdio', command: words }, call.tool, call.args, env), config };
  const replCmd = words.map(replWord).join(' ');
  const sdk = sdkProgram(env);
  return {
    repl: { sdk: `/mcp tools --route sdk -- ${replCmd}`, mcporter: `/mcp tools --route mcporter -- ${replCmd}` },
    mcporter: ['mcporter', 'list', '--stdio', words[0], ...words.slice(1).flatMap((a) => ['--stdio-arg', a])].map(shellWord).join(' '),
    ...(sdk ? { sdk: [...sdk, 'tools', '--json', '--', ...words].map(shellWord).join(' ') } : {}),
    notes: [],
    config,
  };
}

export interface TypedRefusal {
  status: 409;
  refused: 'needs you';
  rule: { runs: false; why: string; command: string };
  cli: TypedLines;
  words: string;
  server: string;
  route: McpRouteId;
}

/**
 * A typed command line's listing or call, refused before anything starts: NEEDS YOU, with the exact line for Timmy's
 * terminal (the REPL's /mcp tools or /mcp call, through the route picked) and the others (the module comment says why).
 */
export function typedRefusal(command: readonly string[], route: McpRouteId, env: Env, call?: { tool: string; args: Record<string, unknown> }): TypedRefusal {
  const cli = typedLines(command, env, call);
  const line = cli.repl[route] ?? cli.repl.sdk ?? cli.repl.mcporter!;
  return {
    status: 409, refused: 'needs you', rule: { runs: false, why: TYPED_WHY, command: line }, cli,
    words: `NEEDS YOU: ${TYPED_WHY}. Nothing was started. In Timmy's terminal: ${line}`,
    server: serverLabel({ command: [...command] }), route,
  };
}

// ── the page's rule for a call ────────────────────────────────────────────────────────

export type PageRule =
  | { runs: true; why: string }
  | { runs: false; why: string; command: string };

/** Whether a call of `tool` from the page runs (the module comment says why this rule). `hints`: the server's own, as a list read through the SDK route in this request gave them; null when they are not known. */
export function pageRule(spec: ServerSpec, tool: string, hints: Record<string, unknown> | null, lines: CliLines, route: McpRouteId): PageRule {
  const command = lines.repl[route] ?? lines.repl.mcporter ?? lines.repl.sdk ?? `/mcp call ${tool} …`;
  if (spec.kind === 'configured') return { runs: false, why: `the server's own hints for ${tool} are not known: a configured server is reached through mcporter, and ${MCPORTER_DROPS_HINTS.replace(/^not known on this route: /, '')}; a tool Timmy cannot see is read-only waits for you`, command };
  if (!hints) return { runs: false, why: `the server's own hints for ${tool} could not be read through the SDK route, so Timmy cannot see it is read-only; it waits for you`, command };
  if (hints.readOnlyHint !== true) return { runs: false, why: `the server does not list ${tool} as read-only (readOnlyHint: ${JSON.stringify(hints.readOnlyHint ?? null)}${hints.destructiveHint === true ? ', destructiveHint: true' : ''}): a call that may change something waits for you`, command };
  if (hints.openWorldHint !== false) return { runs: false, why: `the server does not list ${tool} as closed-world (openWorldHint: ${JSON.stringify(hints.openWorldHint ?? null)}; MCP's default is open): a call that may reach outside this computer waits for you`, command };
  return { runs: true, why: `the server lists ${tool} as read-only and closed-world (its own claim, not checked), so the call runs from this page, as a /mcp call you typed would` };
}

// ── listing ──────────────────────────────────────────────────────────────────────────────

export interface ToolView {
  name: string;
  title?: string;
  description?: string;
  /** the input schema as the server listed it; null when the list did not carry it */
  inputSchema: unknown | null;
  required: string[];
  params: string[];
  /** the server's own hints, as it listed them (its claim); null when not known on this route */
  annotations: Record<string, boolean | number | string> | null;
  hints: string;
  /** the strict tool-schema rule's issues with its schema */
  strict: string[];
}

export interface ListView {
  ok: boolean;
  route: McpRouteId;
  spec: ServerSpec;
  server: string;
  transport: string;
  at: string;
  ms: number;
  tools: ToolView[];
  error?: string;
  needsAuth?: true;
  authCommand?: string;
  /** what the listing started, in words; absent when nothing started */
  started?: string;
  truncated?: true;
  gate: SchemaGate;
  hintsNote: string;
}

const toolView = (t: McpToolEntry, route: McpRouteId): ToolView => ({
  name: t.name,
  ...(typeof (t as { title?: unknown }).title === 'string' ? { title: (t as { title?: string }).title } : {}),
  ...(t.description ? { description: t.description } : {}),
  inputSchema: t.inputSchema ?? null,
  required: t.required,
  params: t.params,
  annotations: route === 'sdk' ? t.annotations ?? {} : null,
  hints: route === 'sdk' ? hintWords(t.annotations) || 'none listed' : 'not known on this route',
  strict: t.inputSchema ? strictIssues(t.inputSchema) : [],
});

export interface InspectorCtx { root: string; env: Env; project?: string }

/**
 * A server's tools through one route: a real tools/list (the route starts the server for it and stops it). Only the fixture
 * and a configured server: the page's route answers a typed command line with typedRefusal, and it is refused here too.
 */
export async function listFor(spec: StartableSpec, route: McpRouteId, ctx: InspectorCtx): Promise<ListView> {
  const at = new Date().toISOString();
  const server = labelOf(spec, ctx.env);
  const transport = spec.kind === 'configured' ? 'as configured' : 'stdio';
  const base = { route, spec, server, transport, at };
  const hintsNote = route === 'sdk' ? "the server's own hints (read-only, destructive, …), as it lists them: its claim, not checked" : MCPORTER_DROPS_HINTS;
  const empty: SchemaGate = { checked: 0, missing: 0, issues: [], collisions: [] };
  // a caller past the types (a page's JSON) gets the refusal's words, and nothing starts
  if ((spec as ServerSpec).kind === 'stdio') return { ok: false, ...base, ms: 0, tools: [], error: `NEEDS YOU: ${TYPED_WHY}`, gate: empty, hintsNote };
  const r = refOf(spec, ctx.env);
  if (!r.ok) return { ok: false, ...base, ms: 0, tools: [], error: r.error, gate: empty, hintsNote };
  if (route === 'sdk' && 'name' in r.ref) return { ok: false, ...base, ms: 0, tools: [], error: 'the SDK route runs a server from its command line only; a configured server is listed through mcporter', gate: empty, hintsNote };
  const listed = await listTools(route, r.ref, { cwd: ctx.root, env: ctx.env, timeoutMs: LIST_TIMEOUT_MS });
  const tools = listed.tools.map((t) => toolView(t, route));
  return {
    ok: listed.ok, ...base, ms: listed.ms, tools,
    ...(listed.error ? { error: listed.error } : {}),
    ...(listed.needsAuth ? { needsAuth: true as const, ...(listed.authCommand ? { authCommand: listed.authCommand } : {}) } : {}),
    ...(listed.routeRan ? { started: 'name' in r.ref ? `the mcporter route started the configured server ${r.ref.name} (or reached its address) for the listing, and stopped it` : `the ${route === 'sdk' ? 'SDK' : 'mcporter'} route started ${server} for the listing, and stopped it` } : {}),
    ...(listed.truncated ? { truncated: true as const } : {}),
    gate: schemaGate(listed.tools),
    hintsNote,
  };
}

// ── a call ──────────────────────────────────────────────────────────────────────────────

export type ResultItem =
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown; label?: string }
  | { type: 'image'; mime: string; data: string; bytes: number }
  | { type: 'media'; label: string };

const base64Bytes = (data: string): number => Math.max(0, Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0));

/** An answer's content items, ready to draw: text, JSON (text that is JSON, and structuredContent), raster images. */
export function resultItems(a: RouteAnswer, route: McpRouteId): { items: ResultItem[]; notes: string[] } {
  if (a.kind === 'none') return { items: [], notes: ['nothing was printed'] };
  if (a.kind === 'text') return { items: [{ type: 'text', text: a.text }], notes: [] };
  if (a.kind === 'issue') return { items: [{ type: 'text', text: a.error }], notes: [] };
  if (a.kind === 'json') return { items: [{ type: 'json', value: a.value }], notes: answerLines(a, route).notes };
  const items: ResultItem[] = [];
  for (const c of a.content) {
    const item = c as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      const text = item.text;
      let json: unknown;
      if (/^\s*[[{]/.test(text)) { try { json = JSON.parse(text); } catch { json = undefined; } }
      items.push(json !== undefined && json && typeof json === 'object' ? { type: 'json', value: json } : { type: 'text', text });
    } else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string' && RASTER.has(item.mimeType) && item.data.length <= IMAGE_LIMIT * 1.4 && /^[A-Za-z0-9+/=\s]*$/.test(item.data)) {
      items.push({ type: 'image', mime: item.mimeType, data: item.data.replace(/\s+/g, ''), bytes: base64Bytes(item.data) });
    } else {
      // audio, resources, links and images this page does not draw: named by type and size, never dumped
      items.push({ type: 'media', label: answerLines({ kind: 'result', content: [item], isError: false }, route).lines.join(' ') });
    }
  }
  const notes: string[] = [];
  if (a.structured) items.push({ type: 'json', value: a.structured.value, label: 'structuredContent' });
  if (!a.content.length && !a.structured) notes.push('the answer holds no content items');
  return { items, notes };
}

export interface ReceiptView { id: string; hash: string; seq: number; ts: string; verified: boolean; why?: string; sealsBytes: boolean }

export interface CallView {
  id: string;
  record: string;
  output?: string;
  wire?: string;
  route: McpRouteId;
  server: string;
  transport: string;
  tool: string;
  args: unknown;
  startedAt: string;
  endedAt: string;
  ms: number;
  outcome: string;
  called: boolean;
  isError: boolean | null;
  error?: string;
  notes: string[];
  annotations: Record<string, unknown> | null;
  annotationsNote?: string;
  /** the receipt that sealed call.json, verified now on the project's chain; null when none did */
  receipt: ReceiptView | null;
  /** output.json and wire.ndjson as they are now, against the sha256 call.json names */
  outputCheck?: 'matches' | 'differs' | 'missing';
  wireCheck?: 'matches' | 'differs' | 'missing';
  /** what the route printed (output.json), at most 32 KB */
  printed?: string;
  /** the answer to draw: the server's own (the wire tap's tools/call answer) when the call went through the tap, else what the route printed */
  answer: { from: 'server' | 'route' | 'none'; items: ResultItem[]; notes: string[] };
  /** the tools/call request: exactly as it passed (the wire tap's), or as the route sends it (its id the route's) */
  request: { text: string; exact: boolean };
  /** the server's JSON-RPC answer, exactly as it passed (the wire tap's) */
  response?: string;
  wireView?: WireView;
  /** made from the browser companion (its own note in the record) */
  fromPage: boolean;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The project's runs chain, as every reader of it reads it (src/workbench/state.ts, src/ops/run-detail.ts). */
export function projectChain(root: string): Receipt[] {
  try { return process.env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

/** One call's record read again, its receipt verified now on the chain, its files checked against what it names. */
export async function readCall(root: string, id: string, chain: readonly Receipt[] = projectChain(root)): Promise<CallView | null> {
  if (!MCP_CALL_ID.test(id)) return null;
  const c = resolveInside(root, mcpCallRel(id));
  if ('error' in c) return null;
  let bytes: Buffer;
  try { if (statSync(c.path).size > 512 * 1024) return null; bytes = readFileSync(c.path); } catch { return null; }
  let rec: McpCallRecord;
  try { rec = JSON.parse(bytes.toString('utf8')) as McpCallRecord; } catch { return null; }
  if (!rec || rec.schema !== MCP_CALL_SCHEMA || rec.id !== id) return null;
  const pid = projectId(root);
  const callRel = mcpCallRel(id);
  const sha = sha256(bytes);
  let receipt: ReceiptView | null = null;
  for (let k = chain.length - 1; k >= 0; k--) {
    const r = chain[k];
    if (r.kind !== 'mcp.call' || r.project_id !== pid || r.outputs?.[0]?.path !== callRel) continue;
    const v = verifyReceiptIn(chain, r.hash);
    const sealsBytes = r.outputs?.[0]?.sha256 === sha;
    receipt = { id: r.hash.slice(7, 15), hash: r.hash, seq: k + 1, ts: r.ts, verified: v.ok && sealsBytes, ...(v.ok ? (sealsBytes ? {} : { why: 'call.json changed after its receipt sealed it' }) : { why: v.reason }), sealsBytes };
    break;
  }
  const readKept = (rel: string, want: string | undefined | null): { text?: string; check: 'matches' | 'differs' | 'missing' } => {
    const p = resolveInside(root, rel);
    try {
      if ('error' in p) throw new Error(p.error);
      const b = readFileSync(p.path);
      return { text: b.subarray(0, WIRE_KEPT_LIMIT).toString('utf8'), check: want ? (sha256(b) === want ? 'matches' : 'differs') : 'differs' };
    } catch { return { check: 'missing' }; }
  };
  const out = rec.output_file === 'output.json' ? readKept(mcpOutputRel(id), rec.kept_sha256) : null;
  const wire = rec.wire_file === 'wire.ndjson' ? readKept(mcpWireRel(id), rec.wire_sha256) : null;
  const t0 = Date.parse(rec.started_at);
  const t1 = Date.parse(rec.ended_at);
  const wv = wire?.text ? wireView(wire.text, Number.isNaN(t0) ? 0 : t0, Number.isNaN(t1) ? 0 : t1) : undefined;
  const printed = out?.text !== undefined ? out.text.slice(0, PRINTED_LIMIT) : undefined;
  // the answer to draw: the server's own words when the tap saw them, else the route's
  let answer: CallView['answer'] = { from: 'none', items: [], notes: [] };
  if (wv?.response) {
    type Answered = { result?: unknown; error?: { message?: unknown } };
    let msg: Answered | null = null;
    try { msg = JSON.parse(wv.response) as Answered; } catch { msg = null; }
    if (msg?.result && typeof msg.result === 'object') {
      // the server's own CallToolResult, as it sent it (read as a result, whichever route carried it)
      const { items, notes } = resultItems(routeAnswerOf(msg.result, 'mcporter'), rec.route);
      answer = { from: 'server', items, notes };
    } else if (msg?.error) answer = { from: 'server', items: [{ type: 'text', text: `JSON-RPC error: ${String(msg.error.message ?? JSON.stringify(msg.error))}` }], notes: [] };
  }
  if (answer.from === 'none' && printed !== undefined) {
    const { items, notes } = resultItems(readRouteAnswer(printed, rec.route), rec.route);
    answer = { from: 'route', items, notes };
  }
  const args = (rec.arguments && typeof rec.arguments === 'object' ? rec.arguments : {}) as Record<string, unknown>;
  return {
    id, record: callRel, ...(out ? { output: mcpOutputRel(id) } : {}), ...(wire ? { wire: mcpWireRel(id) } : {}),
    route: rec.route, server: rec.server, transport: rec.transport, tool: rec.tool, args: rec.arguments,
    startedAt: rec.started_at, endedAt: rec.ended_at, ms: rec.ms, outcome: rec.outcome, called: rec.called, isError: rec.isError,
    ...(rec.error ? { error: rec.error } : {}),
    notes: rec.notes ?? [], annotations: rec.annotations ?? null, ...(rec.annotations_note ? { annotationsNote: rec.annotations_note } : {}),
    receipt,
    ...(out ? { outputCheck: out.check } : {}), ...(wire ? { wireCheck: wire.check } : {}),
    ...(printed !== undefined ? { printed } : {}),
    answer,
    request: wv?.request ? { text: wv.request, exact: true } : { text: JSON.stringify(jsonRpcRequest(rec.tool, args)), exact: false },
    ...(wv?.response ? { response: wv.response } : {}),
    ...(wv ? { wireView: wv } : {}),
    fromPage: (rec.notes ?? []).some((n) => n.startsWith(FROM_PAGE)),
  };
}

export interface CallRow {
  id: string; tool: string; server: string; route: McpRouteId; transport: string; outcome: string; startedAt: string; ms: number;
  isError: boolean | null; fromPage: boolean; wire: boolean;
  receipt: { id: string; verified: boolean; why?: string } | null;
}

/** The project's newest calls, newest first, each with its receipt verified now (readMcpCalls, as tab 9 reads them). */
export function callRows(root: string, max = 12, chain: readonly Receipt[] = projectChain(root)): { calls: CallRow[]; more: number } {
  const { list, more } = readMcpCalls(root, chain, max);
  const pid = projectId(root);
  const calls = list.map((c): CallRow => {
    const r = c.record;
    let receipt: CallRow['receipt'] = null;
    for (let k = chain.length - 1; k >= 0; k--) {
      const x = chain[k];
      if (x.kind !== 'mcp.call' || x.project_id !== pid || x.outputs?.[0]?.path !== c.call) continue;
      const v = verifyReceiptIn(chain, x.hash);
      const bytes = c.check.status === 'verified';
      receipt = { id: x.hash.slice(7, 15), verified: v.ok && bytes, ...(v.ok ? (bytes ? {} : { why: (c.check as { reason?: string }).reason ?? 'call.json changed after its receipt sealed it' }) : { why: v.reason }) };
      break;
    }
    return {
      id: r.id, tool: r.tool, server: r.server, route: r.route, transport: r.transport, outcome: r.outcome, startedAt: r.started_at, ms: r.ms, isError: r.isError,
      fromPage: (r.notes ?? []).some((n) => n.startsWith(FROM_PAGE)), wire: r.wire_file === 'wire.ndjson', receipt,
    };
  });
  return { calls, more };
}

export type CallAnswer =
  | { status: 400; error: string }
  | { status: 404; error: string; listed: string[] }
  | { status: 422; refused: 'schema'; errors: ArgError[]; request: string; cli: CliLines; words: string }
  /** before: what was done before the refusal, in words (nothing started, or the server's own list read) */
  | { status: 409; refused: 'needs you'; rule: Extract<PageRule, { runs: false }>; request: string; cli: CliLines; words: string; before: string }
  | { status: 502; error: string; gate: { route: McpRouteId; ms: number } }
  | { status: 200; call: CallView; cli: CliLines; rule: Extract<PageRule, { runs: true }> };

export interface CallInput { server: unknown; route: unknown; tool: unknown; args: unknown }

/** The seal a page's call is sealed with: the project's runs chain, the short id back, as the REPL's own seal. */
const sealFor = (root: string) => (input: ReceiptInput): string | undefined => appendReceipt('runs', input, process.env.TIMMY_STORE ? undefined : root).hash.slice(7, 15);

/**
 * One call from the page. A typed command line (never started from the page) and a configured server (whose hints are never
 * known here) wait for you before anything starts: 409 NEEDS YOU with the line for Timmy's terminal. For the FAKE fixture:
 * its tools read fresh through the SDK route (which passes the server's hints on), the tool on its own list, the arguments
 * against its schema, the page's rule; then the call through the route the person picked, with the wire tap between the
 * route and the server, kept as /mcp call keeps it. Refused before any tool is called: an unknown tool (404), arguments that
 * fail the schema (422), a call that waits for you (409); 502 when the server's tools could not be read (nothing was called).
 */
export async function callFor(input: CallInput, ctx: InspectorCtx): Promise<CallAnswer> {
  const parsed = parseServerSpec(input.server);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  const spec = parsed.spec;
  const route = input.route;
  if (route !== 'sdk' && route !== 'mcporter') return { status: 400, error: 'pick a route: sdk or mcporter' };
  if (typeof input.tool !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.\-/:]{0,127}$/.test(input.tool)) return { status: 400, error: 'name the tool exactly as the server lists it' };
  const tool = input.tool;
  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) return { status: 400, error: 'the arguments are one JSON object (an empty one when the tool takes none)' };
  const args = input.args as Record<string, unknown>;
  const request = JSON.stringify(jsonRpcRequest(tool, args));
  const nothing = 'Nothing was started, and no record was written.';
  // a command line typed on the page: never started from it
  if (spec.kind === 'stdio') {
    const t = typedRefusal(spec.command, route, ctx.env, { tool, args });
    return { status: 409, refused: 'needs you', rule: t.rule, request, cli: t.cli, words: t.words, before: nothing };
  }
  const ref = refOf(spec, ctx.env);
  if (!ref.ok) return { status: 400, error: ref.error };
  if (route === 'sdk' && 'name' in ref.ref) return { status: 400, error: 'the SDK route runs a server from its command line only; a configured server is called through mcporter' };
  const lines = cliLines(spec, tool, args, ctx.env);
  // a configured server: its hints are never known here (mcporter drops them), so its call waits for you, and nothing starts
  if (spec.kind === 'configured') {
    const rule = pageRule(spec, tool, null, lines, route) as Extract<PageRule, { runs: false }>;
    return { status: 409, refused: 'needs you', rule, request, cli: lines, words: `NEEDS YOU: ${rule.why}. ${nothing} In Timmy's terminal: ${rule.command}`, before: nothing };
  }
  // the gate's own reading of the fixture's tools: the SDK route's (it passes the hints on)
  const gateRoute: McpRouteId = routeRungs(ctx.env).some((r) => r.id === 'sdk' && r.rung === 'installed') ? 'sdk' : 'mcporter';
  const gate = await listTools(gateRoute, ref.ref, { cwd: ctx.root, env: ctx.env, timeoutMs: LIST_TIMEOUT_MS });
  if (!gate.ok) return { status: 502, error: `the server's tools could not be read through the ${gateRoute} route, so nothing was called: ${gate.error ?? 'no answer'}`, gate: { route: gateRoute, ms: gate.ms } };
  const entry = gate.tools.find((t) => t.name === tool);
  const names = gate.allNames ?? gate.tools.map((t) => t.name);
  if (!entry) return { status: 404, error: `no tool named "${tool}" on ${labelOf(spec, ctx.env)}'s own list; nothing was called`, listed: names.slice(0, 50) };
  const checked = checkArgs(entry.inputSchema, args);
  if (!checked.valid) return { status: 422, refused: 'schema', errors: checked.errors, request, cli: lines, words: `Not sent: the arguments do not match ${tool}'s input schema (checked with the MCP SDK's validator), so nothing was called.` };
  const rule = pageRule(spec, tool, gateRoute === 'sdk' ? (entry.annotations ?? {}) : null, lines, route);
  const read = `Its own list was read through the ${gateRoute === 'sdk' ? 'SDK' : 'mcporter'} route (the server started for that, and stopped); ${tool} was not called, and no record was written.`;
  if (!rule.runs) return { status: 409, refused: 'needs you', rule, request, cli: lines, words: `NEEDS YOU: ${rule.why}. Nothing was called. In Timmy's terminal: ${rule.command}`, before: read };
  // the call, with the wire tap between the route and the server (stdio), as /mcp call keeps it
  const tap = ownScript('wire-tap');
  const box = mkdtempSync(join(tmpdir(), 'timmy-wire-'));
  const traceFile = join(box, 'wire.ndjson');
  try {
    const command = ref.command && tap.ok ? [...tap.argv, '--out', traceFile, '--', ...ref.command] : undefined;
    const run = await runToolCall(route, command ? { command } : ref.ref, tool, args, { cwd: ctx.root, env: ctx.env, timeoutMs: CALL_TIMEOUT_MS });
    // the record names the server, not the tap
    const name = labelOf(spec, ctx.env);
    run.facts.server = { ...run.facts.server, name };
    run.answer.server = name;
    run.facts.notes.push(FROM_PAGE);
    if (command) {
      let trace: Buffer | null = null;
      try { trace = readFileSync(traceFile); } catch { trace = null; }
      if (trace && trace.length) {
        const text = trace.toString('utf8');
        const all = text.split('\n').filter(Boolean);
        let kept = trace;
        if (kept.length > WIRE_KEPT_LIMIT) {
          // over the bound: the frames' times stay, their texts go
          kept = Buffer.from(`${all.map((l) => { try { const o = JSON.parse(l) as Record<string, unknown>; delete o.line; return JSON.stringify(o); } catch { return ''; } }).filter(Boolean).join('\n')}\n`, 'utf8');
          run.facts.notes.push('the wire trace was larger than Timmy keeps (512 KB): the frames\' times are kept, their texts are not');
        }
        const parsedLines = all.map((l) => { try { return JSON.parse(l) as TapLine; } catch { return null; } }).filter(Boolean) as TapLine[];
        run.facts.wire = { kept, frames: parsedLines.filter((l) => l.kind !== 'start' && l.kind !== 'end').length, sessions: new Set(parsedLines.map((l) => l.session)).size };
        run.facts.notes.push("through Timmy's wire tap between the route and the server (src/mcp/wire-tap.ts): wire.ndjson keeps each JSON-RPC frame with the time it passed there");
      } else run.facts.notes.push("the wire tap wrote no trace (the server did not start, or the route did not reach it)");
    }
    const record = writeMcpCall({ root: ctx.root, ...(ctx.project ? { project: ctx.project } : {}), seal: sealFor(ctx.root) }, run.facts);
    if (!record.ok) return { status: 502, error: `the call ran (${run.facts.outcome}), but its record could not be written: ${record.error}${record.receipt ? `; receipt ${record.receipt}` : ''}`, gate: { route: gateRoute, ms: gate.ms } };
    const view = await readCall(ctx.root, record.id);
    if (!view) return { status: 502, error: `the call ran (${run.facts.outcome}) and its record ${record.call} was written, but it could not be read back`, gate: { route: gateRoute, ms: gate.ms } };
    return { status: 200, call: view, cli: lines, rule };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

export type CheckAnswer =
  | { status: 400; error: string }
  /** rule: null when the listing the page read carried no hints for a server the call can read them from (it does, first) */
  | { status: 200; valid: boolean; errors: ArgError[]; request: string; cli: CliLines; rule: PageRule | null; ruleFrom: string };

/**
 * The form's check before a call (nothing is started): the arguments against the input schema the page's listing gave,
 * with the SDK's validator; the tools/call request; the exact command lines; and the page's rule on the hints that listing
 * gave. The call itself reads the server's list again and checks again (callFor): this is the preview of that.
 */
export function checkFor(input: CallInput & { inputSchema?: unknown; annotations?: unknown }, env: Env): CheckAnswer {
  const parsed = parseServerSpec(input.server);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  if (input.route !== 'sdk' && input.route !== 'mcporter') return { status: 400, error: 'pick a route: sdk or mcporter' };
  if (typeof input.tool !== 'string' || !input.tool) return { status: 400, error: 'name the tool' };
  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) return { status: 400, error: 'the arguments are one JSON object' };
  const args = input.args as Record<string, unknown>;
  const checked = checkArgs(input.inputSchema, args);
  if (parsed.spec.kind === 'stdio') {
    // a typed command line: checked and given as lines here, never started from the page
    const t = typedRefusal(parsed.spec.command, input.route, env, { tool: input.tool, args });
    return { status: 200, valid: checked.valid, errors: checked.errors, request: JSON.stringify(jsonRpcRequest(input.tool, args)), cli: t.cli, rule: t.rule, ruleFrom: 'a command line typed on this page is never started from it' };
  }
  const lines = cliLines(parsed.spec, input.tool, args, env);
  const hints = input.annotations && typeof input.annotations === 'object' && !Array.isArray(input.annotations) ? (input.annotations as Record<string, unknown>) : null;
  const later = !hints && parsed.spec.kind !== 'configured';
  return {
    status: 200, valid: checked.valid, errors: checked.errors, request: JSON.stringify(jsonRpcRequest(input.tool, args)), cli: lines,
    rule: later ? null : pageRule(parsed.spec, input.tool, hints, lines, input.route),
    ruleFrom: hints ? 'from the hints of the listing this page read; the call reads the server\'s list again first'
      : later ? 'the listing this page read carried no hints (MCPorter drops them): the call reads them through the SDK route first, and decides then'
        : 'a configured server\'s hints are never known here',
  };
}

/** The page's view of the tab: the routes, the FAKE fixture, the ingest modes, what sees the wire, and the newest calls. */
export function inspectorState(root: string, env: Env): {
  routes: RouteRung[]; fixture: FixtureInfo; modes: IngestMode[]; wire: WireTool[]; rule: string; calls: CallRow[]; more: number;
  project: { id: string; folder: string };
} {
  const chain = projectChain(root);
  const { calls, more } = callRows(root, 12, chain);
  return { routes: routeRungs(env), fixture: fixtureServer(env), modes: ingestModes(env), wire: wireTools(env), rule: PAGE_RULE, calls, more, project: { id: projectId(root), folder: basename(root) } };
}
