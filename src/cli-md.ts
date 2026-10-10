/**
 * Round R4 (helper H74; the plan's F-3 and R1 item 5): `timmy md <workflow.md> [<block>] [--plan] [--json]`, the command-line
 * face of /run. It is no second implementation: the run is read as /run reads it (src/repl/workflow-gate.ts planRun), and
 * run by the same Workspace and job as /run (src/repl/workspace.ts run): the prediction sealed first, upmd on a pty of its
 * own when python3 can give it one, each block's receipt sealed as it ends, the run's own receipt naming them, all under one
 * operation (`.timmy/operations/<id>.json`, as `timmy act` records one; with TIMMY_OPERATION set, a block of another run,
 * it joins that operation while it runs).
 *
 * - The project is the current folder (as the REPL would open it); the document is a file of it.
 * - `--plan` prints the prediction (the blocks in run order) and the risky blocks with their commands, and runs and seals
 *   nothing.
 * - A run that would reach a risky block (a destructive shell command, by the agent's shell tool's own rule): in a terminal,
 *   the NEEDS YOU box asks first, once, before anything runs (y runs it once; n, Esc or Enter deny it). With no terminal to
 *   ask, or with --json, it is refused before anything runs, exit 2, with the command to type in the REPL.
 * - Exit codes as `timmy act`'s: 0 succeeded (the run completed: upmd ran every block of it and each exited 0) or answered
 *   (--plan); 1 failed; 2 refused, needs a person, or a usage error; 3 stopped or interrupted (SIGINT, SIGTERM).
 * - --json prints one JSON object at the end (stdout; the progress lines go to stderr).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { folderProject } from './project/index.js';
import { realOnPath } from './repl/center.js';
import { readDecision, type ApprovalRequest, type Decision } from './repl/approvals.js';
import { Workspace } from './repl/workspace.js';
import { planRun, riskyLines, runCommand, UPMD_GATE, workflowNeedsPerson, type RiskyBlock } from './repl/workflow-gate.js';
import { glyphSet } from './term/glyphs.js';
import type { Segment } from './term/theme.js';
import { OPERATION_ENV, OPERATION_ID } from './ops/context.js';
import { operationRel } from './ops/operations.js';
import { timmyHome } from './utils/init.js';
import { appendReceipt, readChain } from './utils/receipts.js';
import { stopReason } from './utils/stop-words.js';
import { blockReceiptsOf } from './workflows/block-receipts.js';
import { findUpmd, upmdVersion } from './workflows/upmd.js';

export const MD_USAGE = 'timmy md <workflow.md> [<block>] [--plan] [--json]';

export function mdHelp(): string {
  return [
    'timmy md: run a block of a upmd workflow document from the command line, as /run does in the REPL.',
    '',
    'USAGE',
    `  ${MD_USAGE}`,
    '',
    '  <workflow.md>  a Markdown file of the current folder (the project) with named blocks: ```bash [name:build]',
    '  <block>        the block to run; upmd runs the blocks it needs first (needed when the document names more than one)',
    '',
    'OPTIONS',
    '  --plan         print the prediction (the blocks in run order) and the risky blocks, and run and seal nothing',
    '  --json         one JSON object at the end on stdout (the run, its receipts and outcome); progress on stderr',
    '',
    'WHAT IT DOES',
    '  The same run as /run: the prediction is sealed first; upmd runs the block after the blocks it needs; each block\'s',
    '  receipt is sealed as it ends, and the run\'s own receipt names them; one operation (/op shows it).',
    '',
    'NEEDS YOU',
    '  A block whose command is a destructive shell command (rm, sudo, chmod, chown, dd, mkfs) needs a person before it runs.',
    `  ${UPMD_GATE}.`,
    '  In a terminal the NEEDS YOU box asks (y once; n, Esc or Enter deny). With no terminal, or with --json, the run is',
    '  refused before anything runs, with the command to type in the REPL instead.',
    '',
    'EXIT',
    '  0 succeeded (or --plan)   1 failed   2 refused, needs a person, or usage   3 stopped or interrupted',
    '',
    'EXAMPLES',
    '  timmy md WORKFLOW.md lesson --plan',
    '  timmy md BUILD.md build',
    '  timmy md BUILD.md build --json',
    '',
  ].join('\n');
}

interface MdArgs { doc: string; block?: string; plan: boolean; json: boolean; help?: boolean }

export function parseMdArgs(argv: string[], o: { json?: boolean } = {}): MdArgs | { error: string } {
  const a: MdArgs = { doc: '', plan: false, json: o.json === true };
  const words: string[] = [];
  for (const w of argv) {
    if (w === '-h' || w === '--help') { a.help = true; continue; }
    if (w === '--plan') { a.plan = true; continue; }
    if (w === '--json') { a.json = true; continue; }
    if (/^--?\S/.test(w)) return { error: `No option ${w}. Usage: ${MD_USAGE}` };
    words.push(w);
  }
  if (a.help) return a;
  if (!words.length) return { error: `Name the workflow document. Usage: ${MD_USAGE}` };
  if (words.length > 2) return { error: `Name one document and at most one block (it was given ${words.length} words). Usage: ${MD_USAGE}` };
  a.doc = words[0];
  if (words[1]) a.block = words[1];
  return a;
}

const plain = (segs: Segment[]): string => segs.map((s) => s.text).join('');
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const riskyJson = (risky: readonly RiskyBlock[]): Array<{ name: string; index: number; command: string; reason: string; code_sha256: string }> =>
  risky.map((b) => ({ name: b.name, index: b.index, command: b.command, reason: b.reason, code_sha256: b.code_sha256 }));

/** The NEEDS YOU box of this terminal: the REPL's own box and keys (src/repl/transcript.ts, src/repl/approvals.ts). */
async function terminalBox(): Promise<{ ask: (req: ApprovalRequest) => Promise<Decision>; restore: () => void }> {
  const { currentCapabilities } = await import('./term/capabilities.js');
  const { TerminalSession } = await import('./term/session.js');
  const { buildTheme } = await import('./term/theme.js');
  const { LiveRegion } = await import('./term/live-region.js');
  const { measureTerminal } = await import('./term/probe.js');
  const { Transcript } = await import('./repl/transcript.js');
  const caps = currentCapabilities();
  const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  const theme = buildTheme(caps, await measureTerminal(caps, process.env, { stdin: process.stdin, stdout: process.stdout }));
  const region = new LiveRegion({ out: process.stdout, err: process.stderr }, { live: caps.animate });
  const transcript = new Transcript(theme, region, { columns: caps.columns });
  return {
    ask: async (req) => {
      transcript.handle({ type: 'needs-you', ...req });
      const decision = await readDecision(process.stdin, session, { session: req.session !== false });
      transcript.handle({ type: 'needs-you-answered', tool: req.tool, decision });
      return decision;
    },
    restore: () => { try { region.close(); } catch { /* closed */ } session.restore(); },
  };
}

