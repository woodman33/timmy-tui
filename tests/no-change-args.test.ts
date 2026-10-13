/**
 * Round R4 (H99, the review of the H99 work, finding 1): a last build made with arguments of the script's own is another
 * build. The review's case: `/blender scene.py --width 200` gets an ok verdict; then a workflow block's `/iterate blender
 * scene.py "…"` makes no change; the check said that last build "still matches its recorded inputs", `timmy act` exited 0,
 * upmd ran inspect and result on the --width 200 output, and the /run showed ✓. The flows run a script with no arguments
 * of its own, so a last run given any is stale (src/flows/iterate-native.ts nativeLastRun scriptArgs; Blender reads them
 * after `--` in the run's job.json, FreeCAD from its freecad.json, the same rule).
 *
 * FAKE pieces, each labelled:
 * - Blender is tests/fixtures/fake-blender.mjs (a TEST DOUBLE: no bpy, it renders nothing; in its `ok` mode it writes
 *   out/scene.blend and out/render.png and a result naming both), run by /blender's own judged job;
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent) as Qwen Code on a local
 *   endpoint: with no edit word in its task it changes nothing;
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour);
 * - one FreeCAD run folder written by hand in the shape src/native writes (job.json, verdicts.jsonl, freecad.json).
 * The `timmy` a block runs is the real CLI (tests/helpers/ops-sandbox.ts); every folder is under os.tmpdir().
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { folderProject } from '../src/project/index.js';
import { blenderLastRun } from '../src/flows/iterate-blender.js';
import { freecadLastRun } from '../src/flows/iterate-freecad.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { FAKE_UPMD, FIXTURES, json, opsKit, REPO, sandbox as opsSandbox, text, type OpsKit, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);
const F = '```';
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** A sandbox with the Blender starter's scene.py and the FAKE Blender on its PATH (also named by TIMMY_BLENDER). */
function blenderSandbox(k: OpsKit, prefix: string): Sandbox {
  const s = opsSandbox(k, prefix);
  fs.copyFileSync(path.join(REPO, 'templates', 'blender-starter', 'scene.py'), path.join(s.root, 'scene.py'));
  fs.copyFileSync(path.join(FIXTURES, 'fake-blender.mjs'), path.join(s.bin, 'blender'));
  fs.chmodSync(path.join(s.bin, 'blender'), 0o755);
  s.env.TIMMY_BLENDER = path.join(s.bin, 'blender');
  s.env.FAKE_BLENDER_MODE = 'ok';
  return s;
}

/** The REPL of a sandbox (as tests/helpers/ops-sandbox.ts replOf), with the FAKE Blender's variables passed on to its jobs. */
function repl(k: OpsKit, s: Sandbox, extra: Partial<WorkspaceDeps> = {}): { ws: Workspace; notes: string[] } {
  for (const key of ['PATH', 'HOME', 'TIMMY_HOME', 'TIMMY_STORE', 'TIMMY_AGENT_QWEN_BIN', 'TIMMY_AGENT_MODEL', 'TIMMY_OPENSCAD', 'NO_COLOR', 'TIMMY_BLENDER', 'FAKE_BLENDER_MODE'] as const) vi.stubEnv(key, s.env[key] ?? '');
  vi.stubEnv('TIMMY_OPERATION', '');
  const notes: string[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { ...process.env, UPMD_BIN: FAKE_UPMD }, onPath: () => null,
    notify: (l) => notes.push(l.map((x) => x.text).join('')), openWeb: (u) => u, link: (t) => t,
    seal: (input) => appendReceipt('runs', input, s.root).hash.slice(7, 15), receipts: () => readChain('runs', s.root),
    jobsDir: path.join(s.home, 'timmy', 'jobs'), chdir: () => {}, recoverAtStart: false, roomTools: async () => [], runProgress: false,
    ...extra,
  }, folderProject(s.root));
  k.spaces.push(ws);
  return { ws, notes };
}

/** `/blender <words>` through the REPL, to its judged end. */
async function blender(ws: Workspace, words: string): Promise<void> {
  const out = text(await ws.operate(`/blender ${words}`, 'repl', () => ws.blender(words)));
  const job = /\b(j[0-9a-f]{6})\b/.exec(out)?.[1];
  expect(job, out).toBeDefined();
  expect((await ws.jobs.done(job!)).state).toBe('completed');
  await ws.ops.done(ws.ops.latest!);
}

