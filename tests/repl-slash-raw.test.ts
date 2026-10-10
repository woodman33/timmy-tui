/**
 * Round R4 (H40): /mcp gets its line as typed through the REPL's command registry (runSlash), so the runs of spaces in
 * a JSON string reach the server as they were written; every other command still gets its words joined by one space.
 * The server is tests/fixtures/mcp-echo-server.mjs (a TEST DOUBLE: every answer is made up), started as a child
 * process on Timmy's SDK route; nothing reaches the network.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { COMMANDS, runSlash, type ReplContext } from '../src/repl/commands.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const NODE = process.execPath;
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(root: string) {
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: {}, onPath: () => null, notify: () => {}, openWeb: (url) => `Open ${url}`, link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('slash-raw-jobs-'), 'jobs'), chdir: () => {}, recoverAtStart: false,
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, sealed };
}

describe('a command gets its arguments as typed only when it asks for them (raw)', () => {
  it('only /mcp and the four VoxVision commands (whose paths keep their spaces) are raw; /model still gets its words joined by one space', () => {
    expect(COMMANDS.filter((c) => c.raw).map((c) => c.name)).toEqual(['inspect', 'measure', 'detect', 'compare', 'mcp']);
    const models: string[] = [];
    const ctx = { print: () => {}, glyphs: glyphSet(true), agent: { getModel: () => 'm', setModel: (m: string) => models.push(m), startSession: () => '' } } as unknown as ReplContext;
    expect(runSlash('  /model   a  b  ', ctx)).toBe('handled');
    expect(models).toEqual(['a b']);
  });

  it('/mcp call through runSlash: the double space inside a JSON string reaches the server, its answer and its record', async () => {
    const root = temp('slash-raw-');
    const { ws, sealed } = make(root);
    const printed: string[] = [];
    const ctx = { print: (s: { text: string }[]) => printed.push(s.map((x) => x.text).join('')), glyphs: glyphSet(true), workspace: ws } as unknown as ReplContext;
    expect(await runSlash(`/mcp   call --route sdk echo {"text": "a  b", "pad": "x   y"} -- ${NODE} ${FIXTURE}  `, ctx)).toBe('handled');
    const out = printed.join('\n');
    expect(out).toMatch(/echo on \S+ mcp-echo-server\.mjs via sdk · answered/);
    expect(out).toContain('echo: a  b');
    const record = /record (\.timmy\/mcp\/m[0-9a-f]{8}\/call\.json)/.exec(out)?.[1];
    expect(record).toBeDefined();
    const call = JSON.parse(readFileSync(join(root, record!), 'utf8')) as { arguments: unknown; tool: string };
    expect(call).toMatchObject({ tool: 'echo', arguments: { text: 'a  b', pad: 'x   y' } });
    expect(readFileSync(join(root, record!.replace('call.json', 'output.json')), 'utf8')).toContain('echo: a  b');
    expect(sealed.map((r) => r.kind)).toEqual(['mcp.call']);
  }, 120_000);
});
