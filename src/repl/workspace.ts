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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { JobManager, type JobRecord } from '../jobs/index.js';
import { aerenderJob, c4dpyJob, judgeNativeJob, nativeReceiptFields, NativeNotFound, type NativeJobSpec } from '../native/index.js';
import { mcpView, splitCommandLine } from '../connectors/mcp-cli.js';
import {
  chooseProject, createProject, groupFiles, humanBytes, listProjectFiles, listProjects, projectId, projectsHome, readProjectFile,
  resolveInside, ROLE_LABEL, ROLE_ORDER, sameFolder, saveActiveProject, type ActiveProject, type FileRole, type ProjectFile,
} from '../project/index.js';
import { staticServerCommand } from '../preview/static-server.js';
import { hashFile, intakeFiles, splitArgs } from '../project/intake.js';
import { killProcessGroup } from '../runtime/spawn-runtime.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { readChain, type Receipt, type ReceiptInput } from '../utils/receipts.js';
import { checkOpenCv, DETERMINISTIC, INTERPRETATION, LOOK_MAX_IMAGE, LOOK_MAX_OUTPUT, LOOK_TIMEOUT_MS, lookArgs, lookPython, OPENCV_SETUP, parseLookOutput, writeObservation, lookEnv } from '../vision/look.js';
import { describeImage } from '../vision/route.js';
import { findUpmd, findWorkflowDocs, parseUpmdLine, parseWorkflow, runOrder, stepsFromEvent, upmdRunArgs, upmdVersion } from '../workflows/upmd.js';

type Line = Segment[];

export interface WorkspaceDeps {
  glyphs: GlyphSet;
  env: NodeJS.ProcessEnv;
  onPath: (cmd: string) => string | null;
  /** A notice above the prompt (a step finished, a server is ready): the REPL's own printer. */
  notify: (line: Line) => void;
  /** Opens a page in Timmy's Browser (/web): carbonyl in a pane, else a link. One line back. */
  openWeb: (url: string) => string;
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
}

