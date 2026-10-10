// A tiny real MCP server over stdio for tests/mcp-cli.test.ts, tests/mcp-servers.test.ts and tests/mcp-records.test.ts:
// two plain tools (echo, add), two that exist to test limits (big: a long answer; hang: never answers, and will not
// stop on its own), and four that answer in the shapes a real server uses (R4, H34): fail (the server's own error,
// isError), lines (many lines), json (JSON as text) and mixed (text, an image, a resource and structuredContent).
// Some tools carry the server's own hints (annotations), as a real server's list does; big and hang carry none.
// Built on the SDK's Server and StdioServerTransport, the same pieces any stdio MCP server uses. A test double:
// every answer here is made up.
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
  { name: 'echo', description: 'Say the text back', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to say back' } }, required: ['text'] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'big', description: 'Answer with a long text', inputSchema: { type: 'object', properties: { size: { type: 'number', description: 'How many characters' } }, required: ['size'] } },
  { name: 'hang', description: 'Never answer', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: "Answer with the server's own error (isError)", inputSchema: { type: 'object', properties: { json: { type: 'boolean', description: 'Say it as JSON text' } } }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'lines', description: 'Answer with many lines', inputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
  { name: 'json', description: 'Answer with JSON as text', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'mixed', description: 'Answer with text, an image, a resource and structured content', inputSchema: { type: 'object', properties: {} } },
];

/** The fixture's own error, worded as a server that needs a user action words it. */
const FIXTURE_ERROR = 'No editor is connected. Open the document in the editor, enable the bridge, then retry.';

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
  if (name === 'fail') {
    const text = args.json === true ? JSON.stringify({ error: 'no editor', hint: 'open the document, then retry' }) : FIXTURE_ERROR;
    return { content: [{ type: 'text', text }], isError: true };
  }
  if (name === 'lines') {
    const n = Math.max(0, Math.min(10_000, Number(args.count) || 0));
    return { content: [{ type: 'text', text: Array.from({ length: n }, (_, i) => `line ${i + 1} of ${n}`).join('\n') }] };
  }
  if (name === 'json') {
    const query = String(args.query ?? '');
    return { content: [{ type: 'text', text: JSON.stringify({ query, results: [{ title: 'First result', score: 0.9 }, { title: 'Second result', score: 0.5 }] }) }] };
  }
  if (name === 'mixed') {
    return {
      content: [
        { type: 'text', text: 'two more items follow' },
        { type: 'image', data: Buffer.alloc(300, 7).toString('base64'), mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///fixture/notes.txt', mimeType: 'text/plain', text: 'the resource body, not shown' } },
      ],
      structuredContent: { count: 2, ok: true },
    };
  }
  // ECHO_FIXTURE_SDK_ERRORS=1 refuses an unknown tool in the SDK's own words, as McpServer does
  // ("Tool x not found"), the wording MCPorter's call reads as a misspelling to correct.
  throw new McpError(ErrorCode.InvalidParams, process.env.ECHO_FIXTURE_SDK_ERRORS === '1' ? `Tool ${name} not found` : `echo-fixture has no tool named ${name}`);
});

await server.connect(new StdioServerTransport());
