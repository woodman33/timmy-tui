/**
 * The agent's MCP tools (R2, MCP to CLI): find MCP servers and their tools, and call one, through the
 * command-line routes in src/connectors/mcp-cli.ts (MCPorter's CLI, or Timmy's own SDK CLI).
 *
 *   list_mcp_tools          read-only: the routes, MCPorter's configured servers, or the tools of a server
 *                           the operator configured (by name). It never starts a program from a command line.
 *   list_mcp_command_tools  starts a program from a command line to list its tools: asks every time
 *   call_mcp_tool           runs a server and calls one of its tools: asks every time
 *
 * A command line is any program on this machine, so only the asking tools take one (the same rule as a
 * workspace command: no pattern tells a safe command from a harmful one). Variables reach a server only
 * by name (pass_env, asking tools only); their values never appear in a call or an answer.
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
const COMMAND = z.array(z.string()).min(1).describe('A stdio MCP server as a command line, one word per item, e.g. ["npx","-y","some-mcp-server"]');
const PASS_ENV = z.array(z.string()).optional().describe('Names of environment variables the server needs (values are never shown)');

export function createMcpTools(o: McpToolOptions = {}) {
  const env = (): Env => (o.env ? o.env() : process.env);
  const runOpts = (passEnv?: string[], timeoutS?: number) => ({
    ...(o.cwd ? { cwd: o.cwd() } : {}),
    env: env(),
    passEnv: (passEnv ?? []).filter((n) => ENV_NAME.test(n)),
    ...(timeoutS ? { timeoutMs: Math.min(300, Math.max(1, timeoutS)) * 1000 } : {}),
  });
  const firstRoute = (): McpRouteId => mcpRoutes(env()).find((r) => r.available)?.id ?? 'mcporter';

  const list = tool({
    name: 'list_mcp_tools',
    description: "Find MCP servers and their tools through Timmy's command-line routes. With no server: the routes (MCPorter's CLI, Timmy's own SDK CLI) and whether each is installed, and the servers named in MCPorter's config (./config/mcporter.json, ~/.mcporter, editor imports), by name, with variable names only. With a server's name from that config: its tools and their parameters (this starts that configured server briefly). To list the tools of a server that is only a command line, use list_mcp_command_tools.",
    inputSchema: z.object({
      server: z.string().optional().describe("A server's name in MCPorter's config"),
    }),
    outputSchema: answer,
    execute: async (input: { server?: string }) => {
      if ((input as Record<string, unknown>).command !== undefined) return { ok: false, error: 'list_mcp_tools never starts a program from a command line: use list_mcp_command_tools, which asks the operator first' };
      const opts = runOpts();
      const routes = mcpRoutes(opts.env);
      if (!input.server) {
        const shown = routes.map((r) => ({ id: r.id, label: r.label, available: r.available, ...(r.version ? { version: r.version } : {}), details: r.details, ...(r.setup ? { setup: r.setup } : {}) }));
        const configured = routes.some((r) => r.id === 'mcporter' && r.available) ? await listServers('mcporter', opts) : null;
        return { ok: true, routes: shown, ...(configured ? (configured.ok ? { servers: configured.servers } : { servers_error: configured.error }) : {}) };
      }
      return { ...(await listTools('mcporter', { name: input.server }, opts)) };
    },
  });

  const listCommand = tool({
    name: 'list_mcp_command_tools',
    description: 'Start a stdio MCP server from its command line and list its tools and their parameters. The operator is asked first: the command runs on this machine. The server is stopped after the list, or when the time limit passes.',
    inputSchema: z.object({
      command: COMMAND,
      route: ROUTE.optional().describe('mcporter or sdk; default: the first installed route'),
      pass_env: PASS_ENV,
    }),
    outputSchema: answer,
    execute: async ({ command, route, pass_env }: { command: string[]; route?: McpRouteId; pass_env?: string[] }) => {
      if (!Array.isArray(command) || !command.length) return { ok: false, error: 'give the server as a command line, one word per item' };
      return { ...(await listTools(route ?? firstRoute(), { command }, runOpts(pass_env))) };
    },
  });

  const call = tool({
    name: 'call_mcp_tool',
    description: "Call one tool on an MCP server through a command-line route (MCPorter's CLI, or Timmy's own SDK CLI). The operator is asked first. Give the server as a name from MCPorter's config or as a command line, the tool's name and its arguments as an object (list_mcp_tools or list_mcp_command_tools shows them). The answer is the server's own: its text (at most 32 KB; a longer one is cut and says so), how long it took, or its error. A call that does not answer in time is stopped, server included.",
    inputSchema: z.object({
      route: ROUTE.optional().describe('mcporter (names and command lines) or sdk (command lines only); default: mcporter for a name, else the first installed route'),
      server: z.string().optional().describe("A server's name in MCPorter's config"),
      command: COMMAND.optional(),
      tool: z.string().min(1).describe("The tool's name on that server"),
      args: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments"),
      pass_env: PASS_ENV,
      timeout_s: z.number().optional().describe('Time limit in seconds (default 60, at most 300)'),
    }),
    outputSchema: answer,
    execute: async ({ route, server, command, tool: name, args, pass_env, timeout_s }: { route?: McpRouteId; server?: string; command?: string[]; tool: string; args?: Record<string, unknown>; pass_env?: string[]; timeout_s?: number }) => {
      const ref: McpServerRef | null = command?.length ? { command } : server ? { name: server } : null;
      if (!ref) return { ok: false, error: "which server? give server (a name in MCPorter's config) or command (a command line)" };
      const picked = route ?? ('name' in ref ? 'mcporter' : firstRoute());
      return { ...(await callTool(picked, ref, name, args ?? {}, runOpts(pass_env, timeout_s))) };
    },
  });

  return [list, listCommand, call];
}
