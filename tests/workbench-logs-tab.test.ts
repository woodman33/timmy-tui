/**
 * R5 (H134): tab 0, Logs & Receipts (src/workbench/logs-tab.ts), over a REAL project in a temporary folder: receipts sealed
 * with the real appendReceipt in the project's own store (hash-chained, and signed with an ed25519 key made in the project's
 * .timmy/keys), an operation record written by writeOperationRecord, and the job store's own file shapes in a temporary
 * Timmy home. FAKE here: the job's record and its log are written by the test (no process runs), with made-up times. A
 * tampered store is made by changing one receipt's words in the file, as an edit by hand would.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OPERATION_SCHEMA, writeOperationRecord } from '../src/ops/operations.js';
import { projectId } from '../src/project/index.js';
import { appendReceipt, receiptsPath, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { innerWidth } from '../src/workbench/frame.js';
import { layoutFor } from '../src/workbench/layout.js';
import { LOGS_LIST, logsDetail, logsView, readLogs, receiptVerdict, type LogsData, type LogsItem } from '../src/workbench/logs-tab.js';
import { COLUMNS_FROM } from '../src/workbench/tab-columns.js';
import { lineCells, plain, type Line, type Role } from '../src/workbench/text.js';

const boxes: string[] = [];
afterAll(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); });

const g = glyphsFor(true);
const SIZES = [[160, 45], [120, 40], [100, 30]] as const;
const OP = 'o1a2b3c4d';
const OP2 = 'o0000beef';
const JOB = 'j1a2b3c';

/** The body's inner size at a terminal size, as the Workbench lays a workspace tab out (Context a column from 120). */
function bodyAt(columns: number, rows: number): { width: number; height: number } {
  const l = layoutFor({ columns, rows, body: 'workspace' });
  return { width: innerWidth(l.center!.w), height: l.center!.h - 2 };
}

const env = (): Record<string, string | undefined> => { const e = { ...process.env }; delete e.TIMMY_STORE; return e; };

/**
 * A project with a /run of build.md › build (operation OP): its record, its prediction sealed before its job started, the job
 * (two blocks; its log has a line far longer than any column), a block receipt and the run's receipt; another operation
 * (OP2) with a run receipt and no prediction; and a receipt sealed outside any operation.
 */
function fixture(): { root: string; home: string; store: string; sealed: Receipt[] } {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'wb-logs-')));
  boxes.push(box);
  const root = join(box, 'tray');
  const home = join(box, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, 'jobs'), { recursive: true });
  const pid = projectId(root);
  const seal = (input: Partial<ReceiptInput> & { kind: string; subject: string }): Receipt =>
    appendReceipt('runs', { policy: 'auto', status: 'ok', project: 'tray', project_id: pid, ...input } as ReceiptInput, root);
  const sealed: Receipt[] = [];
  sealed.push(seal({ kind: 'run', subject: 'doctor.pass · 12 checks ok' }));
  const started = new Date(Date.now() - 1000).toISOString();
  writeOperationRecord(root, { schema: OPERATION_SCHEMA, id: OP, request: '/run build.md build', via: 'repl', project: '.', started, ended: null, state: 'running', parent: null, runs: [{ kind: 'job', id: JOB, at: started }], owner: { pid: 1, started } });
  const predict = seal({ kind: 'predict', subject: 'build.md › build: 2 blocks', operation_id: OP, prediction: { doc: 'build.md', block: 'build', order: ['fetch', 'build'], expect: 'both blocks complete' } });
  sealed.push(predict);
  // the job started after its prediction was sealed, as /run does it
  const t = Date.parse(predict.ts);
  const at = (ms: number): string => new Date(t + ms).toISOString();
  writeFileSync(join(home, 'jobs', `${JOB}.json`), `${JSON.stringify({
    id: JOB, kind: 'workflow', label: 'build.md › build', project: 'tray', root, command: 'upmd', args: ['run'], state: 'completed',
    startedAt: at(500), endedAt: at(6000), exitCode: 0, lines: 4, operation: OP,
    steps: [{ name: 'fetch', state: 'completed', code: 0, startedAt: at(1000), endedAt: at(2000) }, { name: 'build', state: 'completed', code: 0, startedAt: at(2000), endedAt: at(5900) }],
  }, null, 2)}\n`);
  writeFileSync(join(home, 'jobs', `${JOB}.log`), ['$ upmd run build.md build', '[1/2] bash fetch', `fetched ${'x'.repeat(300)} END-OF-LONG-LINE`, 'built tray.stl in 3.9 s'].join('\n') + '\n');
  sealed.push(seal({ kind: 'workflow-block', subject: 'build.md › fetch: completed', operation_id: OP }));
  sealed.push(seal({ kind: 'workflow', subject: 'build.md › build: completed, 2 of 2 blocks', operation_id: OP, job: { id: JOB, kind: 'workflow', label: 'build.md › build', state: 'completed', exit_code: 0 } }));
  writeOperationRecord(root, { schema: OPERATION_SCHEMA, id: OP, request: '/run build.md build', via: 'repl', project: '.', started, ended: at(6100), state: 'succeeded', why: `job ${JOB} succeeded`, parent: null, runs: [{ kind: 'job', id: JOB, at: started }], owner: { pid: 1, started } });
  sealed.push(seal({ kind: 'flow', subject: 'tray flow: no change', operation_id: OP2 }));
  return { root, home, store: receiptsPath('runs', root), sealed };
}

