// R10 (H167): the journey's first screens in the terminal Workbench (src/workbench/home-journey.ts): the header (the project,
// the route the next turn takes, what runs and waits, the ten tabs on one row), Home's recent work and the selected item, the
// words without ids or hashes, and the details the inspector keeps. Pure functions over hand-made Data: FAKE records, no
// project on disk, nothing run.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABS } from '../src/contracts/workspace.js';
import { glyphsFor } from '../src/workbench/frame.js';
import type { BuildInfo } from '../src/build-info.js';
import { openTarget, type JourneyRoute, type RecentWork, type WorkItem as JourneyWorkItem } from '../src/journey/index.js';
import { diagnosticsLines, headerRows, homeSideView, homeWorkView, plainWords, recentWork, routeLine, selectedWork, workDetail } from '../src/workbench/home-journey.js';
import type { Data, Ui } from '../src/workbench/model.js';
import type { JobRow } from '../src/workbench/state.js';
import { lineCells, plain } from '../src/workbench/text.js';

const g = glyphsFor(true);
const NOW = Date.parse('2026-10-22T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function job(o: Partial<JobRow> & Pick<JobRow, 'id' | 'label'>): JobRow {
  return {
    project: 'tray', root: '/p/tray', kind: 'workflow', state: 'completed', mark: 'ok', word: 'completed', why: '', outcome: { state: 'succeeded', words: 'succeeded' },
    live: false, stale: false, startedAt: iso(10), endedAt: iso(10), elapsedMs: 200, elapsed: '0.2 s', owner: 'repl', ownerWords: 'the REPL', steps: [{ name: 'report', state: 'completed', code: 0 }], ...o,
  } as JobRow;
}


function data(o: Partial<Data> = {}): Data {
  return {
    project: { name: 'tray', root: '/p/tray', id: 'p1', shown: '~/timmy/projects/tray' },
    projects: [], files: { total: 0, truncated: false, groups: [] }, workflows: { docs: [], upmd: true },
    jobs: [], decisions: { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [] },
    route: { kind: 'local', words: 'chat: local qwen3:8b · Ollama', ready: true },
    activity: { running: 0, waiting: 0, events: [] }, chat: { session: null, total: 0, messages: [] }, vox: [], native: {}, starters: [], boards: [],
    studio: { state: 'idle' }, overview: { state: 'idle' }, caps: { state: 'idle' }, details: {}, readAt: NOW, away: [],
    ...o,
  } as unknown as Data;
}

function ui(o: Partial<Ui> = {}): Ui {
  return { page: 'home', workspace: 'connections', focus: 'center', tab: 'inspector', cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, input: { field: null, text: '' }, companion: { serving: false, address: null, last: null }, studio: { serving: false, address: null, last: null }, ...o } as unknown as Ui;
}

const ctx = (d: Data, u: Ui = ui(), width = 60) => ({ ui: u, data: d, g, width, height: 30, now: NOW, can: { chat: true } });
const text = (lines: ReturnType<typeof homeWorkView>['lines']) => lines.map(plain).join('\n');
/** the rows' words as one line (a wrapped sentence read whole) */
const flat = (lines: ReturnType<typeof homeWorkView>['lines']) => lines.map(plain).join(' ').replace(/\s+/g, ' ');

