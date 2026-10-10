/**
 * Round R4, the review's R4-5: one flow at a time in a project, also while one is being started. The starts of the four
 * flow kinds (tray, blender, scad, freecad) reserve the project before their first await and release it when the start
 * ends (src/repl/flow-lock.ts, held by src/repl/iterate.ts around every start), so a second start made while the first
 * is still starting is refused with the existing words, whatever the two kinds; starts in two projects do not hold each
 * other up.
 *
 * FAKE pieces, each labelled: the agent's start (IterateDeps.startAgent) is a FAKE that records each call and holds
 * until the test releases it, then answers that it did not start, so no agent, job or app runs; Blender, OpenSCAD and
 * freecadcmd are stand-in programs that are found and never run; TIMMY_CADQUERY_PYTHON names a FAKE file that is never
 * executed; the tray's readback is a test seam that is never reached. Real files, in os.tmpdir().
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../src/jobs/index.js';
import { IterateFlows, type AgentStart, type IterateDeps } from '../src/repl/iterate.js';
import { glyphSet } from '../src/term/glyphs.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const TEMPLATES = path.join(REPO, 'templates');

type Kind = 'tray' | 'blender' | 'scad' | 'freecad';
const KINDS: Kind[] = ['tray', 'blender', 'scad', 'freecad'];
/** Each kind's /iterate line, on the starter files each project holds. */
const LINE: Record<Kind, string> = {
  tray: 'tray "make it wider"',
  blender: 'blender scene.py "make the sphere red"',
  scad: 'scad box.scad "make it wider"',
  freecad: 'freecad plate.py "make it longer"',
};
/** The existing refusal words of each kind, with the flow that holds the project and its step. */
const BUSY = (kind: Kind): RegExp => (kind === 'tray'
  ? /Flow (f[0-9a-f]{8}) is still running in this project \(its prepare step\), and one flow at a time changes recipes\/tray\.params\.json: wait for it, or \/stop \1\. Nothing was started\./
  : /Flow (f[0-9a-f]{8}) is still running in this project \(its prepare step\), and one flow at a time runs in a project \(an agent's before\/after comparison covers all of it\): wait for it, or \/stop \1\. Nothing was started\./);
const NOT_STARTED = 'The agent did not start: FAKE: this test does not start an agent';

let fixtures: string;
let env: NodeJS.ProcessEnv;
const roots: string[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A project with every kind's starter file: the tray needs none (its parameter file is written from the defaults). */
function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-lock-project-')));
  roots.push(root);
  fs.copyFileSync(path.join(TEMPLATES, 'blender-starter', 'scene.py'), path.join(root, 'scene.py'));
  for (const f of ['box.scad', 'box.params.json']) fs.copyFileSync(path.join(TEMPLATES, 'scad-starter', f), path.join(root, f));
  fs.copyFileSync(path.join(TEMPLATES, 'freecad-starter', 'plate.py'), path.join(root, 'plate.py'));
  return root;
}

/** IterateFlows with the FAKE agent start: each call recorded with its project, held until `release`. */
function flows(o: { throws?: true } = {}) {
  const calls: Array<{ root: string; task: string }> = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const deps: IterateDeps = {
    glyphs: glyphSet(true),
    env: () => env,
    onPath: () => null,
    notify: () => {},
    seal: () => undefined,
    jobs: new JobManager({ dir: fs.mkdtempSync(path.join(fixtures, 'jobs-')) }),
    startJob: () => { throw new Error('no job is started in this test'); },
    // FAKE: the agent's start, held until the test releases it; it never starts an agent.
    startAgent: async (_name, task, o2): Promise<AgentStart> => {
      calls.push({ root: o2.root, task });
      await held;
      if (o.throws) throw new Error('FAKE: the agent\'s start failed in this test');
      return { ok: false, refused: 'setup', error: 'FAKE: this test does not start an agent' };
    },
    startRecipe: async () => { throw new Error('no recipe is started in this test'); },
    scrub: (t) => t,
    startNative: () => { throw new Error('no native job is started in this test'); },
    freecadReadback: { ready: () => ({ ready: false, why: 'no readback in this test' }), run: () => ({ ok: false, error: 'no readback in this test' }) },
    // Test seam: the tray's readback worker, never reached here.
    test: { readback: () => ({ command: process.execPath, args: ['-e', ''] }) },
  };
  return { f: new IterateFlows(deps), calls, release: () => release() };
}

beforeEach(() => {
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-lock-fixtures-')));
  const program = (name: string, from?: string): string => {
    const p = path.join(fixtures, 'bin', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (from) fs.copyFileSync(from, p); else fs.writeFileSync(p, '#!/bin/sh\necho "FAKE: never run by this test"\nexit 1\n');
    fs.chmodSync(p, 0o755);
    return p;
  };
  const fakePython = path.join(fixtures, 'fake-python');
  fs.writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by this test"\nexit 1\n', { mode: 0o755 });
  env = {
    TIMMY_AGENT_QWEN_BIN: path.join(FIXTURES, 'fake-code-agent.mjs'), TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: fakePython,
    TIMMY_BLENDER: program('blender', path.join(FIXTURES, 'fake-blender.mjs')), TIMMY_OPENSCAD: program('openscad', path.join(FIXTURES, 'fake-openscad.mjs')),
    TIMMY_FREECADCMD: program('freecadcmd'),
  };
});
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
});

describe('two starts at once (Promise.all), one project: the second is refused with its kind\'s words, whatever the kinds', () => {
  for (const first of KINDS) {
    for (const second of KINDS) {
      it(`${first}, then ${second}: one agent start; the second says the first holds the project (its prepare step); the project is free again after`, async () => {
        const root = project();
        const { f, calls, release } = flows();
        const at = { root, project: 'demo' };
        const both = Promise.all([f.command(LINE[first], at), f.command(LINE[second], at)]);
        await tick();
        // Only the first reached its agent's start; the second was refused before it.
        expect(calls.map((c) => c.root)).toEqual([root]);
        // What the board asks (R4-3): the flow being started here, by its id, in its prepare step.
        const held = f.runningIn(root);
        expect(held).toEqual({ id: expect.stringMatching(/^f[0-9a-f]{8}$/), step: 'prepare' });
        release();
        const [a, b] = (await both).map(text);
        expect(a).toContain(NOT_STARTED);
        expect(b).toMatch(BUSY(second));
        expect(b).toContain(`Flow ${held!.id} is still running in this project (its prepare step)`);
        expect(b).not.toContain(NOT_STARTED);
        expect(f.runningIn(root)).toBeUndefined();
        // Released when the first start ended: a third start reaches its agent's start.
        expect(text(await f.command(LINE[second], at))).toContain(NOT_STARTED);
        expect(calls).toHaveLength(2);
      });
    }
  }
});

describe('two starts at once, two projects: neither holds the other up', () => {
  for (const [first, second] of [['tray', 'tray'], ['blender', 'scad'], ['freecad', 'tray']] as Array<[Kind, Kind]>) {
    it(`${first} in one project and ${second} in another: both reach their agent's start`, async () => {
      const one = project();
      const two = project();
      const { f, calls, release } = flows();
      const both = Promise.all([f.command(LINE[first], { root: one, project: 'one' }), f.command(LINE[second], { root: two, project: 'two' })]);
      await tick();
      expect(calls.map((c) => c.root)).toEqual([one, two]);
      release();
      for (const out of (await both).map(text)) expect(out).toContain(NOT_STARTED);
    });
  }
});

describe('a start that fails still gives the project back', () => {
  it('the agent\'s start throws: the start fails, and the next start in that project is not refused', async () => {
    const root = project();
    const failing = flows({ throws: true });
    const at = { root, project: 'demo' };
    const started = failing.f.command(LINE.tray, at);
    await tick();
    failing.release();
    await expect(started).rejects.toThrow('FAKE: the agent\'s start failed in this test');
    const raced = failing.f.command(LINE.blender, at);
    await tick();
    expect(failing.calls).toHaveLength(2);
    await expect(raced).rejects.toThrow('FAKE');
  });
});
