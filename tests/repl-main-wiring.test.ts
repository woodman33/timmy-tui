/**
 * Round R4 (H40): what src/repl/main.ts gives the agent. The REPL's instructions say iterate_native with the care
 * iterate_recipe gets (a flow id at once; nothing built or measured then), and the agent's MCP tools work in the active
 * project and put its name on each call_mcp_tool record (replMcpOptions). The server is tests/fixtures/mcp-echo-server.mjs
 * (a TEST DOUBLE: every answer is made up) on Timmy's SDK route; the seal here is a stand-in that keeps what it seals.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REPL_INSTRUCTIONS, replMcpOptions, replTools } from '../src/repl/main.js';
import type { ReceiptInput } from '../src/utils/receipts.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("what the REPL's agent is told and given", () => {
  it('the instructions say iterate_native beside iterate_recipe: a flow id at once, nothing built or measured then', () => {
    const recipe = REPL_INSTRUCTIONS.indexOf('iterate_recipe has a local, free code agent');
    const native = REPL_INSTRUCTIONS.indexOf('iterate_native does the same for an OpenSCAD model (app openscad');
    expect(recipe).toBeGreaterThan(-1);
    expect(native).toBeGreaterThan(recipe);
    const sentence = REPL_INSTRUCTIONS.slice(native, REPL_INSTRUCTIONS.indexOf('MCP servers:'));
    expect(sentence).toContain('or a FreeCAD script (app freecad: the agent may change only that script');
    expect(sentence).toContain('it returns a flow id at once: nothing is built or measured when you get it.');
  });

  it("call_mcp_tool works in the active project and its record carries the project's name (read at each call)", async () => {
    const first = temp('wiring-a-');
    const second = temp('wiring-b-');
    let active = { root: first, project: { name: 'first-project' } };
    const opts = replMcpOptions(() => active);
    expect([opts.cwd?.(), opts.project?.()]).toEqual([first, 'first-project']);
    const sealed: ReceiptInput[] = [];
    const tools = replTools(undefined, { root: () => active.root }, { mcp: { ...opts, seal: (input) => { sealed.push(input); return `id${sealed.length}`; } } });
    const call = (tools.find((t) => (t as unknown as { function: { name: string } }).function.name === 'call_mcp_tool')!.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
    const one = await call({ route: 'sdk', command: [process.execPath, FIXTURE], tool: 'echo', args: { text: 'in the first project' } });
    expect(one).toMatchObject({ ok: true, text: 'echo: in the first project', receipt: 'id1' });
    expect(JSON.parse(readFileSync(join(first, String(one.record)), 'utf8'))).toMatchObject({ project: 'first-project', tool: 'echo' });
    // /project switches: the next call is kept in the new project, under its name
    active = { root: second, project: { name: 'second-project' } };
    const two = await call({ route: 'sdk', command: [process.execPath, FIXTURE], tool: 'echo', args: { text: 'in the second project' } });
    expect(JSON.parse(readFileSync(join(second, String(two.record)), 'utf8'))).toMatchObject({ project: 'second-project' });
    expect(sealed.map((r) => [r.kind, r.project])).toEqual([['mcp.call', 'first-project'], ['mcp.call', 'second-project']]);
  }, 120_000);
});
