/**
 * The agent's MCP tools (R2, MCP to CLI): find MCP servers and their tools, and call one, through the
 * command-line routes in src/connectors/mcp-cli.ts (MCPorter's CLI, or Timmy's own SDK CLI).
 *
 *   list_mcp_tools  read-only: the routes, MCPorter's configured servers, or one server's tools
 *   call_mcp_tool   runs a server and calls a tool: the operator is asked every time
 *
 * A server is either a name from MCPorter's config or a command line (an array of words). Variables
 * reach a server only by name (pass_env); their values never appear in a call or an answer.
 */
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import { callTool, listServers, listTools, mcpRoutes, type McpRouteId, type McpServerRef } from '../connectors/mcp-cli.js';

type Env = Record<string, string | undefined>;
export interface McpToolOptions {
  /** The folder MCPorter runs in (its ./config/mcporter.json); default: this process's folder. */
  cwd?: () => string;
  env?: () => Env;
}

const answer = z.record(z.string(), z.unknown());
const ROUTE = z.enum(['mcporter', 'sdk']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const serverOf = (server?: string, command?: string[]): McpServerRef | null =>
  command?.length ? { command } : server ? { name: server } : null;

export function createMcpTools(o: McpToolOptions = {}) {
  const runOpts = (passEnv?: string[], timeoutS?: number) => ({
    ...(o.cwd ? { cwd: o.cwd() } : {}),
    env: o.env ? o.env() : process.env,
    passEnv: (passEnv ?? []).filter((n) => ENV_NAME.test(n)),
    ...(timeoutS ? { timeoutMs: Math.min(300, Math.max(1, timeoutS)) * 1000 } : {}),
  });
  const pickRoute = (route: McpRouteId | undefined, ref: McpServerRef): McpRouteId => {
    if (route) return route;
    if ('name' in ref) return 'mcporter';
    return mcpRoutes(o.env ? o.env() : process.env).find((r) => r.available)?.id ?? 'mcporter';
  };

  const list = tool({
    name: 'list_mcp_tools',
    description: "Find MCP servers and their tools through Timmy's command-line routes (MCPorter's CLI, or Timmy's own SDK CLI). With no server: the routes and whether each is installed, and the servers named in MCPorter's config. With a server name (from MCPorter's config) or a command line that starts a stdio server: that server's tools and their parameters. Starting a server to list its tools runs it briefly.",
    inputSchema: z.object({
      route: ROUTE.optional().describe('mcporter (config names and command lines) or sdk (command lines only); default: mcporter for a name, else the first installed route'),
      server: z.string().optional().describe("A server's name in MCPorter's config"),
      command: z.array(z.string()).min(1).optional().describe('A stdio server as a command line, one word per item, e.g. ["npx","-y","some-mcp-server"]'),
      pass_env: z.array(z.string()).optional().describe('Names of environment variables the server needs (values are never shown)'),
    }),
    outputSchema: answer,
    execute: async ({ route, server, command, pass_env }: { route?: McpRouteId; server?: string; command?: string[]; pass_env?: string[] }) => {
      const ref = serverOf(server, command);
      const opts = runOpts(pass_env);
      if (!ref) {
        const routes = mcpRoutes(opts.env).map((r) => ({ id: r.id, label: r.label, available: r.available, ...(r.version ? { version: r.version } : {}), details: r.details, ...(r.setup ? { setup: r.setup } : {}) }));
        const configured = routes.some((r) => r.id === 'mcporter' && r.available) ? await listServers('mcporter', opts) : null;
        return { ok: true, routes, ...(configured ? (configured.ok ? { servers: configured.servers } : { servers_error: configured.error }) : {}) };
      }
      const r = await listTools(pickRoute(route, ref), ref, opts);
      return { ...r };
    },
  });

  const call = tool({
    name: 'call_mcp_tool',
    description: "Call one tool on an MCP server through a command-line route (MCPorter's CLI, or Timmy's own SDK CLI). The operator is asked first. Give the server as a name from MCPorter's config or as a command line, the tool's name and its arguments as an object (list_mcp_tools shows them). The answer is the server's own: its text (at most 32 KB; a longer one is cut and says so), how long it took, or its error. A call that does not answer in time is stopped, server included.",
    inputSchema: z.object({
      route: ROUTE.optional().describe('mcporter or sdk; default: mcporter for a name, else the first installed route'),
      server: z.string().optional().describe("A server's name in MCPorter's config"),
      command: z.array(z.string()).min(1).optional().describe('A stdio server as a command line, one word per item'),
      tool: z.string().min(1).describe("The tool's name on that server"),
      args: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments"),
      pass_env: z.array(z.string()).optional().describe('Names of environment variables the server needs (values are never shown)'),
      timeout_s: z.number().optional().describe('Time limit in seconds (default 60, at most 300)'),
    }),
    outputSchema: answer,
    execute: async ({ route, server, command, tool: name, args, pass_env, timeout_s }: { route?: McpRouteId; server?: string; command?: string[]; tool: string; args?: Record<string, unknown>; pass_env?: string[]; timeout_s?: number }) => {
      const ref = serverOf(server, command);
      if (!ref) return { ok: false, error: "which server? give server (a name in MCPorter's config) or command (a command line)" };
      const r = await callTool(pickRoute(route, ref), ref, name, args ?? {}, runOpts(pass_env, timeout_s));
      return { ...r };
    },
  });

  return [list, call];
}
