/**
 * Round R4 (helper H107; r25, the scripted rehearsal on the operator's Mac at 5e5cbb3, findings D2, D3, D8 and the `timmy md`
 * part of D4): a /run whose request made no change has one outcome, "no change", said the same way in every place a person
 * reads it, and upmd's own verdict (it counts any non-zero exit as a failed block) is kept on record as its own field, in
 * words as "upmd counted it as failed", never as the run's outcome.
 *
 * r25 (U7, the stale case): Timmy's end line said "= ja8e289 no change … (upmd counted the block as failed: exit 4)" and /jobs
 * "no change (upmd counted it as failed)", but the block's progress line said "change failed · 1 of 3", the block receipt
 * held outcome "no change" with state "failed", the workflow receipt said "failed" and `timmy md --json` gave job state
 * failed. U6 (the satisfied case): the board's Jobs section listed the run COMPLETED while every other view said no change;
 * and the board's contents said "Overview" for the section headed "God's Eye View" (D8). D4: `timmy md` ran only the current
 * folder's workflow, so a launcher that starts each command in a folder of its own could not name a project's.
 *
 * Here the same shapes run for real, on a pty as on the Mac (workers/upmd/pty_run.py under this machine's python3): a /run
 * whose change block calls a real `timmy act '/iterate scad …' --wait`, four times: the request made; the same request again
 * (no change, the last build current: every block exits 0); again after the parameter file was changed by hand (no change,
 * the last build stale: the change block exits 4, and upmd counts it as failed and stops its chain); and once more by
 * `timmy md --json --project <dir>` from another folder.
 *
 * FAKE pieces, each labelled (as tests/no-change-run.test.ts uses them):
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour, in its pty mode; it is not upmd);
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent) as Qwen Code on a local
 *   endpoint; its PYREPLACE word edits the parameter file, and changes nothing when what it replaces is not there;
 * - OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE with no geometry engine: a box sized by -D values).
 * The `timmy` each block runs and `timmy md` are the real CLI; the live board's page is drawn by a real headless Chromium
 * (skipped, and said, when none is found). Every folder is under os.tmpdir().
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { BOARD_FILE } from '../src/repl/board.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain, verifyChain, type Receipt } from '../src/utils/receipts.js';
import { FAKE_UPMD, json, opsKit, sandbox as opsSandbox, text, type OpsKit, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

const g = glyphSet(true);
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p): p is string => Boolean(p) && fs.existsSync(p!));
if (!PYTHON3) console.warn('run-words-agree: no python3 here, so the run on a pty (as on the Mac) is skipped');
if (!browserPath) console.warn('run-words-agree: no Chromium found, so the live board\'s page is not drawn here');

const F = '```';
const WORKFLOW = [
  '# FAKE workflow for the run-words test',
  '',
  `${F}bash [name:change]`,
  'timmy act \'/iterate scad box.scad "make it 100 wide PYFILE:box.params.json PYREPLACE:60,=>100,"\' --wait',
  F,
  '',
  `${F}bash [name:inspect, deps:change]`,
  'echo inspect ran on the last build',
  F,
  '',
  `${F}bash [name:result, deps:inspect]`,
  'echo result ran',
  F,
  '',
].join('\n');

/** The REPL of a sandbox (as tests/helpers/ops-sandbox.ts replOf), with python3 on its PATH: upmd runs on a pty, as on the Mac. */
function replOnPty(k: OpsKit, s: Sandbox): { ws: Workspace; notes: string[] } {
  for (const key of ['PATH', 'HOME', 'TIMMY_HOME', 'TIMMY_STORE', 'TIMMY_AGENT_QWEN_BIN', 'TIMMY_AGENT_MODEL', 'TIMMY_OPENSCAD', 'NO_COLOR'] as const) vi.stubEnv(key, s.env[key] ?? '');
  vi.stubEnv('TIMMY_OPERATION', '');
  const notes: string[] = [];
  const ws = new Workspace({
    glyphs: g, env: { ...process.env, UPMD_BIN: FAKE_UPMD }, onPath: (cmd) => (cmd === 'python3' ? PYTHON3 : null),
    notify: (l) => notes.push(l.map((x) => x.text).join('')), openWeb: (u) => u, link: (t) => t,
    seal: (input) => appendReceipt('runs', input, s.root).hash.slice(7, 15), receipts: () => readChain('runs', s.root),
    jobsDir: path.join(s.home, 'timmy', 'jobs'), chdir: () => {}, recoverAtStart: false, roomTools: async () => [],
  }, folderProject(s.root));
  k.spaces.push(ws);
  return { ws, notes };
}

