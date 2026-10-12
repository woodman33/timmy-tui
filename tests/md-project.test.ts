/**
 * Round R4 (helper H107; r25, the scripted rehearsal on the operator's Mac at 5e5cbb3, finding D4's `timmy md` part): the
 * preview launcher starts every command in a work folder of its own, so `timmy md WORKFLOW.md result` could not name a
 * project's workflow (the project was always the current folder). `timmy md <doc> [<block>] --project <dir>` now runs a
 * project's workflow from any folder, as `timmy act --project` does; without --project the current folder is the project,
 * as before. Its --help says how the folder is chosen. The whole run from another folder (its receipts, its JSON) is in
 * tests/run-words-agree.test.ts; here: the arguments, the help, and --plan and the refusals as real child processes.
 *
 * FAKE: upmd is tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7's --ci behaviour (UPMD_BIN; it is not upmd).
 * `timmy` is the real CLI (src/cli.ts through tsx); every folder is under os.tmpdir().
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MD_USAGE, mdHelp, parseMdArgs } from '../src/cli-md.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';

const REPO = path.resolve(__dirname, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO, 'src', 'cli.ts');
const FAKE_UPMD = path.join(REPO, 'tests', 'fixtures', 'fake-upmd.mjs');
const F = '```';
const DOC = ['# Build', '', `${F}bash [name:setup]`, 'mkdir -p dist', F, '', `${F}bash [name:build, deps:setup]`, 'echo built > dist/out.txt', F, ''].join('\n');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function box() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h107-md-')));
  dirs.push(base);
  const root = path.join(base, 'project');
  const elsewhere = path.join(base, 'launcher-work');
  const home = path.join(base, 'home');
  for (const d of [root, elsewhere, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'BUILD.md'), DOC);
  const env: NodeJS.ProcessEnv = { ...withoutRunner(process.env), HOME: home, TIMMY_HOME: path.join(home, 'timmy'), TIMMY_STORE: path.join(root, '.timmy', 'receipts'), UPMD_BIN: FAKE_UPMD, NO_COLOR: '1' };
  delete env.TIMMY_OPERATION;
  return { base, root, elsewhere, env };
}
function md(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(TSX, [CLI, 'md', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}
const last = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;

describe('D4: timmy md --project <dir>', () => {
  it('reads --project <dir> and --project=<dir>; refuses it without a value', () => {
    expect(parseMdArgs(['BUILD.md', 'build', '--project', '/some/where'])).toEqual({ doc: 'BUILD.md', block: 'build', plan: false, json: false, project: '/some/where' });
    expect(parseMdArgs(['--project=/some/where', 'BUILD.md', '--plan'])).toEqual({ doc: 'BUILD.md', plan: true, json: false, project: '/some/where' });
    expect(parseMdArgs(['BUILD.md', '--project'])).toEqual({ error: `--project needs a value. Usage: ${MD_USAGE}` });
    expect(parseMdArgs(['BUILD.md', '--project='])).toEqual({ error: `--project needs a value. Usage: ${MD_USAGE}` });
    expect(MD_USAGE).toBe('timmy md <workflow.md> [<block>] [--project <dir>] [--plan] [--json]');
  });

  it('its help says how the project folder is chosen', () => {
    const help = mdHelp();
    expect(help).toContain('  --project <dir>  the project folder: the document is a file of it, its blocks run in it, its receipts are sealed on its store');
    expect(help).toContain('Without --project the project is the current folder (as the REPL would open it from here), as timmy act decides it.');
  });

  it('from another folder: --project runs that project\'s workflow (--plan, a real child process); without it the current folder is the project, as before', async () => {
    const b = box();
    const planned = await md(b.elsewhere, b.env, ['BUILD.md', 'build', '--project', b.root, '--plan', '--json']);
    expect(planned.code, planned.stdout + planned.stderr).toBe(0);
    expect(last(planned.stdout)).toMatchObject({ schema: 'timmy.md/1', plan: true, doc: 'BUILD.md', block: 'build', order: ['setup', 'build'], outcome: 'answered', exit_code: 0 });
    // a path relative to the folder it was run in is not how the document is named: it is a file of the project
    const relative = await md(b.elsewhere, b.env, ['BUILD.md', 'build', `--project=${path.relative(b.elsewhere, b.root)}`, '--plan', '--json']);
    expect(relative.code, relative.stdout + relative.stderr).toBe(0);
    // without --project: the current folder is the project, which has no such document
    const here = await md(b.elsewhere, b.env, ['BUILD.md', 'build', '--plan', '--json']);
    expect(here.code).toBe(2);
    expect(last(here.stdout)).toMatchObject({ operation: null, outcome: 'refused', exit_code: 2 });
    // a --project that is not a folder: refused, exit 2, before anything runs
    const missing = await md(b.elsewhere, b.env, ['BUILD.md', 'build', '--project', path.join(b.base, 'no-such-folder'), '--json']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain(`--project ${path.join(b.base, 'no-such-folder')} is not a folder. Usage: ${MD_USAGE}`);
    expect(last(missing.stdout)).toMatchObject({ operation: null, outcome: 'usage', exit_code: 2 });
    // nothing was sealed or recorded anywhere by --plan and the refusals
    expect(fs.existsSync(path.join(b.root, '.timmy', 'receipts', 'runs.jsonl'))).toBe(false);
  }, 120_000);
});
