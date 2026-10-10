/**
 * Round R4 (helper H58, ledger row 157): a workflow run's block states as they happen.
 *
 * With its output a pipe, upmd 0.2.7 prints a block's start line, its output and its end line all at once, when the block
 * ends (r18 on the operator's Mac: the Timmy Workflows card never showed a block running, each block's own time read
 * "<0.1 s", and a block stopped or interrupted mid-run read "not run"). On a terminal it draws each block as it starts and
 * its output as it runs. So Timmy runs upmd on a pseudo-terminal of its own: workers/upmd/pty_run.py, run by this
 * machine's python3 (Timmy's other workers need it too), starts upmd as the leader of its own session on a pty, copies the
 * pty's bytes to its stdout unchanged, exits with upmd's exit code, and on SIGTERM stops upmd's process group and the
 * groups of the blocks upmd started on terminals of their own. Before the first run a REPL checks once that the wrapper
 * works here (ptyReady: it runs a small program through it and asks whether that program's output is a terminal). Where
 * there is no python3, no wrapper, or the check fails, upmd runs over a pipe as before and the card says live states are
 * not available.
 *
 * What upmd 0.2.7 wrote on a terminal (tests/fixtures/upmd-0.2.7-pty-third.bin: a probe document of three blocks, run as
 * `upmd --ci -b third` under python3's pty on the operator's Mac), read line by line once ANSI sequences and CRs are
 * removed (terminalText):
 *   ` [1/3] Bash`, ` [2/3] Bash  [first]`       a block starts: its number in the document, the document's count of
 *                                               fenced blocks, its language and its needs; drawn again at each redraw
 *   `==> first [block 1]`                        the block has ended: its summary (its whole output again) follows
 *   `  ✔ exited with code 0`, `  ✘ exited with code 3`   the summary's last line: how it ended
 *   `Block 2 failed - stopping dependency chain` (stderr, before that summary) no block after it runs
 * and around them the block's code and output, each line indented by two spaces, a drawn cursor and redraws
 * (ESC[nA CR ESC[J). A block's start names it by the document's block of that number (parseWorkflow counts fenced blocks
 * as upmd does); its summary line names it in upmd's own words, and where the two differ upmd's name is kept (the
 * document may have changed since the run started). The wrapper's own lines (stderr, `pty_run: `) say when it was asked
 * to stop: the block running then is stopped. The pipe format (old runs, the fallback, the test double's pipe mode) is
 * read as before (src/workflows/upmd.ts parseUpmdLine, stepsFromEvent).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRecord, JobStep } from '../jobs/index.js';
import { spawnProcess } from '../runtime/spawn-runtime.js';
import { packagedPath, packageRoot } from '../utils/asset-dirs.js';
import { parseUpmdLine, stepsFromEvent, type WorkflowBlock } from './upmd.js';

/** workers/upmd/pty_run.py at the package root (as src/flows/iterate.ts finds its readback worker). */
function packaged(rel: string): string {
  return packagedPath(rel, import.meta.url, { kind: 'file' }) ?? path.join(packageRoot(import.meta.url) ?? fileURLToPath(new URL('.', import.meta.url)), rel);
}
export const PTY_RUN_SCRIPT = packaged('workers/upmd/pty_run.py');
const WRAPPER = 'pty_run.py';

/** Whether this machine can run upmd on a pty through the wrapper; why not, in words, when it cannot. */
export type PtyReady = { ok: true; python: string; script: string } | { ok: false; why: string };

const probes = new Map<string, { p: Promise<PtyReady>; done?: PtyReady }>();
/** What the probe printed through the wrapper when its output was a terminal. */
const PROBE_SAID = 'timmy pty: a terminal';
const PROBE = `import os, sys; sys.stdout.write(${JSON.stringify(PROBE_SAID)} if os.isatty(1) else 'timmy pty: not a terminal')`;

function staticReady(python: string | null, script: string): PtyReady | undefined {
  if (!python) return { ok: false, why: 'no python3 on PATH' };
  if (!existsSync(script)) return { ok: false, why: 'its pty wrapper (workers/upmd/pty_run.py) is missing from this Timmy' };
  return undefined;
}

/**
 * Whether upmd can run on a pty here: python3 (`python`, as the caller found it on PATH) runs the wrapper with a small
 * program of its own, whose output must be a terminal. Checked once per python3 and wrapper for this process (5 s at
 * most); nothing of upmd runs.
 */
