/**
 * Round R4 (helper H107; r25, the scripted rehearsal on the operator's Mac at 5e5cbb3, finding D13): /lanes said
 * "unreal-mcp Unreal MCP · found (not checked)" only because mcporter, the program that lane runs, was on PATH (as a package
 * dependency). An MCP-backed lane is found only when its server is configured for Timmy: a server of that name in
 * MCPorter's own configuration as Timmy's route reads it (the home config under TIMMY_MCP_HOME, or the home's when that is
 * not set, and the route's own config/mcporter.json; only $MCPORTER_CONFIG when that is set). Otherwise /lanes says
 * "mcporter found, no Unreal MCP server configured". Nothing is run or contacted to decide it: the files are read.
 *
 * FAKE: the `mcporter` on PATH is a script that writes a marker file if it is ever run (it must not be). The configs are
 * files in temporary folders, in MCPorter 0.12.4's shape (mcpServers by name; JSON with comments allowed).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { glyphSet } from '../src/term/glyphs.js';
import { listLanes } from '../src/utils/dispatch.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; };
const put = (file: string, body: string): void => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); };

/** A PATH holding only a FAKE mcporter that leaves a marker if run; the folders a lane check may read. */
function box() {
  const base = temp('h107-lanes-');
  const bin = join(base, 'bin');
  const marker = join(base, 'mcporter-ran');
  put(join(bin, 'mcporter'), `#!/bin/sh\necho ran > "${marker}"\n`);
  chmodSync(join(bin, 'mcporter'), 0o755);
  const home = join(base, 'home');
  const mcpHome = join(base, 'mcp-home');
  const project = join(base, 'project');
  for (const d of [home, mcpHome, project]) mkdirSync(d, { recursive: true });
  return { base, bin, marker, home, mcpHome, project };
}
const UNREAL = (comment = false): string => `${comment ? '// the operator\'s servers\n' : ''}{ "mcpServers": { "unreal-mcp": { "command": "node", "args": ["server.js"], }, }, }\n`;
const OTHER = '{ "mcpServers": { "echo": { "command": "node" } } }\n';

function withPath<T>(bin: string, run: () => T): T {
  const was = process.env.PATH;
  process.env.PATH = bin;
  try { return run(); } finally { process.env.PATH = was; }
}
const unreal = (env: NodeJS.ProcessEnv, cwd: string) => listLanes(env, { cwd }).find((l) => l.id === 'unreal-mcp')!;
const printed = (lanes: ReturnType<typeof listLanes>): string[] => {
  const out: string[] = [];
  const ctx = { print: (s: Array<{ text: string }>) => out.push(s.map((x) => x.text).join('')), glyphs: glyphSet(false), lanes: () => lanes } as unknown as ReplContext;
  runSlash('/lanes', ctx);
  return out;
};

describe('D13: an MCP-backed lane is found only when its server is configured for Timmy (files read, nothing run or contacted)', () => {
  it('mcporter on PATH and no server configured: not found, and /lanes says "mcporter found, no Unreal MCP server configured"', () => {
    const b = box();
    const env = { HOME: b.home };
    const lane = withPath(b.bin, () => unreal(env, b.project));
    expect(lane.available).toBe(false);
    expect(lane.mcp).toMatchObject({ server: 'unreal-mcp', program: 'mcporter', found: true, configured: false });
    const line = withPath(b.bin, () => printed(listLanes(env, { cwd: b.project }))).find((l) => l.includes('unreal-mcp'))!;
    expect(line).toMatch(/^ {4}unreal-mcp Unreal MCP - mcporter found, no Unreal MCP server configured: /);
    expect(line).not.toContain('found (not checked)');
    // an editor's own config is not Timmy's: a server there does not make the lane found
    put(join(b.home, '.cursor', 'mcp.json'), UNREAL());
    expect(withPath(b.bin, () => unreal(env, b.project)).available).toBe(false);
    expect(existsSync(b.marker)).toBe(false); // mcporter was never run
  });

  it('a server of the lane\'s name in TIMMY_MCP_HOME\'s MCPorter config (comments and trailing commas allowed): found', () => {
    const b = box();
    put(join(b.mcpHome, '.mcporter', 'mcporter.jsonc'), UNREAL(true));
    // the person's own home has another server only: TIMMY_MCP_HOME is the home Timmy's route gives MCPorter
    put(join(b.home, '.mcporter', 'mcporter.json'), OTHER);
    const env = { HOME: b.home, TIMMY_MCP_HOME: b.mcpHome };
    const lane = withPath(b.bin, () => unreal(env, b.project));
    expect(lane.available).toBe(true);
    expect(lane.mcp).toMatchObject({ configured: true, where: expect.stringContaining('mcporter.jsonc') });
    expect(withPath(b.bin, () => printed([lane])).join('\n')).toMatch(/^ {2}\* unreal-mcp Unreal MCP - found \(not checked\)/);
    // without TIMMY_MCP_HOME the route reads the person's own home, which has no such server
    expect(withPath(b.bin, () => unreal({ HOME: b.home }, b.project)).available).toBe(false);
    expect(existsSync(b.marker)).toBe(false);
  });

  it('the route\'s own config (./config/mcporter.json where it runs): found; only $MCPORTER_CONFIG when that is set', () => {
    const b = box();
    put(join(b.project, 'config', 'mcporter.json'), UNREAL());
    expect(withPath(b.bin, () => unreal({ HOME: b.home }, b.project)).available).toBe(true);
    // MCPORTER_CONFIG names the one file MCPorter reads: one without the server leaves the lane not found
    const only = join(b.base, 'only.json');
    put(only, OTHER);
    expect(withPath(b.bin, () => unreal({ HOME: b.home, MCPORTER_CONFIG: only }, b.project)).available).toBe(false);
    put(only, UNREAL());
    expect(withPath(b.bin, () => unreal({ HOME: b.home, MCPORTER_CONFIG: only }, b.project)).available).toBe(true);
    expect(existsSync(b.marker)).toBe(false);
  });

  it('a config that cannot be read as JSON is said, never taken for a server; no mcporter: not installed, as before', async () => {
    const { mcporterServerConfigured } = await import('../src/connectors/mcp-configured.js');
    const b = box();
    put(join(b.home, '.mcporter', 'mcporter.json'), '{ "mcpServers": { "unreal-mcp": ');
    const r = mcporterServerConfigured('unreal-mcp', { env: { HOME: b.home }, cwd: b.project });
    expect(r.configured).toBe(false);
    expect(r.unreadable).toEqual(['~/.mcporter/mcporter.json']);
    // a file is never named by its absolute path, even asked from a folder that holds the home (a REPL started in /)
    put(join(b.home, '.mcporter', 'mcporter.json'), UNREAL());
    const fromRoot = mcporterServerConfigured('unreal-mcp', { env: { HOME: b.home }, cwd: '/' });
    expect(fromRoot).toMatchObject({ configured: true, where: '~/.mcporter/mcporter.json', checked: ['~/.mcporter/mcporter.json'] });
    expect(JSON.stringify(fromRoot)).not.toContain(b.base);
    const empty = temp('h107-empty-bin-');
    const lane = withPath(empty, () => unreal({ HOME: b.home }, b.project));
    expect(lane).toMatchObject({ available: false, mcp: { found: false } });
    expect(withPath(empty, () => printed([lane]))[0]).toMatch(/^ {4}unreal-mcp Unreal MCP - not installed: npm i -g mcporter$/);
  });
});
