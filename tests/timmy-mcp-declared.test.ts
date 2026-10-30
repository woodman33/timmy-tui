/**
 * The 07:37 completion pass: the Timmy MCP page reads what `timmy mcp serve` declares (TIMMY_MCP_TOOLS, the same list its
 * tools/list answers), as a declaration — not a listing of a running server. Real: the module and a real `tools/list` over
 * stdio from the server run as a script.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIMMY_MCP_TOOLS } from '../src/mcp/server.js';

describe('Timmy MCP: the declared tools', () => {
  it('names are unique and carry the OpenHands, Animate and Command Post tools', () => {
    const names = TIMMY_MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['timmy_openhands_run', 'timmy_animate_catalog', 'timmy_animate_export', 'timmy_list_lanes', 'timmy_receipt_verify']));
    for (const t of TIMMY_MCP_TOOLS) expect(t.description.length).toBeGreaterThan(10);
  });

  it('tools/list from the server run as a script answers the same names', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/mcp/server.ts')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TIMMY_LOGS_OPEN: '0' } });
    try {
      const answer = await new Promise<{ result: { tools: Array<{ name: string }> } }>((ok, fail) => {
        let buf = '';
        const t = setTimeout(() => fail(new Error('no tools/list answer')), 30_000);
        child.stdout.on('data', (d) => { buf += d; const line = buf.split('\n').find((l) => l.includes('"id":2')); if (line) { clearTimeout(t); ok(JSON.parse(line)); } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      });
      expect(answer.result.tools.map((t) => t.name)).toEqual(TIMMY_MCP_TOOLS.map((t) => t.name));
    } finally { child.kill('SIGTERM'); }
  }, 40_000);
});
