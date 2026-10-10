/**
 * Timmy Memory (round R4, helper H50): retrieval before a task. A checked lesson that applies reaches the agent's task in
 * each /iterate kind (tray, blender, scad, freecad, ae) and in /agent; its id, its file's sha256 and its status are kept in
 * the flow record (or the /agent run's record) and named by its receipt; a lesson whose evidence changed since its check
 * is not given, is recorded stale (its file and a lesson receipt) and is named; a draft is named, not given.
 *
 * Driven through the Workspace on real files and a REAL receipts chain kept in the project (tests/helpers/memory-kit.ts).
 * FAKE pieces, each labelled:
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent), run through /agent's own
 *   start as Qwen Code on a local endpoint. It acts on words in its task: a lesson's text holds WRITE:<file>, so the file
 *   it writes proves that lesson's text was in the task it was given (and a file a lesson not given names is never written);
 * - the native apps (Blender, OpenSCAD, freecadcmd, After Effects, aerender) and TIMMY_CADQUERY_PYTHON are FAKE files that
 *   only wait; none runs: each flow stops at its checks step, because the agent wrote a file other than the one it may
 *   change, so the flow's record and its receipt are written there.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LESSONS_ARE, type Lesson } from '../src/memory/lessons.js';
import { LESSONS_HEAD, LESSONS_MAX, lessonsLine, retrieveLessons } from '../src/memory/retrieve.js';
import { chainOf, memoryKit, put, read, realSeal, sha, text, until, workspace, type MemoryKit } from './helpers/memory-kit.js';
import { projectId } from '../src/project/index.js';

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);

const REPO = resolve(__dirname, '..');
const FAKE_AGENT = join(REPO, 'tests', 'fixtures', 'fake-code-agent.mjs');
const lessonIdIn = (out: string): string => { const m = /Lesson\s+(l[0-9a-f]{8})/.exec(out); if (!m) throw new Error(`no lesson in: ${out}`); return m[1]; };
const flowIdIn = (out: string): string => { const m = /Flow\s+(f[0-9a-f]{8})/.exec(out); if (!m) throw new Error(`no flow in: ${out}`); return m[1]; };

/** A FAKE program (a test double) that only waits until it is stopped: it stands where a native app is looked for. */
function sleeper(dir: string, name: string): string {
  const at = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(at, `#!/bin/sh\n# a FAKE ${name} (a test double) that only waits; the flows here never reach it\nexec sleep 30\n`, { mode: 0o755 });
  return at;
}

/** A project for one kind of flow, with its file and the environment its start checks. */
function setup(k: MemoryKit, kind: 'tray' | 'blender' | 'scad' | 'freecad' | 'ae') {
  const root = k.temp(`memory-retrieve-${kind}-`);
  const bin = join(k.temp('memory-retrieve-bin-'), 'bin');
  const env: Record<string, string> = { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b' };
  let line = '';
  if (kind === 'tray') { env.TIMMY_CADQUERY_PYTHON = sleeper(bin, 'python-fake'); line = 'tray "make it sturdier"'; }
  if (kind === 'blender') { copyFileSync(join(REPO, 'templates/blender-starter/scene.py'), join(root, 'scene.py')); env.TIMMY_BLENDER = sleeper(bin, 'blender'); line = 'blender scene.py "make the sphere red"'; }
  if (kind === 'scad') { for (const f of ['box.scad', 'box.params.json']) copyFileSync(join(REPO, 'templates/scad-starter', f), join(root, f)); env.TIMMY_OPENSCAD = sleeper(bin, 'openscad'); line = 'scad box.scad "make it wider"'; }
  if (kind === 'freecad') { copyFileSync(join(REPO, 'templates/freecad-starter/plate.py'), join(root, 'plate.py')); env.TIMMY_FREECADCMD = sleeper(bin, 'freecadcmd'); line = 'freecad plate.py "make it longer"'; }
  if (kind === 'ae') { copyFileSync(join(REPO, 'templates/ae-starter/author.jsx'), join(root, 'author.jsx')); env.TIMMY_AFTERFX = sleeper(bin, 'afterfx'); env.TIMMY_AERENDER = sleeper(bin, 'aerender'); line = 'ae author.jsx "move the title"'; }
  put(root, 'evidence/one.txt', 'the run where the fillets held\n');
  put(root, 'evidence/two.txt', 'the run that will change\n');
  // A FAKE readback for the tray (never reached: the flow stops at its checks).
  const { ws, notes } = workspace(root, k, { env, extra: { iterateTest: { readback: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }), settleMs: 2000 } } });
  return { root, ws, notes, line };
}