const ctxAt = (columns: number, rows: number, cursor = 0) => ({ ui: { cursor: { [LOGS_LIST]: cursor } }, g, ...bodyAt(columns, rows), now: Date.now(), columns });
const text = (lines: readonly Line[]): string => lines.map(plain).join('\n');
const segs = (lines: readonly Line[]) => lines.flat();
/** The roles of the segments whose words match. */
const rolesOf = (lines: readonly Line[], re: RegExp): Role[] => segs(lines).filter((s) => re.test(s.text)).map((s) => s.role ?? 'text');
/** Every green segment's words (a green card's box drawing left out: its title and rows are what say something). */
const greens = (lines: readonly Line[]): string[] => segs(lines).filter((s) => s.role === 'live' && !/^[\s│╭╮╰╯┏┓┗┛━┃─]*$/.test(s.text)).map((s) => s.text);
/** The line of the store a receipt is on (the bus's "receipt.sealed" lines are between them). */
const lineOfReceipt = (store: string, hash: string): number => readFileSync(store, 'utf8').split('\n').findIndex((l) => l.includes(`"hash":"${hash}"`)) + 1;
const indexOf = (d: LogsData, pred: (e: LogsData['events'][number]) => boolean): number => d.events.findIndex(pred);

/** What the reader may not change: every file of the project and of the home, with its size and time. */
function manifest(...dirs: string[]): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p); else { const s = statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
    }
  };
  for (const d of dirs) walk(d);
  return out.sort().join('\n');
}

