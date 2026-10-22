// R10 (H163): the Workbench's first frame waits on no walk of the project (R9's item B, for the Workbench).
//
// Measured from launch (a packed build at 122x37, every synchronous file system call recorded until the first frame): before
// its first frame the Workbench walked the project four times: its files twice (src/project listProjectFiles: up to 2,000
// files, each stat'd and peeked) and its workflow documents twice (src/workflows/upmd findWorkflowDocs: up to 5,000 folders,
// every .md read), once from the Controller's constructor and once more for the workspace frame it builds at once. On a
// project of 3,765 files that was about 350 ms of the first frame; with 400 workflow documents more, about 1.1 s.
//
// Now the Controller reads the files and the workflow documents once, right after its first frame (setImmediate), and the
// workspace frame uses that same reading. This test records every synchronous listing of the project's folders and every read
// of its Markdown documents from the moment the Controller is made until its first frame is composed. A walk lists every
// folder (the fixture's 20 folders under src/ are listed by nothing else) and reads every workflow document; none may happen
// before the first frame. The readers of Timmy's records and of the recent work list a few folders of their own (results/vox,
// results/flows, the project's top level, docs/), never the whole project, and are not counted. The first frame says the files
// and workflow documents are being read; right after, Home names their counts.
//
// Over a real Timmy home in a temporary folder: a tray-workflow project made by the starter code and the REPL's own
// Workspace, plus 200 FIXTURE files in 20 folders and 12 FIXTURE workflow documents. FAKE: the browser opener and the server
// starts; the run detail's and the chat session's producers have none.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ on: false, root: '', listed: [] as string[], read: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  /** a path of the project's own (not Timmy's records under .timmy) */
  const own = (p: unknown): boolean => {
    const s = String(p);
    if (!seen.on || !seen.root || !(s === seen.root || s.startsWith(`${seen.root}/`))) return false;
    return !s.slice(seen.root.length).startsWith('/.timmy');
  };
  const readdirSync = ((p: unknown, ...rest: unknown[]) => {
    if (own(p)) seen.listed.push(String(p));
    return (real.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readdirSync;
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (own(p) && /\.md$/i.test(String(p))) seen.read.push(String(p));
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readdirSync, readFileSync }, readdirSync, readFileSync };
});

import { spawnSync } from 'node:child_process';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import type { Line } from '../src/workbench/text.js';
import { armPlan, createPlan, dispatchPlan, getPlan, type DispatchPlan } from '../src/utils/dispatch.js';
import { issueApproval } from '../src/utils/approvals.js';
import { dispatchTmuxOfItsOwn } from './helpers/dispatch-tmux.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const rowText = (l: Line): string => l.map((s) => s.text).join('');
const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
// the dispatch sessions of this file on a tmux server of its own (tests/helpers/dispatch-tmux.ts), stopped after it
const tmuxOwn = dispatchTmuxOfItsOwn();
const dispatchPlanOf = (): DispatchPlan => ({
  schema_version: 'dispatch/0.1', objective: 'FIXTURE: a dispatch whose session ends outside Timmy', deliverables: ['patch'], acceptance_tests: ['npm test'],
  harnesses: ['pi'], model_policy: { requested: 'local/qwen', allow_paid: false, max_spend_usd: 0 }, copies: 1,
  cadence: { mode: 'parallel', depends_on: [] }, context_manifest: [], repo_ref: 'main', workspace: { kind: 'host-ephemeral' },
  permissions: { filesystem: 'rw-ephemeral', network: false, tools: [], secrets: [] }, limits: { cost_usd: 0, wall_ms: 60000 },
  retry_limit: 1, approval: { required: true, mode: 'manual' }, expected_artifacts: ['patch.diff'], telemetry: { redact: true, events: true },
});

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];
beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-first-frame-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  seen.on = false;
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

function bigTray(name: string): { name: string; root: string; chosen: boolean } {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  mkdirSync(join(made.root, '.timmy'), { recursive: true });
  writeFileSync(join(made.root, '.timmy', 'store-pin'), join(made.root, '.timmy', 'receipts'));
  // FIXTURE: a bigger project: 200 source files in 20 folders, and 12 workflow documents of one block each
  for (let d = 0; d < 20; d++) {
    mkdirSync(join(made.root, 'src', `mod${d}`), { recursive: true });
    for (let f = 0; f < 10; f++) writeFileSync(join(made.root, 'src', `mod${d}`, `file${f}.ts`), `export const n${f} = ${f};\n`);
  }
  mkdirSync(join(made.root, 'docs'));
  for (let i = 0; i < 12; i++) writeFileSync(join(made.root, 'docs', `step${i}.md`), `# Step ${i}\n\n\`\`\`bash [name:step${i}]\necho ${i}\n\`\`\`\n`);
  return made;
}

function workbench(p: { name: string; root: string; chosen: boolean }): Controller {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({ glyphs: glyphSet(true), env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
  spaces.push(ws);
  const c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 3_600_000,
  });
  opened.push(c);
  return c;
}

