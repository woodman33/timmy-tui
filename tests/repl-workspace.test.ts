// R1 workspace direction (2026-10-08): one project through its files, a workflow run (upmd's real --ci
// protocol, through the labelled test double), a preview server, an edit and the results — with real
// processes, and the receipts each step seals.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager } from '../src/jobs/index.js';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const WORKFLOW = [
  '# Build the site', '',
  '```bash [name:setup]', 'mkdir -p dist', '```', '',
  '```bash [name:build, deps:setup]', 'cp src/index.html dist/index.html && echo built', '```', '',
  '```bash [name:broken]', 'echo "nope" >&2; exit 3', '```', '',
].join('\n');

const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string[] => lines.map((l) => l.map((s) => s.text).join(''));
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function site(): string {
  const root = temp('site-');
  put(root, 'BUILD.md', WORKFLOW);
  put(root, 'src/index.html', '<h1>Hello</h1>\n');
  return root;
}

function make(root: string, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const opened: string[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { UPMD_BIN: FAKE_UPMD },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => { opened.push(url); return `Open ${url} in your browser.`; },
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed, opened };
}

describe('the project and its files', () => {
  it('shows the project, its files by role, and a workflow document as its blocks', () => {
    const root = site();
    const { ws } = make(root);
    const summary = text(ws.project_('')).join('\n');
    expect(summary).toContain('Project');
    expect(summary).toMatch(/Files\s+2: Source 1 . Workflows 1/);
    const files = text(ws.files('')).join('\n');
    expect(files).toContain('Source (1)');
    expect(files).toContain('src/index.html');
    expect(files).toContain('Workflows (1)');
    expect(files).toContain('blocks: setup, build, broken');
    const open = text(ws.open('BUILD.md')).join('\n');
    expect(open).toMatch(/build\s+needs setup/);
    expect(text(ws.open('../outside')).join('')).toContain('outside the project');
  });
});

