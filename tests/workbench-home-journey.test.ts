// R10 (H167): the journey's first screens in the terminal Workbench (src/workbench/home-journey.ts): the header (the project,
// the route the next turn takes, what runs and waits, the ten tabs on one row), Home's recent work and the selected item, the
// words without ids or hashes, and the details the inspector keeps. Pure functions over hand-made Data: FAKE records, no
// project on disk, nothing run.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABS } from '../src/contracts/workspace.js';
import { glyphsFor } from '../src/workbench/frame.js';
import type { BuildInfo } from '../src/build-info.js';
import { openTarget, type JourneyRoute, type RecentWork, type WorkItem as JourneyWorkItem } from '../src/journey/index.js';
import { companionWhat, diagnosticsLines, fileWhat, handoffWords, headerRows, homeConnections, homeSideView, homeWorkView, inWords, plainWords, recentWork, representation, routeLine, selectedWork, workDetail } from '../src/workbench/home-journey.js';
import { layoutFor } from '../src/workbench/layout.js';
import type { Data, Ui } from '../src/workbench/model.js';
import { bottomView, pageActions } from '../src/workbench/views.js';
import { blockKey } from '../src/workbench/workflows-tab.js';
import { routeOf } from '../src/workbench/hub.js';
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
    // (R10 H163; H168's N1: a local route's price is said one way, "no charge · local"; its long forms are the details')
    expect(routeLine(data())).toMatchObject({ model: 'qwen3:8b', where: 'this computer (Ollama)', price: 'no charge · local', fake: false, ready: true });
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
    expect(routeLine(data({ journeyRoute: j({}) }))).toMatchObject({ model: 'qwen3:8b', where: 'this computer (Ollama)', price: 'no charge · local', priceWhole: 'no price declared (local)', fake: false, ready: true });
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
      // (from 122 columns the route is whole; narrower, its short form (H168's F8), and what runs and waits stays whole)
      if (width >= 122) expect(status).toMatch(/^TIMMY · tray {3}next turn: qwen3:8b · this computer \(Ollama\) · no charge/);
      else expect(status).toMatch(/^TIMMY · tray {3}next: qwen3:8b · here · no charge/);
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
    // (R10 H163; H168's N1: "no charge · local" is longer than "no charge", so at 122 the route takes its short form)
    expect(plain(headerRows(data({ route: { kind: 'local', words: 'chat: local fake-qwen:1b · Ollama', ready: true } }), 'home', 122, g).lines[0])).toMatch(/next(?: turn)?: FAKE fake-qwen:1b · (?:this computer \(Ollama\)|here) · no charge · local/);
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
    expect(side).toMatch(/CONNECTION · ● live Ollama \(local models\) answered on this computer with 1 model/);
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

describe('words on Home and Chat (R10 H167; H168\'s F3): no address, port, path, command or id outside the details', () => {
  it('a cause, a step and a setting are said by what they are; the details keep them whole', () => {
    expect(inWords('Ollama at 127.0.0.1:11434 did not answer (the connection failed (ECONNREFUSED)). Start it (ollama serve, or open the Ollama app), then check again (timmy workspace check: free requests only).'))
      .toBe('Ollama on this computer did not answer (the connection was refused). Start it, then check again.');
    expect(inWords('Cause: the setup recorded none for Ollama at 127.0.0.1:11434.')).toBe('Cause: the setup recorded none for Ollama on this computer.');
    expect(inWords('no key: timmy init --chat openrouter asks for it (typed hidden), or set OPENROUTER_API_KEY'))
      .toBe('no key: the setup (in a shell) asks for it (typed hidden), or set it in the environment ([i])');
    expect(inWords('answered at http://127.0.0.1:40623 with 1 model')).toBe('answered on this computer with 1 model');
    expect(inWords('pull a local model (ollama pull <model>, not a cloud one), then timmy workspace check')).toBe('pull a local model, then check again');
    // words with none of them are kept as they are
    expect(inWords('answered 3 min ago (FAKE: 2 models); live: an answer seen in the last 30 minutes')).toBe('answered 3 min ago (FAKE: 2 models); live: an answer seen in the last 30 minutes');
  });

  it('a hand-off says what opened: the item by its name, else the tab; its address is the details\' (the server\'s own words, kept)', () => {
    const hex = Buffer.from('refs/demo-tray.stl', 'utf8').toString('hex');
    expect(companionWhat(`tab=create&mesh=${hex}`)).toBe('demo-tray.stl in 3D & Motion');
    expect(companionWhat('tab=workflows&run=o92079bb4', 'for Workflow run: report in REPORT.md')).toBe('Workflow run: report in REPORT.md in Workflows');
    expect(companionWhat('tab=voxvision&vox=v8764e36c')).toBe('the observation chosen in VoxVision');
    // (the companion's page opens on its Chat now: its Chat, not a tab of that name)
    expect(companionWhat('tab=chat')).toBe('its Chat');
    expect(companionWhat('tab=chat&receipt=d2d756db')).toBe('the receipt chosen in Chat');
    expect(handoffWords('companion', `The Companion opened in your browser (http://127.0.0.1:4472/?tab=create&mesh=${hex}), through a private page that carries its key`, 'demo-tray.stl in 3D & Motion'))
      .toBe('Opened in the companion: demo-tray.stl in 3D & Motion.');
    expect(handoffWords('studio', 'Studio opened in your browser (http://127.0.0.1:4470/), through a private page that carries its key. It shows tray.', '')).toBe('Opened Studio: it shows tray.');
    expect(handoffWords('companion', 'The Companion is at http://127.0.0.1:4472/; this computer has no browser opener here, so open it yourself', 'its Home tab'))
      .toBe('The companion serves its Home tab on this computer, but no browser was opened from here: the details ([i]) say its address, to open it yourself.');
  });
});