describe('a checked lesson reaches the agent\'s task in each /iterate kind, and its record and receipt name it', () => {
  for (const kind of ['tray', 'blender', 'scad', 'freecad', 'ae'] as const) {
    it(`/iterate ${kind}: given (checked), kept in the flow record and its receipt; a stale one and a draft named, not given`, async () => {
      const { root, ws, line } = setup(kit, kind);
      const given = lessonIdIn(text(ws.lesson(`add "For ${kind}: WRITE:notes/given-${kind}.txt keep the fillets at 2 mm." --from evidence/one.txt --applies ${kind}`)));
      const stale = lessonIdIn(text(ws.lesson(`add "Stale soon: WRITE:notes/stale-${kind}.txt" --from evidence/two.txt --applies ${kind}`)));
      const draft = lessonIdIn(text(ws.lesson(`add "A draft: WRITE:notes/draft-${kind}.txt" --from evidence/one.txt --applies ${kind}`)));
      const other = lessonIdIn(text(ws.lesson(`add "Another kind's: WRITE:notes/other-${kind}.txt" --from evidence/one.txt --applies ${kind === 'tray' ? 'scad' : 'tray'}`)));
      for (const id of [given, stale, other]) expect(text(ws.lesson(`check ${id}`))).toContain(`${id} checked`);
      writeFileSync(join(root, 'evidence/two.txt'), 'the run that changed\n'); // after its check: stale now
      const givenSha = sha(readFileSync(join(root, `.timmy/memory/lessons/${given}.json`)));

      const out = text(await ws.iterate(line));
      const flow = flowIdIn(out);
      expect(out).toContain(`lessons: ${given} (checked); not given: `);
      expect(out).toContain(`${stale} (stale: item 1: evidence/two.txt changed: sha256 `);
      expect(out).toContain(`${draft} (a draft, not checked yet: /lesson check ${draft})`);
      expect(out).not.toContain(other);
      await until(() => chainOf(root).some((r) => r.kind === 'flow' && String(r.subject).includes(flow)), 90_000);

      // The record keeps the lesson given, its file's sha256 as given, and its status; the flow receipt names the same.
      const record = JSON.parse(read(root, `results/flows/${flow}.json`)) as { lessons?: unknown; outcome: string; agent: { run: string } };
      expect(record.lessons).toEqual([{ id: given, sha256: givenSha, status: 'checked' }]);
      expect(record.outcome).toBe('stopped');
      const receipt = chainOf(root).find((r) => r.kind === 'flow' && String(r.subject).includes(flow))!;
      expect(receipt.lessons).toEqual([{ id: given, sha256: givenSha, status: 'checked' }]);
      // The agent's task held the one delimited section with the lesson given, and not the others' texts.
      const run = JSON.parse(read(root, `.timmy/agents/${record.agent.run}/run.json`)) as { task: string };
      expect(run.task).toContain(`${LESSONS_HEAD}\n[${given}] For ${kind}: WRITE:notes/given-${kind}.txt keep the fillets at 2 mm.\n---- end of lessons ----`);
      expect(run.task.split(LESSONS_HEAD)).toHaveLength(2);
      expect(run.task).not.toContain('Stale soon');
      expect(run.task).not.toContain('A draft');
      // The FAKE agent acted on the lesson's text, so the text reached the task it ran with; nothing else it names was written.
      expect(existsSync(join(root, `notes/given-${kind}.txt`))).toBe(true);
      for (const f of [`stale-${kind}`, `draft-${kind}`, `other-${kind}`]) expect(existsSync(join(root, `notes/${f}.txt`))).toBe(false);
      // The stale lesson was recorded stale, with a lesson receipt that says the check before the task found it.
      expect((JSON.parse(read(root, `.timmy/memory/lessons/${stale}.json`)) as Lesson).status).toBe('stale');
      expect(chainOf(root).filter((r) => r.kind === 'lesson' && r.lesson?.id === stale).at(-1)).toMatchObject({ status: 'failed', lesson: { action: 'check', status: 'stale', by: 'retrieval' } });
      // Lessons change no file: the given lesson's own file is as it was.
      expect(sha(readFileSync(join(root, `.timmy/memory/lessons/${given}.json`)))).toBe(givenSha);
    }, 120_000);
  }

  it('/iterate with no lesson that applies says "lessons: none apply", and its record keeps an empty list', async () => {
    const { root, ws, line } = setup(kit, 'tray');
    const out = text(await ws.iterate(line));
    const flow = flowIdIn(out);
    expect(out).toContain('  lessons: none apply');
    await until(() => chainOf(root).some((r) => r.kind === 'flow' && String(r.subject).includes(flow)), 90_000);
    expect((JSON.parse(read(root, `results/flows/${flow}.json`)) as { lessons?: unknown }).lessons).toEqual([]);
    expect(chainOf(root).find((r) => r.kind === 'flow')!.lessons).toBeUndefined();
  }, 120_000);

  it('the agent\'s iterate tool starts the same flow with the same lessons, and says which', async () => {
    const { root, ws } = setup(kit, 'tray');
    const id = lessonIdIn(text(ws.lesson('add "WRITE:notes/tool.txt" --from evidence/one.txt --applies tray')));
    text(ws.lesson(`check ${id}`));
    const answer = await ws.iterateForTool('make it sturdier') as { flow: string; lessons?: unknown };
    expect(answer.lessons).toEqual([{ id, sha256: sha(readFileSync(join(root, `.timmy/memory/lessons/${id}.json`))), status: 'checked' }]);
    await until(() => chainOf(root).some((r) => r.kind === 'flow' && String(r.subject).includes(answer.flow)), 90_000);
    expect(existsSync(join(root, 'notes/tool.txt'))).toBe(true);
  }, 120_000);
});