describe('the route the next chat turn takes (R10 H167)', () => {
  it('says the model, where it runs and its price; a local model on this computer is no charge; FAKE when the model says so; not ready says why', () => {
    expect(routeLine(data())).toMatchObject({ model: 'qwen3:8b', where: 'this computer (Ollama)', price: 'no charge', fake: false, ready: true });
    expect(routeLine(data({ route: { kind: 'local', words: 'chat: local fake-model:1b · Ollama', ready: true } }))).toMatchObject({ model: 'fake-model:1b', fake: true });
    expect(routeLine(data({ route: { kind: 'local', words: 'chat: local · no model chosen · /model', ready: false } }))).toMatchObject({ model: null, ready: false, why: 'no local model chosen yet' });
    expect(routeLine(data({ route: { kind: 'local', words: 'chat: gpt-oss:120b-cloud · Ollama, cloud-backed', ready: true } }))).toMatchObject({ model: 'gpt-oss:120b-cloud', where: 'Ollama, cloud-backed (leaves this computer)', price: 'cost unknown' });
    expect(routeLine(data({ route: { kind: 'openrouter', words: 'chat: qwen/qwen3-coder:free · OpenRouter · free-only', ready: true } }))).toMatchObject({ model: 'qwen/qwen3-coder:free', where: 'OpenRouter (cloud)', price: 'free (as OpenRouter lists it)' });
    expect(routeLine(data({ route: { kind: 'none', words: 'chat: no model key · /setup', ready: false } }))).toMatchObject({ model: null, ready: false, why: 'no model key and no local model' });
  });
});

describe('the route from H164\'s routeNow (R10 H167)', () => {
  const j = (o: Partial<JourneyRoute>): JourneyRoute => ({ provider: 'ollama', model: 'qwen3:8b', where: 'this computer', price: { state: 'unknown', words: 'no price declared' }, fake: false, ready: true, words: 'chat: local qwen3:8b · Ollama', surface: 'workbench', tools: 'gated', details: { keyFrom: null, freeOnly: false }, ...o } as JourneyRoute);
  it('the model, where it runs and its price as declared (a local model\'s is not declared before its turn); FAKE as it says; not ready with why', () => {
    expect(routeLine(data({ journeyRoute: j({}) }))).toMatchObject({ model: 'qwen3:8b', where: 'this computer (Ollama)', price: 'no price declared (local)', fake: false, ready: true });
    expect(routeLine(data({ journeyRoute: j({ provider: 'openrouter', model: 'qwen/qwen3-coder:free', where: 'cloud', price: { state: 'declared', free: true, words: 'free' } }) }))).toMatchObject({ where: 'OpenRouter (cloud)', price: 'free (declared)' });
    expect(routeLine(data({ journeyRoute: j({ provider: 'fake', model: 'fake-chat:1b', fake: true, fakeWhy: 'declared' }) }))).toMatchObject({ fake: true, price: 'no price (FAKE)' });
    expect(routeLine(data({ journeyRoute: j({ provider: 'none', model: null, where: null, ready: false, why: 'no model key, and the chat is not set to the local model' }) }))).toMatchObject({ model: null, ready: false, why: 'no model key, and the chat is not set to the local model' });
    // the open chat session's own route, when it says another than routeNow read (a test's FIXTURE session), is the turn's
    expect(routeLine(data({ journeyRoute: j({}), chatRoute: { kind: 'local', words: 'chat: FIXTURE route', ready: true } }))).toMatchObject({ model: 'FIXTURE route', fake: true });
  });
});

