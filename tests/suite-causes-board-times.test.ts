/**
 * Round R4 (helper H114): the cause of the full suite's failure of tests/board-workflows-live.test.ts › "Run up to here on
 * verify" at c56303c (the lead's suite, 2026-10-12, a loaded machine; and at 5aa422c before it): block build's own time read
 * "1.5 s" while its command sleeps 1.6 s. A measured time shorter than the work it measures.
 *
 * What ran, in order: upmd (here its test double, on the pty wrapper's terminal) writes setup's end and, at once, build's
 * start; the wrapper copies them to its stdout; Timmy's job manager parses the lines it read one by one
 * (src/jobs/index.ts record → parse). Parsing setup's end changes the job's steps, and that change runs, synchronously and
 * before the next line is parsed, the job record's write and the Workspace's listeners: setup's block receipt is sealed
 * there (src/repl/workflow-blocks.ts). Only then is build's start line parsed, and its moment was Timmy's clock at that
 * parse (src/workflows/upmd-live.ts upmdLineParser). Build's end line was stamped before its own seal. So whatever setup's
 * seal took (a slow disk under the receipts chain, a loaded machine) was taken off build's time.
 *
 * The fix (the product's): the wrapper stamps each block's start and end as it reads them from the pty and writes them to the
 * run's blocks file (workers/upmd/pty_run.py --blocks-file) before it copies those bytes on, so the file holds a line's
 * moment before Timmy can read the line; Timmy's parser takes a block's moments from that file, and its own clock only when
 * the file does not say.
 *
 * The delay is made on purpose: a FAKE slow receipts store holds the seal of setup's block receipt for 400 ms (as a slow disk
 * would). FAKE pieces, each labelled: upmd (tests/fixtures/fake-upmd.mjs, on a real pty through the real wrapper and this
 * machine's python3) and the slow seal. Everything else is real: the Workspace, the job manager, the block sealer and the
 * views' words.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LineSplitter, type JobStep } from '../src/jobs/index.js';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { PTY_BLOCKS_SCHEMA, readBlockMoments, runBlocksFile } from '../src/workflows/pty-stop.js';
import { stepMs } from '../src/workflows/run-blocks.js';
import { PTY_RUN_SCRIPT, upmdLineParser, wrapperStopFile } from '../src/workflows/upmd-live.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
const F = '```';
// the document of tests/board-workflows-live.test.ts: build sleeps 1.6 s
const DOC = [
  '# Tray build', '',
  `${F}bash [name:setup]`, 'mkdir -p dist', F, '',
  `${F}bash [name:build, deps:setup]`, 'sleep 1.6', 'echo built > dist/out.txt', F, '',
  `${F}sh [name:verify, deps:build]`, 'test -f dist/out.txt', F, '',
].join('\n');
const SLOW_MS = 400;

const dirs: string[] = [];
const spaces: Workspace[] = [];
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');

/** A Workspace whose seal of setup's block receipt is slow (FAKE: a slow receipts store), with python3 for the pty wrapper. */
function slowSealWorkspace(root: string): { ws: Workspace; sealed: ReceiptInput[] } {
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { UPMD_BIN: FAKE_UPMD }, onPath: (cmd) => (cmd === 'python3' ? PYTHON3 : null),
    notify: () => {}, openWeb: (url) => url, link: (t) => t, jobsDir: join(temp('h114-jobs-'), 'jobs'), chdir: () => {},
    seal: (input) => {
      // FAKE: a slow disk under the receipts chain, for this one seal (setup's block receipt, sealed as setup ends)
      if (input.kind === 'workflow-block' && (input as { block?: { name?: string } }).block?.name === 'setup') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOW_MS);
      sealed.push(input);
      return String(sealed.length - 1).padStart(8, '0');
    },
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, sealed };
}

