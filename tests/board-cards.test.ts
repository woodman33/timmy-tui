// Round R4 (H22): the board's parameter card and result cards, rendered from real files in temporary projects
// (a parameter file, a code agent's run record, a native run's record) and from plain records. The recipe's own
// result card with verified values is driven end to end in tests/board-edits.test.ts (a FAKE executor).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '../src/jobs/index.js';
import { DOCTRINE_15 } from '../src/recipes/index.js';
import { agentResults, gatherResults, jobResults, nativeResults, observationResults, paramsCard, renderParamsCard, renderResultCards, type ResultCard } from '../src/repl/board-cards.js';
import { kit } from '../src/repl/board-kit.js';
import { renderBoard, type BoardObservation } from '../src/repl/board.js';
import type { Receipt } from '../src/utils/receipts.js';

const dirs: string[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const still = kit({ live: false, base: '../../' });
const live = kit({ live: true, base: '../../' });
const scrub = (t: string): string => t;

describe('the parameter card', () => {
  it("shows the recipe's defaults when there is no file, read-only on the snapshot, with units, meanings and DOCTRINE §15", () => {
    const root = temp('cards-');
    const p = paramsCard(root);
    expect(p).toMatchObject({ recipe: 'tray', id: 'enclosure.tray/1', path: 'recipes/tray.params.json', file: { state: 'none' }, values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } });
    const html = renderParamsCard(p, still);
    expect(html).toContain('<strong>defaults</strong> no recipes/tray.params.json yet: these are the recipe&#39;s own defaults');
    expect(html).toContain('<th scope="row">width</th><td><span class="param-value">140</span> <span class="unit">mm</span></td><td class="help">overall width (X), 40 to 1000</td>');
    expect(html).toContain('above wall + 6, below min(width, 80)/2 - 6');
    expect(html).toContain('fixed (mm): depth 80, height 30, supportRadius 6, supportHeight 8');
    expect(html).toContain('data-cmd="/recipe tray"');
    expect(html).toContain(DOCTRINE_15);
    expect(html).not.toMatch(/<input|data-act=|data-params/);
  });

  it('shows a saved file with its sha256 and the values that differ from the defaults; the live card is a form with Save, Discard and Rebuild', () => {
    const root = temp('cards-');
    const file = '{"schema":"timmy.recipe-params/1","recipe":"enclosure.tray/1","parameters":{"width":180}}';
    put(root, 'recipes/tray.params.json', file);
    const p = paramsCard(root);
    expect(p.file).toMatchObject({ state: 'ok', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const html = renderParamsCard(p, still);
    expect(html).toContain('<strong>saved</strong> recipes/tray.params.json · sha256');
    expect(html).toContain('href="../../recipes/tray.params.json"');
    expect(html).toContain('overall width (X), 40 to 1000 (default 140)');
    const form = renderParamsCard(p, live);
    expect(form).toContain(`data-params="tray" data-params-base="${(p.file as { sha256: string }).sha256}"`);
    expect(form).toContain('<input type="number" step="any" inputmode="decimal" class="param-input" data-param="width" value="180" aria-label="width in millimetres">');
    expect(form).toContain('data-params-save');
    expect(form).toContain('data-params-discard');
    expect(form).toContain('data-act="rebuild" data-recipe="tray"');
    expect(form).not.toMatch(/\sstyle=|\son[a-z]+=|href=/);
  });

  it('says plainly when the file is not usable, and shows the defaults rather than guessing its values', () => {
    const root = temp('cards-');
    put(root, 'recipes/tray.params.json', '{"schema":"timmy.recipe-params/1","recipe":"enclosure.tray/1","parameters":{"width":20}}');
    const p = paramsCard(root);
    expect(p.file).toMatchObject({ state: 'unusable', error: expect.stringContaining('Conflicting tray dimensions') });
    expect(p.values.width).toBe(140);
    const html = renderParamsCard(p, live);
    expect(html).toContain('<strong>not usable</strong> recipes/tray.params.json: Conflicting tray dimensions');
    expect(html).toContain('/recipe tray refuses to start until it is fixed');
    expect(html).toContain(`data-params-base="${(p.file as { sha256: string }).sha256}"`);
  });
});

describe('result cards', () => {
  const card: ResultCard = {
    kind: 'job', title: 'j0a1b2c · <img src=x onerror=alert(1)>', at: '2026-10-09T10:00:00.000Z',
    status: { word: 'failed', tone: 'failed', detail: 'exit 2 <b>' }, lines: ['workflow · 1 of 2 steps completed'],
    facts: [{ label: 'bounds', value: '1 x 2 x 3 mm', how: 'as recorded' }],
    files: [{ rel: 'out/<x>.txt', note: 'written during the job' }], receipts: [{ id: 'deadbeef', what: 'workflow' }], commands: ['/jobs j0a1b2c'],
  };

  it('draw every part the same way, escaped: the status in words, files as links (text on the live board), receipts and commands', () => {
    const html = renderResultCards([card], still);
    expect(html).toContain('<strong class="label">j0a1b2c · &lt;img src=x onerror=alert(1)&gt;</strong> <span class="kind">job</span>');
    expect(html).toContain('2026-10-09 10:00 UTC');
    expect(html).toContain('<div class="rstatus rstatus-failed"><strong>failed</strong> exit 2 &lt;b&gt;</div>');
    expect(html).toContain('<dt>bounds</dt><dd>1 x 2 x 3 mm <span class="tier">as recorded</span></dd>');
    expect(html).toContain('<a class="file" href="../../out/%3Cx%3E.txt">out/&lt;x&gt;.txt</a>');
    expect(html).toContain('receipt deadbeef (workflow)');
    expect(html).toContain('data-cmd="/jobs j0a1b2c"');
    expect(html).not.toMatch(/<img|<b>|\sstyle=/);
    expect(html).not.toContain('class="notice"');
    const shown = renderResultCards([{ ...card, notice: DOCTRINE_15 }], live);
    expect(shown).toContain('<span class="file">out/&lt;x&gt;.txt</span>');
    expect(shown).not.toContain('href=');
    expect(shown).toContain(`<p class="notice">${DOCTRINE_15}</p>`);
  });

  it("an observation's card says its provenance in words and names its files, and shows none of its values", () => {
    const obs = (check: BoardObservation['check']): BoardObservation => ({
      file: 'results/observations/card.json', madeAt: '2026-10-09T09:00:00.000Z', source: { path: 'refs/card.png' },
      measurements: [{ name: 'sharpness', value: 123.456, tier: 'deterministic computation' }], job: 'j000001', ...(check ? { check } : {}),
    });
    const [verified, unverified, unchecked] = observationResults([obs({ status: 'verified', reasons: [], receipt: '1a2b3c4d' }), obs({ status: 'unverified', reasons: ['no observe receipt sealed these bytes'] }), obs(undefined)]);
    expect(verified.status).toMatchObject({ word: 'verified', tone: 'ok' });
    expect(verified.status.detail).toContain('1 value in its card under Observations');
    expect(verified.receipts).toEqual([{ id: '1a2b3c4d', what: 'observe' }]);
    expect(verified.files).toEqual([{ rel: 'refs/card.png', note: 'the image' }, { rel: 'results/observations/card.json', note: 'the observation' }]);
    expect(unverified.status).toMatchObject({ word: 'unverified', tone: 'attention', detail: expect.stringContaining('no observe receipt sealed these bytes; its values are shown as recorded, not as measured') });
    expect(unverified.receipts).toBeUndefined();
    expect(unchecked.status.detail).toContain('its provenance was not checked');
    const html = renderResultCards([verified, unverified], still);
    expect(html).not.toContain('123.456');
    expect(html).not.toContain('sharpness');
    expect(html).not.toContain('(measured)');
    expect(html).not.toMatch(/class="(measured|claim)"/);
  });

  it('a finished job that no other card stands for: its state, steps, prediction and the outputs its receipt sealed', () => {
    const root = temp('cards-');
    put(root, 'dist/index.html', '<p>hi</p>');
    const job = (id: string, label: string, state: JobRecord['state'], extra: Partial<JobRecord> = {}): JobRecord => ({
      id, kind: 'workflow', label, project: 'p', root, command: 'upmd', args: [], state, startedAt: '2026-10-09T10:00:00.000Z', endedAt: '2026-10-09T10:00:05.000Z',
      steps: [{ name: 'setup', state: 'completed', code: 0 }, { name: 'build', state: 'completed', code: 0 }], logPath: '/dev/null', lines: 0, ...extra,
    });
    const chain = [{ kind: 'workflow', job: { id: 'j000001' }, outputs: [{ path: 'dist/index.html', bytes: 9 }, { path: 'dist/gone.js', bytes: 1 }, { path: '/etc/passwd', bytes: 1 }], prediction: { met: true } }] as unknown as Receipt[];
    const cards = jobResults([
      job('j000001', 'BUILD.md › build', 'completed', { receipt: 'cafe0001' }),
      job('j000002', 'look refs/a.png', 'completed'), job('j000003', 'recipe enclosure.tray/1 x', 'completed'), job('j000004', 'agent qwen a1: x', 'completed'),
      job('j000005', 'BUILD.md › wait', 'running'), job('j000006', 'Blender · s.py', 'failed', { kind: 'task', exitCode: 1 }),
    ], chain, new Set(['j000006']), (t) => t);
    expect(cards.map((c) => c.title)).toEqual(['j000001 · BUILD.md › build']);
    expect(cards[0]).toMatchObject({
      kind: 'job', status: { word: 'completed', tone: 'ok' }, lines: ['workflow · 2 of 2 steps completed · its sealed prediction was met'],
      files: [{ rel: 'dist/index.html', note: 'written during the job' }, { rel: 'dist/gone.js', note: 'not there now' }], receipts: [{ id: 'cafe0001', what: 'workflow' }], commands: ['/jobs j000001'],
    });
  });

  it("a code agent's run: its outcome, what it changed, and its cost as reported (unknown, never an invented 0)", () => {
    const root = temp('cards-');
    const rec = (run: string, extra: Record<string, unknown>) => put(root, `.timmy/agents/${run}/result.json`, JSON.stringify({
      agent_run: 1, run, agent: 'claude', agent_version: '1.0', model: null, endpoint: 'remote', where: 'your account', task: 'fix the build', job: 'j0000aa', started_at: '2026-10-09T10:00:00.000Z', ...extra,
    }));
    rec('a00000001', { ended_at: '2026-10-09T10:05:00.000Z', outcome: 'completed', why: 'it exited 0 and reported success', cost_usd: null, cost_basis: 'unknown: the agent reported no cost', receipt: 'beef0001',
      files: { added: [{ path: 'src/new.ts', size: 1, sha256: null }], changed: [{ path: 'src/a.ts', size: 1, sha256: null }], deleted: [{ path: 'src/old.ts', size: 1, sha256: null }], truncated: false } });
    rec('a00000002', { started_at: '2026-10-09T09:00:00.000Z', agent: 'qwen', endpoint: 'local', where: '127.0.0.1:11434', ended_at: '2026-10-09T09:01:00.000Z', outcome: 'failed', why: 'it exited 1', cost_usd: 0, cost_basis: 'local endpoint' });
    rec('a00000003', { started_at: '2026-10-09T08:00:00.000Z' });
    const { cards, jobs } = agentResults(root, scrub);
    expect(jobs.has('j0000aa')).toBe(true);
    expect(cards.map((c) => [c.title, c.status.word])).toEqual([['agent claude · a00000001', 'completed'], ['agent qwen · a00000002', 'failed'], ['agent claude · a00000003', 'not finished here']]);
    expect(cards[0].lines).toEqual(['fix the build', 'its default model · your account · cost unknown: the agent reported none', '1 added, 1 changed, 1 deleted']);
    expect(cards[0].files).toEqual([{ rel: 'src/new.ts', note: 'added' }, { rel: 'src/a.ts', note: 'changed' }, { rel: '.timmy/agents/a00000001/result.json', note: 'its record' }]);
    expect(cards[0].receipts).toEqual([{ id: 'beef0001', what: 'agent' }]);
    expect(cards[1].lines?.[1]).toBe('its default model · local endpoint 127.0.0.1:11434 · cost $0.0000 (local endpoint)');
    expect(cards[2].lines?.[1]).toBe('its default model · your account');
  });

  it("a native run: judged by its own result file (the exit recorded, not decisive), its files inside the project, its sealed receipt", () => {
    const root = temp('cards-');
    const run = '0f0e0d0c-0b0a-4908-8706-050403020100';
    put(root, `.timmy/native/${run}/job.json`, JSON.stringify({ record: 'timmy-native-run', v: 1, app: 'blender', run, program: 'blender', label: 'Blender · scene.py', project: 'p', args: [], result: 'out/result.json', expect: ['out/scene.blend'], pre: {}, started_at: '2026-10-09T11:00:00.000Z', timeout_ms: 60000 }));
    put(root, `.timmy/native/${run}/started.json`, JSON.stringify({ job: 'j0000bb', started_at: '2026-10-09T11:00:00.000Z' }));
    put(root, `.timmy/native/${run}/verdicts.jsonl`, `${JSON.stringify({ judged_at: '2026-10-09T11:01:00.000Z', job: 'j0000bb', outcome: 'ok', why: 'its result file says ok and out/scene.blend was written', exit: { state: 'failed', code: 1, signal: null },
      files: [{ path: 'out/scene.blend', present: true, written: true }, { path: '/elsewhere/x', present: true, outside: true }, { path: 'out/missing.png', present: false }] })}\n`);
    // A receipt's short id is the first 8 hex digits of its hash, as /results shows it.
    const chain = [{ kind: 'native', hash: `sha256_89abcdef${'0'.repeat(56)}`, native: { run } }] as unknown as Receipt[];
    const { cards, jobs } = nativeResults(root, chain, scrub);
    expect(jobs.has('j0000bb')).toBe(true);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: 'native', title: 'Blender (Python, headless) · Blender · scene.py', status: { word: 'ok', tone: 'ok', detail: 'judged by its result file: its result file says ok and out/scene.blend was written' },
      lines: ['run 0f0e0d0c · job j0000bb · exit 1 (the exit is recorded, not decisive)'], files: [{ rel: 'out/scene.blend', note: 'written by this run' }],
      receipts: [{ id: '89abcdef', what: 'native' }], commands: ['/jobs j0000bb'],
    });
  });

  it('gathers every result newest first, counts the rest, and takes extra cards in the same shape (the hook for flows)', () => {
    const root = temp('cards-');
    const flow: ResultCard = { kind: 'flow', title: 'iterate · tray width', at: '2026-10-09T12:00:00.000Z', status: { word: 'completed', tone: 'ok' } };
    const old: ResultCard = { kind: 'flow', title: 'older', at: '2026-10-08T12:00:00.000Z', status: { word: 'failed', tone: 'failed' } };
    const obs: BoardObservation = { file: 'results/observations/a.json', madeAt: '2026-10-09T11:00:00.000Z', source: { path: 'refs/a.png' }, measurements: [] };
    const got = gatherResults({ root, jobs: [], chain: [], observations: [obs], scrub: (t) => t, extra: [old, flow], max: 2 });
    expect(got.cards.map((c) => c.title)).toEqual(['iterate · tray width', 'refs/a.png']);
    expect(got.more).toBe(1);
  });
});

