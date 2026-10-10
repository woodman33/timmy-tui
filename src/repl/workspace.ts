/**
 * The REPL's workspace (R1 workspace direction, 2026-10-08): one active project, its Files, Workflows
 * (upmd), background jobs (workflow runs and preview servers), Preview in Timmy's Browser, and Results —
 * all on the same project folder, the same job identity and the same receipt chain.
 *
 * Jobs run in their own process groups (src/jobs), so the REPL stays usable while they run and /stop
 * stops a job with its process group. A preview server is "ready" when its address answers, which is
 * not the same as a build being "completed". A workflow run seals its prediction first, then its outcome.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { JobManager, type JobRecord } from '../jobs/index.js';
import { aerenderJob, blenderJob, c4dpyJob, judgeNativeJob, nativeReceiptFields, NativeNotFound, noteNativeStarted, type NativeJobSpec } from '../native/index.js';
import { AE_USAGE, aeEndLines, aeReceiptFields, aeScriptJob, aeStartLines, isAeJobSpec, judgeAeJob, parseAeScriptArgs, type AeJobSpec, type AeMode } from '../native/ae-author.js';
import { mcpView, splitCommandLine } from '../connectors/mcp-cli.js';
import {
  chooseProject, createProject, groupFiles, humanBytes, listProjectFiles, listProjects, projectId, projectsHome, readProjectFile,
  resolveInside, ROLE_LABEL, ROLE_ORDER, sameFolder, saveActiveProject, writeProjectFile, type ActiveProject, type FileRole, type ProjectFile,
} from '../project/index.js';
import { staticServerCommand } from '../preview/static-server.js';
import { hashFile, intakeFiles, kindOf, splitArgs } from '../project/intake.js';
import { copyStarter, listStarters } from '../project/starters.js';
import { BOARD_BASE, BOARD_FILE, readObservationRecord, renderBoard, renderBoardBody, utcStamp, type BoardFile, type BoardInput, type BoardObservation } from './board.js';
import { LiveBoard, type BoardCommand, type LiveState } from './board-live.js';
import { dropLaunchPages } from '../utils/launch-page.js';
// Round R4 (H22): the board's parameter, workflow-graph and result cards, and the live board's edits.
import { gatherResults, paramsCard, type ResultCard } from './board-cards.js';
import { applyBoardEdit } from './board-edits.js';
import { workflowForBoard } from './board-nodes.js';
import { recipeEnded, recipeView, startRecipeJob, type RecipeContext, type RecipeStarted, type RecipeTestSeams } from './recipe.js';
import { cancelRecipe, cancelSentence, RecipeLaunches, type RecipeCancel } from './recipe-stop.js';
import { killProcessGroup } from '../runtime/spawn-runtime.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { readChain, type Receipt, type ReceiptInput } from '../utils/receipts.js';
import { checkOpenCv, DETERMINISTIC, INTERPRETATION, LOOK_MAX_IMAGE, LOOK_MAX_OUTPUT, LOOK_TIMEOUT_MS, lookArgs, lookPython, OBSERVATIONS_DIR, OPENCV_SETUP, parseLookOutput, writeObservation, lookEnv } from '../vision/look.js';
import { acceptsImages, describeImage, imageMime, MAX_IMAGE_BYTES } from '../vision/route.js';
// R3 (H14): /observe --qualify, the observed-handle + cite protocol (AGENTS.md §4).
import { qualifyInterpretation } from '../vision/evidence.js';
import { meteredQualifyClient, sdkQualifyClient, unlessAborted, type QualifyClient } from '../vision/qualify-route.js';
import { describeRefusal, interpretationSeal, QUALIFIED_PROTOCOL, qualifiedSeal } from '../evidence/observation-check.js';
// R4 (H20): what an observation keeps privately: a model's whole output past 64 KiB, its whole record when its file cannot be written.
import { keptReader, observationKeeper, wholeNote, type KeepPlaces, type KeptRef, type ObservationKeeper } from '../vision/kept.js';
import { findUpmd, findWorkflowDocs, parseUpmdLine, parseWorkflow, runOrder, stepsFromEvent, upmdRunArgs, upmdVersion } from '../workflows/upmd.js';
// Round R3 (/agent, helper H13): code agents as jobs; the code is in the "/agent" section below.
import { spawnSync, execFile } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import {
  AGENT_NAMES, AGENTS, AGENTS_DIR, agentBin, agentLabel, appendProgress, boundMessage, diffSnapshots, ensureDir, isGitDir, judgeAgentRun,
  listAgentRuns, newProgress, newRunId, parseAgentLine, planAgent, progressLine, readProgressTail, runDir, scrubPaths, snapshotJson, snapshotProject,
  taskWords, writeJson, type AgentName, type AgentPlan, type AgentProgress, type AgentRunRecord, type Snapshot,
} from '../code-agents/index.js';
// Round R4 (/iterate, helper H24): the connected flow (src/repl/iterate.ts); hooks are marked "R4 (/iterate)".
import { IterateFlows, type AgentStart, type IterateTestSeams } from './iterate.js';
import { readBoardFlows } from './board-flows.js';
import { FLOW_ID, FLOWS_DIR } from '../flows/iterate.js';

type Line = Segment[];

export interface WorkspaceDeps {
  glyphs: GlyphSet;
  env: NodeJS.ProcessEnv;
  onPath: (cmd: string) => string | null;
  /** A notice above the prompt (a step finished, a server is ready): the REPL's own printer. */
  notify: (line: Line) => void;
  /** Opens a page in Timmy's Browser (/web): carbonyl in a pane, else a link. One line back. `secret`: the address
   * carries one (the live board's token), so no command line may hold it (round R4, src/utils/launch-page.ts). */
  openWeb: (url: string, opts?: { secret?: boolean }) => string;
  /** An OSC 8 link where the terminal supports one, else the text. */
  link: (text: string, url: string) => string;
  /** Seals a receipt on the runs chain; its short id back (or undefined when sealing failed). */
  seal: (input: ReceiptInput) => string | undefined;
  /** Where job records and their private logs live (<TIMMY_HOME>/jobs). */
  jobsDir: string;
  /** Opens a file in the editor, in the foreground. */
  edit?: (path: string) => void;
  tildify?: (path: string) => string;
  /** The static preview server: this Node with Timmy's inline server unless a test gives another. */
  staticServer?: (dir: string, port: number) => { command: string; args: string[] };
  freePort?: () => Promise<number>;
  chdir?: (dir: string) => void;
  /** The project changed: the agent moves its conversation there; one line back to show. */
  onSwitch?: (p: ActiveProject) => string | undefined;
  receipts?: () => Receipt[];
  /** The agent's current model, for /observe's question (round R2, look); without it no model is asked. */
  model?: () => string;
  /** The fetch a model interpretation uses; a test gives a mock. */
  fetch?: typeof fetch;
  /** Round R3 (/recipe), test seams only: a fake recipe executor, the recipe supervisor's process, the watcher's poll. */
  recipeTest?: RecipeTestSeams;
  /** R3 (H14): the model client /observe --qualify uses (src/vision/qualify-route.ts); a test gives a labelled fake. */
  qualifyClient?: (apiKey: string) => QualifyClient;
  /** R4 (/iterate), test seams only: a FAKE readback worker. */
  iterateTest?: IterateTestSeams;
}

/** How an observation ended (round R2, look): its file and receipt, or why there is none. */
export type ObserveOutcome =
  | { ok: true; file: string; receipt?: string; tiers: string[]; interpretation?: Record<string, unknown>; qualified?: Record<string, unknown> }
  /** R4 (H20): `kept`, where the whole record is kept when the observation file could not be written */
  | { ok: false; error: string; receipt?: string; kept?: KeptRef };

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const sha256File = (path: string, limit = 16 * 1024 * 1024): string | undefined => {
  try {
    if (statSync(path).size > limit) return undefined;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch { return undefined; }
};
/** A file's first bytes (what kindOf reads), or none when it cannot be read. */
const headOf = (path: string, n = 32): Buffer => {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } catch { return Buffer.alloc(0); } finally { if (fd !== undefined) closeSync(fd); }
};
/** How much of each part a board shows (round R2, board); the rest is counted and named. */
const BOARD_MAX = { references: 60, outputs: 30, workflows: 20, jobs: 24, observations: 24 } as const;
/** A board hashes a file up to this size to show its short sha256; a larger one shows none. */
const BOARD_HASH_LIMIT = 8 * 1024 * 1024;
const fileUrl = (abs: string): string => `file://${encodeURI(abs)}`;
const ago = (ms: number): string => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const seconds = (j: JobRecord): string => {
  const end = j.endedAt ? Date.parse(j.endedAt) : Date.now();
  const s = (end - Date.parse(j.startedAt)) / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : s < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
};

/** A free loopback port: bind 0, read it, close. */
export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const a = srv.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    srv.close(() => resolve(port));
  });
});

/** Round R3 (/agent): `<agent> --version`'s first line (5 s at most), or null when it does not say. */
const agentVersion = (bin: string): Promise<string | null> => new Promise((resolve) => {
  try {
    execFile(bin, ['--version'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      const first = String(stdout ?? '').split('\n').map((l) => l.trim()).find(Boolean);
      resolve(!err && first ? first.slice(0, 60) : null);
    });
  } catch { resolve(null); }
});
/** Round R3 (/agent): `git diff --stat --relative` in the project (paths relative to it), or '' when git says nothing. */
const gitStat = (root: string): string => {
  const r = spawnSync('git', ['diff', '--stat', '--relative'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? String(r.stdout ?? '').trim().slice(0, 8000) : '';
};

interface Prediction { doc: string; block: string; order: string[]; receipt?: string }

/**
 * Round R3 (the independent review of 40022d9, finding 2): an observation in progress is one cancellable
 * operation, from Look's measurement to the model's answer. /stop, /stop all and the REPL's end abort it.
 */
interface Observing {
  abort: AbortController;
  /** settles once the observation is written and sealed, or it is known why there is none */
  done?: Promise<ObserveOutcome>;
  /** set while the model is asked, after the measurement: which model, since when, and whether the paid request is out */
  asking?: { model: string; since: number; sent: boolean };
}

/** Round R3 (/agent): a code agent's run while it is going: its plan, the project before it, its progress. */
interface AgentRunState {
  record: AgentRunRecord;
  plan: AgentPlan;
  root: string;
  dir: string;
  before: Snapshot;
  beforeTruncated: boolean;
  /** `git diff --stat --relative` before the run, when the project is in a git work tree */
  gitBefore: string | null;
  progress: AgentProgress;
}

/** R3 (H14): what an observation with a qualified answer adds to its reading. */
const QUALIFIED_READING = ' A qualified answer is admitted only when it cites, through the cite tool, measurements observed in its own run on these exact bytes; it is still a model\'s claim, and whether it is right is not verified.';
/** R3 (H14): the question /observe --qualify asks when none is given. */
const QUALIFY_DEFAULT_QUESTION = 'What do these measurements show about the image?';
/** How long /stop and the REPL's end wait for a stopped observation to be recorded. */
const OBSERVE_SETTLE_MS = 10_000;
const within = <T>(p: Promise<T>, ms = OBSERVE_SETTLE_MS): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), ms).unref(); })]);

export class Workspace {
  project: ActiveProject;
  readonly jobs: JobManager;
  private readonly predictions = new Map<string, Prediction>();
  private readonly seen = new Map<string, { state: string; done: number }>();
  private upmdFound: { bin: string; version: string | null } | null = null;
  /** The jobs this REPL started: the only ones it may stop. */
  private readonly mine = new Set<string>();
  /** R2: native jobs (Cinema 4D, After Effects) this REPL started, with what they must leave behind */
  private readonly natives = new Map<string, NativeJobSpec>();
  /** Look jobs: their one receipt is the observation's, sealed when it is written (not the job's). */
  private readonly looks = new Set<string>();
  /** Round R3: observations still in progress, by their Look job's id (measuring, or asking the model). */
  private readonly observing = new Map<string, Observing>();
  /** Round R3: the live board this REPL serves on 127.0.0.1 (/board live), until /board off or the REPL's end. */
  private live?: LiveBoard;
  /** Round R3 (/recipe): each recipe watcher job's recipe job UUID (its operation ID). */
  private readonly recipes = new Map<string, string>();
  /** Round R4 (H17): recipes being launched, before their watcher exists; the REPL's end cancels them too. */
  private readonly launches = new RecipeLaunches();
  /** Round R3 (/agent): code-agent runs this REPL started, by their job's id: sealed by sealAgent, not as a plain task. */
  private readonly agentRuns = new Map<string, AgentRunState>();
  /** R4 (/iterate): jobs whose one receipt their flow seals (a readback), not the plain job seal. */
  private readonly selfSealed = new Set<string>();
  /** R4 (/iterate): the flows this REPL runs. */
  private readonly flows: IterateFlows;

  constructor(private readonly d: WorkspaceDeps, start: ActiveProject) {
    this.project = start;
    this.jobs = new JobManager({ dir: d.jobsDir, onChange: (job) => this.changed(job), seal: (job) => this.sealJob(job) });
    this.flows = new IterateFlows({
      glyphs: d.glyphs, env: () => this.d.env, onPath: d.onPath, notify: (l) => this.d.notify(l), seal: (input) => this.d.seal(input), jobs: this.jobs,
      startJob: (spec, o) => { const job = this.jobs.start(spec); this.mine.add(job.id); if (o?.selfSealed) this.selfSealed.add(job.id); return job; },
      startAgent: (name, task, o) => this.startAgentRun(name, task, o),
      startRecipe: (root, project, given) => startRecipeJob({ ...this.recipeContext(), root, project }, given),
      scrub: (t, root) => this.scrub(t, root),
      // R4 (H26): /iterate blender's Blender run, started and adopted as /blender's (judged and sealed at its end).
      startNative: (spec) => { const job = this.jobs.start(spec); try { noteNativeStarted(spec, job); } catch { /* the record says it was submitted */ } this.adoptNative(job.id, spec); return job; },
      ...(d.iterateTest ? { test: d.iterateTest } : {}),
    });
  }

  get root(): string { return this.project.root; }
  private get sep(): string { return ` ${this.d.glyphs.sep} `; }
  private tilde(p: string): string { return this.d.tildify ? this.d.tildify(p) : p; }
  private fileLink(rel: string): string { return this.d.link(rel, fileUrl(join(this.root, rel))); }
  private say(text: string, role: Segment['role'] = 'secondary'): Line[] { return [[{ text: `  ${text}`, role }]]; }

  // ── /project ────────────────────────────────────────────────────────────────

  project_(args: string): Line[] {
    const a = args.trim();
    if (a === 'list') {
      const all = listProjects();
      if (!all.length) return this.say(`No projects in ${this.tilde(projectsHome())} yet: /project new <name> makes one.`);
      return all.map((p) => [
        { text: `  ${p.root === this.root ? this.d.glyphs.bullet : ' '} ` },
        { text: p.name.padEnd(22), role: p.root === this.root ? 'strong' : undefined },
        { text: ` ${this.tilde(p.root)}`, role: 'secondary' },
      ]);
    }
    if (a === 'new' || a.startsWith('new ')) {
      // Round R2: `/project new <name> --from <starter>` fills the new project from templates/<starter>.
      const from = a.match(/(?:^|\s)--from(?:(?:=|\s+)(\S+))?(?=\s|$)/);
      const name = a.slice(3).replace(from?.[0] ?? '', ' ').trim();
      if (from) {
        const starters = listStarters();
        const pick = starters.find((s) => s.name === from[1]);
        if (!pick) {
          const have = starters.map((s) => `${s.name} (${s.about})`).join('; ') || 'none in this Timmy';
          return this.say(`${from[1] ? `No starter named ${from[1]}` : 'Name a starter'}. Starters: ${have}.`);
        }
      }
      const made = createProject(name);
      if ('error' in made) return this.say(made.error);
      let note = '';
      if (from?.[1]) {
        const copied = copyStarter(from[1], made.root);
        if ('error' in copied) return this.say(`Made ${made.name}, but its starter was not copied: ${copied.error}`);
        note = ` from ${from[1]}: ${copied.files.length} files, yours to edit`;
      }
      this.use(made);
      return [[{ text: `  Made ${made.name}${note}.`, role: 'strong' }], ...this.summary()];
    }
    if (a) {
      const chosen = chooseProject(a, this.root);
      if ('error' in chosen) return this.say(chosen.error);
      this.use(chosen);
    }
    return this.summary();
  }

