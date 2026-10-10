/**
 * Timmy's own small MCP command line (R2, MCP to CLI, route "sdk"): list a stdio MCP server's tools or
 * call one, from the shell, on @modelcontextprotocol/sdk's Client and StdioClientTransport alone. It
 * shares nothing with MCPorter, so it still works when MCPorter is missing or broken.
 *
 *   mcp-sdk-cli tools [--json] [--timeout <ms>] -- <command> [args...]
 *   mcp-sdk-cli call <tool> [--args <json> | --args -] [--json] [--timeout <ms>] -- <command> [args...]
 *
 * The server runs with this process's environment and folder; whoever starts this decides what is in
 * them (src/connectors/mcp-cli.ts hands over a small base set plus the names asked for, never values on
 * the command line). With --json the answer is one JSON object on stdout: { ok, server, tools } or
 * { ok, server, result, tool }, or { ok: false, error }. Exit 0 on success, 1 on a failed call, 2 on bad usage.
 *
 * Round R4 (H34): `call` also reads the server's own entry for the tool from its tools/list, in the same session and
 * before the call, so its record can keep the server's annotations (readOnlyHint, destructiveHint, …): `tool` is
 * { name, title?, annotations? }, null when the server's list does not name the tool, and absent with
 * `tool_list_error` when the list could not be read (at most 5 s; the call runs either way).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

export interface SdkCliRequest {
  verb: 'tools' | 'call';
  tool?: string;
  args: Record<string, unknown>;
  json: boolean;
  timeoutMs: number;
  command: string[];
}

const USAGE = 'usage: mcp-sdk-cli tools [--json] [--timeout <ms>] -- <command> [args...]\n'
  + '       mcp-sdk-cli call <tool> [--args <json> | --args -] [--json] [--timeout <ms>] -- <command> [args...]';

export function parseSdkCliArgs(argv: string[]): SdkCliRequest | { error: string } {
  const split = argv.indexOf('--');
  if (split < 0 || split === argv.length - 1) return { error: 'give the server as a command line after --' };
  const head = argv.slice(0, split);
  const command = argv.slice(split + 1);
  const verb = head.shift();
  if (verb !== 'tools' && verb !== 'call') return { error: USAGE };
  const req: SdkCliRequest = { verb, args: {}, json: false, timeoutMs: 60_000, command };
  if (verb === 'call') {
    const tool = head.shift();
    if (!tool || tool.startsWith('--')) return { error: 'call needs a tool name' };
    req.tool = tool;
  }
  while (head.length) {
    const flag = head.shift();
    if (flag === '--json') req.json = true;
    else if (flag === '--timeout') {
      const ms = Number(head.shift());
      if (!Number.isFinite(ms) || ms <= 0) return { error: '--timeout needs a number of milliseconds' };
      req.timeoutMs = ms;
    } else if (flag === '--args') {
      // `--args -` reads the JSON from stdin, so the arguments stay off the process list.
      let parsed: unknown;
      const raw = head.shift();
      try { parsed = JSON.parse(raw === '-' ? readFileSync(0, 'utf8') : raw ?? ''); } catch { return { error: '--args needs a JSON object' }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: '--args needs a JSON object' };
      req.args = parsed as Record<string, unknown>;
    } else return { error: `unknown flag ${flag}\n${USAGE}` };
  }
  return req;
}

interface Out { write(s: string): unknown }

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('\n');
  return JSON.stringify(result, null, 2);
};

/**
 * R4 (H34): the server's own list entry for one tool. A plain tools/list request, not client.listTools(): that one
 * also caches each tool's output schema, and the SDK would then check the call's answer against it, which a call alone
 * never does here; so reading the entry leaves the call exactly as it was.
 */
async function toolEntry(client: Client, name: string, timeout: number): Promise<{ tool: Record<string, unknown> | null } | { tool_list_error: string }> {
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const listed = await client.request({ method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, ListToolsResultSchema, { timeout });
      const found = listed.tools.find((t) => t.name === name);
      if (found) return { tool: { name: found.name, ...(found.title ? { title: found.title } : {}), ...(found.annotations ? { annotations: found.annotations } : {}) } };
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return { tool: null };
  } catch (e) {
    return { tool_list_error: e instanceof Error ? e.message : String(e) };
  }
}

/** Run one request; returns the exit code. */
export async function runSdkCli(argv: string[], out: Out = process.stdout, err: Out = process.stderr): Promise<number> {
  const req = parseSdkCliArgs(argv);
  if ('error' in req) { err.write(`${req.error}\n`); return 2; }
  const say = (o: Record<string, unknown>, text: string): void => { out.write(req.json ? `${JSON.stringify(o)}\n` : `${text}\n`); };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  let stderrTail = '';
  const transport = new StdioClientTransport({ command: req.command[0], args: req.command.slice(1), env, stderr: 'pipe' });
  transport.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-2000); });
  const client = new Client({ name: 'timmy-mcp-sdk-cli', version: '1.0.0' }, { capabilities: {} });
  const fail = (e: unknown, more: Record<string, unknown> = {}): number => {
    const message = e instanceof Error ? e.message : String(e);
    const lines = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean);
    const said = lines.find((l) => /\b\w*Error\b/.test(l)) ?? lines[lines.length - 1];
    const error = said ? `${message} (the server said: ${said.slice(0, 300)})` : message;
    say({ ok: false, error, ...more }, `error: ${error}`);
    return 1;
  };
  try {
    await client.connect(transport, { timeout: req.timeoutMs });
  } catch (e) {
    await client.close().catch(() => {});
    return fail(e);
  }
  const server = client.getServerVersion();
  let listed: Awaited<ReturnType<typeof toolEntry>> | undefined;
  try {
    if (req.verb === 'tools') {
      const { tools } = await client.listTools(undefined, { timeout: req.timeoutMs });
      say({ ok: true, server, tools }, tools.map((t) => `${t.name}${t.description ? `  ${t.description}` : ''}`).join('\n'));
      return 0;
    }
    listed = await toolEntry(client, req.tool!, Math.min(5_000, req.timeoutMs));
    const result = await client.callTool({ name: req.tool!, arguments: req.args }, undefined, { timeout: req.timeoutMs });
    const isError = (result as { isError?: boolean }).isError === true;
    say(isError ? { ok: false, server, error: textOf(result), result, ...listed } : { ok: true, server, result, ...listed }, textOf(result));
    return isError ? 1 : 0;
  } catch (e) {
    return fail(e, listed ?? {});
  } finally {
    await client.close().catch(() => {});
  }
}

const invokedDirectly = (): boolean => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (invokedDirectly()) {
  runSdkCli(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`${String(e)}\n`); process.exit(1); });
}
