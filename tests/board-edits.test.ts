// Round R4 (H22): the live board's parameter card, workflow node editing and Rebuild, over real HTTP to the
// Workspace's live board on 127.0.0.1, with real files in temporary projects. Workflow runs use
// tests/fixtures/fake-upmd.mjs, a labelled TEST DOUBLE of upmd 0.2.7 (it is not upmd). The Rebuild round trip
// uses a FAKE recipe executor (the jobs.ts seam, as in tests/recipe-repl.test.ts): SYNTHETIC files and signed
// receipts, no CadQuery, Open3D or Python; TIMMY_CADQUERY_PYTHON names a FAKE file that is never executed.
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { status as recipeStatus } from '../lanes/recipes/jobs.js';
import { folderProject } from '../src/project/index.js';
import { DOCTRINE_15, EXPORTS } from '../src/recipes/index.js';
import type { LiveState } from '../src/repl/board-live.js';
import { EDIT_LIMIT } from '../src/repl/board-edits.js';
import { saveParams } from '../src/repl/board-cards.js';
import { docPlace } from '../src/repl/board-nodes.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const F = '```';
const DOC = [
  '# Build', '',
  'Prose before the blocks: it must stay as it is.', '',
  `${F}bash [name:setup]`, 'mkdir -p dist', F, '',
  '## Then', '',
  `${F}bash [name:build, deps:setup]`, 'echo built > dist/out.txt', F, '',
  `${F}bash [name:verify, deps:build]`, 'test -f dist/out.txt', F, '',
  'Prose after the blocks.', '',
].join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const dirs: string[] = [];
const spaces: Workspace[] = [];
let supervisors: Promise<void>[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
async function until(pred: () => boolean, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  await Promise.race([Promise.all(supervisors), new Promise((r) => setTimeout(r, 15000))]);
  supervisors = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(root: string, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { UPMD_BIN: FAKE_UPMD },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => `Open ${url} in your browser.`,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
  return new Promise((done, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
async function live(ws: Workspace): Promise<{ port: number; token: string }> {
  expect(text(await ws.boardLive('live'))).toContain('Live board');
  const lb = ws.liveBoard!;
  return { port: lb.port, token: lb.url.split('#t=')[1] };
}
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const json = (token: string): Record<string, string> => ({ ...auth(token), 'Content-Type': 'application/json' });
const edit = (port: number, token: string, body: unknown, headers: Record<string, string> = json(token)): Promise<Reply> =>
  raw(port, { method: 'POST', path: '/edit', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const act = (port: number, token: string, body: unknown): Promise<Reply> => raw(port, { method: 'POST', path: '/action', headers: json(token), body: JSON.stringify(body) });
async function state(port: number, token: string): Promise<LiveState> {
  const r = await raw(port, { path: '/state', headers: auth(token) });
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as LiveState;
}
const unescapeAttr = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** The workflow card's data as the page's editor reads it: the blocks and the sha256 it started from. */
function cardData(html: string, doc: string): { sha256: string; blocks: Array<{ index: number; name: string; lang: string; deps: string[]; code: string }> } {
  const m = new RegExp(`data-wf-doc="${doc.replace(/[.]/g, '\\.')}" data-wf-sha="([0-9a-f]{64})" data-wf="([^"]*)"`).exec(html);
  if (!m) throw new Error(`no editable card for ${doc}`);
  return { sha256: m[1], blocks: JSON.parse(unescapeAttr(m[2])) };
}
const PARAMS = { width: 150, wall: 3, supportOffset: 10, bore: 3 };
const historyFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name))); };
  walk(join(root, '.timmy'));
  return out.filter((f) => /history/.test(f));
};

