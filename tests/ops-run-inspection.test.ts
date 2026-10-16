/**
 * R6 (H144): one run inspected (src/ops/run-detail.ts readRunInspection): its source, its changes, its outputs and its
 * receipts, made from the records a real /run wrote, as the companion's run detail and the Workbench's tab 3 draw them.
 *
 * FAKE pieces, each labelled where it is used:
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; each block through sh -c);
 * - the `change` block's `fake-params-flow 150` is tests/fixtures/fake-params-flow.ts (a TEST DOUBLE of what
 *   `/iterate tray` leaves when its agent changes the tray's width: no agent runs, nothing is built; it keeps the
 *   parameter file's bytes as read, changes the width, writes the flow record through Timmy's own writer and seals a real
 *   flow receipt under the block's operation);
 * - REPORT.md is this test's FAKE workflow: its `report` block writes a text, a JSON, a PNG (made here) and a binary into
 *   out/, and prints 60 lines;
 * - a copy of the chain with one receipt's words changed (FIXTURE), to show a receipt that does not verify.
 * Real: the REPL's Workspace and its /run (the operation's record, the prediction receipt, the job and its block receipts,
 * the run's receipt), its /restore, the job manager, the project's own receipt chain and Timmy's verifier. Every folder is
 * under os.tmpdir().
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { IMAGE_DATA_MAX, lineDiff, readRunDetail, readRunInspection, RUN_INSPECTION_VERSION, type InspectChange, type RunInspection } from '../src/ops/run-detail.js';
import { readChain, type Receipt } from '../src/utils/receipts.js';
import type { Workspace } from '../src/repl/workspace.js';
import { FIXTURES, LOADER, opsKit, replOf, sandbox, text, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);

const F = '```';
const FAKE_FLOW = path.join(FIXTURES, 'fake-params-flow.ts');
const TRAY_PARAMS = path.resolve('templates/tray-workflow/recipes/tray.params.json');
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

/** A small PNG (8 by 6 pixels, RGB), made here: the image the FAKE report block writes. */
function png(w: number, h: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = 40 * x; raw[i + 1] = 255 - 40 * y; raw[i + 2] = 180; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(8, 6);

/** The FAKE workflow: `change` (the FAKE flow), then `report`, which writes out/ and prints 60 lines. */
const REPORT = [
  '# FAKE report workflow (this test)', '',
  'The change block runs a TEST DOUBLE of /iterate; the report block writes a text, a JSON, an image and a binary.', '',
  `${F}bash [name:change]`, 'fake-params-flow 150', F, '',
  `${F}bash [name:report, deps:change]`,
  'mkdir -p out',
  "printf '# Report\\n\\nThe tray is 150 mm wide now.\\nFAKE: written by the test workflow.\\n' > out/report.md",
  "printf '{\"width\":150,\"files\":[\"out/report.md\",\"out/preview.png\"],\"ok\":true}\\n' > out/summary.json",
  `printf '%s' '${PNG.toString('base64')}' | base64 -d > out/preview.png`,
  "printf 'BIN\\000\\001\\002\\377' > out/blob.bin",
  'for i in $(seq 1 60); do echo "report line $i"; done',
  F, '',
].join('\n');

/** The project: the tray's parameter file, REPORT.md, and the FAKE flow command on PATH. */
function reportProject(s: Sandbox): void {
  fs.mkdirSync(path.join(s.root, 'recipes'), { recursive: true });
  fs.copyFileSync(TRAY_PARAMS, path.join(s.root, 'recipes', 'tray.params.json'));
  fs.writeFileSync(path.join(s.root, 'REPORT.md'), REPORT);
  fs.writeFileSync(path.join(s.bin, 'fake-params-flow'), [
    '#!/bin/sh',
    '# FAKE: a TEST DOUBLE of /iterate changing the tray\'s width (tests/fixtures/fake-params-flow.ts)',
    `exec "${process.execPath}" --import "${LOADER}" "${FAKE_FLOW}" "$@"`, '',
  ].join('\n'), { mode: 0o755 });
}

/** `/run <doc> <block>` in the REPL, to its end: its job and operation. */
async function runOf(ws: Workspace, doc: string, block: string): Promise<{ job: string; op: string }> {
  const started = text(await ws.operate(`/run ${doc} ${block}`, 'repl', () => ws.run(`${doc} ${block}`)));
  const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
  expect(job, started).toBeDefined();
  const h = ws.ops.latest!;
  const done = await ws.jobs.done(job!);
  expect(done.state, `${started}\n${ws.jobs.tail(job!, 80).join('\n')}`).toBe('completed');
  await ws.ops.done(h);
  return { job: job!, op: h.id };
}

const inspect = (s: Sandbox, ws: Workspace, op: string, o: { chain?: readonly Receipt[]; images?: number; lines?: number } = {}): RunInspection => {
  const r = readRunInspection(op, { project: s.root, jobs: ws.jobs.list(), chain: o.chain ?? readChain('runs', s.root), images: o.images ?? IMAGE_DATA_MAX, ...(o.lines ? { lines: o.lines } : {}) });
  if (!r.ok) throw new Error(r.why);
  return r.inspection;
};
const change = (i: RunInspection, p: string): InspectChange => { const c = i.changes.list.find((x) => x.path === p); if (!c) throw new Error(`no change of ${p}: ${i.changes.list.map((x) => x.path).join(', ')}`); return c; };
const diffText = (c: InspectChange): string[] => (c.diff.shown ? c.diff.hunks.flatMap((h) => [h.header, ...h.lines.map((l) => `${l.op}${l.text}`)]) : []);

describe('a run inspected: a FAKE workflow run that changes a file and writes four (R6 H144)', () => {
  it('its source as it ran with both hashes, each change with its diff (or why none), its outputs previewed, its receipts verified now, its actions with one primary', async () => {
    const s = sandbox(kit, 'inspect-');
    reportProject(s);
    const { ws } = replOf(kit, s);
    const paramsBefore = fs.readFileSync(path.join(s.root, 'recipes', 'tray.params.json'));
    const { job, op } = await runOf(ws, 'REPORT.md', 'report');
    const i = inspect(s, ws, op);
    expect(i.version).toBe(RUN_INSPECTION_VERSION);
    expect(i.operation).toBe(op);
    expect(Date.parse(i.checkedAt)).toBeGreaterThan(0);

    // the intent: the request, from its record; not a receipt, and the prediction receipt that seals what it ran from
    const docSha = sha(fs.readFileSync(path.join(s.root, 'REPORT.md')));
    expect(i.intent).toMatchObject({ request: '/run REPORT.md report', via: 'repl', from: `.timmy/operations/${op}.json` });
    expect(i.intent.sealed).toMatch(new RegExp(`^not a receipt: Timmy writes an operation's record and nothing seals it; prediction receipt [0-9a-f]{8} seals what it ran from \\(REPORT\\.md sha256 ${docSha.slice(0, 12)}\\)$`));

    // the source: the document as upmd read it (the copy /run kept, its sha256 the one sealed), the same now, each block
    // that ran with its code, and that code's sha256 against the one its block receipt sealed
    if (!('doc' in i.source)) throw new Error(i.source.none);
    expect(i.source).toMatchObject({ doc: 'REPORT.md', block: 'report', order: ['change', 'report'], asRan: { sha256: docSha }, copy: { state: 'kept' }, now: { state: 'same', sha256: docSha } });
    expect(i.source.copy.words).toMatch(new RegExp(`^the copy upmd read \\(job ${job}\\), its sha256 the one prediction receipt [0-9a-f]{8} sealed$`));
    expect(i.source.copy.where).toMatch(/^~?.*\/jobs\/runs\/w[0-9a-f]{8}\/checked\.md$/);
    expect(i.source.blocks.map((b) => [b.name, b.target, b.firstLine, b.sealed?.matches])).toEqual([['change', false, 6, true], ['report', true, 10, true]]);
    expect(i.source.blocks[0].code).toEqual(['fake-params-flow 150']);
    expect(i.source.blocks[1].code[0]).toBe('mkdir -p out');
    expect(i.source.blocks[1].code).toHaveLength(6);
    expect(i.source.blocks[1].code.at(-1)).toBe('for i in $(seq 1 60); do echo "report line $i"; done');
    expect(i.source.diff).toBeUndefined();

    // the changes: the FAKE flow's parameter change, drawn against the copy it kept, with the /restore that can be done
    const params = change(i, 'recipes/tray.params.json');
    expect(params).toMatchObject({ how: 'changed', before: sha(paramsBefore), now: { state: 'as recorded' }, check: { status: 'verified' }, open: '/open recipes/tray.params.json' });
    expect(params.kept.path).toMatch(/^\.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json$/);
    expect(params.kept.state).toBe('ok');
    expect(params.diff).toMatchObject({ shown: true, against: 'kept', from: params.kept.path, to: 'recipes/tray.params.json', added: expect.any(Number), removed: expect.any(Number) });
    const pd = diffText(params);
    expect(pd.some((l) => /^-\s+"width": 140,?$/.test(l))).toBe(true);
    expect(pd.some((l) => /^\+\s+"width": 150,?$/.test(l))).toBe(true);
    expect(pd[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    // context lines around the change, unchanged ones marked ' '
    expect(params.diff.shown && params.diff.hunks[0].lines.some((l) => l.op === ' ')).toBe(true);
    expect(params.restore).toEqual({ offered: true, command: `/restore recipes/tray.params.json --from ${params.kept.path}`, from: params.kept.path });
    // what the report block wrote: each an output-folder file of the run's receipt (written: whether it was there before is
    // not recorded, so no diff), its preview the bytes the run left: text, JSON laid out, an image drawn, a binary's size
    for (const p of ['out/report.md', 'out/summary.json', 'out/preview.png', 'out/blob.bin']) {
      const c = change(i, p);
      expect(c.how).toBe('written');
      expect(c.diff).toEqual({ shown: false, why: 'no line diff: Timmy kept no previous version of it, and whether it was there before the run is not recorded' });
      expect(c.restore).toEqual({ offered: false, why: 'no previous version is kept' });
      expect(c.preview?.of).toBe('the file as the run left it');
      expect(c.now.state).toBe('as recorded');
    }
    expect(change(i, 'out/report.md').preview).toMatchObject({ kind: 'text', lines: ['# Report', '', 'The tray is 150 mm wide now.', 'FAKE: written by the test workflow.'], more: 0 });
    expect(change(i, 'out/summary.json').preview).toMatchObject({ kind: 'text', json: true, lines: ['{', '  "width": 150,', '  "files": [', '    "out/report.md",', '    "out/preview.png"', '  ],', '  "ok": true', '}'] });
    expect(change(i, 'out/preview.png').preview).toMatchObject({ kind: 'image', mime: 'image/png', width: 8, height: 6, bytes: PNG.length, sha256: sha(PNG), data: `data:image/png;base64,${PNG.toString('base64')}` });
    const blob = Buffer.from([0x42, 0x49, 0x4e, 0, 1, 2, 0xff]);
    expect(change(i, 'out/blob.bin').preview).toMatchObject({ kind: 'binary', bytes: 7, sha256: sha(blob) });
    expect(i.changes.notes.join('\n')).toContain('a block\'s own command may change files Timmy does not record');

    // the outputs: the run's log first (its bytes the ones the run's receipt sealed, its 60 printed lines), then its files
    const log = i.outputs[0];
    expect(log).toMatchObject({ kind: 'log', what: `the log of job ${job} (REPORT.md › report)`, now: { state: 'as recorded' }, open: `/jobs ${job}` });
    expect(log.path).toMatch(new RegExp(`jobs/${job}\\.log$`));
    if (log.preview.kind !== 'text') throw new Error('the log is not text');
    expect(log.preview.lines).toEqual(expect.arrayContaining(['report line 1', 'report line 60']));
    expect(log.preview.lines.join('\n')).not.toMatch(/\x1b/);
    const files = i.outputs.filter((o) => o.kind === 'file').map((o) => o.path);
    expect(files).toEqual(expect.arrayContaining(['out/report.md', 'out/summary.json', 'out/preview.png', 'out/blob.bin']));
    const pngOut = i.outputs.find((o) => o.path === 'out/preview.png')!;
    expect(pngOut).toMatchObject({ recorded: { sha256: sha(PNG), bytes: PNG.length }, now: { state: 'as recorded' }, preview: { kind: 'image', width: 8, height: 6 } });
    expect(pngOut.recorded!.from).toMatch(/^receipt [0-9a-f]{8}$/);

    // the receipts: predict → run (the flow's, each block's) → receipt (the run's), each verified now, saying what it checked
    const chain = readChain('runs', s.root);
    const mine = chain.filter((r) => r.operation_id === op);
    expect(i.receipts.list.map((r) => [r.stage, r.kind])).toEqual(mine.map((r) => [r.kind === 'predict' ? 'predict' : r.kind === 'workflow' ? 'receipt' : 'run', r.kind]));
    expect(i.receipts.list.map((r) => r.kind)).toEqual(['predict', 'flow', 'workflow-block', 'workflow-block', 'workflow']);
    for (const r of i.receipts.list) {
      expect(r.verified.ok, JSON.stringify(r)).toBe(true);
      const at = chain.findIndex((x) => x.hash === r.hash);
      const prev = at > 0 ? chain[at - 1].hash.slice(7, 15) : 'genesis';
      expect(r.prev).toBe(prev);
      expect(r.position).toBe(at + 1);
      if (r.verified.ok) expect(r.verified.checked).toBe(`its body hashes to ${r.hash.slice(0, 19)}…, recomputed now; its prev_hash ${prev === 'genesis' ? 'starts epoch 1' : `is receipt ${prev}'s hash`}, and the ${at + 1} link${at ? 's' : ''} and body hashes from the start of epoch 1 up to it hold; its signature verifies against the signer key it carries`);
    }
    expect(i.receipts.chain).toMatchObject({ ok: true, read: chain.length });
    expect(i.receipts.chain.words).toBe(`the chain verifies from the start of epoch 1 up to receipt ${i.receipts.list.at(-1)!.id}: ${chain.findIndex((x) => x.hash === i.receipts.list.at(-1)!.hash) + 1} receipts, every link and body hash, and ${i.receipts.list.at(-1)!.id}'s signature (verifyReceiptIn, now)`);

    // the actions: open, review, restore (it writes), the run again (it runs); one primary, the run detail's next step
    const acts = i.actions;
    expect(acts.map((a) => [a.id, a.effect, a.available])).toEqual([['open', 'reads', true], ['review', 'reads', true], ['restore', 'writes', true], ['run-again', 'runs', true]]);
    expect(acts.find((a) => a.id === 'open')).toMatchObject({ label: 'Open recipes/tray.params.json', command: '/open recipes/tray.params.json' });
    expect(acts.find((a) => a.id === 'review')).toMatchObject({ command: `/review ${op}` });
    expect(acts.find((a) => a.id === 'restore')).toMatchObject({ command: params.restore.offered ? params.restore.command : '', label: 'Restore recipes/tray.params.json' });
    expect(acts.find((a) => a.id === 'run-again')).toMatchObject({ command: '/run REPORT.md report' });
    // one primary: Timmy's verdict is completed, so its result, to look at
    const d = readRunDetail(op, { project: s.root, jobs: ws.jobs.list(), chain });
    if (!d.ok) throw new Error(d.why);
    expect(d.detail.verdict.state).toBe('completed');
    expect(acts.filter((a) => a.primary).map((a) => a.id)).toEqual(['open']);

    // the source changed since the run: said so, with both hashes, and its diff as it ran → now
    fs.appendFileSync(path.join(s.root, 'REPORT.md'), '\nA line added after the run.\n');
    const nowSha = sha(fs.readFileSync(path.join(s.root, 'REPORT.md')));
    const later = inspect(s, ws, op);
    if (!('doc' in later.source)) throw new Error('no source');
    expect(later.source.now).toEqual({ state: 'changed', sha256: nowSha, words: `REPORT.md changed since the run: sha256 ${nowSha.slice(0, 12)} now, ${docSha.slice(0, 12)} as it ran` });
    expect(later.source.copy.state).toBe('kept');
    expect(later.source.blocks).toHaveLength(2);
    expect(later.source.diff).toMatchObject({ shown: true, against: 'as ran', from: 'REPORT.md as it ran', to: 'REPORT.md now', added: 2, removed: 0 });
    expect(later.source.diff!.shown && later.source.diff!.hunks.flatMap((h) => h.lines).filter((l) => l.op === '+').map((l) => l.text)).toEqual(['', 'A line added after the run.']);
  }, 120_000);

  it('a receipt that does not verify on the chain read gets no verified mark: why, and the ones after it say the chain is broken before them', async () => {
    const s = sandbox(kit, 'inspect-bad-');
    reportProject(s);
    const { ws } = replOf(kit, s);
    const { op } = await runOf(ws, 'REPORT.md', 'report');
    // FIXTURE: a copy of the chain with the FAKE flow's receipt's words changed after it was sealed
    const chain = readChain('runs', s.root).map((r) => (r.kind === 'flow' && r.operation_id === op ? { ...r, subject: `${r.subject} (changed)` } : r));
    const i = inspect(s, ws, op, { chain });
    const v = i.receipts.list.map((r) => [r.kind, r.verified.ok, r.verified.ok ? '' : r.verified.why]);
    expect(v[0]).toEqual(['predict', true, '']);
    expect(v[1][0]).toBe('flow');
    expect(v[1][1]).toBe(false);
    expect(String(v[1][2])).toMatch(/body hash mismatch/);
    for (const later of v.slice(2)) { expect(later[1]).toBe(false); expect(String(later[2])).toMatch(/^the chain is broken before it/); }
    expect(i.receipts.chain.ok).toBe(false);
    expect(i.receipts.chain.words).toMatch(/^the chain up to receipt [0-9a-f]{8} does not verify: the chain is broken before it/);
  }, 120_000);

  it('Restore, the existing /restore: the file back as it was, the run\'s change said changed since (no restore offered), and the restore\'s own run shows its change against the version it kept', async () => {
    const s = sandbox(kit, 'inspect-restore-');
    reportProject(s);
    const { ws } = replOf(kit, s);
    const paramsBefore = fs.readFileSync(path.join(s.root, 'recipes', 'tray.params.json'), 'utf8');
    const { op } = await runOf(ws, 'REPORT.md', 'report');
    const i = inspect(s, ws, op);
    const act = i.actions.find((a) => a.id === 'restore')!;
    expect(act).toMatchObject({ effect: 'writes', available: true });
    // the action's command, typed in the REPL as the page tells a person to (its effect: writes)
    const args = act.command.replace(/^\/restore /, '');
    const said = text(await ws.operate(act.command, 'repl', () => ws.restore!(args)));
    const h = ws.ops.latest!;
    await ws.ops.done(h);
    expect(said).toMatch(/restored/i);
    expect(fs.readFileSync(path.join(s.root, 'recipes', 'tray.params.json'), 'utf8')).toBe(paramsBefore);
    // the run's own change: the file is not what the run left any more, so no restore is offered
    const after = change(inspect(s, ws, op), 'recipes/tray.params.json');
    expect(after.now.state).toBe('changed since');
    expect(after.restore.offered).toBe(false);
    expect(after.diff.shown).toBe(false);
    // the restore's run: its edit, drawn against the version /restore kept first (− 150, + 140), its receipt verified now
    const r = inspect(s, ws, h.id);
    const c = change(r, 'recipes/tray.params.json');
    expect(c).toMatchObject({ how: 'changed', now: { state: 'as recorded' }, check: { status: 'verified' } });
    expect(c.by).toMatch(/^\/restore \(from \.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json\)$/);
    expect(c.kept.path).toMatch(/^\.timmy\/restore-history\/recipes\/tray\.params\.json\/.+\.json\.bak$/);
    const dl = diffText(c);
    expect(dl.some((l) => /^-\s+"width": 150,?$/.test(l))).toBe(true);
    expect(dl.some((l) => /^\+\s+"width": 140,?$/.test(l))).toBe(true);
    expect(r.receipts.list.map((x) => [x.kind, x.verified.ok])).toEqual([['edit', true]]);
    expect(r.source).toEqual({ none: 'it ran no workflow document: no document\'s bytes were sealed before it ran' });
  }, 120_000);

  it('defaults: the jobs folder and the project\'s chain as `timmy op` reads them; images only when asked; an unknown operation refused in words', async () => {
    const s = sandbox(kit, 'inspect-defaults-');
    reportProject(s);
    const { ws } = replOf(kit, s);
    const { op } = await runOf(ws, 'REPORT.md', 'report');
    const r = readRunInspection(op, { project: s.root, lines: 5 });
    if (!r.ok) throw new Error(r.why);
    const pngChange = r.inspection.changes.list.find((c) => c.path === 'out/preview.png')!;
    expect(pngChange.preview).toMatchObject({ kind: 'image', width: 8, height: 6, why: 'drawn by the companion\'s run detail; a terminal shows its size and sha256' });
    expect((pngChange.preview as { data?: string }).data).toBeUndefined();
    const log = r.inspection.outputs[0];
    // its end: the block's last lines, then upmd's own end line for the block (FAKE upmd prints it as upmd 0.2.7 does)
    expect(log.preview).toMatchObject({ kind: 'text', lines: ['report line 57', 'report line 58', 'report line 59', 'report line 60', '<== report exited with code 0'] });
    expect((log.preview as { more: number }).more).toBeGreaterThan(55);
    expect(r.inspection.receipts.list.every((x) => x.verified.ok)).toBe(true);
    const none = readRunInspection('o00000000', { project: s.root });
    expect(none).toMatchObject({ ok: false, refusal: 'unknown' });
  }, 120_000);
});

describe('lineDiff: unified hunks with context (R6 H144)', () => {
  it('a change in the middle, an addition at the end, nothing changed, and an added file against nothing', () => {
    const a = 'abcdefghij'.split('').join('\n') + '\n';
    const b = ['a', 'B', ...'cdefghij'.split(''), 'k'].join('\n') + '\n';
    const d = lineDiff(a, b);
    expect(d).toMatchObject({ added: 2, removed: 1, more: 0 });
    expect(d.hunks.map((h) => [h.header, h.lines.map((l) => `${l.op}${l.text}`)])).toEqual([
      ['@@ -1,4 +1,4 @@', [' a', '-b', '+B', ' c', ' d']],
      ['@@ -9,2 +9,3 @@', [' i', ' j', '+k']],
    ]);
    // places closer than twice the context are one hunk, as a unified diff draws them
    expect(lineDiff('1\n2\n3\n4\n5\n6\n', '1\nX\n3\n4\n5\nY\n').hunks.map((h) => h.header)).toEqual(['@@ -1,6 +1,6 @@']);
    expect(lineDiff(a, a)).toMatchObject({ added: 0, removed: 0, hunks: [] });
    expect(lineDiff('', 'x\ny\n').hunks).toEqual([{ header: '@@ -0,0 +1,2 @@', lines: [{ op: '+', text: 'x' }, { op: '+', text: 'y' }] }]);
    // control characters are written as codes, never drawn
    expect(lineDiff('', 'a\x1b[31mb\n').hunks[0].lines[0].text).toBe('a\\x1b[31mb');
  });
});
