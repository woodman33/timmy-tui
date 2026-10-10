/**
 * Round R4 (H51): `timmy act "<slash command>" [--wait] [--json] [--project <dir>] [--timeout <dur>]`: one REPL command run
 * headlessly in a project, through the same Workspace and command code the REPL uses (src/repl/commands.ts runSlash), with
 * no terminal. A workflow block runs Timmy this way: `timmy act '/iterate tray "make the tray 150 mm wide"' --wait`.
 *
 * - The project is the folder the REPL would open from here (the current directory), or --project <dir>.
 * - It is one operation (src/ops): recorded at once in .timmy/operations/; with TIMMY_OPERATION set (a job Timmy started,
 *   a workflow block of a /run) it joins that operation when this project holds it and it still runs, so everything it
 *   makes carries the same id; an id it cannot join is the parent of a new one.
 * - Anything that would ask a person is refused, with the exact line to type in the REPL instead (fail closed): a chat
 *   request (its tools may ask for approval), an editor, the full-screen monitor or cockpit, a page opened or served for a
 *   person, the REPL's own model and conversation.
 * - --wait waits until the jobs, flows and VoxVision actions it started have ended, printing their progress lines. Without
 *   it, act stops what the command started before it exits (each through its normal stop path, recorded as stopped), so
 *   nothing it started is left without its record.
 * - Exit: 0 succeeded (a flow that succeeded, a completed job, an ok VoxVision record) or answered (it started nothing and
 *   said so); 1 failed or differs; 2 refused or a usage error; 3 stopped or interrupted (--timeout, SIGINT, SIGTERM, or
 *   stopped because --wait was not given). SIGINT and SIGTERM stop what it started through the normal stop path, record it,
 *   and exit 3.
 * - --json prints one JSON object at the end (stdout; the progress lines go to stderr): the operation's id, its outcome,
 *   its exit code, the records it made and the receipts sealed under it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { folderProject } from '../project/index.js';
import { Workspace } from '../repl/workspace.js';
import { runSlash, type ReplContext } from '../repl/commands.js';
import { realOnPath } from '../repl/center.js';
import { glyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { appendReceipt, readChain } from '../utils/receipts.js';
import { timmyHome } from '../utils/init.js';
import { OPERATION_ENV, OPERATION_ID } from './context.js';
import { operationRel, type OperationHandle, type OperationState } from './operations.js';
import { flowRecordPath } from '../flows/iterate.js';
import { voxRecordPath } from '../vox/record.js';
import { AGENTS_DIR } from '../code-agents/index.js';
import { MCP_CALLS_DIR } from '../connectors/mcp-records.js';

export const ACT_USAGE = 'timmy act "<slash command>" [--wait] [--json] [--project <dir>] [--timeout <dur>]';

export function actHelp(): string {
  return [
    'timmy act: run one REPL command headlessly in a project, as one operation, and say how it ended.',
    '',
    'USAGE',
    `  ${ACT_USAGE}`,
    '',
    'OPTIONS',
    '  --wait            wait until the jobs, flows and VoxVision actions it started have ended, printing their progress',
    '                    (without it, act stops what the command started before it exits, each recorded as stopped)',
    '  --json            one JSON object at the end on stdout (the operation, its outcome, records, receipts); progress on stderr',
    '  --project <dir>   the project folder (default: the folder the REPL would open from here, the current directory)',
    '  --timeout <dur>   stop what it started after this long (90s, 5m, 1h; a bare number is seconds), and exit 3',
    '',
    'EXIT',
    '  0 succeeded or answered   1 failed or differs   2 refused or usage   3 stopped or interrupted',
    '',
    'NEEDS A PERSON (refused, with the line to type in the REPL instead)',
    '  a chat request (its tools may ask for approval), /edit, /watch, /center, /web, /browser, /canvas, /board live, /board off,',
    '  /model, /new, /exit',
    '',
    'OPERATIONS',
    `  With ${OPERATION_ENV} set (a workflow block of a /run), act joins that operation when this project holds it and it still`,
    '  runs: everything it makes carries the same id (/op shows it). An id it cannot join is the parent of a new operation.',
    '',
    'EXAMPLES',
    '  timmy act \'/iterate tray "make the tray 150 mm wide"\' --wait',
    '  timmy act "/inspect out/recipes/1a2b3c4d/console-tray.step" --wait --json',
    '  timmy act /op',
    '',
  ].join('\n');
}

interface ActArgs { line: string; wait: boolean; json: boolean; project?: string; timeoutMs?: number; help?: boolean }

/** A duration: 500ms, 90s, 5m, 1h, or a bare number of seconds. */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const ms = m[2] === 'ms' ? n : m[2] === 'm' ? n * 60_000 : m[2] === 'h' ? n * 3_600_000 : n * 1000;
  return Number.isFinite(ms) && ms > 0 && ms <= 7 * 24 * 3_600_000 ? Math.round(ms) : undefined;
}

