/**
 * R4 lead (2026-10-12), the dispatch audit the operator ordered finished at 14:48 PT. After 58ab7c9 made a lane task's
 * objective one shell word (src/utils/dispatch.ts laneCommand), these were the other places where text that is not shell
 * code reached a shell:
 *  - the zellij lane backend typed an approved command into its pane through Timmy's OWN shell (execSync with only "
 *    escaped), so $(...), `...` and $VAR in it ran in Timmy's process, outside the pane, and a \" ended the quoting;
 *  - a lane pane's start command quoted its launcher's path with plain '...', so a project folder named with an apostrophe
 *    ("Bob's project") broke every lane's start;
 *  - the monitor's Files, Model explorer and Code review panels opened a file, a receipt or a page, and copied a path or a
 *    hash, through shell strings, so a file named with $(...) in it ran that when opened.
 *
 * Real: bash, and the code under test. FAKE: zellij, open and pbcopy are stand-in scripts on PATH (this test's own) that
 * record the arguments and input they were given.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { laneStartupScript } from '../src/agent/lanes.js';
import { ZellijManager } from '../src/agent/zellij.js';

const dirs: string[] = [];
const saved = { PATH: process.env.PATH, REC: process.env.TIMMY_TEST_REC, cwd: process.cwd() };
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.REC === undefined) delete process.env.TIMMY_TEST_REC;
  else process.env.TIMMY_TEST_REC = saved.REC;
  process.chdir(saved.cwd);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A FAKE program (this test's): each argument NUL-terminated into $TIMMY_TEST_REC/<name>.argv, its input into <name>.stdin. */
function fake(bin: string, name: string, o: { readsInput?: boolean } = {}): void {
  const lines = [
    '#!/usr/bin/env bash',
    `# FAKE ${name} (tests/dispatch-shell-paths.test.ts): records its arguments${o.readsInput ? ' and its input' : ''}, does nothing else`,
    // (no arguments: an empty record; printf alone would still print its format once)
    `{ [ $# -eq 0 ] || printf '%s\\0' "$@"; } > "$TIMMY_TEST_REC/${name}.argv.part" && mv "$TIMMY_TEST_REC/${name}.argv.part" "$TIMMY_TEST_REC/${name}.argv"`,
    ...(o.readsInput ? [`cat > "$TIMMY_TEST_REC/${name}.stdin.part" && mv "$TIMMY_TEST_REC/${name}.stdin.part" "$TIMMY_TEST_REC/${name}.stdin"`] : []),
  ];
  writeFileSync(join(bin, name), `${lines.join('\n')}\n`);
  chmodSync(join(bin, name), 0o755);
}
async function recorded(rec: string, file: string, ms = 5000): Promise<string> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (existsSync(join(rec, file))) return readFileSync(join(rec, file), 'utf8');
  throw new Error(`the FAKE program wrote no ${file} in ${ms} ms`);
}
const argvOf = async (rec: string, name: string): Promise<string[]> => (await recorded(rec, `${name}.argv`)).split('\0').slice(0, -1);
/** Text that a shell would run if it ever read it as shell code: each piece makes its own file in the current folder. */
const HOSTILE = 'notes "a" $(touch made-by-dollar-paren) `touch made-by-backticks` $HOME \\" ; touch made-by-semicolon # it\'s';
const MARKS = ['made-by-dollar-paren', 'made-by-backticks', 'made-by-semicolon'];
const marksIn = (dir: string): string[] => MARKS.filter((f) => existsSync(join(dir, f)));

