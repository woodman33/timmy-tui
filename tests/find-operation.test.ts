/**
 * Round R4 (H99, gap 4): the operation is easy to find. On the Mac (r24) plain /op showed only the newest, Timmy Studio never
 * showed the id, and the compact /overview cut it off. Here: the first screen keeps every operation id whole (the words around
 * it are shortened instead) and names the newest request with its /op command; /room and /overview end with the live board's
 * address of their section while a board runs, else with what starts one. (/run's own start and end lines naming the
 * operation are held in tests/no-change-run.test.ts.)
 *
 * FAKE pieces, each labelled: the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE as Qwen Code on a local
 * endpoint) and OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE with no geometry engine), through the REPL's own
 * Workspace in a temporary project (tests/helpers/ops-sandbox.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildOverview } from '../src/overview/index.js';
import { cut, cutKeepingIds, fitHeadAndItem, overviewFirstLines } from '../src/repl/overview.js';
import { glyphSet } from '../src/term/glyphs.js';
import { opsKit, replOf, sandbox as opsSandbox, text } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

describe('an operation id is never cut off', () => {
  const long = 'operation o1a2b3c4d changed 1 file: /iterate scad box.scad "make it a good deal wider than it is now"';
  it('the words around an id are shortened, never the id (the old cut lost it)', () => {
    expect(cut(`3 app runs, 5 files (2 editable), 1 change to review · ${long}`, 66)).not.toContain('o1a2b3c4d'); // before
    const kept = cutKeepingIds(`3 app runs, 5 files (2 editable), 1 change to review · ${long}`, 66);
    expect(kept).toContain('o1a2b3c4d');
    expect(Array.from(kept).length).toBeLessThanOrEqual(66);
    expect(kept).toContain('…');
  });
  it('a text that fits is kept as it is; two ids both stay; ids alone that do not fit are kept and the rest dropped', () => {
    expect(cutKeepingIds('operation o1a2b3c4d', 66)).toBe('operation o1a2b3c4d');
    const two = cutKeepingIds(`first o11111111 then a long middle part that will not fit at all, then o22222222 and the end of it`, 40);
    expect(two).toContain('o11111111');
    expect(two).toContain('o22222222');
    expect(Array.from(two).length).toBeLessThanOrEqual(40);
    expect(cutKeepingIds('a o11111111 b o22222222 c', 10)).toBe('o11111111 o22222222');
    expect(cutKeepingIds('words without an id that go on and on', 12)).toBe('words witho…');
  });
});

// R4 (H99, the review of the H99 work, finding 2): a head that fits but does not fit with its urgent item cut the item inside
// its id ("…14 changes to reviewa2b3c4d", heads of 57 to 66 columns at width 80)
describe('a section\'s head and its urgent item keep every operation id whole at every width', () => {
  const ITEM = 'operation o1a2b3c4d changed 3 files: /iterate scad box.scad "make it a good deal wider than it is now"';
  const heads = Array.from({ length: 12 }, (_, i) => `112 app runs, 131 files (18 editable), 14 changes to review${'.'.repeat(i)}`.slice(0, 55 + i));
  const ID = /\bo1a2b3c4d\b/;

  it('the review\'s line (width 80): the head gives way, the item keeps its id whole after the separator', () => {
    const head = '112 app runs, 131 files (18 editable), 14 changes to review';
    const fit = fitHeadAndItem(head, ITEM, ' · ', 66);
    expect(fit.item).toMatch(/^ · /);
    expect(`${fit.head}${fit.item}`).toMatch(ID);
    expect(`${fit.head}${fit.item}`).not.toContain('reviewa2b3c4d');
    expect(Array.from(`${fit.head}${fit.item}`).length).toBeLessThanOrEqual(66);
    expect(head.startsWith(fit.head.replace(/…$/, ''))).toBe(true);
  });

  it('every head of 55 to 66 columns at every width from 60 to 120: within the width, the id whole, the head a cut of itself', () => {
    for (const head of heads) {
      for (let w = 60; w <= 120; w++) {
        const room = w - 14;
        const fit = fitHeadAndItem(head, ITEM, ' · ', room);
        const line = `${fit.head}${fit.item}`;
        expect(Array.from(line).length, `${w}: ${line}`).toBeLessThanOrEqual(room);
        expect(line, `${w}: ${line}`).toMatch(ID);
        expect(line, `${w}: ${line}`).not.toMatch(/[^\s]o?[0-9a-f]{0,7}o1a2b3c4d|o1a2b3c4d[0-9a-f]/);
        expect(head.startsWith(fit.head.replace(/…$/, '')), `${w}: ${fit.head}`).toBe(true);
        expect(fit.item.startsWith(' · '), `${w}: ${fit.item}`).toBe(true);
      }
    }
  });

  it('on the first screen itself (overviewFirstLines), the Apps line at widths 60 to 120', () => {
    const s = opsSandbox(kit, 'find-op-fit-');
    const o = buildOverview(s.root, { name: 'project', jobsDir: path.join(s.home, 'timmy', 'jobs'), store: path.join(s.root, '.timmy', 'receipts'), env: { TIMMY_HOME: path.join(s.home, 'timmy') } });
    for (const head of heads) {
      const shown = structuredClone(o);
      shown.apps.summary = head;
      shown.apps.urgent = { text: ITEM, tone: 'attention', source: { record: null, command: '/review o1a2b3c4d', board: 'review' } };
      for (let w = 60; w <= 120; w++) {
        const lines = text(overviewFirstLines(shown, { glyphs: glyphSet(true), width: w })).split('\n');
        const apps = lines.find((l) => /^ {2}Apps /.test(l))!;
        expect(Array.from(apps).length, `${w}: ${apps}`).toBeLessThanOrEqual(w);
        expect(apps, `${w}: ${apps}`).toMatch(ID);
        expect(apps, `${w}: ${apps}`).not.toMatch(/\bo[0-9a-f]{1,7}…|[a-z]a2b3c4d/);
      }
    }
  });
});

describe('/overview and /room say where their operations are, and where the board shows them (FAKE agent and OpenSCAD)', () => {
  it('the first screen names the newest request whole with /op; /room and /overview end with the board\'s section, or with /board live', async () => {
    const s = opsSandbox(kit, 'find-op-');
    const { ws } = replOf(kit, s);
    const out = text(await ws.operate('/iterate scad box.scad "make it a good deal wider than it is now PYFILE:box.params.json PYREPLACE:60,=>100,"', 'repl', () => ws.iterate('scad box.scad "make it a good deal wider than it is now PYFILE:box.params.json PYREPLACE:60,=>100,"')));
    const h = ws.ops.latest!;
    expect(out).toMatch(/Flow\s+f[0-9a-f]{8}/);
    await ws.ops.done(h);
    expect(h.ended?.state).toBe('succeeded');

    // The first screen: every line within 80 columns; the newest request with its id whole and its /op command
    const first = text(await ws.overview(''));
    const lines = first.split('\n');
    for (const l of lines) expect(Array.from(l).length, l).toBeLessThanOrEqual(80);
    expect(first).toMatch(new RegExp(`Request +${h.id} succeeded`));
    expect(first).toContain(`/op ${h.id}`);
    // the Apps line's result to review names the operation: its id stays whole however long the request
    const apps = lines.find((l) => /^ {2}Apps /.test(l))!;
    expect(apps, first).toContain(h.id);
    // no operation id on the first screen is cut short
    expect(first).not.toMatch(/\bo[0-9a-f]{1,7}…/);
    // no board runs: each view says what starts one
    expect(lines.at(-1)).toMatch(/^ {2}Board +\/board live shows it in your browser$/);
    expect(text(await ws.overview('--all')).split('\n').at(-1)).toBe('  On the board  /board live shows it in your browser');
    expect(text(await ws.room('')).split('\n').at(-1)).toBe('  On the board  /board live shows it in your browser');

    // With the live board running: the address of each view's section (no token in it)
    text(await ws.boardLive('live'));
    const live = ws.liveBoard!;
    expect(live.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const room = text(await ws.room('')).split('\n').at(-1)!;
    expect(room).toContain(`On the board  ${live.address}#room`);
    expect(room).not.toMatch(/#t=|[0-9a-f]{64}/);
    expect(text(await ws.overview('')).split('\n').at(-1)).toMatch(new RegExp(`^ {2}Board +${live.address.replace(/[.]/g, '\\.')}#overview$`));
    expect(text(await ws.overview('agents')).split('\n').at(-1)).toContain(`${live.address}#overview`);
    const flow = /Flow\s+(f[0-9a-f]{8})/.exec(out)![1];
    const one = text(await ws.room(flow)).split('\n').at(-1)!;
    expect(one).toContain(`${live.address}#room`);
    await ws.boardLive('off');
    expect(text(await ws.room('')).split('\n').at(-1)).toBe('  On the board  /board live shows it in your browser');
  }, 120_000);
});