export function parseActArgs(argv: string[], o: { json?: boolean } = {}): ActArgs | { error: string } {
  const a: ActArgs = { line: '', wait: false, json: o.json === true };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === '-h' || w === '--help') { a.help = true; continue; }
    if (w === '--wait') { a.wait = true; continue; }
    if (w === '--json') { a.json = true; continue; }
    const eq = /^--(project|timeout)=(.*)$/.exec(w);
    if (w === '--project' || w === '--timeout' || eq) {
      const v = eq ? eq[2] : argv[++i];
      if (v === undefined || v === '') return { error: `${eq ? `--${eq[1]}` : w} needs a value. Usage: ${ACT_USAGE}` };
      if ((eq?.[1] ?? w.slice(2)) === 'project') a.project = v;
      else {
        const ms = parseDuration(v);
        if (ms === undefined) return { error: `--timeout ${v} is not a duration (90s, 5m, 1h, or seconds). Usage: ${ACT_USAGE}` };
        a.timeoutMs = ms;
      }
      continue;
    }
    if (/^--?\S/.test(w) && !words.length) return { error: `No option ${w}. Usage: ${ACT_USAGE}` };
    words.push(w);
  }
  if (a.help) return a;
  if (!words.length) return { error: `Name the command, quoted as one argument. Usage: ${ACT_USAGE}` };
  if (words.length > 1) return { error: `Quote the command as one argument (it was given as ${words.length} words). Usage: ${ACT_USAGE}` };
  a.line = words[0].trim();
  if (!a.line) return { error: `Name the command. Usage: ${ACT_USAGE}` };
  return a;
}

/** Why a line needs a person (and so is refused here), or undefined. */
export function needsPerson(line: string): string | undefined {
  if (!line.startsWith('/')) return 'a chat request runs a turn whose tools may ask you to approve them';
  const [word, ...rest] = line.slice(1).split(/\s+/);
  const args = rest.join(' ').trim();
  switch (word) {
    case 'edit': return '/edit opens a file in your editor';
    case 'watch': return '/watch opens the full-screen monitor';
    case 'center': return '/center opens the cockpit in a terminal';
    case 'web': case 'browser': return `/${word} opens a page for you`;
    case 'canvas': return '/canvas starts and opens Timmy Canvas for you';
    case 'board': return /^(live|off)$/.test(args) ? '/board live serves the board for you while the REPL runs' : undefined;
    case 'model': return '/model is the REPL conversation\'s model';
    case 'new': return '/new starts a REPL conversation';
    case 'exit': return '/exit ends the REPL';
    default: return undefined;
  }
}

/**
 * Whether a line asks to start work (a run, a flow, an action, a native app, a recipe, an MCP call): such a command that
 * started nothing and sealed nothing was refused (its own lines say why: a usage line, a missing tool, a busy project).
 * Every other command answers (a listing, a card, a view): it is never counted as refused.
 */