describe('the parameter card, saved through the live board', () => {
  it('saves new values: the file written, its sha256 named, the previous version kept, an edit receipt sealed, the transcript told', async () => {
    const root = temp('board-params-');
    const { ws, notes, sealed } = make(root);
    const { port, token } = await live(ws);
    const s = await state(port, token);
    expect(s.recipes).toEqual(['tray']);
    expect(s.html).toContain('data-params="tray" data-params-base="none"');
    expect(s.html).toContain('data-param="width" value="140"');
    expect(s.html).toContain('data-act="rebuild" data-recipe="tray"');

    const first = await edit(port, token, { action: 'set-params', recipe: 'tray', base: null, parameters: PARAMS });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('text/plain; charset=utf-8');
    const file = readFileSync(join(root, 'recipes/tray.params.json'));
    expect(JSON.parse(file.toString()).parameters).toEqual(PARAMS);
    expect(first.body).toBe(`Saved recipes/tray.params.json: width 140 → 150, wall 3, supportOffset 10, bore 3 (mm). sha256 ${sha(file).slice(0, 12)}; a new file (there was none before); receipt id1. /recipe tray and Rebuild take these values.`);
    expect(sealed[0]).toMatchObject({ kind: 'edit', status: 'ok', files: [{ path: 'recipes/tray.params.json', sha256: sha(file), created: true }] });
    expect(notes).toContain(`  board  saved recipes/tray.params.json: width 140 → 150, wall 3, supportOffset 10, bore 3 · receipt id1`);

    // The card now shows the file; a second save names the version it replaces and where it is kept.
    const after = await state(port, token);
    expect(after.html).toContain(`data-params-base="${sha(file)}"`);
    expect(after.html).toContain('data-param="width" value="150"');
    const second = await edit(port, token, { action: 'set-params', recipe: 'tray', base: sha(file), parameters: { ...PARAMS, width: 160 } });
    expect(second.status).toBe(200);
    const kept = /the previous version is kept at (\.timmy\/params-history\/tray\/[^;]+\.json);/.exec(second.body)?.[1];
    expect(kept).toBeDefined();
    expect(readFileSync(join(root, kept!))).toEqual(file);
    expect(sealed[1]).toMatchObject({ kind: 'edit', files: [{ path: 'recipes/tray.params.json', previous_sha256: sha(file), created: false }], sources: [{ path: kept, sha256: sha(file), role: 'previous version' }] });
    // The same values again: no change, nothing written, no receipt.
    const now = readFileSync(join(root, 'recipes/tray.params.json'));
    const same = await edit(port, token, { action: 'set-params', recipe: 'tray', base: sha(now), parameters: { ...PARAMS, width: 160 } });
    expect(same.status).toBe(200);
    expect(same.body).toContain('No change: recipes/tray.params.json already holds');
    expect(sealed).toHaveLength(2);
    expect(first.body + second.body).not.toContain(root);
  });

  it('refuses what the recipe refuses, a stale base, a wrong shape and an unknown recipe, and writes nothing', async () => {
    const root = temp('board-params-');
    const { ws, sealed } = make(root);
    const { port, token } = await live(ws);
    const cases: Array<[unknown, number, string]> = [
      [{ action: 'set-params', recipe: 'tray', base: null, parameters: { ...PARAMS, width: 'abc' } }, 422, 'Refused: width must be a number of millimetres. Nothing was written'],
      [{ action: 'set-params', recipe: 'tray', base: null, parameters: { ...PARAMS, width: 30 } }, 422, 'Conflicting tray dimensions'],
      [{ action: 'set-params', recipe: 'tray', base: null, parameters: { ...PARAMS, wall: 0 } }, 422, 'Nothing was written'],
      [{ action: 'set-params', recipe: 'tray', base: 'ab'.repeat(32), parameters: PARAMS }, 409, 'changed since the board showed it (it is now not there)'],
      [{ action: 'set-params', recipe: 'tray', base: null, parameters: { width: 150 } }, 400, 'The parameters are width, wall, supportOffset, bore'],
      [{ action: 'set-params', recipe: 'tray', base: null, parameters: { ...PARAMS, depth: 80 } }, 400, 'The parameters are'],
      [{ action: 'set-params', recipe: 'box', base: null, parameters: PARAMS }, 404, 'No parameter card for box'],
      [{ action: 'set-params', recipe: 'tray', parameters: PARAMS }, 400, 'A parameter save is'],
      [{ action: 'set-params', recipe: 'tray', base: null, parameters: PARAMS, path: '/etc/passwd' }, 400, 'A parameter save is'],
      [{ action: 'delete', file: 'recipes/tray.params.json' }, 400, 'Unknown edit'],
      ['[]', 400, 'An edit is a JSON object.'],
    ];
    for (const [body, status, says] of cases) {
      const r = await edit(port, token, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.body).toContain(says);
    }
    expect(existsSync(join(root, 'recipes'))).toBe(false);
    expect(sealed).toEqual([]);
  });
});

