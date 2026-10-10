// Round R4 (H47): the connected workflow card on the live board, over real HTTP to the Workspace's live board on
// 127.0.0.1, with real files in temporary projects: the set-scad-params edit, a run whose blocks' states come from the
// run job's events, each block's results after it, an interrupted run, and /workflows <file> in the REPL.
// FAKE pieces, each a labelled test double: tests/fixtures/fake-upmd.mjs (it is not upmd: it reproduces upmd 0.2.7's
// observed --ci protocol); tests/fixtures/fake-code-agent.mjs (it is not a code agent: here it only sleeps in a flow's
// agent step); TIMMY_CADQUERY_PYTHON names a FAKE program that is never run; the stale job record of the interrupted run
// is written by hand in the shape src/jobs writes. No paid call, no network.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import type { LiveState } from '../src/repl/board-live.js';
import { saveScadParams } from '../src/repl/board-edits.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
// R4 (H58): this machine's python3, which runs upmd (here the test double) on a pty through workers/upmd/pty_run.py
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
const withPython = { onPath: (cmd: string): string | null => (cmd === 'python3' ? PYTHON3 : null) };
const F = '```';
const DOC = [
  '# Tray build', '', 'The blocks read `box.params.json` and write `dist/`.', '',
  `${F}bash [name:setup]`, 'mkdir -p dist', F, '',
  `${F}bash [name:build, deps:setup]`, 'cat box.params.json > /dev/null', 'sleep 1.6', 'echo built > dist/out.txt', F, '',
  `${F}sh [name:verify, deps:build]`, 'test -f dist/out.txt', F, '',
].join('\n');
const PARAMS = { width: 60, part: 'both', lid: true };
const paramsText = (p: Record<string, unknown>): string => `${JSON.stringify({ schema: 'timmy.scad-params/1', model: 'box.scad', parameters: p }, null, 2)}\n`;
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
async function until(pred: () => boolean | Promise<boolean>, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = temp('board-wfx-');
  put(root, 'BUILD.md', DOC);
  put(root, 'box.scad', 'width = 60;\npart = "both";\nlid = true;\ncube([width, 40, 10]);\n');
  put(root, 'box.params.json', paramsText(PARAMS));
  return root;
}
function make(root: string, extra: Partial<WorkspaceDeps> = {}, jobsDir = join(temp('jobs-'), 'jobs')) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { UPMD_BIN: FAKE_UPMD }, onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
    // the short id each seal returns is the one the receipts below carry (sha256:<8 hex>…)
    seal: (input) => { sealed.push(input); return String(sealed.length - 1).padStart(8, '0'); },
    jobsDir, chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed, jobsDir };
}

interface Reply { status: number; body: string }
function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) }, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
async function live(ws: Workspace): Promise<{ port: number; token: string }> {
  await ws.boardLive('live');
  const lb = ws.liveBoard!;
  return { port: lb.port, token: lb.url.split('#t=')[1] };
}
const json = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const edit = (port: number, token: string, body: unknown): Promise<Reply> => raw(port, { method: 'POST', path: '/edit', headers: json(token), body: JSON.stringify(body) });
const act = (port: number, token: string, body: unknown): Promise<Reply> => raw(port, { method: 'POST', path: '/action', headers: json(token), body: JSON.stringify(body) });
async function state(port: number, token: string): Promise<LiveState> {
  const r = await raw(port, { path: '/state', headers: { Authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as LiveState;
}
/** A node's state line on the graph, as the live board draws it: "<glyph> <word>[ · detail]". */
const unescapeHtml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const nodeState = (html: string, key: string): string | undefined => {
  const m = new RegExp(`data-wf-node="${key}"[^>]*>[\\s\\S]*?<text class="wf-state [^"]*"[^>]*>([^<]*)</text>`).exec(html);
  return m ? unescapeHtml(m[1]) : undefined;
};
const kept = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name))); };
  walk(join(root, '.timmy', 'params-history'));
  return out;
};

