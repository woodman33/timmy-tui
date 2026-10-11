/**
 * The agent's MCP tools (R2, MCP to CLI; R3, the operator's configured servers): find MCP servers and their
 * tools, and call one, through the command-line routes in src/connectors/mcp-cli.ts (MCPorter's CLI, or Timmy's
 * own SDK CLI).
 *
 *   list_mcp_tools          read-only: the routes, and the servers MCPorter knows from the files (its config and
 *                           the editor configs it imports), by name. It starts no program and contacts no server.
 *   list_mcp_command_tools  starts a server to list its tools: one named in MCPorter's config (its configured
 *                           program on this machine, or its remote address), or any stdio command line. Asks
 *                           every time.
 *   call_mcp_tool           runs a server and calls one of its tools: asks every time
 *
 * Listing a configured server's tools starts that server: operator-configured software, but still a program
 * started (or a remote address contacted) on the model's say-so, so it asks, like a command line. Names must
 * match the config exactly and tools must be on the server's own list (mcp-cli.ts). Variables reach a server only
 * by name (pass_env, asking tools only); their values never appear in a call or an answer. A server that wants a
 * sign-in answers "needs authorization" with MCPorter's own step; no tool here starts a sign-in.
 *
 * Round R4 (H34): call_mcp_tool keeps the same record as the REPL's /mcp call (src/connectors/mcp-records.ts): its
 * call.json and raw output.json in the project's .timmy/mcp/<call-id>/, sealed with an `mcp.call` receipt on the runs
 * chain; the answer names both. A tool's annotations are the server's own claim, and come through the SDK route only.
 */
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import { callAndRecord, listServers, listTools, MCPORTER_DROPS_HINTS, mcpRoutes, type McpRouteId, type McpServerRef } from '../connectors/mcp-cli.js';
import { appendReceipt, type ReceiptInput } from '../utils/receipts.js';

type Env = Record<string, string | undefined>;
export interface McpToolOptions {
  /** The folder MCPorter runs in (its ./config/mcporter.json), and the project a call's record is kept in; default: this process's folder. */
  cwd?: () => string;
  env?: () => Env;
  /** R4 (H34): the project's name for a call's record and receipt. */
  project?: () => string | undefined;
  /** R4 (H34): seals a call's receipt (a short id back); default: appendReceipt on the runs chain, as the REPL's own seal. */
  seal?: (input: ReceiptInput) => string | undefined;
}

/** The REPL's own seal (src/repl/main.ts): the runs chain through appendReceipt, the short id back. */
const sealOnRuns = (input: ReceiptInput): string | undefined => appendReceipt('runs', input).hash.slice(7, 15);