describe('a workflow run', () => {
  it('predicts, runs as a job, reports each step, and seals the outcome with the outputs', async () => {
    const root = site();
    const { ws, notes, sealed } = make(root);
    const lines = text(await ws.run('BUILD.md build')).join('\n');
    expect(lines).toMatch(/Predicted\s+setup . build, each exits 0/);
    expect(sealed[0]).toMatchObject({ kind: 'predict', prediction: { doc: 'BUILD.md', block: 'build', order: ['setup', 'build'] } });
    expect(sealed[0].files?.[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const id = ws.jobs.list()[0].id;
    const done = await ws.jobs.done(id);
    await tick();
    expect(done.state).toBe('completed');
    expect(done.steps.map((s) => [s.name, s.state])).toEqual([['setup', 'completed'], ['build', 'completed']]);
    expect(existsSync(join(root, 'dist/index.html'))).toBe(true);
    expect(notes.some((n) => n.includes('setup completed') && n.includes('1 of 2'))).toBe(true);
    expect(notes.some((n) => n.includes(`${id} completed`) && n.includes('prediction met'))).toBe(true);
    const outcome = sealed.at(-1)!;
    expect(outcome).toMatchObject({ kind: 'workflow', status: 'ok', prediction: { met: true }, job: { id, state: 'completed' } });
    expect(outcome.outputs?.map((o) => o.path)).toContain('dist/index.html');
  });

  it('a failing block fails the job, stops the chain and misses the prediction', async () => {
    const root = site();
    const { ws, notes, sealed } = make(root);
    await ws.run('BUILD.md broken');
    const id = ws.jobs.list()[0].id;
    const done = await ws.jobs.done(id);
    await tick();
    expect(done.state).toBe('failed');
    expect(notes.some((n) => n.includes(`${id} failed`) && n.includes('broken exited 3'))).toBe(true);
    expect(sealed.at(-1)).toMatchObject({ kind: 'workflow', status: 'failed', prediction: { met: false } });
  });

  it('refuses before running: no upmd, an unknown block, or a missing dependency', async () => {
    const root = site();
    put(root, 'BAD.md', '```bash [name:go, deps:nowhere]\necho hi\n```\n');
    const without = make(root, { env: {} });
    expect(text(await without.ws.run('BUILD.md build')).join('\n')).toContain('upmd is not installed');
    expect(without.ws.jobs.list()).toEqual([]);
    expect(without.sealed).toEqual([]);
    const { ws, sealed } = make(root);
    expect(text(await ws.run('BUILD.md nope')).join('')).toContain('No block named nope');
    expect(text(await ws.run('BAD.md go')).join('')).toContain('needs nowhere');
    expect(sealed).toEqual([]);
  });
});

describe('a preview', () => {
  it('is ready (not completed) when it answers, opens in the Browser, and stops with everything it started', async () => {
    const root = site();
    put(root, 'dist/index.html', '<h1>Built</h1>\n');
    const { ws, notes, sealed, opened } = make(root);
    const lines = text(await ws.preview('')).join('\n');
    expect(lines).toContain('preview dist/');
    const id = ws.jobs.list()[0].id;
    const ready = await ws.jobs.ready(id);
    await tick(150);
    expect(ready.state).toBe('ready');
    expect(opened).toEqual([ready.url]);
    expect(await (await fetch(ready.url!)).text()).toContain('Built');
    expect(notes.some((n) => n.includes(`${id} ready`))).toBe(true);
    expect(notes.some((n) => n.includes(`${id} completed`))).toBe(false);
    const stopped = text(await ws.stop(id)).join('');
    expect(stopped).toContain('cancelled');
    await tick();
    expect(sealed.at(-1)).toMatchObject({ kind: 'preview', status: 'cancelled', job: { id, url: ready.url } });
    await expect(fetch(ready.url!, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it('says what to do when there is nothing to serve', async () => {
    const root = temp('empty-');
    const { ws } = make(root);
    expect(text(await ws.preview('')).join('')).toContain('Nothing to preview');
  });
});

describe('edits and results', () => {
  it('an edit is sealed with its hashes, and results show jobs, outputs and changes', async () => {
    const root = site();
    const { ws, sealed } = make(root, { edit: (path) => writeFileSync(path, '<h1>Edited</h1>\n') });
    expect(text(ws.edit('src/index.html')).join('')).toContain('Saved src/index.html');
    expect(sealed.at(-1)).toMatchObject({ kind: 'edit', files: [{ path: 'src/index.html', created: false }] });
    expect(sealed.at(-1)?.files?.[0].previous_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(text(ws.edit('src/index.html')).join('')).toContain('No change to src/index.html');
    await ws.run('BUILD.md build');
    await ws.jobs.done(ws.jobs.list()[0].id);
    await tick();
    expect(readFileSync(join(root, 'dist/index.html'), 'utf8')).toContain('Edited');
    const results = text(ws.results('')).join('\n');
    expect(results).toContain('Jobs');
    expect(results).toContain('BUILD.md › build');
    expect(results).toContain('dist/index.html');
    expect(results).toMatch(/src\/index.html\s+your edit/);
  });
});

describe('switching projects', () => {
  it('moves into the project, remembers it, and says which conversation it carries', () => {
    const home = temp('home-');
    const prev = process.env.TIMMY_HOME;
    process.env.TIMMY_HOME = home;
    try {
      const root = site();
      const other = temp('other-');
      const moved: string[] = [];
      const { ws } = make(root, { chdir: (d) => moved.push(d), onSwitch: (p) => `a new conversation, kept in ${p.name}` });
      const lines = text(ws.project_(other)).join('\n');
      expect(moved).toEqual([other]);
      expect(ws.root).toBe(other);
      expect(lines).toMatch(/Context\s+a new conversation, kept in other-/);
      expect(text(ws.project_('no-such-project-here')).join('')).toContain('no project named');
    } finally {
      if (prev === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = prev;
    }
  });
});


// Independent source review at c7475458 (2026-10-08), findings 4 and 6.
describe('review: /stop is about this REPL\'s jobs and says what actually happened', () => {
  it('leaves another session\'s job alone and says so; /stop all counts only its own', async () => {
    const root = site();
    const jobsDir = join(temp('jobs-'), 'jobs');
    const other = new JobManager({ dir: jobsDir });
    const theirs = other.start({ kind: 'task', label: 'their job', project: 'site', root, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    try {
      for (let i = 0; i < 100 && other.get(theirs.id)?.state !== 'running'; i++) await tick(20);
      const { ws } = make(root, { jobsDir });
      const one = text(await ws.stop(theirs.id)).join('');
      expect(one).toMatch(/another Timmy session/);
      expect(one).not.toMatch(/have stopped/);
      expect(other.get(theirs.id)?.state).toBe('running');
      const all = text(await ws.stop('all')).join('');
      expect(all).toMatch(/Nothing this REPL started is running/);
      expect(other.get(theirs.id)?.state).toBe('running');
    } finally {
      await other.stopAll();
    }
  });
});

describe('review: two folders with the same name keep their own results', () => {
  it('matches jobs and receipts by the project folder, never by its name, and keeps paths out of receipts', async () => {
    const a = join(temp('ws-a-'), 'app');
    const b = join(temp('ws-b-'), 'app');
    for (const r of [a, b]) { put(r, 'BUILD.md', WORKFLOW); put(r, 'src/index.html', '<h1>Hello</h1>\n'); }
    const shared: ReceiptInput[] = [];
    const seal = (input: ReceiptInput): string => { shared.push(input); return `id${shared.length}`; };
    const receipts = (): Receipt[] => shared.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[];
    const jobsDir = join(temp('jobs-'), 'jobs');
    const A = make(a, { jobsDir, seal, receipts, edit: (path) => writeFileSync(path, '<h1>A</h1>\n') });
    const B = make(b, { jobsDir, seal, receipts });
    expect(text(A.ws.edit('src/index.html')).join('')).toContain('Saved src/index.html');
    await A.ws.run('BUILD.md build');
    await A.ws.jobs.done(A.ws.jobs.list()[0].id);
    await tick();
    const inA = text(A.ws.results('')).join('\n');
    expect(inA).toContain('BUILD.md › build');
    expect(inA).toMatch(/src\/index.html\s+your edit/);
    const inB = text(B.ws.results('')).join('\n');
    expect(inB).not.toContain('BUILD.md › build');
    expect(inB).not.toMatch(/your edit/);
    expect(shared.length).toBeGreaterThan(0);
    for (const r of shared) {
      expect(r.project_id).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(r)).not.toContain(a);
    }
  });
});

// Independent verification of b1ede23: a job's error ("spawn <absolute path> ENOENT", "no such folder: ...")
// and a typed /preview command reached the receipt with the project's absolute path.
describe('review follow-up: job receipts carry no absolute path', () => {
  it('writes the project folder as "." in a failed job\'s receipt', async () => {
    const root = site();
    const { ws, sealed } = make(root);
    await ws.preview(`${join(root, 'no-such-server')} --url http://127.0.0.1:9/`);
    const id = ws.jobs.list()[0].id;
    expect((await ws.jobs.done(id)).state).toBe('failed');
    await tick();
    const rec = sealed.at(-1);
    expect(rec?.kind).toBe('preview');
    expect(JSON.stringify(rec)).not.toContain(root);
    expect(rec?.job?.error).toMatch(/\.\/no-such-server/);
  });
});
