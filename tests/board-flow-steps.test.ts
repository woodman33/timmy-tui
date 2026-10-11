/**
 * Round R4 (H45): the board's flow cards, drawn from FAKE flow records (tests/fixtures/fake-flow-records.ts: synthetic,
 * written by hand; no agent, app, render or readback ran): the step strip from records of each kind and each ending, the
 * details' defaults and keys, the artifacts row, the After Effects timeline (escaped, bounded, none for an older record),
 * the flows that run (their state files), and the parameter card's saved values and Save. No processes.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCTRINE_15, type FlowRecord } from '../src/flows/iterate.js';
import { paramsCard, renderParamsCard } from '../src/repl/board-cards.js';
import { flowsSection, readBoardFlows, type BoardFlow } from '../src/repl/board-flows.js';
import { kit } from '../src/repl/board-kit.js';
import { flowSteps, nextHtml, STEP_NAMES, stripHtml, type Strip } from '../src/repl/board-steps.js';
import { fakeAe, fakeBlender, fakeFreecad, fakeFreecadOk, fakeScad, fakeTray, fakeTrayFailed, fakeTrayInterrupted, fakeTrayRunningState, type FakeRecord } from './fixtures/fake-flow-records.js';

const dirs: string[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const states = (s: Strip | undefined): string[] => (s ? s.steps.map((x) => `${x.name}:${x.state}${x.here ? ` (${x.here})` : ''}`) : []);
const flow = (r: FakeRecord, o: Partial<BoardFlow> = {}): BoardFlow => ({ file: `results/flows/${r.id}.json`, record: r as unknown as FlowRecord, check: { status: 'unverified', reasons: ['no flow receipt names this file'] }, ...o });
const section = (records: FakeRecord[], live = false): string => flowsSection({ list: records.map((r) => flow(r)), more: 0 }, { live, base: '../../' }).html;
const cardOf = (html: string, id: string): string => [...html.matchAll(/<article class="card flow[^"]*">([\s\S]*?)<\/article>/g)].map((m) => m[0]).find((c) => c.includes(`<strong>${id}</strong>`)) ?? '';
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

describe('the step strip: each kind\'s steps in order, each step\'s state from the record', () => {
  it('names the steps each kind runs', () => {
    expect(STEP_NAMES).toEqual({
      tray: ['agent', 'checks', 'build', 'readback'], blender: ['agent', 'checks', 'blender', 'readback'], scad: ['agent', 'checks', 'openscad', 'compare'],
      freecad: ['agent', 'checks', 'freecad', 'readback'], ae: ['agent', 'checks', 'author', 'render', 'readback'],
    });
  });

  it('succeeded, differs, failed, stopped, cancelled and interrupted: the steps before completed, the one it ended in marked, the rest not run', () => {
    expect(states(flowSteps(fakeTray()))).toEqual(['agent:completed', 'checks:completed', 'build:completed', 'readback:completed (ended here: succeeded)']);
    expect(states(flowSteps(fakeTrayFailed()))).toEqual(['agent:completed', 'checks:completed', 'build:failed (ended here: failed)', 'readback:not run']);
    expect(states(flowSteps(fakeTrayInterrupted()))).toEqual(['agent:completed', 'checks:completed', 'build:interrupted (ended here: interrupted)', 'readback:not run']);
    expect(states(flowSteps(fakeBlender()))).toEqual(['agent:completed', 'checks:completed', 'blender:completed', 'readback:completed (ended here: differs)']);
    expect(states(flowSteps(fakeScad()))).toEqual(['agent:completed', 'checks:completed', 'openscad:completed', 'compare:completed (ended here: succeeded)']);
    expect(states(flowSteps(fakeFreecad()))).toEqual(['agent:completed', 'checks:stopped (ended here: stopped)', 'freecad:not run', 'readback:not run']);
    expect(states(flowSteps(fakeAe()))).toEqual(['agent:completed', 'checks:completed', 'author:completed', 'render:completed', 'readback:completed (ended here: differs)']);
    // Stopped with /stop: the record's word is cancelled; the step says stopped.
    expect(states(flowSteps({ ...fakeTray(), outcome: 'cancelled', ended_in: 'agent' }))).toEqual(['agent:stopped (ended here: cancelled)', 'checks:not run', 'build:not run', 'readback:not run']);
    // After Effects whose author run failed: nothing rendered or read back.
    expect(states(flowSteps({ ...fakeAe(), outcome: 'failed', ended_in: 'author', render: undefined, readback: undefined }))).toEqual(['agent:completed', 'checks:completed', 'author:failed (ended here: failed)', 'render:not run', 'readback:not run']);
  });

  it('a readback that could not run says not run, even on the step the flow ended in; a flow that ended in prepare or record shows that step', () => {
    const fc = fakeFreecadOk();
    expect(states(flowSteps({ ...fc, readback: { state: 'not run', setup: 'FAKE setup' } }))).toEqual(['agent:completed', 'checks:completed', 'freecad:completed', 'readback:not run (ended here: succeeded)']);
    expect(states(flowSteps({ ...fakeAe(), outcome: 'succeeded', readback: { state: 'not run', setup: 'FAKE' } })).at(-1)).toBe('readback:not run (ended here: succeeded)');
    expect(states(flowSteps({ ...fakeTray(), outcome: 'failed', ended_in: 'record' }))).toEqual(['agent:completed', 'checks:completed', 'build:completed', 'readback:completed', 'record:failed (ended here: failed)']);
    expect(states(flowSteps({ ...fakeScad(), outcome: 'interrupted', ended_in: 'prepare' }))).toEqual(['prepare:interrupted (ended here: interrupted)', 'agent:not run', 'checks:not run', 'openscad:not run', 'compare:not run']);
  });

  it('a flow that runs: from its state file\'s step, the steps before completed, its step running, the rest waiting', () => {
    expect(states(flowSteps(fakeTrayRunningState()))).toEqual(['agent:completed', 'checks:completed', 'build:running (running now)', 'readback:waiting']);
    expect(states(flowSteps({ ...fakeAe(), outcome: 'running', ended_in: undefined, step: 'render' }))).toEqual(['agent:completed', 'checks:completed', 'author:completed', 'render:running (running now)', 'readback:waiting']);
    const odd = flowSteps({ ...fakeTrayRunningState(), step: 'teleport' });
    expect(odd?.steps.every((s) => s.state === 'unknown')).toBe(true);
    expect(odd?.note).toBe('its state file names a step this board does not know: teleport');
  });

  it('a record that does not say where it ended: no step is marked, each step as its own part says, and it says so', () => {
    const s = flowSteps({ ...fakeTray(), ended_in: undefined });
    expect(s?.steps.some((x) => x.here)).toBe(false);
    expect(states(s)).toEqual(['agent:completed', 'checks:unknown', 'build:completed', 'readback:completed']);
    expect(s?.note).toBe('the record does not say which step it ended in: each step is shown as its own part says');
    expect(flowSteps({ ...fakeTray(), kind: 'other' })).toBeUndefined();
    expect(flowSteps({ ...fakeTray(), target: 'maya' })).toBeUndefined();
    expect(flowSteps(null)).toBeUndefined();
  });

  it('is an ordered list with every state in words, the marked step aria-current, glyphs hidden from readers, every string escaped', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const r = { ...fakeTrayFailed(), agent: { ...(fakeTray().agent as object), agent: evil } };
    const html = stripHtml(flowSteps(r)!, `f0000a002${evil}`);
    expect(html.startsWith('<ol class="strip n4" aria-label="the steps of flow f0000a002&lt;img')).toBe(true);
    expect(html.match(/<li /g)).toHaveLength(4);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('<li class="st st-failed st-here" aria-current="step"><span class="st-dot" aria-hidden="true">✕</span> <span class="st-name">build</span> <span class="st-state">failed</span> <span class="st-here-words">ended here: failed</span>');
    expect(html).toContain('<span class="st-state">not run</span>');
    expect(html).toContain(esc(evil));
    expect(html).not.toContain('<img');
    // The words are there for a reader with no colour: each state as text.
    for (const w of ['completed', 'failed', 'not run']) expect(html).toContain(`<span class="st-state">${w}</span>`);
  });

  it('every card has its strip, on the snapshot and on the live board, with no script needed', () => {
    for (const live of [false, true]) {
      const html = section([fakeTray(), fakeTrayFailed(), fakeBlender(), fakeScad(), fakeFreecad(), fakeAe()], live);
      expect(html.match(/<ol class="strip n[45]"/g)).toHaveLength(6);
      expect(html).not.toContain('<script');
      expect(cardOf(html, 'f0000e001')).toContain('<ol class="strip n5"');
      expect(cardOf(html, 'f0000c001')).toContain('<span class="st-name">compare</span>');
    }
  });
});

describe('progressive disclosure: the summary in view, the long parts in <details>', () => {
  it('closed by default; open when the flow failed or differs; each keyed by the flow id', () => {
    const html = section([fakeTray(), fakeTrayFailed(), fakeBlender(), fakeFreecad()]);
    const ok = cardOf(html, 'f0000a001');
    expect(ok.match(/<details /g)).toHaveLength(4);
    expect(ok).not.toContain(' open>');
    for (const part of ['checks', 'change', 'steps', 'files']) expect(ok).toContain(`<details class="more" data-keep="f0000a001:${part}"><summary>`);
    const failed = cardOf(html, 'f0000a002');
    expect(failed).toContain('<details class="more" data-keep="f0000a002:steps" data-open-default open>');
    expect(cardOf(html, 'f0000b001')).toContain('<details class="more" data-keep="f0000b001:checks" data-open-default open>');
    // Stopped (not failed): closed, and only the parts it has (no checks: nothing was read back).
    const stopped = cardOf(html, 'f0000d001');
    expect(stopped).not.toContain('data-open-default');
    expect(stopped).not.toContain('data-keep="f0000d001:checks"');
  });

  it('the summary keeps the verdict and who measured what in one line, with DOCTRINE §15; the honesty labels stay in the card', () => {
    const verified = flowsSection({ list: [flow(fakeTray(), { check: { status: 'verified', receipt: 'abcd1234', reasons: [] } })], more: 0 }, { live: false, base: '../../' }).html;
    const summary = verified.match(/<section class="summary">([\s\S]*?)<\/section>/)![1];
    expect(summary).toContain('<dt>changed (mm)</dt><dd>width 140 → 180</dd>');
    expect(summary).toContain('<strong class="vw vw-matches">matches</strong>');
    expect(summary).toContain('<dt>measured</dt><dd>180 x 80 x 30 mm, 151,234.5 mm3 <span class="tier">predicted 180 x 80 x 30 mm, 151,234.5 mm3, sealed before the build</span></dd>');
    expect(summary).toContain('<p class="who">measured from the CAD file: the delivered STEP read back in its own process by fake-step-readback 0.0.0-fake (a FAKE readback, not a measurement); a measurement of the file, not of a physical part</p>');
    expect(summary).toContain(`<p class="doctrine">${esc(DOCTRINE_15)}</p>`);
    // Unverified: the same numbers, said as the record says.
    const card = cardOf(section([fakeTray()]), 'f0000a001');
    expect(card.match(/<section class="summary">([\s\S]*?)<\/section>/)![1]).toContain('measured from the CAD file, as the record says (not verified)');
    expect(card).toContain('measured from the CAD file, as the record says (not verified)</h4>');
    // Each kind keeps its scope and labels in the card (in its details).
    const html = section([fakeBlender(), fakeScad(), fakeFreecadOk(), fakeAe()]);
    expect(cardOf(html, 'f0000b001')).toContain('the same application reading its own file, not an independent implementation');
    expect(cardOf(html, 'f0000c001')).toContain('Timmy&#39;s own reading of the exported STL');
    expect(cardOf(html, 'f0000d002')).toContain('not an independent kernel');
    const ae = cardOf(html, 'f0000e001');
    expect(ae).toContain('After Effects&#39; own report of its project, read inside After Effects; the render measured by ffprobe, ffmpeg and Timmy&#39;s pixel reading, outside After Effects; as the record says (not verified)');
    expect(ae).toContain('<p class="meta label">measured from the rendered file by ffprobe');
    for (const id of ['f0000b001', 'f0000c001', 'f0000d002']) expect(cardOf(html, id)).toContain(esc(DOCTRINE_15));
    // Green is never a verdict here: the summary's words carry no accent class.
    expect(html).not.toMatch(/class="vw [^"]*accent/);
  });

  it('a record with no readback says nothing measured, and claims no measurement', () => {
    const card = cardOf(section([fakeTrayFailed()]), 'f0000a002');
    expect(card).not.toContain('measured from the CAD file');
    expect(card).not.toContain('<p class="who">');
  });
});

describe('the artifacts row', () => {
  it('names the editable file, the source, the preview and the record, each a link with its /open command, once', () => {
    const html = section([fakeTray(), fakeBlender(), fakeScad(), fakeFreecadOk(), fakeAe()]);
    const arts = (id: string): string => cardOf(html, id).match(/<section class="artifacts">([\s\S]*?)<\/section>/)![1];
    const rows = (id: string): string[] => [...arts(id).matchAll(/<span class="art-role">([^<]*)<\/span> <a class="name" href="([^"]*)">/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(rows('f0000a001')).toEqual(['STEP ../../out/recipes/1a2b3c4d/console-tray.step', 'parameters ../../recipes/tray.params.json', 'record ../../results/flows/f0000a001.json']);
    expect(rows('f0000b001')).toEqual(['.blend ../../out/scene.blend', 'script ../../scene.py', 'render ../../out/render.png', 'record ../../results/flows/f0000b001.json']);
    expect(rows('f0000c001')).toEqual(['.scad ../../box.scad', 'parameters ../../box.params.json', 'STL ../../out/box.stl', 'preview ../../out/box.png', 'record ../../results/flows/f0000c001.json']);
    expect(rows('f0000d002')).toEqual(['.FCStd ../../out/plate.FCStd', 'STEP ../../out/plate.step', 'script ../../plate.py', 'record ../../results/flows/f0000d002.json']);
    expect(rows('f0000e001')).toEqual(['.aep ../../out/ae/author-v2.aep', 'script ../../author.jsx', 'render ../../out/ae/author-v2.mp4', 'record ../../results/flows/f0000e001.json']);
    for (const r of [fakeTray(), fakeBlender(), fakeScad(), fakeFreecadOk(), fakeAe()]) {
      const card = cardOf(html, r.id);
      // each /open is offered once in the card (the commands live in the artifacts row only)
      expect(card.match(new RegExp(`data-cmd="/open results/flows/${r.id}\\.json"`, 'g'))).toHaveLength(1);
      expect(arts(r.id)).toContain('receipts: ');
    }
  });

  it('a path outside the project is left out of the row (the files list says it is not a project path); the live board names files as text', () => {
    const r = fakeTray({ parameters: { ...(fakeTray().parameters as object), path: '../../etc/passwd' } });
    const card = cardOf(section([r]), 'f0000a001');
    expect(card.match(/<section class="artifacts">([\s\S]*?)<\/section>/)![1]).not.toContain('etc/passwd');
    expect(card).not.toMatch(/href="[^"]*etc\/passwd/);
    const live = section([fakeTray(), fakeAe()], true);
    expect(live).not.toMatch(/<a [^>]*href=|<img /);
    expect(live).toContain('<span class="art-role">STEP</span> <span class="name">out/recipes/1a2b3c4d/console-tray.step</span>');
  });

  it("an interrupted record's next steps are shown as written; only the plain commands at their head get a copy button; nothing resumes", () => {
    const h = { cmd: (c: string) => `[${c}]` };
    const html = nextHtml(fakeTrayInterrupted(), h);
    expect(html).toContain('recorded after a restart (2026-10-10 09:10 UTC): what the record says to do next');
    expect(html).toContain('<li>/iterate tray &quot;FAKE: make the tray 160 mm wide&quot; starts a new flow from recipes/tray.params.json as it is now</li>');
    expect(html.match(/\[\/[^\]]*\]/g)).toEqual(['[/recipe recover 3c4d5e6f-0000-4000-8000-00000000000c]']);
    expect(html).toContain('no command resumes a flow');
    expect(html.toLowerCase()).not.toMatch(/>\s*resume/);
    expect(nextHtml(fakeTray(), h)).toBe('');
    expect(nextHtml({ recovered: { next: ['/jobs j0a0001; then', '/recipe status shows it', '/rm -rf x'] } }, h).match(/\[\/[^\]]*\]/g)).toEqual(['[/jobs j0a0001]']);
  });
});

describe("the After Effects timeline: After Effects' own report, with the readback's samples", () => {
  const timeline = (r: FakeRecord): string => cardOf(section([r]), r.id).match(/<section class="timeline">([\s\S]*?)<\/section>/)?.[1] ?? '';

  it('one row per layer, a bar from in to out, a diamond per Position key, a mark per sample by its check; labelled; escaped', () => {
    const t = timeline(fakeAe());
    expect(t).toContain('<p class="meta tl-label">After Effects&#39; own report; samples measured from the render · as the record says (not verified)</p>');
    expect(t).toMatch(/<svg class="tl" viewBox="0 0 360 134" width="360" height="134" role="img" aria-label="A timeline of 4 layers as After Effects reported them, with 6 readback samples: 4 match, 1 differ, 1 not compared"/);
    expect(t.match(/<g class="tl-row">/g)).toHaveLength(4);
    expect(t.match(/<rect /g)).toHaveLength(4);
    expect(t.match(/a Position key at/g)).toHaveLength(5);
    expect(t.match(/<g class="tl-sample tl-matches">/g)).toHaveLength(4);
    expect(t.match(/<g class="tl-sample tl-differs">/g)).toHaveLength(1);
    expect(t.match(/<g class="tl-sample tl-notcompared">/g)).toHaveLength(1);
    expect(t).toContain('<title>Mover at 2 s: differs (outside 38.4 x, 21.6 y comp pixels)</title>');
    expect(t).toContain('<title>Mover: in 0 s, out 4 s (After Effects&#39; report)</title>');
    // the hostile layer name is text, cut on the row and whole in its title
    expect(t).not.toContain('<img');
    expect(t).toContain('<title>&lt;img src=x onerror=alert(1)&gt;</title>&lt;img src=x on…</text>');
    expect(t).toContain('the record keeps Position keys only, not Scale, Opacity or Rotation');
    // pure data: nothing fetched, no link, no style attribute, no script
    expect(t).not.toMatch(/https?:|url\(|<image|<a |href=|style=|<script|<foreignObject|\son[a-z]+="/i);
  });

  it('keys of Scale, Opacity and Rotation are drawn when a record keeps them; samples with no row are counted', () => {
    const r = fakeAe();
    const ba = r.before_after as { after: { layers: Array<Record<string, unknown>> } };
    ba.after.layers[1] = { ...ba.after.layers[1], opacity: { keys: [[0.5, 0], [1, 100]] }, rotation: { keys: [[2, 0]] } };
    (r.readback as { checks: unknown[] }).checks.push({ name: 'Ghost at 1 s', passed: true });
    const t = timeline(r);
    expect(t.match(/an Opacity key at/g)).toHaveLength(2);
    expect(t.match(/a Rotation key at/g)).toHaveLength(1);
    expect(t).toContain('◆ Position, Opacity, Rotation keys');
    expect(t).not.toContain('keeps Position keys only');
    expect(t).toContain('1 sample of a layer not drawn here');
  });

  it('no readback samples: the label says the render was not read back; bounded rows and sizes; nothing for an older record', () => {
    expect(timeline({ ...fakeAe(), readback: { state: 'not run', setup: 'FAKE' } })).toContain('After Effects&#39; own report; no samples: the render was not read back');
    // many layers: the first 16 drawn, the rest counted; a hostile number does not escape the drawing
    const many = fakeAe();
    const ba = many.before_after as { after: Record<string, unknown> };
    ba.after = { ...ba.after, duration: 4, layers: Array.from({ length: 30 }, (_, i) => ({ name: `L${i}`, kind: 'solid', span: [i === 0 ? -1e300 : 0, i === 1 ? 1e300 : 4], position: { keys: [[Number.MAX_VALUE, [0, 0]], [2, [1, 1]]] } })) };
    const t = timeline(many);
    expect(t.match(/<g class="tl-row">/g)).toHaveLength(16);
    expect(t).toContain('the first 16 of 30 layers');
    expect(t).toMatch(/viewBox="0 0 360 446"/);
    for (const n of t.matchAll(/ (?:x|y|width|height|cx|cy|x1|x2|y1|y2)="(-?[\d.]+)"/g)) expect(Math.abs(Number(n[1]))).toBeLessThanOrEqual(446);
    // an older record: no report of layers with their in and out points or keys, so no timeline
    const old = fakeAe();
    (old.before_after as { after: Record<string, unknown> }).after = { comp: 'Main', layers: [{ name: 'Mover', kind: 'solid' }] };
    expect(timeline(old)).toBe('');
    expect(timeline({ ...fakeAe(), before_after: undefined })).toBe('');
    expect(timeline({ ...fakeAe(), before_after: { after: { layers: [{ position: { keys: [1, [2]] } }] } } })).toBe('');
  });
});

describe('the flows that run: drawn from their state files, said as such', () => {
  it('a state file that says it runs, with no record: a running card first; one with a record, or ended, or outside the project, is not', () => {
    const root = temp('flow-steps-');
    const running = fakeTrayRunningState();
    put(root, `.timmy/flows/${running.id}/state.json`, JSON.stringify(running));
    // a flow with a record: its state file is not drawn again
    const done = fakeTray();
    put(root, `results/flows/${done.id}.json`, JSON.stringify(done));
    put(root, `.timmy/flows/${done.id}/state.json`, JSON.stringify({ ...done, outcome: 'running', step: 'readback' }));
    // an ended flow whose record is gone: not drawn from its state file
    put(root, '.timmy/flows/f0000f002/state.json', JSON.stringify({ ...fakeTray(), id: 'f0000f002', outcome: 'failed' }));
    // a state file reached through a link out of the project: not read
    const outside = temp('flow-steps-outside-');
    put(outside, 'state.json', JSON.stringify({ ...running, id: 'f0000f003' }));
    symlinkSync(outside, join(root, '.timmy/flows/f0000f003'));
    const flows = readBoardFlows(root, [`results/flows/${done.id}.json`], { receipts: [], projectId: 'p', scrub: (t) => t });
    expect(flows.list.map((f) => f.record.id)).toEqual([done.id]);
    expect(flows.running?.map((f) => [f.record.id, f.file])).toEqual([[running.id, `.timmy/flows/${running.id}/state.json`]]);
    const html = flowsSection(flows, { live: false, base: '../../' }).html;
    expect(html.indexOf('Running now, as their state files say')).toBeLessThan(html.indexOf(`<strong>${done.id}</strong>`));
    const card = cardOf(html, running.id);
    expect(card).toContain('<span class="state state-running">running</span>');
    expect(card).toMatch(/<strong>running<\/strong> no record yet: this card is drawn from its state file \(\.timmy\/flows\/f0000f001\/state\.json\) as its session last wrote it, at \d{4}-\d\d-\d\d \d\d:\d\d UTC; the record is written when the flow ends\. If the REPL running it has ended, \/recover records it as interrupted\./);
    expect(card).toContain('<span class="st-state">running</span> <span class="st-here-words">running now</span>');
    expect(card).toContain('<span class="st-state">waiting</span>');
    expect(card).toContain('data-cmd="/stop f0000f001"');
    expect(card).toContain('<span class="art-role">state file</span>');
    // the count is of records
    expect(html).toContain('<h2 id="flows">Flows <span class="count">1</span></h2>');
  });
});

describe('the parameter card: saved values beside the inputs, Save only once something changed', () => {
  const live = kit({ live: true, base: '../../' });
  const still = kit({ live: false, base: '../../' });

  it('shows the saved value beside each input and a place for its before → after; Save starts disabled', () => {
    const root = temp('flow-steps-params-');
    put(root, 'recipes/tray.params.json', '{"schema":"timmy.recipe-params/1","recipe":"enclosure.tray/1","parameters":{"width":180}}');
    const form = renderParamsCard(paramsCard(root), live);
    expect(form).toContain('<th scope="col">value</th><th scope="col">saved</th><th scope="col">meaning and range (mm)</th>');
    expect(form).toContain('aria-label="width in millimetres"> <span class="unit">mm</span></td><td class="saved"><span class="param-saved">180</span><span class="param-change" data-param-change></span></td>');
    expect(form).toContain('<button type="button" class="act" data-params-save disabled>Save parameters</button>');
    expect(form).toContain('data-params-file="ok"');
    expect(form).toContain('Save is offered once a value differs from the saved file.');
    expect(form).toContain('while an /iterate flow runs in this project, Save is refused');
    expect(form).not.toMatch(/\sstyle=|\son[a-z]+=|href=/);
  });

  it('with no file the column says default; a file that is not usable can be replaced at once (Save enabled)', () => {
    const none = renderParamsCard(paramsCard(temp('flow-steps-params-')), live);
    expect(none).toContain('<th scope="col">default</th>');
    expect(none).toContain('data-params-save disabled');
    const root = temp('flow-steps-params-');
    put(root, 'recipes/tray.params.json', '{"schema":"timmy.recipe-params/1","recipe":"enclosure.tray/1","parameters":{"width":20}}');
    const bad = renderParamsCard(paramsCard(root), live);
    expect(bad).toContain('<button type="button" class="act" data-params-save>Save parameters</button>');
    expect(bad).toContain('data-params-file="unusable"');
  });

  it('the snapshot stays read-only, as it was: no saved column, no form', () => {
    const html = renderParamsCard(paramsCard(temp('flow-steps-params-')), still);
    expect(html).toContain('<th scope="col">parameter</th><th scope="col">value</th><th scope="col">meaning and range (mm)</th>');
    expect(html).not.toMatch(/<input|data-param|class="saved"/);
  });
});