/**
 * R4 review (R4-3): a parameter save from the board while an /iterate flow runs in the project would be taken for the
 * agent's change (or lost under it), so it is refused. FAKE pieces: the code agent is tests/fixtures/fake-code-agent.mjs
 * (a TEST DOUBLE, here only sleeping in its agent step); TIMMY_CADQUERY_PYTHON and TIMMY_BLENDER name FAKE programs that
 * are never run (each flow is stopped in its agent step).
 */
describe('a parameter save while a flow runs in the project (R4 review, R4-3)', () => {
  it('refused with 409 while any /iterate flow runs there (the tray\'s, a Blender one): nothing written or sealed; taken once the flows have ended', async () => {
    const root = temp('board-params-flow-');
    const fakes = temp('board-params-fakes-');
    const program = (name: string): string => { const p = join(fakes, name); writeFileSync(p, '#!/bin/sh\necho "FAKE: never run by this test"\nexit 1\n', { mode: 0o755 }); return p; };
    put(root, 'scene.py', readFileSync(resolve('templates/blender-starter/scene.py')));
    const { ws, notes, sealed } = make(root, {
      env: { UPMD_BIN: FAKE_UPMD, TIMMY_AGENT_QWEN_BIN: resolve('tests/fixtures/fake-code-agent.mjs'), TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: program('python'), TIMMY_BLENDER: program('blender') },
    });
    const { port, token } = await live(ws);
    for (const line of ['tray "SLEEP PARAM:width=180"', 'blender scene.py "SLEEP"']) {
      const out = text(await ws.iterate(line));
      const id = /Flow\s+(f[0-9a-f]{8})/.exec(out)![1];
      const agent = /Agent\s+(j[0-9a-f]{6})/.exec(out)![1];
      await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
      // The tray's start wrote the file from the recipe's defaults; the board shows it as it is.
      const file = readFileSync(join(root, 'recipes/tray.params.json'));
      expect((await state(port, token)).html).toContain(`data-params-base="${sha(file)}"`);
      const seals = sealed.length;
      const r = await edit(port, token, { action: 'set-params', recipe: 'tray', base: sha(file), parameters: PARAMS });
      expect(r.status).toBe(409);
      expect(r.body).toBe(`flow ${id} is running in this project: save after it ends, or /stop it`);
      expect(readFileSync(join(root, 'recipes/tray.params.json'))).toEqual(file);
      expect(historyFiles(root)).toEqual([]);
      expect(sealed).toHaveLength(seals);
      expect(notes).toContain(`  board  refused a parameter save: flow ${id} is running in this project`);
      expect(text(await ws.stop(id))).toContain(`${id} cancelled`);
    }
    // No flow runs now: the same save is taken.
    const file = readFileSync(join(root, 'recipes/tray.params.json'));
    const ok = await edit(port, token, { action: 'set-params', recipe: 'tray', base: sha(file), parameters: PARAMS });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('Saved recipes/tray.params.json: width 140 → 150');
    expect(JSON.parse(readFileSync(join(root, 'recipes/tray.params.json'), 'utf8')).parameters).toEqual(PARAMS);
  }, 60_000);

  it('a flow still being started (its id not named yet) refuses the save the same way, before anything is read', () => {
    const root = temp('board-params-held-');
    const r = saveParams({ action: 'set-params', recipe: 'tray', base: null, parameters: PARAMS }, { root, project: 'demo', projectId: 'p', workflows: [], recipes: ['tray'], flowIn: () => ({ step: 'prepare' }) });
    expect(r).toEqual({ status: 409, text: 'a flow is being started in this project: save after it ends, or /stop it', line: 'refused a parameter save: a flow is being started in this project' });
    expect(existsSync(join(root, 'recipes'))).toBe(false);
  });
});

