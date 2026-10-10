/**
 * Timmy Memory (round R4, helper H50): a flow interrupted after its start gave its agent lessons. Recovery (/recover,
 * src/repl/recover.ts) writes its record from the state its session left, which keeps `lessons` as the start kept them,
 * and seals it with a `flow` receipt that names them, as the flow's own end would have.
 *
 * Driven through the Workspace on a temporary project with a REAL receipts chain (tests/helpers/memory-kit.ts). The two
 * flow states are SYNTHETIC, written by hand as /iterate tray and /iterate scad save them while their agent runs
 * (src/repl/iterate.ts and iterate-scad.ts saveState); no agent, recipe or app runs, and the lesson ids name no file.
 */
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCTRINE_15 } from '../src/flows/iterate.js';
import { lessonsPart } from '../src/memory/retrieve.js';
import { RECIPE_ID } from '../src/recipes/index.js';
import { FLOW_QUIET_MS } from '../src/repl/recover.js';
import { chainOf, memoryKit, put, read, text, workspace } from './helpers/memory-kit.js';

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

const LESSONS = [{ id: 'l0123abcd', sha256: 'c'.repeat(64), status: 'checked' }];

/** SYNTHETIC: a flow's state while its agent runs, with the lessons its start gave (the agent's job has no record here). */
function state(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', instruction: 'make it wider', project: 'p',
    started_at: new Date().toISOString(), outcome: 'running',
    agent: { run: 'a0123abcd', agent: 'qwen', version: null, route: 'local endpoint, no charge', where: '127.0.0.1:11434', model: 'qwen3:4b', job: 'j0aaaa1' },
    receipts: {}, child_receipts: [], doctrine: DOCTRINE_15, lessons: LESSONS, step: 'agent', ...extra,
  };
}

describe('a flow interrupted after its start gave it lessons', () => {
  it('tray and scad: the record keeps the lessons its state kept, and the interrupted flow receipt names them', async () => {
    const root = kit.temp('memory-recover-');
    const { ws } = workspace(root, kit);
    const tray = state('f0000aaaa', { recipe: RECIPE_ID, parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: 'a'.repeat(64), values: { width: 140 } } } });
    const scad = state('f0000bbbb', { target: 'scad', model: { path: 'box.scad' }, parameters: { path: 'box.params.json', before: { sha256: 'a'.repeat(64) } } });
    // Ten minutes and more with no change: nothing about either flow moves.
    const old = new Date(Date.now() - FLOW_QUIET_MS - 60_000);
    for (const s of [tray, scad]) {
      const rel = `.timmy/flows/${String(s.id)}/state.json`;
      put(root, rel, `${JSON.stringify(s, null, 2)}\n`);
      utimesSync(join(root, rel), old, old);
    }
    expect(text(await ws.recover(''))).toContain('2 flows were interrupted');
    const flows = chainOf(root).filter((r) => r.kind === 'flow');
    for (const [id, kind] of [['f0000aaaa', 'tray'], ['f0000bbbb', 'scad']]) {
      expect(JSON.parse(read(root, `results/flows/${id}.json`))).toMatchObject({ id, outcome: 'interrupted', ended_in: 'agent', lessons: LESSONS });
      expect(flows.find((r) => r.subject === `flow · iterate · ${kind} · ${id} · interrupted`)).toMatchObject({ status: 'failed', lessons: LESSONS });
    }
  });

  it('the receipt names only entries with a lesson id, a sha256 and a status; none, nothing', () => {
    expect(lessonsPart([...LESSONS, { id: '../x', sha256: 'c', status: 'checked' }, { id: 'l00000001', sha256: 1, status: 'checked' }, null, 'l00000002'])).toEqual({ lessons: LESSONS });
    expect(lessonsPart([{ ...LESSONS[0], extra: 'left out' }])).toEqual({ lessons: LESSONS });
    expect(lessonsPart(undefined)).toEqual({});
    expect(lessonsPart([])).toEqual({});
    expect(lessonsPart({ id: 'l0123abcd' })).toEqual({});
  });
});
