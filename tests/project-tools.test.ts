// R1 workspace direction (2026-10-08): the agent lists, reads and writes files in the active project,
// writing only after NEEDS YOU, and each write reaches the turn's receipt with its hashes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectTools, ProjectTurnFiles } from '../src/agent/project-tools.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { replTools } from '../src/repl/main.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
type Exec = (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
const toolsFor = (root: string, touched?: ProjectTurnFiles) => {
  const tools = createProjectTools({ root: () => root, touched });
  return (name: string, args: Record<string, unknown>) => ((tools.find((t) => t.function.name === name)!.function as unknown as { execute: Exec }).execute(args));
};

describe('project file tools', () => {
  it('list by role, read text, refuse private files, and write with hashes kept for the receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ptools-')); dirs.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/app.js'), 'console.log(1)\n');
    writeFileSync(join(root, '.env'), 'KEY=1\n');
    const touched = new ProjectTurnFiles();
    const call = toolsFor(root, touched);
    const listed = await call('list_project_files', {});
    expect(listed).toMatchObject({ ok: true, files: [{ path: 'src/app.js', role: 'source' }] });
    expect(await call('read_project_file', { path: 'src/app.js' })).toMatchObject({ ok: true, text: 'console.log(1)\n' });
    expect(await call('read_project_file', { path: '.env' })).toMatchObject({ ok: false });
    expect(await call('write_project_file', { path: '../escape.txt', content: 'x' })).toMatchObject({ ok: false });
    expect(await call('write_project_file', { path: 'src/new.js', content: 'one' })).toMatchObject({ ok: true, created: true });
    expect(await call('write_project_file', { path: 'src/new.js', content: 'two' })).toMatchObject({ ok: true, created: false });
    expect(await call('write_project_file', { path: 'src/app.js', content: 'console.log(2)\n' })).toMatchObject({ ok: true, created: false });
    expect(readFileSync(join(root, 'src/new.js'), 'utf8')).toBe('two');
    const files = touched.close();
    expect(files.find((f) => f.path === 'src/new.js')).toMatchObject({ created: true });
    expect(files.find((f) => f.path === 'src/new.js')?.previous_sha256).toBeUndefined();
    expect(files.find((f) => f.path === 'src/app.js')?.previous_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(touched.close()).toEqual([]);
  });

  it('are in the REPL agent\'s tools, and writing asks first while reading does not', () => {
    const names = replTools().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['list_project_files', 'read_project_file', 'write_project_file']));
    expect(approvalNeeded('write_project_file', { path: 'src/app.js' })).not.toBeNull();
    expect(approvalNeeded('read_project_file', { path: 'src/app.js' })).toBeNull();
    expect(approvalNeeded('list_project_files', {})).toBeNull();
  });
});