describe('tab 0, Logs & Receipts: the chain line (verifyChain, in this reading)', () => {
  it('says "chain verified: N receipts" in green only when verifyChain passed now, at every size', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    expect(d.chain.state).toBe('verified');
    expect(d.chain.count).toBe(5);
    expect(d.chain.store).toBe('.timmy/receipts/runs.jsonl');
    for (const [c, r] of SIZES) {
      const v = logsView(ctxAt(c, r), d);
      expect(plain(v.lines[0])).toMatch(/^✓ chain verified: 5 receipts · in this reading · epoch 1/);
      expect(rolesOf([v.lines[0]], /chain verified/)).toEqual(['live']);
      // where there is room, what was checked (each part whole or left out, never cut)
      if (c !== 120) expect(plain(v.lines[0])).toMatch(/· links and body hashes \(verifyChain\)\s*$/);
      expect(plain(v.lines[0])).not.toMatch(/…/);
    }
  });

  it('a tampered receipt: ✕ amber with the reason; the chain is never green, and a receipt only where verifyReceiptIn still confirms it', () => {
    const f = fixture();
    const raw = readFileSync(f.store, 'utf8');
    writeFileSync(f.store, raw.replace('build.md › fetch: completed', 'build.md › fetch: EDITED BY HAND'));
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    expect(d.chain.state).toBe('broken');
    expect(d.chain.reason).toMatch(/body hash mismatch \(receipt rc_\w+ was tampered with\)/);
    for (const [c, r] of SIZES) {
      for (let k = 0; k < d.events.length; k++) {
        const v = logsView(ctxAt(c, r, k), d);
        expect(plain(v.lines[0])).toMatch(/^✕ chain does not verify: body hash mismatch/);
        expect(rolesOf([v.lines[0]], /chain does not verify/)).toEqual(['failure']);
        // the prediction was sealed before the edited receipt: its own link, body and signature still verify, and only that
        // may be green; the run's receipt, sealed after it, may not
        for (const s of greens(v.lines)) expect(s).toMatch(/^(✓ verified|\.predict)$/);
        expect(greens(v.lines)).not.toContain('.receipt');
      }
    }
    expect(receiptVerdict(d, f.sealed[1].hash)).toEqual({ ok: true });
    const k = indexOf(d, (e) => e.tag === 'workflow');
    for (const [c, r] of SIZES) {
      const v = logsView(ctxAt(c, r, k), d);
      expect(text(v.lines)).toMatch(/✕ does not verify/);
      expect(rolesOf(v.lines, /✕ does not verify/)).toEqual(['failure']);
      expect(rolesOf(v.lines, /^\s*\.receipt\s*$/)).toEqual(['failure']);
    }
    expect(text(logsView(ctxAt(100, 30, k), d).lines)).toMatch(/\.receipt +#\d+ workflow sealed · \d\d:\d\d:\d\d · ✕ does not verify: the chain is broken/);
    expect(receiptVerdict(d, f.sealed[3].hash)).toMatchObject({ ok: false, reason: expect.stringMatching(/^the chain is broken before it \(body hash mismatch/) });
  });

  it('nothing sealed: "no receipts yet", and the empty log says the one command that fills it', () => {
    const box = realpathSync(mkdtempSync(join(tmpdir(), 'wb-logs-empty-')));
    boxes.push(box);
    const root = join(box, 'blank');
    mkdirSync(root);
    const d = readLogs({ home: join(box, 'home'), root, env: env() });
    expect(d.chain.state).toBe('empty');
    expect(d.events).toEqual([]);
    for (const [c, r] of SIZES) {
      const v = logsView(ctxAt(c, r), d);
      expect(plain(v.lines[0])).toMatch(/^no receipts yet · nothing is sealed in \.timmy\/receipts\/runs\.jsonl/);
      expect(greens(v.lines)).toEqual([]);
      // the words wrap inside their column: each piece of the command is whole on its row
      const all = text(v.lines);
      for (const word of ['Nothing', 'recorded', '/run', '<document>', '<block>', 'REPL']) expect(all).toContain(word);
      for (const l of v.lines) expect(lineCells(l)).toBeLessThanOrEqual(ctxAt(c, r).width);
    }
    expect(text(logsView(ctxAt(100, 30), d).lines).replace(/\s+/g, ' ')).toMatch(/Nothing is recorded in this project yet\. A run fills this log: \/run <document> <block> in the REPL \(its operation, its job and its receipts appear here\)\./);
  });
});

describe('tab 0: the event log, the sequence cards and the raw output', () => {
  it('lists receipts, the operation and the job\'s events newest first, each with its time, tag and status; receipts with their place on the chain', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    const sources = new Set(d.events.map((e) => e.source));
    expect(sources).toEqual(new Set(['receipt', 'operation', 'job']));
    const times = d.events.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const wf = d.events.find((e) => e.tag === 'workflow')!;
    expect(wf.seq).toBe(4);
    expect(wf.operation).toBe(OP);
    expect(wf.status).toEqual({ word: 'sealed', tone: 'text' });
    expect(wf.raw.where).toBe(`.timmy/receipts/runs.jsonl:${lineOfReceipt(f.store, f.sealed[3].hash)}`);
    expect(JSON.parse(wf.raw.text).hash).toBe(f.sealed[3].hash);
    expect(d.events.find((e) => e.tag === 'job.end')).toMatchObject({ job: JOB, operation: OP, status: { word: 'completed' } });
    expect(d.events.find((e) => e.source === 'operation' && e.operation === OP)).toMatchObject({ summary: '/run build.md build', status: { word: 'succeeded' } });
    // the job's log: its last lines, read now
    expect(d.jobs[JOB].tail).toEqual({ lines: ['$ upmd run build.md build', '[1/2] bash fetch', `fetched ${'x'.repeat(300)} END-OF-LONG-LINE`, 'built tray.stl in 3.9 s'] });
  });

  it('the selected row has its raw line right under it, and the rows of its operation are marked as linked', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    const k = indexOf(d, (e) => e.tag === 'workflow');
    for (const [c, r] of SIZES) {
      const v = logsView(ctxAt(c, r, k), d);
      const at = v.items[k].line;
      expect(at).toBeGreaterThan(0);
      expect(plain(v.lines[at])).toContain('▸ ');
      const rows = v.items[k].rows ?? 1;
      expect(plain(v.lines[at + rows - 1])).toMatch(/raw .*\{"v":1/);
      // another row of the same operation, drawn, carries the quiet link mark
      const other = v.items.find((x, i) => i !== k && x.line >= 0 && (x.item as LogsItem).event.operation === OP);
      if (other) expect(plain(v.lines[other.line])).toMatch(/· \d\d:\d\d:\d\d/);
    }
  });

  it('the sequence: .intent and .predict amber, sandbox / run grey, .receipt green only as verifyReceiptIn confirms it now', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    const k = indexOf(d, (e) => e.tag === 'workflow');
    for (const [c, r] of SIZES) {
      const v = logsView(ctxAt(c, r, k), d);
      const all = text(v.lines);
      expect(all).toMatch(/OPERATION o1a2b3c4d/);
      expect(rolesOf(v.lines, /^\s*\.intent\s*$/)).toEqual(['action']);
      expect(rolesOf(v.lines, /^\s*\.predict\s*$/)).toEqual(['action']);
      // the run is structure: its card's title grey beside the others, its label plain in the stacked rows
      expect(rolesOf(v.lines, /^\s*sandbox \/ run\s*$/)).toEqual([c >= COLUMNS_FROM ? 'border' : 'strong']);
      expect(rolesOf(v.lines, /^\s*\.receipt\s*$/)).toEqual(['live']);
      // the request whole where its card has room for it (at 120 its card is 21 cells wide: cut, with an ellipsis)
      expect(all).toMatch(c === 120 ? /\/run build\.md…/ : /\/run build\.md build/);
      expect(all).toMatch(/sealed before/);
      expect(all).not.toMatch(/not recorded/);
      // both of its receipts say they verify; the green words are the chain's, theirs and the verified receipt's title
      expect(all.match(/✓ verified/g)?.length).toBe(2);
      for (const s of greens(v.lines)) expect(s).toMatch(/^(✓ chain verified: 5 receipts|✓ verified|\s*\.receipt\s*)$/);
    }
    expect(text(logsView(ctxAt(100, 30, k), d).lines)).toMatch(/\.predict +#\d+ sealed before the run started · ✓ verified/);
    expect(receiptVerdict(d, f.sealed[3].hash)).toEqual({ ok: true });
    expect(receiptVerdict(d, f.sealed[1].hash)).toEqual({ ok: true });
  });

  it('a step with no record says "not recorded", and a row with no operation says it has no sequence', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    const flow = indexOf(d, (e) => e.tag === 'flow');
    for (const [c, r] of SIZES) {
      const v = logsView(ctxAt(c, r, flow), d);
      const all = text(v.lines);
      expect(all).toMatch(/OPERATION o0000beef/);
      expect(rolesOf(v.lines, /^\s*\.intent\s*$/)).toEqual(['secondary']);
      expect(rolesOf(v.lines, /^\s*\.predict\s*$/)).toEqual(['secondary']);
      // its record, its prediction and its run are not recorded; its receipt is (the flow's), and verifies
      expect(all.match(/not recorded/g)?.length).toBe(3);
      expect(rolesOf(v.lines, /^\s*\.receipt\s*$/)).toEqual(['live']);
    }
    const stacked = text(logsView(ctxAt(100, 30, flow), d).lines);
    expect(stacked).toMatch(/\.intent +not recorded · no \.timmy\/operations\/o0000beef\.json in this project/);
    expect(stacked).toMatch(/\.predict +not recorded · no prediction is sealed for this operation/);
    expect(stacked).toMatch(/sandbox \/ run +not recorded · no job or run of this operation is recorded/);
    const lone = indexOf(d, (e) => e.tag === 'run');
    const w = logsView(ctxAt(100, 30, lone), d);
    expect(text(w.lines)).toMatch(/This row names no operation: there is no sequence to show\./);
    expect(text(w.lines)).toMatch(/This row names no run: there is no output to show\./);
  });

  it('the raw output: the run\'s last lines; a line longer than its column ends in an ellipsis and never wraps through the rule', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    const k = indexOf(d, (e) => e.tag === 'job.end');
    for (const [c, r] of SIZES) {
      const v = logsView(ctxAt(c, r, k), d);
      const all = text(v.lines);
      // the log's name and how many of its lines show: beside the heading where they fit, else the column's first row
      expect(all).toMatch(c === 100 ? /RAW OUTPUT · j1a2b3c\.log · last \d of 4/ : c === 160 ? /RAW OUTPUT · j1a2b3c\.log/ : /RAW OUTPUT[^\n]*\n[^\n]*│ j1a2b3c\.log/);
      expect(all).toMatch(/built tray\.stl/);
      expect(all).toMatch(/fetched x+…/);
      expect(all).not.toMatch(/END-OF-LONG-LINE/);
      // no row starts with the cut line's rest
      for (const l of v.lines) expect(plain(l)).not.toMatch(/(^|│ )x{10,}/);
    }
  });
});