describe('the header (R10 H167): two rows, exactly the width, the tabs in their places', () => {
  it('row 1 says TIMMY, the project, the route and what runs and waits; row 2 the ten tabs, the active one bracketed, ◌ said in words', () => {
    for (const width of [180, 160, 122, 100]) {
      const h = headerRows(data(), 'home', width, g);
      expect(h.lines).toHaveLength(2);
      for (const l of h.lines) expect(lineCells(l), `${width}`).toBe(width);
      const [status, tabs] = h.lines.map(plain);
      // (from 122 columns the route is whole; narrower, it is cut at a word, and what runs and waits stays whole)
      if (width >= 122) expect(status).toMatch(/^TIMMY · tray {3}next turn: qwen3:8b · this computer \(Ollama\) · no charge/);
      else expect(status).toMatch(/^TIMMY · tray {3}next turn: qwen3:8b/);
      expect(status).toMatch(/nothing runs · nothing waits on you$/);
      expect(tabs).toMatch(/^\[1[^\]]*\]/);
      expect(tabs.match(/\[/g) ?? [], `one active tab at ${width}`).toHaveLength(1);
      expect(h.hits.map((x) => x.page)).toEqual(TABS.map((t) => t.id));
    }
    // short labels at 122 (the operator's size), whole labels from 180, keys and the active tab's name at 100
    expect(plain(headerRows(data(), 'home', 122, g).lines[1])).toMatch(/\[1 Home\] +2 Chat +3 Workflows/);
    expect(plain(headerRows(data(), 'chat', 180, g).lines[1])).toContain('[2 Chat & Intent]');
  });

  it('every tab keeps its cells whichever tab is active and whatever waits; what waits is ⚠ on its tab and the count on row 1', () => {
    for (const width of [180, 160, 122, 100]) {
      let first = '';
      for (const active of TABS.map((t) => t.id)) {
        for (const waiting of [0, 3]) {
          const frame = { project: { id: 'p1' }, activity: { chatTurn: null }, connections: [], log: [], tabs: TABS.map((t) => ({ id: t.id, key: t.key, label: t.label, refs: t.refs, waiting: t.id === 'control' || t.id === 'home' ? waiting : 0, ...(t.unfinished ? { unfinished: t.unfinished } : {}) })) };
          const d = data({ frame: frame as unknown as Data['frame'], decisions: { items: [], more: 0, total: waiting, otherSetup: 0, tools: {}, operations: {}, notes: [] } as unknown as Data['decisions'] });
          const h = headerRows(d, active, width, g);
          const cells = JSON.stringify(h.hits.map((x) => [x.x0, x.x1]));
          first ||= cells;
          expect(cells, `${width}, ${active}, ${waiting}`).toBe(first);
          if (waiting) {
            expect(plain(h.lines[0])).toContain('⚠ 3 waiting on you');
            const home = h.hits[0];
            expect([...plain(h.lines[1])].slice(home.x0, home.x1 + 1).join('')).toContain('⚠');
          }
        }
      }
    }
  });

  it('a route that is not ready is said in amber with why; a FAKE model is named FAKE on row 1', () => {
    const notReady = headerRows(data({ route: { kind: 'local', words: 'chat: local · no model chosen · /model', ready: false } }), 'home', 122, g).lines[0];
    expect(plain(notReady)).toContain('next turn: no local model chosen yet');
    expect(notReady.find((s) => s.text.includes('no local model chosen yet'))?.role).toBe('attention');
    expect(plain(headerRows(data({ route: { kind: 'local', words: 'chat: local fake-qwen:1b · Ollama', ready: true } }), 'home', 122, g).lines[0])).toContain('next turn: FAKE fake-qwen:1b');
  });
});