describe('Home\'s rows and the selected item (R10 H167; H168\'s F6, F7 and F10)', () => {
  const route = { provider: 'ollama' as const, requested: 'qwen3:8b', answeredBy: 'qwen3:8b', where: 'this computer' as const, fallback: false, fake: false, surface: 'workbench' as const };
  const turn = { kind: 'turn', id: 'd2d756db', title: 'Summarise the report run in one line.', when: iso(2), state: 'answered', receipt: { id: 'd2d756db', verified: true }, fake: false, operation: 'oc372c7b3', route, open: openTarget({ kind: 'turn', id: 'd2d756db' }) } as unknown as JourneyWorkItem;
  // (R10 H163, the lead's addition with H164's one turn row: Home counts answers from the frame's own sealed turns)
  const sealed = (at: string) => ({ receipt: 'd2d756db', surface: 'workbench', state: 'answered', model: 'qwen3:8b', at, operation: 'oc372c7b3', route: 'local', words: 'turn answered in the Workbench · qwen3:8b · receipt d2d756db' });
  const frame = (conns: unknown[], turns: unknown[] = []) => ({ project: { id: 'p1' }, activity: { chatTurn: null }, log: [], tabs: [], connections: conns, chat: { turns } }) as unknown as Data['frame'];
  const ollama = { id: 'ollama', label: 'Ollama (local models)', state: 'configured', words: 'set up, not checked yet (a setting is not a connection)', observedAt: null, setup: 'timmy workspace check' };
  const studio = { id: 'studio', label: 'Timmy Studio', state: 'configured', words: 'not running when checked 2 min ago; Studio · Show (s) starts it', observedAt: iso(2), setup: null };

  it('F6: a turn answered through Ollama is an answer seen from it (live, said so); a check that found a surface not running says so, never "not checked yet"', () => {
    const d = data({ frame: frame([ollama, studio], [sealed(iso(2))]), recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [turn] } });
    const [o, st] = homeConnections({ data: d, now: NOW });
    expect(o).toMatchObject({ state: 'live', observedAt: iso(2) });
    expect(o.words).toMatch(/^answered a chat turn \d\d:\d\d:\d\d \(its receipt is sealed\)/);
    expect(st.state).toBe('configured');
    const rows = text(homeWorkView(ctx(d, ui(), 70)).lines);
    expect(rows).toMatch(/Ollama +● live {2}· answered a chat turn \d\d:\d\d/);
    expect(rows).toMatch(/Studio +○ configured {2}· not running · checked \d\d:\d\d/);
    expect(rows).not.toMatch(/not checked yet/);
    // an answer older than the live bound is not counted
    const old = data({ frame: frame([ollama], [sealed(iso(45))]), recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [{ ...turn, when: iso(45) }] } });
    expect(homeConnections({ data: old, now: NOW })[0].state).toBe('configured');
  });

  it('F7: a file\'s row says the kind its record gives and what the file is ("reference · image"), never "result" for a reference', () => {
    const item = (kind: string, id: string) => ({ kind, id, title: id, when: iso(3), state: 'saved', receipt: null, fake: false, operation: null, open: openTarget({ kind: kind as 'reference', id }) }) as unknown as JourneyWorkItem;
    const d = data({ recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [item('reference', 'refs/demo-preview.png'), item('mesh', 'refs/demo-tray.stl'), item('result', 'out/report.md'), item('recording', 'out/scene.rrd')] } });
    const rows = text(homeWorkView(ctx(d, ui(), 90)).lines);
    expect(rows).toMatch(/demo-preview\.png +reference · image/);
    expect(rows).toMatch(/demo-tray\.stl +mesh · STL/);
    expect(rows).toMatch(/report\.md +result · document/);
    // (R10 H163; H168's N5: its kind once)
    expect(rows).toMatch(/scene\.rrd +recording +\d+ min ago/);
    expect(rows).not.toContain('recording · recording');
    expect(rows).not.toMatch(/result · (?:image|mesh)/);
    expect([fileWhat('a/b.JPG'), fileWhat('x.step'), fileWhat('notes.txt'), fileWhat('blob.bin')]).toEqual(['image', 'STEP', 'text', 'file']);
  });

  it('F7: two files of one name say their folders; a reference is a reference', () => {
    const item = (kind: string, id: string) => ({ kind, id, title: id, when: iso(3), state: 'saved', receipt: null, fake: false, operation: null, open: openTarget({ kind: kind as 'reference', id }) }) as unknown as JourneyWorkItem;
    const d = data({ recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [item('reference', 'refs/preview.png'), item('result', 'out/preview.png'), item('result', 'out/notes.txt')] } });
    expect(recentWork(d, 10, NOW).map((w) => [w.kind, w.title])).toEqual([['reference', 'preview.png (in refs)'], ['result', 'preview.png (in out)'], ['result', 'notes.txt']]);
  });

  it('F10: the selected item drawn as a terminal can: an image\'s pixel size and what measured it, a run\'s progress and files, a turn\'s question and answer', () => {
    // FIXTURE: a 640 × 360 PNG's header (its IHDR) in a project of this test's own
    const root = mkdtempSync(join(tmpdir(), 'wb-repr-'));
    mkdirSync(join(root, 'refs'));
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20);
    writeFileSync(join(root, 'refs', 'preview.png'), png);
    const image = { kind: 'reference', id: 'refs/preview.png', title: 'refs/preview.png', when: iso(3), state: 'saved', receipt: null, fake: false, operation: null, open: openTarget({ kind: 'reference', id: 'refs/preview.png' }) } as unknown as JourneyWorkItem;
    const run = { kind: 'run', id: 'o92079bb4', title: 'Workflow run: report in REPORT.md', when: iso(9), state: 'completed', receipt: { id: 'f7a8f9c4', verified: true }, fake: false, operation: 'o92079bb4', results: ['out/report.md', 'out/preview.png', 'out/a.txt', 'out/b.txt'], open: openTarget({ kind: 'run', id: 'o92079bb4' }) } as unknown as JourneyWorkItem;
    const d = data({
      project: { name: 'tray', root, id: 'p1', shown: '~/timmy/projects/tray' } as Data['project'],
      recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [turn, run, image] },
      jobs: [job({ id: 'j5c4706', label: 'REPORT.md › report', operation: 'o92079bb4' })],
      vox: [{ id: 'v8764e36c', what: 'detect refs/preview.png', state: 'ok', at: iso(4), record: 'results/vox/v8764e36c.json' }],
      chat: { session: 's1', total: 2, messages: [{ role: 'user', text: 'Summarise the report run in one line.' }, { role: 'assistant', text: 'FIXTURE: the report run wrote four files and its receipt verifies.' }] },
    });
    const c = ctx(d, ui(), 50);
    const [t, r, im] = recentWork(d, 10, NOW);
    expect(representation(im, c).map(plain).join(' ')).toMatch(/Image +640 × 360 px .*Measured +VoxVision detect · ok · \d\d:\d\d/);
    expect(representation(r, c).map(plain).join(' ')).toMatch(/Progress +completed · 1 of 1 step · 0\.2 s .*Wrote +report\.md, preview\.png, a\.txt, 1 more/);
    expect(representation(t, c).map(plain).join(' ').replace(/\s+/g, ' ')).toMatch(/You Summarise the report run in one line\. Timmy FIXTURE: the report run wrote four files/);
    // drawn in the Selected column, under the item's facts, with no path or id
    const side = flat(homeSideView(ctx(d, ui({ cursor: { 'center:connections': 2 } }), 50)).lines);
    expect(side).toMatch(/Image 640 × 360 px/);
    expect(side).not.toMatch(/refs\/|o92079bb4|v8764e36c/);
  });
});

