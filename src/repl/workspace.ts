/**
 * The REPL's workspace (R1 workspace direction, 2026-10-08): one active project, its Files, Workflows
 * (upmd), background jobs (workflow runs and preview servers), Preview in Timmy's Browser, and Results —
 * all on the same project folder, the same job identity and the same receipt chain.
 *
 * Jobs run in their own process groups (src/jobs), so the REPL stays usable while they run and /stop
 * stops a job with everything it started. A preview server is "ready" when its address answers, which is
 * not the same as a build being "completed". A workflow run seals its prediction first, then its outcome.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { JobManager, type JobRecord } from '../jobs/index.js';
import {
  chooseProject, createProject, groupFiles, humanBytes, listProjectFiles, listProjects, projectsHome, readProjectFile,
  resolveInside, ROLE_LABEL, ROLE_ORDER, saveActiveProject, type ActiveProject, type FileRole, type ProjectFile,
} from '../project/index.js';
import { staticServerCommand } from '../preview/static-server.js';
import { killProcessGroup } from '../runtime/spawn-runtime.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { readChain, type Receipt, type ReceiptInput } from '../utils/receipts.js';
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
  receipts?: () => Receipt[];
}

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

  private use(p: ActiveProject): void {
    (this.d.chdir ?? process.chdir)(p.root);
    this.project = p;
    saveActiveProject(p);
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
      kind: 'edit', subject: `edit · ${at.rel}`, policy: 'human-gated', status: 'ok', project: this.project.name,
      files: [{ path: at.rel, sha256: after, ...(before ? { previous_sha256: before } : {}), created: before === undefined, bytes: statSync(at.path).size }],
    });
    return [[{ text: `  Saved ${this.fileLink(at.rel)}`, role: 'strong' }, { text: `${id ? `${this.sep}receipt ${id}` : ''}${this.sep}/results`, role: 'secondary' }]];
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
      kind: 'predict', subject: `workflow · predict · ${r.rel} › ${target}`, policy: 'human-gated', status: 'ok', project: this.project.name,
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

  private sealJob(job: JobRecord): string | undefined {
    const p = this.predictions.get(job.id);
    const met = p ? job.state === 'completed' && job.steps.length === p.order.length && job.steps.every((s, i) => s.name === p.order[i] && s.state === 'completed') : undefined;
    const outputs = job.kind === 'server' ? [] : this.outputsSince(job);
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const log = sha256File(job.logPath);
    const kind = job.kind === 'server' ? 'preview' : job.kind;
    try {
      return this.d.seal({
        kind, subject: `${kind} · ${job.label} · ${job.state}`, policy: 'human-gated',
        status: job.state === 'completed' ? 'ok' : job.state === 'cancelled' ? 'cancelled' : 'failed',
        project: job.project,
        job: {
          id: job.id, kind: job.kind, label: job.label, state: job.state, exit_code: job.exitCode ?? null,
          steps: job.steps.map(({ name, state, code }) => ({ name, state, ...(code === undefined ? {} : { code }) })),
          ...(log ? { log_sha256: log } : {}), ...(job.url ? { url: job.url } : {}), ...(ms !== undefined ? { ms } : {}), ...(job.error ? { error: job.error } : {}),
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
    return [
      { text: `  ${mark} `, role: j.state === 'failed' ? 'failure' : undefined },
      { text: j.id, role: 'strong' },
      { text: `  ${j.state.padEnd(9)} ${j.label}${steps}${where}${this.sep}${seconds(j)}${j.receipt ? `${this.sep}receipt ${j.receipt}` : ''}${stale}`, role: 'secondary' },
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

  async stop(args: string): Promise<Line[]> {
    const id = args.trim();
    if (!id) return this.say('Usage: /stop <job>, or /stop all');
    if (id === 'all') {
      const live = this.jobs.list().filter((j) => !j.stale && !TERMINAL.has(j.state)).length;
      await this.jobs.stopAll();
      return this.say(live ? `Stopped ${live} job${live === 1 ? '' : 's'}.` : 'Nothing was running.');
    }
    const j = this.jobs.get(id);
    if (!j) return this.say(`No job ${id} started in this REPL. /jobs lists them.`);
    if (TERMINAL.has(j.state)) return this.say(`${id} already ${j.state}.`);
    const done = await this.jobs.stop(id);
    return [[{ text: `  ${id} ${done?.state ?? 'cancelled'}`, role: 'strong' }, { text: `  ${j.label}: it and everything it started have stopped`, role: 'secondary' }]];
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

  // ── /results ────────────────────────────────────────────────────────────────

  results(_args: string): Line[] {
    const lines: Line[] = [[{ text: `  Results in ${this.project.name}`, role: 'strong' }, { text: `  ${this.tilde(this.root)}`, role: 'secondary' }]];
    const jobs = this.jobs.list().filter((j) => j.project === this.project.name).slice(0, 6);
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
      if (rec.project !== this.project.name || !rec.files?.length || rec.kind === 'predict') continue;
      for (const f of rec.files) if (!changed.some((c) => c.path === f.path)) changed.push({ path: f.path, kind: rec.kind, id: String(rec.hash).slice(7, 15) });
    }
    lines.push([{ text: '  Changed', role: 'strong' }, { text: changed.length ? '  by Timmy turns and your edits' : '', role: 'secondary' }]);
    if (changed.length) for (const c of changed.slice(0, 10)) lines.push([{ text: '    ' }, { text: this.fileLink(c.path) }, { text: `  ${c.kind === 'turn' ? 'a Timmy turn' : c.kind === 'edit' ? 'your edit' : c.kind}${this.sep}receipt ${c.id}`, role: 'secondary' }]);
    else lines.push(...this.say('  nothing yet'));
    lines.push(...this.say('All receipts: /receipts; a receipt\'s page: /web <receipt id>; a job\'s output: /jobs <id>'));
    return lines;
  }
}