  private switched: string | undefined;

  private use(p: ActiveProject): void {
    (this.d.chdir ?? process.chdir)(p.root);
    this.project = p;
    saveActiveProject(p);
    this.switched = this.d.onSwitch?.(p);
  }

  summary(): Line[] {
    const { files, truncated } = listProjectFiles(this.root);
    const counts = groupFiles(files).map((g) => `${g.label} ${g.files.length}`).join(this.sep) || 'no files yet';
    const live = this.jobs.list().filter((j) => !j.stale && (j.state === 'running' || j.state === 'ready'));
    return [
      [{ text: '  Project  ', role: 'secondary' }, { text: this.project.name, role: 'strong' }, { text: this.project.chosen ? '' : '  (this folder)', role: 'secondary' }],
      [{ text: '  Folder   ', role: 'secondary' }, { text: this.d.link(this.tilde(this.root), fileUrl(this.root)) }],
      [{ text: '  Files    ', role: 'secondary' }, { text: `${files.length}${truncated ? '+' : ''}: ${counts}` }],
      [{ text: '  Jobs     ', role: 'secondary' }, { text: live.length ? live.map((j) => `${j.id} ${j.state}`).join(', ') : 'none running' }],
      ...(this.switched ? [[{ text: '  Context  ', role: 'secondary' as const }, { text: this.switched }]] : []),
      [{ text: '  Next     ', role: 'secondary' }, { text: '/files, /workflows, /preview, /results', role: 'secondary' }],
    ];
  }

  // ── /files, /open, /edit ────────────────────────────────────────────────────

  files(args: string): Line[] {
    const a = args.trim();
    const { files, truncated } = listProjectFiles(this.root);
    const lower = a.toLowerCase();
    const role = ROLE_ORDER.find((r) => lower && (r === lower || ROLE_LABEL[r].toLowerCase() === lower || `${r}s` === lower)) as FileRole | undefined;
    const under = !role && a ? a.replace(/^\.?\/+/, '').replace(/\/+$/, '') : '';
    const picked = files.filter((f) => (!role || f.role === role) && (!under || f.rel === under || f.rel.startsWith(`${under}/`)));
    const scope = role ? `${this.sep}${ROLE_LABEL[role]}` : under ? `${this.sep}${under}/` : '';
    const lines: Line[] = [[{ text: `  ${this.project.name}  `, role: 'strong' }, { text: `${this.tilde(this.root)}${scope}`, role: 'secondary' }]];
    if (!picked.length) return [...lines, ...this.say(files.length ? 'Nothing here matches.' : 'No files yet. Add some, or ask Timmy to write them.')];
    const per = role || under ? 40 : 8;
    for (const g of groupFiles(picked)) {
      lines.push([{ text: `  ${g.label} (${g.files.length})`, role: 'strong' }]);
      for (const f of g.files.slice(0, per)) lines.push([{ text: '    ' }, { text: this.fileLink(f.rel) }, { text: `  ${this.detail(f)}`, role: 'secondary' }]);
      if (g.files.length > per) lines.push([{ text: `    and ${g.files.length - per} more: /files ${g.role}`, role: 'secondary' }]);
    }
    if (truncated) lines.push(...this.say('Only the first 2,000 files are listed.'));
    lines.push(...this.say('Show one: /open <file>; edit it: /edit <file>'));
    return lines;
  }

  private detail(f: ProjectFile): string {
    if (f.role === 'workflow') {
      const r = readProjectFile(this.root, f.rel, 256 * 1024);
      const named = r.ok && r.text ? parseWorkflow(r.text).filter((b) => b.name).map((b) => b.name) : [];
      if (named.length) return `blocks: ${named.join(', ')}`;
    }
    return `${humanBytes(f.bytes)}${this.sep}${ago(f.mtimeMs)}`;
  }

  open(args: string): Line[] {
    const rel = args.trim();
    if (!rel) return this.say('Usage: /open <file>   (/files lists them)');
    const r = readProjectFile(this.root, rel, 64 * 1024);
    if (!r.ok) return this.say(r.error);
    const lines: Line[] = [[{ text: `  ${this.fileLink(r.rel)}`, role: 'strong' }, { text: `  ${humanBytes(r.bytes)}${r.sha256 ? `${this.sep}sha256 ${r.sha256.slice(0, 12)}` : ''}`, role: 'secondary' }]];
    if (r.binary) return [...lines, ...this.say('A binary file: not shown here. The link opens it.')];
    const blocks = parseWorkflow(r.text ?? '').filter((b) => b.name);
    if (blocks.length) {
      lines.push(...this.say('A workflow (upmd). Its blocks:'));
      for (const b of blocks) lines.push([{ text: `    ${String(b.index).padStart(2)} ${String(b.name).padEnd(16)}` }, { text: b.deps.length ? `needs ${b.deps.join(', ')}` : '', role: 'secondary' }]);
      lines.push(...this.say(`Run one: /run ${r.rel} ${blocks[blocks.length - 1].name}`));
      return lines;
    }
    const text = (r.text ?? '').split('\n');
    for (const l of text.slice(0, 30)) lines.push([{ text: `  ${this.d.glyphs.sep} `, role: 'secondary' }, { text: l }]);
    if (text.length > 30 || r.truncated) lines.push(...this.say(`${text.length > 30 ? text.length - 30 : 'more'} more lines: /edit ${r.rel}, or the link`));
    return lines;
  }

  edit(args: string): Line[] {
    const rel = args.trim();
    if (!rel) return this.say('Usage: /edit <file>   (a new file is made when you save)');
    const at = resolveInside(this.root, rel);
    if ('error' in at) return this.say(at.error);
    if (!this.d.edit) return this.say(`No editor here. Open ${this.fileLink(at.rel)} yourself.`);
    const before = sha256File(at.path);
    this.d.edit(at.path);
    const after = sha256File(at.path);
    if (after === undefined) return this.say(`${at.rel} was not saved.`);
    if (after === before) return this.say(`No change to ${at.rel}.`);
    const id = this.d.seal({
      kind: 'edit', subject: `edit · ${at.rel}`, policy: 'human-gated', status: 'ok', project: this.project.name, project_id: projectId(this.root),
      files: [{ path: at.rel, sha256: after, ...(before ? { previous_sha256: before } : {}), created: before === undefined, bytes: statSync(at.path).size }],
    });
    return [[{ text: `  Saved ${this.fileLink(at.rel)}`, role: 'strong' }, { text: `${id ? `${this.sep}receipt ${id}` : ''}${this.sep}/results`, role: 'secondary' }]];
  }

  // ── /add, /observe (round R2, look: references in, observations out) ────────

