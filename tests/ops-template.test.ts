/**
 * Round R4 (H51): the tray-workflow starter (templates/tray-workflow): registered like the other starters; its files; its
 * parameter file the tray recipe card's defaults, as Timmy writes a parameter file; its WORKFLOW.md parsed into its three
 * blocks with their needs (change, inspect after change, result after inspect); and its blocks' shell, run.
 *
 * FAKE pieces, each labelled: `timmy` on PATH in the run below is a TEST DOUBLE shell script that records how each block
 * called it (and, for the change block's call, writes a FAKE console-tray.step), so the blocks' own shell and the
 * operation id they pass on are what is checked, not the tray itself (that needs CadQuery: a Mac check). upmd is
 * tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; each block through sh -c).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyStarter, listStarters, STARTERS } from '../src/project/starters.js';
import { readCard } from '../src/recipes/index.js';
import { parseParams, paramsText } from '../src/recipes/params-file.js';
import { parseWorkflow, runOrder } from '../src/workflows/upmd.js';
import { OPERATION_ID } from '../src/ops/context.js';
import { opsKit, replOf, REPO, sandbox, text } from './helpers/ops-sandbox.js';
import { runAsync } from './helpers/run-async.js';

const TEMPLATE = path.join(REPO, 'templates', 'tray-workflow');
const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); kit.dirs.push(d); return d; };

describe('the tray-workflow starter', () => {
  it('is registered with the other starters, and holds its three files', () => {
    expect(STARTERS['tray-workflow']).toContain('/run WORKFLOW.md lesson');
    expect(listStarters().map((s) => s.name)).toContain('tray-workflow');
    const dest = path.join(temp('tray-workflow-'), 'mytray');
    const r = copyStarter('tray-workflow', dest);
    expect(r).toEqual({ files: ['README.md', 'recipes/tray.params.json', 'WORKFLOW.md'] });
  });

  it('its parameter file is the tray recipe card\'s defaults, written as Timmy writes a parameter file, and the recipe\'s rules take it', () => {
    const file = fs.readFileSync(path.join(TEMPLATE, 'recipes', 'tray.params.json'), 'utf8');
    expect(file).toBe(paramsText(readCard().parameters));
    expect(parseParams(file)).toEqual({ ok: true, parameters: readCard().parameters });
  });

  it('its WORKFLOW.md parses into change, inspect (needs change), result (needs inspect) and lesson (needs result)', () => {
    const doc = fs.readFileSync(path.join(TEMPLATE, 'WORKFLOW.md'), 'utf8');
    const blocks = parseWorkflow(doc);
    expect(blocks.map((b) => [b.name, b.lang, b.deps])).toEqual([['change', 'bash', []], ['inspect', 'bash', ['change']], ['result', 'bash', ['inspect']], ['lesson', 'bash', ['result']]]);
    expect(runOrder(blocks, 'result')).toEqual({ order: ['change', 'inspect', 'result'], missing: [] });
    expect(runOrder(blocks, 'lesson')).toEqual({ order: ['change', 'inspect', 'result', 'lesson'], missing: [] });
    expect(blocks[0].code).toBe('timmy act \'/iterate tray "make the tray 150 mm wide"\' --wait');
    expect(blocks[1].code).toContain('timmy act "/inspect $step" --wait');
    expect(blocks[2].code).toBe('timmy act \'/op\' --wait');
    // The prose explains the request, and the lesson: the user's sentence, a draft, checked only by /lesson check.
    expect(doc).toContain('The instruction in the `change` block is the request');
    expect(blocks[3].code).toContain('timmy act "/lesson add \\"');
    expect(blocks[3].code).toContain('--from $flow --from $vox --applies tray" --wait');
    expect(doc).toContain('Edit the sentence to say what you learned.');
    expect(doc).toContain('No model is trained.');
    // Nothing personal, no absolute path.
    for (const f of ['README.md', 'WORKFLOW.md', 'recipes/tray.params.json']) expect(fs.readFileSync(path.join(TEMPLATE, f), 'utf8'), f).not.toMatch(/\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]/i);
  });

  it('its inspect block picks the newest console-tray.step the rebuild exported, and fails in words when there is none', async () => {
    const code = parseWorkflow(fs.readFileSync(path.join(TEMPLATE, 'WORKFLOW.md'), 'utf8'))[1].code;
    const dir = temp('tray-inspect-');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // FAKE timmy: prints how it was called.
    fs.writeFileSync(path.join(bin, 'timmy'), '#!/bin/sh\necho "FAKE timmy: $*"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    const none = await runAsync('sh', ['-c', code], { cwd: dir, env });
    expect(none.status).toBe(1);
    expect(none.stdout).toContain('no console-tray.step in out/recipes/ yet: the change block delivered none');
    for (const [job, age] of [['1a2b3c4d', 60], ['5e6f7a8b', 0]] as const) {
      const f = path.join(dir, 'out', 'recipes', job, 'console-tray.step');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'FAKE STEP\n');
      const t = new Date(Date.now() - age * 1000);
      fs.utimesSync(f, t, t);
    }
    const newest = await runAsync('sh', ['-c', code], { cwd: dir, env });
    expect(newest.status).toBe(0);
    expect(newest.stdout.trim()).toBe('FAKE timmy: act /inspect out/recipes/5e6f7a8b/console-tray.step --wait');
  });

  it('its lesson block adds the sentence with the newest flow and VoxVision records as evidence, and fails in words without them', async () => {
    const code = parseWorkflow(fs.readFileSync(path.join(TEMPLATE, 'WORKFLOW.md'), 'utf8'))[3].code;
    const dir = temp('tray-lesson-');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // FAKE timmy: prints how it was called, one argument per line.
    fs.writeFileSync(path.join(bin, 'timmy'), '#!/bin/sh\nfor a in "$@"; do echo "ARG $a"; done\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    const none = await runAsync('sh', ['-c', code], { cwd: dir, env });
    expect(none.status).toBe(1);
    expect(none.stdout).toContain('no flow record or VoxVision record yet');
    for (const [rel, age] of [['results/flows/f00000001.json', 60], ['results/flows/f00000002.json', 0], ['results/vox/v00000001.json', 0]] as const) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '{}\n');
      const t = new Date(Date.now() - age * 1000);
      fs.utimesSync(f, t, t);
    }
    const ok = await runAsync('sh', ['-c', code], { cwd: dir, env });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim().split('\n')).toEqual([
      'ARG act',
      'ARG /lesson add "A tray size change by /iterate tray is confirmed by its STEP readback and by a VoxVision inspection of the exported STEP." --from results/flows/f00000002.json --from results/vox/v00000001.json --applies tray',
      'ARG --wait',
    ]);
  });

  it('/project new --from tray-workflow, then /run WORKFLOW.md result: the three blocks run in order, each calling timmy act with the run\'s operation id', async () => {
    const s = sandbox(kit, 'tray-workflow-run-');
    const { ws } = replOf(kit, s);
    const out = text(ws.project_('new mytray --from tray-workflow'));
    expect(out).toContain('Made mytray from tray-workflow: 3 files, yours to edit.');
    const root = path.join(s.home, 'timmy', 'projects', 'mytray');
    expect(fs.existsSync(path.join(root, 'WORKFLOW.md'))).toBe(true);
    // FAKE timmy on PATH: records each call with the TIMMY_OPERATION it was given; the change block's call writes a FAKE STEP.
    const calls = path.join(s.base, 'calls.txt');
    fs.writeFileSync(path.join(s.bin, 'timmy'), [
      '#!/bin/sh',
      '# FAKE timmy (a TEST DOUBLE): no Timmy runs here',
      `echo "$TIMMY_OPERATION|$*" >> "${calls}"`,
      'case "$2" in /iterate*) mkdir -p out/recipes/1a2b3c4d && echo "FAKE STEP" > out/recipes/1a2b3c4d/console-tray.step ;; esac',
      'exit 0', '',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('PATH', s.env.PATH ?? '');
    const started = text(await ws.operate('/run WORKFLOW.md result', 'repl', () => ws.run('WORKFLOW.md result')));
    const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
    expect(job, started).toBeDefined();
    const done = await ws.jobs.done(job!);
    expect(done.state, ws.jobs.tail(job!, 200).join('\n')).toBe('completed');
    const op = ws.ops.latest!.id;
    expect(op).toMatch(OPERATION_ID);
    expect(done.operation).toBe(op);
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      `${op}|act /iterate tray "make the tray 150 mm wide" --wait`,
      `${op}|act /inspect out/recipes/1a2b3c4d/console-tray.step --wait`,
      `${op}|act /op --wait`,
    ]);
    expect(done.steps.map((x) => [x.name, x.state])).toEqual([['change', 'completed'], ['inspect', 'completed'], ['result', 'completed']]);
  }, 60_000);
});
