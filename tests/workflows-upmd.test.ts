// The upmd adapter (src/workflows/upmd.ts): Timmy runs the operator's installed upmd rather than
// rebuilding it. upmd is not installed here: tests/fixtures/fake-upmd.mjs, a labelled test double,
// reproduces upmd 0.2.7's observed --ci behaviour, so the end-to-end cases below exercise the adapter
// against that double, never against upmd itself.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnProcess } from '../src/runtime/spawn-runtime.js';
import {
  findUpmd, findWorkflowDocs, isWorkflowDoc, parseUpmdLine, parseWorkflow, runOrder, stepsFromEvent, upmdRunArgs, upmdVersion,
  type UpmdEvent,
} from '../src/workflows/upmd.js';

const FAKE_UPMD = fileURLToPath(new URL('./fixtures/fake-upmd.mjs', import.meta.url));
const F = '```';
const T = '~~~';

type Step = Parameters<typeof stepsFromEvent>[0][number];

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-upmd-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A task block: `task('name:build, deps:setup')`. */
const task = (attrs: string, code = 'true') => [`${F}sh [${attrs}]`, code, F].join('\n');
const doc = (...parts: string[]) => parts.join('\n\n') + '\n';

const RUNBOOK = [
  '# Release runbook', //                             1
  '', //                                              2
  `${F}bash [name:setup]`, //                         3  block 1
  'mkdir -p artifacts', //                            4
  F, //                                               5
  '', //                                              6
  'Prose between the tasks.', //                      7
  '', //                                              8
  `${F}text`, //                                      9  block 2, unnamed
  'an example, not a task: upmd still counts it', // 10
  F, //                                              11
  '', //                                             12
  `${F}bash [name:build, deps:setup]`, //            13  block 3
  'echo built > artifacts/build.txt', //             14
  F, //                                              15
  '', //                                             16
  `${T}sh [name:lint, deps:setup]`, //               17  block 4, a tilde fence
  'echo lint', //                                    18
  T, //                                              19
  '', //                                             20
  `${F}bash [name:test,deps: setup]`, //             21  block 5
  'echo test', //                                    22
  F, //                                              23
  '', //                                             24
  `${F}bash [name:verify, deps:"lint | test"]`, //   25  block 6, a quoted expression
  'echo verified', //                                26
  F, //                                              27
].join('\n');