describe('the workflow node editor, saved through the live board', () => {
  it('renames, adds, removes and edits blocks: prose kept, old bytes kept, a receipt sealed, the answer says what changed; Run works on the renamed node', async () => {
    const root = temp('board-wf-');
    put(root, 'BUILD.md', DOC);
    const { ws, notes, sealed } = make(root);
    const { port, token } = await live(ws);
    const { sha256, blocks } = cardData((await state(port, token)).html, 'BUILD.md');
    expect(sha256).toBe(sha(DOC));
    expect(blocks.map((b) => b.name)).toEqual(['setup', 'build', 'verify']);
    const [setup, build] = blocks;
    const body = {
      action: 'save-workflow', doc: 'BUILD.md', sha256,
      blocks: [
        { from: setup.index, name: 'init', lang: 'bash', needs: [], command: 'mkdir -p dist\necho init' },
        { from: build.index, name: 'build', lang: 'bash', needs: ['init'], command: build.code },
        { name: 'lint', lang: 'sh', needs: ['build'], command: 'echo lint' },
      ],
    };
    const r = await edit(port, token, body);
    expect(r.status).toBe(200);
    const after = readFileSync(join(root, 'BUILD.md'), 'utf8');
    expect(r.body).toMatch(/^Saved BUILD\.md: renamed setup to init; edited init's command \(1 → 2 lines\); added lint \(needs build\); removed verify; order: init, build, lint\. sha256 [0-9a-f]{12} \(was [0-9a-f]{12}\); the previous version is kept at \.timmy\/workflow-history\/BUILD\.md\/[^;]+\.md\.bak; receipt id1\.$/);
    expect(parseWorkflow(after).filter((b) => b.name).map((b) => [b.name, b.lang, b.deps, b.code])).toEqual([
      ['init', 'bash', [], 'mkdir -p dist\necho init'], ['build', 'bash', ['init'], 'echo built > dist/out.txt'], ['lint', 'sh', ['build'], 'echo lint'],
    ]);
    for (const line of ['# Build', 'Prose before the blocks: it must stay as it is.', '## Then', 'Prose after the blocks.']) expect(after).toContain(line);
    // The old bytes, kept as a .bak beside nothing the board would take for a workflow.
    const kept = /kept at (\S+\.md\.bak);/.exec(r.body)![1];
    expect(readFileSync(join(root, kept), 'utf8')).toBe(DOC);
    expect(sealed[0]).toMatchObject({ kind: 'edit', files: [{ path: 'BUILD.md', sha256: sha(after), previous_sha256: sha(DOC), created: false }], sources: [{ path: kept, sha256: sha(DOC) }] });
    expect(notes.some((n) => n.startsWith('  board  saved BUILD.md: renamed setup to init'))).toBe(true);
    const s = await state(port, token);
    expect(s.workflows).toEqual([{ rel: 'BUILD.md', blocks: ['init', 'build', 'lint'] }]);
    // Run on a node is the existing run action: /run BUILD.md init, through the Workspace (fake upmd).
    const ran = await act(port, token, { action: 'run', doc: 'BUILD.md', block: 'init' });
    expect(ran.status).toBe(200);
    expect(ran.body.split('\n')[0]).toBe('board /run BUILD.md init');
  }, 20_000);

  it('refuses a cycle, duplicate names, an unknown need, a stale sha256 and a document not on the board, and writes nothing', async () => {
    const root = temp('board-wf-');
    put(root, 'BUILD.md', DOC);
    const outside = temp('board-outside-');
    put(outside, 'other.md', DOC);
    const { ws, sealed } = make(root);
    const { port, token } = await live(ws);
    const { sha256, blocks } = cardData((await state(port, token)).html, 'BUILD.md');
    const asIs = blocks.map((b) => ({ from: b.index, name: b.name, lang: b.lang, needs: b.deps, command: b.code }));
    const cases: Array<[unknown, number, string]> = [
      [{ action: 'save-workflow', doc: 'BUILD.md', sha256, blocks: [{ ...asIs[0], needs: ['verify'] }, asIs[1], asIs[2]] }, 422, 'These blocks need each other in a loop: setup → verify → build → setup.'],
      [{ action: 'save-workflow', doc: 'BUILD.md', sha256, blocks: [asIs[0], { ...asIs[1], name: 'setup', needs: [] }, asIs[2]] }, 422, 'Two blocks are named setup'],
      [{ action: 'save-workflow', doc: 'BUILD.md', sha256, blocks: [asIs[0], { ...asIs[1], needs: ['deploy'] }] }, 422, 'build needs deploy, but no block is named deploy.'],
      [{ action: 'save-workflow', doc: 'BUILD.md', sha256, blocks: [{ ...asIs[0], name: 'rm -rf /' }] }, 422, 'is not a block name'],
      [{ action: 'save-workflow', doc: 'BUILD.md', sha256: 'ab'.repeat(32), blocks: asIs }, 409, 'BUILD.md changed since the board read it'],
      [{ action: 'save-workflow', doc: '../BUILD.md', sha256, blocks: asIs }, 404, 'No workflow ../BUILD.md on this board'],
      [{ action: 'save-workflow', doc: join(outside, 'other.md'), sha256, blocks: asIs }, 404, 'on this board'],
      [{ action: 'save-workflow', doc: 'NEW.md', sha256, blocks: asIs }, 404, 'No workflow NEW.md on this board'],
      [{ action: 'save-workflow', doc: 'BUILD.md', sha256, blocks: asIs, run: 'all' }, 400, 'A save is'],
    ];
    for (const [body, status, says] of cases) {
      const r = await edit(port, token, body);
      expect(r.status, JSON.stringify(body).slice(0, 120)).toBe(status);
      expect(r.body).toContain(says);
    }
    expect(readFileSync(join(root, 'BUILD.md'), 'utf8')).toBe(DOC);
    expect(readFileSync(join(outside, 'other.md'), 'utf8')).toBe(DOC);
    expect(existsSync(join(root, 'NEW.md'))).toBe(false);
    expect(historyFiles(root)).toEqual([]);
    expect(sealed).toEqual([]);
  });

  it('a document that becomes a link out of the project, or that sits behind a linked folder, is refused in place', () => {
    const root = temp('board-wf-');
    const outside = temp('board-outside-');
    put(outside, 'real.md', DOC);
    put(root, 'BUILD.md', DOC);
    symlinkSync(join(outside, 'real.md'), join(root, 'LINK.md'));
    mkdirSync(join(root, 'docs'));
    symlinkSync(outside, join(root, 'docs', 'away'));
    put(root, 'inner/real.md', DOC);
    symlinkSync(join(root, 'inner'), join(root, 'alias'));
    expect(docPlace(root, 'LINK.md', ['LINK.md'])).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('outside the project') });
    expect(docPlace(root, 'docs/away/real.md', ['docs/away/real.md'])).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('outside the project') });
    // A link that stays inside the project is refused too: the board writes a document only in place.
    expect(docPlace(root, 'alias/real.md', ['alias/real.md'])).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('symbolic link') });
    expect(docPlace(root, '../x.md', ['../x.md'])).toMatchObject({ ok: false, status: 403 });
    expect(docPlace(root, 'BUILD.md', [])).toMatchObject({ ok: false, status: 404 });
    expect(docPlace(root, 'BUILD.md', ['BUILD.md'])).toMatchObject({ ok: true });
    // The board itself never lists them: findWorkflowDocs follows no link.
    unlinkSync(join(root, 'LINK.md'));
  });
});