describe('R4 (H114): a block\'s own time is not shortened by what Timmy does between reading two lines', () => {
  it.skipIf(!PYTHON3)('setup\'s block receipt sealed slowly (FAKE: 400 ms), as build starts: build\'s own time is still at least the 1.6 s it sleeps, in its record, its receipt and /workflows', async () => {
    const root = temp('h114-times-');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'BUILD.md'), DOC);
    const { ws, sealed } = slowSealWorkspace(root);
    await ws.run('BUILD.md verify');
    const job = ws.jobs.list().find((j) => j.label === 'BUILD.md › verify')!;
    const ended = await ws.jobs.done(job.id);
    expect(ended.state).toBe('completed');
    const setup = ended.steps.find((s) => s.name === 'setup')!;
    const build = ended.steps.find((s) => s.name === 'build')!;
    // build's start is the moment the wrapper read it, while setup's seal still held Timmy (before: 404 ms after setup's end,
    // the seal's 400 ms, as Timmy parsed build's start line only once the seal was done)
    expect(Date.parse(build.startedAt!) - Date.parse(setup.endedAt!), JSON.stringify(ended.steps)).toBeLessThan(SLOW_MS);
    // before: about 1.2 s (1.6 s less the 400 ms seal), its start stamped when Timmy parsed it after setup's seal
    expect(stepMs(build), JSON.stringify(ended.steps)).toBeGreaterThanOrEqual(1600);
    const receipt = sealed.find((r) => r.kind === 'workflow-block' && (r as { block?: { name?: string } }).block?.name === 'build') as unknown as { block: { ms: number } };
    expect(receipt.block.ms).toBeGreaterThanOrEqual(1600);
    // the words the full suite checked (tests/board-workflows-live.test.ts, line 268)
    expect(text(await ws.workflows('BUILD.md'))).toMatch(/2 build +bash +needs setup +✓ completed exit 0 · (1\.[6-9]|[2-9]\.\d) s/);
    // the wrapper was told where to write the moments: the run's blocks file, beside its stop file
    const args = ended.args;
    expect(args.slice(0, args.indexOf('--'))).toEqual(expect.arrayContaining(['--blocks-file', runBlocksFile(wrapperStopFile(args)!)]));
  }, 40_000);

  it.skipIf(!PYTHON3)('the wrapper writes a block\'s start and end to its blocks file before the line that shows them reaches its stdout: the parser never needs its own clock', async () => {
    const dir = temp('h114-wrap-');
    writeFileSync(join(dir, 'BUILD.md'), DOC);
    const file = join(dir, 'blocks.json');
    // the parser as the Workspace makes it, with a clock that counts each time the blocks file did not say
    let own = 0;
    const parse = upmdLineParser(parseWorkflow(DOC), 'pty', () => { own += 1; return new Date(); }, { blocksFile: file });
    const steps: JobStep[] = [];
    const lines = new LineSplitter();
    const child = spawn(PYTHON3!, ['-I', PTY_RUN_SCRIPT, '--blocks-file', file, '--', FAKE_UPMD, '--ci', '-b', 'verify', '-d', dir, join(dir, 'BUILD.md')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    // each line is parsed as it comes, as the job manager parses it (src/jobs/index.ts LineSplitter, then parseLine)
    child.stdout.setEncoding('utf8').on('data', (c: string) => { for (const l of lines.push(c)) parse(l, steps); });
    const code = await new Promise<number | null>((done) => child.on('close', done));
    for (const l of lines.end()) parse(l, steps);
    expect(code).toBe(0);
    expect(steps.map((s) => `${s.name} ${s.state}`)).toEqual(['setup completed', 'build completed', 'verify completed']);
    expect(own).toBe(0);
    // and the moments are the file's own
    const moments = readBlockMoments(file);
    expect(steps.map((s) => [s.startedAt, s.endedAt])).toEqual([1, 2, 3].map((n) => [moments.get(n)!.startedAt, moments.get(n)!.endedAt]));
    expect(stepMs(steps[1])).toBeGreaterThanOrEqual(1600);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; wrapper_pid: number; blocks: unknown[] };
    expect(raw).toMatchObject({ schema: PTY_BLOCKS_SCHEMA, wrapper_pid: child.pid, blocks: [{ n: 1, count: 3, name: 'setup', state: 'completed', code: 0 }, { n: 2, name: 'build' }, { n: 3, name: 'verify' }] });
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
  }, 40_000);

  it('a blocks file Timmy does not read gives no moments: none yet, not a regular file, too large, another schema, not JSON; a bad entry is left out', () => {
    const dir = temp('h114-read-');
    const file = (name: string, body: string): string => { writeFileSync(join(dir, name), body); return join(dir, name); };
    const ok = { schema: PTY_BLOCKS_SCHEMA, wrapper_pid: 4242, at: '2026-10-12T10:00:02.000Z', blocks: [
      { n: 1, state: 'completed', started_at: '2026-10-12T10:00:00.000Z', ended_at: '2026-10-12T10:00:01.000Z' },
      { n: 0, started_at: '2026-10-12T10:00:00.000Z' }, { n: 'two' }, null,
      { n: 2, state: 'running', started_at: 'yesterday' },
      { n: 3, state: 'running', started_at: '2026-10-12T10:00:01.500Z' },
      { n: 3, state: 'completed', started_at: '2026-10-12T10:00:01.600Z', ended_at: '2026-10-12T10:00:02.000Z' },
    ] };
    expect([...readBlockMoments(file('ok.json', JSON.stringify(ok)))]).toEqual([
      [1, { startedAt: '2026-10-12T10:00:00.000Z', endedAt: '2026-10-12T10:00:01.000Z' }],
      [2, {}],
      [3, { startedAt: '2026-10-12T10:00:01.600Z', endedAt: '2026-10-12T10:00:02.000Z' }],
    ]);
    expect(readBlockMoments(join(dir, 'none.json')).size).toBe(0);
    symlinkSync(join(dir, 'ok.json'), join(dir, 'link.json'));
    expect(readBlockMoments(join(dir, 'link.json')).size).toBe(0);
    expect(readBlockMoments(file('big.json', JSON.stringify({ ...ok, pad: 'x'.repeat(70 * 1024) }))).size).toBe(0);
    expect(readBlockMoments(file('other.json', JSON.stringify({ ...ok, schema: 'timmy.pty-stop/1' }))).size).toBe(0);
    expect(readBlockMoments(file('text.json', 'not json')).size).toBe(0);
    // a parser with no such file times the blocks by its own clock, as before
    let own = 0;
    const parse = upmdLineParser(parseWorkflow(DOC), 'pty', () => { own += 1; return new Date('2026-10-12T10:00:00.000Z'); }, { blocksFile: join(dir, 'none.json') });
    const steps: JobStep[] = [];
    parse(' [1/3] Bash', steps);
    expect(steps).toEqual([{ name: 'setup', index: 1, state: 'running', startedAt: '2026-10-12T10:00:00.000Z' }]);
    expect(own).toBe(1);
  });
});
