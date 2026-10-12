/**
 * R4 (H109; r25 D9 c): what an operation used of a parameter file, read from that operation's own records
 * (src/studio/used-values.ts), against a real temporary project (tests/helpers/canvas-project.ts): the tray recipe's parameter
 * file written by the recipe's own writer (writeParams, which keeps each previous version under .timmy/params-history/), and
 * receipts sealed into a real runs.jsonl as appendReceipt seals them (unsigned). FIXTURES: the flow records are written here in
 * their documented schema (src/flows/iterate.ts FlowRecord); no /iterate, agent or recipe ran.
 */
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardText, projectCards, readRunsChain } from '../src/studio/project-cards.js';
import { usedReader, type UsedValues } from '../src/studio/used-values.js';
import { PARAMETER_NAMES, readCard } from '../src/recipes/index.js';
import { paramsText, writeParams } from '../src/recipes/params-file.js';
import { makeCanvasProject, sha, type CanvasProject } from './helpers/canvas-project.js';

const FILE = 'recipes/tray.params.json';
const TRAY = { file: FILE, engine: 'tray' as const, model: null };
const X = 'oa0a9ed5a';
const Y = 'ob1b2c3d4';
const W = 'oc1c2c3d4';
const V = 'od1d2d3d4';
const N = 'oe1e2e3e4';

/** A FIXTURE tray flow record of operation `op` (src/flows/iterate.ts FlowRecord), its file back. */
function flow(p: CanvasProject, id: string, op: string, o: { outcome: string; before: Record<string, number>; after?: Record<string, number>; rebuild?: boolean; invalid?: boolean; started?: string }): string {
  const rel = `results/flows/${id}.json`;
  const text = `${JSON.stringify({
    flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', recipe: 'enclosure.tray/1', instruction: 'make the tray 150 mm wide', project: 'demo', operation: op,
    started_at: o.started ?? '2026-10-11T10:00:00.000Z', ended_at: '2026-10-11T10:03:00.000Z', outcome: o.outcome,
    parameters: {
      path: FILE, created: false,
      before: { sha256: sha(paramsText(o.before)), values: o.before },
      ...(o.after ? { after: { sha256: sha(paramsText(o.after)), values: o.after } } : {}),
      ...(o.invalid ? { invalid: { error: 'width must be a number of millimetres' } } : {}),
    },
    ...(o.rebuild ? { rebuild: { job: 'abcd1234-0000-4000-8000-000000000000', state: 'succeeded', predicted: { bounds_mm: [150, 80, 30], volume_mm3: 1000 }, parameters_file: { path: FILE, sha256: sha(paramsText(o.after!)) } } } : {}),
    readback: { state: 'completed', verdict: 'matches', tolerance: { bounds_mm: 0.01, volume_relative: 0.001 }, scope: 'The readback measures the delivered CAD file.' },
    receipts: {}, child_receipts: [], doctrine: 'Timmy can compute and verify dimensions of generated CAD.',
  }, null, 2)}\n`;
  p.write(rel, text);
  p.seal({ kind: 'flow', subject: `flow · iterate · tray · ${id} · ${o.outcome}`, operation_id: op, outputs: [{ path: rel, sha256: sha(text), bytes: Buffer.byteLength(text) }] });
  return rel;
}

const width = (u: UsedValues | null): unknown => u?.values.find((v) => v.name === 'width')?.value;