/** `timmy md …`: its exit code (the CLI exits with it). */
export async function mdMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  const parsed = parseMdArgs(argv, o);
  const end = (obj: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify({ schema: 'timmy.md/1', ...obj })}\n`); };
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    if (o.json || argv.includes('--json')) end({ operation: null, outcome: 'usage', exit_code: 2, why: parsed.error });
    return 2;
  }
  if (parsed.help) { process.stdout.write(mdHelp()); return 0; }
  const a = parsed;
  const out = (text: string): void => { (a.json ? process.stderr : process.stdout).write(`${text}\n`); };
  const glyphs = glyphSet(true);
  const sep = ` ${glyphs.sep} `;
  let root = process.cwd();
  try { root = fs.realpathSync(root); } catch { /* as given */ }

  // The run, read as /run reads it.
  const p = planRun(root, a.doc, a.block);
  if (!p.ok) {
    const why = p.which ? `Which block? timmy md ${p.rel} <${p.which.join(' | ')}>` : p.why;
    out(why);
    if (a.json) end({ operation: null, doc: p.rel ?? a.doc, block: a.block ?? null, outcome: 'refused', exit_code: 2, why });
    return 2;
  }
  const found = findUpmd(process.env, (cmd) => realOnPath(cmd, process.env));
  const version = found ? await upmdVersion(found.bin) : null;
  const facts = {
    doc: p.rel, block: p.target, order: p.order, ...(p.sha256 ? { doc_sha256: p.sha256 } : {}), risky: riskyJson(p.risky), ...(p.risky.length ? { gate: UPMD_GATE } : {}),
    upmd: found ? { version } : null,
  };
  // the risky blocks in the words (and columns) the REPL's /run prints before its box
  const risky = (): void => { for (const l of riskyLines(p.risky, { sep })) out(plain(l)); };

  if (a.plan) {
    out(`  Plan       ${p.order.join(` ${glyphs.arrow} `)}, each exits 0${sep}--plan: nothing runs and nothing is sealed`);
    risky();
    out(`  upmd       ${found ? (version ?? 'found, but it did not say its version') : 'not installed: brew install rezigned/tap/upmd'}`);
    out(`  Run it     timmy md ${p.rel} ${p.target}${p.risky.length ? '  (in a terminal: its NEEDS YOU box asks first)' : ''}, or ${runCommand(p.rel, p.target)} in the REPL`);
    if (a.json) end({ operation: null, plan: true, ...facts, outcome: 'answered', exit_code: 0, why: 'the prediction only: --plan runs and seals nothing' });
    return 0;
  }

  // NEEDS YOU: with no terminal to ask (or --json), a risky run is refused before anything runs.
  const terminal = !a.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (p.risky.length && !terminal) {
    const msg = `Not run: ${workflowNeedsPerson(root, `/run ${p.rel} ${p.target}`) ?? 'a block of it is a destructive shell command on this machine'}, which needs a person, and ${a.json ? 'timmy md --json' : 'timmy md with no terminal'} cannot ask you. Type this in the REPL instead: ${runCommand(p.rel, p.target)}`;
    out(msg);
    risky();
    if (a.json) end({ operation: null, ...facts, outcome: 'refused', exit_code: 2, why: msg });
    return 2;
  }

  const box = terminal && p.risky.length ? await terminalBox() : undefined;
  const printed: string[] = [];
  const ws = new Workspace({
    glyphs,
    env: process.env,
    onPath: (cmd) => realOnPath(cmd, process.env),
    notify: (line) => { printed.push(plain(line)); out(plain(line)); },
    openWeb: (url, opts) => (opts?.secret ? 'a page for a person (not opened by timmy md)' : `${url} (not opened by timmy md)`),
    link: (text) => text,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15),
    jobsDir: join(timmyHome(), 'jobs'),
    recoverAtStart: false,
    chdir: () => {},
    ...(box ? { askPerson: box.ask } : {}),
  }, folderProject(root));
  const joinId = process.env[OPERATION_ENV]?.trim();
  const request = `timmy md ${p.rel} ${p.target}`;
  const h = ws.beginOperation(request, { via: 'md', ...(joinId && OPERATION_ID.test(joinId) ? { join: joinId } : {}) });
  if (!a.json) out(`  operation ${h.id}${h.joined ? ` (joined: ${OPERATION_ENV})` : ''}${h.parent ? ` (continues ${h.parent})` : ''}${h.recorded ? `${sep}${operationRel(h.id)}` : ''}`);

  // A signal stops the run through the normal stop path (recorded as stopped by timmy md), and it exits 3.
  let stopping: Promise<void> | undefined;
  let stopWhy = '';
  const stop = (why: string): Promise<void> => {
    if (stopping) return stopping;
    stopWhy = why;
    out(`  stopping: ${why}`);
    ws.ops.stopping(h, why);
    stopping = (async () => { for (const l of await ws.stop('all', { by: stopReason(`by timmy md (${why})`) })) out(plain(l)); })().catch(() => undefined);
    return stopping;
  };
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals): void => {
    signals += 1;
    if (signals > 1) { ws.killNow(stopReason(`by timmy md (a second ${sig}: it exits at once)`)); box?.restore(); process.exit(3); }
    void stop(`${sig} received`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let failedToRun: string | undefined;
  try {
    const lines = await ws.ops.run(h, async () => {
      const r = await ws.run(`${p.rel} ${p.target}`);
      // It started nothing (denied, upmd missing, the document changed while asked): refused, its lines say why.
      if (!h.runs.length) ws.ops.answer(h, 'refused');
      return r;
    });
    box?.restore();
    for (const l of lines) { printed.push(plain(l)); out(plain(l)); }
  } catch (e) {
    box?.restore();
    failedToRun = e instanceof Error ? e.message : String(e);
    out(`  the run failed to start: ${failedToRun}`);
  }
  while (ws.ops.live(h) && !stopping) { await sleep(100); ws.ops.check(); }
  if (stopping) { await stopping; ws.ops.end(h, 'stopped', stopWhy); }
  for (let i = 0; i < 100 && !h.ended; i++) { ws.ops.check(); if (!h.ended) await sleep(50); }
  if (!h.ended) ws.ops.end(h, failedToRun ? 'failed' : 'stopped', failedToRun ? `the run failed to start: ${failedToRun}` : 'it did not end within the time timmy md waits');
  await ws.close({ by: stopReason('by timmy md (it is exiting)') });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const ended = h.ended!;
  const state = stopping ? 'stopped' : failedToRun ? 'failed' : ended.state;
  const code = state === 'succeeded' || state === 'answered' ? 0 : state === 'failed' || state === 'differs' ? 1 : state === 'refused' ? 2 : 3;
  // What the run sealed: its prediction, each block's receipt and its own, from the chain.
  const jobId = h.runs.find((r) => r.kind === 'job')?.id;
  const job = jobId ? ws.jobs.get(jobId) : undefined;
  let chain: ReturnType<typeof readChain> = [];
  try { chain = readChain('runs'); } catch { chain = []; }
  const own = jobId ? blockReceiptsOf(chain, jobId) : new Map();
  const blocks = (job?.steps ?? []).map((s) => ({ name: s.name, state: s.state, exit_code: s.code ?? null, receipt: own.get(s.name)?.receipt ?? null }));
  const receipts = chain.filter((r) => r.operation_id === h.id).map((r) => ({ id: r.hash.slice(7, 15), kind: r.kind, ...(r.status ? { status: r.status } : {}) }));
  if (a.json) {
    end({
      operation: h.id, joined: h.joined, parent: h.parent, request, project: ws.project.name, ...facts,
      outcome: state, exit_code: code, why: ended.why,
      job: job ? { id: job.id, state: job.state, exit_code: job.exitCode ?? null } : null,
      prediction: job?.expected?.receipt ?? null, receipt: job?.receipt ?? null, blocks, receipts, lines: printed,
    });
  } else {
    if (blocks.some((b) => b.receipt)) out(`  Blocks     ${blocks.filter((b) => b.receipt).map((b) => `block ${b.name}: receipt ${b.receipt}`).join(sep)}`);
    if (job?.receipt) out(`  Run        receipt ${job.receipt}${sep}/jobs ${job.id}`);
    const who = h.joined ? `this request (in operation ${h.id}, joined)` : `operation ${h.id}`;
    out(`  ${state === 'succeeded' || state === 'answered' ? glyphs.ok : state === 'stopped' || state === 'refused' ? ' ' : glyphs.fail} ${who} ${state}: ${ended.why}`);
    out(`  /op ${h.id} shows it in full (in the REPL, or timmy act "/op ${h.id}")`);
  }
  return code;
}
