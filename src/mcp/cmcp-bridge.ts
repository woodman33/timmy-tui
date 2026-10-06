// TIMMY cmcp bridge (client-tool-execution): an MCP server whose tool calls
// execute client-side by puppeting the real timmy MCP transport. Execution
// happens where the data lives; TIMMY receipts still seal every call.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClientExecServer, createClientExecClient } from '@mcpc-tech/cmcp';
import { join } from 'path';
import { VERSION } from '../version.js';

const root = process.cwd();
const tsx = join(root, 'node_modules', '.bin', 'tsx');

const server = new Server(
  { name: 'timmy-cmcp', version: VERSION },
  { capabilities: { tools: {} } }
);
// cmcp ships CJS typings against the SDK's cjs dist; ours is esm — interop cast
createClientExecServer(server as any, 'timmy');

const client = new Client(
  { name: 'timmy-cmcp-client', version: VERSION },
  { capabilities: {} }
);
createClientExecClient(client as any, 'timmy');
await client.connect(new StdioClientTransport({ command: tsx, args: [join(root, 'src/mcp/server.ts')] }));

await server.connect(new StdioServerTransport());