describe('set-scad-params: an OpenSCAD model\'s parameter file, saved from the inspector', () => {
  it('saves typed values: the file rewritten, the previous kept, an edit receipt; the card is drawn again from it', async () => {
    const root = project();
    const { ws, notes, sealed } = make(root);
    const { port, token } = await live(ws);
    const s = await state(port, token);
    expect(s.scadModels).toEqual(['box.scad']);
    const before = readFileSync(join(root, 'box.params.json'));
    expect(s.html).toContain(`data-scad-params="box.scad" data-scad-base="${sha(before)}"`);
    const r = await edit(port, token, { action: 'set-scad-params', model: 'box.scad', base: sha(before), parameters: { width: 80, part: 'lid', lid: false } });
    expect(r.status).toBe(200);
    const after = readFileSync(join(root, 'box.params.json'));
    expect(JSON.parse(after.toString())).toEqual({ schema: 'timmy.scad-params/1', model: 'box.scad', parameters: { width: 80, part: 'lid', lid: false } });
    const keptAt = /the previous version is kept at (\.timmy\/params-history\/scad\/box\.params\.json\/[^;]+\.json);/.exec(r.body)?.[1];
    expect(keptAt).toBeDefined();
    expect(readFileSync(join(root, keptAt!))).toEqual(before);
    expect(r.body).toBe(`Saved box.params.json: width 60 → 80, part "both" → "lid", lid true → false. sha256 ${sha(after).slice(0, 12)} (was ${sha(before).slice(0, 12)}); the previous version is kept at ${keptAt}; receipt 00000000. /scad box.scad takes these values.`);
    expect(sealed[0]).toMatchObject({ kind: 'edit', status: 'ok', files: [{ path: 'box.params.json', sha256: sha(after), previous_sha256: sha(before), created: false }], sources: [{ path: keptAt, sha256: sha(before), role: 'previous version' }] });
    expect(notes).toContain('  board  saved box.params.json: width 60 → 80, part "both" → "lid", lid true → false · receipt 00000000');
    expect((await state(port, token)).html).toContain(`data-scad-base="${sha(after)}"`);
    // the same values again: no change, nothing written, no receipt
    const same = await edit(port, token, { action: 'set-scad-params', model: 'box.scad', base: sha(after), parameters: { width: 80, part: 'lid', lid: false } });
    expect(same).toMatchObject({ status: 200 });
    expect(same.body).toContain('No change: box.params.json already holds');
    expect(sealed).toHaveLength(1);
    expect(r.body + same.body).not.toContain(root);
  });

  it('refuses a stale file, a changed kind, changed names, a value the rules refuse, a model the board does not show, and writes nothing', async () => {
    const root = project();
    put(root, 'other.scad', 'cube(1);\n');
    put(root, 'other.params.json', `${JSON.stringify({ schema: 'timmy.scad-params/1', model: 'other.scad', parameters: { a: 1 } })}\n`);
    const { ws, sealed } = make(root);
    const { port, token } = await live(ws);
    const base = sha(readFileSync(join(root, 'box.params.json')));
    const cases: Array<[unknown, number, string]> = [
      [{ action: 'set-scad-params', model: 'box.scad', base: 'ab'.repeat(32), parameters: PARAMS }, 409, `box.params.json changed since the board showed it (it is now sha256 ${base.slice(0, 12)}); nothing was written.`],
      [{ action: 'set-scad-params', model: 'box.scad', base, parameters: { ...PARAMS, width: '80' } }, 422, 'Refused: width is a number in box.params.json, and "80" is text: the board keeps each parameter\'s kind.'],
      [{ action: 'set-scad-params', model: 'box.scad', base, parameters: { ...PARAMS, lid: 'yes' } }, 422, 'lid is true or false in box.params.json'],
      [{ action: 'set-scad-params', model: 'box.scad', base, parameters: { width: 80, part: 'both' } }, 400, 'The parameters of box.params.json are width, part, lid, each once: the board changes values, not names.'],
      [{ action: 'set-scad-params', model: 'box.scad', base, parameters: { ...PARAMS, height: 3 } }, 400, 'the board changes values, not names'],
      [{ action: 'set-scad-params', model: 'box.scad', base, parameters: { ...PARAMS, part: 'a\nb' } }, 422, 'part: text with a control character'],
      [{ action: 'set-scad-params', model: 'other.scad', base, parameters: { a: 2 } }, 404, 'No OpenSCAD parameter card for other.scad on this board.'],
      [{ action: 'set-scad-params', model: '../box.scad', base, parameters: PARAMS }, 404, 'No OpenSCAD parameter card'],
      [{ action: 'set-scad-params', model: 'box.scad', base, parameters: PARAMS, path: '/etc/passwd' }, 400, 'An OpenSCAD parameter save is'],
      [{ action: 'set-scad-params', model: 'box.scad', base: 'x', parameters: PARAMS }, 400, 'base is the 64 hex characters'],
    ];
    for (const [body, status, says] of cases) {
      const r = await edit(port, token, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.body, JSON.stringify(body)).toContain(says);
    }
    // a number too large to be finite (1e400 reads back as Infinity): refused by the scad-params rules
    const huge = await raw(port, { method: 'POST', path: '/edit', headers: json(token), body: `{"action":"set-scad-params","model":"box.scad","base":"${base}","parameters":{"width":1e400,"part":"both","lid":true}}` });
    expect(huge.status).toBe(422);
    expect(huge.body).toContain('Refused: width must be a finite number. Nothing was written');
    expect(readFileSync(join(root, 'box.params.json'), 'utf8')).toBe(paramsText(PARAMS));
    expect(kept(root)).toEqual([]);
    expect(sealed).toEqual([]);
  });

  it('a parameter file that is a link, or that does not check, is shown as not usable and never saved over', async () => {
    const root = project();
    const outside = temp('board-wfx-outside-');
    put(outside, 'real.json', paramsText(PARAMS));
    rmSync(join(root, 'box.params.json'));
    symlinkSync(join(outside, 'real.json'), join(root, 'box.params.json'));
    const { ws, sealed } = make(root);
    const { port, token } = await live(ws);
    const html = (await state(port, token)).html;
    expect(html).toContain('<strong>not usable</strong>');
    expect(html).not.toContain('data-scad-base=');
    const r = await edit(port, token, { action: 'set-scad-params', model: 'box.scad', base: sha(paramsText(PARAMS)), parameters: PARAMS });
    expect(r.status).toBe(422);
    expect(r.body).toContain('box.params.json is not usable: box.params.json leads outside the project. Nothing was written');
    expect(lstatSync(join(root, 'box.params.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'real.json'), 'utf8')).toBe(paramsText(PARAMS));
    expect(sealed).toEqual([]);
  });

  it('refused with 409 while an /iterate flow runs in the project, before anything is read; taken once it has ended', async () => {
    const root = project();
    const fakes = temp('board-wfx-fakes-');
    const fakePython = join(fakes, 'python');
    writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: never run by this test"\nexit 1\n', { mode: 0o755 });
    const { ws, notes, sealed } = make(root, { env: { UPMD_BIN: FAKE_UPMD, TIMMY_AGENT_QWEN_BIN: resolve('tests/fixtures/fake-code-agent.mjs'), TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: fakePython } });
    const { port, token } = await live(ws);
    const base = sha(readFileSync(join(root, 'box.params.json')));
    const out = text(await ws.iterate('tray "SLEEP"'));
    const id = /Flow\s+(f[0-9a-f]{8})/.exec(out)![1];
    const agent = /Agent\s+(j[0-9a-f]{6})/.exec(out)![1];
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    const seals = sealed.length;
    const r = await edit(port, token, { action: 'set-scad-params', model: 'box.scad', base, parameters: { ...PARAMS, width: 90 } });
    expect(r).toEqual({ status: 409, body: `flow ${id} is running in this project: save after it ends, or /stop it` });
    expect(notes).toContain(`  board  refused an OpenSCAD parameter save: flow ${id} is running in this project`);
    expect(readFileSync(join(root, 'box.params.json'), 'utf8')).toBe(paramsText(PARAMS));
    expect(sealed).toHaveLength(seals);
    expect(text(await ws.stop(id))).toContain(`${id} cancelled`);
    const ok = await edit(port, token, { action: 'set-scad-params', model: 'box.scad', base, parameters: { ...PARAMS, width: 90 } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, 'box.params.json'), 'utf8')).parameters.width).toBe(90);
    // a flow still being started refuses it the same way (the edit itself, with the context's flowIn)
    expect(saveScadParams({ action: 'set-scad-params', model: 'box.scad', base, parameters: PARAMS }, { root, project: 'p', projectId: 'p', workflows: [], recipes: [], scadModels: ['box.scad'], flowIn: () => ({ step: 'prepare' }) }))
      .toEqual({ status: 409, text: 'a flow is being started in this project: save after it ends, or /stop it', line: 'refused an OpenSCAD parameter save: a flow is being started in this project' });
  }, 60_000);
});

describe('a run on the live board: the blocks\' states come from the run job\'s events (test-double upmd)', () => {
  // R4 (H58): through the pty wrapper (python3), as /run runs upmd wherever python3 works: each block's own time is real
  it.skipIf(!PYTHON3)('Run up to here on verify: setup completed, build running, verify waiting, then each completed with its exit, its own time and what the run wrote', async () => {
    const root = project();
    const { ws, sealed } = make(root, withPython);
    const { port, token } = await live(ws);
    const first = (await state(port, token)).html;
    expect(nodeState(first, '1')).toBe('· not run yet');
    expect(first).toContain('No run of BUILD.md yet.');
    const ran = await act(port, token, { action: 'run', doc: 'BUILD.md', block: 'verify' });
    expect(ran.status).toBe(200);
    expect(ran.body.split('\n')[0]).toBe('board /run BUILD.md verify');
    const job = ws.jobs.list().find((j) => j.label === 'BUILD.md › verify')!;
    // while build runs (it sleeps 1.6 s), the board says so in words, from the job's steps (stepsFromEvent)
    let during = '';
    await until(async () => { during = (await state(port, token)).html; return nodeState(during, '2') === '● running'; }, 15_000);
    expect(nodeState(during, '1')).toMatch(/^✓ completed · exit 0 · (<0\.1 s|\d+\.\d s)$/);
    expect(nodeState(during, '3')).toBe('○ waiting');
    expect(during).toContain(`<strong class="wfx-run-job">${job.id}</strong>`);
    expect(during).toContain('setup completed, build running, verify waiting');
    expect(during).toContain(`data-wf-stop="${job.id}"`);
    expect(during).toMatch(/<span class="wf-chip-state">running<\/span>/);
    // when it ends: each block completed, with its exit and its own time; the run's sealed outcome
    const ended = await ws.jobs.done(job.id);
    expect(ended.receipt).toBe('00000001');
    const after = (await state(port, token)).html;
    expect(nodeState(after, '1')).toMatch(/^✓ completed · exit 0 · (<0\.1 s|\d+\.\d s)$/);
    expect(nodeState(after, '2')).toMatch(/^✓ completed · exit 0 · (1\.[6-9]|[2-9]\.\d) s$/);
    expect(nodeState(after, '3')).toMatch(/^✓ completed · exit 0/);
    expect(after).not.toContain(`data-wf-stop="${job.id}"`);
    const outcome = sealed.find((r) => r.kind === 'workflow')!;
    expect(outcome).toMatchObject({ job: { id: job.id, state: 'completed' }, prediction: { order: ['setup', 'build', 'verify'], met: true } });
    expect(after).toContain(`outcome receipt ${ended.receipt}`);
    expect(after).toContain('its sealed prediction was met');
    // each block's last result names the run and the files it wrote (from the sealed outcome), as text on the live board
    expect(after).toContain('<span class="file">dist/out.txt</span> <span class="tier">as the run wrote it</span>');
    // the REPL says the same in text
    const lines = text(await ws.workflows('BUILD.md'));
    expect(lines).toMatch(/1 setup +bash +✓ completed exit 0/);
    expect(lines).toMatch(/2 build +bash +needs setup +✓ completed exit 0 · (1\.[6-9]|[2-9]\.\d) s/);
    expect(lines).toContain(`Last run  ${job.id}  verify (setup → build → verify) · completed`);
    expect(lines).toContain('OpenSCAD parameters box.params.json  width 60, part "both", lid true · for box.scad');
    expect(lines).toContain('found by a plain match of its path in the command');
    expect(lines).toContain('/run BUILD.md verify  (setup → build → verify)');
    expect(JSON.stringify(await state(port, token))).not.toContain(root);
    expect(JSON.stringify(await state(port, token))).not.toContain(homedir());
  }, 40_000);

  it('a failing block: failed with its exit code, the block after it not run, the chain stopped there', async () => {
    const root = project();
    put(root, 'BUILD.md', DOC.replace('cat box.params.json > /dev/null\nsleep 1.6\necho built > dist/out.txt', 'echo failing; exit 3'));
    const { ws } = make(root);
    const { port, token } = await live(ws);
    await act(port, token, { action: 'run', doc: 'BUILD.md', block: 'verify' });
    const job = ws.jobs.list().find((j) => j.label === 'BUILD.md › verify')!;
    await ws.jobs.done(job.id);
    const html = (await state(port, token)).html;
    expect(nodeState(html, '1')).toMatch(/^✓ completed · exit 0/);
    expect(nodeState(html, '2')).toMatch(/^✕ failed · exit 3/);
    expect(nodeState(html, '3')).toBe('– not run');
    expect(html).toContain('build failed with exit 3; upmd stopped the chain there.');
    expect(html).toContain('its sealed prediction was missed');
  }, 30_000);
});

describe('an interrupted run: a job record whose session ended while it ran', () => {
  it('is shown as interrupted at its block, with /run again; nothing resumes it, on the board and in the REPL', async () => {
    const root = project();
    const jobsDir = join(temp('jobs-'), 'jobs');
    mkdirSync(jobsDir, { recursive: true });
    // A pid that ran and is gone: the record's process is not there, so the manager reads it as stale.
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(join(jobsDir, 'j0dead1.json'), `${JSON.stringify({
      id: 'j0dead1', kind: 'workflow', label: 'BUILD.md › verify', project: 'demo', root, command: FAKE_UPMD,
      args: ['--ci', '-b', 'verify', '-d', root, join(root, 'BUILD.md')], state: 'running', pid: gone, startedAt: '2026-10-10T09:00:00.000Z',
      steps: [{ name: 'setup', index: 1, state: 'completed', code: 0 }, { name: 'build', index: 2, state: 'running' }], lines: 3,
    }, null, 2)}\n`);
    writeFileSync(join(jobsDir, 'j0dead1.log'), '');
    const { ws } = make(root, {}, jobsDir);
    expect(ws.jobs.get('j0dead1')).toMatchObject({ stale: true });
    const { port, token } = await live(ws);
    const html = (await state(port, token)).html;
    expect(nodeState(html, '1')).toBe('✓ completed · exit 0');
    expect(nodeState(html, '2')).toBe('! interrupted');
    // R4 (H67, r20): nothing proves upmd stopped before verify: not seen, never "not run"
    expect(nodeState(html, '3')).toBe('◌ not seen');
    expect(html).toContain('interrupted run');
    expect(html).toContain('The session that ran j0dead1 ended while build was running; its process is gone, so how it ended is not known; verify not seen: its REPL had ended, and upmd may have gone on until it ended. upmd does not resume a run, and Timmy does not either: /run BUILD.md verify runs it again from setup.');
    expect(html).toContain('<button type="button" class="act" data-wf-rerun="3">Run verify again</button>');
    expect(html).not.toContain('data-wf-stop=');
    expect(html).not.toMatch(/resume safely|data-act="resume"/i);
    const lines = text(await ws.workflows('BUILD.md'));
    expect(lines).toContain('Interrupted j0dead1');
    expect(lines).toContain('its session ended while build ran; its process is gone; verify not seen: its REPL had ended, and upmd may have gone on until it ended. Nothing resumes it: /run BUILD.md verify runs it again.');
    // Run again is the same /run (the test-double upmd): a new job, from setup
    const again = await act(port, token, { action: 'run', doc: 'BUILD.md', block: 'verify' });
    expect(again.body.split('\n')[0]).toBe('board /run BUILD.md verify');
    const fresh = ws.jobs.list().find((j) => j.label === 'BUILD.md › verify' && j.id !== 'j0dead1')!;
    await ws.jobs.done(fresh.id);
    expect(nodeState((await state(port, token)).html, '2')).toMatch(/^✓ completed/);
  }, 30_000);
});
