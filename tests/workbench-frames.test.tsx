// R4 (H110): the terminal Workbench's frames, drawn by Ink through ink-testing-library at 80x24, 120x36 and 180x50, over a real
// Timmy home in a temporary folder: a tray-workflow project made by the starter code, the shared active-project record, the
// REPL's own Workspace and job store. FAKE here: the tools rows (no machine is probed), the opener and the server starts (none
// is pressed in this file), and a job record of another live session made by this test's own job store (a real `sleep`).
import React from 'react';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { JobManager } from '../src/jobs/index.js';
import { activeProjectPath, createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { WorkbenchApp } from '../src/workbench/app.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { workbenchJson } from '../src/workbench/state.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
// FAKE: two rows in the /tools ladder's shape (no program is run to find them)
const FAKE_ROWS: CapabilityRow[] = [
  { id: 'vox:stl', kind: 'vox', name: 'FAKE STL reader', rung: 'installed', detail: 'FAKE row for the frames test' },
  { id: 'blender', kind: 'adapter', name: 'FAKE Blender', rung: 'needs setup', detail: 'FAKE row', setup: 'install Blender (FAKE)' },
];

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-frames-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(() => {
  cleanup();
  for (const c of opened.splice(0)) c.dispose();
  vi.unstubAllEnvs();
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

/** A project made by the starter code, chosen in the shared record (as /project new does). */
function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  return made;
}

function workbench(project: { name: string; root: string; chosen: boolean }, o: { companion?: CompanionControl } = {}): Controller {
  const ws = new Workspace({
    glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t,
    seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined,
  }, project);
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    companion: o.companion ?? new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => FAKE_ROWS, tickMs: 100, slowMs: 400,
  });
  opened.push(c);
  return c;
}

function frameOf(c: Controller, columns: number, rows: number) {
  const app = <WorkbenchApp controller={c} colour={false} size={{ columns, rows }} />;
  const r = render(app);
  // ink-testing-library's terminal is always 100 columns wide: give it this frame's size, and Ink lays out again at it
  Object.defineProperty(r.stdout, 'columns', { configurable: true, get: () => columns });
  Object.defineProperty(r.stdout, 'rows', { configurable: true, get: () => rows });
  r.rerender(app);
  const lines = (): string[] => (r.lastFrame() ?? '').split('\n');
  return { r, lines, text: () => r.lastFrame() ?? '' };
}

/** Writes keys to Ink and waits for the frame to follow. */
async function press(r: ReturnType<typeof render>, ...keys: string[]): Promise<void> {
  for (const k of keys) { r.stdin.write(k); await sleep(60); }
  await sleep(80);
}

const TAB = '\t';
const DOWN = '\u001b[B';
const ESC = '\u001b';

