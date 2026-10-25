// Local protocol fixture: never represents a live Framer account.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'framer-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'open_project', description: 'Fixture only', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => ({
  isError: request.params.arguments?.projectId === 'fail',
  content: [{ type: 'text', text: JSON.stringify({ fixture: true, ...request.params }) }],
}));
await server.connect(new StdioServerTransport());