describe('the board with its new sections', () => {
  it('the snapshot: Parameters and Results in the contents, the cards drawn read-only, one script, nothing fetched', () => {
    const root = temp('cards-');
    const html = renderBoard({
      project: 'demo', madeAt: 'now', base: '../../', references: [], jobs: [], outputs: [], observations: [],
      workflows: [{ rel: 'BUILD.md', sha256: 'ab'.repeat(32), blocks: [{ index: 1, name: 'setup', lang: 'bash', deps: [], code: 'mkdir -p dist' }, { index: 2, name: 'build', lang: 'bash', deps: ['setup'], code: 'npm run build' }] }],
      params: paramsCard(root), results: [], more: { results: 0 },
    });
    expect(html).toMatch(/<nav class="toc"><a href="#references">References <b>0<\/b><\/a><a href="#workflows">Workflows <b>1<\/b><\/a><a href="#parameters">Parameters<\/a><a href="#jobs">Jobs <b>0<\/b><\/a><a href="#results">Results <b>0<\/b><\/a>/);
    expect(html).toContain('<h2 id="parameters">Parameters</h2>');
    expect(html).toContain('No results yet: a recipe, a workflow run, a native app, a code agent or /observe makes one.');
    expect(html).toContain('<svg class="wf-svg"');
    expect(html).toContain('needs setup');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toMatch(/https?:\/\/|url\(|<input|data-act=|data-wf=/);
  });
});