/** How an observation ended (round R2, look): its file and receipt, or why there is none. */
export type ObserveOutcome =
  | { ok: true; file: string; receipt?: string; tiers: string[]; interpretation?: Record<string, unknown> }
  | { ok: false; error: string; receipt?: string };

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const sha256File = (path: string): string | undefined => {
  try {
    if (statSync(path).size > 16 * 1024 * 1024) return undefined;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch { return undefined; }
};
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

interface Prediction { doc: string; block: string; order: string[]; receipt?: string }

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

  constructor(private readonly d: WorkspaceDeps, start: ActiveProject) {
    this.project = start;
    this.jobs = new JobManager({ dir: d.jobsDir, onChange: (job) => this.changed(job), seal: (job) => this.sealJob(job) });
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
      const made = createProject(a.slice(3).trim());
      if ('error' in made) return this.say(made.error);
      this.use(made);
      return [[{ text: `  Made ${made.name}.`, role: 'strong' }], ...this.summary()];
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
   */
  async observeFile(relArg: string, question?: string, model?: string): Promise<{ ok: true; job: JobRecord; done: Promise<ObserveOutcome> } | { ok: false; error: string }> {
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
    const done = this.jobs.done(job.id).then((j) => this.observed(j, { root, project, imagePath: at.path, source, question: q, ...(model ? { model } : {}) }))
      .catch((err: unknown): ObserveOutcome => ({ ok: false, error: `the observation could not be finished (${err instanceof Error ? err.message : 'error'})` }));
    return { ok: true, job, done };
  }

  /** `/observe <file> [question]`: starts Look; the observation arrives as a notice and in /results. */
  async observe(args: string): Promise<Line[]> {
    const a = args.trim();
    const m = a.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s*([\s\S]*)$/);
    if (!a || !m) return this.say('Usage: /observe <file> [question]   (a question asks the current model too)');
    const rel = m[1] ?? m[2] ?? m[3];
    const question = m[4].trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    const started = await this.observeFile(rel, question);
    if (!started.ok) return this.say(started.error, 'failure');
    const g = this.d.glyphs;
    const model = this.d.model?.();
    return [
      [{ text: '  Observing  ', role: 'secondary' }, { text: started.job.id, role: 'strong' }, { text: `  ${started.job.label.slice(5)} with Look${this.sep}/jobs ${started.job.id}${this.sep}/stop ${started.job.id}`, role: 'secondary' }],
      ...(question ? [[{ text: '  Then asks ', role: 'secondary' as const }, { text: model ?? 'no model known here', role: model ? 'ai' as const : 'estimate' as const }, { text: ` ${g.arrow} a model interpretation, a claim beside the measurements`, role: 'secondary' as const }]] : []),
    ];
  }

  private async observed(j: JobRecord, o: { root: string; project: string; imagePath: string; source: { path: string; sha256: string; bytes: number }; question?: string; model?: string }): Promise<ObserveOutcome> {
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
    let interpretation: Record<string, unknown> | undefined;
    if (o.question) {
      const model = o.model ?? this.d.model?.();
      if (!model) interpretation = { tier: INTERPRETATION, status: 'not asked', question: o.question, reason: 'no current model is known here' };
      else {
        const r = await describeImage({ model, imagePath: o.imagePath, question: o.question, apiKey: this.d.env.OPENROUTER_API_KEY, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
        // The claim is about the bytes the model saw: they must be the bytes Look measured.
        if (r.ok && r.image_sha256 !== o.source.sha256) interpretation = { tier: INTERPRETATION, status: 'failed', model, question: o.question, reason: `${rel} changed between Look and the model, so the answer is not kept` };
        else if (r.ok) { const { ok: _ok, ...rest } = r; interpretation = { status: 'answered', ...rest }; }
        else interpretation = { tier: INTERPRETATION, status: r.refused ? 'refused' : 'failed', model, question: o.question, reason: r.error, ...(r.alternatives ? { alternatives: r.alternatives } : {}) };
      }
    }
    const answered = interpretation?.status === 'answered';
    const tiers = [DETERMINISTIC, ...(answered ? [INTERPRETATION] : [])];
    const now = new Date();
    const record = {
      observation: 1, made_at: now.toISOString(), project: o.project, source: o.source, tiers,
      reading: 'Measurements are deterministic computations on the pixels. An interpretation is a model\'s claim about the image, not a measurement.',
      look, ...(interpretation ? { interpretation } : {}), job: { id: j.id },
    };
    const w = writeObservation(o.root, rel, record, now);
    if (!w.ok) return fail(`the observation could not be written: ${w.error}`, 'failed');
    const cost = answered && typeof interpretation?.cost_usd === 'number' ? interpretation.cost_usd as number : undefined;
    let receipt: string | undefined;
    try {
      receipt = this.d.seal({
        ...base, subject: `observe · ${rel}`, status: 'ok', outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
        observation: {
          tiers, worker: `${look.worker.name} ${look.worker.version}`, opencv: look.opencv, measurements: look.measurements.length,
          ...(interpretation ? { interpretation: { status: String(interpretation.status), ...(typeof interpretation.model === 'string' ? { model: interpretation.model } : {}), ...(answered ? { cost_usd: cost ?? null } : {}) } } : {}),
        },
        ...(answered ? { model_requested: String(interpretation?.model_requested), model_resolved: String(interpretation?.model) } : {}),
        ...(cost !== undefined ? { cost_usd: cost } : {}),
      });
    } catch { receipt = undefined; }
    this.d.notify([{ text: `  ${g.ok} ` }, { text: `${j.id} observed`, role: 'strong' }, { text: `  ${rel} ${g.arrow} ${w.path}${this.sep}${tiers.join(', ')}${receipt ? `${this.sep}receipt ${receipt}` : ''}`, role: 'secondary' }]);
    if (interpretation && !answered) {
      const alt = Array.isArray(interpretation.alternatives) && interpretation.alternatives.length ? `; models that do: ${(interpretation.alternatives as string[]).join(', ')} (/model <id>)` : '';
      this.d.notify([{ text: '  Model      ', role: 'secondary' }, { text: `${String(interpretation.reason)}${alt}`, role: 'estimate' }]);
    } else if (answered) {
      this.d.notify([{ text: '  Model      ', role: 'secondary' }, { text: `${String(interpretation?.model)} answered (a claim, in the file)${this.sep}cost ${cost === undefined ? 'not reported' : `$${cost.toFixed(4)}`}`, role: 'ai' }]);
    }
    return { ok: true, file: w.path, tiers, ...(receipt ? { receipt } : {}), ...(interpretation ? { interpretation } : {}) };
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

  private defaultPreviewFolder(): string | null {
    for (const dir of ['dist', 'build', 'out', 'public']) if (existsSync(join(this.root, dir, 'index.html'))) return dir;
    return existsSync(join(this.root, 'index.html')) ? '.' : null;
  }

  private devScript(): string | null {
    try {
      const pkg = JSON.parse(readFileSync(join(this.root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      return ['dev', 'start', 'preview'].find((s) => typeof pkg.scripts?.[s] === 'string') ?? null;
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
      const folder = a || this.defaultPreviewFolder();
      const script = a ? null : this.devScript();
      if (folder) {
        const at = folder === '.' ? { path: this.root, rel: '.' } : resolveInside(this.root, folder);
        if ('error' in at) return this.say(at.error);
        if (!existsSync(at.path) || !statSync(at.path).isDirectory()) return this.say(`${folder} is not a folder in this project.`);
        spec = { label: `preview ${at.rel === '.' ? 'the project' : `${at.rel}/`}`, ...(this.d.staticServer ?? staticServerCommand)(at.path, port), url: `http://127.0.0.1:${port}/` };
      } else if (script) {
        spec = { label: `preview npm run ${script}`, command: 'npm', args: ['run', script], url: `http://127.0.0.1:${port}/`, env: { ...this.d.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' } };
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
    const nat = this.natives.get(job.id);
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
    if (this.looks.has(job.id)) return undefined;
    const p = this.predictions.get(job.id);
    const met = p ? job.state === 'completed' && job.steps.length === p.order.length && job.steps.every((s, i) => s.name === p.order[i] && s.state === 'completed') : undefined;
    const outputs = job.kind === 'server' ? [] : this.outputsSince(job);
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const log = sha256File(job.logPath);
    const kind = job.kind === 'server' ? 'preview' : job.kind;
    const label = this.scrub(job.label, job.root);
    const error = job.error ? this.scrub(job.error, job.root) : undefined;
    const nat = this.natives.get(job.id);
    const judged = nat && job.state !== 'cancelled' ? nativeReceiptFields(nat.native.app, judgeNativeJob(job, nat)) : undefined;
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

  jobsView(args: string): Line[] {
    const id = args.trim();
    if (id) {
      const j = this.jobs.get(id) ?? this.jobs.list().find((x) => x.id === id);
      if (!j) return this.say(`No job ${id}. /jobs lists them.`);
      const lines: Line[] = [this.jobLine(j)];
      for (const s of j.steps) lines.push([{ text: `      ${s.state === 'completed' ? this.d.glyphs.ok : s.state === 'failed' ? this.d.glyphs.fail : this.d.glyphs.bullet} ${s.name}`, role: s.state === 'failed' ? 'failure' : undefined }, { text: s.code === undefined ? '' : `  exit ${s.code}`, role: 'secondary' }]);
      lines.push([{ text: '  Output   ', role: 'secondary' }, { text: this.d.link('the full log', fileUrl(j.logPath)) }, { text: `${this.sep}${j.lines} lines; the last of them:`, role: 'secondary' }]);
      for (const l of this.jobs.tail(j.id, 12)) lines.push([{ text: `  ${this.d.glyphs.sep} `, role: 'secondary' }, { text: l }]);
      return lines;
    }
    const all = this.jobs.list().slice(0, 12);
    if (!all.length) return this.say('No jobs yet: /run starts a workflow, /preview a preview server.');
    return [...all.map((j) => this.jobLine(j)), ...this.say('Details: /jobs <id>; stop one: /stop <id>')];
  }

  /**
   * Stops this REPL's own jobs and reports what actually happened (review at c7475458: /stop claimed
   * another session's job stopped when it was left untouched, and /stop all counted jobs it did not own).
   */
  async stop(args: string): Promise<Line[]> {
    const id = args.trim();
    if (!id) return this.say('Usage: /stop <job>, or /stop all');
    if (id === 'all') {
      const live = [...this.mine].map((x) => this.jobs.get(x)).filter((j): j is JobRecord => !!j && !TERMINAL.has(j.state));
      if (!live.length) return this.say('Nothing this REPL started is running.');
      const ended = await Promise.all(live.map((j) => this.jobs.stop(j.id)));
      const clean = ended.filter((j) => j && TERMINAL.has(j.state) && !j.error).length;
      const left = live.length - clean;
      return left
        ? this.say(`Stopped ${clean} of ${live.length} jobs this REPL started; ${left} did not stop cleanly: /jobs`, 'failure')
        : this.say(`Stopped ${clean} job${clean === 1 ? '' : 's'} this REPL started, with ${clean === 1 ? 'its process group' : 'their process groups'}.`);
    }
    const j = this.jobs.get(id);
    if (!j) return this.say(`No job ${id}. /jobs lists them.`);
    if (!this.mine.has(id)) {
      const how = j.stale ? 'its process is gone' : TERMINAL.has(j.state) ? `it already ${j.state}` : `it is ${j.state} and was left as it is`;
      return this.say(`${id} was started by another Timmy session; ${how}. /stop stops only the jobs this REPL started.`);
    }
    if (TERMINAL.has(j.state)) return this.say(`${id} already ${j.state}.`);
    const done = await this.jobs.stop(id);
    if (!done || !TERMINAL.has(done.state) || done.error) {
      return [[{ text: `  ${id} ${done?.state ?? 'unknown'}`, role: 'failure' }, { text: `  ${j.label}: ${done?.error ?? 'it did not stop'}; /jobs ${id}`, role: 'secondary' }]];
    }
    return [[{ text: `  ${id} ${done.state}`, role: 'strong' }, { text: `  ${j.label}: it and its process group have stopped`, role: 'secondary' }]];
  }

  /** The REPL is ending: stop what this REPL started. */
  async close(): Promise<void> { await this.jobs.stopAll(); }

  /** The process is exiting at once (a second Ctrl+C): signal this REPL's live jobs without waiting. */
  killNow(): void {
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
    this.adoptNative(job.id, spec);
    return [[{ text: '  Running    ', role: 'secondary' }, { text: job.id, role: 'strong' }, { text: `  ${what}${this.sep}judged by its result file${this.sep}/jobs ${job.id}${this.sep}/stop ${job.id}`, role: 'secondary' }]];
  }

  /** /c4d <script.py> [args]: Cinema 4D's own Python (c4dpy), headless, as a job in the project. */
  async c4d(args: string): Promise<Line[]> {
    const w = splitCommandLine(args.trim());
    if (!w.length) return this.say('Usage: /c4d <script.py> [args]   (Cinema 4D Python, headless, as a job)');
    return this.startNative(() => c4dpyJob({ script: w[0], args: w.slice(1), root: this.root, project: this.project.name }), `Cinema 4D runs ${w[0]}`);
  }

  /** /ae <project.aep> <comp> <output>: After Effects renders an existing project's comp (aerender), as a job. */
  async ae(args: string): Promise<Line[]> {
    const w = splitCommandLine(args.trim());
    if (w.length < 3) return this.say('Usage: /ae <project.aep> <comp> <output file>   (renders an existing project)');
    return this.startNative(() => aerenderJob({ projectFile: w[0], comp: w[1], output: w[2], root: this.root, project: this.project.name }), `After Effects renders ${w[1]} from ${w[0]}`);
  }

  /** /mcp: MCP servers and their tools through the two command-line routes (MCPorter, Timmy's SDK command). */
  async mcp(args: string): Promise<Line[]> {
    const lines = await mcpView(splitCommandLine(args.trim()), { cwd: this.root });
    return lines.map((l) => [{ text: `  ${l}` }]);
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
    if (changed.length) for (const c of changed.slice(0, 10)) lines.push([{ text: '    ' }, { text: this.fileLink(c.path) }, { text: `  ${c.kind === 'turn' ? 'a Timmy turn' : c.kind === 'edit' ? 'your edit' : c.kind === 'intake' ? 'added (/add)' : c.kind}${this.sep}receipt ${c.id}`, role: 'secondary' }]);
    else lines.push(...this.say('  nothing yet'));
    // Round R2, look: what Look measured (and any model's claim beside it), newest first.
    const observed = [...chain].reverse().filter((r) => r.project_id === id && r.kind === 'observe').slice(0, 8);
    lines.push([{ text: '  Observations', role: 'strong' }, { text: observed.length ? '  newest first; measurements, and any model claim' : '', role: 'secondary' }]);
    if (observed.length) {
      for (const r of observed) {
        const src = r.files?.[0]?.path ?? '?';
        const out = r.outputs?.[0]?.path;
        const tiers = r.observation?.tiers?.length ? r.observation.tiers.join(', ') : r.status === 'cancelled' ? 'stopped' : 'not observed';
        lines.push([
          { text: '    ' }, { text: this.fileLink(src) }, { text: ` ${this.d.glyphs.arrow} ` },
          out ? { text: this.fileLink(out) } : { text: r.observation?.error ?? 'no observation', role: 'failure' },
          { text: `  ${tiers}${this.sep}receipt ${String(r.hash).slice(7, 15)}`, role: 'secondary' },
        ]);
      }
    } else lines.push(...this.say('  none yet: /observe <image>'));
    lines.push(...this.say('All receipts: /receipts; a receipt\'s page: /web <receipt id>; a job\'s output: /jobs <id>'));
    return lines;
  }
}