describe('where the previous versions go', () => {
  it('a .timmy folder that is a link out of the project: both edits refuse, and nothing is written there or in the project', async () => {
    const root = temp('board-keep-');
    put(root, 'BUILD.md', DOC);
    const elsewhere = temp('board-elsewhere-');
    const { ws, sealed } = make(root);
    const { port, token } = await live(ws);
    const { sha256, blocks } = cardData((await state(port, token)).html, 'BUILD.md');
    put(root, 'recipes/tray.params.json', JSON.stringify({ schema: 'timmy.recipe-params/1', recipe: 'enclosure.tray/1', parameters: PARAMS }));
    const params = readFileSync(join(root, 'recipes/tray.params.json'));
    symlinkSync(elsewhere, join(root, '.timmy'));
    const p = await edit(port, token, { action: 'set-params', recipe: 'tray', base: sha(params), parameters: { ...PARAMS, width: 170 } });
    expect(p.status).toBe(403);
    expect(p.body).toContain('leads outside the project');
    expect(p.body).toContain('Nothing was written');
    const w = await edit(port, token, { action: 'save-workflow', doc: 'BUILD.md', sha256, blocks: blocks.map((b) => ({ from: b.index, name: b.name, lang: b.lang, needs: b.deps, command: `${b.code}\necho more` })) });
    expect(w.status).toBe(500);
    expect(w.body).toContain('Nothing was written: the previous version of BUILD.md could not be kept');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readFileSync(join(root, 'recipes/tray.params.json'))).toEqual(params);
    expect(readFileSync(join(root, 'BUILD.md'), 'utf8')).toBe(DOC);
    expect(sealed).toEqual([]);
  });
});