describe('the Workbench\'s first frame waits on no walk of the project (R10, H163; R9\'s item B)', { timeout: 60_000 }, () => {
  it('walks none of the project\'s folders and reads none of its workflow documents until the first frame; it says they are being read, then names them', async () => {
    const p = bigTray('first-frame');
    seen.root = p.root;
    seen.listed.length = 0;
    seen.read.length = 0;
    seen.on = true;
    const c = workbench(p);
    const first = c.frame(122, 37).screen.map(rowText).join('\n');
    seen.on = false;
    expect(seen.listed.filter((d) => d.startsWith(join(p.root, 'src'))), 'walked synchronously before the first frame: the folders under src/').toEqual([]);
    expect(seen.read, 'read synchronously before the first frame: the project\'s workflow documents').toEqual([]);
    expect(first).toMatch(/files and workflow documents being read/);
    // R10 (H167; the lead's note on this work): Home's recent work (H164's recentWork: the project's top level, its result
    // folders, its records) is read right after the first frame too, with the files it then takes as read: the first frame
    // says it is being read
    expect(c.data.recent, 'the recent work read before the first frame').toBeUndefined();
    expect(first).toMatch(/Reading the project's recent work…/);
    // right after the first frame: read once, and Home names them (the tray starter's files and the fixture's)
    let now = '';
    for (const end = Date.now() + 10_000; Date.now() < end && !/\d+ files · \d+ workflow documents/.test(now); await sleep(20)) now = c.frame(122, 37).screen.map(rowText).join('\n');
    expect(now).toMatch(/\b2\d\d files · 1[0-9] workflow documents\b/);
    expect(now).not.toMatch(/being read/);
    // and the recent work with them: the tray starter's files listed (its reference image, its workflow), no longer "being read"
    expect(c.data.recent?.items.length ?? 0).toBeGreaterThan(0);
    expect(now).not.toMatch(/Reading the project's recent work/);
  });

  it('reads the project\'s files and workflow documents once per reading: the workspace frame uses the Controller\'s own', async () => {
    const p = bigTray('one-walk');
    const c = workbench(p);
    let now = '';
    for (const end = Date.now() + 10_000; Date.now() < end && !/\d+ files · \d+ workflow documents/.test(now); await sleep(20)) now = c.frame(122, 37).screen.map(rowText).join('\n');
    // a reading of everything, as each slow tick and [r] make (readAll, then the workspace frame): the files walked once and the
    // workflow documents once (each lists every folder once, src/mod0 among them; each document is peeked once as a file and
    // read once as a workflow). Up to R10 the workspace frame walked both again: src/mod0 listed 4 times, each document read 4.
    await sleep(1100);   // past the frame's own once-a-second bound, so this reading builds one
    seen.root = p.root;
    seen.listed.length = 0;
    seen.read.length = 0;
    seen.on = true;
    c.readAll();
    c.refreshFrame();
    await sleep(1500);
    seen.on = false;
    expect(seen.listed.filter((d) => d === join(p.root, 'src', 'mod0')), 'listings of one source folder in one reading').toHaveLength(2);
    expect(seen.read.filter((f) => f.startsWith(join(p.root, 'docs'))), 'reads of the 12 workflow documents in one reading').toHaveLength(24);
  });

  it.skipIf(!hasTmux)('releases a dispatch copy whose session ended outside Timmy right after the first frame, never before it, and says so (R9\'s F11)', async () => {
    const p = bigTray('released');
    vi.stubEnv('TIMMY_DISPATCH_DRYRUN', '1');
    // FIXTURE: a dispatch of this project, its session then ended outside Timmy (its tmux session killed)
    const made = createPlan(dispatchPlanOf(), p.root);
    expect(made.ok, made.note).toBe(true);
    expect(armPlan(made.id!, issueApproval(made.plan_hash!).token, p.root).ok).toBe(true);
    const started = dispatchPlan(made.id!, p.root);
    expect(started.ok, started.note).toBe(true);
    expect(spawnSync('tmux', ['-L', tmuxOwn.label, 'kill-session', '-t', `=timmy-dp-${made.id}`]).status).toBe(0);
    expect(getPlan(made.id!, p.root)!.copy).toMatchObject({ state: 'in_use' });
    const c = workbench(p);
    c.frame(122, 37);
    // not before the first frame
    expect(getPlan(made.id!, p.root)!.copy).toMatchObject({ state: 'in_use' });
    for (const end = Date.now() + 10_000; Date.now() < end && getPlan(made.id!, p.root)!.copy!.state === 'in_use'; await sleep(20)) { /* the next turns */ }
    expect(getPlan(made.id!, p.root)!.copy).toMatchObject({ state: 'removed' });
    expect(c.ui.flash?.text).toBe(`Released a dispatch copy whose session had ended outside Timmy (its outputs kept): ${made.id}`);
  });
});
