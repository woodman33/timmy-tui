// Round R4 (H47): the connected workflow card (src/repl/board-workflows.ts and its parts in board-nodes.ts): a document's
// prose with chips, its graph with each block's state in words, the inspector, the parameter files a command names, its
// runs' results and an interrupted run. Pure functions over real files in a temporary project; the job records and the
// receipts here are FAKE (built by hand in the shapes src/jobs and the Workspace write), and no block runs.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '../src/jobs/index.js';
import { kit } from '../src/repl/board-kit.js';
import { renderWorkflowCard, workflowForBoard } from '../src/repl/board-nodes.js';
import { EDIT_SCRIPT } from '../src/repl/board-edits.js';
import { connectWorkflow, liveNodeStates, mentions, nodeAnchor, paramRefs, runOf, StepClock, WORKFLOW_SCRIPT, workflowSummaryLines, type ConnectContext } from '../src/repl/board-workflows.js';
import type { Receipt } from '../src/utils/receipts.js';

const F = '```';
const DOC = [
  '# Tray build', '',
  'Check the parameters in `recipes/tray.params.json` first, then see [the model](box.scad) and [upmd](https://github.com/rezigned/upmd).', '',
  `${F}bash [name:check]`, 'test -f recipes/tray.params.json', F, '',
  '## Build', '',
  `${F}bash [name:build, deps:check]`, 'cat box.params.json > /dev/null', 'mkdir -p out && echo FAKE > out/tray.stl', F, '',
  `${F}sh [name:inspect, deps:build]`, 'test -s out/tray.stl', F, '',
].join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'board-wf-'));
  dirs.push(root);
  const put = (rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
  put('BUILD.md', DOC);
  put('box.scad', 'width = 60;\ncube([width, 40, 10]);\n');
  put('box.params.json', `${JSON.stringify({ schema: 'timmy.scad-params/1', model: 'box.scad', parameters: { width: 60, part: 'both', lid: true } }, null, 2)}\n`);
  put('out/tray.stl', 'FAKE stl bytes');
  return root;
}
const files = ['BUILD.md', 'box.scad', 'box.params.json', 'out/tray.stl'];
/** A FAKE /run job record of BUILD.md, in the shape src/jobs writes. */
function job(root: string, o: Partial<JobRecord> & { id: string; target: string }): JobRecord {
  const { target, ...rest } = o;
  return {
    kind: 'workflow', label: `BUILD.md › ${target}`, project: 'demo', root, command: 'upmd', args: ['--ci', '-b', target, '-d', root, join(root, 'BUILD.md')],
    state: 'completed', startedAt: '2026-10-10T10:00:00.000Z', endedAt: '2026-10-10T10:00:03.000Z', steps: [], logPath: '/dev/null', lines: 0, ...rest,
  };
}
const view = (root: string, ctx: Partial<ConnectContext> = {}) => connectWorkflow(workflowForBoard('BUILD.md', { text: DOC, sha256: sha(DOC) }), { root, jobs: [], chain: [], files, upmd: true, ...ctx });
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');

describe('the parameter files a command names: a plain match of the path', () => {
  it('matches the path itself, with ./ or quotes around it, and nothing longer', () => {
    expect(mentions('cat box.params.json', 'box.params.json')).toBe(true);
    expect(mentions('cat ./box.params.json | jq .', 'box.params.json')).toBe(true);
    expect(mentions('python b.py --params="box.params.json"', 'box.params.json')).toBe(true);
    expect(mentions('cat mybox.params.json', 'box.params.json')).toBe(false);
    expect(mentions('cat out/box.params.json', 'box.params.json')).toBe(false);
    expect(mentions('cp box.params.json.bak x', 'box.params.json')).toBe(false);
    expect(mentions('cat a/./box.params.json', 'box.params.json')).toBe(false);
    expect(mentions('cat box.params.json.bak box.params.json', 'box.params.json')).toBe(true);
  });

  it('knows the tray recipe\'s file and each OpenSCAD model\'s <model>.params.json beside it; no other kind', () => {
    expect(paramRefs('python b.py recipes/tray.params.json cad/box.params.json other.params.json', ['cad/box.scad', 'lid.scad'])).toEqual([
      { kind: 'tray', path: 'recipes/tray.params.json' }, { kind: 'scad', path: 'cad/box.params.json', model: 'cad/box.scad' },
    ]);
    expect(paramRefs('cat settings.json params.json', ['box.scad'])).toEqual([]);
  });

  it("reads a /run job's document and block from its upmd arguments, else its label", () => {
    expect(runOf({ kind: 'workflow', args: ['--ci', '-b', 'build', '-d', join('/', 'proj'), join('/', 'proj', 'docs', 'BUILD.md')], root: join('/', 'proj'), label: 'x' })).toEqual({ doc: 'docs/BUILD.md', target: 'build' });
    expect(runOf({ kind: 'workflow', args: [], root: join('/', 'proj'), label: 'BUILD.md › build' })).toEqual({ doc: 'BUILD.md', target: 'build' });
    expect(runOf({ kind: 'task', args: [], root: join('/', 'proj'), label: 'BUILD.md › build' })).toBeUndefined();
  });
});