describe('Home\'s recent work (R10 H167): H164\'s recentWork, as Home draws it', () => {
  // FAKE: recent work as H164's src/journey recentWork returns it (its open targets made by its openTarget)
  const item = (o: Partial<JourneyWorkItem> & Pick<JourneyWorkItem, 'kind' | 'id' | 'title' | 'state'>, minAgo: number): JourneyWorkItem => ({
    when: iso(minAgo), receipt: null, fake: false, open: openTarget({ kind: o.kind, id: o.id, operation: o.operation ?? null }), ...o,
  } as JourneyWorkItem);
  const recent: RecentWork = { project: { name: 'tray', id: 'p1' }, notes: [], items: [
    item({ kind: 'turn', id: 'd2d756db', title: 'Summarise the report run in one line.', state: 'answered', operation: 'oc372c7b3', receipt: { id: 'd2d756db', verified: true }, route: { provider: 'ollama', requested: 'qwen3:8b', answeredBy: 'qwen3:8b', where: 'this computer', fallback: false, fake: false, surface: 'workbench' } }, 1),
    item({ kind: 'mesh', id: 'refs/demo-tray.stl', title: 'refs/demo-tray.stl', state: 'saved' }, 2),
    item({ kind: 'run', id: 'o92079bb4', title: 'Workflow run: report in REPORT.md', state: 'completed', operation: 'o92079bb4', receipt: { id: 'f7a8f9c4', verified: true }, results: ['out/report.md', 'out/preview.png'] }, 9),
    item({ kind: 'observation', id: 'v8764e36c', title: 'detect refs/preview.png', state: 'completed', operation: 'o22357763', receipt: { id: '41d8cb07', verified: false, why: 'it is not on the chain' } }, 12),
    item({ kind: 'reference', id: 'refs/preview.png', title: 'refs/preview.png', state: 'saved' }, 13),
    item({ kind: 'result', id: 'out/notes.txt', title: 'out/notes.txt', state: 'saved' }, 14),
    item({ kind: 'draft', id: 'draft-0a1b2c3d', title: 'A draft Timmy proposed', state: 'draft' }, 15),
  ] };
  const d = data({
    recent,
    jobs: [job({ id: 'j5c4706', label: 'REPORT.md › report', operation: 'o92079bb4', receipt: 'f7a8f9c4' })],
    workflows: { docs: [{ rel: 'REPORT.md', title: 'Report (review demo)', blocks: [{ key: '1', name: 'report' }] }], upmd: true } as unknown as Data['workflows'],
    files: { total: 7, truncated: false, groups: [] } as unknown as Data['files'],
  });

  it('what waits on you first, then H164\'s items in its order, each with its words, its state and its receipt as verified there', () => {
    const waiting = data({ ...d, decisions: { items: [
      { key: 'approval:j1', kind: 'approval', blocks: true, title: 'A NEEDS YOU box waits: tidy', needed: 'allow or deny it', why: 'its box', commands: [] },
      { key: 'draft:j1', kind: 'approval', blocks: false, title: 'A draft waits', needed: 'Accept or Discard it', why: 'its board', commands: [] },
    ], more: 0, total: 2 } as unknown as Data['decisions'] });
    const work = recentWork(waiting, 40, NOW);
    // (a Studio draft is H164's own item: not listed twice)
    expect(work.map((w) => [w.kind, w.title])).toEqual([
      ['waiting', 'A NEEDS YOU box waits: tidy'],
      ['turn', 'Summarise the report run in one line.'],
      ['mesh', 'demo-tray.stl'],
      ['run', 'Workflow run: report in REPORT.md'],
      ['observation', 'detect preview.png'],
      ['reference', 'preview.png'],
      ['result', 'notes.txt'],
      ['draft', 'A draft Timmy proposed'],
    ]);
    expect(work.find((w) => w.kind === 'run')).toMatchObject({ state: 'completed', tone: 'ok', receipt: { sealed: true, verified: true }, facts: ['2 files written'] });
    expect(work.find((w) => w.kind === 'observation')!.receipt).toMatchObject({ verified: false, why: 'it is not on the chain' });
    expect(work.find((w) => w.kind === 'turn')!.facts).toEqual(['qwen3:8b', 'this computer']);
  });

  it('Enter opens each where it belongs here (a run on 3 with its block selected, an observation on 5, a mesh on 6, a draft on 4, an image in the companion); c opens H164\'s companion address', () => {
    const work = recentWork(d, 40, NOW);
    const by = (k: string) => work.find((w) => w.kind === k)!.opens;
    expect(by('run')).toMatchObject({ page: 'workflows', select: { list: 'center:workflows', key: 'block:REPORT.md:1' }, companion: 'tab=workflows&run=o92079bb4' });
    expect(by('observation')).toMatchObject({ page: 'voxvision', select: { list: 'center:voxvision', key: 'vox:v8764e36c' }, companion: 'tab=voxvision&vox=v8764e36c' });
    expect(by('mesh')).toMatchObject({ page: 'create', select: { list: 'center:create3d', key: 'mesh:refs/demo-tray.stl' }, companion: `tab=create&mesh=${Buffer.from('refs/demo-tray.stl').toString('hex')}` });
    expect(by('turn')).toMatchObject({ page: 'chat', companion: 'tab=chat&receipt=d2d756db' });
    expect(by('reference')).toMatchObject({ show: true, companion: `tab=home&file=${Buffer.from('refs/preview.png').toString('hex')}` });
    expect(by('result')).toMatchObject({ page: 'logs', ws: 'files', select: { list: 'center:files', key: 'file:out/notes.txt' } });
    expect(by('draft')).toMatchObject({ page: 'studio', studio: true, companion: '' });
  });

  it('the list draws a glyph, a few words, the kind and state, and when; no id, hash, path or command', () => {
    const v = homeWorkView(ctx(d, ui(), 70));
    const t = text(v.lines);
    expect(v.items.filter((x) => x.item.kind === 'work')).toHaveLength(7);
    expect(t).toMatch(/▸ ✓ Summarise the report run in one… +chat · answered +1 min ago/);
    expect(t).toMatch(/✓ detect preview\.png +VoxVision · completed +12 min ago/);
    expect(t).toMatch(/✓ Workflow run: report in REPORT\.md +run · completed +9 min ago/);
    expect(t).not.toMatch(/\bj[0-9a-f]{6}\b|\bo[0-9a-f]{8}\b|\b[0-9a-f]{8}\b|refs\/|out\/|\/run /);
  });

  it('the selected item: its kind and state, when, its receipt (verified as H164 checked it), where Enter and c open it', () => {
    const run = ui({ cursor: { 'center:connections': 2 } });
    expect(selectedWork({ ui: run, data: d, now: NOW })?.kind).toBe('run');
    const side = flat(homeSideView(ctx(d, run, 50)).lines);
    expect(side).toContain('RUN · ✓ completed');
    expect(side).toContain('Workflow run: report in REPORT.md');
    expect(side).toMatch(/Receipt ✓ sealed and verified/);
    expect(side).toMatch(/\[Enter\] opens its progress, result and receipt in 3 Workflows/);
    expect(side).toMatch(/\[c\] the companion: its source, changes, outputs and receipts, drawn/);
    expect(side).toMatch(/PROJECT 7 files · 1 workflow document · 1 job/);
    expect(side).not.toMatch(/f7a8f9c4|o92079bb4|j5c4706/);
    const seal = homeSideView(ctx(d, run, 50)).lines.flat().find((s) => s.text.includes('sealed and verified'));
    expect(seal?.role).toBe('live');
    // one that does not verify says so, amber with ✕
    const obs = flat(homeSideView(ctx(d, ui({ cursor: { 'center:connections': 3 } }), 50)).lines);
    expect(obs).toMatch(/Receipt ✕ sealed, does not verify/);
  });

  it('the connections follow recent work in the same list, a row each (mark and word, no address); selected, its words and what Enter does, its address left to the details', () => {
    const frame = { project: { id: 'p1' }, activity: { chatTurn: null }, log: [], tabs: [], connections: [
      { id: 'ollama', label: 'Ollama (local models)', state: 'live', words: 'answered at http://127.0.0.1:40623 with 1 model', observedAt: iso(3), setup: 'timmy workspace check' },
      { id: 'openrouter', label: 'OpenRouter (cloud chat)', state: 'not set up', words: 'no key: timmy init --chat openrouter asks for it', observedAt: null, setup: 'timmy init --chat openrouter' },
    ] } as unknown as Data['frame'];
    const withConns = data({ ...d, frame });
    const v = homeWorkView(ctx(withConns, ui(), 70));
    expect(v.items.map((x) => x.item.key).slice(-2)).toEqual(['conn:ollama', 'conn:openrouter']);
    const t = text(v.lines);
    expect(t).toMatch(/CONNECTIONS/);
    expect(t).toMatch(/Ollama +● live {2}· checked/);
    expect(t).toMatch(/OpenRouter +· not set up/);
    expect(t).not.toContain('127.0.0.1');
    const onOllama = ui({ cursor: { 'center:connections': 7 } });
    const side = flat(homeSideView(ctx(withConns, onOllama, 50), () => 'checks the connections from here').lines);
    expect(side).toMatch(/CONNECTION · ● live Ollama \(local models\) answered at its address with 1 model/);
    expect(side).toMatch(/\[Enter\] checks the connections from here/);
    expect(side).not.toContain('127.0.0.1');
  });

  it('an empty project says so and what starts it', () => {
    const v = homeWorkView(ctx(data()));
    expect(v.items).toHaveLength(0);
    expect(text(v.lines)).toContain('Nothing here yet');
    expect(flat(v.lines)).toMatch(/Enter on the next step above types your first message/);
  });

  it('the details (the inspector) keep the ids, the receipt and the files; About says the build as H163\'s buildInfo read it', () => {
    const run = recentWork(d, 40, NOW).find((w) => w.kind === 'run')!;
    const det = workDetail(run, 60, g).map(plain).join('\n');
    expect(det).toMatch(/Id +o92079bb4/);
    expect(det).toMatch(/Receipt +f7a8f9c4 \(verified here now\)/);
    expect(det).toMatch(/Results +out\/report\.md, out\/preview\.png/);
    const build = { version: '1.0.8', revision: { full: 'd59244f0', short: 'd59244f' }, revisionFrom: 'git, read from the checkout this runs from', dirty: false, branch: 'r10/h167-ui', builtAt: null, source: 'dev', node: { version: 'v24.21.0', path: '/x/node' }, timmyHome: join(homedir(), 'timmy'), ports: { studio: 4460, logs: 4461, companion: 4462 }, reviewPackage: null, mismatch: null } as BuildInfo;
    const about = diagnosticsLines({ data: data({ build }), g, width: 70 }).map(plain).join('\n');
    expect(about).toMatch(/Version +1\.0\.8/);
    expect(about).toMatch(/Revision +d59244f/);
    expect(about).toMatch(/From +source · git, read from the checkout this runs from/);
    expect(about).toMatch(/Timmy home ~\/timmy/);
    expect(about).toMatch(/Ports +companion 4462, Studio 4460, log 4461/);
    expect(diagnosticsLines({ data: d, g, width: 60 }).map(plain).join('\n')).toMatch(/Revision +not read yet/);
  });
});