export function startsWork(line: string): boolean {
  const [word, ...rest] = line.slice(1).split(/\s+/);
  const args = rest.join(' ').trim();
  if (['observe', 'inspect', 'measure', 'detect', 'compare', 'preview', 'scad', 'blender', 'c4d', 'ae'].includes(word)) return true;
  if (word === 'run' || word === 'iterate' || word === 'freecad') return args.length > 0;
  if (word === 'agent') return args.length > 0 && args !== 'last';
  if (word === 'recipe') return /^tray\b/.test(args);
  if (word === 'mcp') return /^call\b/.test(args);
  return false;
}

const EXIT: Readonly<Record<OperationState, number>> = { succeeded: 0, answered: 0, failed: 1, differs: 1, refused: 2, stopped: 3, running: 3 };
const plain = (segs: Segment[]): string => segs.map((s) => s.text).join('');
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** The records this act's runs made, as project-relative paths that are there. */
function recordsOf(root: string, h: OperationHandle): string[] {
  const out = h.joined ? [] : [operationRel(h.id)];
  for (const r of h.runs) {
    const rel = r.kind === 'flow' ? flowRecordPath(r.id) : r.kind === 'vox' ? voxRecordPath(r.id) : r.kind === 'agent' ? `${AGENTS_DIR}/${r.id}/result.json`
      : r.kind === 'native' ? `.timmy/native/${r.id}/job.json` : r.kind === 'mcp' ? `${MCP_CALLS_DIR}/${r.id}/call.json` : undefined;
    if (rel && fs.existsSync(path.join(root, rel))) out.push(rel);
  }
  return out;
}

