import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasSummary } from '../src/companion/canvas.js';
import { CanvasDocuments } from '../src/studio/document.js';

// Fourth order, step 5: the Canvas tab in the browser companion shows the same canvas as the page and
// the terminal: its revision and source revision, and its jobs, each with the receipt that sealed it.
// The companion can be opened from a phone on the network, so it reads only those, never the drawing.
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'timmy-companion-canvas-')); homes.push(h); return h; };
const SNAP = { store: {}, schema: { schemaVersion: 2, sequences: {} } };
const SOURCE = 'ab'.repeat(32);

describe('the jobs ledger (round R1)', () => {
  it("marks a job by its last call, and counts the failed calls, which kept nothing", () => {
    const docs = new CanvasDocuments(join(home(), 'canvas'));
    docs.recordJob('draw', { ok: false, revision: 2, sourceRevision: SOURCE });
    expect(docs.recordJob('draw', { ok: false, revision: 4, sourceRevision: SOURCE })).toMatchObject({ ok: false, calls: 2, failed: 2 });
    expect(docs.recordJob('draw', { ok: true, revision: 5, sourceRevision: SOURCE })).toMatchObject({ ok: true, calls: 3, failed: 2 });
  });
});

describe('canvasSummary', () => {
  it('a new home: revision 0, no source revision, no jobs, and where to open the canvas', () => {
    expect(canvasSummary({ TIMMY_HOME: home() })).toEqual({ revision: 0, sourceRevision: null, savedAt: null, jobs: [], open: 'http://127.0.0.1:4337/' });
  });
  it('the saved canvas and its jobs, newest first, at most 12, and never the drawing itself', () => {
    const h = home();
    const docs = new CanvasDocuments(join(h, 'canvas'));
    docs.save({ snapshot: SNAP, revision: 7, baseRevision: 0 });
    for (let i = 0; i < 14; i++) docs.recordJob(`turn-${i}`, { ok: i !== 13, revision: 7, sourceRevision: SOURCE });
    docs.linkReceipt('turn-12', '0f3c9a12');
    const s = canvasSummary({ TIMMY_HOME: h, TIMMY_STUDIO_PORT: '4400' });
    expect(s).toMatchObject({ revision: 7, open: 'http://127.0.0.1:4400/' });
    expect(s.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(s.jobs).toHaveLength(12);
    expect(s.jobs.slice(0, 2)).toEqual([
      expect.objectContaining({ id: 'turn-13', ok: false }),
      expect.objectContaining({ id: 'turn-12', ok: true, receipt: '0f3c9a12' }),
    ]);
    expect(JSON.stringify(s)).not.toContain('schemaVersion');
  });
  it('R6 lead: with a project, its own board (each project has one since H139), never another project\'s', async () => {
    const { boardOfFolder } = await import('../src/studio/boards.js');
    const h = home();
    const env = { TIMMY_HOME: h };
    const a = join(h, 'projects', 'FAKE-a');
    const b = join(h, 'projects', 'FAKE-b');
    const docsA = boardOfFolder(a, env);
    docsA.save({ snapshot: SNAP, revision: 3, baseRevision: 0 });
    docsA.recordJob('turn-aaaa', { ok: true, revision: 3, sourceRevision: SOURCE });
    const docsB = boardOfFolder(b, env);
    docsB.save({ snapshot: SNAP, revision: 9, baseRevision: 0 });
    docsB.recordJob('turn-bbbb', { ok: true, revision: 9, sourceRevision: SOURCE });
    const sa = canvasSummary(env, a);
    const sb = canvasSummary(env, b);
    expect(sa).toMatchObject({ revision: 3, jobs: [expect.objectContaining({ id: 'turn-aaaa' })] });
    expect(sb).toMatchObject({ revision: 9, jobs: [expect.objectContaining({ id: 'turn-bbbb' })] });
    expect(JSON.stringify(sa)).not.toContain('turn-bbbb');
    expect(JSON.stringify(sb)).not.toContain('turn-aaaa');
    // the home-wide canvas of the layout before R6 is neither
    expect(canvasSummary(env)).toMatchObject({ revision: 0, jobs: [] });
  });
});

// The tab's own rendering, as the served page runs it (R4 H92: the page's script is a file of its own).
const html = readFileSync(new URL('../src/companion/client/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/companion/client/companion.js', import.meta.url), 'utf8');
const code = script.slice(script.indexOf('// Timmy Canvas tab'), script.indexOf('// end Timmy Canvas tab'));
const render = (summary: unknown, hostname: string): string => runInNewContext(`${code}\ncanvasSummaryHtml(summary, hostname);`, { summary, hostname });

describe('the CANVAS tab', () => {
  const summary = {
    revision: 7, sourceRevision: SOURCE, savedAt: '2026-10-07T19:41:15.104Z', open: 'http://127.0.0.1:4337/',
    jobs: [
      { id: 'turn-3c0f18b0', ok: true, calls: 2, revision: 7, sourceRevision: SOURCE, at: '2026-10-07T19:41:15.104Z', receipt: '0f3c9a12' },
      { id: 'turn-<b>x</b>', ok: false, calls: 1, revision: 6, sourceRevision: SOURCE, at: '2026-10-07T19:40:00.000Z' },
    ],
  };
  it('names the revision, the source revision and each job in words, its receipt linked on this computer', () => {
    const out = render(summary, '127.0.0.1');
    expect(out).toContain('Revision 7');
    expect(out).toContain(`source ${SOURCE.slice(0, 12)}`);
    expect(out).toContain('✓ done');
    expect(out).toContain('✖ failed');
    expect(out).toContain('<a href="http://127.0.0.1:4337/receipts/0f3c9a12"');
    expect(out).toContain('<a href="http://127.0.0.1:4337/"');
    expect(out).toContain('no receipt yet');
  });
  it("from another device: no links to this computer’s 127.0.0.1, the address said instead; text escaped", () => {
    const out = render(summary, '192.0.2.10');
    expect(out).not.toContain('<a ');
    expect(out).toContain('receipt 0f3c9a12');
    expect(out).toContain('Open http://127.0.0.1:4337/ on the computer that runs Timmy');
    expect(out).toContain('turn-&lt;b&gt;x&lt;/b&gt;');
  });
  it('R6 lead: says whose board it is, the project\'s name escaped', () => {
    const out = render({ ...summary, project: 'tray<i>' }, '127.0.0.1');
    expect(out).toContain('The board of tray&lt;i&gt; (each project has its own)');
  });
  it('a canvas file it cannot read is said, not shown as blank', () => {
    expect(render({ ...summary, revision: null, sourceRevision: null, unreadable: true, jobs: [] }, '127.0.0.1')).toContain('The saved canvas could not be read');
  });
  it('the tab is in the deck, with its panel', () => {
    // R4 (H92): wired by the page's script (data-tab), not an inline handler, which the page's policy would not run. R5 (H132):
    // the panel is the Studio tab's (4), and that tab names it
    expect(html).toMatch(/id="ws-tab-studio" data-ws-tab="studio" data-tab="canvas"/);
    expect(html).toContain('id="tab-canvas"');
    expect(html).not.toMatch(/\sonclick=/);
  });
  it('writes no style attribute and opens its links apart from the page, with no referrer (R4 H92)', () => {
    const out = render(summary, '127.0.0.1');
    expect(out).not.toMatch(/\sstyle=|\son[a-z]+=/);
    for (const a of out.match(/<a [^>]*>/g) ?? []) expect(a).toMatch(/target="_blank" rel="noopener noreferrer"/);
  });
});