export function ptyReady(python: string | null, script: string = PTY_RUN_SCRIPT): Promise<PtyReady> {
  const known = staticReady(python, script);
  if (known) return Promise.resolve(known);
  const key = `${python}\0${script}`;
  let entry = probes.get(key);
  if (!entry) {
    const made: { p: Promise<PtyReady>; done?: PtyReady } = { p: probe(python!, script) };
    made.p.then((r) => { made.done = r; }, () => undefined);
    probes.set(key, made);
    entry = made;
  }
  return entry.p;
}

/** ptyReady's answer when it is known now without waiting (no python3, no wrapper, or a check that has finished). */
export function ptyKnown(python: string | null, script: string = PTY_RUN_SCRIPT): PtyReady | undefined {
  return staticReady(python, script) ?? probes.get(`${python}\0${script}`)?.done;
}

async function probe(python: string, script: string): Promise<PtyReady> {
  try {
    const { child, outcome } = spawnProcess(python, ['-I', script, '--', python, '-I', '-c', PROBE], { timeoutMs: 5_000, maxBuffer: 64 * 1024 });
    child.stdin.on('error', () => { /* it may end before its stdin closes */ });
    child.stdin.end();
    const r = await outcome;
    if (r.status === 0 && r.stdout.includes(PROBE_SAID)) return { ok: true, python, script };
    const said = `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).filter((l) => l && !/ runs as process \d+, /.test(l)).at(-1);
    const why = r.timedOut ? 'did not answer within 5 s' : r.error ? r.error : r.status === 0 ? 'its output was not a terminal' : `exit ${r.status ?? r.signal}${said ? `: ${said.slice(0, 160)}` : ''}`;
    return { ok: false, why: `python3 could not run its pty wrapper (${why})` };
  } catch (e) {
    return { ok: false, why: `python3 could not run its pty wrapper (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** The job that runs `upmd <upmdArgs>`: through the wrapper on a pty when `pty` is ready, else upmd itself over a pipe. */
export type UpmdJob = { command: string; args: string[]; live: true } | { command: string; args: string[]; live: false; why: string };
export function upmdJob(bin: string, upmdArgs: string[], pty: PtyReady): UpmdJob {
  return pty.ok
    ? { command: pty.python, args: ['-I', pty.script, '--', bin, ...upmdArgs], live: true }
    : { command: bin, args: [...upmdArgs], live: false, why: pty.why };
}

/** Whether a job's arguments run its command through the pty wrapper (a run whose block states came as they happened). */
export function isLiveRun(args: readonly string[]): boolean {
  const at = args.indexOf('--');
  return at >= 1 && path.basename(args[at - 1]) === WRAPPER;
}

/** The program a live run's wrapper ran (upmd), for whoever names a job by its program; undefined for any other job. */
export function liveProgram(j: Pick<JobRecord, 'kind' | 'args'>): string | undefined {
  if (j.kind !== 'workflow' || !isLiveRun(j.args)) return undefined;
  return j.args[j.args.indexOf('--') + 1];
}

// ── reading upmd's terminal output ───────────────────────────────────────────

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CHARSET = /\x1b[()*+][0-9A-Za-z]/g;
const SHORT = /\x1b[@-Z\\-_]/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** A line of terminal output as text: its ANSI sequences and control characters (a CR among them) removed, trailing space too. */
export function terminalText(line: string): string {
  return line.replace(OSC, '').replace(CSI, '').replace(CHARSET, '').replace(SHORT, '').replace(CONTROLS, '').replace(/\s+$/, '');
}

/**
 * ` [2/3] Bash  [first]`: a block starts (or is drawn again): its number, the count, at most one word (its language) and
 * its needs in brackets, nothing else. upmd indents a block's output by two spaces; the shape also keeps a progress line
 * such as `[2/3] Building CXX object x.o` from being taken for a header, should one reach the start of a line.
 */
const HEADER = /^ ?\[(\d+)\/(\d+)\](?: ([^\s[]\S*))?(?:\s+\[([^\]]*)\])?$/;
const SUMMARY = /^==> (.+) \[block (\d+)\]$/;
const END = /^\s*[✔✘]\s*exited with code (-?\d+)$/;
const CHAIN = /^Block (\d+) failed [-–—] stopping dependency chain$/;
/** The pipe format's end line, in case upmd writes it on a terminal too (anchored: on a terminal output is indented). */
const PIPE_END = /^<== (.+) exited with code (-?\d+)$/;
/** The wrapper's own word that it was asked to stop (workers/upmd/pty_run.py, on its stderr). */
const STOPPING = /^pty_run: (SIG[A-Z0-9]+) received: stopping /;

export type LiveFormat = 'pty' | 'pipe';

/**
 * A job's line reader for a upmd run (JobSpec.parseLine: each stdout and stderr line in order): 'pty' for a run through
 * the wrapper, 'pipe' for upmd's own pipe output. `blocks` are the document's blocks as /run read it; `now` stamps when a
 * block's start and end were seen (a pty run's only: on a pipe both arrive when the block ends). It changes `steps` in
 * place; see the module comment for what each line means.
 */
export function upmdLineParser(blocks: readonly WorkflowBlock[], format: LiveFormat, now: () => Date = () => new Date()): (line: string, steps: JobStep[]) => void {
  if (format === 'pipe') return (line, steps) => { const ev = parseUpmdLine(line); if (ev) stepsFromEvent(steps, ev); };
  const stamp = (): string => now().toISOString();
  const latest = (steps: JobStep[], pred: (s: JobStep) => boolean): JobStep | undefined => { for (let i = steps.length - 1; i >= 0; i--) if (pred(steps[i])) return steps[i]; return undefined; };
  /** the step whose summary is being written (between `==> name [block n]` and the next block's lines) */
  let summary: JobStep | undefined;
  return (line, steps) => {
    if (STOPPING.test(line)) {
      for (const s of steps) if (s.state === 'running') { s.state = 'stopped'; s.endedAt ??= stamp(); }
      summary = undefined;
      return;
    }
    const text = terminalText(line);
    if (!text) return;
    const head = HEADER.exec(text);
    if (head) {
      summary = undefined;
      const n = Number(head[1]);
      // drawn again (a redraw), or a block this run already ended: no new step
      if (!(n >= 1) || steps.some((s) => s.index === n)) return;
      // the document's block of that number, when upmd counts the same blocks; else named by its number until it ends
      const mapped = Number(head[2]) === blocks.length ? blocks[n - 1] : undefined;
      // upmd shows a block's needs, and only then, in brackets: a line that disagrees is not that block's header
      if (mapped && (head[4] !== undefined) !== (mapped.deps.length > 0)) return;
      steps.push({ name: mapped?.name ?? `block ${n}`, index: n, state: 'running', startedAt: stamp() });
      return;
    }
    const sum = SUMMARY.exec(text);
    if (sum) {
      const n = Number(sum[2]);
      let step = latest(steps, (s) => s.index === n);
      if (!step) {
        // its start was not seen: when it started is not known
        step = { name: sum[1], index: n, state: 'running' };
        steps.push(step);
      } else if (step.name !== sum[1]) {
        step.name = sum[1]; // upmd's own name for its block n
      }
      summary = step;
      return;
    }
    const end = END.exec(text);
    if (end) {
      if (!summary) return; // not upmd's end line: its end line closes a summary
      const code = Number(end[1]);
      summary.code = code; // the summary's last such line is upmd's own (a block's output is written before it)
      if (summary.state === 'running' || summary.state === 'completed' || summary.state === 'failed') summary.state = code === 0 ? 'completed' : 'failed';
      summary.endedAt ??= stamp();
      return;
    }
    const chain = CHAIN.exec(text);
    if (chain) {
      const step = latest(steps, (s) => s.index === Number(chain[1]));
      if (step?.state === 'running') { step.state = 'failed'; step.endedAt ??= stamp(); }
      return;
    }
    const pipeEnd = PIPE_END.exec(text);
    if (pipeEnd) {
      const step = latest(steps, (s) => s.name === pipeEnd[1] && s.code === undefined);
      const code = Number(pipeEnd[2]);
      if (step) {
        step.code = code;
        if (step.state === 'running' || step.state === 'failed') step.state = code === 0 ? 'completed' : 'failed';
        step.endedAt ??= stamp();
      } else {
        steps.push({ name: pipeEnd[1], state: code === 0 ? 'completed' : 'failed', code });
      }
      summary = undefined;
    }
  };
}