describe('parseWorkflow', () => {
  it('reads names, deps and quoted dependency expressions; unnamed blocks count in the numbering', () => {
    const blocks = parseWorkflow(RUNBOOK);
    expect(blocks.map((b) => [b.index, b.name ?? null, b.lang, b.line])).toEqual([
      [1, 'setup', 'bash', 3],
      [2, null, 'text', 9],
      [3, 'build', 'bash', 13],
      [4, 'lint', 'sh', 17],
      [5, 'test', 'bash', 21],
      [6, 'verify', 'bash', 25],
    ]);
    expect(blocks[0]).toStrictEqual({ index: 1, name: 'setup', lang: 'bash', deps: [], line: 3, code: 'mkdir -p artifacts' });
    expect(blocks[1]).toStrictEqual({ index: 2, lang: 'text', deps: [], line: 9, code: 'an example, not a task: upmd still counts it' });
    expect(blocks[2]).toMatchObject({ name: 'build', deps: ['setup'], depsExpr: 'setup', code: 'echo built > artifacts/build.txt' });
    expect(blocks[3]).toMatchObject({ name: 'lint', deps: ['setup'], code: 'echo lint' });
    expect(blocks[4]).toMatchObject({ name: 'test', deps: ['setup'], depsExpr: 'setup' });
    expect(blocks[5]).toMatchObject({ name: 'verify', deps: ['lint', 'test'], depsExpr: 'lint | test' });
  });

  it('closes fences by CommonMark rules: same character, at least as long; unclosed runs to the end', () => {
    const blocks = parseWorkflow([
      '````markdown', //                   1  block 1: a longer fence shows a fence as content
      `${F}bash [name:inner]`,
      'echo shown, not run',
      F,
      '````',
      '',
      `${T}bash [name:tilde]`, //          7  block 2: a backtick line does not close a tilde fence
      F,
      'still inside',
      T,
      '',
      '``` not`a`fence', //               12  a backtick in the info string: inline code, not a fence
      '',
      `${F}sh [name:open]`, //            14  block 3: never closed
      'echo never closed',
      '',
      'trailing prose',
    ].join('\r\n'));
    expect(blocks.map((b) => [b.index, b.name ?? null, b.lang, b.line])).toEqual([[1, null, 'markdown', 1], [2, 'tilde', 'bash', 7], [3, 'open', 'sh', 14]]);
    expect(blocks[0].code).toBe(`${F}bash [name:inner]\necho shown, not run\n${F}`);
    expect(blocks[1].code).toBe(`${F}\nstill inside`);
    expect(blocks[2].code).toBe('echo never closed\n\ntrailing prose');
  });

  it('counts fences inside list items, not fences in indented code or an HTML comment', () => {
    const blocks = parseWorkflow([
      '1. Install:', //                              1
      '',
      `   ${F}bash [name:install]`, //               3  block 1
      '   npm ci',
      `   ${F}`,
      '2. Then, nested:',
      '   - deeper:',
      '',
      `     ${F}bash [name:deep, deps:install]`, //  9  block 2
      '     echo deep',
      `     ${F}`,
      '',
      'The syntax, shown as indented code:',
      '',
      `    ${F}bash [name:example]`, //             15  indented code: not a block
      '    echo shown, not run',
      `    ${F}`,
      '',
      '<!-- disabled for now', //                   19  a commented-out block
      `${F}bash [name:hidden]`,
      'echo hidden',
      F,
      '-->',
      '',
      `- ${F}sh [name:inline]`, //                  25  block 3: a fence opening a list item
      '  echo inline',
      `  ${F}`,
    ].join('\n'));
    expect(blocks.map((b) => [b.index, b.name, b.line, b.code])).toEqual([
      [1, 'install', 3, 'npm ci'],
      [2, 'deep', 9, 'echo deep'],
      [3, 'inline', 25, 'echo inline'],
    ]);
    expect(blocks[1].deps).toEqual(['install']);
  });

  it('isWorkflowDoc needs at least one named block', () => {
    expect(isWorkflowDoc(RUNBOOK)).toBe(true);
    expect(isWorkflowDoc(`# Notes\n\n${F}bash\necho unnamed\n${F}\n`)).toBe(false);
    expect(isWorkflowDoc('# Notes\n\nNo code at all.\n')).toBe(false);
    expect(isWorkflowDoc(`<!--\n${task('name:hidden')}\n-->\n`)).toBe(false);
  });
});

describe('runOrder', () => {
  it('predicts the dependency closure in run order, dependencies first, each block once', () => {
    const blocks = parseWorkflow(RUNBOOK);
    expect(runOrder(blocks, 'verify')).toStrictEqual({ order: ['setup', 'lint', 'test', 'verify'], missing: [] });
    expect(runOrder(blocks, 'build')).toStrictEqual({ order: ['setup', 'build'], missing: [] });
    expect(runOrder(blocks, 'setup')).toStrictEqual({ order: ['setup'], missing: [] });
  });

  it('reports unknown dependencies and an unknown target as missing', () => {
    const blocks = parseWorkflow(doc(task('name:setup'), task('name:ship, deps:"setup | ghost | ghost"')));
    expect(runOrder(blocks, 'ship')).toStrictEqual({ order: ['setup', 'ship'], missing: ['ghost'] });
    expect(runOrder(blocks, 'nope')).toStrictEqual({ order: [], missing: ['nope'] });
  });

  it('reports a cycle as a path back to its start, without throwing', () => {
    const blocks = parseWorkflow(doc(task('name:a, deps:b'), task('name:b, deps:c'), task('name:c, deps:a'), task('name:d, deps:a')));
    let result: ReturnType<typeof runOrder> | undefined;
    expect(() => { result = runOrder(blocks, 'd'); }).not.toThrow();
    expect(result).toStrictEqual({ order: ['c', 'b', 'a', 'd'], missing: [], cycle: ['a', 'b', 'c', 'a'] });
    expect(runOrder(parseWorkflow(task('name:loop, deps:loop')), 'loop')).toStrictEqual({ order: ['loop'], missing: [], cycle: ['loop', 'loop'] });
  });
});