describe('a last build made with arguments of the script\'s own (FAKE Blender, real /blender jobs)', () => {
  it('is stale for a flow that runs the script with none, with the arguments in its words; a run with none is current', async () => {
    const s = blenderSandbox(kit, 'no-change-args-');
    const { ws } = repl(kit, s);
    await blender(ws, 'scene.py --width 200');
    const stale = blenderLastRun(s.root, 'scene.py');
    expect(stale).toMatchObject({ state: 'stale', build: { kind: 'native', app: 'blender' }, checks: [{ what: 'the arguments its script was given', recorded: '--width 200', now: '', same: false }] });
    expect(stale.words).toMatch(/^the last Blender run \([0-9a-f]{8}, [^)]+\) is stale: it was run with the arguments --width 200, and the flow runs scene\.py with none; \/blender scene\.py runs it again$/);
    // the same script run with no arguments of its own: its files are the bytes its verdict names, so it is current. (The
    // FAKE Blender writes the same bytes every time, and a run is judged on files it made: out/ is cleared first.)
    fs.rmSync(path.join(s.root, 'out'), { recursive: true, force: true });
    await blender(ws, 'scene.py');
    const current = blenderLastRun(s.root, 'scene.py');
    expect(current.state, current.words).toBe('current');
    expect(current.words).toContain('still matches its recorded inputs: scene.py hashes as recorded, and the 2 files its verdict says it wrote are the bytes it names');
  }, 120_000);

  it('FreeCAD by the same rule: its record\'s script_args (FAKE run folder written by hand); a record that does not say is not known', () => {
    const s = opsSandbox(kit, 'no-change-args-fc-');
    const script = '# a FAKE FreeCAD script\n';
    fs.writeFileSync(path.join(s.root, 'part.py'), script);
    const run = (args: unknown, at: string): string => {
      const id = randomUUID();
      const dir = path.join(s.root, '.timmy', 'native', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
        record: 'timmy-native-run', v: 1, app: 'freecad', run: id, program: 'freecadcmd', label: 'FreeCAD · part.py', project: 'p', args: [],
        input: { path: 'part.py', sha256: sha(script) }, expect: [], pre: {}, started_at: at, timeout_ms: 60_000,
      }));
      fs.writeFileSync(path.join(dir, 'verdicts.jsonl'), `${JSON.stringify({ judged_at: new Date().toISOString(), outcome: 'ok', why: 'FAKE', exit: { code: 0 }, files: [] })}\n`);
      if (args !== undefined) fs.writeFileSync(path.join(dir, 'freecad.json'), JSON.stringify({ script_args: args }));
      return id;
    };
    run(['--length', '40'], '2026-10-11T10:00:00.000Z');
    expect(freecadLastRun(s.root, 'part.py')).toMatchObject({ state: 'stale', words: expect.stringContaining('is stale: it was run with the arguments --length 40, and the flow runs part.py with none; /freecad part.py runs it again') });
    // a newer run whose record does not say which arguments it was given: not known (never current)
    run(undefined, '2026-10-11T11:00:00.000Z');
    expect(freecadLastRun(s.root, 'part.py')).toMatchObject({ state: 'unknown', words: expect.stringContaining('is not known: its record does not say which arguments its script was given') });
    // and one given none: its (no) files are as recorded, so it is current
    run([], '2026-10-11T12:00:00.000Z');
    expect(freecadLastRun(s.root, 'part.py').state).toBe('current');
  });
});

describe('the review\'s case through /run and `timmy act` (FAKE upmd, agent and Blender)', () => {
  it('a /blender run with --width 200, then a block\'s /iterate blender that changes nothing: stale, exit 4, nothing runs on that build, the /run reads no change', async () => {
    const s = blenderSandbox(kit, 'no-change-args-run-');
    const { ws, notes } = repl(kit, s);
    await blender(ws, 'scene.py --width 200');
    fs.writeFileSync(path.join(s.root, 'WORKFLOW.md'), [
      '# FAKE workflow: a Blender change, then what needs it', '',
      `${F}bash [name:change]`, 'timmy act \'/iterate blender scene.py "make the cube a little wider"\' --wait', F, '',
      `${F}bash [name:inspect, deps:change]`, 'echo "inspect would read out/scene.blend"', F, '',
      `${F}bash [name:result, deps:inspect]`, 'timmy act \'/op\' --wait', F, '',
    ].join('\n'));
    const out = text(await ws.operate('/run WORKFLOW.md result', 'repl', () => ws.run('WORKFLOW.md result')));
    const job = /Running\s+(j[0-9a-f]{6})/.exec(out)![1];
    const h = ws.ops.latest!;
    const done = await ws.jobs.done(job);
    await ws.ops.done(h);
    const log = ws.jobs.tail(job, 400).join('\n');
    // the block exited 4 (not current), so upmd ran nothing after it
    expect(done.steps.map((x) => [x.name, x.state, x.code, x.outcome ?? ''])).toEqual([['change', 'failed', 4, 'no change']]);
    expect(log).toMatch(/<== change exited with code 4/);
    expect(log).not.toMatch(/==> inspect/);
    const flow = fs.readdirSync(path.join(s.root, 'results', 'flows')).map((n) => json(path.join(s.root, 'results', 'flows', n))).find((r) => r.operation === h.id)!;
    expect(flow).toMatchObject({ target: 'blender', outcome: 'no change', last_build: { state: 'stale' } });
    expect(String(flow.why)).toContain('it was run with the arguments --width 200, and the flow runs scene.py with none');
    // the /run: no change, never ✓
    const said = notes.join('\n');
    expect(said).toMatch(new RegExp(`= ${job} `));
    expect(said).not.toMatch(new RegExp(`✓ ${job} completed`));
    expect(said).toContain('--width 200');
  }, 240_000);
});