  /** `/add <path…>`: copies files into refs/ (never moves them) and seals one intake receipt. */
  add(args: string): Line[] {
    const paths = splitArgs(args.trim());
    if (!paths.length) return this.say('Usage: /add <file…>   copies into refs/; quote a name with spaces');
    const r = intakeFiles(this.root, paths, { cwd: this.root });
    const lines: Line[] = [];
    if (r.added.length) {
      const id = this.d.seal({
        kind: 'intake', subject: `intake · ${r.added.length} file${r.added.length === 1 ? '' : 's'} into refs/`, policy: 'human-gated', status: 'ok',
        project: this.project.name, project_id: projectId(this.root),
        // The source is named by its base name only, and only when the copy's name differs (a clash).
        files: r.added.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, kind: f.kind, kind_by: f.by, ...(f.path.endsWith(`/${f.source_name}`) ? {} : { source_name: f.source_name }) })),
      });
      lines.push([{ text: `  Added ${r.added.length} file${r.added.length === 1 ? '' : 's'} to refs/`, role: 'strong' }, { text: id ? `${this.sep}receipt ${id}` : '', role: 'secondary' }]);
      for (const f of r.added) {
        lines.push([{ text: '    ' }, { text: this.fileLink(f.path) }, { text: `  ${f.kind}${this.sep}${humanBytes(f.bytes)}${f.note ? `${this.sep}${f.note}` : ''}`, role: 'secondary' }]);
      }
    }
    for (const x of r.refused) lines.push([{ text: `  Not added ${x.name}: `, role: 'failure' }, { text: x.reason, role: 'secondary' }]);
    if (r.added.length) {
      const image = r.added.find((f) => f.kind === 'image');
      lines.push(...this.say(`The agent can read them now with read_project_file${image ? `; measure an image: /observe ${image.path}` : ''}`));
    }
    return lines;
  }

  /**
   * Starts Look on a project file as a job (an id, progress, /stop, a log); `done` settles once the
   * observation is written and sealed, or once it is known why there is none. With a question and a
   * current model that takes images, the model's interpretation is added (it spends: the operator asked).
   * R3 (H14): with `opts.qualify`, the model is asked through the observed-handle + cite protocol instead
   * (qualifyObserved); without a question it asks QUALIFY_DEFAULT_QUESTION.
   */
  async observeFile(relArg: string, question?: string, model?: string, opts?: { qualify?: boolean }): Promise<{ ok: true; job: JobRecord; done: Promise<ObserveOutcome> } | { ok: false; error: string }> {
    const at = resolveInside(this.root, relArg.trim());
    if ('error' in at) return { ok: false, error: at.error };
    try {
      const st = statSync(at.path);
      if (!st.isFile()) return { ok: false, error: `${at.rel} is not a file` };
      if (st.size > LOOK_MAX_IMAGE) return { ok: false, error: `${at.rel} is larger than ${LOOK_MAX_IMAGE / 1024 / 1024} MB, more than Look reads` };
    } catch { return { ok: false, error: `${at.rel} does not exist` }; }
    const py = lookPython(this.d.env, this.d.onPath);
    if ('error' in py) return { ok: false, error: `Look needs a Python with OpenCV: ${py.error}. Setup: ${OPENCV_SETUP}` };
    const cv = await checkOpenCv(py.python, lookEnv(this.d.env));
    if (!cv.ok) return { ok: false, error: `${cv.error}. Setup: ${OPENCV_SETUP}, or set TIMMY_VISION_PYTHON to a Python that has it` };
    let source: { path: string; sha256: string; bytes: number };
    try { source = { path: at.rel, sha256: hashFile(at.path), bytes: statSync(at.path).size }; } catch { return { ok: false, error: `${at.rel} cannot be read` }; }
    const root = this.root;
    const project = this.project.name;
    const job = this.jobs.start({ kind: 'task', label: `look ${at.rel}`, project, root, command: py.python, args: lookArgs(at.path, at.rel), timeoutMs: LOOK_TIMEOUT_MS, env: lookEnv(this.d.env) });
    this.mine.add(job.id);
    this.looks.add(job.id);
    const q = question?.trim() || undefined;
    // Round R3: the measurement and the model's answer are one operation, with one stop: the entry's abort.
    const entry: Observing = { abort: new AbortController() };
    this.observing.set(job.id, entry);
    // R3 (H14): --qualify asks for an answer admitted only through cited Look measurements; it needs a question.
    const qualify = opts?.qualify === true;
    const asked = q ?? (qualify ? QUALIFY_DEFAULT_QUESTION : undefined);
    const done = this.jobs.done(job.id).then((j) => this.observed(j, { root, project, imagePath: at.path, source, question: asked, ...(model ? { model } : {}), ...(qualify ? { qualify } : {}) }, entry))
      .catch((err: unknown): ObserveOutcome => ({ ok: false, error: `the observation could not be finished (${err instanceof Error ? err.message : 'error'})` }))
      .finally(() => { if (this.observing.get(job.id) === entry) this.observing.delete(job.id); });
    entry.done = done;
    return { ok: true, job, done };
  }

  /** `/observe <file> [question]`: starts Look; the observation arrives as a notice and in /results. */
  async observe(args: string): Promise<Line[]> {
    let a = args.trim();
    // R3 (H14): `--qualify`, before or after the file.
    const flag = /^--qualify(?:\s|$)/;
    let qualify = flag.test(a);
    if (qualify) a = a.slice('--qualify'.length).trim();
    const m = a.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s*([\s\S]*)$/);
    if (!a || !m) return this.say('Usage: /observe <file> [--qualify] [question]   (a question asks the current model too; --qualify admits only an answer that cites the measurements)');
    const rel = m[1] ?? m[2] ?? m[3];
    let rest = m[4].trim();
    if (flag.test(rest)) { qualify = true; rest = rest.slice('--qualify'.length).trim(); }
    const question = rest.replace(/^(["'])([\s\S]*)\1$/, '$2');
    const started = await this.observeFile(rel, question, undefined, qualify ? { qualify } : undefined);
    if (!started.ok) return this.say(started.error, 'failure');
    const g = this.d.glyphs;
    const model = this.d.model?.();
    return [
      [{ text: '  Observing  ', role: 'secondary' }, { text: started.job.id, role: 'strong' }, { text: `  ${started.job.label.slice(5)}: measuring with Look${this.sep}/jobs ${started.job.id}${this.sep}/stop ${started.job.id}`, role: 'secondary' }],
      ...(question && !qualify ? [[{ text: '  Then asks ', role: 'secondary' as const }, { text: model ?? 'no model known here', role: model ? 'ai' as const : 'estimate' as const }, { text: ` ${g.arrow} a model interpretation, a claim beside the measurements`, role: 'secondary' as const }]] : []),
      // R3 (H14): the qualified route says what it admits.
      ...(qualify ? [[{ text: '  Then asks ', role: 'secondary' as const }, { text: model ?? 'no model known here', role: model ? 'ai' as const : 'estimate' as const }, { text: ` ${g.arrow} an answer admitted only if it cites Look's measurements (cite tool, this run, this image); still a claim`, role: 'secondary' as const }]] : []),
    ];
  }

  private async observed(j: JobRecord, o: { root: string; project: string; imagePath: string; source: { path: string; sha256: string; bytes: number }; question?: string; model?: string; qualify?: boolean }, entry?: Observing): Promise<ObserveOutcome> {
    const g = this.d.glyphs;
    const rel = o.source.path;
    const ms = j.endedAt ? Date.parse(j.endedAt) - Date.parse(j.startedAt) : undefined;
    const log = sha256File(j.logPath);
    const jobInfo = {
      id: j.id, kind: j.kind, label: j.label, state: j.state, exit_code: j.exitCode ?? null,
      ...(log ? { log_sha256: log } : {}), ...(ms !== undefined ? { ms } : {}), ...(j.error ? { error: this.scrub(j.error, o.root) } : {}),
    };
    const base = { kind: 'observe', policy: 'human-gated', project: o.project, project_id: projectId(o.root), files: [{ ...o.source }], job: jobInfo };
    const fail = (why: string, status: 'failed' | 'cancelled'): ObserveOutcome => {
      const error = this.scrub(why, o.root);
      let receipt: string | undefined;
      try { receipt = this.d.seal({ ...base, subject: `observe · ${rel} · ${status}`, status, observation: { tiers: [], error } }); } catch { receipt = undefined; }
      this.d.notify([{ text: `  ${g.fail} ` }, { text: `${j.id} not observed`, role: 'failure' }, { text: `  ${rel}: ${error}${receipt ? `${this.sep}receipt ${receipt}` : ''}`, role: 'secondary' }]);
      return { ok: false, error, ...(receipt ? { receipt } : {}) };
    };
    let output = '';
    try {
      if (statSync(j.logPath).size > LOOK_MAX_OUTPUT) return fail('Look printed more than it may', 'failed');
      output = this.jobs.tail(j.id, 400).join('\n');
    } catch { /* no log: read as no output */ }
    const parsed = parseLookOutput(output, rel);
    if (j.state === 'cancelled') return fail('stopped before it finished', 'cancelled');
    if (j.state !== 'completed') return fail(!parsed.ok && output ? parsed.error : j.error ?? `Look exited ${j.exitCode ?? j.signal ?? '?'}`, 'failed');
    if (!parsed.ok) return fail(parsed.error, 'failed');
    const look = parsed.observation;
    if (look.source.sha256 !== o.source.sha256) return fail(`${rel} changed while Look read it`, 'failed');
    // An interpretation's cost_usd (round R3): absent when no request went out (nothing can have been charged);
    // null when one went out and no cost was reported (unknown, never 0); the reported amount otherwise.
    let interpretation: Record<string, unknown> | undefined;
    // R3 (H14): --qualify runs the observed-handle + cite protocol instead of the plain interpretation.
    let qualified: Record<string, unknown> | undefined;
    // R4 (H20): keeps a model's whole output when the record keeps only its first 64 KiB, and the whole record when its file cannot be written.
    const keeper = observationKeeper(this.keepPlaces(o.root), j.id);
    if (o.question && o.qualify) qualified = await this.qualifyObserved(j, o, look, entry, keeper);
    else if (o.question) {
      const model = o.model ?? this.d.model?.();
      if (!model) interpretation = { tier: INTERPRETATION, status: 'not asked', question: o.question, reason: 'no current model is known here' };
      else {
        // Round R3: the measurement has completed; the model is asked inside the same operation, so /stop reaches it.
        if (entry) entry.asking = { model, since: Date.now(), sent: false };
        const onRequest = (): void => {
          if (entry?.asking) { entry.asking.sent = true; entry.asking.since = Date.now(); }
          this.d.notify([{ text: `  ${g.bullet} ` }, { text: `${j.id} measured`, role: 'strong' }, { text: `  ${rel}${this.sep}interpreting with ${model}, a paid request${this.sep}/stop ${j.id} stops it`, role: 'secondary' }]);
        };
        const r = await describeImage({
          model, imagePath: o.imagePath, question: o.question, apiKey: this.d.env.OPENROUTER_API_KEY, ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
          ...(entry ? { signal: entry.abort.signal } : {}), onRequest, keepWhole: (whole) => keeper.whole('answer', whole),
        });
        if (entry) entry.asking = undefined;
        if (r.ok && r.image_sha256 !== o.source.sha256) {
          // The claim is about the bytes the model saw, and they are not the bytes Look measured. Round R3: the paid
          // answer is kept as it came, with its charge and the hash of what the model saw, but rejected: not a claim
          // about this observation's input.
          const { ok: _ok, ...rest } = r;
          interpretation = { status: 'rejected', ...rest, reason: `${rel} changed between Look and the model: the model saw other bytes (sha256 ${r.image_sha256.slice(0, 12)}, not the measured ${o.source.sha256.slice(0, 12)}), so its answer is kept as it came and is not a claim about what Look measured` };
        } else if (r.ok) { const { ok: _ok, ...rest } = r; interpretation = { status: 'answered', ...rest }; }
        else {
          interpretation = {
            tier: INTERPRETATION, status: r.refused ? 'refused' : r.cancelled ? 'cancelled' : 'failed', model, question: o.question, reason: r.error,
            ...(r.alternatives ? { alternatives: r.alternatives } : {}),
            ...(r.sent ? { cost_usd: r.cost_usd ?? null, ...(r.tokens !== undefined ? { tokens: r.tokens } : {}) } : {}),
          };
        }
      }
    }
    const answered = interpretation?.status === 'answered';
    const rejected = interpretation?.status === 'rejected';
    const admitted = qualified?.status === 'admitted';
    const tiers = [DETERMINISTIC, ...(answered || admitted ? [INTERPRETATION] : [])];
    const now = new Date();
    const record = {
      observation: 1, made_at: now.toISOString(), project: o.project, source: o.source, tiers,
      reading: `Measurements are deterministic computations on the pixels. An interpretation is a model's claim about the image, not a measurement.${qualified ? QUALIFIED_READING : ''}`,
      look, ...(interpretation ? { interpretation } : {}), ...(qualified ? { qualified } : {}), job: { id: j.id },
    };
    // Round R3: a charge the response reported is sealed whatever became of the answer; a request that went out
    // with no charge reported is sealed as an unknown cost (cost_measured: false), never as $0. R4 (H20, the review
    // of 07f37ec, finding 1): worked out before the file is written, so a file that cannot be written loses none of it.
    const spent = interpretation ?? qualified;
    const charged = spent && 'cost_usd' in spent ? (typeof spent.cost_usd === 'number' ? spent.cost_usd : null) : undefined;
    const cost = typeof charged === 'number' ? charged : undefined;
    const costText = charged === null ? 'cost unknown' : cost === undefined ? '' : `cost $${cost.toFixed(4)}`;
    const tokens = spent?.tokens;
    const accounting: Pick<ReceiptInput, 'model_requested' | 'model_resolved' | 'tokens' | 'cost_usd' | 'cost_measured'> = {
      ...(charged !== undefined ? { model_requested: String(spent?.model_requested ?? spent?.model) } : {}),
      ...(answered || rejected ? { model_resolved: String(interpretation?.model) } : {}),
      ...(qualified && typeof qualified.model_resolved === 'string' ? { model_resolved: qualified.model_resolved } : {}),
      ...(typeof tokens === 'number' && Number.isFinite(tokens) ? { tokens } : {}),
      ...(cost !== undefined ? { cost_usd: cost } : charged === null ? { cost_measured: false } : {}),
    };
    // What the model returned, sealed by its hashes (the whole text's, and the cut part's when the record holds only that).
    const claims = { ...(interpretation ? { interpretation: interpretationSeal(interpretation) } : {}), ...(qualified ? { qualified: qualifiedSeal(qualified) } : {}) };
    let w: ReturnType<typeof writeObservation>;
    try { w = writeObservation(o.root, rel, record, now); } catch (e) { w = { ok: false, error: `it could not be written (${e instanceof Error ? e.message : 'error'})` }; }
    if (!w.ok) return this.unwritten(j, o, { base, record, keeper, storage: w.error, accounting, claims, costText, ...(spent ? { spent } : {}) });
    let receipt: string | undefined;
    try {
      receipt = this.d.seal({
        ...base, subject: `observe · ${rel}`, status: 'ok', outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
        observation: { tiers, worker: `${look.worker.name} ${look.worker.version}`, opencv: look.opencv, measurements: look.measurements.length, ...claims },
        ...accounting,
      });
    } catch { receipt = undefined; }
    /** R4 (H20): where the whole of a cut text is kept, for a notice. */
    const whole = (s: Record<string, unknown> | undefined, field: string, label: string): string => {
      const n = wholeNote(s, field, label, (ref) => this.keptShown(ref));
      return n ? `${this.sep}${n}` : '';
    };
    this.d.notify([{ text: `  ${g.ok} ` }, { text: `${j.id} observed`, role: 'strong' }, { text: `  ${rel} ${g.arrow} ${w.path}${this.sep}${tiers.join(', ')}${receipt ? `${this.sep}receipt ${receipt}` : ''}`, role: 'secondary' }]);
    if (interpretation && !answered) {
      const alt = Array.isArray(interpretation.alternatives) && interpretation.alternatives.length ? `; models that do: ${(interpretation.alternatives as string[]).join(', ')} (/model <id>)` : '';
      const kept = rejected ? `${this.sep}${String(interpretation.model)}'s answer is in the file, not as a claim` : '';
      this.d.notify([{ text: '  Model      ', role: 'secondary' }, { text: `${String(interpretation.reason)}${alt}${kept}${whole(interpretation, 'answer', 'answer')}${costText ? `${this.sep}${costText}` : ''}`, role: 'estimate' }]);
    } else if (answered) {
      this.d.notify([{ text: '  Model      ', role: 'secondary' }, { text: `${String(interpretation?.model)} answered (a claim, in the file)${whole(interpretation, 'answer', 'answer')}${this.sep}cost ${cost === undefined ? 'not reported' : `$${cost.toFixed(4)}`}`, role: 'ai' }]);
    }
    if (qualified) {
      // R3 (H14): an admitted answer is a model's claim whose citations point at measured values; never a measurement.
      const cites = Array.isArray(qualified.cites) ? (qualified.cites as Array<{ measurement?: unknown }>).map((c) => String(c.measurement)).join(', ') : '';
      this.d.notify(admitted
        ? [{ text: '  Model      ', role: 'secondary' }, { text: `${String(qualified.model)} answered, citing ${cites} (measured values; the answer is a claim, in the file)${whole(qualified, 'answer', 'answer')}${whole(qualified, 'raw_output', 'raw output')}${costText ? `${this.sep}${costText}` : `${this.sep}cost not reported`}`, role: 'ai' }]
        : [{ text: '  Model      ', role: 'secondary' }, { text: `no admitted answer: ${String(qualified.status)}${typeof qualified.refusal === 'string' ? ` (${qualified.refusal})` : ''}: ${String(qualified.reason)}${typeof qualified.raw_output === 'string' && qualified.raw_output ? `${this.sep}the raw output is in the file, not as a claim` : ''}${whole(qualified, 'raw_output', 'raw output')}${costText ? `${this.sep}${costText}` : ''}`, role: 'estimate' }]);
    }
    return { ok: true, file: w.path, tiers, ...(receipt ? { receipt } : {}), ...(interpretation ? { interpretation } : {}), ...(qualified ? { qualified } : {}) };
  }

  /**
   * R3 (H14): `/observe <file> --qualify`: after Look succeeds, asks the current model through the
   * observed-handle + cite protocol (src/vision/evidence.ts; AGENTS.md §4) instead of the plain interpretation.
   * Every deterministic measurement is one handle of this run, bound to the image's sha256; the answer is
   * admitted only as the exact envelope citing handles that were cited through the real cite tool. Inside the
   * observation's own operation: /stop, /stop all and the REPL's end abort it (status cancelled, no admission).
   * The record keeps the raw output on every outcome (bounded like the plain answer) and the cost by the
   * absent / null / number rule. An admitted answer is still a claim: semantic_correctness_verified is false.
   * R4 (H20): a raw output or answer past 64 KiB keeps its first 64 KiB in the record and the whole of it through
   * `keeper` (.timmy/kept/model-output/), with the whole text's sha256 either way.
   */
  private async qualifyObserved(j: JobRecord, o: { root: string; imagePath: string; source: { path: string; sha256: string }; question?: string; model?: string }, look: Parameters<typeof qualifyInterpretation>[0]['observation'], entry: Observing | undefined, keeper: ObservationKeeper): Promise<Record<string, unknown>> {
    const g = this.d.glyphs;
    const rel = o.source.path;
    const question = o.question ?? QUALIFY_DEFAULT_QUESTION;
    const model = o.model ?? this.d.model?.();
    const base = { tier: INTERPRETATION, protocol: QUALIFIED_PROTOCOL, question, source_revision: o.source.sha256 };
    if (!model) return { ...base, status: 'not asked', reason: 'no current model is known here' };
    const apiKey = this.d.env.OPENROUTER_API_KEY;
    if (!apiKey) return { ...base, status: 'not asked', model_requested: model, reason: 'no OPENROUTER_API_KEY: a model answer needs one' };
    const signal = entry?.abort.signal;
    const stopped = (): Record<string, unknown> => ({ ...base, status: 'cancelled', model_requested: model, reason: 'stopped before the request was sent: nothing was asked, so nothing was charged' });
    if (signal?.aborted) return stopped();
    if (entry) entry.asking = { model, since: Date.now(), sent: false };
    try {
      // The image goes with the measurements only to a model that takes images, and only as exactly the bytes Look measured.
      let imageDataUrl: string | undefined;
      const support = await unlessAborted(acceptsImages(model, this.d.fetch ?? fetch), signal).catch(() => null);
      if (signal?.aborted) return stopped();
      if (support?.accepts === true) {
        try {
          const bytes = readFileSync(o.imagePath);
          const mime = bytes.length <= MAX_IMAGE_BYTES ? imageMime(bytes.subarray(0, 16)) : null;
          if (mime && createHash('sha256').update(bytes).digest('hex') === o.source.sha256) imageDataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
        } catch { imageDataUrl = undefined; }
      }
      const meter = meteredQualifyClient((this.d.qualifyClient ?? sdkQualifyClient)(apiKey), () => {
        if (entry?.asking) { entry.asking.sent = true; entry.asking.since = Date.now(); }
        this.d.notify([{ text: `  ${g.bullet} ` }, { text: `${j.id} measured`, role: 'strong' }, { text: `  ${rel}${this.sep}asking ${model} for an answer that cites the measurements, a paid request${this.sep}/stop ${j.id} stops it`, role: 'secondary' }]);
      });
      // Trusted, never model input: the project image's sha256 now (a read failure is a changed image).
      const currentRevision = (): string => createHash('sha256').update(readFileSync(o.imagePath)).digest('hex');
      let q: Awaited<ReturnType<typeof qualifyInterpretation>>;
      try {
        q = await qualifyInterpretation({ observation: look, question, model, client: meter.client, currentRevision, ...(imageDataUrl ? { imageDataUrl } : {}), ...(signal ? { signal } : {}) });
      } catch (e) {
        // qualifyInterpretation throws only on arguments it cannot ask with (a question over 2000 characters, say).
        const spend = await meter.spend(signal);
        const why = this.scrub(e instanceof Error ? e.message : 'the question could not be asked', o.root);
        return spend.sent
          ? { ...base, status: 'failed', model_requested: model, cost_usd: spend.cost_usd, reason: `the exchange did not complete (${why})` }
          : { ...base, status: 'not asked', model_requested: model, reason: why };
      }
      const spend = await meter.spend(signal);
      // R4 (H20, M8): a total the meter cannot tell (responses it cannot tell apart) is unknown, with why; never a sum.
      const cost = spend.sent ? { cost_usd: spend.cost_usd, ...(spend.tokens !== undefined ? { tokens: spend.tokens } : {}), ...(spend.cost_usd === null && spend.reason ? { cost_unknown_reason: spend.reason } : {}) } : {};
      const kept = keeper.fields('raw_output', q.admission.raw_output);
      const who = { model_requested: model, model: spend.model ?? model, ...(spend.model ? { model_resolved: spend.model } : {}), image_sent: imageDataUrl !== undefined };
      const run = q.asked ? { run_id: q.snapshot.run_id } : {};
      if (q.admission.ok && q.evidence.admission === 'admitted_references') {
        const values = new Map(q.snapshot.observations.map((h) => [h.handle_id, h.value as { name?: unknown; value?: unknown; unit?: unknown; note?: unknown }]));
        return {
          ...base, status: 'admitted', ...who, run_id: q.evidence.run_id, source_revision: q.evidence.source_revision,
          ...keeper.fields('answer', q.answer ?? ''),
          cites: q.evidence.handles.map((h) => {
            const v = values.get(h.handle_id);
            return { handle_id: h.handle_id, measurement: h.measurement, value: v?.value ?? null, ...(typeof v?.unit === 'string' ? { unit: v.unit } : {}) };
          }),
          semantic_correctness_verified: false, ...kept, ...cost,
        };
      }
      const refusal = q.admission.ok ? 'invalid_output' : q.admission.reason;
      if (signal?.aborted) {
        return { ...base, status: 'cancelled', ...who, ...run, refusal, ...kept, ...cost, reason: spend.sent ? 'stopped while the model was answering: the request had been sent, so it may still be charged; its cost is unknown' : 'stopped before the request was sent: nothing was asked, so nothing was charged' };
      }
      if (refusal === 'stale_context') {
        return { ...base, status: 'rejected', ...who, ...run, refusal, ...kept, ...cost, reason: `${rel} changed between Look and the ${q.asked ? 'answer' : 'question'}: ${q.asked ? 'the answer is kept as it came, not admitted and not a claim about what Look measured' : 'nothing was sent'}` };
      }
      if (q.error !== undefined && q.asked) {
        return { ...base, status: 'failed', ...who, ...run, refusal, ...kept, ...cost, reason: `the exchange did not complete (${this.scrub(q.error, o.root)})` };
      }
      const unknown = refusal === 'invalid_output' && q.admission.raw_output.trim() === 'UNKNOWN';
      return { ...base, status: q.asked ? 'refused' : 'not asked', ...who, ...run, refusal, ...kept, ...cost, reason: unknown ? 'the model replied UNKNOWN: no measurement bears on the question, so the evidence is unknown' : describeRefusal(refusal) };
    } finally {
      if (entry) entry.asking = undefined;
    }
  }

  /** R4 (H20): where an observation keeps things privately: the project's .timmy/kept/, else Timmy's own kept folder beside the jobs. */
  private keepPlaces(root: string): KeepPlaces { return { root, timmy: join(this.d.jobsDir, 'kept') }; }

  /** R4 (H20): where a kept file is, for a person: its place in the project, or in Timmy's own kept folder. */
  private keptShown(ref: KeptRef): string { return ref.store === 'timmy' ? this.tilde(join(this.d.jobsDir, 'kept', ref.path)) : ref.path; }

  /**
   * R4 (H20; the review of 07f37ec, finding 1): the observation file could not be written. A paid answer and its cost
   * are not lost with it: the whole record (measurements, the model's answer and raw output, cites, cost) is kept
   * privately (.timmy/kept/observations/<job>.json, else Timmy's own kept folder), and the failure receipt seals the
   * storage error, what was spent and who answered, the hashes of the answer and raw output, and where the record is
   * kept or why it is kept nowhere. The notice says the file could not be written, why, and where the answer and its cost are.
   */
  private unwritten(j: JobRecord, o: { root: string; source: { path: string } }, x: {
    base: Pick<ReceiptInput, 'kind' | 'policy' | 'project' | 'project_id' | 'files' | 'job'>; record: Record<string, unknown>; keeper: ObservationKeeper; storage: string;
    accounting: Pick<ReceiptInput, 'model_requested' | 'model_resolved' | 'tokens' | 'cost_usd' | 'cost_measured'>;
    claims: Pick<NonNullable<ReceiptInput['observation']>, 'interpretation' | 'qualified'>; costText: string; spent?: Record<string, unknown>;
  }): ObserveOutcome {
    const g = this.d.glyphs;
    const rel = o.source.path;
    const storage = this.scrub(x.storage, o.root);
    const error = `the observation file could not be written: ${storage}`;
    let k: ReturnType<ObservationKeeper['record']>;
    try { k = x.keeper.record(x.record, error); } catch (e) { k = { ok: false, error: `it could not be kept (${e instanceof Error ? e.message : 'error'})` }; }
    const keptError = k.ok ? '' : this.scrub(k.error, o.root);
    let receipt: string | undefined;
    try {
      receipt = this.d.seal({
        ...x.base, subject: `observe · ${rel} · failed`, status: 'failed',
        observation: { tiers: [], error, ...x.claims, kept: k.ok ? k.ref : { error: keptError } },
        ...x.accounting,
      });
    } catch { receipt = undefined; }
    // What was paid for, in a person's words: a request went out when the record carries a cost (a number or null).
    const asked = x.spent !== undefined && 'cost_usd' in x.spent;
    const cost = x.costText.replace(/^cost /, '');
    const said = typeof x.spent?.answer === 'string' ? "the model's answer" : typeof x.spent?.raw_output === 'string' && x.spent.raw_output ? "the model's raw output" : '';
    const what = !asked ? 'the measurements' : said ? `the measurements, ${said} and its cost (${cost})` : `the measurements and the cost of the model's request (${cost})`;
    const line = k.ok
      ? `the observation file could not be written (${storage}); ${what} were kept at ${this.keptShown(k.ref)}`
      : `the observation file could not be written (${storage}), and its record could not be kept either (${keptError})${asked ? `; the receipt seals what was spent: ${x.costText}` : ''}`;
    this.d.notify([{ text: `  ${g.fail} ` }, { text: `${j.id} not observed`, role: 'failure' }, { text: `  ${rel}: ${line}${receipt ? `${this.sep}receipt ${receipt}` : ''}`, role: 'secondary' }]);
    return { ok: false, error: line, ...(receipt ? { receipt } : {}), ...(k.ok ? { kept: k.ref } : {}) };
  }

  // ── /workflows, /run ────────────────────────────────────────────────────────

  private async upmd(): Promise<{ bin: string; version: string | null } | null> {
    if (this.upmdFound) return this.upmdFound;
    const found = findUpmd(this.d.env, this.d.onPath);
    if (!found) return null;
    this.upmdFound = { bin: found.bin, version: await upmdVersion(found.bin) };
    return this.upmdFound;
  }

  async workflows(_args: string): Promise<Line[]> {
    const docs = findWorkflowDocs(this.root);
    const tool = await this.upmd();
    const lines: Line[] = [[
      { text: '  Workflows', role: 'strong' },
      { text: ` in ${this.project.name}${this.sep}`, role: 'secondary' },
      tool ? { text: `upmd ${tool.version ?? '(version unknown)'}`, role: 'secondary' } : { text: 'upmd is not installed: brew install rezigned/tap/upmd', role: 'estimate' },
    ]];
    if (!docs.length) return [...lines, ...this.say('No workflow documents here. A workflow is Markdown with named blocks: ```bash [name:build]')];
    for (const doc of docs) {
      lines.push([{ text: '  ' }, { text: this.fileLink(doc.rel), role: 'strong' }]);
      const r = readProjectFile(this.root, doc.rel, 1024 * 1024);
      for (const b of r.ok && r.text ? parseWorkflow(r.text).filter((x) => x.name) : []) {
        lines.push([{ text: `    ${String(b.index).padStart(2)} ${String(b.name).padEnd(16)}` }, { text: b.deps.length ? `needs ${b.deps.join(', ')}` : '', role: 'secondary' }]);
      }
    }
    lines.push(...this.say('Run one: /run <file> <block>; follow it: /jobs; stop it: /stop <job>'));
    return lines;
  }

  async run(args: string): Promise<Line[]> {
    const [docArg, blockArg] = args.trim().split(/\s+/).filter(Boolean);
    if (!docArg) return this.workflows('');
    const r = readProjectFile(this.root, docArg, 1024 * 1024);
    if (!r.ok) return this.say(r.error);
    if (r.binary || r.text === undefined) return this.say(`${r.rel} is not a Markdown workflow.`);
    const blocks = parseWorkflow(r.text);
    const named = blocks.filter((b) => b.name).map((b) => b.name as string);
    if (!named.length) return this.say(`${r.rel} has no named blocks. upmd runs blocks named like \`\`\`bash [name:build]`);
    const target = blockArg ?? (named.length === 1 ? named[0] : undefined);
    if (!target) return this.say(`Which block? /run ${r.rel} <${named.join(' | ')}>`);
    if (!named.includes(target)) return this.say(`No block named ${target} in ${r.rel}: ${named.join(', ')}`);
    const plan = runOrder(blocks, target);
    if (plan.missing.length) return this.say(`${target} needs ${plan.missing.join(', ')}, which ${r.rel} does not define. Nothing ran.`, 'failure');
    if (plan.cycle) return this.say(`${target}'s dependencies loop (${plan.cycle.join(' -> ')}). Nothing ran.`, 'failure');
    const tool = await this.upmd();
    if (!tool) return [...this.say(`upmd is not installed, so ${r.rel} › ${target} did not run.`, 'estimate'), ...this.say('Setup: brew install rezigned/tap/upmd, then /run again.')];
    // F-3: the prediction is sealed before anything runs, with the document's hash as its input identity.
    const predicted = this.d.seal({
      kind: 'predict', subject: `workflow · predict · ${r.rel} › ${target}`, policy: 'human-gated', status: 'ok', project: this.project.name, project_id: projectId(this.root),
      prediction: { doc: r.rel, block: target, order: plan.order, expect: 'each block exits 0' },
      files: [{ path: r.rel, ...(r.sha256 ? { sha256: r.sha256 } : {}) }],
    });
    const job = this.jobs.start({
      kind: 'workflow', label: `${r.rel} › ${target}`, project: this.project.name, root: this.root,
      command: tool.bin, args: upmdRunArgs(join(this.root, r.rel), target, this.root),
      parseLine: (line, j) => { const ev = parseUpmdLine(line); if (ev) stepsFromEvent(j.steps, ev); },
    });
    this.mine.add(job.id);
    this.predictions.set(job.id, { doc: r.rel, block: target, order: plan.order, ...(predicted ? { receipt: predicted } : {}) });
    return [
      [{ text: '  Predicted  ', role: 'secondary' }, { text: plan.order.join(` ${this.d.glyphs.arrow} `), role: 'strong' }, { text: `, each exits 0${predicted ? `${this.sep}receipt ${predicted}` : ''}`, role: 'secondary' }],
      [{ text: '  Running    ', role: 'secondary' }, { text: job.id, role: 'strong' }, { text: `  ${job.label}${this.sep}/jobs ${job.id}${this.sep}/stop ${job.id}`, role: 'secondary' }],
    ];
  }

  // ── /preview ────────────────────────────────────────────────────────────────

  /**
   * What `/preview` serves as files, in order: a built folder (dist/, build/, out/) first; then, only when
   * the project has no dev, start or preview script, public/ or the project folder. A page at the root
   * beside a dev script is an app's unbuilt source (a Vite app's index.html), so its server runs instead
   * (round R2: found on the operator's Mac, where such a page was served as static files).
   */
  private defaultPreviewFolder(hasScript: boolean): string | null {
    for (const dir of ['dist', 'build', 'out']) if (existsSync(join(this.root, dir, 'index.html'))) return dir;
    if (hasScript) return null;
    if (existsSync(join(this.root, 'public', 'index.html'))) return 'public';
    return existsSync(join(this.root, 'index.html')) ? '.' : null;
  }

  private devScript(): string | null {
    return this.devScriptText()?.name ?? null;
  }

  private devScriptText(): { name: string; text: string } | null {
    try {
      const pkg = JSON.parse(readFileSync(join(this.root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const name = ['dev', 'start', 'preview'].find((s) => typeof pkg.scripts?.[s] === 'string');
      return name ? { name, text: pkg.scripts![name] } : null;
    } catch { return null; }
  }

  async preview(args: string): Promise<Line[]> {
    const a = args.trim();
    let spec: { label: string; command: string; args: string[]; url: string; env?: NodeJS.ProcessEnv };
    const urlFlag = a.match(/(?:^|\s)--url\s+(\S+)/);
    if (urlFlag) {
      const cmd = a.replace(urlFlag[0], ' ').trim().split(/\s+/).filter(Boolean);
      if (!cmd.length) return this.say('Usage: /preview <command> --url <address it serves>');
      spec = { label: `preview ${cmd.join(' ')}`, command: cmd[0], args: cmd.slice(1), url: urlFlag[1] };
    } else {
      const port = await (this.d.freePort ?? freePort)();
      const script = a ? null : this.devScript();
      const folder = a || this.defaultPreviewFolder(script !== null);
      if (folder) {
        const at = folder === '.' ? { path: this.root, rel: '.' } : resolveInside(this.root, folder);
        if ('error' in at) return this.say(at.error);
        if (!existsSync(at.path) || !statSync(at.path).isDirectory()) return this.say(`${folder} is not a folder in this project.`);
        spec = { label: `preview ${at.rel === '.' ? 'the project' : `${at.rel}/`}`, ...(this.d.staticServer ?? staticServerCommand)(at.path, port), url: `http://127.0.0.1:${port}/` };
      } else if (script) {
        // Vite reads no PORT or HOST: it is given the port and address on its command line instead, and
        // --strictPort makes it fail rather than answer on another port (round R2 review).
        const text = this.devScriptText()?.text ?? '';
        const vite = /(?:^|[\s;&|(])vite(?:\s|$)/.test(text) && !/--port\b/.test(text);
        const extra = vite ? ['--', '--port', String(port), '--host', '127.0.0.1', '--strictPort'] : [];
        spec = { label: `preview npm run ${script}`, command: 'npm', args: ['run', script, ...extra], url: `http://127.0.0.1:${port}/`, env: { ...this.d.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' } };
      } else {
        return this.say('Nothing to preview: no index.html in dist, build, out, public or the project, and no dev or start script. Try /preview <folder>, or /preview <command> --url <address>.');
      }
    }
    const job = this.jobs.start({
      kind: 'server', label: spec.label, project: this.project.name, root: this.root, command: spec.command, args: spec.args,
      ...(spec.env ? { env: spec.env } : {}), ready: { url: spec.url, timeoutMs: 30000 },
    });
    this.mine.add(job.id);
    void this.jobs.ready(job.id).then((j) => {
      if (j.state !== 'ready') return;
      this.d.notify([{ text: '  Browser    ', role: 'secondary' }, { text: this.d.openWeb(j.url ?? spec.url) }]);
    });
    return [[{ text: '  Starting   ', role: 'secondary' }, { text: job.id, role: 'strong' }, { text: `  ${spec.label} at ${spec.url}${this.sep}ready when it answers${this.sep}/stop ${job.id}`, role: 'secondary' }]];
  }

  // ── jobs: notices, /jobs, /stop ─────────────────────────────────────────────

  private expected(j: JobRecord): number | undefined { return this.predictions.get(j.id)?.order.length; }

  private changed(job: JobRecord): void {
    const before = this.seen.get(job.id) ?? { state: 'queued', done: 0 };
    const done = job.steps.filter((s) => s.state !== 'running').length;
    this.seen.set(job.id, { state: job.state, done });
    const g = this.d.glyphs;
    if (job.kind === 'workflow' && done > before.done) {
      const s = job.steps.filter((x) => x.state !== 'running').at(-1);
      const total = this.expected(job) ?? job.steps.length;
      if (s) this.d.notify([{ text: `  ${g.bullet} ` }, { text: job.id, role: 'strong' }, { text: `  ${s.name} ${s.state === 'completed' ? 'completed' : `failed, exit ${s.code ?? '?'}`}${this.sep}${done} of ${total}`, role: s.state === 'failed' ? 'failure' : 'secondary' }]);
    }
    if (job.state === before.state) return;
    const recipe = this.recipes.get(job.id);
    if (recipe && TERMINAL.has(job.state)) {
      // Round R4 (H17): a watcher stopped, or ended by a signal (its handler may never have loaded), cannot follow its
      // recipe any more: the recipe's own cancel is asked (again, when a stop path already did), idempotently.
      const asked = job.state === 'cancelled' || job.signal ? cancelRecipe(job.root, recipe) : undefined;
      for (const l of recipeEnded({ ...this.recipeContext(), root: job.root }, job, recipe, asked)) this.d.notify(l);
      return;
    }
    // Round R3 (/agent): a code agent's end says its outcome and what it changed, from its sealed result.
    const agentRun = this.agentRuns.get(job.id);
    if (agentRun && TERMINAL.has(job.state)) return void this.d.notify(this.agentEndLine(job, agentRun));
    const nat = this.natives.get(job.id);
    if (nat && (job.state === 'completed' || job.state === 'failed') && isAeJobSpec(nat)) {
      // R4: an After Effects script run says its new version (Timmy's sha256), After Effects' own report and the next step.
      for (const l of aeEndLines(judgeAeJob(job, nat), nat, { id: job.id, label: job.label, glyphs: g, sep: this.sep, scrub: (s) => this.scrub(s, job.root), ...(job.receipt ? { receipt: job.receipt } : {}) })) this.d.notify(l);
      return;
    }
    if (nat && (job.state === 'completed' || job.state === 'failed')) {
      // R2: judged by the app's own result file; an exit code alone decides nothing (c4dpy can exit 1 after a good run).
      const j = judgeNativeJob(job, nat);
      const mark = j.outcome === 'ok' ? g.ok : j.outcome === 'failed' ? g.fail : '?';
      this.d.notify([{ text: `  ${mark} `, role: j.outcome === 'failed' ? 'failure' : undefined }, { text: `${job.id} ${j.outcome}`, role: j.outcome === 'failed' ? 'failure' : 'strong' }, { text: `  ${job.label}: ${this.scrub(j.why, job.root)}${job.receipt ? `${this.sep}receipt ${job.receipt}` : ''}${this.sep}/results`, role: 'secondary' }]);
      return;
    }
    if (job.state === 'ready') {
      this.d.notify([{ text: `  ${g.ok} ` }, { text: `${job.id} ready`, role: 'strong' }, { text: `  ${job.label} answers at ${job.url ?? ''}${this.sep}serving until /stop ${job.id}`, role: 'secondary' }]);
    } else if (job.state === 'completed') {
      const p = this.predictions.get(job.id);
      const met = p ? job.steps.length === p.order.length && job.steps.every((s, i) => s.name === p.order[i] && s.state === 'completed') : undefined;
      this.d.notify([{ text: `  ${g.ok} ` }, { text: `${job.id} completed`, role: 'strong' }, { text: `  ${job.label}${job.steps.length ? `${this.sep}${job.steps.length} of ${this.expected(job) ?? job.steps.length} steps` : ''}${this.sep}${seconds(job)}${met === undefined ? '' : met ? `${this.sep}prediction met` : `${this.sep}prediction missed`}${job.receipt ? `${this.sep}receipt ${job.receipt}` : ''}`, role: 'secondary' }]);
    } else if (job.state === 'failed') {
      const step = job.steps.find((s) => s.state === 'failed');
      const why = job.error ?? (step ? `${step.name} exited ${step.code ?? '?'}` : `exit ${job.exitCode ?? job.signal ?? '?'}`);
      this.d.notify([{ text: `  ${g.fail} ` }, { text: `${job.id} failed`, role: 'failure' }, { text: `  ${job.label}: ${why}${this.sep}/jobs ${job.id} shows its output`, role: 'secondary' }]);
    } else if (job.state === 'cancelled') {
      this.d.notify([{ text: '  ' }, { text: `${job.id} stopped`, role: 'strong' }, { text: `  ${job.label}${job.receipt ? `${this.sep}receipt ${job.receipt}` : ''}`, role: 'secondary' }]);
    }
  }

  private outputsSince(job: JobRecord): Array<{ path: string; sha256?: string; bytes: number }> {
    const since = Date.parse(job.startedAt) - 1000;
    return listProjectFiles(job.root).files
      .filter((f) => f.role === 'output' && f.mtimeMs >= since)
      .slice(0, 50)
      .map((f) => { const sha = sha256File(join(job.root, f.rel)); return { path: f.rel, ...(sha ? { sha256: sha } : {}), bytes: f.bytes }; });
  }

  /** Free text bound for a receipt with the project's folder written as "." and the home folder as "~"
   *  (verification of b1ede23: a job's error and a typed /preview command carried absolute paths). */
  private scrub(text: string, root: string): string {
    let out = text;
    const roots = [root];
    try { roots.push(realpathSync(root)); } catch { /* gone */ }
    for (const r of [...new Set(roots)].sort((a, b) => b.length - a.length)) if (r.length > 1) out = out.split(r).join('.');
    const home = homedir();
    if (home.length > 1) out = out.split(home).join('~');
    return out;
  }

  private sealJob(job: JobRecord): string | undefined {
    // A Look job's one receipt is its observation's (kind observe), sealed once the observation is written.
    // R4 (/iterate): a flow's readback job is sealed by its flow (kind readback).
    if (this.looks.has(job.id) || this.selfSealed.has(job.id)) return undefined;
    // Round R3 (/agent): a code agent's run is sealed with its result (kind agent).
    const agentRun = this.agentRuns.get(job.id);
    if (agentRun) return this.sealAgent(job, agentRun);
    const p = this.predictions.get(job.id);
    const met = p ? job.state === 'completed' && job.steps.length === p.order.length && job.steps.every((s, i) => s.name === p.order[i] && s.state === 'completed') : undefined;
    const outputs = job.kind === 'server' ? [] : this.outputsSince(job);
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const log = sha256File(job.logPath);
    const kind = job.kind === 'server' ? 'preview' : job.kind;
    const label = this.scrub(job.label, job.root);
    const error = job.error ? this.scrub(job.error, job.root) : undefined;
    const nat = this.natives.get(job.id);
    const judged = nat && job.state !== 'cancelled' ? (isAeJobSpec(nat) ? aeReceiptFields(judgeAeJob(job, nat)) : nativeReceiptFields(nat.native.app, judgeNativeJob(job, nat))) : undefined;
    if (judged) judged.native.why = this.scrub(judged.native.why, job.root);
    const status = job.state === 'cancelled' ? 'cancelled' as const : judged ? judged.status : job.state === 'completed' ? 'ok' as const : 'failed' as const;
    try {
      return this.d.seal({
        kind: judged ? 'native' : kind, subject: `${judged ? 'native' : kind} · ${label} · ${judged ? judged.native.outcome : job.state}`, policy: 'human-gated',
        ...(status ? { status } : {}),
        ...(judged ? { native: judged.native } : {}),
        project: job.project, project_id: projectId(job.root),
        job: {
          id: job.id, kind: job.kind, label, state: job.state, exit_code: job.exitCode ?? null,
          steps: job.steps.map(({ name, state, code }) => ({ name, state, ...(code === undefined ? {} : { code }) })),
          ...(log ? { log_sha256: log } : {}), ...(job.url ? { url: job.url } : {}), ...(ms !== undefined ? { ms } : {}), ...(error ? { error } : {}),
        },
        ...(outputs.length ? { outputs } : {}),
        ...(p ? { prediction: { doc: p.doc, block: p.block, order: p.order, expect: 'each block exits 0', ...(met === undefined ? {} : { met }), ...(p.receipt ? { receipt: p.receipt } : {}) } } : {}),
      });
    } catch { return undefined; }
  }

  private jobLine(j: JobRecord): Line {
    const g = this.d.glyphs;
    const mark = j.state === 'completed' || j.state === 'ready' ? g.ok : j.state === 'failed' ? g.fail : j.state === 'cancelled' ? ' ' : g.bullet;
    const steps = j.kind === 'workflow' ? `${this.sep}${j.steps.filter((s) => s.state !== 'running').length} of ${this.expected(j) ?? j.steps.length} steps` : '';
    const where = j.url && j.state === 'ready' ? `${this.sep}${j.url}` : '';
    const stale = j.stale ? `${this.sep}from an earlier session; its process is gone` : '';
    const note = j.note ? `${this.sep}${j.note}` : '';
    return [
      { text: `  ${mark} `, role: j.state === 'failed' ? 'failure' : undefined },
      { text: j.id, role: 'strong' },
      { text: `  ${j.state.padEnd(9)} ${j.label}${steps}${where}${this.sep}${seconds(j)}${j.receipt ? `${this.sep}receipt ${j.receipt}` : ''}${stale}${note}`, role: 'secondary' },
    ];
  }

  /** Round R3: under a Look job whose measurement is done, the model still being asked (and whether it can charge yet). */
  private askingLine(j: JobRecord): Line[] {
    const a = this.observing.get(j.id)?.asking;
    if (!a) return [];
    const secs = Math.max(0, Math.round((Date.now() - a.since) / 1000));
    return [[{ text: `      ${this.d.glyphs.arrow} `, role: 'secondary' }, a.sent
      ? { text: `measured; interpreting with ${a.model}${this.sep}${secs} s${this.sep}a paid request${this.sep}/stop ${j.id} stops it`, role: 'ai' }
      : { text: `measured; about to ask ${a.model}, nothing sent yet${this.sep}/stop ${j.id} stops it`, role: 'secondary' }]];
  }

  jobsView(args: string): Line[] {
    const id = args.trim();
    if (id) {
      const j = this.jobs.get(id) ?? this.jobs.list().find((x) => x.id === id);
      if (!j) return this.say(`No job ${id}. /jobs lists them.`);
      const lines: Line[] = [this.jobLine(j), ...this.askingLine(j)];
      for (const s of j.steps) lines.push([{ text: `      ${s.state === 'completed' ? this.d.glyphs.ok : s.state === 'failed' ? this.d.glyphs.fail : this.d.glyphs.bullet} ${s.name}`, role: s.state === 'failed' ? 'failure' : undefined }, { text: s.code === undefined ? '' : `  exit ${s.code}`, role: 'secondary' }]);
      // Round R3 (/agent): a code agent's job shows its parsed progress, not its raw stream.
      const progress = this.agentProgressLines(j);
      if (progress) return [...lines, ...progress];
      lines.push([{ text: '  Output   ', role: 'secondary' }, { text: this.d.link('the full log', fileUrl(j.logPath)) }, { text: `${this.sep}${j.lines} lines; the last of them:`, role: 'secondary' }]);
      for (const l of this.jobs.tail(j.id, 12)) lines.push([{ text: `  ${this.d.glyphs.sep} `, role: 'secondary' }, { text: l }]);
      return lines;
    }
    const all = this.jobs.list().slice(0, 12);
    if (!all.length) return this.say('No jobs yet: /run starts a workflow, /preview a preview server.');
    return [...all.flatMap((j) => [this.jobLine(j), ...this.askingLine(j)]), ...this.say('Details: /jobs <id>; stop one: /stop <id>')];
  }

  /**
   * Stops this REPL's own jobs and reports what actually happened (review at c7475458: /stop claimed
   * another session's job stopped when it was left untouched, and /stop all counted jobs it did not own).
   */
  async stop(args: string): Promise<Line[]> {
    const id = args.trim();
    if (!id) return this.say('Usage: /stop <job>, or /stop all');
    // R4 (/iterate): a flow is stopped by its id (f + 8 hex).
    if (FLOW_ID.test(id)) return this.flows.stop(id, this.root);
    if (id === 'all') {
      // R4 (/iterate): the flows first, so none starts a next step; their running steps are this REPL's jobs below.
      const flows = this.flows.abortAll();
      // Round R3: an observation's model interpretation belongs to its Look job: /stop all reaches it too.
      const asking = [...this.observing.values()].filter((o) => o.asking);
      for (const o of this.observing.values()) o.abort.abort();
      const live = [...this.mine].map((x) => this.jobs.get(x)).filter((j): j is JobRecord => !!j && !TERMINAL.has(j.state));
      if (!live.length && !asking.length && !flows.count) return this.say('Nothing this REPL started is running.');
      // Round R4 (H17): each recipe watcher's recipe is cancelled through its own path before any watcher is stopped.
      const recipesAsked = live.flatMap((j) => this.cancelWatched(j) ?? []);
      const [ended, asked] = await Promise.all([
        Promise.all(live.map((j) => this.jobs.stop(j.id))),
        Promise.all(asking.map((o) => (o.done ? within(o.done) : Promise.resolve(undefined)))),
      ]);
      const lines: Line[] = [];
      if (live.length) {
        const clean = ended.filter((j) => j && TERMINAL.has(j.state) && !j.error).length;
        const left = live.length - clean;
        lines.push(...(left
          ? this.say(`Stopped ${clean} of ${live.length} jobs this REPL started; ${left} did not stop cleanly: /jobs`, 'failure')
          : this.say(`Stopped ${clean} job${clean === 1 ? '' : 's'} this REPL started, with ${clean === 1 ? 'its process group' : 'their process groups'}.`)));
      }
      if (asking.length) {
        const n = asked.filter((x) => x?.ok && (x.interpretation ?? x.qualified)?.status === 'cancelled').length;
        const rest = asking.length - n;
        lines.push(...this.say(n
          ? `Stopped ${n} model interpretation${n === 1 ? '; its measurement' : 's; their measurements'} had completed${rest ? `; ${rest} more had already ended` : ''}.`
          : `${rest} model interpretation${rest === 1 ? ' had' : 's had'} already ended when the stop came.`));
      }
      for (const a of recipesAsked) lines.push(...this.say(cancelSentence(a), a.error ? 'failure' : 'secondary'));
      const flowsEnded = await flows.report();
      if (flowsEnded) lines.push(...this.say(flowsEnded));
      return lines;
    }
    const j = this.jobs.get(id);
    if (!j) return this.say(`No job ${id}. /jobs lists them.`);
    if (!this.mine.has(id)) {
      const how = j.stale ? 'its process is gone' : TERMINAL.has(j.state) ? `it already ${j.state}` : `it is ${j.state} and was left as it is`;
      return this.say(`${id} was started by another Timmy session; ${how}. /stop stops only the jobs this REPL started.`);
    }
    const obs = this.observing.get(id);
    if (obs?.asking && TERMINAL.has(j.state)) return this.stopAsking(id, obs);
    if (TERMINAL.has(j.state)) return this.say(`${id} already ${j.state}.`);
    // A measurement that completes while this stop lands goes no further: the model is not asked.
    obs?.abort.abort();
    // Round R4 (H17): a recipe watcher's recipe is cancelled through its own path first, so a stop that lands before
    // the watcher has its handler still reaches the recipe (the live board's Stop comes here too).
    const asked = this.cancelWatched(j);
    const recipeLine = asked ? this.say(cancelSentence(asked), asked.error ? 'failure' : 'secondary') : [];
    const done = await this.jobs.stop(id);
    if (!done || !TERMINAL.has(done.state) || done.error) {
      return [[{ text: `  ${id} ${done?.state ?? 'unknown'}`, role: 'failure' }, { text: `  ${j.label}: ${done?.error ?? 'it did not stop'}; /jobs ${id}`, role: 'secondary' }], ...recipeLine];
    }
    return [[{ text: `  ${id} ${done.state}`, role: 'strong' }, { text: `  ${j.label}: it and its process group have stopped`, role: 'secondary' }], ...recipeLine];
  }

  /** Round R4 (H17): the recipe's own cancel for a live recipe watcher job, asked before the watcher is stopped. */
  private cancelWatched(j: JobRecord): RecipeCancel | undefined {
    const uuid = this.recipes.get(j.id);
    return uuid && !TERMINAL.has(j.state) ? cancelRecipe(j.root, uuid) : undefined;
  }

  /** Round R4 (H17): the REPL is ending: no recipe watcher starts after this, and each recipe being launched or
   *  followed is cancelled through its own path (never a signal, never a PID read from disk) before anything stops. */
  private cancelRecipes(): RecipeCancel[] {
    const asked = this.launches.close();
    for (const id of this.recipes.keys()) {
      const j = this.jobs.get(id);
      if (j) { const a = this.cancelWatched(j); if (a) asked.push(a); }
    }
    return asked;
  }

  /**
   * Round R3: /stop on a Look job whose measurement has completed while its model is being asked: the request
   * is aborted, and the observation is recorded with its interpretation cancelled (cost unknown once sent).
   */
  private async stopAsking(id: string, obs: Observing): Promise<Line[]> {
    obs.abort.abort();
    const out = obs.done ? await within(obs.done) : undefined;
    if (!out) return this.say(`${id}: the model's request was stopped; its observation is not recorded yet: /jobs ${id}`, 'estimate');
    if (!out.ok) return this.say(`${id}: the model's request was stopped, and the observation could not be recorded: ${out.error}`, 'failure');
    const i = out.interpretation ?? out.qualified;
    if (i?.status !== 'cancelled') return this.say(`${id}: the model had already ${i?.status === 'answered' || i?.status === 'admitted' ? 'answered' : 'finished'} when the stop came${this.sep}${out.file}`);
    const sent = 'cost_usd' in i;
    return [[
      { text: `  ${id} stopped the model interpretation; the measurement had completed`, role: 'strong' },
      { text: `${this.sep}${sent ? 'the request had been sent, so it may still be charged: cost unknown' : 'no request had been sent'}${this.sep}${out.file}${out.receipt ? `${this.sep}receipt ${out.receipt}` : ''}`, role: 'secondary' },
    ]];
  }

  /** The REPL is ending: stop what this REPL started, a model's interpretation included, and let a stopped
   *  observation be recorded (round R3). */
  async close(): Promise<void> {
    // Round R4 (H17): recipes first, through their own cancel; a recipe start under way settles (bounded) and starts no watcher.
    for (const a of this.cancelRecipes()) if (a.error) this.d.notify(this.say(cancelSentence(a), 'failure')[0]);
    await within(this.launches.settled());
    await this.closeLiveBoard();
    // R4 (/iterate): no flow starts a next step; each writes its record once its step has stopped.
    this.flows.abortAll();
    const pending = [...this.observing.values()].flatMap((o) => { o.abort.abort(); return o.done ? [o.done] : []; });
    await this.jobs.stopAll();
    await within(Promise.allSettled(pending));
    await this.flows.settle(20_000);
  }

  /** The process is exiting at once (a second Ctrl+C): signal this REPL's live jobs without waiting. */
  killNow(): void {
    this.flows.abortAll();
    this.live?.closeNow();
    this.live = undefined;
    for (const o of this.observing.values()) o.abort.abort();
    // Round R4 (H17): each recipe is cancelled through its own path before any watcher is signalled (synchronous).
    this.cancelRecipes();
    for (const id of this.mine) {
      const j = this.jobs.get(id);
      if (j?.pid && !TERMINAL.has(j.state)) killProcessGroup(j.pid, 'SIGTERM');
    }
  }

  // ── R2: native apps and MCP ─────────────────────────────────────────────────

  /** A native job this REPL started (by /c4d, /ae or the agent's run_native): /stop reaches it and its end is judged. */
  adoptNative(id: string, spec: NativeJobSpec): void {
    this.mine.add(id);
    this.natives.set(id, spec);
  }

  private startNative(make: () => NativeJobSpec, what: string): Line[] {
    let spec: NativeJobSpec;
    try { spec = make(); } catch (e) {
      if (e instanceof NativeNotFound) return [...this.say(e.message, 'estimate'), ...this.say(`Setup: ${e.setup}`)];
      return this.say(this.scrub((e as Error).message, this.root), 'failure');
    }
    const job = this.jobs.start(spec);
    // Round R3: the run's own record (.timmy/native/<run>/) learns its job, so a restart can reconcile it.
    try { noteNativeStarted(spec, job); } catch { /* the record says it was submitted; the job still runs */ }
    this.adoptNative(job.id, spec);
    return [[{ text: '  Running    ', role: 'secondary' }, { text: job.id, role: 'strong' }, { text: `  ${what}${this.sep}judged by its result file${this.sep}/jobs ${job.id}${this.sep}/stop ${job.id}`, role: 'secondary' }]];
  }

  /** /c4d <script.py> [args]: Cinema 4D's own Python (c4dpy), headless, as a job in the project. */
  async c4d(args: string): Promise<Line[]> {
    const w = splitCommandLine(args.trim());
    if (!w.length) return this.say('Usage: /c4d <script.py> [args]   (Cinema 4D Python, headless, as a job)');
    return this.startNative(() => c4dpyJob({ script: w[0], args: w.slice(1), root: this.root, project: this.project.name }), `Cinema 4D runs ${w[0]}`);
  }

  /** /blender <script.py> [args]: Blender's own Python, headless, as a job in the project (round R3). */
  async blender(args: string): Promise<Line[]> {
    const w = splitCommandLine(args.trim());
    if (!w.length) return this.say('Usage: /blender <script.py> [args]   (Blender Python, headless, as a job: an editable .blend and a render)');
    return this.startNative(() => blenderJob({ script: w[0], args: w.slice(1), root: this.root, project: this.project.name }), `Blender runs ${w[0]}`);
  }

  /** /ae <project.aep> <comp> <output>: After Effects renders an existing project's comp (aerender), as a job.
   *  R4: /ae author|edit|inspect run a script inside After Effects itself (src/native/ae-author.ts). */
  async ae(args: string): Promise<Line[]> {
    const w = splitCommandLine(args.trim());
    const scripted = parseAeScriptArgs(w);
    if (scripted) return 'error' in scripted ? this.say(scripted.error) : this.aeScript(scripted);
    if (w.length < 3) return [[{ text: '  Usage:', role: 'secondary' }], ...AE_USAGE.map((u): Line => [{ text: `    ${u}`, role: 'secondary' }])];
    return this.startNative(() => aerenderJob({ projectFile: w[0], comp: w[1], output: w[2], root: this.root, project: this.project.name }), `After Effects renders ${w[1]} from ${w[0]}`);
  }

  /** R4: an After Effects script run as a job; what happens in After Effects is said before it starts. */
  private aeScript(p: { mode: AeMode; script?: string; projectFile?: string; name?: string }): Line[] {
    const made: { spec?: AeJobSpec } = {};
    const what = p.mode === 'author' ? `After Effects writes a project from ${p.script}` : p.mode === 'edit' ? `After Effects edits a new version of ${p.projectFile} with ${p.script}` : `After Effects reads ${p.projectFile} back`;
    const lines = this.startNative(() => (made.spec = aeScriptJob({ ...p, root: this.root, project: this.project.name, findEnv: this.d.env })), what);
    return made.spec ? [...aeStartLines(made.spec, this.sep), ...lines] : lines;
  }

  // ── /recipe (round R3: the CadQuery enclosure-tray recipe as a durable job; src/repl/recipe.ts) ──

  async recipe(args: string): Promise<Line[]> { return this.launches.track(recipeView(this.recipeContext(), args)); }

  /** The agent's run_recipe: the same start as /recipe tray, answered as data. */
  runRecipe(parameters: Record<string, unknown>): Promise<RecipeStarted> { return this.launches.track(startRecipeJob(this.recipeContext(), parameters)); }

  private recipeContext(): RecipeContext {
    const root = this.root;
    return {
      root, project: this.project.name, env: this.d.env, glyphs: this.d.glyphs, seal: this.d.seal,
      startJob: (spec, uuid) => {
        // Round R4 (H17): a watcher started after the REPL began to end would outlive it, so none is.
        if (this.launches.closing) throw new Error('this REPL is ending');
        const job = this.jobs.start(spec); this.mine.add(job.id); this.recipes.set(job.id, uuid); return job;
      },
      launching: (uuid) => this.launches.add(uuid, root),
      ...(this.d.recipeTest ? { test: this.d.recipeTest } : {}),
    };
  }

  /** /mcp: MCP servers and their tools through the two command-line routes (MCPorter, Timmy's SDK command). */
  async mcp(args: string): Promise<Line[]> {
    const lines = await mcpView(splitCommandLine(args.trim()), { cwd: this.root });
    return lines.map((l) => [{ text: `  ${l}` }]);
  }

  // ── /agent (round R3, helper H13): a code agent as a job; its result in .timmy/agents/<run>/ ──────────

  /** `/agent` lists the agents; `/agent <name> [--paid] <task…>` runs one as a job; `/agent last` shows the last run. */
  async agent(args: string): Promise<Line[]> {
    const a = args.trim();
    if (!a) return this.agentList();
    if (a === 'last') return this.agentLast();
    const p = parseAgentLine(a);
    if (!p.name) return this.say(`No agent named ${p.word ?? ''}. Agents: ${AGENT_NAMES.join(', ')}; /agent lists them.`);
    const s = await this.startAgentRun(p.name, p.task, { paid: p.paid });
    if (!s.ok) return this.say(s.error, s.refused === 'missing' || s.refused === 'paid' ? 'estimate' : 'failure');
    const { info, version, plan, run, job } = s;
    const g = this.d.glyphs;
    return [
      [{ text: '  Agent      ', role: 'secondary' }, { text: job.id, role: 'strong' }, { text: `  ${job.label}`, role: 'secondary' }],
      [{ text: '  Runs       ', role: 'secondary' }, { text: `${info.title}${version ? ` ${version}` : ''}${plan.model ? `${this.sep}model ${plan.model}` : ''}${plan.agent === 'qwen' ? ` at ${plan.where}` : ''}${this.sep}` },
        { text: plan.endpoint === 'local' ? plan.charge : `${plan.charge}: it uses ${plan.agent === 'qwen' ? 'that endpoint' : 'your account'} and may cost money`, role: plan.endpoint === 'local' ? 'secondary' : 'estimate' },
        { text: `${this.sep}up to ${plan.wallTime}${plan.env?.HOME ? `${this.sep}its own HOME (TIMMY_AGENT_HOME)` : ''}`, role: 'secondary' }],
      [{ text: '  Follow     ', role: 'secondary' }, { text: `/jobs ${job.id}${this.sep}/stop ${job.id}${this.sep}then /agent last or /results ${g.arrow} ${AGENTS_DIR}/${run}/`, role: 'secondary' }],
    ];
  }

  /**
   * R4 (/iterate): a code agent's run started, as data: the one start /agent and /iterate share. The endpoint rule
   * (planAgent), the project's snapshot before it, its job (this REPL's, so /stop reaches it) and, at its end, its
   * sealed result (sealAgent). `root`, `project` and `env` default to the active project and this REPL's environment.
   */
  async startAgentRun(name: AgentName, task: string, o: { paid: boolean; root?: string; project?: string; env?: NodeJS.ProcessEnv }): Promise<AgentStart> {
    const info = AGENTS[name];
    const env = o.env ?? this.d.env;
    const bin = agentBin(name, env, this.d.onPath);
    if (!bin) return { ok: false, refused: 'missing', error: `${info.title} is not on PATH (${info.bin}); /tools says how to install it. Nothing was started.` };
    const run = newRunId();
    const planned = planAgent(name, task, { env, paid: o.paid, run, bin });
    if (!planned.ok) return { ok: false, refused: planned.refused, error: planned.error };
    const plan = planned.plan;
    const root = o.root ?? this.root;
    const dir = runDir(root, run);
    const version = await agentVersion(bin);
    let before: { files: Snapshot; truncated: boolean };
    try { ensureDir(dir); before = snapshotProject(root); } catch (e) { return { ok: false, refused: 'prepare', error: `The run could not be prepared: ${this.scrub((e as Error).message, root)}` }; }
    const record: AgentRunRecord = {
      agent_run: 1, run, agent: name, agent_version: version, model: plan.model, endpoint: plan.endpoint, where: plan.where,
      task, job: '', started_at: new Date().toISOString(),
    };
    const progress = newProgress();
    const state: AgentRunState = { record, plan, root, dir, before: before.files, beforeTruncated: before.truncated, gitBefore: isGitDir(root) ? gitStat(root) : null, progress };
    try { writeJson(join(dir, 'snapshot-before.json'), { truncated: before.truncated, files: snapshotJson(before.files) }); } catch { /* kept in memory */ }
    const job = this.jobs.start({
      kind: 'task', label: agentLabel(name, run, task, root), project: o.project ?? this.project.name, root, command: plan.command, args: plan.args, timeoutMs: plan.timeoutMs,
      ...(plan.env ? { env: plan.env } : {}),
      parseLine: (line) => { const shown = progressLine(line, progress, root); if (shown) appendProgress(dir, shown); },
    });
    this.mine.add(job.id);
    this.agentRuns.set(job.id, state);
    record.job = job.id;
    try { writeJson(join(dir, 'run.json'), { ...record, state: 'submitted' }); } catch { /* the job still runs; its result is written at its end */ }
    return { ok: true, job, run, plan, info, version, record };
  }

  // ── /iterate (round R4, helper H24: a local agent edits the parameter file, the recipe rebuilds, a separate worker reads it back) ──

  /** `/iterate` lists the flows; `/iterate tray "<instruction>" [--agent qwen] [--model <m>]` starts one (src/repl/iterate.ts). */
  async iterate(args: string): Promise<Line[]> { return this.flows.command(args, { root: this.root, project: this.project.name }); }

  /** The agent's iterate_recipe: the same start as /iterate tray "<instruction>", answered as data. */
  iterateForTool(instruction: string): Promise<Record<string, unknown>> { return this.flows.startForTool(instruction, { root: this.root, project: this.project.name }); }

  private agentList(): Line[] {
    const env = this.d.env;
    const lines: Line[] = [[{ text: '  Code agents', role: 'strong' }, { text: `  each runs in ${this.project.name} as a job: /agent <name> <task>`, role: 'secondary' }]];
    for (const n of AGENT_NAMES) {
      const info = AGENTS[n];
      const bin = agentBin(n, env, this.d.onPath);
      const found = bin ? (env[info.binEnv]?.trim() ? `set by ${info.binEnv}` : 'on PATH') : 'not on PATH';
      const model = env[info.modelEnv]?.trim();
      let how: Segment;
      if (n === 'qwen') {
        const plan = model ? planAgent('qwen', 'list', { env, paid: true, run: 'a00000000', bin: bin ?? info.bin }) : undefined;
        how = !model
          ? { text: `needs TIMMY_AGENT_MODEL (a model the endpoint serves)${this.sep}endpoint ${env.TIMMY_AGENT_BASE_URL?.trim() ? 'from TIMMY_AGENT_BASE_URL' : 'a local Ollama (127.0.0.1:11434)'}`, role: 'estimate' }
          : plan?.ok
            ? { text: `${plan.plan.endpoint === 'local' ? 'local endpoint, no charge' : 'remote endpoint: may cost money (--paid)'}${this.sep}model ${model} at ${plan.plan.where}`, role: plan.plan.endpoint === 'local' ? 'secondary' : 'estimate' }
            : { text: plan ? plan.error : '', role: 'failure' };
      } else {
        how = { text: `your own account: costs money (--paid)${this.sep}model ${model ?? 'its default'}`, role: 'estimate' };
      }
      lines.push([{ text: `  ${bin ? this.d.glyphs.bullet : ' '} ` }, { text: n.padEnd(9), role: bin ? 'strong' : undefined }, { text: ` ${info.title.padEnd(12)} ${found.padEnd(12)}${this.sep}`, role: 'secondary' }, how]);
    }
    lines.push(...this.say(`Run one: /agent qwen <task>; a paid one: /agent claude --paid <task>; the last run: /agent last`));
    return lines;
  }

  private agentLast(): Line[] {
    const runs = listAgentRuns(this.root);
    const r = runs[0];
    if (!r) return this.say('No agent runs in this project yet: /agent qwen <task>');
    const live = [...this.agentRuns.entries()].find(([, s]) => s.record.run === r.run);
    const job = live ? this.jobs.get(live[0]) : r.job ? this.jobs.get(r.job) : undefined;
    const lines: Line[] = [[{ text: '  Agent run  ', role: 'secondary' }, { text: r.run, role: 'strong' }, { text: `  ${r.agent}${r.agent_version ? ` ${r.agent_version}` : ''}${this.sep}`, role: 'secondary' },
      r.outcome ? { text: r.outcome, role: r.outcome === 'completed' ? 'strong' : 'failure' } : { text: job && !TERMINAL.has(job.state) ? `running: /jobs ${job.id}` : 'not finished here: no result was written (its REPL ended first)', role: 'estimate' },
      { text: r.why ? `${this.sep}${this.scrub(r.why, this.root)}` : '', role: 'secondary' }]];
    lines.push([{ text: '  Task       ', role: 'secondary' }, { text: taskWords(r.task, this.root, 160) }]);
    const cost = r.cost_usd === undefined ? '' : r.cost_usd === null ? `${this.sep}cost unknown (the agent reported none)` : `${this.sep}cost $${r.cost_usd.toFixed(4)} (${r.cost_basis ?? ''})`;
    lines.push([{ text: '  Model      ', role: 'secondary' }, { text: `${r.model ?? 'its default'}${this.sep}${r.endpoint === 'local' ? `local endpoint ${r.where}` : r.where}${cost}`, role: r.endpoint === 'local' ? undefined : 'estimate' }]);
    if (r.files) {
      const f = r.files;
      lines.push([{ text: '  Changed    ', role: 'secondary' }, { text: `${f.added.length} added, ${f.changed.length} changed, ${f.deleted.length} deleted${f.truncated ? ' (the project has more files than were compared)' : ''}` }]);
      for (const [list, word] of [[f.added, 'added'], [f.changed, 'changed'], [f.deleted, 'deleted']] as const) {
        for (const c of list.slice(0, 12)) lines.push([{ text: '    ' }, word === 'deleted' ? { text: c.path } : { text: this.fileLink(c.path) }, { text: `  ${word}`, role: word === 'deleted' ? 'failure' : 'secondary' }]);
        if (list.length > 12) lines.push(...this.say(`  and ${list.length - 12} more ${word}: ${AGENTS_DIR}/${r.run}/result.json`));
      }
      if (r.git_diff_stat?.after) lines.push([{ text: '  Git        ', role: 'secondary' }, { text: r.git_diff_stat.after.split('\n').filter(Boolean).at(-1) ?? '' }]);
    }
    if (r.final_message) {
      let text = '';
      try { text = readFileSync(join(runDir(this.root, r.run), r.final_message.file), 'utf8'); } catch { /* gone */ }
      const first = scrubPaths(text, this.root).replace(/\s+/g, ' ').trim();
      lines.push([{ text: '  Said       ', role: 'secondary' }, { text: first.length > 300 ? `${first.slice(0, 299)}…` : first || '(empty)', role: 'ai' }]);
      if (first.length > 300 || r.final_message.truncated) lines.push(...this.say(`  the whole message: ${AGENTS_DIR}/${r.run}/${r.final_message.file}`));
    }
    lines.push([{ text: '  Files      ', role: 'secondary' }, { text: this.fileLink(`${AGENTS_DIR}/${r.run}/${r.outcome ? 'result.json' : 'run.json'}`) }, { text: `${r.transcript ? `${this.sep}transcript.log` : ''}${r.receipt ? `${this.sep}receipt ${r.receipt}` : ''}`, role: 'secondary' }]);
    return lines;
  }

  /** Under /jobs <id> for a code agent's job: its parsed progress (tool calls, files edited, what it said). */
  private agentProgressLines(j: JobRecord): Line[] | undefined {
    const st = this.agentRuns.get(j.id);
    const rec = st?.record ?? listAgentRuns(j.root).find((r) => r.job === j.id);
    if (!rec) return undefined;
    const p = st?.progress;
    const edited = p?.filesEdited ?? rec.progress?.files_edited ?? [];
    const calls = p?.toolCalls ?? rec.progress?.tool_calls ?? 0;
    const lines: Line[] = [[{ text: '  Progress ', role: 'secondary' }, { text: `${calls} tool call${calls === 1 ? '' : 's'}${edited.length ? `${this.sep}edited ${edited.slice(0, 6).join(', ')}${edited.length > 6 ? ` and ${edited.length - 6} more` : ''}` : ''}${this.sep}` },
      { text: this.d.link('the transcript', fileUrl(rec.transcript ? join(runDir(j.root, rec.run), rec.transcript) : j.logPath)) }]];
    for (const l of readProgressTail(j.root, rec.run, 12)) lines.push([{ text: `  ${this.d.glyphs.sep} `, role: 'secondary' }, { text: l }]);
    return lines;
  }

  /** /results: each code agent's run in this project, newest first, with what it changed. */
  private agentResultLines(): Line[] {
    const runs = listAgentRuns(this.root).slice(0, 5);
    const lines: Line[] = [[{ text: '  Agents', role: 'strong' }, { text: runs.length ? '  newest first; what each run changed' : '', role: 'secondary' }]];
    if (!runs.length) return [...lines, ...this.say('  none yet: /agent qwen <task>')];
    for (const r of runs) {
      const f = r.files;
      const counts = f ? `${f.added.length} added, ${f.changed.length} changed, ${f.deleted.length} deleted` : 'no result yet';
      lines.push([{ text: `    ${r.run}  ` }, { text: `${r.agent}  `, role: 'strong' }, { text: r.outcome ?? 'not finished', role: r.outcome === 'completed' ? undefined : 'failure' },
        { text: `${this.sep}${counts}${r.receipt ? `${this.sep}receipt ${r.receipt}` : ''}`, role: 'secondary' }]);
      const named = f ? [...f.added.map((c) => `${c.path} added`), ...f.changed.map((c) => `${c.path} changed`), ...f.deleted.map((c) => `${c.path} deleted`)] : [];
      if (named.length) lines.push([{ text: '      ' }, { text: `${named.slice(0, 6).join(this.sep)}${named.length > 6 ? `${this.sep}and ${named.length - 6} more` : ''}`, role: 'secondary' }]);
    }
    lines.push(...this.say('  the last run in full: /agent last'));
    return lines;
  }

  /** A code agent's end, in one notice: its outcome, what it changed, its cost and receipt. */
  private agentEndLine(job: JobRecord, st: AgentRunState): Line {
    const g = this.d.glyphs;
    const r = st.record;
    const f = r.files;
    const ok = r.outcome === 'completed';
    const cost = r.cost_usd === null ? 'cost unknown' : r.cost_usd === undefined ? '' : `cost $${r.cost_usd.toFixed(4)}${r.cost_basis === 'local endpoint' ? ' (local endpoint)' : ''}`;
    return [{ text: `  ${ok ? g.ok : r.outcome === 'cancelled' ? ' ' : g.fail} `, role: ok ? undefined : 'failure' }, { text: `${job.id} ${r.outcome ?? job.state}`, role: ok ? 'strong' : 'failure' },
      { text: `  agent ${r.agent} ${r.run}${f ? `: ${f.added.length} added, ${f.changed.length} changed, ${f.deleted.length} deleted` : ''}${cost ? `${this.sep}${cost}` : ''}${job.receipt ?? r.receipt ? `${this.sep}receipt ${job.receipt ?? r.receipt}` : ''}${this.sep}/agent last`, role: 'secondary' }];
  }

  /**
   * Seals a code agent's run (from the job's seal callback, at its end): the project after it, compared with
   * the snapshot before it; its final message, bounded; its transcript; its result.json; then one receipt
   * (kind agent). Its cost is 0 only for a local endpoint; otherwise what the agent reported, or unknown.
   */
  private sealAgent(job: JobRecord, st: AgentRunState): string | undefined {
    const root = st.root;
    const rec = st.record;
    const judged = judgeAgentRun(job, st.progress, rec.agent);
    let after: { files: Snapshot; truncated: boolean };
    try { after = snapshotProject(root); } catch { after = { files: new Map(), truncated: true }; }
    const changes = diffSnapshots(st.before, after.files);
    const gitAfter = st.gitBefore !== null ? gitStat(root) : null;
    let final = st.progress.finalMessage;
    if (final === undefined && st.plan.lastMessageFile) { try { final = readFileSync(join(root, st.plan.lastMessageFile), 'utf8'); } catch { /* none written */ } }
    final ??= st.progress.lastText;
    const outputs: Array<{ path: string; sha256?: string; bytes: number }> = [];
    const keep = (name: string, write: () => void): void => {
      try {
        write();
        const abs = join(st.dir, name);
        const sha = sha256File(abs);
        outputs.push({ path: `${AGENTS_DIR}/${rec.run}/${name}`, ...(sha ? { sha256: sha } : {}), bytes: statSync(abs).size });
      } catch { /* not kept */ }
    };
    let finalInfo: AgentRunRecord['final_message'] = null;
    if (final !== undefined) {
      const b = boundMessage(final);
      keep('final-message.md', () => writeFileSync(join(st.dir, 'final-message.md'), b.text));
      finalInfo = { file: 'final-message.md', chars: final.length, truncated: b.truncated };
    }
    keep('transcript.log', () => copyFileSync(job.logPath, join(st.dir, 'transcript.log')));
    const local = rec.agent === 'qwen' && st.plan.endpoint === 'local';
    const cost: number | null = local ? 0 : st.progress.reportedCostUsd ?? null;
    const costBasis = local ? 'local endpoint' : cost === null ? 'unknown: the agent reported no cost' : 'reported by the agent';
    Object.assign(rec, {
      ended_at: job.endedAt ?? new Date().toISOString(), exit_code: job.exitCode ?? null, signal: job.signal ?? null, outcome: judged.outcome, why: this.scrub(judged.why, root),
      files: { ...changes, truncated: st.beforeTruncated || after.truncated },
      git_diff_stat: st.gitBefore !== null ? { before: st.gitBefore, after: gitAfter ?? '' } : null,
      final_message: finalInfo,
      progress: { tool_calls: st.progress.toolCalls, files_edited: st.progress.filesEdited, tool_errors: st.progress.toolErrors, denied: st.progress.denied, structured_lines: st.progress.structured, raw_lines: st.progress.raw },
      cost_usd: cost, cost_basis: costBasis, transcript: outputs.some((o) => o.path.endsWith('/transcript.log')) ? 'transcript.log' : undefined,
    } satisfies Partial<AgentRunRecord>);
    keep('result.json', () => writeJson(join(st.dir, 'result.json'), rec));
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const log = sha256File(job.logPath);
    const finalSha = outputs.find((o) => o.path.endsWith('/final-message.md'))?.sha256;
    const status = judged.outcome === 'completed' ? 'ok' as const : judged.outcome === 'cancelled' ? 'cancelled' as const : 'failed' as const;
    const files = [
      // A link's sha256 is of its link text, not of file bytes: links stay in result.json (link text), out of the receipt's files.
      ...changes.added.filter((c) => c.link === undefined).map((c) => ({ path: c.path, ...(c.sha256 ? { sha256: c.sha256 } : {}), bytes: c.size, created: true })),
      ...changes.changed.filter((c) => c.link === undefined).map((c) => ({ path: c.path, ...(c.sha256 ? { sha256: c.sha256 } : {}), ...(c.previous_sha256 && c.previous_link === undefined ? { previous_sha256: c.previous_sha256 } : {}), bytes: c.size })),
    ].slice(0, 200);
    let receipt: string | undefined;
    try {
      receipt = this.d.seal({
        kind: 'agent', subject: `agent · ${rec.agent} · ${rec.run} · ${judged.outcome}`, policy: 'human-gated', status,
        project: job.project, project_id: projectId(root),
        prompt_hash: `sha256:${createHash('sha256').update(rec.task).digest('hex')}`,
        ...(rec.model ? { model_requested: rec.model } : {}),
        ...(st.progress.model ? { model_resolved: st.progress.model } : {}),
        agent: {
          name: rec.agent, run: rec.run, version: rec.agent_version, model: rec.model, endpoint: rec.endpoint, outcome: judged.outcome, why: this.scrub(judged.why, root),
          tool_calls: st.progress.toolCalls, added: changes.added.length, changed: changes.changed.length, deleted: changes.deleted.slice(0, 200).map((c) => c.path),
          ...(finalSha ? { final_message_sha256: finalSha } : {}), cost_basis: costBasis,
        },
        job: {
          id: job.id, kind: job.kind, label: this.scrub(job.label, root), state: job.state, exit_code: job.exitCode ?? null,
          ...(log ? { log_sha256: log } : {}), ...(ms !== undefined ? { ms } : {}), ...(job.error ? { error: this.scrub(job.error, root) } : {}),
        },
        ...(files.length ? { files } : {}),
        ...(outputs.length ? { outputs } : {}),
        ...(cost === null ? { cost_measured: false } : { cost_usd: cost }),
      });
    } catch { receipt = undefined; }
    if (receipt) rec.receipt = receipt;
    try { writeJson(join(st.dir, 'run.json'), { ...rec, state: 'ended', ...(receipt ? { receipt } : {}) }); } catch { /* the result stands */ }
    return receipt;
  }

  // ── /results ────────────────────────────────────────────────────────────────

  results(_args: string): Line[] {
    const lines: Line[] = [[{ text: `  Results in ${this.project.name}`, role: 'strong' }, { text: `  ${this.tilde(this.root)}`, role: 'secondary' }]];
    // Review at c7475458: by the project's folder, never its name, so two folders named app stay apart.
    const id = projectId(this.root);
    const jobs = this.jobs.list().filter((j) => sameFolder(j.root, this.root)).slice(0, 6);
    lines.push([{ text: '  Jobs', role: 'strong' }]);
    if (jobs.length) for (const j of jobs) lines.push(this.jobLine(j));
    else lines.push(...this.say('  none yet: /run, /preview'));
    const outputs = listProjectFiles(this.root).files.filter((f) => f.role === 'output').sort((a, b) => b.mtimeMs - a.mtimeMs);
    lines.push([{ text: '  Outputs', role: 'strong' }, { text: outputs.length ? '  editable where they are' : '', role: 'secondary' }]);
    if (outputs.length) for (const f of outputs.slice(0, 10)) lines.push([{ text: '    ' }, { text: this.fileLink(f.rel) }, { text: `  ${humanBytes(f.bytes)}${this.sep}${ago(f.mtimeMs)}`, role: 'secondary' }]);
    else lines.push(...this.say('  none yet: a build writes them (dist/, build/, out/, outputs/)'));
    const changed: Array<{ path: string; kind: string; id: string }> = [];
    let chain: Receipt[] = [];
    try { chain = (this.d.receipts ?? (() => readChain('runs')))(); } catch { chain = []; }
    for (const rec of [...chain].reverse().slice(0, 60)) {
      // Receipts sealed before projects had an id cannot say which folder they came from: not shown here.
      // A prediction's and an observation's files are what they read, not what they changed.
      if (rec.project_id !== id || !rec.files?.length || rec.kind === 'predict' || rec.kind === 'observe') continue;
      for (const f of rec.files) if (!changed.some((c) => c.path === f.path)) changed.push({ path: f.path, kind: rec.kind, id: String(rec.hash).slice(7, 15) });
    }
    lines.push([{ text: '  Changed', role: 'strong' }, { text: changed.length ? '  by Timmy turns, your edits and /add' : '', role: 'secondary' }]);
    if (changed.length) for (const c of changed.slice(0, 10)) lines.push([{ text: '    ' }, { text: this.fileLink(c.path) }, { text: `  ${c.kind === 'turn' ? 'a Timmy turn' : c.kind === 'edit' ? 'your edit' : c.kind === 'intake' ? 'added (/add)' : c.kind === 'agent' ? 'a code agent (/agent)' : c.kind}${this.sep}receipt ${c.id}`, role: 'secondary' }]);
    else lines.push(...this.say('  nothing yet'));
    // Round R3 (/agent): each code agent's run, how it ended and what it changed (project-relative).
    lines.push(...this.agentResultLines());
    // Round R2, look: what Look measured (and any model's claim beside it), newest first.
    const observed = [...chain].reverse().filter((r) => r.project_id === id && r.kind === 'observe').slice(0, 8);
    lines.push([{ text: '  Observations', role: 'strong' }, { text: observed.length ? '  newest first; measurements, and any model claim' : '', role: 'secondary' }]);
    if (observed.length) {
      for (const r of observed) {
        const src = r.files?.[0]?.path ?? '?';
        const out = r.outputs?.[0]?.path;
        const tiers = r.observation?.tiers?.length ? r.observation.tiers.join(', ') : r.status === 'cancelled' ? 'stopped' : 'not observed';
        // R3 (H14): a qualified answer's outcome, as its receipt sealed it.
        const q = r.observation?.qualified;
        const n = Array.isArray(q?.cites) ? q.cites.length : 0;
        const qualified = q ? `${this.sep}${q.status === 'admitted' ? `cited answer admitted (${n} handle${n === 1 ? '' : 's'}; a claim)` : `no admitted answer: ${q.status}${q.refusal ? ` (${q.refusal})` : ''}`}` : '';
        // R4 (H20): an observation whose file could not be written: where its whole record (and any answer and cost) is kept.
        const kept = r.observation?.kept;
        const keptAt = kept && 'path' in kept ? `${this.sep}its record is kept at ${kept.store === 'timmy' ? this.keptShown(kept) : kept.path}` : kept ? `${this.sep}its record could not be kept` : '';
        lines.push([
          { text: '    ' }, { text: this.fileLink(src) }, { text: ` ${this.d.glyphs.arrow} ` },
          out ? { text: this.fileLink(out) } : { text: r.observation?.error ?? 'no observation', role: 'failure' },
          { text: `  ${tiers}${qualified}${keptAt}${this.sep}receipt ${String(r.hash).slice(7, 15)}`, role: 'secondary' },
        ]);
      }
    } else lines.push(...this.say('  none yet: /observe <image>'));
    lines.push(...this.say('All receipts: /receipts; a receipt\'s page: /web <receipt id>; a job\'s output: /jobs <id>'));
    return lines;
  }

  // ── /board (round R2: a reference board linked to the actual files, jobs and results) ──

  /**
   * `/board`: writes a read-only HTML snapshot of the project to .timmy/board/index.html — references,
   * workflows, this project's jobs, outputs and observations, each card linked to its file (relative
   * links) with the command that acts on it — and opens it. Free text from jobs and observation files
   * has the project's folder written as "." and the home folder as "~", so the page names no absolute path.
   * Each observation card says whether it is verified, unverified or stale, and why (checkObservation).
   * Nothing is sealed: the board is a view of what the project and its receipts already hold.
   */
  board(_args: string): Line[] {
    const { input, references, docs, jobs, outputs, observed, verifiedCount, truncated } = this.boardData();
    const root = this.root;
    const html = renderBoard(input);
    const w = writeProjectFile(root, BOARD_FILE, html);
    if (!w.ok) return this.say(`The board could not be written: ${w.error}`, 'failure');
    const opened = this.d.openWeb(fileUrl(join(root, w.rel)));
    const flows = (input.flows?.list.length ?? 0) + (input.flows?.more ?? 0);
    const counts = [
      `References ${references}`, `Workflows ${docs}`, `Jobs ${jobs}`,
      `Outputs ${outputs}`, `Observations ${observed}${observed ? ` (${verifiedCount} verified)` : ''}`,
      ...(flows ? [`Flows ${flows}`] : []),
    ].join(this.sep);
    return [
      [{ text: '  Board      ', role: 'secondary' }, { text: this.fileLink(w.rel), role: 'strong' }, { text: `  a read-only snapshot${this.sep}/board again makes a new one`, role: 'secondary' }],
      [{ text: '  Holds      ', role: 'secondary' }, { text: counts }],
      ...(truncated ? this.say('Only the first 2,000 files of the project were read.') : []),
      [{ text: '  Browser    ', role: 'secondary' }, { text: opened }],
    ];
  }

  /** What a board shows (the snapshot's and the live board's): gathered from the project, its jobs and its receipts. */
  private boardData(live = false): {
    input: BoardInput; references: number; docs: number; jobs: number; outputs: number; observed: number; verifiedCount: number; truncated: boolean;
    images: Array<{ rel: string; kind: string; bytes: number }>;
  } {
    const root = this.root;
    const { files, truncated } = listProjectFiles(root);
    const card = (f: ProjectFile): BoardFile => {
      const abs = join(root, f.rel);
      const sha = sha256File(abs, BOARD_HASH_LIMIT);
      return { rel: f.rel, bytes: f.bytes, kind: kindOf(f.rel, headOf(abs)).kind, ...(sha ? { sha256: sha } : {}) };
    };
    const inObservations = (f: ProjectFile): boolean => f.rel.startsWith(`${OBSERVATIONS_DIR}/`);
    // R4 (/iterate): flow records are shown as flows, not again as outputs.
    const inFlows = (f: ProjectFile): boolean => f.rel.startsWith(`${FLOWS_DIR}/`);
    const references = files.filter((f) => f.role === 'reference');
    // Observation files are shown as observations, not again as outputs.
    const outputs = files.filter((f) => f.role === 'output' && !inObservations(f) && !inFlows(f)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const docs = findWorkflowDocs(root);
    // R4 (H22): each document's blocks with their language and command, its sha256, and whether the live board edits it.
    const workflows = docs.slice(0, BOARD_MAX.workflows).map((doc) => {
      const r = readProjectFile(root, doc.rel, 1024 * 1024);
      return workflowForBoard(doc.rel, r.ok && r.text !== undefined && !r.truncated ? { text: r.text, ...(r.sha256 ? { sha256: r.sha256 } : {}) } : undefined);
    });
    const jobs = this.jobs.list().filter((j) => sameFolder(j.root, root));
    // The review of 40022d9: an observation file is editable. Each is checked against the runs chain (a
    // sealed observe receipt for exactly its bytes) and against its image as it is now (checkObservation).
    let chain: Receipt[] = [];
    try { chain = (this.d.receipts ?? (() => readChain('runs')))(); } catch { chain = []; }
    const pid = projectId(root);
    const sources = new Map<string, string | null | undefined>();
    /** The project image's sha256 now: null when it is not there, undefined when it cannot be read or hashed. */
    const sourceNow = (rel: unknown): string | null | undefined => {
      if (typeof rel !== 'string') return undefined;
      if (!sources.has(rel)) {
        const at = resolveInside(root, rel);
        sources.set(rel, 'error' in at ? undefined : !existsSync(at.path) ? null : sha256File(at.path, LOOK_MAX_IMAGE));
      }
      return sources.get(rel);
    };
    const observed: Array<BoardObservation & { at: number }> = [];
    // R4 (H20): a record whose model text was cut is checked against the file that keeps the whole of it.
    const readKept = keptReader(this.keepPlaces(root));
    for (const f of files.filter((x) => inObservations(x) && x.rel.endsWith('.json'))) {
      const r = readProjectFile(root, f.rel, 1024 * 1024);
      if (!r.ok || !r.text || r.truncated) continue;
      let raw: unknown;
      let json: unknown;
      // Checked as written; shown with the project's folder as "." and the home folder as "~".
      try { raw = JSON.parse(r.text); json = JSON.parse(this.scrub(r.text, root)); } catch { continue; }
      const source = raw && typeof raw === 'object' ? (raw as { source?: { path?: unknown } }).source : undefined;
      const o = readObservationRecord(f.rel, json, { record: raw, fileSha256: r.sha256, currentSourceSha256: sourceNow(source?.path), receipts: chain, projectId: pid, readKept });
      if (!o) continue;
      const at = o.madeAt ? Date.parse(o.madeAt) : Number.NaN;
      observed.push({ ...o, ...(o.check ? { check: { ...o.check, reasons: o.check.reasons.map((x) => this.scrub(x, root)) } } : {}), at: Number.isNaN(at) ? f.mtimeMs : at });
    }
    observed.sort((a, b) => b.at - a.at);
    const verifiedCount = observed.filter((o) => o.check?.status === 'verified').length;
    const shownRefs = references.slice(0, BOARD_MAX.references).map(card);
    const shownOutputs = outputs.slice(0, BOARD_MAX.outputs).map(card);
    const shownObs = observed.slice(0, BOARD_MAX.observations).map(({ at: _at, ...o }) => o);
    // The live board's Observe acts only on an image the board shows: a card, or an observation's source.
    const images = [...shownRefs, ...shownOutputs].map((f) => ({ rel: f.rel, kind: f.kind ?? kindOf(f.rel, Buffer.alloc(0)).kind, bytes: f.bytes }));
    if (live) {
      for (const o of shownObs) {
        const rel = o.source?.path;
        if (!rel || images.some((f) => f.rel === rel)) continue;
        const at = resolveInside(root, rel);
        if ('error' in at || !existsSync(at.path)) continue;
        try { if (statSync(at.path).isFile()) images.push({ rel: at.rel, kind: kindOf(at.rel, headOf(at.path)).kind, bytes: statSync(at.path).size }); } catch { /* not readable: not offered */ }
      }
    }
    // R4 (H22): the tray recipe's parameter card, and one result card per result, newest first.
    let params: BoardInput['params'];
    try { params = paramsCard(root); } catch { params = undefined; }
    let results: { cards: ResultCard[]; more: number };
    try { results = gatherResults({ root, jobs, chain, observations: shownObs, scrub: (t, r) => this.scrub(t, r) }); } catch (err) {
      results = { cards: [{ kind: 'board', title: 'results', status: { word: 'unreadable', tone: 'failed', detail: this.scrub(err instanceof Error ? err.message : String(err), root) } }], more: 0 };
    }
    const input: BoardInput = {
      project: this.project.name,
      madeAt: utcStamp(new Date()),
      base: BOARD_BASE,
      references: shownRefs,
      workflows,
      ...(params ? { params } : {}),
      results: results.cards,
      jobs: jobs.slice(0, BOARD_MAX.jobs).map((j) => ({
        id: j.id, state: j.stale ? `${j.state} (its process is gone)` : j.state, label: this.scrub(j.label, j.root), seconds: seconds(j), kind: j.kind,
        ...(j.receipt ? { receipt: j.receipt } : {}),
        ...(live ? { stoppable: this.mine.has(j.id) && !j.stale && !TERMINAL.has(j.state) } : {}),
      })),
      outputs: shownOutputs,
      observations: shownObs,
      more: {
        references: Math.max(0, references.length - BOARD_MAX.references),
        outputs: Math.max(0, outputs.length - BOARD_MAX.outputs),
        workflows: Math.max(0, docs.length - BOARD_MAX.workflows),
        jobs: Math.max(0, jobs.length - BOARD_MAX.jobs),
        observations: Math.max(0, observed.length - BOARD_MAX.observations),
        results: results.more,
      },
      ...(live ? { live: true } : {}),
      // R4 (/iterate): each flow record, checked against the runs chain like an observation.
      flows: readBoardFlows(root, files.filter((f) => inFlows(f) && f.rel.endsWith('.json')).map((f) => f.rel), { receipts: chain, projectId: pid, scrub: (t) => this.scrub(t, root) }),
    };
    return {
      input, references: references.length, docs: docs.length, jobs: jobs.length, outputs: outputs.length, observed: observed.length, verifiedCount, truncated, images,
    };
  }

  // ── /board live (round R3: the board with Stop, Run and Observe, served on 127.0.0.1) ──

  /**
   * `/board live` serves the board with job controls on 127.0.0.1 (src/repl/board-live.ts) and opens it;
   * again, it says where it runs; `/board off` stops it, as does the REPL's end. Each button runs the typed
   * command it stands for through this Workspace's own method, echoed in the transcript as from the board.
   */
  async boardLive(args: string): Promise<Line[]> {
    const a = args.trim();
    if (a === 'off') {
      if (!this.live) return this.say('No live board is running: /board live starts one.');
      const was = this.live.address;
      await this.closeLiveBoard();
      return this.say(`The live board at ${was} is stopped; its address no longer answers.`);
    }
    if (a !== 'live') return this.say('Usage: /board (a read-only snapshot), /board live (with controls, on 127.0.0.1), /board off');
    if (this.live) {
      return [
        [{ text: '  Live board ', role: 'secondary' }, { text: this.live.address, role: 'strong' }, { text: `  running for this REPL${this.sep}/board off stops it`, role: 'secondary' }],
        [{ text: '  Open       ', role: 'secondary' }, { text: this.d.link(this.live.url, this.live.url) }, { text: '  the token after # stays in your browser', role: 'secondary' }],
      ];
    }
    // Round R4 (review M4): the pane opens a private launch page, removed once the board has let the page in.
    const lb = new LiveBoard({ onAuthorized: () => dropLaunchPages(lb.url), state: () => this.liveState(), execute: (c) => this.boardCommand(c), edit: (body, s) => this.boardEdit(body, s), scrub: (t) => this.scrub(t, this.root) });
    try { await lb.start(); } catch (err) { return this.say(`The live board could not start: ${err instanceof Error ? err.message : 'error'}`, 'failure'); }
    this.live = lb;
    const opened = this.d.openWeb(lb.url, { secret: true });
    return [
      [{ text: '  Live board ', role: 'secondary' }, { text: lb.address, role: 'strong' }, { text: `  on 127.0.0.1 only, for this REPL${this.sep}Stop, Run and Observe act as the typed command${this.sep}/board off stops it`, role: 'secondary' }],
      [{ text: '  Browser    ', role: 'secondary' }, { text: opened }],
    ];
  }

  /** The live board's address, while it runs (for tests and the REPL's status). */
  get liveBoard(): { address: string; url: string; port: number; host?: string } | undefined {
    return this.live ? { address: this.live.address, url: this.live.url, port: this.live.boundPort, host: this.live.boundHost } : undefined;
  }

  private async closeLiveBoard(): Promise<void> {
    const lb = this.live;
    this.live = undefined;
    if (lb) dropLaunchPages(lb.url);
    await lb?.close();
  }

  /** The live board's state: the board's sections with buttons, and what its actions are checked against. */
  private liveState(): LiveState {
    const { input, images } = this.boardData(true);
    const { toc, main } = renderBoardBody(input);
    // The sections are redrawn when this changes: everything but the jobs' states and times.
    const shape = createHash('sha256').update(JSON.stringify({ ...input, madeAt: '', jobs: input.jobs.map((j) => ({ id: j.id, label: j.label, receipt: j.receipt })) })).digest('hex').slice(0, 16);
    return {
      project: input.project, madeAt: input.madeAt, toc, html: main, shape,
      jobs: input.jobs.map((j) => ({ id: j.id, state: j.state, label: j.label, ...(j.seconds ? { seconds: j.seconds } : {}), stoppable: j.stoppable === true })),
      workflows: input.workflows.map((w) => ({ rel: w.rel, blocks: w.blocks.map((b) => b.name) })),
      files: images,
      recipes: input.params ? [input.params.recipe] : [],
    };
  }

  /**
   * Round R4 (H22): a structured edit from the live board (the parameter form or the workflow node editor),
   * checked and applied by src/repl/board-edits.ts against the board's state, sealed as an edit receipt; echoed
   * in the transcript as from the board, with the page's answer scrubbed of the project's and home folders.
   */
  private async boardEdit(body: unknown, state: LiveState): Promise<{ status: number; text: string }> {
    const root = this.root;
    const out = applyBoardEdit(body, {
      root, project: this.project.name, projectId: projectId(root), workflows: state.workflows.map((w) => w.rel), recipes: state.recipes ?? [], seal: this.d.seal,
    });
    this.d.notify([{ text: '  board  ', role: 'secondary' }, { text: this.scrub(out.line, root), role: out.status === 200 ? 'strong' : 'failure' }]);
    return { status: out.status, text: this.scrub(out.text, root) };
  }

  /**
   * A board action, checked by the live board, run as its typed command: the same method and argument
   * string as `/stop`, `/run` or `/observe` typed here. It is echoed in the transcript as from the board,
   * with what it printed; the page gets that text with the project's folder as "." and the home folder as "~".
   */
  private async boardCommand(c: BoardCommand): Promise<string[]> {
    const root = this.root;
    this.d.notify([{ text: '  board  ', role: 'secondary' }, { text: c.line, role: 'strong' }]);
    const lines = c.name === 'stop' ? await this.stop(c.args) : c.name === 'run' ? await this.run(c.args)
      : c.name === 'recipe' ? await this.recipe(c.args) : await this.observe(c.args);
    for (const line of lines) this.d.notify(line);
    return lines.map((l) => this.scrub(l.map((s) => s.text).join(''), root));
  }
}