describe('each block connected to its runs (FAKE job records and receipts)', () => {
  it('a run going now: its blocks waiting, running or completed, in words; Stop only for this REPL\'s run', () => {
    const root = project();
    const running = job(root, { id: 'j00a001', target: 'inspect', state: 'running', endedAt: undefined, steps: [{ name: 'check', index: 1, state: 'completed', code: 0 }, { name: 'build', index: 2, state: 'running' }] });
    const w = view(root, { jobs: [running], prediction: (id) => (id === 'j00a001' ? { order: ['check', 'build', 'inspect'] } : undefined), mine: () => true });
    const c = w.connected!;
    expect(c.nodes.map((n) => [n.name, n.word, n.detail])).toEqual([['check', 'completed', 'exit 0'], ['build', 'running', ''], ['inspect', 'waiting', '']]);
    expect(c.runs[0]).toMatchObject({ job: 'j00a001', target: 'inspect', word: 'running', stoppable: true, orderFrom: 'prediction' });
    const live = renderWorkflowCard(w, kit({ live: true, base: '../../' }));
    // each state is a word (and a glyph) on the graph, on the chips and in the inspector; colour only follows the word
    expect(live).toContain('>✓ completed · exit 0</text>');
    expect(live).toContain('>● running</text>');
    expect(live).toContain('>○ waiting</text>');
    expect(live).toMatch(/<span class="wf-chip-state">running<\/span>/);
    // the run bar: Stop presses the Jobs section's own Stop (the existing /stop path); the command is shown too
    expect(live).toContain('<button type="button" class="act act-stop" data-wf-stop="j00a001">Stop</button>');
    expect(live).toContain('data-cmd="/stop j00a001"');
    expect(live).not.toMatch(/data-act="stop"/);
    // another session's run: no Stop here
    const foreign = renderWorkflowCard(view(root, { jobs: [running], mine: () => false }), kit({ live: true, base: '../../' }));
    expect(foreign).not.toContain('data-wf-stop');
    expect(foreign).toContain('started by another session: this REPL cannot stop it');
  });

  it("after a run: each block's exit code and own time, the files the run wrote from its sealed outcome, the outcome receipt", () => {
    const root = project();
    // R4 (H58): a run with live states (upmd on a pty, through the wrapper) records when each block started and ended:
    // check from 0 to 400 ms, build from 400 to 2400 ms, inspect from 2400 to 2450 ms
    const t = (ms: number): string => new Date(Date.parse('2026-10-10T10:00:00.000Z') + ms).toISOString();
    const done = job(root, {
      id: 'j00a002', target: 'inspect', receipt: 'cafe0002', command: 'python3', args: ['-I', join(root, 'workers', 'upmd', 'pty_run.py'), '--', 'upmd', '--ci', '-b', 'inspect', '-d', root, join(root, 'BUILD.md')],
      steps: [
        { name: 'check', index: 1, state: 'completed', code: 0, startedAt: t(0), endedAt: t(400) },
        { name: 'build', index: 2, state: 'completed', code: 0, startedAt: t(400), endedAt: t(2400) },
        { name: 'inspect', index: 3, state: 'completed', code: 0, startedAt: t(2400), endedAt: t(2450) },
      ],
    });
    // the in-memory clock is only the fallback for such a run's step without recorded moments: a stale reading here is not used
    const clock = new StepClock();
    clock.note({ id: done.id, steps: done.steps.map((s) => ({ ...s, state: 'running' as const })) }, 1_000_000);
    clock.note({ id: done.id, steps: done.steps }, 1_000_001);
    const chain = [
      { kind: 'predict', hash: `sha256:abcd1234${'0'.repeat(56)}`, prediction: { doc: 'BUILD.md', block: 'inspect', order: ['check', 'build', 'inspect'], expect: 'each block exits 0' }, files: [{ path: 'BUILD.md', sha256: 'f'.repeat(64) }] },
      {
        kind: 'workflow', job: { id: 'j00a002' }, prediction: { doc: 'BUILD.md', block: 'inspect', order: ['check', 'build', 'inspect'], expect: 'each block exits 0', met: true, receipt: 'abcd1234' },
        outputs: [{ path: 'out/tray.stl', sha256: sha('FAKE stl bytes'), bytes: 14 }, { path: 'out/gone.txt', sha256: 'e'.repeat(64), bytes: 3 }, { path: '/etc/passwd', bytes: 1 }],
      },
    ] as unknown as Receipt[];
    const w = view(root, { jobs: [done], chain, clock });
    const c = w.connected!;
    expect(c.nodes.map((n) => [n.name, n.word, n.detail])).toEqual([['check', 'completed', 'exit 0 · 0.4 s'], ['build', 'completed', 'exit 0 · 2.0 s'], ['inspect', 'completed', 'exit 0 · <0.1 s']]);
    expect(c.runs[0]).toMatchObject({ met: true, receipt: 'cafe0002', orderFrom: 'sealed', predicted: 'abcd1234', docSha256: 'f'.repeat(64), outputs: [{ rel: 'out/tray.stl', note: 'as the run wrote it' }, { rel: 'out/gone.txt', note: 'not there now' }] });
    const still = renderWorkflowCard(w, kit({ live: false, base: '../../' }));
    expect(still).toContain('href="../../out/tray.stl"');
    expect(still).toContain('as the run wrote it');
    expect(still).toContain('outcome receipt cafe0002');
    expect(still).toContain('prediction met');
    expect(still).toContain('it ran an earlier version of BUILD.md (sha256 ffffffffffff)');
    expect(still).toContain("The files the run wrote, from its sealed outcome; a run&#39;s files are not attributed to one block.");
    expect(still).not.toContain('/etc/passwd');
    // the REPL's /workflows <file>: the same results in text
    const lines = text(workflowSummaryLines(w, { sep: ' · ', link: (rel) => rel, upmd: { version: '0.2.7' } }));
    expect(lines).toContain('BUILD.md  workflow · 3 named blocks');
    expect(lines).toMatch(/1 check +bash +✓ completed exit 0 · 0\.4 s · j00a002 2026-10-10 10:00 UTC · receipt cafe0002/);
    expect(lines).toMatch(/2 build +bash +needs check +✓ completed exit 0 · 2\.0 s/);
    expect(lines).toContain('Last run  j00a002  inspect (check → build → inspect) · completed');
    expect(lines).toContain('outcome receipt cafe0002 · prediction met');
    expect(lines).toContain('wrote out/tray.stl (as the run wrote it), out/gone.txt (not there now)');
    expect(lines).toContain('/run BUILD.md inspect  (check → build → inspect)');
    expect(lines).not.toContain('were not live');
    expect(c.runs[0].live).toBe(true);

    // R4 (H58, ledger row 157): the same run over a pipe (upmd's own args; no python3, or a run before H58) saw each block
    // only when it ended: no own time is shown, even where a clock noted one, and the card says its states were not live
    const piped = { ...done, command: 'upmd', args: ['--ci', '-b', 'inspect', '-d', root, join(root, 'BUILD.md')], steps: done.steps.map(({ startedAt: _s, endedAt: _e, ...s }) => s) };
    const p = view(root, { jobs: [piped], chain, clock });
    expect(p.connected!.nodes.map((n) => [n.name, n.word, n.detail])).toEqual([['check', 'completed', 'exit 0'], ['build', 'completed', 'exit 0'], ['inspect', 'completed', 'exit 0']]);
    expect(p.connected!.runs[0].live).toBe(false);
    const pipedLive = renderWorkflowCard(p, kit({ live: true, base: '../../' }));
    expect(pipedLive).toContain('Its block states were not live: upmd wrote to a pipe and printed each block only when it ended, so no block was seen running and no own time was measured.');
    expect(pipedLive).toContain('its own time was not measured (its block states were not live); the run took 3.0 s for 3 blocks');
    expect(text(workflowSummaryLines(p, { sep: ' · ', link: (rel) => rel, upmd: { version: '0.2.7' } }))).toContain('its block states were not live: upmd wrote to a pipe and printed each block only when it ended');
  });

  it('a failed run: the block that failed with its exit, the blocks after it not run; a stopped run says stopped', () => {
    const root = project();
    const failed = job(root, { id: 'j00a003', target: 'inspect', state: 'failed', exitCode: 1, steps: [{ name: 'check', index: 1, state: 'completed', code: 0 }, { name: 'build', index: 2, state: 'failed', code: 2 }] });
    const c = view(root, { jobs: [failed] }).connected!;
    expect(c.nodes.map((n) => [n.name, n.word, n.detail])).toEqual([['check', 'completed', 'exit 0'], ['build', 'failed', 'exit 2'], ['inspect', 'not run', '']]);
    const live = renderWorkflowCard(view(root, { jobs: [failed] }), kit({ live: true, base: '../../' }));
    expect(live).toContain('build failed with exit 2; upmd stopped the chain there.');
    expect(live).toContain('upmd did not reach it in j00a003 (the chain stopped at build).');
    const stopped = job(root, { id: 'j00a004', target: 'build', state: 'cancelled', steps: [{ name: 'check', index: 1, state: 'completed', code: 0 }, { name: 'build', index: 2, state: 'running' }] });
    expect(view(root, { jobs: [stopped] }).connected!.nodes.map((n) => n.word)).toEqual(['completed', 'stopped', 'not run yet']);
  });

  it("an interrupted run (its job record is stale): interrupted where it was, then not run; /run again, and nothing resumes it", () => {
    const root = project();
    const stale = job(root, { id: 'j00a005', target: 'inspect', state: 'running', endedAt: undefined, stale: true, steps: [{ name: 'check', index: 1, state: 'completed', code: 0 }, { name: 'build', index: 2, state: 'running' }] });
    const w = view(root, { jobs: [stale] });
    expect(w.connected!.nodes.map((n) => n.word)).toEqual(['completed', 'interrupted', 'not run']);
    expect(w.connected!.runs[0]).toMatchObject({ word: 'interrupted', interruptedAt: 'build', orderFrom: 'document', stoppable: false });
    const live = renderWorkflowCard(w, kit({ live: true, base: '../../' }));
    expect(live).toContain('interrupted run');
    expect(live).toContain('The session that ran j00a005 ended while build was running; its process is gone, so how it ended is not known. upmd does not resume a run, and Timmy does not either: /run BUILD.md inspect runs it again from check.');
    // Run again presses the block's own Run (the same /run); the command is shown; nothing says resume
    expect(live).toContain('<button type="button" class="act" data-wf-rerun="3">Run inspect again</button>');
    expect(live).toContain('data-cmd="/run BUILD.md inspect"');
    expect(live).not.toMatch(/resume safely|data-act="resume"/i);
    expect(live).toContain('no outcome was sealed');
    const lines = text(workflowSummaryLines(w, { sep: ' · ', link: (rel) => rel, upmd: null }));
    expect(lines).toContain('Interrupted j00a005');
    expect(lines).toContain('Nothing resumes it: /run BUILD.md inspect runs it again.');
    expect(lines).toContain('upmd is not installed: brew install rezigned/tap/upmd');
  });

  it("a block's state comes from the newest run that included it", () => {
    const root = project();
    const older = job(root, { id: 'j00a006', target: 'check', startedAt: '2026-10-10T09:00:00.000Z', steps: [{ name: 'check', index: 1, state: 'failed', code: 1 }] });
    const newer = job(root, { id: 'j00a007', target: 'build', startedAt: '2026-10-10T09:30:00.000Z', steps: [{ name: 'check', index: 1, state: 'completed', code: 0 }, { name: 'build', index: 2, state: 'completed', code: 0 }] });
    const c = view(root, { jobs: [newer, older] }).connected!;
    expect(c.nodes.map((n) => [n.name, n.word, n.run ?? null])).toEqual([['check', 'completed', 'j00a007'], ['build', 'completed', 'j00a007'], ['inspect', 'not run yet', null]]);
    expect(c.latest).toBe('j00a007');
  });
});