describe('text that is not shell code never reaches a shell as code (R4 lead, the dispatch audit)', () => {
  it('the zellij lane backend types an approved command into its pane exactly; nothing in it runs in Timmy', async () => {
    const bin = tmp('dsp-bin-');
    const rec = tmp('dsp-rec-');
    const cwd = tmp('dsp-cwd-');
    fake(bin, 'zellij');
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.TIMMY_TEST_REC = rec;
    process.chdir(cwd);
    const agent = { currentRunId: 'run-test', tmuxSessions: [{ id: '1', name: 'lane' }], lastBlockedCommands: new Map(), emit: () => true };
    const manager = new ZellijManager(agent as never);
    await manager.sendCommand('1', HOSTILE, true); // approved: the operator saw exactly this text
    const argv = await argvOf(rec, 'zellij');
    expect(argv.slice(0, 4)).toEqual(['-s', 'ortui-1', 'action', 'write-chars']);
    expect(argv).toHaveLength(5);
    // the pane gets the command as it was approved, wrapped to report its exit code, and one Enter
    expect(argv[4].startsWith(`( ${HOSTILE} ); printf "\\nTIMMY_EXIT_CODE:cmd_`)).toBe(true);
    expect(argv[4].endsWith(':%s\\n" "$?"\n')).toBe(true);
    expect(marksIn(cwd)).toEqual([]);
  });

  it("a lane pane's start command holds its launcher's path as one word, in a folder named with an apostrophe and $(...)", () => {
    const root = tmp('dsp-lane-');
    const project = join(root, "Bob's project $(touch made-by-dollar-paren)");
    mkdirSync(project);
    process.chdir(project);
    const start = laneStartupScript(undefined); // the plain shell lane: its launcher prints and runs no program
    const out = execFileSync('bash', ['--norc', '--noprofile', '-c', start], { cwd: project, encoding: 'utf8', env: { PATH: saved.PATH, HOME: project, TERM: 'dumb' } });
    expect(out).toContain('Systems MCP shell ready');
    expect(marksIn(project)).toEqual([]);
    expect(existsSync(join(project, '.timmy', 'run', 'lane-shell.sh'))).toBe(true);
  });

  it('the monitor opens a file or a page and copies a path as text: a file named with $(...) runs nothing', async () => {
    const bin = tmp('dsp-bin-');
    const rec = tmp('dsp-rec-');
    const cwd = tmp('dsp-cwd-');
    fake(bin, 'open');
    fake(bin, 'pbcopy', { readsInput: true });
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.TIMMY_TEST_REC = rec;
    process.chdir(cwd);
    const { copyToClipboard, openExternal } = await import('../src/utils/external-open.js');
    const file = join(cwd, `${HOSTILE}.md`);
    openExternal(file, { textEditor: true });
    expect(await argvOf(rec, 'open')).toEqual(['-t', file]);
    rmSync(join(rec, 'open.argv'));
    openExternal('http://127.0.0.1:4310/#t=placeholder');
    expect(await argvOf(rec, 'open')).toEqual(['http://127.0.0.1:4310/#t=placeholder']);
    copyToClipboard(file);
    expect(await recorded(rec, 'pbcopy.stdin')).toBe(file); // exactly the text: no shell, no added newline
    expect(await argvOf(rec, 'pbcopy')).toEqual([]);
    expect(marksIn(cwd)).toEqual([]);
  });

  it('a missing open or pbcopy (Linux, a stripped Mac) is a quiet no-op, as before', async () => {
    const bin = tmp('dsp-empty-bin-');
    process.env.PATH = bin; // neither program anywhere
    const { copyToClipboard, openExternal } = await import('../src/utils/external-open.js');
    expect(() => openExternal('/nowhere/file.md', { textEditor: true })).not.toThrow();
    expect(() => copyToClipboard('text')).not.toThrow();
    await sleep(300); // an unhandled error from either child would fail the run here
  });

  it('no shell string is built from text in the monitor panels or the zellij backend (a source check)', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const files = [...walk(join(saved.cwd, 'src', 'tui')).filter((f) => /\.tsx?$/.test(f)), join(saved.cwd, 'src', 'agent', 'zellij.ts')];
    const offenders = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, n: i + 1, line })))
      .filter(({ line }) => /\bexec(Sync)?\(\s*`[^`]*\$\{/.test(line))
      .map(({ f, n, line }) => `${f.slice(saved.cwd.length + 1)}:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
