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
 * { ok, server, result }, or { ok: false, error }. Exit 0 on success, 1 on a failed call, 2 on bad usage.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  const fail = (e: unknown): number => {
    const message = e instanceof Error ? e.message : String(e);
    const lines = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean);
    const said = lines.find((l) => /\b\w*Error\b/.test(l)) ?? lines[lines.length - 1];
    const error = said ? `${message} (the server said: ${said.slice(0, 300)})` : message;
    say({ ok: false, error }, `error: ${error}`);
    return 1;
  };
  try {
    await client.connect(transport, { timeout: req.timeoutMs });
  } catch (e) {
    await client.close().catch(() => {});
    return fail(e);
  }
  const server = client.getServerVersion();
  try {
    if (req.verb === 'tools') {
      const { tools } = await client.listTools(undefined, { timeout: req.timeoutMs });
      say({ ok: true, server, tools }, tools.map((t) => `${t.name}${t.description ? `  ${t.description}` : ''}`).join('\n'));
      return 0;
    }
    const result = await client.callTool({ name: req.tool!, arguments: req.args }, undefined, { timeout: req.timeoutMs });
    const isError = (result as { isError?: boolean }).isError === true;
    say(isError ? { ok: false, server, error: textOf(result), result } : { ok: true, server, result }, textOf(result));
    return isError ? 1 : 0;
  } catch (e) {
    return fail(e);
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