describe('what an operation used of a parameter file, from its own records', () => {
  let p: CanvasProject;
  const card = readCard().parameters as Record<string, number>;
  let helperSha = '';

  beforeAll(async () => {
    p = await makeCanvasProject('studio-used-values-');
    // the helper wrote the file (width + 5) with the recipe's writer and sealed an edit receipt (no operation) naming it
    helperSha = sha(paramsText({ ...card, width: card.width + 5 }));
    // X: its flow changed width 140 → 150 and rebuilt; its agent's receipt names the file's bytes after
    flow(p, 'fa0a9ed5a', X, { outcome: 'succeeded', before: { ...card, width: 140 }, after: { ...card, width: 150 }, rebuild: true });
    p.seal({ kind: 'agent', subject: 'agent · qwen · tray', operation_id: X, files: [{ path: FILE, sha256: sha(paramsText({ ...card, width: 150 })), previous_sha256: sha(paramsText({ ...card, width: 140 })) }] });
    // N: its flow made no change (no values after)
    flow(p, 'fe1e2e3e4', N, { outcome: 'no change', before: { ...card, width: 150 } });
    // W: a save whose receipt names the helper's bytes (kept under .timmy/params-history/ when the file is written again below)
    p.seal({ kind: 'edit', subject: 'edit · recipes/tray.params.json from the live board', operation_id: W, files: [{ path: FILE, sha256: helperSha }] });
    // V: a receipt naming bytes that no copy holds
    p.seal({ kind: 'edit', subject: 'edit · recipes/tray.params.json', operation_id: V, files: [{ path: FILE, sha256: 'ab'.repeat(32) }] });
    // today: width 160, by hand (no receipt), through the recipe's writer, which keeps the previous bytes first
    const wrote = writeParams(p.root, { ...card, width: 160 });
    if (!wrote.ok) throw new Error(wrote.error);
    // Y: a save whose receipt names today's bytes
    p.seal({ kind: 'edit', subject: 'edit · recipes/tray.params.json from Timmy Canvas', operation_id: Y, files: [{ path: FILE, sha256: wrote.sha256 }] });
  });
  afterAll(() => { if (p?.base) rmSync(p.base, { recursive: true, force: true }); });

  const reader = () => usedReader({ root: p.root, pid: p.pid, chain: readRunsChain(p.store), t: (v, max) => cardText(v, p.root, max) });

  it('an operation whose flow changed the file and rebuilt: the values after its agent (150, not today\'s 160), sealed, with its build', () => {
    const u = reader().of(X, TRAY)!;
    expect(u).toMatchObject({ operation: X, file: FILE, state: 'recorded', sha256: sha(paramsText({ ...card, width: 150 })), verified: true });
    expect(width(u)).toBe(150);
    // every value of the recipe, in the recipe's own order, in millimetres
    expect(u.values.map((v) => v.name)).toEqual([...PARAMETER_NAMES]);
    expect(u.values.every((v) => v.unit === 'mm')).toBe(true);
    expect(u.from).toMatch(/^its flow fa0a9ed5a \(succeeded\) rebuilt the tray from these values; receipt [0-9a-f]{8} sealed its record$/);
    expect(u.build).toBe('recipe job abcd1234 succeeded, predicted 150 x 80 x 30 mm, its readback matches');
  });

  it('a flow record changed after it was sealed: its values are shown as not verified, and why', async () => {
    const t = await makeCanvasProject('studio-used-values-tamper-');
    try {
      const rel = flow(t, 'fb0b0b0b0', X, { outcome: 'succeeded', before: { ...card, width: 140 }, after: { ...card, width: 150 }, rebuild: true });
      appendFileSync(join(t.root, rel), ' ');
      const u = usedReader({ root: t.root, pid: t.pid, chain: readRunsChain(t.store), t: (v, max) => cardText(v, t.root, max) }).of(X, TRAY)!;
      expect(u).toMatchObject({ state: 'recorded', verified: false });
      expect(width(u)).toBe(150);
      expect(u.from).toMatch(/its record is not verified: results\/flows\/fb0b0b0b0\.json changed after it was sealed/);
    } finally { rmSync(t.base, { recursive: true, force: true }); }
  });

  it('a flow that made no change: the values its agent left as they were', () => {
    const u = reader().of(N, TRAY)!;
    expect(u).toMatchObject({ state: 'recorded', verified: true, build: null });
    expect(width(u)).toBe(150);
    expect(u.from).toMatch(/^its flow fe1e2e3e4 made no change: these are the values its agent left as they were, and nothing was rebuilt; receipt [0-9a-f]{8} sealed its record$/);
  });

  it("a save whose receipt names today's bytes: today's values, said as the same bytes now", () => {
    const u = reader().of(Y, TRAY)!;
    expect(u).toMatchObject({ state: 'recorded', verified: true });
    expect(width(u)).toBe(160);
    expect(u.from).toMatch(/^receipt [0-9a-f]{8} \(edit\) names recipes\/tray\.params\.json as sha256 [0-9a-f]{12}, and the file holds the same bytes now$/);
  });

  it('a save whose bytes the file no longer holds: read from the copy the recipe\'s writer kept of them', () => {
    const u = reader().of(W, TRAY)!;
    expect(u).toMatchObject({ state: 'recorded', verified: true, sha256: helperSha });
    expect(width(u)).toBe(card.width + 5);
    expect(u.from).toMatch(/^receipt [0-9a-f]{8} \(edit\) names recipes\/tray\.params\.json as sha256 [0-9a-f]{12}; a kept copy \(\.timmy\/params-history\/tray\/[^)]+\.json\) holds those bytes$/);
  });

  it('bytes no copy holds: unknown, never today\'s values, and why', () => {
    const u = reader().of(V, TRAY)!;
    expect(u).toMatchObject({ state: 'unknown', values: [], sha256: 'ab'.repeat(32), verified: false });
    expect(u.from).toMatch(/^receipt [0-9a-f]{8} \(edit\) names recipes\/tray\.params\.json as sha256 abababababab, the file is sha256 [0-9a-f]{12} now, and no copy Timmy kept holds those bytes, so the values it used are not known$/);
    // an operation no record of which names the file: none (the card says unknown, with why)
    expect(reader().of('of0f0f0f0', TRAY)).toBeNull();
    expect(reader().of('not-an-op', TRAY)).toBeNull();
  });

  it("an OpenSCAD model's parameter file: the values in the bytes a receipt of the operation names", () => {
    p.seal({ kind: 'edit', subject: 'edit · box.params.json', operation_id: 'o5c5c5c5c', files: [{ path: 'box.params.json', sha256: sha(readFileSync(join(p.root, 'box.params.json'))) }] });
    const u = reader().of('o5c5c5c5c', { file: 'box.params.json', engine: 'scad', model: 'box.scad' })!;
    expect(u).toMatchObject({ state: 'recorded', verified: true });
    expect(u.values).toEqual([{ name: 'width', value: 90 }, { name: 'depth', value: 40 }, { name: 'height', value: 30 }]);
  });

  it("the project's reading lists, with the detail, what each operation used of the parameter files it lists", () => {
    const read = projectCards({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store }, {}, { detail: true });
    const x = read.operations!.find((o) => o.id === X)!;
    expect(x.used).toHaveLength(1);
    expect(x.used![0]).toMatchObject({ operation: X, file: FILE, state: 'recorded', verified: true });
    expect(width(x.used![0])).toBe(150);
    // without the detail, none (the plain list says nothing of values)
    const plain = projectCards({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store }, {}, { detail: false });
    expect(plain.operations!.every((o) => o.used === undefined)).toBe(true);
    // no absolute path in what the page is sent
    expect(JSON.stringify(read.operations)).not.toContain(p.root);
  });
});