describe('/agent gets the checked lessons that apply after its task, and its run record and receipt name them', () => {
  it('a lesson for the agent kind, a file named in the task, and a word', async () => {
    const root = kit.temp('memory-retrieve-agent-');
    put(root, 'evidence/one.txt', 'the run\n');
    put(root, 'README.md', '# readme\n');
    const { ws } = workspace(root, kit, { env: { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b' } });
    const byKind = lessonIdIn(text(ws.lesson('add "Agents: WRITE:notes/by-kind.txt" --from evidence/one.txt --applies agent')));
    const byFile = lessonIdIn(text(ws.lesson('add "The readme: WRITE:notes/by-file.txt" --from evidence/one.txt --applies README.md')));
    const byWord = lessonIdIn(text(ws.lesson('add "Tidying: WRITE:notes/by-word.txt" --from evidence/one.txt --applies tidy')));
    const none = lessonIdIn(text(ws.lesson('add "Unrelated: WRITE:notes/none.txt" --from evidence/one.txt --applies blender')));
    for (const id of [byKind, byFile, byWord, none]) text(ws.lesson(`check ${id}`));
    const out = text(await ws.agent('qwen tidy README.md please'));
    expect(out).toMatch(/lessons: l[0-9a-f]{8} \(checked\), l[0-9a-f]{8} \(checked\), l[0-9a-f]{8} \(checked\)/);
    for (const id of [byKind, byFile, byWord]) expect(out).toContain(`${id} (checked)`);
    expect(out).not.toContain(none);
    const run = /agents\/(a[0-9a-f]{8})\//.exec(out)![1];
    await until(() => chainOf(root).some((r) => r.kind === 'agent'), 60_000);
    const result = JSON.parse(read(root, `.timmy/agents/${run}/result.json`)) as { lessons: Array<{ id: string; status: string }>; task: string };
    expect(result.lessons.map((l) => l.id).sort()).toEqual([byKind, byFile, byWord].sort());
    expect(result.lessons.every((l) => l.status === 'checked')).toBe(true);
    expect(result.task.startsWith('tidy README.md please\n\n---- Lessons from this project')).toBe(true);
    expect(chainOf(root).find((r) => r.kind === 'agent')!.lessons).toEqual(result.lessons);
    for (const f of ['by-kind', 'by-file', 'by-word']) expect(existsSync(join(root, `notes/${f}.txt`))).toBe(true);
    expect(existsSync(join(root, 'notes/none.txt'))).toBe(false);
  }, 120_000);
});

describe('the limits: at most 3 lessons and 2,000 characters, the rest named', () => {
  const pick = (root: string, files: string[] = []) => retrieveLessons({ root, project: 'p', kind: 'scad', instruction: 'wider', files }, { root, project: 'p', projectId: projectId(root), seal: realSeal(root), chain: chainOf(root) });
  const prepared = (texts: string[], applies: string[] = texts.map(() => 'scad')) => {
    const root = kit.temp('memory-retrieve-limits-');
    put(root, 'evidence/one.txt', 'x\n');
    const { ws } = workspace(root, kit);
    const ids = texts.map((t, i) => lessonIdIn(text(ws.lesson(`add "${t}" --from evidence/one.txt --applies ${applies[i]}`))));
    for (const id of ids) expect(text(ws.lesson(`check ${id}`))).toContain(`${id} checked`);
    return { root, ids };
  };

  it('more than 3 apply: the 3 that apply most are given, the 4th is named', () => {
    const { root } = prepared(['the first', 'the second', 'the third', 'the fourth']);
    const r = pick(root);
    expect(r.used).toHaveLength(LESSONS_MAX);
    expect(r.notUsed).toEqual([{ id: expect.stringMatching(/^l[0-9a-f]{8}$/), why: `more than ${LESSONS_MAX} lessons apply; the ${LESSONS_MAX} that apply most are given` }]);
    expect(lessonsLine(r)).toMatch(/^lessons: l[0-9a-f]{8} \(checked\), l[0-9a-f]{8} \(checked\), l[0-9a-f]{8} \(checked\); not given: l[0-9a-f]{8} \(more than 3/);
  });

  it('one that would take the section past 2,000 characters is named, not given', () => {
    const { root } = prepared(['L'.repeat(1000), 'M'.repeat(1000)]);
    const r = pick(root);
    expect(r.used).toHaveLength(1);
    expect(r.section.length).toBeLessThanOrEqual(2000);
    expect(r.notUsed).toEqual([{ id: expect.stringMatching(/^l[0-9a-f]{8}$/), why: 'it would take the lessons past 2,000 characters' }]);
  });

  it('a file the task works on applies more than its kind: that lesson is given first', () => {
    const { root, ids } = prepared(['by kind', 'by file'], ['scad', 'box.scad']);
    const r = pick(root, ['box.scad']);
    expect(r.used.map((u) => u.id)).toEqual([ids[1], ids[0]]);
    expect(r.used[0].why).toBe('file box.scad');
    expect(r.used[1].why).toBe('kind scad');
    expect(LESSONS_ARE).toContain('no model is trained');
  });
});