type Block = Receipt & { block: Record<string, unknown> };
const blockReceipt = (chain: Receipt[], job: string, name: string): Block | undefined =>
  chain.find((r) => r.kind === 'workflow-block' && (r as Block).block?.run === job && (r as Block).block?.name === name) as Block | undefined;
const runReceipt = (chain: Receipt[], job: string): Receipt | undefined => chain.find((r) => r.kind === 'workflow' && r.job?.id === job);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe.skipIf(!PYTHON3)('a /run that made no change, on a pty as on the Mac: one outcome in every place (FAKE upmd, agent and OpenSCAD)', () => {
  it('the progress line, the end line, /jobs, /op, /room, God\'s Eye View, the board\'s Jobs section, both receipts and timmy md --json --project say no change; upmd\'s verdict is its own field', async () => {
    const s = opsSandbox(kit, 'run-words-');
    const { ws, notes } = replOnPty(kit, s);
    const { root } = s;
    fs.writeFileSync(path.join(root, 'WORKFLOW.md'), WORKFLOW);
    const run = async (): Promise<{ job: string; op: string }> => {
      const started = text(await ws.operate('/run WORKFLOW.md result', 'repl', () => ws.run('WORKFLOW.md result')));
      const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
      expect(job, started).toBeDefined();
      // as on the Mac: upmd on a terminal of its own, so each block's state comes as it happens
      expect(started).not.toContain('Live block states are not available');
      const h = ws.ops.latest!;
      await ws.jobs.done(job!);
      await ws.ops.done(h);
      return { job: job!, op: h.id };
    };

    // 1. The request, made: the flow changes the width 60 → 100 and OpenSCAD builds it.
    const first = await run();
    expect(ws.jobs.get(first.job)!.state, ws.jobs.tail(first.job, 200).join('\n')).toBe('completed');

    // 2. The same request again (U6): the agent changes nothing and the last build still matches its inputs, so the change
    //    block exits 0 and the blocks after it run on that build.
    const second = await run();
    const job2 = ws.jobs.get(second.job)!;
    expect(job2.state, ws.jobs.tail(second.job, 300).join('\n')).toBe('completed'); // upmd's own end: every block exited 0
    expect(job2.steps.map((x) => [x.name, x.state, x.code, x.outcome ?? ''])).toEqual([['change', 'completed', 0, 'no change'], ['inspect', 'completed', 0, ''], ['result', 'completed', 0, '']]);
    // D2: the board's Jobs section (the snapshot) says no change, as every other view does, never COMPLETED
    ws.board('');
    const snap2 = fs.readFileSync(path.join(root, BOARD_FILE), 'utf8');
    expect.soft(snap2).toContain(`<strong>${second.job}</strong> <span class="state state-nochange">no change</span>`);
    expect.soft(snap2).not.toContain(`<strong>${second.job}</strong> <span class="state state-completed">`);
    // D8: its table of contents names the section as its heading does
    expect.soft(snap2).toMatch(/<a href="#overview">God(?:'|&#39;)s Eye View <b>/);
    expect.soft(snap2).not.toMatch(/<a href="#overview">Overview\b/);
    // D3: the run's own receipt: no change, with upmd's verdict as its own (it exited 0, every block completed)
    const r2 = runReceipt(readChain('runs', root), second.job)!;
    expect(r2).toBeDefined();
    expect.soft(r2.subject).toBe('workflow · WORKFLOW.md › result · no change');
    expect.soft(r2.status).toBeUndefined(); // neither ok (nothing was changed) nor failed
    expect.soft(r2.job).toMatchObject({ state: 'no change', exit_code: 0, upmd: { state: 'completed', exit_code: 0 } });

    // 3. The parameter file changed by hand, and the same request again (U7): the agent changes nothing and the last build is
    //    stale, so the change block exits 4; upmd counts it as failed and runs nothing after it.
    const params = path.join(root, 'box.params.json');
    fs.writeFileSync(params, fs.readFileSync(params, 'utf8').replace('"width": 100', '"width": 120'));
    const third = await run();
    const job3 = ws.jobs.get(third.job)!;
    const log3 = ws.jobs.tail(third.job, 400).join('\n');
    expect(job3.state, log3).toBe('failed'); // upmd's own end, kept as it is in the job's record
    expect(job3.steps.map((x) => [x.name, x.state, x.code, x.outcome ?? ''])).toEqual([['change', 'failed', 4, 'no change']]);
    const said = notes.join('\n');
    // the block's progress line: no change, why in a few words, upmd's own word beside it; never "change failed"
    expect.soft(said).toMatch(new RegExp(`^ {2}${esc(g.bullet)} ${third.job} {2}change no change: the last build is stale \\(upmd counted it as failed: exit 4\\) · 1 of 3 · block change: receipt [0-9a-f]{8} · flow f[0-9a-f]{8}: `, 'm'));
    expect.soft(said).not.toMatch(new RegExp(`${third.job} {2}change failed`));
    // the end line
    const end3 = notes.find((n) => n.includes(`= ${third.job} no change`));
    expect.soft(end3).toMatch(new RegExp(`^ {2}= ${third.job} no change {2}operation ${third.op} · the last build is stale: stopped at change, which made no change \\(upmd counted it as failed: exit 4\\) · WORKFLOW\\.md › result · 1 of 3 steps; change no change, exit 4; inspect, result not run · `));
    expect.soft(said).not.toContain(`${third.job} failed`);
    // /jobs and /jobs <id>
    expect.soft(text(ws.jobsView(''))).toMatch(new RegExp(`= ${third.job} +no change`));
    expect.soft(text(ws.jobsView(third.job))).toMatch(/= change {2}no change \(upmd counted it as failed: exit 4\)/);
    // /op, /room and God's Eye View
    expect.soft(text(ws.op(third.op))).toMatch(new RegExp(`Operation ${third.op}\\s+no change`));
    const room = text(await ws.room(''));
    expect.soft(room).toMatch(new RegExp(`= ${third.job}  upmd \\(a workflow run\\)  no change`));
    // its run's lines say "failed" only as upmd's own word
    for (const l of room.split('\n').filter((x) => x.includes(third.job))) expect.soft(l.replace(/upmd counted it as failed/g, ''), l).not.toContain('failed');
    const overview = JSON.parse(text(await ws.overview('--json'))) as { workflows: { items: Array<{ doc: string; last_run?: { job: string; word: string } }> } };
    expect.soft(overview.workflows.items.find((i) => i.doc === 'WORKFLOW.md')?.last_run).toMatchObject({ job: third.job, word: 'no change' });
    // the board's Jobs section (the snapshot)
    ws.board('');
    const snap3 = fs.readFileSync(path.join(root, BOARD_FILE), 'utf8');
    expect.soft(snap3).toContain(`<strong>${third.job}</strong> <span class="state state-nochange">no change</span>`);
    expect.soft(snap3).not.toContain(`<strong>${third.job}</strong> <span class="state state-failed">`);
    // the block's receipt: Timmy's word, with upmd's verdict as its own field; no status (neither ok nor failed)
    const chain3 = readChain('runs', root);
    const b3 = blockReceipt(chain3, third.job, 'change')!;
    expect(b3).toBeDefined();
    expect.soft(b3.subject).toBe('workflow · block · WORKFLOW.md › result · change · no change');
    expect.soft(b3.status).toBeUndefined();
    expect.soft(b3.block).toMatchObject({ state: 'no change', outcome: 'no change', exit_code: 4, upmd: { state: 'failed', exit_code: 4 }, no_change: { last_build: 'stale' } });
    // the run's own receipt: no change (never "failed"), upmd's verdict on the run as its own field, each step the same way
    const r3 = runReceipt(chain3, third.job)!;
    expect(r3).toBeDefined();
    expect.soft(r3.subject).toBe('workflow · WORKFLOW.md › result · no change');
    expect.soft(r3.status).toBeUndefined();
    expect.soft(r3.job).toMatchObject({ state: 'no change', exit_code: 1, upmd: { state: 'failed', exit_code: 1 } });
    expect.soft(r3.job?.steps?.[0]).toMatchObject({ name: 'change', state: 'no change', code: 4, upmd: { state: 'failed', exit_code: 4 } });
    // `timmy verify`'s check of the chain still holds with these fields
    expect(verifyChain('runs', root)).toMatchObject({ ok: true });

    // The live board in a real browser: its Jobs section and its contents
    if (browserPath) {
      await ws.boardLive('live');
      const browser = await chromium.launch({ headless: true, executablePath: browserPath });
      try {
        const page = await (await browser.newContext()).newPage();
        const problems: string[] = [];
        page.on('pageerror', (e) => problems.push(String(e)));
        await page.goto(ws.liveBoard!.url);
        await page.waitForSelector(`[data-job-card="${third.job}"] .state`);
        for (const job of [second.job, third.job]) {
          const st = page.locator(`[data-job-card="${job}"] .state`);
          expect.soft(await st.textContent(), job).toBe('no change');
          // the page draws a state word in capitals (CSS): what a person reads
          expect.soft(await st.innerText(), job).toBe('NO CHANGE');
        }
        // the contents name the section as its heading does (drawn in capitals, as the headings are)
        const toc = page.locator('#toc a[href="#overview"]');
        expect.soft(await toc.textContent()).toMatch(/^God's Eye View\b/);
        expect.soft(await toc.innerText()).toMatch(/^GOD'S EYE VIEW\b/);
        expect.soft(await page.locator('h2#overview').innerText()).toMatch(/^GOD'S EYE VIEW\b/);
        expect(problems).toEqual([]);
      } finally {
        await browser.close();
      }
    }

    // 4. `timmy md --json --project <dir>` from another folder (D4): the same run, the same words, exit 4 (no change, stale)
    const md = spawn(path.join(s.bin, 'timmy'), ['md', 'WORKFLOW.md', 'result', '--project', root, '--json'], { cwd: s.base, env: { ...s.env, UPMD_BIN: FAKE_UPMD }, stdio: ['ignore', 'pipe', 'pipe'] });
    kit.children.push(md);
    let stdout = '';
    let stderr = '';
    md.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    md.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    const code = await new Promise<number | null>((resolve) => md.on('close', (c) => resolve(c)));
    expect.soft(code, `${stdout}\n${stderr}`).toBe(4);
    const out = (() => { try { return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>; } catch { return {}; } })();
    expect.soft(out).toMatchObject({ schema: 'timmy.md/1', project: path.basename(root), outcome: 'no change', exit_code: 4, job: { state: 'no change', upmd: { state: 'failed', exit_code: 1 } } });
    expect.soft((out.blocks as unknown[] | undefined)?.[0]).toMatchObject({ name: 'change', state: 'no change', exit_code: 4, upmd: { state: 'failed', exit_code: 4 } });
    // its receipts: the block's and the run's, neither with a status
    const kinds = (out.receipts as Array<{ kind: string; status?: string }> | undefined) ?? [];
    expect.soft(kinds.filter((r) => r.kind === 'workflow' || r.kind === 'workflow-block')).toEqual([{ id: expect.any(String), kind: 'workflow-block' }, { id: expect.any(String), kind: 'workflow' }]);
    // its progress line on stderr says no change, never failed
    expect.soft(stderr).toMatch(/ {2}\S+ j[0-9a-f]{6} {2}change no change: the last build is stale \(upmd counted it as failed: exit 4\) · 1 of 3 · /);
    expect.soft(stderr).not.toMatch(/ {2}change failed/);
    // the run it made is this project's
    const mdOp = String(out.operation ?? '');
    if (mdOp) expect.soft(json(path.join(root, '.timmy', 'operations', `${mdOp}.json`))).toMatchObject({ state: 'no change' });
  }, 360_000);
});
