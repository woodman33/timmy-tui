/**
 * The 2026-10-27 shared-integrator order (the Treg checkpoint, adopted): Timmy's own stdio MCP server for Treg
 * (https://treg.to), the one remote transport both of Timmy's MCP routes reach Treg through. The routes stay independent
 * clients: MCPorter starts this server as an ad-hoc stdio command, Timmy's SDK route (mcp-sdk-cli) starts the same command
 * with its own Client; neither is the other.
 *
 * Adopted from the operator's private adapter of 2026-10-27 (kept outside this repository), with its limits unchanged:
 *   - the sign-in is the Treg CLI's own login file (`treg login` writes it), read anew for every request: `token` and an
 *     optional `active_org`. The file is the one TREG_CONFIG names (an absolute path), else <HOME>/.treg/config.json. No
 *     token is ever copied, printed, logged, put on a command line or answered: an answer that contains it is withheld;
 *   - one fixed endpoint, https://treg.to/mcp/, with Bearer authorization and X-Treg-Org; any other URL and every redirect
 *     are refused before a byte is sent; there is no endpoint override (tests reach the remote through the `fetch` seam);
 *   - only Treg's live definitions of catalog_search, catalog_get, balance and call are offered, their schemas forwarded
 *     unchanged (never manufactured); a call must name a tool observed in that same remote session;
 *   - 20 s per request; discovery bounded at 10 pages; no automatic retry of anything (a `call` may cost money: inspect
 *     Treg's history before calling again); no invented cost argument (the remote schema has none);
 *   - errors are said in fixed words, never the SDK's (they can carry remote headers or content); nothing goes to stdout but
 *     the protocol.
 *
 * Parent Timmy owns the records and receipts (`/mcp call` keeps .timmy/mcp/<call>/ and seals mcp.call; the companion's
 * connector operations, src/companion/connector-ops.ts, add theirs). Provider descriptions and answers are untrusted data.
 */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

type Env = Record<string, string | undefined>;
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export const TREG_ENDPOINT = 'https://treg.to/mcp/';
export const TREG_TOOLS = ['catalog_search', 'catalog_get', 'balance', 'call'] as const;
export type TregTool = (typeof TREG_TOOLS)[number];
const ALLOWED = new Set<string>(TREG_TOOLS);
export const TREG_TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;

export const AUTH_NEEDED = 'Treg needs sign-in: run `treg login` yourself (this server never starts a sign-in), or set TREG_CONFIG to the file it wrote.';
export const UNAVAILABLE = 'Treg did not complete the request: its sign-in, the network or the remote service failed. Nothing was retried; check Treg\'s history before calling a paid endpoint again.';
export const WITHHELD = 'Treg\'s answer was withheld: it contained the sign-in token.';

/** The sign-in file: TREG_CONFIG when it is an absolute path, else <HOME>/.treg/config.json (HOME as this process has it). */
export function tregConfigPath(env: Env = process.env): string {
  const named = env.TREG_CONFIG?.trim();
  if (named && isAbsolute(named)) return named;
  return join(env.HOME?.trim() || homedir(), '.treg', 'config.json');
}

/** The token and team from the CLI's login file, checked for shape only (never sent anywhere but the fixed endpoint). */
export async function readCredentials(path: string): Promise<{ token: string; org: string }> {
  let config: { token?: unknown; active_org?: unknown };
  try { config = JSON.parse(await readFile(path, 'utf8')) as typeof config; } catch { throw new Error(AUTH_NEEDED); }
  const token = typeof config?.token === 'string' ? config.token.trim() : '';
  if (!token || /[\r\n]/.test(token)) throw new Error(AUTH_NEEDED);
  const org = typeof config.active_org === 'string' ? config.active_org.trim() : '';
  if (/[\r\n]/.test(org)) throw new Error(AUTH_NEEDED);
  return { token, org };
}

