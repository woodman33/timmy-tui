// TIMMY as a composed agentic MCP server (mcpc): wraps the governance tools
// (and optional helper lanes) into one agent surface. Wrap-don't-compete —
// every call still lands in TIMMY's receipts via the upstream timmy server.
import { mcpc } from '@mcpc/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'path';
import { VERSION } from '../version.js';

const root = process.cwd();
const tsx = join(root, 'node_modules', '.bin', 'tsx');

const server = await mcpc(
  [{ name: 'timmy-agent', version: VERSION }, { capabilities: { tools: {} } }],
  [{
    name: 'timmy-agent',
    description: `
      I am TIMMY, the Agent Trust OS. I govern agent runs with signed,
      hash-chained receipts; I never spend without an operator token bound to
      the complete plan hash.

      Available tools:
      <tool name="timmy.__ALL__"/>
      <tool name="3minapi.__ALL__"/>
    `,
    options: { mode: 'agentic' },
    deps: {
      mcpServers: {
        timmy: { command: tsx, args: [join(root, 'src/mcp/server.ts')], transportType: 'stdio' },
        ...(process.env.THREEMINAPI_KEY ? {
          '3minapi': {
            transportType: 'streamable-http' as const,
            url: 'https://3minapi.com/api/mcp',
            headers: { 'x-api-key': '${THREEMINAPI_KEY}' }
          }
        } : {})
      }
    }
  }]
);

await server.connect(new StdioServerTransport());