describe('plain words (R10 H167): ids and hashes said by what they name', () => {
  it('a job by its label, once; a receipt as sealed; an operation left out; a /run request as the run it asks for', () => {
    const d = data({ jobs: [job({ id: 'j5c4706', label: 'REPORT.md › report' })] });
    expect(plainWords('j5c4706 started: REPORT.md › report', d)).toBe('started: REPORT.md › report');
    expect(plainWords('j5c4706 report completed (exit 0)', d)).toBe('REPORT.md › report: report completed (exit 0)');
    expect(plainWords('turn answered in the REPL · qwen3:8b · receipt 43881339 · 2.2 s', d)).toBe('turn answered in the REPL · qwen3:8b · receipt sealed · 2.2 s');
    expect(plainWords('sealed before it ran (38a7a98d)', d)).toBe('sealed before it ran');
    expect(plainWords('sealed fb72a565 · verified here', d)).toBe('sealed · verified here');
    expect(plainWords('/run LONG.md wait', d)).toBe('run LONG.md › wait');
    expect(plainWords('done · operation o92079bb4', d)).toBe('done');
    // the REPL's end lines (src/repl/end-lines.ts): the operation after the word and the /op at the end are the details'
    expect(plainWords('  ✓ j5c4706 completed  operation o92079bb4 · REPORT.md › report · 1 of 1 steps · 0.2 s · prediction met · receipt f7a8f9c4 · /op o92079bb4', d))
      .toBe('✓ REPORT.md › report completed · 1 of 1 steps · 0.2 s · prediction met · receipt sealed');
    expect(plainWords('  ✕ j5c4706 failed  operation o92079bb4 · REPORT.md › report: exit 2 · /jobs j5c4706 shows its output · /op o92079bb4', d))
      .toBe('✕ REPORT.md › report failed · REPORT.md › report: exit 2 · 0 Logs shows its output');
  });
});