/** The remote's own definitions of the allowed tools, unchanged (the same objects). */
export function allowedTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => t && ALLOWED.has(t.name));
}

/** The answer, unless it contains the token (then it is withheld whole). */
export function noCredentialEcho<T>(value: T, token: string): T {
  if (token && JSON.stringify(value)?.includes(token)) throw new Error(WITHHELD);
  return value;
}

export interface BridgeOptions {
  /** where the sign-in file is (default: tregConfigPath of this process's environment) */
  configPath?: string;
  /** test seam: the fetch every request goes through (the endpoint and redirect checks still apply) */
  fetch?: FetchLike;
}

async function withRemote<T>(o: BridgeOptions, run: (client: Client, signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const { token, org } = await readCredentials(o.configPath ?? tregConfigPath());
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TREG_TIMEOUT_MS);
  const cancelled = (): void => abort.abort();
  outer?.addEventListener('abort', cancelled, { once: true });
  if (outer?.aborted) abort.abort();
  const base = o.fetch ?? (fetch as FetchLike);
  const client = new Client({ name: 'timmy-treg', version: '1.0.0' });
  client.onerror = () => { /* never logged: it may carry remote headers or content */ };
  const transport = new StreamableHTTPClientTransport(new URL(TREG_ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...(org ? { 'X-Treg-Org': org } : {}) }, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (url, init) => {
      // the credentials go to the fixed endpoint only: any other URL is refused before anything is sent
      if (String(url) !== TREG_ENDPOINT) return Promise.reject(new Error('unexpected endpoint'));
      return base(url, { ...init, redirect: 'error', signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) });
    },
  });
  try {
    await client.connect(transport, { timeout: TREG_TIMEOUT_MS, signal: abort.signal });
    return noCredentialEcho(await run(client, abort.signal), token);
  } catch (e) {
    throw new Error((e as Error)?.message === WITHHELD ? WITHHELD : UNAVAILABLE);
  } finally {
    abort.abort();
    clearTimeout(timer);
    outer?.removeEventListener('abort', cancelled);
    // close ends the local transport only; it never repeats a tools/call
    await client.close().catch(() => undefined);
  }
}

async function remoteTools(client: Client, signal: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: TREG_TIMEOUT_MS });
    tools.push(...r.tools);
    if (!r.nextCursor) return allowedTools(tools);
    cursor = r.nextCursor;
  }
  throw new Error('the remote tool list went on past its bound');
}

const fixed = (e: unknown): string => {
  const m = (e as Error)?.message;
  return m === AUTH_NEEDED || m === WITHHELD ? m : UNAVAILABLE;
};

export function createTregBridge(o: BridgeOptions = {}): Server {
  const server = new Server({ name: 'timmy-treg', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.onerror = () => undefined;
  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    try { return await withRemote(o, async (client, signal) => ({ tools: await remoteTools(client, signal) }), extra.signal); } catch (e) { throw new McpError(ErrorCode.InternalError, fixed(e)); }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    if (!ALLOWED.has(req.params.name)) return { isError: true, content: [{ type: 'text', text: `Refused: ${req.params.name} is not one of the tools this server offers (${TREG_TOOLS.join(', ')}). Nothing was sent.` }] };
    try {
      return await withRemote(o, async (client, signal) => {
        const tools = await remoteTools(client, signal);
        if (!tools.some((t) => t.name === req.params.name)) throw new Error('not observed in this session');
        // no invented cost argument, no hidden retry: the caller gives the remote schema's own arguments
        return await client.callTool(req.params, undefined, { signal, timeout: TREG_TIMEOUT_MS }) as CallToolResult;
      }, extra.signal);
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: fixed(e) }] };
    }
  });
  return server;
}

const invokedDirectly = (): boolean => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (invokedDirectly()) {
  const server = createTregBridge();
  const stop = (): void => { void server.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.connect(new StdioServerTransport()).catch(() => process.exit(1));
}