const answer = z.record(z.string(), z.unknown());
const ROUTE = z.enum(['mcporter', 'sdk']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND = z.array(z.string()).min(1).describe('A stdio MCP server as a command line, one word per item, e.g. ["npx","-y","some-mcp-server"]');
const SERVER = z.string().min(1).describe("A server's exact name in MCPorter's config or editor imports (list_mcp_tools shows them)");
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
    description: "Find MCP servers through Timmy's command-line routes, read-only: the routes (MCPorter's CLI, Timmy's own SDK CLI) and whether each is installed, and every server MCPorter knows from the files: its config (./config/mcporter.json, ~/.mcporter/mcporter.json) and the editor configs it imports (Cursor, Claude Code, Claude Desktop, Codex, Windsurf, OpenCode, VS Code). Each with its name, transport (stdio or http), the file it came from, the sign-in its config names, and variable and header names only. Nothing is started or contacted. To see a server's tools, use list_mcp_command_tools with its name (that starts it, so the operator is asked).",
    // Loose: the SDK parses a live turn's arguments first, and a strict-or-stripping object would drop a server
    // name silently; kept, it gets the pointer to the asking tool. The advertised schema still lists nothing.
    inputSchema: z.looseObject({}),
    outputSchema: answer,
    execute: async (input: Record<string, unknown>) => {
      const raw = (input ?? {}) as Record<string, unknown>;
      if (raw.command !== undefined) return { ok: false, error: 'list_mcp_tools never starts a program from a command line: use list_mcp_command_tools, which asks the operator first' };
      if (raw.server !== undefined) return { ok: false, error: "list_mcp_tools never starts a server: to list a configured server's tools, use list_mcp_command_tools with server set to its name (the operator is asked first)" };
      const opts = runOpts();
      const routes = mcpRoutes(opts.env);
      const shown = routes.map((r) => ({ id: r.id, label: r.label, available: r.available, ...(r.version ? { version: r.version } : {}), details: r.details, ...(r.setup ? { setup: r.setup } : {}) }));
      const configured = routes.some((r) => r.id === 'mcporter' && r.available) ? await listServers('mcporter', opts) : null;
      return { ok: true, routes: shown, ...(configured ? (configured.ok ? { servers: configured.servers, servers_note: 'read from the files; no server was contacted' } : { servers_error: configured.error }) : {}) };
    },
  });

  const listCommand = tool({
    name: 'list_mcp_command_tools',
    description: "Start an MCP server and list its tools and their parameters: a server named in MCPorter's config or editor imports (give server; it runs through MCPorter), or any stdio server from its command line (give command). The operator is asked first, every time: a configured stdio server runs its configured program on this machine, and an HTTP server is contacted at its address. The server is stopped after the list, or when the time limit passes. A server that wants a sign-in answers needs authorization, with the step the operator can run.",
    inputSchema: z.object({
      server: SERVER.optional(),
      command: COMMAND.optional(),
      route: ROUTE.optional().describe('For a command line: mcporter or sdk (default: the first installed route). A name always goes through mcporter.'),
      pass_env: PASS_ENV,
    }),
    outputSchema: answer,
    execute: async ({ server, command, route, pass_env }: { server?: string; command?: string[]; route?: McpRouteId; pass_env?: string[] }) => {
      if (Array.isArray(command) && command.length && server) return { ok: false, error: 'give server (a configured name) or command (a command line), not both' };
      // R4 (H34): the server's own hints come with each tool on the SDK route; on MCPorter's they are not known.
      const hinted = (picked: McpRouteId, r: Awaited<ReturnType<typeof listTools>>): Record<string, unknown> => ({
        ...r, ...(r.ok ? { annotations_note: picked === 'mcporter' ? MCPORTER_DROPS_HINTS : "each tool's annotations are the server's own hints, as it lists them: its claim, not checked" } : {}),
      });
      if (Array.isArray(command) && command.length) { const picked = route ?? firstRoute(); return hinted(picked, await listTools(picked, { command }, runOpts(pass_env))); }
      if (typeof server === 'string' && server) { const picked = route ?? 'mcporter'; return hinted(picked, await listTools(picked, { name: server }, runOpts(pass_env))); }
      return { ok: false, error: "which server? give server (a name in MCPorter's config, as list_mcp_tools shows) or command (a command line, one word per item)" };
    },
  });

  const call = tool({
    name: 'call_mcp_tool',
    description: "Call one tool on an MCP server through a command-line route (MCPorter's CLI, or Timmy's own SDK CLI). The operator is asked first. Give the server as its exact name in MCPorter's config or editor imports, or as a command line; the tool's exact name and its arguments as an object (list_mcp_command_tools shows them). Through MCPorter the tool must be on the server's own list: a near miss is refused, never corrected. The answer is the server's own: its text (at most 32 KB; a longer one is cut and says so), how long it took, or its error; an error answer (isError) says what the server said; a server that wants a sign-in answers needs authorization. A call that does not answer in time is stopped, server included. Every call is kept in the project as a record (record: .timmy/mcp/<call-id>/call.json, and output: the raw output.json) sealed with an mcp.call receipt (receipt).",
    inputSchema: z.object({
      route: ROUTE.optional().describe('mcporter (names and command lines) or sdk (command lines only); default: mcporter for a name, else the first installed route'),
      server: SERVER.optional(),
      command: COMMAND.optional(),
      tool: z.string().min(1).describe("The tool's exact name on that server"),
      args: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments"),
      pass_env: PASS_ENV,
      timeout_s: z.number().optional().describe('Time limit in seconds (default 60, at most 300)'),
    }),
    outputSchema: answer,
    execute: async ({ route, server, command, tool: name, args, pass_env, timeout_s }: { route?: McpRouteId; server?: string; command?: string[]; tool: string; args?: Record<string, unknown>; pass_env?: string[]; timeout_s?: number }) => {
      const ref: McpServerRef | null = command?.length ? { command } : server ? { name: server } : null;
      if (!ref) return { ok: false, error: "which server? give server (a name in MCPorter's config) or command (a command line)" };
      const picked = route ?? ('name' in ref ? 'mcporter' : firstRoute());
      const opts = runOpts(pass_env, timeout_s);
      // R4 (H34): the same record and receipt as the REPL's /mcp call, in the project (the folder MCPorter runs in).
      const { run, record } = await callAndRecord(picked, ref, name, args ?? {}, opts, { root: opts.cwd ?? process.cwd(), project: o.project?.(), seal: o.seal ?? sealOnRuns });
      return {
        ...run.answer,
        ...(record?.ok ? { record: record.call, ...(record.output ? { output: record.output } : {}) } : record ? { record_error: record.error } : {}),
        ...(record?.receipt ? { receipt: record.receipt } : {}),
      };
    },
  });

  return [list, listCommand, call];
}