describe('Chat\'s quiet log keeps a row for a notice; tab 3\'s next step after a run is to review it (R10 H167)', () => {
  it('the collapsed Activity & log on Chat: no log line, one empty row a two-row notice takes (its first row was lost); under 30 rows a workspace keeps its body rows', () => {
    const chat = layoutFor({ columns: 160, rows: 45, body: 'hub', pipeline: true, quietLog: true });
    expect(chat).toMatchObject({ logLines: 0, quietLog: true });
    expect(chat.bottom.h).toBe(5);
    // 80x24 and 100x28: the status row took the row a log line had, so the body is as tall as it was with one header row
    for (const [columns, rows, was] of [[80, 24, 2], [100, 28, 3]] as const) {
      const l = layoutFor({ columns, rows });
      expect(l.tabRows).toBe(2);
      expect(l.logLines).toBe(was - 1);
    }
    const long = 'Not sent yet: one turn at a time per project, and a turn is being answered in the REPL. What you typed stays here; Enter sends it once that turn has ended (RUNNING NOW 0).';
    const u = ui({ page: 'chat', workspace: 'chat', flash: { text: long, role: 'secondary', at: NOW - 1000 }, settings: { settings: { reducedMotion: true } }, activityOpen: false } as unknown as Partial<Ui>);
    const v = bottomView({ ...ctx(data(), u, 156), height: 3 } as never, { logLines: 0, quiet: true });
    expect(v.lines).toHaveLength(2);
    expect(v.lines[1]).toEqual([]);
    expect(plain(v.footAbove ?? [])).toMatch(/^Not sent yet: one turn at a time per project, and a turn is being answered in the REPL/);
    expect(plain(v.foot)).toMatch(/\(RUNNING NOW 0\)\.\s*$/);
  });

  it('a finished run of the selected block, nothing running or waiting: Review this run is the primary (Enter opens it in the companion, as c), Run it second', () => {
    const block = { doc: 'PAIR.md', key: '2', name: 'second', lang: 'bash', needs: ['first'], word: 'completed', glyph: '✓', detail: 'exit 0', order: ['first', 'second'], missing: [], risky: [] };
    const acts = [
      { n: 1, label: 'Run PAIR.md › second', command: '/run PAIR.md second', primary: true, enabled: true, effect: 'local change' },
      { n: 2, label: 'Review the last run', command: '/op o12345678', primary: false, enabled: true, effect: 'read' },
      { n: 3, label: 'Stop current', command: '/stop', primary: false, enabled: false, why: 'nothing runs', effect: 'local change' },
      { n: 4, label: 'Receipts of this project', command: '/receipts', primary: false, enabled: true, effect: 'read' },
    ];
    const frame = { project: { id: 'p1', name: 'tray' }, activity: { chatTurn: null }, connections: [], log: [], tabs: [], actions: { workflows: acts } };
    const run = { job: 'j123456', operation: 'o12345678', word: 'completed', live: false, steps: [], startedAt: iso(3), endedAt: iso(3), tail: { lines: [] } };
    const base = { frame, workflows: { upmd: true, docs: [{ rel: 'PAIR.md', blocks: [{ ...block, name: 'first', key: '1', order: ['first'], needs: [] }, block], repeated: [] }] } };
    const u = ui({ page: 'workflows', workspace: 'workflows', cursor: { 'center:workflows': 1 } });
    const after = pageActions({ ui: u, data: data({ ...base, workflowsTab: { for: blockKey('PAIR.md', 'second'), run } } as unknown as Partial<Data>) }).acts;
    expect(after.map((a) => [a.label, !!a.primary])).toEqual([['Run PAIR.md › second', false], ['Review this run', true], ['Stop current', false], ['Receipts of this project', false]]);
    expect(routeOf(after[1])).toMatchObject({ kind: 'key', key: 'c' });
    // while it runs, or for another block's run, the frame's own order stays
    const live = pageActions({ ui: u, data: data({ ...base, workflowsTab: { for: blockKey('PAIR.md', 'second'), run: { ...run, live: true, endedAt: null } } } as unknown as Partial<Data>) }).acts;
    expect(live.map((a) => [a.label, !!a.primary])[1]).toEqual(['Review the last run', false]);
    const other = pageActions({ ui: u, data: data({ ...base, workflowsTab: { for: blockKey('PAIR.md', 'first'), run } } as unknown as Partial<Data>) }).acts;
    expect(other[0].primary).toBe(true);
  });
});
