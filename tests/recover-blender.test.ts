/**
 * Round R4, the review's R4-1: a `/iterate blender` flow whose REPL ended without its stop path gets its interrupted
 * record and its `flow` receipt once, at the next REPL start and on /recover, in Blender's words (never the tray's), for
 * each step a Blender flow saves its state in while it runs: agent, checks, blender and readback.
 *
 * Each state is the one src/repl/iterate-blender.ts writes (not hand-made): a real Blender flow runs to that step, its
 * .timmy/flows/<id>/state.json is copied while the step runs, the flow is stopped, and then (SYNTHETIC, labelled where it
 * is done) its record is removed and its state put back as it was, ten minutes old: what a session that ended at that
 * moment leaves. The next session has its own jobs folder, so no job of the flow is known there.
 *
 * FAKE pieces, each labelled: the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing
 * sent); Blender is tests/fixtures/fake-blender.mjs (a TEST DOUBLE) with the stand-in bpy (tests/fixtures/blender-stub)
 * run by this machine's python3, or its sleep modes to hold the Blender run or the second pass; for the checks step, a
 * FAKE python3 that only sleeps holds the syntax check. No Blender runs here. These tests are skipped without python3.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { FLOW_QUIET_MS } from '../src/repl/recover.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const STUB = path.join(FIXTURES, 'blender-stub');
const FAKE_AGENT = path.join(FIXTURES, 'fake-code-agent.mjs');
const STARTER = path.join(REPO, 'templates', 'blender-starter', 'scene.py');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';

let root: string;
let fixtures: string;
let fakeBlender: string;
const spaces: Workspace[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
async function until(pred: () => boolean, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}
const flowIdIn = (out: string): string => { const m = out.match(/Flow\s+(f[0-9a-f]{8})/); if (!m) throw Error(`no flow in: ${out}`); return m[1]; };
const ended = (sealed: ReceiptInput[], id: string) => (): boolean => sealed.some((r) => r.kind === 'flow' && String(r.subject).includes(id));

function make(o: { env?: Record<string, string>; python3?: string; recoverAtStart?: boolean } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: {
      TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_BLENDER: fakeBlender,
      // FAKE: the fake Blender's scene run hands the script to python3 with the stand-in bpy
      FAKE_BLENDER_MODE: 'python', FAKE_BLENDER_PYTHON: python, PYTHONPATH: STUB, PYTHONDONTWRITEBYTECODE: '1',
      ...(o.env ?? {}),
    },
    onPath: (cmd) => (cmd === 'python3' ? o.python3 ?? python : null),
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    // Each session its own jobs folder: the next one knows no job of the one before.
    jobsDir: path.join(fs.mkdtempSync(path.join(fixtures, 'jobs-')), 'jobs'),
    chdir: () => {},
    receipts: () => sealed as unknown as Receipt[],
    ...(o.recoverAtStart === undefined ? {} : { recoverAtStart: o.recoverAtStart }),
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-blender-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-blender-fixtures-')));
  fs.copyFileSync(STARTER, path.join(root, 'scene.py'));
  fakeBlender = path.join(fixtures, 'bin', 'blender');
  fs.mkdirSync(path.dirname(fakeBlender), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'fake-blender.mjs'), fakeBlender);
  fs.chmodSync(fakeBlender, 0o755);
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60_000);

type Step = 'agent' | 'checks' | 'blender' | 'readback';
const CASES: Array<{ step: Step; via: 'start' | '/recover'; instruction: string; env?: Record<string, string>; slowPython?: true }> = [
  { step: 'agent', via: 'start', instruction: 'SLEEP PYREPLACE:Sphere=>Ball' },
  { step: 'checks', via: '/recover', instruction: 'rename the sphere PYREPLACE:Sphere=>Ball', slowPython: true },
  { step: 'blender', via: 'start', instruction: 'rename the sphere PYREPLACE:Sphere=>Ball', env: { FAKE_BLENDER_MODE: 'sleep' } },
  { step: 'readback', via: '/recover', instruction: 'rename the sphere PYREPLACE:Sphere=>Ball', env: { FAKE_BLENDER_READBACK: 'sleep' } },
];

/** Whether the state shows the step running, as iterate-blender.ts saves it once the step's work has started. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inStep = (s: any, step: Step): boolean => s?.step === step && s.outcome === 'running' && (
  step === 'agent' ? typeof s.agent?.job === 'string'
    : step === 'checks' ? typeof s.script?.after?.sha256 === 'string'
      : step === 'blender' ? s.blender?.state === 'running' && typeof s.blender?.job === 'string'
        : s.readback?.state === 'running' && typeof s.readback?.job === 'string');

describe.skipIf(!python)('a /iterate blender flow interrupted with its REPL: its record and flow receipt, once, in Blender\'s words', () => {
  for (const c of CASES) {
    it(`in its ${c.step} step: the next REPL ${c.via === 'start' ? 'start' : 'on /recover'} writes the record (outcome interrupted, ended in ${c.step}), what to do next, and the flow receipt`, async () => {
      // A FAKE python3 that answers nothing for 30 s holds the syntax check (the checks step).
      const slow = path.join(fixtures, 'slow-python3');
      fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
      const first = make({ ...(c.env ? { env: c.env } : {}), ...(c.slowPython ? { python3: slow } : {}) });
      const id = flowIdIn(text(await first.ws.iterate(`blender scene.py "${c.instruction}"`)));
      const stateFile = path.join(root, '.timmy', 'flows', id, 'state.json');
      const read = (): unknown => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return undefined; } };
      await until(() => inStep(read(), c.step));
      const left = fs.readFileSync(stateFile);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = JSON.parse(left.toString('utf8')) as any;
      // The state as iterate-blender.ts writes it: a Blender flow's record and its step, with a script and no parameters.
      expect(s).toMatchObject({ schema: 'timmy.flow/1', id, kind: 'iterate', target: 'blender', outcome: 'running', step: c.step, instruction: c.instruction, script: { path: 'scene.py' } });
      expect(s).not.toHaveProperty('parameters');
      await first.ws.stop(id);
      await until(ended(first.sealed, id));
      // SYNTHETIC: as if that session had ended without its stop path: its record gone, its state as it was, ten minutes old.
      const recordFile = path.join(root, 'results', 'flows', `${id}.json`);
      fs.rmSync(recordFile);
      fs.writeFileSync(stateFile, left);
      const old = new Date(Date.now() - FLOW_QUIET_MS - 60_000);
      fs.utimesSync(stateFile, old, old);

      // The next session.
      const next = make({ recoverAtStart: c.via === 'start' });
      let said: string;
      if (c.via === 'start') {
        const report = (await next.ws.startRecovery)!;
        expect(report.items.filter((i) => i.kind === 'flow').map((i) => [i.id, i.did, i.state])).toEqual([[id, 'interrupted', c.step]]);
        expect(next.notes[0]).toBe(`  Recovered  1 flow was interrupted: ${id} (record written)`);
        said = next.notes.join('\n');
      } else {
        expect(await next.ws.startRecovery).toBeUndefined();
        expect(fs.existsSync(recordFile)).toBe(false);
        said = text(await next.ws.recover(''));
        expect(said).toContain(`1 flow was interrupted: ${id} (record written)`);
      }

      // The words: the step, the job evidence, what was and was not run; Blender's, never the tray's.
      const jobOf: Record<Step, string | undefined> = { agent: s.agent?.job, checks: undefined, blender: s.blender?.job, readback: s.readback?.job };
      const jobWords = c.step === 'checks' ? 'no job of that step was recorded' : `its job ${jobOf[c.step]} has no record in this Timmy's jobs folder`;
      const tail = 'recorded after a restart, and nothing was run again';
      const why: Record<Step, string> = {
        agent: `the REPL running it ended while its agent ran (${jobWords}); Blender did not run; ${tail}`,
        checks: `the REPL running it ended after its agent ran, before its checks were recorded (${jobWords}); Blender did not run; ${tail}`,
        blender: `the REPL running it ended during its Blender run (${jobWords}); Blender run ${String(s.blender?.run).slice(0, 8)} is judged from its own record (a native run, below); nothing was read back; ${tail}`,
        readback: `the REPL running it ended during its readback (${jobWords}); there is no verdict; ${tail}`,
      };
      const restart = `/iterate blender scene.py "${c.instruction}" starts a new flow from scene.py as it is now`;
      const change = 'scene.py holds the agent\'s change: /blender scene.py runs it';
      const next_: Record<Step, string[]> = {
        agent: [`the agent's run ${s.agent.run} keeps its progress in .timmy/agents/${s.agent.run}/progress.log; scene.py may hold its change (sha256 before it: ${String(s.script.before.sha256).slice(0, 12)})`, restart],
        checks: [change, restart],
        blender: [`Blender run ${String(s.blender?.run).slice(0, 8)} keeps its own record in .timmy/native/${s.blender?.run}/; /recover judges it once its job has ended`, change, restart],
        readback: [`/jobs ${jobOf.readback} shows the readback's output while this Timmy's jobs folder keeps it`, change, restart],
      };
      expect(said).toContain(`flow ${id} was interrupted in its ${c.step} step (${jobWords}): record results/flows/${id}.json; receipt id1; next: /iterate blender again`);

      // The record: once, the state as its session left it plus the outcome, the step, why and what next.
      const rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      expect(rec).toMatchObject({ schema: 'timmy.flow/1', id, kind: 'iterate', target: 'blender', outcome: 'interrupted', ended_in: c.step, instruction: c.instruction, script: s.script, agent: s.agent });
      expect(rec).not.toHaveProperty('step');
      expect(rec.why).toBe(why[c.step]);
      expect(rec.recovered.next).toEqual(next_[c.step]);
      expect(rec.recovered.step).toBe(c.step);
      expect(rec.recovered.state_file).toEqual({ path: `.timmy/flows/${id}/state.json`, sha256: sha(left) });
      const children = ['agent', 'blender', 'readback'].map((k) => s.receipts?.[k]).filter((x): x is string => typeof x === 'string');
      expect(rec.child_receipts).toEqual(children);

      // The flow receipt: Blender's subject, the record's bytes, the state it was made from, the child receipts.
      const flows = next.sealed.filter((r) => r.kind === 'flow');
      expect(flows).toHaveLength(1);
      expect(flows[0]).toMatchObject({
        subject: `flow · iterate · blender · ${id} · interrupted`, status: 'failed', prompt_hash: `sha256:${sha(c.instruction)}`,
        outputs: [{ path: `results/flows/${id}.json`, sha256: sha(fs.readFileSync(recordFile)), bytes: fs.statSync(recordFile).size }],
        sources: [{ path: `.timmy/flows/${id}/state.json`, sha256: sha(left), role: 'the flow state its session left' }],
        discrepancies: [`interrupted: ${why[c.step]}`],
      });
      if (children.length) expect(flows[0].child_receipts).toEqual(children); else expect(flows[0].child_receipts).toBeUndefined();
      expect(flows[0].cost_usd).toBe(typeof s.agent.cost_usd === 'number' ? s.agent.cost_usd : undefined);
      const words = [said, JSON.stringify(rec), JSON.stringify(flows)].join('\n');
      expect(words).not.toMatch(/\btray\b|\/recipe|recipes\/tray|parameter file/);
      for (const p of [root, fixtures, os.tmpdir()]) expect(words).not.toContain(p);

      // The state file stays as its session wrote it; /iterate lists the flow as interrupted, a Blender flow.
      expect(fs.readFileSync(stateFile)).toEqual(left);
      expect(text(await next.ws.iterate(''))).toMatch(new RegExp(`${id}\\s+interrupted blender scene\\.py`));
      // Once: a second pass writes and seals nothing more, and leaves the record as it is.
      const body = fs.readFileSync(recordFile);
      expect(text(await next.ws.recover(''))).not.toContain(`flow ${id} was interrupted`);
      expect(next.sealed.filter((r) => r.kind === 'flow')).toHaveLength(1);
      expect(fs.readFileSync(recordFile)).toEqual(body);
    }, 120_000);
  }
});