describe('upmd output', () => {
  it('parseUpmdLine reads the start, end and chain-stopped lines', () => {
    expect(parseUpmdLine('==> setup [block 1]')).toEqual({ type: 'start', name: 'setup', index: 1 });
    expect(parseUpmdLine('<== setup exited with code 0')).toEqual({ type: 'end', name: 'setup', code: 0 });
    expect(parseUpmdLine('<== bad exited with code 3\r')).toEqual({ type: 'end', name: 'bad', code: 3 });
    expect(parseUpmdLine('Block 3 failed - stopping dependency chain')).toEqual({ type: 'chain-stopped', index: 3 });
    expect(parseUpmdLine('\x1b[1m==> build [block 4]\x1b[0m')).toEqual({ type: 'start', name: 'build', index: 4 });
    // a block whose output lacks a final newline leaves upmd's end line after it
    expect(parseUpmdLine('no newline<== build exited with code 0')).toEqual({ type: 'end', name: 'build', code: 0 });
  });

  it('parseUpmdLine returns null for ordinary lines', () => {
    for (const line of ['', 'setting up', 'built', '  ==> indented [block 1]', '==> setup', 'Block 3 failed', '<== setup exited', 'ok: 2 blocks']) {
      expect(parseUpmdLine(line)).toBeNull();
    }
  });

  it('stepsFromEvent: start pushes a running step; end completes it on 0 and fails it otherwise', () => {
    const steps: Step[] = [];
    stepsFromEvent(steps, { type: 'start', name: 'setup', index: 1 });
    expect(steps).toEqual([{ name: 'setup', index: 1, state: 'running' }]);
    stepsFromEvent(steps, { type: 'end', name: 'setup', code: 0 });
    stepsFromEvent(steps, { type: 'start', name: 'bad', index: 4 });
    stepsFromEvent(steps, { type: 'end', name: 'bad', code: 3 });
    stepsFromEvent(steps, { type: 'chain-stopped', index: 4 });
    expect(steps).toEqual([{ name: 'setup', index: 1, state: 'completed', code: 0 }, { name: 'bad', index: 4, state: 'failed', code: 3 }]);
  });

  it('stepsFromEvent: stderr may be read before stdout, so a chain-stopped line can precede its end line', () => {
    const steps: Step[] = [];
    stepsFromEvent(steps, { type: 'start', name: 'bad', index: 4 });
    stepsFromEvent(steps, { type: 'chain-stopped', index: 4 });
    expect(steps).toEqual([{ name: 'bad', index: 4, state: 'failed' }]);
    stepsFromEvent(steps, { type: 'end', name: 'bad', code: 3 });
    expect(steps).toEqual([{ name: 'bad', index: 4, state: 'failed', code: 3 }]);
    // an end whose start was not seen is still recorded
    stepsFromEvent(steps, { type: 'end', name: 'late', code: 0 });
    expect(steps[1]).toEqual({ name: 'late', state: 'completed', code: 0 });
  });
});

