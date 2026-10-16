#!/usr/bin/env node
/**
 * R6 (H142): Timmy's FAKE stdio MCP server, for trying the Tools & MCP inspector (the browser companion's tab 9) and both
 * MCP-to-CLI routes (`/mcp call --route sdk …` and `--route mcporter …`) with no network, no account and no real server.
 *
 * FAKE: every tool and every answer here is made up, and each says so: "FAKE" opens each tool's title, description and
 * answer. Nothing is measured, nothing is written, nothing leaves this computer; fake_write_note writes nothing either (it
 * says what a real server would have done). Its tools carry the server's own hints (annotations), as a real server's list
 * does, so the inspector's rules can be seen at work: fake_write_note says it is not read-only and destructive, so a call
 * of it from the companion waits for you; the others say they are read-only.
 *
 *   node dist/src/mcp/fake-fixture-server.js          (built)
 *   node --import tsx src/mcp/fake-fixture-server.ts  (from a source checkout)
 *
 * `--call-log <file>` (or TIMMY_FAKE_MCP_CALL_LOG=<file>) appends each called tool's name to that file: a test's way to see
 * what reached the server, and that a refused call did not (the routes hand a server a small base environment only, so a
 * test names the file on the command line).
 */
import { appendFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

export const FAKE_FIXTURE_NAME = 'timmy-fake-fixture';
export const FAKE_FIXTURE_VERSION = '1.0.0';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** The fixture's tools, as its tools/list gives them. */
export const FAKE_TOOLS: Tool[] = [
  {
    name: 'fake_echo',
    title: 'FAKE echo',
    description: 'FAKE: says your words back, once or up to three times. Made up by the fixture; nothing is checked.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 200, description: 'The words to say back' },
        times: { type: 'integer', minimum: 1, maximum: 3, default: 1, description: 'How many times (1 to 3)' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { title: 'FAKE echo', ...readOnly },
  },
  {
    name: 'fake_measure',
    title: 'FAKE measure',
    description: 'FAKE: the area and perimeter of a rectangle from the two sides you give, as JSON. Arithmetic on your numbers, not a measurement of anything.',
    inputSchema: {
      type: 'object',
      properties: {
        width_mm: { type: 'number', exclusiveMinimum: 0, maximum: 10000, description: 'One side, in millimetres' },
        height_mm: { type: 'number', exclusiveMinimum: 0, maximum: 10000, description: 'The other side, in millimetres' },
        unit: { type: 'string', enum: ['mm', 'cm', 'in'], default: 'mm', description: 'The unit the answer is given in' },
      },
      required: ['width_mm', 'height_mm'],
      additionalProperties: false,
    },
    annotations: { title: 'FAKE measure', ...readOnly },
  },
  {
    name: 'fake_swatch',
    title: 'FAKE swatch',
    description: 'FAKE: a small PNG drawn by the fixture (an image content item), with a label. An image made up here, not a capture.',
    inputSchema: {
      type: 'object',
      properties: {
        shade: { type: 'string', enum: ['amber', 'grey', 'green'], description: 'The shade the fixture draws' },
        label: { type: 'string', maxLength: 40, description: 'Words said beside the image' },
      },
      required: ['shade'],
      additionalProperties: false,
    },
    annotations: { title: 'FAKE swatch', ...readOnly },
  },
  {
    name: 'fake_fail',
    title: 'FAKE failure',
    description: "FAKE: answers with the server's own error (isError), as a server that cannot do what it was asked answers.",
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', maxLength: 120, description: 'The words the error carries' } },
      additionalProperties: false,
    },
    annotations: { title: 'FAKE failure', ...readOnly },
  },
  {
    name: 'fake_write_note',
    title: 'FAKE write a note',
    description: 'FAKE: a tool that says it changes things (not read-only, destructive). The fixture writes nothing; its answer says what a real server would have done.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', minLength: 1, maxLength: 200, description: 'The note a real server would write' } },
      required: ['note'],
      additionalProperties: false,
    },
    annotations: { title: 'FAKE write a note', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

// ── a small PNG, drawn here (the fixture's own image: an image item keeps its own colors on every surface) ──

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const SHADES: Readonly<Record<string, readonly [number, number, number]>> = { amber: [0xff, 0xb0, 0x00], grey: [0x8e, 0x8e, 0x93], green: [0x28, 0xfe, 0x14] };

/** A 64×40 PNG: the shade as a band of squares on black, with a frame. */
export function swatchPng(shade: string): Buffer {
  const [r, g, b] = SHADES[shade] ?? SHADES.grey;
  const w = 64;
  const h = 40;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const frame = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      const square = !frame && y >= 8 && y < 32 && (Math.floor((x - 4) / 8) % 2 === 0) && x >= 4 && x < 60;
      const on = frame || square;
      const at = y * (w * 3 + 1) + 1 + x * 3;
      raw[at] = on ? r : 0;
      raw[at + 1] = on ? g : 0;
      raw[at + 2] = on ? b : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── the answers ──

const round = (n: number): number => Math.round(n * 1000) / 1000;
const UNIT_MM: Readonly<Record<string, number>> = { mm: 1, cm: 10, in: 25.4 };

/** One call's answer (an MCP CallToolResult), or an McpError for a tool the fixture does not have. */
export function fakeAnswer(name: string, args: Record<string, unknown>): CallToolResult {
  if (name === 'fake_echo') {
    const times = Math.max(1, Math.min(3, Number.isInteger(args.times) ? Number(args.times) : 1));
    return { content: [{ type: 'text', text: Array.from({ length: times }, () => `FAKE echo: ${String(args.text ?? '')}`).join('\n') }] };
  }
  if (name === 'fake_measure') {
    const w = Number(args.width_mm);
    const h = Number(args.height_mm);
    const unit = typeof args.unit === 'string' && UNIT_MM[args.unit] ? args.unit : 'mm';
    const k = UNIT_MM[unit];
    const answer = { fake: true, note: 'FAKE: arithmetic on the numbers given, not a measurement', unit, width: round(w / k), height: round(h / k), area: round((w * h) / (k * k)), perimeter: round((2 * (w + h)) / k) };
    return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer };
  }
  if (name === 'fake_swatch') {
    const shade = typeof args.shade === 'string' && SHADES[args.shade] ? args.shade : 'grey';
    const label = typeof args.label === 'string' && args.label ? `: ${args.label}` : '';
    return { content: [{ type: 'image', mimeType: 'image/png', data: swatchPng(shade).toString('base64') }, { type: 'text', text: `FAKE swatch (${shade})${label}: a 64×40 PNG drawn by the fixture, not a capture` }] };
  }
  if (name === 'fake_fail') {
    return { content: [{ type: 'text', text: `FAKE error: ${typeof args.reason === 'string' && args.reason ? args.reason : 'the fixture was asked to fail, so it did'}` }], isError: true };
  }
  if (name === 'fake_write_note') {
    return { content: [{ type: 'text', text: `FAKE: a real server would have written "${String(args.note ?? '')}"; this fixture wrote nothing.` }] };
  }
  throw new McpError(ErrorCode.InvalidParams, `${FAKE_FIXTURE_NAME} has no tool named ${name}`);
}

/** Serves the fixture over stdio until its input ends. */
export async function serveFakeFixture(argv: string[] = process.argv.slice(2)): Promise<void> {
  const at = argv.indexOf('--call-log');
  const callLog = (at >= 0 ? argv[at + 1] : undefined) || process.env.TIMMY_FAKE_MCP_CALL_LOG;
  const server = new Server({ name: FAKE_FIXTURE_NAME, version: FAKE_FIXTURE_VERSION }, { capabilities: { tools: {} }, instructions: 'FAKE: Timmy\'s test server; every answer is made up.' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FAKE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (callLog) { try { appendFileSync(callLog, `${name}\n`); } catch { /* the log is a test's; the answer stands */ } }
    return fakeAnswer(name, args as Record<string, unknown>);
  });
  await server.connect(new StdioServerTransport());
}

const invokedDirectly = (): boolean => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (invokedDirectly()) {
  serveFakeFixture().catch((e: unknown) => { process.stderr.write(`FAKE fixture could not start: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