describe('who may edit', () => {
  it('refuses a missing or wrong token (401), a foreign Origin or Host (403), an oversized body (413), another type (415) or method (405), before anything is read or written', async () => {
    const root = temp('board-wf-');
    put(root, 'BUILD.md', DOC);
    const { ws, notes, sealed } = make(root);
    const { port, token } = await live(ws);
    const body = { action: 'set-params', recipe: 'tray', base: null, parameters: PARAMS };
    expect((await edit(port, token, body, { 'Content-Type': 'application/json' })).status).toBe(401);
    expect((await edit(port, token, body, { ...json('0'.repeat(64)) })).status).toBe(401);
    expect((await edit(port, token, body, { ...json(token), Origin: 'http://evil.example' })).status).toBe(403);
    expect((await edit(port, token, body, { ...json(token), Origin: `http://localhost:${port}` })).status).toBe(403);
    expect((await edit(port, token, body, { ...json(token), Host: 'evil.example' })).status).toBe(403);
    const big = JSON.stringify({ action: 'save-workflow', doc: 'BUILD.md', sha256: 'ab'.repeat(32), blocks: [{ name: 'a', lang: 'bash', needs: [], command: 'x'.repeat(EDIT_LIMIT) }] });
    const over = await edit(port, token, big);
    expect(over.status).toBe(413);
    expect(over.body).toBe(`Refused: an edit is at most ${EDIT_LIMIT} bytes.`);
    expect((await edit(port, token, body, { ...auth(token), 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await raw(port, { method: 'GET', path: '/edit', headers: auth(token) })).status).toBe(405);
    expect((await edit(port, token, '{"action":')).status).toBe(400);
    expect(existsSync(join(root, 'recipes'))).toBe(false);
    expect(readFileSync(join(root, 'BUILD.md'), 'utf8')).toBe(DOC);
    expect(sealed).toEqual([]);
    expect(notes.filter((n) => n.includes('board  '))).toEqual([]);
    // An edit cannot be posted to /action, nor an action to /edit.
    expect((await act(port, token, body)).status).toBe(400);
    expect((await edit(port, token, { action: 'run', doc: 'BUILD.md', block: 'setup' })).status).toBe(400);
  });
});

describe('Rebuild: the typed /recipe tray, from the board', () => {
  it('is checked against the state and dispatched through the Workspace method (no CadQuery runtime here: its own setup answer comes back)', async () => {
    const root = temp('board-rebuild-');
    const { ws, notes } = make(root);
    const { port, token } = await live(ws);
    const r = await act(port, token, { action: 'rebuild', recipe: 'tray' });
    expect(r.status).toBe(200);
    expect(r.body.split('\n')[0]).toBe('board /recipe tray');
    expect(r.body).toContain('Not started: TIMMY_CADQUERY_PYTHON is not set');
    expect(notes[0]).toBe('  board  /recipe tray');
    expect((await act(port, token, { action: 'rebuild', recipe: 'box' })).status).toBe(404);
    expect((await act(port, token, { action: 'rebuild', recipe: 'tray', width: 1 })).status).toBe(400);
    expect((await act(port, token, { action: 'rebuild', recipe: 'tray status' })).status).toBe(404);
  });

  /** A FAKE recipe executor for the jobs.ts seam (as in tests/recipe-repl.test.ts): SYNTHETIC files, signed receipts, no geometry. */
  function fakeExecutor(dir: string): string {
    const file = join(dir, 'fake-recipe-complete.mts');
    const mod = (name: string) => JSON.stringify(pathToFileURL(resolve(name)).href);
    writeFileSync(file, `
// FAKE recipe executor (test fixture): SYNTHETIC files only; no CadQuery, no Open3D, no Python.
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${mod('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${mod('src/utils/receipts.ts')};
import {sha,prediction,validate} from ${mod('lanes/recipes/tray.ts')};
const [,root,id]=process.argv.slice(2), job=loadJob(root,id), dir=jobDirectory(root,id), workspace=path.join(dir,'workspace');
const p=validate(job.request), pred=prediction(p);
const run=randomUUID(), base=path.join(workspace,'.timmy','recipe-runs',run);fs.mkdirSync(base,{recursive:true});
fs.writeFileSync(path.join(base,'request.json'),JSON.stringify(job.request));
fs.writeFileSync(path.join(base,'prediction.json'),JSON.stringify(pred,null,2)+'\\n');
fs.writeFileSync(path.join(base,'build.py'),'SYNTHETIC fixture source; not the recipe');
const common={subject:'SYNTHETIC recipe fixture; no geometry claim',policy:'auto',cost_usd:0};
const prediction_=appendReceipt('runs',{...common,status:'ok',kind:'recipe.prediction',sources:['request.json','prediction.json','build.py'].map(n=>({path:path.join(base,n),sha256:sha(fs.readFileSync(path.join(base,n)))}))},workspace);
const native=path.join(base,'native');fs.mkdirSync(native);
const exports=${JSON.stringify(EXPORTS)}.map(f=>{fs.writeFileSync(path.join(native,f),'SYNTHETIC '+f+'; not geometry');return {file:f,sha256:sha(fs.readFileSync(path.join(native,f)))};});
const labels=[...Array.from({length:12},(_,i)=>'Stage check '+(i+1)),'Native bounds','Native analytic volume','Native valid single solid','STEP reimport bounds','STEP reimport analytic volume','STEP reimport valid single solid','STL closed, manifold, orientable','STL one component, no self intersections','STL volume agrees within 0.1%','Every construction stage validated',...Array.from({length:8},(_,i)=>'axis '+(i+1))];
const result={schema:'timmy.tray-build/1',engine:'SYNTHETIC fixture',synthetic:true,variant:{measured:{bounds:pred.bounds,volume:pred.volumeMm3},mesh:{engine:'SYNTHETIC mesh fixture'},checks:labels.map((label,i)=>({id:'geometry.'+String(i+1).padStart(2,'0'),label,passed:true}))}};
fs.writeFileSync(path.join(native,'result.json'),JSON.stringify(result));
fs.writeFileSync(path.join(base,'native.log'),'SYNTHETIC native log');
const sources=[path.join(native,'result.json'),path.join(base,'native.log'),...exports.map(e=>path.join(native,e.file))].map(f=>({path:f,sha256:sha(fs.readFileSync(f))}));
const receipt=appendReceipt('runs',{...common,status:'ok',kind:'recipe.build',child_receipts:[prediction_.id],sources},workspace);
const report={state:'succeeded',run,parameters:p,predictionReceipt:prediction_.id,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:30,exports};
fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\\n');
recordResult(root,id,{...report,directory:base});
`);
    return file;
  }

  it('saved parameters, then Rebuild: the recipe job takes the file and its result card shows the verified values, the exports and DOCTRINE §15 (FAKE executor)', async () => {
    const root = temp('board-rebuild-');
    const fixtures = temp('board-rebuild-fixtures-');
    const fakePython = join(fixtures, 'fake-python');
    writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
    const { ws } = make(root, {
      env: { TIMMY_CADQUERY_PYTHON: fakePython },
      recipeTest: { executor: fakeExecutor(fixtures), pollMs: 100, onSupervisor: (child: ChildProcess) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); } },
    });
    const { port, token } = await live(ws);
    expect((await edit(port, token, { action: 'set-params', recipe: 'tray', base: null, parameters: { ...PARAMS, width: 180 } })).status).toBe(200);
    const r = await act(port, token, { action: 'rebuild', recipe: 'tray' });
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/Predicted\s+180 x 80 x 30 mm/);
    expect(r.body).toMatch(/Parameters\s+recipes\/tray\.params\.json\s+sha256 [0-9a-f]{12}/);
    const id = /Recipe job\s+([0-9a-f-]{36})/.exec(r.body)![1];
    await until(() => recipeStatus(root, id).state === 'succeeded');
    await until(() => ws.jobs.list().every((j) => ['completed', 'failed', 'cancelled'].includes(j.state)));
    let html = '';
    await until(() => { html = renderedResults(); return html.includes('rstatus-ok'); }, 10_000);
    function renderedResults(): string { text(ws.board('')); return readFileSync(join(root, '.timmy/board/index.html'), 'utf8'); }
    const card = /<article class="card result result-recipe">([\s\S]*?)<\/article>/.exec(html)![1];
    expect(card).toContain(`recipe enclosure.tray/1 · ${id.slice(0, 8)}`);
    expect(card).toContain('<strong>succeeded</strong> its signed result verified now, and every copied file matches its sha256');
    expect(card).toContain('30 of 30 passed');
    expect(card).toContain('180 x 80 x 30 mm <span class="tier">measured on the generated CAD; 180 x 80 x 30 mm in the sealed prediction</span>');
    for (const f of EXPORTS) expect(card).toContain(`href="../../out/recipes/${id.slice(0, 8)}/${f}"`);
    expect(card).toContain(DOCTRINE_15);
    expect(card).not.toContain('(measured)');
    // Tampering with a copied export takes the values off the card: the board's check no longer verifies them.
    writeFileSync(join(root, `out/recipes/${id.slice(0, 8)}/outer.stl`), 'changed by hand');
    const tampered = /<article class="card result result-recipe">([\s\S]*?)<\/article>/.exec(renderedResults())![1];
    expect(tampered).toContain('<strong>succeeded</strong> but its exports are not verified in the project');
    expect(tampered).not.toContain('measured on the generated CAD');
    expect(tampered).toContain(`data-cmd="/recipe copy ${id}"`);
    expect(JSON.stringify(await state(port, token))).not.toContain(root);
    expect(JSON.stringify(await state(port, token))).not.toContain(homedir());
  }, 60_000);
});