describe('findWorkflowDocs', () => {
  it('lists workflow documents shallowest first, skipping build output, dependencies and .timmy/private', () => {
    const root = tempDir();
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    const named = (name: string) => doc('# Doc', task(`name:${name}`));
    put('README.md', doc(task('name:setup'), `${F}text\nexample\n${F}`));
    put('notes.md', '# Notes\n\nNo fences here.\n');
    put('docs/run.md', doc(task('name:a'), task('name:b, deps:a')));
    put('docs/plain.md', `${F}bash\necho unnamed\n${F}\n`);
    put('docs/guide.markdown', named('guide'));
    put('docs/run.txt', named('not-markdown'));
    put('docs/deep/x/y.md', named('deep'));
    put('.timmy/runbook.md', named('runbook'));
    put('.timmy/private/secret.md', named('secret'));
    for (const skipped of ['node_modules/pkg/README.md', 'sub/node_modules/z.md', '.git/info.md', 'dist/a.md', 'build/b.md', 'out/c.md']) put(skipped, named('skipped'));
    symlinkSync(join(root, 'docs'), join(root, 'linked'));

    const all = [
      { rel: 'README.md', blocks: 2, named: ['setup'] },
      { rel: '.timmy/runbook.md', blocks: 1, named: ['runbook'] },
      { rel: 'docs/guide.markdown', blocks: 1, named: ['guide'] },
      { rel: 'docs/run.md', blocks: 2, named: ['a', 'b'] },
      { rel: 'docs/deep/x/y.md', blocks: 1, named: ['deep'] },
    ];
    expect(findWorkflowDocs(root)).toEqual(all);
    expect(findWorkflowDocs(root, { max: 2 })).toEqual(all.slice(0, 2));
    expect(findWorkflowDocs(join(root, '.timmy'))).toEqual([{ rel: 'runbook.md', blocks: 1, named: ['runbook'] }]);
    expect(findWorkflowDocs(join(root, 'missing'))).toEqual([]);
  });
});

describe('finding and versioning upmd', () => {
  it('findUpmd: UPMD_BIN wins over PATH, else upmd on PATH, else null', () => {
    const asked: string[] = [];
    const onPath = (cmd: string) => { asked.push(cmd); return '/opt/tools/bin/upmd'; };
    expect(findUpmd({ UPMD_BIN: '/opt/pinned/upmd' }, onPath)).toEqual({ bin: '/opt/pinned/upmd' });
    expect(asked).toEqual([]);
    expect(findUpmd({}, onPath)).toEqual({ bin: '/opt/tools/bin/upmd' });
    expect(asked).toEqual(['upmd']);
    expect(findUpmd({ UPMD_BIN: '  ' }, () => null)).toBeNull();
  });

  it('upmdRunArgs builds the non-interactive run', () => {
    expect(upmdRunArgs('/w/RELEASE.md', 'build', '/w')).toEqual(['--ci', '-b', 'build', '-d', '/w', '/w/RELEASE.md']);
  });

  it('upmdVersion reads `upmd 0.2.7`, and null for a missing binary or another program', async () => {
    expect(await upmdVersion(FAKE_UPMD)).toBe('0.2.7');
    expect(await upmdVersion(join(tempDir(), 'no-such-upmd'))).toBeNull();
    expect(await upmdVersion(process.execPath)).toBeNull(); // node --version names no upmd
    expect(await upmdVersion('')).toBeNull();
  });
});