describe('the connected card', () => {
  it('the snapshot: chips and nodes lead to each block\'s details (closed, the anchor inside), every inspector listed, nothing to press', () => {
    const root = project();
    const still = renderWorkflowCard(view(root), kit({ live: false, base: '../../' }));
    const anchor = nodeAnchor('BUILD.md', '2');
    expect(still).toContain(`<a class="wf-chip wfs-notrunyet" href="#${anchor}"`);
    expect(still).toContain(`<a class="wf-node-link" href="#${anchor}"><g class="wf-node">`);
    expect(still.match(/<details class="wf-insp">/g)).toHaveLength(3);
    expect(still).toContain(`<div class="wf-insp-body" id="${anchor}">`);
    expect(still).not.toMatch(/<details class="wf-insp" open/);
    expect(still).not.toMatch(/data-act=|data-wf-select|data-wf-node=|<textarea|<input|<select/);
    // the source one click away: a link to the file and the Markdown as written
    expect(still).toContain('<a class="file" href="../../BUILD.md">BUILD.md</a>');
    expect(still).toContain('open BUILD.md: the Markdown as written');
    // the instructions: prose in order, a project file and an http(s) link
    expect(still).toContain('<h4 class="md-h md-h1">Tray build</h4>');
    expect(still).toContain('<a class="md-a md-file" href="../../box.scad">the model</a>');
    expect(still).toContain('<a class="md-a md-web" href="https://github.com/rezigned/upmd" rel="noopener noreferrer" target="_blank">upmd</a>');
    // the parameter files, read-only, with how they were found
    expect(still).toContain('recipes/tray.params.json: found by a plain match of each file&#39;s path in the command&#39;s text.');
    expect(still).toContain('box.params.json: found by a plain match');
    expect(still).toContain('<span class="param-value">60</span>');
    expect(still).toContain('for box.scad (timmy.scad-params/1)');
  });

  it('live: one Run per block (Run up to here, or Run this block when it needs nothing), node and chip select the same key, the first block shown', () => {
    const root = project();
    const live = renderWorkflowCard(view(root, { tray: () => undefined }), kit({ live: true, base: '../../' }));
    for (const b of ['check', 'build', 'inspect']) expect(live.match(new RegExp(`data-act="run" data-doc="BUILD\\.md" data-block="${b}"`, 'g'))).toHaveLength(1);
    expect(live).toContain('<button type="button" class="act" data-act="run" data-doc="BUILD.md" data-block="check">Run this block</button>');
    expect(live).toContain('<button type="button" class="act" data-act="run" data-doc="BUILD.md" data-block="build">Run up to here</button>');
    expect(live).toContain('Run up to here is /run BUILD.md build: upmd runs check → build, build after the blocks it needs.');
    expect(live).toMatch(/<button type="button" class="act quiet" disabled title="Run this block alone is not offered: upmd runs a block after the blocks it needs, and Timmy does not run a block without them\.">Run this block<\/button>/);
    // the same key on a node, a chip and a panel; the first block is the one shown
    expect(live).toMatch(/<g class="wf-node wf-sel" data-wf-node="1" tabindex="0" role="button" aria-pressed="true"/);
    expect(live).toMatch(/<g class="wf-node" data-wf-node="2" tabindex="0" role="button" aria-pressed="false"/);
    expect(live).toMatch(/<button type="button" class="wf-chip wfs-notrunyet" data-wf-select="2" aria-pressed="false"/);
    expect(live).toContain('<section class="wf-insp" data-wf-insp="1" aria-label="block check">');
    expect(live).toContain('<section class="wf-insp" data-wf-insp="2" hidden aria-label="block build">');
    // the command is editable through save-workflow (the card carries its blocks); the OpenSCAD file is a form
    expect(live).toContain('<textarea class="wf-in wf-cmd wf-cmd-edit" data-wf-cmd="2"');
    expect(live).toContain('data-wf-cmd-save="2" disabled>Save command</button>');
    expect(live).toMatch(/data-scad-params="box\.scad" data-scad-base="[0-9a-f]{64}"/);
    expect(live).toContain('data-scad-param="width" data-kind="number" data-saved="60" value="60"');
    expect(live).toContain('<select class="param-input" data-scad-param="lid" data-kind="boolean" data-saved="true"');
    expect(live).toContain('data-scad-param="part" data-kind="text" data-saved="both" value="both"');
    // the live board serves no files: no link to a project file, the source in a details instead
    expect(live).not.toMatch(/href="\.\.\//);
    expect(live).toContain('<span class="md-a md-file" title="a project file: /open box.scad">the model</span>');
  });

  it('names, commands and prose are escaped everywhere on the card', () => {
    const root = project();
    const evil = ['# <img src=x onerror=alert(1)>', '', `${F}bash [name:x<b>]`, 'echo "<script>alert(1)</script>"', F, ''].join('\n');
    const w = connectWorkflow(workflowForBoard('E<vil>.md', { text: evil, sha256: sha(evil) }), { root, jobs: [], chain: [], files: [] });
    for (const k of [kit({ live: true, base: '../../' }), kit({ live: false, base: '../../' })]) {
      const html = renderWorkflowCard(w, k);
      expect(html).not.toMatch(/<script|<img|<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('x&lt;b&gt;');
    }
  });

  it('a block whose needs are missing or loop is not offered a Run, and says why as /run does', () => {
    const root = project();
    const bad = [`${F}bash [name:a, deps:ghost]`, 'true', F, '', `${F}bash [name:b, deps:c]`, 'true', F, '', `${F}bash [name:c, deps:b]`, 'true', F, ''].join('\n');
    const w = connectWorkflow(workflowForBoard('BAD.md', { text: bad, sha256: sha(bad) }), { root, jobs: [], chain: [], files: [] });
    const live = renderWorkflowCard(w, kit({ live: true, base: '../../' }));
    expect(live).not.toContain('data-act="run"');
    expect(live).toContain('Not runnable as it is: it needs ghost, which BAD.md does not define. /run refuses it the same way; nothing runs.');
    expect(live).toContain('Not runnable as it is: its needs loop (b → c → b).');
  });
});

describe("the live page's part", () => {
  it('is inlined in the editor script, parses, and carries no control character a template escape could have made', () => {
    expect(EDIT_SCRIPT).toContain(WORKFLOW_SCRIPT);
    expect(() => new Function(EDIT_SCRIPT)).not.toThrow();
    expect(EDIT_SCRIPT).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
    // it sends only the two edits the server checks, and never an action of its own (Stop and Run again press the board's buttons)
    expect([...WORKFLOW_SCRIPT.matchAll(/action: '([a-z-]+)'/g)].map((m) => m[1]).sort()).toEqual(['save-workflow', 'set-scad-params']);
    expect(WORKFLOW_SCRIPT).not.toContain('/action');
    expect(WORKFLOW_SCRIPT).not.toMatch(/innerHTML|localStorage|sessionStorage|document\.cookie|eval\(/);
  });

  it('the states it sets in place: each block\'s, and the newest run\'s (key \'\')', () => {
    const root = project();
    const running = job(root, { id: 'j00a009', target: 'build', state: 'running', endedAt: undefined, steps: [{ name: 'check', index: 1, state: 'completed', code: 0 }, { name: 'build', index: 2, state: 'running' }] });
    expect(liveNodeStates([view(root, { jobs: [running] })])).toEqual([
      { doc: 'BUILD.md', key: '1', word: 'completed', glyph: '✓', detail: 'exit 0' },
      { doc: 'BUILD.md', key: '2', word: 'running', glyph: '●', detail: '' },
      { doc: 'BUILD.md', key: '3', word: 'not run yet', glyph: '·', detail: '' },
      { doc: 'BUILD.md', key: '', word: 'running', glyph: '●', detail: '' },
    ]);
  });
});