describe('tab 0: the layout at 160x45, 120x40 and 100x30', () => {
  it('three columns side by side from 120 columns, stacked below; no line longer than its box at any size or selection', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    for (const [c, r] of SIZES) {
      const { width, height } = bodyAt(c, r);
      for (let k = 0; k < d.events.length; k++) {
        const v = logsView(ctxAt(c, r, k), d);
        expect(v.lines.length).toBeLessThanOrEqual(height);
        for (const l of v.lines) expect(lineCells(l)).toBeLessThanOrEqual(width);
        // the items are the log's rows, in its order, at every size; the selected one is drawn
        expect(v.items.map((x) => x.item.key)).toEqual(d.events.map((e) => `log:${e.key}`));
        expect(v.items[k].line).toBeGreaterThanOrEqual(0);
        const head = v.lines.findIndex((l) => /EVENT LOG/.test(plain(l)));
        if (c >= COLUMNS_FROM) {
          expect(plain(v.lines[head])).toMatch(/EVENT LOG.*│ OPERATION.*│ RAW OUTPUT/);
          expect(v.lines.slice(head).every((l) => (plain(l).match(/│/g) ?? []).length >= 2)).toBe(true);
        } else {
          expect(plain(v.lines[head])).not.toMatch(/│/);
          const op = v.lines.findIndex((l) => /^OPERATION/.test(plain(l)));
          const raw = v.lines.findIndex((l) => /^RAW OUTPUT/.test(plain(l)));
          expect(head).toBeLessThan(op);
          expect(op).toBeLessThan(raw);
        }
      }
    }
  });

  it('the body\'s own width decides when the terminal\'s is not given (Context beside it at 120 leaves 70 cells)', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    const wide = logsView({ ui: { cursor: {} }, g, width: 70, height: 23, now: Date.now() }, d);
    expect(text(wide.lines)).toMatch(/EVENT LOG.*│ OPERATION/);
    const narrow = logsView({ ui: { cursor: {} }, g, width: 60, height: 23, now: Date.now() }, d);
    expect(text(narrow.lines)).not.toMatch(/EVENT LOG.*│/);
  });

  it('ASCII glyphs: the same rows without box-drawing characters, and still within the width', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    const a = glyphsFor(false);
    for (const [c, r] of SIZES) {
      const v = logsView({ ...ctxAt(c, r, indexOf(d, (e) => e.tag === 'workflow')), g: a }, d);
      for (const l of v.lines) {
        expect(lineCells(l)).toBeLessThanOrEqual(bodyAt(c, r).width);
        expect(plain(l)).not.toMatch(/[│╭╮╰╯┏┓┗┛━┃✓✕▸…]/);
      }
      expect(plain(v.lines[0])).toMatch(/^\+ chain verified: 5 receipts/);
    }
  });
});