describe('a run through the upmd test double (end to end)', () => {
  const RELEASE = [
    '# Release',
    '',
    `${F}bash [name:setup]`,
    'mkdir -p artifacts',
    'echo "setting up"',
    F,
    '',
    'An example for the reader, not a task:',
    '',
    `${F}text`,
    'upmd still counts this block in its numbering',
    F,
    '',
    `${F}bash [name:build, deps:setup]`,
    'echo built > artifacts/build.txt',
    'echo "build done" >&2',
    F,
    '',
    `${F}sh [name:bad]`,
    'echo "about to fail"',
    'exit 3',
    F,
    '',
    `${F}bash [name:ship, deps:"build | bad"]`,
    'echo shipped > artifacts/ship.txt',
    F,
    '',
  ].join('\n');

  /** Split streamed text into lines. */
  function lineReader(onLine: (line: string) => void) {
    let partial = '';
    return {
      push(text: string) {
        const lines = (partial + text).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      },
      end() {
        if (partial) onLine(partial);
        partial = '';
      },
    };
  }

  /** Run upmd the way Timmy does: spawnProcess, every stdout and stderr line through parseUpmdLine into the steps. */
  async function runUpmd(block: string) {
    const docs = tempDir();
    const work = tempDir();
    const file = join(docs, 'RELEASE.md');
    writeFileSync(file, RELEASE);
    const found = findUpmd({ ...process.env, UPMD_BIN: FAKE_UPMD }, () => null);
    expect(found).toEqual({ bin: FAKE_UPMD });
    expect(await upmdVersion(found!.bin)).toBe('0.2.7');
    const events: UpmdEvent[] = [];
    const steps: Step[] = [];
    const feed = (line: string) => {
      const ev = parseUpmdLine(line);
      if (ev) { events.push(ev); stepsFromEvent(steps, ev); }
    };
    const out = lineReader(feed);
    const err = lineReader(feed);
    // cwd is the documents folder; -d must make the work folder the blocks' working directory
    const { child, outcome } = spawnProcess(found!.bin, upmdRunArgs(file, block, work), { cwd: docs, timeoutMs: 30_000, onStdout: out.push, onStderr: err.push });
    child.stdin.end();
    const result = await outcome;
    out.end();
    err.end();
    return { result, events, steps, docs, work, blocks: parseWorkflow(RELEASE) };
  }

  it('build (deps:setup) runs setup then build, exits 0 and creates its file in the -d folder', async () => {
    const { result, events, steps, docs, work, blocks } = await runUpmd('build');
    expect(runOrder(blocks, 'build').order).toEqual(['setup', 'build']); // the prediction shown before the run
    expect(result).toMatchObject({ status: 0, signal: null, error: null, timedOut: false, stderr: '' });
    // exactly upmd's framing; the block's stderr ("build done") is merged into stdout
    expect(result.stdout).toBe([
      '==> setup [block 1]',
      'setting up',
      '<== setup exited with code 0',
      '==> build [block 3]',
      'build done',
      '<== build exited with code 0',
      '',
    ].join('\n'));
    // the double numbers blocks independently; its numbers match the adapter's parse
    const index = (name: string) => blocks.find((b) => b.name === name)!.index;
    expect(events).toEqual([
      { type: 'start', name: 'setup', index: index('setup') },
      { type: 'end', name: 'setup', code: 0 },
      { type: 'start', name: 'build', index: index('build') },
      { type: 'end', name: 'build', code: 0 },
    ]);
    expect(steps).toEqual([
      { name: 'setup', index: 1, state: 'completed', code: 0 },
      { name: 'build', index: 3, state: 'completed', code: 0 },
    ]);
    expect(readFileSync(join(work, 'artifacts', 'build.txt'), 'utf8')).toBe('built\n');
    expect(existsSync(join(docs, 'artifacts'))).toBe(false);
  });

  it('a failing block shows code 3 on its end line, stops the chain on stderr and exits 1', async () => {
    const { result, events, steps, work, blocks } = await runUpmd('ship');
    expect(runOrder(blocks, 'ship').order).toEqual(['setup', 'build', 'bad', 'ship']);
    const bad = blocks.find((b) => b.name === 'bad')!;
    expect(bad.index).toBe(4);
    expect(result).toMatchObject({ status: 1, error: null, timedOut: false });
    expect(result.stdout.split('\n').slice(-4)).toEqual(['==> bad [block 4]', 'about to fail', '<== bad exited with code 3', '']);
    expect(result.stderr).toBe('Block 4 failed - stopping dependency chain\n');
    expect(events).toContainEqual({ type: 'end', name: 'bad', code: 3 });
    expect(events).toContainEqual({ type: 'chain-stopped', index: bad.index });
    expect(events.filter((e) => e.type === 'start').map((e) => e.name)).toEqual(['setup', 'build', 'bad']); // ship never starts
    expect(steps).toEqual([
      { name: 'setup', index: 1, state: 'completed', code: 0 },
      { name: 'build', index: 3, state: 'completed', code: 0 },
      { name: 'bad', index: 4, state: 'failed', code: 3 },
    ]);
    expect(existsSync(join(work, 'artifacts', 'build.txt'))).toBe(true);
    expect(existsSync(join(work, 'artifacts', 'ship.txt'))).toBe(false);
  });
});