/** `timmy act …`: its exit code (the CLI exits with it). */
export async function actMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  const parsed = parseActArgs(argv, o);
  // Refused before an operation began (a usage error, a command that needs a person): --json still ends with one object.
  const before = (request: string, outcome: 'usage' | 'refused', why: string): string => JSON.stringify({
    schema: 'timmy.act/1', operation: null, joined: false, parent: null, request, project: null, outcome, exit_code: 2, why, runs: [], records: [], receipts: [], lines: [],
  });
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    if (o.json || argv.includes('--json')) process.stdout.write(`${before('', 'usage', parsed.error)}\n`);
    return 2;
  }
  if (parsed.help) { process.stdout.write(actHelp()); return 0; }
  const a = parsed;
  const out = (text: string): void => { (a.json ? process.stderr : process.stdout).write(`${text}\n`); };
  const person = needsPerson(a.line);
  if (person) {
    const msg = `Not run: ${person}, which needs a person. Type this in the REPL instead: ${a.line}`;
    out(msg);
    if (a.json) process.stdout.write(`${before(a.line, 'refused', msg)}\n`);
    return 2;
  }
  let root = process.cwd();
  if (a.project) {
    root = path.resolve(a.project);
    let dir = false;
    try { dir = fs.statSync(root).isDirectory(); } catch { dir = false; }
    if (!dir) { process.stderr.write(`--project ${a.project} is not a folder. Usage: ${ACT_USAGE}\n`); return 2; }
  }
  try { root = fs.realpathSync(root); } catch { /* as given */ }
  try { process.chdir(root); } catch (e) { process.stderr.write(`The project folder cannot be entered: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }

  const glyphs = glyphSet(true);
  const printed: Segment[][] = [];
  const ws = new Workspace({
    glyphs,
    env: process.env,
    onPath: (cmd) => realOnPath(cmd, process.env),
    notify: (line) => out(plain(line)),
    // Nothing is opened for a person here: a page is named instead.
    openWeb: (url, opts) => (opts?.secret ? 'a page for a person (not opened by timmy act)' : `${url} (not opened by timmy act)`),
    link: (text) => text,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15),
    jobsDir: join(timmyHome(), 'jobs'),
    recoverAtStart: false,
    chdir: () => {},
  }, folderProject(root));
  const joinId = process.env[OPERATION_ENV]?.trim();
  const h = ws.beginOperation(a.line, joinId && OPERATION_ID.test(joinId) ? { join: joinId } : {});
  if (!a.json) out(`  operation ${h.id}${h.joined ? ` (joined: ${OPERATION_ENV})` : ''}${h.parent ? ` (continues ${h.parent})` : ''}${h.recorded ? `${` ${glyphs.sep} `}${operationRel(h.id)}` : ''}`);

  // A stop (a signal, the time limit, no --wait): what the command started stops through the normal stop path.
  let stopping: Promise<void> | undefined;
  let stopWhy = '';
  const stop = (why: string): Promise<void> => {
    if (stopping) return stopping;
    stopWhy = why;
    out(`  stopping: ${why}`);
    ws.ops.stopping(h, why);
    stopping = (async () => {
      for (const l of await ws.stop('all')) out(plain(l));
    })().catch(() => undefined);
    return stopping;
  };
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals): void => {
    signals += 1;
    if (signals > 1) { ws.killNow(); process.exit(3); }
    void stop(`${sig} received`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const deadline = a.timeoutMs !== undefined ? Date.now() + a.timeoutMs : undefined;

  const ctx: ReplContext = {
    agent: { getModel: () => 'none: timmy act runs no chat', setModel: () => undefined, startSession: () => '' },
    print: (segs) => { printed.push(segs); out(plain(segs)); },
    glyphs,
    workspace: ws,
  };
  let failedToRun: string | undefined;
  try {
    await ws.ops.run(h, async () => {
      const r = await runSlash(a.line, ctx);
      // It started and sealed nothing: a command asked to start work was refused (its lines say why); any other answered.
      if (!h.runs.length && !h.seals && startsWork(a.line)) ws.ops.answer(h, 'refused');
      return r;
    });
  } catch (e) {
    failedToRun = e instanceof Error ? e.message : String(e);
    out(`  the command failed: ${ws.project.name}: ${failedToRun}`);
  }

  // Wait for what it started (or stop it), then for the operation's own end.
  while (ws.ops.live(h) && !stopping) {
    if (!a.wait) { await stop('timmy act was not given --wait, so what the command started is stopped as it exits'); break; }
    if (deadline !== undefined && Date.now() >= deadline) { await stop(`--timeout ${a.timeoutMs} ms passed`); break; }
    await sleep(100);
    ws.ops.check();
  }
  if (stopping) {
    await stopping;
    // A stop decides it, with its own why (each run's own record says how that run ended): it was stopped.
    ws.ops.end(h, 'stopped', stopWhy);
  }
  for (let i = 0; i < 100 && !h.ended; i++) { ws.ops.check(); if (!h.ended) await sleep(50); }
  if (!h.ended) ws.ops.end(h, failedToRun ? 'failed' : 'stopped', failedToRun ? `the command failed: ${failedToRun}` : 'it did not end within the time act waits');
  await ws.close();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const end = h.ended!;
  // A stop overrides: a run already ended stays as it ended in its own record.
  const state: OperationState = stopping ? 'stopped' : failedToRun ? 'failed' : end.state;
  const code = EXIT[state];
  const receipts = (() => { try { return readChain('runs').filter((r) => r.operation_id === h.id).map((r) => ({ id: r.hash.slice(7, 15), kind: r.kind, ...(r.status ? { status: r.status } : {}) })); } catch { return []; } })();
  if (a.json) {
    process.stdout.write(`${JSON.stringify({
      schema: 'timmy.act/1', operation: h.id, joined: h.joined, parent: h.parent, request: h.request, project: ws.project.name,
      outcome: state, exit_code: code, why: end.why,
      runs: h.runs.map((r) => ({ kind: r.kind, id: r.id })), records: recordsOf(root, h), receipts,
      lines: printed.map(plain),
    })}\n`);
  } else {
    // A joined act says how its own request ended: the operation it joined goes on in the Timmy that began it.
    const who = h.joined ? `this request (in operation ${h.id}, joined)` : `operation ${h.id}`;
    out(`  ${state === 'succeeded' || state === 'answered' ? glyphs.ok : state === 'stopped' ? ' ' : glyphs.fail} ${who} ${state}: ${end.why}`);
    out(`  /op ${h.id} shows it in full (in the REPL, or timmy act "/op ${h.id}")`);
  }
  return code;
}
