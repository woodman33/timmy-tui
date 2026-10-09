// A tiny real MCP server over stdio for tests/mcp-cli.test.ts: two plain tools (echo, add) and two
// that exist to test limits (big: a long answer; hang: never answers, and will not stop on its own). Built on the SDK's Server and
// StdioServerTransport, the same pieces any stdio MCP server uses.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, writeFileSync } from 'node:fs';

// A test that must see this process end (the time limit) names a file here; the server writes its pid.
if (process.env.ECHO_FIXTURE_PID_FILE) writeFileSync(process.env.ECHO_FIXTURE_PID_FILE, String(process.pid));
// A test that must see which tools actually ran names a file here; every call appends the tool's name.
const callLog = process.env.ECHO_FIXTURE_CALL_LOG;

const server = new Server({ name: 'echo-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

const TOOLS = [
  { name: 'echo', description: 'Say the text back', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to say back' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'big', description: 'Answer with a long text', inputSchema: { type: 'object', properties: { size: { type: 'number', description: 'How many characters' } }, required: ['size'] } },
  { name: 'hang', description: 'Never answer', inputSchema: { type: 'object', properties: {} } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (callLog) appendFileSync(callLog, `${name}\n`);
  if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${String(args.text)}` }] };
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] };
  if (name === 'big') return { content: [{ type: 'text', text: 'x'.repeat(Math.max(0, Number(args.size) || 0)) }] };
  // A stubborn server: it never answers, outlives its closed stdin and shrugs off SIGTERM, so only a
  // time limit that stops the whole process group (SIGKILL after a grace) ends it.
  if (name === 'hang') { setInterval(() => {}, 60_000); process.on('SIGTERM', () => {}); return new Promise(() => {}); }
  // ECHO_FIXTURE_SDK_ERRORS=1 refuses an unknown tool in the SDK's own words, as McpServer does
  // ("Tool x not found"), the wording MCPorter's call reads as a misspelling to correct.
  throw new McpError(ErrorCode.InvalidParams, process.env.ECHO_FIXTURE_SDK_ERRORS === '1' ? `Tool ${name} not found` : `echo-fixture has no tool named ${name}`);
});

await server.connect(new StdioServerTransport());