describe('the terminal Workbench\'s frames (R4 H110)', () => {
  it('180x50: all five zones; every row exactly the width; the tray project\'s blocks; Tab moves the focus border', async () => {
    sandbox();
    const p = trayProject('tray-wide');
    const c = workbench(p);
    const f = frameOf(c, 180, 50);
    await sleep(100);
    const lines = f.lines();
    expect(lines).toHaveLength(50);
    expect(lines.every((l) => visibleWidth(l) === 180)).toBe(true);
    const t = f.text();
    // left, top, center, right, bottom
    expect(t).toMatch(/◆ TIMMY/); // the navigation has the keyboard first
    expect(t).toMatch(/CREATE[\s\S]*OPERATE[\s\S]*LIBRARY[\s\S]*Connections/);
    expect(t).toContain('Timmy Workbench');
    expect(t).toContain('tray-wide / Workflows');
    expect(t).toMatch(/run: idle\s+Stop current: idle/);
    expect(t).toContain('Workflows · plan and run');
    expect(t).toContain('Context');
    expect(t).toMatch(/Tools │ ▸ Inspector │\s+Files/);
    expect(t).toMatch(/Activity\s+0 running · 0 waiting on you/);
    for (const block of ['change', 'inspect', 'result', 'lesson', 'tidy']) expect(t).toContain(block);
    expect(t).toContain('⚠ needs you before it runs');
    // Tab: the center has the keyboard (its heavy border and marker), the navigation no longer
    await press(f.r, TAB);
    expect(f.text()).toMatch(/┏━ ◆ Workflows · plan and run/);
    expect(f.text()).not.toMatch(/◆ TIMMY/);
    await press(f.r, TAB);
    expect(f.text()).toMatch(/◆ Context/);
    // the right dock's tabs: End the last, Home the first, ← → between them (wrapping), as the reference's tabs
    await press(f.r, '\u001b[F');
    expect(f.text()).toMatch(/Tools │ {3}Inspector │ ▸ Files/);
    await press(f.r, '\u001b[H');
    expect(f.text()).toMatch(/▸ Tools │ {3}Inspector │ {3}Files/);
    await press(f.r, '\u001b[D');
    expect(f.text()).toMatch(/Tools │ {3}Inspector │ ▸ Files/);
    // focus mode (z): the center alone, with the top and the bottom; i opens the right dock as a drawer; z leaves it
    await press(f.r, 'z');
    expect(f.text()).toMatch(/┏━ ◆ Workflows · plan and run · focus mode \(z leaves it\)/);
    expect(f.text()).not.toMatch(/CREATE|Context/);
    expect(f.text()).toContain('tray-wide / Workflows');
    expect(f.lines().every((l) => visibleWidth(l) === 180)).toBe(true);
    await press(f.r, 'i');
    expect(f.text()).toMatch(/◆ Context \(drawer\)/);
    await press(f.r, ESC, 'z');
    expect(f.text()).toContain('CREATE');
    expect(f.text()).toMatch(/╭─ Context ─/);
  });

  it('120x36: the right dock is a drawer ([i]), the navigation stays; project, task, state and Stop are on top', async () => {
    sandbox();
    const p = trayProject('tray-medium');
    const c = workbench(p);
    const f = frameOf(c, 120, 36);
    await sleep(100);
    const lines = f.lines();
    expect(lines).toHaveLength(36);
    expect(lines.every((l) => visibleWidth(l) <= 120)).toBe(true);
    expect(f.text()).toMatch(/CREATE[\s\S]*OPERATE/);
    expect(f.text()).not.toContain('Context');
    expect(f.text()).toContain('tray-medium / Workflows');
    expect(f.text()).toContain('Stop current: idle');
    await press(f.r, 'i');
    expect(f.text()).toMatch(/◆ Context \(drawer\)/);
    expect(f.lines().every((l) => visibleWidth(l) <= 120)).toBe(true);
    await press(f.r, ESC);
    expect(f.text()).not.toContain('Context (drawer)');
  });

  it('80x24: the navigation and the right dock are drawers ([g], [i]); the top keeps the project, task, state and Stop', async () => {
    sandbox();
    const p = trayProject('tray-narrow');
    const c = workbench(p);
    const f = frameOf(c, 80, 24);
    await sleep(100);
    const lines = f.lines();
    expect(lines).toHaveLength(24);
    expect(lines.every((l) => visibleWidth(l) <= 80)).toBe(true);
    expect(f.text()).not.toMatch(/CREATE/);
    expect(f.text()).toContain('tray-narrow / Workflows');
    expect(f.text()).toMatch(/run: idle\s+Stop current: idle/);
    await press(f.r, 'g');
    expect(f.text()).toMatch(/◆ TIMMY[\s\S]*CREATE/);
    // the top still names the project and the task with the drawer open (it once lost them to the route's words)
    expect(f.lines()[1]).toContain('tray-narrow / Workflows');
    expect(f.lines().every((l) => visibleWidth(l) <= 80)).toBe(true);
    await press(f.r, ESC, 'i');
    // the drawer's title and all three tabs stay whole (a range note and the tabs' marker column once cut them)
    expect(f.text()).toMatch(/◆ Context \(drawer\)/);
    expect(f.text()).toMatch(/Tools │ ▸Inspector │ Files/);
    expect(f.text()).not.toMatch(/CREATE/);
  });

  it('a blank project: Files says "No files yet." with the blank guides, and the right Files tab says so too', async () => {
    sandbox();
    const made = createProject('blank-one');
    if ('error' in made) throw new Error(made.error);
    saveActiveProject(made);
    const c = workbench(made);
    c.selectWorkspace('files');
    const f = frameOf(c, 180, 50);
    await sleep(100);
    const t = f.text();
    expect(t).toContain('No files yet.');
    expect(t).toContain('This project is blank');
    expect(t).toMatch(/\[n\] New project from a public starter/);
    await press(f.r, TAB, TAB, '\u001b[C');
    expect(f.text()).toMatch(/▸ Files[\s\S]*No files yet\./);
  });

  it('a job another live session runs: in Control Room and Activity; Stop names it and leaves it running, with the command for that session', async () => {
    sandbox();
    const p = trayProject('tray-jobs');
    // FAKE: this test is the other live session; its own job store starts a real `sleep`
    const other = new JobManager({ dir: jobsDir });
    const job = other.start({ kind: 'task', label: 'FAKE job (test): sleep 60', project: p.name, root: p.root, command: 'sleep', args: ['60'] });
    try {
      for (let i = 0; i < 100 && other.get(job.id)?.state !== 'running'; i++) await sleep(30);
      const c = workbench(p);
      c.selectWorkspace('control');
      const f = frameOf(c, 180, 50);
      await sleep(150);
      expect(f.text()).toContain(`[x] Stop current: ${job.id} FAKE job (test): sleep 60`);
      expect(f.text()).toMatch(new RegExp(`RUNNING NOW \\(1\\)[\\s\\S]*${job.id}\\s+running\\s+FAKE job`));
      // the navigation's count for Control Room, in the longest words that fit whole
      expect(f.text()).toMatch(/▸ Control Room 1 run\s/);
      expect(f.text()).toMatch(new RegExp(`Activity\\s+\\S* ?1 running[\\s\\S]*${job.id} started: FAKE job`));
      await press(f.r, 'x');
      await sleep(400);
      expect(f.text()).toContain(`Nothing stopped: ${job.id} belongs to another Timmy session that is still running`);
      expect(other.get(job.id)?.state).toBe('running');
    } finally {
      await other.stop(job.id);
    }
  });

  it('the project picker chooses another project: the shared active-project record names it', async () => {
    sandbox();
    const a = trayProject('pick-a');
    const b = trayProject('pick-b');
    saveActiveProject(a);
    const c = workbench(a);
    const f = frameOf(c, 180, 50);
    await sleep(100);
    await press(f.r, 'p');
    expect(f.text()).toContain('Switch project');
    for (const ch of 'pick-b') f.r.stdin.write(ch);
    await sleep(100);
    await press(f.r, '\r');
    expect(JSON.parse(readFileSync(activeProjectPath(), 'utf8')).root).toBe(b.root);
    expect(f.text()).toContain('pick-b / ');
    expect(f.text()).toMatch(/Now in pick-b/);
  });

  it('Companion · Show starts one server (a FAKE start) and opens it through a private page, its key never on the screen; Stop serving stops it; Quick settings say "Saved locally" after the write; New makes a blank project', async () => {
    sandbox();
    const p = trayProject('tray-show');
    // FAKE: the server's start and the browser opener; the key is made here, at run time
    const key = randomBytes(16).toString('hex');
    const hrefs: string[] = [];
    let starts = 0;
    let stops = 0;
    const companion = new CompanionControl({
      opener: { program: 'FAKE opener', open: (href) => { hrefs.push(href); return { ok: true }; } },
      start: async () => { starts += 1; return { port: 4321, url: `http://127.0.0.1:4321/#token=${key}`, address: 'http://127.0.0.1:4321/', shutdown: async () => { stops += 1; } }; },
    });
    const c = workbench(p, { companion });
    const f = frameOf(c, 180, 50);
    await sleep(100);
    expect(hrefs).toEqual([]); // nothing opens before the press
    await press(f.r, 'c');
    await sleep(150);
    expect(f.text()).toContain('The Companion opened in your browser (http://127.0.0.1:4321/), through a private page that carries its key');
    expect(f.text()).not.toContain(key);
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toMatch(/^file:\/\//);
    const page = fileURLToPath(hrefs[0]);
    expect(readFileSync(page, 'utf8')).toContain(key);
    expect(statSync(page).mode & 0o777).toBe(0o600);
    // a second press opens the same server again: one start
    await press(f.r, 'c');
    await sleep(150);
    expect({ starts, opened: hrefs.length }).toEqual({ starts: 1, opened: 2 });
    await press(f.r, 'C');
    await sleep(100);
    expect(f.text()).toContain('The Companion at http://127.0.0.1:4321/ stopped serving.');
    expect(stops).toBe(1);
    // the private pages go with their minute or with the process; this test's worker does not end here, so it removes its own
    for (const h of hrefs) rmSync(dirname(fileURLToPath(h)), { recursive: true, force: true });

    // Quick settings: "Saved locally" only once the file is written
    const file = join(box, 'settings', 'workbench.json');
    await press(f.r, ',');
    expect(f.text()).toContain('Quick settings');
    expect(f.text()).not.toContain('Saved locally');
    await press(f.r, ' ');
    expect(f.text()).toMatch(/Saved locally at \d\d:\d\d:\d\d/);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ schema: 'timmy.workbench-settings/1', openCompanionAtStart: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(f.text()).toMatch(/\[x\] Open Companion at startup/);
    await press(f.r, ESC);

    // New: a blank project, made by the REPL's /project new, chosen in the shared record
    await press(f.r, 'n');
    expect(f.text()).toContain('New project');
    for (const ch of 'made-here') f.r.stdin.write(ch);
    await sleep(100);
    await press(f.r, '\r');
    const made = JSON.parse(readFileSync(activeProjectPath(), 'utf8'));
    expect(made.name).toBe('made-here');
    expect(existsSync(made.root)).toBe(true);
    expect(f.text()).toContain('made-here / ');
    expect(f.text()).toMatch(/Now in made-here[\s\S]*a blank project/);
  });

  it('--json\'s state model reads the same records (in this process)', async () => {
    sandbox();
    const p = trayProject('tray-json');
    const s = await workbenchJson({ cwd: p.root, jobsDir });
    expect(s.schema).toBe('timmy.workbench/1');
    expect(s.project.name).toBe('tray-json');
    expect(s.navigation.map((g) => g.group)).toEqual(['CREATE', 'OPERATE', 'LIBRARY', 'FOOT']);
    expect(s.navigation.flatMap((g) => g.items.map((i) => i.label))).toEqual(['Chat', 'Studio', 'VoxVision', '3D Create', 'Motion', 'Workflows', 'Control Room', 'God\'s Eye View', 'REA', 'Files', 'Templates', 'All tools', 'Connections']);
    expect(s.activity.stop_current).toEqual({ job: null, words: 'Stop current: idle' });
    expect(s.route.words).toMatch(/^chat: /);
    expect(s.workflows.docs.map((d) => d.rel).sort()).toEqual(['APPROVAL.md', 'WORKFLOW.md']);
    expect(s.workflows.docs.find((d) => d.rel === 'APPROVAL.md')?.blocks[0]).toMatchObject({ name: 'tidy', needs_person: true });
  });
});
