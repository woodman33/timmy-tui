#!/usr/bin/env node
// A FAKE Treg MCP server (a TEST DOUBLE) for tests/connector-ops.test.ts and the Tools & integrations captures: the four tool
// names Timmy's Treg bridge offers (catalog_search, catalog_get, balance, call), with small schemas in the shape Treg's
// own list gives, and made-up answers. Nothing here contacts treg.to; no answer is a real price, balance or result.
// FAKE_TREG_LOG: a file each call appends one JSON line to ({ tool, args, treg_config }), so a test can count calls.
// FAKE_TREG_CALL=slow: `call` answers after FAKE_TREG_SLOW_MS (default 3000). FAKE_TREG_TOKEN: a string `balance`
// answers with, to test that an answer carrying it is never kept by Timmy's own bridge (not used through this server).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';

const log = process.env.FAKE_TREG_LOG;
const s = (title, type = 'string') => ({ title, type });
const TOOLS = [
  { name: 'catalog_search', description: 'FAKE: search the made-up catalog by what you want to do.', inputSchema: { type: 'object', properties: { query: s('Query'), limit: { title: 'Limit', type: 'integer', default: 8 } }, required: ['query'] } },
  { name: 'catalog_get', description: 'FAKE: one made-up endpoint in full, with its made-up price.', inputSchema: { type: 'object', properties: { endpoint_id: s('Endpoint Id') }, required: ['endpoint_id'] } },
  { name: 'balance', description: 'FAKE: a made-up prepaid balance.', inputSchema: { type: 'object', properties: {} } },
  { name: 'call', description: 'FAKE: call a made-up endpoint.', inputSchema: { type: 'object', properties: { endpoint_id: s('Endpoint Id'), params: { title: 'Params', type: 'object' }, method: s('Method'), idempotency_key: s('Idempotency Key'), query: { title: 'Query', type: 'object' }, body: { title: 'Body' } }, required: ['endpoint_id'] } },
];
const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });

const server = new Server({ name: 'fake-treg', version: '0.0.1-FAKE' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (log) appendFileSync(log, `${JSON.stringify({ tool: name, args, treg_config: process.env.TREG_CONFIG ?? null })}\n`);
  if (name === 'catalog_search') {
    return text({ query: args.query, count: 2, verdict: 'strong', results: [
      { endpoint_id: 'fake.demo.profile', name: 'FAKE profile lookup', provider: 'fake', usd_per_call: 0.001, no_key_needed: true },
      { endpoint_id: 'fake.demo.free', name: 'FAKE free lookup', provider: 'fake', usd_per_call: 0, no_key_needed: true },
    ], note: 'FAKE catalog: a test double' });
  }
  if (name === 'catalog_get') {
    if (args.endpoint_id === 'fake.demo.unpriced') return text({ endpoint: { id: 'fake.demo.unpriced', name: 'FAKE unpriced endpoint', method: 'GET', cost: { type: 'unknown' } } });
    return text({ endpoint: { id: String(args.endpoint_id), name: 'FAKE profile lookup', method: 'GET', cost: { type: 'per_success', value: 0.001, currency: 'USD', usd: 0.001, note: 'charged on 2xx only', checked: '2026-10-27', confidence: 'FAKE' } } });
  }
  if (name === 'balance') return text({ balance_usd: 0.5, balance_micro: 500000, note: 'FAKE balance' });
  if (name === 'call') {
    if (process.env.FAKE_TREG_CALL === 'slow') await new Promise((r) => setTimeout(r, Number(process.env.FAKE_TREG_SLOW_MS ?? 3000)));
    return text({ http_status: 200, charged_micro: 1000, call_id: 'fake-call-0001', idempotency_key: args.idempotency_key ?? null, data: { echo: args.query ?? args.params ?? null, cost: 99 }, note: 'FAKE call: nothing was charged' });
  }
  return { isError: true, content: [{ type: 'text', text: `FAKE: no tool ${name}` }] };
});
await server.connect(new StdioServerTransport());