describe('tab 0: the Inspector and the reading', () => {
  it('a receipt, an operation and a job\'s event each have a detail with every field and the raw line whole', () => {
    const f = fixture();
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    const v = logsView(ctxAt(160, 45), d);
    const kinds = new Set(v.items.map((x) => x.item.kind));
    expect(kinds).toEqual(new Set(['log-receipt', 'log-op', 'log-event']));
    const receipt = v.items.find((x) => x.item.kind === 'log-receipt' && x.item.event.tag === 'workflow')!.item;
    const r = logsDetail(receipt, d, 40, g);
    for (const l of r) expect(lineCells(l)).toBeLessThanOrEqual(40);
    const flat = (lines: readonly Line[]): string => text(lines).replace(/\s+/g, ' ');
    expect(text(r)).toMatch(/RECEIPT/);
    expect(text(r)).toMatch(/Place\s+#4 on the chain/);
    expect(text(r)).toMatch(/Operation\s+o1a2b3c4d/);
    expect(flat(r)).toMatch(/Signed yes: an ed25519 signature is on it/);
    expect(rolesOf(r, /✓ verified/)).toEqual(['live']);
    expect(flat(r)).toMatch(/against this reading's chain \(verifyReceiptIn\)/);
    expect(text(r)).toMatch(new RegExp(`RAW · \\.timmy/receipts/runs\\.jsonl:${lineOfReceipt(f.store, f.sealed[3].hash)}`));
    // the raw line whole (wrapped, never cut): every part of its hash is there
    expect(text(r).replace(/\s+/g, '')).toContain(f.sealed[3].hash);
    const op = logsDetail(v.items.find((x) => x.item.kind === 'log-op' && x.item.event.operation === OP)!.item, d, 40, g);
    expect(text(op)).toMatch(/OPERATION/);
    expect(text(op)).toMatch(/Request\s+\/run build\.md build/);
    expect(text(op)).toMatch(/Runs\s+job j1a2b3c/);
    expect(text(op)).toMatch(/Receipts\s+3/);
    const ev = logsDetail(v.items.find((x) => x.item.kind === 'log-event' && x.item.event.tag === 'job.end')!.item, d, 40, g);
    expect(text(ev)).toMatch(/EVENT/);
    expect(text(ev)).toMatch(/Job\s+j1a2b3c/);
    expect(text(ev)).toMatch(/RAW · .*j1a2b3c\.json/);
    for (const lines of [r, op, ev]) expect(greens(lines).every((s) => /✓ verified/.test(s))).toBe(true);
  });

  it('reads only: nothing in the project or the Timmy home is written or changed by a reading or a drawing', () => {
    const f = fixture();
    const before = manifest(f.root, f.home);
    const d = readLogs({ home: f.home, root: f.root, env: env() });
    for (const [c, r] of SIZES) for (let k = 0; k < d.events.length; k++) logsView(ctxAt(c, r, k), d);
    expect(manifest(f.root, f.home)).toBe(before);
  });
});
