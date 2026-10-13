/**
 * Timmy Memory (round R4, helper H50): lessons with evidence, through the Workspace's /lesson and /lessons, on real files
 * in a temporary project and a REAL receipts chain kept in it (tests/helpers/memory-kit.ts: appendReceipt, signed, read
 * back with readChain). The flow records cited as evidence are written by the flows' own writer with made-up contents
 * (no agent or recipe ran); their bytes, their sha256 and their receipts on the chain are what the lessons bind.
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/repl/commands.js';
import { LESSON_SCHEMA, LESSONS_ARE, validateLesson, type Lesson } from '../src/memory/lessons.js';
import { verifyChain } from '../src/utils/receipts.js';
import { chainOf, memoryKit, put, read, sha, text, workspace, writeFlow } from './helpers/memory-kit.js';

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

const lessonId = (out: string): string => { const m = /Lesson\s+(l[0-9a-f]{8})/.exec(out); if (!m) throw new Error(`no lesson in: ${out}`); return m[1]; };
const lessonFile = (root: string, id: string): Lesson => JSON.parse(read(root, `.timmy/memory/lessons/${id}.json`)) as Lesson;
const lessonReceipts = (root: string) => chainOf(root).filter((r) => r.kind === 'lesson');

describe('/lesson add: a draft with its evidence, or refused', () => {
  it('a lesson without evidence is refused with the line to type; nothing is written or sealed', async () => {
    const root = kit.temp('memory-lessons-');
    const flow = writeFlow(root, { instruction: 'make it 180 wide' });
    const { ws } = workspace(root, kit);
    const out = text(ws.lesson('add "keep the width under 200"'));
    expect(out).toContain('A lesson needs evidence: a record it was learnt from. Nothing was written.');
    expect(out).toContain(`/lesson add "keep the width under 200" --from ${flow.rel}`);
    expect(() => readdirSync(join(root, '.timmy', 'memory'))).toThrow();
    expect(lessonReceipts(root)).toEqual([]);
    // No text, an unknown option, a quote left open: refused too, with nothing written.
    expect(text(ws.lesson(`add --from ${flow.rel}`))).toContain('Say what the lesson is, in quotes');
    expect(text(ws.lesson(`add "x y" --form ${flow.rel}`))).toContain('No option --form');
    expect(text(ws.lesson(`add don't do it --from ${flow.rel}`))).toContain('A quote is left open');
    expect(lessonReceipts(root)).toEqual([]);
  });

  it('from a record file: a draft in schema timmy.lesson/1 exactly, the file\'s sha256 and the receipt that sealed it, 0600 in 0700 folders, one lesson receipt', async () => {
    const root = kit.temp('memory-lessons-');
    const flow = writeFlow(root, { instruction: 'make it 180 wide' });
    const { ws } = workspace(root, kit, { env: { TIMMY_OPERATION: 'op-test-1' } });
    const out = text(ws.lesson(`add "Keep the width under 200 mm: wider trays failed the readback." --from ${flow.rel} --applies tray width`));
    const id = lessonId(out);
    expect(out).toContain(`1. ${flow.rel}  sha256 ${flow.sha256.slice(0, 12)} · receipt ${flow.receipt!.hash.slice(7, 15)}`);
    expect(out).toContain('Applies    kinds tray · files none · words width');
    expect(out).toContain(`/lesson check ${id}: only a checked lesson is given to an agent`);
    expect(out).toContain(LESSONS_ARE);
    const raw = JSON.parse(read(root, `.timmy/memory/lessons/${id}.json`)) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['applies_to', 'checked', 'created', 'evidence', 'id', 'operation', 'schema', 'source', 'status', 'text']);
    expect(raw).toMatchObject({
      schema: LESSON_SCHEMA, id, text: 'Keep the width under 200 mm: wider trays failed the readback.', status: 'draft', checked: null, source: 'user', operation: 'op-test-1',
      applies_to: { kinds: ['tray'], files: [], words: ['width'] },
      evidence: [{ path: flow.rel, sha256: flow.sha256, receipt: flow.receipt!.hash }],
    });
    expect(Object.keys((raw.evidence as object[])[0]).sort()).toEqual(['path', 'receipt', 'sha256', 'why']);
    expect(String((raw.evidence as Array<{ why: string }>)[0].why)).toContain(`flow tray ${flow.id}: succeeded`);
    expect(validateLesson(raw, id).ok).toBe(true);
    // Private, as other private records: the file 0600, the folders it made 0700; no temporary file left behind.
    expect(statSync(join(root, '.timmy/memory/lessons', `${id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.timmy/memory')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, '.timmy/memory/lessons')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(root, '.timmy/memory/lessons'))).toEqual([`${id}.json`]);
    // Its receipt: kind lesson, action add, the file's bytes, the evidence as sources; the chain verifies.
    const [r] = lessonReceipts(root);
    expect(r).toMatchObject({ kind: 'lesson', status: 'ok', lesson: { id, action: 'add', status: 'draft', evidence: 1, operation: 'op-test-1' } });
    expect(r.files).toEqual([{ path: `.timmy/memory/lessons/${id}.json`, sha256: sha(readFileSync(join(root, '.timmy/memory/lessons', `${id}.json`))), bytes: statSync(join(root, '.timmy/memory/lessons', `${id}.json`)).size, created: true }]);
    expect(r.sources).toEqual([{ path: flow.rel, sha256: flow.sha256, receipt: flow.receipt!.hash, role: 'evidence' }]);
    expect(JSON.stringify(r)).not.toContain('wider trays');
    expect(verifyChain('runs', root).ok).toBe(true);
  });

  it('from a receipt hash: the record it sealed; a receipt not on the chain is refused; without --applies its kind comes from its evidence', async () => {
    const root = kit.temp('memory-lessons-');
    const flow = writeFlow(root, { instruction: 'deeper', kind: 'scad' });
    const { ws } = workspace(root, kit);
    const id = lessonId(text(ws.lesson(`add "The box lid needs 0.4 mm of gap." --from ${flow.receipt!.hash.slice(7, 15)}`)));
    const l = lessonFile(root, id);
    expect(l.evidence).toEqual([expect.objectContaining({ path: flow.rel, sha256: flow.sha256, receipt: flow.receipt!.hash })]);
    expect(l.applies_to).toEqual({ kinds: ['scad'], files: [], words: [] });
    const refused = text(ws.lesson('add "nothing" --from deadbeef'));
    expect(refused).toContain('Not added: --from deadbeef: no receipt deadbeef is on this project\'s chain. Nothing was written.');
    const missing = text(ws.lesson('add "nothing" --from results/flows/f00000000.json'));
    expect(missing).toContain('results/flows/f00000000.json does not exist in this project');
    expect(lessonReceipts(root).map((r) => r.lesson?.action)).toEqual(['add']);
  });
});

describe('/lesson check: checked while its evidence holds, stale when it does not', () => {
  async function added() {
    const root = kit.temp('memory-lessons-');
    const flow = writeFlow(root, { instruction: 'make it 180 wide' });
    const { ws } = workspace(root, kit);
    const id = lessonId(text(ws.lesson(`add "Keep the width under 200." --from ${flow.rel} --applies tray`)));
    return { root, flow, ws, id };
  }

  it('checked: every evidence file has its bytes and every receipt verifies; its checked time and a check receipt', async () => {
    const { root, ws, id } = await added();
    const out = text(ws.lesson(`check ${id}`));
    expect(out).toContain(`${id} checked: every evidence file (1) has the bytes it was added with, and every receipt it names verifies`);
    const l = lessonFile(root, id);
    expect(l.status).toBe('checked');
    expect(Date.parse(l.checked!)).not.toBeNaN();
    const r = lessonReceipts(root).at(-1)!;
    expect(r).toMatchObject({ status: 'ok', lesson: { id, action: 'check', status: 'checked' } });
    expect(r.files?.[0]).toMatchObject({ path: `.timmy/memory/lessons/${id}.json`, previous_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('one changed byte of its evidence makes it stale, naming the item; the file says stale, its receipt failed with why', async () => {
    const { root, flow, ws, id } = await added();
    text(ws.lesson(`check ${id}`));
    const bytes = readFileSync(join(root, flow.rel));
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x7d ? 0x20 : 0x7d; // one byte, near the end
    writeFileSync(join(root, flow.rel), bytes);
    const out = text(ws.lesson(`check ${id}`));
    expect(out).toContain(`${id} stale: item 1: ${flow.rel} changed: sha256 ${sha(bytes).slice(0, 12)} now, ${flow.sha256.slice(0, 12)} when the lesson was added`);
    const l = lessonFile(root, id);
    expect(l.status).toBe('stale');
    const r = lessonReceipts(root).at(-1)!;
    expect(r).toMatchObject({ status: 'failed', lesson: { id, action: 'check', status: 'stale' } });
    expect(r.discrepancies?.[0]).toContain(`item 1: ${flow.rel} changed`);
    // Its checked time stays the last time it checked.
    expect(l.checked).not.toBeNull();
  });

  it('a deleted evidence file makes it stale', async () => {
    const { root, flow, ws, id } = await added();
    rmSync(join(root, flow.rel));
    expect(text(ws.lesson(`check ${id}`))).toContain(`${id} stale: item 1: ${flow.rel} is gone`);
    expect(lessonFile(root, id).status).toBe('stale');
  });

  it('a receipt that does not verify makes it stale: an edited receipt on the chain', async () => {
    const { root, flow, ws, id } = await added();
    // The flow's receipt is edited in the chain file (its subject), so its body no longer hashes to its hash.
    const file = join(root, '.timmy', 'receipts', 'runs.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.includes(flow.receipt!.hash) && l.includes('"kind":"flow"'));
    const rec = JSON.parse(lines[at]) as Record<string, unknown>;
    lines[at] = JSON.stringify({ ...rec, subject: 'flow · edited after it was sealed' });
    writeFileSync(file, lines.join('\n'));
    const out = text(ws.lesson(`check ${id}`));
    expect(out).toContain(`${id} stale: item 1: receipt ${flow.receipt!.hash.slice(7, 15)} does not verify: body hash mismatch`);
    expect(lessonFile(root, id).status).toBe('stale');
  });

  it('where its receipt names the record\'s sha256 and the lesson holds another, they disagree: stale', async () => {
    const { root, flow, ws, id } = await added();
    // The record is rewritten (no new receipt), and the lesson file is edited by hand to hold the new bytes' sha256.
    writeFileSync(join(root, flow.rel), `${read(root, flow.rel)} `);
    const l = lessonFile(root, id);
    const now = sha(readFileSync(join(root, flow.rel)));
    writeFileSync(join(root, `.timmy/memory/lessons/${id}.json`), `${JSON.stringify({ ...l, evidence: [{ ...l.evidence[0], sha256: now }] }, null, 2)}\n`);
    const out = text(ws.lesson(`check ${id}`));
    expect(out).toContain(`receipt ${flow.receipt!.hash.slice(7, 15)} sealed ${flow.rel} as sha256 ${flow.sha256.slice(0, 12)}, not the ${now.slice(0, 12)} the lesson holds`);
  });

  it('check all checks every lesson, names a file that is not a lesson, and leaves a retired one as it is', async () => {
    const { root, ws, id } = await added();
    put(root, '.timmy/memory/lessons/l00000000.json', '{ not json');
    const other = lessonId(text(ws.lesson(`add "Second." --from ${'results/flows/' + readdirSync(join(root, 'results/flows'))[0]} --applies tray`)));
    text(ws.lesson(`retire ${other}`));
    const out = text(ws.lesson('check all'));
    expect(out).toContain(`${id} checked`);
    expect(out).toContain('.timmy/memory/lessons/l00000000.json  not checked: it is not JSON');
    expect(out).toContain(`${other}  retired: not checked; it stays as it is`);
    expect(read(root, '.timmy/memory/lessons/l00000000.json')).toBe('{ not json');
  });
});

describe('/lesson retire, /lesson <id>, /lessons', () => {
  it('retire: never given again, kept, sealed; twice says so and seals nothing', async () => {
    const root = kit.temp('memory-lessons-');
    const flow = writeFlow(root, { instruction: 'x' });
    const { ws } = workspace(root, kit);
    const id = lessonId(text(ws.lesson(`add "A lesson." --from ${flow.rel} --applies tray`)));
    expect(text(ws.lesson(`retire ${id}`))).toContain(`${id} retired: it is never given to an agent again; its file and evidence are kept`);
    expect(lessonFile(root, id).status).toBe('retired');
    expect(lessonReceipts(root).map((r) => [r.lesson?.action, r.lesson?.status])).toEqual([['add', 'draft'], ['retire', 'retired']]);
    expect(text(ws.lesson(`retire ${id}`))).toContain(`${id} is retired already; nothing was written.`);
    expect(lessonReceipts(root)).toHaveLength(2);
    expect(text(ws.lesson('retire l12345678'))).toContain('No lesson l12345678 in this project');
  });

  it('/lessons: status, text, evidence count and the runs that used each; an unreadable file is named; /lesson <id> in full', async () => {
    const root = kit.temp('memory-lessons-');
    const flow = writeFlow(root, { instruction: 'x' });
    const { ws } = workspace(root, kit);
    const id = lessonId(text(ws.lesson(`add "Use a 0.4 mm lid gap." --from ${flow.rel} --applies scad`)));
    text(ws.lesson(`check ${id}`));
    writeFlow(root, { instruction: 'y', kind: 'scad', lessons: [id] });
    put(root, '.timmy/memory/lessons/l00000000.json', JSON.stringify({ schema: 'timmy.lesson/1', id: 'l00000000' }));
    const list = text(ws.lessons(''));
    expect(list).toMatch(new RegExp(`${id} {2}checked  Use a 0\\.4 mm lid gap\\. · 1 evidence · used by 1 run · scad`));
    expect(list).toContain('.timmy/memory/lessons/l00000000.json  not read as a lesson: not a timmy.lesson/1 lesson: it has no text');
    expect(list).toContain(LESSONS_ARE);
    expect(text(ws.lessons('blender'))).toContain('None names blender.');
    expect(text(ws.lessons('nonsense'))).toContain('No kind nonsense');
    const one = text(ws.lesson(id));
    expect(one).toContain(`Lesson     ${id}  checked`);
    expect(one).toContain('Now        its evidence checks: every file has its bytes and every receipt it names verifies');
    expect(one).toMatch(/Used by +1 run: flow f[0-9a-f]{8}/);
    expect(one).toMatch(/File {7}\.timmy\/memory\/lessons\/l[0-9a-f]{8}\.json · receipt [0-9a-f]{8} sealed these bytes/);
  });

  it('/help says recall searches by words, not meaning, and that lessons are agent context with no model trained', () => {
    const d = Object.fromEntries(COMMANDS.map((c) => [c.name, c.description]));
    expect(d.recall).toBe('Find retained work by words, not meaning');
    expect(d.lesson).toBe('Add, check, eval, retire: text with evidence');
    expect(d.lessons).toBe('Lessons as agent context; no model trained');
    for (const n of ['recall', 'lesson', 'lessons']) expect(d[n].length).toBeLessThanOrEqual(45);
  });
});
